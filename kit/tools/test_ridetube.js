'use strict';

// RideTube (apps/jap_ridetube): the control-socket client and the playback state against a fake jap-ridetube-d daemon on a
// temporary Unix socket; then, when dist/jap_ridetube is built, one results and one player frame through the stubbed
// head unit into a renderer stream (pictures as message 10, the video as 13 + op 19), the feed tabs, the sign-in
// page and signing out; where the kit runs the screen: the rail and the bar, Home's shelves (arrows, the controller
// bringing any tile into view, thumbs asked for the drawn tiles only, the picture pool). No SDK or car needed:
//   node kit/tools/test_ridetube.js

const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { Ctl, Model, clock } = require('../../apps/jap_ridetube/yt');

const quiet = { info() {}, warn() {}, error(m, e) { throw e || new Error(m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, what) {
    const end = Date.now() + (ms || 3000);
    while (!fn()) { if (Date.now() > end) throw new Error('timed out: ' + what); await sleep(10); }
}

// the daemon got obj as its last command (the socket delivers a moment later)
async function lastIs(d, obj, msg) {
    try { await until(() => JSON.stringify(d.got.filter((m) => m.cmd === obj.cmd).slice(-1)[0]) === JSON.stringify(obj), 2000, msg); } catch (e) {
        assert.deepStrictEqual(d.got.filter((m) => m.cmd === obj.cmd).slice(-1)[0], obj, msg);
    }
}

function fakeDaemon(sock) {
    const d = { got: [], conn: null, conns: 0 };
    d.server = net.createServer((c) => {
        d.conn = c; d.conns++;
        let buf = '';
        c.setEncoding('utf8');
        c.on('data', (x) => {
            buf += x;
            let i;
            while ((i = buf.indexOf('\n')) >= 0) { d.got.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); }
        });
        c.on('error', () => {});
    });
    d.send = (o) => d.conn.write(JSON.stringify(o) + '\n');
    d.cmds = (cmd) => d.got.filter((m) => m.cmd === cmd);
    return new Promise((r) => d.server.listen(sock, () => r(d)));
}

async function clientAndModel() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-'));
    const sock = path.join(dir, 'ctl.sock');
    const d = await fakeDaemon(sock);
    const ctl = new Ctl(sock, quiet);
    const m = new Model((o) => ctl.send(o));
    ctl.on('up', () => m.setConnected(true)).on('down', () => m.setConnected(false)).on('msg', (x) => m.onMsg(x));
    ctl.connect();
    await until(() => d.cmds('status').length, 2000, 'status on connect');
    assert.ok(m.connected, 'connected');
    await until(() => d.cmds('auth_status').length, 2000, 'auth_status on connect');
    assert.deepStrictEqual(d.got.slice(0, 2), [{ cmd: 'status' }, { cmd: 'auth_status' }], 'on connect: status, then the account (no library: nothing is kept on the car)');

    // first results: no thumb asked on its own (the screens ask for the tiles they draw: wantThumb), each asked once
    assert.ok(m.search('first'));
    d.send({ ev: 'results', q: 'first', items: [{ id: 'lib1', title: 'First' }, { bad: 1 }] });
    await until(() => m.results.length === 1, 2000, 'first results (the bad item dropped)');
    await sleep(50);
    assert.strictEqual(d.cmds('thumb').length, 0, 'no thumb asked before a screen draws one');
    assert.ok(m.wantThumb('lib1') && !m.wantThumb('lib1') && !m.wantThumb('nope'), 'asked once; an unknown id never');
    await lastIs(d, { cmd: 'thumb', id: 'lib1' });
    d.send({ ev: 'thumb', id: 'lib1', w: 160, h: 90, rgba: Buffer.alloc(57600, 9).toString('base64') });
    await until(() => m.thumbs.lib1, 2000, 'thumb stored');
    assert.deepStrictEqual([m.thumbs.lib1.w, m.thumbs.lib1.h, m.thumbs.lib1.buf.length, m.pending.size], [160, 90, 57600, 0], '160x90 kept, no longer pending');
    assert.ok(!m.wantThumb('lib1'), 'held: not asked again');
    d.got.length = 0;

    // proxy offline: the daemon's error ends the search
    assert.ok(m.search('offline test'));
    d.send({ ev: 'error', msg: 'search offline' });
    await until(() => !m.searching, 2000, 'offline error');
    assert.strictEqual(m.searchError, 'search offline', 'the daemon text shown on the search screen');
    // no answer at all: the app gives up on its own
    m.search('silent');
    assert.ok(m.searching && !m.checkSearch(Date.now(), 8000), 'still waiting at first');
    assert.ok(m.checkSearch(Date.now() + 9000, 8000) && !m.searching && /No answer/.test(m.searchError), 'no answer in 8 s: an error');
    d.got.length = 0;

    // search -> results (thumbs asked by the screen, see wantThumb)
    assert.ok(m.search('  cats  '));
    await lastIs(d, { cmd: 'search', q: 'cats' }, 'trimmed query');
    assert.ok(m.searching);
    d.send({ ev: 'results', q: 'dogs', items: [{ id: 'zzz' }] });
    await sleep(50);
    assert.ok(!m.results.some((r) => r.id === 'zzz'), "an older search's results are ignored");
    const items = [{ id: 'aaa', title: 'Cat video', channel: 'Cats', duration_s: 83 }, { id: 'bbb', title: 'More cats', channel: 'C', duration_s: 3723 }, { title: 'no id' }];
    d.send({ ev: 'results', q: 'cats', items });
    await until(() => m.results.length === 2, 2000, 'results');
    assert.strictEqual(m.searchError, null, 'results clear the last search error');
    assert.ok(!m.searching && m.results.length === 2);
    assert.ok(m.wantThumb('aaa') && m.wantThumb('bbb'));
    await until(() => d.cmds('thumb').length === 2, 2000, 'thumb requests');
    // a thumb: 160x90 (0.1.5 daemon, a line of 76.8 kB) or 320x180 (0.1.6, 307 kB) RGBA base64; anything else dropped
    d.send({ ev: 'thumb', id: 'aaa', w: 160, h: 90, rgba: Buffer.alloc(160 * 90 * 4, 200).toString('base64') });
    d.send({ ev: 'thumb', id: 'bbb', w: 160, h: 90, rgba: Buffer.alloc(10).toString('base64') });
    d.send({ ev: 'thumb', id: 'bbb', w: 200, h: 72, rgba: Buffer.alloc(57600).toString('base64') });
    d.send({ ev: 'thumb', id: 'nope', w: 160, h: 90, rgba: Buffer.alloc(160 * 90 * 4).toString('base64') });
    await until(() => m.thumbs.aaa, 2000, 'thumb');
    await sleep(30);
    assert.strictEqual(m.thumbs.aaa.buf.length, 57600);
    assert.ok(!m.thumbs.bbb && !m.thumbs.nope, 'wrong size or unknown id dropped');
    assert.ok(!m.wantThumb('bbb'), 'a bad thumb is not asked again in a loop');
    d.send({ ev: 'thumb', id: 'bbb', w: 320, h: 180, rgba: Buffer.alloc(320 * 180 * 4, 7).toString('base64') });
    await until(() => m.thumbs.bbb, 2000, '320x180 thumb');
    assert.deepStrictEqual([m.thumbs.bbb.w, m.thumbs.bbb.h, m.pending.size], [320, 180, 0], '320x180 kept');

    // play -> preparing -> playing; buttons
    m.play('aaa', '1836x504', false);
    await lastIs(d, { cmd: 'play', id: 'aaa', rect: '1836x504', fill: false });
    assert.strictEqual(m.state, 'preparing');
    assert.ok(m.active(), 'preparing holds the app active');
    assert.strictEqual(m.toggle(), false, 'no pause while preparing');
    d.send({ ev: 'state', state: 'preparing', pct: 42, id: 'aaa', title: 'Cat video' });
    await until(() => m.pct === 42, 2000, 'pct');
    m.setWantVideo(true);
    await lastIs(d, { cmd: 'video', on: true }, 'player shown, parked: video on');
    const nVideo = d.cmds('video').length;
    d.send({ ev: 'state', state: 'playing', pct: 100, id: 'aaa', title: 'Cat video' });
    d.send({ ev: 'time', elapsed: 5000, total: 60000 });
    await until(() => m.elapsed === 5000, 2000, 'time');
    await until(() => d.cmds('video').length > nVideo, 2000, 'video again');
    assert.deepStrictEqual(d.cmds('video').slice(nVideo), [{ cmd: 'video', on: true }], 'playback start: video state told again');
    m.toggle();
    await lastIs(d, { cmd: 'pause' });
    d.send({ ev: 'state', state: 'paused', id: 'aaa', title: 'Cat video' });
    await until(() => m.state === 'paused', 2000, 'paused');
    m.toggle();
    await lastIs(d, { cmd: 'resume' });
    m.skip(-10000);
    await lastIs(d, { cmd: 'seek', ms: 0 }, '-10 s clamps at 0');
    m.elapsed = 55000; m.skip(10000);
    await lastIs(d, { cmd: 'seek', ms: 59000 }, '+10 s clamps 1 s before the end');
    m.setWantVideo(false);
    await lastIs(d, { cmd: 'video', on: false }, 'driving or hidden: video off');
    await sleep(50);
    const n = d.got.length;
    m.setWantVideo(false);
    await sleep(50);
    assert.strictEqual(d.got.length, n, 'no repeat while unchanged');
    d.send({ ev: 'error', msg: 'proxy down' });
    await until(() => m.error === 'proxy down', 2000, 'error');
    d.send({ ev: 'state', state: 'idle' });
    await until(() => m.state === 'idle', 2000, 'idle');
    assert.ok(!m.active() && m.error === null && m.elapsed === 0);
    assert.strictEqual(m.stop(), false, 'nothing to stop');

    // the account: a code asked once, signed in, a feed (at most 20, thumbs asked), no answer, signed out
    d.got.length = 0;
    assert.strictEqual(m.authStart(), false, 'no code asked before the daemon said signed out');
    d.send({ ev: 'auth', state: 'signed_out' });
    await until(() => m.auth.state === 'signed_out', 2000, 'signed out');
    assert.ok(m.authStart() && m.auth.state === 'asking' && !m.authStart(), 'asked once');
    await lastIs(d, { cmd: 'auth' });
    d.send({ ev: 'auth', state: 'code', code: 'ABC-DEF-GHIJ', url: 'https://www.google.com/device', expires: 1800 });
    await until(() => m.auth.code === 'ABC-DEF-GHIJ', 2000, 'code');
    assert.strictEqual(m.feed('home'), false, 'no feed while signed out');
    d.send({ ev: 'auth', state: 'error', msg: 'timeout' });
    await until(() => m.auth.state === 'error', 2000, 'auth error');
    assert.ok(!m.authStart() && m.authStart(true), 'after an error only a retry asks again');
    d.send({ ev: 'auth', state: 'signed_in' });
    await until(() => m.auth.state === 'signed_in', 2000, 'signed in');
    d.got.length = 0;
    assert.ok(m.feed('subs') && !m.feed('subs') && m.feeds.subs.loading, 'one feed request at a time');
    await lastIs(d, { cmd: 'feed', which: 'subs' });
    const many = Array.from({ length: 25 }, (_, i) => ({ id: 'sub' + i, title: 'Sub ' + i, channel: 'C', duration_s: 60, meta: ['1K views', '2 days ago'] }));
    d.send({ ev: 'feed', which: 'subs', items: many.concat([{ bad: 1 }]) });
    await until(() => m.feeds.subs.items.length, 2000, 'feed');
    assert.ok(m.feeds.subs.items.length === 20 && !m.feeds.subs.loading && m.feeds.subs.error === null, 'at most 20');
    assert.strictEqual(m.feeds.subs.shelves, null, 'no shelves (an older daemon): none');
    assert.deepStrictEqual(m.feeds.subs.items[0].meta, ['1K views', '2 days ago'], 'meta kept');
    await sleep(30);
    assert.strictEqual(d.cmds('thumb').length, 0, 'a feed asks no thumbs on its own');
    // shelves: at most 8 of at most 12 videos, empty ones dropped, [] = none; their videos are known (thumbs, titles)
    const shelf = (k, n) => ({ title: 'Shelf ' + k, items: Array.from({ length: n }, (_, i) => ({ id: 's' + k + '_' + i, title: 'T' + k + '.' + i })) });
    d.send({ ev: 'feed', which: 'subs', items: many, shelves: [shelf(0, 15), { title: 'empty', items: [] }, 'bad'].concat(Array.from({ length: 9 }, (_, k) => shelf(k + 1, 3))) });
    await until(() => m.feeds.subs.shelves, 2000, 'shelves');
    assert.deepStrictEqual(m.feeds.subs.shelves.map((x) => x.items.length), [12, 3, 3, 3, 3, 3, 3, 3], 'shelves capped');
    assert.strictEqual(m.feeds.subs.shelves[0].title, 'Shelf 0');
    assert.ok(m.item('s1_2') && m.item('s1_2').title === 'T1.2' && m.wantThumb('s1_2'), 'a shelf video is known');
    d.send({ ev: 'feed', which: 'subs', items: many, shelves: [] });
    await until(() => m.feeds.subs.shelves === null, 2000, 'shelves [] = none');
    assert.ok(!m.pending.has('s1_2'), 'its video gone: no longer pending');
    d.send({ ev: 'thumb', id: 'sub3', w: 160, h: 90, rgba: Buffer.alloc(57600, 1).toString('base64') });
    await until(() => m.thumbs.sub3, 2000, 'feed thumb kept');
    m.play('sub3', '1280x720', false);
    assert.strictEqual(m.title, 'Sub 3', 'a feed item plays with its title');
    // the tile tapped: its title and channel, kept while the daemon says only the id; its own title then wins
    m.play('zzz', '1280x720', false, { id: 'zzz', title: 'Tapped tile', channel: 'Its channel' });
    d.send({ ev: 'state', state: 'preparing', pct: 5, id: 'zzz', title: 'zzz' });
    await until(() => m.pct === 5, 2000, 'preparing zzz');
    assert.deepStrictEqual([m.title, m.channel], ['Tapped tile', 'Its channel'], 'the id is not shown as the title');
    d.send({ ev: 'state', state: 'playing', id: 'zzz', title: 'Real title' });
    await until(() => m.state === 'playing', 2000, 'playing zzz');
    assert.strictEqual(m.title, 'Real title', "the daemon's own title");
    d.send({ ev: 'state', state: 'playing', id: 'sub4', title: 'sub4' });
    await until(() => m.id === 'sub4', 2000, 'another video');
    assert.deepStrictEqual([m.title, m.channel], ['Sub 4', 'C'], "another video (the daemon's, only its id said): title and channel from the list");
    d.send({ ev: 'state', state: 'idle' });
    m.feed('wl');
    assert.ok(!m.checkFeeds(Date.now(), 15000) && m.checkFeeds(Date.now() + 16000, 15000) && /No answer/.test(m.feeds.wl.error), 'no answer in 15 s: an error');
    m.feeds.wl.loading = false;
    m.feed('wl');
    d.send({ ev: 'feed', which: 'wl', error: 'feed offline' });
    await until(() => m.feeds.wl.error === 'feed offline', 2000, 'feed error');
    assert.strictEqual(m.error, null, 'a feed error is not a playback error');
    d.got.length = 0;
    assert.ok(m.signOut());
    await lastIs(d, { cmd: 'sign_out' });
    d.send({ ev: 'auth', state: 'signed_out' });
    await until(() => m.auth.state === 'signed_out', 2000, 'signed out again');
    assert.deepStrictEqual(m.feeds, {}, 'signed out: the feeds are gone');
    assert.ok(!m.thumbs.sub3, 'and their thumbs');
    // an older daemon: no sign-in, and nothing shown as an error
    d.send({ ev: 'error', msg: 'unknown cmd auth_status' });
    await until(() => m.auth.state === 'unsupported', 2000, 'unsupported');
    assert.strictEqual(m.error, null);

    // a bad line is skipped, the next one read
    d.conn.write('not json\n{"ev":"time","elapsed":1,"total":2}\n');
    await until(() => m.total === 2, 2000, 'line after a bad one');

    // the daemon goes away and comes back: reconnect within 2 s, status asked again
    const statuses = d.cmds('status').length;
    m.onMsg({ ev: 'results', q: m.q, items: [{ id: 'lib2', title: 'Second' }] });
    assert.ok(m.wantThumb('lib2'), 'lib2 asked');
    d.conn.destroy();
    await until(() => !m.connected, 2000, 'down');
    assert.strictEqual(m.send({ cmd: 'status' }), false, 'commands dropped while down');
    assert.strictEqual(m.pending.size, 0, 'down: what was asked is asked again once back');
    await until(() => d.conns === 2, 3500, 'reconnect');
    await until(() => d.cmds('status').length === statuses + 1, 2000, 'status after reconnect');
    ctl.close();
    d.server.close();
    assert.strictEqual(clock(83000), '1:23');
    assert.strictEqual(clock(3723000), '1:02:03');
    console.log('ok   ctl client + state machine');
}

// renderer stream: message types, picture ids drawn (op 18, native form: id in word 6), whether video 1 is drawn (op 19)
function scan(s) {
    const r = { types: [], pics: [], all: [], frames: [], op19: false, vrect: null, xf: false };
    for (let o = 0; o + 8 <= s.length;) {
        const t = s.readUInt32LE(o), len = s.readUInt32LE(o + 4);
        r.types.push(t);
        if (t === 7) { r.pics = []; r.frames.push(r.pics); r.vrect = null; }   // vrect: the last frame's
        if (t === 7) for (let i = o + 8; i + 28 <= o + 8 + len; i += 4) {
            const w = s.readUInt32LE(i);
            if (w === 19 && s.readUInt32LE(i + 24) === 1) { r.op19 = true; r.vrect = [4, 8, 12, 16].map((k) => s.readFloatLE(i + k)); }
            if (w === 18 && s.readUInt32LE(i + 24) > 0 && s.readUInt32LE(i + 24) < 4096) { r.pics.push(s.readUInt32LE(i + 24)); r.all.push(s.readUInt32LE(i + 24)); }
        }
        o += 8 + len;
    }
    return r;
}

// the app itself, drawn into a renderer stream (preview path of kit/tools/hu-stub.js)
async function appFrames() {
    const stage = path.join(__dirname, '..', '..', 'dist', 'jap_ridetube');
    if (!fs.existsSync(path.join(stage, 'source', 'javascript', 'app.js'))) { console.log('skip app frames (python3 kit/tools/build.py jap_ridetube first)'); return; }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-app-'));
    const sock = path.join(dir, 'ctl.sock'), file = path.join(dir, 'stream.bin');
    const d = await fakeDaemon(sock);
    process.env.MGU_YT_SOCKET = sock;
    process.env.MGU_RENDERD_FILE = file;
    const vfile = process.env.MGU_YT_VIDEO = path.join(dir, 'mgu-video-ridetube');
    const { headUnit } = require('./hu-stub');
    const hu = headUnit(stage, { dataDir: dir, fresh: true, image: () => Promise.resolve(), log: quiet });
    const disp = hu.display;
    // parked: the car reads 0 km/h (the video gate counts no speed as moving)
    let speedH = null;
    let batH = null;
    hu.ctx.signals = { watch: async (i, n, h) => { if (h && h.statusCarSpeed2) { speedH = h.statusCarSpeed2; speedH({ speedVehicleCentreOfGravity: 0 }); } if (h && h.statusBattery2) batH = h.statusBattery2; return {}; } };
    // (the stub's ctx predates these: as kit/mgu.js)
    hu.ctx.hideButton = (id, hide) => disp.hideButton(id, hide);
    hu.ctx.onPageFocus = (fn) => { disp.onPageFocus = fn; };
    hu.ctx.focus = (k) => disp.focusPage(k);
    hu.start();
    await until(() => d.cmds('auth_status').length, 3000, 'app connects and asks for the account');
    const POOL = (id) => id >= 8 && id < 64;
    const frame = () => scan(fs.readFileSync(file));
    // first screen: Home, signed out: the sign-in card, no tiles; never a library (nothing is kept on the car)
    await hu.ui.open('VIEW');
    await hu.loopFn();
    await sleep(100);
    assert.strictEqual(d.cmds('thumb').length, 0, 'no tiles, no thumbs');
    assert.strictEqual(d.cmds('library').length, 0, 'no library asked');
    // recent search -> results with a 320x180 thumb
    hu.handlers.BTN_S1();
    await until(() => d.cmds('search').length, 2000, 'search');
    assert.deepStrictEqual(d.cmds('search')[0], { cmd: 'search', q: 'Music' }, 'first suggestion');
    d.send({ ev: 'results', q: 'Music', items: [{ id: 'aaa', title: 'Song', channel: 'Band', duration_s: 200, meta: ['5 views'] }] });
    await sleep(100);
    await hu.loopFn();
    await until(() => d.cmds('thumb').some((x) => x.id === 'aaa'), 2000, 'results thumb asked');
    d.send({ ev: 'thumb', id: 'aaa', w: 320, h: 180, rgba: Buffer.alloc(320 * 180 * 4, 255).toString('base64') });
    await sleep(100);
    await hu.loopFn();
    assert.ok(frame().pics.some(POOL), 'results frame draws its 320x180 thumb');
    // offline search: the error, drawn, no hang
    hu.handlers.BTN_S2();
    await until(() => d.cmds('search').length === 2, 2000, 'second search');
    d.send({ ev: 'error', msg: 'search offline' });
    await sleep(100);
    await hu.loopFn();
    // player: video file there -> VIDEO + op 19
    fs.writeFileSync(vfile, '');
    hu.handlers.BTN_NOW();
    d.send({ ev: 'state', state: 'playing', id: 'aaa', title: 'Song' });
    d.send({ ev: 'time', elapsed: 1000, total: 200000 });
    await sleep(400);              // the 250 ms gate
    await hu.loopFn();
    const f = frame();
    assert.ok(f.types.indexOf(10) >= 0, 'the thumbnails uploaded as pictures (10)');
    assert.ok(f.types.indexOf(13) >= 0, 'VIDEO (13) names the decoder file');
    assert.ok(f.op19, 'player frame draws video 1 (op 19)');
    const plays = d.cmds('video');
    assert.deepStrictEqual(plays.slice(-1)[0], { cmd: 'video', on: true }, 'player shown and parked: video on');
    // where the kit runs the screen (a renderer that routes touch, full-screen layout): no bar; the player covers the
    // whole screen with its overlay (targets ov:*), a tap beside them hides it, any tap or the controller shows it
    disp.gpu.touch = true; disp._place();
    await hu.loopFn();
    const own = disp.own();
    const bar = () => disp.buttons().map((b) => b.id);
    const pl = disp.place;
    const keys = () => disp.pageTargets.map((x) => x.key);
    if (own && pl && pl.full) {
        assert.deepStrictEqual(bar(), [], 'no bar where the kit runs the screen');
        assert.ok(pl.extra > 0, 'so the page reaches the screen bottom: extra ' + pl.extra);
        assert.deepStrictEqual(frame().vrect, [0, 0, pl.w, pl.h], 'the player: the video over the whole screen at once');
        assert.deepStrictEqual(keys(), ['ov:back', 'ov:qr', 'ov:rw', 'ov:play', 'ov:ff', 'ov:q', 'ov:zoom', 'ov:bar'], 'the overlay controls');
        // Quality: auto -> 720 (the setting too); zoom: whole picture (default, 0.3.6) -> fill
        disp.pageTargets.find((t) => t.key === 'ov:q').run();
        await lastIs(d, { cmd: 'quality', quality: '720' }, 'Quality: the next one');
        assert.strictEqual(hu.ctx.settings.get('quality'), '720');
        await hu.loopFn();
        disp.pageTargets.find((t) => t.key === 'ov:zoom').run();
        await lastIs(d, { cmd: 'fill', on: true }, 'Zoom: fill the screen');
        assert.strictEqual(hu.ctx.settings.get('fill'), true);
        hu.ctx.settings.set('quality', 'auto'); hu.ctx.settings.set('fill', false);
        await hu.loopFn();
        disp.pageTargets.find((t) => t.key === 'ov:qr').run();
        await hu.loopFn();
        assert.deepStrictEqual(keys(), ['ov:back', 'ov:qr', 'ov:qrcard'], 'On phone: the QR card over the controls');
        disp.pageTargets.find((t) => t.key === 'ov:qrcard').run();
        await hu.loopFn();
        disp.pageTargets.find((t) => t.key === 'ov:play').run();
        await lastIs(d, { cmd: 'pause' }, 'play / pause on the overlay');
        disp.pageTargets.find((t) => t.key === 'ov:ff').run();
        await lastIs(d, { cmd: 'seek', ms: 11000 }, '+10 s on the overlay');
        // the knob on the progress bar: 10 s a detent, one seek when it rests (through the kit's controller path)
        const nSeek = d.cmds('seek').length;
        disp.focusKey = 'tgt:ov:bar';
        const knob = (k) => disp._ccu({ frontRotaryEncoderOperation: k, frontRotaryEncoderPushButton: 0, frontRotaryEncoderDeflection: 0 });
        knob(100); knob(102); knob(101);                    // +2 then -1 detents
        assert.strictEqual(disp.focusKey, 'tgt:ov:bar', 'turning on the bar stays on it');
        await sleep(500);
        assert.strictEqual(d.cmds('seek').length, nSeek + 1, 'one seek for the three detents');
        await lastIs(d, { cmd: 'seek', ms: 21000 }, 'the knob on the bar: +10 s net');
        // SponsorBlock "ask" (end cards by default): a Skip button while the clock is in one, the overlay kept
        d.send({ ev: 'extras', id: 'aaa', chapters: [], segments: [[15000, 60000, 'outro']] });
        await sleep(100); await hu.loopFn();
        assert.ok(keys().indexOf('ov:sbskip') >= 0, 'Skip end cards: ' + keys());
        disp.pageTargets.find((t) => t.key === 'ov:sbskip').run();
        await lastIs(d, { cmd: 'seek', ms: 60000 }, 'Skip jumps to its end');
        d.send({ ev: 'extras', id: 'aaa', chapters: [], segments: [] });
        // the 12 V battery under the setting (65 %) while parked and playing: paused, with why
        const nPause = d.cmds('pause').length;
        batH({ conditionBatteryChargingCondition: 62 });
        await until(() => d.cmds('pause').length > nPause, 2500, 'low 12 V battery pauses');
        batH({ conditionBatteryChargingCondition: 90 });
        await hu.loopFn();
        console.log('ok   SponsorBlock Skip button (ask), 12 V battery guard');
        disp.onTap(800, 300);
        await hu.loopFn();
        const hid = disp.pageTargets;
        assert.ok(hid.length === 8 && hid.every((t) => t.w > 1000 && t.h > 500), 'a tap beside them: hidden, each key the whole screen');
        assert.deepStrictEqual(frame().vrect, [0, 0, pl.w, pl.h], 'the video stays whole');
        const pauses = d.cmds('pause').length;
        hid.find((t) => t.key === 'ov:play').run();       // (as the controller pressed on its key, or a tap)
        await hu.loopFn();
        assert.strictEqual(d.cmds('pause').length, pauses, 'hidden, a press only shows the overlay');
        assert.ok(disp.pageTargets.find((t) => t.key === 'ov:play').w < 300, 'shown again');
        disp.onTap(800, 300);
        await hu.loopFn();
        disp.onPageFocus('ov:rw');                           // the knob turned
        await hu.loopFn();
        assert.ok(disp.pageTargets.find((t) => t.key === 'ov:rw').w < 300, 'the controller shows it');
        console.log('ok   full-screen player: overlay controls, hides on a tap, a tap or the controller shows it');
        // driving: podcast mode - no picture, the big controls always there (no overlay to wake)
        speedH({ speedVehicleCentreOfGravity: 50 * 64 });
        const seeks = d.cmds('seek').length;
        await sleep(300); await hu.loopFn();                 // (an unchanged model redraws within 250 ms)
        assert.ok(!frame().vrect, 'no video while driving');
        // Video while driving on (a car coded for video in motion): switched on while moving, it waits for a stop;
        // switched on while parked, the picture stays while moving
        hu.ctx.settings.set('video_driving', true);
        await sleep(300); await hu.loopFn();
        assert.ok(!frame().vrect, 'Video while driving switched on while moving: no picture until parked');
        speedH({ speedVehicleCentreOfGravity: 0 });
        await sleep(300); await hu.loopFn();
        speedH({ speedVehicleCentreOfGravity: 50 * 64 });
        await sleep(300); await hu.loopFn();
        assert.ok(frame().vrect, 'Video while driving: video while moving');
        assert.deepStrictEqual(d.cmds('video').slice(-1)[0], { cmd: 'video', on: true }, 'Video while driving: video on');
        hu.ctx.settings.set('video_driving', false);
        await sleep(300); await hu.loopFn();
        assert.ok(!frame().vrect, 'setting off: no video while driving again');
        console.log('ok   Video while driving setting keeps the picture while moving');
        ['ov:rw', 'ov:play', 'ov:ff'].forEach((k) => assert.ok(disp.pageTargets.some((t) => t.key === k && t.w > 120 && t.w < 300), 'podcast control ' + k + ': ' + keys()));
        disp.pageTargets.find((t) => t.key === 'ov:ff').run();
        await until(() => d.cmds('seek').length > seeks, 2000, 'a podcast +10 s');
        assert.ok(disp.pageTargets.some((t) => t.key === 'ov:bar' && t.turn), 'podcast: the knob seeks on the bar');
        // a failed play while driving: Try again in the middle (the same video)
        d.send({ ev: 'state', state: 'error', id: 'aaa', title: 'Song' }); d.send({ ev: 'error', msg: 'fetch: boom' });
        await sleep(300); await hu.loopFn();
        const nPlay = d.cmds('play').length;
        disp.pageTargets.find((t) => t.key === 'ov:play').run();
        await until(() => d.cmds('play').length > nPlay, 2000, 'Try again plays it again');
        assert.strictEqual(d.cmds('play').slice(-1)[0].id, 'aaa');
        assert.strictEqual(d.cmds('play').slice(-1)[0].quality, 'auto', 'the Video quality setting goes with each play');
        assert.deepStrictEqual(d.cmds('play').slice(-1)[0].skip, ['sponsor', 'selfpromo', 'interaction', 'intro'], 'and the SponsorBlock categories skipped');
        d.send({ ev: 'state', state: 'playing', id: 'aaa', title: 'Song' }); d.send({ ev: 'time', elapsed: 21000, total: 200000 });
        speedH({ speedVehicleCentreOfGravity: 0 });
        await sleep(300); await hu.loopFn();
        console.log('ok   podcast mode while driving: no picture, big controls, knob seek, Try again');
    } else console.log('skip full-screen player (the stub has no full-screen placement)');
    // back to the list (the overlay's back, or the bar's list button where the HMI runs the screen): DROP_VIDEO
    if (own) disp.pageTargets.find((t) => t.key === 'ov:back').run(); else hu.handlers.BTN_LIST();
    await sleep(50);
    assert.ok(frame().types.indexOf(14) >= 0, 'leaving the player sends DROP_VIDEO');
    await lastIs(d, { cmd: 'video', on: false }, 'and tells the daemon video off');
    if (own) {
        await hu.loopFn();
        assert.ok(keys().indexOf('rail:player') >= 0, 'browsing while a video plays: Playing on the rail: ' + keys());
        assert.ok(disp.onBack(false) === false && disp.onBack(true) === false, 'browsing: the controller pushed left is the kit\'s (leaves the app at the edge)');
        disp.pageTargets.find((t) => t.key === 'rail:player').run();
        await hu.loopFn();
        assert.ok(keys().indexOf('ov:play') >= 0, 'the rail\'s Playing opens the player');
        assert.ok(disp.onBack(false) === true, 'the controller pushed left in the player: taken');
        await hu.loopFn();
        assert.ok(keys().indexOf('rail:player') >= 0, 'and back on the list');
        d.send({ ev: 'state', state: 'idle' });
        await sleep(100);
        assert.deepStrictEqual(bar(), [], 'nothing playing: no bar either');
        d.send({ ev: 'results', q: d.cmds('search').slice(-1)[0].q, items: [{ id: 'lib1', title: 'First', channel: 'Me', duration_s: 60 }, { id: 'lib2', title: 'Second' }] });
        await sleep(100);
        hu.handlers.BTN_RESULTS();           // (the search's results page)
        await hu.loopFn();
        const ks = keys();
        assert.deepStrictEqual(ks.slice(0, 4), ['rail:search', 'rail:home', 'rail:subs', 'rail:wl'], 'the rail first: ' + ks);
        assert.ok(ks.indexOf('rail:library') < 0, 'no Library');
        assert.ok(ks.indexOf('rail:player') < 0, 'nothing playing: no Playing');
        assert.ok(ks.indexOf('r:0:lib1') > 3 && ks.indexOf('r:0:lib2') > 3, 'then the tiles: ' + ks);
        // the controller on a tile, pressed: the player; pushed left: back on that tile
        disp.onPageFocus('r:0:lib1');
        disp.pageTargets.find((t) => t.key === 'r:0:lib1').run();
        await hu.loopFn();
        assert.ok(keys().indexOf('ov:back') >= 0, 'the tile opens the player');
        assert.ok(disp.onBack(false) === true);
        await hu.loopFn();
        assert.strictEqual(disp.focusKey, 'tgt:r:0:lib1', 'the controller back on the tile it left from');
        console.log('ok   no bar, rail (Playing while a video plays), back from the player onto the tile');
    }
    console.log('ok   app frames (Home signed out, results, offline search, player through the renderer stream)');

    // the feed tabs: signed out, Home asks for a code and shows the sign-in page (QR + code); signed in, the feed
    const { Recorder } = require(path.join(hu.kitDir, 'record'));
    const texts = [], rects = [];
    const ot = Recorder.prototype.text, of = Recorder.prototype.fillRect;
    Recorder.prototype.text = function (str) { texts.push(String(str)); return ot.apply(this, arguments); };
    Recorder.prototype.fillRect = function (x, y, w, h, c) { rects.push({ w, h, c }); return of.apply(this, arguments); };
    const drawn = async () => { texts.length = 0; rects.length = 0; await hu.loopFn(); };
    d.send({ ev: 'auth', state: 'signed_out' });
    await sleep(100);
    assert.strictEqual(d.cmds('auth').length, 0, 'signed out on the results: no code asked');
    disp.onTab(0);
    await until(() => d.cmds('auth').length === 1, 2000, 'Home, signed out: a sign-in code asked');
    await drawn();
    assert.ok(texts.indexOf('Getting a sign-in code...') >= 0, texts.join('|'));
    d.send({ ev: 'auth', state: 'code', code: 'ABC-DEF-GHIJ', url: 'https://www.google.com/device', expires: 1800 });
    await sleep(100);
    await drawn();
    assert.ok(texts.indexOf('ABC-DEF-GHIJ') >= 0 && texts.indexOf('Enter this code on your phone') >= 0, texts.join('|'));
    assert.ok(rects.some((r) => r.w === 296 && r.h === 296 && r.c === '#ffffff'), 'the QR code on its white square (29 + 8 modules of 8 px)');
    assert.ok(rects.filter((r) => r.c === '#000000' && r.h === 8).length > 100, 'its dark modules');
    // a url longer than the QR holds: the fixed sign-in URL instead, never a throw
    d.send({ ev: 'auth', state: 'code', code: 'ABC-DEF-GHIJ', url: 'https://www.google.com/device?' + 'x'.repeat(80), expires: 1700 });
    await sleep(100);
    await drawn();
    assert.ok(texts.indexOf('Scan the code, or go to google.com/device') >= 0 && rects.some((r) => r.w === 296 && r.c === '#ffffff'), 'long url: the fixed one');
    disp.onTab(1);
    await sleep(100);
    assert.strictEqual(d.cmds('auth').length, 1, 'another feed tab: the code shown, not asked again');
    d.send({ ev: 'auth', state: 'signed_in' });
    await until(() => d.cmds('feed').length === 1, 2000, 'signed in on Subscriptions: its feed asked');
    assert.deepStrictEqual(d.cmds('feed')[0], { cmd: 'feed', which: 'subs' });
    await drawn();
    assert.ok(texts.indexOf('Loading Subscriptions...') >= 0, texts.join('|'));
    // an older daemon: a flat list, no shelves -> a grid of four a row; thumbs asked for the tiles drawn only
    const thumbs0 = d.cmds('thumb').length;
    d.send({ ev: 'feed', which: 'subs', items: Array.from({ length: 24 }, (_, i) => ({ id: 'f' + i, title: 'Feed ' + i, channel: 'Ch', duration_s: 90 })) });
    await sleep(100);
    await drawn();
    await sleep(100);
    const asked = d.cmds('thumb').slice(thumbs0).map((x) => x.id);
    assert.ok(asked.length >= 4 && asked.length <= 12 && asked.indexOf('f0') >= 0 && asked.indexOf('f19') < 0, 'only the drawn tiles asked: ' + asked);
    d.send({ ev: 'thumb', id: 'f0', w: 160, h: 90, rgba: Buffer.alloc(57600, 77).toString('base64') });
    await sleep(100);
    await drawn();
    assert.ok(frame().pics.some(POOL), 'feed frame draws a pooled picture');
    assert.ok(texts.indexOf('Feed 0') >= 0 && texts.indexOf('Feed 1') >= 0, 'the first row: Feed 0 and Feed 1 side by side');
    if (own) {
        assert.ok(disp.onScroll(5000), 'the feed scrolls');
        await drawn();
        const keys = disp.pageTargets.map((x) => x.key);
        assert.ok(keys.some((k) => /^s:\d+:f19$/.test(k)) && !keys.some((k) => /^s:\d+:f0$/.test(k)), 'scrolled to the end: the last row, not the first: ' + keys.join(','));
        assert.ok(!disp.onScroll(100), 'at the end');
        disp.pageTargets.find((x) => /^s:\d+:f19$/.test(x.key)).run();
        await until(() => d.cmds('play').some((x) => x.id === 'f19' && x.fill === false && /^\d+x\d+$/.test(x.rect)), 2000, 'a feed tile plays its video');
        console.log('ok   feed scrolls (kit runs the screen) and a tile plays');
        d.send({ ev: 'state', state: 'idle' });
        hu.handlers.BTN_LIST();             // (back to the list)
    } else console.log('skip feed scrolling (the stub does not run the screen)');
    // sign out: pressed twice; the daemon says signed out, the feed tab asks for a new code
    disp.onTab(1);
    await until(() => d.cmds('feed').length === 2, 2000, 'back on Subscriptions: reloaded');
    hu.handlers.BTN_ACCOUNT();
    await sleep(50);
    assert.strictEqual(d.cmds('sign_out').length, 0, 'one press does not sign out');
    hu.handlers.BTN_ACCOUNT();
    await until(() => d.cmds('sign_out').length === 1, 2000, 'second press signs out');
    d.send({ ev: 'auth', state: 'signed_out' });
    await sleep(150);
    assert.strictEqual(d.cmds('auth').length, 1, 'signed out (or a code expired) on a feed tab: no new device flow on its own');
    await drawn();
    if (own) {
        assert.ok(texts.indexOf('Tap here to get a sign-in code') >= 0, texts.join('|'));
        disp.pageTargets.find((x) => x.key === 'signin').run();
        await until(() => d.cmds('auth').length === 2, 2000, 'the tap asks for a code');
    } else {
        hu.handlers.BTN_ACCOUNT();
        await until(() => d.cmds('auth').length === 2, 2000, 'Sign in in the menu asks for a code');
    }
    // an expired code (daemon: signed_out) while the page shows: also no new flow on its own
    d.send({ ev: 'auth', state: 'code', code: 'NEW-COD-EEEE', url: 'https://www.google.com/device', expires: 1800 });
    d.send({ ev: 'auth', state: 'signed_out' });
    await sleep(150);
    assert.strictEqual(d.cmds('auth').length, 2, 'code expired: not asked again until a tap');
    disp.onTab(0);
    await until(() => d.cmds('auth').length === 3, 2000, 'opening a feed tab asks again');
    console.log('ok   feed tabs (sign-in page with QR and code, feed tiles, sign out)');

    // Home with the account's shelves (daemon 0.1.6): the shelves, Watch later (asked with Home)
    if (own) {
        const SH = 8, N = 12, vids = [];
        const shelves = Array.from({ length: SH }, (_, k) => ({ title: 'Shelf ' + k, items: Array.from({ length: N }, (_, i) => { const v = { id: 'h' + k + '_' + i, title: 'Video ' + k + '.' + i, channel: 'C', duration_s: 4053, meta: ['1K views'] }; vids.push(v); return v; }) }));
        const feeds0 = d.cmds('feed').length;
        d.send({ ev: 'auth', state: 'signed_in' });
        await until(() => d.cmds('feed').length === feeds0 + 2, 2000, 'Home asks for its feed and Watch later');
        assert.deepStrictEqual(d.cmds('feed').slice(feeds0).map((x) => x.which), ['home', 'wl']);
        d.send({ ev: 'feed', which: 'home', items: vids.slice(0, 20), shelves });
        d.send({ ev: 'feed', which: 'wl', items: [{ id: 'w1', title: 'Later', channel: 'C' }], shelves: [] });
        // the daemon answers every thumb asked (a 320x180 one), as the screens draw
        let served = d.cmds('thumb').length;
        const serve = async () => {
            await sleep(25);
            d.cmds('thumb').slice(served).forEach((x) => d.send({ ev: 'thumb', id: x.id, w: 320, h: 180, rgba: Buffer.alloc(320 * 180 * 4, 60).toString('base64') }));
            served = d.cmds('thumb').length;
            await sleep(25);
        };
        await sleep(100);
        await drawn(); await serve(); await drawn();
        assert.ok(texts.indexOf('Shelf 0') >= 0, 'titled shelves: ' + texts.slice(0, 20).join('|'));
        const at = (re) => disp.pageTargets.find((x) => re.test(x.key));
        const view = { x0: 0, x1: 1600, y0: 38, y1: 520 + (disp.place.extra || 0) };
        const inView = (t) => t.x >= view.x0 && t.x + t.w <= view.x1 && t.y >= view.y0 - 12 && t.y + t.h <= view.y1 + 12;
        // the chevron: Shelf 0 (row 0) turned by four
        const inX = (t) => t && t.x >= view.x0 && t.x + t.w <= view.x1;
        assert.ok(!inX(at(/^h:0:h0_4$/)), 'the 5th tile not whole at first');
        at(/^h:0:>$/).run();
        await drawn();
        assert.ok(inX(at(/^h:0:h0_4$/)) && at(/^h:0:<$/) && !at(/^h:0:h0_2$/), 'the arrow turned the shelf by four (and the back arrow shows)');
        at(/^h:0:<$/).run();
        await drawn();
        // the controller through every video of every shelf, as turning the knob would: each brought into view
        const ids = new Set();
        for (const v of vids) {
            const t = at(new RegExp('^h:\\d+:' + v.id + '$'));
            assert.ok(t, 'a target for ' + v.id + ' next to the one before: ' + disp.pageTargets.map((x) => x.key));
            disp._focus({ k: 'tgt:' + t.key, tgt: t });
            await drawn(); await serve(); await drawn();
            const t2 = disp.pageTargets.find((x) => x.key === t.key);
            assert.ok(t2 && inView(t2), v.id + ' brought into view: ' + JSON.stringify(t2));
            const pics = frame().pics;
            assert.ok(pics.every(POOL) && new Set(pics).size === pics.length && pics.length <= 56, 'pictures from the pool, each once: ' + pics);
            ids.add(v.id);
        }
        const all = new Set(frame().all);
        assert.ok([...all].every(POOL) && all.size <= 56 && ids.size > 56, 'over ' + ids.size + ' videos drawn, ' + all.size + ' picture ids reused: ' + [...all].sort((a, b) => a - b));
        assert.ok(disp.pageTargets.some((x) => /^h:\d+:w1$/.test(x.key)), 'Watch later is the last shelf');
        console.log('ok   Home shelves: arrows, the controller scrolls any tile into view, the picture pool (' + all.size + ' ids)');
        // the rail: Subscriptions
        at(/^rail:subs$/).run();
        await until(() => d.cmds('feed').slice(-1)[0].which === 'subs', 2000, 'the rail opens Subscriptions');
        await until(() => d.cmds('channels').length, 2000, 'and asks for the channels');
        d.send({ ev: 'channels', items: [{ id: 'UCdemo000000000000000001', title: 'Demo Detailing', handle: '@demo' }, { id: 'UCdemo000000000000000002', title: 'Élise Atelier', handle: '@elise' }] });
        for (let k = 0; k < 100 && !disp.pageTargets.some((x) => x.key === 's:0:UCdemo000000000000000002'); k++) { await sleep(20); await hu.loopFn(); }
        assert.ok(disp.pageTargets.some((x) => x.key === 's:0:UCdemo000000000000000002'), 'the channels row: ' + disp.pageTargets.map((x) => x.key).slice(0, 12));
        assert.ok(disp.pageTargets.some((x) => x.key === 's:0:::find'), 'Search channels first');
        disp.onPageFocus('s:0:UCdemo000000000000000002');
        disp.pageTargets.find((x) => x.key === 's:0:UCdemo000000000000000002').run();
        await lastIs(d, { cmd: 'channel', id: 'UCdemo000000000000000002' }, 'a channel opens its page');
        assert.ok(disp.onBack(false) === false, 'on a channel, pushed left moves along the page first');
        assert.ok(disp.onBack(true) === true, 'pushed left at its edge: back');
        await hu.loopFn();
        assert.ok(disp.pageTargets.some((x) => x.key === 's:0:UCdemo000000000000000002'), 'back on Subscriptions');
        assert.strictEqual(disp.focusKey, 'tgt:s:0:UCdemo000000000000000002', 'on the channel it opened');
        console.log('ok   Subscriptions: the channels row (Search channels, then A-Z); a channel opens its page, back at its edge');
        // a channel's page: Hide this channel first; hidden, its videos leave Subscriptions (members-only ones too, a setting)
        d.send({ ev: 'feed', which: 'subs', items: [{ id: 'HHHHHHHHHH1', title: 'From Elise', channel: 'Élise Atelier', duration_s: 90 },
            { id: 'HHHHHHHHHH2', title: 'Perk', channel: 'Other', duration_s: 90, members: true }, { id: 'HHHHHHHHHH3', title: 'Free', channel: 'Other', duration_s: 90 }], shelves: [] });
        disp.onPageFocus('s:0:UCdemo000000000000000002');
        disp.pageTargets.find((x) => x.key === 's:0:UCdemo000000000000000002').run();
        d.send({ ev: 'channel', id: 'UCdemo000000000000000002', items: [{ id: 'HHHHHHHHHH1', title: 'From Elise', channel: 'Élise Atelier', duration_s: 90 }] });
        await sleep(100); await hu.loopFn();
        const hide = disp.pageTargets.find((x) => /^c:0:::hide$/.test(x.key));
        assert.ok(hide, 'Hide this channel on its page: ' + disp.pageTargets.map((x) => x.key));
        assert.ok(disp.pageTargets.some((x) => x.key === 'c:0:HHHHHHHHHH1'), 'its videos still on its own page');
        hide.run();
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'hidden.json'), 'utf8')), ['Élise Atelier'], 'kept in hidden.json');
        disp.onBack(true); await hu.loopFn();
        const subKeys = disp.pageTargets.map((x) => x.key).filter((k) => /HHHHHHHHHH/.test(k));
        assert.deepStrictEqual(subKeys.map((k) => k.slice(-1)), ['3'], 'Subscriptions: the hidden channel\'s and the members-only videos gone: ' + subKeys);
        disp.onPageFocus('s:0:UCdemo000000000000000002');
        disp.pageTargets.find((x) => x.key === 's:0:UCdemo000000000000000002').run();
        await hu.loopFn();
        disp.pageTargets.find((x) => /^c:0:::hide$/.test(x.key)).run();          // Show this channel
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'hidden.json'), 'utf8')), [], 'shown again');
        disp.onBack(true); await hu.loopFn();
        console.log('ok   Hide this channel (its page), hidden from Subscriptions; members-only videos hidden by default');
        // the controller resting ~1 s on a known video: its stream lookup asked once; a pass over one: nothing
        const rq = d.cmds('search').slice(-1)[0].q;
        d.send({ ev: 'results', q: rq, items: [{ id: 'ABCDEFGHIJK', title: 'Saved' }, { id: 'ZYXWVUTSRQP', title: 'Other' }] });
        await sleep(100);
        disp.onPageFocus('r:0:ZYXWVUTSRQP');
        await sleep(300);
        disp.onPageFocus('r:0:ABCDEFGHIJK');
        await sleep(1300);
        assert.deepStrictEqual(d.cmds('prefetch'), [{ cmd: 'prefetch', id: 'ABCDEFGHIJK' }], 'only the rested-on one');
        console.log('ok   prefetch: a video the controller rests on 1 s is looked up ahead');
        // autoplay: a tile played from a row; when it ends, the next one in that row plays after 5 s
        hu.handlers.BTN_RESULTS();
        let tile = null;
        for (let k = 0; k < 100 && !(tile = at(/^r:\d+:ABCDEFGHIJK$/)); k++) { await sleep(20); await hu.loopFn(); }
        assert.ok(tile, 'the result on its page: ' + disp.pageTargets.map((x) => x.key).slice(0, 10));
        tile.run();
        await until(() => (d.cmds('play').slice(-1)[0] || {}).id === 'ABCDEFGHIJK', 2000, 'played');
        d.send({ ev: 'state', state: 'playing', id: 'ABCDEFGHIJK' });
        d.send({ ev: 'state', state: 'ended', id: 'ABCDEFGHIJK' });
        await sleep(100); await hu.loopFn();
        assert.ok(!d.cmds('play').some((x) => x.id === 'ZYXWVUTSRQP'), 'not at once');
        for (let k = 0; k < 40 && !d.cmds('play').some((x) => x.id === 'ZYXWVUTSRQP'); k++) { await sleep(200); await hu.loopFn(); }
        assert.ok(d.cmds('play').some((x) => x.id === 'ZYXWVUTSRQP'), 'the next one in the row plays');
        console.log('ok   autoplay: the next video in the row, 5 s after the end');
    }
    Recorder.prototype.text = ot; Recorder.prototype.fillRect = of;
    d.server.close();
}

function extrasModel() {
    const m = new Model(() => true);
    m.onMsg({ ev: 'positions', items: [{ id: 'AAAAAAAAAAA', ms: 60000, total: 600000, done: false, title: 'Half' }, { id: 'BBBBBBBBBBB', ms: 590000, total: 600000, done: true, title: 'Seen' },
        { id: 'CCCCCCCCCCC', ms: 5000, total: 600000, done: false, title: 'Barely' }, { id: 'bad' }] });
    assert.deepStrictEqual(m.resume.map((r) => r.id), ['AAAAAAAAAAA'], 'Continue watching: started, not finished');
    assert.deepStrictEqual(Object.keys(m.pos).sort(), ['AAAAAAAAAAA', 'BBBBBBBBBBB', 'CCCCCCCCCCC'], 'every position for the bars');
    assert.ok(m._known('AAAAAAAAAAA'), 'its thumb can be asked');
    m.onMsg({ ev: 'state', state: 'playing', id: 'AAAAAAAAAAA', title: 'Half' });
    m.onMsg({ ev: 'extras', id: 'AAAAAAAAAAA', chapters: [[0, 'Intro'], [30000, 'Main'], 'x'], segments: [[10000, 20000, 'sponsor'], [5, 1]] });
    assert.strictEqual(m.extras.chapters.length, 2); assert.strictEqual(m.extras.segments.length, 1);
    m.onMsg({ ev: 'time', elapsed: 31000, total: 600000 });
    assert.strictEqual(m.chapter(), 'Main');
    m.onMsg({ ev: 'skipped', category: 'sponsor', ms: 10000 });
    assert.strictEqual(m.toast.text, 'Skipped sponsor · 0:10');
    m.onMsg({ ev: 'state', state: 'preparing', id: 'DDDDDDDDDDD' });
    m.onMsg({ ev: 'retry', id: 'DDDDDDDDDDD', n: 2, msg: 'boom' });
    assert.strictEqual(m.retry, 2, 'the network lost: trying again (2)');
    m.onMsg({ ev: 'state', state: 'playing', id: 'DDDDDDDDDDD' });
    assert.strictEqual(m.retry, 0, 'playing: no more retry note');
    console.log('ok   extras: Continue watching, positions, chapters, the skipped toast');
}

function channelSearch() {
    const m = new Model(() => true);
    m.auth.state = 'signed_in';
    m.loadChannels();
    m.onMsg({ ev: 'channels', items: [{ id: 'UCdemo000000000000000001', title: 'Demo Detailing', handle: '@demo_detailing' },
        { id: 'UCdemo000000000000000002', title: 'Élise Atelier', handle: '@eliseatelier' }, { id: 'UCdemo000000000000000003', title: 'Arcadia', handle: '@arcadia' }, { id: 'bad', title: 'x' }] });
    const ids = (q) => m.findChannels(q).map((c) => c.title);
    assert.deepStrictEqual(ids(''), ['Demo Detailing', 'Élise Atelier', 'Arcadia'], 'all, a bad id dropped');
    assert.deepStrictEqual(ids('e'), ['Élise Atelier'], 'one letter: names starting with it, accents aside');
    assert.deepStrictEqual(ids('A'), ['Arcadia'], 'case aside');
    assert.deepStrictEqual(ids('atelier'), ['Élise Atelier'], 'a word: names holding it');
    assert.deepStrictEqual(ids('ar'), ['Arcadia'], 'two letters: held, not only at the start');
    assert.deepStrictEqual(ids('demo_d'), ['Demo Detailing'], 'the @handle too');
    console.log('ok   channel search: a letter = the names starting with it, a word = the names (or handles) holding it');
}

clientAndModel().then(appFrames).then(channelSearch).then(extrasModel).then(() => process.exit(0), (e) => { console.error('FAIL', e); process.exit(1); });
