'use strict';
// BMW's oap-sdk, for the kit on iDrive 8 (build.py --hmi ID8 ships this file as kit/sdk.js).
//
// The MGU Store's deploy tool builds an iDrive 8 app from its source package: it links the app's entry module
// (kit/id8/boot.js) against the oap-sdk of an app already on the car. The entry module gives those SDK modules, and
// its host, to the kit through this module (give) before it loads the app.
//
// Through this module, not through a global: on the car the linked bundle does not run with the "global" the
// package's files see (the head unit's entry point loads the bundle its own way), so what the entry module put on
// its global was not there for the kit (0.4.3: "the kit was loaded without the app's entry module"). Node's module
// cache is one per process: the entry module asks for this file by its full path, the kit as './sdk', and both get
// this object.
//
// This file must not name the SDK in a require call: a package that does is not given one on iDrive 8, and the
// deploy tool refuses a built package that still asks for it.
const held = { sdk: null, host: null };
const sdk = () => {
    if (!held.sdk) throw new Error('iDrive 8: the kit was loaded before the app\'s entry module gave it the SDK (kit/id8/boot.js give)');
    return held.sdk;
};
module.exports = {
    /** (kit/id8/boot.js, before it loads the app) the SDK modules the head unit linked, and the entry module's host */
    give(modules, host) { held.sdk = modules; held.host = host; },
    get OnlineApp() { return sdk().OnlineApp; },
    get logging() { return sdk().logging; },
    get someipBuilders() { return sdk().someipBuilders; },
    /** the entry module's host: its OnlineApp, its facts and its events (null before give) */
    get host() { return held.host; },
};
