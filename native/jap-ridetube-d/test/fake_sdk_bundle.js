'use strict';
/* A browserify bundle shaped like an installed app's, for the tests of sdkread.js: an app module, an SDK-like player
 * class (our own code, written in the manner of a TypeScript build: __importDefault, a logger from a logging module,
 * a state service, a proxy from a builder that needs the native SOME/IP binding) and its helpers.
 *   bundle({ minified, idAs: 'buffer' | 'array' | 'uint8', union: 'wrapped' | 'typed' | 'plain', brokenLogging, loggerThrows, noClass, asyncProxy }) -> text
 *   bundle({ id8: true, noTypeMap, byHandlers }): the class (byHandlers: its init fails against stand-ins and
 *   subscribes to nothing - only its own handlers of the focus and the connection move it on) in the manner iDrive 8's apps were seen to have it - made with
 *   { instance, clientName, lumOptions }, an item id of four bytes that carries a number made of the app's logging id
 *   and a type per player instance (a static map), the focus asked with timer 0 for the entertainment instances, an
 *   init and a connect, the start of a playlist an arrow function set in the constructor. */

const PRELUDE = '(function(){function r(e,n,t){function o(i,f){if(!n[i]){if(!e[i]){var c="function"==typeof require&&require;' +
    'if(!f&&c)return c(i,!0);if(u)return u(i,!0);var a=new Error("Cannot find module \'"+i+"\'");throw a.code="MODULE_NOT_FOUND",a}' +
    'var p=n[i]={exports:{}};e[i][0].call(p.exports,function(r){var n=e[i][1][r];return o(n||r)},p,p.exports,r,e,n,t)}' +
    'return n[i].exports}for(var u="function"==typeof require&&require,i=0;i<t.length;i++)o(t[i]);return o}return r})()';
const PRELUDE_MIN = '!function(){return function r(e,n,t){function o(i,f){if(!n[i]){if(!e[i]){var c="function"==typeof require&&require;' +
    'if(!f&&c)return c(i,!0);if(u)return u(i,!0);var a=new Error("Cannot find module \'"+i+"\'");throw a.code="MODULE_NOT_FOUND",a}' +
    'var p=n[i]={exports:{}};e[i][0].call(p.exports,function(r){var n=e[i][1][r];return o(n||r)},p,p.exports,r,e,n,t)}' +
    'return n[i].exports}for(var u="function"==typeof require&&require,i=0;i<t.length;i++)o(t[i]);return o}}()';

function bundle(o) {
    o = o || {};
    const id = o.idAs === 'array' ? 'counter += 1; return [0, 0, counter >> 8, counter & 255];'
        : o.idAs === 'uint8' ? 'counter += 1; return new Uint8Array([0, 0, counter >> 8, counter & 255]);'
            : 'counter += 1; const b = Buffer.alloc(4); b.writeUInt32BE(counter, 0); return b;';
    const str = o.union === 'typed' ? '{ type: "stringValue", value: v }' : o.union === 'plain' ? 'v' : '{ stringValue: v }';
    const num = o.union === 'typed' ? '{ type: "numeric", value: v }' : o.union === 'plain' ? 'v' : '{ numeric: v }';
    const player = `
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) { return (mod && mod.__esModule) ? mod : { "default": mod }; };
Object.defineProperty(exports, "__esModule", { value: true });
const events_1 = require("events");
const util = require("util");
const SDKError_1 = __importDefault(require("../errors/SDKError"));
const logging = require("../logging/logging");
const someipBuilders_1 = require("../someip/someipBuilders");
const StateService_1 = __importDefault(require("./StateService"));
const logger = logging.getSDKLogger();
const HEARTBEAT_TIMEOUT = 5;
const WATCHDOG = 30000;
const check = (r) => { if (!r || r.dynMediaPlayerError !== "OK") throw new SDKError_1.default("the player said " + (r && r.dynMediaPlayerError)); return r; };
const asString = (v) => (${str});
const asNumber = (v) => (${num});
let counter = 0;
class MediaPlayerImpl extends events_1.EventEmitter {
    constructor(instance, app) {
        super();
        this.instance = instance;
        this.app = app;
        this.cachedPlaylist = [];
        this.stateService = new StateService_1.default((s) => this.emit("stateChanged", s));
        ${o.asyncProxy ? 'someipBuilders_1.buildProxyLater("DynamicMediaPlayer", instance).then((p) => { this.mediaPlayerProxy = p; });' : 'this.mediaPlayerProxy = someipBuilders_1.buildProxy("DynamicMediaPlayer", instance);'}
    }
    get publicState() { return this.stateService.state; }
    get state() { return this.publicState; }
    connect() {
        logger.info(\`MediaPlayerImpl(\${this.instance}) connect\`);
        this.mediaPlayerProxy.subscribe({ name: "connectionState", onReceive: (v) => { if (v === "CS_CONNECTED") this.stateService.send("eConnected"); } });
        this.mediaPlayerProxy.subscribe({ name: "playerState", onReceive: (v) => { this.mediaPlayerState = v; if (v === "PLAYER_STATE_PLAY") this.stateService.send("ePlaying"); } });
        this.watchdog = setTimeout(() => this.stateService.send("eTimeout"), WATCHDOG);
        return this.mediaPlayerProxy.getAudioFocus({ clientId: this.app.getAppId(), clientName: this.app.name, timeOutHeartBeatTimer: HEARTBEAT_TIMEOUT })
            .then(check).then((r) => { this.cachedToken = r.token; this.startHeartbeat(); this.stateService.send("eConnecting"); });
    }
    startHeartbeat() { this.heartbeatTimer = setInterval(() => this.mediaPlayerProxy.heartBeat({ token: this.cachedToken }), 2000); }
    generateItemId() { ${id} }
    playlistConverter(list, start) {
        return list.map((item, i) => {
            const metadata = [{ key: "FILE_NAME", value: asString(item.fileName) }];
            (item.metadata || []).forEach((m) => metadata.push({ key: m.key, value: typeof m.value === "number" ? asNumber(m.value) : asString(String(m.value)) }));
            return { pos: start + i, id: item.id, metadata };
        });
    }
    createPlaylist(list, mediaType) {
        const what = \`MediaPlayerImpl(\${this.instance})[\${this.publicState}]::createPlaylist\`;
        if (["Disconnected", "Disconnecting", "Connecting"].includes(this.publicState) || !this.cachedToken) return SDKError_1.default.reject(\`\${what} - not allowed now\`);
        this.mediaType = mediaType;
        const withIds = list.map((e) => Object.assign({}, e, { id: this.generateItemId() }));
        logger.info(\`\${what} with \${util.inspect(withIds, { depth: 5 })}\`);
        return this.mediaPlayerProxy.createPlaylist({ token: this.cachedToken, newPlaylist: this.playlistConverter(withIds, 1) }).then(check).then(() => { this.cachedPlaylist = withIds; });
    }
    playFile(file, startTime, mediaType, size) {
        this.fileToPlay = file; this.startTime = startTime; this.mediaType = mediaType;
        this.stateService.send("ePlay");
        const item = { fileName: file };
        if (size) item.metadata = [{ key: "FILE_SIZE", value: size }];
        return this.createPlaylist([item], mediaType)
            .then(() => this.mediaPlayerProxy.setCurrentItemPositionAndTime({ token: this.cachedToken, newPosition: 1, newTimeElapsed: startTime })).then(check);
    }
    sendButtonEvent(button) {
        return this.mediaPlayerProxy.sendButtonEventDirect({ token: this.cachedToken, button, action: "PRESS" }).then(check)
            .then(() => new Promise((r) => setTimeout(r, 100)))
            .then(() => this.mediaPlayerProxy.sendButtonEventDirect({ token: this.cachedToken, button, action: "RELEASE" })).then(check);
    }
    disconnect() { clearInterval(this.heartbeatTimer); return this.mediaPlayerProxy.releaseAudioFocus({ token: this.cachedToken }).then(check); }
}
exports.default = MediaPlayerImpl;
`;
    const player8 = `
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) { return (mod && mod.__esModule) ? mod : { "default": mod }; };
Object.defineProperty(exports, "__esModule", { value: true });
const events_1 = require("events");
const SDKError_1 = __importDefault(require("../errors/SDKError"));
const logging = require("../logging/logging");
const someipBuilders_1 = require("../someip/someipBuilders");
const StateService_1 = __importDefault(require("./StateService"));
const logger = logging.getSDKLogger();
const check = (r) => { if (!r || r.dynMediaPlayerError !== "OK") throw new SDKError_1.default("the player said " + (r && r.dynMediaPlayerError)); return r; };
class MediaPlayerImpl extends events_1.EventEmitter {
    constructor(options) {
        super();
        this.instance = options.instance;
        this.clientName = options.clientName;
        this.lumEnabled = !!(options.lumOptions && options.lumOptions.enabled === true);
        this.appId = logging.appId();
        this.convertedLoggingId = logging.convertLoggingId(logging.loggingId());
        this.heartBeatTimeoutMs = 8000;
        this.heartBeatIntervalMs = 2000;
        this.cachedPlaylist = [];
        this.stateService = new StateService_1.default((s) => this.emit("stateChanged", s));
        this.mediaPlayerProxy = someipBuilders_1.buildProxy("DynamicMediaPlayer", this.instance);
        this.audioManagerProxy = someipBuilders_1.buildProxy("CommandControl", "1");
        this.startPlaybackWithPlayItem = (position, time) => this.mediaPlayerProxy.setCurrentItemPositionAndTime({ token: this.cachedToken, newPosition: position, newTimeElapsed: time }).then(check)
            .then(() => this.mediaPlayerProxy.sendButtonEventDirect({ token: this.cachedToken, button: "PLAY", action: "PRESS" })).then(check).then(() => this.setSoundProperty());
    }
    setSoundProperty() { logger.info("setSoundProperty"); return this.audioManagerProxy.setMainSinkSoundProperty({ sinkID: 1024, soundProperty: { type: "SP_AVSYNC_TARGET", value: this.mediaType === "Video" ? 1 : 0 } }); }
    get publicState() { return this.stateService.state; }
    get state() { return this.publicState; }
    init() {
        ${o.byHandlers ? 'return this.subscriptions.ready.catch(() => {});' : `this.mediaPlayerProxy.subscribe({ name: "connectionState", onReceive: (v) => this.handleConnectionStateChange(v) });
        this.mediaPlayerProxy.subscribe({ name: "playerState", onReceive: (v) => { if (v === "PLAYER_STATE_PLAY") this.stateService.send("ePlaying"); } });
        return Promise.resolve();`}
    }
    handleCurrentAudioFocusChange(f) { this.focusIsOurs = !!f && f.token === this.cachedToken && f.status === "HAS_FOCUS"; }
    handleConnectionStateChange(v) { if (v === "CS_CONNECTED" && ${o.byHandlers ? 'this.focusIsOurs' : 'true'}) this.stateService.send("eConnected"); }
    connect() { this.stateService.send("eConnecting"); return this.getAudioFocus(); }
    getAudioFocus() {
        logger.info(\`MediaPlayerImpl(\${this.instance}) getAudioFocus\`);
        return this.mediaPlayerProxy.getAudioFocus({ clientId: this.appId, clientName: this.clientName || this.appId, timeOutHeartBeatTimer: ["Entertainment", "EntertainmentTemp", "EntertainmentTempLum"].includes(this.instance) ? 0 : this.heartBeatTimeoutMs })
            .then(check).then(({ token }) => { this.cachedToken = token; return this.mediaPlayerProxy.setAutoplay({ token, autoplay: this.lumEnabled }); }).then(check);
    }
    generateItemId() {
        const type = MediaPlayerImpl.sourceToItemTypeMap[this.instance], count = MediaPlayerImpl.itemIdCounter++ % 65536;
        return (Math.floor(this.convertedLoggingId / 256) << 28) + (type << 24) + (this.convertedLoggingId % 256 << 16) + count;
    }
    playlistItemConverter(item, pos) {
        const id = Buffer.alloc(4);
        id.writeInt32BE(item.id | 0, 0);
        const metadata = (item.metadata || []).map((m) => ({ key: m.key, value: { numeric: m.value } }));
        metadata.push({ key: "ITEM_ID", value: { id } });
        metadata.push({ key: "FILE_NAME", value: { stringValue: item.fileName } });
        return { id, metadata, pos };
    }
    playlistConverter(list, start) { return list.map((item, i) => this.playlistItemConverter(item, start + i)); }
    setPlaylist(list, mediaType) {
        this.mediaType = mediaType;
        const withIds = list.map((e) => Object.assign({}, e, { id: e.id === undefined ? this.generateItemId() : e.id }));
        return this.mediaPlayerProxy.createPlaylist({ token: this.cachedToken, newPlaylist: this.playlistConverter(withIds, 1) }).then(check).then(() => { this.cachedPlaylist = withIds; });
    }
    playFile(file, startTime, mediaType, size) {
        if (this.publicState !== "Connected") throw new SDKError_1.default(\`MediaPlayerImpl(\${this.instance})[\${this.publicState}] - command ePlay not allowed\`);
        this.stateService.send("ePlay");
        const item = { fileName: file };
        if (size) item.metadata = [{ key: "FILE_SIZE", value: size }];
        return this.setPlaylist([item], mediaType).then(() => this.startPlaybackWithPlayItem(1, startTime));
    }
}
MediaPlayerImpl.itemIdCounter = 0;
${o.noTypeMap ? '' : 'MediaPlayerImpl.sourceToItemTypeMap = { Entertainment: 1, EntertainmentTemp: 2, EntertainmentTempLum: 3, Interrupt: 5 };'}
exports.default = MediaPlayerImpl;
`;
    const logging8 = 'const path = require("path"); const dlt = require("dlt-native");' +
        ' let id; try { id = path.basename(path.dirname(process.argv[1])); } catch (e) { dlt.log(2, `Could not determine the appID due to ${e}`); id = "unknown"; }' +
        ' exports.appId = () => id; exports.loggingId = () => "OA15"; exports.convertLoggingId = (text) => parseInt(String(text).slice(1), 16);' +
        ' exports.getSDKLogger = () => ({ info: (m) => dlt.log(4, m), error: (m) => dlt.log(2, m) });';
    if (o.id8) {
        const mods8 = [
            [1, 'const mp = require("./MediaPlayerImpl"); class VideoView { play() { const e = this.mediaRepository.getVideoPath(this.message.uuid); return this.onlineApp.registerAudioFocus().then(() => this.mediaPlayer.playFile(e, 0, "Video")); } } module.exports = [mp, VideoView];', '{"./MediaPlayerImpl":3}'],
            [3, player8, '{"events":undefined,"../errors/SDKError":4,"../logging/logging":5,"../someip/someipBuilders":6,"./StateService":7}'],
            [4, '"use strict"; class SDKError extends Error { static reject(m) { return Promise.reject(new SDKError(m)); } } exports.default = SDKError; exports.__esModule = true;', '{}'],
            [5, logging8, '{"path":undefined,"dlt-native":undefined}'],
            [6, 'const someip = require("someip"); exports.buildProxy = (name, inst) => someip.buildProxy(name, inst);', '{"someip":undefined}'],
            [7, '"use strict"; const NEXT = { Disconnected: { eConnecting: "Connecting" }, Connecting: { eConnected: "Connected" }, Connected: { ePlay: "Starting" }, Starting: { ePlaying: "Playing" }, Playing: {} };' +
                ' class StateService { constructor(on) { this.state = "Disconnected"; this.on = on; } send(ev) { const n = (NEXT[this.state] || {})[ev]; if (n) { this.state = n; this.on(n); } } } exports.default = StateService; exports.__esModule = true;', '{}'],
            [8, 'class MediaRepository { getVideoPath(uuid) { return this.root + "/media/" + uuid + ".mp4"; } } module.exports = MediaRepository;', '{}'],
        ];
        return PRELUDE + '({' + mods8.map((m) => m[0] + ':[function(require,module,exports){\n' + m[1] + '\n},' + m[2] + ']').join(',') + '},{},[1]);\n';
    }
    const mods = [
        [1, 'const mp = require("oap-sdk/src/media/mediaplayer"); const fs = require("fs"); fs.writeFileSync("/tmp/rt-test-must-not-exist", "the app ran"); module.exports = mp;', '{"oap-sdk/src/media/mediaplayer":2,"fs":undefined}'],
        [2, '"use strict"; const MediaPlayerImpl_1 = require("./MediaPlayerImpl"); class HmiMediaPlayerImpl { constructor(a, b) { this.player = new MediaPlayerImpl_1.default(a, b); } } exports.HmiMediaPlayerImpl = HmiMediaPlayerImpl;', '{"./MediaPlayerImpl":3}'],
        [3, o.noClass ? 'exports.nothing = 1;' : player, '{"events":undefined,"util":undefined,"../errors/SDKError":4,"../logging/logging":5,"../someip/someipBuilders":6,"./StateService":7}'],
        [4, '"use strict"; class SDKError extends Error { static reject(m) { return Promise.reject(new SDKError(m)); } } exports.default = SDKError; exports.__esModule = true;', '{}'],
        [5, o.loggerThrows ? 'exports.getSDKLogger = () => { throw new Error("the logger needs the car"); };' : o.brokenLogging ? 'const dlt = require("dlt-native"); dlt.register("OAP"); throw new Error("no DLT daemon here");'
            : 'const dlt = require("dlt-native"); exports.getSDKLogger = () => ({ info: (m) => dlt.log(4, m), error: (m) => dlt.log(2, m), verbose() {} });', '{"dlt-native":undefined}'],
        [6, 'const someip = require("someip"); const fs = require("fs"); exports.buildProxy = (name, inst) => someip.buildProxy(JSON.parse(fs.readFileSync("/etc/x.json")), inst); exports.buildProxyLater = (name, inst) => someip.buildProxyAsync(name, inst);', '{"someip":undefined,"fs":undefined}'],
        [7, '"use strict"; const NEXT = { Disconnected: { eConnecting: "Connecting" }, Connecting: { eConnected: "Connected" }, Connected: { ePlay: "Starting" }, Starting: { ePlaying: "Playing" }, Playing: {} };' +
            ' class StateService { constructor(on) { this.state = "Disconnected"; this.on = on; } send(ev) { const n = (NEXT[this.state] || {})[ev]; if (n) { this.state = n; this.on(n); } } } exports.default = StateService; exports.__esModule = true;', '{}'],
    ];
    const map = '({' + mods.map((m) => m[0] + ':[function(require,module,exports){\n' + m[1] + '\n},' + m[2] + ']').join(',') + '},{},[1]);\n';
    return (o.minified ? PRELUDE_MIN : PRELUDE) + map;
}

module.exports = { bundle: bundle };
