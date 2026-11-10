'use strict';
// A built app (dist/<id>) started as on the head unit, against a fake oap-sdk whose HMI sends the screen events of a
// scenario and a fake mgu-render socket (mgu-render/1: X_READY, READY 2880 x 960 with touch, TICK, X_STATE). Prints
// what the renderer saw as one JSON line: { shows: [SHOW values in order], frames, place, log: [app log lines] }.
// Used by test_mgu8.js:  node kit/tools/mgu8_harness.js <dist/id> <scenario>
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const Module = require('module');
const EventEmitter = require('events');

const [stageIn, scenario] = process.argv.slice(2);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mgu8-'));
const stage = path.join(tmp, path.basename(stageIn));
fs.cpSync(stageIn, stage, { recursive: true });
fs.mkdirSync(path.join(stage, 'data'));

// ---- the fake renderer
const seen = { shows: [], frames: 0, place: null, hello: null, titles: [] };
const sock = path.join(tmp, 'render.sock');
const u32 = (type, words) => { const b = Buffer.alloc(8 + words.length * 4); b.writeUInt32LE(type, 0); b.writeUInt32LE(words.length * 4, 4); words.forEach((w, i) => b.writeUInt32LE(w >>> 0, 8 + i * 4)); return b; };
net.createServer((c) => {
    let buf = Buffer.alloc(0);
    c.on('error', () => {});
    c.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        while (buf.length >= 8) {
            const type = buf.readUInt32LE(0), len = buf.readUInt32LE(4);
            if (buf.length < 8 + len) break;
            const p = buf.slice(8, 8 + len);
            buf = buf.slice(8 + len);
            if (type === 1) {                                   // HELLO: mgu-render/1 asked for -> X_READY, READY
                seen.hello = p.toString('latin1').replace(/\0/g, ' ');
                c.write(u32(0x4d520101, [0, 0, 1 | 4]));        // touch, front gate
                c.write(u32(101, [0, 2880, 960, 1]));
            } else if (type === 2) {
                seen.place = { x: p.readInt32LE(0), y: p.readInt32LE(4), w: p.readInt32LE(8), h: p.readInt32LE(12), scale: +p.readFloatLE(16).toFixed(3) };
            } else if (type === 3) {
                const on = p.readUInt32LE(0);
                seen.shows.push(on);
                c.write(u32(0x4d520102, [0, on, 1]));           // X_STATE: on screen as asked, in front
            } else if (type === 7) {
                seen.frames++;
                c.write(u32(102, [seen.frames, 0]));            // TICK
            }
        }
    });
}).listen(scenario === 'no-renderer' ? path.join(tmp, 'unused.sock') : sock);
process.env.MGU_RENDERD_SOCKET = sock;
process.env.MGU_YT_SOCKET = path.join(tmp, 'no-daemon.sock');

// ---- the fake oap-sdk: an iDrive 8 HMI
const logs = [];
const logger = {};
['info', 'warn', 'error', 'debug'].forEach((l) => { logger[l] = (m) => logs.push(l[0].toUpperCase() + ' ' + m); });
class State extends EventEmitter {
    constructor(n, id) { super(); this.n = n; this.id = id; }
    updateResources() { return Promise.resolve(); }
    getId() { return this.id; }
    setValue() { return Promise.resolve(); }
}
const view = new State('VIEW', 3000);
const title = new State('VIEW_TITLE', 3220);
title.setValue = (row, cell, value) => { seen.titles.push(value); return Promise.resolve(); };
if (scenario === 'no-getId') view.getId = undefined;
const rhmi = new EventEmitter();
Object.assign(rhmi, {
    getByName: (n) => (n === 'VIEW' ? view : n === 'VIEW_TITLE' ? title : null),
    mapEntryState: () => Promise.resolve(),
    openEntryState: () => Promise.resolve(),
    openState: () => Promise.resolve(),
    closeState: () => Promise.resolve(),
    getResourceBundle: () => ({ createResourceHandles: () => Promise.resolve(), getResourceHandle: () => 1, destroyResourceHandles: () => Promise.resolve() }),
});
const desc = JSON.parse(fs.readFileSync(path.join(stage, 'source', 'rhmiData', 'application.json'), 'utf8')).application.entryPoints[0];
class OnlineApp extends EventEmitter {
    start() { this.rhmiApplication = rhmi; this.startReason = 'ENTRY_POINT'; return Promise.resolve(); }
    initialized() { setTimeout(play, 300); return Promise.resolve(); }
    registerActive() { return Promise.resolve(); }
    registerInactive() { return Promise.resolve(); }
    registerHmiVisible() { return Promise.resolve(); }
    unregisterHmiVisible() { return Promise.resolve(); }
    getLastExecutedEntryPointUuid() { return desc.uuid; }
    getEntryPoints() {
        return [{ getDescription: () => desc, init: () => Promise.resolve(), entryPoint: { setText() {}, setIcon() {} }, setAvailability: () => Promise.resolve() }];
    }
}
// the HMI's events after the tile opened the page, per scenario (formats the Store's own app handles on both HMIs)
const SCENARIOS = {
    'id7-like': [['stack', { ROOT_APP: [3000] }], ['visible', { visible: true }]],
    'stack-strings': [['stack', { ROOT_APP: ['3000'] }], ['visible', { visible: 1 }]],
    'stack-objects': [['stack', { ROOT_APP: [{ id: 3000 }] }], ['visible', { visible: 'true' }]],
    'visible-first': [['visible', { visible: 1 }], ['stack', { ROOT_APP: ['VIEW'] }]],
    'no-getId': [['visible', { visible: true }], ['stack', { ROOT_APP: [3000] }]],
    'stack-only': [['stack', { ROOT_APP: [] }]],
    'no-renderer': [['visible', { visible: 1 }], ['stack', { ROOT_APP: [3000] }]],
    // the user leaves: a stack without the app, or the page's visible 0
    'left-home': [['visible', { visible: 1 }], ['stack', { ROOT_APP: ['3000'] }], ['wait'], ['stack', { HOME: [1] }]],
    'hidden-event': [['visible', { visible: 1 }], ['wait'], ['visible', { visible: 0 }]],
};
function play() {
    const steps = SCENARIOS[scenario].slice();
    const next = () => {
        const s = steps.shift();
        if (!s) return;
        if (s[0] === 'stack') rhmi.emit('applicationStackChanged', s[1]);
        else if (s[0] === 'visible') view.emit('visible', s[1]);
        setTimeout(next, s[0] === 'wait' ? 1200 : 100);
    };
    next();
}
const real = Module._load;
Module._load = function (req) {
    if (req === 'oap-sdk') return { OnlineApp, logging: { getSDKLogger: () => logger } };
    if (req === 'someip') throw new Error('no someip here');
    return real.apply(this, arguments);
};
require(path.join(stage, 'source', 'javascript', 'app.js'));
setTimeout(() => {
    console.log(JSON.stringify(Object.assign(seen, { log: logs.filter((l) => /display|visible|hidden|front|renderd|stack/i.test(l)).slice(-12) })));
    process.exit(0);
}, scenario === 'left-home' || scenario === 'hidden-event' ? 4500 : scenario === 'no-renderer' ? 10000 : 3000);
