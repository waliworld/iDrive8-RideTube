// SPDX-License-Identifier: GPL-3.0-or-later
// Turns the text tools/id8_collect.js wrote back into files:  node tools/id8_unpack.js ridetube-id8-data.txt <folder>
// Takes the text however it arrived: with other lines around it, with CRLF, or as UTF-16 (a PowerShell redirect).
'use strict';
const fs = require('fs'), path = require('path'), zlib = require('zlib');

function decode(buf) {
    let text;
    if (buf.length > 1 && buf[0] === 0xff && buf[1] === 0xfe) text = buf.slice(2).toString('utf16le');
    else if (buf.length > 3 && buf[1] === 0 && buf[3] === 0) text = buf.toString('utf16le');
    else text = buf.toString('latin1');
    const a = text.indexOf('-----BEGIN RIDETUBE ID8 DATA-----'), b = text.indexOf('-----END RIDETUBE ID8 DATA-----');
    if (a < 0) throw new Error('no RideTube data in this file (the BEGIN line is missing)');
    if (b < a) throw new Error('the data is cut off (the END line is missing): the copy did not finish');
    const b64 = text.slice(a + 33, b).replace(/[^A-Za-z0-9+/=]/g, '');
    return JSON.parse(zlib.gunzipSync(Buffer.from(b64, 'base64')).toString('utf8'));
}
function unpack(data, dir) {
    const root = path.resolve(dir);
    Object.keys(data.files).forEach((p) => {
        const to = path.resolve(root, 'files', '.' + path.posix.normalize('/' + p.replace(/#/g, '.')));
        if (to.indexOf(root + path.sep) !== 0) throw new Error('refused: ' + p);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.writeFileSync(to, data.files[p].text);
    });
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'lists.json'), JSON.stringify(data.lists, null, 1));
    fs.writeFileSync(path.join(root, 'commands.txt'), Object.keys(data.commands).map((k) => '===== ' + k + '\n' + data.commands[k]).join('\n\n'));
    fs.writeFileSync(path.join(root, 'notes.txt'), ['made ' + data.made + ' by Node ' + data.node + ' in ' + data.took_ms + ' ms'].concat(data.notes,
        Object.keys(data.files).filter((p) => data.files[p].cut).map((p) => p + ': ' + data.files[p].cut + ' of ' + data.files[p].size)).join('\n') + '\n');
}
module.exports = { decode, unpack };
if (require.main === module) {
    if (process.argv.length < 4) { console.error('usage: node tools/id8_unpack.js <the text file> <folder>'); process.exit(2); }
    const data = decode(fs.readFileSync(process.argv[2]));
    unpack(data, process.argv[3]);
    console.log(Object.keys(data.files).length + ' files, ' + Object.keys(data.commands).length + ' command outputs -> ' + process.argv[3]);
}
