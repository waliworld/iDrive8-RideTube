'use strict';
// iDrive 8: the built app (dist/jap_ridetube8) started as on the head unit (kit/mgu.js, display.js, renderd.js and
// the app itself) against a fake oap-sdk whose HMI sends the screen events in the formats the MGU Store's own app
// handles on iDrive 8, and a fake mgu-render (mgu8_harness.js, one process per scenario). The renderer must be asked
// to show the app whatever the stack's form (0.4.0 showed a grey page: the stack hid it), hide it when the user
// leaves, and without a renderer the page's title must say why.
//   node kit/tools/test_mgu8.js
const assert = require('assert');
const cp = require('child_process');
const fs = require('fs');
const path = require('path');

const stage = path.join(__dirname, '..', '..', 'dist', 'jap_ridetube8');
if (!fs.existsSync(path.join(stage, 'source', 'javascript', 'app.js'))) { console.log('skip (python3 kit/tools/build.py --hmi ID8 jap_ridetube first)'); process.exit(0); }
const run = (scenario) => {
    const out = cp.execFileSync(process.execPath, [path.join(__dirname, 'mgu8_harness.js'), stage, scenario], { encoding: 'utf8', timeout: 30000 });
    return JSON.parse(out.trim().split('\n').pop());
};
const last = (a) => a[a.length - 1];
for (const s of ['id7-like', 'stack-strings', 'stack-objects', 'visible-first', 'no-getId', 'stack-only']) {
    const r = run(s);
    assert.ok(/proto=mgu-render\/1/.test(r.hello), s + ': mgu-render/1 asked for');
    assert.deepStrictEqual(r.place, { x: 0, y: 76, w: 2880, h: 764, scale: 1.4 }, s + ': the app area');
    assert.strictEqual(last(r.shows), 1, s + ': shown (SHOW ' + JSON.stringify(r.shows) + ')\n' + r.log.join('\n'));
    assert.ok(r.frames >= 2, s + ': frames sent: ' + r.frames);
    console.log('ok   ' + s + ': shown, ' + r.frames + ' frames');
}
for (const s of ['left-home', 'hidden-event']) {
    const r = run(s);
    assert.deepStrictEqual(r.shows, [1, 0], s + ': shown, then hidden: ' + JSON.stringify(r.shows));
    console.log('ok   ' + s + ': shown, then hidden');
}
const r = run('no-renderer');
assert.deepStrictEqual(r.shows, [], 'no renderer: nothing shown');
assert.ok(r.titles.some((t) => /^RideTube - needs the GPU renderer mgu-render/.test(t)), 'the title says why: ' + JSON.stringify(r.titles));
console.log('ok   no renderer: the page title says "' + last(r.titles) + '"');
console.log('mgu8: all ok');
