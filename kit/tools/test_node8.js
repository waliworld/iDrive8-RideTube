'use strict';
// The head unit runs the apps on Node 8, and its deploy tool checks an iDrive 8 app's entry module with that Node
// before it links it: one construct Node 8 does not parse and the install is refused, or the app ends at start.
// Parses every javascript file that ships in an app package (the kit's runtime, the iDrive 8 entry module and SDK
// shim, the app's own code) as ES2018 at most and looks for the newer runtime calls that have slipped in before.
//   node kit/tools/test_node8.js
// Uses the parser inside this Node (acorn); a Node without it is said and the check skipped.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..', '..');
const js = (dir) => fs.readdirSync(path.join(root, dir)).filter((f) => /\.js$/.test(f)).map((f) => path.join(dir, f));
const files = js('kit/runtime').concat(js('kit/id8'));
fs.readdirSync(path.join(root, 'apps')).forEach((a) => { if (fs.existsSync(path.join(root, 'apps', a, 'app.json'))) files.push(...js(path.join('apps', a))); });

let acorn = null;
try {
    const natives = process.binding('natives');
    const key = Object.keys(natives).filter((k) => /acorn\/dist\/acorn$/.test(k))[0];
    const mod = { exports: {} };
    vm.runInThisContext('(function (exports, module) {' + natives[key] + '\n})')(mod.exports, mod);
    acorn = mod.exports;
    acorn.parse('var a = 1;', { ecmaVersion: 2018 });
} catch (e) { acorn = null; }
if (!acorn) { console.log('skip (this Node has no parser to check with)'); process.exit(0); }

// calls and syntax past Node 8 that a parser set to ES2018 lets through or that are runtime only
const NEWER = /\.finally\(|\.flat\(|\.flatMap\(|Object\.fromEntries|\.matchAll\(|\.trimStart\(|\.trimEnd\(|\.replaceAll\(|Promise\.allSettled|globalThis|queueMicrotask|fs\.promises|\.rmSync\(|\.cpSync\(|mkdirSync\([^)]*recursive|BigInt\(|\.at\(-?\d|Object\.hasOwn\(|structuredClone|AbortController|\(\?<[a-zA-Z=!]|\\p\{/;
let bad = 0;
for (const f of files) {
    const src = fs.readFileSync(path.join(root, f), 'utf8').replace(/^#!.*/, '');
    try { acorn.parse(src, { ecmaVersion: 2018, sourceType: 'script', allowReturnOutsideFunction: true }); } catch (e) { bad++; console.log('not ok ' + f + ': Node 8 does not parse it: ' + e.message); continue; }
    // (object spread / rest and async iteration are ES2018 but Node 8.3+ has the first and not the second)
    const lines = src.split('\n');
    lines.forEach((l, i) => {
        const code = l.replace(/\/\/.*$/, '');
        if (NEWER.test(code) || /for await\s*\(/.test(code)) { bad++; console.log('not ok ' + f + ':' + (i + 1) + ': newer than Node 8: ' + l.trim().slice(0, 100)); }
    });
}
if (bad) { console.log('node8: ' + bad + ' problem(s)'); process.exit(1); }
console.log('ok   ' + files.length + ' files of the app packages parse as Node 8 does\nnode8: all ok');
