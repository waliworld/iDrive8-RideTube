'use strict';
// BMW's oap-sdk, for the kit.
// iDrive 7: the module node_modules/oap-sdk, which the MGU Store's deploy tool generates on the head unit from an app
// already on the car (it looks for the call below). iDrive 8: the deploy tool generates no such module there, so
// build.py ships kit/id8/sdk.js in this file's place: the SDK the head unit linked into the app's entry module.
module.exports = require('oap-sdk');
