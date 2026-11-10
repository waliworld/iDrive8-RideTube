'use strict';
// kit/runtime/parked.js: strict mode counts no speed, and a speed older than STALE_MS, as moving.
//   node kit/tools/test_parked.js
const assert = require('assert');
const path = require('path');
const { watch, STALE_MS } = require(path.join(__dirname, '..', 'runtime', 'parked.js'));

let cb = null, t = 0;
const ctx = { signals: { watch: (iface, inst, h) => { cb = h.statusCarSpeed2; return Promise.resolve({}); } } };
const strict = watch(ctx, null, { strict: true, now: () => t });
assert.strictEqual(strict.moving(), true, 'strict: no speed yet = moving');
cb({ speedVehicleCentreOfGravity: 0 });
assert.strictEqual(strict.moving(), false, 'parked');
t += STALE_MS + 1;
assert.strictEqual(strict.moving(), true, 'strict: stale reading = moving');
cb({ speedVehicleCentreOfGravity: 0 });
assert.strictEqual(strict.moving(), false, 'fresh again');
cb({ speedVehicleCentreOfGravity: 64 * 10 });
assert.strictEqual(strict.moving(), true, '10 km/h = moving');
const lax = watch(ctx, null, { now: () => t });
assert.strictEqual(lax.moving(), false, 'not strict: no speed = parked');
cb({ speedVehicleCentreOfGravity: 0 }); t += STALE_MS * 3;
assert.strictEqual(lax.moving(), false, 'not strict: quiet after standing = parked');
console.log('parked: OK');
