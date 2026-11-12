'use strict';
// Host test for ytd.js: fake someip, fake ytdec, fake fetcher and thumb helper, real unix socket.  node test/test_ytd.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { Daemon, Audio, pruneCache, listCache, feedItems, feedShelves, pickFetchUid, fetchRequest, isPlayable } = require('../ytd.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ytd-'));
process.env.MGU_YT_AUDIO = path.join(tmp, 'audio.json');      // (none: the iDrive 7 route)
const cache = path.join(tmp, 'cache');
const srcGen = path.join(tmp, 'src-gen');
const ytlog = path.join(tmp, 'ytdec.calls');
fs.mkdirSync(cache); fs.mkdirSync(srcGen);
['org_genivi_am_commandinterface_CommandControl.json', 'de_bmw_infotainment_entertainment_mediaplayer_MediaPlayer.json']
    .forEach((f) => fs.writeFileSync(path.join(srcGen, f), JSON.stringify({ name: f })));
const fakeYtdec = path.join(__dirname, 'fake_ytdec.js');
fs.chmodSync(fakeYtdec, 0o755);
process.env.FAKE_YTDEC_LOG = ytlog;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const setMode = (m) => fs.writeFileSync(ytlog + '.mode', m);

// ---- fake someip
const calls = [];
let conns = [{ mainConnectionID: 7, sourceID: 1046, sinkID: 1024 }, { mainConnectionID: 15, sourceID: 129, sinkID: 387 }];
let nextConn = 20;
let slowPlayFile = 0;
const subs = {};
const someip = {
    buildProxy: async (cfg, inst) => ({
        init: async () => {},
        isAvailable: async () => true,
        subscribe: (s) => { subs[s.name] = s.onReceive; },
        getValue: async (n) => {
            if (n === 'listOfMainSources') return [{ sourceID: 1046, name: 'OapGenericMedia' }, { sourceID: 129, name: 'Tuner' }];
            if (n === 'listOfMainSinks') return [{ sinkID: 1024, name: 'AMP' }];
            assert.strictEqual(n, 'listOfMainConnections'); return conns.slice();
        },
        callMethod: async (m, a) => {
            calls.push({ inst: inst, m: m, a: a });
            if (m === 'connect') { const id = nextConn++; conns.push({ mainConnectionID: id, sourceID: a.sourceID }); return { mainConnectionID: id, amError: 'E_OK' }; }
            if (m === 'disconnect') { conns = conns.filter((c) => c.mainConnectionID !== a.mainConnectionID); return { amError: 'E_OK' }; }
            if (m === 'playFile' && slowPlayFile) await sleep(slowPlayFile);
            return { EntError: 'OK' };
        }
    })
};
const called = (m) => calls.filter((c) => c.m === m);
const ours = () => conns.filter((c) => c.sourceID === 1046);

// ---- cache fixtures
function mkVideo(id, opts) {
    opts = opts || {};
    const d = path.join(cache, id);
    fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, 'meta.json'), JSON.stringify({ id: id, title: 'T ' + id, channel: 'C', duration_s: 60 }));
    fs.writeFileSync(path.join(d, 'thumb.rgba'), Buffer.alloc(57600, 7));
    (opts.files || ['audio.m4a', 'index.bin', 'video.h264']).forEach((f) => fs.writeFileSync(path.join(d, f), 'x'));
    const t = new Date(opts.mtime || Date.now());
    fs.utimesSync(d, t, t);
    return d;
}

// ---- fake www.youtube.com (ytRequest): the TV page, its base script, device code, token, browse
const yt = { calls: [], inline: false, expiresIn: 1800, token: () => ({ error: 'authorization_pending' }), browse: null };
const SECRETS = ['SeCrEt-1', 'DEV-CODE-XYZ', 'ACCESS-1', 'ACCESS-2', 'ACCESS-3', 'REFRESH-1'];
const CRED = 'clientId:"123-abc.apps.googleusercontent.com",\nqz:"SeCrEt-1"';
const fakeYt = async (method, url, headers, body) => {
    yt.calls.push({ method: method, url: url, headers: headers, body: body });
    const slow = Object.keys(yt.slow || {}).find((k) => url.endsWith(k));
    if (slow) await sleep(yt.slow[slow]);
    const json = (o, st) => ({ status: st || 200, body: JSON.stringify(o) });
    if (url === 'https://www.youtube.com/tv') return { status: 200, body: yt.creds === false ? '<html></html>' : yt.inline ? 'a ' + CRED + ' b' : '<script src="/s/tv/x1/base.js"></script>' };
    if (url === 'https://www.youtube.com/s/tv/x1/base.js') return { status: 200, body: 'var q={' + CRED + '};' };
    if (url === 'https://www.youtube.com/o/oauth2/device/code' && yt.refuse > 0) { yt.refuse--; return json({ error: 'invalid_client' }, 401); }
    if (url === 'https://www.youtube.com/o/oauth2/device/code') return json({ device_code: 'DEV-CODE-XYZ', user_code: 'ABC-DEF-GHI', verification_url: 'https://www.google.com/device', interval: 0.03, expires_in: yt.expiresIn });
    if (url === 'https://www.youtube.com/o/oauth2/token') { const r = yt.token(body); return json(r, r.error ? 400 : 200); }
    if (url === 'https://www.youtube.com/youtubei/v1/browse') return yt.browse(headers, body);
    if (url === 'https://www.youtube.com/youtubei/v1/search') return yt.search(headers, body);
    if (url.indexOf('https://sponsor.ajay.app/api/skipSegments/') === 0 && yt.sb) return yt.sb(url);
    if (url === 'https://www.youtube.com/youtubei/v1/player') return json({ playbackTracking: { videostatsPlaybackUrl: { baseUrl: 'https://s.youtube.com/api/stats/playback?docid=x&ei=E' }, videostatsWatchtimeUrl: { baseUrl: 'https://s.youtube.com/api/stats/watchtime?docid=x&ei=E' } } });
    if (url.indexOf('https://s.youtube.com/api/stats/') === 0) return { status: 204, body: '' };
    return { status: 404, body: '' };
};
// an anonymous TVHTML5 search answer for "big buck bunny" (2026-11-03), trimmed to three lockups
const SEARCH = JSON.parse(fs.readFileSync(path.join(__dirname, 'search_tvhtml5.json'), 'utf8'));
yt.search = () => ({ status: 200, body: JSON.stringify(SEARCH) });
const ytCalls = (end) => yt.calls.filter((x) => x.url.endsWith(end));
// a browse answer shaped like TVHTML5's: shelves of tiles (a video, a short, a channel, the video again)
const tile = (id, type, title, channel, len, line2) => ({ tileRenderer: {
    contentId: id, contentType: type,
    header: { tileHeaderRenderer: { thumbnailOverlays: len ? [{ thumbnailOverlayTimeStatusRenderer: { text: { simpleText: len } } }] : [] } },
    metadata: { tileMetadataRenderer: { title: { runs: [{ text: title }] }, lines: [
        { lineRenderer: { items: [{ lineItemRenderer: { text: { runs: [{ text: channel }] } } }] } },
        { lineRenderer: { items: line2 || [{ lineItemRenderer: { text: { simpleText: '1K views' } } }, { lineItemRenderer: { text: { simpleText: '•' } } }] } }] } },
    onSelectCommand: type === 'TILE_CONTENT_TYPE_SHORTS' ? { reelWatchEndpoint: { videoId: id } } : { watchEndpoint: { videoId: id } } } });
const BROWSE = { contents: { tvBrowseRenderer: { content: { tvSurfaceContentRenderer: { content: { sectionListRenderer: { contents: [
    { shelfRenderer: { content: { horizontalListRenderer: { items: [
        tile('VVVVVVVVVV1', 'TILE_CONTENT_TYPE_VIDEO', 'First', 'Chan A', '39:50'),
        tile('SSSSSSSSSS1', 'TILE_CONTENT_TYPE_SHORTS', 'A short', 'Chan B', null),
        tile('UCxxxxxxxxx', 'TILE_CONTENT_TYPE_CHANNEL', 'A channel', '', null)] } } } },
    { shelfRenderer: { content: { horizontalListRenderer: { items: [
        tile('VVVVVVVVVV2', 'TILE_CONTENT_TYPE_VIDEO', 'Second', 'Chan C', '1:02:03'),
        tile('VVVVVVVVVV1', 'TILE_CONTENT_TYPE_VIDEO', 'First', 'Chan A', '39:50'),
        tile('VVVVVVVVVV3', 'TILE_CONTENT_TYPE_VIDEO', 'Live', 'Chan D', 'LIVE')] } } } }] } } } } } } };

// ---- app side
function client(sock) {
    return new Promise((resolve) => {
        const c = net.connect(sock, () => resolve(c));
        c.evs = [];
        let buf = '';
        c.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { c.evs.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
        c.send = (o) => c.write(JSON.stringify(o) + '\n');
        c.waitFor = async (pred, ms) => {
            const end = Date.now() + (ms || 3000);
            for (;;) {
                const e = c.evs.find(pred);
                if (e) return e;
                if (Date.now() > end) throw new Error('timeout waiting; got ' + JSON.stringify(c.evs.slice(-5)));
                await sleep(20);
            }
        };
        c.clear = () => { c.evs.length = 0; };
    });
}
const ytdecLines = () => (fs.existsSync(ytlog) ? fs.readFileSync(ytlog, 'utf8').split('\n').filter(Boolean) : []);
const waitUntil = async (f, ms) => { const end = Date.now() + (ms || 3000); while (!f()) { if (Date.now() > end) throw new Error('timeout'); await sleep(20); } };
const tick = (ms) => subs.currentItemTime({ elapsed: ms, total: 60000 });

const results = [];
async function t(name, fn) {
    try { await fn(); results.push('ok   ' + name); } catch (e) { results.push('FAIL ' + name + '\n' + (e.stack || e)); }
}

async function main() {
    const logs = [];
    const stateDir = path.join(tmp, 'state');
    const acct = path.join(stateDir, 'account.json');
    const ctl = path.join(tmp, 'fetch.ctl');
    const d = new Daemon({
        someip: someip, srcGen: srcGen, ytdec: fakeYtdec, cacheDir: cache, logDir: tmp, sock: path.join(tmp, 'ctl.sock'),
        watchdogMs: 800, tickMs: 200, keep: 20, stateDir: stateDir, noSetuid: true, spare: false, resume: false, fetchRetryMs: [],
        fetcher: [process.execPath, path.join(__dirname, 'fake_ytfetch.js'), ctl],
        accountFile: acct, ytRequest: fakeYt, log: (m) => logs.push(m)
    });
    mkVideo('DemoVideo01', { mtime: Date.now() - 1000 });
    mkVideo('PPPPPPPPPPP', { mtime: Date.now() - 1500 });
    mkVideo('DemoVideo02', { files: ['audio.m4a', 'index.bin', 'video.h264.part'], mtime: Date.now() - 2000 });
    await d.start();
    let c = await client(d.opts.sock);

    await t('leftover 1046 connection removed at start, others kept', async () => {
        assert.deepStrictEqual(called('disconnect').map((x) => x.a.mainConnectionID), [7]);
        assert.ok(conns.some((x) => x.mainConnectionID === 15));
    });

    await t('no downloads: library / download / remove are unknown commands; thumb read from the cache', async () => {
        for (const cmd of ['library', 'download', 'remove']) {
            c.clear();
            c.send({ cmd: cmd, id: 'DemoVideo01' });
            await c.waitFor((x) => x.ev === 'error' && x.msg === 'unknown cmd ' + cmd);
        }
        c.send({ cmd: 'thumb', id: 'DemoVideo01' });
        const th = await c.waitFor((x) => x.ev === 'thumb');
        assert.strictEqual(Buffer.from(th.rgba, 'base64').length, 57600);
        c.clear();
        fs.renameSync(path.join(cache, 'DemoVideo02', 'video.h264.part'), path.join(cache, 'DemoVideo02', 'video.h264'));
    });

    await t('search: TVHTML5 InnerTube, anonymous when signed out; lockups parsed; offline -> "search offline"', async () => {
        c.clear(); yt.calls.length = 0;
        c.send({ cmd: 'search', q: ' bunny ' });
        const e = await c.waitFor((x) => x.ev === 'results');
        assert.deepStrictEqual(e, { ev: 'results', q: 'bunny', items: [
            { id: 'f7NwyBnIRTE', title: 'Animated Short Film "Big Buck Bunny", 4K, Full Length', channel: 'AnimalsReview', duration_s: 635, meta: ['37M views', '11 years ago'] },
            { id: 'PJx173L9jWw', title: 'Big Buck Bunny creative common Blender Foundation Short Film', channel: 'Miniaiza', duration_s: 10205, meta: ['36 views', 'Streamed 15 hours ago'] },
            { id: 'OR6rRQ1fAzM', title: 'LES ANIMOJIS - LA CHANSON DU GROS LAPIN (CLIP)', channel: 'Monsieur Seby', duration_s: 213, meta: ['1.7M views', '8 years ago'] }] });
        const r = ytCalls('/youtubei/v1/search')[0];
        assert.strictEqual(r.method, 'POST');
        assert.strictEqual(r.headers, null, 'anonymous');
        assert.deepStrictEqual(r.body, { context: { client: { clientName: 'TVHTML5', clientVersion: '7.20251101.10.00', hl: 'en' } }, query: 'bunny' });
        yt.search = () => Promise.reject(new Error('ENETUNREACH'));
        c.send({ cmd: 'search', q: 'x' });
        await c.waitFor((x) => x.ev === 'error' && x.msg === 'search offline');
        yt.search = () => ({ status: 200, body: JSON.stringify(SEARCH) });
    });

    await t('play cached: connect + playFile + ytdec args, no fetcher', async () => {
        c.clear(); calls.length = 0; fs.writeFileSync(ytlog, ''); setMode('ok');
        fs.chmodSync(path.join(cache, 'DemoVideo01'), 0o700);       // cached by 0.3.8 or older
        c.send({ cmd: 'play', id: 'DemoVideo01', rect: '1836x504', fill: true });
        const pl = await c.waitFor((x) => x.ev === 'state' && x.state === 'playing');
        assert.strictEqual(pl.buffering, false);
        assert.ok(!fs.existsSync(ctl + '.log'), 'no fetcher');
        assert.deepStrictEqual(called('connect')[0].a, { sourceID: 1046, sinkID: 1024 });
        assert.deepStrictEqual(called('playFile')[0].a, { path: path.join(cache, 'DemoVideo01', 'audio.m4a'), languageCode: 7695972 });
        assert.strictEqual(called('playFile')[0].inst, 'OapGenericMedia');
        // BMW's media engine (its own uid) opens audio.m4a by name: it must pass through the folder, not list it
        assert.strictEqual(fs.statSync(path.join(cache, 'DemoVideo01')).mode & 0o777, 0o711, 'an old 0700 folder opened up');
        await waitUntil(() => ytdecLines().length > 0);
        assert.ok(ytdecLines()[0].endsWith('argv --dir ' + path.join(cache, 'DemoVideo01') + ' --rect 1836x504 --fill --log ' + path.join(tmp, 'ytdec.log')), ytdecLines()[0]);
    });

    await t('clock ticks forwarded to ytdec (mono ms) and as time events', async () => {
        subs.currentItemTime({ elapsed: 0, total: 1 }); // ignored
        subs.playerState('PLAYER_STATE_PLAY');
        tick(1226);
        const e = await c.waitFor((x) => x.ev === 'time');
        assert.deepStrictEqual(e, { ev: 'time', elapsed: 1226, total: 60000 });
        await sleep(100);
        const cl = ytdecLines().filter((l) => / in clock /.test(l));
        assert.strictEqual(cl.length, 1);
        const parts = cl[0].split(' ');
        assert.strictEqual(parts[3], '1226');
        assert.ok(Math.abs(Number(parts[4]) - (process.hrtime()[0] * 1000)) < 5000);
    });

    await t('pause/resume/seek/video map to SOME/IP and ytdec stdin', async () => {
        calls.length = 0;
        c.send({ cmd: 'pause' });
        await c.waitFor((x) => x.ev === 'state' && x.state === 'paused');
        c.send({ cmd: 'resume' });
        await c.waitFor((x) => x.ev === 'state' && x.state === 'playing');
        c.send({ cmd: 'seek', ms: 30000 });
        c.send({ cmd: 'video', on: false });
        c.send({ cmd: 'video', on: true });
        await sleep(200);
        assert.strictEqual(called('setTime').length, 0, 'no setTime before the restarted file ticks (the player drops it)');
        tick(0);
        await waitUntil(() => called('setTime').length > 0);
        // pause = STOP where it is (the car's player answers OK to PAUSE and plays on); resume = the file again, set there
        assert.deepStrictEqual(called('sendButtonEvent').map((x) => x.a.button), ['STOP', 'STOP'], 'pause; resume releases (STOP, disconnect) and connects again');
        assert.strictEqual(called('connect').length, 1);
        assert.deepStrictEqual(called('playFile').map((x) => x.a.path), [path.join(cache, 'DemoVideo01', 'audio.m4a')]);
        // the seek sent while the file restarts wins: one setTime, there
        assert.deepStrictEqual(called('setTime').map((x) => x.a.newTimeElapsed), [30000]);
        const ins = ytdecLines().map((l) => l.split(' ').slice(1).join(' ')).filter((l) => /^in (pause|resume|seek|video)/.test(l));
        assert.strictEqual(ins[0], 'in pause');
        assert.ok(/^in seek \d+$/.test(ins[1]) && Number(ins[1].split(' ')[2]) < 60000, 'where it stopped: ' + ins[1]);
        assert.deepStrictEqual(ins.slice(2), ['in resume', 'in seek 30000', 'in video 0', 'in video 1']);
    });

    await t('stop disconnects audio and quits ytdec', async () => {
        calls.length = 0;
        c.send({ cmd: 'stop' });
        await c.waitFor((x) => x.ev === 'state' && x.state === 'idle');
        assert.deepStrictEqual(called('sendButtonEvent').map((x) => x.a.button), ['STOP']);
        assert.strictEqual(called('disconnect').length, 1);
        assert.strictEqual(ours().length, 0);
        await sleep(200);
        assert.ok(ytdecLines().some((l) => / in quit$/.test(l)));
        assert.strictEqual(d.child, null);
    });

    const playing = async (id) => {
        c.clear();
        c.send({ cmd: 'play', id: id || 'DemoVideo01', rect: '1280x720' });
        await c.waitFor((x) => x.ev === 'state' && x.state === 'playing');
        subs.playerState('PLAYER_STATE_PLAY');
    };

    await t('app disconnect stops within 1 s', async () => {
        await playing();
        const child = d.child;
        const t0 = Date.now();
        c.destroy();
        while (ours().length && Date.now() - t0 < 1000) await sleep(10);
        assert.strictEqual(ours().length, 0);
        assert.ok(child.killed || child.exitCode !== null || d.child === null);
        assert.strictEqual(d.state, 'idle');
        c = await client(d.opts.sock);
    });

    await t('fault (uncaught error path) disconnects and goes idle', async () => {
        await playing();
        d.fault(new Error('boom'));
        await c.waitFor((x) => x.ev === 'error' && /boom/.test(x.msg));
        await c.waitFor((x) => x.ev === 'state' && x.state === 'idle');
        assert.strictEqual(ours().length, 0);
        assert.strictEqual(d.child, null);
    });

    await t('ytdec dies -> one restart with seek to the clock; second death -> error, audio keeps playing', async () => {
        await sleep(500); fs.writeFileSync(ytlog, ''); setMode('crash'); // let earlier children finish logging
        await playing();
        tick(4000);
        const err = await c.waitFor((x) => x.ev === 'error' && /audio only/.test(x.msg), 3000);
        assert.ok(err);
        const argv = ytdecLines().filter((l) => / argv /.test(l));
        assert.strictEqual(argv.length, 2, ytdecLines().filter((l) => !/ in clock/.test(l)).join('\n'));
        assert.ok(ytdecLines().some((l) => / in seek 4000$/.test(l)));
        assert.strictEqual(ours().length, 1);
        assert.strictEqual(d.state, 'playing');
        c.send({ cmd: 'stop' });
        await c.waitFor((x) => x.ev === 'state' && x.state === 'idle');
    });

    await t('no decoded frames for the watchdog period -> child restarted', async () => {
        fs.writeFileSync(ytlog, ''); setMode('stall');
        await playing();
        await sleep(2200);
        const argv = ytdecLines().filter((l) => / argv /.test(l));
        assert.ok(argv.length >= 2, 'restarted: ' + argv.length);
        assert.ok(logs.some((l) => /watchdog/.test(l)));
        setMode('ok');
        c.send({ cmd: 'stop' });
        await c.waitFor((x) => x.ev === 'state' && x.state === 'idle');
    });

    await t('STOP mid-file -> held as paused; resume plays the file again at that point', async () => {
        await playing();
        tick(20000);
        calls.length = 0;
        subs.playerState('PLAYER_STATE_STOP');
        await c.waitFor((x) => x.ev === 'state' && x.state === 'paused');
        assert.strictEqual(ours().length, 1, 'audio kept connected');
        c.send({ cmd: 'resume' });
        await c.waitFor((x) => x.ev === 'state' && x.state === 'playing');
        await waitUntil(() => called('playFile').length > 0);
        tick(0);   // the restarted file's first tick: then setTime
        await waitUntil(() => called('setTime').length > 0);
        assert.strictEqual(called('playFile').length, 1);
        assert.deepStrictEqual(called('setTime')[0].a, { newTimeElapsed: 20000 });
        assert.deepStrictEqual(called('sendButtonEvent').map((x) => x.a.button), ['STOP'], 'no PLAY after a stop (ignored): released, connected again');
        assert.strictEqual(called('disconnect').length, 1);
        assert.strictEqual(called('connect').length, 1);
        assert.strictEqual(ours().length, 1, 'one connection');
        c.send({ cmd: 'stop' });
        await c.waitFor((x) => x.ev === 'state' && x.state === 'idle');
    });

    await t('end of file (STOP after PLAY, near the end) -> ended, audio released', async () => {
        await playing();
        tick(58000);
        subs.playerState('PLAYER_STATE_STOP');
        await c.waitFor((x) => x.ev === 'state' && x.state === 'ended');
        assert.strictEqual(ours().length, 0);
    });

    const fetchLog = () => JSON.parse(fs.readFileSync(ctl + '.log', 'utf8'));
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return false; } };
    const fetchPlay = async (id) => {
        c.clear();
        c.send({ cmd: 'play', id: id, rect: '1280x720' });
        return c.waitFor((x) => x.ev === 'state' && x.state === 'playing', 4000);
    };

    await t('play uncached: the fetcher (env {}, cwd /) into a fresh dir; preparing pct; playing after audio_ready + 10 s of video', async () => {
        fs.writeFileSync(ctl, ''); fs.writeFileSync(ytlog, ''); setMode('ok');
        const id = 'FFFFFFFFFF1', dir = path.join(cache, id);
        fs.mkdirSync(dir); // a killed fetch's leftover: fetched again
        ['audio.m4a', 'index.bin', 'video.h264.part'].forEach((f) => fs.writeFileSync(path.join(dir, f), 'old'));
        assert.strictEqual(isPlayable(dir), false);
        const pl = await fetchPlay(id);
        assert.deepStrictEqual(c.evs.filter((x) => x.ev === 'state' && x.state === 'preparing').map((x) => x.pct), [0, 35, 70, 94, 99]);
        assert.strictEqual(pl.title, 'Fetched ' + id);
        assert.strictEqual(pl.buffering, false);
        const l = fetchLog();
        assert.deepStrictEqual(l.argv.slice(1), ['fetch', '--cache-dir', path.join(cache, 'ytdlp'), '--height', '720', '--', id, dir]);
        assert.strictEqual(l.cwd, '/');
        assert.ok(l.env.length < 5, 'an empty env: ' + l.env);
        assert.ok(alive(l.pid), 'still fetching');
        assert.ok(fs.statSync(path.join(cache, 'ytdlp')).isDirectory());
        assert.strictEqual(d.fetchedMs, 12000);
        assert.strictEqual(d.preparing, id);
        assert.strictEqual(called('playFile').slice(-1)[0].a.path, path.join(dir, 'audio.m4a'));
        assert.strictEqual(fs.statSync(dir).mode & 0o777, 0o711, 'the media engine passes through, nobody lists it');
        await waitUntil(() => ytdecLines().some((l2) => / argv --dir /.test(l2)));
    });

    await t('buffering: true when the clock nears the fetched video, the watchdog spares ytdec; fetcher done -> false', async () => {
        c.clear(); fs.writeFileSync(ytlog, ''); setMode('stall');
        tick(11500);
        const b = await c.waitFor((x) => x.ev === 'state' && x.buffering === true);
        assert.strictEqual(b.state, 'playing');
        d.child.kill('SIGKILL'); // death 1: restarted, now a ytdec that decodes nothing
        const wd = logs.filter((l) => /watchdog/.test(l)).length;
        await sleep(2000);
        assert.strictEqual(logs.filter((l) => /watchdog/.test(l)).length, wd, 'no watchdog kill while buffering');
        assert.strictEqual(ytdecLines().filter((l) => / argv /.test(l)).length, 1);
        fs.writeFileSync(ctl, 'done');
        await c.waitFor((x) => x.ev === 'state' && x.state === 'playing' && x.buffering === false);
        assert.strictEqual(d.fetchedMs, Infinity);
        assert.ok(d.fetcher === null && d.preparing === null);
        assert.ok(isPlayable(path.join(cache, 'FFFFFFFFFF1')));
        setMode('ok');
        c.send({ cmd: 'stop' });
        await c.waitFor((x) => x.ev === 'state' && x.state === 'idle');
    });

    await t('fetcher error after playback began: one "video incomplete" error, audio plays on', async () => {
        fs.writeFileSync(ctl, '');
        await fetchPlay('FFFFFFFFFF2');
        fs.writeFileSync(ctl, 'error');
        await c.waitFor((x) => x.ev === 'error' && x.msg === 'video incomplete: HTTP 403');
        await sleep(300);
        assert.strictEqual(c.evs.filter((x) => x.ev === 'error').length, 1);
        assert.strictEqual(d.state, 'playing');
        assert.strictEqual(ours().length, 1);
        c.send({ cmd: 'stop' });
        await c.waitFor((x) => x.ev === 'state' && x.state === 'idle');
    });

    await t('stop kills the fetcher', async () => {
        fs.writeFileSync(ctl, '');
        await fetchPlay('FFFFFFFFFF3');
        const pid = fetchLog().pid;
        assert.ok(alive(pid));
        c.send({ cmd: 'stop' });
        await c.waitFor((x) => x.ev === 'state' && x.state === 'idle');
        assert.ok(!alive(pid), 'gone by the idle state');
        assert.ok(d.fetcher === null && d.preparing === null);
    });

    await t('speed: a warm spare takes the prefetch (stream lookup); the next spare takes the play, with --info', async () => {
        fs.writeFileSync(ctl, ''); setMode('ok');
        const id = 'FFFFFFFFFF5';
        d.opts.spare = true;
        c.send({ cmd: 'status' });                                   // the app in use
        await waitUntil(() => d.spare && d.spare.warm, 3000);
        const sp = d.spare.child.pid;
        c.send({ cmd: 'prefetch', id: id });
        await waitUntil(() => d.extracting, 1000);
        assert.ok(d.spare && d.spare.child.pid !== sp, 'a new spare at once, not at the next poll');
        await waitUntil(() => fs.existsSync(d.infoFile(id)) && !d.extracting, 3000);
        const x = JSON.parse(fs.readFileSync(ctl + '.extract', 'utf8'));
        assert.strictEqual(x.served, true);
        assert.deepStrictEqual(x.argv, ['extract', '--cache-dir', path.join(cache, 'ytdlp'), '--', id, d.infoFile(id)]);
        assert.ok(!alive(sp) || !d.spare || d.spare.child.pid !== sp, 'the spare was used up');
        c.send({ cmd: 'prefetch', id: id });                         // fresh: not looked up again
        assert.strictEqual(d.extracting, null);
        await waitUntil(() => d.spare && d.spare.warm, 3000);
        await fetchPlay(id);
        const l = fetchLog();
        assert.strictEqual(l.served, true);
        assert.deepStrictEqual(l.argv.slice(1), ['fetch', '--cache-dir', path.join(cache, 'ytdlp'), '--height', '720', '--info', d.infoFile(id), '--', id, path.join(cache, id)]);
        c.send({ cmd: 'stop' });
        await c.waitFor((x2) => x2.ev === 'state' && x2.state === 'idle');
        d.opts.spare = false;
        d.keepWarm();
        assert.strictEqual(d.spare, null, 'spare off: killed');
    });

    await t('extras: chapters + SponsorBlock (hashed prefix, cached), a segment skipped once; position kept, resumed', async () => {
        const id = 'SSSSSSSSSS1', dir = path.join(cache, id);
        mkVideo(id);
        fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ id: id, title: 'T', channel: 'C', duration_s: 60, chapters: [[0, 'Intro'], [30000, 'Main']] }));
        const pre = require('crypto').createHash('sha256').update(id).digest('hex').slice(0, 4);
        yt.sb = (url) => ({ status: 200, body: JSON.stringify([{ videoID: 'other111111', segments: [{ category: 'sponsor', actionType: 'skip', segment: [1, 50] }] },
            { videoID: id, segments: [{ category: 'sponsor', actionType: 'skip', segment: [10, 20] }, { category: 'filler', actionType: 'skip', segment: [40, 45] }, { category: 'intro', actionType: 'mute', segment: [0, 5] }] }]) });
        yt.calls.length = 0;
        await playing(id);
        const ex = await c.waitFor((x) => x.ev === 'extras' && x.segments.length);
        assert.deepStrictEqual(ex, { ev: 'extras', id: id, chapters: [[0, 'Intro'], [30000, 'Main']], segments: [[10000, 20000, 'sponsor']] });
        const sbUrl = yt.calls.find((x) => /sponsor/.test(x.url)).url;
        assert.ok(sbUrl.indexOf('skipSegments/' + pre + '?') > 0 && /categories=/.test(sbUrl), sbUrl);
        calls.length = 0;
        tick(12000);
        const sk = await c.waitFor((x) => x.ev === 'skipped');
        assert.deepStrictEqual(sk, { ev: 'skipped', category: 'sponsor', ms: 10000 });
        await waitUntil(() => called('setTime').length);
        assert.strictEqual(called('setTime').slice(-1)[0].a.newTimeElapsed, 20000);
        tick(15000);                                                 // back into it: played
        await sleep(100);
        assert.strictEqual(c.evs.filter((x) => x.ev === 'skipped').length, 1);
        tick(25000);
        c.send({ cmd: 'stop' });
        const pos = await c.waitFor((x) => x.ev === 'positions');
        assert.deepStrictEqual([pos.items[0].id, pos.items[0].ms, pos.items[0].done], [id, 25000, false]);
        assert.strictEqual(JSON.parse(fs.readFileSync(path.join(cache, 'positions.json'), 'utf8'))[id].ms, 25000);
        assert.strictEqual(fs.statSync(path.join(cache, 'positions.json')).mode & 0o777, 0o600, 'the watch history: root only');
        d.opts.resume = true; calls.length = 0; yt.calls.length = 0;
        await playing(id);
        tick(500);
        await waitUntil(() => called('setTime').length);
        assert.strictEqual(called('setTime')[0].a.newTimeElapsed, 25000, 'resumed where it was left');
        assert.strictEqual(yt.calls.filter((x) => /sponsor/.test(x.url)).length, 0, 'segments from sb.json');
        c.send({ cmd: 'stop' });
        await c.waitFor((x) => x.ev === 'state' && x.state === 'idle');
        d.opts.resume = false;
        fs.rmSync ? fs.rmSync(dir, { recursive: true }) : null;
    });

    await t('SponsorBlock: the play\'s skip list; other categories (outro) only in extras, for the app\'s Skip button', async () => {
        const id = 'SSSSSSSSSS2', dir = path.join(cache, id);
        mkVideo(id);
        fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ id: id, title: 'T', channel: 'C', duration_s: 60 }));
        yt.sb = () => ({ status: 200, body: JSON.stringify([{ videoID: id, segments: [{ category: 'sponsor', actionType: 'skip', segment: [10, 20] },
            { category: 'outro', actionType: 'skip', segment: [50, 58] }] }]) });
        c.clear();
        c.send({ cmd: 'play', id: id, rect: '1280x720', skip: ['outro'] });
        await c.waitFor((x) => x.ev === 'state' && x.state === 'playing');
        subs.playerState('PLAYER_STATE_PLAY');
        const ex = await c.waitFor((x) => x.ev === 'extras' && x.segments.length);
        assert.deepStrictEqual(ex.segments, [[10000, 20000, 'sponsor'], [50000, 58000, 'outro']]);
        tick(12000);
        await sleep(150);
        assert.strictEqual(c.evs.filter((x) => x.ev === 'skipped').length, 0, 'sponsor not in this play\'s list: played');
        tick(51000);
        const sk = await c.waitFor((x) => x.ev === 'skipped');
        assert.strictEqual(sk.category, 'outro');
        c.send({ cmd: 'stop' });
        await c.waitFor((x) => x.ev === 'state' && x.state === 'idle');
        fs.rmSync(dir, { recursive: true, force: true });
    });

    await t('fetcher error before playable -> error state + "fetch: <msg>", nothing played', async () => {
        fs.writeFileSync(ctl, 'fail'); c.clear(); calls.length = 0;
        c.send({ cmd: 'play', id: 'FFFFFFFFFF4', rect: '1280x720' });
        await c.waitFor((x) => x.ev === 'state' && x.state === 'error', 4000);
        await c.waitFor((x) => x.ev === 'error' && x.msg === 'fetch: boom');
        assert.strictEqual(called('playFile').length, 0);
        assert.strictEqual(d.fetcher, null);
    });

    await t('fetcher error before playable: retried after a wait (retry event), then plays', async () => {
        fs.writeFileSync(ctl, 'fail'); c.clear(); calls.length = 0;
        d.opts.fetchRetryMs = [300];
        c.send({ cmd: 'play', id: 'FFFFFFFFFR4', rect: '1280x720' });
        const r = await c.waitFor((x) => x.ev === 'retry', 4000);
        assert.deepStrictEqual(r, { ev: 'retry', id: 'FFFFFFFFFR4', n: 1, msg: 'boom' });
        fs.writeFileSync(ctl, '');                          // the network back
        await c.waitFor((x) => x.ev === 'state' && x.state === 'playing' && x.id === 'FFFFFFFFFR4', 4000);
        assert.ok(!c.evs.some((x) => x.ev === 'state' && x.state === 'error'), 'no error on the way');
        d.opts.fetchRetryMs = [];
        c.send({ cmd: 'stop' }); await c.waitFor((x) => x.ev === 'state' && x.state === 'idle');
        fs.rmSync(path.join(cache, 'FFFFFFFFFR4'), { recursive: true, force: true });
    });

    await t('a refused video (unavailable) is not retried', async () => {
        fs.writeFileSync(ctl, 'gone'); c.clear();
        d.opts.fetchRetryMs = [300];
        c.send({ cmd: 'play', id: 'FFFFFFFFFG4', rect: '1280x720' });
        await c.waitFor((x) => x.ev === 'error' && x.msg === 'fetch: Video unavailable', 4000);
        assert.ok(!c.evs.some((x) => x.ev === 'retry'), 'no retry');
        d.opts.fetchRetryMs = [];
        fs.writeFileSync(ctl, '');
    });

    await t('a second play during the first one\'s playFile keeps the second\'s audio', async () => {
        c.clear(); slowPlayFile = 300;
        c.send({ cmd: 'play', id: 'DemoVideo01', rect: '1280x720' });
        await sleep(50);
        c.send({ cmd: 'play', id: 'PPPPPPPPPPP', rect: '1280x720' });
        await c.waitFor((x) => x.ev === 'state' && x.state === 'playing' && x.id === 'PPPPPPPPPPP', 4000);
        await sleep(800);
        slowPlayFile = 0;
        assert.strictEqual(ours().length, 1, JSON.stringify(ours()));
        assert.strictEqual(called('playFile').slice(-1)[0].a.path, path.join(cache, 'PPPPPPPPPPP', 'audio.m4a'));
        c.send({ cmd: 'stop' });
        await c.waitFor((x) => x.ev === 'state' && x.state === 'idle');
        assert.strictEqual(ours().length, 0);
    });

    // ---- head start: audio.head.m4a first, audio.m4a when the fetcher has it all
    const headPlay = async (id, m) => {
        fs.writeFileSync(ctl, m); fs.writeFileSync(ytlog, ''); setMode('ok'); calls.length = 0;
        const pl = await fetchPlay(id);
        calls.splice(0, calls.findIndex((x) => x.m === 'connect')); // the previous play's STOP
        subs.playerState('PLAYER_STATE_PLAY');
        return pl;
    };
    const hdir = (id) => path.join(cache, id);
    const ytdecIns = () => ytdecLines().map((l) => l.split(' ').slice(1).join(' ')).filter((l) => /^in (pause|resume|seek)/.test(l));
    const stopIdle = async () => { c.send({ cmd: 'stop' }); await c.waitFor((x) => x.ev === 'state' && x.state === 'idle'); };

    await t('head: plays audio.head.m4a on audio_head + 10 s video; audio_ready -> playFile(audio.m4a) on the same connection + setTime; head removed', async () => {
        const id = 'FFFFFFFFFH1';
        const pl = await headPlay(id, 'head');
        assert.strictEqual(pl.buffering, false);
        assert.strictEqual(called('playFile')[0].a.path, path.join(hdir(id), 'audio.head.m4a'));
        await waitUntil(() => called('setTime').length === 1);
        assert.deepStrictEqual(called('playFile').map((x) => path.basename(x.a.path)), ['audio.head.m4a', 'audio.m4a']);
        assert.ok(called('setTime')[0].a.newTimeElapsed < 2000, JSON.stringify(called('setTime')[0].a));
        assert.strictEqual(called('connect').length, 1, 'one connection');
        assert.strictEqual(ours().length, 1);
        assert.ok(!fs.existsSync(path.join(hdir(id), 'audio.head.m4a')), 'head removed after the switch');
        assert.strictEqual(d.head, null);
        assert.strictEqual(d.state, 'playing');
        await stopIdle();
    });

    await t('head: total is the video\'s (meta), not the head file\'s; switch seeks to the extrapolated clock; stale times after it ignored', async () => {
        const id = 'FFFFFFFFFH2';
        await headPlay(id, 'hold');
        c.clear();
        tick(20000);
        const tm = await c.waitFor((x) => x.ev === 'time');
        assert.deepStrictEqual(tm, { ev: 'time', elapsed: 20000, total: 600000 });
        await sleep(200);
        fs.writeFileSync(ctl, 'full');
        await waitUntil(() => called('setTime').length === 1);
        const at = called('setTime')[0].a.newTimeElapsed;
        assert.ok(at >= 20200 && at < 22000, 'clock extrapolated: ' + at);
        assert.strictEqual(path.basename(called('playFile').slice(-1)[0].a.path), 'audio.m4a');
        tick(300); // the restart's own time before the setTime landed
        assert.ok(d.elapsed >= 20000, 'stale time ignored: ' + d.elapsed);
        assert.ok(!ytdecLines().some((l) => / in clock 300 /.test(l)), 'ytdec never sees the restart at 0');
        await stopIdle();
    });

    await t('head: the full file\'s PLAY during the switch still arms its end -> ended', async () => {
        await headPlay('FFFFFFFFFH9', 'hold');
        tick(20000);
        slowPlayFile = 300;
        fs.writeFileSync(ctl, 'done');
        await waitUntil(() => called('playFile').length === 2);
        subs.playerState('PLAYER_STATE_STOP'); // the head stops for the new file: ignored
        subs.playerState('PLAYER_STATE_PLAY'); // the full file starts, before our setTime
        await waitUntil(() => called('setTime').length === 1);
        slowPlayFile = 0;
        assert.strictEqual(d.state, 'playing');
        subs.currentItemTime({ elapsed: 598000, total: 600000 });
        subs.playerState('PLAYER_STATE_STOP');
        await c.waitFor((x) => x.ev === 'state' && x.state === 'ended');
        assert.strictEqual(ours().length, 0);
    });

    await t('head runs out before audio.m4a: buffering, player paused, STOP at its end is not `ended`; audio_ready resumes there', async () => {
        const id = 'FFFFFFFFFH3';
        await headPlay(id, 'hold');
        c.clear();
        tick(58600); // within headMarginMs of the 60 s head
        const b = await c.waitFor((x) => x.ev === 'state' && x.buffering === true);
        assert.strictEqual(b.state, 'playing');
        assert.deepStrictEqual(called('sendButtonEvent').map((x) => x.a.button), ['STOP']);
        subs.playerState('PLAYER_STATE_STOP');
        tick(59500);
        await sleep(200);
        assert.strictEqual(d.state, 'playing');
        assert.strictEqual(d.elapsed, 58600);
        assert.ok(!c.evs.some((x) => x.ev === 'state' && x.state === 'ended'));
        assert.strictEqual(ours().length, 1);
        assert.deepStrictEqual(ytdecIns(), ['in pause']);
        fs.writeFileSync(ctl, 'done'); // all of it: past the 12 s of video fetched, buffering ends with the fetch
        await c.waitFor((x) => x.ev === 'state' && x.state === 'playing' && x.buffering === false);
        assert.deepStrictEqual(called('setTime').map((x) => x.a.newTimeElapsed), [58600]);
        assert.strictEqual(path.basename(called('playFile').slice(-1)[0].a.path), 'audio.m4a');
        await waitUntil(() => ytdecIns().length === 3);
        assert.deepStrictEqual(ytdecIns(), ['in pause', 'in seek 58600', 'in resume']);
        await stopIdle();
    });

    await t('preparing on the head: pct moves with the video lead', async () => {
        c.clear();
        await headPlay('FFFFFFFFFHA', 'head');
        assert.deepStrictEqual(c.evs.filter((x) => x.ev === 'state' && x.state === 'preparing').map((x) => x.pct), [0, 35, 70, 94, 99]);
        await stopIdle();
    });

    await t('seek past the head before audio.m4a: buffering, no setTime on the head; audio_ready -> playFile + setTime there', async () => {
        const id = 'FFFFFFFFFH4';
        await headPlay(id, 'hold');
        c.clear();
        c.send({ cmd: 'seek', ms: 300000 });
        await c.waitFor((x) => x.ev === 'state' && x.buffering === true);
        assert.strictEqual(called('setTime').length, 0);
        assert.deepStrictEqual(called('sendButtonEvent').map((x) => x.a.button), ['STOP']);
        c.send({ cmd: 'pause' });
        await c.waitFor((x) => x.ev === 'state' && x.state === 'paused');
        c.send({ cmd: 'resume' }); // still waiting: playing + buffering, no PLAY
        await c.waitFor((x) => x.ev === 'state' && x.state === 'playing' && x.buffering === true);
        assert.ok(!called('sendButtonEvent').some((x) => x.a.button === 'PLAY'));
        fs.writeFileSync(ctl, 'done'); // all of it: past the 12 s of video fetched, buffering ends with the fetch
        await c.waitFor((x) => x.ev === 'state' && x.state === 'playing' && x.buffering === false);
        assert.deepStrictEqual(called('setTime').map((x) => x.a.newTimeElapsed), [300000]);
        await waitUntil(() => ytdecIns().slice(-2).join() === 'in seek 300000,in resume');
        await stopIdle();
    });

    await t('paused on the head when audio.m4a arrives: no switch until resume, which plays audio.m4a at that point', async () => {
        const id = 'FFFFFFFFFH5';
        await headPlay(id, 'hold');
        tick(15000);
        c.send({ cmd: 'pause' });
        await c.waitFor((x) => x.ev === 'state' && x.state === 'paused');
        fs.writeFileSync(ctl, 'full');
        await waitUntil(() => d.fullReady);
        await sleep(100);
        assert.strictEqual(called('playFile').length, 1);
        c.send({ cmd: 'resume' });
        await waitUntil(() => called('setTime').length === 1, 5000);   // (no tick comes: resume's 3 s tick wait runs out first)
        assert.strictEqual(path.basename(called('playFile').slice(-1)[0].a.path), 'audio.m4a');
        assert.deepStrictEqual(called('setTime')[0].a, { newTimeElapsed: 15000 });
        assert.ok(!called('sendButtonEvent').some((x) => x.a.button === 'PLAY'));
        await stopIdle();
    });

    await t('stop during the switch: release waits for the playFile, no setTime after, audio released', async () => {
        const id = 'FFFFFFFFFH6';
        await headPlay(id, 'hold');
        tick(10000);
        slowPlayFile = 400;
        fs.writeFileSync(ctl, 'full');
        await waitUntil(() => called('playFile').length === 2);
        c.send({ cmd: 'stop' });
        await c.waitFor((x) => x.ev === 'state' && x.state === 'idle');
        slowPlayFile = 0;
        await sleep(300);
        assert.strictEqual(called('setTime').length, 0);
        assert.strictEqual(ours().length, 0);
        const ms = calls.map((x) => x.m);
        assert.ok(ms.lastIndexOf('playFile') < ms.indexOf('disconnect'), ms.join());
    });

    await t('a new play during the switch: the old switch does nothing more, the new video plays', async () => {
        await headPlay('FFFFFFFFFH7', 'hold');
        slowPlayFile = 300;
        fs.writeFileSync(ctl, 'full');
        await waitUntil(() => called('playFile').length === 2);
        c.clear();
        c.send({ cmd: 'play', id: 'DemoVideo01', rect: '1280x720' });
        await c.waitFor((x) => x.ev === 'state' && x.state === 'playing' && x.id === 'DemoVideo01', 4000);
        slowPlayFile = 0;
        await sleep(300);
        assert.strictEqual(called('setTime').length, 0);
        assert.strictEqual(ours().length, 1);
        assert.strictEqual(called('playFile').slice(-1)[0].a.path, path.join(cache, 'DemoVideo01', 'audio.m4a'));
        await stopIdle();
    });

    await t('fetcher dies while only the head is there: error state, audio released', async () => {
        await headPlay('FFFFFFFFFH8', 'hold');
        fs.writeFileSync(ctl, 'error');
        await c.waitFor((x) => x.ev === 'state' && x.state === 'error', 4000);
        await c.waitFor((x) => x.ev === 'error' && x.msg === 'fetch: HTTP 403');
        assert.strictEqual(ours().length, 0);
    });

    // ---- account and feeds
    const authEv = (st) => (x) => x.ev === 'auth' && x.state === st;
    const readAcct = () => JSON.parse(fs.readFileSync(acct, 'utf8'));
    const ok = (o) => ({ status: 200, body: JSON.stringify(o) });

    await t('zoom while playing: ytdec again with the other mode at the clock, no error; same mode does nothing', async () => {
        await sleep(300); fs.writeFileSync(ytlog, ''); setMode('ok');
        await playing();
        await waitUntil(() => ytdecLines().some((l) => / argv /.test(l)));
        tick(4000);
        c.send({ cmd: 'fill', on: true });
        await waitUntil(() => ytdecLines().filter((l) => / argv /.test(l)).length === 2);
        const argv = ytdecLines().filter((l) => / argv /.test(l));
        assert.ok(!/--fill/.test(argv[0]) && /--rect 1280x720 --fill /.test(argv[1]), argv.join('\n'));
        // (the seek reaches the new ytdec a moment after its start line: waited for, not raced)
        await waitUntil(() => ytdecLines().some((l) => / in seek 40\d\d$/.test(l)), 2000).catch(() => assert.fail('at the clock: ' + ytdecLines().slice(-3).join(' | ')));
        c.send({ cmd: 'fill', on: true });
        await sleep(300);
        assert.strictEqual(ytdecLines().filter((l) => / argv /.test(l)).length, 2);
        assert.ok(!c.evs.some((x) => x.ev === 'error'));
        c.send({ cmd: 'stop' });
        await c.waitFor((x) => x.ev === 'state' && x.state === 'idle');
    });

    await t('quality while playing: fetched again at that height; same height: nothing', async () => {
        fs.writeFileSync(ctl, ''); setMode('ok');
        const id = 'FFFFFFFFFF7';
        await fetchPlay(id);
        c.send({ cmd: 'quality', quality: '720' });            // auto is 720 here
        await sleep(300);
        assert.ok(!c.evs.some((x) => x.ev === 'state' && x.state === 'preparing' && c.evs.indexOf(x) > c.evs.findIndex((y) => y.state === 'playing')));
        c.clear();
        c.send({ cmd: 'quality', quality: '480' });
        await c.waitFor((x) => x.ev === 'state' && x.state === 'playing', 4000);
        assert.deepStrictEqual(fetchLog().argv.slice(1, 5), ['fetch', '--cache-dir', path.join(cache, 'ytdlp'), '--height'].slice(0, 4));
        assert.strictEqual(fetchLog().argv[fetchLog().argv.indexOf('--height') + 1], '480');
        c.send({ cmd: 'stop' });
        await c.waitFor((x) => x.ev === 'state' && x.state === 'idle');
    });

    await t('auth_status with no account: signed out', async () => {
        c.clear();
        c.send({ cmd: 'auth_status' });
        await c.waitFor(authEv('signed_out'));
    });

    await t('auth: creds from the base script, device code, polled until signed in; account 0600 in a dir others cannot list', async () => {
        c.clear(); yt.calls.length = 0;
        let polls = 0;
        yt.token = (b) => (++polls < 3 ? { error: 'authorization_pending' } : { access_token: 'ACCESS-1', refresh_token: 'REFRESH-1', expires_in: 72000 });
        c.send({ cmd: 'auth' });
        const e = await c.waitFor(authEv('code'));
        assert.strictEqual(e.code, 'ABC-DEF-GHI');
        assert.strictEqual(e.url, 'https://www.google.com/device');
        assert.ok(e.expires > 1700 && e.expires <= 1800, String(e.expires));
        const dc = ytCalls('/device/code')[0].body;
        assert.strictEqual(dc.client_id, '123-abc.apps.googleusercontent.com');
        assert.ok(/^[0-9a-f]{32}$/.test(dc.device_id) && dc.device_model === 'ytlr::' && /gdata\.youtube\.com/.test(dc.scope));
        c.send({ cmd: 'auth' }); // again while the code is shown: the same code, no second device flow
        await c.waitFor((x) => x.ev === 'auth' && x.state === 'code' && c.evs.filter(authEv('code')).length === 2);
        await c.waitFor(authEv('signed_in'), 3000);
        assert.strictEqual(ytCalls('/device/code').length, 1);
        assert.deepStrictEqual(ytCalls('/oauth2/token')[0].body, { client_id: '123-abc.apps.googleusercontent.com', client_secret: 'SeCrEt-1', code: 'DEV-CODE-XYZ', grant_type: 'http://oauth.net/grant_type/device/1.0' });
        assert.strictEqual(fs.statSync(acct).mode & 0o777, 0o600);
        assert.strictEqual(fs.statSync(path.dirname(acct)).mode & 0o077, 0, 'state dir stays 0700');
        const a = readAcct();
        assert.ok(a.access === 'ACCESS-1' && a.refresh === 'REFRESH-1' && a.exp > Date.now() + 71000e3);
        assert.ok(!fs.existsSync(acct + '.tmp'));
        c.send({ cmd: 'auth_status' });
        await c.waitFor((x) => authEv('signed_in')(x) && c.evs.filter(authEv('signed_in')).length === 2);
    });

    await t('feed subs: TVHTML5 browse with the token; video tiles only, each once, channel and length', async () => {
        c.clear(); yt.calls.length = 0;
        yt.browse = (h, b) => ok(BROWSE);
        c.send({ cmd: 'feed', which: 'subs' });
        const e = await c.waitFor((x) => x.ev === 'feed');
        const v1 = { id: 'VVVVVVVVVV1', title: 'First', channel: 'Chan A', duration_s: 2390, meta: ['1K views'] };
        const v2 = { id: 'VVVVVVVVVV2', title: 'Second', channel: 'Chan C', duration_s: 3723, meta: ['1K views'] };
        const v3 = { id: 'VVVVVVVVVV3', title: 'Live', channel: 'Chan D', duration_s: null, meta: ['1K views'] };
        assert.deepStrictEqual(e, { ev: 'feed', which: 'subs', items: [v1, v2, v3],
            shelves: [{ title: 'Chan A', items: [v1] }, { title: '', items: [v2, v1, v3] }] });
        const b = ytCalls('/browse')[0];
        assert.strictEqual(b.headers.Authorization, 'Bearer ACCESS-1');
        assert.strictEqual(b.body.browseId, 'FEsubscriptions');
        assert.strictEqual(b.body.context.client.clientName, 'TVHTML5');
        assert.strictEqual(ytCalls('/oauth2/token').length, 0, 'no refresh with 20 h left');
        c.send({ cmd: 'feed', which: 'wl' });
        await c.waitFor((x) => x.ev === 'feed' && x.which === 'wl');
        assert.strictEqual(ytCalls('/browse')[1].body.browseId, 'VLWL');
        c.send({ cmd: 'feed', which: 'nope' });
        await c.waitFor((x) => x.ev === 'feed' && x.which === 'nope' && x.error === 'unknown feed');
        c.send({ cmd: 'search', q: 'bunny' });
        await c.waitFor((x) => x.ev === 'results');
        assert.strictEqual(ytCalls('/youtubei/v1/search')[0].headers.Authorization, 'Bearer ACCESS-1', 'signed in: searched with the token');
    });

    await t('token with < 5 min left refreshed before the browse; a 401 forces one more refresh', async () => {
        const a = readAcct(); a.exp = Date.now() + 60000; fs.writeFileSync(acct, JSON.stringify(a), { mode: 0o600 });
        c.clear(); yt.calls.length = 0;
        let n = 1;
        yt.token = (b) => { assert.deepStrictEqual(b, { client_id: '123-abc.apps.googleusercontent.com', client_secret: 'SeCrEt-1', refresh_token: 'REFRESH-1', grant_type: 'refresh_token' }); return { access_token: 'ACCESS-' + (++n), expires_in: 3600 }; };
        yt.browse = (h) => (h.Authorization === 'Bearer ACCESS-2' ? { status: 401, body: '{}' } : ok(BROWSE));
        c.send({ cmd: 'feed', which: 'home' });
        const e = await c.waitFor((x) => x.ev === 'feed');
        assert.strictEqual(e.items.length, 3, JSON.stringify(e));
        assert.deepStrictEqual(ytCalls('/browse').map((x) => x.headers.Authorization), ['Bearer ACCESS-2', 'Bearer ACCESS-3']);
        assert.strictEqual(ytCalls('/browse')[0].body.browseId, 'FEwhat_to_watch');
        const a2 = readAcct();
        assert.ok(a2.access === 'ACCESS-3' && a2.refresh === 'REFRESH-1' && a2.exp > Date.now() + 3500e3);
        assert.strictEqual(fs.statSync(acct).mode & 0o777, 0o600);
    });

    await t('youtube offline: feed error, still signed in', async () => {
        c.clear();
        yt.browse = () => Promise.reject(new Error('ENETUNREACH'));
        c.send({ cmd: 'feed', which: 'subs' });
        await c.waitFor((x) => x.ev === 'feed' && x.error === 'feed offline');
        assert.ok(fs.existsSync(acct));
    });

    await t('refresh answered invalid_grant: signed out, account gone, the feed says so', async () => {
        const a = readAcct(); a.exp = Date.now() - 1000; fs.writeFileSync(acct, JSON.stringify(a), { mode: 0o600 });
        c.clear();
        yt.token = () => ({ error: 'invalid_grant' });
        c.send({ cmd: 'feed', which: 'subs' });
        await c.waitFor(authEv('signed_out'));
        await c.waitFor((x) => x.ev === 'feed' && x.error === 'signed out');
        assert.ok(!fs.existsSync(acct));
    });

    await t('sign_out deletes the account; a code left to expire -> signed out; no creds -> auth error', async () => {
        fs.writeFileSync(acct, JSON.stringify({ cid: 'x', sec: 'y', access: 'ACCESS-1', refresh: 'REFRESH-1', exp: Date.now() + 1e7 }), { mode: 0o600 });
        c.clear();
        c.send({ cmd: 'sign_out' });
        await c.waitFor(authEv('signed_out'));
        assert.ok(!fs.existsSync(acct));
        c.clear(); yt.inline = true; yt.expiresIn = 0.15;
        yt.token = () => ({ error: 'authorization_pending' });
        c.send({ cmd: 'auth' });
        await c.waitFor(authEv('code'));
        await c.waitFor(authEv('signed_out'), 2000);
        c.clear(); yt.creds = false; d.account.cred = null; // a fresh process: the page has no client id
        c.send({ cmd: 'auth' });
        const e = await c.waitFor(authEv('error'));
        assert.ok(/no client id/.test(e.msg));
        yt.creds = undefined; yt.inline = false; yt.expiresIn = 1800;
    });

    await t('feed: prototype names are unknown feeds; asks while one is in flight share its browse', async () => {
        fs.writeFileSync(acct, JSON.stringify({ cid: 'x', sec: 'y', access: 'ACCESS-1', refresh: 'REFRESH-1', exp: Date.now() + 1e7 }), { mode: 0o600 });
        c.clear(); yt.calls.length = 0;
        ['constructor', 'toString', '__proto__', 'hasOwnProperty'].forEach((w) => c.send({ cmd: 'feed', which: w }));
        await c.waitFor(() => c.evs.filter((x) => x.ev === 'feed' && x.error === 'unknown feed').length === 4);
        assert.strictEqual(ytCalls('/browse').length, 0);
        yt.slow = { '/browse': 200 }; yt.browse = () => ok(BROWSE);
        for (let i = 0; i < 5; i++) c.send({ cmd: 'feed', which: 'subs' });
        await c.waitFor((x) => x.ev === 'feed' && x.which === 'subs' && x.items);
        await sleep(300);
        assert.strictEqual(ytCalls('/browse').length, 1, 'one browse for five asks');
        c.send({ cmd: 'feed', which: 'subs' });
        await c.waitFor(() => ytCalls('/browse').length === 2, 2000);
        yt.slow = null;
    });

    await t('sign_out while a refresh is in flight: the new token is not written back', async () => {
        fs.writeFileSync(acct, JSON.stringify({ cid: 'x', sec: 'y', access: 'ACCESS-1', refresh: 'REFRESH-1', exp: Date.now() - 1000 }), { mode: 0o600 });
        c.clear(); yt.calls.length = 0;
        yt.slow = { '/oauth2/token': 200 }; yt.token = () => ({ access_token: 'ACCESS-2', expires_in: 3600 });
        c.send({ cmd: 'feed', which: 'home' });
        await waitUntil(() => ytCalls('/oauth2/token').length === 1);
        c.send({ cmd: 'sign_out' });
        await c.waitFor(authEv('signed_out'));
        await c.waitFor((x) => x.ev === 'feed' && x.error === 'signed out', 2000);
        await sleep(100);
        assert.ok(!fs.existsSync(acct), 'still signed out');
        assert.strictEqual(ytCalls('/browse').length, 0);
        yt.slow = null;
    });

    await t('sign_out during the device-code request: no code, no polling', async () => {
        c.clear(); yt.calls.length = 0;
        yt.slow = { '/device/code': 200 }; yt.token = () => ({ error: 'authorization_pending' });
        c.send({ cmd: 'auth' });
        await waitUntil(() => ytCalls('/device/code').length === 1);
        c.send({ cmd: 'sign_out' });
        await sleep(400);
        assert.strictEqual(c.evs.filter(authEv('code')).length, 0, JSON.stringify(c.evs));
        assert.strictEqual(d.account.pending, null);
        assert.strictEqual(ytCalls('/oauth2/token').length, 0, 'no poll');
        yt.slow = null;
    });

    await t('sign_out while a poll is offline: not re-armed', async () => {
        c.clear(); yt.calls.length = 0;
        yt.slow = { '/oauth2/token': 150 }; yt.token = () => { throw new Error('ENETUNREACH'); };
        c.send({ cmd: 'auth' });
        await c.waitFor(authEv('code'));
        await waitUntil(() => ytCalls('/oauth2/token').length === 1);
        c.send({ cmd: 'sign_out' });
        await sleep(500);
        assert.strictEqual(ytCalls('/oauth2/token').length, 1, 'no poll after the sign-out');
        yt.slow = null;
    });

    await t('client id/secret scraped once a process; scraped again once when the device code is refused', async () => {
        c.clear(); yt.calls.length = 0;
        yt.token = () => ({ error: 'authorization_pending' });
        c.send({ cmd: 'auth' });
        await c.waitFor(authEv('code'));
        assert.strictEqual(ytCalls('/tv').length, 0, 'cached: no scrape');
        c.send({ cmd: 'sign_out' }); await c.waitFor(authEv('signed_out'));
        c.clear(); yt.calls.length = 0; yt.refuse = 1;
        c.send({ cmd: 'auth' });
        await c.waitFor(authEv('code'));
        assert.strictEqual(ytCalls('/tv').length, 1, 'refused: one scrape');
        assert.strictEqual(ytCalls('/device/code').length, 2);
        c.send({ cmd: 'sign_out' }); await c.waitFor(authEv('signed_out'));
        c.clear(); yt.calls.length = 0; yt.refuse = 2;
        c.send({ cmd: 'auth' });
        const e = await c.waitFor(authEv('error'));
        assert.ok(/refused/.test(e.msg) && ytCalls('/tv').length === 1 && ytCalls('/device/code').length === 2, 'refused twice: an error, no loop');
        yt.refuse = 0;
    });

    // ---- the fetch uid and the fetch helper
    const fsRoot = path.join(tmp, 'uidfs');
    const mkdirs = (dd) => { if (!fs.existsSync(dd)) { mkdirs(path.dirname(dd)); fs.mkdirSync(dd); } }; // (Node 8: no recursive)
    const put = (f, text) => { mkdirs(path.dirname(f)); fs.writeFileSync(f, text); };
    const rejects = (p, re) => p.then(() => { throw new Error('resolved, expected ' + re); }, (e) => assert.ok(re.test(e.message), e.message)); // (Node 8: no assert.rejects)
    const uo = { stateDir: path.join(fsRoot, 'var/opt/jap-ridetube-d/state'), etcDir: path.join(fsRoot, 'etc'), oapRoot: path.join(fsRoot, 'oap'),
        toolRoot: path.join(fsRoot, 'var/opt'), procDir: path.join(fsRoot, 'proc'), log: (m) => logs.push(m),
        mainapps: [{ root: path.join(fsRoot, 'mainapp'), hmi: 'HmiMain3D' }, { root: path.join(fsRoot, 'mainapp21'), hmi: 'Hmi8' }] };

    await t('fetch uid: none without MainApp\'s ranges; then the lowest free above them, written for the uplink', async () => {
        assert.strictEqual(pickFetchUid(uo), null);
        assert.ok(logs.some((l) => /internet uid: none: MainApp/.test(l)));
        assert.ok(!fs.existsSync(path.join(uo.stateDir, 'internet-uids')));
        put(path.join(fsRoot, 'mainapp/config/base.json'), JSON.stringify({ usableUidsAndGids: { min: 10000, max: 12499 },
            usableUidsAndGidsRse: { rse1: { min: 12600, max: 12700 } }, mainAppUids: [12701] }));
        put(path.join(fsRoot, 'etc/passwd'), 'root:x:0:0::/root:/bin/sh\nfoo:x:12702:12703::/:/bin/false\n');
        put(path.join(fsRoot, 'etc/group'), 'root:x:0:\nbar:x:12704:\n');
        mkdirs(path.join(fsRoot, 'oap/oap_12705'));
        put(path.join(fsRoot, 'oap/oap_12201/data/apps/x.json'), JSON.stringify({ userId: 12706 }));
        put(path.join(fsRoot, 'oap/oap_12201/security/uids.txt'), '12707=some.app\n');
        put(path.join(fsRoot, 'var/opt/mgu-uplink/uids.d/mgu-updater'), '12708\n');
        put(path.join(fsRoot, 'var/opt/mgu-uplink/uids.d/iteriodev-tailscale'), '3910 12709 # two\n');
        put(path.join(fsRoot, 'var/opt/mgu-uplink/uids.d/jap-ridetube-d'), '12710\n');              // our own: not taken
        mkdirs(path.join(fsRoot, 'var/opt/mgu-uplink/current'));
        put(path.join(fsRoot, 'var/opt/mgu-updater/state/uids.json'), JSON.stringify({ build: 12711, fetch: 12712, web: 12713 }));
        put(path.join(fsRoot, 'proc/77/status'), 'Name:\tx\nUid:\t12714\t12714\t12714\t12714\nGid:\t12715\t12715\t12715\t12715\n');
        assert.strictEqual(pickFetchUid(uo), 12710, 'every lower one is taken; our own drop-in is not');
        const rd = (f) => fs.readFileSync(path.join(fsRoot, f), 'utf8');
        assert.strictEqual(rd('var/opt/jap-ridetube-d/state/internet-uids'), '12710\n');
        assert.deepStrictEqual(JSON.parse(rd('var/opt/jap-ridetube-d/state/uids.json')), { fetch: 12710 });
        assert.strictEqual(rd('var/opt/mgu-uplink/uids.d/jap-ridetube-d'), '12710\n');
        assert.strictEqual(fs.statSync(uo.stateDir).mode & 0o777, 0o700);
    });

    await t('fetch uid: kept while free (its own processes do not count); taken since -> picked again; two MainApps: the running one', async () => {
        put(path.join(fsRoot, 'proc/78/status'), 'Uid:\t12710\t12710\t12710\t12710\n');     // our helper running
        assert.strictEqual(pickFetchUid(uo), 12710, 'kept');
        fs.appendFileSync(path.join(fsRoot, 'etc/passwd'), 'new:x:12710:12710::/:/bin/false\n');
        assert.strictEqual(pickFetchUid(uo), 12716, 'taken: the next free (12714/15 run, 12710 in passwd)');
        assert.strictEqual(fs.readFileSync(path.join(fsRoot, 'var/opt/mgu-uplink/uids.d/jap-ridetube-d'), 'utf8'), '12716\n');
        put(path.join(fsRoot, 'mainapp21/config/base.json'), JSON.stringify({ usableUidsAndGids: { min: 20000, max: 29999 } }));
        fs.unlinkSync(path.join(uo.stateDir, 'uids.json'));
        assert.strictEqual(pickFetchUid(uo), null, 'two configs, neither HMI running: unknown');
        put(path.join(fsRoot, 'proc/90/comm'), 'Hmi8\n');
        assert.strictEqual(pickFetchUid(uo), 30000, "iDrive 8's MainApp runs: above its range");
    });

    const fakeFetch = path.join(__dirname, 'fake_fetch.js');
    // as root (Docker): a real switch to a uid nothing has; else no switch (only root can)
    const root = process.getuid() === 0, me = root ? 12345 : process.getuid();
    const flogDir = path.join(tmp, 'flog');
    fs.mkdirSync(flogDir); fs.chmodSync(flogDir, 0o777); fs.chmodSync(tmp, 0o711);
    const flog = path.join(flogDir, 'fetch.log');
    const fo = (mode) => ({ noSetuid: !root, fetchCmd: [process.execPath, fakeFetch, flog, mode] });
    const req = { method: 'POST', url: 'https://www.youtube.com/o/oauth2/token', headers: { Authorization: 'Bearer ACCESS-1' },
        body: { client_secret: 'SeCrEt-1', refresh_token: 'REFRESH-1' }, timeoutMs: 300 };

    await t('fetch helper: spawned as the uid, the request (secrets) on stdin only, the answer from stdout', async () => {
        const r = await fetchRequest(fo('ok'), me, req);
        assert.deepStrictEqual(r, { status: 200, body: 'hello' });
        const l = JSON.parse(fs.readFileSync(flog, 'utf8'));
        assert.deepStrictEqual(l.req, req);
        assert.strictEqual(l.uid, me, root ? 'switched to the fetch uid' : 'own uid (not root)');
        const argv = l.argv.join(' ');
        SECRETS.concat(['Bearer']).forEach((x) => assert.ok(argv.indexOf(x) < 0, x + ' in argv'));
        assert.ok(l.env.every((k) => !/SECRET|TOKEN/i.test(k)) && l.env.length < 5, 'an empty env: ' + l.env);
        await rejects(fetchRequest(fo('error'), me, req), /ENETUNREACH/);
    });

    await t('fetch helper: no answer by the timeout -> killed, rejected', async () => {
        const t0 = Date.now();
        await rejects(fetchRequest(fo('hang'), me, req), /timeout/);
        assert.ok(Date.now() - t0 < 2500);
        const pid = JSON.parse(fs.readFileSync(flog, 'utf8')).pid;
        await sleep(100);
        assert.throws(() => process.kill(pid, 0), 'the helper is gone');
    });

    await t('the real helper (ytd.js --fetch): a request it cannot make comes back as an error', async () => {
        const o = { noSetuid: !root, fetchCmd: [process.execPath, '--max-http-header-size=65536', path.join(__dirname, '..', 'ytd.js'), '--fetch'] };
        await rejects(fetchRequest(o, me, { method: 'GET', url: 'https://127.0.0.1:1/', headers: null, body: null, timeoutMs: 3000 }), /ECONNREFUSED/);
    });

    await t('daemon without a fetch uid: sign-in and feeds say so, nothing spawned, no crash', async () => {
        const evs = [];
        const d2 = new Daemon({ someip: someip, srcGen: srcGen, cacheDir: cache, logDir: tmp, sock: path.join(tmp, 'ctl3.sock'),
            accountFile: path.join(tmp, 'acct2.json'), stateDir: path.join(tmp, 'st2'), etcDir: uo.etcDir, oapRoot: uo.oapRoot,
            toolRoot: path.join(tmp, 'none'), procDir: uo.procDir, mainapps: [], fetchCmd: [process.execPath, fakeFetch, flog, 'ok'], log: (m) => logs.push(m) });
        d2.emit = (o) => evs.push(o);
        try { fs.unlinkSync(flog); } catch (e) { /* none */ }
        await d2.account.start();
        assert.deepStrictEqual(evs.pop(), { ev: 'auth', state: 'error', msg: 'no internet uid on the car (see the log)' });
        fs.writeFileSync(path.join(tmp, 'acct2.json'), JSON.stringify({ cid: 'x', sec: 'y', access: 'A', refresh: 'R', exp: Date.now() + 1e7 }));
        await d2.account.feed('subs');
        assert.deepStrictEqual(evs.pop(), { ev: 'feed', which: 'subs', error: 'no internet uid on the car (see the log)' });
        assert.ok(!fs.existsSync(flog), 'nothing spawned');
    });

    await t('no token, secret or device code in the log', async () => {
        const all = logs.join('\n');
        SECRETS.forEach((s) => assert.ok(all.indexOf(s) < 0, s + ' logged'));
        assert.ok(/sign-in: signed in/.test(all) && /token refreshed/.test(all));
    });

    await t('feedItems: an empty or odd answer is no items', async () => {
        assert.deepStrictEqual(feedItems({}), []);
        assert.deepStrictEqual(feedItems({ a: [null, 1, 'x', { tileRenderer: { contentType: 'TILE_CONTENT_TYPE_VIDEO', contentId: 'bad' } }] }), []);
        const tap = (ep) => ({ commandContext: { onTap: { innertubeCommand: ep } } });
        assert.deepStrictEqual(feedItems({ a: [
            { lockupViewModel: { contentId: 'PLxxxxxxxxxxxxxxxx', rendererContext: tap({ watchEndpoint: { videoId: 'AAAAAAAAAAA' } }) } },
            { lockupViewModel: { contentId: 'UCxxxxxxxxxxxxxxxxxxxxxx', rendererContext: tap({ browseEndpoint: { browseId: 'UCx' } }) } },
            { lockupViewModel: { contentId: 'SSSSSSSSSS1', rendererContext: tap({ reelWatchEndpoint: { videoId: 'SSSSSSSSSS1' } }) } }] }), [], 'playlist, channel, short');
        assert.deepStrictEqual(feedItems({ lockupViewModel: { contentId: 'AAAAAAAAAAA', rendererContext: tap({ watchEndpoint: { videoId: 'AAAAAAAAAAA' } }) } }),
            [{ id: 'AAAAAAAAAAA', title: 'AAAAAAAAAAA', channel: '', duration_s: null, meta: [] }], 'a bare lockup');
    });

    await t('members-only tiles flagged (their badge); Video quality: 360/480/720, auto = 720 on Wi-Fi or unknown, 480 on phone data', async () => {
        const mb = { lineItemRenderer: { badge: { metadataBadgeRenderer: { style: 'BADGE_STYLE_TYPE_MEMBERS_ONLY', label: 'Members only' } } } };
        const items = feedItems({ a: [tile('MMMMMMMMMM1', 'TILE_CONTENT_TYPE_VIDEO', 'Perk', 'Chan', '9:00', [mb]), tile('MMMMMMMMMM2', 'TILE_CONTENT_TYPE_VIDEO', 'Free', 'Chan', '9:00')] });
        assert.deepStrictEqual(items.map((x) => !!x.members), [true, false]);
        const { qualityHeight } = require('../ytd.js');
        assert.deepStrictEqual([qualityHeight('360'), qualityHeight(480), qualityHeight('720'), qualityHeight('1080', null)], [360, 480, 720, 720]);
        assert.strictEqual(qualityHeight('auto', { interface: 'wlan0' }), 720);
        assert.strictEqual(qualityHeight('auto', { interface: 'usb0' }), 480);
        assert.strictEqual(qualityHeight(undefined, null), 720, 'no uplink known: as before');
    });

    await t('feedShelves: titles, per-channel and mixed groups, shorts shelf dropped, per-shelf dedup, meta, caps', async () => {
        const V = 'TILE_CONTENT_TYPE_VIDEO';
        const txt = (x) => ({ lineItemRenderer: { text: { simpleText: x } } });
        const badge = (x) => ({ lineItemRenderer: { badge: { metadataBadgeRenderer: { style: 'BADGE_STYLE_TYPE_SIMPLE', label: x } } } });
        const shelf = (header, tiles) => ({ shelfRenderer: Object.assign({ content: { horizontalListRenderer: { items: tiles } } }, header) });
        const avatar = (runs) => ({ headerRenderer: { shelfHeaderRenderer: { avatarLockup: { avatarLockupRenderer: { title: { runs: runs.map((x) => ({ text: x })) } } } } } });
        const page = (shelves) => ({ contents: { tvBrowseRenderer: { content: { tvSurfaceContentRenderer: { content: { sectionListRenderer: { contents: shelves } } } } } } });
        const id = (n) => 'fake' + ('0000000' + n).slice(-7);
        const many = [];
        for (let i = 0; i < 13; i++) many.push(tile(id(100 + i), V, 'M' + i, 'Chan M', '1:00'));
        const root = page([
            shelf(avatar(['Consumer Electronics', ' and more']), [
                tile(id(1), V, 'One', 'Chan A', '4:05', [badge('4K'), txt('125K views'), txt('•'), txt('1 day ago')]),
                tile(id(2), V, 'Two', 'Chan B', '10:00', [])]),
            shelf(avatar(['Shorts']), [tile(id(3), 'TILE_CONTENT_TYPE_SHORTS', 'Short', 'Chan C', null)]),
            shelf({ tvhtml5Metadata: { retainShelfIndex: true } }, [
                tile(id(4), V, 'Four', 'Chan D', '2:00'), tile(id(5), V, 'Five', 'Chan D', '3:00'), tile(id(4), V, 'Four', 'Chan D', '2:00')]),
            shelf({ tvhtml5Metadata: { retainShelfIndex: true } }, [tile(id(1), V, 'One', 'Chan A', '4:05'), tile(id(6), V, 'Six', 'Chan E', '1:00')]),
            shelf({ headerRenderer: { shelfHeaderRenderer: { title: { simpleText: 'Plain title' } } } }, many)]);
        const sh = feedShelves(root);
        assert.deepStrictEqual(sh.map((x) => x.title), ['Consumer Electronics and more', 'Chan D', '', 'Plain title']);
        assert.deepStrictEqual(sh[0].items[0], { id: id(1), title: 'One', channel: 'Chan A', duration_s: 245, meta: ['125K views', '1 day ago'] });
        assert.deepStrictEqual(sh[0].items[1].meta, []);
        assert.deepStrictEqual(sh[1].items.map((x) => x.id), [id(4), id(5)], 'dedup inside a shelf');
        assert.deepStrictEqual(sh[2].items.map((x) => x.id), [id(1), id(6)], 'a video in two shelves stays in both');
        assert.strictEqual(sh[3].items.length, 12);
        const flat = feedItems(root).map((x) => x.id);
        assert.strictEqual(flat.filter((x) => x === id(1)).length, 1, 'flat items deduped across shelves');
        assert.deepStrictEqual(flat.slice(0, 5), [id(1), id(2), id(4), id(5), id(6)]);
        assert.strictEqual(flat.length, 18);
        const ten = [];
        for (let i = 0; i < 10; i++) ten.push(shelf(avatar(['S' + i]), [tile(id(200 + i), V, 'T', 'C', '1:00')]));
        assert.deepStrictEqual(feedShelves(page(ten)).map((x) => x.title), ['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7']);
        // Watch later: a playlist, tiles without shelves
        const wl = { contents: { tvBrowseRenderer: { content: { tvSecondaryNavRenderer: { sections: [{ playlistVideoListRenderer: { contents: [tile(id(7), V, 'Seven', 'Chan F', '5:00')] } }] } } } } };
        assert.deepStrictEqual(feedShelves(wl), []);
        assert.deepStrictEqual(feedItems(wl).map((x) => x.id), [id(7)]);
        assert.deepStrictEqual(feedShelves({}), []);
    });

    await t('thumbs: cached thumb.rgba by its length, else thumbs/<id>.rgba, else the helper (env {}, cwd /), checked, kept, 150 at most', async () => {
        const evs = [], tlog = path.join(tmp, 'thumb.log'), tdir = path.join(cache, 'thumbs');
        const d3 = new Daemon({ someip: someip, srcGen: srcGen, ytdec: fakeYtdec, cacheDir: cache, logDir: tmp, sock: path.join(tmp, 'ctl3.sock'),
            accountFile: path.join(tmp, 'acct3.json'), noSetuid: true, thumbCmd: [process.execPath, path.join(__dirname, 'fake_thumb.js'), tlog],
            ytRequest: fakeYt, log: (m) => logs.push(m) });
        d3.emit = (o) => evs.push(o);
        const sizes = () => evs.map((e) => [e.id, e.w, e.h, Buffer.from(e.rgba, 'base64').length]);
        const put = (vid, n) => { fs.mkdirSync(path.join(cache, vid)); fs.writeFileSync(path.join(cache, vid, 'thumb.rgba'), Buffer.alloc(n, 1)); };
        put('TTTTTTTTTT1', 57600); put('TTTTTTTTTT2', 230400); put('TTTTTTTTTT3', 1234);
        await d3.thumb('TTTTTTTTTT1'); await d3.thumb('TTTTTTTTTT2'); await d3.thumb('TTTTTTTTTT3');
        assert.deepStrictEqual(sizes(), [['TTTTTTTTTT1', 160, 90, 57600], ['TTTTTTTTTT2', 320, 180, 230400]]);
        assert.ok(logs.some((m) => /TTTTTTTTTT3: 1234 bytes/.test(m)), 'odd size logged');
        assert.ok(!fs.existsSync(tlog), 'cached thumbs: no helper');
        fs.mkdirSync(tdir);
        for (let i = 0; i < 150; i++) {
            const f = path.join(tdir, 'X' + i + '.rgba'), tm = new Date(Date.now() - (i + 1) * 60000);
            fs.writeFileSync(f, ''); fs.utimesSync(f, tm, tm);
        }
        evs.length = 0;
        await Promise.all([d3.thumb('NNNNNNNNNN1'), d3.thumb('ZZZZZZZZZZZ'), d3.thumb('SSSSSSSSSS1')]);
        assert.deepStrictEqual(sizes(), [['NNNNNNNNNN1', 320, 180, 230400]]);
        assert.ok(logs.some((m) => /ZZZZZZZZZZZ: thumb helper exit 1, 0 bytes: no thumbnail/.test(m)));
        assert.ok(logs.some((m) => /SSSSSSSSSS1: thumb helper exit 0, 1000 bytes/.test(m)));
        const hl = fs.readFileSync(tlog, 'utf8').split('\n').filter(Boolean).map((x) => JSON.parse(x));
        assert.deepStrictEqual(hl.map((x) => x.id).sort(), ['NNNNNNNNNN1', 'SSSSSSSSSS1', 'ZZZZZZZZZZZ']);
        assert.ok(hl.every((x) => x.cwd === '/' && x.env.length < 5), JSON.stringify(hl[0]));
        const tf = path.join(tdir, 'NNNNNNNNNN1.rgba');
        assert.strictEqual(fs.statSync(tf).size, 230400);
        assert.strictEqual(fs.statSync(tf).mode & 0o777, 0o600, "root only: the thumbnails show what was watched");
        assert.strictEqual(fs.readdirSync(tdir).length, 150, 'capped');
        assert.ok(!fs.existsSync(path.join(tdir, 'X149.rgba')), 'the oldest went');
        fs.unlinkSync(tlog); evs.length = 0;
        await d3.thumb('NNNNNNNNNN1');
        assert.deepStrictEqual(sizes(), [['NNNNNNNNNN1', 320, 180, 230400]]);
        assert.ok(!fs.existsSync(tlog), 'from thumbs/: no helper');
        assert.ok(listCache(cache).every((x) => x.id !== 'thumbs'), 'thumbs/ is not a video');
        fs.readdirSync(tdir).forEach((n) => fs.unlinkSync(path.join(tdir, n))); fs.rmdirSync(tdir);
        ['TTTTTTTTTT1', 'TTTTTTTTTT2', 'TTTTTTTTTT3'].forEach((v) => { fs.unlinkSync(path.join(cache, v, 'thumb.rgba')); fs.rmdirSync(path.join(cache, v)); });
    });

    await t('channels: the FEchannels tiles -> id, name, @handle; videos, playlists and repeats skipped', async () => {
        const { channelTiles } = require('../ytd.js');
        const line = (txt) => ({ lineRenderer: { items: [{ lineItemRenderer: { text: { simpleText: txt } } }] } });
        const tile = (id, type, title, lines) => ({ tileRenderer: { contentId: id, contentType: type, onSelectCommand: { browseEndpoint: { browseId: id } },
            metadata: { tileMetadataRenderer: { title: { simpleText: title }, lines: lines.map(line) } } } });
        const page = { contents: { shelfRenderer: { content: { horizontalListRenderer: { items: [
            tile('UCdemo000000000000000001', 'TILE_CONTENT_TYPE_CHANNEL', 'Demo Detailing', ['@demo_detailing', '135K subscribers']),
            tile('DemoVideo01', 'TILE_CONTENT_TYPE_VIDEO', 'a video', []),
            tile('UCdemo000000000000000002', 'TILE_CONTENT_TYPE_CHANNEL', 'Seven Demo', ['1M subscribers']),
            tile('UCdemo000000000000000001', 'TILE_CONTENT_TYPE_CHANNEL', 'Demo Detailing', [])] } } } } };
        assert.deepStrictEqual(channelTiles(page), [
            { id: 'UCdemo000000000000000001', title: 'Demo Detailing', handle: '@demo_detailing' },
            { id: 'UCdemo000000000000000002', title: 'Seven Demo', handle: '' }]);
    });

    await t('LRU keeps 6 newest, never the playing one', async () => {
        const lru = path.join(tmp, 'lru');
        fs.mkdirSync(lru);
        const ids = [];
        for (let i = 0; i < 9; i++) {
            const id = 'L' + String(i).repeat(10);
            const dd = path.join(lru, id);
            fs.mkdirSync(dd);
            const tm = new Date(Date.now() - (i + 1) * 60000); // L0 newest ... L8 oldest
            fs.utimesSync(dd, tm, tm);
            ids.push(id);
        }
        const removed = pruneCache(lru, 6, [ids[8]], () => {});
        assert.deepStrictEqual(removed.sort(), [ids[6], ids[7]].sort());
        assert.deepStrictEqual(listCache(lru).map((x) => x.id).sort(), ids.slice(0, 6).concat([ids[8]]).sort());
    });

    await t('fetch helper resolves through the uplink lease, else the system resolver', async () => {
        const { uplinkLookup } = require('../ytd.js');
        const lease = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lease-')), 'lease.json');
        assert.strictEqual(uplinkLookup(lease), undefined, 'no lease: system resolver');
        fs.writeFileSync(lease, JSON.stringify({ dns: [] }));
        assert.strictEqual(uplinkLookup(lease), undefined, 'no servers: system resolver');
        fs.writeFileSync(lease, JSON.stringify({ dns: ['192.0.2.53'] }));
        assert.strictEqual(typeof uplinkLookup(lease), 'function');
    });

    await t('a played video is deleted once stopped (nothing is kept for offline)', async () => {
        c.send({ cmd: 'stop' }); await c.waitFor((x) => x.ev === 'state' && x.state === 'idle');
        d.opts.keep = 0;
        fs.writeFileSync(ctl, 'done');
        c.clear();
        c.send({ cmd: 'play', id: 'UUUUUUUUUU1', rect: '1280x720' });
        await c.waitFor((x) => x.ev === 'state' && x.state === 'playing', 5000);
        assert.ok(fs.existsSync(path.join(cache, 'UUUUUUUUUU1')), 'kept while it plays');
        c.send({ cmd: 'stop' }); await c.waitFor((x) => x.ev === 'state' && x.state === 'idle');
        assert.ok(!fs.existsSync(path.join(cache, 'UUUUUUUUUU1')), 'gone');
        assert.deepStrictEqual(fs.readdirSync(cache).filter((n) => /^[\w-]{11}$/.test(n)), [], 'no other video left either');
        d.opts.keep = 20;
    });

    await t('history: signed in, /player then a playback ping, watchtime at pause and a final one when it ended', async () => {
        const saved = d.account, id = 'HHHHHHHHHH1';
        mkVideo(id);
        d.account = Object.assign(Object.create(Object.getPrototypeOf(saved)), saved, { status: () => ({ state: 'signed_in' }), token: async () => 'TOK' });
        yt.calls.length = 0;
        await playing(id);
        await waitUntil(() => yt.calls.some((x) => /stats\/playback/.test(x.url)));
        const pl = yt.calls.find((x) => /v1\/player/.test(x.url));
        assert.strictEqual(pl.headers.Authorization, 'Bearer TOK'); assert.strictEqual(pl.body.videoId, id);
        const pb = yt.calls.find((x) => /stats\/playback/.test(x.url));
        assert.ok(/^https:\/\/s\.youtube\.com\/api\/stats\/playback\?docid=x&ei=E&ns=yt&ver=2&cpn=[\w-]{16}&len=60&cmt=0\.0$/.test(pb.url), pb.url);
        assert.strictEqual(pb.headers.Authorization, 'Bearer TOK');
        tick(30000);
        c.send({ cmd: 'pause' });
        await waitUntil(() => yt.calls.some((x) => /stats\/watchtime/.test(x.url)));
        assert.ok(/&st=0&et=30\.0$/.test(yt.calls.find((x) => /watchtime/.test(x.url)).url));
        c.send({ cmd: 'resume' });
        await sleep(100);
        tick(59000);
        d.stop('ended');
        await waitUntil(() => yt.calls.some((x) => /watchtime.*final=1/.test(x.url)));
        assert.ok(/st=60&et=60&final=1$/.test(yt.calls.filter((x) => /watchtime/.test(x.url)).pop().url));
        await c.waitFor((x) => x.ev === 'state' && x.state === 'ended');
        d.account = saved;
        fs.rmSync(path.join(cache, id), { recursive: true, force: true });
    });

    await t('feed tiles carry the account\'s watched share and resume point', async () => {
        const j = { contents: [{ tileRenderer: { contentType: 'TILE_CONTENT_TYPE_VIDEO', contentId: 'AUTOAUTO003',
            metadata: { tileMetadataRenderer: { title: { simpleText: 'A' } } },
            header: { tileHeaderRenderer: { thumbnailOverlays: [{ thumbnailOverlayTimeStatusRenderer: { text: { simpleText: '5:00' } } },
                { thumbnailOverlayResumePlaybackRenderer: { percentDurationWatched: 40 } }] } },
            onSelectCommand: { watchEndpoint: { videoId: 'AUTOAUTO003', startTimeSeconds: 120 } } } }] };
        assert.strictEqual(feedItems(j)[0].watched_pct, 40); assert.strictEqual(feedItems(j)[0].start_s, 120);
    });

    await t('iDrive 8: interface files found in oap-mainapp21/src-gen/someip; the route from audio.json; a missing player instance named', async () => {
        const root = path.join(tmp, 'id8'), id7 = path.join(root, 'oap-mainapp', 'src-gen'), id8 = path.join(root, 'oap-mainapp21', 'src-gen', 'someip');
        fs.mkdirSync(id8, { recursive: true });
        fs.writeFileSync(path.join(id8, 'org_genivi_am_commandinterface_CommandControl.json'), JSON.stringify({ name: 'cc' }));
        fs.writeFileSync(path.join(id8, 'de_bmw_infotainment_entertainment_mediaplayer_MediaPlayer.json'), JSON.stringify({ name: 'mp', instances: { OapGenericMedia: {}, Usb: {} } }));
        const lines = [], conf = path.join(root, 'audio.json'), built = [];
        const sip = { buildProxy: async (cfg, inst) => { built.push([cfg.name, inst]); return someip.buildProxy(cfg, inst); } };
        const mk = () => new Audio({ someip: sip, srcGen: null, srcGens: [id7, id8], audioConf: conf, availWaitMs: 500, log: (m) => lines.push(m) }, { time() {}, state() {}, error() {} });
        let a = mk();
        await a.init();
        assert.deepStrictEqual(built, [['cc', '1'], ['mp', 'OapGenericMedia']]);
        assert.ok(lines.some((l) => l === 'interfaces from ' + id8), lines.join('|'));
        assert.ok(lines.some((l) => /^audio sources 1046:OapGenericMedia 129:Tuner; sinks 1024:AMP; using source 1046, sink 1024$/.test(l)), lines.join('|'));
        calls.length = 0;
        await a.playNow('/x/audio.m4a');
        assert.deepStrictEqual(called('connect')[0].a, { sourceID: 1046, sinkID: 1024 });
        await a.release();
        // a hand-written route (another head unit), read at the next start of the service
        fs.writeFileSync(conf, JSON.stringify({ sourceID: 2001, sinkID: 1999, instance: 'Usb' }));
        a = mk(); built.length = 0; lines.length = 0;
        await a.init();
        assert.deepStrictEqual(built[1], ['mp', 'Usb']);
        calls.length = 0;
        await a.playNow('/x/audio.m4a');
        assert.deepStrictEqual(called('connect')[0].a, { sourceID: 2001, sinkID: 1999 });
        await a.release();
        assert.ok(lines.some((l) => /using source 2001, sink 1999 \(audio\.json\)$/.test(l)), lines.join('|'));
        // an instance the player does not have: the error names the ones it has
        fs.writeFileSync(conf, JSON.stringify({ instance: 'Nope' }));
        await assert.rejects(mk().init(), /MediaPlayer has no instance Nope \(it has OapGenericMedia, Usb; set "instance" in /);
        fs.unlinkSync(conf);
        // nowhere: the folders it looked in
        await assert.rejects(new Audio({ someip: sip, srcGens: [path.join(root, 'none')], audioConf: conf, log() {} }, {}).init(), /no org_genivi_am_commandinterface_CommandControl\.json in /);
    });

    await t('iDrive 8: source 1046 not listed, one source named like the generic OAP media one: that one; none: kept and said', async () => {
        const lines = [];
        const mkSip = (sources) => ({ buildProxy: async (cfg, inst) => Object.assign(await someip.buildProxy(cfg, inst), {
            getValue: async (n) => (n === 'listOfMainSources' ? sources : n === 'listOfMainSinks' ? null : conns.slice()) }) });
        let a = new Audio({ someip: mkSip([{ sourceID: 3050, name: 'OAP_GENERIC_MEDIA' }, { sourceID: 129, name: 'Tuner' }]), srcGen: srcGen, audioConf: path.join(tmp, 'none.json'), availWaitMs: 500, log: (m) => lines.push(m) }, { time() {}, state() {}, error() {} });
        await a.init();
        assert.strictEqual(a.src, 3050);
        assert.ok(lines.some((l) => l === 'source 1046 is not on this head unit: using 3050 (OAP_GENERIC_MEDIA)'), lines.join('|'));
        lines.length = 0;
        a = new Audio({ someip: mkSip([{ sourceID: 129, name: 'Tuner' }]), srcGen: srcGen, audioConf: path.join(tmp, 'none.json'), availWaitMs: 500, log: (m) => lines.push(m) }, { time() {}, state() {}, error() {} });
        await a.init();
        assert.strictEqual(a.src, 1046);
        assert.ok(lines.some((l) => /^source 1046 is not listed on this head unit; set "sourceID" in /.test(l)), lines.join('|'));
    });

    // ---- 0.4.1: the audio start says where it stops, finds its descriptions elsewhere, and the Diagnostics page
    const H = { time() {}, state() {}, error() {} };
    const mkRoot = (name) => { const r = path.join(tmp, name); fs.mkdirSync(r, { recursive: true }); return r; };

    await t('the version is component.json\'s', async () => {
        assert.strictEqual(require('../ytd.js').VERSION, JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'component.json'), 'utf8')).version);
    });

    await t('diag: the page\'s lines - the sound ready, the route, the car\'s lists, the files, the log', async () => {
        c.clear();
        c.send({ cmd: 'diag' });
        const m = await c.waitFor((x) => x.ev === 'diag');
        const all = m.lines.join('\n');
        assert.strictEqual(m.ready, true);
        assert.ok(/^RideTube service \d+\.\d+\.\d+ \| Node v/.test(m.lines[0]), m.lines[0]);
        assert.ok(/# Sound\nReady: /.test(all), all);
        assert.ok(all.indexOf('CommandControl: description ' + path.join(srcGen, 'org_genivi_am_commandinterface_CommandControl.json') + ' | instance 1 (the description lists none) | answers: yes') >= 0, all);
        assert.ok(/Route: source 1046 \(listed: yes\) to sink 1024 \(listed: yes\)/.test(all), all);
        assert.ok(/Sources: 1046:OapGenericMedia 129:Tuner\nSinks: 1024:AMP\nConnections \(id:source>sink\): /.test(all), all);
        assert.ok(all.indexOf(srcGen + ': 2 descriptions, CommandControl yes, MediaPlayer yes') >= 0, all);
        assert.ok(/# Log \(the last lines\)\n\d\d:\d\d:\d\d /.test(all), all);
        SECRETS.forEach((x) => assert.ok(all.indexOf(x) < 0, x + ' on the page'));
    });

    await t('no description anywhere: both are looked for, the start says which is missing, the player gets a reason', async () => {
        const root = mkRoot('nodesc');
        const a = new Audio({ someip: someip, srcGens: [path.join(root, 'a'), path.join(root, 'b')], oapRoot: path.join(root, 'oap'), catalogs: [path.join(root, 'cat.json')], generators: [],
            audioConf: path.join(root, 'audio.json'), availWaitMs: 200, log() {} }, H);
        await assert.rejects(a.start(), /^Error: no org_genivi_am_commandinterface_CommandControl\.json in /);
        assert.strictEqual(a.diag.stage, 'finding the CommandControl description');
        assert.ok(/^no org_genivi_am_commandinterface_CommandControl\.json in /.test(a.diag.cc.error) && /^no de_bmw_infotainment_entertainment_mediaplayer_MediaPlayer\.json in /.test(a.diag.mp.error));
        assert.strictEqual(a.diag.cc.generator, 'no interface catalog (' + path.join(root, 'cat.json') + ')');
        assert.strictEqual(a.why(), 'the car\'s audio is not ready - this head unit has no description of the CommandControl interface (Settings > Diagnostics)');
        assert.strictEqual(a.diag.ready, false);
        assert.strictEqual(a.diag.tries, 1);
    });

    await t('the page\'s files: MainApp\'s folders, the apps\' descriptions, the catalog, the generator, and a search for them elsewhere when one is missing', async () => {
        const { audioInventory } = require('../ytd.js');
        const root = mkRoot('inv'), gen = path.join(root, 'usr/lib/oap-mainapp21/src-gen/someip'), oap = path.join(root, 'oap');
        fs.mkdirSync(gen, { recursive: true });
        ['de_bmw_infotainment_hmi_remote2_RemoteHmiApplication2', 'de_bmw_infotainment_entertainment_tuner_Tuner', 'org_genivi_am_commandinterface_CommandControl', 'de_bmw_infotainment_vehicle_Vehicle2']
            .forEach((n) => fs.writeFileSync(path.join(gen, n + '.json'), '{}'));
        fs.mkdirSync(path.join(oap, 'oap_13007', 'someipInterfaces'), { recursive: true });
        fs.writeFileSync(path.join(oap, 'oap_13007', 'someipInterfaces', 'de_bmw_infotainment_entertainment_mediaplayer_MediaPlayer.json'), JSON.stringify({ instances: { OapGenericMedia: {}, Usb: {} } }));
        fs.mkdirSync(path.join(oap, 'oap_13008', 'someipInterfaces'), { recursive: true });
        fs.mkdirSync(path.join(root, 'etc/oap/someip'), { recursive: true });
        fs.writeFileSync(path.join(root, 'etc/oap/someip/someip-interfaces.json'), JSON.stringify({ interfaces: { 'org.genivi.am.commandinterface.CommandControl': {}, 'de.bmw.infotainment.entertainment.mediaplayer2.MediaPlayer2': {}, 'de.bmw.infotainment.vehicle.Vehicle2': {} } }));
        fs.mkdirSync(path.join(root, 'usr/lib/oap-mainapp21/src/AppManagement'), { recursive: true });
        fs.writeFileSync(path.join(root, 'usr/lib/oap-mainapp21/src/AppManagement/AppManagement.js'), '({"someip-interfaces-generator/IFConfigGenerator":3})');
        fs.mkdirSync(path.join(root, 'usr/share/franca/deep/node_modules'), { recursive: true });
        fs.writeFileSync(path.join(root, 'usr/share/franca/deep/MediaPlayer2.json'), '{}');
        fs.writeFileSync(path.join(root, 'usr/share/franca/deep/node_modules/MediaPlayer.json'), '{}');
        const o = { srcGens: [path.join(root, 'usr/lib/oap-mainapp/src-gen'), gen], oapRoot: oap, catalogs: [path.join(root, 'etc/oap/someip/someip-interfaces.json')],
            generators: [path.join(root, 'usr/lib/oap-mainapp21/src/AppManagement/AppManagement.js'), path.join(root, 'usr/lib/oap-mainapp21/src/AppManagement/AppManagement.bundle.js')],
            mainapps: [{ root: path.join(root, 'usr/lib/oap-mainapp'), hmi: 'HmiMain3D' }, { root: path.join(root, 'usr/lib/oap-mainapp21'), hmi: 'Hmi8' }], searchRoots: [path.join(root, 'usr'), path.join(root, 'etc')] };
        const rel = (l) => l.map((x) => x.split(root).join(''));
        assert.deepStrictEqual(rel(audioInventory(o, true)), [
            'App manager /usr/lib/oap-mainapp21 (Hmi8); src-gen has: someip',
            '/usr/lib/oap-mainapp/src-gen: not there',
            '/usr/lib/oap-mainapp21/src-gen/someip: 4 descriptions, CommandControl yes, MediaPlayer NO; of the audio: org_genivi_am_commandinterface_CommandControl, entertainment_tuner_Tuner',
            'Installed apps: 2; with a description of the audio manager or the player: oap_13007 entertainment_mediaplayer_MediaPlayer [OapGenericMedia, Usb]',
            'Interface catalog /etc/oap/someip/someip-interfaces.json: 3 interfaces, CommandControl yes, MediaPlayer NO; others of the audio: entertainment.mediaplayer2.MediaPlayer2',
            'Generator /usr/lib/oap-mainapp21/src/AppManagement/AppManagement.js: has the interface generator',
            'Elsewhere under /usr, /etc: /usr/share/franca/deep/MediaPlayer2.json']);
        // nothing asked to be searched: no walk; no catalog: what the nearest folder above holds
        fs.unlinkSync(path.join(root, 'etc/oap/someip/someip-interfaces.json'));
        fs.rmdirSync(path.join(root, 'etc/oap/someip'));
        fs.writeFileSync(path.join(root, 'etc/oap/base.json'), '{}');
        const l2 = rel(audioInventory(o, false));
        assert.ok(l2.indexOf('Interface catalog /etc/oap/someip/someip-interfaces.json: not there (/etc/oap has: base.json)') >= 0, l2.join('\n'));
        assert.ok(!l2.some((x) => /^Elsewhere/.test(x)));
    });

    await t('descriptions only in an installed app\'s someipInterfaces, or under a numbered name: used, and said', async () => {
        const root = mkRoot('apps'), oap = path.join(root, 'oap'), gen = path.join(root, 'src-gen', 'someip');
        fs.mkdirSync(gen, { recursive: true });
        // two apps have the player's: the one with the instance wanted wins over the one with more instances
        fs.mkdirSync(path.join(oap, 'oap_13001', 'someipInterfaces'), { recursive: true });
        fs.mkdirSync(path.join(oap, 'oap_13002', 'someipInterfaces'), { recursive: true });
        fs.mkdirSync(path.join(oap, 'not_an_app', 'someipInterfaces'), { recursive: true });
        fs.writeFileSync(path.join(oap, 'oap_13001', 'someipInterfaces', 'de_bmw_infotainment_entertainment_mediaplayer_MediaPlayer.json'), JSON.stringify({ name: 'mpA', instances: { Usb: {}, Bt: {}, Ipod: {} } }));
        fs.writeFileSync(path.join(oap, 'oap_13002', 'someipInterfaces', 'de_bmw_infotainment_entertainment_mediaplayer_MediaPlayer.json'), JSON.stringify({ name: 'mpB', instances: { OapGenericMedia: {} } }));
        fs.writeFileSync(path.join(oap, 'not_an_app', 'someipInterfaces', 'org_genivi_am_commandinterface_CommandControl.json'), JSON.stringify({ name: 'wrong' }));
        // the audio manager's under a numbered name in MainApp's folder, with one instance that is not '1'
        fs.writeFileSync(path.join(gen, 'org_genivi_am_commandinterface2_CommandControl2.json'), JSON.stringify({ name: 'cc2', instances: { AM: {} }, methods: { connect: {}, disconnect: {} }, fields: { listOfMainConnections: {} } }));
        fs.writeFileSync(path.join(gen, 'org_genivi_am_commandinterface_CommandControlTypes.json'), JSON.stringify({ name: 'types' }));
        const lines = [], built = [];
        const sip = { buildProxy: async (cfg, inst) => { built.push([cfg.name, inst]); return someip.buildProxy(cfg, inst); } };
        const a = new Audio({ someip: sip, srcGens: [gen], oapRoot: oap, catalogs: [], generators: [], audioConf: path.join(root, 'audio.json'), availWaitMs: 200, log: (m) => lines.push(m) }, H);
        await a.start();
        assert.deepStrictEqual(built, [['cc2', 'AM'], ['mpB', 'OapGenericMedia']]);
        assert.ok(lines.some((l) => l === 'the CommandControl description is not in MainApp\'s folders: using ' + path.join(gen, 'org_genivi_am_commandinterface2_CommandControl2.json')), lines.join('|'));
        assert.ok(lines.some((l) => l === 'CommandControl has no instance 1 on this head unit: using AM (it has AM)'), lines.join('|'));
        assert.ok(lines.some((l) => l === 'the MediaPlayer description is not in MainApp\'s folders: using ' + path.join(oap, 'oap_13002', 'someipInterfaces', 'de_bmw_infotainment_entertainment_mediaplayer_MediaPlayer.json')), lines.join('|'));
        assert.deepStrictEqual(a.diag.cc.lacks, ['listOfMainSources', 'listOfMainSinks']);
        assert.strictEqual(a.diag.mp.lacks, null);
        assert.strictEqual(a.diag.ready, true);
        assert.strictEqual(a.diag.stage, 'ready');
    });

    await t('the player\'s instance: the only one named like the generic OAP one is used; several, or none like it: an error naming them', async () => {
        const root = mkRoot('inst');
        const mk = (insts, lines) => {
            fs.writeFileSync(path.join(root, 'org_genivi_am_commandinterface_CommandControl.json'), JSON.stringify({ name: 'cc' }));
            fs.writeFileSync(path.join(root, 'de_bmw_infotainment_entertainment_mediaplayer_MediaPlayer.json'), JSON.stringify({ name: 'mp', instances: insts }));
            return new Audio({ someip: someip, srcGen: root, audioConf: path.join(root, 'audio.json'), availWaitMs: 200, log: (m) => lines.push(m) }, H);
        };
        let lines = [];
        let a = mk({ Usb: {}, OapGenericMedia_2: {} }, lines);
        await a.init();
        assert.strictEqual(a.diag.mp.instance, 'OapGenericMedia_2');
        assert.ok(lines.some((l) => l === 'MediaPlayer has no instance OapGenericMedia on this head unit: using OapGenericMedia_2 (it has Usb, OapGenericMedia_2)'), lines.join('|'));
        // (an array of names is read as well)
        a = mk(['Usb', 'OnlineOapPlayer'], lines = []);
        await a.init();
        assert.strictEqual(a.diag.mp.instance, 'OnlineOapPlayer');
        a = mk({ Usb: {}, Bt: {} }, lines = []);
        await assert.rejects(a.init(), /^Error: MediaPlayer has no instance OapGenericMedia \(it has Usb, Bt; set "instance" in /);
        assert.strictEqual(a.why(), 'the car\'s audio is not ready - the car\'s MediaPlayer has no instance OapGenericMedia (Settings > Diagnostics)');
        assert.strictEqual(a.diag.mp.file, path.join(root, 'de_bmw_infotainment_entertainment_mediaplayer_MediaPlayer.json'));
        assert.deepStrictEqual(a.diag.mp.instances, ['Usb', 'Bt']);
        a = mk({ OapGenericMediaA: {}, OapGenericMediaB: {} }, lines = []);
        await assert.rejects(a.init(), /MediaPlayer has no instance OapGenericMedia \(it has OapGenericMediaA, OapGenericMediaB;/);
    });

    await t('a description made from the unit\'s interface catalog by the app manager\'s generator; a catalog without it, a bundle without one: said', async () => {
        const root = mkRoot('gen'), cat = path.join(root, 'someip-interfaces.json'), bundle = path.join(root, 'AppManagement.js');
        const CC = 'org.genivi.am.commandinterface.CommandControl', MP = 'de.bmw.infotainment.entertainment.mediaplayer.MediaPlayer';
        fs.writeFileSync(cat, JSON.stringify({ interfaces: { [CC]: { n: 'cc' }, [MP]: { n: 'mp' } } }));
        // a browserify bundle shaped like MainApp's: a module table, the generator among it, an entry that must not run
        const table = '{1:[function(require,module,exports){global.__entryRan=true;},{}],' +
            '7:[function(require,module,exports){module.exports={generate:function(db,m){var o={};Object.keys(m.proxies).forEach(function(id){o[id]={name:"gen-"+db.interfaces[id].n,instances:{"1":{},OapGenericMedia:{}}};});return o;}};},{}]}';
        const text = '(function(){function r(e,n,t){function o(i,f){if(!n[i]){if(!e[i]){throw new Error("no module "+i)}var p=n[i]={exports:{}};e[i][0].call(p.exports,function(r){return o(e[i][1][r]||r)},p,p.exports,r,e,n,t)}return n[i].exports}for(var u=0;u<t.length;u++)o(t[u]);return o}return r})()(' +
            table.replace('7:[', '7:[').replace(/^\{/, '{') + ',{},[1]);\n';
        fs.writeFileSync(bundle, text.replace('},{}]}', '},{"someip-interfaces-generator/IFConfigGenerator":7}]}'));
        const lines = [], built = [];
        const sip = { buildProxy: async (cfg, inst) => { built.push([cfg.name, inst]); return someip.buildProxy(cfg, inst); } };
        const mk = (o) => new Audio(Object.assign({ someip: sip, srcGens: [path.join(root, 'none')], oapRoot: path.join(root, 'none'), catalogs: [path.join(root, 'absent.json'), cat],
            generators: [path.join(root, 'absent.js'), bundle], audioConf: path.join(root, 'audio.json'), availWaitMs: 200, log: (m) => lines.push(m) }, o), H);
        let a = mk({});
        await a.start();
        assert.deepStrictEqual(built, [['gen-cc', '1'], ['gen-mp', 'OapGenericMedia']]);
        assert.ok(!global.__entryRan, 'the bundle\'s entry ran');
        assert.strictEqual(a.diag.cc.file, cat + ' (generator of ' + bundle + ')');
        assert.ok(lines.some((l) => l === 'the description of ' + MP + ' was made from ' + cat + ' (generator of ' + bundle + ')'), lines.join('|'));
        // the catalog has no such interface
        fs.writeFileSync(cat, JSON.stringify({ interfaces: { [CC]: { n: 'cc' } } }));
        a = mk({});
        await assert.rejects(a.start(), /no de_bmw_infotainment_entertainment_mediaplayer_MediaPlayer\.json in /);
        assert.strictEqual(a.diag.mp.generator, cat + ' has no ' + MP);
        assert.strictEqual(a.diag.stage, 'finding the MediaPlayer description');
        assert.strictEqual(a.diag.cc.error, null);
        // a bundle this service cannot take the generator from, and one whose generator throws
        fs.writeFileSync(cat, JSON.stringify({ interfaces: { [CC]: { n: 'cc' }, [MP]: { n: 'mp' } } }));
        fs.writeFileSync(bundle, 'module.exports = require("./bytecode-loader")("AppManagement.jsc");\n');
        a = mk({});
        await assert.rejects(a.start(), /no org_genivi_am_commandinterface_CommandControl\.json in /);
        assert.strictEqual(a.diag.cc.generator, bundle + ' has no generator this service can load');
        fs.writeFileSync(bundle, text.replace('},{}]}', '},{"someip-interfaces-generator/IFConfigGenerator.js":9}]}'));
        a = mk({});
        await assert.rejects(a.start(), /no org_genivi_am_commandinterface_CommandControl\.json in /);
        assert.ok(/^the generator failed: no module 9$/.test(a.diag.cc.generator), a.diag.cc.generator);
    });

    await t('the sink: 1024 not on the unit - the only sink, or the only one its connections use, is used; among several nothing is picked', async () => {
        const mkSip = (sinks, cs) => ({ buildProxy: async (cfg, inst) => Object.assign(await someip.buildProxy(cfg, inst), {
            getValue: async (n) => (n === 'listOfMainSources' ? [{ sourceID: 1046, name: 'OapGenericMedia' }] : n === 'listOfMainSinks' ? sinks : cs) }) });
        const run = async (sinks, cs, conf) => {
            const lines = [], f = path.join(tmp, 'sink.json');
            if (conf) fs.writeFileSync(f, JSON.stringify(conf)); else try { fs.unlinkSync(f); } catch (e) { /* none */ }
            const a = new Audio({ someip: mkSip(sinks, cs), srcGen: srcGen, audioConf: f, availWaitMs: 200, log: (m) => lines.push(m) }, H);
            await a.start();
            return { a: a, lines: lines };
        };
        let r = await run([{ sinkID: 5, name: 'Cabin' }], []);
        assert.strictEqual(r.a.sink, 5);
        assert.ok(r.lines.some((l) => l === 'sink 1024 is not on this head unit: using 5 (Cabin), the only sink'), r.lines.join('|'));
        calls.length = 0;
        await r.a.playNow('/x/audio.m4a');
        assert.deepStrictEqual(called('connect')[0].a, { sourceID: 1046, sinkID: 5 });
        assert.strictEqual(r.a.diag.play.route, '1046>5');
        assert.strictEqual(r.a.diag.play.error, null);
        await r.a.release();
        r = await run([{ sinkID: 5, name: 'Cabin' }, { sinkID: 6, name: 'Phone' }], [{ mainConnectionID: 1, sourceID: 129, sinkID: 5 }, { mainConnectionID: 2, sourceID: 130, sinkID: 5 }, { mainConnectionID: 3, sourceID: 131, sinkID: 77 }]);
        assert.strictEqual(r.a.sink, 5);
        assert.ok(r.lines.some((l) => l === 'sink 1024 is not on this head unit: using 5 (Cabin), the sink its own connections use'), r.lines.join('|'));
        r = await run([{ sinkID: 5, name: 'Cabin' }, { sinkID: 6, name: 'Phone' }], [{ mainConnectionID: 1, sourceID: 129, sinkID: 5 }, { mainConnectionID: 2, sourceID: 130, sinkID: 6 }]);
        assert.strictEqual(r.a.sink, 1024);
        assert.strictEqual(r.a.sinkListed, false);
        assert.ok(r.lines.some((l) => /^sink 1024 is not listed on this head unit; set "sinkID" in /.test(l)), r.lines.join('|'));
        // audio.json names one: it is used as written, listed or not
        r = await run([{ sinkID: 5, name: 'Cabin' }], [], { sinkID: 1999 });
        assert.strictEqual(r.a.sink, 1999);
        // the measured unit: 1024 listed, nothing changes
        r = await run([{ sinkID: 1024, name: 'AMP' }, { sinkID: 5, name: 'Cabin' }], []);
        assert.strictEqual(r.a.sink, 1024);
        assert.strictEqual(r.a.diag.notes.length, 0);
    });

    await t('a proxy that never starts: the try ends with its name after stageMs, the next try joins it (built once); the audio manager silent: said', async () => {
        let builds = 0, release = null;
        const hang = { buildProxy: async (cfg, inst) => { builds++; const px = await someip.buildProxy(cfg, inst); if (cfg.name.indexOf('CommandControl') >= 0) px.init = () => new Promise((r) => { release = r; }); return px; } };
        let a = new Audio({ someip: hang, srcGen: srcGen, audioConf: path.join(tmp, 'none.json'), availWaitMs: 200, stageMs: 120, log() {} }, H);
        await assert.rejects(a.start(), /^Error: starting the CommandControl proxy timed out$/);
        assert.strictEqual(a.diag.stage, 'starting the CommandControl proxy');
        assert.strictEqual(a.why(), 'the car\'s audio is not ready - the car\'s CommandControl does not start (Settings > Diagnostics)');
        await assert.rejects(a.start(), /starting the CommandControl proxy timed out/);
        assert.strictEqual(builds, 1);
        release();
        await a.start();
        assert.strictEqual(builds, 2);       // (the player's)
        assert.strictEqual(a.diag.tries, 3);
        assert.strictEqual(a.diag.ready, true);
        // a proxy whose build fails is built again
        builds = 0;
        const fail = { buildProxy: async (cfg, inst) => { if (++builds === 1) throw new Error('no such service'); return someip.buildProxy(cfg, inst); } };
        a = new Audio({ someip: fail, srcGen: srcGen, audioConf: path.join(tmp, 'none.json'), availWaitMs: 200, log() {} }, H);
        await assert.rejects(a.start(), /^Error: no such service$/);
        await a.start();
        // the audio manager does not answer
        const silent = { buildProxy: async (cfg, inst) => Object.assign(await someip.buildProxy(cfg, inst), { isAvailable: async () => false, getValue: async () => { throw new Error('not available'); } }) };
        a = new Audio({ someip: silent, srcGen: srcGen, audioConf: path.join(tmp, 'none.json'), availWaitMs: 150, log() {} }, H);
        await assert.rejects(a.start(), /^Error: CommandControl not available$/);
        assert.strictEqual(a.diag.stage, 'waiting for the audio manager (CommandControl) to answer');
        assert.strictEqual(a.why(), 'the car\'s audio is not ready - the car\'s audio manager (CommandControl) does not answer (Settings > Diagnostics)');
        await a.refresh();
        assert.strictEqual(a.diag.cc.available, false);
        assert.strictEqual(a.diag.sources, null);
    });

    await t('a play the car refuses: the answer is kept for the page; a rejection that is no Error says which call; a player not offered is named', async () => {
        const mkSip = (over) => ({ buildProxy: async (cfg, inst) => Object.assign(await someip.buildProxy(cfg, inst), over(cfg)) });
        const mk = (over) => new Audio({ someip: mkSip(over), srcGen: srcGen, audioConf: path.join(tmp, 'none.json'), availWaitMs: 200, log() {} }, H);
        let a = mk(() => ({ callMethod: async (m) => (m === 'connect' ? { amError: 'E_NON_EXISTENT' } : { EntError: 'OK' }) }));
        await a.start();
        await assert.rejects(a.playNow('/x/audio.m4a'), /^Error: audio connect: E_NON_EXISTENT$/);
        assert.strictEqual(a.diag.play.connect, '{"amError":"E_NON_EXISTENT"}');
        assert.strictEqual(a.diag.play.error, 'audio connect: E_NON_EXISTENT');
        a = mk(() => ({ callMethod: (m) => (m === 'connect' ? Promise.reject({ code: 7 }) : Promise.resolve({ EntError: 'OK' })) }));    // eslint-disable-line prefer-promise-reject-errors
        await a.start();
        await assert.rejects(a.playNow('/x/audio.m4a'), /^Error: audio connect failed: \{"code":7\}$/);
        a = mk((cfg) => (cfg.name.indexOf('MediaPlayer') >= 0 ? { isAvailable: async () => false, callMethod: async () => { throw new Error('Service unavailable for call playFile()'); } } : {}));
        Object.assign(a.opts, { playerWaitMs: 60, probeMs: 60, playerAfterMs: 120, probeAgainMs: 20 });
        await a.start();
        assert.strictEqual(a.diag.mp.available, false);
        await assert.rejects(a.playNow('/x/audio.m4a'), /^Error: the car does not offer the media player "OapGenericMedia" on this head unit \(Settings > Diagnostics\)$/);
        assert.strictEqual(a.diag.play.player, false);
        assert.ok(a.diag.play.waited >= 100, 'the player was waited for once its source was connected: ' + a.diag.play.waited);
        assert.strictEqual(a.diag.play.error, 'Service unavailable for call playFile() | the player does not answer');
        await a.release();
    });

    // ---- 0.4.2: a head unit that does not offer the measured player (iDrive 8, on a car: "Service unavailable for call playFile()")
    // a binding whose players answer or not by description and instance: up = { 'mp|OapGenericMedia': true, ... }
    const mkPlayers = (root, files) => {
        fs.mkdirSync(root, { recursive: true });
        fs.writeFileSync(path.join(root, 'org_genivi_am_commandinterface_CommandControl.json'), JSON.stringify({ name: 'CommandControl', serviceId: 4660, instances: { 1: 1 } }));
        Object.keys(files).forEach((f) => fs.writeFileSync(path.join(root, f), JSON.stringify(files[f])));
    };
    const playersSip = (up, sources, after) => ({ built: [], buildProxy: async function (cfg, inst) {
        this.built.push(cfg.name + '|' + inst);
        const px = await someip.buildProxy(cfg, inst);
        if (cfg.name === 'CommandControl') {
            return Object.assign(px, { getValue: async (n) => (n === 'listOfMainSources' ? sources : n === 'listOfMainSinks' ? [{ sinkID: 1024, name: 'AMP' }] : []),
                callMethod: async (m, a) => { calls.push({ inst: inst, m: m, a: a }); if (m === 'connect' && after) after(); return m === 'connect' ? { mainConnectionID: 90, amError: 'E_OK' } : { amError: 'E_OK' }; } });
        }
        const subsOf = {};
        return Object.assign(px, { tag: cfg.name + '|' + inst, subsOf: subsOf, isAvailable: async () => !!up[cfg.name + '|' + inst], subscribe: (x) => { subsOf[x.name] = x.onReceive; },
            callMethod: async (m, a) => { calls.push({ inst: cfg.name + '|' + inst, m: m, a: a }); if (!up[cfg.name + '|' + inst]) throw new Error('Service unavailable for call ' + m + '()'); return { EntError: 'OK' }; } });
    } });
    const quick = { probe: true, scanAfterS: 0, playerWaitMs: 40, probeMs: 40, playerAfterMs: 60, probeAgainMs: 20, availWaitMs: 200 };
    const MPF = 'de_bmw_infotainment_entertainment_mediaplayer_MediaPlayer.json', MP2F = 'de_bmw_infotainment_entertainment_mediaplayer2_MediaPlayer2.json';
    const SRC = [{ sourceID: 1046, name: 'OapGenericMedia' }, { sourceID: 2050, name: 'OAP_GENERIC_MEDIA_PLAYER' }, { sourceID: 129, name: 'Tuner' }];

    await t('the measured player not offered: the same instance under a numbered description is used (every instance asked once, the events heard of the one in use)', async () => {
        const root = mkRoot('pl1'), lines = [], seenEv = [];
        mkPlayers(root, { [MPF]: { name: 'mp', serviceId: 100, instances: { OapGenericMedia: 3, Usb: 1 } }, [MP2F]: { name: 'mp2', serviceId: 200, instances: { OapGenericMedia: 3, Bt: 7 } } });
        // an app's copy of the first: the same service and instances, not asked again
        fs.mkdirSync(path.join(root, 'oap', 'oap_13001', 'someipInterfaces'), { recursive: true });
        fs.writeFileSync(path.join(root, 'oap', 'oap_13001', 'someipInterfaces', MPF), JSON.stringify({ name: 'mpApp', serviceId: 100, instances: { OapGenericMedia: 3 } }));
        const up = { 'mp|Usb': true, 'mp2|OapGenericMedia': true, 'mp2|Bt': true };
        const sip = playersSip(up, SRC);
        const a = new Audio(Object.assign({ someip: sip, srcGen: root, oapRoot: path.join(root, 'oap'), audioConf: path.join(root, 'audio.json'), log: (m) => lines.push(m) }, quick),
            { time() {}, state: (v) => seenEv.push(v), error() {} });
        await a.start();
        assert.deepStrictEqual(sip.built, ['CommandControl|1', 'mp|OapGenericMedia', 'mp|Usb', 'mp2|OapGenericMedia', 'mp2|Bt']);
        assert.strictEqual(a.mp.tag, 'mp2|OapGenericMedia');
        assert.ok(lines.some((l) => l === 'the MediaPlayer "OapGenericMedia" is not offered on this head unit: using "OapGenericMedia" of ' + path.join(root, MP2F)), lines.join('|'));
        assert.strictEqual(a.src, 1046, 'the measured instance keeps its source');
        assert.deepStrictEqual(a.diag.players.map((x) => x.inst + ' ' + x.available + ' ' + path.basename(x.file)),
            ['OapGenericMedia false ' + MPF, 'Usb true ' + MPF, 'OapGenericMedia true ' + MP2F, 'Bt true ' + MP2F]);
        assert.strictEqual(a.diag.mp.file, path.join(root, MP2F));
        assert.strictEqual(a.diag.mp.available, true);
        calls.length = 0;
        await a.playNow('/x/audio.m4a');
        assert.deepStrictEqual(called('playFile').map((c) => c.inst), ['mp2|OapGenericMedia']);
        assert.strictEqual(a.diag.play.error, null);
        // only the player in use is heard
        a.heard[0].subsOf.playerState('OLD');
        a.mp.subsOf.playerState('NEW');
        assert.deepStrictEqual(seenEv, ['NEW']);
        await a.release();
        // the same instance under the first description comes up later: the one in use answers, nothing moves
        up['mp|OapGenericMedia'] = true;
        calls.length = 0;
        await a.playNow('/x/audio.m4a');
        assert.deepStrictEqual(called('playFile').map((c) => c.inst), ['mp2|OapGenericMedia']);
        assert.strictEqual(sip.built.length, 5, 'no proxy built twice');
        await a.release();
    });

    await t('the measured player not offered: the only offered one named like the generic OAP player, with the audio source named like it; none like it, or audio.json naming one: nothing changes', async () => {
        const root = mkRoot('pl2'), lines = [];
        mkPlayers(root, { [MPF]: { name: 'mp', serviceId: 100, instances: { OapGenericMedia: 3, Usb: 1, OapGenericMediaPlayer: 9, Bluetooth: 4 } } });
        const up = { 'mp|Usb': true, 'mp|OapGenericMediaPlayer': true };
        let a = new Audio(Object.assign({ someip: playersSip(up, SRC), srcGen: root, audioConf: path.join(root, 'audio.json'), log: (m) => lines.push(m) }, quick), H);
        await a.start();
        assert.strictEqual(a.mp.tag, 'mp|OapGenericMediaPlayer');
        assert.strictEqual(a.src, 2050);
        assert.ok(lines.some((l) => l === 'the MediaPlayer "OapGenericMedia" is not offered on this head unit: using "OapGenericMediaPlayer"'), lines.join('|'));
        assert.ok(lines.some((l) => l === 'audio source 2050 (OAP_GENERIC_MEDIA_PLAYER) goes with the MediaPlayer "OapGenericMediaPlayer"'), lines.join('|'));
        calls.length = 0;
        await a.playNow('/x/audio.m4a');
        assert.deepStrictEqual(called('connect')[0].a, { sourceID: 2050, sinkID: 1024 });
        assert.deepStrictEqual(called('playFile').map((c) => c.inst), ['mp|OapGenericMediaPlayer']);
        await a.release();
        // the measured instance comes up later: the next play goes back to it, and to its source
        up['mp|OapGenericMedia'] = true;
        calls.length = 0;
        await a.playNow('/x/audio.m4a');
        assert.deepStrictEqual(called('connect')[0].a, { sourceID: 1046, sinkID: 1024 });
        assert.deepStrictEqual(called('playFile').map((c) => c.inst), ['mp|OapGenericMedia']);
        await a.release();
        delete up['mp|OapGenericMedia'];
        // audio.json names the instance: no other is taken for it
        fs.writeFileSync(path.join(root, 'audio.json'), JSON.stringify({ instance: 'OapGenericMedia' }));
        a = new Audio(Object.assign({ someip: playersSip(up, SRC), srcGen: root, audioConf: path.join(root, 'audio.json'), log() {} }, quick), H);
        await a.start();
        assert.strictEqual(a.mp.tag, 'mp|OapGenericMedia');
        assert.strictEqual(a.diag.mp.available, false);
        fs.unlinkSync(path.join(root, 'audio.json'));
        // no offered player is named like it (Usb and Bluetooth are other people's players): the play says so
        const up2 = { 'mp|Usb': true, 'mp|Bluetooth': true };
        a = new Audio(Object.assign({ someip: playersSip(up2, SRC), srcGen: root, audioConf: path.join(root, 'audio.json'), log() {} }, quick), H);
        await a.start();
        assert.strictEqual(a.mp.tag, 'mp|OapGenericMedia');
        assert.strictEqual(a.diag.ready, true);
        calls.length = 0;
        await assert.rejects(a.playNow('/x/audio.m4a'), /^Error: the car does not offer the media player "OapGenericMedia" on this head unit \(Settings > Diagnostics\)$/);
        assert.deepStrictEqual(called('playFile').map((c) => c.inst), ['mp|OapGenericMedia'], 'nobody else\'s player is tried');
        await a.release();
        // two offered ones named like it: not chosen between
        const up3 = { 'mp|OapGenericMediaPlayer': true, 'mp2|OapGenericMediaTwo': true };
        mkPlayers(root, { [MP2F]: { name: 'mp2', serviceId: 200, instances: { OapGenericMediaTwo: 5 } } });
        a = new Audio(Object.assign({ someip: playersSip(up3, SRC), srcGen: root, audioConf: path.join(root, 'audio.json'), log() {} }, quick), H);
        await a.start();
        assert.strictEqual(a.mp.tag, 'mp|OapGenericMedia');
    });

    await t('a player the head unit starts with its source: waited for once the source is connected, then played', async () => {
        const root = mkRoot('pl3');
        mkPlayers(root, { [MPF]: { name: 'mp', serviceId: 100, instances: { OapGenericMedia: 3 } } });
        const up = {};
        const sip = playersSip(up, SRC, () => setTimeout(() => { up['mp|OapGenericMedia'] = true; }, 150));
        const a = new Audio(Object.assign({ someip: sip, srcGen: root, audioConf: path.join(root, 'audio.json'), log() {} }, quick, { playerAfterMs: 2000 }), H);
        await a.start();
        assert.strictEqual(a.diag.mp.available, false);
        calls.length = 0;
        await a.playNow('/x/audio.m4a');
        assert.deepStrictEqual(calls.filter((c) => c.m === 'connect' || c.m === 'playFile').map((c) => c.m), ['connect', 'playFile']);
        assert.ok(a.diag.play.waited >= 100 && a.diag.play.waited < 1500, String(a.diag.play.waited));
        assert.strictEqual(a.diag.play.player, true);
        assert.strictEqual(a.diag.play.error, null);
        await a.release();
    });

    await t('the page: who the unit\'s SOME/IP security lets ask for and offer a service', async () => {
        const { someipPolicies } = require('../ytd.js');
        const root = mkRoot('pol'), dir = path.join(root, 'vsomeip');
        const put = (rel, o) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), typeof o === 'string' ? o : JSON.stringify(o)); };
        const me = process.getuid() + '_' + process.getgid();
        put('13001_13001/policy.json', { security: { check_credentials: 'true', policies: [{ credentials: { uid: 13001, gid: 13001 }, allow: { requests: [{ service: '0x64', instances: [{ ids: ['0x3'], methods: 'any' }] }, { service: '0x1234', instance: 'any' }] } }] } });
        put('1016_1016/policy.json', { security: { policies: [{ credentials: { uid: '1016', gid: '1016' }, allow: { offers: [{ service: 100, instance: '0x3' }, { service: { first: '0x1000', last: '0x1fff' }, instance: 'any' }] } }] } });
        put(me + '/policy.json', { security: { policies: [{ allow: { requests: [{ service: '0x1234', instance: 'any' }] }, deny: { requests: [{ service: '0x64' }] } }] } });
        put('base.json', { security: { allow_remote_clients: false, policies: [{ credentials: { uid: 0, gid: 77 }, allow: { requests: [{ service: '0x64' }] } }] } });
        put('13002_13002/broken.json', '{ not json');
        const l = someipPolicies([dir, path.join(root, 'none')], [{ name: 'CommandControl', id: 0x1234 }, { name: 'MediaPlayer', id: 100 }, { name: 'Other', id: null }]);
        assert.ok(l[0].indexOf('SOME/IP security: ' + dir + ' has 5 files for 4 clients (') === 0 && / \| check_credentials true \| allow_remote_clients false \| this service runs as \d+_\d+: has a policy$/.test(l[0]), l[0]);
        const byName = (l2) => l2.sort((x, y) => (x.split(' ')[0] < y.split(' ')[0] ? -1 : 1)).join(', ');
        assert.strictEqual(l[1], 'CommandControl (service 0x1234): may be asked for by ' + byName(['13001_13001 [any]', me + ' [any]']) + ' | offered by 1016_1016 [any] | this service (' + me + ') may ask: yes');
        assert.strictEqual(l[2], 'MediaPlayer (service 0x64): may be asked for by ' + byName(['13001_13001 [[{ids:[0x3],methods:any}]]', '0_77']) + ' | offered by 1016_1016 [0x3] | also named (denied or other) for ' + me + ' | this service (' + me + ') may ask: NOT NAMED');
        assert.strictEqual(l[3], 'Other: its description gives no service id, the policies cannot be read for it');
        assert.deepStrictEqual(someipPolicies([path.join(root, 'none')], []), ['SOME/IP security: no policies (' + path.join(root, 'none') + ' not there)']);
    });

    await t('a daemon on a head unit without the player: the page names the players asked, the policies, and how the installed apps play media (read in the background)', async () => {
        const root = mkRoot('pl5'), oap = path.join(root, 'oap');
        mkPlayers(root, { [MPF]: { name: 'mp', serviceId: 100, instances: { OapGenericMedia: 3, Usb: 1 } } });
        const js = (rel, text) => { fs.mkdirSync(path.dirname(path.join(oap, rel)), { recursive: true }); fs.writeFileSync(path.join(oap, rel), text + '\n' + '/* pad */'.repeat(40)); };
        js('oap_13001/node_modules/bmw-music/javascript/app.js', 'var a=buildProxy("de.bmw.infotainment.entertainment.mediaplayer2.MediaPlayer2","OnlineGenericMedia");a.playUrl({url:u});require("oap-sdk/src/media/MediaSession.js");');
        js('oap_13002/node_modules/bmw-radio/javascript/app.js', "p=get('OnlineGenericMedia');p.playUrl(x);q='org.genivi.am.commandinterface.CommandControl'");
        js('oap_13003/node_modules/jap_ridetube8/app/main.js', 'x="OapGenericMedia";y.playFile(1)');
        js('oap_13004/node_modules/other/javascript/app.js', 'nothing here about it');
        fs.mkdirSync(path.join(root, 'vsomeip', '0_0'), { recursive: true });
        fs.writeFileSync(path.join(root, 'vsomeip', '0_0', 'policy.json'), JSON.stringify({ security: { policies: [{ allow: { requests: [{ service: 4660, instance: 'any' }] } }] } }));
        const lg = [];
        const d5 = new Daemon(Object.assign({ someip: playersSip({ 'mp|Usb': true }, SRC), srcGen: root, oapRoot: oap, policyDirs: [path.join(root, 'vsomeip')], mainapps: [], ytdec: fakeYtdec, cacheDir: path.join(root, 'cache'), logDir: tmp,
            sock: path.join(tmp, 'ctl5.sock'), stateDir: path.join(tmp, 'st5'), noSetuid: true, spare: false, resume: false, fetchRetryMs: [], noHwCheck: true, accountFile: path.join(tmp, 'acct5.json'),
            ytRequest: fakeYt, audioConf: path.join(root, 'audio.json'), codeScanDelayMs: 30, log: (m) => lg.push(m) }, quick));
        await d5.start();
        await waitUntil(() => d5.code && d5.code.state === 'done', 4000);
        const c5 = await client(path.join(tmp, 'ctl5.sock'));
        c5.send({ cmd: 'diag' });
        const m = await c5.waitFor((x) => x.ev === 'diag');
        const all = m.lines.join('\n');
        assert.strictEqual(m.ready, true);
        assert.ok(all.indexOf('MediaPlayer: description ' + path.join(root, MPF) + ' | instance OapGenericMedia of [OapGenericMedia, Usb] | service 0x64, instance 0x3 | answers: NO') >= 0, all);
        assert.ok(all.indexOf('Players the car offers: 2 asked | answering: Usb=0x1 | of the OAP, dynamic and online ones: OapGenericMedia=0x3 NO') >= 0, all);
        assert.ok(all.indexOf('# The dynamic media player\nNo description of a DynamicMediaPlayer on this head unit.') >= 0, all);
        assert.ok(/# Who may use them\nSOME\/IP security: .* has 1 files for 1 clients \(0_0\)/.test(all), all);
        assert.ok(/\nCommandControl \(service 0x1234\): may be asked for by 0_0 \[any\] \| offered by nobody \| /.test(all), all);
        assert.ok(/\nMediaPlayer \(service 0x64\): may be asked for by nobody \| offered by nobody \| this service \(\d+_\d+\) may ask: NOT NAMED/.test(all), all);
        assert.ok(all.indexOf('# How the installed apps play media\n3 files of the installed apps and the app manager read\n' +
            'instances: OnlineGenericMedia (oap_13001:bmw-music, oap_13002:bmw-radio)\n' +
            'interfaces: de.bmw.infotainment.entertainment.mediaplayer2.MediaPlayer2 (oap_13001:bmw-music) | org.genivi.am.commandinterface.CommandControl (oap_13002:bmw-radio)\n' +
            'calls: playUrl (oap_13001:bmw-music, oap_13002:bmw-radio)\n' +
            'SDK modules: oap-sdk/src/media/MediaSession.js (oap_13001:bmw-music)\n') >= 0, all);
        assert.ok(lg.some((l) => /^apps' code read for how they play media: 3 files, 1 instances, 2 interfaces, 1 calls, 1 SDK modules$/.test(l)), lg.join('|'));
        c5.destroy();
        await d5.close();
    });

    await t('iDrive 8 as on the car: the lists read through a description made of the catalog, the DynamicMediaPlayer described and asked (nothing called), what runs the media, and the code around it', async () => {
        const root = mkRoot('id8'), gen = path.join(root, 'usr/lib/oap-mainapp21/src-gen/someip'), main = path.join(root, 'usr/lib/oap-mainapp21');
        const CC = 'org.genivi.am.commandinterface.CommandControl';
        fs.mkdirSync(gen, { recursive: true });
        fs.writeFileSync(path.join(gen, 'org_genivi_am_commandinterface_CommandControl.json'), JSON.stringify({ name: 'ccTrim', serviceId: 0xb020, instances: { 1: 1 }, methods: { connect: {}, disconnect: {} }, fields: { listOfMainConnections: {} } }));
        fs.writeFileSync(path.join(gen, 'de_bmw_infotainment_entertainment_dynamicmediaplayer_DynamicMediaPlayer.json'),
            JSON.stringify({ name: 'dyn', serviceId: 0xb050, instances: { DynInstA: 1, DynInstB: 2 }, methods: { createPlayer: { id: 3, schema: { t: 'Struct', e: [{ n: 'playerName', t: 'Utf16D' }, { n: 'kind', t: 'Enum', e: { MEDIA: 0, OVERLAY: 1 } }] },
                retSchema: { t: 'Struct', e: [{ n: 'token', t: 'Utf16D' }] } } }, fields: { activePlayers: { id: 9, schema: { t: 'ArrayD', e: { t: 'Utf16D' } } }, broken: { id: 10, schema: { t: 'UInt8' } } } }));
        fs.mkdirSync(path.join(root, 'am'));
        fs.writeFileSync(path.join(root, 'am', 'SmartXMGU.bin'), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from('OapGenericMediaStereo'), Buffer.from([0, 7]), Buffer.from('TelRing_Outband'), Buffer.from([0]), Buffer.from('OnlineEntertainment_Main')]));
        fs.writeFileSync(path.join(root, 'asound.conf'), 'pcm.!default {\n type plug\n}\npcm.smartx_media {\n type smartx\n}\n');
        fs.mkdirSync(path.join(root, 'bin')); fs.writeFileSync(path.join(root, 'bin', 'gst-launch-1.0'), '');
        fs.mkdirSync(path.join(root, 'gst')); ['libgstfdkaac.so', 'libgstalsa.so', 'libgstvideo4linux2.so'].forEach((n) => fs.writeFileSync(path.join(root, 'gst', n), ''));
        fs.mkdirSync(path.join(root, 'oap', 'oap_12204', 'someipInterfaces'), { recursive: true });
        const many = {};
        ['OapGenericMedia', 'Usb', 'DynamicMedia', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9', 'A10'].forEach((n, i) => { many[n] = i + 1; });
        fs.writeFileSync(path.join(root, 'oap', 'oap_12204', 'someipInterfaces', MPF), JSON.stringify({ name: 'mp', serviceId: 0xb042, instances: many }));
        fs.writeFileSync(path.join(root, 'cat.json'), JSON.stringify({ interfaces: { [CC]: { full: { name: 'ccFull', serviceId: 0xb020, instances: { 1: 1 }, methods: { connect: {} }, fields: { listOfMainSources: {}, listOfMainSinks: {}, listOfMainConnections: {} } } } } }));
        fs.mkdirSync(path.join(main, 'src', 'AppManagement'), { recursive: true });
        fs.writeFileSync(path.join(main, 'src', 'AppManagement', 'AppManagement.js'),
            '(function(){function r(e,n,t){function o(i){if(!n[i]){var p=n[i]={exports:{}};e[i][0].call(p.exports,function(x){return o(e[i][1][x]||x)},p,p.exports)}return n[i].exports}for(var u=0;u<t.length;u++)o(t[u]);return o}return r})()({7:[function(require,module,exports){module.exports={generate:function(db,m){var o={};Object.keys(m.proxies).forEach(function(id){o[id]=db.interfaces[id].full;});return o;}};},{"someip-interfaces-generator/IFConfigGenerator":7}]},{},[7]);\n');
        fs.mkdirSync(path.join(main, 'src', 'media'), { recursive: true });
        fs.writeFileSync(path.join(main, 'src', 'media', 'player.js'), '/* pad */'.repeat(30) + 'var p=buildProxy("de.bmw.infotainment.entertainment.dynamicmediaplayer.DynamicMediaPlayer","DynInstA");p.callMethod("createPlayer",{playerName:"OapGenericMedia"},5000);p.subscribe({name:"activePlayers",onReceive:f});' + '/* pad */'.repeat(30));
        fs.mkdirSync(path.join(root, 'proc', '77'), { recursive: true });
        fs.writeFileSync(path.join(root, 'proc', '77', 'cmdline'), '/usr/bin/mediaplayerd\0--instance\0CarPlayMedia\0');
        fs.mkdirSync(path.join(root, 'proc', '78'), { recursive: true });
        fs.writeFileSync(path.join(root, 'proc', '78', 'cmdline'), '/bin/sh\0');
        fs.mkdirSync(path.join(root, 'units'));
        ['mediaplayerd.service', 'oap-dynamic-player.socket', 'network.service'].forEach((n) => fs.writeFileSync(path.join(root, 'units', n), ''));
        fs.mkdirSync(path.join(root, 'asound'));
        fs.writeFileSync(path.join(root, 'asound', 'cards'), ' 0 [Dummy ]: Dummy - Dummy\n');
        const got = [];
        const sip = { buildProxy: async (cfg, inst) => {
            got.push(cfg.name + '|' + inst);
            const px = await someip.buildProxy(cfg, inst);
            if (cfg.name === 'ccTrim') return Object.assign(px, { getValue: async (n) => { if (n !== 'listOfMainConnections') throw new Error('no such field ' + n); return [{ mainConnectionID: 1, sourceID: 129, sinkID: 387 }]; },
                callMethod: async (m, a) => { calls.push({ inst: 'ccTrim', m: m, a: a }); return { mainConnectionID: 9, amError: 'E_OK' }; } });
            if (cfg.name === 'ccFull') return Object.assign(px, { getValue: async (n) => (n === 'listOfMainSources' ? [{ sourceID: 1046, name: 'OapGenericMedia' }] : [{ sinkID: 1024, name: 'AMP' }]), callMethod: async () => { throw new Error('not for calls'); } });
            if (cfg.name === 'dyn') return Object.assign(px, { isAvailable: async () => inst === 'DynInstB', getValue: async (n) => { if (n === 'broken') throw new Error('nope'); return [{ name: 'CarPlayMedia' }]; },
                callMethod: async (m) => { calls.push({ inst: 'dyn', m: m }); return {}; } });
            return Object.assign(px, { isAvailable: async () => inst === 'Usb', callMethod: async (m) => { throw new Error('Service unavailable for call ' + m + '()'); } });
        } };
        const d6 = new Daemon(Object.assign({ someip: sip, srcGens: [path.join(root, 'usr/lib/oap-mainapp/src-gen'), gen], srcGen: null, oapRoot: path.join(root, 'oap'), catalogs: [path.join(root, 'cat.json')],
            generators: [path.join(main, 'src', 'AppManagement', 'AppManagement.js')], mainapps: [{ root: main, hmi: 'Hmi8' }], policyDirs: [path.join(root, 'none')], procRoot: path.join(root, 'proc'),
            unitDirs: [path.join(root, 'units')], asound: path.join(root, 'asound'), systemctl: path.join(root, 'no-systemctl'), amDir: path.join(root, 'am'), alsaConf: [path.join(root, 'asound.conf')],
            binDirs: [path.join(root, 'bin')], gstDirs: [path.join(root, 'gst')], searchRoots: [], ytdec: fakeYtdec, cacheDir: path.join(root, 'cache'), logDir: tmp,
            sock: path.join(tmp, 'ctl6.sock'), stateDir: path.join(tmp, 'st6'), noSetuid: true, spare: false, resume: false, fetchRetryMs: [], noHwCheck: true, accountFile: path.join(tmp, 'acct6.json'),
            ytRequest: fakeYt, audioConf: path.join(root, 'audio.json'), codeScanDelayMs: 20, log() {} }, quick));
        calls.length = 0;
        await d6.start();
        await waitUntil(() => d6.code && d6.code.state === 'done', 4000);
        const all = (await d6.diagLines()).join('\n').split(root).join('');
        assert.ok(all.indexOf('Sources: 1046:OapGenericMedia\nSinks: 1024:AMP\nConnections (id:source>sink): 1:129>387') >= 0, all);
        assert.ok(/Route: source 1046 \(listed: yes\) to sink 1024 \(listed: yes\)/.test(all), all);
        assert.ok(all.indexOf('MediaPlayer: description /oap/oap_12204/someipInterfaces/' + MPF + ' | instance OapGenericMedia of 13 instances | service 0xb042, instance 0x1 | answers: NO') >= 0, all);
        assert.ok(all.indexOf('Players the car offers: 13 asked | answering: Usb=0x2 | of the OAP, dynamic and online ones: OapGenericMedia=0x1 NO, DynamicMedia=0x3 NO') >= 0, all);
        assert.ok(all.indexOf('# The dynamic media player\nDescription /usr/lib/oap-mainapp21/src-gen/someip/de_bmw_infotainment_entertainment_dynamicmediaplayer_DynamicMediaPlayer.json | service 0xb050 | instances: DynInstA=0x1 NO, DynInstB=0x2 yes\n' +
            'Its fields now: activePlayers = [{"name":"CarPlayMedia"}] | broken = (nope)\n' +
            'methods (1): createPlayer(playerName:Utf16D, kind:E1) -> token:Utf16D\nfields (2): activePlayers: Utf16D[] | broken: UInt8\nE1 = {MEDIA:0, OVERLAY:1}\n') >= 0, all);
        assert.ok(all.indexOf('Sound device names (ALSA configuration): default, smartx_media\nThe audio manager\'s names of the OAP, online and dynamic media (/am: SmartXMGU.bin): OapGenericMediaStereo, OnlineEntertainment_Main\n' +
            'What could play a file: gst-launch-1.0 | GStreamer plugins: alsa, fdkaac') >= 0, all);
        assert.ok(all.indexOf('DynamicMediaPlayer: its description gives') < 0 && /SOME\/IP security: no policies/.test(all), all);
        assert.ok(all.indexOf('# What runs the media\nProcesses of the media and the audio (uid: command): ' + fs.statSync(path.join(root, 'proc', '77')).uid + ': /usr/bin/mediaplayerd --instance CarPlayMedia\n' +
            'Units of the media and the audio: mediaplayerd | oap-dynamic-player.socket\nSound cards: 0 [Dummy ]: Dummy - Dummy\n') >= 0, all);
        assert.ok(all.indexOf('Calls near the DynamicMediaPlayer in the code: callMethod createPlayer,{playerName:"OapGenericMedia"},5000) || subscribe activePlayers,onReceive:f})') >= 0, all);
        assert.ok(/\[DynamicMediaPlayer, in the app manager\] .*buildProxy\("de\.bmw\.infotainment\.entertainment\.dynamicmediaplayer\.DynamicMediaPlayer","DynInstA"\);p\.callMethod\("createPlayer"/.test(all), all);
        assert.ok(/\[OapGenericMedia, in the app manager\] /.test(all), all);
        assert.deepStrictEqual(calls.filter((c) => c.inst === 'dyn'), [], 'nothing is called on the DynamicMediaPlayer');
        assert.ok(got.indexOf('ccFull|1') >= 0 && got.filter((x) => x === 'ccFull|1').length === 1, got.join(' '));
        // the calls still go to the description MainApp has
        await assert.rejects(d6.audio.playNow('/x/audio.m4a'), /does not offer the media player "OapGenericMedia"/);
        assert.deepStrictEqual(calls.filter((c) => c.m === 'connect').map((c) => c.inst), ['ccTrim']);
        await d6.audio.release();
        await d6.close();
    });

    await t('0.4.4, as shipped (probe off): the two proxies of iDrive 7 and nothing else - no other player, no DynamicMediaPlayer proxy, no generator, no code read at the start', async () => {
        const root = mkRoot('quiet');
        mkPlayers(root, { [MPF]: { name: 'mp', serviceId: 100, instances: { OapGenericMedia: 3, Usb: 1, OapGenericMediaPlayer: 9 } },
            'de_bmw_infotainment_entertainment_dynamicmediaplayer_DynamicMediaPlayer.json': { name: 'dyn', serviceId: 300, instances: { A: 1 }, methods: { createPlayer: {} } } });
        fs.writeFileSync(path.join(root, 'org_genivi_am_commandinterface_CommandControl.json'), JSON.stringify({ name: 'CommandControl', serviceId: 4660, instances: { 1: 1 }, methods: { connect: {} }, fields: { listOfMainConnections: {} } }));
        fs.mkdirSync(path.join(root, 'oap', 'oap_12204', 'someipInterfaces'), { recursive: true });
        const fullCc = path.join(root, 'oap', 'oap_12204', 'someipInterfaces', 'org_genivi_am_commandinterface_CommandControl.json');
        fs.writeFileSync(fullCc, JSON.stringify({ name: 'CommandControl', serviceId: 4660, instances: { 1: 1 }, methods: { connect: {}, disconnect: {} }, fields: { listOfMainConnections: {}, listOfMainSources: {}, listOfMainSinks: {} } }));
        const gen = path.join(root, 'AppManagement.js');
        fs.writeFileSync(gen, 'global.__generatorLoaded = true; ({"someip-interfaces-generator/IFConfigGenerator":7}),{},[7]);');
        fs.writeFileSync(path.join(root, 'cat.json'), JSON.stringify({ interfaces: { 'org.genivi.am.commandinterface.CommandControl': {} } }));
        const sip = playersSip({ 'mp|Usb': true, 'mp|OapGenericMediaPlayer': true }, SRC);
        const dq = new Daemon({ someip: sip, srcGen: root, oapRoot: path.join(root, 'oap'), catalogs: [path.join(root, 'cat.json')], generators: [gen], mainapps: [], policyDirs: [], searchRoots: [],
            procRoot: path.join(root, 'proc'), unitDirs: [], asound: path.join(root, 'asound'), ytdec: fakeYtdec, cacheDir: path.join(root, 'cache'), logDir: tmp, sock: path.join(tmp, 'ctlq.sock'), stateDir: path.join(tmp, 'stq'),
            noSetuid: true, spare: false, resume: false, fetchRetryMs: [], noHwCheck: true, accountFile: path.join(tmp, 'acctq.json'), ytRequest: fakeYt, audioConf: path.join(root, 'audio.json'),
            playerWaitMs: 40, playerAfterMs: 60, availWaitMs: 200, codeScanDelayMs: 10, log() {} });
        assert.strictEqual(dq.opts.probe, false);
        await dq.start();
        await sleep(150);
        await assert.rejects(dq.audio.playNow('/x/audio.m4a'), /does not offer the media player "OapGenericMedia"/);
        await dq.audio.release();
        const all = (await dq.diagLines()).join('\n');
        assert.deepStrictEqual(sip.built, ['CommandControl|1', 'mp|OapGenericMedia']);
        assert.ok(!global.__generatorLoaded, 'the app manager\'s code was loaded');
        assert.strictEqual(dq.code, undefined, 'the code was read at the start');
        assert.ok(/# The dynamic media player\nDescription .*DynamicMediaPlayer\.json \| service 0x12c \| instances: A=0x1 unknown\nIts fields now: none read\nmethods \(1\): createPlayer /.test(all), all);
        assert.ok(all.indexOf('CommandControl: description ' + fullCc + ' | instance 1 of [1]') >= 0 && all.indexOf('Sources: 1046:OapGenericMedia 2050:OAP_GENERIC_MEDIA_PLAYER 129:Tuner\nSinks: 1024:AMP') >= 0, all);
        assert.ok(all.indexOf('Note: MainApp\'s CommandControl description lacks disconnect, listOfMainSources, listOfMainSinks: using ' + fullCc) >= 0, all);
        // once the service has run long enough, opening the page starts the reading, and its result comes by itself
        dq.opts.scanAfterS = 0;
        const cq = await client(path.join(tmp, 'ctlq.sock'));
        cq.send({ cmd: 'diag' });
        await waitUntil(() => cq.evs.filter((x) => x.ev === 'diag').length >= 2, 5000);
        const last = cq.evs.filter((x) => x.ev === 'diag').pop();
        assert.ok(last.lines.some((l) => /^\d+ files of the installed apps and the app manager read$/.test(l)), last.lines.join('\n'));
        cq.destroy();
        assert.ok(all.indexOf('Not read yet: the service waits 180 s after its start') >= 0, all);
        await dq.close();
    });

    await t('a daemon whose audio never comes up: a play ends with the reason (not "audio service timed out"), diag says NOT READY, the start goes on trying', async () => {
        const silent = { buildProxy: async (cfg, inst) => Object.assign(await someip.buildProxy(cfg, inst), { isAvailable: async () => false }) };
        const lg = [];
        const d4 = new Daemon({ someip: silent, srcGen: srcGen, ytdec: fakeYtdec, cacheDir: cache, logDir: tmp, sock: path.join(tmp, 'ctl4.sock'), stateDir: path.join(tmp, 'st4'),
            noSetuid: true, spare: false, resume: false, fetchRetryMs: [], noHwCheck: true, accountFile: path.join(tmp, 'acct4.json'), ytRequest: fakeYt,
            availWaitMs: 60, audioRetryMs: 40, audioWaitMs: 300, log: (m) => lg.push(m) });
        d4.start().catch((e) => lg.push('start: ' + e));
        await waitUntil(() => fs.existsSync(path.join(tmp, 'ctl4.sock')));
        const c4 = await client(path.join(tmp, 'ctl4.sock'));
        mkVideo('AudioDown01');
        c4.send({ cmd: 'play', id: 'AudioDown01', rect: '100x100' });
        const e = await c4.waitFor((x) => x.ev === 'error', 4000);
        assert.strictEqual(e.msg, 'the car\'s audio is not ready - the car\'s audio manager (CommandControl) does not answer (Settings > Diagnostics)', lg.join(' || '));
        await c4.waitFor((x) => x.ev === 'state' && x.state === 'error');
        c4.send({ cmd: 'diag' });
        const m = await c4.waitFor((x) => x.ev === 'diag');
        assert.strictEqual(m.ready, false);
        assert.ok(m.lines.some((l) => /^NOT READY - CommandControl not available \| stopped at: .* \| try \d+$/.test(l)), m.lines.join('\n'));
        assert.ok(m.lines.some((l) => /^CommandControl: description .* \| answers: NO$/.test(l)), m.lines.join('\n'));
        assert.ok(m.lines.some((l) => /someip not ready: CommandControl not available$/.test(l)), m.lines.join('\n'));
        assert.strictEqual(lg.filter((l) => /someip not ready/.test(l)).length, 1, 'the same reason is logged once (and once a minute)');
        const tries = d4.audio.diag.tries;
        await waitUntil(() => d4.audio.diag.tries > tries + 1);
        // past the first minute's tries the start waits six times as long; a play makes the next try at once
        await waitUntil(() => d4.audio.diag.tries >= 14, 6000);
        const at = d4.audio.diag.tries;
        await sleep(130);
        assert.ok(d4.audio.diag.tries <= at + 1, 'slower after 12 tries: ' + (d4.audio.diag.tries - at));
        c4.clear();
        const before = d4.audio.diag.tries;
        c4.send({ cmd: 'play', id: 'AudioDown01', rect: '100x100' });
        await c4.waitFor((x) => x.ev === 'error', 4000);
        assert.ok(d4.audio.diag.tries > before, 'a play asks for a try at once');
        c4.destroy();
        await d4.close();
        const after = d4.audio.diag.tries;
        await sleep(200);
        assert.ok(d4.audio.diag.tries <= after + 1, 'the start stops trying once closed');
        fs.rmSync(path.join(cache, 'AudioDown01'), { recursive: true, force: true });
    });

    c.destroy();
    await d.close();
    console.log(results.join('\n'));
    const failed = results.filter((r) => r.indexOf('FAIL') === 0).length;
    process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
