'use strict';
// An iDrive 8 app as the head unit built it (id8_link.js: the source package linked by the MGU Store's own linker),
// started as on the car - its package.json's main, the stock entry point, which runs the linked bundle (the kit's entry
// module kit/id8/boot.js, then the kit and the app) - against a fake oap-sdk whose HMI sends the screen events of a
// scenario and a fake mgu-render socket (mgu-render/1: X_READY, READY 2880 x 960 with touch, TICK, X_STATE). Prints
// what the HMI and the renderer saw as one JSON line: { shows: [SHOW values in order], frames, place, opens, status,
// info: { label: last text }, titles, tile, asked: [modules asked for by name that the car has not], log: [...] }.
// Used by test_mgu8.js:  node kit/tools/mgu8_harness.js <built package> <scenario> [sdk]
//   scenario: the HMI's events once the page was opened (SCENARIOS below)
//   sdk: how the fake oap-sdk starts and answers (the list above class OnlineApp; default 'plain'), after what the
//        MGU Store's app handles on iDrive 8's SDK
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const Module = require('module');
const EventEmitter = require('events');

const [builtIn, scenario, sdk = 'plain'] = process.argv.slice(2);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mgu8-'));
// an installed app's home: source/ (the package), data/, rhmiData/ (the installed description)
const home = path.join(tmp, 'oap_13001');
const source = path.join(home, 'source');
fs.cpSync(builtIn, source, { recursive: true });
fs.mkdirSync(path.join(home, 'data'));
const pkg = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
// (the app's own code broken on purpose: the tile and the page must work without it)
if (sdk === 'kit-broken') fs.writeFileSync(path.join(source, 'app', 'main.js'), "'use strict';\nthrow new Error('broken on purpose');\n");

// ---- the fake renderer
const seen = {
    shows: [], frames: 0, place: null, hello: null, titles: [], info: {}, opens: 0, openTries: 0, initialized: 0, asked: [],
    status: { active: 0, inactive: 0, hmiVisible: 0, hmiInvisible: 0 }, tile: { init: 0, enabled: 0, text: 0, icon: 0, mapped: 0 },
    exit: null, proxies: [],
};
const sock = path.join(tmp, 'render.sock');
const u32 = (type, words) => { const b = Buffer.alloc(8 + words.length * 4); b.writeUInt32LE(type, 0); b.writeUInt32LE(words.length * 4, 4); words.forEach((w, i) => b.writeUInt32LE(w >>> 0, 8 + i * 4)); return b; };
let conn = null, asked = 0, front = 1;
const state = () => { if (conn) conn.write(u32(0x4d520102, [1, asked && front ? 1 : 0, front])); };       // X_STATE: mode, on screen, in front
net.createServer((c) => {
    let buf = Buffer.alloc(0);
    conn = c;
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
                // version, modes (layer), caps (touch, front gate), embed box, app area, largest pixmap, refresh
                c.write(u32(0x4d520101, [1, 1, 1 | 4, 0, 0, 0, 0, 0, 76, 2880, 764, 2048, 60000]));
                c.write(u32(101, [4, 2880, 960, 1]));
            } else if (type === 2) {
                seen.place = { x: p.readInt32LE(0), y: p.readInt32LE(4), w: p.readInt32LE(8), h: p.readInt32LE(12), scale: +p.readFloatLE(16).toFixed(3) };
            } else if (type === 3) {
                asked = p.readUInt32LE(0);
                seen.shows.push(asked);
                state();
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
class Comp extends EventEmitter {
    constructor(n, id) { super(); this.n = n; this.id = id; }
    updateResources() { return Promise.resolve(); }
    getId() { return this.id; }
    setValue(row, cell, value) { if (/_TITLE$/.test(this.n)) seen.titles.push(value); else seen.info[this.n] = value; return Promise.resolve(); }
}
const ui = JSON.parse(fs.readFileSync(path.join(source, 'rhmiData', 'uiDescriptions', 'ID8', 'uiDescription.json'), 'utf8'));
const comps = {};
Object.keys(ui.containers).forEach((cid) => {
    const c = ui.containers[cid];
    comps[c.name] = new Comp(c.name, Number(cid));
    Object.keys(c.components || {}).forEach((id) => { comps[c.components[id].name] = new Comp(c.components[id].name, Number(id)); });
});
const view = comps.VIEW;
if (scenario === 'no-getId') view.getId = undefined;
const rhmi = new EventEmitter();
let refuse = sdk === 'refuse-open' ? 2 : 0;
Object.assign(rhmi, {
    getByName: (n) => comps[n] || null,
    mapEntryState: () => { seen.tile.mapped++; return sdk === 'map-refused' ? Promise.reject(new Error('INVALID_COMPONENTID')) : Promise.resolve(); },
    openEntryState: () => {
        seen.openTries++;
        if (refuse > 0) { refuse--; return Promise.reject(new Error('the HMI is not ready')); }
        seen.opens++;
        setTimeout(play, 150);                                  // the HMI shows the page: its events follow
        return Promise.resolve();
    },
    openState: () => Promise.resolve(),
    closeState: () => Promise.resolve(),
    getResourceBundle: () => ({ createResourceHandles: () => Promise.resolve(), getResourceHandle: () => 1, destroyResourceHandles: () => Promise.resolve() }),
});
const appDesc = JSON.parse(fs.readFileSync(path.join(source, 'rhmiData', 'application.json'), 'utf8'));
const desc = appDesc.application.entryPoints[0];
// the installed rhmiData is left out for 'no-installed-json': the SDK's copy of the description, or the package's, then
fs.mkdirSync(path.join(home, 'rhmiData', 'resources'), { recursive: true });
if (sdk !== 'no-installed-json') fs.writeFileSync(path.join(home, 'rhmiData', 'application.json'), JSON.stringify(appDesc));
/*
 * How the SDK starts and answers:
 *   plain            start() resolves with the screens there, startReason set (a 24.x-like SDK)
 *   event            the 'initialized' event, then start() resolves; the reason only in getVisibilityData(); an 'error'
 *                    event on the way (the SDK reporting a failure of its own); iDrive 8's names (isInitialized)
 *   hang             the 'initialized' event comes, start()'s promise never resolves
 *   late-rhmi        start() resolves first, the screens and the event 1 s later
 *   member           the SDK's modules export { OnlineApp }, { logging }, { someipBuilders } (id8_link.js)
 *   background       started with the platform (autostart, as the Store's deploy tool lists an iDrive 8 app): no entry
 *                    point named; the tile is tapped 1.5 s later ('entryPointExecute')
 *   no-rhmi          a start for no screen: no RHMI application
 *   no-last          started for the tile, but getLastExecutedEntryPointUuid() names none and no execute event comes
 *   refuse-open      the HMI refuses to open the page twice (not an INVALID_ error), then opens it
 *   init-fails       the entry point's init() is refused
 *   map-refused      mapEntryState is refused every time
 *   no-installed-json  no rhmiData/application.json beside the app's source, no description in the SDK
 *   status-throws    the app status calls throw (no status channel on this SDK)
 *   no-logging       the SDK's logging module has no getSDKLogger
 *   kit-broken       the app's own code throws when loaded
 */
const EVENT = ['event', 'hang', 'late-rhmi'].indexOf(sdk) >= 0;
let theApp = null;
class OnlineApp extends EventEmitter {
    constructor() { super(); theApp = this; if (sdk !== 'no-installed-json') this.appDescription = appDesc; }
    start() {
        const up = () => { if (sdk !== 'no-rhmi') this.rhmiApplication = rhmi; };
        if (sdk === 'event' || sdk === 'hang') {
            return new Promise((resolve) => setTimeout(() => {
                up();
                this.isInitialized = true;
                this.emit('error', new Error('joynr: no backend (reported, not fatal)'));
                this.emit('initialized');
                if (sdk === 'event') resolve();
            }, 50));
        }
        if (sdk === 'late-rhmi') { setTimeout(() => { up(); this.emit('initialized'); }, 1000); return Promise.resolve(); }
        up();
        this.startReason = sdk === 'background' ? 'AUTOSTART' : sdk === 'no-rhmi' ? 'CONFIG_STATE' : 'ENTRY_POINT';
        if (sdk === 'background') setTimeout(() => this.emit('entryPointExecute', desc.uuid, 'USER', 'tile'), 1500);
        return Promise.resolve();
    }
    getVisibilityData() { return EVENT ? { reason: 'ENTRY_POINT' } : undefined; }
    initialized() { seen.initialized++; return Promise.resolve(); }
    registerActive() { seen.status.active++; if (sdk === 'status-throws') throw new Error('no app status service'); return Promise.resolve(); }
    registerInactive() { seen.status.inactive++; return Promise.resolve(); }
    registerHmiVisible() { seen.status.hmiVisible++; return Promise.resolve(); }
    unregisterHmiVisible() { seen.status.hmiInvisible++; return Promise.resolve(); }
    getLastExecutedEntryPointUuid() { return sdk === 'no-last' || sdk === 'background' ? undefined : desc.uuid; }
    getEntryPoints() {
        return [{
            getDescription: () => desc,
            init: () => { seen.tile.init++; return sdk === 'init-fails' ? Promise.reject(new Error('EntryPoint2: not available')) : Promise.resolve(); },
            entryPoint: { setText() { seen.tile.text++; }, setIcon() { seen.tile.icon++; } },
            setAvailability: (a) => { if (a === 'ENABLED') seen.tile.enabled++; return Promise.resolve(); },
        }];
    }
    destroyBundles() { return Promise.resolve(); }
}
// the HMI's events once the page is open (formats the Store's own app handles on both HMIs)
const SCENARIOS = {
    'id7-like': [['stack', { ROOT_APP: [3000] }], ['visible', { visible: true }]],
    'stack-strings': [['stack', { ROOT_APP: ['3000'] }], ['visible', { visible: 1 }]],
    'stack-objects': [['stack', { ROOT_APP: [{ id: 3000 }] }], ['visible', { visible: 'true' }]],
    'visible-first': [['visible', { visible: 1 }], ['stack', { ROOT_APP: ['VIEW'] }]],
    'no-getId': [['visible', { visible: true }], ['stack', { ROOT_APP: [3000] }]],
    // the app in front, its stack never with ROOT_APP (0.4.1 hid the page on these)
    'stack-other-keys': [['visible', { visible: true }], ['stack', { APP: [3000] }], ['wait'], ['stack', { APP: [3000], POPUP: [] }]],
    'stack-map': [['visible', { visible: true }], ['stack', new Map([['ROOT_APP', [3000]]])], ['wait'], ['stack', new Map([['OTHER', []]])]],
    // focus events in other shapes: a bare value must not throw, a lost focus comes back
    'focus-shapes': [['visible', { visible: true }], ['focus', true], ['focus', { focus: 0 }], ['focus', { focus: 1 }], ['focus', null]],
    // an HMI that never says "visible": the stack is all there is
    'stack-only': [['stack', { ROOT_APP: [] }]],
    'stack-only-left': [['stack', { ROOT_APP: [3000] }], ['wait'], ['wait'], ['wait'], ['wait'], ['wait'], ['stack', { HOME: [1] }]],
    'no-renderer': [['visible', { visible: 1 }], ['stack', { ROOT_APP: [3000] }]],
    // the user leaves: the page's visible 0; a stack without the app alone hides nothing (the renderer's gate does)
    'left-home': [['visible', { visible: 1 }], ['stack', { ROOT_APP: ['3000'] }], ['wait'], ['stack', { HOME: [1] }]],
    'hidden-event': [['visible', { visible: 1 }], ['wait'], ['visible', { visible: 0 }]],
    'manager-hides': [['visible', { visible: 1 }], ['wait'], ['changeVisibility', { visible: false }]],
    // the renderer's gate does not have the app in front (another app's screen): nothing is drawn, the page says so
    'not-in-front': [['front', 0], ['visible', { visible: 1 }], ['stack', { ROOT_APP: [3000] }]],
    // an uncaught error in the app's process: it runs on, the page says what it was
    'uncaught': [['visible', { visible: 1 }], ['throw']],
};
let played = false;
function play() {
    if (played) return;
    played = true;
    const steps = SCENARIOS[scenario].slice();
    const next = () => {
        const s = steps.shift();
        if (!s) return;
        if (s[0] === 'stack') rhmi.emit('applicationStackChanged', s[1]);
        else if (s[0] === 'visible') view.emit('visible', s[1]);
        else if (s[0] === 'focus') view.emit('focus', s[1]);
        else if (s[0] === 'changeVisibility') theApp.emit('changeVisibility', s[1]);
        else if (s[0] === 'front') { front = s[1]; state(); }
        else if (s[0] === 'throw') setTimeout(() => { throw new Error('boom in a timer'); }, 0);
        setTimeout(next, s[0] === 'wait' ? 1200 : 100);
    };
    next();
}
const typed = (iface) => ({ statusCarSpeed2: { getValue: () => Promise.resolve({ speedVehicleCentreOfGravity: 0 }), subscribe: () => Promise.resolve() },
    statusBattery2: { getValue: () => Promise.resolve({ conditionBatteryChargingCondition: 80 }), subscribe: () => Promise.resolve() }, iface });
// the SDK the linked bundle's modules hand out (id8_link.js), and nothing else by that name: on the car a package
// that asks for a module "oap-sdk" (or the raw SOME/IP binding) finds none
global.__mguFakeSdk = {
    shape: sdk === 'member' ? 'member' : 'direct',
    OnlineApp,
    logging: sdk === 'no-logging' ? {} : { getSDKLogger: () => logger },
    someipBuilders: { buildAndInitTypedProxy: (iface, inst, t) => { seen.proxies.push([iface, inst, typeof t]); return Promise.resolve(typed(iface)); } },
};
const real = Module._load;
Module._load = function (req) {
    if (req === 'oap-sdk' || req === 'someip') {
        seen.asked.push(req);
        const e = new Error("Cannot find module '" + req + "'");
        e.code = 'MODULE_NOT_FOUND';
        throw e;
    }
    return real.apply(this, arguments);
};
process.on('exit', (code) => { if (seen.exit === null && code) process.stdout.write(JSON.stringify({ exit: code, log: logs.slice(-8) }) + '\n'); });
// as the app manager starts it: the package's main, in the app's data folder
process.chdir(path.join(home, 'data'));
require(path.join(source, pkg.main));
const long = ['left-home', 'hidden-event', 'manager-hides', 'stack-other-keys', 'stack-map', 'stack-only-left', 'stack-only'].indexOf(scenario) >= 0;
setTimeout(() => {
    let file = '';
    try { file = fs.readFileSync(path.join(home, 'data', pkg.name + '.log'), 'utf8'); } catch (e) { /* none */ }
    seen.exit = 0;
    console.log(JSON.stringify(Object.assign(seen, {
        log: file.split('\n').filter((l) => /boot:|display|visible|hidden|front|renderd|stack|entry|initialized|OnlineApp|signals|FATAL|ERROR/i.test(l)).slice(-24),
        fatal: file.split('\n').filter((l) => / FATAL /.test(l)),
    })));
    process.exit(0);
}, (scenario === 'stack-only-left' ? 9500 : long ? 6000 : scenario === 'no-renderer' || scenario === 'not-in-front' ? 10000 : 3500) +
    (['late-rhmi', 'no-last', 'refuse-open', 'background'].indexOf(sdk) >= 0 ? 2500 : sdk === 'no-rhmi' ? 3500 : 0));
