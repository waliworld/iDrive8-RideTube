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
