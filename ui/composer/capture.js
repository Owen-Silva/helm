// Screenshot picker: choose a screen or window (live thumbnails), capture it, optionally drag a crop,
// attach. Desktop only: needs window.helmNative.captureSources (preload.js; mock-capture.js in ?mock=1).
// Attaches by dispatching 'helm:composer-attach' (composer/index.js adds it to the active composer).
// Owner: lane review-tools.
import { html } from '../lib/html.js';
import { useState, useRef, useEffect, useCallback } from 'preact/hooks';
import { Icon } from '../lib/icons.js';
import { Modal } from '../panels/util.js';

const POLL_MS = 2500;
const HIDE_KEY = 'helm.capture.hideSelf';
const MIN_DRAG = 4;   // css px; a smaller drag is a click and clears the selection

const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
// ipcRenderer.invoke wraps the host's message: "Error invoking remote method 'helm:capture': Error: <reason>"
const reason = (e) => String(e?.message || e || 'Unknown error').replace(/^Error invoking remote method '[^']+':\s*/, '').replace(/^(Error:\s*)+/, '');

export const canCapture = () => typeof window !== 'undefined' && typeof window.helmNative?.captureSources === 'function';

function SourceCard({ s, onPick, busy, locked }) {
  return html`<button type="button" class=${'cap-card' + (busy ? ' is-busy' : '')} onClick=${() => onPick(s)} disabled=${!!locked}
    title=${s.self ? `${s.name} (this Helm window)` : s.name} aria-label=${`Capture ${s.kind} ${s.name}`}>
    <span class="cap-thumb">
      ${s.thumb ? html`<img src=${s.thumb} alt="" draggable="false" />` : html`<span class="cap-thumb-none">No preview</span>`}
    </span>
    <span class="cap-card-meta">
      ${s.icon ? html`<img class="cap-app-icon" src=${s.icon} alt="" />` : html`<${Icon} name=${s.kind === 'screen' ? 'monitor' : 'preview'} size=${14} class="cap-app-icon" />`}
      <span class="cap-card-name">${s.name}</span>
      ${s.self && html`<span class="cap-self">Helm</span>`}
    </span>
  </button>`;
}

function Group({ title, list, onPick, busyId, locked }) {
  if (!list.length) return null;
  return html`<section class="cap-group">
    <div class="cap-group-head">${title}<span class="cap-count">${list.length}</span></div>
    <div class="cap-grid">${list.map((s) => html`<${SourceCard} key=${s.id} s=${s} onPick=${onPick} busy=${busyId === s.id} locked=${locked} />`)}</div>
  </section>`;
}

// Crop step: the image fitted in the stage; drag a rectangle (stored as 0..1 fractions of the image).
function CropStage({ shot, sel, setSel }) {
  const frame = useRef(null);
  const drag = useRef(null);
  const ratio = shot.width / shot.height;

  const at = (e) => {
    const r = frame.current.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)), r };
  };
  const down = (e) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    e.preventDefault();
    const p = at(e);
    drag.current = { x0: p.x, y0: p.y, cx: e.clientX, cy: e.clientY, moved: false };
    try { frame.current.setPointerCapture(e.pointerId); } catch {}
  };
  const move = (e) => {
    const d = drag.current;
    if (!d) return;
    if (!d.moved && Math.abs(e.clientX - d.cx) < MIN_DRAG && Math.abs(e.clientY - d.cy) < MIN_DRAG) return;
    d.moved = true;
    const p = at(e);
    setSel({ x: Math.min(d.x0, p.x), y: Math.min(d.y0, p.y), w: Math.abs(p.x - d.x0), h: Math.abs(p.y - d.y0) });
  };
  const up = (e) => {
    const d = drag.current;
    drag.current = null;
    try { frame.current.releasePointerCapture(e.pointerId); } catch {}
    if (d && !d.moved) setSel(null);
  };
  const px = sel && { w: Math.max(1, Math.round(sel.w * shot.width)), h: Math.max(1, Math.round(sel.h * shot.height)) };
  const pct = (v) => `${(v * 100).toFixed(3)}%`;

  return html`<div class="cap-stage">
    <div class=${'cap-frame' + (sel ? ' has-sel' : '')} ref=${frame}
      style=${{ aspectRatio: `${shot.width} / ${shot.height}`, width: `min(100cqw, calc(100cqh * ${ratio.toFixed(5)}))` }}
      onPointerDown=${down} onPointerMove=${move} onPointerUp=${up} onPointerCancel=${up}
      role="application" aria-label="Drag to select the part of the screenshot to attach">
      <img src=${shot.attachment.dataUrl} alt=${shot.name} draggable="false" />
      ${sel && html`<div class="cap-sel" style=${{ left: pct(sel.x), top: pct(sel.y), width: pct(sel.w), height: pct(sel.h) }}>
        <span class=${'cap-sel-size' + (sel.y < 0.06 ? ' is-inside' : '')}>${px.w} × ${px.h}</span>
      </div>`}
    </div>
  </div>`;
}

export function CapturePicker({ onClose }) {
  const n = window.helmNative;
  const [step, setStep] = useState('pick');            // pick | capturing | crop | attaching
  const [sources, setSources] = useState(null);         // null = loading
  const [listErr, setListErr] = useState(null);
  const [err, setErr] = useState(null);                 // capture / crop / attach failure
  const [busyId, setBusyId] = useState(null);
  const [shot, setShot] = useState(null);
  const [sel, setSel] = useState(null);
  const [hideSelf, setHideSelf] = useState(() => lsGet(HIDE_KEY) !== '0');
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const load = useCallback(async () => {
    try {
      const list = await n.captureSources();
      if (!alive.current) return;
      setSources(Array.isArray(list) ? list : []);
      setListErr(null);
    } catch (e) {
      if (alive.current) setListErr(reason(e));
    }
  }, []);

  // live thumbnails: poll only while the picker step is showing and the page is visible
  useEffect(() => {
    if (step !== 'pick') return;
    let t = null;
    const tick = () => { if (document.visibilityState === 'visible') load(); };
    tick();
    t = setInterval(tick, POLL_MS);
    const vis = () => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', vis);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', vis); };
  }, [step]);

  const pick = async (s) => {
    setErr(null);
    setBusyId(s.id);
    setStep('capturing');
    try {
      const r = await n.capture(s.id, { hideSelf });
      if (!alive.current) return;
      if (!r?.attachment?.dataUrl) throw new Error('The capture returned no image');
      setShot(r);
      setSel(null);
      setStep('crop');
    } catch (e) {
      if (!alive.current) return;
      setErr(`Could not capture "${s.name}": ${reason(e)}`);
      setStep('pick');
    } finally {
      if (alive.current) setBusyId(null);
    }
  };

  const attach = async () => {
    setErr(null);
    let att = shot.attachment;
    if (sel && sel.w > 0 && sel.h > 0) {
      setStep('attaching');
      try {
        const r = await n.captureCrop(shot.token, {
          x: Math.round(sel.x * shot.width), y: Math.round(sel.y * shot.height),
          width: Math.max(1, Math.round(sel.w * shot.width)), height: Math.max(1, Math.round(sel.h * shot.height)),
        });
        if (!r?.attachment?.dataUrl) throw new Error('The crop returned no image');
        att = r.attachment;
      } catch (e) {
        if (alive.current) { setErr(`Could not crop the screenshot: ${reason(e)}`); setStep('crop'); }
        return;
      }
    }
    window.dispatchEvent(new CustomEvent('helm:composer-attach', { detail: { attachments: [att] } }));
    onClose();
  };

  const toggleHide = (e) => { const v = !!e.currentTarget.checked; setHideSelf(v); lsSet(HIDE_KEY, v ? '1' : '0'); };

  const screens = (sources || []).filter((s) => s.kind === 'screen');
  const windows = (sources || []).filter((s) => s.kind !== 'screen');
  const inCrop = step === 'crop' || step === 'attaching';

  const footer = inCrop
    ? html`<div class="cap-foot">
        <span class="cap-foot-info">${sel
          ? html`<${Icon} name="crop" size=${14} /> Selection ${Math.round(sel.w * shot.width)} × ${Math.round(sel.h * shot.height)} px`
          : html`Whole ${shot.width} × ${shot.height} px · drag on the image to crop`}</span>
        <button type="button" class="btn btn-ghost sm" onClick=${() => { setStep('pick'); setShot(null); setSel(null); setErr(null); }} disabled=${step === 'attaching'}>
          <${Icon} name="arrow-left" size=${14} /> Back</button>
        <button type="button" class="btn btn-ghost sm" onClick=${() => setSel(null)} disabled=${!sel || step === 'attaching'}>Clear selection</button>
        <button type="button" class="btn btn-primary sm" onClick=${attach} disabled=${step === 'attaching'}>${step === 'attaching' ? 'Attaching…' : sel ? 'Attach selection' : 'Attach'}</button>
      </div>`
    : html`<div class="cap-foot">
        <label class="cap-check"><input type="checkbox" checked=${hideSelf} onChange=${toggleHide} /> Hide Helm while capturing</label>
        <span class="cap-foot-info">${step === 'capturing' ? 'Capturing…' : 'Pick a screen or window'}</span>
        <button type="button" class="btn btn-ghost sm" onClick=${onClose}>Cancel</button>
      </div>`;

  return html`<${Modal} title=${inCrop ? `Crop · ${shot.name}` : 'Attach a screenshot'} onClose=${onClose} wide footer=${footer}>
    <div class=${'cap' + (inCrop ? ' is-crop' : '') + (step === 'capturing' ? ' is-capturing' : '')} aria-busy=${step === 'capturing' || step === 'attaching' ? 'true' : 'false'}>
      ${err && html`<div class="cap-error" role="alert"><${Icon} name="alert" size=${14} /><span>${err}</span></div>`}
      ${inCrop
        ? html`<${CropStage} shot=${shot} sel=${sel} setSel=${setSel} />`
        : html`<div class="cap-pick">
            ${listErr && html`<div class="cap-error" role="alert"><${Icon} name="alert" size=${14} /><span>Could not list screens and windows: ${listErr}</span>
              <button type="button" class="btn btn-ghost sm" onClick=${load}>Retry</button></div>`}
            ${sources == null && !listErr && html`<div class="cap-empty">Looking for screens and windows…</div>`}
            ${sources && !sources.length && html`<div class="cap-empty">No screens or windows were reported by the system, so there is nothing to capture.</div>`}
            <${Group} title="Screens" list=${screens} onPick=${pick} busyId=${busyId} locked=${step !== 'pick'} />
            <${Group} title="Windows" list=${windows} onPick=${pick} busyId=${busyId} locked=${step !== 'pick'} />
          </div>`}
    </div>
  <//>`;
}
