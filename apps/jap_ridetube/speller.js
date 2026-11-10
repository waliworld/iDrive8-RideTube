'use strict';
/**
 * The HMI's own full-screen free-text speller, opened as the Store app opens it: the use case
 * 02076b22-d19b-4aef-9e8c-0d7305d8b88c through the SDK's use case factory (needs the
 * usecasemanagement proxies, which build.py gives every app).
 *
 *   spell(ctx.app, 'Search videos').then((text) => ...)   // text, or null when left without OK
 *
 * Interaction parameters: 4 the title (22 characters show), 102 the text so far (each keystroke),
 * 105 present once the driver pressed OK. Written for this kit (the Store's speller.js is GPL).
 */
const USE_CASE = '02076b22-d19b-4aef-9e8c-0d7305d8b88c';
const P_TITLE = 4, P_INPUT = 102, P_OK = 105;
const FINAL = ['ABORTED', 'FAILED', 'COMPLETED'];

function timeout(p, ms, what) {
    let t;
    return Promise.race([p, new Promise((res, rej) => { t = setTimeout(() => rej(new Error(what + ' timed out')), ms); })])
        .then((v) => { clearTimeout(t); return v; }, (e) => { clearTimeout(t); throw e; });
}

function spell(app, title) {
    return new Promise((resolve, reject) => {
        let inst = null, sub = null, text = '', done = false;
        const finish = (err, v) => {
            if (done) return;
            done = true;
            Promise.resolve().then(() => (inst && sub !== null ? inst.proxy.notify.unsubscribe(sub) : null)).catch(() => {})
                .then(() => (err ? reject(err) : resolve(v)));
        };
        timeout(Promise.resolve().then(() => app.getUseCaseFactory()), 10000, 'use case factory')
            .then((f) => f.create(USE_CASE))
            .then((i) => { inst = i; return inst.proxy.init(); })
            .then(() => inst.proxy.waitUntilAvailable())
            .then(() => inst.proxy.notify.subscribe((n) => {
                const p = n && n.interactionParameters;     // Map-like, not always this realm's Map
                const has = (k) => !!p && typeof p.has === 'function' && p.has(k);
                if (has(P_INPUT)) text = String(p.get(P_INPUT));
                if (has(P_OK)) finish(null, text);
                else if (n && FINAL.indexOf(n.interactionState) >= 0) finish(null, null);
            }))
            .then((id) => {
                sub = id === undefined ? null : id;
                if (done) return null;
                return Promise.resolve(inst.proxy.interactionState.getValue()).then((st) => {
                    if (st !== 'READY') throw new Error('speller is ' + st + ', not READY');
                    return inst.proxy.start({ token: inst.token, startParameters: new Map([[P_TITLE, String(title).slice(0, 22)]]) });
                });
            })
            .catch((e) => finish(e));
    });
}

module.exports = { spell };
