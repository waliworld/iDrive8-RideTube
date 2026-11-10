#!/usr/bin/env node
'use strict';
// Stand-in for ytdec: logs argv and every stdin line to $FAKE_YTDEC_LOG, prints ready and
// stats. FAKE_YTDEC_MODE: ok (decoded grows), stall (decoded stays 0), crash (exits after 200 ms).
const fs = require('fs');
const log = (s) => fs.appendFileSync(process.env.FAKE_YTDEC_LOG, process.pid + ' ' + s + '\n');
const mode = fs.existsSync(process.env.FAKE_YTDEC_LOG + '.mode') ? fs.readFileSync(process.env.FAKE_YTDEC_LOG + '.mode', 'utf8').trim() : 'ok';
log('argv ' + process.argv.slice(2).join(' '));
let decoded = 0;
console.log(JSON.stringify({ ev: 'ready', w: 1280, h: 720, fps: 30 }));
setInterval(() => {
    if (mode !== 'stall') decoded += 10;
    console.log(JSON.stringify({ ev: 'stats', decoded: decoded }));
}, 200);
if (mode === 'crash') setTimeout(() => process.exit(3), 200);
let buf = '';
process.stdin.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
        const l = buf.slice(0, i);
        buf = buf.slice(i + 1);
        log('in ' + l);
        if (l === 'quit') process.exit(0);
    }
});
process.stdin.on('end', () => process.exit(0));
