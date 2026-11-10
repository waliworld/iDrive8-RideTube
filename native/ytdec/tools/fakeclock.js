// Feeds ytdec a fake audio clock on stdout: `clock <elapsed> <mono>` every
// 500 ms from elapsed 0, CLOCK_MONOTONIC from process.hrtime (libuv), then
// `quit` after SECS. Extra args are commands sent at given seconds:
//   node fakeclock.js 30 "10:seek 20000" ...   (node 8 on the unit: no BigInt)
var secs = +process.argv[2] || 30;
var extra = process.argv.slice(3).map(function (a) { var i = a.indexOf(':'); return [+a.slice(0, i), a.slice(i + 1)]; });
function mono() { var t = process.hrtime(); return Math.floor(t[0] * 1000 + t[1] / 1e6); }
var t0 = 0, base = 0;   // elapsed 0 at the first clock line
function tick() {
    var now = mono();
    if (!t0) t0 = now;
    var el = now - t0;
    extra = extra.filter(function (e) {
        if (el < e[0] * 1000) return true;
        process.stdout.write(e[1] + '\n');
        var m = /^seek (\d+)/.exec(e[1]);
        if (m) { base = +m[1] - el; }
        return false;
    });
    if (el >= secs * 1000) { process.stdout.write('quit\n'); return; }
    process.stdout.write('clock ' + (el + base) + ' ' + now + '\n');
    setTimeout(tick, 500);
}
setTimeout(tick, 1000);   // 1 s of "no clock yet": ytdec holds frame 0
