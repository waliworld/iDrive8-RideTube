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

    c.destroy();
    await d.close();
    console.log(results.join('\n'));
    const failed = results.filter((r) => r.indexOf('FAIL') === 0).length;
    process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
