'use strict';
/**
 * RideTube - search and play videos through the car daemon jap-ridetube-d (ytd.js, a root service), which
 * fetches them on the car itself, plays the sound through BMW's own media player (the car's audio source)
 * and decodes the picture (ytdec) into
 * /dev/shm/mgu-video-ridetube, which the renderer (mgu-render) draws in this app's layer (op 19).
 *
 * Screens (a TV-style dark look: navy, neon pink and cyan, big 16:9 tiles):
 *   VIEW  (first) drawn page. Browsing: an icon rail on the left (Search = the HMI menu, Home, Subscriptions,
 *         Watch later; the page shown lit, a pink mark) and, right of it, rows of tiles: a 320 x 180
 *         thumb (its length in a pill), the title in up to two lines, "channel · 125K views · 1 day ago".
 *           home     shelves, each titled, turned sideways on their own: Continue watching, the account's
 *                    Home shelves (daemon `feed` shelves; an older daemon: its flat list as a grid), Watch later
 *           subs     the account's Subscriptions shelves (or the flat list as a grid)
 *           wl / results   a grid, four a row: Watch later, a search's results
 *           Not signed in, on a feed page: the sign-in card, a QR code for google.com/device and the code to
 *           enter there (the daemon's TV device sign-in: it keeps the account, the app never sees a token).
 *           The page scrolls (a finger, the controller turned on the page); the controller pushed or turned onto
 *           a tile brings it into view (ctx.onPageFocus), the arrows at a shelf's edges turn it for a finger.
 *           Thumbs are asked only for the tiles drawn, and drawn from a pool of 56 picture ids.
 *           player   where the kit runs the screen: the video over the whole screen (no header, no bar), under
 *                    the overlay: back to the list and the title / channel (top), -10 s, play / pause,
 *                    +10 s (middle), the progress bar with the times (bottom). A tap or the controller shows
 *                    it; it hides 4 s later while the picture plays (a tap beside the controls hides it at once);
 *                    preparing, paused, driving or no picture: it stays, with the "Preparing... N %" ring.
 *                    The controller pushed left goes back to the list (the HMI's BACK key closes the screen).
 *                    Where the HMI runs the screen: the video in a box under the header, over the HMI's bar.
 *         bar: none where the kit runs the screen (the rail and the overlay have its jobs; a "Playing" rail entry
 *         while something plays), so the pages reach the screen's bottom. Where the HMI runs the screen: all five
 *         (Play/Pause, -10 s, +10 s, the list / Now playing, Search), and the header has the page tabs (G.frame).
 *   MAIN  HMI menu (Search): the HMI's speller, Now playing, Results, Home, Subscriptions, Watch later, recent
 *         searches / suggestions, then Sign in / Sign out (pressed twice).
 *
 * iDrive 8 (built with kit/tools/build.py --hmi ID8, its own app jap_ridetube8): the HMI has only the empty host page
 * of VIEW; the kit runs the whole screen (touch only, its own back button) on a wider page (PAGE.w 2080: five tiles a
 * row). Search opens the kit's on-screen keyboard (recent searches as chips; typing only while parked), and the
 * rail's last entry, Settings, opens a card with the account (Sign in / Sign out) and the settings sheet.
 *
 * Video only while parked (kit parked.js), unless the "Video while driving" setting is on (for a car coded
 * for video in motion): driving off turns the picture off (daemon `video off`,
 * renderer DROP_VIDEO), the sound plays on; parked again, it comes back. The app stays ACTIVE
 * while hidden as long as sound plays (ctx.background), because closing the socket stops playback.
 * Never exits: every handler logs its errors.
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const QR = require('./kit/qr');
const { setImage } = require('./kit/record');
const { HMI, PAGE, ID8 } = require('./kit/display');
const { listSheet, cardSheet, textSheet } = require('./kit/sheet');
const { keyboardSheet } = require('./kit/keyboard');
const Parked = require('./kit/parked');
const { Ctl, Model, clock, SOCKET, FEEDS, SHELF_MAX } = require('./yt');
const { spell } = require('./speller');

const W = PAGE.w, H = PAGE.h;                             // 1600 x 520 (iDrive 8: 2080 x 520)
const BOX = { x: 12, y: 38, w: W - 24, h: 432 };         // the video, in the page's visible part (y 38..520)
const VID = 1, VPATH = process.env.MGU_YT_VIDEO || '/dev/shm/mgu-video-ridetube';     // (env: tests)
const POOL0 = 8, POOL = 56;                               // picture ids POOL0.. for the thumbs drawn (a pool, by video)
const TOP = 38;                                          // the page shows from here down (the kit: y 38..520 + extra)
const RAIL_W = 116;                                      // the icon rail, x 12..116
const X0 = 136, TW = 320, TH = 180, PITCH = 348;          // tiles: 16:9 thumbs, four a row, the fifth peeking
const PER_ROW = Math.floor((W - X0 - TW) / PITCH) + 1;      // (4; iDrive 8's wider page: 5, the sixth peeking)
const TILE_H = TH + 98, HEAD_H = 50, SHELF_GAP = 30, GRID_GAP = 22;   // a tile with its text; a shelf's title row
const OVERLAY_MS = 4000;                                 // the player's controls hide this long after a tap (playing)
const SEARCH_MS = 8000;                                  // a search with no answer by then is an error on screen
const SUGGEST = ['Music', 'News', 'Cars', 'Podcasts', 'Comedy', 'Trailers'];
const SLOTS = ['BTN_S1', 'BTN_S2', 'BTN_S3', 'BTN_S4', 'BTN_S5', 'BTN_S6'];
const TABS = ['home', 'subs', 'wl'];
const NAMES = { home: 'Home', subs: 'Subscriptions', wl: 'Watch later', results: 'Results' };
const FEED_MS = 15000;                                   // a feed with no answer by then is an error on screen
const SIGNIN_URL = 'https://www.google.com/device';

process.on('uncaughtException', (e) => { try { mgu.log.error('uncaught', e); } catch (x) { /* nothing left to log with */ } });

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const parked = Parked.watch(ctx, log, { strict: true });
        // the drive lock: Video while driving counts only once switched on while parked, so a press while moving
        // cannot bring the picture up; switching it off works at once
        let videoDrivingOk = false;
        const noVideo = () => {
            const on = settings.get('video_driving') === true, moving = parked.moving();
            videoDrivingOk = moving ? videoDrivingOk && on : on;
            return moving && !videoDrivingOk;
        };

        /* ---------- the daemon ---------- */
        const ctl = new Ctl(process.env.MGU_YT_SOCKET || SOCKET, log);
        const model = new Model((o) => ctl.send(o));
        let mode = 'home', browse = 'home', dirty = true;   // browse: the list the player goes back to
        const changed = () => { dirty = true; if (ctx.background) ctx.background('playing', model.active()); labels(); };
        const isFeed = (m) => FEEDS.indexOf(m) >= 0;
        // a feed tab: signed in, (re)load it; signed out, ask for a sign-in code (the daemon says the one shown again).
        // A new device flow starts only from here (show), the account button or the page's "tap" - never on its own
        const openFeed = () => {
            if (!isFeed(mode)) return;
            if (model.auth.state !== 'signed_in') { model.authStart(); return; }
            model.feed(mode);
            if (mode === 'home') model.feed('wl');
            if (mode === 'subs') model.loadChannels();                    // Home's last shelf (one request at a time: idempotent)
        };
        const backKey = {};                              // page -> the tile the controller was on when it was left
        function show(m) {
            if (m !== mode) { dirty = true; if (laid.mode === mode && laid.where[focusKey]) backKey[mode] = focusKey; }   // (a tile of this page)
            mode = m;
            if (m !== 'player') browse = m; else wake();
            openFeed(); sync(); labels();
        }
        function goBack(m) {
            show(m);
            if (backKey[m] && ctx.focus) ctx.focus(backKey[m]);
        }
        // (iDrive 8: the service's state among the page's status lines, read when the drawn screen does not come)
        const service = () => { if (ctx.status) ctx.status('Service (jap-ridetube-d): ' + (ctl.up ? 'connected' : 'not answering - is the RideTube service installed? (the Store, Tools)')); };
        ctl.on('up', () => { model.setConnected(true); changed(); service(); });
        ctl.on('down', () => { model.setConnected(false); changed(); service(); });
        service();
        ctl.on('msg', (m) => {
            model.onMsg(m);
            if (m.ev === 'error') log.warn('jap-ridetube-d: ' + m.msg);
            if (m.ev === 'state') log.info('jap-ridetube-d: ' + m.state + (m.id ? ' ' + m.id : ''));
            if (m.ev === 'auth') { log.info('jap-ridetube-d: account ' + m.state); if (m.state === 'signed_in') openFeed(); }
            changed();
        });
        ctl.connect();

        /* ---------- hidden channels (a channel page's Hide), members-only videos (a setting) ---------- */
        const HIDDEN = path.join(ctx.dataDir, 'hidden.json');
        let hidden = [];
        try { hidden = JSON.parse(fs.readFileSync(HIDDEN, 'utf8')).filter((s) => typeof s === 'string'); } catch (e) { /* none yet */ }
        function toggleHidden(name) {
            hidden = hidden.indexOf(name) >= 0 ? hidden.filter((x) => x !== name) : hidden.concat(name);
            try { fs.writeFileSync(HIDDEN, JSON.stringify(hidden)); } catch (e) { log.warn('hidden: ' + e.message); }
            dirty = true;
        }
        // what Home, Subscriptions, Watch later and Search show (a channel's own page shows all)
        const shown = (items) => items.filter((r) => hidden.indexOf(r.channel) < 0 && !(r.members && !settings.get('members')));

        /* ---------- searches: recent first, then suggestions ---------- */
        const RECENT = path.join(ctx.dataDir, 'recent.json');
        let recent = [];
        try { recent = JSON.parse(fs.readFileSync(RECENT, 'utf8')).filter((s) => typeof s === 'string').slice(0, SLOTS.length); } catch (e) { /* none yet */ }
        const slots = () => recent.concat(SUGGEST.filter((s) => recent.indexOf(s) < 0)).slice(0, SLOTS.length);
        const showSlots = () => slots().forEach((s, i) => ui.text(SLOTS[i], s));
        function search(q) {
            q = String(q || '').trim();
            if (!q) return;
            recent = [q].concat(recent.filter((s) => s.toLowerCase() !== q.toLowerCase())).slice(0, SLOTS.length);
            try { fs.writeFileSync(RECENT, JSON.stringify(recent)); } catch (e) { log.warn('recent: ' + e.message); }
            showSlots();
            model.search(q);               // (not sent: the results screen says why)
            show('results');
            ui.open('VIEW');
        }
        // the keyboard: the HMI's speller (MAIN's Search), or on iDrive 8 the kit's (recent searches as chips; typing
        // only while parked, as the HMI's own speller does it)
        const typingLocked = () => parked.moving();
        function openSearch() {
            if (!ID8) { ui.open('MAIN'); return; }
            const ok = ctx.sheet(keyboardSheet({ title: 'Search', hint: 'Search videos', action: 'Search', chips: slots,
                locked: typingLocked, lockedText: 'Typing works when parked - or pick a recent search', onDone: (q) => search(q) }));
            if (!ok) log.warn('search: the keyboard needs the GPU renderer (mgu-render)');
        }
        ui.onClick('BTN_SEARCH', () => spell(ctx.app, 'Search videos')
            .then((t) => search(t))
            .catch((e) => { log.error('speller', e); ui.text('MAIN_INFO', 'The keyboard did not open: ' + (e.message || e)); }));
        SLOTS.forEach((b, i) => ui.onClick(b, () => search(slots()[i])));
        ui.onClick('BTN_NOW', () => { show('player'); ui.open('VIEW'); });
        ui.onClick('BTN_RESULTS', () => { show('results'); ui.open('VIEW'); });
        [['BTN_HOME', 'home'], ['BTN_SUBS', 'subs'], ['BTN_WL', 'wl']].forEach(([b, m]) => ui.onClick(b, () => { show(m); ui.open('VIEW'); }));
        // Sign in: the Home tab shows how (after a failed try, asks again). Sign out: pressed twice within 5 s
        let signOutArmed = null;
        ui.onClick('BTN_ACCOUNT', () => {
            if (model.auth.state !== 'signed_in') { show('home'); model.authStart(true); ui.open('VIEW'); return; }
            if (!signOutArmed) { signOutArmed = setTimeout(() => { signOutArmed = null; labels(); }, 5000); labels(); return; }
            clearTimeout(signOutArmed); signOutArmed = null;
            model.signOut();
            labels();
        });
        showSlots();

        function info() {
            let s;
            if (!model.connected) s = 'The RideTube service (jap-ridetube-d) is not running';
            else if (model.searchError) s = 'Search: ' + model.searchError;
            else if (model.error) s = 'Error: ' + model.error;
            else if (model.active()) s = (model.state === 'preparing' ? 'Preparing ' + Math.round(model.pct) + ' %: ' : model.state === 'paused' ? 'Paused: ' : 'Playing: ') + model.title;
            else s = 'Search, or pick a recent search below';
            ui.text('MAIN_INFO', s);
        }
        info();
        setInterval(() => { try { model.checkSearch(Date.now(), SEARCH_MS); model.checkFeeds(Date.now(), FEED_MS); if (ui.isVisible('MAIN')) info(); } catch (e) { log.error('info', e); } }, 1000);

        /* ---------- playing ---------- */
        // the decoder's picture size. Full-screen layout: the whole screen, for the full view (ytdec fits, or
        // fills when that crops at most 15 %; the fill setting, on by default, always crops); the player draws the same frame
        // smaller (op 19 fits it into its box). The daemon has no rect change, so the size is the full view's
        // from the start. Else the box in screen pixels.
        function rect() {
            const pl = ctx.display && ctx.display.place, s = (pl && pl.scale) || 1;
            const even = (v, max) => Math.min(max, Math.max(16, Math.round(v / 2) * 2));
            // iDrive 8: the app area is 2880 x 764, wider than ytdec's 2048 and than any video: a 16:9 frame as tall
            // as the area (op 19 fits it, centred), so nothing is decoded only to be shown smaller
            if (pl && pl.full && ID8) return even(Math.min(2048, pl.h * 16 / 9), 2048) + 'x' + even(pl.h, 2048);
            if (pl && pl.full) return even(pl.w, 2048) + 'x' + even(pl.h, 2048);
            return even(BOX.w * s, 1920) + 'x' + even(BOX.h * s, 720);
        }
        // it: the tile tapped (its title and channel show while the video is prepared)
        // list: the row it was picked from; the videos after it play next when one ends (autoplay)
        const QUALITIES = ['auto', '720', '480', '360'];   // app.json's Video quality values, in the button's order
        let queue = [], nextAt = 0;
        function play(id, it, list) {
            show('player');
            if (list) { const i = list.findIndex((r) => r.id === id); queue = list.slice(i + 1).filter((r) => r && !r.act && /^[\w-]{11}$/.test(r.id)); }
            nextAt = 0;
            if (model.id === id && model.active()) return;
            model.play(id, rect(), settings.get('fill') !== false, it, { quality: settings.get('quality'), skip: sbSkip() });
        }
        // from render: ended with a next one -> 5 s to see what comes, then it plays (back to the list cancels)
        function autoNext() {
            if (model.state !== 'ended' || !queue.length || mode !== 'player') { nextAt = 0; return null; }
            if (!nextAt) { nextAt = Date.now() + 5000; wake(); }
            if (Date.now() < nextAt) return queue[0];
            const r = queue.shift();
            play(r.id, r);
            return null;
        }
        let lastPlay = null, lastList = null, lastAcct = null;
        function labels() {
            const p = model.state === 'playing' ? 'Pause' : 'Play';
            if (p !== lastPlay) { lastPlay = p; ui.text('BTN_PLAY', p); }
            const l = mode === 'player' ? NAMES[browse] : model.active() ? 'Now playing' : 'Player';
            if (l !== lastList) { lastList = l; ui.text('BTN_LIST', l); }
            const a = model.auth.state !== 'signed_in' ? 'Sign in' : signOutArmed ? 'Press again to sign out' : 'Sign out';
            if (a !== lastAcct) { lastAcct = a; ui.text('BTN_ACCOUNT', a); }
        }
        // iDrive 8: the rail's Settings - the account (sign in, sign out pressed twice) and the settings sheet
        let menuArmed = 0;
        function openMenu() {
            const signedIn = () => model.auth.state === 'signed_in';
            ctx.sheet(cardSheet({
                title: 'Settings', heading: 'RideTube',
                subtitle: () => (!model.connected ? 'The RideTube service (jap-ridetube-d) is not running' : signedIn() ? 'Signed in on the car' : 'Not signed in'),
                rows: () => [['Account', signedIn() ? 'Signed in' : 'Signed out'], ['Now playing', model.active() ? model.title || model.id : 'Nothing'],
                    ['Version', mgu.SPEC.version]],
                note: 'Unofficial client for YouTube · Skip data: SponsorBlock (sponsor.ajay.app), CC BY-NC-SA 4.0',
                actions: () => [
                    signedIn()
                        ? { label: menuArmed > Date.now() ? 'Press again to sign out' : 'Sign out', color: '#ff6b6b', run: () => {
                            if (menuArmed > Date.now()) { menuArmed = 0; model.signOut(); return 'close'; }
                            menuArmed = Date.now() + 5000;
                            return null;
                        } }
                        : { label: 'Sign in', run: () => { show('home'); model.authStart(true); return 'close'; } },
                    { label: 'Diagnostics', run: () => { openDiag(); return null; } },
                ].concat(model.snd ? [{ label: 'Sound: start over', run: () => { model.soundReset(); return 'close'; } }] : [], [
                    { label: 'Settings', primary: true, run: () => { ctx.sheet(listSheet(settings, null, { version: mgu.SPEC.version })); return null; } },
                ]),
            }));
        }
        // Settings > Diagnostics: what the app and its service say about this head unit, as pages of text to read or
        // photograph (a car has no log to send). The service's part is asked when the page opens and on Refresh.
        let diagMemo = null;
        function diagLines() {
            const g = ctx.display && ctx.display.gpu, dg = model.diag;
            const key = [model.connected, dg && dg.t, model.state, model.error, parked.moving(), parked.speed() === null, g && g.ready].join('|');
            if (diagMemo && diagMemo.key === key) return diagMemo.lines;
            const lines = ['RideTube app ' + mgu.SPEC.version + (mgu.SPEC.hmi ? ' (' + (mgu.SPEC.hmi === 'ID8' ? 'iDrive 8' : mgu.SPEC.hmi) + ')' : '') +
                ' | service: ' + (model.connected ? 'connected' : 'NOT RUNNING') + ' | player: ' + model.state + (model.error ? ' | last error: ' + model.error : '')];
            lines.push('Screen: ' + (!g ? 'no GPU renderer' : (g.ready ? 'renderer connected' : 'renderer not connected') + (g.path ? ' ' + g.path : '') +
                (g.screen ? ', ' + g.screen.w + 'x' + g.screen.h : '') + (g.native ? ', mgu-render/1' : g.iterio ? ', IterioDev dialect' : '')) +
                ' | car: ' + (parked.moving() ? 'moving' : 'standing') + ' (speed ' + (parked.speed() === null ? 'not read' : Math.round(parked.speed()) + ' km/h') + ')');
            if (!model.connected) lines.push('The RideTube service (jap-ridetube-d) does not answer: install or update "RideTube service" in the Store (Tools), then restart the head unit.');
            else if (!dg) lines.push('Asking the RideTube service...');
            else dg.lines.forEach((l) => lines.push(l));
            diagMemo = { key, lines };
            return lines;
        }
        function openDiag() {
            model.diag = null;
            model.askDiag();
            ctx.sheet(textSheet({ title: 'Diagnostics', heading: 'RideTube diagnostics', lines: diagLines,
                actions: [{ label: 'Refresh', run: () => { model.diag = null; model.askDiag(); return null; } }] }));
        }
        ui.onClick('BTN_PLAY', () => model.toggle());
        ui.onClick('BTN_RW', () => model.skip(-10000));
        ui.onClick('BTN_FF', () => model.skip(10000));
        ui.onClick('BTN_LIST', () => show(mode === 'player' ? browse : 'player'));
        if (ctx.onTab) ctx.onTab((i) => { if (TABS[i]) show(TABS[i]); });
        ui.onClick('BTN_FIND', () => openSearch());
        // where the kit runs the screen: no bar at all (the rail and the player's overlay do its jobs), so the
        // pages reach the screen's bottom; the HMI's own screen keeps all five
        if (ctx.hideButton) ['BTN_PLAY', 'BTN_RW', 'BTN_FF', 'BTN_LIST', 'BTN_FIND'].forEach((b) => ctx.hideButton(b, true));
        labels();

        /* ---------- the player's overlay (where the kit runs the screen): shown on a tap or the controller ---------- */
        // the knob turned on the progress bar: 10 s a detent, one seek once it rests 350 ms (the bar moves at once)
        let pend = 0, pendT = null;
        function turnSeek(d) {
            if (model.state !== 'playing' && model.state !== 'paused') return;
            pend += d * 10000; wake();
            clearTimeout(pendT);
            pendT = setTimeout(() => { const ms = pend; pend = 0; model.skip(ms); dirty = true; }, 350);
        }
        const shownAt = () => Math.max(0, Math.min(model.total > 0 ? model.total : Infinity, model.elapsed + pend));
        // preparing: its percentage, or the network lost and the daemon trying again
        const prepText = () => (model.retry ? 'No connection - trying again (' + model.retry + ')...' : model.note ? model.note : 'Preparing... ' + Math.round(model.pct || 0) + ' %');
        // a failed play: Try again (the same video, the queue kept)
        const again = () => { if (model.id) play(model.id, model.item(model.id)); };
        /* ---------- SponsorBlock: per category Skip, a Skip button (ask) or Off (Settings) ---------- */
        const SB = [['sponsor', 'sponsor'], ['selfpromo', 'self-promotion'], ['interaction', 'subscribe reminder'], ['intro', 'intro'], ['outro', 'end cards'], ['music_offtopic', 'non-music part']];
        const sbMode = (cat) => settings.get('sb_' + cat) || 'off';
        const sbSkip = () => SB.map((c) => c[0]).filter((c) => sbMode(c) === 'skip');
        const sbName = (cat) => (SB.find((c) => c[0] === cat) || [0, 'segment'])[1];
        const sbSegs = (ex) => ex.segments.filter((g) => sbMode(g[2]) !== 'off');
        const sbColor = (g) => (sbMode(g[2]) === 'ask' ? '#ffd400' : '#00d400');
        // the segment the clock is in whose category asks: its Skip button shows (and the overlay stays)
        function askSeg() {
            const ex = model.extras && model.extras.id === model.id ? model.extras : null, t = shownAt();
            if (!ex || (model.state !== 'playing' && model.state !== 'paused')) return null;
            return ex.segments.find((g) => sbMode(g[2]) === 'ask' && t >= g[0] && t < g[1] - 1000) || null;
        }
        const sbJump = (g) => () => model.skip(g[1] - shownAt());

        /* ---------- the 12 V battery while parked: a warning 5 points above the setting's level, paused below it ---------- */
        let soc = null, socWarned = false;
        Promise.resolve(ctx.signals.watch('de.bmw.infotainment.vehicle.CDS', '1', {
            statusBattery2: (v) => { const k = v && v.conditionBatteryChargingCondition; if (typeof k === 'number' && k > 0 && k <= 100) soc = k; },
        }, log, { pollMs: 10000 })).catch((e) => log.warn('battery: ' + e));
        function batteryGuard() {
            const lim = Number(settings.get('battery'));
            if (!lim || soc === null) return;
            if (soc >= lim + 5) socWarned = false;
            if (parked.moving() || model.state !== 'playing') return;          // driving charges it
            if (soc < lim) {
                model.toggle();
                model.toast = { text: '12 V battery at ' + soc + ' % - paused. Start the car to keep watching', until: Date.now() + 15000, warn: true };
            } else if (soc < lim + 5 && !socWarned) {
                socWarned = true;
                model.toast = { text: '12 V battery at ' + soc + ' % - it pauses at ' + lim + ' %', until: Date.now() + 8000, warn: true };
            } else return;
            wake(); changed();
        }
        setInterval(() => { try { batteryGuard(); } catch (e) { log.error('battery', e); } }, 1000);
        let ovUntil = 0, qrUntil = 0;   // qrUntil: the On phone QR card shows until then
        function wake() { ovUntil = Date.now() + OVERLAY_MS; dirty = true; }
        // it stays while there is no moving picture to look at
        const pinned = () => model.state !== 'playing' || !videoShown || noVideo() || !!askSeg();
        const overlay = () => pinned() || Date.now() < ovUntil || Date.now() < qrUntil;
        // a tap beside the controls (no target): hides them
        if (ctx.onTap) ctx.onTap(() => { if (mode === 'player' && !pinned() && overlay()) { ovUntil = 0; dirty = true; } });
        // the controller pushed left in the player: back to the list it came from; pushed left at a channel's
        // edge (the rail): back to Subscriptions. Both put the controller back on the tile it left from
        if (ctx.onBack) ctx.onBack((edge) => {
            if (mode === 'player') { goBack(browse); return true; }
            if (mode === 'channel' && edge) { goBack(chanFrom); return true; }
            return false;
        });

        /* ---------- video gate: on screen and parked; else off (sound plays on) ---------- */
        let ino = null, videoShown = false;
        const gpu = () => (ctx.display && ctx.display.gpu && ctx.display.gpu.rich ? ctx.display.gpu : null);
        function sync() {
            const shown = ui.isVisible('VIEW') && (!ui.hasFocus || ui.hasFocus('VIEW'));
            const want = mode === 'player' && shown && !noVideo();
            model.setWantVideo(want);
            // the file ytdec writes; a new one (ytdec restarted) is named to the renderer again
            let cur = null;
            if (want && (model.state === 'playing' || model.state === 'paused')) {
                try { const st = fs.statSync(VPATH); cur = st.isFile() ? st.ino : null; } catch (e) { cur = null; }
            }
            const g = gpu();
            if (g) {
                if (!cur || cur !== ino) g.dropVideo(VID);
                if (cur) g.video(VID, VPATH);
            }
            ino = cur;
            const on = !!(cur && g);
            if (on !== videoShown) { videoShown = on; dirty = true; }
        }
        setInterval(() => { try { sync(); } catch (e) { log.error('sync', e); } }, 250);
        ui.onVisible((name, v) => { if (name === 'VIEW') { sync(); dirty = true; } });
        if (ui.onFocus) ui.onFocus(() => sync());
        if (ctx.onLayout) ctx.onLayout(() => { dirty = true; });

        /* ---------- drawing ---------- */
        const fit = (cv, s, size, w, opts) => {
            s = String(s || '');
            if (cv.textWidth(s, size, opts) <= w) return s;
            let lo = 0, hi = s.length;
            while (lo < hi) { const m = (lo + hi + 1) >> 1; if (cv.textWidth(s.slice(0, m) + '…', size, opts) <= w) lo = m; else hi = m - 1; }
            return s.slice(0, lo).replace(/\s+$/, '') + '…';     // (no trimEnd on the unit's Node 8)
        };
        const LIT = { literal: true }, LITB = { literal: true, font: 'bold' };
        const C = { bg: '#0b0f1e', card: '#1a2038', ph: '#232a46', text: '#f1f3ff', dim: '#a4abc8', red: '#ff3f8e', cyan: '#3ad6ff', amber: '#ffd36b' };   // red: the accent (neon pink)
        const browsing = () => mode !== 'player';

        // thumbs: a pool of picture ids by video, least recently drawn reused (the renderer holds 64 pictures an app)
        const pool = new Map(), free = Array.from({ length: POOL }, (_, i) => POOL0 + i);
        let frameNo = 0;
        function slot(id, th) {
            let e = pool.get(id);
            if (!e) {
                let pid = free.pop();
                if (pid === undefined) {
                    let old = null;
                    pool.forEach((x, k) => { if (x.t < frameNo && (!old || x.t < pool.get(old).t)) old = k; });
                    if (!old) return null;                 // all drawn in this frame already
                    pid = pool.get(old).pid; pool.delete(old);
                }
                pool.set(id, e = { pid, th: null, t: 0 });
            }
            if (e.th !== th) { e.th = th; setImage(e.pid, th.w, th.h, th.buf); }
            e.t = frameNo;
            return e.pid;
        }

        // a title in at most two lines of TW px (the second one ellipsised), cached by title
        const wraps = new Map();
        function wrap(cv, s) {
            let v = wraps.get(s);
            if (v) return v;
            const words = s.split(/\s+/).filter(Boolean);
            let l1 = '', i = 0;
            for (; i < words.length; i++) { const t = l1 ? l1 + ' ' + words[i] : words[i]; if (cv.textWidth(t, 24, LITB) > TW) break; l1 = t; }
            let rest = words.slice(i).join(' ');
            if (!l1 && rest) {                           // one word wider than the tile: cut it
                let n = rest.length;
                while (n > 1 && cv.textWidth(rest.slice(0, n), 24, LITB) > TW) n--;
                l1 = rest.slice(0, n); rest = rest.slice(n);
            }
            v = rest ? [l1, fit(cv, rest, 24, TW, LITB)] : [l1];
            if (wraps.size > 400) wraps.clear();
            wraps.set(s, v);
            return v;
        }
        if (ctx.onLayout) ctx.onLayout(() => wraps.clear());          // (text widths follow the scale)

        // a play triangle pointing right, centred on cx, cy, s px tall
        const tri = (cv, cx, cy, s, c) => cv.quad([[cx - s * 0.38, cy - s / 2], [cx + s * 0.5, cy], [cx - s * 0.38, cy + s / 2], [cx - s * 0.38, cy - s / 2]], c);
        // Try again: a circle arrow (cv.arc's ring, its head at the top)
        const retryGlyph = (cv, cx, cy, r, c) => { cv.arc(cx, cy, r - 5, r, 40, 340, c); cv.quad([[cx - 4, cy - r - 9], [cx + 10, cy - r + 2], [cx - 4, cy - r + 12], [cx - 4, cy - r - 9]], c); };
        // RideTube's mark: a cyan screen outline with the pink play mark in it
        const logo = (cv, cx, cy, w) => { cv.strokeRoundRect(cx - w / 2, cy - w * 0.33, w, w * 0.66, w * 0.16, Math.max(3, Math.round(w * 0.06)), C.cyan); tri(cv, cx + w * 0.04, cy, w * 0.32, C.red); };

        /* the left rail: Search, Home, Subscriptions, Watch later */
        const RAIL = [
            ['search', 'Search', (cv, x, y, c) => { cv.arc(x - 4, y - 4, 9, 12.5, 0, 360, c); cv.line(x + 4.5, y + 4.5, x + 14, y + 14, 4.5, c); }],
            ['home', 'Home', (cv, x, y, c, bg) => {
                cv.quad([[x, y - 18], [x + 19, y - 1], [x - 19, y - 1], [x, y - 18]], c);
                cv.fillRect(x - 13, y - 3, 26, 19, c); cv.fillRect(x - 4, y + 6, 8, 10, bg);
            }],
            ['subs', 'Subscriptions', (cv, x, y, c, bg) => {
                cv.roundRect(x - 11, y - 18, 22, 3, 1.5, c); cv.roundRect(x - 15, y - 12, 30, 3, 1.5, c);
                cv.roundRect(x - 18, y - 6, 36, 24, 5, c); tri(cv, x + 1, y + 6, 12, bg);
            }],
            ['wl', 'Watch later', (cv, x, y, c) => { cv.arc(x, y, 14, 17.5, 0, 360, c); cv.line(x, y + 1, x, y - 9, 3.5, c); cv.line(x, y, x + 7, y + 5, 3.5, c); }],
        ];
        // while something plays: back to the player (the bar's Now playing, where the kit runs the screen)
        const PLAYING = ['player', 'Playing', (cv, x, y, c) => { [10, 20, 14].forEach((h, k) => cv.roundRect(x - 15 + k * 11, y + 8 - h, 8, h + 8, 2, c)); }];
        // iDrive 8 (no HMI menu): the account and the settings (three sliders)
        const MORE = ['more', 'Settings', (cv, x, y, c, bg) => {
            [[-12, -6], [0, 9], [12, -2]].forEach(([dy, kx]) => { cv.roundRect(x - 18, y + dy - 2, 36, 4, 2, c); cv.circle(x + kx, y + dy, 6, c); cv.circle(x + kx, y + dy, 2.5, bg); });
        }];
        function drawRail(cv) {
            const sel = mode === 'results' ? 'search' : mode === 'channel' ? 'subs' : mode, bottom = H + (cv.own ? cv.extra : 0);
            const items = (cv.own && model.active() ? RAIL.concat([PLAYING]) : RAIL).concat(ID8 ? [MORE] : []);
            const pitch = Math.min(100, (bottom - 156) / (items.length - 1));   // (the page down to the screen's bottom where it reaches)
            items.forEach(([m, name, glyph], i) => {
                const cx = 62, cy = 96 + Math.round(i * pitch), on = m === sel, bg = on ? '#2c2c2c' : C.bg, c = on ? '#ffffff' : C.dim;
                if (on) { cv.roundRect(18, cy - 38, 90, 84, 16, bg); cv.roundRect(18, cy - 14, 5, 28, 2.5, C.red); }
                glyph(cv, cx, cy - 8, c, bg);
                cv.text(name === 'Subscriptions' ? 'Subs' : name, cx, cy + 34, 18, c, { literal: true, align: 'center', font: on ? 'bold' : 'label' });
                if (cv.own) cv.target(16, cy - 38, 92, 84, () => (m === 'search' ? openSearch() : m === 'more' ? openMenu() : show(m)), 'rail:' + m, 16);
            });
        }

        /* a tile: the 16:9 thumb, its length, two lines of title, the channel and the tile's meta (views, age) */
        function drawTile(cv, r, x, y, key) {
            const cur = r.id === model.id && model.active();
            if (key === focusKey) cv.roundRect(x - 10, y - 10, TW + 20, TILE_H + 16, 18, C.card);
            const th = model.thumbs[r.id];
            if (!th) model.wantThumb(r.id);
            const pid = th && cv.place ? slot(r.id, th) : null;
            if (pid) cv.picture(pid, x, y, TW, TH, 12);
            else { cv.roundRect(x, y, TW, TH, 12, C.ph); cv.circle(x + TW / 2, y + TH / 2, 30, '#ffffff10'); tri(cv, x + TW / 2 + 2, y + TH / 2, 24, '#ffffff38'); }
            const p = model.pos[r.id];   // watched (here, else on the account): a bar along the thumbnail's foot
            const frac = p ? (p.done ? 1 : Math.min(1, p.ms / p.total)) : r.watched_pct > 0 ? r.watched_pct / 100 : 0;
            if (frac > 0) {
                const pw = Math.max(8, Math.round(TW * frac));
                cv.fillRect(x, y + TH - 5, TW, 5, '#ffffff55');
                cv.fillRect(x, y + TH - 5, pw, 5, C.red);
            }
            if (r.duration_s > 0) {
                const d = clock(r.duration_s * 1000), dw = cv.textWidth(d, 20, LITB) + 16;
                cv.roundRect(x + TW - 8 - dw, y + TH - 36, dw, 28, 6, '#000000cc');
                cv.text(d, x + TW - 16, y + TH - 15, 20, '#ffffff', { literal: true, font: 'bold', align: 'right' });
            }
            if (cur) {
                cv.strokeRoundRect(x - 2, y - 2, TW + 4, TH + 4, 14, 3, C.red);
                const pw = cv.textWidth('NOW PLAYING', 16, { literal: true, font: 'bold', spacing: 1 }) + 20;
                cv.roundRect(x + 10, y + 10, pw, 28, 6, C.red);
                cv.text('NOW PLAYING', x + 20, y + 30, 16, '#ffffff', { literal: true, font: 'bold', spacing: 1 });
            }
            const lines = wrap(cv, String(r.title || r.id));
            lines.forEach((l, k) => cv.text(l, x, y + TH + 32 + k * 30, 24, C.text, LITB));
            const my = y + TH + 32 + lines.length * 30 - 2;
            const meta = [r.channel].concat(Array.isArray(r.meta) ? r.meta : []).filter((m) => typeof m === 'string' && m).join(' · ');
            if (meta) cv.text(fit(cv, meta, 20, TW, LIT), x, my, 20, C.dim, LIT);
        }

        /* a channel: a round mark with its initial, its name, its @handle; or an action (r.act: Search channels, All) */
        const HUES = ['#c62828', '#ad1457', '#6a1b9a', '#283593', '#1565c0', '#00838f', '#2e7d32', '#9e9d24', '#ef6c00', '#4e342e'];
        function drawChan(cv, r, x, y, key) {
            if (key === focusKey) cv.roundRect(x - 10, y - 10, TW + 20, TILE_H + 16, 18, C.card);
            const cx = x + TW / 2, cy = y + TH / 2, name = String(r.title || r.id);
            let h = 0;
            for (const ch of r.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
            if (r.act) {
                cv.roundRect(x, y, TW, TH, 12, C.ph);
                r.glyph(cv, cx, cy, '#ffffff');
            } else {
                cv.circle(cx, cy, 78, HUES[h % HUES.length]);
                const ini = (Array.from(name).find((ch) => /[0-9]/.test(ch) || ch.toLowerCase() !== ch.toUpperCase()) || name.charAt(0) || '?').toUpperCase();   // (Node 8: no \p{L})
                cv.text(ini, cx, cy + 26, 72, '#ffffff', { literal: true, font: 'bold', align: 'center' });
            }
            cv.text(fit(cv, name, 24, TW, LITB), cx, y + TH + 36, 24, C.text, { literal: true, font: 'bold', align: 'center' });
            if (r.sub || r.handle) cv.text(fit(cv, r.sub || r.handle, 20, TW, LIT), cx, y + TH + 66, 20, C.dim, { literal: true, align: 'center' });
        }
        const KEYS = (cv, cx, cy, c) => {                 // a keyboard
            cv.strokeRoundRect(cx - 46, cy - 30, 92, 60, 10, 4, c);
            for (let k = 0; k < 5; k++) { cv.roundRect(cx - 34 + k * 15, cy - 18, 9, 9, 2, c); cv.roundRect(cx - 34 + k * 15, cy - 3, 9, 9, 2, c); }
            cv.roundRect(cx - 24, cy + 12, 48, 8, 3, c);
        };
        const BLOCK = (cv, cx, cy, c) => { cv.arc(cx, cy, 30, 36, 0, 360, c); cv.line(cx - 22, cy + 22, cx + 22, cy - 22, 6, c); };   // hide
        const SHOW = (cv, cx, cy, c) => { cv.arc(cx, cy, 30, 36, 0, 360, c); cv.polyline([[cx - 15, cy], [cx - 4, cy + 12], [cx + 16, cy - 12]], 6, c); };
        const ALL = (cv, cx, cy, c) => { [-20, 0, 20].forEach((d) => cv.roundRect(cx - 34, cy + d - 4, 68, 8, 4, c)); };
        // the channels, filtered by chanQ (the keyboard: one letter = names starting with it, else names holding it)
        let chanQ = '';
        function findChannel() {
            if (ID8) {
                ctx.sheet(keyboardSheet({ title: 'Find a channel', hint: 'A name, or its first letter', action: 'Find', locked: typingLocked,
                    onDone: (t) => { chanQ = String(t).trim(); vs('subs').sy = 0; vs('subs').off = {}; dirty = true; show('subs'); } }));
                return;
            }
            spell(ctx.app, 'Find a channel').then((t) => {
                if (t === null || t === undefined) { ui.open('VIEW'); return; }
                chanQ = String(t).trim(); vs('subs').sy = 0; vs('subs').off = {}; dirty = true;
                show('subs'); ui.open('VIEW');
            }).catch((e) => log.error('speller', e));
        }
        let chanFrom = 'subs';
        function openChannel(c) { if (mode !== 'channel') chanFrom = mode; model.openChannel(c.id, c.title); show('channel'); vs('channel').sy = 0; vs('channel').off = {}; }
        function chanSections() {
            const ch = model.chans;
            if (!ch || (!ch.items.length && ch.loading)) return [{ title: 'Channels', sub: 'Loading...', items: [], chan: true }];
            if (!ch.items.length) return ch.error ? [{ title: 'Channels', sub: ch.error, items: [], chan: true }] : [];
            const find = { id: '::find', title: chanQ ? 'Search again' : 'Search channels', sub: 'A letter, or a word', act: findChannel, glyph: KEYS };
            if (!chanQ) return [{ title: 'Channels', sub: ch.items.length + ' subscriptions, A-Z', items: [find].concat(ch.items), chan: true }];
            const hits = model.findChannels(chanQ);
            const all = { id: '::all', title: 'All channels', sub: ch.items.length + ' subscriptions', act: () => { chanQ = ''; vs('subs').off = {}; dirty = true; }, glyph: ALL };
            return [{ title: (chanQ.length === 1 ? 'Channels starting with “' : 'Channels matching “') + chanQ + '”',
                sub: hits.length ? hits.length + (hits.length === 1 ? ' channel' : ' channels') : 'none', items: [find, all].concat(hits), chan: true, grid: true }];
        }
        function drawChannel(cv) {
            const c = model.chan;
            if (!model.connected) return say(cv, OFF, OFF2);
            if (!c) return say(cv, 'Pick a channel in Subscriptions');
            if (!c.items.length) return say(cv, c.loading ? 'Loading ' + (c.title || 'the channel') + '...' : c.error === 'feed offline' ? 'The video service is not reachable - check the car\'s internet connection' : c.error || 'No videos on this channel', c.title || null);
            const hid = hidden.indexOf(c.title) >= 0;
            const tog = { id: '::hide', title: hid ? 'Show this channel' : 'Hide this channel', sub: hid ? 'Hidden from Home, Subscriptions, Search' : 'From Home, Subscriptions and Search',
                act: () => toggleHidden(c.title), glyph: hid ? SHOW : BLOCK };
            drawPage(cv, (c.shelves && c.shelves.length ? c.shelves : [{ title: 'Videos', items: c.items, grid: true }])
                .map((s, i) => (i === 0 ? Object.assign({}, s, { title: c.title + (s.title ? ' · ' + s.title : ''), items: [tog].concat(s.items) }) : s)));
        }

        // a shelf's arrow for touch: shifts it by four tiles. Its target goes before the tiles' (a tap on it is not
        // the tile under it), the drawing after them (returned: drawn by the caller once the tiles are)
        function chevron(cv, cx, cy, dir, run, key) {
            cv.target(cx - 32, cy - 32, 64, 64, run, key, 32);
            return () => {
                cv.circle(cx, cy, 32, '#00000099'); cv.circle(cx, cy, 29, key === focusKey ? '#ffffff' : '#303030');
                cv.polyline([[cx - 5 * dir, cy - 11], [cx + 6 * dir, cy], [cx - 5 * dir, cy + 11]], 4.5, key === focusKey ? '#0f0f0f' : '#ffffff');
            };
        }

        /*
         * A browsing page: rows of tiles, each a shelf (its own sideways offset, a title) or a grid's row of four.
         * sections [{ title, items, grid }]. Scrolls up and down (a finger, the controller); targets for the tiles
         * shown, one more past each edge of a shelf and the rows next to the ones shown (the controller moves
         * there, onPageFocus brings it into view). Keys: <mode letter>:<row>:<video id>.
         */
        const view = {};                                  // mode -> { sy, off: { row: first tile shown } }
        const vs = (m) => view[m] || (view[m] = { sy: 0, max: 0, off: {} });
        let laid = { mode: null, rows: [], viewH: 0, where: {} }, focusKey = null, dwell = null;
        function layout(sections) {
            const rows = [];
            let y = 10;
            sections.forEach((sc) => {
                const chunks = sc.grid ? [] : [sc.items];
                if (sc.grid) for (let i = 0; i < sc.items.length; i += PER_ROW) chunks.push(sc.items.slice(i, i + PER_ROW));
                chunks.forEach((items, k) => {
                    const title = k === 0 ? sc.title : null, h = (title ? HEAD_H : 0) + TILE_H + (sc.grid && k < chunks.length - 1 ? GRID_GAP : SHELF_GAP);
                    rows.push({ title, sub: k === 0 ? sc.sub : null, items, y, h, hs: !sc.grid && items.length > PER_ROW, chan: !!sc.chan });
                    y += h;
                });
            });
            return { rows, h: y };
        }
        function drawPage(cv, sections) {
            const st = vs(mode), bottom = H + (cv.own ? cv.extra : 0), viewH = bottom - TOP, L = layout(sections);
            st.max = Math.max(0, L.h - viewH);
            st.sy = Math.max(0, Math.min(st.max, st.sy));
            const where = {}, letter = mode[0];
            const ys = L.rows.map((r) => TOP + r.y - st.sy);
            const vis = L.rows.map((r, i) => ys[i] + r.h > TOP && ys[i] < bottom);
            const first = vis.indexOf(true), lastV = vis.lastIndexOf(true), after = [];
            cv.clip(RAIL_W, TOP, W - RAIL_W, bottom - TOP);
            L.rows.forEach((row, ri) => {
                if (ri < first - 1 || ri > lastV + 1) return;
                const y = ys[ri], shown = vis[ri], n = row.items.length, ty = y + (row.title ? HEAD_H : 0);
                if (row.title && shown) {
                    const tw = cv.text(fit(cv, row.title, 30, 1100, LITB), X0, y + 34, 30, '#ffffff', LITB);
                    if (row.sub) cv.text(row.sub, X0 + tw + 18, y + 34, 22, C.dim, LIT);
                }
                const max = row.hs ? n - PER_ROW : 0, off = Math.max(0, Math.min(max, st.off[ri] || 0));
                st.off[ri] = off;
                // touch: arrows where tiles are hidden (recorded first: a tap on one is not the tile under it)
                if (cv.own && shown && row.hs) {
                    if (off > 0) after.push(chevron(cv, X0 + 4, ty + TH / 2, -1, () => { st.off[ri] = Math.max(0, off - PER_ROW); dirty = true; }, letter + ':' + ri + ':<'));
                    if (off < max) {
                        after.push(() => { for (let k = 0; k < 6; k++) cv.fillRect(W - 108 + k * 16, ty - 10, 16, TILE_H + 16, [15, 15, 15, Math.round(255 * (0.3 + k * 0.14))]); });
                        after.push(chevron(cv, W - 48, ty + TH / 2, 1, () => { st.off[ri] = Math.min(max, off + PER_ROW); dirty = true; }, letter + ':' + ri + ':>'));
                    }
                }
                for (let i = Math.max(0, off - 1); i <= Math.min(n - 1, off + PER_ROW); i++) {
                    const r = row.items[i], x = X0 + (i - off) * PITCH, key = letter + ':' + ri + ':' + r.id;
                    if (shown && x + TW > RAIL_W && x < W) (row.chan || r.act ? drawChan : drawTile)(cv, r, x, ty, key);
                    const run = r.act ? () => r.act() : row.chan ? () => openChannel(r) : () => play(r.id, r, row.items);
                    if (cv.own) { cv.target(x - 10, ty - 10, TW + 20, TILE_H + 16, run, key, 18); where[key] = { ri, i }; }
                }
            });
            after.forEach((fn) => fn());
            cv.noclip();
            laid = { mode, rows: L.rows, viewH, where };
            if (cv.own && st.max > 0) cv.scroll = true;
        }
        // the controller on a tile: its shelf turned and the page scrolled so that it shows whole
        if (ctx.onPageFocus) ctx.onPageFocus((key) => {
            if (key !== focusKey) dirty = true;
            focusKey = key;
            // resting ~1 s on a video: the daemon looks its streams up now, so a press plays ~2.5 s sooner
            clearTimeout(dwell);
            const vid = /^[a-z]+:\d+:([A-Za-z0-9_-]{11})$/.exec(key || '');
            if (vid) dwell = setTimeout(() => { if (focusKey === key) model.prefetch(vid[1]); }, 1000);
            if (key && key.indexOf('ov:') === 0) { wake(); return; }      // the controller in the player: its overlay
            const w = key && laid.mode === mode && laid.where[key];
            if (!w) return;
            const st = vs(mode), row = laid.rows[w.ri];
            if (row.hs) {
                const off = st.off[w.ri] || 0;
                if (w.i < off) st.off[w.ri] = w.i; else if (w.i > off + PER_ROW - 1) st.off[w.ri] = w.i - PER_ROW + 1;
            }
            const top = row.y - 8, bot = row.y + row.h;
            if (top < st.sy) st.sy = Math.max(0, top); else if (bot > st.sy + laid.viewH) st.sy = Math.min(st.max, bot - laid.viewH);
            dirty = true;
        });
        if (ctx.onScroll) ctx.onScroll((dy) => {
            if (!browsing()) return false;
            const st = vs(mode), y = Math.max(0, Math.min(st.max, st.sy + dy)), moved = y !== st.sy;
            st.sy = y;
            if (moved) dirty = true;
            return moved;
        });

        // a message in the middle of the page (RideTube's mark over it), a grey line under it
        const MID = (RAIL_W + W) / 2;
        function say(cv, msg, sub) {
            if (browsing()) logo(cv, MID, 200, 76);
            cv.text(fit(cv, msg, 34, 1360, LIT), browsing() ? MID : W / 2, 290, 34, '#ffffff', { literal: true, align: 'center' });
            if (sub) cv.text(fit(cv, sub, 24, 1360, LIT), browsing() ? MID : W / 2, 336, 24, C.dim, { literal: true, align: 'center' });
        }
        const OFF = 'The RideTube service (jap-ridetube-d) is not running';
        const OFF2 = 'Install the RideTube service (jap-ridetube-d) from the MGU Store';
        function drawResults(cv) {
            if (!model.connected) return say(cv, OFF, OFF2);
            if (model.searching) return say(cv, 'Searching "' + model.q + '"...');
            if (model.searchError) return say(cv, 'Search: ' + model.searchError, 'Try again from Search');
            if (!model.results.length) return say(cv, model.q ? 'Nothing found for "' + model.q + '"' : 'Search (bar button) to find videos', model.q ? 'Try other words' : null);
            drawPage(cv, [{ title: 'Results for “' + model.q + '”', items: shown(model.results), grid: true }]);
        }
        function drawFeed(cv, which) {
            const f = model.feeds[which], a = model.auth.state;
            if (!model.connected) return say(cv, OFF, OFF2);
            if (a === 'unsupported') return say(cv, 'Signing in needs a newer jap-ridetube-d tool on the car');
            if (a !== 'signed_in') return drawSignIn(cv);
            const chans = which === 'subs' && model.chans && model.chans.items.length;   // the channels show without the videos
            if ((!f || !f.items.length) && !chans) {
                return say(cv, !f || f.loading ? 'Loading ' + NAMES[which] + '...' : f.error === 'feed offline' ? 'The video service is not reachable - check the car\'s internet connection'
                    : f.error ? NAMES[which] + ': ' + f.error : which === 'wl' ? 'Nothing in Watch later' : 'No videos here yet', which === 'wl' && f && !f.loading && !f.error ? 'Videos you save for later show here' : null);
            }
            let secs;
            if (which === 'home') {
                const wl = model.feeds.wl;
                secs = (model.resume.length ? [{ title: 'Continue watching', items: model.resume }] : [])
                    .concat(f.shelves || [{ title: 'Recommended', items: f.items, grid: true }])
                    .concat(wl && wl.items.length ? [{ title: 'Watch later', items: wl.items.slice(0, SHELF_MAX) }] : []);
            } else secs = !f ? [] : f.shelves && which !== 'wl' ? f.shelves : [{ title: NAMES[which], sub: f.items.length + ' videos', items: f.items, grid: true }];
            if (which === 'subs') secs = chanSections().concat(chanQ || !f || !f.items.length ? [] : secs);
            drawPage(cv, secs.map((sc) => (sc.chan ? sc : Object.assign({}, sc, { items: shown(sc.items) }))).filter((sc) => sc.chan || sc.items.length));
        }
        // not signed in: a QR code for the sign-in page, the code to enter there in big letters, on a card
        function drawSignIn(cv) {
            const a = model.auth;
            // a code expired or refused, or signed out: a new one only when asked (a tap, or Sign in in the menu)
            if (a.state === 'error' || a.state === 'signed_out') {
                say(cv, a.state === 'error' ? 'Sign-in is not available (' + (a.msg || 'error') + ') - tap to try again'
                    : cv.own ? 'Tap here to get a sign-in code' : 'Sign in (menu) to get a sign-in code',
                'Your Home, Subscriptions and Watch later, on the car');
                if (cv.own) cv.target(MID - 520, 160, 1040, 200, () => model.authStart(true), 'signin', 16);
                return;
            }
            if (a.state !== 'code' || !a.code) return say(cv, 'Getting a sign-in code...');
            let url = /^https:\/\//.test(a.url || '') ? a.url : SIGNIN_URL, q;
            try { q = QR.encode(url); } catch (e) { url = SIGNIN_URL; q = QR.encode(url); }   // longer than a version 4 code holds
            const code = { literal: true, font: 'bold', spacing: 6 }, cwid = cv.textWidth(a.code, 54, code), hint = 'Scan the code, or go to ' + url.replace(/^https:\/\/(www\.)?/, '');
            const side = (q.length + 8) * 8, textW = Math.max(cwid + 56, cv.textWidth(hint, 26, LIT), 88 + cv.textWidth('Sign in', 44, LITB), 560);
            const cw = Math.min(1400, 44 + side + 80 + textW + 64), ch = 444, cx = Math.round(MID - cw / 2), cy = TOP + Math.max(14, Math.round((H + (cv.own ? cv.extra : 0) - TOP - ch) / 2)), dy = cy - 58;
            cv.roundRect(cx, cy, cw, ch, 24, C.card);
            const qx = cx + 44, qy = cy + Math.round((ch - side) / 2);
            cv.roundRect(qx - 6, qy - 6, side + 12, side + 12, 18, '#ffffff');
            QR.draw(cv, url, qx, qy, 8);
            const tx = qx + side + 80;
            logo(cv, tx + 34, 128 + dy, 68);
            cv.text('Sign in', tx + 88, 144 + dy, 44, '#ffffff', LITB);
            cv.text('Enter this code on your phone', tx, 214 + dy, 30, C.dim, LIT);
            cv.roundRect(tx, 238 + dy, cwid + 56, 96, 16, C.bg);
            cv.text(a.code, tx + 28, 308 + dy, 54, '#ffffff', code);
            cv.text(hint, tx, 392 + dy, 26, C.dim, LIT);
            cv.text('The account stays on the car; this app never sees a password', tx, 440 + dy, 20, '#717171', LIT);
        }
        function drawPlayer(cv) {
            cv.fillRect(0, TOP, W, H - TOP, '#000000');
            cv.fillRect(BOX.x, BOX.y, BOX.w, BOX.h, '#000000');
            if (videoShown) cv.video(VID, BOX.x, BOX.y, BOX.w, BOX.h, 0);
            const cx = BOX.x + BOX.w / 2, cy = BOX.y + BOX.h / 2 - 10, bot = BOX.y + BOX.h;
            // the title and channel over a scrim at the top
            if (model.title) {
                cv.gradientRect(BOX.x, BOX.y, BOX.w, 130, [[0, '#000000d0'], [1, '#00000000']]);
                const it = model.item(model.id);
                cv.text(fit(cv, model.title, 30, BOX.w - 60, LITB), BOX.x + 30, BOX.y + 48, 30, '#ffffff', LITB);
                if (it && it.channel) cv.text(fit(cv, it.channel, 22, BOX.w - 60, LIT), BOX.x + 30, BOX.y + 82, 22, '#cccccc', LIT);
            }
            let mid = null;
            if (!model.connected) mid = 'The RideTube service (jap-ridetube-d) is not running';
            else if (model.state === 'preparing') {
                const p = Math.max(0, Math.min(100, model.pct || 0));
                cv.circle(cx, cy - 20, 54, '#00000099');
                cv.arc(cx, cy - 20, 44, 52, 0, 360, '#ffffff26');
                if (p > 0) cv.arc(cx, cy - 20, 44, 52, 0, p * 3.6, C.red, { round: true });
                cv.text(Math.round(p) + '%', cx, cy - 10, 30, '#ffffff', { literal: true, font: 'bold', align: 'center' });
                cv.text(prepText(), cx, cy + 82, 26, '#dddddd', { literal: true, align: 'center' });
            } else if (model.state === 'error') mid = 'Error: ' + (model.error || 'playback stopped');
            else if (!model.active()) mid = model.state === 'ended' ? 'Finished' : 'Pick a video on Home or Search';
            else if (noVideo()) mid = 'Video stops while driving - the sound plays on';
            else if (!cv.place || !gpu()) mid = 'The picture needs the GPU renderer (mgu-render) - the sound plays';
            else if (!videoShown) mid = 'Starting the picture...';
            if (model.state === 'paused' && !mid) { cv.circle(cx, cy, 60, '#000000a0'); cv.arc(cx, cy, 57, 60, 0, 360, '#ffffff50'); tri(cv, cx + 5, cy, 46, '#ffffff'); }
            if (mid) {
                if (model.state === 'paused') { cv.circle(cx, cy - 40, 46, '#000000a0'); tri(cv, cx + 4, cy - 40, 36, '#ffffff'); }
                cv.text(fit(cv, mid, 34, 1500, LIT), W / 2, BOX.y + BOX.h / 2 + (model.state === 'paused' ? 50 : 12), 34, '#ffffff', { literal: true, align: 'center' });
            }
            // the progress bar at the bottom: the track, the part played, the scrubber; the times under it
            if (model.total > 0 && model.active() && model.state !== 'preparing') {
                cv.gradientRect(BOX.x, bot - 120, BOX.w, 120, [[0, '#00000000'], [1, '#000000d8']]);
                const tx = BOX.x + 30, tw = BOX.w - 60, ty = bot - 62, k = Math.min(1, model.elapsed / model.total), fx = tx + Math.round(tw * k);
                cv.roundRect(tx, ty, tw, 6, 3, '#ffffff55');
                cv.roundRect(tx, ty, fx - tx, 6, 3, C.red);
                cv.circle(fx, ty + 3, 9, C.red);
                cv.text(clock(model.elapsed), tx, bot - 20, 24, '#ffffff', LITB);
                cv.text(clock(model.total), tx + tw, bot - 20, 24, '#dddddd', { literal: true, font: 'bold', align: 'right' });
            }
        }
        /*
         * The player where the kit runs the screen: the video over the whole surface (no header, no bar), the
         * overlay over it, drawn in screen px / scale (sharp text) at the screen's origin. Its targets go back into
         * the page's px (dx, dy). Hidden, the same keys cover the whole screen and only show it again (the
         * controller stays on its key, so a turn or a press wakes it; a tap anywhere too).
         */
        const OVK = ['ov:back', 'ov:qr', 'ov:snd', 'ov:rw', 'ov:play', 'ov:ff', 'ov:q', 'ov:zoom', 'ov:bar'];
        let sndArmed = 0;       // "No sound?" pressed once: a second press within 6 s says it
        // podcast mode (driving): artwork, title, chapter, the bar with chapter ticks and skipped segments, controls
        // a glove can hit (-10 s, play/pause, +10 s, next in the row), the next video, a skipped-sponsor notice
        function drawPodcast(cv, SW, SH, LX, tg, run, live) {
            cv.fillRect(0, 0, SW, SH, C.bg);
            const x0 = LX + 46, top = 40, ch = model.channel || (model.item(model.id) || {}).channel;
            cv.text('RideTube', x0, top + 30, 34, '#ffffff', LITB);
            const chip = 'Podcast mode · driving', cw = cv.textWidth(chip, 22, LIT) + 40;
            cv.roundRect(x0 + 170, top, cw, 40, 20, C.ph);
            cv.text(chip, x0 + 170 + cw / 2, top + 28, 22, C.dim, { literal: true, align: 'center' });
            cv.text('Video returns when parked', SW - 60, top + 28, 22, '#717171', { literal: true, align: 'right' });
            // laid out from the bottom: the notice / up-next row, the controls, the bar; the artwork takes what is left
            const cy = SH - 178, by = cy - 128, ay = top + 72, ah = Math.max(120, by - 56 - ay), aw = Math.round(ah * 16 / 9), ax = x0;
            const th = model.thumbs[model.id];
            if (!th) model.wantThumb(model.id);
            const pid = th && cv.place ? slot(model.id, th) : null;
            if (pid) cv.picture(pid, ax, ay, aw, ah, 24); else { cv.roundRect(ax, ay, aw, ah, 24, C.ph); tri(cv, ax + aw / 2 + 4, ay + ah / 2, 50, '#ffffff38'); }
            // title block
            const tx = ax + aw + 70, tw = SW - tx - 60;
            if (ch) cv.text(fit(cv, ch, 28, tw, LIT), tx, ay + 30, 28, C.dim, LIT);
            const words = String(model.title || model.id || '').split(/\s+/).filter(Boolean);
            let l1 = '', i = 0;
            for (; i < words.length; i++) { const t = l1 ? l1 + ' ' + words[i] : words[i]; if (l1 && cv.textWidth(t, 44, LITB) > tw) break; l1 = t; }
            [fit(cv, l1, 44, tw, LITB), fit(cv, words.slice(i).join(' '), 44, tw, LITB)].filter(Boolean).forEach((l, k) => cv.text(l, tx, ay + 84 + k * 52, 44, '#ffffff', LITB));
            const chap = model.chapter();
            if (chap) cv.text(fit(cv, chap, 28, tw, LIT), tx, ay + ah - 6, 28, '#3ea6ff', LIT);
            // the bar
            const bw = SW - x0 - 60, tot = model.total, ex = model.extras && model.extras.id === model.id ? model.extras : null;
            const at = (ms) => x0 + Math.round(bw * Math.min(1, tot ? ms / tot : 0));
            cv.roundRect(x0, by, bw, 10, 5, '#3f3f3f');
            if (tot > 0) {
                const el = shownAt(), bf = focusKey === 'ov:bar';
                cv.roundRect(x0, by, Math.max(10, at(el) - x0), 10, 5, C.red);
                if (ex) sbSegs(ex).forEach((g) => cv.fillRect(at(g[0]), by, Math.max(4, at(g[1]) - at(g[0])), 10, sbColor(g)));
                if (ex) ex.chapters.forEach((k) => { if (k[0] > 0) cv.fillRect(at(k[0]) - 2, by, 4, 10, C.bg); });
                if (bf) cv.circle(at(el), by + 5, 24, '#3ea6ff');
                cv.circle(at(el), by + 5, bf ? 18 : 14, C.red);
                tg(x0 - 10, by - 36, bw + 20, 80, run(() => model.toggle()), 'ov:bar', 0, turnSeek);
                cv.text(clock(el), x0, by + 50, 26, C.dim, LIT);
                cv.text('-' + clock(tot - el), x0 + bw, by + 50, 26, C.dim, { literal: true, align: 'right' });
            } else if (model.state === 'preparing') cv.text(prepText(), x0, by + 50, 26, C.dim, LIT);
            // controls
            const mid = x0 + bw / 2 + (queue.length ? 0 : 100);   // with Next: four buttons; without: three, centred
            const big = (key, x, r, light, fn, glyph) => {
                const f = focusKey === key;
                cv.circle(x, cy, r, f ? '#3ea6ff' : light ? '#ffffff' : C.ph);
                glyph(light && !f ? C.bg : '#ffffff');
                tg(x - r - 10, cy - r - 10, 2 * r + 20, 2 * r + 20, run(fn), key, r + 10);
            };
            const num = (t, x) => (c) => cv.text(t, x, cy + 14, 38, c, { literal: true, font: 'bold', align: 'center' });
            if (live) {
                big('ov:rw', mid - 300, 58, false, () => model.skip(-10000), num('-10', mid - 300));
                big('ov:play', mid - 100, 72, true, () => model.toggle(), (c) => {
                    if (model.state === 'paused') tri(cv, mid - 92, cy, 60, c);
                    else { cv.roundRect(mid - 124, cy - 32, 16, 64, 4, c); cv.roundRect(mid - 92, cy - 32, 16, 64, 4, c); }
                });
                big('ov:ff', mid + 100, 58, false, () => model.skip(10000), num('+10', mid + 100));
            }
            else if (model.state === 'error' && model.id) big('ov:play', mid - 100, 72, true, again, (c) => retryGlyph(cv, mid - 100, cy, 30, c));
            if (queue.length) {
                const nx = mid + 300;
                big('ov:next', nx, 58, false, () => { const r = queue.shift(); play(r.id, r); }, (c) => {
                    cv.quad([[nx - 22, cy - 26], [nx - 22, cy + 26], [nx + 12, cy], [nx - 22, cy - 26]], c); cv.fillRect(nx + 14, cy - 26, 9, 52, c);
                });
                const up = 'Up next  ·  ' + String(queue[0].title || queue[0].id), uw = Math.min(700, cv.textWidth(up, 26, LIT) + 50);
                cv.roundRect(SW - 60 - uw, SH - 96, uw, 64, 16, '#1c1c1c');
                cv.text(fit(cv, up, 26, uw - 50, LIT), SW - 60 - uw + 25, SH - 54, 26, '#dddddd', LIT);
            }
            const ask = askSeg();
            if (ask) {
                const tt = 'Skip ' + sbName(ask[2]), w2 = cv.textWidth(tt, 30, LITB) + 80, f = focusKey === 'ov:sbskip';
                cv.roundRect(x0, SH - 100, w2, 72, 36, f ? '#3ea6ff' : '#ffffff');
                cv.text(tt, x0 + 40, SH - 52, 30, f ? '#ffffff' : C.bg, LITB);
                tg(x0, SH - 100, w2, 72, run(sbJump(ask)), 'ov:sbskip', 36);
            } else if (model.toast && Date.now() < model.toast.until) {
                const tt = model.toast.text, w2 = cv.textWidth(tt, 26, LIT) + 60, wn = model.toast.warn;
                cv.roundRect(x0, SH - 96, w2, 64, 32, wn ? '#4a3a10' : '#1f3d1f');
                cv.text(tt, x0 + 30, SH - 54, 26, wn ? '#ffd27a' : '#7ee07e', LIT);
            }
            if (model.state === 'error') cv.text(fit(cv, 'Error: ' + (model.error || 'playback stopped'), 28, bw, LIT), x0, SH - 54, 28, '#ff6b6b', LIT);
        }
        function drawFull(cv) {
            const pl = cv.place, s = pl.scale, SW = pl.w / s, SH = pl.h / s, dx = pl.ox / s, dy = pl.oy / s;
            cv.chrome = null;              // no header or bar composed over it (display.js present)
            // read: the page stays placed as the browsing pages (reaching down), so oy, and the targets with it, hold
            void cv.extra;
            const tg = (x, y, w, h, run, key, r, turn) => cv.target(x - dx, y - dy, w, h, run, key, r, turn);
            cv.xf(1, 0, 0).fillRect(0, 0, pl.w, pl.h, '#000000');
            const pod = model.active() && noVideo();   // driving: podcast mode (no picture, big controls, always shown)
            if (videoShown && !pod) cv.video(VID, 0, 0, pl.w, pl.h, 0);
            if (!overlay() && !pod) { cv.xf(); OVK.forEach((k) => tg(0, 0, SW, SH, wake, k, 0, k === 'ov:bar' ? turnSeek : undefined)); return; }
            cv.xf(s, 0, 0);
            const LX = HMI.left / s, act = model.active(), live = model.state === 'playing' || model.state === 'paused';
            const cx = SW / 2, cy = SH / 2 - 6, run = (fn) => () => { fn(); wake(); };
            if (pod) { drawPodcast(cv, SW, SH, LX, tg, run, live); hmiIcons(cv); return; }
            // a round control: dark, white when the controller is on it (its glyph dark then)
            const ctl = (key, x, y, r, fn, glyph) => {
                const f = focusKey === key;
                cv.circle(x, y, r, f ? '#ffffff' : '#00000099');
                glyph(f ? '#0f0f0f' : '#ffffff');
                tg(x - r - 6, y - r - 6, 2 * r + 12, 2 * r + 12, run(fn), key, r + 6);
            };
            // top: back to the list, the title and channel over a scrim
            cv.gradientRect(0, 0, SW, 160, [[0, '#000000d8'], [1, '#00000000']]);
            const bx = LX + 44, by = 52;
            ctl('ov:back', bx, by, 30, () => goBack(browse), (c) => cv.polyline([[bx + 5, by - 12], [bx - 7, by], [bx + 5, by + 12]], 5, c));
            const ch = model.channel || (model.item(model.id) || {}).channel;
            if (model.title) cv.text(fit(cv, model.title, 30, SW - LX - 160, LITB), LX + 96, by - 4, 30, '#ffffff', LITB);
            if (ch) cv.text(fit(cv, ch, 22, SW - LX - 300, LIT), LX + 96, by + 30, 22, '#cccccc', LIT);
            // top right, On phone: a QR code of the video's public link at this second (nothing is kept on the car)
            if (model.id) {
                const px = SW - 150;
                ctl('ov:qr', px, by, 30, () => { qrUntil = qrUntil > Date.now() ? 0 : Date.now() + 30000; }, (c) => {
                    cv.strokeRoundRect(px - 10, by - 17, 20, 34, 4, 3, c); cv.fillRect(px - 4, by + 10, 8, 3, c);
                });
                cv.text('On phone', px - 42, by + 9, 24, '#ffffff', Object.assign({}, LIT, { align: 'right' }));
            }
            if (model.id && qrUntil > Date.now()) {
                const url = 'https://youtu.be/' + model.id + (model.elapsed > 5000 ? '?t=' + Math.floor(model.elapsed / 1000) : ''), mod = 8;
                const n = QR.encode(url).length, side = (n + 8) * mod, cw = side + 520, chh = side + 60, qx0 = cx - cw / 2, qy0 = cy - chh / 2;
                cv.roundRect(qx0, qy0, cw, chh, 24, '#212121f2');
                cv.roundRect(qx0 + 30 - 6, qy0 + 30 - 6, side + 12, side + 12, 18, '#ffffff');
                QR.draw(cv, url, qx0 + 30, qy0 + 30, mod);
                cv.text('Continue on your phone', qx0 + side + 80, qy0 + chh / 2 - 20, 34, '#ffffff', LITB);
                cv.text('Scan with the camera to go on from ' + clock(model.elapsed), qx0 + side + 80, qy0 + chh / 2 + 24, 22, '#cccccc', LIT);
                tg(qx0, qy0, cw, chh, () => { qrUntil = 0; wake(); }, 'ov:qrcard', 24);
                cv.xf();
                return;
            }
            // middle: -10 s, play / pause, +10 s; preparing: the ring with the percentage
            let mid = null;
            if (!model.connected) mid = OFF;
            else if (model.state === 'error') mid = 'Error: ' + (model.error || 'playback stopped');
            const up = upNext;
            if (up) {
                mid = 'Up next in ' + Math.max(1, Math.ceil((nextAt - Date.now()) / 1000)) + ' s: ' + String(up.title || up.id);
                ctl('ov:play', cx, cy, 58, () => { nextAt = 1; }, (c) => tri(cv, cx + 5, cy, 46, c));
            } else if (!act && model.state !== 'error') mid = model.state === 'ended' ? 'Finished' : 'Pick a video on Home or Search';
            else if (noVideo()) mid = 'Video stops while driving - the sound plays on';
            else if (!gpu()) mid = 'The picture needs the GPU renderer (mgu-render) - the sound plays';
            else if (live && !videoShown) mid = 'Starting the picture...';
            if (model.state === 'preparing') {
                const p = Math.max(0, Math.min(100, model.pct || 0));
                cv.circle(cx, cy, 56, '#00000099');
                cv.arc(cx, cy, 44, 52, 0, 360, '#ffffff26');
                if (p > 0) cv.arc(cx, cy, 44, 52, 0, p * 3.6, C.red, { round: true });
                cv.text(Math.round(p) + '%', cx, cy + 10, 30, '#ffffff', { literal: true, font: 'bold', align: 'center' });
                cv.text(prepText(), cx, cy + 100, 26, '#dddddd', { literal: true, align: 'center' });
            } else if (live) {
                const skip = (key, x, dir, ms) => ctl(key, x, cy, 42, () => model.skip(ms), (c) => {
                    cv.arc(x, cy, 19, 23.5, dir < 0 ? 0 : 60, dir < 0 ? 300 : 360, c);
                    cv.quad([[x - 1 * dir, cy - 29], [x + 9 * dir, cy - 21], [x - 1 * dir, cy - 13], [x - 1 * dir, cy - 29]], c);
                    cv.text('10', x, cy + 7, 18, c, { literal: true, font: 'bold', align: 'center' });
                });
                skip('ov:rw', cx - 210, -1, -10000);
                ctl('ov:play', cx, cy, 58, () => model.toggle(), (c) => {
                    if (model.state === 'paused') tri(cv, cx + 5, cy, 46, c);
                    else { cv.roundRect(cx - 17, cy - 22, 12, 44, 3, c); cv.roundRect(cx + 5, cy - 22, 12, 44, 3, c); }
                });
                skip('ov:ff', cx + 210, 1, 10000);
                // right: Video quality (a press takes the next one; the video starts again there) and zoom (fill crops)
                const qv = String(settings.get('quality') || 'auto'), fl = settings.get('fill') !== false, qx = SW - 330, zx = SW - 150;
                ctl('ov:q', qx, cy, 42, () => { const q = QUALITIES[(QUALITIES.indexOf(qv) + 1) % QUALITIES.length]; settings.set('quality', q); model.quality(q); },
                    (c) => cv.text(qv === 'auto' ? 'Auto' : qv + 'p', qx, cy + 8, 22, c, { literal: true, font: 'bold', align: 'center' }));
                cv.text('Quality', qx, cy + 76, 22, '#dddddd', { literal: true, align: 'center' });
                ctl('ov:zoom', zx, cy, 42, () => { settings.set('fill', !fl); model.fill(!fl); }, (c) => {
                    cv.strokeRoundRect(zx - 22, cy - 15, 44, 30, 4, 3, c);
                    if (fl) cv.fillRect(zx - 22, cy - 15, 44, 30, c); else cv.fillRect(zx - 12, cy - 15, 24, 30, c);
                });
                cv.text(fl ? 'Unzoom' : 'Zoom', zx, cy + 76, 22, '#dddddd', { literal: true, align: 'center' });
                // left, where the service plays through a way it found by trying (iDrive 8): "No sound?" - pressed
                // twice, the service leaves that way out and goes on with the next
                if (model.snd && model.snd.route) {
                    const sx = LX + 150, armed = sndArmed > Date.now();
                    ctl('ov:snd', sx, cy, 42, () => { if (sndArmed > Date.now()) { sndArmed = 0; model.noSound(); } else sndArmed = Date.now() + 6000; }, (c) => {
                        cv.fillRect(sx - 20, cy - 8, 10, 16, c);
                        cv.quad([[sx - 11, cy - 8], [sx + 2, cy - 19], [sx + 2, cy + 19], [sx - 11, cy + 8]], c);
                        cv.polyline([[sx + 9, cy - 9], [sx + 23, cy + 9]], 4, c);
                        cv.polyline([[sx + 23, cy - 9], [sx + 9, cy + 9]], 4, c);
                    });
                    cv.text(armed ? 'Press again: try another way' : 'No sound?', armed ? LX + 90 : sx, cy + 76, 22, armed ? '#ffd27a' : '#dddddd', { literal: true, align: armed ? 'left' : 'center' });
                }
            } else if (model.state === 'error' && model.id && model.connected) {
                ctl('ov:play', cx, cy, 58, again, (c) => retryGlyph(cv, cx, cy, 26, c));
                cv.text('Try again', cx, cy + 100, 26, '#dddddd', { literal: true, align: 'center' });
            }
            if (mid) cv.text(fit(cv, mid, 30, SW - 2 * LX, LIT), cx, model.state === 'preparing' || live || up || (model.state === 'error' && model.id) ? cy + 150 : cy + 10, 30, '#ffffff', { literal: true, align: 'center' });
            // bottom: the progress bar (the track, the part played, the scrubber) and the times
            if (model.total > 0 && live) {
                cv.gradientRect(0, SH - 150, SW, 150, [[0, '#00000000'], [1, '#000000d8']]);
                const x0 = LX + 40, w = SW - x0 - 40, y = SH - 66, el = shownAt(), fx = x0 + Math.round(w * Math.min(1, el / model.total)), bf = focusKey === 'ov:bar';
                const at = (ms) => x0 + Math.round(w * Math.min(1, ms / model.total)), ex = model.extras && model.extras.id === model.id ? model.extras : null;
                cv.roundRect(x0, y, w, 6, 3, '#ffffff55');
                cv.roundRect(x0, y, fx - x0, 6, 3, C.red);
                if (ex) sbSegs(ex).forEach((g) => cv.fillRect(at(g[0]), y, Math.max(3, at(g[1]) - at(g[0])), 6, sbColor(g)));   // SponsorBlock: skipped green, asked yellow
                if (ex) ex.chapters.forEach((c) => { if (c[0] > 0) cv.fillRect(at(c[0]) - 2, y, 4, 6, '#000000'); });
                if (bf) cv.circle(fx, y + 3, 18, '#ffffff');
                cv.circle(fx, y + 3, bf ? 14 : 10, C.red);
                tg(x0 - 10, y - 34, w + 20, 70, run(() => model.toggle()), 'ov:bar', 0, turnSeek);
                const tt0 = clock(el) + ' / ' + clock(model.total), tw = cv.textWidth(tt0, 24, LITB), chap = model.chapter();
                cv.text(tt0, x0, SH - 22, 24, '#ffffff', LITB);
                if (chap) cv.text(fit(cv, '·  ' + chap, 24, w - tw - 20, LIT), x0 + tw + 14, SH - 22, 24, '#dddddd', LIT);
            }
            if (model.toast && Date.now() < model.toast.until && live) {
                const tt = model.toast.text, tw2 = cv.textWidth(tt, 24, LIT) + 48, wn = model.toast.warn;
                cv.roundRect(LX + 40, SH - 150, tw2, 50, 25, wn ? '#4a3a10e6' : '#1f3d1fe6');
                cv.text(tt, LX + 64, SH - 116, 24, wn ? '#ffd27a' : '#7ee07e', LIT);
            }
            const ask = live && askSeg();
            if (ask) {
                const tt = 'Skip ' + sbName(ask[2]), w2 = cv.textWidth(tt, 28, LITB) + 70, sx = SW - 60 - w2, sy = SH - 168, f = focusKey === 'ov:sbskip';
                cv.roundRect(sx, sy, w2, 60, 30, f ? '#ffffff' : '#3a3a3ae6');
                cv.text(tt, sx + 35, sy + 40, 28, f ? '#0f0f0f' : '#ffffff', LITB);
                tg(sx, sy, w2, 60, run(sbJump(ask)), 'ov:sbskip', 30);
            }
            hmiIcons(cv);
        }
        // the HMI's home and back arrow column: its taps stay the HMI's, but no black hole over the video;
        // the same two icons where the HMI has them (screen px), on the scrim
        function hmiIcons(cv) {
            if (ID8) return;               // (iDrive 8: the surface is under the HMI's strip; no column of its there)
            cv.xf(1, 0, 0);
            cv.circle(44, 42, 30, '#00000099');
            RAIL[1][2](cv, 44, 44, '#ffffff', '#1a1a1a');
            cv.circle(52, 398, 30, '#00000099');
            cv.polyline([[60, 384], [46, 398], [60, 412]], 5, '#ffffff');
            cv.xf();
        }
        let last = null, lastRev = -1, lastT = 0, upNext = null;
        function render() {
            const now = Date.now();
            upNext = autoNext();
            // redraw on a change (and 4 times a second); unchanged, the same frame again keeps the layer alive (>= 1 message/s)
            if (!last || dirty || model.rev !== lastRev || now - lastT > 250) {
                dirty = false; lastRev = model.rev; lastT = now;
                const cv = ctx.canvas(W, H).clear(C.bg);
                frameNo++;
                if (mode === 'player' && cv.own && cv.place && cv.place.full) drawFull(cv);
                else {
                    if (browsing()) drawRail(cv);
                    if (mode === 'player') drawPlayer(cv); else if (mode === 'channel') drawChannel(cv); else if (mode === 'results') drawResults(cv); else drawFeed(cv, isFeed(mode) ? mode : 'home');
                    // where the kit runs the screen the rail has the pages: the header shows just the name
                    if (cv.own) G.frame(cv, ctx.theme(), [], -1); else G.frame(cv, ctx.theme(), TABS.map((m) => NAMES[m]), TABS.indexOf(mode));
                }
                last = cv;
            }
            return ui.image('VIEW_GFX', last);
        }
        ctx.loop('VIEW', 10, render);
        log.info('ridetube app started');
    },
});
