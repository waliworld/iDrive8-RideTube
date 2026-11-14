'use strict';
/**
 * sound.js - the sound on a head unit that does not offer iDrive 7's "OapGenericMedia" player (iDrive 8).
 *
 * Nobody has heard RideTube on such a car yet, and every try costs its driver a trip to the car. So a play there
 * does not try one guess: it works through every way this service knows, on its own, until one plays, keeps that
 * one for the next play (state/sound.json), and writes down every answer of the car for the Diagnostics page.
 *
 * The ways ("routes"), the quick ones first:
 *   direct:<device>  without the car's player (DirectRoute): the audio manager connects our source as on iDrive 7,
 *                    ytaud decodes the file and ytalsa.py writes the samples to the car's audio router (ALSA,
 *                    "smartx" devices). The router reads a device only while its source is connected to a
 *                    loudspeaker, so which device is ours is measured, not guessed: silence is written to all of
 *                    them at once before and after the connection (ytalsa.py scan) - the one that takes it as time
 *                    passes plays. Seconds.
 *   focus:<instance>|<device>  the audio focus of the car's DynamicMediaPlayer, then the same (FocusRoute): asking
 *                    for the focus makes the car connect that player's source; where its device is free, our
 *                    samples go there. No playlist, no file the car must read. Seconds.
 *   dyn:<instance>   the car's DynamicMediaPlayer, as its own apps use it (DynRoute): getAudioFocus -> a token kept
 *                    alive by heartBeat, createPlaylist with our file as its one item, a start, then its playerState
 *                    and currentItemTime. What the interface description does not say - how an item's union value
 *                    and byte buffer are written, where the file may be, what starts it - is first read from BMW's
 *                    own code on the car (sdkread.js) and otherwise tried in every likely form. Each instance the
 *                    car has for the entertainment (Media, TempMedia, TempLumMedia) is a route. Minutes.
 * A route that plays but is not heard is the driver's to say ("No sound?" in the app): it is marked silent and the
 * play goes on with the next.
 *
 *   new Sound(audio)            audio: ytd.js's Audio (its proxy(), answers(), dynamic(), cc, opts, handlers)
 *   .play(file, info)           resolves once something plays; rejects with what to tell the driver
 *   .replay(file) .button(b) .seek(ms) .release() .cancel()
 *   .nosound() .reset()         the driver's verdict; start over
 *   .lines()                    the Diagnostics page's lines
 *
 * Node 8 (the unit's /usr/bin/node). No dependency.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const util = require('util');
const crypto = require('crypto');
const cp = require('child_process');
const readline = require('readline');
const sdkread = require('./sdkread.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function withTimeout(p, ms, what) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(what + ' timed out')), ms);
        Promise.resolve(p).then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
    });
}
function errText(e) {
    if (e && typeof e === 'object' && !e.message) { try { return JSON.stringify(e); } catch (x) { /* as a string below */ } }
    return String(e && e.message || e);
}
/* A value of the car on one line, buffers told apart from arrays. */
function show(v, max) {
    let t;
    try { t = typeof v === 'string' ? v : util.inspect(v, { depth: 5, breakLength: Infinity, maxArrayLength: 24 }); } catch (e) { t = String(v); }
    t = String(t).replace(/\s+/g, ' ');
    return t.length > (max || 220) ? t.slice(0, max || 220) + '...' : t;
}
const uniq = (l) => l.filter((x, i) => x !== undefined && x !== null && l.indexOf(x) === i);
const short = (dev) => String(dev).replace(/^plug:smartx:/, '');
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } };
function writeJson(file, v) {
    const tmp = file + '.tmp';
    try {
        fs.writeFileSync(tmp, JSON.stringify(v), { mode: 0o600 });
        fs.renameSync(tmp, file);
        return true;
    } catch (e) { try { fs.unlinkSync(tmp); } catch (x) { /* none */ } return false; }
}
function mkdirp(p) {
    try { fs.mkdirSync(p); } catch (e) {
        if (e.code === 'ENOENT') { mkdirp(path.dirname(p)); fs.mkdirSync(p); } else if (e.code !== 'EEXIST') throw e;
    }
}

/* A scan on one line: what takes samples as time passes, what takes none, what swallows them, what does not open. */
function scanText(devs, map) {
    const g = { flows: [], stalls: [], fast: [], no: [] };
    devs.forEach((n) => {
        const d = map[n];
        if (!d) g.no.push(short(n) + ' (no answer)');
        else if (!d.open) g.no.push(short(n) + ' (' + String(d.error || '?').slice(0, 70) + ')');
        else (g[d.verdict] || g.stalls).push(short(n) + (d.verdict === 'flows' ? ' (' + (d.late !== undefined ? d.late : d.ratio) + ' of real time)' : ''));
    });
    const out = [], some = (l, n) => l.slice(0, n).join(', ') + (l.length > n ? ' +' + (l.length - n) + ' more' : '');
    if (g.flows.length) out.push('TAKE SAMPLES as time passes: ' + some(g.flows, 12));
    if (g.stalls.length) out.push('take none: ' + some(g.stalls, 14));
    if (g.fast.length) out.push('swallow them: ' + some(g.fast, 6));
    if (g.no.length) out.push('do not open: ' + some(g.no, 5));
    return out.join(' | ') || 'none';
}

/* BMW's item as read (a template with sdkread's sample path and size) with our file's place and size in it. */
function fill(v, value, size) {
    const S = sdkread.SAMPLE;
    if (typeof v === 'string') return v.split(S.file).join(value);
    if (typeof v === 'number') return v === S.size ? size : v;
    if (Buffer.isBuffer(v)) {
        for (const encn of ['utf8', 'utf16le']) { const at = v.indexOf(Buffer.from(S.file, encn)); if (at >= 0) return Buffer.concat([v.slice(0, at), Buffer.from(value, encn), v.slice(at + Buffer.from(S.file, encn).length)]); }
        return Buffer.from(v);
    }
    if (Array.isArray(v)) return v.map((x) => fill(x, value, size));
    if (v && typeof v === 'object' && !ArrayBuffer.isView(v)) { const o = {}; Object.keys(v).forEach((k) => { o[k] = fill(v[k], value, size); }); return o; }
    return v;
}
/* Every buffer equal to `from` in a value replaced by `to` (an item's id stands in it twice). */
function swap(v, from, to) {
    if (Buffer.isBuffer(v)) return v.equals(from) ? Buffer.from(to) : v;
    if (Array.isArray(v)) return v.map((x) => swap(x, from, to));
    if (v && typeof v === 'object' && !ArrayBuffer.isView(v)) { const o = {}; Object.keys(v).forEach((k) => { o[k] = swap(v[k], from, to); }); return o; }
    return v;
}
/* An item id as BMW's code was read to make it: four bytes - the app's number's high part, a type per player
 * instance, the number's low byte, a counter. */
function itemId(num, type, count) {
    const b = Buffer.alloc(4);
    b.writeUInt32BE((((num >> 8) & 15) * 0x10000000 + (type & 15) * 0x1000000 + (num & 255) * 0x10000 + (count & 0xffff)) >>> 0, 0);
    return b;
}
/* The number BMW's code makes of an app's logging id ("OA15" -> 0xA15), or null where the id is not of that kind. */
function logNum(id) {
    const m = /^[A-Za-z]([0-9A-Fa-f]{3})$/.exec(String(id || ''));
    return m ? parseInt(m[1], 16) : null;
}
function appLoggingId(home) {
    const pkg = home ? readJson(path.join(home, 'source', 'package.json')) : null;
    let set = pkg && pkg.oapAppSettings;
    if (typeof set === 'string') { try { set = JSON.parse(set); } catch (e) { set = null; } }
    return set && typeof set.loggingId === 'string' ? set.loggingId : null;
}

const START_CALLS = ['setCurrentItemPositionAndTime', 'sendButtonEventDirect', 'setAutoplay', 'setPlaybackSpeed', 'setMuteState', 'configureButtonEventForwarding'];
const DYN_INSTS = [/^DynamicMediaPlayerMedia$/, /^DynamicMediaPlayerTempMedia$/, /^DynamicMediaPlayerTempLumMedia$/];
const FATAL = /^(ITEM_UNPLAYABLE|ITEM_CORRUPTED|ITEM_NO_DATA|DRM|NO_NETWORK)$/;
const STATE_V = 1;

/* ------------------------------------------------------------------ what is kept between plays and starts */

function loadState(file, version) {
    let s = readJson(file);
    if (!s || typeof s !== 'object' || s.v !== STATE_V) s = { v: STATE_V };
    ['silent', 'tried', 'skip'].forEach((k) => { if (!s[k] || typeof s[k] !== 'object') s[k] = {}; });
    // a combination the service died in the middle of is not tried again by this version
    if (typeof s.trying === 'string') { s.skip[s.trying] = 'the service stopped while it tried this'; }
    s.trying = null;
    // another version tries everything again (it may ask differently); what played and what was silent stays
    if (s.ver !== version) { s.tried = {}; s.skip = {}; s.ver = version; }
    return s;
}

/* ------------------------------------------------------------------ where the car's player may read our file */

function Expose(sound) {
    this.s = sound;
    this.o = sound.o;
    this.made = [];        // files of ours outside the cache
    this.server = null;
    this.tokens = {};
}
/* Our app's home among the installed apps (its package is named jap_ridetube...), or null. */
Expose.prototype.appHome = function () {
    if (this.home !== undefined) return this.home;
    this.home = null;
    const root = this.o.oapRoot;
    let names = [];
    try { names = fs.readdirSync(root).filter((n) => /^oap_\d+$/.test(n)).sort(); } catch (e) { return null; }
    for (const n of names) {
        const pkg = readJson(path.join(root, n, 'source', 'package.json'));
        if (pkg && /^jap_ridetube/.test(String(pkg.name))) { this.home = path.join(root, n); break; }
    }
    return this.home;
};
Expose.prototype.copyTo = function (dir, file) {
    // (a folder that is there keeps its mode - it is the app manager's; one we make can be read by the car's player)
    if (!fs.existsSync(dir)) { mkdirp(dir); try { fs.chmodSync(dir, 0o755); } catch (e) { /* as it is */ } }
    const to = path.join(dir, 'rt-audio-' + crypto.randomBytes(4).toString('hex') + path.extname(file));
    try { fs.linkSync(file, to); } catch (e) {
        // (a copy that does not fit leaves nothing behind)
        try { fs.copyFileSync(file, to); } catch (e2) { try { fs.unlinkSync(to); } catch (e3) { /* none was made */ } throw e2; }
    }
    try { fs.chmodSync(to, 0o644); } catch (e) { /* as it is */ }
    this.made.push(to);
    return to;
};
/* A copy (a hard link where the file system allows) in the data folder of our app: where BMW's apps keep the files
 * they play. */
Expose.prototype.pub = function (file) {
    const home = this.appHome();
    if (!home) throw new Error('our app\'s folder was not found under ' + this.o.oapRoot);
    return this.copyTo(path.join(home, 'data'), file);
};
/* A copy in the car's own store for online media (its media player's configuration names it as a media store): a
 * folder of ours in it, owned as the store is. */
Expose.prototype.store = function (file) {
    const root = this.o.oeDir || '/mnt/share/ent/oe';
    let st;
    try { st = fs.statSync(root); } catch (e) { throw new Error('the car has no ' + root); }
    if (!st.isDirectory()) throw new Error(root + ' is no folder');
    const dir = path.join(root, 'jap_ridetube8');
    const to = this.copyTo(dir, file);
    [dir, to].forEach((f) => { try { fs.chownSync(f, st.uid, st.gid); } catch (e) { /* as it is */ } });
    return to;
};
Expose.prototype.run = function (file) {
    return this.copyTo(this.o.runDir || '/run/jap-ridetube-d/media', file);
};
/* The file at http://127.0.0.1:<port>/<token>/<name>, ranges served: for a player that takes addresses. */
Expose.prototype.http = async function (file) {
    if (!this.server) {
        const srv = http.createServer((req, res) => {
            const m = /^\/([0-9a-f]{16})\//.exec(req.url || ''), f = m && this.tokens[m[1]];
            let st = null;
            try { st = f && fs.statSync(f); } catch (e) { st = null; }
            if (!st || (req.method !== 'GET' && req.method !== 'HEAD')) { res.writeHead(404); res.end(); return; }
            this.s.say('  (the player asked our address: ' + req.method + (req.headers.range ? ' ' + req.headers.range : '') + ')');
            const r = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
            let from = 0, to = st.size - 1;
            if (r && (r[1] || r[2])) {
                if (r[1]) { from = Number(r[1]); if (r[2]) to = Math.min(to, Number(r[2])); } else from = Math.max(0, st.size - Number(r[2]));
                if (from > to || from >= st.size) { res.writeHead(416, { 'Content-Range': 'bytes */' + st.size }); res.end(); return; }
            }
            const head = { 'Content-Type': 'audio/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': to - from + 1 };
            if (r) head['Content-Range'] = 'bytes ' + from + '-' + to + '/' + st.size;
            res.writeHead(r ? 206 : 200, head);
            if (req.method === 'HEAD') { res.end(); return; }
            fs.createReadStream(f, { start: from, end: to }).on('error', () => res.destroy()).pipe(res);
        });
        await new Promise((resolve, reject) => { srv.once('error', reject); srv.listen(0, '127.0.0.1', resolve); });
        srv.unref();
        this.server = srv;
    }
    const tok = crypto.randomBytes(8).toString('hex');
    this.tokens[tok] = file;
    return 'http://127.0.0.1:' + this.server.address().port + '/' + tok + '/' + path.basename(file);
};
Expose.prototype.clear = function () {
    this.made.forEach((f) => { try { fs.unlinkSync(f); } catch (e) { /* gone */ } });
    this.made = [];
    try { fs.rmdirSync(path.join(this.o.oeDir || '/mnt/share/ent/oe', 'jap_ridetube8')); } catch (e) { /* not there, or in use */ }
    this.tokens = {};
    if (this.server) { try { this.server.close(); } catch (e) { /* closed */ } this.server = null; }
};
/* At the service's start: files an earlier run left in the places above. */
Expose.prototype.sweep = function () {
    const dirs = [this.o.runDir || '/run/jap-ridetube-d/media', path.join(this.o.oeDir || '/mnt/share/ent/oe', 'jap_ridetube8')];
    const home = this.appHome();
    if (home) dirs.push(path.join(home, 'data'));
    dirs.forEach((d) => {
        let names = [];
        try { names = fs.readdirSync(d); } catch (e) { return; }
        names.filter((n) => /^rt-audio-[0-9a-f]{8}\.\w+$/.test(n)).forEach((n) => { try { fs.unlinkSync(path.join(d, n)); } catch (e) { /* stays */ } });
    });
};

/* ------------------------------------------------------------------ the car's dynamic media player */

function DynRoute(sound, inst) {
    this.s = sound;
    this.a = sound.a;
    this.o = sound.o;
    this.inst = inst;
    this.key = 'dyn:' + inst;
    this.name = 'the car\'s dynamic media player (' + inst.replace(/^DynamicMediaPlayer/, '') + ')';
    this.px = null;
    this.token = null;
    this.beat = null;
    this.ev = {};           // a field or event's name -> { n, v, t }: the last the car said
    this.active = false;    // a play of the daemon's goes through it: its state, time and errors go to the handlers
    this.combo = null;      // what played: { form, loc, start }
    this.unit = null;       // currentItemTime's unit, once it is seen moving: 'ms' or 's'
    this.info = {};
    this.focus = null;      // { clientId, hb }
}
DynRoute.prototype.say = function (t) { this.s.say(t); };
DynRoute.prototype.fail = function (short, e) {
    const x = new Error(this.name + ' ' + short);
    x.short = short + (e ? ': ' + errText(e) : '');
    return x;
};
DynRoute.prototype.call = function (m, a, ms) {
    const px = this.px;
    return withTimeout(Promise.resolve().then(() => px.callMethod(m, a, ms || 5000)), (ms || 5000) + 1500, m);
};
DynRoute.prototype.value = async function (name) {
    const px = this.px;
    try { return await withTimeout(Promise.resolve().then(() => px.getValue(name, 1500)), 2000, name); } catch (e) { return undefined; }
};
/* The proxy, answering; its fields and events heard (once per proxy, whichever DynRoute is the instance's now). */
DynRoute.prototype.open = async function () {
    const y = this.a.dyn;
    if (!y || !y.file) throw this.fail('has no description on this head unit');
    try { this.px = await this.a.proxy('DynamicMediaPlayer', y.cfg, this.inst, y.file, 4000); } catch (e) { throw this.fail('could not be reached', e); }
    const end = Date.now() + (this.o.dynWaitMs === undefined ? 5000 : this.o.dynWaitMs);
    let up = await this.a.answers(this.px);
    while (!up && Date.now() < end) { await sleep(250); up = await this.a.answers(this.px); }
    if (!up) throw this.fail('does not answer');
    this.s.receivers[this.inst] = this;
    if (this.s.heard.indexOf(this.px) < 0) {
        this.s.heard.push(this.px);
        const names = [], inst = this.inst, s = this.s;
        ['fields', 'attributes', 'events', 'broadcasts'].forEach((k) => {
            const v = y.cfg[k];
            if (v && typeof v === 'object') (Array.isArray(v) ? v.map((x) => String(x && typeof x === 'object' ? x.name : x)) : Object.keys(v)).forEach((x) => { if (names.indexOf(x) < 0) names.push(x); });
        });
        const none = [];
        names.forEach((n) => {
            try { this.px.subscribe({ name: n, onReceive: (v) => { const r = s.receivers[inst]; if (r) { try { r.onEvent(n, v); } catch (e) { s.o.log('dynamic player: handler: ' + (e && e.stack || e)); } } } }); } catch (e) { none.push(n + ' (' + errText(e).slice(0, 50) + ')'); }
        });
        // (how it is before anything is asked of it: one line)
        const now = [];
        for (const n of ['connectionState', 'playerState', 'autoPlayStatus', 'currentAudioFocus', 'currentItemPosition']) { const v = await this.value(n); if (v !== undefined) now.push(n + ' ' + show(v, 120)); }
        this.say(this.inst + ' answers' + (none.length ? ' (no listening to: ' + none.join(', ') + ')' : '') + (now.length ? ' | ' + now.join(' | ') : ''));
    } else this.say(this.inst + ' answers');
};
DynRoute.prototype.onEvent = function (name, v) {
    const e = this.ev[name] = this.ev[name] || { n: 0, first: Date.now() };
    e.n++;
    e.v = v;
    e.t = Date.now();
    // (the page's story: during an attempt what it said is gathered into one line; before, each kind's first three)
    if (this.got) { const g = this.got[name] = this.got[name] || { n: 0 }; g.n++; g.v = v; } else if (!this.active && name === 'playbackErrorEvent') this.say('  the player: ' + name + ' ' + show(v, 300));
    if (name === 'currentItemTime') this.onTime(v);
    if (name === 'playerState') this.stateEvents = true;
    if (!this.active) return;
    if (name === 'playerState') this.s.to('state', v);
    else if (name === 'playbackErrorEvent' && v && FATAL.test(String(v.event))) this.s.to('error', v);
};
/* currentItemTime: its unit told by how fast it moves (ms on iDrive 7's player; not known here), then to the daemon
 * as milliseconds with the video's own length where the player gives none. */
DynRoute.prototype.onTime = function (v) {
    if (!v || typeof v.elapsed !== 'number') return;
    const now = Date.now(), c = this.clock;
    if (!c || v.elapsed < c.e0) this.clock = { e0: v.elapsed, t0: now, e: v.elapsed, t: now, moved: false };
    else {
        if (v.elapsed > c.e) c.moved = true;
        c.e = v.elapsed;
        c.t = now;
        if (!this.unit && now - c.t0 >= 1200 && v.elapsed > c.e0) {
            const rate = (v.elapsed - c.e0) / (now - c.t0);
            this.unit = rate > 0.05 ? 'ms' : 's';
            this.say('  the player\'s time moves ' + (this.unit === 'ms' ? 'in milliseconds' : 'in seconds') + ' (' + v.elapsed + ' after ' + (now - c.t0) + ' ms)');
            this.s.learnUnit(this.key, this.unit);
        }
    }
    if (!this.unit && v.total > 0 && this.info.durationMs > 0) {
        if (Math.abs(v.total - this.info.durationMs) < this.info.durationMs * 0.05) this.unit = 'ms';
        else if (Math.abs(v.total * 1000 - this.info.durationMs) < this.info.durationMs * 0.05 + 1000) this.unit = 's';
        if (this.unit) this.s.learnUnit(this.key, this.unit);
    }
    // (until the unit is known - kept from a play before, told by the total, or by 1.2 s of moving - nothing is said
    // to the daemon: a time in seconds taken for milliseconds would put the picture at the start. 1.5 s at most.)
    if (this.active && (this.unit || now - this.clock.t0 >= 1500)) this.tick(v.elapsed, v.total);
};
DynRoute.prototype.tick = function (elapsed, total) {
    const k = this.unit === 's' ? 1000 : 1;
    let tot = (total > 1 ? total : 0) * k;
    if (!(tot > 1)) tot = this.info.durationMs > 1 ? this.info.durationMs : 2;
    this.lastTick = { e: elapsed * k, t: Date.now() };
    this.s.to('time', { elapsed: elapsed * k, total: tot });
};
/* A player that says PLAY and then no time (seen on no car yet, but then the picture would never start): the clock
 * goes on from the last time it did say. */
DynRoute.prototype.assist = function () {
    if (this.timer) return;
    let n = 0;
    this.timer = setInterval(() => {
        if (!this.active || this.busy) return;
        // a player whose events do not reach us: its state is asked now and then, a change said to the daemon
        if (!this.stateEvents && ++n % 4 === 0) {
            this.value('playerState').then((v) => {
                const e = this.ev.playerState = this.ev.playerState || { n: 0 };
                if (v === undefined || v === e.v || !this.active || this.stateEvents) return;
                e.v = v;
                this.s.to('state', v);
            });
        }
        if (this.held) return;
        const st = this.ev.playerState && this.ev.playerState.v, lt = this.lastTick || { e: this.base || 0, t: this.playAt || Date.now() };
        if (st !== 'PLAYER_STATE_PLAY' || Date.now() - lt.t < 1500) return;
        if (!this.assisted) { this.assisted = true; this.say('the player says no time: the service counts it on'); }
        const e = lt.e + (Date.now() - lt.t);
        this.lastTick = { e: e, t: Date.now() };
        this.s.to('time', { elapsed: e, total: this.info.durationMs > 1 ? this.info.durationMs : e + 2 });
    }, 500);
    if (this.timer.unref) this.timer.unref();
};
DynRoute.prototype.clear = function (names) { names.forEach((n) => { delete this.ev[n]; }); };
DynRoute.prototype.playingNow = function () {
    const st = this.ev.playerState && this.ev.playerState.v;
    return st === 'PLAYER_STATE_PLAY' || !!(this.clock && this.clock.moved && this.ev.currentItemTime);
};
DynRoute.prototype.errorNow = function () {
    const e = this.ev.playbackErrorEvent && this.ev.playbackErrorEvent.v;
    return e && e.event && !/^(NO_ERROR|ITEM_CHANGE_DELAYED|ITEM_BUFFER_UNDERRUN)$/.test(String(e.event)) ? String(e.event) : null;
};
/* Waits until it plays or says an error (asking its state too: the events may not come), ms at most. */
DynRoute.prototype.waitPlay = async function (ms) {
    const end = Date.now() + ms;
    for (;;) {
        if (this.playingNow() || this.errorNow()) return;
        const st = await this.value('playerState');
        if (st !== undefined) { const e = this.ev.playerState = this.ev.playerState || { n: 0 }; e.v = st; e.t = Date.now(); }
        if (this.playingNow() || this.errorNow() || Date.now() > end || this.s.cancelled) return;
        await sleep(200);
    }
};
DynRoute.prototype.button = async function (b) {
    const one = async (action) => {
        try {
            const r = await this.call('sendButtonEventDirect', { token: this.token, button: b, action: action }, 3000);
            if (!r || r.dynMediaPlayerError !== 'OK') this.o.log('dynamic player: ' + b + ' ' + action + ' ' + show(r));
            return r;
        } catch (e) { this.o.log('dynamic player: ' + b + ' ' + action + ' failed: ' + errText(e)); return { failed: errText(e) }; }
    };
    if (b === 'STOP' || b === 'PAUSE') this.held = true; else if (b === 'PLAY') this.held = false;
    const r = await one('PRESS');
    await sleep(80);
    await one('RELEASE');
    return r;
};
/* The focus: a token, kept alive by our beat. The first car gave it to our app's name with timer 0 and answered
 * BAD_ARGUMENT to every other timer; where that is refused: what BMW's own code passes where that could be read
 * (sdkread), then every name of ours with a wide row of timers, shown under our title, under the name itself and
 * under nothing. Each answer takes milliseconds. The story gets one line. */
DynRoute.prototype.getFocus = async function (hint) {
    const sdk = this.s.sdkFacts();
    // (our own names first: the car gave its focus to the first of them; a name BMW's code passes as a plain word after)
    const ids = uniq([hint && hint.clientId].concat(this.s.clientIds(), sdk.clientIds || []));
    // (BMW's own code passes timer 0 for the three entertainment instances - the car took nothing else - and its
    // heartbeat's time for the others)
    const hbs = uniq([hint && hint.hb, 0, sdk.hb, this.o.dynHeartbeatTimer || 10000, 5000, 3000, 2000, 1000, 500, 30, 10, 5, 3, 2, 1, 60, 15000, 30000, 60000]);
    const titles = uniq([hint && hint.clientName, 'RideTube', sdk.clientName]);
    const combos = [];
    ids.forEach((id) => titles.forEach((t) => hbs.forEach((hb) => combos.push([id, t, hb]))));
    ids.forEach((id) => [id, ''].forEach((t) => hbs.forEach((hb) => { if (titles.indexOf(t) < 0) combos.push([id, t, hb]); })));
    const said = {}, skip = {};
    const sum = () => Object.keys(said).map((k) => k + ' x' + said[k]).join(', ') || 'nothing asked';
    const what = () => 'names ' + ids.join(', ') + ' | shown as ' + titles.concat(['the name itself', 'nothing']).join(', ') + ' | timers ' + hbs.join(', ');
    const end = Date.now() + (this.o.dynFocusMs || 25000);
    let last = null, n = 0;
    for (const c of combos) {
        if (skip[c[0] + '|' + c[1]] || this.s.cancelled || Date.now() > end || n >= 400) continue;
        let r;
        n++;
        try { r = await this.call('getAudioFocus', { clientId: c[0], clientName: c[1], timeOutHeartBeatTimer: c[2] }); } catch (e) {
            last = errText(e);
            // (no answer at all is not about what was asked: this instance is left)
            if (/timed out|timeout|unavailable/i.test(last)) {
                this.say('getAudioFocus(' + c.join(', ') + ') failed: ' + last + (n > 1 ? ' | before: ' + sum() : ''));
                throw this.fail('does not answer getAudioFocus (' + last.slice(0, 80) + ')');
            }
            said['failed: ' + last.slice(0, 60)] = (said['failed: ' + last.slice(0, 60)] || 0) + 1;
            skip[c[0] + '|' + c[1]] = true;
            continue;
        }
        last = r && r.dynMediaPlayerError;
        if (r && r.dynMediaPlayerError === 'OK' && r.token) {
            this.say('getAudioFocus(' + c.join(', ') + ') -> ' + show(r) + (n > 1 ? ' | refused before: ' + sum() : ''));
            this.token = r.token;
            this.focus = { clientId: c[0], clientName: c[1], hb: c[2] };
            const every = Math.max(300, Math.min(this.o.dynHeartbeatMs || 1500, sdk.beatMs || 1e9, c[2] >= 900 && c[2] < 1e9 ? Math.floor(c[2] / 3) : 1e9));
            this.beat = setInterval(() => {
                this.call('heartBeat', { token: this.token }, 2000).catch((e) => { if (!this.beatSaid) this.say('heartBeat failed: ' + errText(e)); this.beatSaid = true; });
            }, every);
            if (this.beat.unref) this.beat.unref();
            return;
        }
        const k = String(last === undefined ? show(r) : last).slice(0, 60);
        said[k] = (said[k] || 0) + 1;
        // (an answer other than "bad argument" is not about the timer: the next name)
        if (last !== 'BAD_ARGUMENT') skip[c[0] + '|' + c[1]] = true;
    }
    this.say('getAudioFocus refused all ' + n + ' ways it was asked: ' + sum() + ' | ' + what());
    throw this.fail('gave no audio focus (' + sum().slice(0, 80) + ')');
};
/* Connected to the car's audio, as BMW's SDK waits for it before it plays: ms at most, what it said either way. */
DynRoute.prototype.waitConnected = async function (ms) {
    const end = Date.now() + ms;
    let conn, focus, said = '';
    for (;;) {
        conn = await this.value('connectionState');
        if (conn === undefined && this.ev.connectionState) conn = this.ev.connectionState.v;
        focus = await this.value('currentAudioFocus');
        const now = show(conn);
        if (now !== said.slice(-now.length)) said += (said ? ' -> ' : '') + now;
        if (conn === 'CS_CONNECTED' || Date.now() > end || this.s.cancelled) break;
        await sleep(300);
    }
    this.say('  connectionState ' + said + ' | currentAudioFocus ' + show(focus));
    return { conn: conn, focus: focus, ours: !!(focus && focus.token === this.token) };
};
/* What the player says of the item it took: its own words for our file name show the form was understood. */
DynRoute.prototype.echo = function (value) {
    const md = this.ev.currentItemMetadata;
    if (!md || md.v === undefined) return 'none';
    const text = show(md.v, 4000);
    if (text.indexOf(value) >= 0 || text.indexOf(path.basename(value)) >= 0) return 'name';
    return Array.isArray(md.v) && md.v.length ? 'other' : 'none';
};
DynRoute.prototype.starts = function (first) {
    const tok = () => this.token;
    const w = this.o.dynStartWaitMs || 2500;      // how long each start is given to show
    const sdk = this.s.sdkFacts().startCalls;
    const mine = (v) => (v === 'RTTOKEN' ? tok() : Array.isArray(v) ? v.map(mine) : v && typeof v === 'object' && !Buffer.isBuffer(v) ? Object.keys(v).reduce((o, k) => { o[k] = mine(v[k]); return o; }, {}) : v);
    const all = (sdk ? [{ key: 'sdk', name: 'as BMW\'s code does (' + sdk.map((c) => c.method + (c.args.button ? ' ' + c.args.button + ' ' + c.args.action : '')).join(', ') + ')', ms: w, run: async () => {
        let bad = null, r = null;
        for (const c of sdk) { r = await this.call(c.method, mine(c.args), 3000); if (!bad && (!r || r.dynMediaPlayerError !== 'OK')) bad = r || {}; }
        return bad || r;
    } }] : []).concat([
        { key: 'auto', name: 'by itself', ms: this.o.dynAutoMs || 1800, run: null },
        { key: 'pos', name: 'position(1, 0)', ms: w, run: () => this.call('setCurrentItemPositionAndTime', { token: tok(), newPosition: 1, newTimeElapsed: 0 }, 3000) },
        { key: 'play', name: 'PLAY', ms: w, run: () => this.button('PLAY') },
        { key: 'autoplay', name: 'autoplay + PLAY', ms: w, run: async () => { const r = await this.call('setAutoplay', { token: tok(), autoplay: true }, 3000); await this.button('PLAY'); return r; } },
        { key: 'pos0', name: 'position(0, 0) + PLAY', ms: w, run: async () => { const r = await this.call('setCurrentItemPositionAndTime', { token: tok(), newPosition: 0, newTimeElapsed: 0 }, 3000); await this.button('PLAY'); return r; } },
    ]);
    // what is known to start it (kept from a play, else read from BMW's code) goes first, at once; nothing known:
    // it is first given a moment to start by itself
    const lead = uniq((first || []).filter(Boolean).concat(sdk ? ['sdk'] : ['auto'])).map((k) => all.filter((x) => x.key === k)[0]).filter(Boolean);
    return lead.concat(all.filter((x) => lead.indexOf(x) < 0));
};
/* (the starts' names on the page: "by itself" - nothing is asked after the playlist; "position(1, 0)" -
 * setCurrentItemPositionAndTime(token, 1, 0), which is what BMW's playItem does; "PLAY" - sendButtonEventDirect PLAY,
 * pressed and released; "autoplay + PLAY" - setAutoplay(token, true) first.)
 * One playlist with our file, written one way (form) and said to be in one place (loc), then the starts until it
 * plays: { out: 'playing' | 'rejected' | 'idle' | 'item-error' | 'token' | 'conn' | 'unprepared' | 'empty', ... }.
 * The car answers OK to a playlist and may still leave its list empty (the first car did, to every one): whether
 * the item is in the list is asked first. probe: an item that is not ends the attempt there ('empty', nothing
 * said - the caller sums those up); otherwise only BMW's own start and PLAY are tried on an empty list. */
DynRoute.prototype.attempt = async function (form, loc, file, starts, quick, probe) {
    const tag = '[' + form.name + ' | ' + loc.name + ']';
    let value, item;
    try {
        value = await loc.value(file);
        let size = 0;
        try { size = fs.statSync(file).size; } catch (e) { /* unknown */ }
        item = form.make(value, size, Buffer.from((path.basename(path.dirname(file)) || 'ridetube').slice(0, 11) + (/head/.test(path.basename(file)) ? 'h' : 'f')));
    } catch (e) {
        this.say('createPlaylist ' + tag + ' not asked: ' + errText(e));
        return { out: 'unprepared', why: errText(e) };
    }
    const key = this.key + '|' + form.key + '|' + loc.key;
    this.clear(['playerState', 'playbackErrorEvent', 'currentItemTime', 'currentItemMetadata', 'currentItemId', 'currentItemPosition', 'currentItemPath']);
    this.clock = null;
    this.got = {};
    const said = () => {
        const g = this.got || {}, names = Object.keys(g);
        // (our file's place is said as such: what the player says is then the same from one place to the next)
        return names.length ? names.map((n) => n + (g[n].n > 1 ? ' x' + g[n].n : '') + ' ' + show(g[n].v, n === 'currentItemMetadata' ? 400 : 160).split(String(value)).join('<our file>').slice(0, n === 'currentItemMetadata' ? 260 : 120)).join(' | ') : 'nothing';
    };
    this.s.trying(key);
    let r, err = null;
    try { r = await this.call('createPlaylist', { token: this.token, newPlaylist: item }); } catch (e) { err = errText(e); }
    this.s.tried(key, err ? 'refused: ' + err.slice(0, 80) : String(r && r.dynMediaPlayerError));
    // (the item is printed the first time its form is used: only the file's place differs after that)
    const shown = this.s.shown, fam = form.family || form.key;
    const what = shown[fam] ? show(value, 120) : show(item, 300);
    if (!probe) shown[fam] = true;
    if (err) { this.got = null; this.say('createPlaylist ' + tag + ' ' + what + ' FAILED: ' + err); return { out: 'rejected', why: err }; }
    const code = r && r.dynMediaPlayerError;
    if (code !== 'OK') {
        this.got = null;
        this.say('createPlaylist ' + tag + ' ' + what + ' -> ' + show(r));
        return { out: code === 'TOKEN_NOT_VALID' ? 'token' : code === 'CONNECTION_STATE_NOT_VALID' ? 'conn' : 'rejected', why: String(code) };
    }
    // taken: what it says of it, then the starts. One line of the story for all of it; what repeats the attempt
    // before (the same starts failing, the player saying the same) is said short
    const listEnd = Date.now() + (this.o.dynListMs === undefined ? 900 : this.o.dynListMs);
    let pos, echo, listed = false;
    for (;;) {
        await sleep(Math.min(150, Math.max(0, listEnd - Date.now())));
        pos = await this.value('currentItemPosition');
        echo = this.echo(String(value));
        const idSaid = this.got.currentItemId && this.got.currentItemId.v && this.got.currentItemId.v.length > 0;
        listed = !!(pos && pos.totalNumber > 0) || echo !== 'none' || !!idSaid || this.playingNow() || !!this.errorNow();
        if (listed || Date.now() >= listEnd || this.s.cancelled) break;
    }
    if (probe && !listed) {
        this.got = null;
        this.s.tried(key, 'taken, the list stays empty');
        return { out: 'empty', item: item };
    }
    shown[fam] = true;
    let line = 'createPlaylist ' + tag + ' ' + what + ' -> OK, list ' + (pos ? pos.position + '/' + pos.totalNumber : '?') + (listed ? '' : ' (empty)') + (echo === 'name' ? ', it names our file' : echo === 'other' ? ', it does NOT name our file' : '');
    let used = null;
    const tries = [];
    // (an empty list: what BMW's code does after its playlist, and PLAY - a moment each)
    for (const st of listed ? starts : starts.filter((x) => x.key === 'sdk' || x.key === 'pos' || x.key === 'play')) {
        if (this.playingNow() || this.errorNow() || this.s.cancelled) break;
        used = st.key;
        let res = '';
        if (st.run) { try { const x = await st.run(); res = x && x.dynMediaPlayerError === 'OK' ? '' : ' -> ' + show(x, 70); } catch (e) { res = ' failed: ' + errText(e).slice(0, 70); } }
        await this.waitPlay(quick || !listed ? Math.min(st.ms, 1500) : st.ms);
        tries.push(st.name + res + ': ' + (this.playingNow() ? 'PLAYS' : this.errorNow() ? this.errorNow() : 'no'));
        if (quick && echo === 'other') break;      // (not our file in its list: no start will play it)
    }
    const all = tries.join(', '), heard = said();
    line += ' | started ' + (!tries.length ? 'by nothing: it ' + (this.playingNow() ? 'PLAYS' : 'said ' + this.errorNow()) : all === this.lastTries ? 'by none of them again' : all);
    line += heard === this.lastHeard ? '' : ' | the player said: ' + heard;
    // whether the car's media engine has the file open tells a list it took from one it dropped
    if (!this.playingNow() && /^\//.test(String(value))) {
        const who = this.s.readers(String(value));
        if (who !== undefined) line += who ? ' | ' + who + ' has our file open' : ' | the car\'s media engine does not have our file open';
    }
    if (tries.length && !this.playingNow()) this.lastTries = all;
    this.lastHeard = heard;
    this.got = null;
    this.say(line);
    if (this.playingNow()) { this.s.tried(key, 'PLAYS (' + used + ')'); return { out: 'playing', start: used || 'auto' }; }
    if (this.errorNow()) { this.s.tried(key, 'taken, then ' + this.errorNow()); return { out: 'item-error', why: this.errorNow(), echo: echo }; }
    this.s.tried(key, listed ? 'taken, never played' : 'taken, the list stays empty');
    return { out: 'idle', echo: echo, listed: listed };
};
/* The focus of this instance, ours and kept alive, and what it then says of its connection to the car's audio:
 * once, whoever asks first (the service's own player with this focus, or the playlist below). */
DynRoute.prototype.enter = async function (hint) {
    if (this.entered) return this.conn;
    await this.open();
    if (!this.token) await this.getFocus(hint);
    this.conn = await this.waitConnected(this.o.dynConnectMs === undefined ? 5000 : this.o.dynConnectMs);
    this.entered = true;
    return this.conn;
};
/* The whole of it on this instance: the focus, then the forms and places until one plays. */
DynRoute.prototype.play = async function (file, info, hint) {
    this.info = info || {};
    hint = hint && hint.key === this.key ? hint : null;
    if (hint && (hint.unit === 'ms' || hint.unit === 's')) this.unit = hint.unit;
    let c = await this.enter(hint);
    // (a form the binding or the service refused on an instance before is refused here too: left out)
    const refused = this.s.refused, locs = this.s.locs(), sdk = this.s.sdkFacts();
    const ids = this.s.idForms(this.inst);
    let forms = this.s.forms(), places = locs;
    if (forms.some((f) => !refused[f.key])) forms = forms.filter((f) => !refused[f.key]);
    // an instance after one that took our file and never played it: the form that one took, the two likeliest
    // places - the long search was made there
    if (this.s.took && !hint) {
        const f = forms.concat(ids).filter((x) => x.key === this.s.took)[0];
        if (f) { forms = [f]; places = locs.slice(0, 2); }
    }
    const starts = this.starts([hint && hint.start, sdk.startCalls ? 'sdk' : sdk.start]);
    const by = (list, k) => list.filter((x) => x.key === k)[0];
    const done = {}, again = {};
    // a token or a connection the player says it lacks: asked for again, once each a play
    const recover = async (kind) => {
        if (again[kind]) throw this.fail(kind === 'token' ? 'does not keep our audio focus (TOKEN_NOT_VALID)' : 'is not connected to the car\'s audio (connectionState ' + show(c.conn) + ')');
        again[kind] = true;
        if (kind === 'token') { if (this.beat) clearInterval(this.beat); this.beat = null; this.token = null; await this.getFocus(hint); }
        c = await this.waitConnected(this.o.dynConnectMs === undefined ? 5000 : this.o.dynConnectMs);
    };
    let n = 0, lastWhy = null, taken = 0, inList = 0, itemError = null;
    let queue = forms.map((f) => [f, locs[0]]), later = [];
    // The car's player answers OK to a playlist and leaves its list empty. BMW's own code gives an item an id of
    // four bytes that says which app and which player instance it is for (ours was all zeros), and the player's
    // configuration names a store for online media. So first, a moment each: BMW's item with every id an app could
    // give it for this instance, our file where it is, in that store and in our app's folder. One the list takes
    // gets the starts at once.
    if (ids.length && !hint) {
        const pl = ['path', 'oe', 'pub'].map((k) => by(locs, k)).filter(Boolean);
        const empty = [], not = {};
        let sample = null, stop = false;
        // (one line for all the list did not take, one for where the file could not be put)
        const sum = () => {
            if (empty.length) {
                this.say('BMW\'s item with each id an app could give it (' + uniq(empty.map((e) => e[0])).join(', ') + '), our file ' + uniq(empty.map((e) => e[1])).join(' / ') +
                    ': createPlaylist OK ' + empty.length + ' times, the list stays empty' + (sample && !this.s.shown.sdk ? ' | the first: ' + show(sample, 320) : ''));
                this.s.shown.sdk = true;
            }
            if (Object.keys(not).length) this.say('our file could not be put: ' + Object.keys(not).map((k) => not[k]).join(' | '));
        };
        for (const f of ids) {
            for (const l of pl) {
                if (stop || this.s.cancelled || not[l.key]) continue;
                this.s.note('Finding how this car plays sound: way ' + this.s.count() + '...');
                let r = await this.attempt(f, l, file, starts, false, true);
                if (r.out === 'token' || r.out === 'conn') { await recover(r.out); r = await this.attempt(f, l, file, starts, false, true); }
                n++;
                if (r.out !== 'empty' && r.out !== 'unprepared') done[this.key + '|' + f.key + '|' + l.key] = true;
                if (r.out === 'playing') {
                    sum();
                    this.combo = { form: f.key, loc: l.key, start: r.start };
                    this.say('PLAYS: ' + this.inst + ' | ' + f.name + ' | ' + l.name + ' | started ' + r.start);
                    return;
                }
                if (r.out === 'empty') { empty.push([f.id, l.name]); sample = sample || r.item; continue; }
                if (r.out === 'unprepared') { not[l.key] = l.name + ' (' + String(r.why).slice(0, 90) + ')'; continue; }
                lastWhy = r.why || r.out;
                // (a token or a connection lost, a form the binding refuses: the search below deals with those)
                if (r.out !== 'idle' && r.out !== 'item-error') { stop = true; continue; }
                taken++;
                inList++;
                if (r.out === 'item-error') itemError = r.why;
                // in its list and not played: this id is the one; the file's other places with it
                this.s.took = f.key;
                queue = places.map((x) => [f, x]);
                stop = true;
            }
        }
        sum();
        // none in its list: the likeliest id at every place once more, now with BMW's own start and PLAY each (should
        // its list not say what it holds) and a look whether the car's media engine opened the file
        if (!taken && !stop && forms.length !== 1) { forms = [ids[0]]; queue = places.map((x) => [ids[0], x]); }
    }
    if (hint && by(forms.concat(ids), hint.form) && by(locs, hint.loc)) queue.unshift([by(forms.concat(ids), hint.form), by(locs, hint.loc)]);
    // the first instance gets the whole search; the next ones a shorter one
    const deadline = Date.now() + (this.s.searched++ ? (this.o.dynNextMs || 60000) : (this.o.dynBudgetMs || 150000));
    while (queue.length || later.length) {
        if (!queue.length) { queue = later; later = []; }
        const f = queue[0][0], l = queue[0][1];
        queue.shift();
        const key = this.key + '|' + f.key + '|' + l.key;
        if (done[key]) continue;
        if (this.s.cancelled) throw this.fail('was stopped');
        if (this.s.state.skip[key]) { this.say('[' + f.name + ' | ' + l.name + '] left out: ' + this.s.state.skip[key]); done[key] = true; continue; }
        if (Date.now() > deadline) { this.say('out of time: ' + (queue.length + later.length + 1) + ' ways not tried this time'); throw this.fail('did not play in the time given (' + n + ' ways tried; a new play goes on)'); }
        done[key] = true;
        n++;
        this.s.note('Finding how this car plays sound: way ' + this.s.count() + '...');
        const r = await this.attempt(f, l, file, starts, taken >= 2 && f.key !== 'sdk');
        if (r.out === 'playing') {
            this.combo = { form: f.key, loc: l.key, start: r.start };
            this.say('PLAYS: ' + this.inst + ' | ' + f.name + ' | ' + l.name + ' | started ' + r.start);
            return;
        }
        lastWhy = r.why || r.out;
        if (r.out === 'rejected') refused[f.key] = true;
        if (r.out === 'token' || r.out === 'conn') {
            await recover(r.out);
            done[key] = false;
            queue.unshift([f, l]);
            continue;
        }
        if (r.out === 'idle' || r.out === 'item-error') {
            taken++;
            if (r.listed !== false) inList++;
            if (r.out === 'item-error') itemError = r.why;
            // the player took this form and (as far as it says) understood it: no other form is asked - what is
            // left to find is the place of the file and the start
            if (r.echo !== 'other') { queue = queue.filter((x) => x[0] === f); later = later.filter((x) => x[0] === f); }
            // the form was taken: the file's other places with it - at once when the form is BMW's own, the player
            // named our file, or it said it cannot read it; else after the other forms
            if (!this.s.took || f.key === 'sdk') this.s.took = this.s.took === 'sdk' ? 'sdk' : f.key;
            const others = places.filter((x) => x !== l).map((x) => [f, x]);
            if (f.key === 'sdk' || r.echo === 'name' || r.out === 'item-error') queue = others.concat(queue); else later = later.concat(others);
        }
    }
    throw this.fail(taken && !inList ? 'answers OK to our playlist and leaves its list empty' : taken ? 'took our file but never played it' + (itemError ? ' (' + itemError + ')' : '') : 'did not take the playlist (' + String(lastWhy).slice(0, 60) + ')');
};
/* From here its state, time and errors are the daemon's. */
DynRoute.prototype.activate = function () {
    this.active = true;
    this.playAt = Date.now();
    this.base = 0;
    this.lastTick = null;
    this.assist();
    // (the daemon arms its end-of-file on a PLAY it sees: the one that came while we were finding the way is said again)
    setTimeout(() => { if (this.active && this.playingNow()) this.s.to('state', 'PLAYER_STATE_PLAY'); }, 30);
    // what the car says a moment into the play, for the page: a play nobody hears shows here (not connected, no time)
    const t = setTimeout(async () => {
        if (!this.active) return;
        const conn = await this.value('connectionState'), st = await this.value('playerState'), focus = await this.value('currentAudioFocus');
        if (this.active) this.say('  ' + Math.round((Date.now() - this.playAt) / 1000) + ' s into it: connectionState ' + show(conn) + ' | playerState ' + show(st) + ' | currentItemTime ' + show(this.ev.currentItemTime && this.ev.currentItemTime.v) +
            (this.ev.currentItemTime ? ' (' + this.ev.currentItemTime.n + ' said)' : ' (none said)') + ' | focus ' + (focus && focus.token === this.token ? 'ours, ' + focus.status : show(focus, 120)) + (this.errorNow() ? ' | error ' + this.errorNow() : ''));
    }, this.o.dynLookMs || 3000);
    if (t.unref) t.unref();
};
/* Another file on the live focus (the head file, then the whole one): the way that played, its start. */
DynRoute.prototype.replay = async function (file) {
    const forms = this.s.forms().concat(this.s.idForms(this.inst)), locs = this.s.locs(), c = this.combo;
    const f = forms.filter((x) => x.key === c.form)[0], l = locs.filter((x) => x.key === c.loc)[0];
    if (!f || !l) throw this.fail('lost the way it played');
    const was = this.active;
    this.active = false;       // (the list's own STOP and errors are not the daemon's)
    this.busy = true;
    this.held = false;
    try {
        const r = await this.attempt(f, l, file, this.starts([c.start]), false);
        if (r.out !== 'playing') throw this.fail('did not play the next file (' + (r.why || r.out) + ')');
    } finally { this.active = was; this.busy = false; }
    this.lastTick = null;
    this.playAt = Date.now();
    if (was) setTimeout(() => { if (this.active && this.playingNow()) this.s.to('state', 'PLAYER_STATE_PLAY'); }, 30);
};
DynRoute.prototype.seek = async function (ms) {
    const v = this.unit === 's' ? Math.round(ms / 1000) : ms;
    let r;
    try { r = await this.call('setCurrentItemPositionAndTime', { token: this.token, newPosition: 1, newTimeElapsed: v }, 3000); } catch (e) { r = { failed: errText(e) }; }
    if (!r || r.dynMediaPlayerError !== 'OK') {
        this.o.log('dynamic player: seek ' + show(r) + ', setTime instead');
        try { this.o.log('dynamic player: setTime ' + show(await this.call('setTime', { newTimeElapsed: v }, 3000))); } catch (e) { this.o.log('dynamic player: setTime failed: ' + errText(e)); }
    }
    this.lastTick = { e: ms, t: Date.now() };
};
DynRoute.prototype.release = async function () {
    this.active = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.beat) clearInterval(this.beat);
    this.beat = null;
    const token = this.token;
    this.token = null;
    this.entered = false;
    if (this.s.receivers[this.inst] === this) delete this.s.receivers[this.inst];
    if (!token || !this.px) return;
    for (const c of [['createPlaylist', { token: token, newPlaylist: [] }], ['releaseAudioFocus', { token: token }]]) {
        try { this.o.log('dynamic player: ' + c[0] + (c[0] === 'createPlaylist' ? ' (empty) ' : ' ') + show(await this.call(c[0], c[1], 3000))); } catch (e) { this.o.log('dynamic player: ' + c[0] + ' failed: ' + errText(e)); }
    }
};

/* ------------------------------------------------------------------ without the car's player: decoder + ALSA */

function DirectRoute(sound, dev, opt) {
    this.s = sound;
    this.a = sound.a;
    this.o = sound.o;
    this.dev = dev;
    this.connect = !(opt && opt.connect === false);     // our source connected by the audio manager first
    this.key = 'direct:' + dev;
    this.name = 'the service\'s own player on "' + short(dev) + '"';
    this.child = null;
    this.active = false;
    this.info = {};
}
DirectRoute.prototype.say = function (t) { this.s.say(t); };
DirectRoute.prototype.fail = function (short, e) {
    const x = new Error(this.name + ' ' + short);
    x.short = short + (e ? ': ' + errText(e) : '');
    return x;
};
/* ytalsa.py with the file: resolves when it writes samples the device takes at the pace of time. */
DirectRoute.prototype.spawn = function (file, startMs) {
    const o = this.o, cmd = o.alsaCmd || ['/var/opt/mgu-python/current/bin/python3', '-I', path.join(__dirname, 'ytalsa.py')];
    const args = cmd.slice(1).concat(['play', '--device', this.dev, '--decoder', o.ytaud || path.join(__dirname, 'ytaud'), '--file', file, '--start-ms', String(Math.max(0, Math.floor(startMs || 0)))]);
    const child = cp.spawn(cmd[0], args, { cwd: '/', env: o.alsaEnv || {}, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    child.stdin.on('error', () => { /* it died: its exit says */ });
    readline.createInterface({ input: child.stderr }).on('line', (l) => { if (this.child === child) { this.lastErr = l; this.o.log('ytalsa: ' + l.slice(0, 300)); } });
    readline.createInterface({ input: child.stdout }).on('line', (l) => {
        if (this.child !== child) return;
        let m;
        try { m = JSON.parse(l); } catch (e) { return; }
        this.onLine(m);
    });
    child.on('error', (e) => { if (this.child === child) this.onLine({ ev: 'error', msg: 'could not be started: ' + e.message }); });
    child.on('exit', (code, sig) => { if (this.child === child) { this.child = null; this.onLine({ ev: 'exit', code: sig || code }); } });
};
DirectRoute.prototype.to = function (line) {
    if (!this.child) return;
    try { this.child.stdin.write(line + '\n'); } catch (e) { /* dying */ }
};
DirectRoute.prototype.onLine = function (m) {
    const s = this.s;
    if (m.ev === 'time') {
        this.last = m;
        if (this.active) s.to('time', { elapsed: m.elapsed, total: m.total > 1 ? m.total : (this.info.durationMs > 1 ? this.info.durationMs : m.elapsed + 2) });
    } else if (m.ev === 'state') {
        this.pstate = m.state;
        if (this.active) s.to('state', m.state);
    } else if (m.ev === 'resumed') {
        this.resumed = !!m.ok;
    } else if (m.ev === 'flow') {
        this.flow = m;
        if (this.waiter) this.waiter();
    } else if (m.ev === 'open') {
        this.opened = m;
        this.say('  opened ' + short(this.dev) + ': ' + m.rate + ' Hz, ' + m.channels + ' ch, buffer ' + m.buffer);
    } else if (m.ev === 'error' || m.ev === 'exit') {
        if (m.ev === 'error') this.err = String(m.msg || 'failed');
        else if (!this.err && !this.ended && m.code !== 0) this.err = 'ended (' + m.code + ')' + (this.lastErr ? ': ' + String(this.lastErr).trim().slice(0, 160) : '');
        if (m.ev === 'exit' && !this.err) this.ended = true;
        if (this.waiter) this.waiter();
        if (this.active && this.err) { const e = this.err; this.active = false; s.to('error', { event: 'the service\'s own player: ' + e }); }
    }
    // (its eof is followed by its own stop: nothing more to say here)
};
/* Waits for the writer's verdict on the device: 'flows' (it takes the samples as time passes), 'stalls' (it takes
 * none: not connected to anything), or an error. */
DirectRoute.prototype.verdict = async function (ms) {
    const end = Date.now() + ms;
    while (!this.flow && !this.err && !this.ended && Date.now() < end && !this.s.cancelled) {
        await new Promise((r) => { this.waiter = r; setTimeout(r, 250); });
    }
    this.waiter = null;
    if (this.err) return { out: 'error', why: this.err };
    if (this.ended) return { out: 'error', why: 'ended at once' };
    if (!this.flow) return { out: 'error', why: 'said nothing in ' + Math.round(ms / 1000) + ' s' };
    return { out: this.flow.verdict, why: this.flow };
};
DirectRoute.prototype.play = async function (file, info) {
    this.info = info || {};
    // (our source connected by the audio manager, as an iDrive 7 play does: once for all the devices tried in a row)
    if (this.connect) { try { await this.s.amConnect(); } catch (e) { throw this.fail(e.short || errText(e)); } }
    this.flow = null; this.err = null; this.ended = false; this.opened = null; this.lastErr = null;
    this.spawn(file, 0);
    const v = await this.verdict(this.o.directStartMs || 8000);
    this.say('  ' + short(this.dev) + ': ' + (v.out === 'flows' ? 'takes the samples as time passes' : v.out === 'stalls' ? 'takes no samples (nothing plays it)' : v.out === 'fast' ? 'swallows the samples faster than time (nothing plays it)' : 'failed: ' + show(v.why, 160)) +
        (v.why && v.why.ratio !== undefined ? ' (' + v.why.ratio + ' of real time)' : ''));
    if (v.out !== 'flows') { this.kill(); throw this.fail(v.out === 'error' ? 'failed (' + show(v.why, 100) + ')' : 'is not played by the car (' + v.out + ')'); }
};
DirectRoute.prototype.activate = function () {
    this.active = true;
    setTimeout(() => { if (this.active && this.child) this.s.to('state', 'PLAYER_STATE_PLAY'); }, 30);
};
/* Another file on the open device, from ms of it (the whole file after the first seconds: it goes on where those were). */
DirectRoute.prototype.replay = async function (file, ms) {
    this.to('file ' + JSON.stringify(file) + (ms > 0 ? ' ' + Math.floor(ms) : ''));
    if (this.active) setTimeout(() => { if (this.active && this.child) this.s.to('state', 'PLAYER_STATE_PLAY'); }, 30);
};
/* STOP keeps the place; PLAY goes on there and says whether the device takes the samples again (false: it does not -
 * the car gave its sound to another source meanwhile, and our way has to be asked for anew). */
DirectRoute.prototype.button = async function (b) {
    if (b === 'STOP' || b === 'PAUSE') { this.to('pause'); return undefined; }
    if (b !== 'PLAY') return undefined;
    this.resumed = null;
    this.to('resume');
    const end = Date.now() + (this.o.directResumeMs || 3500);
    while (this.resumed === null && this.child && Date.now() < end && !this.s.cancelled) await sleep(40);
    return !!this.child && this.resumed !== false;
};
DirectRoute.prototype.seek = async function (ms) { this.to('seek ' + Math.max(0, Math.floor(ms))); };
DirectRoute.prototype.holds = true;      // stopped, it keeps its place and goes on there at PLAY
DirectRoute.prototype.kill = function () {
    const c = this.child;
    this.child = null;
    if (!c) return;
    try { c.stdin.write('quit\n'); c.stdin.end(); } catch (e) { /* gone */ }
    const t = setTimeout(() => { try { c.kill('SIGKILL'); } catch (e) { /* gone */ } }, 1200);
    c.on('exit', () => clearTimeout(t));
};
DirectRoute.prototype.release = async function () {
    this.active = false;
    this.kill();
};

/* ------------------------------------------------------------------ the dynamic player's focus, our own player */

/* Asking the car's dynamic player for the audio focus makes the car connect that player's source to the
 * loudspeakers; the router then reads that source's device whoever writes to it. Where the scan finds such a device
 * free, the service's own player writes there - and neither a playlist nor a file the car must read is needed. */
function FocusRoute(sound, dyn, dev) {
    this.s = sound;
    this.o = sound.o;
    this.dyn = dyn;
    this.dev = dev;
    this.direct = new DirectRoute(sound, dev, { connect: false });
    this.key = 'focus:' + dyn.inst + '|' + dev;
    this.name = 'the service\'s own player on "' + short(dev) + '" with the audio focus of ' + dyn.inst;
    this.direct.name = this.name;
    this.owns = false;       // it is the play's route: the focus is given back with it
}
FocusRoute.prototype.fail = function (shortly, e) { return this.direct.fail(shortly, e); };
FocusRoute.prototype.play = async function (file, info, hint) {
    await this.dyn.enter(hint && hint.key === this.key ? hint : null);
    await this.direct.play(file, info);
    this.focus = this.dyn.focus;
};
FocusRoute.prototype.activate = function () { this.owns = true; this.direct.activate(); };
FocusRoute.prototype.replay = function (file, ms) { return this.direct.replay(file, ms); };
FocusRoute.prototype.button = function (b) { return this.direct.button(b); };
FocusRoute.prototype.seek = function (ms) { return this.direct.seek(ms); };
FocusRoute.prototype.holds = true;
FocusRoute.prototype.release = async function () {
    await this.direct.release();
    if (this.owns) { this.owns = false; await this.dyn.release(); }
};

/* ------------------------------------------------------------------ the routes together */

function Sound(audio) {
    this.a = audio;
    this.o = audio.opts;
    this.h = audio.h;
    this.file = path.join(this.o.stateDir || path.dirname(this.o.audioConf || '/var/opt/jap-ridetube-d/state/audio.json'), 'sound.json');
    this.sdkFile = path.join(path.dirname(this.file), 'sdk.json');
    this.state = loadState(this.file, this.o.version || '?');
    this.save();
    this.expose = new Expose(this);
    try { this.expose.sweep(); } catch (e) { /* nothing left */ }
    this.heard = [];
    this.receivers = {};
    this.route = null;
    this.cancelled = false;
    this.runs = [];         // the last plays' stories: { at, file, lines, result }
    this.n = 0;
    this.refused = {};      // this play: the item forms an instance refused
    this.searched = 0;
    this.took = null;       // ... the form an instance took (and did not play)
    this.shown = {};        // ... the kinds of item the story has shown whole
    this.amId = null;       // the audio manager's connection of our source, while the service's own player is tried or plays
    this.scans = [];        // the last scans of the car's sound devices: { label, at, devs, map }
    this.others = [];       // the router's devices whose names say nothing (devices() fills it)
    this.sdk = readJson(this.sdkFile);
}
Sound.prototype.save = function () { return writeJson(this.file, this.state); };
Sound.prototype.trying = function (key) { this.state.trying = key; this.save(); };
Sound.prototype.tried = function (key, what) { this.state.tried[key] = what; this.state.trying = null; this.save(); };
Sound.prototype.count = function () { return ++this.n; };
/* The unit of a dynamic instance's time, once seen: kept with the way that plays, so the next play knows it at once. */
Sound.prototype.learnUnit = function (key, unit) {
    const k = this.state.kept;
    if (k && k.key === key && k.unit !== unit) { k.unit = unit; this.save(); }
};
Sound.prototype.say = function (t) {
    const run = this.runs[0];
    this.o.log('sound: ' + t);
    if (!run) return;
    const at = ((Date.now() - run.at) / 1000).toFixed(1);
    if (run.lines.length < 220) run.lines.push('+' + at + 's ' + String(t).slice(0, 700));
};
/* A handler of the daemon's (state, time, error), whatever it throws: a fault there must not end the play. */
Sound.prototype.to = function (k, v) {
    try { this.h[k](v); } catch (e) { this.o.log('sound: the daemon\'s ' + k + ' handler: ' + (e && e.stack || e)); }
};
Sound.prototype.note = function (t) { if (this.h.note) { try { this.h.note(t); } catch (e) { /* the app's page only */ } } };
/* What BMW's own code on this car says of the player (sdkread.js), read once per bundle and kept (state/sdk.json). */
Sound.prototype.readSdk = async function () {
    if (this.o.sdkRead === false) return;
    const have = this.sdk;
    // read again when it failed over a day ago, or by another version of this service
    if (have && have.ver === (this.o.version || '?') && (have.ok || Date.now() - (have.at || 0) < 86400000)) {
        let st = null;
        try { st = have.file && fs.statSync(have.file); } catch (e) { st = null; }
        if (!have.ok || !have.file || (st && st.size + ':' + Math.floor(st.mtime.getTime() / 1000) === have.stamp)) return;
    }
    this.note('Reading how the car\'s own apps play...');
    this.say('reading BMW\'s own player code among the installed apps');
    const ids = this.o.noSetuid ? {} : { uid: this.o.sdkUid === undefined ? 65534 : this.o.sdkUid, gid: this.o.sdkGid === undefined ? 65534 : this.o.sdkGid };
    let r;
    try { r = await sdkread.read(Object.assign({ oapRoot: this.o.oapRoot, prefer: this.o.codeHomes || [], gapMs: this.o.sdkGapMs, logIds: (home) => this.logIds(home) }, ids, this.o.sdkOpts || {})); } catch (e) { r = { ok: false, error: errText(e) }; }
    r.at = Date.now();
    r.ver = this.o.version || '?';
    this.sdk = r;
    writeJson(this.sdkFile, r);
    this.facts = null;
    const f = this.sdkFacts();
    const types = r.statics && Object.keys(r.statics).filter((k) => /ItemType/i.test(k))[0];
    this.say(r.ok ? 'read from ' + r.file + ': the item as BMW\'s code writes it: ' + sdkread.show(r.item) + (f.item ? '' : ' (not usable as it is)') +
        ' | its id\'s type per instance: ' + (types ? sdkread.show(r.statics[types]) : 'not found') + ' | started by: ' + (f.start || 'not found')
        : 'not read: ' + r.error);
};
/* The numbers an app's item ids could carry (BMW's code makes one of the app's logging id: "OA15" -> 0xA15; ours
 * is not of that kind), the likeliest first: ours made like one of BMW's apps, that of the app whose code was read,
 * the low bytes alone, none. [{ key, n }], n null for "not a number" (what BMW's code would make of our id). */
Sound.prototype.logIds = function (donor) {
    const ours = appLoggingId(this.expose.appHome()), theirs = logNum(appLoggingId(donor && path.join(this.o.oapRoot || '/var/opt/public/oap', donor)));
    let mine = logNum(ours);
    if (mine === null) { const low = parseInt(String(ours || '').slice(-2), 16); mine = 0xA00 + (low >= 0 && low < 256 ? low : 0xF0); }
    const out = [{ key: 'ours', n: mine }];
    const add = (key, n) => { if (!out.some((x) => x.n === n)) out.push({ key: key, n: n }); };
    if (theirs !== null) add('theirs', theirs);
    add('ours-low', mine & 255);
    if (theirs !== null) add('theirs-low', theirs & 255);
    add('none', null);
    return out;
};
/* BMW's item for our file with each id an app could give it on this player instance: [{ key, family, id, name,
 * make }]. The ids are made by BMW's own generateItemId where its type per instance could be read (sdkread's ids);
 * else the template's id is written here with the types 1 to 6. Each use counts the id's last two bytes on. */
Sound.prototype.idForms = function (inst) {
    const r = this.sdk, out = [], seen = {};
    if (!r || !r.ok) return out;
    const norm = (x) => String(x || '').replace(/^DynamicMediaPlayer/, '').replace(/^Entertainment/, '').replace(/Media$/, '').toLowerCase();
    const add = (key, tpl) => {
        const id = Array.isArray(tpl) && tpl[0] && tpl[0].id;
        if (!Buffer.isBuffer(id) || id.length !== 4) return;
        const hex = id.slice(0, 2).toString('hex').toUpperCase() + 'xxxx';
        if (seen[hex]) return;
        seen[hex] = true;
        out.push({ key: 'sdk:' + key, family: 'sdk', id: hex, name: 'BMW\'s item, id ' + hex, make: (value, size) => {
            const to = Buffer.from(id);
            this.idCount = ((this.idCount || 0) + 1) & 0xffff;
            to.writeUInt16BE(this.idCount, 2);
            return swap(fill(tpl, value, size), id, to);
        } });
    };
    const usable = (x) => x && !x.error && Array.isArray(x.out) && x.out.length === 1 && !sdkread.hasStub(x.out) && JSON.stringify(x.out).indexOf(sdkread.SAMPLE.file) >= 0;
    const recs = (r.ids || []).filter(usable), typed = recs.filter((x) => x.inst !== null);
    typed.filter((x) => norm(x.inst) === norm(inst)).forEach((x) => add(x.log, sdkread.decode(x.out)));
    if (!out.length) {
        // (no type per instance to be read: the id written here, its type tried through)
        const tpl = this.sdkFacts().item, id = Array.isArray(tpl) && tpl[0] && tpl[0].id;
        if (Buffer.isBuffer(id) && id.length === 4) {
            const num = this.logIds(null)[0].n;
            [1, 2, 3, 4, 5, 6].forEach((t) => add('ours.' + t, swap(tpl, id, itemId(num, t, 0))));
            recs.filter((x) => x.inst === null).forEach((x) => add(x.log, sdkread.decode(x.out)));
        }
    }
    return out;
};
/* Which of the car's media programs has this file open now: its name, null (none of them), undefined (they were
 * not found: nothing can be said). */
Sound.prototype.readers = function (p) {
    const proc = this.o.procDir || '/proc';
    let pids, real = p, found = 0;
    try { pids = fs.readdirSync(proc).filter((n) => /^\d+$/.test(n)); } catch (e) { return undefined; }
    try { real = fs.realpathSync(p); } catch (e) { /* as given */ }
    for (const pid of pids) {
        let comm, fds;
        try { comm = fs.readFileSync(path.join(proc, pid, 'comm'), 'utf8').trim(); } catch (e) { continue; }
        if (!/^(mediaengine|mediaapp)/i.test(comm)) continue;
        found++;
        try { fds = fs.readdirSync(path.join(proc, pid, 'fd')); } catch (e) { continue; }
        for (const fd of fds) {
            let t;
            try { t = fs.readlinkSync(path.join(proc, pid, 'fd', fd)); } catch (e) { continue; }
            if (t === p || t === real) return comm;
        }
    }
    return found ? null : undefined;
};
/* What is used of it: { item (decoded, no stand-in inside), hb, beatMs, start }. */
Sound.prototype.sdkFacts = function () {
    if (this.facts) return this.facts;
    const r = this.sdk, f = this.facts = {};
    if (!r || !r.ok) return f;
    try {
        const list = Array.isArray(r.item) && r.item.length === 1 && !sdkread.hasStub(r.item) ? r.item : null;
        // (else the playlist its createPlaylist handed to the proxy, when that one is whole)
        const call = (r.calls || []).filter((c) => c.method === 'createPlaylist' && c.args && Array.isArray(c.args.newPlaylist) && c.args.newPlaylist.length === 1 && !sdkread.hasStub(c.args.newPlaylist))[0];
        const enc = list || (call && call.args.newPlaylist);
        if (enc && JSON.stringify(enc).indexOf(sdkread.SAMPLE.file) >= 0) f.item = sdkread.decode(enc);
        const asks = (r.calls || []).filter((c) => c.method === 'getAudioFocus' && c.args && typeof c.args === 'object');
        const focus = asks.filter((c) => typeof c.args.timeOutHeartBeatTimer === 'number')[0];
        if (focus) f.hb = focus.args.timeOutHeartBeatTimer;
        // (a name it passes as a plain word is tried as it is; one it takes from the app is seen on the page)
        const plain = (v) => typeof v === 'string' && /^[\w.@\/ -]{1,80}$/.test(v) && !/^RT/.test(v);
        f.clientIds = uniq(asks.map((c) => c.args.clientId).filter(plain));
        f.clientName = asks.map((c) => c.args.clientName).filter(plain)[0];
        const iv = (r.timers || []).filter((t) => t.kind === 'interval' && /heartBeat/i.test(String(t.fn)) && t.ms >= 100)[0];
        if (iv) f.beatMs = iv.ms;
        // (its playFile as the class made like an app's ran it, where that got as far as the playlist; else the bare one)
        const made = (r.calls || []).filter((c) => /^constructed: playFile\(/.test(String(c.in)));
        const pf = made.some((c) => c.method === 'createPlaylist') ? made : (r.calls || []).filter((c) => /^playFile\(/.test(String(c.in)));
        const i = pf.map((c) => c.method).indexOf('createPlaylist');
        if (i >= 0) {
            const next = pf.slice(i + 1).map((c) => c.method);
            // what it asks of the player after its playlist, each with whole arguments: asked the same way first
            // (only what can start a list: nothing that gives the focus back or writes another list)
            const after = [];
            for (const c of pf.slice(i + 1)) {
                if (c.method === 'heartBeat') continue;
                if (START_CALLS.indexOf(c.method) < 0 || after.length >= 6) break;
                after.push(c);
            }
            if (after.length && after.every((c) => c.args && typeof c.args === 'object' && !Array.isArray(c.args) && !sdkread.hasStub(c.args))) f.startCalls = after.map((c) => ({ method: c.method, args: sdkread.decode(c.args) }));
            f.start = next.indexOf('setCurrentItemPositionAndTime') >= 0 ? 'pos' : next.indexOf('sendButtonEventDirect') >= 0 ? 'play' : next.indexOf('setAutoplay') >= 0 ? 'autoplay' : 'auto';
        }
    } catch (e) { this.o.log('sound: BMW\'s code as read is not usable: ' + errText(e)); }
    return f;
};
/* The names the focus is asked under, in order: our app's id, its title, what the app manager calls our app (its
 * home's name and number) - and last, where the player takes none of ours, the name of the BMW app whose code was
 * read: whether it knows only its own apps is then on the page. */
Sound.prototype.clientIds = function () {
    if (this.ids) return this.ids;
    const ids = [this.o.dynClientId || 'jap_ridetube8', 'RideTube'];
    try {
        const home = this.expose.appHome();
        if (home) { ids.push(path.basename(home)); ids.push(path.basename(home).replace(/^oap_/, '')); }
        const f = this.sdk && this.sdk.file, m = f ? /^(.*\/oap_\d+)\//.exec(f) : null;
        const pkg = m ? readJson(path.join(m[1], 'source', 'package.json')) : null;
        if (pkg && typeof pkg.name === 'string' && /^[\w.@\/-]{2,80}$/.test(pkg.name)) ids.push(pkg.name);
    } catch (e) { /* the two of ours */ }
    this.ids = uniq(ids);
    return this.ids;
};
/* The ways a playlist item is written: BMW's own first (when read), then the likely ones. */
Sound.prototype.forms = function () {
    const out = [], t = this.sdkFacts().item;
    if (t) {
        out.push({ key: 'sdk', name: 'as BMW\'s own code writes it', make: (value, size) => fill(t, value, size) });
    }
    const bytes = (b) => b, arr = (b) => Array.prototype.slice.call(b);
    const mk = (str, num, idf, withSize) => (value, size, id) => [{ pos: 1, id: idf(id), metadata: [{ key: 'FILE_NAME', value: str(value) }].concat(withSize && size ? [{ key: 'FILE_SIZE', value: num(size) }] : []) }];
    const named = [(v) => ({ stringValue: v }), (v) => ({ numeric: v })], plain = [(v) => v, (v) => v];
    const typed = [(v) => ({ type: 'stringValue', value: v }), (v) => ({ type: 'numeric', value: v })];
    out.push({ key: 'wb', name: 'named values, id a Buffer', make: mk(named[0], named[1], bytes, true) });
    out.push({ key: 'wa', name: 'named values, id an array', make: mk(named[0], named[1], arr, true) });
    out.push({ key: 'wb1', name: 'named values, the name only, id a Buffer', make: mk(named[0], named[1], bytes, false) });
    out.push({ key: 'pb', name: 'plain values, id a Buffer', make: mk(plain[0], plain[1], bytes, true) });
    out.push({ key: 'pa', name: 'plain values, id an array', make: mk(plain[0], plain[1], arr, true) });
    out.push({ key: 'tb', name: 'typed values, id a Buffer', make: mk(typed[0], typed[1], bytes, true) });
    return out;
};
/* The places our file is said to be in. */
Sound.prototype.locs = function () {
    const ex = this.expose;
    const readable = (file) => { try { fs.chmodSync(file, 0o644); } catch (e) { /* as it is */ } return file; };
    const memo = {};
    const once = (k, fn) => (file) => { const id = k + '|' + file; if (!memo[id]) memo[id] = Promise.resolve().then(() => fn(file)); return memo[id]; };
    const pub = once('pub', (f) => ex.pub(readable(f)));
    return [
        { key: 'path', name: 'where the file is', value: async (f) => readable(f) },
        { key: 'pub', name: 'a copy in our app\'s data folder', value: pub },
        { key: 'oe', name: 'a copy in the car\'s store for online media', value: once('oe', (f) => ex.store(readable(f))) },
        { key: 'url', name: 'file:// and its path', value: async (f) => 'file://' + readable(f) },
        { key: 'run', name: 'a copy under /run', value: once('run', (f) => ex.run(readable(f))) },
        { key: 'http', name: 'http://127.0.0.1 from this service', value: once('http', (f) => ex.http(readable(f))) },
        { key: 'puburl', name: 'file:// and the copy in our app\'s data folder', value: async (f) => 'file://' + await pub(f) },
    ];
};
/* ytalsa.py with these arguments, its one JSON answer (never rejects: { error } instead). */
Sound.prototype.alsa = function (args, ms) {
    const o = this.o, cmd = o.alsaCmd || ['/var/opt/mgu-python/current/bin/python3', '-I', path.join(__dirname, 'ytalsa.py')];
    return new Promise((resolve) => {
        let so = '', se = '', child, done = false;
        const end = (v) => { if (!done) { done = true; clearTimeout(t); resolve(v); } };
        // (what Python itself says when it cannot run the file - a module the car's build lacks - is the answer then)
        const why = () => { const l = se.trim().split('\n').pop().trim(); return l ? ': ' + l.slice(0, 200) : ''; };
        const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) { /* gone */ } end({ error: 'no answer in ' + Math.round(ms / 1000) + ' s' }); }, ms);
        try { child = cp.spawn(cmd[0], cmd.slice(1).concat(args), { cwd: '/', env: o.alsaEnv || {}, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { end({ error: e.message }); return; }
        child.stdout.on('data', (d) => { if (so.length < (1 << 20)) so += d; });
        child.stderr.on('data', (d) => { se = (se + d).slice(-2000); });
        child.on('error', (e) => end({ error: e.message }));
        child.on('close', (code) => { let v = null; try { v = JSON.parse(so); } catch (e) { v = null; } end(v && typeof v === 'object' ? v : { error: 'it ended (' + code + ') without an answer' + why() }); });
    });
};
/* The devices of the car's audio router worth a try, the likeliest first: read from the car's files by ytalsa.py
 * (nothing is opened), kept for the next plays. Those another program has open are named and left alone. */
Sound.prototype.devices = async function () {
    const o = this.o;
    if (o.direct === false) return [];
    if (this.devs) return this.devs;
    const cmd = o.alsaCmd || ['/var/opt/mgu-python/current/bin/python3', '-I', path.join(__dirname, 'ytalsa.py')];
    const dec = o.ytaud || path.join(__dirname, 'ytaud');
    if (!fs.existsSync(cmd[0]) || !fs.existsSync(dec)) { this.say('the service\'s own player is not installed (' + (!fs.existsSync(cmd[0]) ? cmd[0] : dec) + ')'); this.devs = []; this.others = []; return this.devs; }
    const res = await this.alsa(['probe'].concat(o.alsaProbeArgs || []), o.probeDevMs || 20000);
    this.probe = res;
    const all = (res.devices || []).filter((d) => d && typeof d.name === 'string');
    const free = all.filter((d) => !d.held);
    this.say('the car\'s sound devices named like ours: ' + (res.error ? 'not read: ' + res.error : (free.map((d) => short(d.name)).join(', ') || 'none')) +
        (all.length > free.length ? ' | another program has: ' + all.filter((d) => d.held).map((d) => short(d.name) + ' (' + d.held + ')').join(', ') : ''));
    this.devs = free.map((d) => d.name);
    // (the router's devices whose names say nothing: listened to only when none of those above plays)
    this.others = (res.others || []).filter((n) => typeof n === 'string' && this.devs.indexOf(n) < 0);
    return this.devs;
};
/* Silence to all of these devices at once, for a second or two: which of them the car takes samples from as time
 * passes at the end of that - that is, which are connected to a loudspeaker now.
 * { name: { open, verdict, ratio, late, error } }. */
Sound.prototype.scan = async function (devs, label, ms) {
    const o = this.o;
    this.note('Listening to which of the car\'s sound devices plays...');
    const res = await this.alsa(['scan', '--devices', JSON.stringify(devs), '--ms', String(ms)].concat(o.alsaScanArgs || []), ms + 15000);
    const map = {};
    (res.devices || []).forEach((d) => { if (d && typeof d.name === 'string') map[d.name] = d; });
    this.scans = this.scans.filter((x) => x.label !== label);
    this.scans.push({ label: label, at: Date.now(), error: res.error, devs: devs.slice(), map: map });
    if (this.scans.length > 8) this.scans.shift();
    this.say('the devices ' + label + ': ' + (res.error ? 'not scanned: ' + res.error : scanText(devs, map)));
    return map;
};
/* The devices of a scan that take samples as time passes: first those that did not before (they are what changed),
 * then the others; those the driver heard nothing through are left out by the caller. */
Sound.prototype.flowing = function (map, base) {
    const names = Object.keys(map).filter((n) => map[n].open && map[n].verdict === 'flows');
    const was = (n) => !!(base && base[n] && base[n].open && base[n].verdict === 'flows');
    return names.filter((n) => !was(n)).concat(names.filter(was));
};
/* The dynamic player's instances that are routes: those the car has for the entertainment. */
Sound.prototype.dynInsts = function () {
    const y = this.a.dyn;
    if (this.o.dynamic === false || !y || !y.file) return [];
    const insts = instancesOf(y.cfg) || [];
    return DYN_INSTS.map((re) => insts.filter((n) => re.test(n))[0]).filter(Boolean);
};
/* Whether there is any route to try at all (else iDrive 7's way stays, with its own error). */
Sound.prototype.any = function () {
    if (this.dynInsts().length) return true;
    if (this.o.direct === false) return false;
    const cmd = this.o.alsaCmd || [];
    return !!cmd[0] && fs.existsSync(cmd[0]) && fs.existsSync(this.o.ytaud || path.join(__dirname, 'ytaud'));
};
/* The audio manager connects our source (as iDrive 7's play does) for the service's own player; the connection is
 * kept from one device tried to the next and given back when none plays or the play ends. */
Sound.prototype.amConnect = async function () {
    if (this.amId !== null && this.amId !== undefined) return;
    const a = this.a;
    let r;
    try { r = await withTimeout(Promise.resolve().then(() => a.cc.callMethod('connect', { sourceID: a.src, sinkID: a.sink }, 5000)), 6500, 'connect'); } catch (e) {
        const x = new Error('could not connect its source: ' + errText(e));
        x.short = 'could not connect its source: ' + errText(e);
        throw x;
    }
    this.say('audio manager: connect ' + a.src + '>' + a.sink + ' -> ' + show(r));
    if (!r || (r.amError !== 'E_OK' && r.amError !== 'E_ALREADY_EXISTS')) { const x = new Error('was refused by the audio manager (' + (r && r.amError) + ')'); x.short = x.message; throw x; }
    this.amId = r.mainConnectionID === undefined || r.mainConnectionID === null ? -1 : r.mainConnectionID;
};
Sound.prototype.amDisconnect = async function () {
    const id = this.amId, a = this.a;
    this.amId = null;
    if (id === null || id === undefined) return;
    try {
        if (id === -1) throw new Error('no connection id');
        this.o.log('disconnect ' + show(await withTimeout(Promise.resolve().then(() => a.cc.callMethod('disconnect', { mainConnectionID: id }, 5000)), 6500, 'disconnect')));
    } catch (e) {
        this.o.log('disconnect failed: ' + errText(e) + '; sweeping source ' + a.src);
        await a.dropLeftovers().catch((e2) => this.o.log('sweep failed: ' + errText(e2)));
    }
};
/* A play: the kept way first; then the quick ways (the service's own player on a device the car plays - with our
 * source connected by the audio manager, then with each dynamic player's focus); then each dynamic player's playlist
 * in every form. Until one plays. */
Sound.prototype.play = async function (file, info) {
    this.cancelled = false;
    this.n = 0;
    this.refused = {};
    this.searched = 0;
    this.took = null;
    this.shown = {};
    const run = { at: Date.now(), file: path.basename(file), lines: [], result: null };
    this.lastFile = file;
    this.runs.unshift(run);
    if (this.runs.length > 3) this.runs.length = 3;
    const st = this.state, errors = [];
    const tryRoute = async (r) => {
        this.route = r;
        try {
            await r.play(file, info, st.kept);
            if (this.cancelled) throw r.fail('was stopped');
            r.activate();
            st.kept = Object.assign({ key: r.key, at: Date.now(), plays: st.kept && st.kept.key === r.key ? (st.kept.plays || 0) + 1 : 1 },
                r.combo || {}, r.focus || {}, r.unit ? { unit: r.unit } : {});
            this.save();
            run.result = 'plays through ' + r.name;
            this.say('PLAYS through ' + r.name);
            return true;
        } catch (e) {
            errors.push(e.short ? r.name + ' ' + e.short : errText(e));
            this.say('NOT through ' + r.name + ': ' + (e.short || errText(e)));
            this.route = null;
            try { await r.release(); } catch (e2) { this.o.log('sound: release failed: ' + errText(e2)); }
            if (st.kept && st.kept.key === r.key) { st.kept = null; this.save(); }
            return false;
        }
    };
    const own = this.o.direct !== false;
    const playing = (d) => this.route === d || (this.route instanceof FocusRoute && this.route.dyn === d);
    try {
        const insts = this.dynInsts();
        // the way kept from the last play that worked
        const k = st.kept;
        let m;
        if (k && !st.silent[k.key]) {
            if ((m = /^direct:(.+)$/.exec(k.key))) {
                if (own) { if (await tryRoute(new DirectRoute(this, m[1]))) return; await this.amDisconnect(); }
            } else if ((m = /^focus:([^|]+)\|(.+)$/.exec(k.key))) {
                if (own && insts.indexOf(m[1]) >= 0) {
                    const d = new DynRoute(this, m[1]);
                    try { if (await tryRoute(new FocusRoute(this, d, m[2]))) return; } finally { if (!playing(d)) await d.release(); }
                }
            } else if ((m = /^dyn:(.+)$/.exec(k.key)) && insts.indexOf(m[1]) >= 0) {
                if (await tryRoute(new DynRoute(this, m[1]))) return;
            }
        }
        // the service's own player, our source connected by the audio manager as on iDrive 7: the devices are
        // listened to as the car is, then with the connection - one that takes samples only now is ours. Where none
        // of the devices named like ours does, the router's other free devices are listened to as well
        const devs = this.cancelled || !own ? [] : await this.devices();
        const others = own ? this.others : [];
        const ms = this.o.scanMs || 2500;
        let base = null, withAm = {};
        if ((devs.length || others.length) && !this.cancelled) {
            if (devs.length) base = await this.scan(devs, 'as the car is', this.o.scanBaseMs || 1200);
            let on = false;
            try { await this.amConnect(); on = true; } catch (e) { this.say('our source was not connected: ' + (e.short || errText(e))); }
            if (on && !this.cancelled) {
                await sleep(this.o.amSettleMs === undefined ? 700 : this.o.amSettleMs);
                if (devs.length) withAm = await this.scan(devs, 'with our source connected by the audio manager', ms);
                let flows = this.flowing(withAm, base);
                if (!flows.some((dev) => !st.silent['direct:' + dev]) && others.length && !this.cancelled) {
                    const more = await this.scan(others, '(the router\'s other ones) with our source connected', ms);
                    withAm = Object.assign({}, withAm, more);
                    flows = flows.concat(this.flowing(more, null));
                }
                for (const dev of flows) {
                    if (this.cancelled) break;
                    if (st.silent['direct:' + dev]) { this.say('direct:' + short(dev) + ' left out: it played without sound'); continue; }
                    this.note('Finding how this car plays sound: way ' + this.count() + '...');
                    if (await tryRoute(new DirectRoute(this, dev))) return;
                }
            }
            await this.amDisconnect();
        }
        // the car's dynamic player. First the quick way on each instance: its audio focus, then our own player where
        // a device then takes samples
        const order = k && /^dyn:/.test(k.key) && insts.indexOf(k.key.slice(4)) >= 0 ? uniq([k.key.slice(4)].concat(insts)) : insts;
        if (!this.cancelled && order.length) await this.readSdk();
        const noFocus = {};
        // (a device that took samples with our own source connected too, and was not heard then, takes them whatever
        // is connected: it is not this player's)
        const always = (dev) => !!(st.silent['direct:' + dev] && withAm[dev] && withAm[dev].open && withAm[dev].verdict === 'flows');
        for (const inst of devs.length || others.length ? order : []) {
            if (this.cancelled) break;
            const d = new DynRoute(this, inst);
            try {
                try { await d.enter(null); } catch (e) {
                    noFocus[inst] = true;
                    errors.push(e.short ? d.name + ' ' + e.short : errText(e));
                    this.say('NOT through ' + d.name + ': ' + (e.short || errText(e)));
                    continue;
                }
                if (this.cancelled) continue;
                const usable = (dev) => !st.silent['focus:' + inst + '|' + dev] && !always(dev);
                let flows = devs.length ? this.flowing(await this.scan(devs, 'with the audio focus of ' + inst, ms), base) : [];
                if (!flows.some(usable) && others.length && !this.cancelled) flows = flows.concat(this.flowing(await this.scan(others, '(the router\'s other ones) with the audio focus of ' + inst, ms), null));
                for (const dev of flows) {
                    if (this.cancelled) break;
                    const r = new FocusRoute(this, d, dev);
                    if (!usable(dev)) { this.say(r.key.replace('plug:smartx:', '') + ' left out: ' + (always(dev) ? 'that device takes samples whatever is connected, and was not heard' : 'it played without sound')); continue; }
                    this.note('Finding how this car plays sound: way ' + this.count() + '...');
                    if (await tryRoute(r)) return;
                }
            } finally { if (!playing(d)) { try { await d.release(); } catch (e) { this.o.log('sound: release failed: ' + errText(e)); } } }
        }
        // then the long way: each instance's playlist with our file, in every form
        for (const inst of order) {
            if (this.cancelled) break;
            if (noFocus[inst]) continue;       // (it gave no focus a moment ago)
            if (st.silent['dyn:' + inst]) { this.say('dyn:' + inst + ' left out: it played without sound'); continue; }
            if (await tryRoute(new DynRoute(this, inst))) return;
        }
        run.result = this.cancelled ? 'stopped' : 'nothing played';
    } finally {
        if (!this.route) { this.expose.clear(); await this.amDisconnect(); }
        this.keepStory(run);
    }
    const silent = Object.keys(st.silent).length;
    const e = new Error(this.cancelled ? 'stopped' : 'no way to play sound on this car has worked yet (' + errors.length + ' tried' + (silent ? ', ' + silent + ' without sound' : '') + ') - Settings > Diagnostics shows what the car answered');
    e.tried = errors;
    throw e;
};
/* A play's whole story appended to <logDir>/sound.log (started anew past 400 kB): the page shows a long one cut. */
Sound.prototype.keepStory = function (run) {
    if (!this.o.logDir) return;
    const f = path.join(this.o.logDir, 'sound.log');
    try {
        let big = false;
        try { big = fs.statSync(f).size > 400000; } catch (e) { /* not there yet */ }
        const text = new Date(run.at).toISOString() + ' ' + run.file + ' | ' + (run.result || 'no result') + '\n' + run.lines.join('\n') + '\n\n';
        if (big) fs.writeFileSync(f, text); else fs.appendFileSync(f, text);
    } catch (e) { /* the page still has it */ }
};
Sound.prototype.replay = function (file, ms) { return this.route ? this.route.replay(file, ms) : Promise.reject(new Error('no sound route')); };
Sound.prototype.button = function (b) { return this.route ? this.route.button(b) : Promise.resolve(); };
Sound.prototype.seek = function (ms) { return this.route ? this.route.seek(ms) : Promise.resolve(); };
Sound.prototype.cancel = function () { this.cancelled = true; };
/* Whether the route that plays keeps its place while stopped (the service's own player, as long as it runs). */
Sound.prototype.holds = function () {
    const r = this.route, player = r && (r.direct || r);
    return !!(r && r.holds && player.child);
};
Sound.prototype.release = async function () {
    const r = this.route;
    this.route = null;
    if (r) {
        if (r.button && r instanceof DynRoute && r.token) await r.button('STOP');
        try { await r.release(); } catch (e) { this.o.log('sound: release failed: ' + errText(e)); }
    }
    await this.amDisconnect();
    this.expose.clear();
};
/* The driver hears nothing through the route that plays: it is left out from now on. Returns its name, or null. */
Sound.prototype.nosound = function () {
    const r = this.route;
    if (!r) return null;
    this.state.silent[r.key] = Date.now();
    if (this.state.kept && this.state.kept.key === r.key) this.state.kept = null;
    this.save();
    this.say('the driver hears nothing through ' + r.name + ': left out from now on');
    return r.name;
};
/* Start over: nothing kept, nothing left out. */
Sound.prototype.reset = function () {
    this.state.silent = {}; this.state.tried = {}; this.state.skip = {}; this.state.kept = null;
    this.devs = null;
    this.others = [];
    this.scans = [];
    this.save();
};
Sound.prototype.status = function () {
    const st = this.state, r = this.route;
    return { route: r ? r.key : null, name: r ? r.name : null, kept: st.kept ? st.kept.key : null, silent: Object.keys(st.silent).length };
};
/* The Diagnostics page's lines: what plays or what was tried, the last play's story, BMW's code as read. */
Sound.prototype.lines = function () {
    const st = this.state, out = [];
    const k = st.kept;
    out.push(k ? 'Kept from the last play that worked: ' + k.key + (k.form ? ' | item ' + k.form + ' | file ' + k.loc + ' | start ' + k.start : '') + (k.hb !== undefined ? ' | focus ' + k.clientId + ', timer ' + k.hb : '') + (k.unit ? ' | time in ' + k.unit : '') + ' | ' + (k.plays || 1) + ' plays'
        : 'No way to play sound is known for this car yet: a play tries them all.');
    const silent = Object.keys(st.silent);
    if (silent.length) out.push('Played without sound (left out; Settings > "Sound: start over" tries them again): ' + silent.join(', '));
    const skip = Object.keys(st.skip);
    if (skip.length) out.push('Left out, the service stopped while trying: ' + skip.join(', '));
    this.runs.slice(0, 2).forEach((run, i) => {
        out.push((i ? 'The play before: ' : 'Last play: ') + run.file + ' | ' + (run.result || 'going on') + ' | ' + run.lines.length + ' lines');
        if (i) run.lines.filter((l) => /PLAYS|NOT through/.test(l)).slice(-8).forEach((l) => out.push(l));
        else if (run.lines.length <= 70) run.lines.forEach((l) => out.push(l));
        else {
            // (a long search: its start, where each route ended, its end - the service's log file has every line)
            const keep = {};
            run.lines.forEach((l, k) => { if (k < 40 || k >= run.lines.length - 14 || /PLAYS|NOT through|answers|getAudioFocus|the devices |sound devices|each id|could not be put|read from/.test(l)) keep[k] = true; });
            let gap = 0;
            run.lines.forEach((l, k) => {
                if (keep[k]) { if (gap) out.push('  ... ' + gap + ' more attempts like these (the log has them: ' + path.join(this.o.logDir || '', 'sound.log') + ')'); gap = 0; out.push(l); } else gap++;
            });
        }
    });
    if (!this.runs.length) {
        const tried = Object.keys(st.tried);
        if (tried.length) out.push('Tried before this start of the service: ' + tried.slice(0, 40).map((x) => x + ' = ' + st.tried[x]).join(' || '));
    }
    return out;
};
/* How BMW's own code plays a file, for the top of the page: the car gives us the focus and takes our playlist, and
 * its list stays empty - what is left to learn is here. What the class carries and makes of the app it runs in, the
 * ids it gives an item, its calls once made as an app makes it, then the text of the parts that decide: what starts
 * a playlist, how an item's id is made, where an app keeps the file it plays. */
Sound.prototype.playLines = function () {
    const out = [], r = this.sdk;
    if (!r) return ['BMW\'s own player code has not been looked for yet (a play does that).'];
    out.push('BMW\'s own player code: ' + (r.ok ? 'read from ' + r.file + ' (class ' + r.cls + ')' : 'NOT read: ' + r.error + (r.file ? ' (' + r.file + ')' : '')));
    const st = r.statics ? Object.keys(r.statics) : [];
    if (st.length) out.push('What the class carries: ' + st.map((k) => k + ' = ' + sdkread.show(r.statics[k]).slice(0, 300)).join(' | '));
    if (r.fields && Object.keys(r.fields).length) out.push('Made as an app makes it' + (r.states && r.states[0] ? ' (' + r.states[0][0] + ')' : '') + ': ' + Object.keys(r.fields).map((k) => k + ' = ' + sdkread.show(r.fields[k]).slice(0, 80)).join(' | '));
    const hex = (x) => { const it = Array.isArray(x.out) && x.out[0] && x.out[0].id; return x.error ? 'failed (' + String(x.error).slice(0, 50) + ')' : it && it.$ === 'buffer' ? String(it.hex).toUpperCase() : sdkread.show(x.n).slice(0, 30); };
    if (r.ids && r.ids.length) {
        const by = {};
        r.ids.forEach((x) => { const k = x.inst === null ? '(no instance)' : x.inst; (by[k] = by[k] || []).push(x.log + ' ' + hex(x)); });
        out.push('The ids its generateItemId gives (the number of the app: ' + this.logIds(r.file && (/(oap_\d+)\//.exec(r.file) || [])[1]).map((l) => l.key + ' ' + (l.n === null ? 'none' : '0x' + l.n.toString(16).toUpperCase())).join(', ') + '): ' +
            Object.keys(by).map((k) => k + ': ' + by[k].join(', ')).join(' | '));
    }
    const made = (r.calls || []).filter((c) => /^constructed/.test(String(c.in)));
    if (made.length) out.push('Its calls, made that way: ' + made.slice(0, 14).map((c) => '[' + String(c.in).replace(/^constructed: /, '') + '] ' + c.method + '(' + sdkread.show(c.args).slice(0, 300) + ')').join(' || '));
    // what it asks of anything else than the player once an item is set (its "sound property"), and which of the
    // car's interfaces has such a method
    const oth = r.other || [];
    if (oth.length) {
        out.push('What it asks beside the player (its "sound property"): ' + uniq(oth.map((c) => c.path + '(' + sdkread.show(c.args).slice(0, 260) + ')')).slice(0, 5).join(' || '));
        uniq(oth.map((c) => c.method).filter((m) => /^[A-Za-z_]\w{3,}$/.test(String(m)))).slice(0, 3).forEach((m) => {
            try { if (typeof this.a.ifacesWith === 'function') this.a.ifacesWith(m).forEach((l) => out.push('  ' + l)); } catch (e) { out.push('  ' + m + ': not looked up (' + errText(e) + ')'); }
        });
    }
    if (r.states) out.push('Its states against a simulated car: ' + r.states.map((x) => x[0] + ' = ' + x[1]).join(' | '));
    const notes = (r.notes || []).concat(Object.keys(r.failed || {}).slice(0, 6).map((id) => 'module ' + id + ' did not load: ' + r.failed[id]));
    if (notes.length) out.push('Notes of the reading: ' + notes.join(' || ').slice(0, 900));
    // the keys an item's metadata may have, from the player's description on the car
    try {
        const keys = [];
        const walk = (v, d) => {
            if (!v || typeof v !== 'object' || d > 9 || keys.length) return;
            const names = Array.isArray(v) ? v.map((x) => (x && typeof x === 'object' ? x.name : x)).filter((x) => typeof x === 'string') : Object.keys(v);
            if (names.indexOf('FILE_NAME') >= 0) { names.forEach((x) => keys.push(x)); return; }
            (Array.isArray(v) ? v : Object.keys(v).map((k) => v[k])).forEach((x) => walk(x, d + 1));
        };
        walk(this.a.dyn && this.a.dyn.cfg, 0);
        if (keys.length) out.push('The keys an item\'s metadata may have (the player\'s description): ' + keys.slice(0, 60).join(', '));
    } catch (e) { /* not this time */ }
    try {
        const m = r.file ? /^(.*\/oap_\d+)\//.exec(r.file) : null;
        out.push('Logging ids: that app\'s ' + (appLoggingId(m && m[1]) || 'not found') + ' | ours ' + (appLoggingId(this.expose.appHome()) || 'not found'));
    } catch (e) { /* not this time */ }
    (r.play || []).forEach((x) => out.push('[' + x.what + '] ' + String(x.text).slice(0, /starts the playlist/.test(x.what) ? 820 : 700)));
    // (the class's own methods that decide what the car is given after the focus)
    ['setPlaylist', 'playlistItemConverter', 'setSoundProperty', 'handleSinkNotification', 'waitForDecoder', 'setImageRequestProperty', 'sendResume', 'sendPause', 'sendButtonEvent', 'sendButtonPressAndRelease', 'startNewIfNoExistingPlayback', 'resetPlayback', 'connect'].forEach((n) => {
        if (r.methods && r.methods[n]) out.push('[' + n + '] ' + String(r.methods[n]).slice(0, n === 'playlistItemConverter' ? 900 : n === 'setPlaylist' || n === 'setSoundProperty' ? 650 : 420));
    });
    return out;
};
/* Where the car's media programs may read a file: who they run as, the store for online media their configuration
 * names (what is in it, who owns it), the folder the app whose code was read keeps its data in, and whether others
 * can reach the file we name. Names and modes only: nothing is opened. */
Sound.prototype.whereLines = function () {
    const out = [], proc = this.o.procDir || '/proc';
    const mode = (st) => (st.mode & 0o7777).toString(8) + ' ' + st.uid + ':' + st.gid;
    const ls = (dir, max) => {
        let names;
        try { names = fs.readdirSync(dir).sort(); } catch (e) { return 'not readable (' + (e.code || errText(e)) + ')'; }
        return (names.slice(0, max).map((n) => {
            let st, link = '';
            try { st = fs.lstatSync(path.join(dir, n)); } catch (e) { return n + ' (?)'; }
            if (st.isSymbolicLink()) { try { link = ' -> ' + fs.readlinkSync(path.join(dir, n)); } catch (e) { link = ' -> ?'; } }
            let inside = '';
            if (st.isDirectory()) { try { const sub = fs.readdirSync(path.join(dir, n)); inside = sub.length ? ' [' + sub.length + ': ' + sub.slice(0, 4).join(', ').slice(0, 90) + (sub.length > 4 ? ', ...' : '') + ']' : ' [empty]'; } catch (e) { inside = ' [not readable]'; } }
            return n.slice(0, 48) + (st.isDirectory() ? '/' : '') + link + ' (' + mode(st) + ')' + inside;
        }).join(' | ') || 'empty') + (names.length > max ? ' | +' + (names.length - max) + ' more' : '');
    };
    try {
        const who = [];
        fs.readdirSync(proc).filter((n) => /^\d+$/.test(n)).forEach((pid) => {
            let comm, status;
            try { comm = fs.readFileSync(path.join(proc, pid, 'comm'), 'utf8').trim(); } catch (e) { return; }
            if (!/^(mediaengine|mediaapp)/i.test(comm) || who.length >= 4) return;
            try { status = fs.readFileSync(path.join(proc, pid, 'status'), 'utf8'); } catch (e) { status = ''; }
            const f = (k) => { const m = new RegExp('^' + k + ':\\s*(.*)$', 'm').exec(status); return m ? m[1].trim().split(/\s+/) : []; };
            who.push(comm + ' (' + pid + '): user ' + (f('Uid')[1] || '?') + ', group ' + (f('Gid')[1] || '?') + ', more groups ' + (f('Groups').slice(0, 14).join(' ') || 'none'));
        });
        out.push('The car\'s media programs run as: ' + (who.join(' | ') || 'not found'));
    } catch (e) { out.push('The car\'s media programs: not readable'); }
    const root = this.o.oeDir || '/mnt/share/ent/oe';
    try { out.push('The car\'s store for online media ' + root + ' (' + mode(fs.statSync(root)) + '): ' + ls(root, 24)); } catch (e) {
        out.push('The car\'s store for online media ' + root + ': not there (' + (e.code || errText(e)) + ')');
        if (fs.existsSync(path.dirname(root))) out.push('  ' + path.dirname(root) + ': ' + ls(path.dirname(root), 16));
    }
    try {
        const mounts = fs.readFileSync(path.join(proc, 'mounts'), 'utf8').split('\n').filter((l) => /\s\/mnt\/share|\/oap(\s|\/)/.test(l)).slice(0, 8).map((l) => l.split(/\s+/).slice(0, 4).join(' ').slice(0, 150));
        if (mounts.length) out.push('Mounted there: ' + mounts.join(' | '));
    } catch (e) { /* none readable */ }
    try {
        const m = this.sdk && this.sdk.file ? /^(.*\/oap_\d+)\//.exec(this.sdk.file) : null;
        if (m) out.push('The folder of the app whose code was read, ' + m[1] + ': ' + ls(m[1], 12) + ' || its data: ' + ls(path.join(m[1], 'data'), 16));
        const home = this.expose.appHome();
        if (home) out.push('Our app\'s folder ' + home + ': ' + ls(home, 12));
    } catch (e) { /* not this time */ }
    if (this.lastFile) {
        try {
            const shut = [];
            for (let d = path.dirname(this.lastFile); d !== '/' && d !== '.'; d = path.dirname(d)) { const st = fs.statSync(d); if ((st.mode & 0o005) !== 0o005) shut.push(d + ' (' + mode(st) + ')'); }
            out.push('Our file ' + this.lastFile + ' (' + mode(fs.statSync(this.lastFile)) + ')' + (shut.length ? ' | folders on its way that other users cannot enter: ' + shut.join(', ') : ' | every folder on its way can be entered by other users'));
        } catch (e) { out.push('Our file ' + this.lastFile + ': gone by now'); }
    }
    return out;
};
/* How the car's programs are wired to its sound (ytalsa.py probe's "plumbing"), the telling parts first. */
Sound.prototype.plumbingLines = function () {
    const p = this.probe && this.probe.plumbing, out = [];
    if (!p) return out;
    const put = (title, list, max) => { if (list && list.length) out.push(title + ': ' + list.join(' | ').slice(0, max)); };
    put('Programs and the sound devices they have open (/dev/snd)', p.snd, 900);
    put('Programs and the router\'s buffers they have (/dev/shm)', p.maps, 1300);
    put('The kernel\'s sound streams in use', p.used, 900);
    put('The media engine\'s configuration about its sound output', p.words, 2600);
    put('Sound devices the ALSA configuration defines', p.pcms, 1100);
    put('Sound cards', (p.cards || []).concat(p.pcm || []), 900);
    put('The sound programs and their libraries', p.libs, 1300);
    put('Every buffer in /dev/shm', p.shm, 1500);
    put('Configuration files', p.files, 500);
    return out;
};
/* The rest of what was read of BMW's code (the whole page only): its calls, its methods' text. */
Sound.prototype.codeLines = function () {
    const out = [], r = this.sdk;
    if (!r) return out;
    if (r.calls && r.calls.length) out.push('Its calls of the player: ' + r.calls.slice(0, 30).map((c) => '[' + c.in + '] ' + c.method + '(' + sdkread.show(c.args).slice(0, 330) + ')').join(' || '));
    if (r.timers && r.timers.length) out.push('Its timers: ' + r.timers.slice(0, 12).map((t) => t.kind + ' ' + t.ms + ' ms [' + t.in + '] ' + t.fn).join(' || '));
    if (r.methodNames) out.push('Its methods: ' + r.methodNames.join(', '));
    Object.keys(r.methods || {}).forEach((n) => out.push('[' + n + '] ' + r.methods[n]));
    (r.near || []).forEach((x) => out.push('[near ' + x.what + '] ' + x.text));
    return out;
};
/* The car's sound devices: what was listened to and what took samples, then the router's own lists. */
Sound.prototype.deviceLines = function () {
    const out = [];
    // (a listening the last play's story above already tells is not said twice)
    const told = this.runs[0] ? this.runs[0].lines.join('\n') : '';
    this.scans.forEach((x) => { if (told.indexOf('the devices ' + x.label + ':') < 0) out.push('Listened ' + x.label + ': ' + (x.error ? 'not scanned: ' + x.error : scanText(x.devs, x.map))); });
    if (this.probe) {
        const p = this.probe;
        out.push('The audio router\'s devices named like ours: ' + (p.error ? 'not read: ' + p.error : (p.devices || []).map((d) => short(d.name) + (d.sure === 2 ? '' : d.sure === 1 ? ' (named in a configuration)' : ' (a name of the audio manager\'s)') +
            (d.held ? ' [open in ' + d.held + ']' : '')).join(' | ') || 'none found'));
        if (p.run && p.run.some((x) => x.indexOf(': ') > 0)) out.push('Devices a program has open now (/run/smartx): ' + p.run.filter((x) => x.indexOf(': ') > 0).slice(0, 60).join(' | '));
        if (p.shm && p.shm.length && !p.plumbing) out.push('All of the router\'s buffers (/dev/shm; _p plays, _c records): ' + uniq(p.shm.map((n) => String(n).replace(/^smartx_/, '').replace(/_ringbuffer$/, ''))).slice(0, 160).join(', '));
        if (p.map && p.map.length) out.push('Which player the car\'s configuration gives a device to (the names just before it): ' + p.map.slice(0, 40).join(' | '));
        if (p.conf && p.conf.length) out.push('Device names in the car\'s configuration: ' + p.conf.slice(0, 90).join(', '));
        if (p.notes && p.notes.length) out.push('Notes of the probe: ' + p.notes.slice(0, 8).join(' || '));
    }
    return out;
};

/* The instance names a description has (as ytd.js's instancesOf). */
function instancesOf(cfg) {
    const v = cfg && cfg.instances;
    if (Array.isArray(v)) return v.map((x) => (x && typeof x === 'object' ? String(x.name || x.instance || x.id || '') : String(x))).filter(Boolean);
    return v && typeof v === 'object' ? Object.keys(v) : null;
}

module.exports = { Sound: Sound, DynRoute: DynRoute, DirectRoute: DirectRoute, FocusRoute: FocusRoute, Expose: Expose, loadState: loadState, show: show, scanText: scanText };
