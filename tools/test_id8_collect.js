// SPDX-License-Identifier: GPL-3.0-or-later
// tools/id8_collect.js against a folder that stands for an iDrive 8 unit, run as on the unit (the script on stdin),
// and tools/id8_unpack.js on what it wrote: as written, with other output around it, and as UTF-16 with CRLF.
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process'), assert = require('assert');
const { decode, unpack } = require('./id8_unpack');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'id8c-'));
const put = (p, text) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), text); };

put('usr/lib/oap-mainapp21/src-gen/someip/de_bmw_infotainment_entertainment_dynamicmediaplayer_DynamicMediaPlayer.json', '{"name":"dyn"}');
put('usr/lib/oap-mainapp21/src-gen/someip/org_genivi_am_commandinterface_CommandControl.json', '{"name":"cc"}');
put('usr/lib/oap-mainapp21/package.json', '{"name":"mainapp"}');
put('usr/lib/oap-mainapp21/src/media/Player.js', 'x=buildProxy("de.bmw.infotainment.entertainment.dynamicmediaplayer.DynamicMediaPlayer")');
put('usr/lib/oap-mainapp21/src/other/Nav.js', 'nothing of it');
put('usr/lib/oap-mainapp21/preinstalled_apps/a/app.js', 'mediaplayer but preinstalled');
put('etc/oap/someip/someip-interfaces.json', JSON.stringify({ interfaces: { 'a.b.mediaplayer.MediaPlayer': { m: 1 }, 'a.b.Nav': {} } }));
put('etc/vsomeip/0_0/policy.json', '{"security":{}}');
const sdk = 'var mp=require("oap-sdk/src/media/mediaplayer");mp.playFile(f);' + '/*pad*/'.repeat(400);
put('var/opt/public/oap/oap_12209/node_modules/bmw-music/javascript/app.js', sdk);
put('var/opt/public/oap/oap_12209/node_modules/bmw-music/manifest.json', '{"id":"music"}');
put('var/opt/public/oap/oap_12209/someipInterfaces/org_genivi_am_commandinterface_CommandControl.json', '{"name":"ccApp"}');
put('var/opt/public/oap/oap_12209/someipInterfaces/de_bmw_vehicle_Vehicle.json', '{}');
put('var/opt/public/oap/oap_12209/data/private.json', '{"secret":"destinations"}');
put('var/opt/public/oap/oap_12218/node_modules/bmw-radio/javascript/app.js', sdk);                    // the same code: taken once
put('var/opt/public/oap/oap_12230/node_modules/weather/javascript/app.js', 'no media here' + '/*pad*/'.repeat(400));
put('var/opt/public/oap/oap_13003/node_modules/jap_ridetube8/app/main.js', 'x.playFile(1)' + '/*pad*/'.repeat(400));
put('var/opt/public/oap/oap_13003/data/jap_ridetube8.log', 'boot: the app is loaded\n');
put('var/opt/public/oap/oap_12201/data/custom_apps.json', '{"apps":["jap_ridetube8"]}');
put('var/opt/mgu-deploy/id8/pending.json', '{"queue":[]}');
put('var/opt/jap-ridetube-d/log/ytd.log', 'x'.repeat(500000) + 'THE END');
put('var/opt/jap-ridetube-d/state/audio.json', '{"sinkID":5}');
put('var/opt/jap-ridetube-d/state/account.json', '{"refresh_token":"SECRET-TOKEN"}');
put('proc/77/cmdline', '/usr/bin/mediaplayerd\0--instance\0CarPlayMedia\0');
put('proc/asound/cards', ' 0 [Dummy]\n');
put('usr/lib/systemd/system/mediaplayerd.service', '[Service]\nExecStart=/usr/bin/mediaplayerd\n');
put('usr/lib/libmfxhw64.so', '');

const script = fs.readFileSync(path.join(__dirname, 'id8_collect.js'));
const r = cp.spawnSync(process.execPath, [], { input: script, env: Object.assign({}, process.env, { RT_ROOT: root }), maxBuffer: 64 << 20 });
assert.strictEqual(r.status, 0, String(r.stderr));
assert.ok(/^RideTube iDrive 8 data: \d+ files, /.test(String(r.stderr)), String(r.stderr));
const text = String(r.stdout);
assert.ok(text.split('\n').every((l) => l.length <= 76), 'lines of at most 76 characters');

const check = (data) => {
    const f = data.files, has = (p) => Object.prototype.hasOwnProperty.call(f, p);
    assert.strictEqual(data.format, 'ridetube-id8-data/1');
    assert.strictEqual(f['/usr/lib/oap-mainapp21/src-gen/someip/de_bmw_infotainment_entertainment_dynamicmediaplayer_DynamicMediaPlayer.json'].text, '{"name":"dyn"}');
    assert.ok(has('/usr/lib/oap-mainapp21/src/media/Player.js') && !has('/usr/lib/oap-mainapp21/src/other/Nav.js') && !has('/usr/lib/oap-mainapp21/preinstalled_apps/a/app.js'));
    assert.ok(has('/etc/oap/someip/someip-interfaces.json') && has('/etc/vsomeip/0_0/policy.json'));
    assert.ok(has('/var/opt/public/oap/oap_12209/node_modules/bmw-music/javascript/app.js'), 'an app that plays media');
    assert.ok(!has('/var/opt/public/oap/oap_12218/node_modules/bmw-radio/javascript/app.js'), 'the same code is taken once');
    assert.ok(!has('/var/opt/public/oap/oap_12230/node_modules/weather/javascript/app.js'), 'an app without media is not taken');
    assert.ok(has('/var/opt/public/oap/oap_12209/node_modules/bmw-music/manifest.json') && has('/var/opt/public/oap/oap_12209/someipInterfaces/org_genivi_am_commandinterface_CommandControl.json'));
    assert.ok(!has('/var/opt/public/oap/oap_12209/someipInterfaces/de_bmw_vehicle_Vehicle.json'));
    const all = JSON.stringify(data);
    assert.ok(all.indexOf('SECRET-TOKEN') < 0 && all.indexOf('destinations') < 0, 'no account file, no app data');
    assert.ok(!Object.keys(f).some((p) => /jap_ridetube8\/app\//.test(p)), 'not our own code');
    assert.strictEqual(f['/var/opt/jap-ridetube-d/state/audio.json'].text, '{"sinkID":5}');
    assert.ok(has('/var/opt/public/oap/oap_13003/data/jap_ridetube8.log') && has('/var/opt/public/oap/oap_12201/data/custom_apps.json') && has('/var/opt/mgu-deploy/id8/pending.json'));
    const log = f['/var/opt/jap-ridetube-d/log/ytd.log'];
    assert.ok(log.text.length === 400000 && /THE END$/.test(log.text) && log.cut === 'the last 400000 bytes', 'a long log: its end');
    assert.ok(data.lists.processes.some((l) => / 77 \/usr\/bin\/mediaplayerd --instance CarPlayMedia$/.test(l)));
    assert.deepStrictEqual(data.lists.apps.filter((a) => a.home === 'oap_12218')[0].media.length, 1);
    assert.ok(/the same as /.test(data.lists.apps.filter((a) => a.home === 'oap_12218')[0].media[0]));
    assert.ok(has('/usr/lib/systemd/system/mediaplayerd.service') && data.lists['/usr/lib (mfx, va, gst)'].indexOf('libmfxhw64.so') >= 0);
    assert.deepStrictEqual(data.commands, {}, 'no commands in a test');
};
check(decode(Buffer.from(text)));
console.log('ok   collected as on the unit (the script on stdin); what is private stays');
check(decode(Buffer.from('ssh -p 22 root@169.254.1.1\r\nWarning: Permanently added\r\n' + text.replace(/\n/g, '\r\n') + 'logout\r\n')));
check(decode(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('noise\r\n' + text.replace(/\n/g, '\r\n'), 'utf16le')])));
console.log('ok   read back with other output around it, CRLF, and as UTF-16');
assert.throws(() => decode(Buffer.from(text.slice(0, 2000))), /cut off/);
assert.throws(() => decode(Buffer.from('nothing')), /no RideTube data/);
const dir = path.join(root, 'unpacked');
unpack(decode(Buffer.from(text)), dir);
assert.strictEqual(fs.readFileSync(path.join(dir, 'files/usr/lib/oap-mainapp21/src/media/Player.js'), 'utf8').indexOf('x=buildProxy('), 0);
assert.ok(/the last 400000 bytes of 500007/.test(fs.readFileSync(path.join(dir, 'notes.txt'), 'utf8')));
const evil = decode(Buffer.from(text)); evil.files = { '/../../../escape.txt': { size: 1, text: 'x' } };
unpack(evil, path.join(root, 'u2'));
assert.ok(!fs.existsSync(path.join(root, 'escape.txt')) && fs.existsSync(path.join(root, 'u2/files/escape.txt')), 'paths stay inside the folder');
// --out writes the same text to a file
const r2 = cp.spawnSync(process.execPath, [path.join(__dirname, 'id8_collect.js'), '--out', path.join(root, 'o.txt')], { env: Object.assign({}, process.env, { RT_ROOT: root }) });
assert.strictEqual(r2.status, 0, String(r2.stderr));
check(decode(fs.readFileSync(path.join(root, 'o.txt'))));
console.log('ok   unpacked into files; a cut or empty copy is said; --out');
console.log('id8_collect: all ok');
