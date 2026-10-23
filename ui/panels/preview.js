// Owner: lane panels (E). Preview: a small browser for the dev servers a session starts.
// Electron → <webview partition="persist:helm-preview"> (host enables webviewTag); phone/web → sandboxed <iframe>.
import { html, Icon, cx, Empty } from './util.js';
import { activeSession, activeItems, appInfo } from '../lib/store.js';
import { inspectorWide } from './state.js';
import { useState, useEffect, useRef, useMemo } from 'preact/hooks';

const isElectron = () => typeof window !== 'undefined' && window.helmNative?.platform === 'electron';
const LOOPBACK = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/i;
const URL_RE = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d{2,5})?(?:\/[^\s'"`<>)\]}]*)?/gi;

function keyFor(sid) { return `helm.preview.url.${sid || '_'}`; }
function loadUrl(sid) { try { return localStorage.getItem(keyFor(sid)) || ''; } catch { return ''; } }
function saveUrl(sid, url) { try { localStorage.setItem(keyFor(sid), url); } catch {} }

export function normalizeUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  if (/^:\d+/.test(s)) s = 'localhost' + s;            // ":3000"
  if (/^\d{2,5}(\/|$)/.test(s)) s = 'localhost:' + s;   // "3000"
  // "localhost:3000" / "my-box:8080/x" look like a scheme to a naive test; host:port is not one.
  const hostPort = /^[^/:?#\s]+:\d{1,5}(?:[/?#]|$)/.test(s);
  if (hostPort || !/^[a-z][a-z0-9+.-]*:/i.test(s)) {
    const host = s.split(/[/:?#]/)[0];
    s = (LOOPBACK.test(host) || /^\d+\.\d+\.\d+\.\d+$/.test(host) || !host.includes('.') ? 'http://' : 'https://') + s;
  }
  try { return new URL(s).href; } catch { return s; }
}

// Loopback URLs mentioned in this session's recent items, newest first.
function textsOf(item) {
  const out = [];
  if (item.text) out.push(item.text);
  if (item.type === 'tool') {
    if (item.input) out.push(typeof item.input === 'string' ? item.input : JSON.stringify(item.input));
    if (item.result) out.push(typeof item.result === 'string' ? item.result : item.result.text || '');
  }
  return out;
}
function detectUrls(items) {
  const seen = new Map();
  const recent = items.slice(-300);
  for (let i = recent.length - 1; i >= 0 && seen.size < 6; i--) {
    for (const t of textsOf(recent[i])) {
      for (const m of String(t).matchAll(URL_RE)) {
        const u = m[0].replace(/[.,;:]+$/, '').replace(/\\n.*$/, '');
        let key; try { const p = new URL(u); key = p.origin + (p.pathname === '/' ? '' : p.pathname); } catch { continue; }
        if (!seen.has(key)) seen.set(key, u);
      }
    }
  }
  return [...seen.values()];
}
// ---- what may be framed ----
// Phone/web path: the <iframe> shares Helm's browser profile. A page on Helm's own origin with
// allow-same-origin could read Helm's sessionStorage token and drive Claude, so Helm refuses to frame
// its own server: same port on the same host, where localhost / 127.x / [::1] / 0.0.0.0 all count as
// one host while Helm itself is on loopback. Another port is another origin (own storage; helm_key is
// HttpOnly and the server refuses a WebSocket whose Origin isn't its own host:port), so a dev server
// on the same machine still previews. Helm's own origin never gets allow-same-origin regardless.
const LOOP_HOST = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\]|::1|0\.0\.0\.0)$/i;
function sameHost(a, b) {
  a = String(a || '').toLowerCase(); b = String(b || '').toLowerCase();
  return a === b || (LOOP_HOST.test(a) && LOOP_HOST.test(b));
}
const portOf = (x) => x.port || (x.protocol === 'https:' ? '443' : '80');
// → { ok: true, sameOrigin } | { ok: false, why: 'bad' | 'scheme' | 'self' }
export function frameVerdict(u, electron = false, loc = typeof location !== 'undefined' ? location : null) {
  let p;
  try { p = new URL(u); } catch { return { ok: false, why: 'bad' }; }
  if (p.protocol !== 'http:' && p.protocol !== 'https:') return { ok: false, why: 'scheme' };
  const sameOrigin = !!loc && p.origin === loc.origin;
  const helmItself = !!loc && sameHost(p.hostname, loc.hostname) && portOf(p) === portOf(loc);
  if (!electron && (sameOrigin || helmItself)) return { ok: false, why: 'self' };
  return { ok: true, sameOrigin };
}
const SANDBOX_BASE = 'allow-scripts allow-forms';
export function sandboxFor(verdict) { return verdict.sameOrigin ? SANDBOX_BASE : `${SANDBOX_BASE} allow-same-origin`; }

function chipLabel(u) { try { const p = new URL(u); return p.host + (p.pathname !== '/' ? p.pathname : ''); } catch { return u; } }

function openExternal(url) {
  if (!url) return;
  const n = window.helmNative;
  if (n?.openExternal) { n.openExternal(url); return; }
  window.open(url, '_blank', 'noopener');
}

// Electron webview, created imperatively so `partition` is set before the first navigation.
function WebviewFrame({ url, onNav, onLoading, onFail, apiRef }) {
  const host = useRef(null);
  const wv = useRef(null);
  useEffect(() => {
    const el = document.createElement('webview');
    el.setAttribute('partition', 'persist:helm-preview');
    el.setAttribute('src', url);
    el.className = 'pn-pv-frame';
    const nav = (e) => onNav(e.url);
    const start = () => onLoading(true);
    const stop = () => onLoading(false);
    const fail = (e) => { if (e.errorCode !== -3 && e.isMainFrame !== false) onFail(`${e.errorDescription || 'Load failed'} (${e.errorCode})`); };
    el.addEventListener('did-navigate', nav);
    el.addEventListener('did-navigate-in-page', (e) => { if (e.isMainFrame) nav(e); });
    el.addEventListener('did-start-loading', start);
    el.addEventListener('did-stop-loading', stop);
    el.addEventListener('did-fail-load', fail);
    host.current.appendChild(el);
    wv.current = el;
    apiRef.current = {
      back: () => { try { el.canGoBack() && el.goBack(); } catch {} },
      forward: () => { try { el.canGoForward() && el.goForward(); } catch {} },
      reload: () => { try { el.reload(); } catch {} },
    };
    return () => { el.remove(); wv.current = null; };
  }, []);
  useEffect(() => {
    const el = wv.current;
    if (!el) return;
    try { if (el.getURL && el.getURL() !== url) el.loadURL(url).catch?.(() => {}); } catch { el.setAttribute('src', url); }
  }, [url]);
  return html`<div class="pn-pv-host" ref=${host}></div>`;
}

export function PreviewPanel() {
  const s = activeSession.value;
  const sid = s?.id;
  const electron = isElectron();
  const [url, setUrl] = useState(() => loadUrl(sid));
  const [draft, setDraft] = useState(url);
  const [hist, setHist] = useState(() => ({ stack: url ? [url] : [], i: url ? 0 : -1 }));
  const [loading, setLoading] = useState(false);
  const [fail, setFail] = useState(null);
  const [nonce, setNonce] = useState(0);
  const api = useRef(null);

  // Switch sessions → that session's last URL.
  useEffect(() => {
    const u = loadUrl(sid);
    setUrl(u); setDraft(u); setFail(null); setBad(null); setEscaped(null); setLoading(false);
    setHist({ stack: u ? [u] : [], i: u ? 0 : -1 });
  }, [sid]);

  const picks = useMemo(() => detectUrls(activeItems.value).filter((p) => frameVerdict(normalizeUrl(p), electron).ok), [activeItems.value]);
  const [bad, setBad] = useState(null);         // a typed address that was rejected outright
  const [escaped, setEscaped] = useState(null); // a framed page that ended up on Helm's own origin

  const go = (raw) => {
    const u = normalizeUrl(raw);
    if (!u) return;
    const v = frameVerdict(u, electron);
    if (!v.ok && v.why !== 'self') { setBad(v.why === 'scheme' ? 'Only http:// and https:// addresses can be previewed.' : 'That is not a valid address.'); return; }
    setBad(null); setEscaped(null);
    setUrl(u); setDraft(u); setFail(null); saveUrl(sid, u);
    setHist((h) => { const stack = [...h.stack.slice(0, h.i + 1), u]; return { stack, i: stack.length - 1 }; });
    if (!electron && v.ok) setLoading(true);
  };
  const onNav = (u) => { setDraft(u); setUrl(u); saveUrl(sid, u); };
  const back = () => {
    if (electron) return api.current?.back();
    if (hist.i <= 0) return;
    const i = hist.i - 1; setHist({ ...hist, i }); setUrl(hist.stack[i]); setDraft(hist.stack[i]); saveUrl(sid, hist.stack[i]);
  };
  const forward = () => {
    if (electron) return api.current?.forward();
    if (hist.i >= hist.stack.length - 1) return;
    const i = hist.i + 1; setHist({ ...hist, i }); setUrl(hist.stack[i]); setDraft(hist.stack[i]); saveUrl(sid, hist.stack[i]);
  };
  const reload = () => { setFail(null); if (electron) api.current?.reload(); else { setLoading(true); setNonce(nonce + 1); } };

  // On the phone, "localhost" is the phone itself; offer the PC's address (Helm's host, the dev
  // server's port) instead.
  let remoteHint = null;
  if (url && !electron && appInfo.value.platform !== 'electron' && !LOOPBACK.test(location.hostname)) {
    try {
      const p = new URL(url);
      if (LOOPBACK.test(p.hostname)) { const alt = new URL(url); alt.hostname = location.hostname; remoteHint = alt.href; }
    } catch {}
  }
  const verdict = url ? frameVerdict(url, electron) : null;
  const blocked = !!url && (!verdict.ok || escaped === url);

  // Belt and braces for redirects: if the framed page's location is readable, it is on Helm's own
  // origin (cross-origin access throws), so tear the frame down.
  const onFrameLoad = (e) => {
    setLoading(false);
    try {
      const href = e.currentTarget.contentWindow?.location?.href;
      if (href && href !== 'about:blank') setEscaped(url);
    } catch {}
  };

  const canBack = electron ? true : hist.i > 0;
  const canFwd = electron ? true : hist.i < hist.stack.length - 1;

  return html`<div class="pn pn-preview">
    <form class="pn-pv-bar" onSubmit=${(e) => { e.preventDefault(); go(draft); }}>
      <button type="button" class="icon-btn" title="Back" aria-label="Back" disabled=${!url || !canBack} onClick=${back}><${Icon} name="arrow-left" size=${15} /></button>
      <button type="button" class="icon-btn" title="Forward" aria-label="Forward" disabled=${!url || !canFwd} onClick=${forward}><${Icon} name="arrow-right" size=${15} /></button>
      <button type="button" class="icon-btn" title=${loading ? "Loading…" : "Reload"} aria-label="Reload" disabled=${!url || blocked} onClick=${reload}>${loading ? html`<span class="spinner sm" aria-hidden="true"></span>` : html`<${Icon} name="refresh" size=${15} />`}</button>
      <input class="input pn-pv-url mono" type="text" inputmode="url" spellcheck="false" autocomplete="off" placeholder="localhost:3000"
        value=${draft} onInput=${(e) => setDraft(e.currentTarget.value)} onFocus=${(e) => e.currentTarget.select()}
        onKeyDown=${(e) => { if (e.key === 'Escape') { setDraft(url); e.currentTarget.blur(); } }} aria-label="Address" />
      <button type="button" class="icon-btn" title="Open in your browser" aria-label="Open in your browser" disabled=${!url} onClick=${() => openExternal(url)}><${Icon} name="external" size=${15} /></button>
      <button type="button" class="icon-btn pn-pv-wide" aria-pressed=${inspectorWide.value} title=${inspectorWide.value ? 'Narrow' : 'Pop out wide'} aria-label=${inspectorWide.value ? 'Narrow' : 'Pop out wide'}
        onClick=${() => { inspectorWide.value = !inspectorWide.value; }}><${Icon} name=${inspectorWide.value ? 'collapse' : 'expand'} size=${15} /></button>
    </form>
    ${picks.length > 0 && html`<div class="pn-pv-picks" aria-label="Servers this session mentioned">
      ${picks.map((p) => html`<button class=${cx('chip pn-pv-chip mono', normalizeUrl(p) === url && 'on')} aria-pressed=${normalizeUrl(p) === url} title=${p} onClick=${() => go(p)}>${chipLabel(p)}</button>`)}
    </div>`}
    ${bad && html`<div class="pn-note pn-note-warn pn-pv-note" role="alert">${bad}</div>`}
    ${remoteHint && html`<div class="pn-note pn-pv-note">
      On this device, <span class="mono">localhost</span> means the device itself, not your PC.
      <button class="pn-linkbtn" onClick=${() => go(remoteHint)}>Try ${chipLabel(remoteHint)}</button>
    </div>`}
    ${fail && !blocked && html`<div class="pn-note pn-note-warn pn-pv-note" role="alert">Couldn't load: ${fail}. Is the dev server running?</div>`}
    <div class="pn-pv-stage">
      ${!url ? html`<${Empty} icon="preview" title="Nothing open">
          ${picks.length ? 'Pick a server above, or type an address.' : 'Type an address, e.g. localhost:3000. Servers this session starts show up as quick picks.'}<//>`
        : blocked ? html`<div class="pn-state pn-pv-refused" role="status">
            <span class="pn-state-mark" aria-hidden="true"><${Icon} name="shield" size=${18} class="pn-state-icon" /></span>
            <div class="pn-state-title">${verdict.ok || verdict.why === 'self' ? "Helm won't preview its own address" : "This address can't be previewed"}</div>
            <div class="pn-state-body">${verdict.ok || verdict.why === 'self'
              ? html`<span class="mono">${chipLabel(url)}</span> is Helm itself. A page framed there could reach your Helm sign-in, so open it in a browser tab instead.`
              : 'Only http:// and https:// addresses can be previewed.'}</div>
            ${(verdict.ok || verdict.why === 'self') && html`<button class="btn sm pn-retry" onClick=${() => openExternal(url)}><${Icon} name="external" size=${14} />Open in a browser tab</button>`}
          </div>`
        : electron ? html`<${WebviewFrame} url=${url} apiRef=${api} onNav=${onNav} onLoading=${setLoading} onFail=${setFail} />`
        : html`<iframe key=${url + '#' + nonce} class="pn-pv-frame" src=${url} title="Preview"
            sandbox=${sandboxFor(verdict)} referrerpolicy="no-referrer"
            onLoad=${onFrameLoad}></iframe>`}
    </div>
    ${url && !electron && !blocked && html`<div class="pn-pv-foot">Blank page? Some sites refuse to load in a frame; open it in your browser instead.</div>`}
  </div>`;
}
