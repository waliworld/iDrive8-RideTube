'use strict';
// BMW's oap-sdk, for the kit on iDrive 8 (build.py --hmi ID8 ships this file as kit/sdk.js).
// The MGU Store's deploy tool builds an iDrive 8 app from its source package: it links the app's entry module
// (kit/id8/boot.js) against the oap-sdk of an app already on the car. The entry module hands those SDK modules to the
// kit here. This file must not name the SDK in a require call: a package that does is not given one on iDrive 8, and
// the deploy tool refuses a built package that still asks for it.
if (!global.__mguSdk) throw new Error('iDrive 8: the kit was loaded without the app\'s entry module (kit/id8/boot.js)');
module.exports = global.__mguSdk;
