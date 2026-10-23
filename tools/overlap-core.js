// Overlap detector, analysis half (lane helm-overlap, 2026-10-15). Pure: takes the element records that
// tools/overlap-audit.js measures in a real page and returns findings, so test/host/overlap-audit.test.js can
// check the rules without a browser.
//
// A record (one per visible control, standalone text run or standalone icon):
//   { id, kind: 'ctl' | 'glyph', sel, rect, clip, hardClip, layer, anc: [ctl ids], ctl: id|null,
//     ink?, ring?, hit?, container?: { rect, sel }, small?, inline?, cutX?, cutY? }
//   rect      border box (ctl) or the glyphs' box (glyph), viewport px: { x, y, w, h }
//   clip      what every overflow ancestor leaves visible; hardClip: overflow hidden/clip ancestors only
//   layer     key of the nearest fixed / sticky / z-indexed positioned ancestor ('page' when none):
//             things on different layers float over each other by design and are never compared
//   anc       ids of the controls this one sits inside (a pair in one chain is never "overlapping")
//   ctl       for a glyph: the control it belongs to (its box already stands for it), else null
//   ink       a control's painted box with :hover + :focus-visible forced (rings and outlines included)
//   ring      true when that ink reaches past the border box (a box-shadow ring or an outline)
//   hit       the clickable box: the border box plus any ::before / ::after hit-area extension
//   container the nearest ancestor that paints a box (background, border or shadow)
//   inline    an inline link inside running text (exempt from the target-size rule, as in WCAG 2.5.8)
//   cutX/cutY the text is allowed to be cut on that axis (text-overflow: ellipsis / line-clamp)
'use strict';

const EPS = 0.5;          // sub-pixel noise
const TARGET = 24;        // WCAG 2.2 SC 2.5.8 Target Size (Minimum), CSS px

const R = (x, y, w, h) => ({ x, y, w, h });
const right = (r) => r.x + r.w;
const bottom = (r) => r.y + r.h;
function inter(a, b) {
  if (!a || !b) return null;
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const w = Math.min(right(a), right(b)) - x, h = Math.min(bottom(a), bottom(b)) - y;
  return w > EPS && h > EPS ? R(x, y, w, h) : null;
}
const contains = (outer, inner, tol = EPS) => inner.x >= outer.x - tol && inner.y >= outer.y - tol
  && right(inner) <= right(outer) + tol && bottom(inner) <= bottom(outer) + tol;
// How far `r` reaches past `outer` on each side (0 when inside).
function past(outer, r) {
  return { l: Math.max(0, outer.x - r.x), t: Math.max(0, outer.y - r.y), r: Math.max(0, right(r) - right(outer)), b: Math.max(0, bottom(r) - bottom(outer)) };
}
const maxPast = (p) => Math.max(p.l, p.t, p.r, p.b);
const visible = (rec) => (rec.clip ? inter(rec.rect, rec.clip) : rec.rect);
// the part of a control's hit area (box + ::before/::after extension) its overflow ancestors leave on screen
const hitVisible = (rec) => { const h = rec.hit || rec.rect; return rec.clip ? inter(h, rec.clip) : h; };
// a wrapped inline run is several line boxes; its union would 'hit' whatever sits beside the short last line
function hit(a, b) {
  const la = a.rects || [a.rect], lb = b.rects || [b.rect];
  for (const x of la) for (const y of lb) {
    const r = inter(a.clip ? inter(x, a.clip) : x, b.clip ? inter(y, b.clip) : y);
    if (r) return r;
  }
  return null;
}
const fmt = (r) => r ? `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.w)}x${Math.round(r.h)}` : '-';
const related = (a, b) => a.id === b.id || (a.anc || []).includes(b.id) || (b.anc || []).includes(a.id)
  || (a.ctl != null && (a.ctl === b.id || (b.anc || []).includes(a.ctl) || (a.ctl === b.ctl)))
  || (b.ctl != null && (b.ctl === a.id || (a.anc || []).includes(b.ctl)))
  || (b.kind === 'box' && boxRel(a, b)) || (a.kind === 'box' && boxRel(b, a));
// a painted box is related to what it holds and to what holds it
function boxRel(x, box) {
  return (x.boxAnc || []).includes(box.id) || (box.anc || []).includes(x.id) || (x.ctl != null && (box.anc || []).includes(x.ctl))
    || (x.kind === 'box' && (box.boxAnc || []).includes(x.id));
}

// Parse a computed box-shadow list into { inset, x, y, blur, spread, alpha }.
function parseShadows(s) {
  if (!s || s === 'none') return [];
  const out = [];
  for (const part of s.split(/,(?![^(]*\))/)) {
    const color = /((?:rgba?|hsla?|color|oklab|oklch|lab|lch)\([^)]*\)|#[0-9a-f]{3,8}|transparent)/i.exec(part);
    let alpha = 1;
    if (color) {
      const slash = /\/\s*([\d.]+)(%?)\s*\)$/.exec(color[1]), legacy = /^rgba?\(([^)]*)\)$/i.exec(color[1]);
      if (/transparent/i.test(color[1])) alpha = 0;
      else if (slash) alpha = parseFloat(slash[1]) / (slash[2] ? 100 : 1);
      else if (legacy) { const v = legacy[1].split(',').map((x) => x.trim()); if (v.length >= 4) alpha = parseFloat(v[3]); }
    }
    const rest = color ? part.replace(color[1], '') : part;
    const nums = (rest.match(/-?[\d.]+px|-?[\d.]+(?=\s|$)/g) || []).map(parseFloat);
    const [x = 0, y = 0, blur = 0, spread = 0] = nums;
    out.push({ inset: /\binset\b/.test(part), x, y, blur, spread, alpha });
  }
  return out;
}

// How far a control's crisp rings (box-shadow without much blur, outline) paint past its border box per side.
// Soft elevation shadows (blur > 3) are left out on purpose: they are meant to spill.
function ringReach({ boxShadow, outlineStyle, outlineWidth, outlineOffset }) {
  const reach = { l: 0, t: 0, r: 0, b: 0 };
  for (const s of parseShadows(boxShadow)) {
    if (s.inset || s.alpha < 0.05 || s.blur > 3) continue;
    const e = s.spread + s.blur;
    reach.l = Math.max(reach.l, e - s.x); reach.r = Math.max(reach.r, e + s.x);
    reach.t = Math.max(reach.t, e - s.y); reach.b = Math.max(reach.b, e + s.y);
  }
  const ow = parseFloat(outlineWidth) || 0;
  if (outlineStyle && outlineStyle !== 'none' && ow > 0) {
    const e = ow + (parseFloat(outlineOffset) || 0);
    for (const k of ['l', 't', 'r', 'b']) reach[k] = Math.max(reach[k], e);
  }
  return reach;
}
const grow = (r, g) => R(r.x - g.l, r.y - g.t, r.w + g.l + g.r, r.h + g.t + g.b);

// ---- the rules ----
function analyze(snap, { scenario = '', width = 0 } = {}) {
  const els = snap.els || [];
  const ctls = els.filter((e) => e.kind === 'ctl');
  const glyphs = els.filter((e) => e.kind === 'glyph');
  const boxes = els.filter((e) => e.kind === 'box');
  const out = [];
  const add = (kind, a, b, detail) => out.push({ kind, scenario, width, a: a?.sel || '', b: b?.sel || '', rect: a?.ink || a?.rect || null, brect: b?.rect || null, detail });

  // 1. control boxes that intersect each other (clicks land on the wrong one; highlights stack)
  for (let i = 0; i < ctls.length; i++) {
    for (let j = i + 1; j < ctls.length; j++) {
      const a = ctls[i], b = ctls[j];
      if (a.layer !== b.layer || related(a, b) || (a.ghost && b.ghost)) continue;
      const va = visible(a), vb = visible(b), x = inter(va, vb);
      if (x) add('overlap', a, b, `boxes intersect by ${Math.round(x.w)}x${Math.round(x.h)} px (${fmt(va)} / ${fmt(vb)})`);
      else if (a.hit && b.hit) {
        // a hit area only takes clicks where its overflow ancestors leave it visible: a button scrolled out of
        // the chat (under the session header) cannot be hit there
        const h = inter(hitVisible(a), hitVisible(b));
        if (h && h.w > 1 && h.h > 1) add('hit-overlap', a, b, `hit areas intersect by ${Math.round(h.w)}x${Math.round(h.h)} px`);
      }
    }
  }
  // 1b. a control drawn over a bubble / card it is not part of
  for (const a of ctls) {
    if (a.ghost) continue;
    for (const b of boxes) {
      if (a.layer !== b.layer || related(a, b)) continue;
      const x = inter(visible(a), visible(b));
      if (x) add('overlap', a, b, `control box sits ${Math.round(Math.min(x.w, x.h) * 10) / 10} px onto ${b.sel}`);
    }
  }
  // 2. a control's hover / focus ink (ring, outline, highlight) reaching into a neighbour, a box or loose text
  for (const a of ctls) {
    if (!a.ink) continue;
    const ink = a.clip ? inter(a.ink, a.clip) : a.ink;
    if (!ink) continue;
    for (const b of [...ctls, ...glyphs, ...boxes]) {
      if (b === a || b.ghost || b.layer !== a.layer || related(a, b)) continue;
      if (b.kind === 'glyph' && b.ctl != null) continue;          // its control's box speaks for it
      const vb = visible(b); if (!vb) continue;
      if (inter(visible(a), vb)) continue;                         // already an 'overlap'
      const x = inter(ink, vb) && (b.rects ? hit({ rect: ink }, b) : true) && inter(ink, vb);
      if (x) add('ring', a, b, `hover/focus ink ${fmt(a.ink)} reaches ${Math.round(Math.min(x.w, x.h) * 10) / 10} px into ${b.kind === 'glyph' ? 'text' : b.kind === 'box' ? 'a neighbouring box' : 'a neighbour'} at ${fmt(vb)}`);
    }
  }
  // 3. a focus ring cut off by an overflow ancestor while the control itself is fully inside it
  for (const a of ctls) {
    if (!a.ring || !a.ink || !a.clip) continue;
    if (!contains(a.clip, a.rect)) continue;                       // partly scrolled out: the box is cut anyway
    const p = past(a.clip, a.ink);
    // a side cut by a scroller that can still scroll that way is a scroll position, not a cut: scrolling shows it
    // (the audit pages through scrollers, so a control often lands a fraction of a px inside the edge)
    for (const k of ['l', 't', 'r', 'b']) if (a.clipSoft && a.clipSoft[k]) p[k] = 0;
    const m = maxPast(p);
    if (m > 1) add('clipped-ring', a, null, `focus ring cut by ${Math.round(m * 10) / 10} px (${['l', 't', 'r', 'b'].filter((k) => p[k] > 1).join('')}) by an overflow ancestor`);
  }
  // 4. text: collisions, cut glyphs, spilling out of its box
  for (let i = 0; i < glyphs.length; i++) {
    const g = glyphs[i]; const vg = visible(g); if (!vg) continue;
    for (let j = i + 1; j < glyphs.length; j++) {
      const h = glyphs[j];
      if (h.layer !== g.layer || (g.ctl != null && g.ctl === h.ctl) || related(g, h)) continue;
      const vh = visible(h); if (!vh) continue;
      const x = inter(vg, vh) && hit(g, h);
      if (x && x.w > 1 && x.h > 2) add('text-collide', g, h, `text boxes intersect by ${Math.round(x.w)}x${Math.round(x.h)} px`);
    }
    if (g.ctl == null) {
      for (const c of ctls) {
        if (c.layer !== g.layer || related(g, c)) continue;
        const x = inter(vg, visible(c));
        if (x && x.w > 1 && x.h > 2) add('overlap', c, g, `a control sits on text by ${Math.round(x.w)}x${Math.round(x.h)} px`);
      }
    }
    for (const b of boxes) {
      if (b.layer !== g.layer || related(g, b)) continue;
      const x = inter(vg, visible(b)) && hit(g, b);
      if (x && x.w > 1 && x.h > 2) add('overlap', b, g, `a box sits on text by ${Math.round(x.w)}x${Math.round(x.h)} px`);
    }
    if (g.hardClip && inter(g.rect, g.hardClip)) {
      const p = past(g.hardClip, g.rect);
      const sideX = Math.max(p.l, p.r) > 1 && !g.cutX, sideY = Math.max(p.t, p.b) > 2 && !g.cutY;
      if (sideX || sideY) add('text-clip', g, null, `text cut ${sideX ? `${Math.round(Math.max(p.l, p.r))} px across` : ''}${sideX && sideY ? ', ' : ''}${sideY ? `${Math.round(Math.max(p.t, p.b))} px down` : ''} by an overflow:hidden box`);
    }
    if (g.container && !(g.hardClip && contains(g.container.rect, g.hardClip, 1))) {
      const m = maxPast(past(g.container.rect, vg));
      if (m > 1) add('text-spill', g, null, `text sticks ${Math.round(m)} px out of ${g.container.sel}`);
    }
  }
  // 5. controls sticking out of the box they are drawn in
  for (const c of ctls) {
    if (!c.container) continue;
    const vc = visible(c); if (!vc) continue;
    const m = maxPast(past(c.container.rect, vc));
    if (m > 1) add('outside', c, null, `${Math.round(m)} px outside ${c.container.sel}`);
  }
  // 6. page wider than the window
  if (snap.viewport && snap.scrollWidth > snap.viewport.w + 1) add('page-overflow', { sel: 'document' }, null, `page is ${snap.scrollWidth} px wide in a ${snap.viewport.w} px window`);
  // 7. small targets (WCAG 2.5.8: under 24x24 passes only if a 24 px circle on its centre touches no other target)
  const centre = (r) => [r.x + r.w / 2, r.y + r.h / 2];
  const hitOf = (c) => c.hit || c.rect;
  for (const c of ctls) {
    if (c.inline || c.small === false) continue;
    const r = visible(c); if (!r) continue;
    const hr = hitOf(c);
    if (hr.w >= TARGET - EPS && hr.h >= TARGET - EPS) continue;
    const [cx, cy] = centre(hr);
    let crowd = null;
    for (const d of ctls) {
      if (d === c || d.layer !== c.layer || related(c, d)) continue;
      const dr = hitVisible(d); if (!dr) continue;                 // scrolled out of view: nothing to mis-tap
      // distance from c's centre to d's box
      const dx = Math.max(dr.x - cx, 0, cx - right(dr)), dy = Math.max(dr.y - cy, 0, cy - bottom(dr));
      if (Math.hypot(dx, dy) < TARGET / 2 - EPS) { crowd = d; break; }
      if (dr.w < TARGET && dr.h < TARGET) {   // two undersized targets: their circles must not meet
        const [ex, ey] = centre(dr);
        if (Math.hypot(ex - cx, ey - cy) < TARGET - EPS) { crowd = d; break; }
      }
    }
    if (crowd) add('small-target', c, crowd, `${Math.round(hr.w)}x${Math.round(hr.h)} px target with a neighbour inside its 24 px circle`);
  }
  return out;
}

// Same kind + scenario + width + both selectors = one finding with a count.
function dedupe(findings) {
  const m = new Map();
  for (const f of findings) {
    const k = [f.kind, f.scenario, f.width, f.a, f.b].join('|');
    const cur = m.get(k);
    if (cur) cur.count++; else m.set(k, { ...f, count: 1 });
  }
  return [...m.values()];
}

// An allow entry: { kind, sel (substring of a or b), scenario?, width?, reason } — reason is required.
function allowed(f, allow) {
  return (allow || []).find((e) => e.reason && e.kind === f.kind
    && (!e.scenario || f.scenario.includes(e.scenario))
    && (!e.width || e.width === f.width)
    && (!e.sel || f.a.includes(e.sel) || f.b.includes(e.sel))
    && (!e.with || f.b.includes(e.with) || f.a.includes(e.with))) || null;
}

module.exports = { analyze, dedupe, allowed, parseShadows, ringReach, grow, inter, contains, TARGET };
