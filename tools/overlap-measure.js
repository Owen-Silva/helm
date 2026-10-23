// Overlap detector, in-page half (lane helm-overlap, 2026-10-15). `install` is stringified into the page
// by tools/overlap-audit.js; it defines window.__ovl with the DOM measurements. No imports: it runs in the page.
'use strict';

function install() {
  if (window.__ovl) return;
  const CTL = 'button, a[href], input:not([type=hidden]), select, textarea, summary, [role=button], [role=menuitem],'
    + ' [role=menuitemradio], [role=menuitemcheckbox], [role=tab], [role=option], [role=switch], [role=checkbox],'
    + ' [role=radio], [role=link], [role=slider], [tabindex]:not([tabindex="-1"]), [contenteditable="true"], [contenteditable=""]';
  const R = (r) => ({ x: r.left, y: r.top, w: r.width, h: r.height });
  const inter = (a, b) => {
    const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
    const w = Math.min(a.x + a.w, b.x + b.w) - x, h = Math.min(a.y + a.h, b.y + b.h) - y;
    return w > 0.5 && h > 0.5 ? { x, y, w, h } : null;
  };
  const union = (a, b) => {
    if (!a) return b; if (!b) return a;
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
  };
  const alpha = (c) => {
    if (!c || c === 'transparent' || c === 'none') return 0;
    let m = /\/\s*([\d.]+)(%?)\s*\)\s*$/.exec(c);
    if (m) return parseFloat(m[1]) / (m[2] ? 100 : 1);
    m = /^rgba\(([^)]*)\)/.exec(c);
    if (m) { const v = m[1].split(','); return v.length >= 4 ? parseFloat(v[3]) : 1; }
    return 1;
  };
  const borderShows = (cs) => ['Top', 'Right', 'Bottom', 'Left'].some((s) => parseFloat(cs['border' + s + 'Width']) > 0
    && cs['border' + s + 'Style'] !== 'none' && alpha(cs['border' + s + 'Color']) > 0.05);
  const paints = (cs) => alpha(cs.backgroundColor) > 0.05 || (cs.backgroundImage && cs.backgroundImage !== 'none') || borderShows(cs);
  const boxy = (el) => { const cs = getComputedStyle(el); return paints(cs) || (cs.boxShadow && cs.boxShadow !== 'none'); };

  const label = (el) => {
    const t = el.getAttribute?.('aria-label') || el.getAttribute?.('title') || (el.textContent || '').trim();
    return t ? '[' + t.replace(/\s+/g, ' ').slice(0, 28) + ']' : '';
  };
  const one = (el) => {
    if (!el || el.nodeType !== 1) return '?';
    const cls = [...el.classList].filter((c) => !/^(is-|has-|on$|active$|open$)/.test(c)).slice(0, 2);
    return el.tagName.toLowerCase() + (cls.length ? '.' + cls.join('.') : '');
  };
  const sel = (el) => {
    let p = el.parentElement, up = '';
    for (let i = 0; p && i < 3 && !up; i++, p = p.parentElement) if (p.classList.length) up = '.' + [...p.classList][0] + ' ';
    return up + one(el) + label(el);
  };

  function opacity(el) { let o = 1; for (let n = el; n && n.nodeType === 1; n = n.parentElement) o *= parseFloat(getComputedStyle(n).opacity); return o; }
  function displayed(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    if (getComputedStyle(el).visibility !== 'visible') return false;
    return true;
  }
  const vp = () => ({ x: 0, y: 0, w: innerWidth, h: innerHeight });
  // What every overflow ancestor leaves visible (clip), and the overflow:hidden/clip ones only (hard).
  // self: the element's own overflow counts too (a text run is clipped by its own parent's overflow:hidden)
  function clips(el, self = false) {
    let clip = vp(), hard = null, hardEl = null, scrollX = false, scrollY = false;
    const scrollers = [];   // { box, l, t, r, b }: which way each scroller can still scroll
    let pos = getComputedStyle(el).position;
    let needPositioned = pos === 'absolute';
    if (pos === 'fixed') return { clip, hard, hardEl, soft: null };
    for (let n = self ? el : el.parentElement; n && n !== document.documentElement; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (needPositioned && cs.position === 'static' && cs.transform === 'none') continue;
      needPositioned = false;
      if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
        const b = n.getBoundingClientRect();
        const box = { x: b.left + n.clientLeft, y: b.top + n.clientTop, w: n.clientWidth || b.width, h: n.clientHeight || b.height };
        // one axis only clips when that axis is not visible
        const cx = cs.overflowX !== 'visible', cy = cs.overflowY !== 'visible';
        const ax = { x: cx ? box.x : -1e6, y: cy ? box.y : -1e6, w: cx ? box.w : 2e6, h: cy ? box.h : 2e6 };
        clip = inter(clip, ax) || { x: clip.x, y: clip.y, w: 0, h: 0 };
        // text inside a scroller that sits inside an overflow:hidden box is scrolled, not cut, on that axis
        if (/hidden|clip/.test(cs.overflowX + cs.overflowY)) {
          const hx = /hidden|clip/.test(cs.overflowX) && !scrollX, hy = /hidden|clip/.test(cs.overflowY) && !scrollY;
          const hb = { x: hx ? box.x : -1e6, y: hy ? box.y : -1e6, w: hx ? box.w : 2e6, h: hy ? box.h : 2e6 };
          if (hx || hy) { hard = hard ? (inter(hard, hb) || hard) : hb; if (!hardEl) hardEl = n; }
        }
        if (/auto|scroll/.test(cs.overflowX)) scrollX = true;
        if (/auto|scroll/.test(cs.overflowY)) scrollY = true;
        const sx = /auto|scroll/.test(cs.overflowX), sy = /auto|scroll/.test(cs.overflowY);
        if (sx || sy) scrollers.push({ box,
          l: sx && n.scrollLeft > 0.5, r: sx && n.scrollLeft + n.clientWidth < n.scrollWidth - 0.5,
          t: sy && n.scrollTop > 0.5, b: sy && n.scrollTop + n.clientHeight < n.scrollHeight - 0.5 });
      }
      if (cs.position === 'fixed') break;
      if (cs.position === 'absolute') needPositioned = true;
    }
    // a clip edge is "soft" when the scroller that draws it can still scroll past it
    const soft = { l: false, t: false, r: false, b: false };
    for (const s of scrollers) {
      if (s.l && Math.abs(s.box.x - clip.x) < 0.5) soft.l = true;
      if (s.t && Math.abs(s.box.y - clip.y) < 0.5) soft.t = true;
      if (s.r && Math.abs(s.box.x + s.box.w - (clip.x + clip.w)) < 0.5) soft.r = true;
      if (s.b && Math.abs(s.box.y + s.box.h - (clip.y + clip.h)) < 0.5) soft.b = true;
    }
    return { clip, hard, hardEl, soft };
  }
  let layerSeq = 0;
  function layerOf(el) {
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      const cs = getComputedStyle(n);
      const lifted = cs.position === 'fixed' || cs.position === 'sticky'
        || (cs.position === 'absolute' && cs.zIndex !== 'auto' && +cs.zIndex > 0)
        || n.matches('[popover], dialog[open]');
      if (lifted) { if (!n.dataset.ovlLayer) n.dataset.ovlLayer = 'L' + (++layerSeq); return n.dataset.ovlLayer; }
    }
    return 'page';
  }
  function containerOf(el, self) {
    for (let n = self ? el : el.parentElement; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
      if (boxy(n)) {
        const cs = getComputedStyle(n), b = n.getBoundingClientRect();
        // a full-window scrim is not a box anything is drawn "in"
        if (cs.position === 'fixed' && b.width >= innerWidth - 2 && b.height >= innerHeight - 2) return null;
        return { rect: R(b), sel: one(n) + label(n).slice(0, 18) };
      }
    }
    return null;
  }
  // ::before / ::after boxes: the ones that paint, and the ones that only widen the hit area
  function pseudos(el) {
    const out = { paint: [], hit: [] };
    const cs0 = getComputedStyle(el);
    if (cs0.position === 'static') return out;
    const b = el.getBoundingClientRect();
    for (const p of ['::before', '::after']) {
      const cs = getComputedStyle(el, p);
      if (!cs || cs.content === 'none' || cs.content === 'normal' || cs.display === 'none' || cs.position !== 'absolute') continue;
      const px = (v) => (/px$/.test(v) ? parseFloat(v) : null);
      const t = px(cs.top), l = px(cs.left), r = px(cs.right), bt = px(cs.bottom);
      const w = px(cs.width), h = px(cs.height);
      const x0 = b.left + el.clientLeft, y0 = b.top + el.clientTop, iw = el.clientWidth, ih = el.clientHeight;
      let x, y, ww, hh;
      if (l != null && r != null) { x = x0 + l; ww = iw - l - r; } else if (l != null && w != null) { x = x0 + l; ww = w; } else if (r != null && w != null) { x = x0 + iw - r - w; ww = w; } else continue;
      if (t != null && bt != null) { y = y0 + t; hh = ih - t - bt; } else if (t != null && h != null) { y = y0 + t; hh = h; } else if (bt != null && h != null) { y = y0 + ih - bt - h; hh = h; } else continue;
      if (ww < 1 || hh < 1) continue;
      const box = { x, y, w: ww, h: hh };
      const tip = !/^(""|''|none|normal)$/.test(cs.content) || box.x < b.left - 8 || box.y < b.top - 8 || box.x + box.w > b.right + 8 || box.y + box.h > b.bottom + 8;
      if (tip) continue;
      if (paints(cs) || (cs.boxShadow && cs.boxShadow !== 'none')) out.paint.push({ box, boxShadow: cs.boxShadow });
      else if (cs.pointerEvents !== 'none') out.hit.push(box);
    }
    return out;
  }
  const inRoot = (root, el) => !root || root.contains(el);
  const TEXTY = 'input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=button]):not([type=submit]), textarea, select, [contenteditable="true"], [contenteditable=""]';
  const fsig = (el) => { if (!el.matches(TEXTY)) return sig(el); const out = [sig(el)]; let p = el.parentElement; for (let k = 0; k < 4 && p && p !== document.body; k++, p = p.parentElement) out.push(sig(p)); return out.join('#'); };
  // what a hover / focus state can change that the eye sees (icons inherit `color`)
  function sig(el) {
    const cs = getComputedStyle(el);
    const pb = getComputedStyle(el, '::before'), pa = getComputedStyle(el, '::after');
    const ic = el.querySelector(':scope > svg, :scope > .icon');
    const ics = ic ? getComputedStyle(ic) : null;
    return [cs.backgroundColor, cs.backgroundImage, cs.color, cs.borderTopColor, cs.borderBottomColor, cs.boxShadow, cs.outlineStyle + ' ' + cs.outlineWidth + ' ' + cs.outlineColor,
      cs.textDecorationLine, cs.opacity, cs.filter, cs.transform, pb.backgroundColor + pb.opacity + pb.boxShadow, pa.backgroundColor + pa.opacity + pa.boxShadow,
      ics ? ics.color + ics.opacity + ics.stroke + ics.transform : ''].join('|');
  }

  // Mark candidate controls and the ancestors whose :hover reveals things. Returns counts.
  function mark(rootSel) {
    document.querySelectorAll('[data-ovl],[data-ovlh],[data-ovlfa]').forEach((n) => { n.removeAttribute('data-ovl'); n.removeAttribute('data-ovlh'); n.removeAttribute('data-ovlfa'); });
    const root = rootSel ? [...document.querySelectorAll(rootSel)].pop() : document.body;
    if (!root) return { ctls: 0, hov: 0, missing: true };
    let i = 0, hov = 0;
    for (const el of root.querySelectorAll(CTL)) {
      if (!displayed(el)) continue;
      if (el.closest('[aria-hidden="true"], [inert]')) continue;
      el.dataset.ovl = String(i);
      // a text field's focus is often drawn by its wrapper (:focus-within): the audit forces that on 4 ancestors
      if (el.matches(TEXTY)) { let p = el.parentElement; for (let k = 0; k < 4 && p && p !== document.body; k++, p = p.parentElement) p.dataset.ovlfa = ((p.dataset.ovlfa || '') + ' ' + i).trim(); }
      i++;
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) if (!p.dataset.ovlh) { p.dataset.ovlh = '1'; hov++; }
    }
    return { ctls: i, hov };
  }

  // Everything the rules need, measured in the current (ancestor-hover forced) state.
  function collect(rootSel) {
    const root = rootSel ? [...document.querySelectorAll(rootSel)].pop() : document.body;
    const els = [];
    const ctlEls = [...document.querySelectorAll('[data-ovl]')];
    const byEl = new Map(ctlEls.map((el) => [el, +el.dataset.ovl]));
    const ctlAnc = (el) => { const a = []; for (let p = el.parentElement; p; p = p.parentElement) if (byEl.has(p)) a.push(byEl.get(p)); return a; };
    // painted boxes that hold something (bubbles, cards, chips): neighbours a ring must not bleed into
    const boxEls = new Map(); let bid = 200000;
    for (const n of root.querySelectorAll('*')) {
      if (byEl.has(n) || n.closest('svg') || !n.firstChild || !boxy(n) || !displayed(n) || opacity(n) < 0.05) continue;
      if (!n.firstElementChild && !/\S/.test(n.textContent || '')) continue;
      const cs = getComputedStyle(n), b = n.getBoundingClientRect();
      if (cs.position === 'fixed' && b.width >= innerWidth - 2 && b.height >= innerHeight - 2) continue;
      boxEls.set(n, bid++);
    }
    const boxAnc = (el) => { const a = []; for (let p = el.parentElement; p; p = p.parentElement) if (boxEls.has(p)) a.push(boxEls.get(p)); return a; };
    for (const el of ctlEls) {
      const id = +el.dataset.ovl;
      const r = R(el.getBoundingClientRect());
      const { clip, hard, soft } = clips(el);
      const vis = inter(r, clip);
      const ghost = opacity(el) < 0.05;
      const ps = pseudos(el);
      let hit = r; for (const h of ps.hit) hit = union(hit, h);
      const cs = getComputedStyle(el);
      const role = el.getAttribute('role') || '';
      const buttonish = /^(button|summary)$/i.test(el.tagName) || /^(button|menuitem|menuitemradio|menuitemcheckbox|tab|option|link)$/.test(role) || (el.tagName === 'A' && cs.display !== 'inline');
      const inline = el.tagName === 'A' && cs.display === 'inline' && (el.parentElement?.textContent || '').trim().length > (el.textContent || '').trim().length + 2;
      const labelled = (el.type === 'checkbox' || el.type === 'radio') && el.closest('label');
      els.push({ id, kind: 'ctl', sel: sel(el), rect: r, clip, clipSoft: soft, hardClip: hard, vis: !!vis, ghost, layer: layerOf(el), anc: ctlAnc(el), ctl: null,
        hit: hit === r ? null : hit, container: containerOf(el, false), inline, small: labelled ? false : undefined, boxAnc: boxAnc(el),
        rest: fsig(el), focused: el === document.activeElement, texty: el.matches(TEXTY), buttonish, selected: el.matches('[aria-selected="true"], [aria-pressed="true"], [aria-checked="true"], [aria-current]:not([aria-current="false"]), .on, .active, .is-active, .selected, .is-selected'), disabled: !!(el.disabled || el.getAttribute('aria-disabled') === 'true'), radius: cs.borderTopLeftRadius, fs: cs.fontSize, tag: el.tagName.toLowerCase() });
    }
    // text runs and loose icons
    const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (t) => (/\S/.test(t.data) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT) });
    let gid = 100000;
    const range = document.createRange();
    for (let t = tw.nextNode(); t; t = tw.nextNode()) {
      const p = t.parentElement;
      if (!p || p.closest('script, style, textarea, option, noscript, [aria-hidden="true"], .sr-only, .visually-hidden')) continue;   // screen-reader-only text is clipped on purpose
      if (!displayed(p) || opacity(p) < 0.05) continue;
      range.selectNodeContents(t);
      let box = null; const lines = [];
      for (const cr of range.getClientRects()) if (cr.width > 0.5 && cr.height > 0.5) { box = union(box, R(cr)); if (lines.length < 12) lines.push(R(cr)); }
      if (!box) continue;
      const { clip, hard, hardEl } = clips(p, true);
      if (!inter(box, clip)) continue;
      let cutX = false, cutY = false;
      for (let n = p; n; n = n.parentElement) {
        const cs = getComputedStyle(n);
        if (cs.textOverflow === 'ellipsis') cutX = true;
        if ((cs.webkitLineClamp && cs.webkitLineClamp !== 'none') || (cs.webkitMaskImage && cs.webkitMaskImage !== 'none') || (cs.maskImage && cs.maskImage !== 'none')) { cutY = true; cutX = true; }
        if (n === hardEl || n === document.body) break;
      }
      const owner = p.closest('[data-ovl]');
      els.push({ id: gid++, kind: 'glyph', sel: sel(p) + ' "' + t.data.trim().slice(0, 24) + '"', rect: box, clip, hardClip: hard, layer: layerOf(p),
        anc: owner ? [+owner.dataset.ovl, ...ctlAnc(owner)] : ctlAnc(p), ctl: owner ? +owner.dataset.ovl : null, container: containerOf(p, true), cutX, cutY, rects: lines.length > 1 ? lines : undefined, boxAnc: [...(boxEls.has(p) ? [boxEls.get(p)] : []), ...boxAnc(p)] });
    }
    for (const svg of root.querySelectorAll('svg, img')) {
      if (svg.closest('[data-ovl]') || svg.parentElement?.closest('svg')) continue;
      if (!displayed(svg) || opacity(svg) < 0.05) continue;
      const r = R(svg.getBoundingClientRect());
      const { clip, hard } = clips(svg);
      if (!inter(r, clip)) continue;
      els.push({ id: gid++, kind: 'glyph', sel: sel(svg), rect: r, clip, hardClip: hard, layer: layerOf(svg), anc: ctlAnc(svg), ctl: null, container: null, cutX: true, cutY: true, icon: true, boxAnc: boxAnc(svg) });
    }
    for (const [n, id] of boxEls) {
      const r = R(n.getBoundingClientRect()); const { clip } = clips(n);
      if (!inter(r, clip)) continue;
      const lines = getComputedStyle(n).display === 'inline' ? [...n.getClientRects()].filter((c) => c.width > 0.5).slice(0, 12).map(R) : [];
      els.push({ id, kind: 'box', sel: sel(n), rect: r, rects: lines.length > 1 ? lines : undefined, clip, layer: layerOf(n), anc: ctlAnc(n), ctl: null, boxAnc: boxAnc(n) });
    }
    const se = document.scrollingElement || document.documentElement;
    return { viewport: vp(), scrollWidth: Math.max(se.scrollWidth, document.body.scrollWidth), els };
  }

  // One control under forced :hover + :focus-visible: its box and what paints past it.
  function probe(id) {
    const el = document.querySelector('[data-ovl="' + id + '"]');
    if (!el) return null;
    const cs = getComputedStyle(el);
    const ps = pseudos(el);
    return { rect: R(el.getBoundingClientRect()), painted: paints(cs), boxShadow: cs.boxShadow, outlineStyle: cs.outlineStyle,
      outlineWidth: cs.outlineWidth, outlineOffset: cs.outlineOffset, pseudoPaint: ps.paint, opacity: opacity(el), sig: fsig(el) };
  }

  // The scroll containers in the root, biggest first (to page through long screens).
  function scrollers(rootSel) {
    const root = rootSel ? [...document.querySelectorAll(rootSel)].pop() : document.body;
    if (!root) return [];
    const out = [];
    for (const n of [root, ...root.querySelectorAll('*')]) {
      const cs = getComputedStyle(n);
      if (!/(auto|scroll)/.test(cs.overflowY) || n.scrollHeight <= n.clientHeight + 4 || n.clientHeight < 120) continue;
      if (!n.dataset.ovlScroll) n.dataset.ovlScroll = 'S' + out.length + '_' + Math.random().toString(36).slice(2, 6);
      out.push({ key: n.dataset.ovlScroll, h: n.clientHeight, sh: n.scrollHeight, area: n.clientHeight * n.clientWidth });
    }
    return out.sort((a, b) => b.area - a.area);
  }
  function scrollTo(key, top) { const n = document.querySelector('[data-ovl-scroll="' + key + '"]'); if (n) { n.scrollTop = top; return n.scrollTop; } return null; }

  // Findings drawn over the page for the contact sheet.
  function overlay(boxes) {
    document.getElementById('__ovl_overlay')?.remove();
    if (!boxes) return;
    const host = document.createElement('div');
    host.id = '__ovl_overlay';
    host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647';
    for (const b of boxes) {
      const d = document.createElement('div');
      d.style.cssText = 'position:absolute;box-sizing:border-box;left:' + b.x + 'px;top:' + b.y + 'px;width:' + Math.max(2, b.w) + 'px;height:' + Math.max(2, b.h) + 'px;border:' + (b.b ? '1px dashed #ff9f1a' : '2px solid #ff3b30');
      host.appendChild(d);
    }
    document.body.appendChild(host);
  }

  window.__ovl = { mark, collect, probe, scrollers, scrollTo, overlay };
}

module.exports = { install };
