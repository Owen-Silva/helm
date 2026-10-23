// Session lifecycle actions shared by the sidebar row menu, the session header menu and the palette:
// archive / unarchive, close (stop the CLI), delete from Helm (with a confirm), copy link / ids.
// Owner: lane sessions-org.
import { signal } from '@preact/signals';
import { confirmAgentsThen } from '../lib/stop.js'; // lane steer
import { html } from '../lib/html.js';
import { Icon } from '../lib/icons.js';
import { leaveRefs } from '../lib/motion.js';
import { rpc, toast, sessions, applySessionReply, removeSessionLocal, appInfo, createSession } from '../lib/store.js';
import { Modal, cx } from './util.js';
import { isPhone, openSession } from './state.js';
import { openTabAfter } from './tabs.js';
import { saveDraft } from '../composer/util.js';
import { displayStatus } from '../lib/session-status.js';
import { sessionToMarkdown, exportFileName } from '../lib/export-md.js';

// helm://session/<id> opens Helm on that session (main/launch.js parses it; Helm.exe registers the scheme).
export const sessionLink = (id) => `helm://session/${encodeURIComponent(id)}`;

export function copyText(text, what) {
  const p = navigator.clipboard?.writeText(text);
  if (!p) { toast({ title: 'Copy failed', body: 'The clipboard is not available here.', kind: 'error' }); return; }
  p.then(() => toast({ title: `${what} copied`, body: text, ms: 2500 }), (e) => toast({ title: 'Copy failed', error: e, kind: 'error' }));
}

const plural = (n, one, many = `${one}s`) => (n === 1 ? one : many);

// ---- Export / copy as Markdown (lane git-export) ----
// The whole transcript, not just the loaded window: page back with sessions.history until hasMore is false.
async function fullTranscript(id) {
  const first = await rpc('sessions.history', { id, limit: 2000 });
  let items = (first && first.items) || [];
  let more = !!(first && first.hasMore);
  for (let guard = 0; more && items.length && guard < 200; guard++) {
    const r = await rpc('sessions.history', { id, before: items[0].id, limit: 2000 });
    const seen = new Set(items.map((i) => i.id));
    const fresh = ((r && r.items) || []).filter((i) => !seen.has(i.id));
    if (!fresh.length) break;
    items = [...fresh, ...items];
    more = !!r.hasMore;
  }
  return items;
}

export async function sessionMarkdown(s) {
  return sessionToMarkdown(s, await fullTranscript(s.id));
}

// Desktop: native Save dialog through the host (files.saveText). Phone / browser: a Blob download.
export async function exportSessionMarkdown(s) {
  let md;
  try { md = await sessionMarkdown(s); }
  catch (e) { toast({ title: 'Export failed', body: 'Could not read the conversation', error: e, kind: 'error' }); return null; }
  const name = exportFileName(s);
  if (appInfo.value.platform === 'electron') {
    try {
      const r = await rpc('files.saveText', { suggestedName: name, text: md });
      if (r && r.path) toast({ title: 'Exported as Markdown', body: r.path, ms: 3500 });
      return r && r.path ? md : null;
    } catch (e) { toast({ title: 'Export failed', error: e, kind: 'error' }); return null; }
  }
  try {
    const url = URL.createObjectURL(new Blob([md], { type: 'text/markdown;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url; a.download = name; a.style.display = 'none';
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    toast({ title: 'Exported as Markdown', body: name, ms: 3000 });
    return md;
  } catch (e) { toast({ title: 'Export failed', error: e, kind: 'error' }); return null; }
}

export async function copySessionMarkdown(s) {
  let md;
  try { md = await sessionMarkdown(s); }
  catch (e) { toast({ title: 'Copy failed', body: 'Could not read the conversation', error: e, kind: 'error' }); return null; }
  const p = navigator.clipboard?.writeText(md);
  if (!p) { toast({ title: 'Copy failed', body: 'The clipboard is not available here.', kind: 'error' }); return null; }
  try {
    await p;
    const n = md.split('\n').length;
    toast({ title: 'Markdown copied', body: `${n.toLocaleString()} lines from “${s.title || 'New session'}”`, ms: 2500 });
    return md;
  } catch (e) { toast({ title: 'Copy failed', error: e, kind: 'error' }); return null; }
}

export async function archiveSessions(ids, archived = true) {
  const list = [...new Set(ids)];
  if (!list.length) return 0;
  // Apply each reply as it lands: session.updated trails the reply by up to ~1.5 s.
  const res = await Promise.allSettled(list.map((id) => rpc('sessions.archive', { id, archived }).then((s) => { applySessionReply(s); return s; })));
  const failed = res.filter((r) => r.status === 'rejected');
  const ok = list.length - failed.length;
  if (ok) {
    toast(archived
      ? { title: ok === 1 ? 'Session archived' : `${ok} sessions archived`, body: 'The CLI is stopped. Find it under Archived at the end of the list.', ms: 3500 }
      : { title: ok === 1 ? 'Session restored' : `${ok} sessions restored`, body: 'Back in the list. It resumes when you send a message.', ms: 3500 });
  }
  if (failed.length) toast({ title: `Could not ${archived ? 'archive' : 'restore'} ${failed.length} ${plural(failed.length, 'session')}`, error: failed[0].reason, kind: 'error' });
  return ok;
}

export function closeSession(id) {
  return rpc('sessions.close', { id }).then(
    () => toast({ title: 'Session closed', body: 'The CLI is stopped. It stays in the list and resumes when you send a message.', ms: 3200 }),
    (e) => toast({ title: 'Could not close the session', error: e, kind: 'error' }),
  );
}

// Delete from Helm asks first: { ids } while the dialog is open.
export const deleteAsk = signal(null);
export function askDelete(ids) { deleteAsk.value = { ids: [...new Set(ids)] }; }

export function DeleteDialog() {
  const ask = deleteAsk.value;
  if (!ask) return null;
  const list = ask.ids.map((id) => sessions.value.find((s) => s.id === id)).filter(Boolean);
  const close = () => { deleteAsk.value = null; };
  if (!list.length) { queueMicrotask(close); return null; }
  const n = list.length;
  const live = list.some((s) => s.status === 'working' || s.status === 'waiting');
  const go = async () => {
    close();
    const res = await Promise.allSettled(list.map((s) => rpc('sessions.delete', { id: s.id }).then((r) => { removeSessionLocal(s.id); return r; })));
    const failed = res.filter((r) => r.status === 'rejected');
    const ok = n - failed.length;
    if (ok) toast({ title: ok === 1 ? 'Removed from Helm' : `${ok} sessions removed from Helm`, body: 'The Claude Code transcript is untouched: resume it from History any time.', ms: 4000 });
    if (failed.length) toast({ title: `Could not delete ${failed.length} ${plural(failed.length, 'session')}`, error: failed[0].reason, kind: 'error' });
  };
  return html`<${Modal} title=${n === 1 ? 'Delete from Helm?' : `Delete ${n} sessions from Helm?`} onClose=${close} width=${440} class="confirm-modal"
    footer=${html`<button class="btn btn-ghost" onClick=${close}>Cancel</button>
      <button class="btn btn-danger" data-act="confirm-delete" onClick=${go}><${Icon} name="trash" size=${15} />Delete from Helm</button>`}>
    ${n === 1
      ? html`<p class="confirm-lead"><strong class="truncate">${list[0].title || 'New session'}</strong> leaves Helm's session list.</p>`
      : html`<ul class="confirm-list">${list.slice(0, 5).map((s) => html`<li class="truncate">${s.title || 'New session'}</li>`)}${n > 5 && html`<li class="confirm-more">and ${n - 5} more</li>`}</ul>`}
    <p class="confirm-note">Only Helm's record is removed. Claude Code's own transcript stays on disk, so ${n === 1 ? 'this conversation' : 'these conversations'} can still be found in History and resumed.${live ? ' Running work is stopped first.' : ''}</p>
  <//>`;
}

// ---- Fresh start with handoff (lane handoff, 2026-10-09) ----
// The user picks it (session menu, sidebar row menu, Ctrl+K); nothing here runs on its own. The session writes its own
// handoff (main/engine/handoff.js sessions.handoff: one visible prompt, the turn's final text back), then a NEW
// session opens in the same folder with the same model / effort / permission mode, as a tab right after the old one,
// with the handoff PREFILLED in its message box (the composer's per-session draft), not sent. The old tab stays.
// handoffs: { [sessionId]: { phase: 'writing' | 'opening' | 'error', title, error?, text? } } drives HandoffStatus.
export const handoffs = signal({});
const setHandoff = (id, v) => {
  const next = { ...handoffs.value };
  if (v) next[id] = v; else delete next[id];
  handoffs.value = next;
};

// Why the action is off for this session right now ('' = available). Shown as the item's tooltip.
export function handoffBlocked(s) {
  if (!s) return 'Open a session first';
  const h = handoffs.value[s.id];
  if (h && h.phase !== 'error') return 'A handoff is already being written for this session';
  if (s.status === 'working') return 'Claude is working in this session. Wait for the turn to finish (or stop it), then try again.';
  if (s.status === 'waiting') return 'This session is waiting on you. Answer it first, then try again.';
  if (displayStatus(s) === 'working') return 'Agents are still running in this session. Wait for them to finish, then try again.';
  return '';
}
export const HANDOFF_HINT = 'Ask this session for a short handoff, then open a fresh session with it in the message box';

export const handoffDraft = (title, text) => `Handoff from “${title || 'New session'}”:\n\n${text}`;

const HANDOFF_FAIL = {
  interrupted: 'The handoff turn was stopped before it finished.',
  empty: 'Claude replied without any handoff text.',
  disconnected: 'The connection to Helm dropped while waiting. The reply still lands in the session.',
};

export async function freshStartWithHandoff(s) {
  const why = handoffBlocked(s);
  if (why) { toast({ title: 'Fresh start with handoff is not available yet', body: why, ms: 4500 }); return null; }
  const title = s.title || 'New session';
  setHandoff(s.id, { phase: 'writing', title });
  let r;
  try {
    r = await rpc('sessions.handoff', { id: s.id });
  } catch (e) {
    if (e.code === 'cancelled') { setHandoff(s.id, null); toast({ title: 'Handoff cancelled', body: `“${title}” was stopped. Nothing new was opened.`, ms: 3000 }); return null; }
    setHandoff(s.id, { phase: 'error', title, error: HANDOFF_FAIL[e.code] || e.message || 'Unknown error' });
    return null;
  }
  setHandoff(s.id, { phase: 'opening', title, text: r.text });
  const from = r.from || {};
  try {
    const ns = await createSession({ cwd: from.cwd || s.cwd, model: from.model || s.model || undefined, effort: from.effort || s.effort || undefined, permissionMode: from.permissionMode || s.permissionMode || undefined });
    // Saved in the same task as the selection: the composer reads a session's draft in its [id] effect, which runs
    // after the next paint, so the box opens holding the handoff (unsent).
    saveDraft(ns.id, handoffDraft(from.title || title, r.text));
    if (!isPhone.value) openTabAfter(ns.id, s.id);
    openSession(ns.id);
    setHandoff(s.id, null);
    toast({ title: 'Fresh session ready', body: 'The handoff is in the message box. Review it, then press Enter to send.', ms: 4500 });
    return ns;
  } catch (e) {
    setHandoff(s.id, { phase: 'error', title, text: r.text, error: `The handoff was written, but the new session did not open: ${e.message}` });
    return null;
  }
}

// lane steer: a Cancel that would stop running agents asks first and names them (ui/lib/stop.js).
export function cancelHandoff(id) {
  confirmAgentsThen((all) => rpc('sessions.handoffCancel', { id, ...(all ? { stopAgents: true } : {}) }), { title: 'Cancel the handoff?', verb: 'Stop all and cancel' })
    .catch((e) => toast({ title: 'Could not cancel the handoff', error: e, kind: 'error' }));
}

// Progress ("Writing handoff…" + Cancel) and failures (with Retry / Copy handoff), one card per session.
// The stack stays mounted (empty) so the last card still has somewhere to leave from (lib/motion.js).
const handoffLeave = leaveRefs('drop', 's');
export function HandoffStatus() {
  const list = Object.entries(handoffs.value);
  return html`<div class="handoff-stack" role="status" aria-live="polite">
    ${list.map(([id, h]) => {
      const s = sessions.value.find((x) => x.id === id);
      const err = h.phase === 'error';
      return html`<div key=${id} ref=${handoffLeave(id)} class=${cx('handoff-card', err && 'k-error')} data-handoff=${h.phase}>
        <span class="handoff-icon"><${Icon} name=${err ? 'alert' : 'file-plus'} size=${16} /></span>
        <div class="handoff-text">
          <div class="handoff-title">${err ? 'Handoff failed' : h.phase === 'opening' ? 'Opening fresh session…' : 'Writing handoff…'}</div>
          <div class="handoff-body">${err ? h.error : h.phase === 'opening' ? 'Same folder, model, effort and permissions.' : `“${h.title}” is summarising its work for a fresh session.`}</div>
          <div class="handoff-actions">
            ${!err && html`<button class="btn btn-ghost btn-sm" onClick=${() => openSession(id)}>Show session</button>
              <button class="btn btn-sm" data-act="handoff-cancel" disabled=${h.phase !== 'writing'} onClick=${() => cancelHandoff(id)}>Cancel</button>`}
            ${err && h.text && html`<button class="btn btn-ghost btn-sm" onClick=${() => copyText(h.text, 'Handoff')}>Copy handoff</button>`}
            ${err && s && html`<button class="btn btn-ghost btn-sm" data-act="handoff-retry" onClick=${() => { setHandoff(id, null); freshStartWithHandoff(s); }}>Retry</button>`}
            ${err && html`<button class="btn btn-sm" data-act="handoff-dismiss" onClick=${() => setHandoff(id, null)}>Dismiss</button>`}
          </div>
        </div>
      </div>`;
    })}
  </div>`;
}
