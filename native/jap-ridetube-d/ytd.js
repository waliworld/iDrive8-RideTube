'use strict';
// SPDX-License-Identifier: GPL-3.0-or-later
// jap-ridetube-d daemon (RideTube): plays a video on the MGU. Audio goes through BMW's
// MediaPlayer over SOME/IP, video through
// ytdec, paced by the MediaPlayer clock. The app talks to it on /run/jap-ridetube-d/ctl.sock (JSON
// lines; README.md has the protocol). Node 8: no ?. / ?? / catch without binding.
// 0.1.6: feed{which, items, shelves:[{title, items}]}, items carry meta (the tile's second line).
// The car fetches (ytfetch.py), searches (InnerTube) and makes thumbs (thumb.js) itself, all as the fetch uid; playback starts while the video is still being fetched.
// It never exits on its own: a stray exception is logged, audio is released, it goes idle.
const fs = require('fs');
const path = require('path');
const net = require('net');
const https = require('https');
const crypto = require('crypto');
const cp = require('child_process');
const readline = require('readline');

const ID_RE = /^[A-Za-z0-9_-]{11}$/;
// the audio route on iDrive 7 (measured on the car); state/audio.json overrides them (see Audio.init)
const SOURCE_ID = 1046, SINK_ID = 1024, MEDIA_INSTANCE = 'OapGenericMedia';
// where MainApp keeps the SOME/IP interface descriptions: iDrive 7 (oap-mainapp), iDrive 8 (oap-mainapp21)
const SRC_GENS = ['/usr/lib/oap-mainapp/src-gen', '/usr/lib/oap-mainapp/src-gen/someip',
    '/usr/lib/oap-mainapp21/src-gen/someip', '/usr/lib/oap-mainapp21/src-gen'];
const MEDIA_FILES = ['audio.m4a', 'index.bin', 'video.h264'];
// a video's folder: BMW's media engine (its own uid, no capabilities) opens audio.m4a in it, so it must be able to
// pass through; no read bit, so nobody lists it (and the cache above is 0711: the video ids aren't listed either)
const VIDEO_DIR_MODE = 0o711;
// thumb.rgba length -> [w, h]: 160x90 in caches from older proxies, 320x180 since 0.1.6
const THUMB_SIZES = { 57600: [160, 90], 230400: [320, 180] };

function defaults() {
    const env = process.env;
    const here = __dirname;
    return {
        someip: env.MGU_YT_SOMEIP || '/usr/lib/someip.node',
        srcGen: env.MGU_YT_SRCGEN || null,     // one folder (tests); null: the first of srcGens that has the file
        srcGens: SRC_GENS,
        audioConf: env.MGU_YT_AUDIO || '/var/opt/jap-ridetube-d/state/audio.json',
        ytdec: env.MGU_YT_YTDEC || path.join(here, 'ytdec'),
        cacheDir: env.MGU_YT_CACHE || '/var/opt/jap-ridetube-d/cache',
        logDir: env.MGU_YT_LOGDIR || '/var/opt/jap-ridetube-d/log',
        sock: env.MGU_YT_SOCK || '/run/jap-ridetube-d/ctl.sock',
        sockGid: 12202, // tm_oap_app
        accountFile: env.MGU_YT_ACCOUNT || '/var/opt/jap-ridetube-d/state/account.json',
        ytRequest: null,     // null: each request in a child as the fetch uid (fetchRequest)
        // the fetch uid's pick (pickFetchUid) and the helper it runs
        stateDir: env.MGU_YT_STATE || '/var/opt/jap-ridetube-d/state',
        etcDir: '/etc',
        oapRoot: '/var/opt/public/oap',
        toolRoot: '/var/opt',
        procDir: '/proc',
        mainapps: MAINAPPS,
        fetchCmd: [process.execPath, '--max-http-header-size=65536', __filename, '--fetch'],
        fetcher: ['/var/opt/mgu-python/current/bin/python3', path.join(here, 'ytfetch.py')],
        thumbCmd: ['/var/opt/jap-node22/current/bin/node', path.join(here, 'thumb.js')],
        startVideoMs: 6000,  // video fetched ahead before playback starts (later the buffering pause covers a slow link)
        fetchRetryMs: [3000, 8000], // a fetch failing before playback (the network): tried again after these waits
        spare: true,         // keep a ytfetch.py serve (yt-dlp loaded) waiting while the app is in use
        warmMs: 600000,      // ... for this long after the app's last command
        infoMaxMs: 1500000,
        leaseFile: '/run/mgu-uplink/lease.json',
        resume: true,        // a play starts where the video was left (positions.json)
        sponsorBlock: 'https://sponsor.ajay.app/api/skipSegments/',
        skip: ['sponsor', 'selfpromo', 'interaction', 'intro'], // SponsorBlock categories skipped (the play's own `skip` wins)
        sbCategories: ['sponsor', 'selfpromo', 'interaction', 'intro', 'outro', 'music_offtopic'], // looked up, sent in extras  // a prefetched stream lookup is used this long (ytfetch: 30 min, URLs: ~6 h)
        headMarginMs: 1500,  // on the head file: wait for audio.m4a this close to the head's end
        thumbMax: 150,
        ytTimeoutMs: 10000,
        keep: 0,             // played videos kept in the cache (0: deleted once played; nothing is kept for offline)
        watchdogMs: 5000,
        tickMs: 5000,
        availWaitMs: 5000,
        log: function (m) { console.log(new Date().toISOString() + ' ' + m); }
    };
}

function monoMs() {
    const t = process.hrtime(); // CLOCK_MONOTONIC on Linux
    return Math.floor(t[0] * 1000 + t[1] / 1e6);
}
// the app's Video quality: 360 | 480 | 720, else auto: 720 on Wi-Fi (the uplink's wlan*) or no uplink known, 480 on phone data
function qualityHeight(q, lease) {
    if ([360, 480, 720].indexOf(Number(q)) >= 0) return Number(q);
    return lease && lease.interface && !/^wlan/.test(String(lease.interface)) ? 480 : 720;
}
// members-only (or members-first) videos: a badge somewhere in the tile, its shape unknown (no capture) - matched on the text
// shortcut: a JSON scan of the tile, swap for the badge's field once a real members tile is captured
const isMembers = (t) => /BADGE_STYLE_TYPE_MEMBERS|"Members (only|first)"/i.test(JSON.stringify(t));
const PERMANENT_RE = /unavailable|private|removed|terminated|copyright|members|age|confirm your age|not available in your country/i;
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function withTimeout(p, ms, what) {
    return new Promise(function (resolve, reject) {
        const t = setTimeout(function () { reject(new Error(what + ' timed out')); }, ms);
        p.then(function (v) { clearTimeout(t); resolve(v); }, function (e) { clearTimeout(t); reject(e); });
    });
}
function rmrf(p) {
    let st;
    try { st = fs.lstatSync(p); } catch (e) { return; }
    if (st.isDirectory()) {
        fs.readdirSync(p).forEach(function (n) { rmrf(path.join(p, n)); });
        fs.rmdirSync(p);
    } else {
        fs.unlinkSync(p);
    }
}
function mkdirp(p) {
    if (fs.existsSync(p)) return;
    mkdirp(path.dirname(p));
    fs.mkdirSync(p, 0o755);
}

// ---------------------------------------------------------------- playback cache (no downloads: a played video goes)
function readMeta(dir, id) {
    try {
        const m = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')); // ytfetch writes it
        return { id: id, title: m.title || id, channel: m.channel || '', duration_s: m.duration_s || null };
    } catch (e) { return { id: id, title: id, channel: '', duration_s: null }; }
}
// enough to start without a fetch. No video.h264.part: play() stops any fetcher first, so a .part is a
// dead fetch's leftover that would never complete (fetched again instead)
function isPlayable(dir) {
    const has = (n) => fs.existsSync(path.join(dir, n));
    return has('audio.m4a') && !has('audio.m4a.part') && has('index.bin') && has('video.h264');
}
function isReady(dir) {
    let names;
    try { names = fs.readdirSync(dir); } catch (e) { return false; }
    if (names.some(function (n) { return /\.part$/.test(n); })) return false;
    return MEDIA_FILES.every(function (n) { return names.indexOf(n) >= 0; });
}
function listCache(cacheDir) {
    let names;
    try { names = fs.readdirSync(cacheDir); } catch (e) { return []; }
    const out = [];
    names.forEach(function (n) {
        if (!ID_RE.test(n)) return;
        const dir = path.join(cacheDir, n);
        let st;
        try { st = fs.statSync(dir); } catch (e) { return; }
        if (!st.isDirectory()) return;
        const item = readMeta(dir, n);
        item.ready = isReady(dir);
        item.mtime = st.mtime.getTime();
        out.push(item);
    });
    out.sort(function (a, b) { return b.mtime - a.mtime; });
    return out;
}
// Keep the `keep` most recent ids (dir mtime); never the protected ones (playing/preparing).
function pruneCache(cacheDir, keep, protect, log) {
    const items = listCache(cacheDir);
    const removed = [];
    let kept = 0;
    items.forEach(function (it) {
        if (protect.indexOf(it.id) >= 0) { kept++; return; }
        if (kept < keep) { kept++; return; }
        try { rmrf(path.join(cacheDir, it.id)); removed.push(it.id); } catch (e) { log('lru: ' + it.id + ': ' + e.message); }
    });
    if (removed.length) log('lru removed ' + removed.join(','));
    return removed;
}

// ---------------------------------------------------------------- the fetch uid
// mgu-uplink lets out only the uids it lists, never root: every youtube.com request runs in a child
// as our own "fetch" uid, which the uplink learns from uids.d/jap-ridetube-d (written here, and by the deploy
// tool from state/internet-uids). Picked as mgu-updater's js/uids.js picks its own: the lowest free
// number above MainApp's app uid ranges, kept in state/uids.json while nothing else holds it.
const SELF = 'jap-ridetube-d';
const MAX_UID = 60000; // login.defs UID_MAX
const MAINAPPS = [{ root: '/usr/lib/oap-mainapp', hmi: 'HmiMain3D' }, { root: '/usr/lib/oap-mainapp21', hmi: 'Hmi8' }];
const lines = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n'); } catch (e) { return []; } };
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } };
const list = (d) => { try { return fs.readdirSync(d); } catch (e) { return []; } };
const isId = (n) => n > 0 && n === Math.floor(n);

// MainApp's app uid ranges [{min,max}] and own uids, from the config of the MainApp the unit runs; null unknown
function mainappRanges(o) {
    const have = o.mainapps.filter((m) => fs.existsSync(path.join(m.root, 'config', 'base.json')));
    let m = have.length === 1 ? have[0] : null;
    if (have.length > 1) {
        const running = list(o.procDir).filter((n) => /^\d+$/.test(n)).map((n) => (lines(path.join(o.procDir, n, 'comm'))[0] || '').trim());
        const which = have.filter((x) => running.indexOf(x.hmi) >= 0);
        m = which.length === 1 ? which[0] : null;
    }
    const c = m && readJson(path.join(m.root, 'config', 'base.json'));
    if (!c) return null;
    const rse = c.usableUidsAndGidsRse || {};
    const ranges = [c.usableUidsAndGids].concat(Object.keys(rse).map((k) => rse[k]))
        .filter((r) => r && isId(Number(r.min)) && Number(r.max) >= Number(r.min)).map((r) => ({ min: Number(r.min), max: Number(r.max) }));
    return ranges.length ? { ranges: ranges, own: (Array.isArray(c.mainAppUids) ? c.mainAppUids : []).map(Number).filter(isId) } : null;
}
// every uid and gid in use: /etc/passwd and group, OAP apps (oap_<uid> folders, MainApp's registry and
// uids.txt), other components' uplink drop-ins, mgu-updater's uids.json, MainApp's own; procs: running ones
function takenIds(o, cfg, procs) {
    const ids = {};
    const add = (v) => { const n = Number(v); if (String(v).trim() !== '' && isId(n)) ids[n] = true; };
    lines(path.join(o.etcDir, 'passwd')).forEach((l) => { const f = l.split(':'); add(f[2] || ''); add(f[3] || ''); });
    lines(path.join(o.etcDir, 'group')).forEach((l) => add(l.split(':')[2] || ''));
    list(o.oapRoot).forEach((n) => { const m = /^oap_(\d+)$/.exec(n); if (m) add(m[1]); });
    const mgr = path.join(o.oapRoot, 'oap_12201');
    list(path.join(mgr, 'data', 'apps')).forEach((n) => { const e = readJson(path.join(mgr, 'data', 'apps', n)); add(e && e.userId !== undefined ? e.userId : ''); });
    lines(path.join(mgr, 'security', 'uids.txt')).forEach((l) => add(l.split('=')[0]));
    const dropins = path.join(o.toolRoot, 'mgu-uplink', 'uids.d');
    list(dropins).filter((n) => n !== SELF && !/^\./.test(n))
        .forEach((n) => lines(path.join(dropins, n)).forEach((l) => l.split('#')[0].split(/[\s,]+/).forEach(add)));
    const upd = readJson(path.join(o.toolRoot, 'mgu-updater', 'state', 'uids.json')) || {};
    Object.keys(upd).forEach((k) => add(upd[k]));
    (cfg ? cfg.own : []).forEach(add);
    if (procs) {
        list(o.procDir).filter((n) => /^\d+$/.test(n)).forEach((pid) => lines(path.join(o.procDir, pid, 'status')).forEach((l) => {
            const m = /^[UG]id:\s+(.*)$/.exec(l);
            if (m) m[1].split(/\s+/).forEach(add);
        }));
    }
    return ids;
}
function writeIfChanged(file, text, mode) {
    try { if (fs.readFileSync(file, 'utf8') === text) return; } catch (e) { /* not there yet */ }
    fs.writeFileSync(file + '.tmp', text, { mode: mode });
    fs.renameSync(file + '.tmp', file);
}
// the kept fetch uid while nothing else holds it, else a new pick; written for the uplink. null: none (logged)
function pickFetchUid(o) {
    const kept = Number((readJson(path.join(o.stateDir, 'uids.json')) || {}).fetch);
    const cfg = mainappRanges(o);
    const inRange = (u) => !!cfg && cfg.ranges.some((r) => u >= r.min && u <= r.max);
    let uid = null;
    if (isId(kept) && !takenIds(o, cfg, false)[kept] && !inRange(kept)) uid = kept;
    else if (cfg) {
        const all = takenIds(o, cfg, true);
        let u = Math.max.apply(null, cfg.ranges.map((r) => r.max)) + 1;
        while (u <= MAX_UID && (all[u] || inRange(u))) u++;
        if (u <= MAX_UID) { uid = u; o.log('internet uid: ' + u + (isId(kept) ? ' (' + kept + ' is taken)' : '')); }
    }
    if (uid === null) {
        o.log('internet uid: none: ' + (cfg ? 'no free uid below ' + MAX_UID : "MainApp's config/base.json (its app uid ranges) cannot be read"));
        return null;
    }
    if (!fs.existsSync(o.stateDir)) { mkdirp(path.dirname(o.stateDir)); fs.mkdirSync(o.stateDir, 0o700); }
    writeIfChanged(path.join(o.stateDir, 'uids.json'), JSON.stringify({ fetch: uid }) + '\n', 0o644);
    writeIfChanged(path.join(o.stateDir, 'internet-uids'), uid + '\n', 0o644);
    const uplink = path.join(o.toolRoot, 'mgu-uplink');
    if (fs.existsSync(path.join(uplink, 'current')) || fs.existsSync(path.join(uplink, 'uids.d'))) {
        try { mkdirp(path.join(uplink, 'uids.d')); writeIfChanged(path.join(uplink, 'uids.d', SELF), uid + '\n', 0o644); } catch (e) { o.log('internet uid: uplink drop-in: ' + e.message); }
    }
    return uid;
}
// one request in a child as uid (fetchCmd: ytd.js --fetch). The request, secrets and all, goes on its stdin
// (argv and env show in ps); {status, body} or {error} comes back on its stdout. Killed past the timeout.
function fetchRequest(o, uid, req) {
    return new Promise(function (resolve, reject) {
        let child;
        try {
            // (o.noSetuid: tests not run as root, which cannot switch uid)
            const ids = o.noSetuid ? {} : { uid: uid, gid: uid };
            child = cp.spawn(o.fetchCmd[0], o.fetchCmd.slice(1), Object.assign(ids, { cwd: '/', env: {}, stdio: ['pipe', 'pipe', 'ignore'] }));
        } catch (e) { return reject(e); }
        const chunks = [];
        let size = 0, done = false;
        const finish = function (e, v) {
            if (done) return;
            done = true;
            clearTimeout(timer);
            if (e) { try { child.kill('SIGKILL'); } catch (x) { /* gone */ } reject(e); } else resolve(v);
        };
        const timer = setTimeout(function () { finish(new Error('timeout')); }, (req.timeoutMs || 10000) + 1000);
        child.on('error', finish);
        child.stdin.on('error', function () { /* it died: close says */ });
        child.stdout.on('data', function (c) {
            size += c.length;
            if (size > 24 << 20) return finish(new Error('answer too big')); // 8 MiB of body, JSON-escaped
            chunks.push(c);
            return undefined;
        });
        child.on('close', function () {
            let r = null;
            try { r = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { /* none */ }
            if (!r) return finish(new Error('fetch helper gave no answer'));
            if (r.error) return finish(new Error(r.error));
            return finish(null, { status: r.status, body: String(r.body) });
        });
        child.stdin.end(JSON.stringify(req));
    });
}

// ---------------------------------------------------------------- YouTube account: the TV device sign-in (as SmartTube does)
// The car itself talks to www.youtube.com: the TV page's client id + secret (scraped at run time, never
// shipped), a device code the user enters at google.com/device, then TVHTML5 browse for the feeds.
// Tokens live in accountFile (0600, written atomically) and never cross the ctl socket or the log.
const YT = 'https://www.youtube.com';
const TV_UA = 'Mozilla/5.0 (Linux; Tizen 2.4.0) AppleWebKit/538.1 (KHTML, like Gecko) Version/2.4.0 TV Safari/538.1';
const TV_CLIENT = { clientName: 'TVHTML5', clientVersion: '7.20251101.10.00', hl: 'en' };
const CRED_RE = /clientId:"([-\w]+\.apps\.googleusercontent\.com)",\n?[$\w]+:"([-\w]+)"/;
const SCOPE = 'http://gdata.youtube.com https://www.googleapis.com/auth/youtube-paid-content';
const TOKEN_URL = YT + '/o/oauth2/token';
const FEEDS = { home: 'FEwhat_to_watch', subs: 'FEsubscriptions', wl: 'VLWL' };
const FEED_MAX = 50;

// method, url, headers, body (JSON or null) -> {status, body (utf8)}; no redirects (none seen on these URLs)
function ytRequest(method, url, headers, body, timeoutMs, lookup) {
    return new Promise(function (resolve, reject) {
        const u = require('url').parse(url);
        const data = body ? Buffer.from(JSON.stringify(body)) : null;
        const h = Object.assign({ 'User-Agent': TV_UA }, headers || {});
        if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = data.length; }
        let done = false, size = 0;
        const fail = function (e) { if (!done) { done = true; clearTimeout(timer); reject(e); } };
        const req = https.request({ hostname: u.hostname, port: u.port, path: u.path, method: method, headers: h, lookup: lookup }, function (res) {
            const chunks = [];
            res.on('data', function (c) {
                size += c.length;
                if (size > 8 << 20) { fail(new Error('answer too big')); req.abort(); return; }
                chunks.push(c);
            });
            res.on('end', function () {
                if (done) return;
                done = true;
                clearTimeout(timer);
                resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') });
            });
            res.on('error', fail);
        });
        const timer = setTimeout(function () { fail(new Error('timeout')); req.abort(); }, timeoutMs || 10000);
        req.on('error', fail);
        if (data) req.write(data);
        req.end();
    });
}

const runsText = (x) => (!x ? '' : typeof x.simpleText === 'string' ? x.simpleText
    : Array.isArray(x.runs) ? x.runs.map((r) => (r && r.text) || '').join('') : '');
function hms(s) { return /^\d+(:\d{1,2}){1,2}$/.test(s) ? s.split(':').reduce((a, p) => a * 60 + Number(p), 0) : null; }
// One TVHTML5 tileRenderer -> {id,title,channel,duration_s,meta}, or null when it is not a video
// (shorts, channels, playlists). meta: the texts of the second line, without its "•" and badges ("4K").
function tileItem(t) {
    const ep = t.onSelectCommand && t.onSelectCommand.watchEndpoint;
    const id = t.contentId || (ep && ep.videoId);
    if (t.contentType !== 'TILE_CONTENT_TYPE_VIDEO' || !ID_RE.test(String(id))) return null;
    const m = (t.metadata && t.metadata.tileMetadataRenderer) || {};
    const lines = (Array.isArray(m.lines) ? m.lines : []).map((l) => ((l && l.lineRenderer && l.lineRenderer.items) || [])
        .map((i) => runsText(i && i.lineItemRenderer && i.lineItemRenderer.text)));
    const ovs = (t.header && t.header.tileHeaderRenderer && t.header.tileHeaderRenderer.thumbnailOverlays) || [];
    const ov = ovs.map((x) => x && x.thumbnailOverlayTimeStatusRenderer).filter(Boolean)[0];
    const rp = ovs.map((x) => x && x.thumbnailOverlayResumePlaybackRenderer).filter(Boolean)[0];   // the account's own progress
    const it = { id: id, title: runsText(m.title) || id, channel: (lines[0] || []).join(''), duration_s: hms(runsText(ov && ov.text)),
        meta: (lines[1] || []).filter((x) => x && x.trim() !== '\u2022') };
    if (rp && rp.percentDurationWatched > 0) it.watched_pct = Math.min(100, Number(rp.percentDurationWatched) || 0);
    if (ep && ep.startTimeSeconds > 0) it.start_s = Number(ep.startTimeSeconds);
    if (isMembers(t)) it.members = true;
    return it;
}
// One TVHTML5 lockupViewModel (search answers, 2026-11) -> the same, or null when not a video: playlists
// (contentId a list) and channels (no watchEndpoint). meta: the second metadata row, without badges.
function lockupItem(l) {
    const cc = l.rendererContext && l.rendererContext.commandContext;
    const cmd = cc && cc.onTap && cc.onTap.innertubeCommand;
    const id = cmd && cmd.watchEndpoint && cmd.watchEndpoint.videoId;
    if (!ID_RE.test(String(id)) || id !== l.contentId) return null;
    const m = (l.metadata && l.metadata.lockupMetadataViewModel) || {};
    const cm = m.metadata && m.metadata.contentMetadataViewModel;
    const rows = ((cm && cm.metadataRows) || []).map((r) => ((r && r.metadataParts) || []).map((x) => (x && x.text && x.text.content) || '').filter(Boolean));
    const tv = (l.contentImage && l.contentImage.thumbnailViewModel) || {};
    const ov = (tv.overlays || []).map((x) => x && x.thumbnailBottomOverlayViewModel).filter(Boolean)[0];
    const len = ((ov && ov.badges) || []).map((x) => x && x.thumbnailBadgeViewModel && x.thumbnailBadgeViewModel.text).filter(Boolean)[0];
    const it = { id: id, title: (m.title && m.title.content) || id, channel: (rows[0] || []).join(''), duration_s: hms(String(len)), meta: rows[1] || [] };
    if (isMembers(l)) it.members = true;
    return it;
}
// every video tile (or lockup) under o, in page order, each id once
function videoTiles(o) {
    const out = [], seen = {};
    (function walk(o) {
        if (!o || typeof o !== 'object') return;
        const t = o.tileRenderer || o.lockupViewModel;
        if (t && typeof t === 'object') {
            const it = o.tileRenderer ? tileItem(t) : lockupItem(t);
            if (it && !seen[it.id]) { seen[it.id] = true; out.push(it); }
            return;
        }
        Object.keys(o).forEach((k) => walk(o[k]));
    })(o);
    return out;
}
// A TVHTML5 browse answer -> its video tiles wherever they sit (shelves, tabs, the playlist), each id once.
function feedItems(root) { return videoTiles(root); }
const SHELF_MAX = 8, SHELF_TILES = 12;
// A TVHTML5 browse answer -> [{title, items}], one per shelfRenderer with video tiles, page order. An untitled
// shelf (Subscriptions' per-channel groups) is named after its channel when all its tiles share one.
// No shelfRenderer (Watch later is a playlist): [].
function feedShelves(root) {
    const out = [];
    (function walk(o) {
        if (!o || typeof o !== 'object') return;
        const s = o.shelfRenderer;
        if (s && typeof s === 'object') {
            const items = videoTiles(s.content);
            if (!items.length) return;
            const h = (s.headerRenderer && s.headerRenderer.shelfHeaderRenderer) || {};
            const al = h.avatarLockup && h.avatarLockup.avatarLockupRenderer;
            let title = runsText(al && al.title) || runsText(h.title);
            if (!title && items.every((i) => i.channel === items[0].channel)) title = items[0].channel;
            out.push({ title: title, items: items.slice(0, SHELF_TILES) });
            return;
        }
        Object.keys(o).forEach((k) => walk(o[k]));
    })(root);
    return out.slice(0, SHELF_MAX);
}

// FEchannels (the TV app's "Channels" page: every subscription, A-Z) -> [{id, title, handle}], each channel once
const CHAN_RE = /^UC[\w-]{22}$/;
function channelTiles(root) {
    const out = [], seen = {};
    (function walk(o) {
        if (!o || typeof o !== 'object') return;
        const t = o.tileRenderer;
        if (t && typeof t === 'object') {
            const ep = t.onSelectCommand && t.onSelectCommand.browseEndpoint, id = t.contentId || (ep && ep.browseId);
            if (t.contentType !== 'TILE_CONTENT_TYPE_CHANNEL' || !CHAN_RE.test(String(id)) || seen[id]) return;
            const m = (t.metadata && t.metadata.tileMetadataRenderer) || {};
            const lines = (Array.isArray(m.lines) ? m.lines : []).map((l) => ((l && l.lineRenderer && l.lineRenderer.items) || [])
                .map((i) => runsText(i && i.lineItemRenderer && i.lineItemRenderer.text)).join(''));
            seen[id] = true;
            out.push({ id: id, title: runsText(m.title) || id, handle: lines.filter((x) => x.charAt(0) === '@')[0] || '' });
            return;
        }
        Object.keys(o).forEach((k) => walk(o[k]));
    })(root);
    return out;
}

// emit(o): to the app. Every method answers with an event and never rejects (a rejection would be a fault).
function Account(opts, emit) {
    this.opts = opts;
    this.log = opts.log;
    this.emit = emit;
    this.pending = null;     // the device code shown: {cid, sec, device, code, url, interval, expires, timer}
    this.starting = false;
    this.refreshing = null;
    this.feeding = Object.create(null); // which -> the browse in flight, shared by later asks
    this.cred = null;        // the TV page's client id + secret, scraped once a process (again when refused)
    this.gen = 0;            // bumped by sign_out: work started before it saves, shows and re-arms nothing
}
Account.prototype.load = function () {
    try {
        const a = JSON.parse(fs.readFileSync(this.opts.accountFile, 'utf8'));
        return a && (a.refresh || a.access) ? a : null;
    } catch (e) { return null; }
};
Account.prototype.save = function (a) {
    const f = this.opts.accountFile, tmp = f + '.tmp', dir = path.dirname(f);
    if (!fs.existsSync(dir)) { mkdirp(path.dirname(dir)); fs.mkdirSync(dir, 0o700); }
    try { fs.unlinkSync(tmp); } catch (e) { /* none */ }
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try { fs.writeSync(fd, JSON.stringify(a)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, f);
};
Account.prototype.json = function (method, url, body, headers) {
    return this.opts.ytRequest(method, url, headers || null, body || null, this.opts.ytTimeoutMs).then((r) => {
        let j = null;
        try { j = JSON.parse(r.body); } catch (e) { /* not JSON */ }
        return { status: r.status, j: j };
    });
};
Account.prototype.status = function () {
    if (this.load()) return { ev: 'auth', state: 'signed_in' };
    const p = this.pending;
    if (p && Date.now() < p.expires) return { ev: 'auth', state: 'code', code: p.code, url: p.url, expires: Math.round((p.expires - Date.now()) / 1000) };
    return { ev: 'auth', state: 'signed_out' };
};
// the TV page's client id + secret: inline in the page (2026-11), else in its base script
Account.prototype.creds = async function () {
    const get = (u) => this.opts.ytRequest('GET', u, null, null, this.opts.ytTimeoutMs).then((r) => {
        if (r.status !== 200) throw new Error('tv page ' + r.status);
        return r.body;
    });
    const page = await get(YT + '/tv');
    let m = CRED_RE.exec(page);
    const re = /src="(\/s\/[^"]+(?:\/base\.js|m=base))"/g;
    let s;
    while (!m && (s = re.exec(page))) m = CRED_RE.exec(await get(YT + s[1]));
    if (!m) throw new Error('no client id in the TV page');
    return { cid: m[1], sec: m[2] };
};
// `auth`: signed in or a code still valid -> said again; else a new device code, then polled until used or expired
Account.prototype.start = async function () {
    if (this.status().state !== 'signed_out') return this.emit(this.status());
    if (this.starting) return undefined; // its answer comes
    this.starting = true;
    const g = this.gen;
    const ask = (c) => this.json('POST', YT + '/o/oauth2/device/code',
        { client_id: c.cid, scope: SCOPE, device_id: crypto.randomBytes(16).toString('hex'), device_model: 'ytlr::' });
    try {
        const cached = !!this.cred;
        let c = this.cred || (this.cred = await this.creds());
        if (g !== this.gen) return undefined;
        let r = await ask(c);
        if (g !== this.gen) return undefined;
        if (cached && !(r.j && r.j.device_code)) { // the cached client refused: scrape the page again, once
            this.cred = null;
            c = this.cred = await this.creds();
            if (g !== this.gen) return undefined;
            r = await ask(c);
            if (g !== this.gen) return undefined;
        }
        const j = r.j || {};
        if (!j.user_code || !j.device_code) throw new Error('device code refused: ' + (j.error || r.status));
        this.pending = { cid: c.cid, sec: c.sec, device: j.device_code, code: String(j.user_code), url: j.verification_url || 'https://www.google.com/device',
            interval: Number(j.interval) > 0 ? Number(j.interval) * 1000 : 5000, expires: Date.now() + (Number(j.expires_in) || 1800) * 1000 };
        this.log('sign-in: code issued');
        this.emit(this.status());
        this.poll(this.pending);
    } catch (e) {
        this.log('sign-in: ' + e.message);
        if (g === this.gen) this.emit({ ev: 'auth', state: 'error', msg: e.message });
    } finally {
        this.starting = false;
    }
    return undefined;
};
Account.prototype.poll = function (p) {
    p.timer = setTimeout(() => this.pollOnce(p).catch((e) => {
        this.log('sign-in: ' + e.message);
        if (this.pending === p) { this.pending = null; this.emit({ ev: 'auth', state: 'error', msg: e.message }); }
    }), p.interval);
};
Account.prototype.pollOnce = async function (p) {
    if (this.pending !== p) return undefined;
    if (Date.now() >= p.expires) {
        this.pending = null;
        this.log('sign-in: code expired');
        return this.emit({ ev: 'auth', state: 'signed_out' });
    }
    let r;
    try {
        r = await this.json('POST', TOKEN_URL, { client_id: p.cid, client_secret: p.sec, code: p.device, grant_type: 'http://oauth.net/grant_type/device/1.0' });
    } catch (e) {
        this.log('sign-in poll: ' + e.message); // offline a moment: ask again until the code expires
        return this.pending === p ? this.poll(p) : undefined;
    }
    if (this.pending !== p) return undefined;
    const j = r.j || {};
    if (j.access_token) {
        this.pending = null;
        this.save({ cid: p.cid, sec: p.sec, access: j.access_token, refresh: j.refresh_token || null, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000 });
        this.log('sign-in: signed in');
        return this.emit({ ev: 'auth', state: 'signed_in' });
    }
    if (j.error === 'slow_down') p.interval += 5000;
    if (j.error === 'authorization_pending' || j.error === 'slow_down') return this.poll(p);
    this.pending = null;
    this.log('sign-in: ' + (j.error || 'token ' + r.status));
    return this.emit(j.error === 'access_denied' || j.error === 'expired_token' ? { ev: 'auth', state: 'signed_out' } : { ev: 'auth', state: 'error', msg: j.error || 'token ' + r.status });
};
Account.prototype.signOut = function () {
    this.gen++;
    this.refreshing = null;
    if (this.pending) clearTimeout(this.pending.timer);
    this.pending = null;
    this.drop('asked');
};
Account.prototype.drop = function (why) {
    try { fs.unlinkSync(this.opts.accountFile); } catch (e) { /* none */ }
    this.log('account: signed out (' + why + ')');
    this.emit({ ev: 'auth', state: 'signed_out' });
};
// an access token with 5 min left at least: refreshed when not (force: anyway), one refresh at a time
Account.prototype.token = function (force) {
    const a = this.load();
    const out = new Error('signed out');
    out.signedOut = true;
    if (!a) return Promise.reject(out);
    if (!force && a.access && a.exp - Date.now() > 5 * 60000) return Promise.resolve(a.access);
    if (!this.refreshing) {
        const p = this.refresh(a, out), done = () => { if (this.refreshing === p) this.refreshing = null; };
        this.refreshing = p;
        p.then(done, done);
    }
    return this.refreshing;
};
Account.prototype.refresh = async function (a, out) {
    if (!a.refresh) { this.drop('token expired'); throw out; }
    const g = this.gen;
    const r = await this.json('POST', TOKEN_URL, { client_id: a.cid, client_secret: a.sec, refresh_token: a.refresh, grant_type: 'refresh_token' });
    if (g !== this.gen) throw out; // signed out meanwhile: the new token is not kept
    const j = r.j || {};
    if (j.access_token) {
        a.access = j.access_token;
        a.exp = Date.now() + (Number(j.expires_in) || 3600) * 1000;
        if (j.refresh_token) a.refresh = j.refresh_token;
        this.save(a);
        this.log('account: token refreshed');
        return a.access;
    }
    if (j.error === 'invalid_grant') { this.drop('invalid_grant'); throw out; } // revoked or expired: sign in again
    throw new Error('refresh: ' + (j.error || r.status));
};
Account.prototype.browse = function (browseId, token) {
    return this.json('POST', YT + '/youtubei/v1/browse', { context: { client: TV_CLIENT }, browseId: browseId }, { Authorization: 'Bearer ' + token });
};
// `feed` {which: home|subs|wl} -> feed{which, items, shelves} or feed{which, error}
Account.prototype.feed = function (which) {
    which = String(which);
    if (typeof FEEDS[which] !== 'string') { this.emit({ ev: 'feed', which: which, error: 'unknown feed' }); return Promise.resolve(); }
    if (!this.feeding[which]) {
        const done = () => { delete this.feeding[which]; };
        this.feeding[which] = this.loadFeed(which);
        this.feeding[which].then(done, done);
    }
    return this.feeding[which];
};
Account.prototype.loadFeed = async function (which) {
    const g = this.gen;
    try {
        let r = await this.browse(FEEDS[which], await this.token(false));
        if (r.status === 401) r = await this.browse(FEEDS[which], await this.token(true)); // the token died early
        if (g !== this.gen) throw Object.assign(new Error('signed out'), { signedOut: true });
        if (r.status !== 200 || !r.j) throw new Error('browse ' + r.status);
        this.emit({ ev: 'feed', which: which, items: feedItems(r.j).slice(0, FEED_MAX), shelves: feedShelves(r.j) });
    } catch (e) {
        if (!e.signedOut) this.log('feed ' + which + ': ' + e.message);
        this.emit({ ev: 'feed', which: which, error: e.signedOut ? 'signed out' : e.noUid ? e.message : 'feed offline' });
    }
    return undefined;
};
// `channels` -> channels{items:[{id,title,handle}]} or channels{error}; the list is kept 10 min
// `channel` {id} -> channel{id, items, shelves} (its page: Videos, Popular...) or channel{id, error}
Account.prototype.channels = function () { return this.browseEv({ ev: 'channels' }, 'FEchannels', (j) => ({ items: channelTiles(j) }), 600000); };
Account.prototype.channel = function (id) {
    if (!CHAN_RE.test(String(id))) { this.emit({ ev: 'channel', id: String(id), error: 'bad channel' }); return Promise.resolve(); }
    return this.browseEv({ ev: 'channel', id: id }, id, (j) => ({ items: feedItems(j).slice(0, FEED_MAX), shelves: feedShelves(j) }), 0);
};
Account.prototype.browseEv = async function (head, browseId, parse, keepMs) {
    const g = this.gen, c = this.kept || (this.kept = {}), k = c[browseId];
    try {
        if (k && keepMs && Date.now() - k.t < keepMs && k.g === g) { this.emit(Object.assign({}, head, k.v)); return undefined; }
        let r = await this.browse(browseId, await this.token(false));
        if (r.status === 401) r = await this.browse(browseId, await this.token(true));
        if (g !== this.gen) throw Object.assign(new Error('signed out'), { signedOut: true });
        if (r.status !== 200 || !r.j) throw new Error('browse ' + r.status);
        const v = parse(r.j);
        if (keepMs) c[browseId] = { t: Date.now(), g: g, v: v };
        this.emit(Object.assign({}, head, v));
    } catch (e) {
        if (!e.signedOut) this.log(head.ev + ': ' + e.message);
        this.emit(Object.assign({}, head, { error: e.signedOut ? 'signed out' : e.noUid ? e.message : 'feed offline' }));
    }
    return undefined;
};
Account.prototype.close = function () {
    if (this.pending) clearTimeout(this.pending.timer);
    this.pending = null;
};

// ---------------------------------------------------------------- audio: BMW MediaPlayer
function Audio(opts, handlers) {
    this.opts = opts;
    this.h = handlers; // {time(v), state(v), error(v)}
    this.cc = null;
    this.mp = null;
    this.connId = null;
    this.src = SOURCE_ID;
    this.sink = SINK_ID;
}
// An interface description: the first folder (srcGen, else srcGens in order) that has the file. iDrive 7 keeps them in
// oap-mainapp/src-gen, iDrive 8 in oap-mainapp21/src-gen/someip.
Audio.prototype.iface = function (file) {
    const dirs = this.opts.srcGen ? [this.opts.srcGen] : this.opts.srcGens || SRC_GENS;
    for (const d of dirs) {
        const p = path.join(d, file);
        let cfg = null;
        try { cfg = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { continue; }
        if (!this.ifaceLogged) this.opts.log('interfaces from ' + d);
        this.ifaceLogged = true;
        return cfg;
    }
    throw new Error('no ' + file + ' in ' + dirs.join(', '));
};
// state/audio.json (optional, written by hand): {"sourceID": n, "sinkID": n, "instance": "..."} for a head unit whose
// audio route differs from iDrive 7's. Read at each init (a fix needs only a restart of the service).
Audio.prototype.conf = function () {
    let c = {};
    try { c = JSON.parse(fs.readFileSync(this.opts.audioConf, 'utf8')) || {}; } catch (e) { /* none: the defaults */ }
    const id = (v, d) => (Number.isInteger(v) && v > 0 && v < 65536 ? v : d);
    return { src: id(c.sourceID, SOURCE_ID), sink: id(c.sinkID, SINK_ID), inst: typeof c.instance === 'string' && c.instance ? c.instance : MEDIA_INSTANCE, set: c };
};
Audio.prototype.init = async function () {
    if (this.cc && this.mp) return;
    const someip = typeof this.opts.someip === 'string' ? require(this.opts.someip) : this.opts.someip;
    const conf = this.conf();
    this.src = conf.src;
    this.sink = conf.sink;
    const cc = await someip.buildProxy(this.iface('org_genivi_am_commandinterface_CommandControl.json'), '1');
    await cc.init();
    const mpCfg = this.iface('de_bmw_infotainment_entertainment_mediaplayer_MediaPlayer.json');
    // a head unit whose MediaPlayer has no such instance (another firmware): say which it has instead of hanging
    const insts = mpCfg && mpCfg.instances && typeof mpCfg.instances === 'object' ? Object.keys(mpCfg.instances) : null;
    if (insts && insts.length && insts.indexOf(conf.inst) < 0) {
        throw new Error('MediaPlayer has no instance ' + conf.inst + ' (it has ' + insts.join(', ') + '; set "instance" in ' + this.opts.audioConf + ')');
    }
    const mp = await someip.buildProxy(mpCfg, conf.inst);
    await mp.init();
    await this.route(cc, conf);
    const h = this.h;
    const safe = (fn) => (v) => { try { fn(v); } catch (e) { this.opts.log('someip handler: ' + (e && e.stack || e)); } };
    mp.subscribe({ name: 'playerState', onReceive: safe(h.state) });
    mp.subscribe({ name: 'currentItemTime', onReceive: safe(h.time) });
    mp.subscribe({ name: 'playbackErrorEvent', onReceive: safe(h.error) });
    this.cc = cc;
    this.mp = mp;
};
// The audio manager's sources and sinks, logged once (what a head unit other than the measured iDrive 7 has), and the
// source checked: when the one configured is not listed but exactly one source named like the media player's
// generic OAP source is, that one is used. Nothing is picked for the sink (the wrong one would play in the wrong
// place): state/audio.json sets it. Lists the head unit cannot give change nothing.
Audio.prototype.route = async function (cc, conf) {
    const list = async (attr) => {
        try { const v = await cc.getValue(attr); return Array.isArray(v) ? v : null; } catch (e) { return null; }
    };
    const name = (x) => String(x && (x.name || x.sourceName || x.sinkName) || '');
    const idOf = (x, k) => (x && typeof x[k] === 'number' ? x[k] : null);
    const sources = await list('listOfMainSources'), sinks = await list('listOfMainSinks');
    if (!this.routeLogged) {
        this.routeLogged = true;
        const fmt = (l, k) => (l ? l.map((x) => idOf(x, k) + (name(x) ? ':' + name(x) : '')).join(' ') : 'not readable');
        this.opts.log('audio sources ' + fmt(sources, 'sourceID') + '; sinks ' + fmt(sinks, 'sinkID') +
            '; using source ' + this.src + ', sink ' + this.sink + (Object.keys(conf.set).length ? ' (audio.json)' : ''));
    }
    if (conf.set.sourceID || !sources || !sources.length || sources.some((x) => idOf(x, 'sourceID') === this.src)) return;
    const named = sources.filter((x) => /oap.?generic.?media/i.test(name(x)) && idOf(x, 'sourceID') !== null);
    if (named.length === 1) {
        this.src = idOf(named[0], 'sourceID');
        this.opts.log('source ' + SOURCE_ID + ' is not on this head unit: using ' + this.src + ' (' + name(named[0]) + ')');
    } else this.opts.log('source ' + this.src + ' is not listed on this head unit; set "sourceID" in ' + this.opts.audioConf);
};
Audio.prototype.waitAvailable = async function () {
    const end = Date.now() + this.opts.availWaitMs;
    while (!(await this.cc.isAvailable())) {
        if (Date.now() > end) throw new Error('CommandControl not available');
        await sleep(100);
    }
};
// At start: a connection from our source left by a killed daemon would hold the sink.
Audio.prototype.dropLeftovers = async function () {
    await this.waitAvailable();
    const list = await this.cc.getValue('listOfMainConnections');
    const ours = (Array.isArray(list) ? list : []).filter((c) => c && c.sourceID === this.src);
    for (const c of ours) {
        const r = await this.cc.callMethod('disconnect', { mainConnectionID: c.mainConnectionID }, 5000).catch((e) => String(e));
        this.opts.log('leftover connection ' + c.mainConnectionID + ' disconnect ' + JSON.stringify(r));
    }
    return ours.length;
};
// release() waits for a play in flight, so a stop during connect/playFile still finds connId
Audio.prototype.play = function (file) {
    const p = this.playNow(file);
    this.pending = p.catch(() => {});
    return p;
};
Audio.prototype.playNow = async function (file) {
    await this.init();
    await this.waitAvailable();
    const r = await this.cc.callMethod('connect', { sourceID: this.src, sinkID: this.sink }, 5000);
    this.opts.log('connect ' + JSON.stringify(r));
    if (!r || (r.amError !== 'E_OK' && r.amError !== 'E_ALREADY_EXISTS')) throw new Error('audio connect: ' + (r && r.amError));
    this.connId = r.mainConnectionID;
    if (this.connId === undefined || this.connId === null) this.connId = -1; // id unknown: release sweeps by source
    const p = await this.mp.callMethod('playFile', { path: file, languageCode: 7695972 }, 5000);
    this.opts.log('playFile ' + JSON.stringify(p));
    if (!p || p.EntError !== 'OK') throw new Error('playFile: ' + (p && p.EntError));
};
// playFile again on the live connection: after a STOP the player needs the file, not PLAY
Audio.prototype.replay = function (file) {
    const p = this.mp.callMethod('playFile', { path: file, languageCode: 7695972 }, 5000).then((r) => {
        this.opts.log('replay ' + JSON.stringify(r));
        if (!r || r.EntError !== 'OK') throw new Error('playFile: ' + (r && r.EntError));
    });
    this.pending = p.catch(() => {}); // release() waits for it, as for play()
    return p;
};
Audio.prototype.button = function (b) {
    if (!this.mp) return Promise.resolve();
    return this.mp.callMethod('sendButtonEvent', { button: b, action: 'PRESS' }, 3000)
        .catch((e) => this.opts.log(b + ' failed: ' + e));
};
Audio.prototype.seek = function (ms) {
    if (!this.mp) return Promise.resolve();
    return this.mp.callMethod('setTime', { newTimeElapsed: ms }, 3000).catch((e) => this.opts.log('setTime failed: ' + e));
};
// Every exit path ends here. Safe to call twice.
Audio.prototype.release = async function () {
    if (this.pending) await this.pending;
    if (this.connId === null) return;
    const id = this.connId;
    this.connId = null;
    await this.button('STOP');
    try {
        if (id === -1) throw new Error('no connection id');
        this.opts.log('disconnect ' + JSON.stringify(await this.cc.callMethod('disconnect', { mainConnectionID: id }, 5000)));
    } catch (e) {
        this.opts.log('disconnect failed: ' + e + '; sweeping source ' + this.src);
        await this.dropLeftovers().catch((e2) => this.opts.log('sweep failed: ' + e2));
    }
};

// ---------------------------------------------------------------- daemon
function Daemon(o) {
    this.opts = Object.assign(defaults(), o || {});
    this.log = this.opts.log;
    this.state = 'idle';
    this.cur = null;      // {id, title, dir, rect, fill, gen}
    this.gen = 0;         // bumps on every play/stop: stale async work checks it
    this.client = null;
    this.child = null;
    this.deaths = 0;
    this.videoOn = true;
    this.paused = false;
    this.elapsed = 0;
    this.total = 0;
    this.stoppedAt = null;
    this.lastTimeEv = 0;
    this.sawPlay = false;
    this.ticking = false;
    this.preparing = null; // id the fetcher is writing
    this.fetcher = null;   // ytfetch.py, as the fetch uid
    this.fetchedMs = Infinity; // video fetched up to there (pts ms)
    this.buffering = false;
    this.head = null;      // {ms}: playing audio.head.m4a (the first ms of the audio) until audio.m4a is ready
    this.fullReady = false; // audio.m4a complete
    this.headWait = false; // past the head, waiting for audio.m4a: the player is paused, the state buffering
    this.switching = false; // head -> full: the player's events until the seek are the restart's, not ours
    this.settle = null;    // {ms, until}: after the switch, ignore the player's stale times below ms
    this.lastTickAt = 0;
    this.thumbQ = [Promise.resolve(), Promise.resolve(), Promise.resolve()];
    this.thumbN = 0;
    this.timers = [];
    this.ready = new Promise((r) => { this.readyResolve = r; }); // leftover check done
    this.audio = new Audio(this.opts, {
        time: (v) => this.onTime(v),
        state: (v) => this.onPlayerState(v),
        error: (v) => this.onPlaybackError(v)
    });
    this.childFetch = !this.opts.ytRequest;
    if (this.childFetch) this.opts.ytRequest = (m, u, h, b, t) => this.fetch({ method: m, url: u, headers: h, body: b, timeoutMs: t });
    this.fetchUid = null;
    this.account = new Account(this.opts, (o) => this.emit(o));
}
// the fetch uid (picked on first need; none: an error naming why, never a crash)
Daemon.prototype.uid = function () {
    if (this.fetchUid === null) {
        try { this.fetchUid = pickFetchUid(this.opts); } catch (e) { this.log('internet uid: ' + e.message); }
    }
    if (this.fetchUid === null) throw Object.assign(new Error('no internet uid on the car (see the log)'), { noUid: true });
    return this.fetchUid;
};
// youtube.com, as the fetch uid
Daemon.prototype.fetch = function (req) {
    try { return fetchRequest(this.opts, this.uid(), req); } catch (e) { return Promise.reject(e); }
};
// a helper (ytfetch.py, thumb.js) as the fetch uid, as fetchRequest spawns its child
Daemon.prototype.spawnFetchUid = function (cmd, args, stdin) {
    const ids = this.opts.noSetuid ? {} : { uid: this.uid(), gid: this.uid() };
    return cp.spawn(cmd[0], cmd.slice(1).concat(args), Object.assign(ids, { cwd: '/', env: {}, stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'] }));
};
// yt-dlp's cache dir (5 chars: listCache's 11-char id filter skips it), the fetch uid's
Daemon.prototype.ytc = function () {
    const ytc = path.join(this.opts.cacheDir, 'ytdlp');
    if (!fs.existsSync(ytc)) fs.mkdirSync(ytc, 0o700);
    this.chownFetch(ytc);
    return ytc;
};
// ---- the account's history and resume point, as SmartTube keeps them: /player (signed in) gives the playbackTracking
// URLs; a playback ping at the start, watchtime pings (st..et) every minute, on pause and at the stop (final when done)
Daemon.prototype.trackStart = async function (c) {
    if (this.account.status().state !== 'signed_in') return;
    try {
        const r = await this.account.json('POST', YT + '/youtubei/v1/player', { context: { client: TV_CLIENT }, videoId: c.id },
            { Authorization: 'Bearer ' + await this.account.token(false) });
        const pt = (r.j && r.j.playbackTracking) || {};
        const pb = pt.videostatsPlaybackUrl && pt.videostatsPlaybackUrl.baseUrl, wt = pt.videostatsWatchtimeUrl && pt.videostatsWatchtimeUrl.baseUrl;
        if (!/^https:\/\/s\.youtube\.com\//.test(pb) || !/^https:\/\/s\.youtube\.com\//.test(wt) || this.cur !== c) return;
        const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
        c.track = { pb: pb, wt: wt, st: 0, at: Date.now(), cpn: Array.from(require('crypto').randomBytes(16), (b) => A[b & 63]).join('') };
        await this.ping(c, false);
    } catch (e) { if (!e.signedOut) this.log('history: ' + e.message); }
};
// watch: false = the playback ping (the start), true = a watchtime ping up to now
Daemon.prototype.ping = async function (c, watch, final) {
    const t = c.track;
    if (!t) return;
    const len = Math.round((c.durationMs || this.total || 0) / 1000), pos = Math.max(0, this.elapsed / 1000).toFixed(1);
    const q = { ns: 'yt', ver: 2, cpn: t.cpn, len: len, cmt: pos };
    if (watch) { q.st = t.st; q.et = pos; t.st = pos; }
    if (final) { q.final = 1; if (watch) q.st = q.et = q.cmt = len; }
    t.at = Date.now();
    const url = (watch ? t.wt : t.pb) + '&' + Object.keys(q).map((k) => k + '=' + encodeURIComponent(q[k])).join('&');
    try {
        const r = await this.opts.ytRequest('GET', url, { Authorization: 'Bearer ' + await this.account.token(false), Referer: 'https://www.youtube.com/tv' }, null, 8000);
        if (r.status >= 300) this.log('history ping ' + r.status);
    } catch (e) { this.log('history ping: ' + e.message); }
};

// ---- where each video was left (positions.json, kept after its files go): resume, Continue watching, progress bars
Daemon.prototype.positions = function () {
    if (!this.pos) this.pos = readJson(path.join(this.opts.cacheDir, 'positions.json')) || {};
    return this.pos;
};
Daemon.prototype.savePos = function (force) {
    const c = this.cur;
    if (!c || !this.total || this.head && !c.durationMs) return;
    if (!force && Date.now() - (this.posAt || 0) < 15000) return;
    this.posAt = Date.now();
    const p = this.positions(), m = readMeta(c.dir, c.id);
    p[c.id] = { ms: this.elapsed, total: this.total, done: this.total - this.elapsed < Math.max(5000, this.total * 0.05),
        at: Date.now(), title: c.title || m.title, channel: m.channel, duration_s: Math.round(this.total / 1000) };
    const ids = Object.keys(p).sort((a, b) => p[b].at - p[a].at);
    ids.slice(300).forEach((id) => { delete p[id]; });
    try {
        const f = path.join(this.opts.cacheDir, 'positions.json');
        fs.writeFileSync(f + '.tmp', JSON.stringify(p), { mode: 0o600 }); // the watch history: root only
        fs.renameSync(f + '.tmp', f);
    } catch (e) { this.log('positions: ' + e.message); }
};
Daemon.prototype.sendPositions = function () {
    const p = this.positions();
    this.emit({ ev: 'positions', items: Object.keys(p).sort((a, b) => p[b].at - p[a].at).map((id) => Object.assign({ id: id }, p[id])) });
};
// ---- chapters (ytfetch's meta) and SponsorBlock segments of the playing video, sent as one 'extras' event
Daemon.prototype.sendExtras = function () {
    const c = this.cur;
    if (c) this.emit({ ev: 'extras', id: c.id, chapters: c.chapters || [], segments: (c.segs || []).map((x) => [x.s, x.e, x.cat]) });
};
Daemon.prototype.loadSegments = async function (c) {
    const f = path.join(c.dir, 'sb.json');
    let segs = readJson(f);
    if (!Array.isArray(segs)) {
        const pre = require('crypto').createHash('sha256').update(c.id).digest('hex').slice(0, 4);
        const url = this.opts.sponsorBlock + pre + '?categories=' + encodeURIComponent(JSON.stringify(this.opts.sbCategories)) + '&actionTypes=' + encodeURIComponent('["skip"]');
        let r;
        try { r = await this.opts.ytRequest('GET', url, { 'User-Agent': 'jap-ridetube-d (BMW head unit)' }, null, 8000); } catch (e) { this.log('sponsorblock: ' + e.message); return; }
        segs = [];
        if (r.status === 200) {
            let all = [];
            try { all = JSON.parse(r.body); } catch (e) { /* none */ }
            const v = Array.isArray(all) && all.find((x) => x && x.videoID === c.id);
            ((v && v.segments) || []).forEach((g) => {
                if (g && g.actionType === 'skip' && this.opts.sbCategories.indexOf(g.category) >= 0 && Array.isArray(g.segment))
                    segs.push({ s: Math.round(g.segment[0] * 1000), e: Math.round(g.segment[1] * 1000), cat: g.category });
            });
        } else if (r.status !== 404) return; // 404: none for this video (cached as such); else asked again next play
        try { fs.writeFileSync(f, JSON.stringify(segs)); } catch (e) { /* the dir went */ }
    }
    if (this.cur !== c) return;
    c.segs = segs.filter((x) => x && x.e - x.s >= 1000).sort((a, b) => a.s - b.s);
    if (c.segs.length) this.sendExtras();
};
// a segment the clock entered: seek past it, once per play (a seek back into it plays it)
Daemon.prototype.skipSegments = function () {
    const skip = (this.cur && this.cur.skip) || this.opts.skip;   // the others: the app's (a Skip button, or nothing)
    const seg = ((this.cur && this.cur.segs) || []).find((x) => !x.done && skip.indexOf(x.cat) >= 0 && this.elapsed >= x.s && this.elapsed < x.e - 1000);
    if (!seg) return false;
    seg.done = true;
    this.log('skip ' + seg.cat + ' ' + seg.s + '-' + seg.e);
    this.emit({ ev: 'skipped', category: seg.cat, ms: seg.e - seg.s });
    this.seek(seg.e).catch((e) => this.log('skip: ' + e));
    return true;
};

// ---- speed: a warm ytfetch.py (yt-dlp loaded: ~1.2 s on the car) takes the next job, and the stream lookup
// (~2.5 s) runs while the controller rests on a tile (prefetch), so a play skips both
Daemon.prototype.spawnJob = function (job) {
    const s = this.spare;
    this.spare = null;
    if (s && s.child.exitCode === null && s.child.signalCode === null) { // still loading: serve reads the job once warm
        s.child.stdin.end(JSON.stringify(job) + '\n');
        return s.child;
    }
    if (s) { try { s.child.kill('SIGKILL'); } catch (e) { /* gone */ } }
    return this.spawnFetchUid(this.opts.fetcher, job);
};
// from tick: a spare while the app is in use and no fetch is starting; none past warmMs
Daemon.prototype.keepWarm = function () {
    const want = this.opts.spare && this.client && Date.now() < (this.usedAt || 0) + this.opts.warmMs;
    if (!want) {
        if (this.spare) { try { this.spare.child.kill('SIGKILL'); } catch (e) { /* gone */ } this.spare = null; }
        return;
    }
    if (this.spare || (this.preparing && this.state === 'preparing')) return;
    let child;
    try { child = this.spawnFetchUid(this.opts.fetcher, ['serve', '--cache-dir', this.ytc()], true); } catch (e) { this.log('spare: ' + e.message); return; }
    const s = this.spare = { child: child, warm: false };
    child.stdin.on('error', () => { /* it died: close says */ });
    readline.createInterface({ input: child.stdout }).on('line', (l) => { if (/"ev": ?"warm"/.test(l)) s.warm = true; });
    child.on('error', (e) => this.log('spare: ' + e.message));
    child.on('close', () => { if (this.spare === s) this.spare = null; });
};
Daemon.prototype.infoFile = function (id) { return path.join(this.opts.cacheDir, 'ytdlp', 'info', id + '.json'); };
Daemon.prototype.freshInfo = function (id) {
    try { return Date.now() - fs.statSync(this.infoFile(id)).mtime.getTime() < this.opts.infoMaxMs; } catch (e) { return false; }
};
Daemon.prototype.prefetch = function (id) {
    if (!ID_RE.test(String(id)) || !this.opts.spare) return undefined;
    if (this.extracting) { if (this.extracting.id !== id) this.nextPrefetch = id; return undefined; }
    if (isPlayable(path.join(this.opts.cacheDir, id)) || this.preparing === id || this.freshInfo(id)) return undefined;
    const idir = path.dirname(this.infoFile(id));
    mkdirp(path.join(this.ytc(), 'info'));
    this.chownFetch(idir);
    try { fs.readdirSync(idir).forEach((n) => { const f = path.join(idir, n); if (Date.now() - fs.statSync(f).mtime.getTime() > this.opts.infoMaxMs) fs.unlinkSync(f); }); } catch (e) { /* best effort */ }
    const child = this.spawnJob(['extract', '--cache-dir', this.ytc(), '--', id, this.infoFile(id)]);
    this.keepWarm(); // the play after this lookup finds a spare, not a cold start (the 5 s poll was too late)
    const x = this.extracting = { id: id, child: child, done: null };
    x.done = new Promise((r) => child.on('close', r)).then(() => {
        if (this.extracting === x) this.extracting = null;
        const n = this.nextPrefetch;
        this.nextPrefetch = null;
        if (n) this.prefetch(n);
    });
    child.on('error', (e) => this.log('prefetch: ' + e.message));
    child.stdout.resume();
    readline.createInterface({ input: child.stderr }).on('line', (l) => this.log('ytfetch (prefetch): ' + l));
    return undefined;
};
Daemon.prototype.chownFetch = function (p) {
    if (!this.opts.noSetuid) fs.chownSync(p, this.uid(), this.uid());
};

Daemon.prototype.start = async function () {
    // 0711: the fetch uid reaches its own folders in it, nobody else can list what was watched
    try { mkdirp(this.opts.cacheDir); fs.chmodSync(this.opts.cacheDir, 0o711); } catch (e) { this.log('cache dir: ' + e.message); }
    try { mkdirp(this.opts.logDir); } catch (e) { this.log('log dir: ' + e.message); }
    this.listen();
    // ytdec decodes on the GPU with the unit's Intel Media SDK (measured on iDrive 7). A head unit without it still
    // plays the sound (ytdec fails to start twice: "video failed, audio only"); the log says why up front.
    if (!this.opts.noHwCheck) {
        const mfx = ['/usr/lib/libmfxhw64.so', '/usr/lib/libmfxhw64.so.1', '/usr/lib64/libmfxhw64.so'].filter((p) => fs.existsSync(p));
        this.log(mfx.length ? 'video decoder: Intel Media SDK ' + mfx[0] : 'video decoder: no Intel Media SDK (libmfxhw64) on this head unit - the picture may not show, the sound plays');
    }
    // the uplink learns our fetch uid at start (its 5 s rescan), before anyone signs in
    if (this.childFetch && this.fetchUid === null) { try { this.fetchUid = pickFetchUid(this.opts); } catch (e) { this.log('internet uid: ' + e.message); } }
    this.timers.push(setInterval(() => this.guard(() => this.watchdog()), 1000));
    this.timers.push(setInterval(() => this.guard(() => this.keepWarm()), this.opts.tickMs));
    this.keepWarm();
    this.prune();
    // The SOME/IP services may come up after us at boot: retry until the leftover check ran.
    for (let i = 0; ; i++) {
        try {
            await this.audio.init();
            await this.audio.dropLeftovers();
            this.readyResolve();
            break;
        } catch (e) {
            if (i % 12 === 0) this.log('someip not ready: ' + e.message);
            await sleep(5000);
        }
    }
};
Daemon.prototype.guard = function (fn) {
    try {
        const r = fn();
        if (r && r.catch) r.catch((e) => this.fault(e));
    } catch (e) {
        this.fault(e);
    }
};
// uncaughtException / unhandledRejection / handler errors: log, release audio, idle.
Daemon.prototype.fault = function (e) {
    this.log('fault: ' + (e && e.stack || e));
    this.emit({ ev: 'error', msg: 'internal error: ' + (e && e.message || e) });
    this.stop('idle').catch((e2) => this.log('stop after fault: ' + e2));
};

// ---- control socket
Daemon.prototype.listen = function () {
    const sock = this.opts.sock;
    try { mkdirp(path.dirname(sock)); } catch (e) { this.log('socket dir: ' + e.message); }
    try { fs.unlinkSync(sock); } catch (e) { /* none */ }
    this.server = net.createServer((c) => this.guard(() => this.onClient(c)));
    this.server.on('error', (e) => this.log('ctl server: ' + e.message));
    this.server.listen(sock, () => {
        try { fs.chmodSync(sock, 0o660); } catch (e) { this.log('chmod ctl.sock: ' + e.message); }
        try { fs.chownSync(sock, 0, this.opts.sockGid); } catch (e) { /* not root (tests) */ }
        this.log('listening on ' + sock);
    });
};
Daemon.prototype.onClient = function (c) {
    if (this.client) {
        this.log('new client replaces the old one');
        const old = this.client;
        this.client = null; // its close must not stop playback for the new one
        old.destroy();
    }
    this.client = c;
    c.setEncoding('utf8');
    let buf = '';
    c.on('data', (d) => {
        buf += d;
        if (buf.length > 65536) { this.log('client line too long'); c.destroy(); return; }
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (line) this.guard(() => this.onLine(line));
        }
    });
    c.on('error', (e) => this.log('client: ' + e.message));
    c.on('close', () => {
        if (this.client !== c) return;
        this.client = null;
        this.log('client gone: stop');
        this.stop('idle').catch((e) => this.log('stop: ' + e));
    });
};
Daemon.prototype.emit = function (o) {
    if (!this.client) return;
    try { this.client.write(JSON.stringify(o) + '\n'); } catch (e) { this.log('emit: ' + e.message); }
};
Daemon.prototype.onLine = function (line) {
    let m;
    try { m = JSON.parse(line); } catch (e) { return this.emit({ ev: 'error', msg: 'bad json' }); }
    if (!m || typeof m.cmd !== 'string') return this.emit({ ev: 'error', msg: 'no cmd' });
    this.usedAt = Date.now();
    switch (m.cmd) {
    case 'prefetch': return this.prefetch(m.id);
    case 'positions': return this.sendPositions();
    case 'status': this.sendState(); if (this.total) this.emit({ ev: 'time', elapsed: this.elapsed, total: this.total }); return undefined;
    case 'search': return this.search(m.q);
    case 'thumb': return this.thumb(m.id);
    case 'play': return this.play(m.id, m.rect, !!m.fill, m.at, m.quality, m.skip);
    case 'pause': return this.pause();
    case 'resume': return this.resume();
    case 'seek': return this.seek(m.ms);
    case 'stop': return this.stop('idle');
    case 'video': return this.setVideo(!!m.on);
    case 'fill': return this.setFill(!!m.on);
    case 'quality': return this.requality(m.quality);
    case 'auth': return this.account.start();
    case 'auth_status': return this.emit(this.account.status());
    case 'sign_out': return this.account.signOut();
    case 'feed': return this.account.feed(m.which);
    case 'channels': return this.account.channels();
    case 'channel': return this.account.channel(m.id);
    default: return this.emit({ ev: 'error', msg: 'unknown cmd ' + m.cmd });
    }
};
Daemon.prototype.setState = function (s) {
    this.state = s;
    this.sendState();
};
Daemon.prototype.sendState = function (pct) {
    this.buffering = this.isBuffering();
    const o = { ev: 'state', state: this.state, pct: pct === undefined ? (this.state === 'preparing' ? this.pct || 0 : null) : pct,
        id: this.cur ? this.cur.id : null, title: this.cur ? this.cur.title : null, buffering: this.buffering };
    this.emit(o);
};
// playing ahead of the video fetched so far, while the fetcher still writes it
Daemon.prototype.isBuffering = function () {
    return this.state === 'playing' && (this.headWait || (!!this.fetcher && this.elapsed + 1000 > this.fetchedMs));
};
Daemon.prototype.checkBuffering = function () {
    if (this.isBuffering() !== this.buffering) this.sendState();
};

Daemon.prototype.prune = function () {
    const protect = [];
    if (this.cur) protect.push(this.cur.id);
    if (this.preparing) protect.push(this.preparing);
    return pruneCache(this.opts.cacheDir, this.opts.keep, protect, this.log);
};
// ---- search / thumbs
// TVHTML5 search: signed in when we can (as feed), anonymous otherwise (it answers lockupViewModels)
Daemon.prototype.search = async function (q) {
    q = typeof q === 'string' ? q.trim() : '';
    if (!q) return this.emit({ ev: 'error', msg: 'empty search' });
    const ask = (tok) => this.account.json('POST', YT + '/youtubei/v1/search', { context: { client: TV_CLIENT }, query: q },
        tok ? { Authorization: 'Bearer ' + tok } : null);
    let r;
    try {
        const tok = await this.account.token(false).catch(() => null);
        r = await ask(tok);
        if (r.status === 401 && tok) r = await ask(null);
        if (r.status !== 200 || !r.j) throw new Error('search ' + r.status);
    } catch (e) {
        this.log('search: ' + e.message);
        return this.emit({ ev: 'error', msg: e.noUid ? e.message : 'search offline' });
    }
    return this.emit({ ev: 'results', q: q, items: feedItems(r.j).slice(0, FEED_MAX) });
};
Daemon.prototype.thumb = async function (id) {
    if (!ID_RE.test(String(id))) return this.emit({ ev: 'error', msg: 'bad id' });
    const tdir = path.join(this.opts.cacheDir, 'thumbs'), tf = path.join(tdir, id + '.rgba');
    const read = (f) => { try { return fs.readFileSync(f); } catch (e) { return null; } };
    let data = read(path.join(this.opts.cacheDir, id, 'thumb.rgba')) || read(tf);
    if (!data) {
        // at most 3 helpers at once: each is a Node 22 process, and a page asks for 20 thumbs
        const i = this.thumbN++ % this.thumbQ.length;
        const p = this.thumbQ[i].then(() => this.thumbFetch(id));
        this.thumbQ[i] = p.catch(() => {});
        try { data = await p; } catch (e) {
            this.log('thumb ' + id + ': ' + e.message);
            return undefined; // no thumb: the app keeps its placeholder
        }
        try { mkdirp(tdir); fs.chmodSync(tdir, 0o700); fs.writeFileSync(tf, data, { mode: 0o600 }); this.pruneThumbs(tdir); } catch (e) { this.log('thumb cache: ' + e.message); }
    }
    const wh = THUMB_SIZES[data.length];
    if (!wh) { this.log('thumb ' + id + ': ' + data.length + ' bytes, not 160x90 or 320x180 RGBA'); return undefined; }
    return this.emit({ ev: 'thumb', id: id, w: wh[0], h: wh[1], rgba: data.toString('base64') });
};
// thumb.js <id> as the fetch uid: exactly 320x180 RGBA on stdout, exit 0; killed after 10 s
Daemon.prototype.thumbFetch = function (id) {
    return new Promise((resolve, reject) => {
        const child = this.spawnFetchUid(this.opts.thumbCmd, [id]);
        const out = [], err = [];
        let size = 0;
        const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) { /* gone */ } }, 10000);
        child.stdout.on('data', (c) => { size += c.length; if (size <= 230400) out.push(c); });
        child.stderr.on('data', (c) => err.push(c));
        child.on('error', (e) => { clearTimeout(timer); reject(e); });
        child.on('close', (code, sig) => {
            clearTimeout(timer);
            if (code === 0 && size === 230400) return resolve(Buffer.concat(out));
            return reject(new Error('thumb helper ' + (sig || 'exit ' + code) + ', ' + size + ' bytes: ' + Buffer.concat(err).toString('utf8', 0, 200).trim()));
        });
    });
};
// thumbs/ keeps the newest thumbMax (mtime)
Daemon.prototype.pruneThumbs = function (tdir) {
    const names = list(tdir);
    if (names.length <= this.opts.thumbMax) return;
    names.map((n) => { try { return { n: n, t: fs.statSync(path.join(tdir, n)).mtime.getTime() }; } catch (e) { return { n: n, t: 0 }; } })
        .sort((x, y) => y.t - x.t).slice(this.opts.thumbMax)
        .forEach((x) => { try { fs.unlinkSync(path.join(tdir, x.n)); } catch (e) { /* gone */ } });
};

// ---- playback
Daemon.prototype.play = async function (id, rect, fill, at, quality, skip) {
    if (!ID_RE.test(String(id))) return this.emit({ ev: 'error', msg: 'bad id' });
    if (!/^\d{2,4}x\d{2,4}$/.test(String(rect))) rect = '1280x720';
    await this.stop(null);
    const gen = ++this.gen;
    const dir = path.join(this.opts.cacheDir, id);
    try { fs.chmodSync(dir, VIDEO_DIR_MODE); } catch (e) { /* not fetched yet: fetchVideo makes it */ }   // (0700 before 0.3.9)
    const meta0 = readMeta(dir, id);
    this.cur = { id: id, title: meta0.title, durationMs: meta0.duration_s > 0 ? meta0.duration_s * 1000 : undefined, dir: dir, rect: rect, fill: fill, gen: gen, height: qualityHeight(quality, readJson(this.opts.leaseFile)),
        skip: Array.isArray(skip) ? skip.filter((x) => typeof x === 'string') : null, chapters: (readJson(path.join(dir, 'meta.json')) || {}).chapters };
    const was = this.positions()[id];
    // where it was left (here, else YouTube's own position the tile carried: at): seek there on the first tick
    this.startAt = !this.opts.resume ? null : was ? (!was.done && was.ms > 10000 ? was.ms : null) : (Number(at) > 10000 ? Math.floor(Number(at)) : null);
    this.posAt = Date.now();
    this.pct = 0;
    this.fetchedMs = Infinity;
    this.head = null;
    this.headWait = false;
    this.switching = false;
    this.settle = null;
    this.fullReady = true;
    let headMs = null;
    if (!isPlayable(dir)) {
        this.fullReady = false;
        this.setState('preparing');
        const waits = this.opts.fetchRetryMs || [];
        for (let k = 0; ; k++) {
            try {
                const x = this.extracting;   // its lookup is nearly there: wait for it rather than redo it
                if (x && x.id === id) await withTimeout(x.done, 8000, 'prefetch').catch(() => undefined);
                if (gen !== this.gen) return undefined;
                headMs = await this.fetchVideo(id, dir);
                break;
            } catch (e) {
                if (gen !== this.gen) return undefined;
                // the video itself refused (gone, private, members, age): no retry; else the network, maybe back soon
                if (k >= waits.length || PERMANENT_RE.test(e.message)) return this.failPlayback('fetch: ' + e.message);
                this.log('fetch ' + id + ': ' + e.message + ' - again in ' + waits[k] + ' ms');
                try { fs.unlinkSync(this.infoFile(id)); } catch (e2) { /* none */ } // its stream URLs may be what failed (another uplink)
                this.emit({ ev: 'retry', id: id, n: k + 1, msg: e.message });
                await sleep(waits[k]);
                if (gen !== this.gen) return undefined;
            }
        }
        if (gen !== this.gen) return undefined;
    }
    try { const now = new Date(); fs.utimesSync(dir, now, now); } catch (e) { /* LRU recency only */ }
    this.sendExtras();
    this.loadSegments(this.cur).catch((e) => this.log('sponsorblock: ' + e));
    this.trackStart(this.cur).catch((e) => this.log('history: ' + e));
    this.prune();
    this.deaths = 0;
    this.paused = false;
    this.elapsed = 0;
    this.total = 0;
    this.stoppedAt = null;
    this.sawPlay = false;
    this.ticking = false;
    this.lastTickAt = Date.now();
    try {
        await withTimeout(this.ready, 10000, 'audio service'); // never connect before the leftover sweep
        if (gen !== this.gen) return undefined;
        if (headMs !== null && !this.fullReady) this.head = { ms: headMs };
        await this.audio.play(path.join(dir, this.head ? 'audio.head.m4a' : 'audio.m4a'));
    } catch (e) {
        if (gen !== this.gen) return this.audio.release();
        return this.failPlayback(e.message);
    }
    if (gen !== this.gen) return this.audio.release(); // stopped while connecting
    this.ticking = true;
    this.spawnYtdec(null);
    this.setState('playing');
    if (this.head && this.fullReady) await this.switchToFull(); // audio.m4a came during the connect
    return undefined;
};
// audio.m4a is complete. On the head: switch now; paused: resume() switches (as after a STOP mid-file)
Daemon.prototype.onFullAudio = function () {
    this.fullReady = true;
    if (!this.head || !this.ticking || this.switching) return undefined; // not playing yet: play() picks it
    if (this.paused) {
        this.stoppedAt = this.elapsed;
        this.head = null;
        this.headWait = false;
        return undefined;
    }
    return this.switchToFull();
};
// playFile(audio.m4a) on the live connection, then setTime where the head was. ytdec keeps its clock meanwhile
// (or, waiting, is paused at elapsed), so the target is the extrapolated clock (or elapsed).
Daemon.prototype.switchToFull = async function () {
    const gen = this.gen, waiting = this.headWait;
    this.switching = true;
    this.head = null;
    this.sawPlay = false;
    this.log('audio: head -> full at ' + this.elapsed + (waiting ? ' (waiting)' : ''));
    let target;
    try {
        await this.audio.replay(path.join(this.cur.dir, 'audio.m4a'));
        if (gen !== this.gen) return undefined;
        target = waiting ? this.elapsed : this.elapsed + (Date.now() - this.lastTickAt);
        if (this.total) target = Math.min(target, Math.max(0, this.total - 1000));
        await this.audio.seek(target);
    } catch (e) {
        if (gen !== this.gen) return undefined;
        this.switching = false;
        return this.failPlayback('audio switch: ' + e.message);
    }
    if (gen !== this.gen) return undefined;
    this.switching = false;
    this.headWait = false;
    this.elapsed = target;
    this.lastTickAt = Date.now();
    this.settle = { ms: target, until: Date.now() + 3000 };
    if (waiting) {
        this.toYtdec('seek ' + target);
        if (!this.paused) this.toYtdec('resume');
    }
    if (this.paused) await this.hold(target); // paused during the switch: the playFile started it
    this.checkBuffering();
    try { fs.unlinkSync(path.join(this.cur.dir, 'audio.head.m4a')); } catch (e) { /* the player keeps reading it until then */ }
    return undefined;
};
// past the head before audio.m4a: pause the player and ytdec at ms, buffering until onFullAudio switches
Daemon.prototype.waitFull = function (ms) {
    this.log('audio: past the head at ' + ms + ', waiting for audio.m4a');
    this.headWait = true;
    this.elapsed = ms;
    this.toYtdec('pause');
    this.checkBuffering();
    this.sawPlay = false;             // (STOP: PAUSE leaves the player playing; switchToFull plays the full file anyway)
    return this.audio.button('STOP');
};
// ytfetch.py into a fresh dir; resolves once playable (audio complete or its head, and startVideoMs of video,
// or all of it), rejects if it ends before. Resolves with the head's ms when it starts on the head only, else null.
// It keeps writing the video (and the rest of the audio) after that, while we play.
Daemon.prototype.fetchVideo = function (id, dir) {
    return new Promise((resolve, reject) => {
        rmrf(dir); // a killed fetch's leftovers
        mkdirp(dir);
        fs.chmodSync(dir, VIDEO_DIR_MODE);
        this.chownFetch(dir);
        const info = this.freshInfo(id) ? ['--info', this.infoFile(id)] : [];
        const child = this.spawnJob(['fetch', '--cache-dir', this.ytc(), '--height', String(this.cur.height || 720)].concat(info, ['--', id, dir]));
        this.fetcher = child;
        this.preparing = id;
        this.fetchedMs = 0;
        let audio = false, head = null, done = false, started = false, err = null;
        const pct = (p) => {
            p = Math.min(99, Math.max(this.pct, Math.round(p)));
            if (p !== this.pct && this.state === 'preparing') { this.pct = p; this.sendState(); }
        };
        const check = () => {
            if (!started && (audio || head !== null) && (done || this.fetchedMs >= this.opts.startVideoMs)) { started = true; resolve(audio ? null : head); }
        };
        const end = (why) => {
            if (child === this.fetcher) {
                this.fetcher = null;
                this.preparing = null;
                if (done && why === 'exit 0') this.fetchedMs = Infinity;
                else if (started && !this.fullReady) { // playing the head: the rest of the audio never comes
                    this.failPlayback('fetch: ' + (err || why)).catch((e) => this.log(e));
                    return;
                } else if (started) {
                    this.log('fetch ' + id + ': ' + (err || why));
                    this.emit({ ev: 'error', msg: 'video incomplete: ' + (err || why) });
                }
                this.checkBuffering();
            }
            if (!started) { started = true; reject(new Error(err || why)); }
        };
        readline.createInterface({ input: child.stdout }).on('line', (l) => this.guard(() => {
            if (child !== this.fetcher) return;
            let m;
            try { m = JSON.parse(l); } catch (e) { return; }
            if (m.ev === 'meta') {
                if (m.title) this.cur.title = String(m.title);
                if (m.duration_s > 0) this.cur.durationMs = m.duration_s * 1000;
                if (Array.isArray(m.chapters)) this.cur.chapters = m.chapters;
            } else if (m.ev === 'audio') pct(0.7 * (Number(m.pct) || 0));
            else if (m.ev === 'audio_head' && Number(m.ms) > 0) { if (head === null) { head = Number(m.ms); pct(70); } }
            else if (m.ev === 'audio_ready') {
                audio = true;
                pct(70);
                if (started) this.onFullAudio();
                else this.fullReady = true;
            }
            else if (m.ev === 'video') {
                this.fetchedMs = Number(m.ms) || 0;
                if (audio || head !== null) pct(70 + 29 * Math.min(1, this.fetchedMs / this.opts.startVideoMs));
            } else if (m.ev === 'done') done = true;
            else if (m.ev === 'error') err = String(m.msg);
            check();
            this.checkBuffering();
        }));
        readline.createInterface({ input: child.stderr }).on('line', (l) => this.log('ytfetch: ' + l));
        child.on('error', (e) => end(e.message));
        child.on('close', (code, sig) => end(sig ? 'killed ' + sig : 'exit ' + code)); // close: after its last line
    });
};
// SIGTERM (it leaves .part files), SIGKILL after 3 s; resolves when it is gone
Daemon.prototype.stopFetch = function () {
    const c = this.fetcher;
    if (!c) return Promise.resolve();
    this.fetcher = null;
    this.preparing = null;
    return new Promise((resolve) => {
        const t = setTimeout(() => { try { c.kill('SIGKILL'); } catch (e) { /* gone */ } }, 3000);
        c.on('exit', () => { clearTimeout(t); resolve(); });
        if (c.exitCode !== null || c.signalCode !== null) { clearTimeout(t); resolve(); }
        try { c.kill('SIGTERM'); } catch (e) { /* gone */ }
    });
};
Daemon.prototype.failPlayback = async function (msg) {
    this.log('error: ' + msg);
    this.ticking = false;
    this.killYtdec();
    await Promise.all([this.audio.release(), this.stopFetch()]);
    this.setState('error');
    this.emit({ ev: 'error', msg: msg });
};
// reason: 'idle' | 'ended' | null (internal, before a new play: no state event)
Daemon.prototype.stop = async function (reason) {
    if (this.ticking) {
        this.savePos(true);
        if (reason === 'ended' && this.pos && this.cur && this.pos[this.cur.id]) this.pos[this.cur.id].done = true;
        const p = this.cur && this.pos && this.pos[this.cur.id];
        if (this.cur && this.cur.track) this.ping(this.cur, true, !!(p && p.done));
    }
    this.gen++;
    this.ticking = false;
    this.killYtdec();
    await Promise.all([this.audio.release(), this.stopFetch()]);
    if (reason) {
        this.setState(reason);
        if (this.pos) this.sendPositions();
        this.cur = null;
        this.prune();          // a played video goes
    }
};
Daemon.prototype.pause = async function () {
    if (this.state !== 'playing') return;
    this.paused = true;
    this.toYtdec('pause');
    this.setState('paused'); // at once: the button's reply can take seconds, and a second tap must not send it twice
    // the MediaPlayer answers OK to PAUSE (and PLAY) and plays on (car, 2026-11-03); STOP does stop it, and resume()
    // starts the file again where it stopped
    this.savePos(true);
    if (this.cur && this.cur.track) this.ping(this.cur, true);
    if (this.headWait) return; // already stopped, waiting for audio.m4a
    await this.hold(this.elapsed); // (the last tick: at most a fraction of a second back)
};
// the player stopped at ms (STOP: our own, not the end of the file), for resume() to start it there again
Daemon.prototype.hold = function (ms) {
    this.stoppedAt = ms;
    this.elapsed = ms;
    this.sawPlay = false;
    return this.audio.button('STOP');
};
Daemon.prototype.resume = async function () {
    if (this.state !== 'paused') return;
    this.paused = false;
    this.lastProgress = Date.now();
    this.setState('playing');
    if (this.headWait) return; // still past the head: ytdec and the player stay paused until the switch
    if (this.stoppedAt !== null && this.stoppedAt !== undefined) { // the player stopped mid-file: start it again there
        const gen = this.gen;
        this.sawPlay = false; // the new file's own STOP/PLAY is not a stop mid-file
        this.toYtdec('seek ' + this.stoppedAt);
        this.toYtdec('resume');
        // stopped, the player ignores playFile and PLAY (car, 2026-11-03): a new connection, as a new video starts
        try {
            await this.audio.release();
            if (gen !== this.gen) return;
            await this.audio.play(path.join(this.cur.dir, this.head ? 'audio.head.m4a' : 'audio.m4a'));
        } catch (e) {
            if (gen === this.gen) await this.failPlayback('resume: ' + e.message);
            return;
        }
        if (gen !== this.gen || this.state !== 'playing') return; // stopped, or paused again meanwhile
        // a setTime before the new file's first tick is dropped (it started at 0 on the car): wait for one (3 s at most)
        await new Promise((r) => { this.tickWaiter = r; setTimeout(r, 3000); });
        this.tickWaiter = null;
        if (gen !== this.gen || this.state !== 'playing') return;
        const at = this.stoppedAt;  // (a seek meanwhile moved it: seek() keeps it while the file restarts)
        this.stoppedAt = null;
        this.settle = { ms: at, until: Date.now() + 3000 };
        await this.audio.seek(at);
        return;
    }
    this.toYtdec('resume');
    await this.audio.button('PLAY');
};
Daemon.prototype.seek = async function (ms) {
    if (this.state !== 'playing' && this.state !== 'paused') return;
    ms = Math.max(0, Math.floor(Number(ms) || 0));
    if (this.total) ms = Math.min(ms, Math.max(0, this.total - 1000));
    this.elapsed = ms;
    this.lastProgress = Date.now();
    this.lastTickAt = Date.now();
    this.settle = null; // a seek back right after the switch: its times are ours
    this.toYtdec('seek ' + ms);
    // shortcut: once waiting, a seek back into the head still waits for audio.m4a (a few s), simpler than replaying the head
    if (this.headWait) return this.checkBuffering();
    if (this.head && !this.switching && ms > this.head.ms - this.opts.headMarginMs) return this.waitFull(ms);
    this.checkBuffering();
    if (this.stoppedAt !== null && this.stoppedAt !== undefined) { this.stoppedAt = ms; return undefined; } // resume() replays there
    await this.audio.seek(ms);
};
Daemon.prototype.setVideo = function (on) {
    this.videoOn = on;
    this.lastProgress = Date.now();
    this.toYtdec('video ' + (on ? 1 : 0));
};

// zoom while playing: ytdec again at the clock with the other mode (the sound plays on)
Daemon.prototype.setFill = function (on) {
    const c = this.cur;
    if (!c || c.fill === on) return;
    c.fill = on;
    if (!this.child) return; // the next ytdec takes it
    this.killYtdec();
    this.spawnYtdec(this.paused || this.headWait ? this.elapsed : this.elapsed + (Date.now() - this.lastTickAt));
};
// Video quality while playing: the same video fetched again at that height, from where it is
Daemon.prototype.requality = async function (quality) {
    const c = this.cur;
    if (!c || qualityHeight(quality, readJson(this.opts.leaseFile)) === c.height) return undefined;
    await this.stop(null);
    rmrf(c.dir);
    return this.play(c.id, c.rect, c.fill, null, quality, c.skip);
};

// ---- MediaPlayer events
Daemon.prototype.onTime = function (v) {
    if (!this.ticking || !v || typeof v.elapsed !== 'number') return;
    if (!(v.total > 1)) return; // {elapsed:0,total:1} right after playFile
    if (this.tickWaiter) { this.tickWaiter(); return; } // resume(): the restarted file plays, its setTime can follow
    if (this.switching || this.headWait) return; // the restart's times, or a paused player
    if (this.settle && Date.now() < this.settle.until && v.elapsed < this.settle.ms - 2000) return; // before our setTime landed
    this.elapsed = v.elapsed;
    this.lastTickAt = Date.now();
    this.total = this.head ? (this.cur.durationMs || v.total) : v.total; // the head's own total is ~60 s
    if (this.head && !this.fullReady && v.elapsed >= this.head.ms - this.opts.headMarginMs) {
        this.waitFull(v.elapsed).catch((e) => this.log(e));
        return;
    }
    if (this.startAt) { const at = this.startAt; this.startAt = null; this.seek(at).catch((e) => this.log('resume at: ' + e)); return; }
    if (this.skipSegments()) return;
    this.savePos(false);
    if (this.cur.track && Date.now() - this.cur.track.at > 60000) this.ping(this.cur, true);
    this.toYtdec('clock ' + v.elapsed + ' ' + monoMs());
    this.checkBuffering();
    const now = Date.now();
    if (now - this.lastTimeEv >= 240) { // <= 4/s
        this.lastTimeEv = now;
        this.emit({ ev: 'time', elapsed: v.elapsed, total: this.total });
    }
};
Daemon.prototype.onPlayerState = function (v) {
    if (!this.ticking) return;
    if (v === 'PLAYER_STATE_PLAY') this.sawPlay = true; // also mid-switch: the full file's own PLAY arms its end
    if (this.switching) return;
    // the head file ran out (before onTime saw its end): wait for audio.m4a, never `ended`
    if (v === 'PLAYER_STATE_STOP' && this.head && this.sawPlay) {
        this.sawPlay = false;
        if (!this.headWait) this.waitFull(this.elapsed).catch((e) => this.log(e));
        return;
    }
    // STOP we did not ask for, after it played: the end of the file when near it, else the player
    // stopped mid-file (seen after a PLAY sent while playing): hold as paused, resume restarts it there.
    if (v === 'PLAYER_STATE_STOP' && this.sawPlay) {
        this.sawPlay = false;
        if (!this.total || this.total - this.elapsed < 4000) {
            this.log('audio ended');
            this.stop('ended').catch((e) => this.log('stop: ' + e));
            return;
        }
        this.log('audio stopped at ' + this.elapsed + ' of ' + this.total + ': held as paused');
        this.stoppedAt = this.elapsed;
        this.paused = true;
        this.toYtdec('pause');
        this.setState('paused');
    }
};
Daemon.prototype.onPlaybackError = function (v) {
    if (!this.ticking) return;
    this.failPlayback('playback error ' + JSON.stringify(v)).catch((e) => this.log(e));
};

// ---- ytdec
Daemon.prototype.spawnYtdec = function (seekMs) {
    const c = this.cur;
    const args = ['--dir', c.dir, '--rect', c.rect];
    if (c.fill) args.push('--fill');
    args.push('--log', path.join(this.opts.logDir, 'ytdec.log'));
    let child;
    try {
        child = cp.spawn(this.opts.ytdec, args, { stdio: ['pipe', 'pipe', 'ignore'] });
    } catch (e) {
        return this.ytdecDied(null, 'spawn: ' + e.message);
    }
    this.child = child;
    this.lastProgress = Date.now();
    this.lastDecoded = -1;
    this.eof = false;
    child.stdin.on('error', () => { /* EPIPE when it dies: handled by exit */ });
    child.on('error', (e) => this.ytdecDied(child, e.message));
    child.on('exit', (code, sig) => this.ytdecDied(child, 'exit ' + (sig || code)));
    readline.createInterface({ input: child.stdout }).on('line', (l) => this.guard(() => this.onYtdecLine(child, l)));
    if (seekMs !== null) this.toYtdec('seek ' + seekMs);
    if (this.paused) this.toYtdec('pause');
    if (!this.videoOn) this.toYtdec('video 0');
    this.log('ytdec ' + args.join(' ') + (seekMs !== null ? ' (restart at ' + seekMs + ')' : ''));
};
Daemon.prototype.toYtdec = function (line) {
    if (!this.child) return;
    try { this.child.stdin.write(line + '\n'); } catch (e) { /* dying */ }
};
Daemon.prototype.onYtdecLine = function (child, l) {
    if (child !== this.child) return;
    let m;
    try { m = JSON.parse(l); } catch (e) { return; }
    if (m.ev === 'stats') {
        if (typeof m.decoded === 'number' && m.decoded !== this.lastDecoded) {
            this.lastDecoded = m.decoded;
            this.lastProgress = Date.now();
        }
    } else if (m.ev === 'ready') {
        this.lastProgress = Date.now();
    } else if (m.ev === 'eof') {
        this.eof = true;
    } else if (m.ev === 'error') {
        this.log('ytdec error: ' + m.msg);
    }
};
Daemon.prototype.killYtdec = function () {
    const c = this.child;
    if (!c) return;
    this.child = null;
    try { c.stdin.write('quit\n'); } catch (e) { /* gone */ }
    try { c.stdin.end(); } catch (e) { /* gone */ }
    const t = setTimeout(() => { try { c.kill('SIGKILL'); } catch (e) { /* gone */ } }, 1000);
    c.on('exit', () => clearTimeout(t));
};
// Child died on its own (or the watchdog killed it): restart once at the clock, then audio only.
Daemon.prototype.ytdecDied = function (child, why) {
    if (child && child !== this.child) return; // a child we already let go
    this.child = null;
    if (!this.ticking) return;
    this.deaths++;
    this.log('ytdec died (' + why + '), death ' + this.deaths);
    if (this.deaths === 1) return this.spawnYtdec(this.elapsed);
    this.emit({ ev: 'error', msg: 'video failed, audio only' });
    return undefined;
};
Daemon.prototype.watchdog = function () {
    if (!this.child || this.state !== 'playing' || !this.videoOn || this.eof) return;
    // waiting for video not fetched yet (buffering, or the fetcher ended early): not a stall
    if (this.headWait || this.elapsed + 1000 > this.fetchedMs) { this.lastProgress = Date.now(); return; }
    if (Date.now() - this.lastProgress < this.opts.watchdogMs) return;
    this.log('watchdog: no decoded frames for ' + this.opts.watchdogMs + ' ms');
    const c = this.child;
    try { c.kill('SIGKILL'); } catch (e) { /* gone */ }
    this.lastProgress = Date.now();
};

Daemon.prototype.close = async function () {
    this.timers.forEach(clearInterval);
    [this.spare, this.extracting].forEach((x) => { if (x) { try { x.child.kill('SIGKILL'); } catch (e) { /* gone */ } } });
    this.spare = this.extracting = null;
    this.account.close();
    await this.stop(null);
    if (this.client) this.client.destroy();
    if (this.server) this.server.close();
};

module.exports = { qualityHeight: qualityHeight, channelTiles: channelTiles, Daemon: Daemon, Audio: Audio, Account: Account, feedItems: feedItems, isPlayable: isPlayable, feedShelves: feedShelves, ytRequest: ytRequest, uplinkLookup: uplinkLookup, pickFetchUid: pickFetchUid, fetchRequest: fetchRequest, listCache: listCache, pruneCache: pruneCache, isReady: isReady };

// the uplink's DNS servers (its lease): the system resolver (127.0.0.1) answers no internet names. No
// lease (uplink down or not installed): the system resolver, as before
function uplinkLookup(leaseFile) {
    const servers = ((readJson(leaseFile || '/run/mgu-uplink/lease.json') || {}).dns || []).filter((x) => typeof x === 'string');
    if (!servers.length) return undefined;
    const r = new (require('dns').Resolver)();
    r.setServers(servers);
    return function (host, opts, cb) {
        if (typeof opts === 'function') cb = opts;
        r.resolve4(host, (e, a) => (e ? cb(e) : cb(null, a[0], 4)));
    };
}

if (require.main === module && process.argv[2] === '--fetch') {
    // the fetch helper (as the fetch uid): one request from stdin, its answer on stdout
    let input = '';
    const out = (o) => process.stdout.write(JSON.stringify(o), () => process.exit(0));
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { input += d; });
    process.stdin.on('end', () => {
        let q;
        try { q = JSON.parse(input); } catch (e) { return out({ error: 'bad request' }); }
        return ytRequest(q.method, q.url, q.headers, q.body, q.timeoutMs, uplinkLookup()).then(out, (e) => out({ error: e.message }));
    });
} else if (require.main === module) {
    const d = new Daemon();
    process.on('uncaughtException', (e) => d.fault(e));
    process.on('unhandledRejection', (e) => d.fault(e));
    let exiting = false;
    ['SIGTERM', 'SIGINT', 'SIGHUP'].forEach((s) => process.on(s, () => {
        if (exiting) return;
        exiting = true;
        d.log(s + ': releasing audio');
        setTimeout(() => process.exit(0), 4000); // TimeoutStopSec=5
        d.close().then(() => process.exit(0), () => process.exit(0));
    }));
    d.start().catch((e) => d.fault(e));
}
