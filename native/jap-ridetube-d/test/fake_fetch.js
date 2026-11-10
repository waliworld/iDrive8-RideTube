#!/usr/bin/env node
'use strict';
// stands in for `ytd.js --fetch` in test_ytd.js: argv = [log, mode]; logs its argv, env and stdin, answers
const fs = require('fs');
const log = process.argv[2], mode = process.argv[3];
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
    fs.writeFileSync(log, JSON.stringify({ argv: process.argv, env: Object.keys(process.env), pid: process.pid, uid: process.getuid(), req: JSON.parse(input) }));
    if (mode === 'hang') return setInterval(() => {}, 1000);
    return process.stdout.write(JSON.stringify(mode === 'error' ? { error: 'ENETUNREACH' } : { status: 200, body: 'hello' }), () => process.exit(0));
});
