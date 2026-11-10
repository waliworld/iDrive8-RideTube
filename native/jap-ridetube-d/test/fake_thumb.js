#!/usr/bin/env node
'use strict';
// stands in for thumb.js in test_ytd.js: argv = [log, id]. Ids starting Z fail, H hang, S give a short answer.
const fs = require('fs');
const log = process.argv[2], id = process.argv[3];
fs.appendFileSync(log, JSON.stringify({ id: id, env: Object.keys(process.env), cwd: process.cwd() }) + '\n');
if (id[0] === 'Z') { process.stderr.write('no thumbnail\n'); process.exit(1); }
if (id[0] === 'H') setInterval(() => {}, 1000);
else process.stdout.write(Buffer.alloc(id[0] === 'S' ? 1000 : 230400, 9));
