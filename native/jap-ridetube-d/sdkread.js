'use strict';
/**
 * sdkread.js - how BMW's own SDK asks the car's dynamic media player to play, read on the head unit.
 *
 * iDrive 8 apps play through the DynamicMediaPlayer (ytd.js, sound.js). Its interface description says which calls
 * there are, not how BMW's code fills them: how a playlist item's union value and byte buffer are written for the
 * SOME/IP binding, what getAudioFocus is given, how often the heartbeat goes. The apps installed on the car carry
 * that code (the SDK's MediaPlayerImpl inside each app's browserify bundle). This module finds such a bundle, and in
 * a child process without privileges (uid/gid nobody, no environment, a time limit) it
 *   - evaluates the bundle's module map without running the app (the way the MGU Store's linker reads a donor),
 *   - loads the player class with the bundle's own modules (anything outside the bundle - the SOME/IP binding, fs,
 *     the network - is a stand-in that only records what is asked of it),
 *   - runs the class's own playlistConverter / createPlaylist / playFile / connect against a recording stand-in of
 *     the player's proxy,
 * and returns as JSON: the item exactly as BMW's code writes it, the calls it made with their arguments, the timers
 * it set, and the text of the methods (for the Diagnostics page). Nothing of the car is called from here, and no
 * BMW code leaves the car except as those lines on the driver's own screen.
 *
 *   read({ oapRoot, prefer, uid, gid, timeoutMs, log }) -> Promise<{ ok, file, error, cls, item, calls, timers, methods, ... }>
 *   decode(v) / hasStub(v) / show(v)   the child's JSON values back as Buffers and typed arrays / whether a stand-in
 *                                       is inside / one line for a page
 *
 * Node 8 (the unit's /usr/bin/node). No dependency.
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const vm = require('vm');

// what the child is asked to convert: values no real file has, so the answer is a template (sound.js puts the real
// path and size in their place)
const SAMPLE = { file: '/rt-sample/audio-RTSAMPLE.m4a', size: 987654321 };
const NEEDLES = ['playlistConverter', 'createPlaylist'];
const DMP_METHODS = ['getAudioFocus', 'heartBeat', 'releaseAudioFocus', 'createPlaylist', 'addToPlaylist', 'updatePlaylist',
    'removeFromPlaylist', 'sendButtonEventDirect', 'setAutoplay', 'setCurrentItemPositionAndTime', 'setMuteState',
    'setPlaybackSpeed', 'setTime', 'configureButtonEventForwarding'];
const DMP_FIELDS = ['autoPlayStatus', 'connectionState', 'currentAudioFocus', 'currentItemId', 'currentItemMetadata', 'currentItemPath',
    'currentItemPosition', 'currentItemTime', 'forwardButtons', 'playerState', 'repeat', 'buttonEventForward', 'playbackErrorEvent'];

/* ------------------------------------------------------------------ the parent's side */

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function readText(file, max) {
    return new Promise((resolve) => {
        fs.stat(file, (e, st) => {
            if (e || !st.isFile() || st.size < 2000 || st.size > max) return resolve(null);
            return fs.readFile(file, 'utf8', (e2, t) => resolve(e2 ? null : t));
        });
    });
}
/* The first installed app's bundle that carries the SDK's player (both NEEDLES in it): { file, text } or null.
 * prefer: app homes (oap_<uid>) looked at first. One file at a time, the loop free in between. */
async function findBundle(o) {
    const root = o.oapRoot || '/var/opt/public/oap';
    let homes = [];
    try { homes = fs.readdirSync(root).filter((n) => /^oap_\d+$/.test(n)).sort(); } catch (e) { return null; }
    const first = (o.prefer || []).filter((h) => homes.indexOf(h) >= 0);
    homes = first.concat(homes.filter((h) => first.indexOf(h) < 0));
    const end = Date.now() + (o.findMs || 20000);
    let read = 0;
    for (const h of homes.slice(0, o.maxHomes || 120)) {
        for (const sub of ['source/javascript', 'source']) {
            const dir = path.join(root, h, sub);
            let names = [];
            try { names = fs.readdirSync(dir).filter((n) => /\.js$/.test(n) && !/^runner\.js$/.test(n)).sort((x, y) => (y === 'app.js') - (x === 'app.js') || (x < y ? -1 : 1)); } catch (e) { continue; }
            for (const n of names.slice(0, 6)) {
                if (Date.now() > end || read > (o.maxBytes || (160 << 20))) return null;
                const file = path.join(dir, n);
                if (/jap_ridetube/.test(file)) continue;
                const text = await readText(file, 24 << 20);
                if (text === null) continue;
                read += text.length;
                if (NEEDLES.every((w) => text.indexOf(w) >= 0)) return { file: file, text: text, home: h };
                await sleep(o.gapMs === undefined ? 40 : o.gapMs);
            }
        }
    }
    return null;
}
/* The whole read: the bundle found, the child run, its JSON back. Never rejects: { ok: false, error } says why. */
async function read(o) {
    o = o || {};
    const out = { ok: false, file: null, error: null };
    let found;
    try { found = o.text ? { file: o.file || '(given)', text: o.text, home: null } : await findBundle(o); } catch (e) { out.error = 'looking for an app with the SDK\'s player failed: ' + (e && e.message || e); return out; }
    if (!found) { out.error = 'no installed app carries the SDK\'s player (playlistConverter)'; return out; }
    out.file = found.file;
    let st = null;
    try { st = fs.statSync(found.file); } catch (e) { /* a given text */ }
    out.stamp = st ? st.size + ':' + Math.floor(st.mtime.getTime() / 1000) : String(found.text.length);
    const ids = typeof o.uid === 'number' ? { uid: o.uid, gid: typeof o.gid === 'number' ? o.gid : o.uid } : {};
    const ms = o.timeoutMs || 25000;
    // (the numbers an app's item ids could carry: the caller's, which may depend on the app whose code this is)
    let logIds = [];
    try { logIds = (typeof o.logIds === 'function' ? o.logIds(found.home) : o.logIds) || []; } catch (e) { logIds = []; }
    const res = await new Promise((resolve) => {
        let child, done = false, so = '', se = '';
        const finish = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
        const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) { /* gone */ } finish({ error: 'reading the SDK\'s player took over ' + Math.round(ms / 1000) + ' s' }); }, ms);
        try {
            child = cp.spawn(o.node || process.execPath, [__filename, 'worker', JSON.stringify({ sample: SAMPLE, logIds: logIds })],
                Object.assign(ids, { cwd: '/', env: {}, stdio: ['pipe', 'pipe', 'pipe'] }));
        } catch (e) { return finish({ error: 'the reader could not be started: ' + e.message }); }
        child.on('error', (e) => finish({ error: 'the reader could not be started: ' + e.message }));
        child.stdin.on('error', () => { /* it ended early: its exit says */ });
        child.stdout.on('data', (d) => { if (so.length < (4 << 20)) so += d; });
        child.stderr.on('data', (d) => { if (se.length < 4000) se += d; });
        child.on('close', (code, sig) => {
            let v = null;
            try { v = JSON.parse(so); } catch (e) { /* said below */ }
            if (v && typeof v === 'object') return finish(v);
            return finish({ error: 'the reader ended (' + (sig || code) + ') without an answer' + (se ? ': ' + se.trim().split('\n').pop().slice(0, 200) : '') });
        });
        child.stdin.end(found.text);
        return undefined;
    });
    Object.keys(res).forEach((k) => { if (k !== 'file') out[k] = res[k]; });
    // not understood: at least the text around what matters, as written (nothing is run for this)
    if (!res.ok && !(res.near && res.near.length)) out.near = textNear(found.text);
    // how the focus is asked for, wherever in the bundle that is written (the app's own part too): as text, nothing run
    out.near = textFocus(found.text).concat(out.near || []);
    // how a file is played after the focus: the item's id, where the file is, what starts it - as text, nothing run
    out.play = textPlay(found.text);
    out.ok = !!res.ok && !res.error;
    if (!out.ok && !out.error) out.error = (res.notes && res.notes[0]) || 'the SDK\'s player was not understood';
    return out;
}

/* The stretches of a bundle's text about the audio focus: the call with its three arguments as written, and what an
 * app does before it reports that registering the focus failed. [{ what, text }]. */
function textFocus(text) {
    const out = [], seen = [];
    [['AudioFocus call (clientName:)', /clientName\s*:/g, 320, 260], ['AudioFocus call (timeOutHeartBeatTimer:)', /timeOutHeartBeatTimer\s*:/g, 380, 160],
        ['AudioFocus registration (the app)', /Register audio [Ff]ocus failed/g, 800, 120], ['AudioFocus (clientId =)', /\bclientId\s*=[^=]/g, 160, 260]].forEach((k) => {
        k[1].lastIndex = 0;
        let x, n = 0;
        while ((x = k[1].exec(text)) && out.length < 7 && n < 2) {
            const at = x.index;
            if (seen.some((p) => Math.abs(p - at) < 500)) continue;       // (not the same stretch twice)
            seen.push(at);
            n++;
            out.push({ what: k[0], text: text.slice(Math.max(0, at - k[2]), at + k[3]).replace(/\s+/g, ' ') });
        }
    });
    return out;
}

/* The stretches of a bundle's text that say how a file is played once the focus is there: what starts the playlist,
 * how the number in an item's id is made of the app's logging id, the id's type per player instance, where an app
 * keeps the file it plays, how the SDK finds the app's id. [{ what, text }]. (The class's own methods - its item
 * converter, setPlaylist, init, connect - are read from the class itself: the child's `methods`.) */
function textPlay(text) {
    const out = [];
    const def = (n) => new RegExp('(?:^|[^\\w$.])' + n + '\\s*\\(\\s*(?:[\\w$]+(?:\\s*=\\s*[^,)]{1,12})?(?:\\s*,\\s*[\\w$]+(?:\\s*=\\s*[^,)]{1,12})?)*)?\\s*\\)\\s*\\{', 'g');
    const add = (what, re, before, after, max) => {
        re.lastIndex = 0;
        let x, n = 0;
        while ((x = re.exec(text)) && n < (max || 1) && out.length < 16) {
            n++;
            out.push({ what: what, text: text.slice(Math.max(0, x.index - before), x.index + after).replace(/\s+/g, ' ').trim() });
        }
        return n;
    };
    add('what starts the playlist (startPlaybackWithPlayItem =)', /startPlaybackWithPlayItem\s*=[^=]/g, 10, 800);
    add('the id\'s number of the app (convertedLoggingId =)', /convertedLoggingId\s*=[^=]/g, 160, 300);
    // (the function that makes that number, where it is one: its definition)
    const conv = /convertedLoggingId\s*=\s*(?:\(0\s*,\s*)?(?:[\w$]+\.)*([A-Za-z_$][\w$]{3,})\)?\s*\(/.exec(text);
    if (conv && !/^(parseInt|Number|Math|String)$/.test(conv[1])) {
        if (!add('its function ' + conv[1], def(conv[1]), 0, 420)) add('its function ' + conv[1], new RegExp('[^\\w$]' + conv[1].replace(/\$/g, '\\$') + '\\s*=\\s*(?:function|\\(|[\\w$]+\\s*=>)', 'g'), 0, 420);
    }
    add('the id\'s type per instance (sourceToItemTypeMap =)', /sourceToItemTypeMap\s*=[^=]/g, 10, 320);
    // (the class's other connections to the car: whom its "sound property" is set at)
    add('another proxy of the class', /this\.(?!mediaPlayerProxy)[\w$]*[Pp]roxy\s*=[^=]/g, 0, 240, 3);
    add('the use case per instance (sourceToUseCaseParameterMap =)', /sourceToUseCaseParameterMap\s*=[^=]/g, 10, 300);
    add('where the app keeps the file (getVideoPath)', def('getVideoPath'), 60, 520);
    add('how the app\'s id is found', /Could not determine the appID/g, 560, 80);
    add('registerAudioFocus(', def('registerAudioFocus'), 0, 520);
    return out;
}

/* The stretches of a bundle's text that say how the player is asked, for the Diagnostics page when the class could
 * not be loaded: [{ what, text }]. */
function textNear(text) {
    const out = [];
    [['playlistConverter(', /playlistConverter\s*\(\s*[\w$]+(?:\s*,\s*[\w$]+)*\s*\)\s*\{/g, 60, 900], ['generateItemId()', /generateItemId\s*\(\s*\)\s*\{/g, 40, 400],
        ['getAudioFocus(', /\.getAudioFocus\s*\(/g, 400, 500], ['.heartBeat(', /\.heartBeat\s*\(/g, 350, 350], ['ePlay:', /ePlay\s*:/g, 200, 500]].forEach((k) => {
        k[1].lastIndex = 0;
        let x, n = 0;
        while ((x = k[1].exec(text)) && n++ < 2 && out.length < 9) out.push({ what: k[0], text: text.slice(Math.max(0, x.index - k[2]), x.index + k[3]).replace(/\s+/g, ' ') });
    });
    return out;
}

/* The child's JSON values back as what the binding is given: { $: 'buffer', hex } -> Buffer, typed arrays, undefined.
 * A stand-in ({ $: 'stub' }) stays as it is (hasStub tells). */
function decode(v) {
    if (Array.isArray(v)) return v.map(decode);
    if (!v || typeof v !== 'object') return v;
    if (typeof v.$ === 'string') {
        if (v.$ === 'buffer') return Buffer.from(String(v.hex || ''), 'hex');
        if (v.$ === 'undefined') return undefined;
        if (/^(Uint8|Int8|Uint16|Int16|Uint32|Int32|Uint8Clamped)Array$/.test(v.$) && Array.isArray(v.data)) return new (global[v.$])(v.data);
        return v;
    }
    const o = {};
    Object.keys(v).forEach((k) => { if (k !== '$class') o[k] = decode(v[k]); });
    return o;
}
function hasStub(v) {
    if (Array.isArray(v)) return v.some(hasStub);
    if (!v || typeof v !== 'object') return false;
    if (typeof v.$ === 'string') return !/^(buffer|undefined|(Uint8|Int8|Uint16|Int16|Uint32|Int32|Uint8Clamped)Array)$/.test(v.$);
    return Object.keys(v).some((k) => hasStub(v[k]));
}
/* One line of an encoded value: buffers as <Buffer hex>, stand-ins as <name>. */
function show(v) {
    if (Array.isArray(v)) return '[' + v.map(show).join(', ') + ']';
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (typeof v.$ === 'string') {
        if (v.$ === 'buffer') return '<Buffer ' + String(v.hex || '').slice(0, 64) + (String(v.hex || '').length > 64 ? '...' : '') + '>';
        if (v.$ === 'stub') return '<' + v.name + '>';
        if (Array.isArray(v.data)) return v.$ + '[' + v.data.slice(0, 24).join(',') + (v.data.length > 24 ? ',...' : '') + ']';
        return '<' + v.$ + '>';
    }
    return '{' + Object.keys(v).map((k) => k + ': ' + show(v[k])).join(', ') + '}';
}

/* ------------------------------------------------------------------ the child's side */

/* Where the browserify prelude ends in a bundle (the module map follows as its call's arguments), or -1. The two
 * forms BMW's bundles have: plain ('return r})()') and minified ('return o}}()'). */
function preludeEnd(text) {
    let i = text.indexOf('return r})()');
    if (i >= 0) return i + 12;
    i = text.indexOf('return o}}()');
    return i >= 0 ? i + 12 : -1;
}

/* Runs inside the vm context (its source is evaluated there, so every object it makes belongs to that realm).
 * mods: the bundle's module map { id: [function (require, module, exports), { name: id }] }. */
function inSandbox(mods, opt, ext) {
    var STUB = '__rt_stub__';
    var log = { calls: [], other: [], timers: [], notes: [], failed: {}, externals: {}, subs: [], touched: {} };
    var label = '';
    var DMP = opt.methods, FIELDS = opt.fields;
    var last = function (name) { var m = /([A-Za-z_$][\w$]*)(?:\(\))?>?$/.exec(name); return m ? m[1] : ''; };
    function enc(v, d) {
        d = d || 0;
        if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
        if (typeof v === 'number') return isFinite(v) ? v : { $: 'number', text: String(v) };
        if (v === undefined) return { $: 'undefined' };
        if (typeof v === 'symbol') return { $: 'symbol' };
        if (typeof v === 'function') { var n; try { n = v[STUB]; } catch (e) { n = null; } return { $: 'stub', name: n || ('function ' + (v.name || '')) }; }
        if (d > 9) return { $: 'deep' };
        if (ext.Buffer.isBuffer(v)) return { $: 'buffer', hex: v.toString('hex') };
        if (ArrayBuffer.isView(v)) return { $: (v.constructor && v.constructor.name) || 'TypedArray', data: Array.prototype.slice.call(v, 0, 4096) };
        if (Array.isArray(v)) return v.slice(0, 200).map(function (x) { return enc(x, d + 1); });
        var o = {};
        var keys;
        try { keys = Object.keys(v); } catch (e) { return { $: 'object' }; }
        keys.slice(0, 80).forEach(function (k) { var x; try { x = v[k]; } catch (e) { x = undefined; } o[k] = enc(x, d + 1); });
        var cn = v.constructor && v.constructor.name;
        if (cn && cn !== 'Object') o.$class = cn;
        return o;
    }
    /* What a call of the player's proxy answers here: the car's "OK", with a token for the focus. */
    function answer(m) {
        if (m === 'getAudioFocus') return { dynMediaPlayerError: 'OK', token: 'RTTOKEN' };
        if (m === 'setTime') return { entError: 'OK' };
        if (m === 'heartBeat') return {};
        return { dynMediaPlayerError: 'OK' };
    }
    function called(name, args) {
        var m = last(name);
        var list = Array.prototype.slice.call(args);
        var fns = [];
        list.forEach(function (a) {
            if (typeof a === 'function' && !a[STUB]) fns.push(a);
            else if (a && typeof a === 'object' && !Array.isArray(a)) { try { Object.keys(a).forEach(function (k) { if (typeof a[k] === 'function' && !a[k][STUB]) fns.push(a[k]); }); } catch (e) { /* a stand-in */ } }
        });
        if (DMP.indexOf(m) >= 0) {
            if (log.calls.length < 120) log.calls.push({ in: label, path: name, method: m, args: enc(list.length === 1 ? list[0] : list) });
            return Promise.resolve(answer(m));
        }
        if (fns.length) {
            // a listener handed to something outside the class: kept, so a field's value can be said to it
            var text = name + ' ' + JSON.stringify(enc(list)).slice(0, 300);
            var field = FIELDS.filter(function (f) { return text.indexOf(f) >= 0; }).sort(function (x, y) { return y.length - x.length; })[0] || null;
            if (log.subs.length < 60) log.subs.push({ in: label, path: name, field: field, fns: fns });
        }
        // what the class asks of anything else than the player while it sets its "sound property" or plays a file:
        // of whom (the path says how the class reached it) and with what - logging and its own state machine aside
        if (/^(setSoundProperty|setImageRequestProperty)\(\)|^constructed: (playFile|setSoundProperty)/.test(label) && log.other.length < 24 &&
            !/logg|console|dlt|stateService|\.(log|info|warn|error|debug|trace|emit|send|inspect|bind|includes|toString|delay|resolve|reject)$/i.test(name)) {
            log.other.push({ in: label, path: name.slice(-200), method: m, args: enc(list.length === 1 ? list[0] : list) });
        }
        // (the words it was called with stay in its name: a proxy made of an interface's and an instance's name says so)
        var sig = list.filter(function (x) { return typeof x === 'string' || typeof x === 'number'; }).map(function (x) { return JSON.stringify(x); }).join(',').slice(0, 70);
        return stub(name + '(' + sig + ')', true);
    }
    /* A stand-in for anything outside the bundle or not set on the instance: every property is another stand-in,
     * a call is recorded (when it is one of the player's) and answers a stand-in that can also be awaited. */
    function stub(name, thenable, own) {
        var f = function () { 'use strict'; };      // (strict: no own arguments/caller the proxy would have to tell the truth about)
        var pr = null;
        return new Proxy(f, {
            get: function (t, k) {
                if (k === STUB) return name;
                // (what is known of it is said as it is: the options the class is made with)
                if (own && typeof k === 'string' && Object.prototype.hasOwnProperty.call(own, k)) return own[k];
                if (k === 'then' || k === 'catch') {
                    if (!thenable) return undefined;
                    pr = pr || Promise.resolve(stub(name + '>', false));
                    return pr[k].bind(pr);
                }
                if (typeof k === 'symbol') return k === Symbol.toPrimitive ? function () { return '<' + name + '>'; } : undefined;
                if (k === 'toString' || k === 'valueOf' || k === 'toJSON' || k === 'inspect') return function () { return '<' + name + '>'; };
                if (k === 'prototype') return t.prototype;
                if (k === 'length') return 0;
                if (k === 'constructor') return Object;
                return stub(name + '.' + k, false);
            },
            set: function () { return true; },
            has: function () { return true; },
            apply: function (t, th, args) { return called(name, args); },
            construct: function (t, args) { called('new ' + name, args); return stub('new ' + name + '()', false); }
        });
    }
    // (a description or a configuration read from a file that is a stand-in here stays one, instead of a parse error)
    var parse = JSON.parse;
    JSON.parse = function (t) { if (t && (typeof t === 'object' || typeof t === 'function') && t[STUB]) return stub('JSON.parse(' + t[STUB] + ')', false); return parse.apply(JSON, arguments); };
    var cache = {};
    function external(name) {
        log.externals[name] = (log.externals[name] || 0) + 1;
        var real = ext.builtin(name);
        return real !== undefined ? real : stub('ext:' + name, false);
    }
    function load(id) {
        if (cache[id]) return cache[id].exports;
        var m = mods[id];
        if (!m || typeof m[0] !== 'function') return stub('missing:' + id, false);
        var module = cache[id] = { exports: {} };
        var req = function (name) {
            var dep = m[1] ? m[1][name] : undefined;
            if (dep !== undefined && dep !== null && mods[dep]) return load(dep);
            return external(String(name));
        };
        try { m[0].call(module.exports, req, module, module.exports); } catch (e) {
            log.failed[id] = String(e && e.message || e).slice(0, 140);
            module.exports = stub('failed:' + id, false);
        }
        return module.exports;
    }
    var src = function (fn) { try { return Function.prototype.toString.call(fn); } catch (e) { return ''; } };
    // the timers the code sets are recorded (an interval is the heartbeat's cadence)
    ext.onTimer = function (kind, fn, ms) { if (log.timers.length < 40) log.timers.push({ in: label, kind: kind, ms: typeof ms === 'number' ? ms : null, fn: src(fn).replace(/\s+/g, ' ').slice(0, 160) }); };
    var out = { ok: false, modules: Object.keys(mods).length, module: null, cls: null, item: null, itemHow: null, convert: [], methods: {}, near: [] };

    // 1. the module that defines the converter, loaded with the bundle's own modules
    var defRe = /playlistConverter\s*\(\s*[\w$]+(\s*,\s*[\w$]+)*\s*\)\s*\{/;
    var ids = Object.keys(mods).filter(function (id) { var s = src(mods[id][0]); return defRe.test(s) && s.indexOf('createPlaylist') >= 0; });
    if (!ids.length) ids = Object.keys(mods).filter(function (id) { return src(mods[id][0]).indexOf('playlistConverter') >= 0; });
    if (!ids.length) { log.notes.push('no module of the bundle defines playlistConverter'); return finish(); }
    var Cls = null;
    var classIn = function (ex) {
        var cands = [ex];
        try { Object.keys(ex).forEach(function (k) { cands.push(ex[k]); }); cands.push(ex.default); } catch (e) { /* a stand-in */ }
        return cands.filter(function (c) { return typeof c === 'function' && !c[STUB] && c.prototype && typeof c.prototype.playlistConverter === 'function'; })[0] || null;
    };
    ids.some(function (id) {
        Cls = classIn(load(id));
        if (Cls) out.module = id;
        return !!Cls;
    });
    // the module did not come up with the bundle's own modules (one of them needs the car): alone then, with
    // everything it requires a stand-in but Node's own events and util - its class is the same text
    if (!Cls) {
        ids.some(function (id) {
            var m = mods[id], module = { exports: {} };
            var req = function (name) { var real = ext.builtin(String(name)); return real !== undefined ? real : stub('dep:' + name, false); };
            try { m[0].call(module.exports, req, module, module.exports); } catch (e) { log.notes.push('module ' + id + ' alone: ' + String(e && e.message || e).slice(0, 140)); return false; }
            Cls = classIn(module.exports);
            if (Cls) { out.module = id; out.alone = true; log.notes.push('the class was loaded alone (module ' + id + ' did not load with the bundle\'s modules' + (log.failed[id] ? ': ' + log.failed[id] : '') + '): what it takes from other modules is a stand-in'); }
            return !!Cls;
        });
    }
    // (the state machine's part of the module: what an ePlay does, as written)
    ids.slice(0, 2).forEach(function (id) {
        var s = src(mods[id][0]);
        [['ePlay:', /ePlay\s*:/g], ['Starting: {', /Starting\s*:\s*\{/g], ['getAudioFocus(', /getAudioFocus\s*\(/g], ['.heartBeat(', /\.heartBeat\s*\(/g], ['timeOutHeartBeatTimer', /timeOutHeartBeatTimer/g]].forEach(function (k) {
            var x, n = 0, re = k[1];
            while ((x = re.exec(s)) && n++ < 2 && out.near.length < 10) out.near.push({ what: k[0], text: s.slice(Math.max(0, x.index - 260), x.index + 640).replace(/\s+/g, ' ') });
        });
    });
    if (!Cls) { log.notes.push('the module with playlistConverter (' + ids.join(', ') + ') exports no class with it' + (log.failed[ids[0]] ? ': ' + log.failed[ids[0]] : '')); return finish(); }
    out.cls = Cls.name || '(a class)';
    var proto = Cls.prototype;
    var names = Object.getOwnPropertyNames(proto).filter(function (n) { var d = Object.getOwnPropertyDescriptor(proto, n); return d && typeof d.value === 'function'; });
    out.methodNames = names;
    var want = [/^playlistItemConverter$/, /^setPlaylist$/, /^(setSoundProperty|setImageRequestProperty|handleSinkNotification|waitForDecoder)$/, /^(sendResume|sendPause|sendButtonEvent|sendButtonPressAndRelease|startNewIfNoExistingPlayback|resetPlayback|connect|init)$/, /^playlistConverter$/, /^generateItemId$/, /getAudioFocus\s*\(/, /\.heartBeat\s*\(/, /^playFile$/, /^playItem$/, /^createPlaylist$/, /setCurrentItemPositionAndTime\s*\(/, /setAutoplay\s*\(/, /releaseAudioFocus\s*\(/, /^constructor$/];
    var total = 0;
    want.forEach(function (re) {
        names.forEach(function (n) {
            if (out.methods[n] !== undefined || total > 14000) return;
            var s = n === 'constructor' ? (/constructor\s*\([^)]*\)\s*\{[\s\S]{0,1800}/.exec(src(Cls)) || [src(Cls).slice(0, 1800)])[0] : src(proto[n]);
            if (!(re.source.charAt(0) === '^' ? re.test(n) : re.test(s))) return;
            s = s.replace(/\s+/g, ' ').slice(0, 2200);
            out.methods[n] = s;
            total += s.length;
        });
    });

    // what the class itself carries (its statics): the type an item's id gets per player instance is one of them
    out.statics = {};
    var typeMap = null;
    try {
        Object.getOwnPropertyNames(Cls).forEach(function (k) {
            if (/^(length|name|prototype|caller|arguments)$/.test(k)) return;
            var v;
            try { v = Cls[k]; } catch (e) { return; }
            if (typeof v === 'function' || v === undefined) return;
            var e = enc(v);
            if (JSON.stringify(e).length > 1500 || Object.keys(out.statics).length >= 12) return;
            out.statics[k] = e;
            var plain = v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 0 && Object.keys(v).every(function (x) { return typeof v[x] === 'number'; });
            if (plain && (/ItemType/i.test(k) || !typeMap)) typeMap = v;
        });
    } catch (e) { /* none readable */ }
    out.instances = typeMap ? Object.keys(typeMap) : [];

    // 2. an instance without its constructor: what the class itself does not set is a stand-in
    function bare(mediaType) {
        var t = Object.create(proto);
        t.mediaPlayerProxy = stub('this.mediaPlayerProxy', false);
        t.cachedToken = 'RTTOKEN';
        t.cachedPlaylist = [];
        t.mediaType = mediaType;
        return new Proxy(t, { get: function (o, k, r) {
            if (k in o) return Reflect.get(o, k, r);
            if (typeof k === 'symbol' || k === 'then' || k === 'toJSON') return undefined;
            log.touched[k] = 1;
            return stub('this.' + k, false);
        } });
    }
    var fresh = function (json) { return JSON.parse(JSON.stringify(json)); };   // (made in this realm)
    function convert(how, mediaType, withMeta) {
        var rec = { how: how, mediaType: mediaType, id: null, out: null, error: null };
        try {
            var inst = bare(mediaType), id;
            try { id = inst.generateItemId(); rec.id = enc(id); } catch (e) { rec.idError = String(e && e.message || e).slice(0, 120); }
            var item = fresh(withMeta ? { fileName: opt.sample.file, metadata: [{ key: 'FILE_SIZE', value: opt.sample.size }] } : { fileName: opt.sample.file });
            if (id !== undefined) item.id = id;
            rec.out = enc(inst.playlistConverter([item], 1));
        } catch (e) { rec.error = String(e && e.message || e).slice(0, 200); }
        out.convert.push(rec);
        return rec;
    }
    var c1 = convert('playlistConverter([{ fileName, metadata: [FILE_SIZE], id: generateItemId() }], 1)', 'Audio', true);
    convert('the same without metadata', 'Audio', false);
    convert('the same as a video', 'Video', true);
    if (c1.out && !c1.error) { out.item = c1.out; out.itemHow = c1.how; }
    // the item with the id the class's own generateItemId gives it, for each player instance it knows and each
    // number an app could have (opt.logIds: [{ key, n }], n null for "not a number")
    out.ids = [];
    (out.instances.length ? out.instances : [null]).forEach(function (K) {
        (opt.logIds || []).forEach(function (L) {
            if (out.ids.length >= 60) return;
            var rec = { inst: K, log: L.key, n: null, out: null, error: null };
            try {
                var inst = bare('Audio');
                if (K !== null) inst.instance = K;
                inst.convertedLoggingId = typeof L.n === 'number' ? L.n : NaN;
                var id = inst.generateItemId();
                rec.n = enc(id);
                var item = fresh({ fileName: opt.sample.file, metadata: [{ key: 'FILE_SIZE', value: opt.sample.size }] });
                item.id = id;
                rec.out = enc(inst.playlistConverter([item], 1));
            } catch (e) { rec.error = String(e && e.message || e).slice(0, 160); }
            out.ids.push(rec);
        });
    });

    // 3. the class's own calls against the recording proxy
    function settle(ms) { return new Promise(function (r) { ext.setTimeout(r, ms || 40); }); }
    function run(inst, what, name, args) {
        label = what;
        var p;
        try { p = inst[name].apply(inst, args); } catch (e) { log.notes.push(what + ' threw: ' + String(e && e.message || e).slice(0, 160)); return settle(); }
        if (p && typeof p.then === 'function') { try { p.then(function () {}, function (e) { log.notes.push(what + ' rejected: ' + String(e && e.message || e).slice(0, 160)); }); } catch (e) { /* a stand-in */ } }
        return settle();
    }
    var has = function (re) { return names.filter(function (n) { return n !== 'constructor' && re.test(src(proto[n])); }); };
    var chain = Promise.resolve();
    var then = function (fn) { chain = chain.then(fn).catch(function (e) { log.notes.push('step failed: ' + String(e && e.message || e).slice(0, 160)); }).then(function () { ext.progress(finish()); }); };
    ext.progress(finish());
    if (typeof proto.createPlaylist === 'function') then(function () { return run(bare('Audio'), 'createPlaylist([{ fileName, metadata }], "Audio")', 'createPlaylist', [fresh([{ fileName: opt.sample.file, metadata: [{ key: 'FILE_SIZE', value: opt.sample.size }] }]), 'Audio']); });
    if (typeof proto.playFile === 'function') then(function () { return run(bare('Audio'), 'playFile(file, 0, "Audio", size)', 'playFile', [opt.sample.file, 0, 'Audio', opt.sample.size]); });
    has(/\.getAudioFocus\s*\(/).slice(0, 2).forEach(function (n) { then(function () { return run(bare('Audio'), n + '()', n, []); }); });
    has(/\.heartBeat\s*\(/).filter(function (n) { return !/\.getAudioFocus\s*\(/.test(src(proto[n])); }).slice(0, 2).forEach(function (n) { then(function () { return run(bare('Audio'), n + '()', n, []); }); });
    if (typeof proto.playItem === 'function') then(function () { return run(bare('Audio'), 'playItem(1, 0)', 'playItem', [1, 0]); });
    // (what BMW's code asks beside the player once an item is set: its "sound property", of whom and with what)
    ['setSoundProperty', 'setImageRequestProperty'].forEach(function (n) { if (typeof proto[n] === 'function') then(function () { return run(bare('Audio'), n + '()', n, []); }); });
    // 4. the class as its constructor makes it (its own state machine), with the options an app gives it (its
    // instance's name, the app's title), then init and connect against a simulated car, then playFile
    then(function () {
        var inst;
        label = 'new ' + out.cls + '(...)';
        var K = out.instances.filter(function (k) { return /^Entertainment$/i.test(k); })[0] || out.instances[0];
        // (no "lumOptions": an app that does not ask for that mode passes none)
        var own = K === undefined ? { clientName: 'RideTube' } : { instance: K, clientName: 'RideTube', lumOptions: undefined };
        try { inst = new Cls(stub('arg0', false, own), stub('arg1', false), stub('arg2', false), stub('arg3', false)); } catch (e) {
            log.notes.push('its constructor threw with ' + JSON.stringify(own) + ': ' + String(e && e.message || e).slice(0, 140));
            K = undefined;
            try { inst = new Cls(stub('arg0', false), stub('arg1', false), stub('arg2', false), stub('arg3', false)); } catch (e2) { log.notes.push('its constructor threw: ' + String(e2 && e2.message || e2).slice(0, 160)); return undefined; }
        }
        var st = function () { var s; try { s = inst.state !== undefined ? inst.state : inst.publicState; } catch (e) { s = undefined; } return typeof s === 'string' ? s : s === undefined ? undefined : String(JSON.stringify(enc(s))).slice(0, 60); };
        out.states = [['constructed' + (K === undefined ? '' : ' as ' + K), st()]];
        // (what it made of the app it runs in: the name it asks the focus under, the number its ids carry)
        out.fields = {};
        ['instance', 'appId', 'clientName', 'convertedLoggingId', 'loggingId', 'heartBeatTimeoutMs', 'heartBeatIntervalMs', 'lumEnabled', 'decoderTimeout', 'playerStoppedWaitingMs'].forEach(function (k) {
            var v;
            try { v = inst[k]; } catch (e) { return; }
            if (v !== undefined) out.fields[k] = enc(v);
        });
        try { if (!inst.mediaPlayerProxy || !inst.mediaPlayerProxy[STUB]) { out.proxyWas = inst.mediaPlayerProxy === undefined ? 'not set by the constructor' : 'set by the constructor'; if (inst.mediaPlayerProxy === undefined) inst.mediaPlayerProxy = stub('this.mediaPlayerProxy', false); } } catch (e) { /* as it is */ }
        var say = function (field, value) {
            log.subs.filter(function (s) { return s.field === field; }).forEach(function (s) { s.fns.forEach(function (fn) { try { fn(value); } catch (e) { /* its own business */ } }); });
        };
        var steps = names.filter(function (n) { return /^(init|initialize)$/.test(n); }).slice(0, 1).concat(names.filter(function (n) { return /^(connect|start|open)$/.test(n); }).slice(0, 1));
        if (!steps.length && has(/\.getAudioFocus\s*\(/)[0]) steps.push(has(/\.getAudioFocus\s*\(/)[0]);
        var p = Promise.resolve();
        steps.forEach(function (n) {
            p = p.then(function () { return run(inst, 'constructed: ' + n + '()', n, []); }).then(function () { return settle(120); }).then(function () { out.states.push(['after ' + n + '()', st()]); });
        });
        // the car's side: the focus is ours, then the connection - said to what listens, and to the class's own
        // handlers of those two by name (its subscriptions may not have come about against stand-ins)
        var tell = function (re, value) {
            names.filter(function (n) { return re.test(n); }).slice(0, 1).forEach(function (n) { try { inst[n](value); } catch (e) { log.notes.push(n + ' threw: ' + String(e && e.message || e).slice(0, 120)); } });
        };
        return p.then(function () {
            var str = function (v, d) { return typeof v === 'string' && v ? v : d; };
            var focus = { token: str(inst.cachedToken, 'RTTOKEN'), clientId: str(inst.appId, 'x'), clientName: str(inst.clientName, 'x'), status: 'HAS_FOCUS' };
            say('currentAudioFocus', focus);
            tell(/^handle\w*AudioFocus\w*$/, focus);
            return settle(80);
        }).then(function () {
            say('connectionState', 'CS_CONNECTED');
            tell(/^handle\w*ConnectionState\w*$/, 'CS_CONNECTED');
            say('playerState', 'PLAYER_STATE_STOP');
            return settle(160);
        }).then(function () {
            out.states.push(['the car says connected', st()]);
            return typeof inst.playFile === 'function' ? run(inst, 'constructed: playFile(file, 0, "Audio", size)', 'playFile', [opt.sample.file, 0, 'Audio', opt.sample.size]) : undefined;
        }).then(function () { return settle(160); }).then(function () {
            out.states.push(['after playFile', st()]);
            return typeof inst.setSoundProperty === 'function' ? run(inst, 'constructed: setSoundProperty()', 'setSoundProperty', []) : undefined;
        }).then(function () {
            // (what it asks from here on answers a car that plays: not part of how it starts a file)
            label = 'constructed: once the car says it plays';
            say('currentItemPosition', { position: 1, totalNumber: 1 });
            say('playerState', 'PLAYER_STATE_PLAY');
            say('currentItemTime', { elapsed: 1000, total: 60000 });
            return settle(120);
        }).then(function () { out.states.push(['the car says playing', st()]); });
    });
    function finish() {
        out.notes = log.notes.slice(0, 12);
        out.calls = log.calls;
        out.other = log.other;
        out.timers = log.timers.slice(0, 24);
        out.subs = log.subs.slice(0, 30).map(function (s) { return { in: s.in, path: s.path, field: s.field }; });
        out.failed = log.failed;
        out.externals = Object.keys(log.externals).slice(0, 40);
        out.touched = Object.keys(log.touched).slice(0, 60);
        out.ok = !!out.item;
        return out;
    }
    return chain.then(finish, finish);
}

function worker() {
    const chunks = [];
    process.stdin.on('data', (d) => chunks.push(d));
    process.stdin.on('end', () => {
        let opt = {};
        try { opt = JSON.parse(process.argv[3] || '{}'); } catch (e) { /* the defaults */ }
        opt.sample = opt.sample || SAMPLE;
        opt.methods = DMP_METHODS;
        opt.fields = DMP_FIELDS;
        let sent = false;
        // (stdout's own write: a pipe that is full for a moment is waited for, where a writeSync would give up)
        const send = (v) => { if (sent) return; sent = true; const bye = () => process.exit(0); try { process.stdout.write(JSON.stringify(v), bye); } catch (e) { bye(); } setTimeout(bye, 3000); };
        const fail = (m) => send({ ok: false, notes: [m] });
        // (what is known when the time is up is still sent: the item is read first)
        let partial = null;
        setTimeout(() => { if (partial) { partial.notes = (partial.notes || []).concat(['out of time: the rest was not read']); } send(partial || { ok: false, notes: ['out of time'] }); }, opt.limitMs || 12000);
        try {
            const text = Buffer.concat(chunks).toString('utf8');
            const end = preludeEnd(text);
            if (end < 0) return fail('the file is no browserify bundle');
            const ext = {
                Buffer: Buffer, onTimer: null,
                progress: (o) => { try { partial = JSON.parse(JSON.stringify(o)); } catch (e) { /* kept as it was */ } },
                setTimeout: (fn, ms) => setTimeout(fn, ms),
                builtin: (name) => (['events', 'util', 'path', 'assert', 'url', 'querystring', 'string_decoder', 'buffer', 'punycode'].indexOf(name) >= 0 ? require(name) : undefined),
            };
            const timers = [];
            const sandbox = {
                console: { log() {}, info() {}, warn() {}, error() {}, debug() {}, trace() {} },
                Buffer: Buffer,
                // (a short timeout runs, soon, so the code's chains go on; a long one - a watchdog - is only recorded)
                setTimeout: (fn, ms) => { if (ext.onTimer) ext.onTimer('timeout', fn, ms); if (timers.length > 400 || Number(ms) > 600) return 0; const t = setTimeout(() => { try { fn(); } catch (e) { /* its own */ } }, Math.min(Number(ms) || 0, 25)); timers.push(t); return t; },
                clearTimeout: (t) => clearTimeout(t),
                setInterval: (fn, ms) => { if (ext.onTimer) ext.onTimer('interval', fn, ms); return { unref() {}, ref() {} }; },
                clearInterval: () => {},
                setImmediate: (fn) => setTimeout(() => { try { fn(); } catch (e) { /* its own */ } }, 0),
                clearImmediate: () => {},
                process: { env: {}, argv: [], pid: 1, platform: 'linux', version: process.version, versions: {}, execArgv: [], title: 'node',
                    nextTick: function (fn) { const a = Array.prototype.slice.call(arguments, 1); Promise.resolve().then(() => fn.apply(null, a)); },
                    on() {}, once() {}, emit() {}, removeListener() {}, cwd: () => '/', uptime: () => 1, exit() {}, hrtime: process.hrtime, memoryUsage: () => ({}),
                    stdout: { write() {} }, stderr: { write() {} } },
            };
            sandbox.global = sandbox;
            sandbox.window = undefined;
            const ctx = vm.createContext(sandbox);
            vm.runInContext('var __rt_mods; function __rt_capture(m) { __rt_mods = m; }\n__rt_capture' + text.slice(end).replace(/;\s*$/, ''), ctx, { timeout: 8000 });
            const mods = sandbox.__rt_mods;
            if (!mods || typeof mods !== 'object') return fail('the bundle has no module map');
            const fn = vm.runInContext('(' + inSandbox.toString() + ')', ctx);
            Promise.resolve(fn(mods, opt, ext)).then(send, (e) => fail('reading failed: ' + String(e && e.message || e)));
        } catch (e) { fail('reading failed: ' + String(e && e.message || e).slice(0, 300)); }
        return undefined;
    });
}

if (require.main === module && process.argv[2] === 'worker') worker();

module.exports = {
    textFocus: textFocus, textPlay: textPlay, read: read, findBundle: findBundle, textNear: textNear, decode: decode, hasStub: hasStub, show: show, preludeEnd: preludeEnd, SAMPLE: SAMPLE, DMP_METHODS: DMP_METHODS, DMP_FIELDS: DMP_FIELDS };
