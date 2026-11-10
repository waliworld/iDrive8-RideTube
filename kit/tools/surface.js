'use strict';
/**
 * surface.js - a renderer frame as the screen shows it, in software, for previews and tests: the app's page at the
 * placement's scale and offset, and the parts drawn in surface pixels (xf: the kit's header, the player) as they
 * are, over a stand-in for the HMI around the surface. Approximate: clips are not applied (but for CLEAR), layers and
 * pictures are scaled nearest-pixel, a video is a labelled box.
 *
 *   const { surfaceCanvas } = require('./surface');
 *   const cv = surfaceCanvas(words, display.place, display.gpu.screen);   // canvas.js Canvas, screen size
 *   fs.writeFileSync('frame.png', cv.png());
 */
const path = require('path');

function surfaceCanvas(words, place, screen, kitDir) {
    let pl = place;
    const kit = kitDir || path.join(__dirname, '..', 'runtime');
    const { Canvas } = require(path.join(kit, 'canvas'));
    const R = require(path.join(kit, 'record'));
    // drawn on a canvas the surface's size (nothing reaches past it, as on the renderer), then put on the screen
    const screenCv = new Canvas(screen.w, screen.h).clear('#3a3f4b');
    // the HMI around the surface: its strip above, anything below (iDrive 8: the climate bar)
    if (pl.y > 30) screenCv.text('HMI', 24, Math.min(56, pl.y - 16), 36, '#9aa0ae', { literal: true });
    if (pl.y + pl.h < screen.h) screenCv.text('HMI', 24, pl.y + pl.h + 70, 36, '#9aa0ae', { literal: true });
    const cv = new Canvas(pl.w, pl.h).clear('#3a3f4b');
    const done = () => screenCv.blit(cv, place.x, place.y);
    pl = Object.assign({}, pl, { x: 0, y: 0 });
    const base = { s: pl.scale, ox: pl.ox || 0, oy: pl.oy || 0 };
    let T = base, clip = null, alpha = 1;
    const X = (x) => x * T.s + T.ox, Y = (y) => y * T.s + T.oy, S = (v) => v * T.s;
    const u = words instanceof Uint32Array ? words : new Uint32Array(words);
    const f = new Float32Array(u.buffer, u.byteOffset, u.length);
    const col = (v) => { const a = R.unpack(v); if (alpha < 1) a[3] = Math.round(a[3] * alpha); return a; };
    const OP = R.OP;
    let i = 0;
    while (i < u.length) {
        const op = u[i++];
        switch (op) {
        case OP.CLEAR: {
            // inside a clip: that part of the surface (transparent: the HMI shows, drawn here as its stand-in)
            const c = R.unpack(u[i]); i += 1;
            const r = clip || [(-T.ox + pl.x) / T.s, (-T.oy + pl.y) / T.s, pl.w / T.s, pl.h / T.s];
            if (c[3] === 0) {
                const x0 = Math.max(0, Math.round(X(r[0]))), y0 = Math.max(0, Math.round(Y(r[1])));
                const x1 = Math.min(cv.w, Math.round(X(r[0] + r[2]))), y1 = Math.min(cv.h, Math.round(Y(r[1] + r[3])));
                for (let y = y0; y < y1; y++) cv.d.fill(0, (y * cv.w + x0) * 4, (y * cv.w + x1) * 4);
                for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const o = (y * cv.w + x) * 4; cv.d[o] = 0x3a; cv.d[o + 1] = 0x3f; cv.d[o + 2] = 0x4b; cv.d[o + 3] = 255; }
            } else cv.fillRect(X(r[0]), Y(r[1]), S(r[2]), S(r[3]), c);
            break;
        }
        case OP.RECT: cv.fillRect(X(f[i]), Y(f[i + 1]), S(f[i + 2]), S(f[i + 3]), col(u[i + 4])); i += 5; break;
        case OP.GRAD: case OP.CARD: {
            const card = op === OP.CARD, x = f[i], y = f[i + 1], w = f[i + 2], h = f[i + 3], r = card ? f[i + 4] : 0;
            const k = u[i + (card ? 5 : 4)]; i += card ? 6 : 5;
            const st = [];
            for (let s = 0; s < k; s++) st.push([f[i + s * 2], col(u[i + s * 2 + 1])]);
            i += k * 2;
            if (card) cv.card(X(x), Y(y), S(w), S(h), S(r), st); else cv.gradientRect(X(x), Y(y), S(w), S(h), st);
            break;
        }
        case OP.RRECT: cv.roundRect(X(f[i]), Y(f[i + 1]), S(f[i + 2]), S(f[i + 3]), S(f[i + 4]), col(u[i + 5])); i += 6; break;
        case OP.RSTROKE: cv.strokeRoundRect(X(f[i]), Y(f[i + 1]), S(f[i + 2]), S(f[i + 3]), S(f[i + 4]), S(f[i + 5]), col(u[i + 6])); i += 7; break;
        case OP.RAMPRECT: cv.rampRect(X(f[i]), Y(f[i + 1]), S(f[i + 2]), S(f[i + 3]), S(f[i + 4]), R.rampList[u[i + 5]] || ['#fff'], X(f[i + 6]), S(f[i + 7])); i += 8; break;
        case OP.ARC: {
            const flags = u[i + 7], opts = { round: !!(flags & 1) };
            if (flags & 2) { opts.ramp = R.rampList[u[i + 8]]; opts.rampFrom = f[i + 9]; opts.rampTo = f[i + 10]; }
            cv.arc(X(f[i]), Y(f[i + 1]), S(f[i + 2]), S(f[i + 3]), f[i + 4], f[i + 5], col(u[i + 6]), opts);
            i += 11; break;
        }
        case OP.LINE: cv.line(X(f[i]), Y(f[i + 1]), X(f[i + 2]), Y(f[i + 3]), S(f[i + 4]), col(u[i + 5])); i += 6; break;
        case OP.QUAD: cv.quad([[X(f[i]), Y(f[i + 1])], [X(f[i + 2]), Y(f[i + 3])], [X(f[i + 4]), Y(f[i + 5])], [X(f[i + 6]), Y(f[i + 7])]], col(u[i + 8])); i += 9; break;
        case OP.TRIS: {
            const k = u[i++];
            for (let t = 0; t < k; t++) { const b = i + t * 9; cv.triangle([[X(f[b]), Y(f[b + 1])], [X(f[b + 3]), Y(f[b + 4])], [X(f[b + 6]), Y(f[b + 7])]], col(u[b + 2])); }
            i += k * 9; break;
        }
        case OP.GLYPHS: {
            const fo = R.atlasById(u[i]), c = col(u[i + 1]), k = u[i + 2]; i += 3;
            if (fo) for (let g = 0; g < k; g++) {
                const b = i + g * 8, gw = f[b + 6] - f[b + 4], gh = f[b + 7] - f[b + 5];
                cv._blit(fo, f[b + 4], f[b + 5], gw, gh, X(f[b]), Y(f[b + 1]), S(f[b + 2] / gw), c);
            }
            i += k * 8; break;
        }
        case OP.LAYER: { const L = R.layerById.get(u[i]); if (L) { const sl = R.softLayer(L); cv.drawImage(sl.d, sl.w, sl.h, X(f[i + 1]), Y(f[i + 2]), S(sl.w), S(sl.h)); } i += 3; break; }
        // (mgu-render/1: a picture, `x y w h r id`)
        case OP.IMAGE: { const im = R.imageById.get(u[i + 5]); if (im && im.data) cv.drawImage(im.data, im.w, im.h, X(f[i]), Y(f[i + 1]), S(f[i + 2]), S(f[i + 3])); i += 6; break; }
        case OP.VIDEO: {
            const x = X(f[i]), y = Y(f[i + 1]), w = S(f[i + 2]), h = S(f[i + 3]); i += 6;
            cv.fillRect(x, y, w, h, '#123456');
            cv.text('VIDEO ' + Math.round(w) + ' x ' + Math.round(h), x + w / 2, y + h / 2, 40, '#ffffff', { literal: true, align: 'center' });
            break;
        }
        case OP.CLIP: clip = [f[i], f[i + 1], f[i + 2], f[i + 3]]; i += 4; break;
        case OP.NOCLIP: clip = null; break;
        case OP.ALPHA: alpha = f[i]; i += 1; break;
        case OP.XF: T = f[i] > 0 ? { s: f[i], ox: pl.x + f[i + 1], oy: pl.y + f[i + 2] } : base; i += 3; break;
        default: return done();
        }
    }
    return done();
}

module.exports = { surfaceCanvas };
