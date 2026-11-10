'use strict';

// kit/runtime/qr.js against matrices from an independent encoder (python-qrcode 8, byte mode, level M, the
// mask given, no border; rows as hex, left to right), versions 1-4 (4: two interleaved blocks); then the auto
// mask, the length limit, and draw(). No SDK or car needed:
//   node kit/tools/test_qr.js

const assert = require('assert');
const { encode, draw } = require('../runtime/qr');

const REF = [
    ["hi", 0, 1, [
        'fe1bf8',
        '82f208',
        'ba3ae8',
        'ba52e8',
        'bafae8',
        '825208',
        'feabf8',
        '002000',
        'aa6890',
        'b03578',
        '0bb778',
        '2d5dd0',
        'd2f720',
        '008238',
        'fe4898',
        '826238',
        'baeaa8',
        'ba7550',
        'baf768',
        '827dd0',
        'fed778',]],
    ["https://google.com/dev", 5, 2, [
        'fe323f8',
        '82eaa08',
        'bafaae8',
        'bae7ae8',
        'ba6cae8',
        '8276a08',
        'feaabf8',
        '0083000',
        '82e7670',
        '24031f0',
        '0a8b5d8',
        '65c1d48',
        '3ad0b08',
        'aca9110',
        '9b63dd8',
        '8968568',
        '8aeffa0',
        '00a2880',
        'fe68a88',
        '8271880',
        'ba31fb8',
        'ba0ee18',
        'ba06868',
        '820cf88',
        'fe9c848',]],
    ["https://www.google.com/device", 3, 3, [
        'fec9f3f8',
        '82f32208',
        'ba7f3ae8',
        'baa8d2e8',
        'ba3c52e8',
        '82623a08',
        'feaaabf8',
        '00a65000',
        'b756e258',
        'e0d9bf88',
        'dab365b0',
        'f9a72588',
        '0298c060',
        '100c7338',
        '1f2a75b8',
        '850d3b90',
        'cae83cd0',
        '48344170',
        '82782b20',
        '3511e620',
        '6ead7fe0',
        '00d728f8',
        'feb49ad0',
        '82f8a8d8',
        'ba434fa8',
        'badeccd0',
        'baf7a928',
        '82048950',
        'fee95e50',]],
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=WL&index=1", 6, 4, [
        'fee4a23f8',
        '82c632208',
        'baef86ae8',
        'ba33cdae8',
        'ba95b02e8',
        '827785a08',
        'feaaaabf8',
        '001d83000',
        '9fe2d04b8',
        'fc5d750f8',
        'c2058def8',
        'd51df8720',
        'be6d88a88',
        '38526bd20',
        '5b31142e0',
        '492c80c68',
        '874f3bf80',
        'c8e970ea8',
        'a209d3368',
        '7d18b30e8',
        '8bd750048',
        'f1e7e06e0',
        '935387698',
        'a5d05aff8',
        'e73019f90',
        '00f1838a0',
        'fef515ab0',
        '82be9b8e0',
        'baaf81f98',
        'baa5c8538',
        'ba3d949f8',
        '821a125f8',
        'fe8ac1dc0',]],
];
const toHex = (m) => m.map((r) => { const b = r.map((c) => (c ? '1' : '0')).join('') + '000'; let h = ''; for (let i = 0; i + 4 <= b.length; i += 4) h += parseInt(b.slice(i, i + 4), 2).toString(16); return h; });

REF.forEach(([text, mask, ver, rows]) => {
    const m = encode(text, { mask });
    assert.strictEqual(m.length, 17 + 4 * ver, text + ': version ' + ver);
    assert.deepStrictEqual(toHex(m), rows, text + ' mask ' + mask);
});
// the mask the penalty rules pick is one of the eight valid codes (the reference's own pick for the sign-in URL: 3)
assert.deepStrictEqual(toHex(encode('https://www.google.com/device')), REF[2][3], 'auto mask');
assert.strictEqual(encode('x'.repeat(62)).length, 33, '62 bytes: version 4');
assert.throws(() => encode('x'.repeat(63)), /too long/);
// draw: a white square with a 4-module quiet zone, dark runs as rects inside it
const rects = [];
const cv = { fillRect: (x, y, w, h, c) => rects.push({ x, y, w, h, c }) };
const side = draw(cv, 'https://www.google.com/device', 100, 50, 8);
assert.strictEqual(side, (29 + 8) * 8);
assert.deepStrictEqual(rects[0], { x: 100, y: 50, w: side, h: side, c: '#ffffff' });
const dark = rects.slice(1);
assert.ok(dark.every((r) => r.c === '#000000' && r.x >= 132 && r.y >= 82 && r.x + r.w <= 100 + side - 32 && r.h === 8));
const m = encode('https://www.google.com/device');
assert.strictEqual(dark.reduce((a, r) => a + r.w / 8, 0), m.reduce((a, r) => a + r.filter(Boolean).length, 0), 'every dark module drawn once');
console.log('ok   qr: versions 1-4 match the reference, auto mask, limit, draw');
