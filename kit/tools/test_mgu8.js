'use strict';
// iDrive 8: the built app (dist/jap_ridetube8) started as on the head unit (kit/mgu.js, display.js, renderd.js and
// the app itself) against a fake oap-sdk and a fake mgu-render (mgu8_harness.js, one process per case).
//   - the tile's page is opened and the renderer asked to show the app whatever form the HMI's stack, visible and
//     focus events take (0.4.0 hid the page by the stack, 0.4.1 still when a stack came without ROOT_APP);
//   - however the SDK starts: its 'initialized' event or start()'s promise, the start reason in either place, an
//     'error' event of its own, a refused open, a refused entry point init;
//   - the app stays ACTIVE (never INACTIVE, no HMI-visible reports), leaves the tile's name and icon alone, reads the
//     car through the SDK's proxies, and an uncaught error does not end it;
//   - when the picture cannot come, the page's title and its status lines say why.
//   node kit/tools/test_mgu8.js
const assert = require('assert');
const cp = require('child_process');
const fs = require('fs');
const path = require('path');

const stage = path.join(__dirname, '..', '..', 'dist', 'jap_ridetube8');
if (!fs.existsSync(path.join(stage, 'source', 'javascript', 'app.js'))) { console.log('skip (python3 kit/tools/build.py --hmi ID8 jap_ridetube first)'); process.exit(0); }
const run = (scenario, sdk) => {
    const out = cp.execFileSync(process.execPath, [path.join(__dirname, 'mgu8_harness.js'), stage, scenario].concat(sdk ? [sdk] : []), { encoding: 'utf8', timeout: 40000, stdio: ['ignore', 'pipe', 'ignore'] });
    return JSON.parse(out.trim().split('\n').pop());
};
const last = (a) => a[a.length - 1];
const version = JSON.parse(fs.readFileSync(path.join(stage, 'source', 'package.json'), 'utf8')).version;

// what every start must look like to the manager, the tile and the car
function sane(r, what) {
    const tell = what + '\n' + JSON.stringify(r.status) + ' ' + JSON.stringify(r.tile) + '\n' + r.log.join('\n');
    assert.strictEqual(r.exit, 0, what + ': the app ran on');
    assert.strictEqual(r.initialized, 1, 'initialized() once: ' + tell);
    assert.strictEqual(r.opens, 1, 'the page opened once: ' + tell);
    assert.ok(r.status.active >= 1, 'ACTIVE reported: ' + tell);
    assert.deepStrictEqual([r.status.inactive, r.status.hmiVisible, r.status.hmiInvisible], [0, 0, 0], 'no INACTIVE, no HMI-visible reports: ' + tell);
    assert.deepStrictEqual([r.tile.text, r.tile.icon], [0, 0], 'the tile keeps the manager\'s name and icon: ' + tell);
    assert.ok(!r.rawSomeip, 'no raw someip binding on iDrive 8: ' + tell);
    assert.ok(r.proxies.some((p) => p[0] === 'de.bmw.infotainment.vehicle.Vehicle2' && p[1] === '1' && p[2] === 'number'), 'speed through the SDK\'s proxy: ' + JSON.stringify(r.proxies));
}
function shown(r, what) {
    assert.ok(/proto=mgu-render\/1/.test(r.hello), what + ': mgu-render/1 asked for');
    assert.deepStrictEqual(r.place, { x: 0, y: 76, w: 2880, h: 764, scale: 1.4 }, what + ': the app area');
    assert.strictEqual(last(r.shows), 1, what + ': shown (SHOW ' + JSON.stringify(r.shows) + ')\n' + r.log.join('\n'));
    assert.ok(r.frames >= 2, what + ': frames sent: ' + r.frames);
    assert.deepStrictEqual(r.fatal, [], what + ': nothing fatal');
}

// ---- the HMI's events in every form
for (const s of ['id7-like', 'stack-strings', 'stack-objects', 'visible-first', 'no-getId', 'focus-shapes', 'stack-only']) {
    const r = run(s);
    sane(r, s); shown(r, s);
    assert.strictEqual(r.tile.enabled, 1, s + ': the tile ENABLED');
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
    assert.deepStrictEqual(r.shows, [1, 0], s + ': shown, then hidden: ' + JSON.stringify(r.shows) + '\n' + r.log.join('\n'));
    console.log('ok   ' + s + ': shown, then hidden');
}

// ---- however the SDK starts and answers
for (const k of ['event', 'hang', 'late-rhmi', 'no-last', 'refuse-open', 'init-fails', 'map-refused', 'no-installed-json', 'status-throws', 'no-logging']) {
    const r = run('visible-first', k);
    if (k !== 'status-throws') sane(r, 'sdk ' + k);
    shown(r, 'sdk ' + k);
    assert.strictEqual(r.opens, 1, 'sdk ' + k + ': the page opened');
    if (k === 'event' && r.log.length) assert.ok(r.log.some((l) => /OnlineApp error: .*joynr/.test(l)), 'the SDK\'s error event is logged, not thrown:\n' + r.log.join('\n'));
    if (k === 'refuse-open') assert.strictEqual(r.openTries, 3, 'asked again after each refusal');
    if (k === 'init-fails') assert.strictEqual(r.tile.enabled, 1, 'ENABLED although init() was refused');
    console.log('ok   sdk ' + k + ': opened and shown');
}

// ---- when the picture cannot come, the page says why
{
    const r = run('no-renderer');
    sane(r, 'no renderer');
    assert.deepStrictEqual(r.shows, [], 'no renderer: nothing shown');
    assert.ok(r.titles.some((t) => /^RideTube - the GPU renderer \(mgu-render\) is not running/.test(t)), 'the title says why: ' + JSON.stringify(r.titles));
    assert.ok(new RegExp('^RideTube ' + version.replace(/\./g, '\\.') + ' for iDrive 8: running \\| start: ENTRY_POINT \\| tile: init mapped enabled \\| page: opened').test(r.info.VIEW_INFO1), 'line 1: ' + r.info.VIEW_INFO1);
    assert.ok(/^Screen: the GPU renderer \(mgu-render\) is not running \| page: visible yes/.test(r.info.VIEW_INFO2), 'line 2: ' + r.info.VIEW_INFO2);
    assert.ok(/^Renderer: (no socket|not connected)/.test(r.info.VIEW_INFO3), 'line 3: ' + r.info.VIEW_INFO3);
    assert.ok(/^Service \(jap-ridetube-d\): not answering/.test(r.info.VIEW_INFO4), 'line 4: ' + r.info.VIEW_INFO4);
    console.log('ok   no renderer: "' + last(r.titles) + '"\n       ' + ['VIEW_INFO1', 'VIEW_INFO2', 'VIEW_INFO3', 'VIEW_INFO4'].map((k) => r.info[k]).join('\n       '));
}
{
    const r = run('not-in-front');
    sane(r, 'not in front');
    assert.ok(r.titles.some((t) => /^RideTube - the GPU renderer does not see this app in front/.test(t)), 'the title says why: ' + JSON.stringify(r.titles));
    assert.ok(/in front no, on screen no/.test(r.info.VIEW_INFO3), 'line 3: ' + r.info.VIEW_INFO3);
    console.log('ok   not in front: "' + last(r.titles) + '"\n       ' + r.info.VIEW_INFO3);
}
{
    const r = run('id7-like');
    assert.ok(/^Screen: drawn by the GPU renderer/.test(r.info.VIEW_INFO2), 'line 2 when drawn: ' + r.info.VIEW_INFO2);
    assert.ok(/^Renderer: connected .* \| mgu-render\/1, touch yes, gate yes \| screen 2880x960, area 0,76,2880,764 \| in front yes, on screen yes, asked yes \| frames yes, ticks yes/.test(r.info.VIEW_INFO3), 'line 3 when drawn: ' + r.info.VIEW_INFO3);
    assert.deepStrictEqual(r.titles.filter((t) => / - /.test(t)), [], 'no reason in the title while it draws');
    console.log('ok   drawn: ' + r.info.VIEW_INFO3);
}
{
    const r = run('uncaught');
    sane(r, 'uncaught');
    assert.strictEqual(last(r.shows), 1, 'still shown after an uncaught error');
    assert.ok(r.fatal.some((l) => /boom in a timer/.test(l)), 'logged as FATAL');
    assert.ok(/error: boom in a timer/.test(r.info.VIEW_INFO1), 'line 1 names it: ' + r.info.VIEW_INFO1);
    console.log('ok   an uncaught error: the app runs on, "' + r.info.VIEW_INFO1 + '"');
}
console.log('mgu8: all ok');
