// Window chrome: background layer, rail, top strip, toasts, connection state, phone nav. Owner: lane shell (C).
import { html } from '../lib/html.js';
import { Icon } from '../lib/icons.js';
import { leaveRefs } from '../lib/motion.js';
import { connection, toasts, waitingCount, queue, sessions, ready } from '../lib/store.js';
import { showPanel, inspectorOpen, inspectorPanel } from '../panels/index.js';
import { view, go, goBack, goHome, homeFx, paletteOpen, background, bgUrl, openSession, phoneScreen, sidebarOpen, toggleSidebar, isPhone, resolvedTheme } from './state.js';
import { cx, mod } from './util.js';
import { UpdateChip } from './update.js';   // lane restart
import { TabStrip } from './tabs.js';   // lane tabs
import { LayoutSwitch } from './layout-switch.js';   // lane quad: 1 / 2 / 4 corners
import { useLayoutEffect } from 'preact/hooks';   // lane looksync: Background's lined-up layer
import { signal } from '@preact/signals';
import { lineUp, blurKey, blurPlan } from '../lib/bg-placement.js';
import { topRowSource, topRowUpdate } from './toprow.js';   // lane helm-toprow-hints: Mantle's top bar
import { pinToast } from '../lib/store.js';   // lane plainerror: opening Details keeps the toast
import { ToastText } from './toast-text.js';   // lane plainerror: title, body, Details

// ---- lined-up wallpaper (lane looksync, 2026-10-10) ----
// "Same as desktop" on the desktop window: Mantle's still is drawn where the desktop draws it (cover-fit to the
// monitor the window is mostly on, shifted by the content area's screen position; ui/lib/bg-placement.js), so the
// glass looks see-through. The blurred still is rendered ONCE per blurKey (url, blur, monitor size, dpr) into a
// monitor-sized <canvas>; moving or resizing the window only rewrites a translate3d on that layer (and on Home's
// unblurred copy) from a requestAnimationFrame callback: no Preact render, no re-blur, no CSS filter. Preact only
// re-renders when the layer appears / disappears or a new canvas lands (lnShown). Anything not ready (no placement
// yet, image still decoding, window bigger than its monitor, a failed load) shows the plain CSS cover + filter
// markup below, which is also the ONLY path on the phone, in ?mock=1 and in "own photo" mode.
const LN = {
  want: null,          // { url, blurPx } while the lined path is wanted, else null
  gen: 0,              // bumps on stop: late blur renders from an older run are dropped
  placement: null, unsub: null, offDpr: null, raf: 0, timer: 0,
  tx: 0, ty: 0,        // the current offsets (CSS px, integers)
  cache: null,         // { key, canvas, monW, monH }: the blurred still (one at a time)
  busy: false, failedKey: null, imgUrl: null, imgP: null,
  blurs: 0,            // blur renders since load (data-blurs: the move check asserts this does not grow)
  bg: null, photo: null, clear: null,   // live elements (stable ref callbacks below)
  clearWrap: null, img: null,           // Home's .bg-clear and the decoded still (top-row hints, ui/shell/toprow.js)
};
const lnShown = signal(null);   // the LN.cache entry on screen, or null -> the CSS fallback markup
const refBg = (el) => { LN.bg = el; };
const refPhoto = (el) => { LN.photo = el; if (el) present(); };
const refClear = (el) => { LN.clear = el; if (el) moveLayers(); };
const refClearWrap = (el) => { LN.clearWrap = el; };
// Top-row hints: what the background shows under the window's row 0 (ui/shell/toprow.js reads this)
topRowSource(() => {
  const c = lnShown.peek();
  return { lined: c && LN.photo && LN.photo.firstChild === c.canvas ? c : null, tx: LN.tx, ty: LN.ty, img: LN.img, clearEl: LN.clearWrap };
});

function lineWant(w) {
  LN.want = w;
  if (!w) { stopLine(); return; }
  if (!LN.unsub) {
    const nat = window.helmNative, gen = LN.gen;
    LN.unsub = nat.onPlacement((p) => { LN.placement = p; schedule(); });
    addEventListener('resize', schedule);
    watchDpr();
    Promise.resolve(nat.placement?.()).then((p) => { if (gen === LN.gen && p && !LN.placement) { LN.placement = p; schedule(); } }, () => {});
  }
  schedule();
}

function stopLine() {
  if (LN.unsub) {
    try { LN.unsub(); } catch {}
    removeEventListener('resize', schedule);
  }
  LN.offDpr?.();
  if (LN.raf) cancelAnimationFrame(LN.raf);
  clearTimeout(LN.timer);
  Object.assign(LN, { gen: LN.gen + 1, unsub: null, offDpr: null, raf: 0, timer: 0, placement: null, cache: null, busy: false, failedKey: null, imgUrl: null, imgP: null, img: null });
  lnShown.value = null;
}

// moving to a monitor with another scale changes devicePixelRatio (a new backing size -> a new blur key)
function watchDpr() {
  if (typeof matchMedia !== 'function') return;
  const mq = matchMedia(`(resolution: ${devicePixelRatio || 1}dppx)`);
  const on = () => { LN.offDpr?.(); if (LN.unsub) { watchDpr(); schedule(); } };
  mq.addEventListener('change', on);
  LN.offDpr = () => { mq.removeEventListener('change', on); LN.offDpr = null; };
}

// many placements per second while dragging -> one apply per frame (the timer only covers a frame that never comes)
function schedule() {
  if (LN.raf || !LN.want) return;
  LN.raf = requestAnimationFrame(apply);
  LN.timer = setTimeout(apply, 250);
}

function apply() {
  cancelAnimationFrame(LN.raf); clearTimeout(LN.timer);
  LN.raf = 0; LN.timer = 0;
  const w = LN.want;
  if (!w) return;
  const r = lineUp(LN.placement, innerWidth, innerHeight);
  if (!r.ok) { show(null); return; }
  const key = blurKey(w.url, w.blurPx, r.monW, r.monH, devicePixelRatio || 1, w.sat);
  if (key === LN.failedKey) { show(null); return; }
  if (LN.cache?.key !== key) ensureBlur(key, w, r.monW, r.monH);
  const c = LN.cache;
  // a canvas for THIS monitor size; a stale url / blur stays up while its replacement renders (no flash)
  if (!c || c.monW !== r.monW || c.monH !== r.monH) { show(null); return; }
  LN.tx = r.tx; LN.ty = r.ty;
  show(c);
  moveLayers();
}

function show(c) { if (lnShown.peek() !== c) lnShown.value = c; }

// after a render: put the current canvas into the lined layer (once per canvas), then the offsets
function present() {
  const c = lnShown.peek();
  if (LN.photo && c && LN.photo.firstChild !== c.canvas) LN.photo.replaceChildren(c.canvas);
  moveLayers();
}

// the per-frame work: two transforms + two data attributes, nothing else
function moveLayers() {
  if (!LN.photo) return;   // the lined markup is not mounted (fallback, phone, own mode)
  const t = `translate3d(${LN.tx}px, ${LN.ty}px, 0)`;
  LN.photo.style.transform = t;
  if (LN.clear) LN.clear.style.transform = t;
  if (LN.bg) { LN.bg.dataset.tx = String(LN.tx); LN.bg.dataset.ty = String(LN.ty); }
  topRowUpdate('move');   // same task as the move: a row that slides with the screen is re-sent before this frame
}

function loadImage(url) {
  if (LN.imgUrl === url && LN.imgP) return LN.imgP;
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
  const p = img.decode().then(() => { if (LN.imgUrl === url) LN.img = img; return img; });
  p.catch(() => { if (LN.imgP === p) { LN.imgUrl = null; LN.imgP = null; } });
  LN.imgUrl = url; LN.imgP = p; LN.img = null;
  return p;
}

// one blur render at a time; when it lands apply() runs again and starts the next if the key moved on meanwhile
function ensureBlur(key, w, monW, monH) {
  if (LN.busy) return;
  LN.busy = true;
  const gen = LN.gen, dpr = devicePixelRatio || 1;
  loadImage(w.url).then((img) => {
    if (gen !== LN.gen) return;
    const canvas = renderBlur(img, monW, monH, dpr, w.blurPx, w.sat);
    LN.blurs += 1;
    if (LN.bg) LN.bg.dataset.blurs = String(LN.blurs);
    LN.cache = { key, canvas, monW, monH, url: w.url, blurPx: w.blurPx };
  }).catch((e) => {
    if (gen !== LN.gen) return;
    LN.failedKey = key; LN.cache = null;   // fall back to the CSS markup until the url / blur / monitor changes
    console.warn('[helm] lined-up wallpaper failed; showing the plain cover layer:', e?.message || e);
  }).finally(() => {
    if (gen !== LN.gen) return;
    LN.busy = false;
    schedule();
  });
}

// cover-fit into a margin-padded scratch canvas, stretch the edge rows / columns out over the margin (so the
// monitor edges do not fade), blur that once (sigma = blur x dpr, like CSS blur() on a device-scaled layer), crop
// the centre. Backing = monitor DIPs x dpr; CSS size = monitor DIPs (the layer's width / height).
// sat: the light ground's saturate (%), baked into the same pass (100 = none: dark renders exactly as before)
function renderBlur(img, monW, monH, dpr, blurPx, sat = 100) {
  const { cw, ch, sigma, margin: m, draw: d } = blurPlan(img.naturalWidth, img.naturalHeight, monW, monH, dpr, blurPx);
  const mk = (cwid, chei) => { const c = document.createElement('canvas'); c.width = cwid; c.height = chei; return c; };
  const out = mk(cw, ch);
  const octx = out.getContext('2d');
  // 1 backing px of bleed on every side so the edge rows / columns are fully opaque (no anti-aliased seam)
  const paint = (ctx, ox, oy) => ctx.drawImage(img, ox + d.x - 1, oy + d.y - 1, d.width + 2, d.height + 2);
  const satF = sat !== 100 && Number.isFinite(+sat) ? ` saturate(${+sat}%)` : '';
  if (!(sigma > 0)) { if (satF) octx.filter = satF.trim(); paint(octx, 0, 0); return out; }
  const W = cw + 2 * m, H = ch + 2 * m;
  const s = mk(W, H), sctx = s.getContext('2d');
  sctx.save(); sctx.beginPath(); sctx.rect(m, m, cw, ch); sctx.clip(); paint(sctx, m, m); sctx.restore();
  sctx.imageSmoothingEnabled = false;   // stretch single rows / columns without sampling the empty margin
  sctx.drawImage(s, m, m, cw, 1, m, 0, cw, m);
  sctx.drawImage(s, m, m + ch - 1, cw, 1, m, m + ch, cw, m);
  sctx.drawImage(s, m, 0, 1, H, 0, 0, m, H);
  sctx.drawImage(s, m + cw - 1, 0, 1, H, m + cw, 0, m, H);
  const bl = mk(W, H), bctx = bl.getContext('2d');
  bctx.filter = `blur(${sigma}px)${satF}`;
  bctx.drawImage(s, 0, 0);
  octx.drawImage(bl, m, m, cw, ch, 0, 0, cw, ch);
  s.width = s.height = bl.width = bl.height = 0;   // free the scratch backings now, not at GC
  return out;
}

// lane home: on Home an UNBLURRED copy of the photo (.bg-clear) cross-fades in over the blurred layer, which is then
// hidden (home.css), so neither the blur nor a backdrop-filter is ever animated. The copy only exists on Home and
// for the fade back out (homeFx 'from'); the same URL means the same decoded image. Lined up, the copy's picture is
// a monitor-sized child (.bg-clear-img) under the same transform, so the fade still animates only .bg-clear.
export function Background() {
  const b = background.value;
  const url = b.url !== undefined ? b.url : bgUrl(b.file);
  const fx = homeFx.value;
  const clear = !!url && (view.value === 'home' || fx != null);
  const blurPx = Math.max(0, +b.blur || 0);
  const sat = resolvedTheme.value === 'light' ? 150 : 100;   // light ground: blur + saturate(150%) (shell.css does the same for the CSS layer)
  const want = !!(url && b.lineUp && !isPhone.value && typeof window !== 'undefined' && typeof window.helmNative?.onPlacement === 'function');
  const shown = lnShown.value;
  const lined = want && !!shown;
  useLayoutEffect(() => { lineWant(want ? { url, blurPx, sat } : null); }, [want, url, blurPx, sat]);
  useLayoutEffect(() => () => lineWant(null), []);
  useLayoutEffect(present);   // every render: a freshly landed canvas goes in; the offsets are re-asserted
  useLayoutEffect(() => { topRowUpdate('render'); });   // every render, same task as the commit: Mantle's top bar
  const pos = lined ? { width: `${shown.monW}px`, height: `${shown.monH}px`, transform: `translate3d(${LN.tx}px, ${LN.ty}px, 0)` } : null;
  const img = url && { backgroundImage: `url("${url}")` };
  return html`<div class="bg" aria-hidden="true" ref=${refBg} data-lined=${lined ? '1' : '0'}
      data-tx=${String(lined ? LN.tx : 0)} data-ty=${String(lined ? LN.ty : 0)} data-blurs=${String(LN.blurs)}>
    ${url && (lined
      ? html`<div key="lined" class="bg-photo bg-lined" ref=${refPhoto} style=${pos}></div>`
      : html`<div key="css" class="bg-photo" style=${img}></div>`)}
    ${clear && html`<div class=${cx('bg-clear', fx === 'from' && 'out')} ref=${refClearWrap} style=${lined ? {} : img}>
      ${lined && html`<div class="bg-clear-img bg-lined" ref=${refClear} style=${{ ...pos, ...img }}></div>`}
    </div>`}
    <div class="bg-wash"></div>
  </div>`;
}

function RailBtn({ icon, label, on, onClick, badge, badgeKind, keys }) {
  return html`<button class=${cx('rail-btn', on && 'on')} aria-label=${label} aria-current=${on ? 'page' : undefined}
      data-tip=${keys ? `${label}  ${keys}` : label} data-tip-pos="right" onClick=${onClick}>
    <${Icon} name=${icon} size=${19} stroke=${1.5} />
    ${badge ? html`<span class=${cx('rail-badge', badgeKind)}>${badge}</span>` : null}
  </button>`;
}

export function Rail() {
  const v = view.value;
  const activeQueue = queue.value.filter((j) => j.status === 'queued' || j.status === 'running').length;
  const queueOn = inspectorOpen.value && inspectorPanel.value === 'queue' && v === 'session';
  return html`<nav class="rail" aria-label="Main">
    <button class=${cx('rail-mark rail-home', v === 'home' && 'on')} aria-label="Home" aria-current=${v === 'home' ? 'page' : undefined}
      data-tip=${`Home  ${mod}+Shift+H`} data-tip-pos="right" onClick=${goHome}><${Icon} name="helm" size=${20} stroke=${1.5} /></button>
    <${RailBtn} icon="message" label="Sessions" on=${v === 'session'} keys=${`${mod}+B`}
      onClick=${() => { if (v === 'session') toggleSidebar(); else { go('session'); sidebarOpen.value = true; } }}
      badge=${waitingCount.value || null} badgeKind="warn" />
    <${RailBtn} icon="deck" label="Deck" on=${v === 'deck'} keys=${`${mod}+Shift+D`} onClick=${() => (v === 'deck' ? goBack() : go('deck'))} />
    <${RailBtn} icon="history" label="History" on=${v === 'history'} keys=${`${mod}+H`} onClick=${() => (v === 'history' ? goBack() : go('history'))} />
    <${RailBtn} icon="queue" label="Queue" on=${queueOn} badge=${activeQueue || null}
      onClick=${() => { go('session'); showPanel('queue', { toggle: true }); }} />
    <div class="rail-spacer"></div>
    <${RailBtn} icon="command" label="Commands" keys=${`${mod}+K`} onClick=${() => { paletteOpen.value = true; }} />
    <${RailBtn} icon="settings" label="Settings" on=${v === 'settings'} keys=${`${mod}+,`} onClick=${() => (v === 'settings' ? goBack() : go('settings'))} />
  </nav>`;
}

export function Strip() {
  const c = connection.value;
  // lane tabs: open sessions as tabs (tabs.js), a drag gap, then a compact search (Ctrl+K) on the right;
  // lane quad: the layout switch (1 / 2 / 4 corners) sits just left of the search
  return html`<div class="strip has-tabs">
    <div class="strip-left">
      <button class="icon-btn strip-btn" aria-pressed=${sidebarOpen.value && view.value !== 'home'} aria-label="Toggle sidebar" data-tip=${`Sidebar  ${mod}+B`} data-tip-pos="bottom"
        onClick=${toggleSidebar}><${Icon} name="sidebar-left" size=${16} /></button>
    </div>
    <${TabStrip} />
    <div class="strip-fill"></div>
    <${LayoutSwitch} />
    <button class="strip-search" onClick=${() => { paletteOpen.value = true; }} aria-label="Command palette: search sessions and commands" title="Search sessions and commands">
      <${Icon} name="search" size=${14} />
      <span class="grow">Search</span>
      <span class="kbd">${mod}</span><span class="kbd">K</span>
    </button>
    <div class="strip-right"><${UpdateChip} />${c !== 'open' && html`<${ConnPill} c=${c} />`}</div>
  </div>`;
}

function ConnPill({ c }) {
  const text = c === 'unauthorized' ? 'Not paired: open the phone link from Settings on the PC'
    : c === 'connecting' ? (ready.value ? 'Reconnecting…' : 'Connecting…') : 'Offline · retrying';
  return html`<div class=${cx('conn', c)} role="status">
    ${c === 'unauthorized' ? html`<${Icon} name="lock" size=${13} />` : c === 'closed' ? html`<${Icon} name="wifi-off" size=${13} />` : html`<span class="spinner sm"></span>`}
    <span>${text}</span>
  </div>`;
}

export function PhoneConn() {
  const c = connection.value;
  return c === 'open' ? null : html`<div class="phone-conn"><${ConnPill} c=${c} /></div>`;
}

const TOAST_ICON = { error: 'alert', waiting: 'help', done: 'check-circle', info: 'info' };
// The region stays mounted (empty, pointer-events: none) so a live region exists before its first toast and the
// last toast still has somewhere to leave from (lib/motion.js leaveRefs).
const toastLeave = leaveRefs('drop', 's');
export function Toasts() {
  const list = toasts.value;
  const dismiss = (id) => { toasts.value = toasts.value.filter((t) => t.id !== id); };
  return html`<div class="toasts" role="region" aria-label="Notifications" aria-live="polite">
    ${list.slice(-4).map((t) => html`<div key=${t.id} ref=${toastLeave(t.id)} class=${cx('toast', `k-${t.kind}`, t.sessionId && 'link')}
        onClick=${() => { if (t.sessionId) { openSession(t.sessionId); dismiss(t.id); } }}>
      <span class="toast-icon"><${Icon} name=${TOAST_ICON[t.kind] || 'info'} size=${16} /></span>
      <${ToastText} t=${t} onPin=${() => pinToast(t.id)} />
      <button class="icon-btn sm toast-x" aria-label="Dismiss" onClick=${(e) => { e.stopPropagation(); dismiss(t.id); }}><${Icon} name="x" size=${14} /></button>
    </div>`)}
  </div>`;
}

export function PhoneNav() {
  const v = view.value;
  const activeQueue = queue.value.filter((j) => j.status === 'queued' || j.status === 'running').length;
  const item = (id, icon, label, badge, kind) => html`<button class=${cx('pnav-btn', v === id && 'on')} aria-current=${v === id ? 'page' : undefined}
      onClick=${() => { go(id); if (id === 'session') phoneScreen.value = 'list'; }}>
    <span class="pnav-icon"><${Icon} name=${icon} size=${21} stroke=${1.5} />${badge ? html`<span class=${cx('rail-badge', kind)}>${badge}</span>` : null}</span>
    <span class="pnav-label">${label}</span>
  </button>`;
  return html`<nav class="pnav has-home" aria-label="Main">
    ${item('home', 'home', 'Home')}
    ${item('session', 'message', 'Sessions', waitingCount.value || null, 'warn')}
    ${item('history', 'history', 'History')}
    ${item('queue', 'queue', 'Queue', activeQueue || null)}
    ${item('settings', 'settings', 'Settings')}
  </nav>`;
}
