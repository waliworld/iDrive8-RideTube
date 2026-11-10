'use strict';
/*
 * The entry module of a kit app on iDrive 8 (MGU ID8), the only module the head unit links.
 *
 * Why: the MGU Store's deploy tool gives an app BMW's oap-sdk in two ways. On iDrive 7 it generates the module
 * node_modules/oap-sdk for a package that asks for it. On iDrive 8 it does not: there it only builds source
 * packages (mgu-app.json), linking the modules they list against the oap-sdk of an app already on the car - the way
 * the Store's own app and IterioDev's apps are installed. A package of the first kind installs on iDrive 8, gets its
 * tile, and ends at its first line that loads the SDK: the tile greys out when tapped and nothing opens (RideTube
 * 0.4.0 to 0.4.2). So on iDrive 8 the app is a source package with this one module; the kit and the app's own code
 * are plain files beside it (<package>/app/), loaded from here with the SDK handed over (kit/sdk.js).
 *
 * What it does is the lifecycle of the MGU Store's app (robertnisipeanu/mgu-store, apps/robertn_store/src/store.js,
 * class Store, GPL-3.0-or-later), which runs on iDrive 7 and 8, written again for the kit:
 *   - an OnlineApp subclass; the work starts at the SDK's 'initialized' event (or when start() resolved);
 *   - no RHMI application for this start: initialized() and nothing else;
 *   - else the page's updateResources(), the tile the manager hands over (init, mapped to the page, ENABLED; its
 *     name and icon stay the manager's), ACTIVE on a foreground start, initialized(), then the entry point the app
 *     was started with is opened; 'entryPointExecute' (the tile tapped while the app runs) opens it too;
 *   - 'shutdown': the bundles go, then the process.
 * None of it waits for the app's own code or fails with it: the kit is loaded in between (its handlers must be on the
 * page before it opens), inside try / catch, and its start is not awaited. Every step is tried on its own and timed.
 *
 * What went on is in the app's log (<data>/<id>.log, lines "boot: ...") and on the HMI's own page, which the drawn
 * screen covers while it works: the page's first status line (build.py's <SCREEN>_INFO1) is written here.
 *
 * Linked on the head unit (Node 8: no newer syntax). It may require only Node's own modules and the three SDK names
 * of mgu-app.json; anything else is loaded with a computed path.
 */
const fs = require('fs');
const path = require('path');
const sdkOnlineApp = require('oap-sdk/src/core/OnlineApp.js');
const sdkLogging = require('oap-sdk/src/logging/logging');
const sdkBuilders = require('oap-sdk/src/someip/someipBuilders');

// a module's export, or its member of that name (the two shapes the deploy tool's linker knows of an SDK module)
const pick = (m, name) => (m && m[name] ? m[name] : m);
const OnlineApp = pick(sdkOnlineApp, 'OnlineApp');
const logging = pick(sdkLogging, 'logging');
const someipBuilders = pick(sdkBuilders, 'someipBuilders');

/* ---------------- where things are ---------------- */
// the linked bundle is <source>/javascript/app.js; the app's data folder is beside <source>
const HERE = typeof __dirname === 'string' ? __dirname : '/var/opt/public/oap/oap_' + process.getuid() + '/source/javascript';
const SOURCE = path.join(HERE, '..');
const APP_ROOT = path.join(SOURCE, '..');
const DATA = path.join(APP_ROOT, 'data');
const RUNTIME = path.join(SOURCE, 'app');
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } };
const SPEC = readJson(path.join(RUNTIME, 'kit', 'app-spec.json')) || {};
const PKG = readJson(path.join(SOURCE, 'package.json')) || {};
const ID = SPEC.id || PKG.name || 'app';
const VERSION = SPEC.version || PKG.version || '?';
const TITLE = SPEC.title || ID;
const PAGE = (SPEC.screens && SPEC.screens[0] && SPEC.screens[0].name) || 'VIEW';

/* ---------------- log ---------------- */
const LOG_FILE = path.join(DATA, ID + '.log');
let sdkLog = null;
try { sdkLog = logging && logging.getSDKLogger ? logging.getSDKLogger() : null; } catch (e) { /* the file is the log */ }
const text = (e) => String(e && e.message ? e.message : e).replace(/\s+/g, ' ').slice(0, 160);
const stack = (e) => String((e && e.stack) || e);
function say(level, msg) {
    try {
        let size = 0;
        try { size = fs.statSync(LOG_FILE).size; } catch (e) { /* no file yet */ }
        if (size > 256 * 1024) fs.renameSync(LOG_FILE, LOG_FILE + '.1');
        fs.appendFileSync(LOG_FILE, new Date().toISOString() + ' ' + level + ' boot: ' + msg + '\n');
    } catch (e) { /* no data folder */ }
    try {
        const fn = sdkLog && sdkLog[level === 'ERROR' || level === 'FATAL' ? 'error' : level === 'WARN' ? 'warn' : 'info'];
        if (fn) fn.call(sdkLog, ID + ': boot: ' + msg);
    } catch (e) { /* the file has it */ }
}

/* ---------------- what happened, for the page and the kit ---------------- */
// start: the start reason; entry: the tile; open: the page; kit: the app's own code; error: the last failure
const facts = { start: '?', entry: 'not registered yet', open: 'not asked', opens: 0, kit: 'not loaded yet', error: null };
const handlers = {};
const api = {
    app: null, facts, id: ID, version: VERSION, dataDir: DATA,
    /** 'front' (the page is about to open), 'opened', 'hidden' (the manager: the app left the screen), 'shutdown' */
    on(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); },
    log: say,
};
function emit(ev, a) {
    (handlers[ev] || []).forEach((fn) => { try { fn(a); } catch (e) { say('ERROR', ev + ' handler: ' + stack(e)); } });
}
const failed = (what, e) => { facts.error = what + ': ' + text(e); say('ERROR', what + ': ' + stack(e)); };
// an error anywhere in the process is logged and shown; the app runs on (a process that ends leaves a tile that
// opens nothing, and the manager wipes the data of an app that keeps ending)
process.on('uncaughtException', (e) => { try { failed('uncaught', e); showFacts(); } catch (x) { /* nothing left to say it with */ } });
process.on('unhandledRejection', (e) => { try { say('ERROR', 'unhandled rejection: ' + stack(e)); } catch (x) { /* as above */ } });

/* ---------------- the page's first status line ---------------- */
let host = null, stopping = false;
const written = {};
function label(name, value) {
    const rhmi = host && host.rhmiApplication;
    const s = String(value).replace(/[^\x20-\x7e]/g, '?').slice(0, 230);
    if (!rhmi || written[name] === s) return;
    try {
        const c = rhmi.getByName(name);
        if (!c) return;
        written[name] = s;
        Promise.resolve(c.setValue(0, 'Text', s, 'Text')).catch(() => { written[name] = null; });
    } catch (e) { /* no such label on this page */ }
}
function showFacts() {
    label(PAGE + '_INFO1', TITLE + ' ' + VERSION + ' for iDrive 8: running | start: ' + facts.start + ' | tile: ' + facts.entry +
        ' | page: ' + facts.open + ' | app: ' + facts.kit + (facts.error ? ' | error: ' + facts.error : ''));
    // the app's own code is not there to say more: the second line and the title say so
    if (facts.kit === 'failed') {
        label(PAGE + '_INFO2', 'The app\'s own code did not load (' + (facts.loadError || 'see its log') + '). Please send a photo of this screen.');
        label(PAGE + '_TITLE', TITLE + ' - did not load');
    }
}

/* ---------------- steps that cannot hold the start up ---------------- */
// true when fn's promise resolved; a refusal is logged with what it was
const soft = (what, fn) => Promise.resolve().then(fn).then(() => true, (e) => { say('WARN', what + ': ' + text(e)); return false; });
// p, or after ms whatever it had (the HMI not answering must not keep initialized() from being called)
const within = (what, p, ms) => {
    let timer;
    return Promise.race([
        Promise.resolve(p),
        new Promise((res) => { timer = setTimeout(() => { say('WARN', what + ' still pending after ' + ms + ' ms, going on'); res(); }, ms); }),
    ]).catch((e) => say('WARN', what + ': ' + text(e))).then(() => clearTimeout(timer));
};

/* ---------------- the lifecycle ---------------- */
// start reasons that put the app on screen (the Store's _startedForeground)
const FOREGROUND = ['ENTRY_POINT', 'LUM', 'BOOKMARK', 'START_WIDGET', 'TRIGGER_HMI', 'SPEECH_COMMAND'];
function startReason() {
    let d = null;
    try { d = typeof host.getVisibilityData === 'function' ? host.getVisibilityData() : null; } catch (e) { /* not on this SDK */ }
    return String((d && d.reason) || host.startReason);
}
// the tile's uuid as the app's description names it (the SDK's copy, else the installed file)
function describedEntryPoints() {
    let list = [];
    try { list = (host.appDescription && host.appDescription.application && host.appDescription.application.entryPoints) || []; } catch (e) { /* below */ }
    if (!list.length) {
        const d = readJson(path.join(APP_ROOT, 'rhmiData', 'application.json')) || readJson(path.join(SOURCE, 'rhmiData', 'application.json'));
        list = (d && d.application && d.application.entryPoints) || [];
    }
    return list.map((e) => e && e.uuid).filter(Boolean);
}

let entryUuid = null, mapped = false, page = null;
/* The manager inserts the tile from application.json and hands it to the app at start (the Store's
 * _registerEntryPoints): init, mapped to the page, ENABLED. Each step on its own: one the HMI refuses does not
 * leave the others undone. */
async function registerEntryPoint() {
    const uuids = describedEntryPoints();
    let eps = [];
    try { eps = typeof host.getEntryPoints === 'function' ? host.getEntryPoints() || [] : []; } catch (e) { say('WARN', 'entry points: ' + text(e)); }
    const uuidOf = (ep) => { try { return ep.getDescription().uuid; } catch (e) { return null; } };
    const ours = eps.filter((ep) => ep && uuids.indexOf(uuidOf(ep)) >= 0)[0];
    if (!ours) {
        // without the SDK's object the mapping alone still lets a tap open the page
        entryUuid = uuids[0] || null;
        facts.entry = 'none handed over by the manager';
        say('WARN', 'no entry point handed over by the manager (' + eps.length + ' there, ' + uuids.length + ' described)');
        if (entryUuid && page) mapped = await soft('map entry state', () => host.rhmiApplication.mapEntryState(entryUuid, page));
        return;
    }
    entryUuid = uuidOf(ours);
    const init = await soft('entry point init', () => ours.init());
    mapped = page ? await soft('map entry state', () => host.rhmiApplication.mapEntryState(entryUuid, page)) : false;
    const on = await soft('entry point ENABLED', () => ours.setAvailability('ENABLED'));
    facts.entry = (init ? 'init ' : 'init failed ') + (mapped ? 'mapped ' : 'not mapped ') + (on ? 'enabled' : 'not enabled');
    say('INFO', 'entry point ' + entryUuid + ': ' + facts.entry);
}

let opening = null;
/* Open the page of entry point uuid (the Store's _onEntryPointExecute); a refusal is asked again, 0.8 s apart. */
function open(uuid, tries) {
    if (stopping || !host.rhmiApplication || !uuid) return Promise.resolve();
    if (opening) return opening;            // the manager can send the same tap twice
    let again = false;
    emit('front');
    opening = Promise.resolve()
        // (a mapping the HMI refused at the start is tried again; the manager's own may hold without it)
        .then(() => (mapped || !page ? null : soft('map entry state', () => host.rhmiApplication.mapEntryState(uuid, page)).then((ok) => { mapped = ok; })))
        .then(() => host.rhmiApplication.openEntryState(uuid))
        .then(() => {
            facts.open = 'opened'; facts.opens++;
            say('INFO', 'entry state opened');
            emit('opened');
        }, (e) => {
            facts.open = 'refused (' + text(e).slice(0, 60) + ')';
            again = (tries || 1) > 1;
            say('WARN', 'open entry state: ' + text(e) + (again ? ' - asked again' : ''));
        })
        .then(() => {
            opening = null;
            showFacts();
            if (again) setTimeout(() => open(uuid, tries - 1), 800);
        });
    return opening;
}

/* The kit and the app's own code: plain files of the package, loaded with the SDK handed over. A failure is logged
 * and shown on the page; the tile and the page work without it.
 * Handed over through the kit's own module (kit/sdk.js give), which Node's module cache keeps one of, and not through
 * a global: on the car this bundle's "global" is not the one the package's files see (0.4.3 set the SDK there, and
 * the kit, loaded a line later, did not find it). */
function loadApp() {
    try {
        require(path.join(RUNTIME, 'kit', 'sdk.js')).give({ OnlineApp, logging, someipBuilders }, api);
        require(path.join(RUNTIME, 'main.js'));
        facts.kit = 'loaded';
        say('INFO', 'the app is loaded');
    } catch (e) {
        facts.kit = 'failed';
        facts.loadError = text(e);
        failed('the app did not load', e);
    }
}

let started = false;
async function appInitialized(how) {
    if (started) return;
    started = true;
    facts.start = startReason();
    const rhmi = host.rhmiApplication;
    say('INFO', 'SDK started (' + how + '), start reason ' + facts.start + (rhmi ? '' : ', no RHMI application'));
    if (!rhmi) {
        // a start for no screen: answered, and nothing else (the Store does the same)
        facts.entry = 'no RHMI application for this start'; facts.kit = 'not loaded (no screen for this start)';
        await soft('initialized', () => host.initialized());
        return;
    }
    const foreground = FOREGROUND.indexOf(facts.start) >= 0;
    try { page = rhmi.getByName(PAGE); } catch (e) { page = null; }
    if (!page) failed('the HMI has no page ' + PAGE + ' of this app', 'nothing can open');
    else await within('host page resources', soft('host page resources', () => page.updateResources()), 4000);
    loadApp();
    showFacts();
    await within('entry point', registerEntryPoint(), 6000);
    // ACTIVE before initialized(), on a start for the screen (the Store's order)
    if (foreground) soft('registerActive', () => host.registerActive());
    await soft('initialized', () => host.initialized());
    say('INFO', 'initialized (' + (foreground ? 'foreground' : 'background') + ' start)');
    showFacts();
    let last = null;
    try { last = host.getLastExecutedEntryPointUuid ? host.getLastExecutedEntryPointUuid() : null; } catch (e) { say('WARN', 'last entry point: ' + text(e)); }
    if (last) open(last, 6);
    // started for the tile, yet no entry point named and no execute event either: our own, a moment later
    else if (['ENTRY_POINT', 'BOOKMARK', 'LUM'].indexOf(facts.start) >= 0 && entryUuid) {
        setTimeout(() => { if (!facts.opens && !opening) { say('WARN', 'started for the tile without an entry point named: opening our own'); open(entryUuid, 6); } }, 1500);
    }
}

function shutdown(reason) {
    if (stopping) return;
    stopping = true;
    say('INFO', 'shutdown requested by the app manager' + (reason ? ' (' + text(reason) + ')' : ''));
    emit('shutdown', reason);
    Promise.race([
        Promise.resolve().then(() => (typeof host.destroyBundles === 'function' ? host.destroyBundles() : null)).catch((e) => say('INFO', 'destroyBundles: ' + text(e))),
        new Promise((res) => setTimeout(res, 1500)),
    ]).then(() => process.exit(0));
}

class Host extends OnlineApp {
    constructor() {
        super();
        this.on('initialized', () => appInitialized('initialized event').catch((e) => failed('start failed', e)));
        this.on('entryPointExecute', (uuid, reason, name) => {
            say('INFO', 'entry point ' + (name || uuid) + (reason ? ' (' + reason + ')' : ''));
            open(uuid || entryUuid, 4);
        });
        this.on('changeVisibility', (d) => { if (d && d.visible === false) { say('INFO', 'changeVisibility false'); emit('hidden'); } });
        this.on('shutdown', (reason) => shutdown(reason));
        // (without a listener Node throws an 'error' event, and the app would end on what the SDK only reports)
        this.on('error', (e) => say('WARN', 'OnlineApp error: ' + text(e)));
    }
}

say('INFO', ID + ' ' + VERSION + ' starting (uid ' + (process.getuid ? process.getuid() : '?') + ', node ' + process.version + ')');
host = api.app = new Host();
const facts1s = setInterval(showFacts, 1000);
if (facts1s.unref) facts1s.unref();
// a failed start is logged and the process stays, so the manager can stop or restart it (the Store's)
Promise.resolve().then(() => host.start()).then(() => {
    if (started) return;
    if (host.rhmiApplication) { appInitialized('start() returned').catch((e) => failed('start failed', e)); return; }
    // start() back before the screens are there: the event or the screens, 3 s at most
    const t0 = Date.now();
    const wait = setInterval(() => {
        if (started) { clearInterval(wait); return; }
        if (!host.rhmiApplication && Date.now() - t0 < 3000) return;
        clearInterval(wait);
        appInitialized('start() returned').catch((e) => failed('start failed', e));
    }, 250);
}, (e) => failed('OnlineApp start failed', e));
