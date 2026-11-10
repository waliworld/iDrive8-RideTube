'use strict';

// life.js: the status MainApp gets, against a fake OnlineApp. No SDK or car needed:
//   node kit/tools/test_life.js

const assert = require('assert');
const { Life } = require('../runtime/life');

async function main() {
    const sent = [];
    const app = { registerActive() { sent.push('A'); }, registerInactive() { sent.push('I'); } };
    const log = { info() {}, warn(m) { throw new Error(m); } };
    const life = new Life(app, log);

    await life.sync(true);
    assert.deepStrictEqual(sent, ['A'], 'active from start, before it is first shown');
    await life.setShown(false);
    assert.deepStrictEqual(sent, ['A'], 'a stack without the app before it was ever shown is not a hide');
    await life.setShown(true);
    assert.deepStrictEqual(sent, ['A'], 'no resend while unchanged');
    await life.setShown(false);
    assert.deepStrictEqual(sent, ['A', 'I'], 'hidden: inactive, so MainApp may stop it');
    await life.sync(true);
    assert.deepStrictEqual(sent, ['A', 'I', 'I'], 'force resends the current status');

    await life.hold('datalog', true);
    assert.deepStrictEqual(sent.slice(-1), ['A'], 'background work keeps a hidden app active');
    await life.hold('popups', true);
    await life.hold('datalog', false);
    assert.deepStrictEqual(sent.slice(-1), ['A'], 'active while any work holds');
    await life.hold('popups', false);
    assert.deepStrictEqual(sent.slice(-1), ['I'], 'inactive once the last work ends');

    await life.setWidget(true);
    assert.deepStrictEqual(sent.slice(-1), ['A'], 'a home-screen widget keeps it active');
    await life.setShown(true);
    await life.setShown(false);
    assert.deepStrictEqual(sent.slice(-1), ['A'], 'still active hidden while the widget is placed');

    // a failed send is logged, never thrown (an exception would exit the app: CorruptAppsHandler)
    const warned = [];
    const bad = new Life({ registerActive() { throw new Error('no proxy'); } }, { info() {}, warn(m) { warned.push(m); } });
    await bad.sync(true);
    assert.ok(/no proxy/.test(warned[0]), warned[0]);
    bad.app.registerActive = () => { warned.push('sent'); };
    await bad.sync();
    assert.strictEqual(warned[1], 'sent', 'a failed send is sent again at the next sync');

    console.log('life: all checks pass');
}

main().catch((e) => { console.error(e); process.exit(1); });
