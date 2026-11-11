'use strict';
/**
 * sheet.js - pages the kit draws over an app's own page with the GPU renderer (full-screen
 * layout, mgu-render/1): the settings and cards such as the Service app's item details.
 *
 * A sheet is driven by the display (display.js openSheet):
 *   draw(r, t)  draw on r (a 1600 x 520 Recorder - iDrive 8: 2080 wide -, the app's page coordinates); returns the touch
 *               targets [{ x, y, w, h, act }] (act(): what a tap does; 'close' closes the sheet)
 *   move(d)     controller knob: d clicks (+ = clockwise)
 *   press()     controller press; back(): tilt left. Both return 'close' to close the sheet.
 *   top()       (optional) the controller is at the sheet's top: pushed up, it goes to the header's tabs
 *   title       the header's text
 *
 *   listSheet(settings)     the app's settings: a row per setting, a list of values to pick from
 *   cardSheet(spec)         a card: title, rows of label and value, action buttons
 *   textSheet(spec)         pages of plain text (an app's diagnostics, to be read or photographed)
 *   list(), pill()          the settings' scrolling rows and round buttons, for an app's own sheets
 */
const { withAlpha } = require('./canvas');
const G = require('./gauges');
const { t: translate } = require('./i18n');

const PAGE_W = 1600, TOP = 46, BOTTOM = 512;     // (the page's width is the recorder's: r.w)
const ROW_H = 66, GAP = 8;

/* ---------------- drawing helpers ---------------- */
function pill(r, t, x, y, w, h, label, on, opts) {
    const o = opts || {}, S = t.sel || t.accent;
    const c = o.color || S;
    r.roundRect(x, y, w, h, h / 2, on ? withAlpha(c, 0.9) : withAlpha('#ffffff', 0.08));
    if (!on) r.strokeRoundRect(x, y, w, h, h / 2, 1.5, withAlpha(o.color || '#ffffff', o.color ? 0.7 : 0.22));
    r.text(label, x + w / 2, y + h / 2 + 9, 24, on ? '#ffffff' : o.color || t.text, { align: 'center', font: 'bold', spacing: 1 });
}
function toggle(r, t, x, y, on) {
    const S = t.sel || t.accent, w = 76, h = 38;
    r.roundRect(x, y, w, h, h / 2, on ? S : withAlpha('#ffffff', 0.16));
    r.circle(on ? x + w - h / 2 : x + h / 2, y + h / 2, h / 2 - 5, '#ffffff');
}
function chevron(r, t, x, y, c) {
    r.line(x, y - 9, x + 9, y, 3, c);
    r.line(x + 9, y, x, y + 9, 3, c);
}
function fit(r, s, size, w, font) {
    s = translate(String(s));
    if (r.textWidth(s, size, { font }) <= w) return s;
    while (s.length > 1 && r.textWidth(s + '...', size, { font }) > w) s = s.slice(0, -1);
    return s + '...';
}

/**
 * A scrolling list of rows: rows = [{ label, value, kind: 'toggle'|'more'|'radio', on }].
 * Draws them from y0, keeps row `focus` in view (smooth), returns the rows' rects.
 */
function list(r, t, key, rows, focus, y0, controller) {
    // (r.extra: the page reaches lower on screen, display.js)
    const W = r.w || PAGE_W, S = t.sel || t.accent, bottom = BOTTOM + (r.extra || 0), H = bottom - y0;
    const total = rows.length * (ROW_H + GAP) - GAP;
    const fy = focus * (ROW_H + GAP);
    // st.y: where the list should be; st.show: where it is drawn (glides there, follows a finger at once).
    // The focused row is brought into view when the focus moves, so a finger can scroll it away.
    const st = list.scroll[key] || (list.scroll[key] = { y: 0, show: 0, focus: -1, drag: false });
    if (st.focus !== focus) {
        st.focus = focus;
        if (fy < st.y) st.y = fy;
        if (fy + ROW_H > st.y + H) st.y = fy + ROW_H - H;
    }
    st.y = Math.max(0, Math.min(st.y, Math.max(0, total - H)));
    st.show = st.drag || Math.abs(st.y - st.show) < 0.5 ? st.y : st.show + (st.y - st.show) * 0.35;
    const sy = st.show;
    const rects = [];
    r.clip(0, y0, W, H);
    rows.forEach((row, i) => {
        const y = y0 + i * (ROW_H + GAP) - sy;
        if (y + ROW_H < y0 || y > bottom) return;
        const x = 40, w = W - 80, on = i === focus && controller;
        r.roundRect(x, y, w, ROW_H, 14, on ? withAlpha(S, 0.22) : withAlpha('#ffffff', 0.05));
        if (on) r.strokeRoundRect(x, y, w, ROW_H, 14, 2, S);
        const cy = y + ROW_H / 2;
        let right = x + w - 28;
        if (row.kind === 'toggle') { toggle(r, t, right - 76, cy - 19, row.on); right -= 100; } else if (row.kind === 'more') { chevron(r, t, right - 9, cy, t.dim); right -= 34; } else if (row.kind === 'radio') {
            r.circle(right - 15, cy, 15, row.on ? S : withAlpha('#ffffff', 0.25));
            r.circle(right - 15, cy, row.on ? 6 : 12, row.on ? '#ffffff' : t.bg);
            right -= 44;
        }
        const vw = row.value != null ? Math.min(560, r.textWidth(String(row.value), 26)) : 0;
        if (row.value != null) r.text(fit(r, row.value, 26, 560), right, cy + 9, 26, row.on && row.kind === 'radio' ? t.text : t.dim, { align: 'right' });
        r.text(fit(r, row.label, 28, right - vw - 40 - (x + 28)), x + 28, cy + 10, 28, t.text);
        rects.push({ i, x, y: Math.max(y, y0), w, h: Math.min(y + ROW_H, bottom) - Math.max(y, y0) });
    });
    r.noclip();
    if (total > H) {
        // scroll position
        const bh = Math.max(40, H * H / total), by = y0 + (H - bh) * (sy / (total - H));
        r.roundRect(W - 22, by, 6, bh, 3, withAlpha('#ffffff', 0.3));
    }
    return rects;
}
list.scroll = {};

/* ---------------- settings ---------------- */
function values(s) {
    if (s.type === 'choice') return (s.options || []).map((o) => [o[0], o[1]]);
    if (s.type === 'number') return (s.steps || []).map((v) => [v, String(v) + (s.unit ? ' ' + s.unit : '') + (s.markDefault && v === s.default ? ' (default)' : '')]);
    return null;
}

/** opts: { version } (the app's, shown at the settings' top) */
function listSheet(settings, title, opts) {
    const version = opts && opts.version;
    const schema = settings.schema.filter((s) => !s.hidden);
    const sh = {
        title: title || 'Settings',
        focus: 0, open: null, sub: 0,        // open: the setting whose values are listed
        controller: false,                  // the controller was used: show where it is
        rows() {
            if (this.open) {
                const cur = settings.get(this.open.key);
                return values(this.open).map((v) => ({ label: v[1], kind: 'radio', on: v[0] === cur }));
            }
            return schema.map((s) => (s.type === 'bool'
                ? { label: s.label, kind: 'toggle', on: !!settings.get(s.key) }
                : { label: s.label, value: settings.display(s.key), kind: values(s) ? 'more' : null }));
        },
        draw(r, t) {
            r.clear(t.bg);
            const W = r.w || PAGE_W, rows = this.rows();
            // the header's tab names the sheet; a value list names its setting here
            if (this.open) r.text(this.open.label, 44, TOP + 40, 32, t.text, { font: 'bold' });
            else if (version) r.text('Version ' + version, 44, TOP + 38, 24, t.dim);
            const targets = [];
            // Back (a value list) / Done (the settings): top right
            const bw = 150, bx = W - 40 - bw, by = TOP + 8;
            // (the controller reaches it turning up from the first row: place -1)
            pill(r, t, bx, by, bw, 46, this.open ? 'Back' : 'Done', this.controller && (this.open ? this.sub : this.focus) === -1);
            targets.push({ x: bx - 10, y: by - 6, w: bw + 20, h: 58, act: () => this.back() });
            const rects = list(r, t, this.key(), rows, this.open ? this.sub : this.focus, TOP + 74, this.controller);
            rects.forEach((q) => targets.push(Object.assign(q, { act: () => { if (this.open) this.sub = q.i; else this.focus = q.i; return this.choose(); } })));
            return targets;
        },
        key() { return this.open ? 'v_' + this.open.key : 'settings'; },
        /** the controller is on Done / Back: pushed up from here it goes to the header's tabs */
        top() { return (this.open ? this.sub : this.focus) === -1; },
        /** touch: the list moved by dy (px, + = further down the list) while the finger is on it */
        scroll(dy) {
            const st = list.scroll[this.key()];
            if (st) { st.y += dy; st.drag = true; }
        },
        release() { const st = list.scroll[this.key()]; if (st) st.drag = false; },
        move(d) {
            this.controller = true;
            const n = this.rows().length;
            if (this.open) this.sub = Math.max(-1, Math.min(n - 1, this.sub + d));
            else this.focus = Math.max(-1, Math.min(n - 1, this.focus + d));
        },
        press() {
            this.controller = true;
            if ((this.open ? this.sub : this.focus) === -1) { const r = this.back(); if (this.open === null) this.focus = Math.max(0, this.focus); return r; }
            return this.choose();
        },
        choose() {
            if (this.open) {
                const v = values(this.open)[this.sub];
                if (v && v[0] !== settings.get(this.open.key)) settings.set(this.open.key, v[0]);
                this.open = null;
                return null;
            }
            const s = schema[this.focus];
            if (!s) return null;
            if (s.type === 'bool') settings.set(s.key, !settings.get(s.key));
            else if (values(s)) {
                this.open = s;
                this.sub = Math.max(0, values(s).findIndex((v) => v[0] === settings.get(s.key)));
            } else settings.cycle(s.key);
            return null;
        },
        back() {
            if (this.open) { this.open = null; return null; }
            return 'close';
        },
    };
    return sh;
}

/* ---------------- card ---------------- */
/**
 * spec: { title, heading, subtitle, color, rows: [[label, value]], note, actions: [{ label, run, color, primary }] }
 * (rows / note / actions may be functions, read on each frame). An action's run() may return
 * 'close' (or a promise of it).
 */
function cardSheet(spec) {
    const get = (k) => (typeof spec[k] === 'function' ? spec[k]() : spec[k]);
    const sh = {
        title: spec.title || '',
        focus: 0, controller: false, onClose: null,
        draw(r, t) {
            r.clear(t.bg);
            const W = r.w || PAGE_W, targets = [];
            const actions = get('actions') || [];
            this.focus = Math.max(-1, Math.min(this.focus, actions.length - 1));
            const x = 40, y = TOP + 6, w = W - 80, h = BOTTOM + (r.extra || 0) - y - 4;
            r.roundRect(x, y, w, h, 18, withAlpha('#ffffff', 0.05));
            const accent = get('color') || t.sel || t.accent;
            r.roundRect(x, y, 8, h, 4, accent);
            r.text(fit(r, get('heading') || '', 40, w - 260, 'bold'), x + 44, y + 64, 40, t.text, { font: 'bold' });
            const sub = get('subtitle');
            if (sub) r.text(fit(r, sub, 24, w - 90), x + 44, y + 102, 24, accent);
            // close: top right
            const cw = 150, cx = x + w - cw - 24, cy = y + 24;
            pill(r, t, cx, cy, cw, 46, 'Close', this.controller && this.focus === -1);
            targets.push({ x: cx - 10, y: cy - 6, w: cw + 20, h: 58, act: () => 'close' });
            // label / value tiles
            const rows = (get('rows') || []).filter(Boolean);
            const tw = (w - 88 - (rows.length - 1) * 20) / Math.max(1, rows.length), ty = y + 136, th = 132;
            rows.forEach((rw, i) => {
                const tx = x + 44 + i * (tw + 20);
                r.roundRect(tx, ty, tw, th, 14, withAlpha('#ffffff', 0.06));
                r.text(String(rw[0]).toUpperCase(), tx + 24, ty + 40, 20, t.dim, { font: 'bold', spacing: 1.5 });
                r.text(fit(r, rw[1] == null ? '--' : rw[1], 44, tw - 48, 'bold'), tx + 24, ty + 102, 44, rw[2] || t.text, { font: 'bold' });
            });
            const note = get('note');
            if (note) r.text(fit(r, note, 24, w - 88), x + 44, ty + th + 50, 24, t.dim);
            // actions: bottom right
            let ax = x + w - 24;
            const ay = y + h - 24 - 58;
            for (let i = actions.length - 1; i >= 0; i--) {
                const a = actions[i], aw = Math.max(200, r.textWidth(a.label, 24, { font: 'bold' }) + 80);
                ax -= aw;
                pill(r, t, ax, ay, aw, 58, a.label, this.controller ? i === this.focus : !!a.primary, { color: a.color });   // (-1: Close)
                targets.push({ x: ax, y: ay, w: aw, h: 58, act: () => a.run && a.run() });
                ax -= 20;
            }
            return targets;
        },
        move(d) {
            this.controller = true;
            const n = (get('actions') || []).length;
            this.focus = Math.max(-1, Math.min(n - 1, this.focus + d));     // -1: Close
        },
        press() {
            this.controller = true;
            if (this.focus === -1) return 'close';
            const a = (get('actions') || [])[this.focus];
            return a && a.run ? a.run() : null;
        },
        back() { return 'close'; },
        /** on Close: pushed up, the controller goes to the header's tabs */
        top() { return this.focus === -1; },
    };
    return sh;
}

/* ---------------- text ---------------- */
const LIT = { literal: true };
/** s in rows no wider than w: broken at spaces; a word wider than the row (a path) where it stops fitting. Rows after the first are indented. */
function wrap(r, s, size, w, opts) {
    const out = [], IND = '    ';
    let line = '';
    const fits = (x) => r.textWidth((out.length ? IND : '') + x, size, opts) <= w;
    String(s).split(' ').forEach((word) => {
        let wd = word;
        for (;;) {
            const tried = line ? line + ' ' + wd : wd;
            if (fits(tried)) { line = tried; return; }
            if (line) { out.push((out.length ? IND : '') + line); line = ''; continue; }
            let n = wd.length;
            while (n > 1 && !fits(wd.slice(0, n))) n--;
            out.push((out.length ? IND : '') + wd.slice(0, n));
            wd = wd.slice(n);
            if (!wd) return;
        }
    });
    if (line || !out.length) out.push((out.length ? IND : '') + line);
    return out;
}
/**
 * spec: { title, heading, lines, actions: [{ label, run }] } - lines (an array, or a function read on each frame: the
 * same array while nothing changed, the pages are laid out again only for a new one) of plain text, shown as
 * written (not translated), wrapped to the page and paged. A line that starts with '# ' is a section's heading.
 * Previous / Next / Close on top, the actions before them; the controller turns the pages, its press goes to the
 * next page and closes on the last.
 */
function textSheet(spec) {
    const get = (k) => (typeof spec[k] === 'function' ? spec[k]() : spec[k]);
    const SIZE = 22, LH = 30, X = 44;
    const sh = {
        title: spec.title || '',
        page: 0, pages: 1, controller: false, onClose: null,
        laid: null,                                   // { of: the lines laid out, w, n: rows a page, rows: [{ s, head }] }
        layout(r, W, n) {
            const lines = get('lines') || [];
            const L = this.laid;
            if (L && L.of === lines && L.len === lines.length && L.w === W && L.n === n) return L.rows;
            const rows = [];
            lines.forEach((l) => {
                // (the fonts have Latin and a few signs, kit/tools/bake_fonts.py: anything else would be dropped glyph by glyph)
                const text = String(l).replace(/[^\x20-\x7e\xa0-ſ–—‘-‚“-„•…‹›€]/g, '?');
                const head = text.indexOf('# ') === 0;
                wrap(r, head ? text.slice(2) : text, SIZE, W - 2 * X, head ? { literal: true, font: 'bold' } : LIT).forEach((row) => rows.push({ s: row, head }));
            });
            this.laid = { of: lines, len: lines.length, w: W, n, rows };
            return rows;
        },
        draw(r, t) {
            r.clear(t.bg);
            const W = r.w || PAGE_W, bottom = BOTTOM + (r.extra || 0), y0 = TOP + 84, targets = [];
            const n = Math.max(1, Math.floor((bottom - y0) / LH));
            const rows = this.layout(r, W, n);
            this.pages = Math.max(1, Math.ceil(rows.length / n));
            this.page = Math.max(0, Math.min(this.page, this.pages - 1));
            const accent = t.sel || t.accent;
            r.text(get('heading') || this.title, X, TOP + 44, 30, t.text, { literal: true, font: 'bold' });
            // top right, from the right: Close, Next, Previous, the actions
            let x = W - 40;
            const btn = (label, w, on, act, dim) => {
                x -= w;
                pill(r, t, x, TOP + 8, w, 46, label, on, dim ? { color: withAlpha('#ffffff', 0.35) } : null);
                targets.push({ x: x - 8, y: TOP + 2, w: w + 16, h: 58, act });
                x -= 16;
            };
            btn('Close', 150, false, () => 'close');
            btn('Next', 150, this.page < this.pages - 1, () => { this.page = Math.min(this.pages - 1, this.page + 1); return null; }, this.page >= this.pages - 1);
            btn('Previous', 170, false, () => { this.page = Math.max(0, this.page - 1); return null; }, this.page <= 0);
            (get('actions') || []).forEach((a) => btn(a.label, Math.max(170, r.textWidth(a.label, 24, { font: 'bold' }) + 70), false, () => a.run && a.run()));
            r.text('Page ' + (this.page + 1) + ' of ' + this.pages, x - 8, TOP + 40, 24, t.dim, { literal: true, align: 'right' });
            rows.slice(this.page * n, this.page * n + n).forEach((row, i) => {
                r.text(row.s, X, y0 + i * LH + SIZE, SIZE, row.head ? accent : t.text, row.head ? { literal: true, font: 'bold' } : LIT);
            });
            return targets;
        },
        move(d) {
            this.controller = true;
            this.page = Math.max(0, Math.min(this.pages - 1, this.page + (d > 0 ? 1 : -1)));
        },
        press() {
            this.controller = true;
            if (this.page >= this.pages - 1) return 'close';
            this.page++;
            return null;
        },
        back() { return 'close'; },
        top() { return true; },
    };
    return sh;
}

module.exports = { listSheet, cardSheet, textSheet, wrap, list, pill, TOP };
