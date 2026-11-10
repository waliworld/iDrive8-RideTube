'use strict';

// RideTube on iDrive 8 (dist/jap_ridetube8, python3 kit/tools/build.py --hmi ID8 jap_ridetube): the built app through
// the stubbed head unit on a 2880 x 960 renderer that routes touch, against a fake jap-ridetube-d. Checks the
// placement (the app area under the HMI's strip, over its climate bar), the wider page (five tiles a row), the kit's
// back button, Search through the on-screen keyboard (locked while driving, recent searches as chips), the rail's
// Settings card (sign in / out, the settings sheet), the player and the video size asked of the daemon.
// With SHOTS=<folder> each step is also written there as a PNG of the whole screen (kit/tools/surface.js).
//   node kit/tools/test_ridetube8.js

const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const stage = path.join(ROOT, 'dist', 'jap_ridetube8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, what) {
    const end = Date.now() + (ms || 3000);
    while (!fn()) { if (Date.now() > end) throw new Error('timed out: ' + what); await sleep(10); }
}
const quiet = { info() {}, warn() {}, error(m, e) { throw e || new Error(m); }, debug() {} };

function fakeDaemon(sock) {
    const d = { got: [], conn: null };
    d.server = net.createServer((c) => {
        d.conn = c;
        let buf = '';
        c.setEncoding('utf8');
        c.on('data', (x) => { buf += x; let i; while ((i = buf.indexOf('\n')) >= 0) { d.got.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
        c.on('error', () => {});
    });
    d.send = (o) => d.conn.write(JSON.stringify(o) + '\n');
    d.cmds = (cmd) => d.got.filter((m) => m.cmd === cmd);
    return new Promise((r) => d.server.listen(sock, () => r(d)));
}

async function main() {
    if (!fs.existsSync(path.join(stage, 'source', 'javascript', 'app.js'))) {
        console.log('skip (python3 kit/tools/build.py --hmi ID8 jap_ridetube first)');
        return;
    }
    const kitDir = path.join(stage, 'source', 'javascript', 'kit');
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(kitDir, 'app-spec.json'), 'utf8')).hmi, 'ID8', 'built for iDrive 8');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yt8-'));
    const sock = path.join(dir, 'ctl.sock');
    const d = await fakeDaemon(sock);
    process.env.MGU_YT_SOCKET = sock;
    process.env.MGU_RENDERD_FILE = path.join(dir, 'stream.bin');
    const vfile = process.env.MGU_YT_VIDEO = path.join(dir, 'mgu-video-ridetube');
    const { headUnit } = require('./hu-stub');
    const hu = headUnit(stage, { dataDir: dir, fresh: true, image: () => Promise.resolve(), log: quiet });
    const disp = hu.display;
    const closed = [];
    hu.ui.close = async (n) => { closed.push(n); };
    let speed = 0, speedH = null;
    hu.ctx.signals = { watch: async (i, n, h) => { if (h && h.statusCarSpeed2) { speedH = h.statusCarSpeed2; speedH({ speedVehicleCentreOfGravity: speed }); } return {}; } };
    hu.ctx.hideButton = (id, hide) => disp.hideButton(id, hide);
    hu.ctx.onPageFocus = (fn) => { disp.onPageFocus = fn; };
    hu.ctx.focus = (k) => disp.focusPage(k);
    const drive = (kmh) => { speed = kmh; speedH({ speedVehicleCentreOfGravity: Math.round(kmh / 0.015625) }); };
    hu.start();
    await until(() => d.cmds('auth_status').length, 3000, 'app connects');

    // the renderer of an iDrive 8: 2880 x 960, touch routed (mgu-render/1)
    disp.gpu.screen = { w: 2880, h: 960 };
    disp.gpu.touch = true;
    disp._place();
    await hu.ui.open('VIEW');
    await hu.loopFn();
    const pl = disp.place;
    const { surfaceCanvas } = require('./surface');
    let shot = 0;
    const snap = (name) => {
        if (!process.env.SHOTS) return;
        fs.mkdirSync(process.env.SHOTS, { recursive: true });
        const cv = surfaceCanvas(disp.last.frame.words(), disp.place, disp.gpu.screen, kitDir);
        fs.writeFileSync(path.join(process.env.SHOTS, String(++shot).padStart(2, '0') + '-' + name + '.png'), cv.png());
    };
    // a tap in surface px (what the renderer sends is logical: the placement's)
    const tap = async (sx, sy) => {
        const x = (sx - pl.ox) / pl.scale, y = (sy - pl.oy) / pl.scale;
        disp._touch(1, x, y); disp._touch(3, x, y);
        await sleep(20);
    };
    const tapTarget = async (t) => { const k = disp.place.scale; await tap((t.x + t.w / 2) * k + disp.place.ox, (t.y + t.h / 2) * k + disp.place.oy); };
    const target = (key) => disp.pageTargets.find((t) => t.key === key);
    const sheetTarget = (i) => disp.sheetTargets[i];

    assert.deepStrictEqual([pl.x, pl.y, pl.w, pl.h, pl.full], [0, 76, 2880, 764, true], 'the surface: the app area, under the status strip and over the climate bar');
    assert.ok(disp.own(), 'the kit runs the screen');
    assert.ok(Math.abs(pl.scale * 2056 - 2880) < 2, 'the 2080 px page fills the width: scale ' + pl.scale);
    assert.ok(pl.scale > 1.39 && pl.scale < 1.42, 'about 1.4: ' + pl.scale);
    assert.deepStrictEqual(disp.buttons(), [], 'no bar');
    assert.ok(target('rail:more') && target('rail:search'), 'the rail has Search and Settings: ' + disp.pageTargets.map((t) => t.key).join(' '));
    snap('home-signed-out');
    console.log('ok   iDrive 8 placement: app area 2880 x 764 at y 76, scale ' + pl.scale.toFixed(3) + ', rail with Search and Settings');

    // the claims: the whole surface but nothing outside it (the HMI's strip and climate bar stay the HMI's)
    const claims = JSON.parse(disp.gpu.claimed || '[]');
    const dev = claims.map((c) => [c.x * pl.scale + pl.ox, c.y * pl.scale + pl.oy, c.w * pl.scale, c.h * pl.scale].map(Math.round));
    assert.ok(dev.length >= 1 && dev.every((c) => c[0] >= -1 && c[1] >= -1 && c[0] + c[2] <= 2881 && c[1] + c[3] <= 765), 'claims inside the surface: ' + JSON.stringify(dev));
    assert.ok(dev.some((c) => c[0] <= 0 && c[1] <= 0 && c[2] >= 2879), 'the header, its back button included, claimed across: ' + JSON.stringify(dev));
    console.log('ok   claims: the header (with the back button) and the page, inside the app area');

    // Search: the keyboard sheet; type "cats" with the keys, then Search
    await tapTarget(target('rail:search'));
    assert.ok(disp.sheet && disp.sheet.title === 'Search', 'the keyboard opened');
    disp._paintSheet();
    snap('keyboard');
    const keyAt = (k) => disp.sheet.places.findIndex((p) => p.key === k);
    for (const ch of 'cats') await tapTarget(sheetTarget(keyAt('k:' + ch)));
    assert.strictEqual(disp.sheet.text, 'cats', 'typed');
    await tapTarget(sheetTarget(keyAt('k:bksp')));
    await tapTarget(sheetTarget(keyAt('k:s')));
    disp._paintSheet();
    snap('keyboard-typed');
    await tapTarget(sheetTarget(keyAt('ok')));
    await until(() => d.cmds('search').length, 2000, 'search sent');
    assert.deepStrictEqual(d.cmds('search')[0], { cmd: 'search', q: 'cats' }, 'the text searched');
    await until(() => !disp.sheet, 1000, 'keyboard closed');
    const items = Array.from({ length: 12 }, (_, i) => ({ id: 'cat' + String(i).padStart(8, '0'), title: 'Cat video number ' + (i + 1) + ' with a long title that wraps', channel: 'Cats ' + i, duration_s: 61 + i * 30, meta: [(i + 1) + 'K views', i + ' days ago'] }));
    d.send({ ev: 'results', q: 'cats', items });
    await sleep(100);
    await hu.loopFn();
    await until(() => d.cmds('thumb').length >= 5, 2000, 'thumbs asked');
    const rgba = (r, g, b) => { const buf = Buffer.alloc(320 * 180 * 4); for (let i = 0; i < buf.length; i += 4) { buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = 255; } return buf.toString('base64'); };
    d.cmds('thumb').forEach((t, i) => d.send({ ev: 'thumb', id: t.id, w: 320, h: 180, rgba: rgba(60 + i * 15, 90, 160 - i * 8) }));
    await sleep(150);
    await hu.loopFn();
    const row0 = disp.pageTargets.filter((t) => /^r:0:/.test(t.key) || /:0:cat/.test(t.key));
    snap('results');
    const firstRowYs = {};
    disp.pageTargets.filter((t) => /cat\d{8}$/.test(t.key)).forEach((t) => { firstRowYs[t.y] = (firstRowYs[t.y] || 0) + 1; });
    const perRow = Math.max.apply(null, Object.values(firstRowYs));
    assert.strictEqual(perRow, 5, 'five tiles a row on the wider page: ' + JSON.stringify(firstRowYs));
    void row0;
    console.log('ok   Search: the on-screen keyboard (typed, backspace, Search), results five a row');

    // driving: the keyboard's keys are locked, the recent searches still work
    drive(50);
    await tapTarget(target('rail:search'));
    assert.ok(disp.sheet && disp.sheet.places.some((p) => p.key === 'chip:0'), 'recent search as a chip');
    await tapTarget(sheetTarget(keyAt('k:x')));
    assert.strictEqual(disp.sheet.text, '', 'no typing while driving');
    disp._paintSheet();
    snap('keyboard-driving');
    await tapTarget(sheetTarget(keyAt('chip:0')));
    await until(() => d.cmds('search').length === 2, 2000, 'chip searched');
    assert.deepStrictEqual(d.cmds('search')[1], { cmd: 'search', q: 'cats' }, 'the chip: the recent search');
    drive(0);
    d.send({ ev: 'results', q: 'cats', items });
    await sleep(100);
    console.log('ok   driving: keys locked, a recent search (chip) still searches');

    // the player: the video asked as a 16:9 frame as tall as the area; the overlay
    await hu.loopFn();
    const tile = disp.pageTargets.find((t) => /cat00000000$/.test(t.key));
    await tapTarget(tile);
    await until(() => d.cmds('play').length, 2000, 'play sent');
    assert.strictEqual(d.cmds('play')[0].rect, '1358x764', 'iDrive 8: a 16:9 frame as tall as the app area');
    fs.writeFileSync(vfile, '');
    d.send({ ev: 'state', state: 'playing', id: items[0].id, title: items[0].title });
    d.send({ ev: 'time', elapsed: 64000, total: 200000 });
    await sleep(400);
    await hu.loopFn();
    assert.ok(target('ov:back') && target('ov:play'), 'the overlay: ' + disp.pageTargets.map((t) => t.key).join(' '));
    snap('player');
    drive(60);
    await sleep(400);
    await hu.loopFn();
    snap('player-driving-podcast');
    drive(0);
    await sleep(400);
    await hu.loopFn();
    // (the overlay may have hidden by now: a tap shows it, then its back)
    if (target('ov:back').w > 1000) { await tapTarget(target('ov:back')); await hu.loopFn(); }
    await tapTarget(target('ov:back'));
    await hu.loopFn();
    console.log('ok   player: 1358x764 asked, overlay, podcast mode while driving, back to the list');

    // the rail's Settings: the card (account), Sign out twice, the settings sheet
    d.send({ ev: 'auth', state: 'signed_in' });
    await sleep(50);
    await hu.loopFn();
    await tapTarget(target('rail:more'));
    assert.ok(disp.sheet && disp.sheet.title === 'Settings', 'the card');
    disp._paintSheet();
    snap('settings-card');
    const act = (label) => disp.sheetTargets.find((t, i) => i > 0 && t && t.act && disp.sheet && label === (disp.sheet.lastLabels || [])[i]);
    void act;
    // the card's targets: Close, then the actions right to left as drawn (Settings last drawn first): find by position
    const acts = disp.sheetTargets.slice(1).sort((a, b) => a.x - b.x);
    await tapTarget(acts[0]);                      // Sign out (armed)
    assert.strictEqual(d.cmds('sign_out').length, 0, 'not on the first press');
    disp._paintSheet();
    await tapTarget(disp.sheetTargets.slice(1).sort((a, b) => a.x - b.x)[0]);
    await until(() => d.cmds('sign_out').length === 1, 1000, 'signed out on the second press');
    assert.ok(!disp.sheet, 'the card closed');
    await tapTarget(target('rail:more'));
    disp._paintSheet();
    await tapTarget(disp.sheetTargets.slice(1).sort((a, b) => a.x - b.x)[1]);   // Settings
    assert.ok(disp.sheet && disp.sheet.settings !== true && disp.sheet.title === 'Settings' && typeof disp.sheet.rows === 'function', 'the settings sheet');
    disp._paintSheet();
    snap('settings-list');
    console.log('ok   Settings: the account card (sign out pressed twice), the settings sheet');

    // the kit's back button: over a sheet it closes the sheet, else the screen
    await tap(40, 40);
    assert.ok(!disp.sheet, 'back: the sheet closed');
    assert.deepStrictEqual(closed, [], 'not the screen yet');
    await hu.loopFn();
    await tap(40, 40);
    assert.deepStrictEqual(closed, ['VIEW'], 'back: the screen closed');
    console.log('ok   the back button: a sheet first, then the screen');

    // a touch on the climate bar or the strip is not ours: nothing claimed there (checked above); the renderer
    // hides the app then (CLOSED), as on iDrive 7
    d.server.close();
    if (d.conn) d.conn.destroy();
    console.log('ridetube8: all ok' + (process.env.SHOTS ? ' (screens in ' + process.env.SHOTS + ')' : ''));
    process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
