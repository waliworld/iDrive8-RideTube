// SPDX-License-Identifier: GPL-3.0-or-later
// Collects, from an iDrive 8 head unit, what RideTube needs to learn how that unit plays media - read only.
//
// Run it ON THE HEAD UNIT as root, with the unit's own Node, from your computer over the SSH you already have:
//
//     <your ssh command for the car> node < tools/id8_collect.js > ridetube-id8-data.txt
//
// (cmd.exe, bash and zsh; in PowerShell: cmd /c "<the line above>"). It changes nothing on the unit: it reads files,
// lists processes and asks systemd and the Store's deploy tool for their status. The result is text (gzip of one
// JSON, in base64 between two marker lines), so it survives whatever else the connection prints.
// tools/id8_unpack.js turns it back into files.
//
// What it takes: the SOME/IP interface descriptions and catalog; the SOME/IP security policies; the app manager's
// code that deals with media; the code of up to four installed apps that play media (BMW's SDK is inside them);
// each app's manifest; the Store's app list and status; RideTube's own logs; the units, processes and sound cards of
// the media. What it never takes: RideTube's account (sign-in) files, contacts, destinations, the VIN, or any other
// app's data folder.
//
// The files it takes from the unit are BMW's: keep the result private (do not publish it or commit it to a repo).
// (a function of its own: a script read from stdin runs in the global scope, where fs, path and crypto already are names)
(function () {
'use strict';
var fs = require('fs'), path = require('path'), zlib = require('zlib'), cp = require('child_process'), crypto = require('crypto');

var ROOT = process.env.RT_ROOT || '';                 // (tests: a folder that stands for the unit's /)
var R = function (p) { return ROOT ? path.join(ROOT, p) : p; };
var MAX_FILE = 8 << 20, MAX_TOTAL = 90 << 20;
var out = { format: 'ridetube-id8-data/1', made: new Date().toISOString(), node: process.version, files: {}, lists: {}, commands: {}, notes: [] };
var total = 0, t0 = Date.now();

function note(m) { out.notes.push(m); }
function ls(dir) { try { return fs.readdirSync(R(dir)).sort(); } catch (e) { return null; } }
function stat(p) { try { return fs.lstatSync(R(p)); } catch (e) { return null; } }
function isDir(p) { var s = stat(p); return !!s && s.isDirectory(); }
/* A file into the result: whole up to max bytes (else its head, or with tail its end), as text. Once. */
function take(p, max, tail) {
    if (out.files[p]) return true;
    var s = stat(p);
    if (!s || !s.isFile()) return false;
    max = Math.min(max || MAX_FILE, MAX_FILE);
    if (total >= MAX_TOTAL) { note('left out (the result is full): ' + p); return false; }
    try {
        var fd = fs.openSync(R(p), 'r'), n = Math.min(s.size, max), buf = Buffer.alloc(n);
        fs.readSync(fd, buf, 0, n, tail && s.size > n ? s.size - n : 0);
        fs.closeSync(fd);
        out.files[p] = { size: s.size, text: buf.toString('utf8') };
        if (s.size > n) out.files[p].cut = tail ? 'the last ' + n + ' bytes' : 'the first ' + n + ' bytes';
        total += n;
        return true;
    } catch (e) { note('not readable: ' + p + ' (' + e.message + ')'); return false; }
}
/* The files under dir (at most depth folders down, limit entries looked at) that keep(path, name) accepts. */
function walk(dir, depth, keep, limit) {
    var found = [], left = limit || 20000;
    (function go(d, k) {
        var names = ls(d);
        if (!names) return;
        for (var i = 0; i < names.length && left > 0; i++) {
            left--;
            var p = d + '/' + names[i], s = stat(p);
            if (!s || s.isSymbolicLink()) continue;
            if (s.isDirectory()) { if (k > 0 && names[i] !== 'data' && names[i][0] !== '.') go(p, k - 1); } else if (s.isFile() && keep(p, names[i], s)) found.push(p);
        }
    })(dir, depth);
    return found;
}
/* Whether the file's text (its first max bytes) matches re; read in one piece, files over max are looked at in part. */
function mentions(p, re, max) {
    try {
        var s = stat(p), n = Math.min(s.size, max || (12 << 20)), fd = fs.openSync(R(p), 'r'), buf = Buffer.alloc(n);
        fs.readSync(fd, buf, 0, n, 0);
        fs.closeSync(fd);
        return re.test(buf.toString('latin1'));
    } catch (e) { return false; }
}
function run(name, cmd, args) {
    if (ROOT && !process.env.RT_CMDS) return;
    try {
        out.commands[name] = String(cp.execFileSync(cmd, args, { timeout: 10000, maxBuffer: 4 << 20, stdio: ['ignore', 'pipe', 'pipe'] })).slice(0, 400000);
    } catch (e) {
        out.commands[name] = (e.stdout ? String(e.stdout).slice(0, 400000) : '') + '\n[' + String(e.message).split('\n')[0] + ']';
    }
}

// 1. the interface descriptions the app manager has, and the unit's catalog of all of them
['/usr/lib/oap-mainapp21/src-gen', '/usr/lib/oap-mainapp/src-gen'].forEach(function (d) {
    walk(d, 3, function (p, n) { return /\.json$/.test(n); }).forEach(function (p) { take(p, 2 << 20); });
});
walk('/etc/oap', 3, function (p, n, s) { return /\.json$/.test(n) && s.size <= MAX_FILE; }, 2000).forEach(function (p) { take(p); });
// (the catalog may be larger than one file's limit: of it, the audio's and the players' interfaces are taken whole)
(function () {
    var p = '/etc/oap/someip/someip-interfaces.json', s = stat(p);
    if (!s || s.size <= MAX_FILE || s.size > (80 << 20)) return;
    try {
        var db = JSON.parse(fs.readFileSync(R(p), 'utf8')), part = {};
        Object.keys(db.interfaces || {}).forEach(function (id) { if (/media|player|audio|\.am\.|entertain|commandinterface/i.test(id)) part[id] = db.interfaces[id]; });
        out.files[p + '#audio'] = { size: s.size, text: JSON.stringify({ interfaces: part, names: Object.keys(db.interfaces || {}) }) };
    } catch (e) { note('the catalog could not be read in part: ' + e.message); }
})();

// 2. who may talk to whom
walk('/etc/vsomeip', 3, function (p, n, s) { return s.size <= (2 << 20); }, 3000).forEach(function (p) { take(p, 2 << 20); });

// 3. the app manager: what it is made of, and its code that deals with media
['/usr/lib/oap-mainapp21', '/usr/lib/oap-mainapp'].forEach(function (m) {
    if (!isDir(m)) return;
    out.lists[m] = walk(m, 3, function () { return true; }, 6000).map(function (p) { return p + ' ' + stat(p).size; });
    take(m + '/package.json', 1 << 20);
    var code = walk(m, 5, function (p, n) { return /\.js$/.test(n) && !/\/(preinstalled_apps|src-gen)\//.test(p); }, 8000)
        .filter(function (p) { return mentions(p, /dynamicmediaplayer|mediaplayer|commandinterface|GenericMedia/i); });
    code.slice(0, 30).forEach(function (p) { take(p); });
    if (code.length > 30) note(m + ': ' + (code.length - 30) + ' more files mention the media and were left out');
});

// 4. the installed apps: every app's manifest files; the code of up to four different apps that play media
(function () {
    var base = '/var/opt/public/oap', homes = (ls(base) || []).filter(function (n) { return /^oap_\d+$/.test(n); });
    var seen = {}, taken = 0, apps = [];
    homes.forEach(function (h) {
        var home = base + '/' + h, info = { home: h, interfaces: ls(home + '/someipInterfaces') || [], media: [] };
        apps.push(info);
        walk(home, 5, function (p, n, s) {
            return s.size <= 300000 && /^(package|manifest|permissions|mgu-app|runnerConfig|registration|rhmiData)[\w.-]*\.json$/i.test(n) && !/jap_ridetube/.test(p);
        }, 4000).slice(0, 12).forEach(function (p) { take(p, 300000); });
        (info.interfaces || []).filter(function (n) { return /mediaplayer|commandinterface|audio/i.test(n); }).slice(0, 6).forEach(function (n) { take(home + '/someipInterfaces/' + n, 2 << 20); });
        if (/jap_ridetube/.test(JSON.stringify(ls(home + '/node_modules') || []))) return;
        walk(home, 6, function (p, n, s) { return /\.js$/.test(n) && s.size > 2000 && s.size <= MAX_FILE && !/jap_ridetube/.test(p); }, 4000).forEach(function (p) {
            if (!mentions(p, /playFile|oap-sdk\/src\/media|GenericMediaPlayer|startPlayback|playTrack/)) return;
            info.media.push(p);
            var key;
            try { key = crypto.createHash('sha1').update(fs.readFileSync(R(p))).digest('hex'); } catch (e) { return; }
            if (seen[key]) { info.media[info.media.length - 1] += ' (the same as ' + seen[key] + ')'; return; }
            seen[key] = p;
            if (taken < 4 && take(p)) taken++;
        });
    });
    out.lists.apps = apps;
    // BMW's SDK, where a unit keeps it as files of its own
    ['/usr/lib', '/var/opt/public/oap'].forEach(function (top) {
        walk(top, 5, function (p) { return /\/oap-sdk\/(package\.json$|src\/(media|rhmi\/usecases|rhmi\/components)\/[^/]*(edia|layer)[^/]*\.js$)/.test(p); }, 30000)
            .slice(0, 40).forEach(function (p) { take(p, 1 << 20); });
    });
})();

// 5. the Store: the apps it lists and what its deploy tool says (why tiles may not show)
['/var/opt/public/oap/oap_12201/data/custom_apps.json', '/var/opt/mgu-deploy/verify.json', '/var/opt/mgu-deploy/last-verify.json'].forEach(function (p) { take(p, 2 << 20); });
['/var/opt/mgu-deploy', '/var/opt/mgu-deploy/id8', '/var/opt/mgu-deploy/id8/queue'].forEach(function (d) {
    out.lists[d] = ls(d);
    (ls(d) || []).filter(function (n) { return /\.(json|log|txt)$/.test(n); }).forEach(function (n) { take(d + '/' + n, 1 << 20, true); });
});

// 6. RideTube: its logs, its audio override and what its search for a way to sound kept - never its account files
(ls('/var/opt/jap-ridetube-d/log') || []).forEach(function (n) { take('/var/opt/jap-ridetube-d/log/' + n, 400000, true); });
take('/var/opt/jap-ridetube-d/state/audio.json', 4096);
// (what the service found, tried and read of BMW's player code while looking for a way to sound: sound.js, sdkread.js)
take('/var/opt/jap-ridetube-d/state/sound.json', 200000);
take('/var/opt/jap-ridetube-d/state/sdk.json', 400000);
out.lists['/var/opt/jap-ridetube-d'] = ls('/var/opt/jap-ridetube-d');
(ls('/var/opt/public/oap') || []).forEach(function (h) { take('/var/opt/public/oap/' + h + '/data/jap_ridetube8.log', 400000, true); });

// 7. what runs: the processes, the units and the sound cards of the media; the video decoder
(function () {
    var procs = [];
    (ls('/proc') || []).filter(function (n) { return /^\d+$/.test(n); }).forEach(function (pid) {
        try {
            var cmd = fs.readFileSync(R('/proc/' + pid + '/cmdline'), 'utf8').replace(/\0+/g, ' ').trim();
            if (cmd) procs.push(fs.statSync(R('/proc/' + pid)).uid + ' ' + pid + ' ' + cmd.slice(0, 300));
        } catch (e) { /* gone */ }
    });
    out.lists.processes = procs;
    ['/usr/lib/systemd/system', '/lib/systemd/system', '/etc/systemd/system'].forEach(function (d) {
        var names = ls(d);
        if (!names) return;
        out.lists[d] = names;
        names.filter(function (n) { return /media|player|entertain|audio|oap|mgu-|jap-/i.test(n) && /\.(service|socket|target)$/.test(n); }).slice(0, 80).forEach(function (n) { take(d + '/' + n, 20000); });
    });
    take('/proc/asound/cards', 8000); take('/proc/asound/pcm', 8000); take('/proc/asound/devices', 8000);
    // how sound is played here: ALSA's configuration, the audio manager's configuration, what could play a file
    take('/etc/asound.conf', 1 << 20); take('/usr/share/alsa/alsa.conf', 1 << 20);
    ['/usr/share/alsa/alsa.conf.d', '/etc/alsa/conf.d', '/etc/mediaconfig'].forEach(function (d) {
        out.lists[d] = ls(d);
        (ls(d) || []).filter(function (n) { return /\.(conf|xml|cfg|json|txt)$/.test(n); }).slice(0, 60).forEach(function (n) { take(d + '/' + n, 400000); });
    });
    out.lists['/usr/share/audiomanager'] = ls('/usr/share/audiomanager');
    (ls('/usr/share/audiomanager') || []).forEach(function (n) {
        // (binary configurations: the names in them)
        try {
            var s = stat('/usr/share/audiomanager/' + n);
            if (!s || !s.isFile() || s.size > (6 << 20)) return;
            var names = fs.readFileSync(R('/usr/share/audiomanager/' + n)).toString('latin1').match(/[A-Za-z][A-Za-z0-9_:.-]{3,60}/g) || [];
            out.files['/usr/share/audiomanager/' + n + '#names'] = { size: s.size, text: names.filter(function (x, i) { return names.indexOf(x) === i; }).slice(0, 6000).join('\n') };
        } catch (e) { /* not readable */ }
    });
    out.lists['/usr/bin (players)'] = (ls('/usr/bin') || []).filter(function (n) { return /^gst-|^aplay$|^ffmpeg$|^mpv$|media|player|audio/i.test(n); });
    ['/usr/lib/gstreamer-1.0', '/usr/lib64/gstreamer-1.0'].forEach(function (d) { out.lists[d] = ls(d); });
    take('/etc/os-release', 4000); take('/proc/version', 1000); take('/proc/uptime', 100); take('/etc/passwd', 60000); take('/etc/group', 60000);
    out.lists['/usr/lib (mfx, va, gst)'] = (ls('/usr/lib') || []).filter(function (n) { return /mfx|libva|gstreamer|someip/i.test(n); });
    out.lists['/dev/dri'] = ls('/dev/dri');
    out.lists['/dev/snd'] = ls('/dev/snd');
})();
run('systemctl list-units', 'systemctl', ['list-units', '--all', '--no-pager', '--plain']);
['mgu-app-fallback-id8', 'mgu-deploy-apply', 'mgu-deploy-verify', 'oapcontroller', 'jap-ridetube-d', 'mgu-renderd'].forEach(function (u) {
    run('systemctl status ' + u, 'systemctl', ['status', u, '--no-pager', '-l', '-n', '40']);
    run('journalctl ' + u, 'journalctl', ['-b', '-u', u, '--no-pager', '-n', '300']);
});
run('mgu-deploy status', '/bin/sh', ['/var/opt/mgu-deploy/mgu-deploy.sh', 'status', '--json']);
run('mount', 'mount', []);
run('id', 'id', []);

out.took_ms = Date.now() - t0;
var count = Object.keys(out.files).length;
var b64 = zlib.gzipSync(Buffer.from(JSON.stringify(out), 'utf8'), { level: 9 }).toString('base64');
var text = '-----BEGIN RIDETUBE ID8 DATA-----\n' + b64.replace(/(.{76})/g, '$1\n') + '\n-----END RIDETUBE ID8 DATA-----\n';
process.stderr.write('RideTube iDrive 8 data: ' + count + ' files, ' + Math.round(total / 1024) + ' kB read, ' + Math.round(text.length / 1024) + ' kB written, ' + out.notes.length + ' notes\n');
var outFile = process.argv.indexOf('--out') >= 0 ? process.argv[process.argv.indexOf('--out') + 1] : null;
if (outFile) fs.writeFileSync(outFile, text); else fs.writeSync(1, text);
})();
