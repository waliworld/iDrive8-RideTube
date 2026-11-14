'use strict';
// Host test for sdkread.js: bundles shaped like an installed app's (test/fake_sdk_bundle.js), read in the child.
//   node test/test_sdkread.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sdk = require('../sdkread.js');
const { bundle } = require('./fake_sdk_bundle.js');

const results = [];
async function t(name, fn) {
    try { await fn(); results.push('ok   ' + name); } catch (e) { results.push('FAIL ' + name + '\n     ' + String(e && e.stack || e).split('\n').slice(0, 6).join('\n     ')); }
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdkread-'));
const S = sdk.SAMPLE;

async function main() {
    await t('the item as the SDK writes it: its union and its byte buffer, from the class\'s own converter', async () => {
        const r = await sdk.read({ text: bundle({}) });
        assert.strictEqual(r.ok, true, JSON.stringify(r).slice(0, 600));
        assert.strictEqual(r.cls, 'MediaPlayerImpl');
        assert.strictEqual(r.module, '3');
        assert.strictEqual(r.modules, 7);
        assert.deepStrictEqual(r.item[0].metadata, [{ key: 'FILE_NAME', value: { stringValue: S.file } }, { key: 'FILE_SIZE', value: { numeric: S.size } }]);
        assert.strictEqual(r.item[0].pos, 1);
        assert.strictEqual(r.item[0].id.$, 'buffer');
        assert.strictEqual(sdk.hasStub(r.item), false);
        const d = sdk.decode(r.item);
        assert.ok(Buffer.isBuffer(d[0].id) && d[0].id.length === 4, 'the id is a Buffer again');
        assert.ok(/<Buffer 0000000\d>/.test(sdk.show(r.item)), sdk.show(r.item));
        // the other conversions are there too (no metadata; a video)
        assert.strictEqual(r.convert.length, 3);
        assert.deepStrictEqual(r.convert[1].out[0].metadata, [{ key: 'FILE_NAME', value: { stringValue: S.file } }]);
    });
    await t('the calls BMW\'s code makes: createPlaylist and playFile on the proxy, with their arguments', async () => {
        const r = await sdk.read({ text: bundle({}) });
        const of = (m, where) => r.calls.filter((c) => c.method === m && (!where || where.test(c.in)));
        const cp = of('createPlaylist', /^createPlaylist\(/)[0];
        assert.ok(cp, JSON.stringify(r.calls).slice(0, 800));
        assert.strictEqual(cp.args.token, 'RTTOKEN');
        assert.deepStrictEqual(cp.args.newPlaylist[0].metadata[0], { key: 'FILE_NAME', value: { stringValue: S.file } });
        // playFile: the playlist, then the position (what starts it)
        const pf = r.calls.filter((c) => /^playFile\(/.test(c.in)).map((c) => c.method);
        assert.deepStrictEqual(pf, ['createPlaylist', 'setCurrentItemPositionAndTime'], pf.join());
        assert.deepStrictEqual(of('setCurrentItemPositionAndTime', /^playFile\(/)[0].args, { token: 'RTTOKEN', newPosition: 1, newTimeElapsed: 0 });
    });
    await t('the focus: what getAudioFocus is given, and the heartbeat\'s cadence from the interval it sets', async () => {
        const r = await sdk.read({ text: bundle({}) });
        const f = r.calls.filter((c) => c.method === 'getAudioFocus' && c.in === 'connect()')[0];
        assert.ok(f, JSON.stringify(r.calls).slice(0, 800));
        assert.strictEqual(f.args.timeOutHeartBeatTimer, 5);
        assert.strictEqual(f.args.clientId.$, 'stub');       // (the app's own id: not the class's to know)
        assert.ok(/this\.app\.getAppId/.test(f.args.clientId.name), f.args.clientId.name);
        const iv = r.timers.filter((x) => x.kind === 'interval');
        assert.ok(iv.some((x) => x.ms === 2000 && /heartBeat/.test(x.fn)), JSON.stringify(r.timers));
        // a long timeout (a watchdog) is recorded and never run
        assert.ok(r.timers.some((x) => x.kind === 'timeout' && x.ms === 30000));
    });
    await t('the class as its constructor makes it, against a simulated car: its states and its calls in order', async () => {
        const r = await sdk.read({ text: bundle({}) });
        assert.deepStrictEqual(r.states.map((s) => s[1]), ['Disconnected', 'Connecting', 'Connected', 'Starting', 'Playing'], JSON.stringify(r.states));
        const seq = r.calls.filter((c) => /^constructed: /.test(c.in)).map((c) => c.method);
        assert.deepStrictEqual(seq, ['getAudioFocus', 'createPlaylist', 'setCurrentItemPositionAndTime'], seq.join());
        assert.ok(r.subs.some((s) => s.field === 'connectionState') && r.subs.some((s) => s.field === 'playerState'));
    });
    await t('the methods\' text for the Diagnostics page; the app itself never runs', async () => {
        const r = await sdk.read({ text: bundle({}) });
        assert.ok(/playlistConverter\(list, start\)/.test(r.methods.playlistConverter), r.methods.playlistConverter);
        assert.ok(/counter \+= 1/.test(r.methods.generateItemId));
        assert.ok(/getAudioFocus/.test(r.methods.connect));
        assert.ok(/setInterval/.test(r.methods.startHeartbeat));
        assert.ok(r.methodNames.indexOf('playFile') >= 0);
        assert.ok(!fs.existsSync('/tmp/rt-test-must-not-exist'), 'the bundle\'s entry module was run');
        assert.ok(r.externals.indexOf('someip') >= 0 && r.externals.indexOf('events') >= 0);
    });
    await t('other ways of writing it are reported as they are: an array id, a typed union, plain values', async () => {
        let r = await sdk.read({ text: bundle({ idAs: 'array', union: 'typed' }) });
        assert.strictEqual(r.ok, true);
        assert.deepStrictEqual(r.item[0].id.slice(0, 3), [0, 0, 0]);
        assert.deepStrictEqual(r.item[0].metadata[1], { key: 'FILE_SIZE', value: { type: 'numeric', value: S.size } });
        r = await sdk.read({ text: bundle({ idAs: 'uint8', union: 'plain' }) });
        assert.strictEqual(r.item[0].id.$, 'Uint8Array');
        assert.ok(sdk.decode(r.item)[0].id instanceof Uint8Array);
        assert.deepStrictEqual(r.item[0].metadata[0], { key: 'FILE_NAME', value: S.file });
        assert.strictEqual(sdk.hasStub(r.item), false);
    });
    await t('a minified prelude, a module that fails to load, a proxy that comes later: still read', async () => {
        const r = await sdk.read({ text: bundle({ minified: true, brokenLogging: true, asyncProxy: true }) });
        assert.strictEqual(r.ok, true, JSON.stringify(r).slice(0, 600));
        assert.ok(/no DLT daemon/.test(r.failed['5']), JSON.stringify(r.failed));
        assert.deepStrictEqual(r.item[0].metadata[0], { key: 'FILE_NAME', value: { stringValue: S.file } });
        assert.ok(r.calls.some((c) => c.method === 'createPlaylist'));
    });
    await t('the player\'s module does not load with the bundle\'s modules (its logger needs the car): its class is loaded alone, and still converts', async () => {
        const r = await sdk.read({ text: bundle({ loggerThrows: true }) });
        assert.strictEqual(r.ok, true, JSON.stringify(r).slice(0, 600));
        assert.strictEqual(r.alone, true);
        assert.ok(r.notes.some((n) => /the class was loaded alone \(module 3 did not load with the bundle's modules: the logger needs the car\)/.test(n)), r.notes.join(' | '));
        assert.deepStrictEqual(r.item[0].metadata, [{ key: 'FILE_NAME', value: { stringValue: S.file } }, { key: 'FILE_SIZE', value: { numeric: S.size } }]);
        assert.strictEqual(sdk.hasStub(r.item), false);
        assert.ok(r.calls.some((c) => c.method === 'getAudioFocus' && c.args.timeOutHeartBeatTimer === 5));
    });
    await t('a file the reader cannot take apart: the text around what matters is still given, nothing run', async () => {
        const text = 'var app=function(){/* not a bundle */};' + 'x'.repeat(3000) + 'playlistConverter(e,t){return e.map((e,i)=>({pos:t+i,id:e.id}))}' + 'y'.repeat(600) + 'this.p.getAudioFocus({clientId:this.id,timeOutHeartBeatTimer:5})';
        const r = await sdk.read({ text: text });
        assert.strictEqual(r.ok, false);
        assert.ok(r.near.some((x) => x.what === 'playlistConverter(' && /playlistConverter\(e,t\)\{return e\.map/.test(x.text)), JSON.stringify(r.near).slice(0, 300));
        assert.ok(r.near.some((x) => x.what === 'getAudioFocus(' && /timeOutHeartBeatTimer:5/.test(x.text)));
    });
    await t('no player class, no bundle, a child that cannot start: said, never thrown', async () => {
        let r = await sdk.read({ text: bundle({ noClass: true }) });
        assert.strictEqual(r.ok, false);
        assert.ok(/playlistConverter/.test(r.error), r.error);
        r = await sdk.read({ text: 'var x = 1;' });
        assert.strictEqual(r.ok, false);
        assert.ok(/no browserify bundle/.test(r.error), r.error);
        r = await sdk.read({ text: bundle({}), node: '/nonexistent/node' });
        assert.strictEqual(r.ok, false);
        assert.ok(/could not be started/.test(r.error), r.error);
    });
    await t('the bundle is found among the installed apps: the preferred home first, ours and the runner skipped', async () => {
        const root = path.join(tmp, 'oap');
        const mk = (home, files) => {
            const d = path.join(root, home, 'source', 'javascript');
            fs.mkdirSync(d, { recursive: true });
            Object.keys(files).forEach((n) => fs.writeFileSync(path.join(d, n), files[n]));
        };
        mk('oap_12201', { 'app.js': 'x'.repeat(5000) });
        mk('oap_12205', { 'app.js': bundle({ idAs: 'array' }), 'runner.js': bundle({}) });
        mk('oap_12209', { 'app.js': bundle({}) });
        mk('oap_12300', { 'jap_ridetube8.js': bundle({}) });
        let f = await sdk.findBundle({ oapRoot: root, gapMs: 0 });
        assert.ok(/oap_12205\/source\/javascript\/app\.js$/.test(f.file), f.file);
        f = await sdk.findBundle({ oapRoot: root, prefer: ['oap_12209'], gapMs: 0 });
        assert.ok(/oap_12209/.test(f.file), f.file);
        const r = await sdk.read({ oapRoot: root, prefer: ['oap_12209'], gapMs: 0 });
        assert.strictEqual(r.ok, true);
        assert.ok(/oap_12209/.test(r.file) && /^\d+:\d+$/.test(r.stamp), r.file + ' ' + r.stamp);
        assert.strictEqual(await sdk.findBundle({ oapRoot: path.join(tmp, 'none') }), null);
        const none = await sdk.read({ oapRoot: path.join(tmp, 'none') });
        assert.ok(!none.ok && /no installed app/.test(none.error));
    });
    await t('a class in the manner of iDrive 8\'s apps: its statics, the ids its own generateItemId gives per instance and app number, what it makes of the app and asks once made as an app makes it', async () => {
        const logIds = [{ key: 'ours', n: 0xAB8 }, { key: 'none', n: null }];
        const r = await sdk.read({ text: bundle({ id8: true }), logIds: () => logIds });
        assert.ok(r.ok, r.error);
        assert.deepStrictEqual(r.statics.sourceToItemTypeMap, { Entertainment: 1, EntertainmentTemp: 2, EntertainmentTempLum: 3, Interrupt: 5 });
        assert.deepStrictEqual(r.instances, ['Entertainment', 'EntertainmentTemp', 'EntertainmentTempLum', 'Interrupt']);
        // each instance's type in the id's second half-byte, the app's number around it, a count at the end; "none" as
        // BMW's code makes it of a logging id that is no number
        assert.deepStrictEqual(r.ids.map((x) => x.inst + ' ' + x.log + ' ' + x.out[0].id.hex.slice(0, 4)), ['Entertainment ours a1b8', 'Entertainment none 0100', 'EntertainmentTemp ours a2b8', 'EntertainmentTemp none 0200',
            'EntertainmentTempLum ours a3b8', 'EntertainmentTempLum none 0300', 'Interrupt ours a5b8', 'Interrupt none 0500']);
        const it = sdk.decode(r.ids[0].out)[0];
        assert.ok(Buffer.isBuffer(it.id) && it.id.equals(it.metadata[1].value.id) && it.metadata[2].value.stringValue === S.file && it.metadata[0].value.numeric === S.size && !sdk.hasStub(r.ids[0].out));
        // made with { instance, clientName }: the focus with timer 0 for an entertainment instance, then - connected
        // by the simulated car - the playlist and what starts it
        assert.deepStrictEqual(r.fields.instance, 'Entertainment');
        assert.deepStrictEqual([r.fields.clientName, r.fields.convertedLoggingId, r.fields.lumEnabled], ['RideTube', 0xA15, false]);
        const made = r.calls.filter((c) => /^constructed/.test(c.in));
        assert.deepStrictEqual(made.map((c) => c.method), ['getAudioFocus', 'setAutoplay', 'createPlaylist', 'setCurrentItemPositionAndTime', 'sendButtonEventDirect']);
        assert.deepStrictEqual(made[0].args, { clientId: 'unknown', clientName: 'RideTube', timeOutHeartBeatTimer: 0 });
        assert.strictEqual(made[2].args.newPlaylist[0].id.hex.slice(0, 4), 'a115');
        assert.deepStrictEqual(r.states.map((x) => x[1]), ['Disconnected', 'Disconnected', 'Connecting', 'Connected', 'Starting', 'Playing']);
        // the class's own methods that decide what the car is given, as text
        assert.ok(/^setPlaylist\(list, mediaType\) \{/.test(r.methods.setPlaylist) && /^playlistItemConverter\(item, pos\) \{ const id = Buffer\.alloc\(4\)/.test(r.methods.playlistItemConverter) && /^init\(\) \{/.test(r.methods.init) && /^connect\(\) \{ this\.stateService/.test(r.methods.connect));
        // what it asks beside the player once an item is set (its "sound property"): of whom - the path says how the
        // class reached it, the words a proxy was made with included - and with what; its logger is not part of that
        assert.ok(r.other.length >= 2 && r.other.every((c) => c.method === 'setMainSinkSoundProperty'), JSON.stringify(r.other));
        assert.deepStrictEqual(r.other[0], { in: 'setSoundProperty()', path: 'this.audioManagerProxy.setMainSinkSoundProperty', method: 'setMainSinkSoundProperty', args: { sinkID: 1024, soundProperty: { type: 'SP_AVSYNC_TARGET', value: 0 } } });
        assert.ok(r.other.some((c) => /^constructed: playFile/.test(c.in) && c.path === 'ext:someip.buildProxy("CommandControl","1").setMainSinkSoundProperty'), JSON.stringify(r.other));
        assert.ok(/^setSoundProperty\(\) \{ logger\.info/.test(r.methods.setSoundProperty), r.methods.setSoundProperty);
        assert.ok(r.play.some((x) => x.what === 'another proxy of the class' && /^this\.audioManagerProxy = someipBuilders_1\.buildProxy\("CommandControl", "1"\)/.test(x.text)), JSON.stringify(r.play.map((x) => x.what)));
        // a class whose init fails against stand-ins and subscribes to nothing: its own handlers of the focus and
        // the connection are told by name, and it still gets as far as its playlist and what starts it
        const h = await sdk.read({ text: bundle({ id8: true, byHandlers: true }), logIds: logIds });
        assert.ok(h.notes.some((x) => /init\(\) (threw|rejected): /.test(x)), h.notes.join(' | '));
        assert.deepStrictEqual(h.states.map((x) => x[1]), ['Disconnected', 'Disconnected', 'Connecting', 'Connected', 'Starting', 'Starting']);
        assert.deepStrictEqual(h.calls.filter((c) => /^constructed: playFile/.test(c.in)).map((c) => c.method), ['createPlaylist', 'setCurrentItemPositionAndTime', 'sendButtonEventDirect']);
        // a caller's numbers that cannot be had: none, the rest as before
        const q = await sdk.read({ text: bundle({ id8: true }), logIds: () => { throw new Error('no'); } });
        assert.ok(q.ok && q.ids.length === 0 && q.item);
        // a class without the type map: one id per number, no instance
        const n = await sdk.read({ text: bundle({ id8: true, noTypeMap: true }), logIds: logIds });
        assert.deepStrictEqual(n.ids.map((x) => x.inst + ' ' + x.log), ['null ours', 'null none']);
        assert.deepStrictEqual(n.instances, []);
    });
    await t('how a file is played, as text: what starts the playlist, the item and its id, where the app keeps its file - nothing run', async () => {
        const p = sdk.textPlay(bundle({ id8: true }));
        const by = (re) => p.filter((x) => re.test(x.what))[0];
        assert.ok(/^this\.startPlaybackWithPlayItem = \(position, time\) => this\.mediaPlayerProxy\.setCurrentItemPositionAndTime\(/.test(by(/startPlaybackWithPlayItem/).text));
        assert.ok(/this\.convertedLoggingId = logging\.convertLoggingId\(logging\.loggingId\(\)\)/.test(by(/convertedLoggingId/).text));
        assert.ok(/convertLoggingId = \(text\) => parseInt\(String\(text\)\.slice\(1\), 16\)/.test(by(/its function convertLoggingId/).text));
        assert.ok(/sourceToItemTypeMap = \{ Entertainment: 1,/.test(by(/sourceToItemTypeMap/).text) && /getVideoPath\(uuid\) \{ return this\.root/.test(by(/getVideoPath/).text));
        assert.ok(/path\.basename\(path\.dirname\(process\.argv\[1\]\)\)/.test(by(/app's id is found/).text));
        assert.ok(p.every((x) => x.text.length <= 1000) && p.length <= 16);
        // a text with none of it: nothing, never thrown; minified forms are found too
        assert.deepStrictEqual(sdk.textPlay('var x = 1;'), []);
        const min = sdk.textPlay('class A{constructor(e){this.convertedLoggingId=(0,l.toNum)(e.id),this.startPlaybackWithPlayItem=(e,t)=>this.p.setCurrentItemPositionAndTime({token:this.k,newPosition:e,newTimeElapsed:t})}setPlaylist(e,t){return 1}playlistItemConverter(e,t,i=!1){return 2}}A.sourceToItemTypeMap={Entertainment:1};function toNum(e){return parseInt(e.slice(1),16)}');
        assert.deepStrictEqual(min.map((x) => x.what.replace(/ \(.*$/, '')), ['what starts the playlist', 'the id\'s number of the app', 'its function toNum', 'the id\'s type per instance']);
        assert.ok(/^toNum\(e\)\{return parseInt/.test(min[2].text), min[2].text);
    });
    await t('a bundle that never ends is cut off', async () => {
        const loop = bundle({}).replace('exports.default = MediaPlayerImpl;', 'exports.default = MediaPlayerImpl; for (;;) {}');
        const t0 = Date.now();
        const r = await sdk.read({ text: loop, timeoutMs: 1500 });
        assert.strictEqual(r.ok, false);
        assert.ok(/took over/.test(r.error), r.error);
        assert.ok(Date.now() - t0 < 4000);
    });
    console.log(results.join('\n'));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* left */ }
    process.exit(results.filter((r) => r.indexOf('FAIL') === 0).length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
