'use strict';
/**
 * keyboard.js - an on-screen keyboard drawn by the kit as a sheet (display.js openSheet), for head units whose HMI
 * speller an app can't open (iDrive 8). Touch and the controller both work; nothing goes to the HMI.
 *
 *   const sh = keyboardSheet({
 *       title: 'Search',                 // the header's text
 *       hint: 'Search videos',           // shown in the empty field
 *       text: '',                        // the text to start with
 *       chips: () => ['recent', ...],    // optional: a row of ready answers under the field (recent searches)
 *       locked: () => false,             // optional: true while typing is not allowed (driving): keys grey, chips work
 *       lockedText: 'Typing works when parked',
 *       action: 'Search',                // the OK button's label
 *       onDone(text) {},                 // OK (or a chip): the sheet closes after it
 *   });
 *   ctx.sheet(sh);
 *
 * The keys: digits, the letters (lower case: searches don't care), a few marks, Clear, space and backspace.
 */
const { withAlpha } = require('./canvas');

const TOP = 46, BOTTOM = 512, MARGIN = 40, GAP = 10, MAX_LEN = 100;
const ROWS = [
    '1234567890'.split(''),
    'qwertyuiop'.split(''),
    'asdfghjkl\''.split(''),
    'zxcvbnm,.-'.split(''),
];
// the last row: [label, units of width, what it does]
const LAST = [['Clear', 2, 'clear'], ['space', 5, ' '], ['back', 3, 'bksp']];

function keyboardSheet(opts) {
    const o = opts || {};
    const chips = () => (typeof o.chips === 'function' ? o.chips() : o.chips || []).filter((c) => typeof c === 'string' && c.trim()).slice(0, 8);
    const locked = () => !!(o.locked && o.locked());
    const sh = {
        title: o.title || 'Keyboard',
        text: String(o.text || '').slice(0, MAX_LEN),
        focus: -1,                       // the place the controller is on (index into the last frame's places), -1: none yet
        controller: false,
        places: [],                      // this frame's places in controller order: { key, act }
        onClose: null,

        type(ch) {
            if (locked()) return null;
            if (ch === 'bksp') this.text = this.text.slice(0, -1);
            else if (ch === 'clear') this.text = '';
            else if (this.text.length < MAX_LEN) this.text += ch;
            return null;
        },
        done(text) {
            const v = String(text == null ? this.text : text).trim();
            if (!v) return null;
            return Promise.resolve(o.onDone && o.onDone(v)).then(() => 'close');
        },

        draw(r, t) {
            r.clear(t.bg);
            const W = r.w || 1600, bottom = BOTTOM + (r.extra || 0), S = t.sel || t.accent, lock = locked();
            const targets = [], places = [];
            const pressed = this.pressedKey && Date.now() - this.pressedAt < 250 ? this.pressedKey : null;
            const lit = (key) => (this.controller && this.places[this.focus] && this.places[this.focus].key === key);
            const place = (key, x, y, w, h, act) => { targets.push({ x, y, w, h, act: () => { this.pressedKey = key; this.pressedAt = Date.now(); return act(); } }); places.push({ key, act }); };

            // the field, then Cancel and the action (OK) on its right
            const bw = 200, bh = 64, fy = TOP + 8, fw = W - 2 * MARGIN - 2 * (bw + 16);
            r.roundRect(MARGIN, fy, fw, bh, 16, withAlpha('#ffffff', 0.09));
            r.strokeRoundRect(MARGIN, fy, fw, bh, 16, 2, lock ? withAlpha('#ffffff', 0.2) : S);
            const size = 32, tx = MARGIN + 24, room = fw - 48;
            if (this.text) {
                // the end of a long text stays in view (the start goes)
                let s = this.text;
                while (s.length > 1 && r.textWidth(s, size, { literal: true }) > room - 16) s = s.slice(1);
                r.text(s, tx, fy + bh / 2 + 11, size, t.text, { literal: true });
                const cx = tx + r.textWidth(s, size, { literal: true }) + 4;
                if (!lock && Math.floor(Date.now() / 530) % 2 === 0) r.fillRect(cx, fy + 14, 3, bh - 28, S);
            } else r.text(o.hint || '', tx, fy + bh / 2 + 11, size, t.dim, { literal: true });
            const pill = (key, x, label, primary, act) => {
                const on = lit(key) || pressed === key;
                r.roundRect(x, fy, bw, bh, bh / 2, on ? withAlpha(S, 0.9) : primary ? withAlpha(S, 0.55) : withAlpha('#ffffff', 0.1));
                r.text(label, x + bw / 2, fy + bh / 2 + 10, 28, '#ffffff', { align: 'center', font: 'bold', literal: true });
                place(key, x - 6, fy - 6, bw + 12, bh + 12, act);
            };
            pill('cancel', W - MARGIN - 2 * bw - 16, 'Cancel', false, () => 'close');
            pill('ok', W - MARGIN - bw, o.action || 'OK', true, () => this.done());

            // the ready answers (recent searches): a row of chips
            let y = fy + bh + 18;
            const list = chips();
            if (list.length) {
                const ch = 52;
                let x = MARGIN;
                list.forEach((c, i) => {
                    const label = c.length > 28 ? c.slice(0, 27) + '…' : c, w = Math.round(r.textWidth(label, 24, { literal: true })) + 56;
                    if (x + w > W - MARGIN) return;
                    const key = 'chip:' + i, on = lit(key) || pressed === key;
                    r.roundRect(x, y, w, ch, ch / 2, on ? withAlpha(S, 0.9) : withAlpha('#ffffff', 0.07));
                    if (!on) r.strokeRoundRect(x, y, w, ch, ch / 2, 1.5, withAlpha('#ffffff', 0.22));
                    r.text(label, x + w / 2, y + ch / 2 + 8, 24, '#ffffff', { align: 'center', literal: true });
                    place(key, x, y - 4, w, ch + 8, () => this.done(c));
                    x += w + 12;
                });
                y += ch + 18;
            }

            // the keys: as many rows as fit, each key as wide as the page allows
            const n = ROWS.length + 1, kh = Math.max(36, Math.min(72, Math.floor((bottom - 8 - y - (n - 1) * GAP) / n)));
            const unit = (W - 2 * MARGIN - 9 * GAP) / 10;
            const key = (k, x, w, label, act, glyph) => {
                const on = lit(k) || pressed === k;
                r.roundRect(x, y, w, kh, 12, on ? withAlpha(S, 0.9) : withAlpha('#ffffff', lock ? 0.04 : 0.1));
                if (glyph) glyph(x + w / 2, y + kh / 2, lock ? t.dim : '#ffffff');
                else r.text(label, x + w / 2, y + kh / 2 + 11, Math.min(32, kh * 0.5), lock ? t.dim : '#ffffff', { align: 'center', literal: true, font: label.length > 1 ? 'bold' : undefined });
                place(k, x, y - GAP / 2, w, kh + GAP, act);
            };
            ROWS.forEach((row) => {
                row.forEach((c, i) => key('k:' + c, MARGIN + i * (unit + GAP), unit, c, () => this.type(c)));
                y += kh + GAP;
            });
            let x = MARGIN;
            LAST.forEach(([label, units, what]) => {
                const w = units * unit + (units - 1) * GAP;
                key('k:' + what, x, w, label, () => this.type(what), what === 'bksp' ? (cx, cy, c) => {
                    // a backspace key: a tag pointing left with an x in it
                    r.polyline([[cx + 30, cy - 18], [cx - 14, cy - 18], [cx - 32, cy], [cx - 14, cy + 18], [cx + 30, cy + 18], [cx + 30, cy - 18]], 4, c);
                    r.line(cx - 4, cy - 8, cx + 14, cy + 8, 4, c); r.line(cx + 14, cy - 8, cx - 4, cy + 8, 4, c);
                } : null);
                x += w + GAP;
            });
            if (lock) {
                const msg = o.lockedText || 'Typing works when parked';
                const mw = r.textWidth(msg, 28, { literal: true }) + 80, my = Math.round((fy + bh + bottom) / 2) + 40;
                r.roundRect((W - mw) / 2, my - 40, mw, 64, 32, '#1c1c1cf0');
                r.text(msg, W / 2, my + 2, 28, '#ffd36b', { align: 'center', literal: true });
            }
            this.places = places;
            if (this.focus >= places.length) this.focus = places.length - 1;
            return targets;
        },
        move(d) {
            this.controller = true;
            const n = this.places.length;
            if (!n) return;
            // the first turn lands on the first key (after Cancel, OK and the chips)
            if (this.focus < 0) { this.focus = Math.max(0, this.places.findIndex((p) => p.key.indexOf('k:') === 0)); return; }
            this.focus = Math.max(0, Math.min(n - 1, this.focus + d));
        },
        press() {
            this.controller = true;
            const p = this.places[this.focus];
            return p ? p.act() : null;
        },
        back() { return 'close'; },
        /** on Cancel (the first place): pushed up, the controller goes to the header's tabs */
        top() { return this.focus <= 0; },
        // (no scroll(): a finger that slides a little on a key still types it)
    };
    return sh;
}

module.exports = { keyboardSheet, ROWS, LAST };
