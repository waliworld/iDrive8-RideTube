'use strict';
// iDrive 8: RideTube as the head unit builds and starts it.
//
// The source package (dist/src/jap_ridetube8, build.py --hmi ID8) is built with the MGU Store's own linker (the file
// its deploy tool runs on the car; MGU_STORE: a clone of github.com/robertnisipeanu/mgu-store) against a stand-in for
// an app already on the car (id8_link.js), then started through its package.json's main against a fake oap-sdk and a
// fake mgu-render (mgu8_harness.js, one process per case).
//   - the package: a source package the Store's linker takes; built, it holds the linked bundle, asks for no SDK
//     module by name (0.4.0 to 0.4.2 did: the Store's deploy tool gives none on iDrive 8, the app ended at its first
//     line and the tile greyed out when tapped), and names the certification service;
//   - the start: the tile is made usable and the page opened however the SDK starts - its 'initialized' event or
//     start()'s promise, either export shape of its modules, a start with the platform and the tile tapped later, a
//     start for no screen, a refused open, a refused entry point init - and whatever becomes of the app's own code;
//   - the screen: the renderer is asked to show the app whatever form the HMI's stack, visible and focus events take,
//     and to hide it when the page goes;
//   - the renderer: connected as the apps known to draw on an iDrive 8 car connect (IterioDev's dialect), touch
//     areas claimed; mgu-render/1 on request;
//   - when the picture cannot come, the page's title and its status lines say why.
//   MGU_STORE=<clone> node kit/tools/test_mgu8.js
const assert = require('assert');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const src = path.join(root, 'dist', 'src', 'jap_ridetube8');
const store = process.env.MGU_STORE;
if (!fs.existsSync(path.join(src, 'mgu-app.json'))) { console.log('skip (python3 kit/tools/build.py --hmi ID8 jap_ridetube first)'); process.exit(0); }
if (!store || !fs.existsSync(path.join(store, 'tools', 'oap_link.js'))) { console.log('skip (MGU_STORE: a clone of github.com/robertnisipeanu/mgu-store, whose linker builds the package)'); process.exit(0); }

// ---- the package, built as on the head unit
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mgu8-link-'));
const { linkId8 } = require('./id8_link');
const L = linkId8(path.resolve(store), src, work);
const version = L.manifest.version;
{
    const art = path.join(root, 'dist', 'src', 'jap_ridetube8@' + version + '.tgz');
    const names = L.link.untar(fs.readFileSync(art)).map((f) => f.name);
    assert.ok(names.indexOf('mgu-app.json') >= 0 && names.indexOf('src/boot.js') >= 0, 'the artifact is a source package: mgu-app.json and the entry module at its root');
    assert.ok(names.indexOf('jap_ridetube8@' + version + '/package.json') >= 0 && !names.some((n) => /node_modules|javascript\/app\.js$/.test(n)), 'its tree, with no bundle and no SDK of its own');
    assert.strictEqual(L.build.moduleCount, 4, 'one app module linked with the three SDK modules');
    assert.ok(/entry\.js$/.test(L.build.entry), 'the main is the stock entry point: ' + L.build.entry);
    const built = (f) => fs.readFileSync(path.join(L.dir, f), 'utf8');
    const pkg = JSON.parse(built('package.json'));
    assert.deepStrictEqual([pkg.main, pkg.mguLocalOnly, pkg.mguHmi], ['javascript/runner.js', true, ['ID8']], 'package.json: ' + JSON.stringify(pkg));
    assert.ok(/^\/\* app modules[\s\S]*?\*\/\s*\(function\(\)\{function r\(e,n,t\)/.test(built('javascript/app.js')), 'javascript/app.js is the linked bundle');
    assert.ok(built('javascript/app.js').indexOf("'kit', 'sdk.js')).give(") > 0, 'with the kit\'s entry module in it');
    assert.ok(!/global\.__mgu(Sdk|Host)/.test(built('javascript/app.js')) && !/global\.__mgu(Sdk|Host)/.test(built('app/kit/sdk.js') + built('app/kit/mgu.js')), 'the SDK is not handed over through a global (the bundle\'s is its own on the car)');
    assert.strictEqual(L.link.needsSdk(L.dir), false, 'no file of the built package asks for an SDK module by name');
    assert.strictEqual(L.link.needsCertification(L.dir), false, 'its manifest names the certification service');
    assert.strictEqual(L.build.certification, null, '(nothing had to be added)');
    console.log('ok   the package: built by the Store\'s linker (' + L.build.moduleCount + ' modules, main from ' + L.build.entry + '), no SDK asked for by name');
}

// env: MGU8_CONTEXT=shared (the stock entry point loads the bundle by a plain require; default: in a JavaScript context
// of its own, as a car showed), MGU_RENDERD_PROTO=native (mgu-render/1; default on iDrive 8: IterioDev's dialect)
const run = (scenario, sdk, env) => {
    const out = cp.execFileSync(process.execPath, [path.join(__dirname, 'mgu8_harness.js'), L.dir, scenario].concat(sdk ? [sdk] : []),
        { encoding: 'utf8', timeout: 40000, stdio: ['ignore', 'pipe', 'ignore'], env: Object.assign({}, process.env, { MGU8_CONTEXT: '', MGU_RENDERD_PROTO: '' }, env || {}) });
    return JSON.parse(out.trim().split('\n').pop());
};
const last = (a) => a[a.length - 1];
const tell = (r) => '\n' + JSON.stringify(r.status) + ' ' + JSON.stringify(r.tile) + ' ' + JSON.stringify(r.info) + '\n' + (r.log || []).join('\n');

// what every start must look like to the app manager, the tile and the car
function sane(r, what, o) {
    o = o || {};
    assert.strictEqual(r.exit, 0, what + ': the app ran on' + tell(r));
    assert.deepStrictEqual(r.asked, [], what + ': no module "oap-sdk" or "someip" asked for by name' + tell(r));
    assert.strictEqual(r.initialized, 1, what + ': initialized() once' + tell(r));
    assert.strictEqual(r.opens, 1, what + ': the page opened once' + tell(r));
    if (o.active !== undefined) assert.strictEqual(r.status.active, o.active, what + ': ACTIVE ' + o.active + ' time(s)' + tell(r));
    assert.deepStrictEqual([r.status.inactive, r.status.hmiVisible, r.status.hmiInvisible], [0, 0, 0], what + ': no INACTIVE, no HMI-visible reports' + tell(r));
    assert.deepStrictEqual([r.tile.text, r.tile.icon], [0, 0], what + ': the tile keeps the manager\'s name and icon' + tell(r));
    if (!o.noApp) assert.ok(r.proxies.some((p) => p[0] === 'de.bmw.infotainment.vehicle.Vehicle2' && p[1] === '1' && p[2] === 'number'), what + ': speed through the SDK\'s proxy: ' + JSON.stringify(r.proxies));
}
function shown(r, what, o) {
    if (o && o.native) assert.ok(/proto=mgu-render\/1/.test(r.hello) && r.x >= 1, what + ': mgu-render/1 asked for, its mode set');
    else {
        // IterioDev's dialect, as the apps known to draw on an iDrive 8 car connect: the app id alone, the dialect
        // told by an empty CLAIM first, then the touch areas; nothing of mgu-render/1, no upstream GRAB
        assert.strictEqual(r.hello, 'jap_ridetube8', what + ': HELLO is the app id alone: ' + JSON.stringify(r.hello));
        assert.deepStrictEqual([r.first911, r.x, r.grab10], [[9, 4], 0, 0], what + ': an empty CLAIM first, no mgu-render/1 message, no GRAB: ' + JSON.stringify([r.first911, r.x, r.grab10]));
        assert.ok(r.claims.some((n) => n > 0), what + ': touch areas claimed: ' + JSON.stringify(r.claims));
    }
    assert.deepStrictEqual(r.place, { x: 0, y: 76, w: 2880, h: 764, scale: 1.4 }, what + ': the app area');
    assert.strictEqual(last(r.shows), 1, what + ': shown (SHOW ' + JSON.stringify(r.shows) + ')' + tell(r));
    assert.ok(r.frames >= 2, what + ': frames sent: ' + r.frames);
    assert.deepStrictEqual(r.fatal, [], what + ': nothing fatal');
}
const line1 = (tile, pageState, app) => new RegExp('^RideTube ' + version.replace(/\./g, '\\.') + ' for iDrive 8: running \\| start: [A-Z_]+ \\| tile: ' + tile + ' \\| page: ' + pageState + ' \\| app: ' + app);

// ---- the HMI's events in every form
for (const s of ['id7-like', 'stack-strings', 'stack-objects', 'visible-first', 'no-getId', 'focus-shapes', 'stack-only']) {
    const r = run(s);
    sane(r, s, { active: 1 }); shown(r, s);
    assert.strictEqual(r.tile.enabled, 1, s + ': the tile ENABLED');
    assert.ok(line1('init mapped enabled', 'opened', 'started').test(r.info.VIEW_INFO1), s + ': line 1: ' + r.info.VIEW_INFO1);
    console.log('ok   ' + s + ': opened, shown, ' + r.frames + ' frames');
}
for (const s of ['stack-other-keys', 'stack-map', 'left-home']) {
    const r = run(s);
    sane(r, s); shown(r, s);
    assert.deepStrictEqual(r.shows, [1], s + ': a stack without ROOT_APP hides nothing: ' + JSON.stringify(r.shows));
    console.log('ok   ' + s + ': shown and kept (' + r.frames + ' frames)');
}
for (const s of ['hidden-event', 'manager-hides', 'stack-only-left']) {
    const r = run(s);
    sane(r, s);
    assert.deepStrictEqual(r.shows, [1, 0], s + ': shown, then hidden: ' + JSON.stringify(r.shows) + tell(r));
    console.log('ok   ' + s + ': shown, then hidden');
}

// ---- however the SDK starts and answers
for (const k of ['event', 'hang', 'late-rhmi', 'member', 'no-last', 'refuse-open', 'init-fails', 'map-refused', 'no-installed-json', 'status-throws', 'no-logging']) {
    const r = run('visible-first', k);
    sane(r, 'sdk ' + k);
    shown(r, 'sdk ' + k);
    if (k === 'event') assert.ok(r.log.some((l) => /OnlineApp error: .*joynr/.test(l)), 'the SDK\'s error event is logged, not thrown:' + tell(r));
    if (k === 'refuse-open') assert.strictEqual(r.openTries, 3, 'asked again after each refusal');
    if (k === 'init-fails') assert.ok(r.tile.enabled === 1 && line1('init failed mapped enabled', 'opened', 'started').test(r.info.VIEW_INFO1), 'ENABLED although init() was refused: ' + r.info.VIEW_INFO1);
    console.log('ok   sdk ' + k + ': opened and shown');
}
{
    // started with the platform, as the Store's deploy tool lists an iDrive 8 app (autostart): nothing opens and no
    // ACTIVE is reported until the tile is tapped
    const r = run('visible-first', 'background');
    sane(r, 'sdk background', { active: 0 });
    shown(r, 'sdk background');
    assert.ok(/start: AUTOSTART \| tile: init mapped enabled \| page: opened/.test(r.info.VIEW_INFO1), 'line 1: ' + r.info.VIEW_INFO1);
    console.log('ok   sdk background: started with the platform, opened by the tile, shown');
}
{
    const r = run('visible-first', 'no-rhmi');
    assert.deepStrictEqual([r.exit, r.initialized, r.opens, r.shows, r.asked, r.fatal], [0, 1, 0, [], [], []], 'a start for no screen: answered, nothing else' + tell(r));
    console.log('ok   sdk no-rhmi: a start for no screen is answered and the app stays');
}
{
    // the app's own code does not load: the tile and the page work, and the page says what happened
    const r = run('visible-first', 'kit-broken');
    sane(r, 'sdk kit-broken', { active: 1, noApp: true });
    assert.strictEqual(r.tile.enabled, 1, 'the tile ENABLED');
    assert.ok(line1('init mapped enabled', 'opened', 'failed \\| error: the app did not load: broken on purpose').test(r.info.VIEW_INFO1), 'line 1: ' + r.info.VIEW_INFO1);
    assert.ok(/^The app's own code did not load \(broken on purpose\)/.test(r.info.VIEW_INFO2), 'line 2: ' + r.info.VIEW_INFO2);
    assert.ok(r.titles.some((t) => t === 'RideTube - did not load'), 'the title: ' + JSON.stringify(r.titles));
    console.log('ok   sdk kit-broken: the page opens without the app\'s code and says "' + r.info.VIEW_INFO2 + '"');
}

// ---- when the picture cannot come, the page says why
{
    const r = run('no-renderer');
    sane(r, 'no renderer');
    assert.deepStrictEqual(r.shows, [], 'no renderer: nothing shown');
    assert.ok(r.titles.some((t) => /^RideTube - the GPU renderer \(mgu-render\) is not running/.test(t)), 'the title says why: ' + JSON.stringify(r.titles));
    assert.ok(line1('init mapped enabled', 'opened', 'started').test(r.info.VIEW_INFO1), 'line 1: ' + r.info.VIEW_INFO1);
    assert.ok(/^Screen: the GPU renderer \(mgu-render\) is not running \| page: visible yes/.test(r.info.VIEW_INFO2), 'line 2: ' + r.info.VIEW_INFO2);
    assert.ok(/^Renderer: (no socket|not connected)/.test(r.info.VIEW_INFO3), 'line 3: ' + r.info.VIEW_INFO3);
    assert.ok(/^Service \(jap-ridetube-d\): not answering/.test(r.info.VIEW_INFO4), 'line 4: ' + r.info.VIEW_INFO4);
    console.log('ok   no renderer: "' + last(r.titles) + '"\n       ' + ['VIEW_INFO1', 'VIEW_INFO2', 'VIEW_INFO3', 'VIEW_INFO4'].map((k) => r.info[k]).join('\n       '));
}
{
    // mgu-render/1 (MGU_RENDERD_PROTO=native): the renderer says it does not have the app in front
    const r = run('not-in-front', undefined, { MGU_RENDERD_PROTO: 'native' });
    sane(r, 'not in front');
    assert.ok(r.titles.some((t) => /^RideTube - the GPU renderer does not see this app in front/.test(t)), 'the title says why: ' + JSON.stringify(r.titles));
    assert.ok(/mgu-render\/1, gate yes, touch yes .* in front no, on screen no/.test(r.info.VIEW_INFO3), 'line 3: ' + r.info.VIEW_INFO3);
    console.log('ok   mgu-render/1, not in front: "' + last(r.titles) + '"');
}
{
    const r = run('visible-first', undefined, { MGU_RENDERD_PROTO: 'native' });
    sane(r, 'mgu-render/1'); shown(r, 'mgu-render/1', { native: true });
    console.log('ok   mgu-render/1: opened, shown, ' + r.frames + ' frames');
}
{
    // the stock entry point loading the bundle by a plain require (one context, one global)
    for (const k of ['plain', 'background']) {
        const r = run('visible-first', k, { MGU8_CONTEXT: 'shared' });
        sane(r, 'shared context, sdk ' + k); shown(r, 'shared context, sdk ' + k);
    }
    console.log('ok   the bundle loaded by a plain require: opened and shown');
}
{
    const r = run('id7-like');
    assert.ok(/^Screen: drawn by the GPU renderer/.test(r.info.VIEW_INFO2), 'line 2 when drawn: ' + r.info.VIEW_INFO2);
    assert.ok(/^Renderer: connected .* \| IterioDev dialect, touch yes \| screen 2880x960 \| asked yes, claims yes \| frames yes, ticks yes/.test(r.info.VIEW_INFO3), 'line 3 when drawn: ' + r.info.VIEW_INFO3);
    assert.deepStrictEqual(r.titles.filter((t) => / - /.test(t)), [], 'no reason in the title while it draws');
    console.log('ok   drawn: ' + r.info.VIEW_INFO3.replace(/\/tmp\/\S+/, '<socket>'));
}
{
    const r = run('uncaught');
    sane(r, 'uncaught');
    assert.strictEqual(last(r.shows), 1, 'still shown after an uncaught error');
    assert.ok(r.fatal.some((l) => /boom in a timer/.test(l)), 'logged as FATAL');
    assert.ok(/error: uncaught: boom in a timer/.test(r.info.VIEW_INFO1), 'line 1 names it: ' + r.info.VIEW_INFO1);
    console.log('ok   an uncaught error: the app runs on, "' + r.info.VIEW_INFO1 + '"');
}
fs.rmSync(work, { recursive: true, force: true });
console.log('mgu8: all ok');
