'use strict';
// Host test for sound.js: an iDrive 8 head unit stood in for (test/fake_car.js), whose ways each test sets - the
// search has to find the way that plays on each of them.   node test/test_sound.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Audio } = require('../ytd.js');
const { fakeCar, DMP } = require('./fake_car.js');
const { bundle } = require('./fake_sdk_bundle.js');

const results = [];
async function t(name, fn) {
    try { await fn(); results.push('ok   ' + name); } catch (e) { results.push('FAIL ' + name + '\n     ' + String(e && e.stack || e).split('\n').slice(0, 7).join('\n     ')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(fn, ms) { const end = Date.now() + (ms || 3000); while (!fn()) { if (Date.now() > end) throw new Error('waitUntil timed out: ' + fn); await sleep(15); } }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sound-'));
const fakeAlsa = path.join(__dirname, 'fake_ytalsa.js');
let n = 0;

/* A head unit: its descriptions, our app's home, a BMW app with the SDK's player (o.sdk: the bundle's options, false:
 * none), a fetched video; an Audio on it, started. */
async function unit(ways, o) {
    o = o || {};
    const root = path.join(tmp, 'u' + (++n)), gen = path.join(root, 'gen'), oap = path.join(root, 'oap');
    [gen, path.join(oap, 'oap_12300', 'source'), path.join(oap, 'oap_12300', 'data'), path.join(oap, 'oap_12209', 'source', 'javascript'), path.join(root, 'cache', 'vid12345678'), path.join(root, 'state')]
        .forEach((d) => fs.mkdirSync(d, { recursive: true }));
    const car = fakeCar(ways);
    car.stateFile = path.join(root, 'carstate.json');
    car.write(gen, o.dmp);
    fs.writeFileSync(path.join(oap, 'oap_12300', 'source', 'package.json'), JSON.stringify({ name: 'jap_ridetube8' }));
    if (o.sdk !== false) fs.writeFileSync(path.join(oap, 'oap_12209', 'source', 'javascript', 'app.js'), bundle(o.sdk || {}));
    const file = path.join(root, 'cache', 'vid12345678', 'audio.m4a'), head = path.join(root, 'cache', 'vid12345678', 'audio.head.m4a');
    fs.writeFileSync(file, 'x'.repeat(1234));
    fs.writeFileSync(head, 'h'.repeat(321));
    fs.writeFileSync(path.join(root, 'ytaud'), '');
    const seen = { state: [], time: [], error: [], note: [] }, lg = [];
    const opts = Object.assign({ someip: car.sip, srcGen: gen, oapRoot: oap, audioConf: path.join(root, 'audio.json'), stateDir: path.join(root, 'state'), id8: true, noSetuid: true, version: 'T1',
        playerWaitMs: 30, playerAfterMs: 30, availWaitMs: 300, dynWaitMs: 300, dynHeartbeatMs: 40, dynConnectMs: 300, dynEchoMs: 30, dynAutoMs: 120, dynStartWaitMs: 160, dynLookMs: 250, sdkGapMs: 0,
        codeHomes: ['oap_12209'], runDir: path.join(root, 'run'), direct: false, alsaCmd: [process.execPath, fakeAlsa], ytaud: path.join(root, 'ytaud'), directStartMs: 1500, scanMs: 300, scanBaseMs: 200, amSettleMs: 5,
        alsaEnv: Object.assign({ FAKE_ALSA_LOG: path.join(root, 'alsa.log'), FAKE_ALSA_WAYS: JSON.stringify(o.alsa || {}), FAKE_ALSA_STATE: car.stateFile }, o.alsaEnv || {}), log: (m) => lg.push(m) }, o.audio || {});
    const mk = () => new Audio(opts, { state: (v) => seen.state.push(v), time: (v) => seen.time.push(v), error: (v) => seen.error.push(v), note: (v) => seen.note.push(v) });
    const a = mk();
    await a.start();
    a.playInfo = { durationMs: 180000, id: 'vid12345678' };
    return { root: root, car: car, a: a, file: file, head: head, seen: seen, lg: lg, opts: opts, mk: mk, oap: oap,
        story: () => a.snd().runs[0].lines.join('\n'), kept: () => a.snd().state.kept, alsaLog: () => { try { return fs.readFileSync(path.join(root, 'alsa.log'), 'utf8').trim().split('\n'); } catch (e) { return []; } } };
}
const item = (u) => u.car.dyn('createPlaylist').filter((c) => c.a.newPlaylist.length).pop().a.newPlaylist[0];

async function main() {
    await t('the car as BMW\'s own code asks it: the item, the heartbeat timer and the start read from the app on the car - it plays at the first try, and that is kept', async () => {
        const u = await unit({ start: 'pos', hbOk: (hb) => hb === 5 });
        await u.a.play(u.file);
        const d = u.car.dyn();
        assert.deepStrictEqual(d.map((c) => c.m), ['getAudioFocus', 'createPlaylist', 'setCurrentItemPositionAndTime'], u.story());
        assert.deepStrictEqual(d[0].a, { clientId: 'jap_ridetube8', clientName: 'RideTube', timeOutHeartBeatTimer: 5 });
        // the item is BMW's converter's: its named union, its 4-byte buffer id, our file and its size in the sample's place
        const it = item(u);
        assert.deepStrictEqual(it.metadata, [{ key: 'FILE_NAME', value: { stringValue: u.file } }, { key: 'FILE_SIZE', value: { numeric: 1234 } }]);
        assert.ok(Buffer.isBuffer(it.id) && it.id.length === 4 && it.pos === 1);
        assert.strictEqual(u.a.connId, 'snd');
        assert.deepStrictEqual(u.kept().key + '|' + u.kept().form + '|' + u.kept().loc + '|' + u.kept().start + '|' + u.kept().hb, 'dyn:DynamicMediaPlayerMedia|sdk|path|pos|5');
        // its state and time are the daemon's from here
        await waitUntil(() => u.seen.time.length >= 2 && u.seen.state.length >= 1);
        assert.strictEqual(u.seen.state[0], 'PLAYER_STATE_PLAY');
        assert.ok(u.seen.time[0].total === 180000 && u.seen.time[1].elapsed >= u.seen.time[0].elapsed);
        assert.ok(u.car.calls.filter((c) => c.m === 'heartBeat').length >= 1, 'the focus is kept alive');
        assert.deepStrictEqual(u.car.calls.filter((c) => c.on === 'cc'), [], 'the audio manager is not asked: the player connects itself');
        assert.ok(/reading BMW's own player code/.test(u.story()) && /PLAYS: DynamicMediaPlayerMedia \| as BMW's own code writes it \| where the file is \| started pos/.test(u.story()), u.story());
        // a moment into the play the car's own words go into the story (a play nobody hears shows there)
        await waitUntil(() => /s into it: connectionState CS_CONNECTED \| playerState PLAYER_STATE_PLAY \| currentItemTime \{ elapsed: \d+, total: 180000 \} \(\d+ said\) \| focus ours, HAS_FOCUS/.test(u.story()), 3000);
        assert.ok(u.seen.note.some((x) => /Reading how the car's own apps play/.test(x)) && u.seen.note.some((x) => /Finding how this car plays sound: way 1/.test(x)));
        // pause, seek, the whole file after the head, stop
        u.car.calls.length = 0;
        await u.a.button('STOP');
        await u.a.seek(42000);
        await u.a.replay(u.head);
        assert.deepStrictEqual(u.car.dyn().map((c) => c.m + (c.a.button ? ' ' + c.a.button + ' ' + c.a.action : '')),
            ['sendButtonEventDirect STOP PRESS', 'sendButtonEventDirect STOP RELEASE', 'setCurrentItemPositionAndTime', 'createPlaylist', 'setCurrentItemPositionAndTime']);
        assert.deepStrictEqual(u.car.dyn()[2].a, { token: 'TOK1', newPosition: 1, newTimeElapsed: 42000 });
        assert.strictEqual(item(u).metadata[0].value.stringValue, u.head);
        assert.strictEqual(item(u).metadata[1].value.numeric, 321);
        u.car.calls.length = 0;
        await u.a.release();
        assert.deepStrictEqual(u.car.dyn().map((c) => c.m + (c.a.button ? ' ' + c.a.button : '') + (c.a.newPlaylist ? ' ' + c.a.newPlaylist.length : '')),
            ['sendButtonEventDirect STOP', 'sendButtonEventDirect STOP', 'createPlaylist 0', 'releaseAudioFocus']);
        assert.strictEqual(u.a.connId, null);
        const states = u.seen.state.length;
        u.car.calls.length = 0;
        await sleep(120);
        assert.deepStrictEqual(u.car.calls, [], 'no beat once the focus is given back');
        u.car.emit('DynamicMediaPlayerMedia', 'playerState', 'PLAYER_STATE_PLAY');
        await sleep(20);
        assert.strictEqual(u.seen.state.length, states, 'after the release the daemon no longer hears it');
        // the next play: the kept way at once, BMW's code not read again
        u.car.calls.length = 0; u.seen.note.length = 0;
        await u.a.play(u.file);
        assert.deepStrictEqual(u.car.dyn().map((c) => c.m), ['getAudioFocus', 'createPlaylist', 'setCurrentItemPositionAndTime']);
        assert.ok(!u.seen.note.some((x) => /Reading/.test(x)));
        assert.strictEqual(u.kept().plays, 2);
        await u.a.release();
        u.car.stop();
    });

    await t('no app with the SDK on the car, a binding that takes ids as arrays only: the forms are tried until one is taken', async () => {
        const u = await unit({ idAs: 'array' }, { sdk: false });
        await u.a.play(u.file);
        assert.strictEqual(u.kept().form, 'wa', u.story());
        assert.ok(Array.isArray(item(u).id));
        assert.ok(/createPlaylist \[named values, id a Buffer \| where the file is\] .* FAILED: ByteBuffer: wrong type/.test(u.story()), u.story());
        assert.ok(/not read: no installed app carries the SDK's player/.test(u.story()));
        assert.deepStrictEqual(u.car.dyn()[0].a.timeOutHeartBeatTimer, 10000);
        await u.a.release();
    });

    await t('a service that answers BAD_ARGUMENT to named values and takes plain ones', async () => {
        const u = await unit({ union: 'plain', bad: 'BAD_ARGUMENT' }, { sdk: false });
        await u.a.play(u.file);
        assert.strictEqual(u.kept().form, 'pb', u.story());
        assert.strictEqual(item(u).metadata[0].value, u.file);
        await u.a.release();
    });

    await t('a binding that takes a wrong form without a word (an empty name arrives): the player\'s own words of the item show it, the next form is taken', async () => {
        const u = await unit({ union: 'typed', bad: 'silent', unreadable: 'silent' }, { sdk: false });
        await u.a.play(u.file);
        assert.strictEqual(u.kept().form, 'tb', u.story());
        assert.ok(/it does NOT name our file/.test(u.story()));
        await u.a.release();
    });

    await t('the media engine cannot read our cache folder and says so: the same form with the file in our app\'s data folder plays', async () => {
        const u = await unit({ readable: (nm) => /\/oap\/oap_12300\/data\//.test(nm) && !/^file:/.test(nm) });
        await u.a.play(u.file);
        assert.strictEqual(u.kept().form + '|' + u.kept().loc, 'sdk|pub', u.story());
        const nm = item(u).metadata[0].value.stringValue;
        assert.ok(/oap_12300\/data\/rt-audio-[0-9a-f]{8}\.m4a$/.test(nm) && fs.readFileSync(nm, 'utf8').length === 1234, nm);
        assert.ok(/ITEM_UNPLAYABLE/.test(u.story()));
        // only BMW's form was needed: no other form was asked
        assert.strictEqual(u.car.dyn('createPlaylist').length, 2);
        // the head's switch to the whole file puts that one there too; a release leaves nothing behind
        await u.a.replay(u.head);
        assert.ok(/oap_12300\/data\/rt-audio-/.test(item(u).metadata[0].value.stringValue) && fs.readFileSync(item(u).metadata[0].value.stringValue, 'utf8').length === 321);
        await u.a.release();
        assert.deepStrictEqual(fs.readdirSync(path.join(u.oap, 'oap_12300', 'data')), []);
    });

    await t('a media engine that says nothing when it cannot read, and reads only an address: every place is tried, http://127.0.0.1 plays', async () => {
        const got = [];
        const u = await unit({ unreadable: 'silent', readable: (nm) => { got.push(nm); return /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{16}\/audio\.m4a$/.test(nm); } });
        await u.a.play(u.file);
        assert.strictEqual(u.kept().loc, 'http', u.story());
        assert.deepStrictEqual(got.map((x) => (/^http/.test(x) ? 'http' : /^file:\/\/.*data/.test(x) ? 'puburl' : /^file:/.test(x) ? 'url' : /oap_12300/.test(x) ? 'pub' : /\/run\//.test(x) ? 'run' : 'path')), ['path', 'pub', 'url', 'run', 'http']);
        // the address serves the file, with ranges
        const url = got[got.length - 1];
        const res = await new Promise((resolve, reject) => require('http').get(url, { headers: { Range: 'bytes=10-19' } }, (r) => { let b = ''; r.on('data', (d) => { b += d; }); r.on('end', () => resolve({ code: r.statusCode, body: b, range: r.headers['content-range'] })); }).on('error', reject));
        assert.deepStrictEqual(res, { code: 206, body: 'x'.repeat(10), range: 'bytes 10-19/1234' });
        await u.a.release();
        await assert.rejects(new Promise((resolve, reject) => require('http').get(url, resolve).on('error', reject)), /ECONNREFUSED/, 'the address is gone with the play');
        assert.ok(!fs.existsSync(path.join(u.root, 'run')) || fs.readdirSync(path.join(u.root, 'run')).length === 0);
    });

    for (const start of ['auto', 'play', 'autoplay']) {
        await t('what starts a playlist is found: ' + start, async () => {
            const u = await unit({ start: start }, { sdk: false });
            await u.a.play(u.file);
            assert.strictEqual(u.kept().start, start, u.story());
            // the same start at the next play, first
            await u.a.release();
            u.car.calls.length = 0;
            await u.a.play(u.file);
            const ms = u.car.dyn().map((c) => c.m);
            assert.deepStrictEqual(ms.slice(0, 2), ['getAudioFocus', 'createPlaylist']);
            assert.ok(ms.indexOf('setCurrentItemPositionAndTime') < 0, ms.join());
            await u.a.release();
        });
    }

    await t('the heartbeat timer in seconds with a limit, a client id the player does not know: the next values are taken', async () => {
        const u = await unit({ hbOk: (hb) => hb <= 60, clientOk: (id) => id === 'RideTube' }, { sdk: false });
        await u.a.play(u.file);
        assert.deepStrictEqual(u.car.dyn('getAudioFocus').map((c) => c.a.clientId + ' ' + c.a.timeOutHeartBeatTimer), ['jap_ridetube8 10000', 'RideTube 10000', 'RideTube 5000', 'RideTube 30']);
        assert.deepStrictEqual([u.kept().clientId, u.kept().hb], ['RideTube', 30]);
        await u.a.release();
        // a player that knows only the names the app manager has for the apps: our home's, its number, and last the
        // name of the BMW app whose code was read
        const v = await unit({ clientOk: (id) => id === 'bmw_videoapp' });
        fs.writeFileSync(path.join(v.oap, 'oap_12209', 'source', 'package.json'), JSON.stringify({ name: 'bmw_videoapp' }));
        await v.a.play(v.file);
        assert.deepStrictEqual(v.car.dyn('getAudioFocus').map((c) => c.a.clientId), ['jap_ridetube8', 'RideTube', 'oap_12300', '12300', 'bmw_videoapp']);
        assert.strictEqual(v.kept().clientId, 'bmw_videoapp');
        await v.a.release();
    });

    await t('an instance that does not answer or gives no focus: the next one (TempMedia)', async () => {
        const u = await unit({ insts: { DynamicMediaPlayerTempMedia: true }, bornMs: 80 });
        await u.a.play(u.file);
        assert.strictEqual(u.kept().key, 'dyn:DynamicMediaPlayerTempMedia', u.story());
        assert.ok(/NOT through the car's dynamic media player \(Media\): does not answer/.test(u.story()), u.story());
        await u.a.release();
        // nothing was left on the first (no focus was taken there)
        assert.deepStrictEqual(u.car.calls.filter((c) => c.inst === 'DynamicMediaPlayerMedia'), []);
    });

    await t('a player whose time is in seconds and without a length: the daemon gets milliseconds and the video\'s length; a seek goes in seconds', async () => {
        const u = await unit({ unit: 's', total: false });
        await u.a.play(u.file);
        await waitUntil(() => u.a.snd().route.unit === 's', 4000);
        const last = () => u.seen.time[u.seen.time.length - 1];
        await waitUntil(() => last() && last().elapsed >= 1000, 3000);
        assert.ok(last().elapsed % 1000 === 0 && last().total === 180000, JSON.stringify(last()));
        u.car.calls.length = 0;
        await u.a.seek(42400);
        assert.deepStrictEqual(u.car.dyn()[0].a, { token: 'TOK1', newPosition: 1, newTimeElapsed: 42 });
        // until the unit was known nothing was said to the daemon: no time in seconds taken for milliseconds
        assert.ok(u.seen.time.every((x) => x.elapsed === 0 || x.elapsed >= 1000), JSON.stringify(u.seen.time.slice(0, 4)));
        await u.a.release();
        // the unit is kept with the way that plays: the next play says the time at once, in milliseconds
        assert.strictEqual(u.kept().unit, 's');
        u.seen.time.length = 0;
        await u.a.play(u.file);
        assert.strictEqual(u.a.snd().route.unit, 's');
        await waitUntil(() => u.seen.time.length >= 1, 3000);
        await u.a.release();
    });

    await t('a player that says PLAY and no time: the service counts on, so the picture has a clock', async () => {
        const u = await unit({ timeEvents: false });
        await u.a.play(u.file);
        await waitUntil(() => u.seen.time.length >= 2, 6000);
        assert.ok(u.seen.time[1].elapsed > u.seen.time[0].elapsed && u.seen.time[0].elapsed >= 1400 && u.seen.time[0].total === 180000, JSON.stringify(u.seen.time.slice(0, 2)));
        assert.ok(/the player says no time/.test(u.story()));
        await u.a.release();
    });

    await t('a player that needs the connection first and gets it late; a token lost once: asked again, then it plays', async () => {
        let u = await unit({ needConn: true, connectMs: -1, connectOnList: true }, { audio: { dynConnectMs: 400 } });
        await u.a.play(u.file);
        assert.ok(/CONNECTION_STATE_NOT_VALID/.test(u.story()) && /connectionState CS_CONNECTED/.test(u.story()), u.story());
        await u.a.release();
        u = await unit({ needConn: true, connectMs: -1 }, { audio: { dynConnectMs: 100 } });
        await assert.rejects(u.a.play(u.file), /no way to play sound on this car has worked yet \(3 tried\)/);
        assert.ok(/is not connected to the car's audio \(connectionState CS_DISCONNECTED\)/.test(u.story()), u.story());
        assert.strictEqual(u.a.connId, null);
        // every focus taken was given back
        assert.strictEqual(u.car.dyn('getAudioFocus').length, u.car.dyn('releaseAudioFocus').length);
    });

    await t('nothing plays on the dynamic player: the reasons, each instance tried, nothing kept, nothing left behind', async () => {
        const u = await unit({ start: 'never' }, { sdk: false });
        const e = await u.a.play(u.file).then(() => null, (x) => x);
        assert.ok(e && /^no way to play sound on this car has worked yet \(3 tried\) - Settings > Diagnostics shows what the car answered$/.test(e.message), e && e.message);
        assert.strictEqual(e.tried.length, 3);
        assert.ok(/the car's dynamic media player \(Media\) took our file but never played it/.test(e.tried[0]), e.tried[0]);
        assert.strictEqual(u.kept(), undefined);
        assert.strictEqual(u.a.connId, null);
        assert.strictEqual(u.car.dyn('releaseAudioFocus').length, 3);
        // the page: the story, and what was tried is kept for the next start of the service
        const lines = u.a.snd().lines();
        assert.ok(/^No way to play sound is known for this car yet/.test(lines[0]));
        assert.ok(/^Last play: audio\.m4a \| nothing played \| \d+ lines$/.test(lines[1]), lines[1]);
        const st = JSON.parse(fs.readFileSync(path.join(u.root, 'state', 'sound.json'), 'utf8'));
        assert.strictEqual(st.tried['dyn:DynamicMediaPlayerMedia|wb|path'], 'taken, never played');
        assert.strictEqual(st.trying, null);
        // the first instance: the form it took in every place (no other form once one is taken); the next two: that
        // form in the two likeliest places
        assert.deepStrictEqual(Object.keys(st.tried).sort(), ['http', 'path', 'pub', 'puburl', 'run', 'url'].map((l) => 'dyn:DynamicMediaPlayerMedia|wb|' + l)
            .concat(['dyn:DynamicMediaPlayerTempLumMedia|wb|path', 'dyn:DynamicMediaPlayerTempLumMedia|wb|pub', 'dyn:DynamicMediaPlayerTempMedia|wb|path', 'dyn:DynamicMediaPlayerTempMedia|wb|pub']).sort());
    });

    await t('the service died in the middle of a combination: that one is not tried again by this version; another version tries all again', async () => {
        const u = await unit({}, { sdk: false });
        fs.writeFileSync(path.join(u.root, 'state', 'sound.json'), JSON.stringify({ v: 1, ver: 'T1', trying: 'dyn:DynamicMediaPlayerMedia|wb|path', tried: {}, skip: {}, silent: {} }));
        u.a.sound = null;
        await u.a.play(u.file);
        assert.strictEqual(u.kept().form, 'wb1', u.story());       // (the next form this car takes)
        assert.ok(/\[named values, id a Buffer \| where the file is\] left out: the service stopped while it tried this/.test(u.story()), u.story());
        assert.ok(u.a.snd().lines().some((l) => /^Left out, the service stopped while trying: dyn:DynamicMediaPlayerMedia\|wb\|path$/.test(l)));
        await u.a.release();
        u.opts.version = 'T2';
        const b = u.mk();
        assert.deepStrictEqual(b.snd().state.skip, {});
        assert.strictEqual(b.snd().state.kept.form, 'wb1');
    });

    await t('stopped during the search: it ends at its next step, the focus is given back', async () => {
        const u = await unit({ start: 'never' }, { sdk: false, audio: { dynStartWaitMs: 400 } });
        const p = u.a.play(u.file).then(() => 'played', (e) => e.message);
        await waitUntil(() => u.car.dyn('createPlaylist').length >= 1);
        const t0 = Date.now();
        await u.a.release();
        assert.strictEqual(await p, 'stopped');
        assert.ok(Date.now() - t0 < 2500, 'took ' + (Date.now() - t0));
        assert.strictEqual(u.car.dyn('getAudioFocus').length, u.car.dyn('releaseAudioFocus').length);
        assert.strictEqual(u.a.connId, null);
    });

    await t('out of its time, a route gives up and says so; the play goes on with the next', async () => {
        const u = await unit({ start: 'never', insts: { DynamicMediaPlayerMedia: true } }, { sdk: false, audio: { dynBudgetMs: 700 } });
        await assert.rejects(u.a.play(u.file), /no way to play sound/);
        assert.ok(/out of time: \d+ ways not tried this time/.test(u.story()), u.story());
    });

    await t('the service\'s own player: the car\'s sound devices are listened to as the car is and with our source connected - the one that takes samples only then is ours and plays, in seconds; "No sound?" goes on', async () => {
        const u = await unit({ start: 'never', insts: { DynamicMediaPlayerMedia: true } }, { sdk: false, alsa: { 'plug:smartx:OAPMedia': 'flows@am' }, audio: { direct: true } });
        await u.a.play(u.file);
        assert.strictEqual(u.kept().key, 'direct:plug:smartx:OAPMedia', u.story());
        assert.ok(/the car's sound devices named like ours: OAPMedia, Dynamic, Gone \| another program has: Entertainment \(mediaengine \(4103\)\)/.test(u.story()), u.story());
        assert.ok(/the devices as the car is: take none: OAPMedia, Dynamic \| do not open: Gone \(No such device\)/.test(u.story()), u.story());
        assert.ok(/the devices with our source connected by the audio manager: TAKE SAMPLES as time passes: OAPMedia \(1 of real time\) \| take none: Dynamic \| do not open: Gone/.test(u.story()), u.story());
        assert.ok(/OAPMedia: takes the samples as time passes/.test(u.story()) && /PLAYS through the service's own player on "OAPMedia"/.test(u.story()), u.story());
        // the device another program has open is never touched; the car's own player is not asked at all
        assert.deepStrictEqual(u.alsaLog().slice(0, 3), ['probe', 'scan OAPMedia,Dynamic,Gone', 'scan OAPMedia,Dynamic,Gone']);
        assert.ok(/^plug:smartx:OAPMedia\tplay /.test(u.alsaLog()[3]) && u.alsaLog().length === 4, u.alsaLog().join('\n'));
        assert.deepStrictEqual(u.car.dyn(), []);
        // the audio manager connected our source for it, as on iDrive 7: once
        const cc = u.car.calls.filter((c) => c.on === 'cc').map((c) => c.m);
        assert.deepStrictEqual(cc, ['connect']);
        assert.deepStrictEqual(u.car.calls.filter((c) => c.on === 'cc')[0].a, { sourceID: 1046, sinkID: 1024 });
        await waitUntil(() => u.seen.time.length >= 2 && u.seen.state.length >= 1);
        assert.strictEqual(u.seen.state[0], 'PLAYER_STATE_PLAY');
        assert.ok(u.seen.note.some((x) => /Listening to which of the car's sound devices plays/.test(x)));
        // its controls
        await u.a.button('STOP'); await u.a.seek(5000); await u.a.button('PLAY'); await u.a.replay(u.head);
        await waitUntil(() => u.alsaLog().length >= 8);
        assert.deepStrictEqual(u.alsaLog().slice(-4).map((l) => l.split('\t')[1]), ['pause', 'seek 5000', 'resume', 'file ' + JSON.stringify(u.head)]);
        // (the whole file after the first seconds is started where those are)
        await u.a.replay(u.file, 4321.7);
        await waitUntil(() => u.alsaLog().pop().split('\t')[1] === 'file ' + JSON.stringify(u.file) + ' 4321');
        // the driver hears nothing: left out, kept no more
        assert.strictEqual(u.a.snd().status().route, 'direct:plug:smartx:OAPMedia');
        assert.ok(/"OAPMedia"/.test(u.a.snd().nosound()));
        assert.strictEqual(u.kept(), null);
        await u.a.release();
        assert.strictEqual(u.car.calls.filter((c) => c.on === 'cc').pop().m, 'disconnect');
        // the next play: that device left out; the car's own player then (its focus changes no device; its playlist never
        // plays; its two other instances do not answer)
        await assert.rejects(u.a.play(u.file), /no way to play sound on this car has worked yet \(3 tried, 1 without sound\)/);
        assert.ok(/direct:OAPMedia left out: it played without sound/.test(u.story()) && /the devices with the audio focus of DynamicMediaPlayerMedia: take none: OAPMedia, Dynamic/.test(u.story()), u.story());
        // (nothing played: the connection was given back, and the focus)
        assert.deepStrictEqual(u.car.calls.filter((c) => c.on === 'cc').slice(-2).map((c) => c.m), ['connect', 'disconnect']);
        assert.deepStrictEqual(u.car.conns, []);
        assert.strictEqual(u.car.st.DynamicMediaPlayerMedia.token, null);
        // start over: everything again
        u.a.snd().reset();
        await u.a.play(u.file);
        assert.strictEqual(u.kept().key, 'direct:plug:smartx:OAPMedia');
        // the kept device is the first asked at the next play: no listening, the dynamic player's instances not at all
        await u.a.release();
        u.car.calls.length = 0;
        const before = u.alsaLog().length;
        await u.a.play(u.file);
        assert.deepStrictEqual(u.car.dyn(), []);
        assert.ok(u.alsaLog().slice(before).some((l) => /^plug:smartx:OAPMedia\tplay /.test(l)) && !u.alsaLog().slice(before).some((l) => /^scan|^probe/.test(l)), u.alsaLog().slice(before).join('\n'));
        await u.a.release();
        // the page
        const dl = u.a.snd().deviceLines().join('\n');
        assert.ok(/^Listened as the car is: take none: OAPMedia, Dynamic \| do not open: Gone \(No such device\)\nListened with our source connected by the audio manager: TAKE SAMPLES as time passes: OAPMedia/.test(dl), dl);
        assert.ok(/The audio router's devices named like ours: OAPMedia \| Dynamic \| Entertainment \[open in mediaengine \(4103\)\] \| Gone \(a name of the audio manager's\)/.test(dl), dl);
        assert.ok(/Devices a program has open now \(\/run\/smartx\): Entertainment: mediaengine \(4103\)\n/.test(dl) && /All of the router's buffers \(\/dev\/shm; _p plays, _c records\): OAPMedia_p, Dynamic_p, Entertainment_p, Mic_c/.test(dl), dl);
    });

    await t('the dynamic player\'s audio focus with the service\'s own player: the focus makes the car connect that player\'s source, its device then takes samples and ours go there - no playlist, no file the car must read', async () => {
        const u = await unit({ start: 'never', hbOk: (hb) => hb === 10 }, { sdk: false, alsa: { 'plug:smartx:Dynamic': 'flows@focus:DynamicMediaPlayerTempMedia', 'plug:smartx:OAPMedia': 'stalls' },
            audio: { direct: true, dynBudgetMs: 700, dynNextMs: 400 } });
        await u.a.play(u.file);
        // the first instance's focus changed no device and its playlist never played; the second's made "Dynamic" take samples
        assert.strictEqual(u.kept().key, 'focus:DynamicMediaPlayerTempMedia|plug:smartx:Dynamic', u.story());
        assert.strictEqual(u.kept().clientId + '|' + u.kept().hb, 'jap_ridetube8|10');
        assert.ok(/the devices with the audio focus of DynamicMediaPlayerMedia: take none: OAPMedia, Dynamic/.test(u.story()), u.story());
        assert.ok(/the devices with the audio focus of DynamicMediaPlayerTempMedia: TAKE SAMPLES as time passes: Dynamic \(1 of real time\) \| take none: OAPMedia/.test(u.story()), u.story());
        assert.ok(/PLAYS through the service's own player on "Dynamic" with the audio focus of DynamicMediaPlayerTempMedia/.test(u.story()), u.story());
        // on that instance nothing but the focus was asked, and it is kept alive while our player plays
        const asked = u.car.dyn().filter((c) => c.inst === 'DynamicMediaPlayerTempMedia').map((c) => c.m);
        assert.ok(asked.length >= 1 && asked.every((m) => m === 'getAudioFocus'), asked.join());
        const beats = u.car.st.DynamicMediaPlayerTempMedia.beats;
        await waitUntil(() => u.car.st.DynamicMediaPlayerTempMedia.beats >= beats + 2);
        // the first instance was given back; our source's connection by the audio manager too
        assert.strictEqual(u.car.st.DynamicMediaPlayerMedia.token, null);
        assert.deepStrictEqual(u.car.calls.filter((c) => c.on === 'cc').map((c) => c.m), ['connect', 'disconnect']);
        await waitUntil(() => u.seen.time.length >= 2 && u.seen.state.length >= 1);
        assert.strictEqual(u.seen.state[0], 'PLAYER_STATE_PLAY');
        assert.strictEqual(u.a.snd().status().route, 'focus:DynamicMediaPlayerTempMedia|plug:smartx:Dynamic');
        // its controls are our player's
        await u.a.button('STOP'); await u.a.seek(7000); await u.a.button('PLAY');
        await waitUntil(() => u.alsaLog().slice(-3).map((l) => l.split('\t')[1]).join() === 'pause,seek 7000,resume');
        // the end of the play: our player gone, the focus given back
        await u.a.release();
        assert.strictEqual(u.car.st.DynamicMediaPlayerTempMedia.token, null);
        assert.strictEqual(u.car.dyn().pop().m, 'releaseAudioFocus');
        await waitUntil(() => u.alsaLog().pop().split('\t')[1] === 'quit');
        // the next play: the kept way at once - that focus under the name and timer it took, then our player; no listening
        u.car.calls.length = 0;
        const before = u.alsaLog().length;
        await u.a.play(u.file);
        assert.deepStrictEqual(u.car.dyn().map((c) => c.inst + ' ' + c.m + ' ' + c.a.timeOutHeartBeatTimer), ['DynamicMediaPlayerTempMedia getAudioFocus 10']);
        assert.ok(u.alsaLog().slice(before).some((l) => /^plug:smartx:Dynamic\tplay /.test(l)) && !u.alsaLog().slice(before).some((l) => /^scan|^probe/.test(l)));
        assert.strictEqual(u.kept().plays, 2);
        // the driver hears nothing: that way is left out, the search goes on with the playlists and ends
        assert.ok(/"Dynamic" with the audio focus of DynamicMediaPlayerTempMedia/.test(u.a.snd().nosound()));
        await u.a.release();
        await assert.rejects(u.a.play(u.file), /no way to play sound on this car has worked yet \(3 tried, 1 without sound\)/);
        assert.ok(/focus:DynamicMediaPlayerTempMedia\|Dynamic left out: it played without sound/.test(u.story()), u.story());
        ['DynamicMediaPlayerMedia', 'DynamicMediaPlayerTempMedia', 'DynamicMediaPlayerTempLumMedia'].forEach((i) => assert.strictEqual(u.car.st[i].token, null, i));
        const l0 = u.a.snd().lines()[1];
        assert.ok(/^Played without sound \(left out; .*\): focus:DynamicMediaPlayerTempMedia\|plug:smartx:Dynamic$/.test(l0), l0);
    });

    await t('no device named like ours plays: the router\'s other free devices are listened to as well - the one that takes samples plays; one that takes them whatever is connected is not tried again once the driver heard nothing', async () => {
        const u = await unit({ start: 'never', insts: { DynamicMediaPlayerMedia: true } }, { sdk: false, alsa: { 'plug:smartx:Out3_CF_48_STEREO': 'flows@am', 'plug:smartx:Zone1': 'flows' },
            alsaEnv: { FAKE_ALSA_OTHERS: 'Zone1,Out3_CF_48_STEREO' }, audio: { direct: true } });
        await u.a.play(u.file);
        assert.ok(/the devices with our source connected by the audio manager: take none: OAPMedia, Dynamic/.test(u.story()) &&
            /the devices \(the router's other ones\) with our source connected: TAKE SAMPLES as time passes: Zone1 \(1 of real time\), Out3_CF_48_STEREO \(1 of real time\)/.test(u.story()), u.story());
        // (the other devices are not touched before our source is connected: no listening "as the car is" for them)
        assert.deepStrictEqual(u.alsaLog().filter((l) => /^scan/.test(l)), ['scan OAPMedia,Dynamic,Gone', 'scan OAPMedia,Dynamic,Gone', 'scan Zone1,Out3_CF_48_STEREO']);
        assert.strictEqual(u.kept().key, 'direct:plug:smartx:Zone1');
        u.a.snd().nosound();
        await u.a.release();
        await u.a.play(u.file);
        assert.strictEqual(u.kept().key, 'direct:plug:smartx:Out3_CF_48_STEREO', u.story());
        assert.ok(/direct:Zone1 left out: it played without sound/.test(u.story()));
        u.a.snd().nosound();
        await u.a.release();
        // nothing left with our source; with the dynamic player's focus "Zone1" takes samples again - as it does whatever
        // is connected: not that player's device, not tried
        await assert.rejects(u.a.play(u.file), /no way to play sound on this car has worked yet \(3 tried, 2 without sound\)/);
        assert.ok(/focus:DynamicMediaPlayerMedia\|Zone1 left out: that device takes samples whatever is connected, and was not heard/.test(u.story()), u.story());
        assert.deepStrictEqual(u.car.conns, []);
        assert.strictEqual(u.car.st.DynamicMediaPlayerMedia.token, null);
    });

    await t('an audio manager that refuses our source, a scan that cannot be made: said, and the search goes on to the car\'s own player', async () => {
        const u = await unit({ start: 'auto', amError: 'E_NON_EXISTENT' }, { sdk: false, alsa: {}, alsaEnv: { FAKE_ALSA_SCAN_FAILS: '1' }, audio: { direct: true } });
        await u.a.play(u.file);
        assert.strictEqual(u.kept().key, 'dyn:DynamicMediaPlayerMedia', u.story());
        assert.ok(/the devices as the car is: not scanned: libasound could not be loaded/.test(u.story()) && /our source was not connected: was refused by the audio manager \(E_NON_EXISTENT\)/.test(u.story()), u.story());
        assert.deepStrictEqual(u.car.conns || [], []);
        await u.a.release();
    });

    await t('the car\'s Python cannot run our player (a module its build lacks): its own last word is in the story, and the search goes on', async () => {
        const broken = path.join(tmp, 'broken.js');
        fs.writeFileSync(broken, 'process.stderr.write("Traceback (most recent call last):\\n  File x\\nModuleNotFoundError: No module named \'_ctypes\'\\n"); process.exit(1);');
        const u = await unit({ start: 'auto' }, { sdk: false, audio: { direct: true, alsaCmd: [process.execPath, broken] } });
        await u.a.play(u.file);
        assert.strictEqual(u.kept().key, 'dyn:DynamicMediaPlayerMedia');
        assert.ok(/the car's sound devices named like ours: not read: it ended \(1\) without an answer: ModuleNotFoundError: No module named '_ctypes'/.test(u.story()), u.story());
        await u.a.release();
    });

    await t('stopped while the devices are listened to: nothing is left connected or focused', async () => {
        const u = await unit({ start: 'never' }, { sdk: false, alsa: {}, audio: { direct: true } });
        const p = u.a.play(u.file).then(() => 'played', (e) => e.message);
        await waitUntil(() => u.car.dyn('getAudioFocus').length >= 1);
        await u.a.release();
        assert.ok(/stopped/.test(await p));
        assert.deepStrictEqual(u.car.conns, []);
        Object.keys(u.car.st).forEach((i) => assert.strictEqual(u.car.st[i].token, null, i));
    });

    await t('a head unit with nothing to try (no dynamic player described, no player of ours): iDrive 7\'s way and its error', async () => {
        const u = await unit({}, { dmp: false, audio: { direct: false } });
        await assert.rejects(u.a.play(u.file), /does not offer the media player "OapGenericMedia"/);
        assert.strictEqual(u.a.sound.runs.length, 0);
        await u.a.release();
    });

    await t('the Diagnostics lines: what is kept, the story, BMW\'s code as read', async () => {
        const u = await unit({ start: 'pos' });
        await u.a.play(u.file);
        const s = u.a.snd(), lines = s.lines(), code = s.codeLines().join('\n');
        assert.ok(/^Kept from the last play that worked: dyn:DynamicMediaPlayerMedia \| item sdk \| file path \| start pos \| focus jap_ridetube8, timer 5 \| 1 plays$/.test(lines[0]), lines[0]);
        assert.ok(/^Last play: audio\.m4a \| plays through the car's dynamic media player \(Media\) \| \d+ lines$/.test(lines[1]), lines[1]);
        assert.ok(lines.some((l) => /^\+\d+\.\ds createPlaylist \[as BMW's own code writes it \| where the file is\] \[ \{ pos: 1, id: <Buffer 00 00 00 0\d>, metadata: .* -> OK, list 1\/1, it names our file \| started position\(1, 0\): PLAYS \| the player said: .*currentItemMetadata \[ \{ key: 'FILE_NAME', value: \{ stringValue: '<our file>' \} \} \]$/.test(l)), lines.join('\n'));
        assert.ok(/^BMW's own player code: read from .*oap_12209\/source\/javascript\/app\.js \(class MediaPlayerImpl, module 3 of 7\)\nThe item as it writes it: \[\{pos: 1, id: <Buffer 0000000\d>, metadata: \[\{key: "FILE_NAME", value: \{stringValue: "\/rt-sample\/audio-RTSAMPLE\.m4a"\}\}/.test(code), code);
        assert.ok(/Its calls of the player: .*\[connect\(\)\] getAudioFocus\(\{clientId: <this\.app\.getAppId\(\)>, clientName: <this\.app\.name>, timeOutHeartBeatTimer: 5\}\)/.test(code), code);
        assert.ok(/Its timers: .*interval 2000 ms/.test(code) && /\[playlistConverter\] playlistConverter\(list, start\)/.test(code) && /Its states against a simulated car: constructed = Disconnected/.test(code), code);
        await u.a.release();
    });

    await t('through the daemon: a play prepares with notes, plays with the way found in its state; pause and resume; "No sound?" goes on with the next way from where it was; the page; start over', async () => {
        const u = await unit({ start: 'pos' });
        await u.a.release();
        const net = require('net');
        const { Daemon } = require('../ytd.js');
        const dir = path.join(u.root, 'cache', 'vid12345678');
        process.env.FAKE_YTDEC_LOG = path.join(u.root, 'ytdec.calls');
        const sock = path.join(u.root, 'ctl.sock'), lg = [];
        const d = new Daemon(Object.assign({}, u.opts, { mainapps: [], policyDirs: [], searchRoots: [], catalogs: [], generators: [], procRoot: path.join(u.root, 'proc'), unitDirs: [], ytdec: path.join(__dirname, 'fake_ytdec.js'),
            cacheDir: path.join(u.root, 'cache'), logDir: u.root, sock: sock, spare: false, resume: true, fetchRetryMs: [], noHwCheck: true, accountFile: path.join(u.root, 'acct.json'), ytRequest: async () => ({ status: 404, body: '' }),
            settleS: 0, audioWaitMs: 2000, log: (m) => lg.push(m) }));
        await d.start();
        // (a fetched video, put there after the start: the start - and a stop - clear the cache of what was played)
        const fetched = () => {
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ id: 'vid12345678', title: 'T', channel: 'C', duration_s: 180 }));
            ['index.bin', 'video.h264'].forEach((f) => fs.writeFileSync(path.join(dir, f), 'x'));
            fs.writeFileSync(u.file, 'x'.repeat(1234));
        };
        fetched();
        const c = await new Promise((resolve) => {
            const k = net.connect(sock, () => resolve(k));
            k.evs = [];
            let buf = '';
            k.on('data', (x) => { buf += x; let i; while ((i = buf.indexOf('\n')) >= 0) { k.evs.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
            k.send = (o) => k.write(JSON.stringify(o) + '\n');
        });
        const got = (pred, ms) => waitUntil(() => c.evs.some(pred), ms || 4000).then(() => c.evs.filter(pred).pop());
        await waitUntil(() => d.audio.diag.ready, 3000);
        c.send({ cmd: 'play', id: 'vid12345678', rect: '100x100' });
        const prep = await got((e) => e.ev === 'state' && e.state === 'preparing');
        assert.strictEqual(prep.pct, 99);
        const playing = await got((e) => e.ev === 'state' && e.state === 'playing');
        assert.ok(c.evs.some((e) => e.ev === 'note' && /Finding how this car plays sound: way 1/.test(e.msg)), JSON.stringify(c.evs.filter((e) => e.ev === 'note')));
        assert.deepStrictEqual(playing.snd, { route: 'dyn:DynamicMediaPlayerMedia', name: 'the car\'s dynamic media player (Media)', kept: 'dyn:DynamicMediaPlayerMedia', silent: 0 });
        await got((e) => e.ev === 'time' && e.elapsed > 100 && e.total === 180000);
        // pause: the player is stopped; resume: the focus again, the file again, then the place it was at
        u.car.calls.length = 0;
        c.send({ cmd: 'pause' });
        await got((e) => e.ev === 'state' && e.state === 'paused');
        await waitUntil(() => u.car.dyn('sendButtonEventDirect').some((x) => x.a.button === 'STOP'));
        c.evs.length = 0;
        c.send({ cmd: 'resume' });
        await got((e) => e.ev === 'state' && e.state === 'playing');
        await waitUntil(() => u.car.dyn('setCurrentItemPositionAndTime').length >= 2, 6000);
        assert.deepStrictEqual(u.car.dyn().map((x) => x.m).filter((m) => m !== 'sendButtonEventDirect'), ['createPlaylist', 'releaseAudioFocus', 'getAudioFocus', 'createPlaylist', 'setCurrentItemPositionAndTime', 'setCurrentItemPositionAndTime']);
        // the page: the sound found by trying comes first
        c.evs.length = 0;
        c.send({ cmd: 'diag' });
        const diag = await got((e) => e.ev === 'diag');
        assert.ok(/^RideTube service /.test(diag.lines[0]) && diag.lines[1] === '# Sound on this car (found by trying)' && /^Kept from the last play that worked: dyn:DynamicMediaPlayerMedia \| item sdk/.test(diag.lines[2]), diag.lines.slice(0, 4).join('\n'));
        assert.ok(diag.lines.indexOf('# BMW\'s own player code, read on this car') > diag.lines.indexOf('# The dynamic media player'), diag.lines.filter((l) => l[0] === '#').join(' | '));
        assert.ok(!diag.lines.some((l) => l === '# How the installed apps play media'));
        // the driver hears nothing: the same video, from where it was, through the next way
        await sleep(300);
        c.evs.length = 0; u.car.calls.length = 0;
        c.send({ cmd: 'nosound' });
        const again = await got((e) => e.ev === 'state' && e.state === 'playing', 8000);
        assert.deepStrictEqual([again.snd.route, again.snd.silent], ['dyn:DynamicMediaPlayerTempMedia', 1]);
        assert.ok(lg.some((l) => /no sound through the car's dynamic media player \(Media\): the next way/.test(l)));
        assert.deepStrictEqual(u.car.dyn('getAudioFocus').map((x) => x.inst), ['DynamicMediaPlayerTempMedia']);
        // start over: the first way is tried again at the next play
        c.send({ cmd: 'stop' });
        await got((e) => e.ev === 'state' && e.state === 'idle');
        c.send({ cmd: 'soundreset' });
        await sleep(100);
        fetched();
        c.evs.length = 0; u.car.calls.length = 0;
        c.send({ cmd: 'play', id: 'vid12345678', rect: '100x100' });
        const third = await got((e) => e.ev === 'state' && e.state === 'playing', 8000);
        assert.strictEqual(third.snd.route, 'dyn:DynamicMediaPlayerMedia');
        // nothing plays: "No sound?" has nothing to change
        c.send({ cmd: 'stop' });
        await got((e) => e.ev === 'state' && e.state === 'idle');
        c.evs.length = 0;
        c.send({ cmd: 'nosound' });
        assert.ok(/nothing plays through a way that can be changed/.test((await got((e) => e.ev === 'error')).msg));
        c.destroy();
        await d.close();
        assert.strictEqual(u.car.dyn('getAudioFocus').length, u.car.dyn('releaseAudioFocus').length);
        u.car.stop();
    });

    await t('through the daemon, the service\'s own player: pause and resume go on in place (no new connection), also after a seek while paused; when the car gave its sound away meanwhile the way is asked for anew; played unheard, the page shows how players talk to the audio manager', async () => {
        const u = await unit({ start: 'never', insts: { DynamicMediaPlayerMedia: true } }, { sdk: false, alsa: { 'plug:smartx:OAPMedia': 'flows@am' }, audio: { direct: true, dynBudgetMs: 1200 } });
        await u.a.release();
        const net = require('net');
        const { Daemon } = require('../ytd.js');
        const dir = path.join(u.root, 'cache', 'vid12345678');
        process.env.FAKE_YTDEC_LOG = path.join(u.root, 'ytdec.calls');
        // the unit's interface catalog and the app manager's generator (a bundle shaped like MainApp's)
        const cat = path.join(u.root, 'someip-interfaces.json'), bundle = path.join(u.root, 'AppManagement.js');
        fs.writeFileSync(cat, JSON.stringify({ interfaces: { 'de.bmw.infotainment.am.amsourceinterface.AmPlayerState': {}, 'de.bmw.infotainment.am.amsourceinterface.AmSourceControl': {}, 'x.y.Other': {} } }));
        fs.writeFileSync(bundle, '(function(){function r(e,n,t){function o(i,f){if(!n[i]){if(!e[i]){throw new Error("no module "+i)}var p=n[i]={exports:{}};e[i][0].call(p.exports,function(r){return o(e[i][1][r]||r)},p,p.exports,r,e,n,t)}return n[i].exports}for(var u=0;u<t.length;u++)o(t[u]);return o}return r})()(' +
            '{1:[function(require,module,exports){global.__entryRan2=true;},{}],7:[function(require,module,exports){module.exports={generate:function(db,m){var o={};Object.keys(m.proxies).forEach(function(id){o[id]={name:id.split(".").pop(),serviceId:45100,instances:{"1":1},' +
            'methods:{setPlayerState:{schema:{e:[{n:"sourceID",t:"UInt16"},{n:"state",t:"Enum",e:{PLAYING:1,STOPPED:0}}]}}}};});return o;}};},{"someip-interfaces-generator/IFConfigGenerator":7}]},{},[1]);\n');
        const sock = path.join(u.root, 'ctl.sock'), lg = [];
        const d = new Daemon(Object.assign({}, u.opts, { mainapps: [], policyDirs: [], searchRoots: [], catalogs: [cat], generators: [bundle], procRoot: path.join(u.root, 'proc'), unitDirs: [], ytdec: path.join(__dirname, 'fake_ytdec.js'),
            cacheDir: path.join(u.root, 'cache'), logDir: u.root, sock: sock, spare: false, resume: true, fetchRetryMs: [], noHwCheck: true, accountFile: path.join(u.root, 'acct.json'), ytRequest: async () => ({ status: 404, body: '' }),
            settleS: 0, audioWaitMs: 2000, log: (m) => lg.push(m) }));
        await d.start();
        const fetched = () => {
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ id: 'vid12345678', title: 'T', channel: 'C', duration_s: 180 }));
            ['index.bin', 'video.h264'].forEach((f) => fs.writeFileSync(path.join(dir, f), 'x'));
            fs.writeFileSync(u.file, 'x'.repeat(1234));
        };
        fetched();
        const c = await new Promise((resolve) => {
            const k = net.connect(sock, () => resolve(k));
            k.evs = [];
            let buf = '';
            k.on('data', (x) => { buf += x; let i; while ((i = buf.indexOf('\n')) >= 0) { k.evs.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
            k.send = (o) => k.write(JSON.stringify(o) + '\n');
        });
        const got = (pred, ms) => waitUntil(() => c.evs.some(pred), ms || 5000).then(() => c.evs.filter(pred).pop());
        const cc = () => u.car.calls.filter((x) => x.on === 'cc').map((x) => x.m);
        const told = () => u.alsaLog().filter((l) => /^plug:smartx:OAPMedia\t/.test(l)).map((l) => l.split('\t')[1].split(' ')[0]);
        await waitUntil(() => d.audio.diag.ready, 3000);
        c.send({ cmd: 'play', id: 'vid12345678', rect: '100x100' });
        const playing = await got((e) => e.ev === 'state' && e.state === 'playing', 8000);
        assert.deepStrictEqual(playing.snd, { route: 'direct:plug:smartx:OAPMedia', name: 'the service\'s own player on "OAPMedia"', kept: 'direct:plug:smartx:OAPMedia', silent: 0 });
        assert.ok(c.evs.some((e) => e.ev === 'note' && /Listening to which of the car's sound devices plays/.test(e.msg)));
        await got((e) => e.ev === 'time' && e.elapsed > 100 && e.total === 180000);
        assert.deepStrictEqual(cc(), ['connect']);
        // pause, a seek while paused, resume: the player keeps its place and goes on there - the car is not asked again
        c.send({ cmd: 'pause' });
        await got((e) => e.ev === 'state' && e.state === 'paused');
        await waitUntil(() => told().pop() === 'pause');
        c.send({ cmd: 'seek', ms: 50000 });
        await sleep(60);
        c.evs.length = 0;
        c.send({ cmd: 'resume' });
        await got((e) => e.ev === 'state' && e.state === 'playing');
        await got((e) => e.ev === 'time' && e.elapsed >= 50000 && e.elapsed < 53000);
        assert.deepStrictEqual(told().slice(-3), ['pause', 'seek', 'resume']);
        assert.deepStrictEqual(cc(), ['connect'], 'a resume in place makes no new connection');
        assert.strictEqual(told().filter((x) => x === 'play').length, 1);
        // the car gives its sound to another source while paused: at the resume the device takes nothing - the way is asked for anew
        c.send({ cmd: 'pause' });
        await got((e) => e.ev === 'state' && e.state === 'paused');
        await waitUntil(() => told().pop() === 'pause');
        u.car.conns = [];
        u.car.tell();
        c.evs.length = 0;
        c.send({ cmd: 'resume' });
        await waitUntil(() => lg.some((l) => /the sound did not go on in place: its way is started anew/.test(l)), 6000);
        await waitUntil(() => told().filter((x) => x === 'play').length === 2, 6000);
        await got((e) => e.ev === 'time' && e.elapsed >= 50000, 8000);
        assert.deepStrictEqual(cc().filter((m) => m === 'connect').length, 2);
        // played and not heard: the next way (none plays on this car), and the page then has the audio manager's interfaces for players
        c.evs.length = 0;
        c.send({ cmd: 'nosound' });
        await got((e) => e.ev === 'error' || (e.ev === 'state' && e.state === 'error'), 20000);
        c.evs.length = 0;
        c.send({ cmd: 'diag' });
        const diag = await got((e) => e.ev === 'diag');
        const at = diag.lines.indexOf('# Played unheard: the audio manager\'s interfaces for players');
        assert.ok(at > diag.lines.indexOf('# The car\'s sound devices') && diag.lines.indexOf('# The car\'s sound devices') > diag.lines.indexOf('# Sound on this car (found by trying)'), diag.lines.filter((l) => l[0] === '#').join(' | '));
        assert.strictEqual(diag.lines[at + 1], 'de.bmw.infotainment.am.amsourceinterface.AmPlayerState | service 0xb02c | instances: 1');
        assert.strictEqual(diag.lines[at + 2], '  methods (1): setPlayerState(sourceID:UInt16, state:E1)');
        assert.strictEqual(diag.lines[at + 3], '  E1 = {PLAYING:1, STOPPED:0}');
        assert.ok(/^de\.bmw\.infotainment\.am\.amsourceinterface\.AmSourceControl \| service/.test(diag.lines[at + 4]) && !global.__entryRan2);
        assert.ok(diag.lines.some((l) => /^Played without sound \(left out; .*\): direct:plug:smartx:OAPMedia$/.test(l)));
        c.destroy();
        await d.close();
        assert.deepStrictEqual(u.car.conns, []);
        u.car.stop();
    });

    console.log(results.join('\n'));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* left */ }
    process.exit(results.filter((r) => r.indexOf('FAIL') === 0).length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
