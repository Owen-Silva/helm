// Quick-prompt box: the small always-on-top window the global hotkey toggles (main/quick.js).
// Type, pick where it goes (an open session, or a new session in a project), Enter sends,
// Esc hides. Talks to the host over the same WebSocket as the main window (quick.* methods).
// Owner: lane host (B).
import { h, render } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { signal } from '@preact/signals';
import htm from 'htm';
import { rpc, on } from '/lib/transport.js';

const html = htm.bind(h);

const targets = signal([]);
const targetId = signal(null);
const status = signal(null);   // { kind: 'ok'|'err'|'busy', text, sessionId? }
const sending = signal(false);
let hideTimer = null;

function applyTheme(pref) {
  const dark = pref === 'light' ? false : pref === 'dark' ? true : matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

async function refreshTargets() {
  try {
    const r = await rpc('quick.targets', {});
    targets.value = r.targets || [];
    if (!targetId.value || !targets.value.some((t) => t.id === targetId.value)) targetId.value = r.defaultId || (targets.value[0] || {}).id || null;
  } catch (e) {
    status.value = { kind: 'err', text: `Could not load sessions: ${e.message}` };
  }
}

const hide = () => rpc('quick.hide', {}).catch(() => {});

async function send(textarea) {
  const text = textarea.value.trim();
  if (!text || sending.value) return;
  if (!targetId.value) { status.value = { kind: 'err', text: 'Pick where to send it' }; return; }
  sending.value = true;
  status.value = { kind: 'busy', text: 'Sending…' };
  try {
    const r = await rpc('quick.send', { target: targetId.value, text });
    textarea.value = '';
    status.value = { kind: 'ok', text: `Sent to ${r.title}${r.queued ? ' (queued after the current turn)' : ''}`, sessionId: r.sessionId };
    if (r.sessionId) targetId.value = 'session:' + r.sessionId;
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, 1400);
  } catch (e) {
    status.value = { kind: 'err', text: e.message || String(e) };
  } finally {
    sending.value = false;
  }
}

function Quick() {
  const ta = useRef(null);

  useEffect(() => {
    const focus = () => { clearTimeout(hideTimer); refreshTargets(); ta.current && ta.current.focus(); };
    window.addEventListener('focus', focus);
    focus();
    rpc('settings.get', {}).then((s) => applyTheme(s && s.theme)).catch(() => {});
    const offSettings = on('settings.updated', (s) => s && applyTheme(s.theme));
    const offSessions = on('session.created', () => refreshTargets());
    return () => { window.removeEventListener('focus', focus); offSettings(); offSessions(); };
  }, []);

  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); hide(); return; }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(e.currentTarget); }
  };
  const onWindowKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); hide(); } };

  const st = status.value;
  const list = targets.value;
  return html`
    <div class="qp" onKeyDown=${onWindowKey}>
      <div class="qp-head">
        <span class="qp-mark">Helm</span>
        <select class="select qp-target" aria-label="Send to" value=${targetId.value || ''}
          onChange=${(e) => { targetId.value = e.currentTarget.value; ta.current && ta.current.focus(); }}>
          ${list.some((t) => t.kind === 'session') && html`<optgroup label="Open sessions">
            ${list.filter((t) => t.kind === 'session').map((t) => html`<option value=${t.id}>${t.label}${t.detail ? `  ·  ${t.detail}` : ''}</option>`)}
          </optgroup>`}
          ${list.some((t) => t.kind === 'project') && html`<optgroup label="New session">
            ${list.filter((t) => t.kind === 'project').map((t) => html`<option value=${t.id}>${t.label}</option>`)}
          </optgroup>`}
        </select>
      </div>
      <textarea ref=${ta} class="textarea qp-input" rows="3" placeholder="Ask Claude Code…" aria-label="Prompt"
        spellcheck="true" disabled=${sending.value} onKeyDown=${onKey}></textarea>
      <div class="qp-foot">
        <span class=${'qp-status' + (st ? ' ' + st.kind : '')} role="status">
          ${st ? st.text : ''}
          ${st && st.kind === 'ok' && st.sessionId ? html` · <button class="qp-open" onClick=${() => rpc('quick.open', { sessionId: st.sessionId }).catch(() => {})}>Open in Helm</button>` : ''}
        </span>
        <span class="qp-keys"><span class="kbd">Enter</span> send <span class="kbd">Shift+Enter</span> new line <span class="kbd">Esc</span> close</span>
      </div>
    </div>`;
}

render(html`<${Quick} />`, document.getElementById('quick'));
