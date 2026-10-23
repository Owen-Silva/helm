// Settings view. Owner: lane shell (C).
import { useState, useRef, useEffect } from 'preact/hooks';
import { html } from '../lib/html.js';
import { Icon } from '../lib/icons.js';
import { settings, saveSettings, rpc, toast, appInfo, look, toprowStatus } from '../lib/store.js';
import { topRowLast } from './toprow.js';   // lane helm-toprow-hints
import { bgPreview, bgUrl, background, isPhone, resolvedTheme } from './state.js';
import { previewFor, withPreview, savePartial } from '../lib/glass.js';   // lane wk-light: sliders edit glass[theme]
import { cx, useModels, EFFORTS, MODES, debounce, agoLong } from './util.js';
import { QrCode } from './qr.js';
import { PhoneHealth, copyText } from './phone.js';
import { ClaudeCodeSettings } from './claude-config.js';   // lane cc-config
import { AccountSettings } from './account.js';             // lane account
import { UpdateSettings } from './update.js';               // lane restart
import { CONTEXT_HANDOFF_PCT, CONTEXT_CEILING_PCT } from '../lib/context-limits.js';   // lane ctxwarn

const save = (partial, what = 'Settings') => saveSettings(partial).catch((e) => toast({ title: `${what} not saved`, error: e, kind: 'error' }));

function Section({ id, title, desc, children }) {
  return html`<section class="set-sec" id=${`set-${id}`} aria-labelledby=${`set-${id}-h`}>
    <header class="set-sec-head"><h2 id=${`set-${id}-h`}>${title}</h2>${desc && html`<p>${desc}</p>`}</header>
    <div class="set-sec-body card flat">${children}</div>
  </section>`;
}
function Row({ label, hint, children, stack }) {
  return html`<div class=${cx('set-row', stack && 'stack')}>
    <div class="set-row-label"><span>${label}</span>${hint && html`<span class="hint">${hint}</span>`}</div>
    <div class="set-row-ctl">${children}</div>
  </div>`;
}

function readDataUrl(file) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(file); });
}

// "forest.jpg" -> "Forest", "my-desk_2.png" -> "My desk 2"
const photoName = (f) => String(f).replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim().replace(/^./, (c) => c.toUpperCase()) || String(f);
const BG_TYPES = /^image\/(jpeg|png|webp)$/;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');

// Bundled photo catalog: [{ file, title, category, credit, url }], fetched once per page load.
// Missing or malformed -> [] and every file in settings.backgrounds shows uncategorized.
let catalogCache = null;
let catalogLoad = null;
function loadCatalog() {
  if (catalogCache) return Promise.resolve(catalogCache);
  if (!catalogLoad) {
    catalogLoad = fetch('/assets/backgrounds/catalog.json', { cache: 'no-cache' })
      .then((r) => (r.ok ? r.json() : []))
      .catch(() => [])
      .then((j) => {
        const seen = new Set();
        catalogCache = (Array.isArray(j) ? j : []).filter((x) => x && typeof x.file === 'string' && x.file && !seen.has(x.file) && seen.add(x.file))
          .map((x) => ({ file: x.file, title: String(x.title || photoName(x.file)), category: x.category ? String(x.category) : '', credit: x.credit ? String(x.credit) : '', url: /^https?:\/\//.test(x.url || '') ? x.url : '' }));
        return catalogCache;
      });
  }
  return catalogLoad;
}
const thumbUrl = (file) => `/assets/backgrounds/thumbs/${encodeURIComponent(file)}`;
// A missing thumbnail falls back to the full photo once; a photo that still fails leaves the plain tile
// (its name stays underneath) instead of the browser's broken-image glyph.
const imgError = (file, thumb) => (e) => {
  const i = e.currentTarget;
  if (thumb && !i.dataset.fb) { i.dataset.fb = '1'; i.src = bgUrl(file); } else i.style.visibility = 'hidden';
};
const YOURS = '__yours';
const BG_MODES = [{ v: 'desktop', l: 'Same as desktop', i: 'monitor' }, { v: 'own', l: 'Own picture', i: 'image' }];
const num = (v, d) => (Number.isFinite(+v) && v !== null && v !== '' ? +v : d);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const signed = (v) => (v > 0 ? `+${v.toFixed(2)}` : v.toFixed(2));
const panelHint = (v) => (Math.abs(v) < 0.005 ? '0 (default)' : `${signed(v)} (${v < 0 ? 'more see-through' : 'more solid'})`);
const lookNow = () => look.value;
const appName = (by) => ({ helm: 'Helm', quartz: 'Quartz', mantle: 'Mantle' }[by] || (by ? String(by) : ''));
const isoAgo = (at) => { const t = Date.parse(at || ''); return Number.isFinite(t) ? agoLong(t) : ''; };
// Helm's own accent S/L with the user's hue: the exact acc formula of main/accent.js (dark #9fb4cc, light #4d6784).
const ACC_SL = { dark: [30.6, 71.2], light: [26.3, 41.0] };
const accApprox = (hue, theme) => { const [s, l] = ACC_SL[theme] || ACC_SL.dark; return `hsl(${hue} ${s}% ${l}%)`; };
const HELM_HUE = 212;   // Helm's steel blue: picking "Custom hue" starts here, so nothing jumps

const shuffleIcon = html`<svg class="icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M16 3h5v5"/><path d="M4 20 21 3"/><path d="M21 16v5h-5"/><path d="M15 15l6 6"/><path d="M4 4l5 5"/></svg>`;

function Backgrounds() {
  const st = settings.value;
  const b = background.value;
  const list = st.backgrounds || [];
  const theme = resolvedTheme.value === 'light' ? 'light' : 'dark';
  // The sliders edit the synced glass of the theme showing now (look-sync CONTRACT "Light look": glass.light in
  // light, glass.dark in dark); a preview made in the other theme is not this one's
  const pv = previewFor(bgPreview.value, theme);
  const g = st.glass?.[theme] || {};
  const lookName = theme === 'light' ? 'light look' : 'dark look';
  const mode = b.mode === 'own' ? 'own' : 'desktop';
  const blur = num(pv.blur, num(g.blurPx, num(b.blur, 28)));
  const dim = num(pv.dim, num(g.dim, num(b.setDim, 0.45)));   // the slider is the dim as set, not the shared darkening
  const panel = num(pv.panel, num(g.panel, num(b.panel, 0)));
  const fileInput = useRef(null);
  const [uploading, setUploading] = useState(false);
  const [dropping, setDropping] = useState(false);
  const [catalog, setCatalog] = useState(catalogCache);
  const [filter, setFilter] = useState('all');
  useEffect(() => { if (!catalog) loadCatalog().then(setCatalog); }, []);
  // Every change shows at once through bgPreview (the background layer reads it), then one debounced
  // save persists the whole pending preview. The preview is cleared only if nothing changed meanwhile.
  // Photo + mode go to settings.background (per app); blur/dim/panel go to the synced glass of the theme the
  // preview was made in (snap.theme; the host deep-merges a partial glass).
  const commit = useRef(debounce(() => {
    const snap = bgPreview.value;
    if (!snap) return;
    const partial = savePartial(snap);   // ui/lib/glass.js: glass values go to glass[the theme they were made in]
    if (!Object.keys(partial).length) { bgPreview.value = null; return; }
    save(partial, 'Look')
      .finally(() => { if (bgPreview.value === snap) bgPreview.value = null; });
  }, 350)).current;
  useEffect(() => () => commit.cancel(), []);
  // a glass value is stamped with this theme; one made in the other theme (flipped mid-drag) is dropped, not mis-filed
  const live = (partial) => { bgPreview.value = withPreview(bgPreview.value, partial, theme); commit(); };
  const pick = (file) => { if (file !== b.file) live({ file }); };
  const uploadFile = async (f) => {
    if (!f) return;
    if (!BG_TYPES.test(f.type)) { toast({ title: 'Unsupported image', body: 'Use a JPEG, PNG or WebP.', kind: 'error' }); return; }
    if (f.size > 15 * 1024 * 1024) { toast({ title: 'Image too large', body: 'Keep it under 15 MB.', kind: 'error' }); return; }
    setUploading(true);
    try {
      const dataUrl = await readDataUrl(f);
      // The host saves it (renaming on clashes) and makes it the current background.
      const s = await rpc('settings.uploadBackground', { name: f.name, dataUrl });
      if (bgPreview.value) { const { file, kind, ...rest } = bgPreview.value; bgPreview.value = Object.keys(rest).length ? rest : null; }
      if (s) settings.value = { ...s };
    } catch (err) { toast({ title: 'Upload failed', error: err, kind: 'error' }); }
    setUploading(false);
  };
  const onPick = (e) => { const f = e.currentTarget.files?.[0]; e.currentTarget.value = ''; uploadFile(f); };
  const drag = {
    onDragOver: (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; if (!dropping) setDropping(true); },
    onDragLeave: (e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDropping(false); },
    onDrop: (e) => { if (!hasFiles(e)) return; e.preventDefault(); setDropping(false); uploadFile(e.dataTransfer.files?.[0]); },
  };
  // Gallery model: catalog photos (in catalog order), then "your photos" = files the host lists that the
  // catalog doesn't know (uploads, or everything when there is no catalog).
  const cat = catalog || [];
  const byFile = new Map(cat.map((x) => [x.file, x]));
  const yours = list.filter((f) => !byFile.has(f));
  const categories = [...new Set(cat.map((x) => x.category).filter(Boolean))];
  const chips = [{ id: 'all', label: 'All' }, ...categories.map((c) => ({ id: c, label: c }))];
  if (cat.length && yours.length) chips.push({ id: YOURS, label: 'Your photos' });
  const active = chips.some((c) => c.id === filter) ? filter : 'all';
  const catItems = (active === 'all' ? cat : active === YOURS ? [] : cat.filter((x) => x.category === active))
    .map((x) => ({ file: x.file, label: x.title, src: thumbUrl(x.file), thumb: true }));
  const yourItems = (active === 'all' || active === YOURS) ? yours.map((f) => ({ file: f, label: photoName(f), src: bgUrl(f) })) : [];
  const items = [...catItems, ...yourItems];
  const showAdd = active === 'all' || active === YOURS;
  const showNone = active === 'all';
  const shuffle = () => {
    let pool = items.map((x) => x.file).filter((f) => f !== b.file);
    if (!pool.length) pool = [...cat.map((x) => x.file), ...yours].filter((f) => f !== b.file);
    if (pool.length) pick(pool[Math.floor(Math.random() * pool.length)]);
  };
  const sel = b.file ? byFile.get(b.file) : null;
  const credit = !b.file ? html`<span>No photo</span>`
    : sel ? html`<span class="gal-credit-title">${sel.title}</span>${sel.credit && html`<span class="gal-dot">${' · '}</span>${sel.url
      ? html`<a href=${sel.url} target="_blank" rel="noopener noreferrer">Photo by ${sel.credit}</a>` : html`<span>Photo by ${sel.credit}</span>`}`}`
    : html`<span class="gal-credit-title">${photoName(b.file)}</span>${cat.length ? html`<span class="gal-dot">${' · '}</span><span>Your photo</span>` : null}`;
  const tile = ({ file, label, src, thumb }) => html`<button key=${file || '-none'} type="button" role="radio" aria-checked=${b.file === file}
      class=${cx('gal-opt', b.file === file && 'on')} onClick=${() => pick(file)} title=${label}>
    <span class=${cx('gal-tile', !file && 'none')}>
      ${file ? html`<img src=${src} alt="" loading="lazy" decoding="async" draggable="false" onError=${imgError(file, thumb)} />`
        : html`<span class="gal-tile-none" aria-hidden="true"></span>`}
      ${b.file === file && html`<span class="gal-check"><${Icon} name="check" size=${11} stroke=${2.2} /></span>`}
    </span>
    <span class="gal-name truncate">${label}</span>
  </button>`;
  const setMode = (m) => { if (m !== mode) live({ mode: m }); };
  return html`
    <${Row} label="Background" hint=${mode === 'desktop' ? 'Following your desktop wallpaper — change it in Mantle.' : 'Pick a photo. It is blurred once behind every panel, and changes as you click.'} stack>
      <div class="seg bg-mode" role="radiogroup" aria-label="Background source">
        ${BG_MODES.map((o) => html`<button key=${o.v} role="radio" aria-checked=${mode === o.v} aria-pressed=${mode === o.v} onClick=${() => setMode(o.v)}><${Icon} name=${o.i} size=${13} />${o.l}</button>`)}
      </div>
      ${mode === 'desktop' ? html`<${DesktopSource} />` : html`
      <div class=${cx('gal', dropping && 'dropping')} ...${drag}>
        <div class="gal-bar">
          ${chips.length > 1 && html`<div class="gal-chips" role="group" aria-label="Filter backgrounds">
            ${chips.map((c) => html`<button key=${c.id} type="button" class="chip" aria-pressed=${active === c.id} onClick=${() => setFilter(c.id)}>${c.label}</button>`)}
          </div>`}
          <button type="button" class="btn btn-ghost btn-sm gal-shuffle" onClick=${shuffle} title="Use a random photo">${shuffleIcon}Shuffle</button>
        </div>
        <div class="gal-grid" role="radiogroup" aria-label="Background photo">
          ${showAdd && html`<button key="-add" type="button" class="gal-opt add" onClick=${() => fileInput.current?.click()} disabled=${uploading} title="Choose a photo from this device">
            <span class="gal-tile add">${uploading ? html`<span class="spinner"></span>` : html`<${Icon} name="plus" size=${18} />`}</span>
            <span class="gal-name">${uploading ? 'Adding…' : 'Add photo'}</span>
          </button>`}
          ${items.map(tile)}
          ${showNone && tile({ file: null, label: 'None' })}
        </div>
        <input ref=${fileInput} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange=${onPick} />
        <div class="gal-foot">
          <p class="gal-credit truncate">${credit}</p>
          <p class="hint gal-hint">${dropping ? 'Drop to use this photo' : 'JPEG, PNG or WebP up to 15 MB, or drop an image here.'}</p>
        </div>
      </div>`}
    <//>
    <${Row} label="Blur" hint=${`${Math.round(blur)} px · ${lookName}`}>
      <input class="range" type="range" min="0" max="64" step="1" value=${clamp(blur, 0, 64)} aria-label=${`Background blur, ${lookName}`}
        onInput=${(e) => live({ blur: +e.currentTarget.value })} />
    <//>
    <${Row} label="Dim" hint=${`${Math.round(dim * 100)}% · ${lookName}`}>
      <input class="range" type="range" min="0.2" max="0.9" step="0.01" value=${clamp(dim, 0.2, 0.9)} aria-label=${`Background dim, ${lookName}`}
        onInput=${(e) => live({ dim: +e.currentTarget.value })} />
    <//>
    <${Row} label="See-through" hint=${`${panelHint(panel)} · ${lookName}`}>
      <input class="range" type="range" min="-0.3" max="0.15" step="0.01" value=${clamp(panel, -0.3, 0.15)} aria-label=${`Panel see-through, ${lookName}`}
        onInput=${(e) => live({ panel: Math.round(+e.currentTarget.value * 100) / 100 })} />
    <//>`;
}

// Desktop mode: no picker, just where the wallpaper comes from right now (state + reason, never silent).
function DesktopSource() {
  const d = lookNow()?.desktop || null;
  const [thumbOk, setThumbOk] = useState(true);
  const url = d?.url || null;
  useEffect(() => setThumbOk(true), [url]);
  let text, tone = '';
  if (!d) { text = 'Checking which wallpaper the desktop uses…'; }
  else if (d.source === 'mantle' && d.ok !== false) { text = `Now: ${d.title || 'your wallpaper'}, shared by Mantle`; }
  else if (d.source === 'windows') { text = d.reason || "Following Windows' wallpaper: Mantle hasn't shared one yet"; tone = 'warn'; }
  else { text = d.reason || 'No desktop wallpaper to follow: neither Mantle nor Windows reported one'; tone = 'danger'; }
  // "Change it in Mantle": a button once the host knows Mantle's open-Wallpapers command (main/look.js MANTLE_OPEN),
  // until then text with the reason
  const mo = lookNow()?.mantleOpen || null;
  const openMantle = () => rpc('look.openMantle', {}).catch((e) => toast({ title: "Couldn't open Mantle", error: e, kind: 'error' }));
  // Shared top band (look-sync CONTRACT "desktop.guard" + "Light look"): which wash shows, and why, in either theme
  // (dark: the darkening; light: the white that keeps the secondary text readable on this photo)
  const w = background.value.wash;
  const light = resolvedTheme.value === 'light';
  const what = light ? 'White wash' : 'Darkening';
  const washText = !d ? null
    : w.used ? `${what} ${w.dim.toFixed(2)}, shared with Mantle and Quartz so the top bars match on this photo`
    : `${what} ${(+w.dim).toFixed(2)} (your dim): ${w.reason}`;
  return html`<div class="look-desk">
    ${url && thumbOk ? html`<img class="look-desk-thumb" src=${url} alt="" draggable="false" decoding="async" onError=${() => setThumbOk(false)} />`
      : html`<span class="look-desk-thumb none" aria-hidden="true"></span>`}
    <div class="look-desk-info">
      <p class=${cx('look-desk-text', tone)}>${tone && html`<${Icon} name="alert" size=${13} />`}<span>${text}</span>${d?.rev != null && html`<span class="look-rev">rev ${d.rev}</span>`}</p>
      ${washText && html`<p class=${cx('look-desk-text', 'look-guard', !w.used && 'warn')}>${!w.used && html`<${Icon} name="alert" size=${13} />`}<span>${washText}</span></p>`}
    </div>
    ${mo?.available ? html`<button type="button" class="btn btn-ghost btn-sm look-desk-open" onClick=${openMantle}>Change it in Mantle's Wallpapers</button>`
      : html`<p class="hint look-desk-open">Change it in Mantle's Wallpapers.${mo?.reason ? ` ${mo.reason}` : ''}</p>`}
  </div>`;
}

function Accent() {
  const st = settings.value;
  const theme = resolvedTheme.value === 'light' ? 'light' : 'dark';
  const hue = Number.isInteger(st.accentHue) ? st.accentHue : null;
  const [drag, setDrag] = useState(null);   // hue while the slider moves; saved on release
  const shown = drag ?? hue;
  const tokenAcc = st.accentTokens?.[theme]?.acc || null;
  const swatch = shown == null ? null : (drag == null && tokenAcc) ? tokenAcc : accApprox(shown, theme);
  const setCustom = (on) => {
    if (on === (hue != null)) return;
    save({ accentHue: on ? HELM_HUE : null }, 'Accent');
  };
  const release = (e) => {
    const v = clamp(Math.round(+e.currentTarget.value), 0, 360);
    save({ accentHue: v }, 'Accent').finally(() => setDrag(null));
  };
  return html`
    <${Row} label="Accent" hint=${hue == null ? "Helm's steel blue." : 'Buttons, links and highlights use this hue.'}>
      <div class="seg" role="radiogroup" aria-label="Accent">
        <button role="radio" aria-checked=${hue == null} aria-pressed=${hue == null} onClick=${() => setCustom(false)}>Helm's own</button>
        <button role="radio" aria-checked=${hue != null} aria-pressed=${hue != null} onClick=${() => setCustom(true)}>Custom hue</button>
      </div>
    <//>
    ${hue != null && html`<${Row} label="Hue" hint=${`${shown}°`}>
      <div class="acc-hue">
        <span class="acc-swatch" style=${{ background: swatch }} title=${swatch} aria-hidden="true"></span>
        <input class="range acc-range" type="range" min="0" max="360" step="1" value=${shown} aria-label="Accent hue"
          onInput=${(e) => setDrag(+e.currentTarget.value)} onChange=${release} />
      </div>
    <//>`}`;
}

const SYNC_PROBLEM = { missing: 'No shared look yet', corrupt: 'Shared look file is unreadable', newer: 'Shared look is from a newer version', error: 'Sync error' };
function LookSyncRow() {
  const sync = lookNow()?.sync || null;
  const on = !!(settings.value.lookSync?.enabled ?? sync?.enabled ?? false);
  const rev = sync?.rev != null ? ` · rev ${sync.rev}` : '';
  let text, tone = '';
  if (!on || sync?.state === 'off') { text = 'Off · Helm keeps its own look'; }
  else if (!sync) { text = 'On · waiting for the sync status…'; }
  else if (sync.state === 'ok') {
    const who = sync.by ? `from ${appName(sync.by)}` : '';
    const when = isoAgo(sync.at);
    const last = who || when ? ` (last change ${[who, when].filter(Boolean).join(', ')})` : '';
    text = `On · in sync${last}${rev}`;
  } else {
    text = `On · ${SYNC_PROBLEM[sync.state] || 'Not in sync'}${sync.reason ? `: ${sync.reason}` : ''}${rev}`;
    tone = sync.state === 'missing' || sync.state === 'newer' ? 'warn' : 'danger';
  }
  const skipped = on && Array.isArray(sync?.skipped) ? sync.skipped.filter((x) => x && x.text) : [];
  const hint = html`Theme, accent, blur, dim and see-through follow Quartz and Mantle. Background mode stays per app.
    <span class=${cx('look-status', tone)} role="status">${text}</span>
    ${skipped.map((x, i) => html`<span key=${i} class="look-status warn">${x.text}</span>`)}`;
  return html`<${Row} label="Match the other apps" hint=${html`${hint}<${TopRowStatus} />`}>
    <button class="toggle" role="switch" aria-checked=${on} aria-label="Match the other apps" onClick=${() => save({ lookSync: { enabled: !on } }, 'Look sync')}></button>
  <//>`;
}

// lane helm-toprow-hints: are Mantle's top bar hints getting through? (main/toprow.js + ui/shell/toprow.js)
const TOP_KIND = { wash: 'the shared wallpaper under a wash', flat: 'one flat colour', cols: 'colours across the width', none: "nothing (Mantle reads the screen)" };
function TopRowStatus() {
  if (isPhone.value) return null;   // the phone has no window under Mantle's bar
  const st = toprowStatus.value;
  const lastSent = topRowLast.value;
  let text, tone = '';
  if (!st) text = 'Top bar hints: waiting for the status…';
  else if (st.state === 'connected') {
    const what = lastSent ? ` · telling it ${TOP_KIND[lastSent.kind] || lastSent.kind}${lastSent.alpha != null ? ` (${lastSent.alpha.toFixed(2)})` : ''}${lastSent.kind === 'none' ? `: ${lastSent.why}` : ''}` : '';
    text = `Top bar hints: Mantle connected${what}`;
  } else if (st.state === 'off') { text = `Top bar hints: off · ${st.reason || 'not started'}`; }
  else if (st.state === 'connecting') { text = 'Top bar hints: connecting to Mantle…'; }
  else { text = `Top bar hints: Mantle not running · ${st.reason || 'no connection'}`; tone = 'warn'; }
  return html`<span class=${cx('look-status', tone)} role="status" data-toprow=${st ? st.state : 'none'}>${text}</span>`;
}

function Theme() {
  const t = settings.value.theme || 'dark';
  const opts = [{ v: 'dark', l: 'Dark', i: 'moon' }, { v: 'light', l: 'Light', i: 'sun' }, { v: 'system', l: 'System', i: 'monitor' }];
  return html`<${Row} label="Theme">
    <div class="seg" role="radiogroup" aria-label="Theme">
      ${opts.map((o) => html`<button role="radio" aria-checked=${t === o.v} aria-pressed=${t === o.v} onClick=${() => save({ theme: o.v })}><${Icon} name=${o.i} size=${13} />${o.l}</button>`)}
    </div>
  <//>`;
}

function Defaults() {
  const d = settings.value.defaults || {};
  const models = useModels(rpc);
  const set = (k, v) => save({ defaults: { ...d, [k]: v } }, 'Defaults');
  const [cwd, setCwd] = useState(d.cwd || '');
  useEffect(() => setCwd(d.cwd || ''), [d.cwd]);
  return html`
    <${Row} label="Model">
      <select class="select" value=${d.model} onChange=${(e) => set('model', e.currentTarget.value)} aria-label="Default model">
        ${(models.length ? models : [{ value: d.model, displayName: d.model }]).map((m) => html`<option value=${m.value}>${m.displayName || m.value}</option>`)}
      </select>
    <//>
    <${Row} label="Effort">
      <div class="seg" role="radiogroup" aria-label="Default effort">
        ${EFFORTS.map((e) => html`<button role="radio" aria-checked=${d.effort === e.value} aria-pressed=${d.effort === e.value} onClick=${() => set('effort', e.value)}>${e.label}</button>`)}
      </div>
    <//>
    <${Row} label="Permissions">
      <select class="select" value=${d.permissionMode} onChange=${(e) => set('permissionMode', e.currentTarget.value)} aria-label="Default permission mode">
        ${MODES.map((m) => html`<option value=${m.value}>${m.label} · ${m.long}</option>`)}
      </select>
    <//>
    <${Row} label="Folder" hint="Used when no project is picked.">
      <input class="input mono" value=${cwd} spellcheck="false" aria-label="Default folder"
        onInput=${(e) => setCwd(e.currentTarget.value)} onBlur=${() => cwd !== (d.cwd || '') && set('cwd', cwd.trim())}
        onKeyDown=${(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
    <//>`;
}

function Notifications() {
  const n = settings.value.notifications || {};
  const rows = [
    { k: 'waiting', l: 'Needs you', h: 'A session asks a question or needs permission.' },
    { k: 'done', l: 'Finished', h: 'A turn completes while Helm is in the background.' },
    { k: 'error', l: 'Errors', h: 'A session stops with an error.' },
  ];
  const ctx = settings.value.notifyContextHandoff !== false;
  return [...rows.map((r) => html`<${Row} key=${r.k} label=${r.l} hint=${r.h}>
    <button class="toggle" role="switch" aria-checked=${!!n[r.k]} aria-label=${r.l}
      onClick=${() => save({ notifications: { ...n, [r.k]: !n[r.k] } }, 'Notifications')}></button>
  <//>`), html`<${Row} key="context" label="Agent context hand-off" hint=${`A running agent passes ${CONTEXT_HANDOFF_PCT}% of its context window, and again at the ${CONTEXT_CEILING_PCT}% ceiling. Also sent to your phone.`}>
    <button class="toggle" role="switch" aria-checked=${ctx} aria-label="Agent context hand-off"
      onClick=${() => save({ notifyContextHandoff: !ctx }, 'Notifications')}></button>
  <//>`];
}

// ---- quick-prompt hotkey: KeyboardEvent -> Electron accelerator ("Control+Alt+Space") ----
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '');
const MOD_CODES = /^(Control|Alt|Shift|Meta|OS)(Left|Right)?$/;
const NAMED_KEYS = {
  Space: 'Space', Tab: 'Tab', Enter: 'Enter', NumpadEnter: 'Enter', Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backquote: '`',
  NumpadAdd: 'numadd', NumpadSubtract: 'numsub', NumpadMultiply: 'nummult', NumpadDivide: 'numdiv', NumpadDecimal: 'numdec',
};
const heldMods = (e) => [e.ctrlKey && 'Control', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super'].filter(Boolean);
function keyName(code) {
  let m;
  if ((m = /^Key([A-Z])$/.exec(code))) return m[1];
  if ((m = /^Digit([0-9])$/.exec(code))) return m[1];
  if ((m = /^Numpad([0-9])$/.exec(code))) return `num${m[1]}`;
  if ((m = /^F([1-9]|1[0-9]|2[0-4])$/.exec(code))) return `F${m[1]}`;
  return NAMED_KEYS[code] || null;
}
// -> { accel } | { error } | null (only modifiers so far: keep listening)
function accelFromEvent(e) {
  if (MOD_CODES.test(e.code) || ['Control', 'Alt', 'Shift', 'Meta', 'OS'].includes(e.key)) return null;
  const key = keyName(e.code);
  if (!key) return { error: `${e.key || e.code} can't be used in a shortcut. Try a letter, number, F-key or Space.` };
  const mods = heldMods(e);
  if (!mods.length) return { error: 'Hold Ctrl, Alt, Shift or Win with the key.' };
  const fkey = /^F\d+$/.test(key);
  if (mods.length === 1 && mods[0] === 'Shift' && !fkey) return { error: 'Shift alone would block typing that key everywhere. Add Ctrl or Alt.' };
  return { accel: [...mods, key].join('+') };
}
const CAP_LABEL = { Control: 'Ctrl', CommandOrControl: isMac ? 'Cmd' : 'Ctrl', CmdOrCtrl: isMac ? 'Cmd' : 'Ctrl', Command: 'Cmd', Cmd: 'Cmd', Ctrl: 'Ctrl',
  Alt: isMac ? 'Option' : 'Alt', Option: 'Option', Super: isMac ? 'Cmd' : 'Win', Meta: isMac ? 'Cmd' : 'Win', Shift: 'Shift',
  numadd: 'Num +', numsub: 'Num -', nummult: 'Num *', numdiv: 'Num /', numdec: 'Num .' };
const capLabel = (k) => CAP_LABEL[k] || (/^num\d$/.test(k) ? `Num ${k.slice(3)}` : k);
const accelParts = (a) => String(a || '').split('+').filter(Boolean);

// One window-capture keydown hook registered at import time, i.e. before the shell's own global
// shortcuts, so a combo like Ctrl+K reaches the recorder instead of opening the palette.
let recorder = null;
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', (e) => {
    if (!recorder) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (!e.repeat) recorder(e);
  }, true);
}

function Hotkey() {
  const value = settings.value.quickPromptHotkey ?? '';
  const [rec, setRec] = useState(false);
  const [held, setHeld] = useState([]);
  const [err, setErr] = useState('');
  const recBtn = useRef(null);
  const stop = () => { recorder = null; setRec(false); setHeld([]); };
  useEffect(() => {
    if (!rec) return undefined;
    recorder = (e) => {
      if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) { stop(); setErr(''); return; }
      const r = accelFromEvent(e);
      if (!r) { setHeld(heldMods(e)); return; }
      if (r.error) { setErr(r.error); setHeld([]); return; }
      stop(); setErr('');
      if (r.accel !== value) save({ quickPromptHotkey: r.accel }, 'Shortcut');
    };
    const onUp = (e) => setHeld(heldMods(e));
    const onBlur = () => stop();
    addEventListener('keyup', onUp, true);
    addEventListener('blur', onBlur);
    return () => { recorder = null; removeEventListener('keyup', onUp, true); removeEventListener('blur', onBlur); };
  }, [rec, value]);
  const start = () => { setErr(''); setHeld([]); setRec(true); };
  const clear = () => { stop(); setErr(''); if (value) save({ quickPromptHotkey: '' }, 'Shortcut'); };
  const desktop = appInfo.value.platform === 'electron';
  const caps = rec ? held : accelParts(value);
  const hint = 'Opens a small prompt box from anywhere on your PC, so you can send a prompt to a new or running session without switching to Helm.';
  return html`<${Row} label="Quick prompt" hint=${desktop ? hint : `${hint} Applies to the desktop app.`}>
    <div class="hk-wrap">
    <div class="hk">
      <div class=${cx('hk-keys', rec && 'rec')} aria-live="polite">
        ${caps.length ? caps.map((k, i) => html`${i > 0 && html`<span class="hk-plus" aria-hidden="true">+</span>`}<kbd class="kbd">${capLabel(k)}</kbd>`)
          : html`<span class="hk-empty">${rec ? 'Press a shortcut…' : 'Off'}</span>`}
      </div>
      <div class="hk-actions">
        ${rec ? html`<button type="button" class="btn btn-sm" onClick=${() => { stop(); setErr(''); }}>Cancel</button>`
          : html`<button type="button" class="btn btn-sm" ref=${recBtn} onClick=${start}><${Icon} name="keyboard" size=${14} />${value ? 'Change' : 'Record'}</button>`}
        ${!rec && value && html`<button type="button" class="btn btn-ghost btn-sm" onClick=${clear}>Clear</button>`}
      </div>
    </div>
    ${(rec || err) && html`<p class=${cx('hk-msg', err && 'err')} role=${err ? 'alert' : undefined}>${err || 'Hold Ctrl, Alt, Shift or Win and press a key. Esc cancels.'}</p>`}
    </div>
  <//>`;
}

// Idle CLI close (main/engine/idle-reaper.js): how long an untouched session keeps its claude.exe running. Closing a
// session's tab releases its idle CLI whatever this says, Never included (lane tabrelease: an explicit action).
const IDLE_CHOICES = [[15, '15 min'], [30, '30 min'], [60, '60 min'], [0, 'Never']];
function IdleClose() {
  const v = settings.value.closeIdleAfterMin ?? 15;
  const [closed, setClosed] = useState(null);
  useEffect(() => {
    let on = true;
    rpc('sessions.idleStats').then((r) => { if (on && r) setClosed(r.closed); }).catch(() => {});
    return () => { on = false; };
  }, [v]);
  const choices = IDLE_CHOICES.some(([m]) => m === v) ? IDLE_CHOICES : [...IDLE_CHOICES, [v, `${v} min`]];
  const count = closed ? ` ${closed} idle session${closed === 1 ? '' : 's'} closed since Helm started.` : '';
  return html`
    <${Row} label="Close idle sessions after" hint=${html`Ends the Claude Code process of a session with nothing running, to free memory. It stays in the list and your next message picks it up where it left off.${count}<br />Closing a tab also closes its idle Claude process.`}>
      <select class="select" value=${String(v)} onChange=${(e) => save({ closeIdleAfterMin: Number(e.currentTarget.value) }, 'Idle sessions')} aria-label="Close idle sessions after">
        ${choices.map(([m, label]) => html`<option value=${String(m)}>${label}</option>`)}
      </select>
    <//>`;
}

// lane detach: "Keep sessions running through a restart" (main/engine/broker.js). Default off until the user tries it.
// The status line under it says what is true right now: the HELM_DETACH override, a broker stuck in a Windows job
// (then restarts still stop sessions), and how many Claude processes the broker holds.
function keepStatusText(st) {
  if (!st) return '';
  const out = [];
  if (st.override) out.push(`HELM_DETACH turns it ${st.override} for this run, whatever this switch says.`);
  if (st.safe === false && st.job && st.job.note) out.push(`Not working right now: ${st.job.note}. Restarts still stop sessions, with the restart note.`);
  else if (st.job && st.job.note && st.safe == null) out.push(`Windows job check: ${st.job.note}.`);
  for (const b of st.brokers || []) {
    if (!b.clis && !b.draining) continue;
    out.push(b.draining
      ? `An older broker (pid ${b.pid}) is finishing ${b.clis} session${b.clis === 1 ? '' : 's'} and then exits.`
      : `Broker pid ${b.pid}: ${b.clis} Claude process${b.clis === 1 ? '' : 'es'}${b.orphaned ? `, ${b.orphaned} waiting for Helm` : ''}.`);
  }
  if (st.on && st.kept) out.push(`A restart now would keep ${st.kept} session${st.kept === 1 ? '' : 's'} running.`);
  return out.join(' ');
}
function KeepThroughRestart() {
  const on = settings.value.keepSessionsThroughRestart === true;
  const [st, setSt] = useState(null);
  useEffect(() => {
    let live = true;
    const load = () => rpc('sessions.keepStatus').then((r) => { if (live) setSt(r); }).catch(() => {});
    load();
    const t = setInterval(load, 15000);
    return () => { live = false; clearInterval(t); };
  }, [on]);
  const status = keepStatusText(st);
  return html`
    <${Row} label="Keep sessions running through a restart" hint=${html`Only for a restart Helm does itself (Restart Helm, an update, or Restart when finished): Claude keeps working through it, the turn, its agents and background tasks carry on, and Helm re-attaches when it is back. Those sessions show "Kept running through the restart". Closing or quitting Helm any other way (Quit, ending it in Task Manager, a crash, Windows shutting down or signing out) stops everything, and those sessions show "Stopped when Helm closed". <code class="mono">!</code> commands stop either way.<br />If Helm cannot re-attach to one within a minute, that session shows what stopped and why, with Continue.${status ? html`<br /><span data-keep-status>${status}</span>` : null}`}>
      <button class="toggle" role="switch" aria-checked=${on} aria-label="Keep sessions running through a restart" onClick=${() => save({ keepSessionsThroughRestart: !on }, 'Keep sessions running')}></button>
    <//>`;
}

// Production guard (main/engine/prod-guard.js): the list mirrors what it guards: the repos in prod-guard.json + Railway actions.
function ProdGuard() {
  const on = settings.value.prodGuard !== false;
  return html`
    <${Row} label="Production guard" hint=${html`Claude stops and asks you first, even in Bypass permissions mode, before:<br />
      · <strong>git push</strong> to a protected repo or branch: the ones you list in <code class="mono">prod-guard.json</code> in Helm's data folder (none until you add them)<br />
      · <strong>railway up</strong>, <strong>redeploy</strong>, <strong>restart</strong> or <strong>down</strong>, on any project<br />
      Repos are matched by their GitHub remote. If your last message said to push or deploy, it goes through and the chat notes it. No answer in 30 minutes counts as Deny.`}>
      <button class="toggle" role="switch" aria-checked=${on} aria-label="Production guard" onClick=${() => save({ prodGuard: !on }, 'Production guard')}></button>
    <//>`;
}

function Startup() {
  const on = !!settings.value.launchAtLogin;
  const desktop = appInfo.value.platform === 'electron';
  return html`
    <${Row} label="Launch Helm at login" hint=${desktop ? 'Opens Helm when you sign in to this PC.' : 'Opens Helm when you sign in to the PC. Applies to the desktop app.'}>
      <button class="toggle" role="switch" aria-checked=${on} aria-label="Launch Helm at login" onClick=${() => save({ launchAtLogin: !on }, 'Startup')}></button>
    <//>
    <${Hotkey} />`;
}

function Snippets() {
  const list = settings.value.snippets || [];
  const [editing, setEditing] = useState(null);   // { id, name, text } | null
  const commit = () => {
    const e = editing; if (!e) return;
    if (!e.name.trim() || !e.text.trim()) { toast({ title: 'Snippet needs a name and text', kind: 'error', ms: 3000 }); return; }
    const next = e.id ? list.map((s) => (s.id === e.id ? { ...s, name: e.name.trim(), text: e.text } : s))
      : [...list, { id: `sn_${Date.now().toString(36)}`, name: e.name.trim(), text: e.text }];
    save({ snippets: next }, 'Snippets'); setEditing(null);
  };
  const remove = (id) => save({ snippets: list.filter((s) => s.id !== id) }, 'Snippets');
  return html`<div class="snips">
    ${list.map((s) => editing?.id === s.id ? null : html`<div key=${s.id} class="snip">
      <div class="snip-text"><span class="snip-name">${s.name}</span><span class="snip-body truncate">${s.text}</span></div>
      <button class="icon-btn sm" aria-label=${`Edit ${s.name}`} title="Edit" onClick=${() => setEditing({ ...s })}><${Icon} name="pencil" size=${14} /></button>
      <button class="icon-btn sm" aria-label=${`Delete ${s.name}`} title="Delete" onClick=${() => remove(s.id)}><${Icon} name="trash" size=${14} /></button>
    </div>`)}
    ${editing
      ? html`<div class="snip-edit">
          <input class="input" placeholder="Name" value=${editing.name} aria-label="Snippet name" autofocus
            onInput=${(e) => setEditing({ ...editing, name: e.currentTarget.value })} />
          <textarea class="textarea" rows="3" placeholder="Prompt text" value=${editing.text} aria-label="Snippet text"
            onInput=${(e) => setEditing({ ...editing, text: e.currentTarget.value })}
            onKeyDown=${(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) commit(); }}></textarea>
          <div class="snip-edit-actions"><button class="btn btn-ghost btn-sm" onClick=${() => setEditing(null)}>Cancel</button><button class="btn btn-primary btn-sm" onClick=${commit}>Save snippet</button></div>
        </div>`
      : html`<button class="btn btn-sm snip-add" onClick=${() => setEditing({ id: null, name: '', text: '' })}><${Icon} name="plus" size=${14} />Add snippet</button>`}
    ${!list.length && !editing && html`<p class="hint">Snippets are reusable prompts. Insert one from the command palette or the composer.</p>`}
  </div>`;
}

function Phone() {
  const p = settings.value.phone || {};
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    // the phone page is plain http (no navigator.clipboard): copyText falls back to execCommand
    if (await copyText(p.url)) { setCopied(true); setTimeout(() => setCopied(false), 1600); }
    else toast({ title: 'Copy failed', body: 'Select the link and copy it by hand.', kind: 'error' });
  };
  if (!p.url) {
    return html`<${Row} label="Phone access" hint=${p.enabled ? 'Waiting for Tailscale. The link appears once the PC is on your tailnet.' : 'Off.'}>
      <button class="toggle" role="switch" aria-checked=${!!p.enabled} aria-label="Phone access" onClick=${() => save({ phone: { ...p, enabled: !p.enabled } }, 'Phone')}></button>
    <//>
    <${PhoneHealth} />`;
  }
  return html`<div class="phone-card">
    <div class="phone-qr"><${QrCode} text=${p.url} size=${152} /></div>
    <div class="phone-info">
      <p class="phone-lede">Scan with your phone's camera, or open the link on any device on your tailnet. The link carries Helm's key: treat it like a password.</p>
      <div class="phone-url">
        <code class="mono truncate" title=${p.url}>${p.url}</code>
        <button class="btn btn-sm" onClick=${copy}><${Icon} name=${copied ? 'check' : 'copy'} size=${14} />${copied ? 'Copied' : 'Copy'}</button>
      </div>
      ${p.httpUrl && html`<p class="phone-fallback">Fallback if https is down: <code class="mono" title=${p.httpUrl}>${p.httpUrl.replace(/\?key=.*$/, '?key=…')}</code> <button type="button" class="btn btn-ghost btn-sm" onClick=${async () => { if (!(await copyText(p.httpUrl))) toast({ title: 'Copy failed', body: 'Select the link and copy it by hand.', kind: 'error' }); else toast({ title: 'Copied the plain http link', kind: 'info' }); }}><${Icon} name="copy" size=${14} />Copy</button></p>`}
      <div class="set-row inline">
        <div class="set-row-label"><span>Allow phone access</span></div>
        <button class="toggle" role="switch" aria-checked=${!!p.enabled} aria-label="Allow phone access" onClick=${() => save({ phone: { ...p, enabled: !p.enabled } }, 'Phone')}></button>
      </div>
    </div>
  </div>
  <${PhoneHealth} />`;
}

export function SettingsView() {
  if (!settings.value) return html`<section class="view"><div class="state-note"><span class="spinner"></span>Loading settings…</div></section>`;
  // Launch-at-login and the global hotkey only exist on the PC: the phone doesn't show them.
  return html`<section class="view view-settings" aria-label="Settings">
    <header class="view-head">
      <div><h1 class="view-title">Settings</h1><p class="view-sub">Helm ${appInfo.value.version || ''}</p></div>
    </header>
    <div class="view-scroll">
      <div class="set-wrap">
        <${Section} id="helm" title="Helm" desc="The version running now, updates, restarting and idle sessions."><${UpdateSettings} /><${KeepThroughRestart} /><${IdleClose} /><//>
        <${Section} id="account" title="Account" desc="How Helm's sessions reach Claude: Claude Code's own sign-in, or an API key you add here."><${AccountSettings} /><//>
        <${Section} id="appearance" title="Appearance"><${Backgrounds} /><${Accent} /><${Theme} /><${LookSyncRow} /><//>
        <${Section} id="defaults" title="New session defaults"><${Defaults} /><//>
        <${Section} id="guard" title="Safety" desc="Checks that apply to every session, whatever its permission mode."><${ProdGuard} /><//>
        ${!(isPhone.value && appInfo.value.platform !== 'electron') && html`<${Section} id="startup" title="Startup & shortcuts"><${Startup} /><//>`}
        <${Section} id="notify" title="Notifications"><${Notifications} /><//>
        <${Section} id="snippets" title="Snippets" desc="Saved prompts you reuse."><${Snippets} /><//>
        <${Section} id="claude" title="Claude Code" desc="Your CLAUDE.md files, memory notes and the live session setup. Saves go to the real files and keep a backup."><${ClaudeCodeSettings} /><//>
        <${Section} id="phone" title="Phone"><${Phone} /><//>
        <footer class="set-foot"><button class="btn btn-ghost btn-sm" data-act="whats-new" onClick=${() => import('./whats-new.js').then((m) => m.openWhatsNew())}>What's new in Helm</button></footer>
      </div>
    </div>
  </section>`;
}
