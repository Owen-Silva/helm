// Message actions. Owner: lane conversation (D).
// User messages: Copy, Edit & resend (inline editor → sessions.fork { id, itemId, text } → opens the new
// session), Fork from here (sessions.fork { id, itemId }), Rewind to here (the checkpoint whose itemId is
// this message → the Changes panel's rewind dialog). Assistant messages: Copy (markdown), Copy as plain
// text. Tool rows: copy the command / path. Desktop shows them on hover; the phone opens a menu on long-press.
import { signal } from '@preact/signals';
import { useState, useRef, useEffect } from 'preact/hooks';
import { html } from '../lib/html.js';
import { Icon } from '../lib/icons.js';
import { renderMarkdown } from '../lib/markdown.js';
import { sessions, forkSession, rpc, toast } from '../lib/store.js';
import { openSession } from '../shell/state.js';
import { RewindModal } from '../panels/changes.js';
import { saveDraft } from '../composer/util.js';
import { copyText } from './util.js';

export const editing = signal(null);    // `${sid}:${itemId}` open in the inline editor
export const actsOpen = signal(null);   // phone: `${sid}:${itemId}` whose long-press menu is open
const rewindTarget = signal(null);      // { session, cp } → RewindModal

// ---- copy helpers ----
// Markdown → readable plain text. DOMParser builds an inert document (no image loads, no scripts).
export function plainText(md) {
  const doc = new DOMParser().parseFromString(`<body>${renderMarkdown(md || '')}</body>`, 'text/html');
  const b = doc.body;
  b.querySelectorAll('button, .md-copy, .md-code-head').forEach((n) => n.remove());
  b.querySelectorAll('br').forEach((n) => n.replaceWith('\n'));
  b.querySelectorAll('ol').forEach((ol) => [...ol.children].forEach((li, i) => li.prepend(`${i + 1}. `)));
  b.querySelectorAll('ul > li').forEach((li) => li.prepend('- '));
  b.querySelectorAll('td, th').forEach((c) => { if (c.nextElementSibling) c.append('\t'); });
  b.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, pre, blockquote, tr, hr, div, table').forEach((n) => n.append('\n'));
  return b.textContent.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// What a tool row's copy button copies, or null.
export function toolCopy(item) {
  const i = item?.input || {};
  if (typeof i.command === 'string' && i.command) return { text: i.command, label: 'Copy command' };
  const path = i.file_path || i.notebook_path || (typeof i.path === 'string' && item.name !== 'Grep' && item.name !== 'Glob' ? i.path : '');
  if (path) return { text: path, label: 'Copy path' };
  if (typeof i.pattern === 'string' && i.pattern) return { text: i.pattern, label: 'Copy pattern' };
  if (typeof i.url === 'string' && i.url) return { text: i.url, label: 'Copy URL' };
  if (typeof i.query === 'string' && i.query) return { text: i.query, label: 'Copy query' };
  return null;
}

// Icon button; a truthy result from run() flips the icon to a check for a moment.
export function ActBtn({ icon, label, run, cls = '' }) {
  const [ok, setOk] = useState(false);
  const click = async (e) => {
    e.stopPropagation();
    const r = await run();
    if (r === true) { setOk(true); setTimeout(() => setOk(false), 1400); }
  };
  return html`<button type="button" class=${'cv-copy msg-act ' + cls + (ok ? ' is-done' : '')} title=${label} aria-label=${label} onClick=${click}>
    <${Icon} name=${ok ? 'check' : icon} size=${14} /></button>`;
}

// ---- user-message actions ----
async function doFork(sid, item) {
  try {
    const s = await forkSession(sid, item.id);
    if (item.text) saveDraft(s.id, item.text);   // like Claude Code's rewind: the prompt comes back to the input
    openSession(s.id);
    toast({ title: 'Forked', body: 'New session with the conversation up to this message; its text is back in the composer. The original is untouched.', ms: 4500 });
    return true;
  } catch (e) { toast({ title: 'Could not fork', error: e, kind: 'error' }); return false; }
}

async function doRewind(sid, item) {
  const session = sessions.value.find((s) => s.id === sid);
  if (!session) return false;
  let cps;
  try { cps = await rpc('sessions.checkpoints', { id: sid }); } catch (e) { toast({ title: 'Checkpoints unavailable', error: e, kind: 'error' }); return false; }
  const cp = (cps || []).find((c) => c.itemId === item.id);
  if (!cp) {
    toast({ title: 'No checkpoint at this message', body: 'Claude Code did not record one here. Fork from here branches the conversation instead.', kind: 'info', ms: 5000 });
    return false;
  }
  rewindTarget.value = { session, cp };
  return false;
}

export const USER_ACTS = [
  { id: 'copy', icon: 'copy', label: 'Copy', run: (sid, item) => copyText(item.text || '') },
  { id: 'edit', icon: 'pencil', label: 'Edit & resend', run: (sid, item) => { editing.value = `${sid}:${item.id}`; return false; } },
  { id: 'fork', icon: 'git-branch', label: 'Fork from here', run: doFork },
  { id: 'rewind', icon: 'rewind', label: 'Rewind to here', run: doRewind },
];

// Inline row (desktop hover). Only Copy for prompts that never reached Claude (queued / not sent) or read-only views.
export function UserActions({ item, sid, full }) {
  const acts = full ? USER_ACTS : USER_ACTS.slice(0, 1);
  return acts.map((a) => html`<${ActBtn} key=${a.id} icon=${a.icon} label=${a.label} cls=${a.id === 'copy' ? '' : 'msg-act-x'} run=${() => a.run(sid, item)} />`);
}

// Phone: long-press menu under the bubble.
export function ActsMenu({ item, sid }) {
  const ref = useRef(null);
  useEffect(() => {
    const down = (e) => { if (!ref.current?.contains(e.target)) actsOpen.value = null; };
    const key = (e) => { if (e.key === 'Escape') actsOpen.value = null; };
    const t = setTimeout(() => addEventListener('pointerdown', down, true), 0);
    addEventListener('keydown', key);
    return () => { clearTimeout(t); removeEventListener('pointerdown', down, true); removeEventListener('keydown', key); };
  }, []);
  return html`<div class="msg-acts-menu" role="menu" ref=${ref}>
    ${USER_ACTS.map((a) => html`<button key=${a.id} type="button" role="menuitem" class="msg-acts-item"
      onClick=${async (e) => { e.stopPropagation(); actsOpen.value = null; const ok = await a.run(sid, item); if (ok === true && a.id === 'copy') toast({ title: 'Copied', ms: 1600 }); }}>
      <${Icon} name=${a.icon} size=${16} /><span>${a.label}</span></button>`)}
  </div>`;
}

// Long-press (touch only): fires once after `ms` unless the finger moves or lifts. Once it has fired, lifting
// the finger must not also "click" whatever the menu just put under it (or the bubble), and the OS long-press
// context menu is suppressed.
export function useLongPress(onLong, ms = 450) {
  const t = useRef(0), start = useRef(null), fired = useRef(false);
  const clear = () => { clearTimeout(t.current); t.current = 0; };
  useEffect(() => clear, []);
  return {
    onTouchStart: (e) => {
      if (e.touches.length !== 1) return;
      const p = e.touches[0]; start.current = [p.clientX, p.clientY]; clear(); fired.current = false;
      t.current = setTimeout(() => { t.current = 0; fired.current = true; try { navigator.vibrate?.(8); } catch {} onLong(); }, ms);
    },
    onTouchMove: (e) => { const p = e.touches[0]; if (start.current && p && Math.hypot(p.clientX - start.current[0], p.clientY - start.current[1]) > 10) clear(); },
    onTouchEnd: (e) => { clear(); if (fired.current && e.cancelable) e.preventDefault(); },   // no synthesized click
    onTouchCancel: clear,
    onContextMenu: (e) => { if (fired.current || t.current) e.preventDefault(); },
  };
}

const autosize = (el) => { el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 320)}px`; };

// Inline editor for Edit & resend: Enter sends (Shift+Enter = newline), Esc cancels.
export function EditBox({ item, sid }) {
  const [text, setText] = useState(item.text || '');
  const [busy, setBusy] = useState(false);
  const ta = useRef(null);
  useEffect(() => { const el = ta.current; if (!el) return; el.focus({ preventScroll: true }); el.setSelectionRange(el.value.length, el.value.length); autosize(el); }, []);
  const cancel = () => { editing.value = null; };
  const go = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    try {
      const atts = (item.attachments || []).filter((a) => a.dataUrl || a.path);
      const s = await forkSession(sid, item.id, t, atts.length ? atts : undefined);
      editing.value = null;
      openSession(s.id);
      toast({ title: 'Sent in a new session', body: 'Forked just before this message, with your edit. The original session is untouched.', ms: 4500 });
    } catch (e) { setBusy(false); toast({ title: 'Could not resend', error: e, kind: 'error' }); }
  };
  return html`<div class="msg-edit">
    <textarea ref=${ta} class="msg-edit-ta" value=${text} rows="2" aria-label="Edit message" disabled=${busy}
      onInput=${(e) => { setText(e.currentTarget.value); autosize(e.currentTarget); }}
      onKeyDown=${(e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); }
        else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); go(); }
      }} />
    <div class="msg-edit-foot">
      <span class="msg-edit-note">Sends in a new session forked before this message</span>
      <button type="button" class="btn btn-ghost btn-sm" onClick=${cancel} disabled=${busy}>Cancel</button>
      <button type="button" class="btn btn-primary btn-sm" onClick=${go} disabled=${busy || !text.trim()}>${busy ? 'Sending…' : 'Send'}</button>
    </div>
  </div>`;
}

// Rewind dialog host: each ChatView renders one; only the view showing that session opens it.
export function ActionHost({ sid }) {
  const t = rewindTarget.value;
  if (!t || t.session.id !== sid) return null;
  return html`<${RewindModal} session=${t.session} cp=${t.cp} onClose=${() => { rewindTarget.value = null; }}
    onDone=${(msg) => { rewindTarget.value = null; toast({ title: 'Rewound', body: msg, ms: 4000 }); }} />`;
}
