'use strict';
/**
 * yt.js - RideTube's link to the car daemon jap-ridetube-d (ytd.js) and its playback state.
 *
 *   Ctl    the control socket /run/jap-ridetube-d/ctl.sock: JSON lines, reconnects every 2 s.
 *          App -> daemon: search{q} thumb{id} play{id,rect:"WxH",fill} pause resume seek{ms} stop quality{quality} fill{on} video{on} status
 *                         auth_status auth sign_out feed{which:home|subs|wl} channels channel{id}
 *          Daemon -> app: (a played video is deleted from the car once stopped; nothing is kept for offline)
 *                         results{q,items:[{id,title,channel,duration_s,meta?}]} thumb{id,w,h,rgba(base64)}: 160x90 or 320x180
 *                         state{state:idle|preparing|playing|paused|ended|error,pct,id,title} time{elapsed,total} error{msg}
 *                         auth{state:signed_out|code|signed_in|error,code,url,expires,msg}
 *                         feed{which,items,shelves?|error}: shelves [{title,items}] in the service's page order (0.1.6 on;
 *                         absent or [] = none); meta: ["125K views","1 day ago"] as the service words them
 *                         channels{items:[{id,title,handle}]|error}: every subscription, A-Z
 *                         channel{id,items,shelves|error}: a channel's page
 *          Thumbs are asked lazily (Model.wantThumb, from the screens' draw path): only for the tiles drawn.
 *          The daemon signs in itself (TV device sign-in) and keeps the tokens; none come here.
 *          The daemon stops playback within 1 s of this socket closing, so the app keeps it open hidden too.
 *   Model  what the screens show, from the daemon's events; the commands the buttons send. Pure: no HMI, no timers.
 */
const net = require('net');

const SOCKET = '/run/jap-ridetube-d/ctl.sock';
const MAX_LINE = 1 << 20;            // a 320x180 thumb is 307 kB of base64; anything far past that is not ours
const FEEDS = ['home', 'subs', 'wl'];
const FEED_MAX = 20;                 // a feed's flat list (its pictures: as many as drawn, main.js's pool)
const SHELVES = 8, SHELF_MAX = 12;   // a feed's shelves, the videos in each
const SIZES = ['160x90', '320x180']; // the thumb sizes the daemon sends

class Ctl {
    constructor(path, log) {
        this.path = path || SOCKET;
        this.log = log;
        this.sock = null;
        this.up = false;
        this.buf = '';
        this.closed = false;
        this.handlers = { msg: [], up: [], down: [] };
    }
    on(ev, fn) { this.handlers[ev].push(fn); return this; }
    _emit(ev, a) { this.handlers[ev].forEach((fn) => { try { fn(a); } catch (e) { this.log.error('yt ' + ev, e); } }); }
    connect() {
        if (this.closed) return this;
        const s = this.sock = net.createConnection(this.path);
        s.setEncoding('utf8');
        s.on('connect', () => { this.up = true; this.buf = ''; this.log.info('jap-ridetube-d: connected'); this._emit('up'); });
        s.on('data', (d) => this._data(d));
        s.on('error', (e) => { if (!this.errLogged) { this.errLogged = true; this.log.warn('jap-ridetube-d: ' + e.message); } });
        s.on('close', () => {
            const was = this.up;
            this.up = false; this.sock = null;
            if (was) { this.errLogged = false; this.log.warn('jap-ridetube-d: connection closed'); this._emit('down'); }
            if (!this.closed) this.retry = setTimeout(() => this.connect(), 2000);
        });
        return this;
    }
    _data(d) {
        this.buf += d;
        if (this.buf.length > MAX_LINE && this.buf.indexOf('\n') < 0) { this.log.warn('jap-ridetube-d: line too long, dropped'); this.buf = ''; return; }
        let i;
        while ((i = this.buf.indexOf('\n')) >= 0) {
            const line = this.buf.slice(0, i);
            this.buf = this.buf.slice(i + 1);
            if (!line.trim()) continue;
            let m;
            try { m = JSON.parse(line); } catch (e) { this.log.warn('jap-ridetube-d: bad line ' + line.slice(0, 80)); continue; }
            if (m && typeof m.ev === 'string') this._emit('msg', m);
        }
    }
    /** false when not connected (the command is dropped: the screen shows the daemon is missing) */
    send(obj) {
        if (!this.up || !this.sock) return false;
        this.sock.write(JSON.stringify(obj) + '\n');
        return true;
    }
    close() {
        this.closed = true;
        clearTimeout(this.retry);
        if (this.sock) this.sock.destroy();
    }
}

const ACTIVE = ['preparing', 'playing', 'paused'];

class Model {
    /** send(obj): Ctl.send */
    constructor(send) {
        this.send = send;
        this.connected = false;
        this.q = null; this.searching = false;
        this.results = [];           // [{id,title,channel,duration_s}]
        this.thumbs = {};            // id -> { w, h, buf } (RGBA, 160x90 or 320x180), for ids some list shows
        this.pending = new Set();    // ids whose thumb was asked and has not come yet
        this.searchError = null;     // what the last search got instead of results (proxy offline, no answer)
        this.searchT = 0;
        this.state = 'idle'; this.pct = 0; this.id = null; this.title = ''; this.channel = '';
        this.elapsed = 0; this.total = 0;
        this.error = null;
        this.videoOn = true;         // what the daemon was last told
        this.wantVideo = false;      // player shown and parked
        // the account: unknown (not asked yet) | asking | signed_out | code | signed_in | error | unsupported (older daemon)
        this.auth = { state: 'unknown', code: null, url: null, msg: null };
        this.feeds = {};             // home|subs|wl -> {items, loading, error, t}
        this.pos = {};               // id -> {ms, total, done, title, channel, duration_s}: where each video was left
        this.resume = [];            // Continue watching: started, not finished, newest first
        this.extras = null;          // the playing video's {id, chapters: [[ms, title]], segments: [[ms, ms, category]]}
        this.toast = null;           // {text, until}: a skipped sponsor
        this.chans = null;           // the subscribed channels: {items:[{id,title,handle}], loading, error, t}
        this.chan = null;            // the channel page shown: {id, title, items, shelves, loading, error, t}
        this.rev = 0;                // bumped on every change the screens show
    }
    active() { return ACTIVE.indexOf(this.state) >= 0; }
    _changed() { this.rev++; }

    setConnected(on) {
        this.connected = on;
        if (on) { this.send({ cmd: 'status' }); this.send({ cmd: 'auth_status' }); this.send({ cmd: 'positions' }); this.videoOn = null; this._video(); } else {
            this.searching = false; this.state = 'idle'; this.pending.clear();
            this.auth = { state: 'unknown', code: null, url: null, msg: null };
            Object.keys(this.feeds).forEach((w) => { this.feeds[w].loading = false; });
        }
        this._changed();
    }
    /** a daemon event */
    onMsg(m) {
        if (m.ev === 'results') {
            if (this.q !== null && m.q !== undefined && m.q !== this.q) return;     // an older search's answer
            this.searching = false; this.searchError = null;
            this.results = valid(m.items);
            this._prune();
        } else if (m.ev === 'thumb') {
            if (typeof m.rgba !== 'string' || !this._known(m.id)) return;
            const w = m.w === undefined ? 160 : m.w, h = m.h === undefined ? 90 : m.h, buf = Buffer.from(m.rgba, 'base64');
            if (SIZES.indexOf(w + 'x' + h) < 0 || buf.length !== w * h * 4) return;     // (stays asked: not asked again)
            this.pending.delete(m.id);
            this.thumbs[m.id] = { w, h, buf };
        } else if (m.ev === 'state') {
            const was = this.state;
            this.state = String(m.state || 'idle');
            if (typeof m.pct === 'number') this.pct = m.pct;
            // another video than the one asked (the daemon's own, after an app restart): title and channel from a list;
            // either way the daemon's title wins unless it is only the id (said while preparing)
            if (m.id !== undefined && m.id !== this.id) { const r = this.item(m.id); this.id = m.id; this.title = r ? String(r.title || '') : ''; this.channel = r ? String(r.channel || '') : ''; }
            const t = m.title === undefined ? '' : String(m.title || '');
            if (t && (t !== this.id || !this.title)) this.title = t;
            if (this.state !== 'error') this.error = null;
            if (this.state !== 'preparing') this.retry = 0;
            if (this.state === 'idle' || (was !== 'preparing' && this.state === 'preparing')) { this.elapsed = 0; this.total = 0; }
            // a fresh ytdec starts with video on: tell it again where we are
            if (this.state === 'playing' && was !== 'playing' && was !== 'paused') { this.videoOn = null; this._video(); }
        } else if (m.ev === 'auth') {
            this.auth = { state: String(m.state || 'signed_out'), code: m.code ? String(m.code) : null, url: typeof m.url === 'string' ? m.url : null, msg: m.msg ? String(m.msg) : null };
            if (this.auth.state !== 'signed_in') { this.feeds = {}; this.chans = null; this.chan = null; this._prune(); }   // signed out: nobody's feed left on screen
        } else if (m.ev === 'channels') {
            if (!this.chans) return;
            this.chans.loading = false;
            if (m.error) this.chans.error = String(m.error); else {
                this.chans.error = null;
                this.chans.items = (Array.isArray(m.items) ? m.items : []).filter((c) => c && /^UC[\w-]{22}$/.test(c.id))
                    .map((c) => ({ id: c.id, title: String(c.title || c.id), handle: String(c.handle || ''), key: fold(c.title) }));
            }
        } else if (m.ev === 'channel') {
            const c = this.chan;
            if (!c || m.id !== c.id) return;                                          // another channel's late answer
            c.loading = false;
            if (m.error) c.error = String(m.error); else {
                c.error = null; c.items = valid(m.items, FEED_MAX);
                c.shelves = (Array.isArray(m.shelves) ? m.shelves : []).filter((x) => x && typeof x === 'object')
                    .map((x) => ({ title: String(x.title || ''), items: valid(x.items, SHELF_MAX) })).filter((x) => x.items.length).slice(0, SHELVES);
                this._prune();
            }
        } else if (m.ev === 'feed') {
            if (FEEDS.indexOf(m.which) < 0) return;
            const f = this.feeds[m.which] = this.feeds[m.which] || { items: [] };
            f.loading = false;
            if (m.error) f.error = String(m.error); else {
                f.error = null; f.items = valid(m.items, FEED_MAX);
                // shelves: none (an older daemon, or a playlist) = the flat list as a grid
                f.shelves = (Array.isArray(m.shelves) ? m.shelves : []).filter((s) => s && typeof s === 'object')
                    .map((s) => ({ title: String(s.title || ''), items: valid(s.items, SHELF_MAX) })).filter((s) => s.items.length).slice(0, SHELVES);
                if (!f.shelves.length) f.shelves = null;
                this._prune();
            }
        } else if (m.ev === 'positions') {
            this.pos = {};
            valid(m.items, 300).forEach((r) => { if (r.total > 0) this.pos[r.id] = r; });
            this.resume = valid(m.items, 300).filter((r) => r.total > 0 && !r.done && r.ms > 10000).slice(0, SHELF_MAX);
            this._prune();
        } else if (m.ev === 'extras') {
            this.extras = { id: String(m.id), chapters: (Array.isArray(m.chapters) ? m.chapters : []).filter((c) => Array.isArray(c) && c[0] >= 0),
                segments: (Array.isArray(m.segments) ? m.segments : []).filter((c) => Array.isArray(c) && c[1] > c[0]) };
        } else if (m.ev === 'retry') {
            if (m.id === this.id) this.retry = Number(m.n) || 1;   // the fetch failed (the network): the daemon tries again
        } else if (m.ev === 'skipped') {
            const names = { sponsor: 'sponsor', selfpromo: 'self-promotion', interaction: 'like & subscribe reminder', intro: 'intro' };
            this.toast = { text: 'Skipped ' + (names[m.category] || 'segment') + ' · ' + clock(m.ms), until: Date.now() + 4000 };
        } else if (m.ev === 'time') {
            if (typeof m.elapsed === 'number') this.elapsed = m.elapsed;
            if (typeof m.total === 'number') this.total = m.total;
        } else if (m.ev === 'error') {
            // a daemon older than the account commands: no sign-in, nothing wrong with playback
            if (/^unknown cmd (auth|auth_status|sign_out|feed)$/.test(m.msg)) { this.auth = { state: 'unsupported', code: null, url: null, msg: null }; this._changed(); return; }
            this.error = String(m.msg || 'error');
            if (this.searching) { this.searching = false; this.searchError = this.error; }
        } else return;
        this._changed();
    }

    _items() {
        const f = FEEDS.map((w) => this.feeds[w]).filter(Boolean);
        if (this.chan) f.push(this.chan);
        return this.results.concat(this.resume, ...f.map((x) => x.items || []), ...f.map((x) => [].concat(...(x.shelves || []).map((s) => s.items))));
    }
    _known(id) { return this._items().some((r) => r.id === id); }
    /** an item by its id (the first list that has it), or null */
    item(id) { return this._items().find((r) => r.id === id) || null; }
    /** drop the thumbs (and the requests) of ids no list shows any more */
    _prune() {
        const ids = new Set(this._items().map((r) => r.id));
        Object.keys(this.thumbs).forEach((id) => { if (!ids.has(id)) delete this.thumbs[id]; });
        this.pending.forEach((id) => { if (!ids.has(id)) this.pending.delete(id); });
    }
    /** the chapter playing (its title), or null */
    chapter() {
        const x = this.extras;
        if (!x || x.id !== this.id || !x.chapters.length) return null;
        let c = null;
        x.chapters.forEach((k) => { if (k[0] <= this.elapsed) c = k; });
        return c ? String(c[1]) : null;
    }
    /** a stream lookup ahead of a likely play (the daemon skips cached and fresh ones) */
    prefetch(id) { return this.connected && this._known(id) ? this.send({ cmd: 'prefetch', id }) : false; }
    /** the screens draw item id: its thumb asked once (until it comes, or the item goes), if not held; true when asked now */
    wantThumb(id) {
        if (this.thumbs[id] || this.pending.has(id) || !this.connected || !this._known(id)) return false;
        if (!this.send({ cmd: 'thumb', id })) return false;
        this.pending.add(id);
        return true;
    }
    /** a search with no answer after ms: an error, never a screen waiting for ever */
    checkSearch(now, ms) {
        if (!this.searching || now - this.searchT < ms) return false;
        this.searching = false; this.searchError = 'No answer from the RideTube service';
        this._changed();
        return true;
    }
    search(q) {
        q = String(q || '').trim();
        if (!q) return false;
        this.q = q; this.searching = true; this.searchError = null; this.searchT = Date.now();
        this._changed();
        if (this.send({ cmd: 'search', q })) return true;
        this.searching = false; this.searchError = 'The RideTube service (jap-ridetube-d) is not running';
        return false;
    }
    /** it: the tile tapped ({title, channel}), else the lists' item: shown until the daemon says its own title */
    /** o: { quality, skip } (the settings), sent as they are */
    play(id, rect, fill, it, o) {
        const r = it || this.item(id);
        this.id = id; this.title = r ? String(r.title || '') : ''; this.channel = r ? String(r.channel || '') : ''; this.state = 'preparing'; this.pct = 0; this.elapsed = 0; this.total = 0; this.error = null; this.retry = 0;
        this._changed();
        // the account's own resume point (the tile's), used by the daemon when this car never played it
        return this.send(Object.assign({ cmd: 'play', id, rect, fill: !!fill }, r && r.start_s > 0 ? { at: r.start_s * 1000 } : {}, o || {}));
    }
    toggle() {
        if (this.state === 'playing') return this.send({ cmd: 'pause' });
        if (this.state === 'paused') return this.send({ cmd: 'resume' });
        return false;
    }
    /** seek by delta ms, clamped into the video */
    skip(delta) {
        if (this.state !== 'playing' && this.state !== 'paused') return false;
        let ms = this.elapsed + delta;
        if (this.total > 0) ms = Math.min(ms, Math.max(0, this.total - 1000));
        ms = Math.max(0, Math.round(ms));
        this.elapsed = ms;
        this._changed();
        return this.send({ cmd: 'seek', ms });
    }
    /** ask the daemon for a sign-in code (it says the one shown again, or signed in); retry: after an error too */
    authStart(retry) {
        const st = this.auth.state;
        if (!this.connected || !(st === 'signed_out' || (retry && st === 'error'))) return false;
        this.auth = { state: 'asking', code: null, url: null, msg: null };
        this._changed();
        return this.send({ cmd: 'auth' });
    }
    signOut() { return this.auth.state === 'signed_in' ? this.send({ cmd: 'sign_out' }) : false; }
    /** (re)load feed which (home|subs|wl); its items stay shown meanwhile */
    feed(which) {
        if (FEEDS.indexOf(which) < 0) return false;
        const f = this.feeds[which] = this.feeds[which] || { items: [] };
        if (f.loading || this.auth.state !== 'signed_in') return false;
        f.loading = true; f.error = null; f.t = Date.now();
        this._changed();
        if (this.send({ cmd: 'feed', which })) return true;
        f.loading = false; f.error = 'The RideTube service (jap-ridetube-d) is not running';
        return false;
    }
    /** a feed with no answer after ms: an error, as for searches */
    checkFeeds(now, ms) {
        let any = false;
        FEEDS.map((w) => this.feeds[w]).concat([this.chans, this.chan])
            .forEach((f) => { if (f && f.loading && now - f.t >= ms) { f.loading = false; f.error = 'No answer from the RideTube service'; any = true; } });
        if (any) this._changed();
        return any;
    }
    stop() { return this.active() ? this.send({ cmd: 'stop' }) : false; }
    /** while playing: the same video again at this quality, from where it is */
    quality(q) { return this.active() ? this.send({ cmd: 'quality', quality: q }) : false; }
    /** fill (crop to the screen) or fit (the whole picture) for the playing video */
    fill(on) { return this.active() ? this.send({ cmd: 'fill', on: !!on }) : false; }
    /** (re)load the subscribed channels (the daemon keeps them 10 min); shown meanwhile */
    loadChannels() {
        const c = this.chans = this.chans || { items: [] };
        if (c.loading || this.auth.state !== 'signed_in') return false;
        c.loading = true; c.error = null; c.t = Date.now();
        this._changed();
        if (this.send({ cmd: 'channels' })) return true;
        c.loading = false; c.error = 'The RideTube service (jap-ridetube-d) is not running';
        return false;
    }
    /** the channels whose name starts with q (one letter or digit), else holds q (also the @handle); case and accents aside */
    findChannels(q) {
        const all = (this.chans && this.chans.items) || [], k = fold(q);
        if (!k) return all;
        if (k.length === 1) return all.filter((c) => c.key.charAt(0) === k);
        return all.filter((c) => c.key.indexOf(k) >= 0 || fold(c.handle).indexOf(k) >= 0);
    }
    /** show channel id's page (title: its name, until it loads) */
    openChannel(id, title) {
        const same = this.chan && this.chan.id === id;
        if (!same) { this.chan = { id, title: String(title || ''), items: [], shelves: null }; this._prune(); }
        const c = this.chan;
        if (c.loading) return false;
        c.loading = true; c.error = null; c.t = Date.now();
        this._changed();
        if (this.send({ cmd: 'channel', id })) return true;
        c.loading = false; c.error = 'The RideTube service (jap-ridetube-d) is not running';
        return false;
    }
    /** video wanted (player on screen and the car parked): tells the daemon when that changes */
    setWantVideo(on) { this.wantVideo = !!on; this._video(); }
    _video() {
        if (!this.connected || this.videoOn === this.wantVideo) return;
        if (this.send({ cmd: 'video', on: this.wantVideo })) this.videoOn = this.wantVideo;
    }
}

/** "Élise Atelier" -> "elise atelier": what a channel search compares */
function fold(t) {
    let s = String(t || '');
    try { s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); } catch (e) { /* a Node without ICU: accents kept */ }
    return s.toLowerCase().trim();
}
function valid(items, n) { return (Array.isArray(items) ? items : []).filter((r) => r && typeof r.id === 'string').slice(0, n || 10); }

/** 83000 -> "1:23", 3723000 -> "1:02:03" */
function clock(ms) {
    const s = Math.max(0, Math.floor((ms || 0) / 1000)), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, ss = s % 60;
    const p = (n) => (n < 10 ? '0' : '') + n;
    return h ? h + ':' + p(m) + ':' + p(ss) : m + ':' + p(ss);
}

module.exports = { Ctl, Model, clock, SOCKET, FEEDS, FEED_MAX, SHELF_MAX };
