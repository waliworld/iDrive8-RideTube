'use strict';
// kit/runtime/keyboard.js: the on-screen keyboard sheet (iDrive 8's Search). Drawn on a Recorder of both page widths,
// typed with its targets and with the controller; locked while driving; chips; the length limit.
//   node kit/tools/test_keyboard.js
const assert = require('assert');
const { Recorder } = require('../runtime/record');
const { keyboardSheet } = require('../runtime/keyboard');
const { theme } = require('../runtime/themes');

const t = theme();
const draw = (sh, w) => { const r = new Recorder(w || 2080, 520, {}); return { r, targets: sh.draw(r, t) }; };
const keyOf = (sh, targets, k) => targets[sh.places.findIndex((p) => p.key === k)];

(async () => {
    let done = null, locked = false;
    const sh = keyboardSheet({ title: 'Search', hint: 'Search videos', chips: () => ['cats', '', 'news'], locked: () => locked, onDone: (v) => { done = v; } });
    for (const w of [1600, 2080]) {
        const { targets } = draw(sh, w);
        assert.ok(targets.every((q) => q.x >= 0 && q.x + q.w <= w + 6 && q.y >= 40 && q.y + q.h <= 530), 'targets on the ' + w + ' page');
        const keys = sh.places.filter((p) => p.key.indexOf('k:') === 0).length;
        assert.strictEqual(keys, 43, 'digits, letters, marks, Clear, space, backspace');
        assert.deepStrictEqual(sh.places.filter((p) => /^chip:/.test(p.key)).length, 2, 'empty chips left out');
    }
    let { targets } = draw(sh);
    for (const c of 'abc') await keyOf(sh, targets, 'k:' + c).act();
    await keyOf(sh, targets, 'k: ').act();
    await keyOf(sh, targets, 'k:1').act();
    assert.strictEqual(sh.text, 'abc 1');
    await keyOf(sh, targets, 'k:bksp').act();
    assert.strictEqual(sh.text, 'abc ');
    assert.strictEqual(await keyOf(sh, targets, 'ok').act(), 'close', 'OK closes');
    assert.strictEqual(done, 'abc', 'trimmed');
    await keyOf(sh, targets, 'k:clear').act();
    assert.strictEqual(sh.text, '');
    assert.strictEqual(await keyOf(sh, targets, 'ok').act(), null, 'nothing typed: OK stays');
    for (let i = 0; i < 120; i++) sh.type('x');
    assert.strictEqual(sh.text.length, 100, 'at most 100');
    draw(sh);                                     // a long text draws (its end in view)
    sh.type('clear');
    // driving: keys do nothing, chips still answer
    locked = true;
    ({ targets } = draw(sh));
    await keyOf(sh, targets, 'k:q').act();
    assert.strictEqual(sh.text, '', 'locked');
    assert.strictEqual(await keyOf(sh, targets, 'chip:1').act(), 'close');
    assert.strictEqual(done, 'news', 'a chip searches');
    locked = false;
    // the controller: the first turn lands on the first key, a press types it; Cancel closes
    const c = keyboardSheet({ onDone() {} });
    draw(c);
    c.move(1);
    assert.strictEqual(c.places[c.focus].key, 'k:1');
    c.move(2); c.press();
    assert.strictEqual(c.text, '3');
    c.move(-100);
    assert.ok(c.top(), 'at the top: Cancel');
    assert.strictEqual(c.press(), 'close');
    assert.strictEqual(c.back(), 'close');
    console.log('keyboard: all ok');
})().catch((e) => { console.error(e); process.exit(1); });
