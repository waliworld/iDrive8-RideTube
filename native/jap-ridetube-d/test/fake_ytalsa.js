#!/usr/bin/env node
'use strict';
/* A stand-in for ytalsa.py in the tests of sound.js. A device's way is in FAKE_ALSA_WAYS ({ name: way }):
 *   'flows' | 'stalls' | 'fast'       whatever the car has connected ('stalls' when not named)
 *   'flows@am'                        flows while the audio manager has our source connected, else stalls
 *   'flows@focus:<instance>'          flows while that dynamic player instance has given its focus, else stalls
 *   'busy' | 'error'                  does not open
 *   'silent'                          play: says nothing at all
 * (what is connected is read from FAKE_ALSA_STATE, a file the stand-in car keeps: { am, focus: [instances] }).
 * "probe" prints FAKE_ALSA_PROBE (or four devices, one of them open in another program); "scan" the verdict of each
 * device named; "play" speaks ytalsa.py's lines. What it is asked goes to FAKE_ALSA_LOG. */
const fs = require('fs');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const log = (t) => { if (process.env.FAKE_ALSA_LOG) fs.appendFileSync(process.env.FAKE_ALSA_LOG, t + '\n'); };
const arg = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
const mode = process.argv.filter((a) => a === 'probe' || a === 'scan' || a === 'play')[0];
const ways = JSON.parse(process.env.FAKE_ALSA_WAYS || '{}');
function wayOf(dev) {
    const w = ways[dev] || 'stalls';
    let st = {};
    try { st = JSON.parse(fs.readFileSync(process.env.FAKE_ALSA_STATE, 'utf8')); } catch (e) { st = {}; }
    if (w === 'flows@am') return st.am ? 'flows' : 'stalls';
    const m = /^flows@focus:(.+)$/.exec(w);
    if (m) return (st.focus || []).indexOf(m[1]) >= 0 ? 'flows' : 'stalls';
    return w;
}
if (mode === 'probe') {
    log('probe');
    process.stdout.write(process.env.FAKE_ALSA_PROBE || JSON.stringify({ devices: [{ name: 'plug:smartx:OAPMedia', sure: 2 }, { name: 'plug:smartx:Dynamic', sure: 2 },
        { name: 'plug:smartx:Entertainment', sure: 2, held: 'mediaengine (4103)' }, { name: 'plug:smartx:Gone', sure: 0 }],
    shm: ['smartx_OAPMedia_p_ringbuffer', 'smartx_Dynamic_p_ringbuffer', 'smartx_Entertainment_p_ringbuffer', 'smartx_Mic_c_ringbuffer'], run: ['Entertainment: mediaengine (4103)', 'OAPMedia'], conf: ['OAPMedia', 'Dynamic'], map: ['OAPMedia: OapGenericMedia'], others: (process.env.FAKE_ALSA_OTHERS || '').split(',').filter(Boolean).map((n) => 'plug:smartx:' + n), notes: [] }));
    process.exit(0);
}
if (mode === 'scan') {
    const devs = JSON.parse(arg('--devices'));
    log('scan ' + devs.map((d) => d.replace('plug:smartx:', '')).join(','));
    if (process.env.FAKE_ALSA_SCAN_FAILS) { process.stdout.write(JSON.stringify({ error: 'libasound could not be loaded: no such file' })); process.exit(0); }
    process.stdout.write(JSON.stringify({ ms: Number(arg('--ms')), devices: devs.map((name) => {
        const w = wayOf(name);
        if (w === 'busy') return { name: name, open: false, error: 'Device or resource busy' };
        if (w === 'error' || name === 'plug:smartx:Gone') return { name: name, open: false, error: 'No such device' };
        return { name: name, open: true, buffer: 9600, period: 2400, took: w === 'flows' ? 81600 : 9600, ratio: w === 'flows' ? 1 : w === 'fast' ? 9.5 : 0, verdict: w === 'silent' ? 'stalls' : w };
    }) }));
    process.exit(0);
}
const dev = arg('--device');
const way = wayOf(dev);
log(dev + '\tplay ' + arg('--file') + ' at ' + arg('--start-ms') + ' decoder ' + arg('--decoder'));
if (way === 'error' || way === 'busy') { out({ ev: 'error', msg: 'cannot open ' + dev + ': ' + (way === 'busy' ? 'Device or resource busy' : 'No such device') }); process.exit(3); }
if (way === 'silent') { setTimeout(() => process.exit(0), 20000); return; }
out({ ev: 'open', device: dev, rate: 48000, channels: 2, buffer: 9600, period: 2400 });
let base = Number(arg('--start-ms')) || 0, t0 = Date.now(), playing = true;
const pos = () => base + (playing ? Date.now() - t0 : 0);
setTimeout(() => {
    out({ ev: 'flow', verdict: way, ratio: way === 'flows' ? 1.01 : way === 'fast' ? 9.5 : 0 });
    if (way !== 'flows') return;
    out({ ev: 'state', state: 'PLAYER_STATE_PLAY' });
    setInterval(() => { if (playing) out({ ev: 'time', elapsed: pos(), total: 180000 }); }, 40);
}, 60);
require('readline').createInterface({ input: process.stdin }).on('line', (l) => {
    log(dev + '\t' + l);
    const m = /^(\w+)\s*(.*)$/.exec(l) || [];
    if (m[1] === 'quit') process.exit(0);
    if (m[1] === 'pause') { base = pos(); playing = false; out({ ev: 'state', state: 'PLAYER_STATE_STOP' }); }
    if (m[1] === 'resume') { t0 = Date.now(); playing = true; out({ ev: 'state', state: 'PLAYER_STATE_PLAY' }); setTimeout(() => out({ ev: 'resumed', ok: wayOf(dev) === 'flows' }), 30); }
    if (m[1] === 'seek') { base = Number(m[2]) || 0; t0 = Date.now(); }
    if (m[1] === 'file') { base = 0; t0 = Date.now(); playing = true; out({ ev: 'state', state: 'PLAYER_STATE_PLAY' }); }
    if (m[1] === 'end') { out({ ev: 'eof' }); playing = false; }
}).on('close', () => process.exit(0));
