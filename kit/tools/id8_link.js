'use strict';
// iDrive 8: builds an app's source package (dist/src/<id>, kit/tools/build.py --hmi ID8) the way the head unit does -
// with the MGU Store's own linker (tools/oap_link.js of a clone of github.com/robertnisipeanu/mgu-store, the file its
// deploy tool runs on the car) - against a stand-in for an app already on the car: a bundle whose oap-sdk modules
// hand out whatever global.__mguFakeSdk holds when the built app runs (mgu8_harness.js sets it).
//
//   const { linkId8 } = require('./id8_link');
//   const r = linkId8(storeDir, 'dist/src/<id>', workDir);   // -> { dir: the built package (an app's source/ folder),
//                                                            //      build: the linker's answer, link: the linker }
// No SDK code and none of the Store's: the bundle's prelude is read from the Store's own test donor at run time.
const fs = require('fs');
const path = require('path');

// the three require names an app's entry module links against (kit/tools/build.py ID8_SDK), as a stock app's own entry
// module names them; each stand-in exports the class / object itself or, with shape 'member', as its member of that
// name (the two shapes the Store's linker knows)
const NAMES = { 'oap-sdk/src/core/OnlineApp.js': 'OnlineApp', 'oap-sdk/src/logging/logging': 'logging', 'oap-sdk/src/someip/someipBuilders': 'someipBuilders' };
// a stock entry point: it runs the bundle its runnerConfig.json names (the linker copies it as the app's main)
const ENTRY = "'use strict';\n// (stand-in for a stock app's entry point)\nvar path = require('path');\n" +
    "var config = JSON.parse(require('fs').readFileSync(path.join(__dirname, 'runnerConfig.json'), 'utf8'));\n" +
    "require(path.join(__dirname, config.JS_RELATIVE_PATH));\n";

function donor(storeDir, dir) {
    const sample = require(path.join(storeDir, 'tools', 'test', 'synthetic_donor.js')).bundle();
    const end = sample.indexOf('return r})()');
    if (end < 0) throw new Error('the Store\'s test donor has no browserify prelude');
    const prelude = sample.slice(0, end + 'return r})()'.length);
    const names = Object.keys(NAMES);
    const mods = ['1:[function(require,module,exports){\n' + names.map((n) => 'require(' + JSON.stringify(n) + ');').join('') + '\n},' +
        JSON.stringify(names.reduce((o, n, i) => { o[n] = i + 2; return o; }, {})) + ']']
        .concat(names.map((n, i) => (i + 2) + ':[function(require,module,exports){\nvar s=global.__mguFakeSdk,v=s[' + JSON.stringify(NAMES[n]) +
            '];if(s.shape==="member"){module.exports={};module.exports[' + JSON.stringify(NAMES[n]) + ']=v}else module.exports=v;\n},{}]'));
    fs.mkdirSync(path.join(dir, 'javascript'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'stock_app', version: '1.0.0', main: 'javascript/entry.js', dependencies: { 'oap-sdk': '50.0.0' } }));
    fs.writeFileSync(path.join(dir, 'javascript', 'entry.js'), ENTRY);
    fs.writeFileSync(path.join(dir, 'javascript', 'app.js'), prelude + '({' + mods.join(',') + '},{},[1]);\n');
    return path.join(dir, 'javascript', 'app.js');
}

function linkId8(storeDir, srcDir, workDir) {
    const link = require(path.join(storeDir, 'tools', 'oap_link.js'));
    const m = link.readManifest(srcDir);
    const out = path.join(workDir, m.id + '@' + m.version + '.tgz');
    const build = link.build(srcDir, out, { donors: [donor(storeDir, path.join(workDir, 'stock_app'))], workDir });
    const dir = path.join(workDir, 'built');
    link.untar(fs.readFileSync(out)).forEach((f) => {
        const p = path.join(dir, f.name);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, f.data);
    });
    return { dir, build, link, manifest: m, tgz: out };
}

module.exports = { linkId8, NAMES };

if (require.main === module) {
    const [storeDir, srcDir, workDir] = process.argv.slice(2);
    if (!workDir) { console.error('usage: node kit/tools/id8_link.js <mgu-store clone> <dist/src/id> <empty work dir>'); process.exit(2); }
    fs.mkdirSync(workDir, { recursive: true });
    const r = linkId8(path.resolve(storeDir), path.resolve(srcDir), path.resolve(workDir));
    console.log(JSON.stringify({ dir: r.dir, build: r.build }));
}
