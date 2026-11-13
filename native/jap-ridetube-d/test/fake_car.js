'use strict';
/* A stand-in for an iDrive 8 head unit's SOME/IP side, for the tests of sound.js: the audio manager (CommandControl),
 * iDrive 7's MediaPlayer that does not answer, and a DynamicMediaPlayer whose ways are set by the test - what its
 * binding takes as a union and a byte buffer, which places its media engine can read, what starts a playlist, the
 * unit of its time. Everything it is asked is kept in .calls.
 *
 *   const car = fakeCar({ ...ways });  car.sip is the binding (buildProxy); car.write(dir) writes the descriptions.
 */
const fs = require('fs');
const path = require('path');

const DMP = { name: 'dyn', serviceId: 0xb0c0,
    instances: { DynamicMediaPlayerMedia: 1, DynamicMediaPlayerTempMedia: 2, DynamicMediaPlayerTempLumMedia: 3, DynamicMediaPlayerInterrupt: 5, DynamicMediaPlayerOverlay: 6 },
    methods: { addToPlaylist: {}, configureButtonEventForwarding: {}, createPlaylist: {}, getAudioFocus: {}, heartBeat: {}, releaseAudioFocus: {}, removeFromPlaylist: {}, sendButtonEventDirect: {}, setAutoplay: {},
        setCurrentItemPositionAndTime: {}, setMuteState: {}, setPlaybackSpeed: {}, setTime: {}, updatePlaylist: {} },
    fields: { autoPlayStatus: {}, connectionState: {}, currentAudioFocus: {}, currentItemId: {}, currentItemMetadata: {}, currentItemPath: {}, currentItemPosition: {}, currentItemTime: {}, forwardButtons: {}, playerState: {}, repeat: {} },
    events: { buttonEventForward: {}, playbackErrorEvent: {} } };
const CC = { name: 'CommandControl', serviceId: 0xb020, instances: { 1: 1 }, methods: { connect: {}, disconnect: {} }, fields: { listOfMainConnections: {} } };
const MP = { name: 'mp', serviceId: 0xb042, instances: { OapGenericMedia: 0x28 }, methods: { playFile: {}, sendButtonEvent: {}, setTime: {} }, fields: { playerState: {}, currentItemTime: {} }, events: { playbackErrorEvent: {} } };

function fakeCar(ways) {
    const car = Object.assign({
        insts: { DynamicMediaPlayerMedia: true, DynamicMediaPlayerTempMedia: true, DynamicMediaPlayerTempLumMedia: true },
        bornMs: 0,                  // a proxy answers this long after it is made
        clientOk: () => true,       // getAudioFocus: GENERAL_ERROR for another client id
        hbOk: () => true,           // ... BAD_ARGUMENT for another timer
        connectMs: 0,               // connectionState CS_CONNECTED this long after the focus (-1: never)
        needConn: false,            // createPlaylist: CONNECTION_STATE_NOT_VALID while not connected
        union: 'named',             // what the binding takes: 'named' { stringValue }, 'plain', 'typed' { type, value }
        idAs: 'buffer',             // ... as the id: 'buffer' | 'array'
        bad: 'throw',               // another form: 'throw' (the binding) | 'BAD_ARGUMENT' (the service) | 'silent' (taken, empty)
        readable: () => true,       // the media engine can read this FILE_NAME
        unreadable: 'ITEM_UNPLAYABLE', // what it says when it cannot: an error event's name, or 'silent'
        start: 'auto',              // what makes a playlist play: 'auto' | 'pos' | 'play' | 'autoplay' | 'never'
        unit: 'ms', timeEvents: true, total: true, echo: true,
        loseFocusAfter: 0,          // the token stops being valid after this many createPlaylist calls (0: never)
    }, ways || {});
    const calls = car.calls = [];
    const st = car.st = {};            // per instance
    const subs = car.subs = {};        // per instance: name -> fn
    let tokens = 0;
    const emit = (inst, name, v) => { const f = (subs[inst] || {})[name]; if (f) setTimeout(() => f(v), 1); };
    // what the car has connected to its loudspeakers now, for the stand-in sound devices (fake_ytalsa.js): our source
    // by the audio manager ("am"), the source of a dynamic player instance that gave its focus ("focus")
    const tell = () => { if (car.stateFile) fs.writeFileSync(car.stateFile, JSON.stringify({ am: !!(car.conns && car.conns.length), focus: Object.keys(st).filter((i) => st[i].token) })); };
    car.tell = tell;
    car.emit = emit;
    const stopTicks = (s) => { if (s.timer) clearInterval(s.timer); s.timer = null; };
    function begin(inst) {
        const s = st[inst];
        if (!s.canPlay || s.playing) return;
        s.playing = true;
        s.t0 = Date.now();
        emit(inst, 'playerState', 'PLAYER_STATE_PLAY');
        stopTicks(s);
        s.timer = setInterval(() => {
            if (!s.playing || !car.timeEvents) return;
            const ms = s.base + (Date.now() - s.t0);
            emit(inst, 'currentItemTime', { elapsed: car.unit === 's' ? Math.floor(ms / 1000) : ms, total: car.total ? (car.unit === 's' ? 180 : 180000) : 0 });
        }, 40);
        s.timer.unref();
    }
    function halt(inst) {
        const s = st[inst];
        if (s.playing) { s.base += Date.now() - s.t0; s.playing = false; emit(inst, 'playerState', 'PLAYER_STATE_STOP'); }
        stopTicks(s);
    }
    car.sip = { built: [], buildProxy: async (cfg, inst) => {
        car.sip.built.push(cfg.name + '|' + inst);
        const born = Date.now();
        if (cfg.name === 'CommandControl') {
            return { init: async () => {}, isAvailable: async () => true, subscribe() {}, getValue: async (n) => { if (n === 'listOfMainConnections') return (car.conns || []).slice(); throw new Error('Unknown method name \'get:' + n + '\''); },
                callMethod: async (m, a) => {
                    calls.push({ on: 'cc', m: m, a: a });
                    if (m === 'connect') {
                        if (car.amError) return { mainConnectionID: 0, amError: car.amError };
                        car.conns = (car.conns || []).concat([{ mainConnectionID: 40 + calls.length, sourceID: a.sourceID, sinkID: a.sinkID }]);
                        tell();
                        return { mainConnectionID: 40 + calls.length, amError: 'E_OK' };
                    }
                    if (m === 'disconnect') { car.conns = (car.conns || []).filter((c) => c.mainConnectionID !== a.mainConnectionID); tell(); }
                    return { amError: 'E_OK' };
                } };
        }
        if (cfg.name !== 'dyn') {
            return { init: async () => {}, isAvailable: async () => false, subscribe() {}, getValue: async () => { throw new Error('Service unavailable'); },
                callMethod: async (m) => { calls.push({ on: 'mp', m: m }); throw new Error('Service unavailable for call ' + m + '()'); } };
        }
        const s = st[inst] = st[inst] || { token: null, conn: 'CS_DISCONNECTED', playing: false, base: 0, autoplay: false, lists: 0, beats: 0, item: null };
        subs[inst] = subs[inst] || {};
        return { init: async () => {}, isAvailable: async () => !!car.insts[inst] && Date.now() - born >= car.bornMs,
            subscribe: (x) => { if (car.noSub && car.noSub.indexOf(x.name) >= 0) throw new Error('no such event'); subs[inst][x.name] = x.onReceive; },
            getValue: async (n) => {
                if (n === 'connectionState') return s.conn;
                if (n === 'playerState') return s.playing ? 'PLAYER_STATE_PLAY' : 'PLAYER_STATE_STOP';
                if (n === 'currentAudioFocus') return { token: s.token || '', clientId: s.clientId || '', clientName: s.token ? 'RideTube' : '', status: s.token ? 'HAS_FOCUS' : 'HAS_FOCUS' };
                if (n === 'currentItemPosition') return { position: s.item ? 1 : 0, totalNumber: s.item ? 1 : 0 };
                if (n === 'autoPlayStatus') return s.autoplay;
                throw new Error('Unknown method name \'get:' + n + '\'');
            },
            callMethod: async (m, a) => {
                calls.push({ on: 'dyn', inst: inst, m: m, a: a });
                if (m === 'heartBeat') { s.beats++; return {}; }
                if (m === 'getAudioFocus') {
                    if (!car.clientOk(a.clientId)) return { dynMediaPlayerError: 'GENERAL_ERROR', token: '' };
                    if (!car.hbOk(a.timeOutHeartBeatTimer)) return { dynMediaPlayerError: 'BAD_ARGUMENT', token: '' };
                    if (car.nameOk && !car.nameOk(a.clientName, a.clientId)) return { dynMediaPlayerError: 'BAD_ARGUMENT', token: '' };
                    s.token = 'TOK' + (++tokens); s.clientId = a.clientId; s.lists = 0;
                    tell();
                    if (car.connectMs >= 0) setTimeout(() => { if (s.token) { s.conn = 'CS_CONNECTED'; emit(inst, 'connectionState', 'CS_CONNECTED'); } }, car.connectMs);
                    return { dynMediaPlayerError: 'OK', token: s.token };
                }
                if (m === 'setTime') { s.base = car.unit === 's' ? a.newTimeElapsed * 1000 : a.newTimeElapsed; s.t0 = Date.now(); return { entError: 'OK' }; }
                if (a.token !== s.token || !s.token) return { dynMediaPlayerError: 'TOKEN_NOT_VALID' };
                if (m === 'releaseAudioFocus') { halt(inst); s.token = null; s.conn = 'CS_DISCONNECTED'; s.item = null; tell(); return { dynMediaPlayerError: 'OK' }; }
                if (m === 'createPlaylist') {
                    if (!a.newPlaylist.length) { halt(inst); s.item = null; s.base = 0; return { dynMediaPlayerError: 'OK' }; }
                    if (car.needConn && s.conn !== 'CS_CONNECTED') {
                        // (connectOnList: the connection comes a moment after the first playlist was refused for it)
                        if (car.connectOnList) setTimeout(() => { if (s.token) { s.conn = 'CS_CONNECTED'; emit(inst, 'connectionState', 'CS_CONNECTED'); } }, 50);
                        return { dynMediaPlayerError: 'CONNECTION_STATE_NOT_VALID' };
                    }
                    if (car.loseFocusAfter && ++s.lists > car.loseFocusAfter) { s.token = null; return { dynMediaPlayerError: 'TOKEN_NOT_VALID' }; }
                    const it = a.newPlaylist[0], v0 = it.metadata && it.metadata[0] ? it.metadata[0].value : undefined;
                    const idOk = car.idAs === 'buffer' ? Buffer.isBuffer(it.id) : Array.isArray(it.id);
                    let name = null;
                    if (car.union === 'named' && v0 && typeof v0 === 'object' && typeof v0.stringValue === 'string') name = v0.stringValue;
                    else if (car.union === 'plain' && typeof v0 === 'string') name = v0;
                    else if (car.union === 'typed' && v0 && v0.type === 'stringValue' && typeof v0.value === 'string') name = v0.value;
                    if (!idOk || name === null) {
                        if (car.bad === 'throw') throw new Error(!idOk ? 'ByteBuffer: wrong type for "id"' : 'Union: no member matches "value"');
                        if (car.bad === 'BAD_ARGUMENT') return { dynMediaPlayerError: 'BAD_ARGUMENT' };
                        name = '';
                    }
                    halt(inst);
                    s.item = { name: name }; s.base = 0;
                    s.canPlay = !!name && !!car.readable(name);
                    if (car.echo) {
                        emit(inst, 'currentItemId', Buffer.from('id'));
                        emit(inst, 'currentItemMetadata', name ? [{ key: 'FILE_NAME', value: { stringValue: name } }] : [{ key: 'FILE_NAME', value: { stringValue: '' } }]);
                    }
                    if (!s.canPlay && car.unreadable !== 'silent') setTimeout(() => emit(inst, 'playbackErrorEvent', { event: car.unreadable, itemId: Buffer.from('id'), itemTime: 0 }), 15);
                    if (car.start === 'auto') setTimeout(() => begin(inst), 10);
                    return { dynMediaPlayerError: 'OK' };
                }
                if (m === 'setAutoplay') { s.autoplay = !!a.autoplay; return { dynMediaPlayerError: 'OK' }; }
                if (m === 'setCurrentItemPositionAndTime') {
                    if (s.item && a.newPosition === 1) { s.base = car.unit === 's' ? a.newTimeElapsed * 1000 : a.newTimeElapsed; s.t0 = Date.now(); if (car.start === 'pos') begin(inst); }
                    return { dynMediaPlayerError: s.item ? 'OK' : 'GENERAL_ERROR' };
                }
                if (m === 'sendButtonEventDirect') {
                    if (a.action === 'PRESS' && a.button === 'PLAY' && (car.start === 'play' || (car.start === 'autoplay' && s.autoplay) || (s.item && s.wasPlaying))) begin(inst);
                    if (a.action === 'PRESS' && (a.button === 'STOP' || a.button === 'PAUSE')) { s.wasPlaying = s.playing; halt(inst); }
                    return { dynMediaPlayerError: 'OK' };
                }
                return { dynMediaPlayerError: 'OK' };
            } };
    } };
    /* The descriptions a head unit has, in dir (the test's src-gen). */
    car.write = (dir, dmp) => {
        fs.writeFileSync(path.join(dir, 'org_genivi_am_commandinterface_CommandControl.json'), JSON.stringify(CC));
        fs.writeFileSync(path.join(dir, 'de_bmw_infotainment_entertainment_mediaplayer_MediaPlayer.json'), JSON.stringify(MP));
        if (dmp !== false) fs.writeFileSync(path.join(dir, 'de_bmw_infotainment_entertainment_dynamicmediaplayer_DynamicMediaPlayer.json'), JSON.stringify(dmp || DMP));
    };
    car.dyn = (m) => calls.filter((c) => c.on === 'dyn' && c.m !== 'heartBeat' && (!m || c.m === m));
    car.stop = () => Object.keys(st).forEach((i) => stopTicks(st[i]));
    return car;
}

module.exports = { fakeCar: fakeCar, DMP: DMP };
