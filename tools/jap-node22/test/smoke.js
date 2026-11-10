'use strict';
// Smoke test for the shipped node binary on an old glibc (run as root, with internet):
//   node --max-http-header-size=65536 test/smoke.js
// Exits non-zero on the first failing check.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const https = require('https');
const cp = require('child_process');
const dns = require('dns');

const checks = [];
const check = (name, fn) => checks.push([name, fn]);

check('version', async () => {
    assert.match(process.version, /^v22\./);
    return process.version;
});

check('max-http-header-size flag', async () => {
    assert.strictEqual(http.maxHeaderSize, 65536);
    // a 40 KB header passes only with the raised limit (default 16 KB)
    const srv = http.createServer((req, res) => res.end(String(req.headers['x-big'].length)));
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const body = await new Promise((resolve, reject) => {
        http.get({ port: srv.address().port, host: '127.0.0.1', headers: { 'x-big': 'a'.repeat(40000) } }, (res) => {
            let b = '';
            res.on('data', (d) => { b += d; }).on('end', () => resolve(b));
        }).on('error', reject);
    });
    srv.close();
    assert.strictEqual(body, '40000');
    return `maxHeaderSize=${http.maxHeaderSize}, 40 KB header accepted`;
});

check('TLS without system CA files', async () => {
    const sys = ['/etc/ssl/certs/ca-certificates.crt', '/etc/ssl/cert.pem'].filter((f) => fs.existsSync(f));
    const status = await new Promise((resolve, reject) => {
        https.get('https://www.youtube.com/', (res) => { res.resume(); resolve(res.statusCode); })
            .on('error', reject);
    });
    assert.ok(status >= 200 && status < 400, `status ${status}`);
    return `https://www.youtube.com/ -> ${status}; system CA files present: ${sys.length ? sys.join(',') : 'none'}`;
});

check('child_process spawn with uid/gid', async () => {
    // spawns this node itself, so the check needs no system binary (and no /lib64 loader)
    const out = cp.spawnSync(process.execPath, ['-p', 'process.getuid()+" "+process.getgid()'],
        { uid: 65534, gid: 65534, encoding: 'utf8' });
    assert.strictEqual(out.status, 0, out.stderr || String(out.error));
    assert.strictEqual(out.stdout.trim(), '65534 65534');
    return `child uid gid = ${out.stdout.trim()}`;
});

check('dns.Resolver', async () => {
    const r = new dns.promises.Resolver();
    const a = await r.resolve4('www.youtube.com');
    assert.ok(a.length > 0);
    return `www.youtube.com A ${a[0]} (${r.getServers().join(',')})`;
});

(async () => {
    for (const [name, fn] of checks) {
        try {
            console.log(`ok   ${name}: ${await fn()}`);
        } catch (e) {
            console.log(`FAIL ${name}: ${e.message}`);
            process.exitCode = 1;
            return;
        }
    }
})();
