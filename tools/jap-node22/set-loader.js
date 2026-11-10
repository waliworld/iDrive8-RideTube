'use strict';
// Sets an x86-64 ELF executable's loader (PT_INTERP) in place: the unit has no /lib64, only
// /lib/ld-linux-x86-64.so.2. Modified 2026-11 from setLoader in the MGU Store (github.com/robertnisipeanu/mgu-store,
// native/mgu-python/build.js, GPL-3.0): made a standalone script. GPL-3.0-or-later, as its source.
//   node set-loader.js <file> <loader>
const fs = require('fs');

function setLoader(buf, loader) {
    if (buf.readUInt32BE(0) !== 0x7f454c46 || buf[4] !== 2 || buf[5] !== 1 || buf.readUInt16LE(18) !== 62) {
        throw new Error('not an x86-64 ELF');
    }
    const u64 = (at) => buf.readUInt32LE(at) + buf.readUInt32LE(at + 4) * 0x100000000;
    const phoff = u64(32);
    const phentsize = buf.readUInt16LE(54);
    for (let i = 0; i < buf.readUInt16LE(56); i += 1) {
        const ph = phoff + i * phentsize;
        if (buf.readUInt32LE(ph) === 3) { // PT_INTERP
            const off = u64(ph + 8);
            const size = u64(ph + 32);
            if (Buffer.byteLength(loader) + 1 > size) {
                throw new Error(`${loader} does not fit the ${size}-byte loader path`);
            }
            buf.fill(0, off, off + size);
            buf.write(loader, off);
            return buf.toString('latin1', off, off + size).replace(/\0+$/, '');
        }
    }
    throw new Error('no loader path (PT_INTERP)');
}

const [file, loader] = process.argv.slice(2);
const buf = fs.readFileSync(file);
const got = setLoader(buf, loader);
if (got !== loader) {
    throw new Error(`loader reads back as ${got}`);
}
fs.writeFileSync(file, buf);
