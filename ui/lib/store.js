// Central state, as Preact signals, kept in sync with the main process via transport events.
// Components read signals (`sessions.value`) and call actions; they never mutate signals directly
// except through the helpers here. Lane-specific UI state (open panels, drafts, filters) lives in
// that lane's own module, not here. Owner: lane shell (C); other lanes may ADD exported helpers
// at the bottom under their lane's comment, but must not change existing shapes.
import { signal, computed, batch } from '@preact/signals';
import { rpc, on, onStatus, isMock } from './transport.js';
import { errorToast } from './plain-error.js';   // lane plainerror

export { rpc, isMock };

export const connection = signal('connecting');      // 'connecting' | 'open' | 'closed'
export const ready = signal(false);                  // first app.hello landed
export const appInfo = signal({ version: '', platform: 'web' });
export const settings = signal(null);
export const sessions = signal([]);                  // [Session], newest activity first
export const activeId = signal(null);                // selected session id
export const itemsBySession = signal({});            // { [sessionId]: [Item] } (loaded lazily)
export const fleetBySession = signal({});            // { [sessionId]: [Agent] }
export const usage = signal(null);
export const queue = signal([]);
export const toasts = signal([]);                    // [{ id, title, body, kind, sessionId }]

export const activeSession = computed(() => sessions.value.find((s) => s.id === activeId.value) || null);
export const activeItems = computed(() => itemsBySession.value[activeId.value] || []);
export const activeFleet = computed(() => fleetBySession.value[activeId.value] || []);
export const waitingCount = computed(() => sessions.value.filter((s) => s.status === 'waiting').length);
export const pendingRequests = computed(() => activeItems.value.filter((i) => i.type === 'request' && i.status === 'pending'));

const sortSessions = (list) => [...list].sort((a, b) => (b.pinned - a.pinned) || (b.updatedAt - a.updatedAt));

function upsertSession(s) {
  const list = sessions.value.filter((x) => x.id !== s.id);
  list.push({ ...s });   // copy: the mock (and any in-place mutation) re-sends the same object
  sessions.value = sortSessions(list);
}

function setItems(sessionId, items) { itemsBySession.value = { ...itemsBySession.value, [sessionId]: items }; }

// ---- actions ----
export async function loadHistory(sessionId) {
  if (itemsBySession.value[sessionId]) return;
  const { items, hasMore } = await rpc('sessions.history', { id: sessionId });
  batch(() => { setItems(sessionId, items); hasMoreBySession.value = { ...hasMoreBySession.value, [sessionId]: !!hasMore }; });
}

export function selectSession(id) {
  activeId.value = id;
  if (id) { loadHistory(id).catch((e) => toast({ title: 'Could not load session', error: e, kind: 'error' })); rpc('sessions.markRead', { id }).catch(() => {}); }
  try { localStorage.setItem('helm.active', id || ''); } catch {}
  if (id) noteViewed(id);   // lane smooth: bounded item cache (bottom of this file)
}

export const send = (id, text, attachments) => rpc('sessions.send', { id, text, attachments });
export const interrupt = (id) => rpc('sessions.interrupt', { id });
export const respond = (id, requestId, response) => rpc('sessions.respond', { id, requestId, response });
export const updateSession = (id, fields) => rpc('sessions.update', { id, ...fields });
export async function createSession(params) { const s = await rpc('sessions.create', params); upsertSession(s); selectSession(s.id); return s; }
// settings.set returns the merged Settings; copy it so the signal always sees a new object
export async function saveSettings(partial) { const s = await rpc('settings.set', partial); if (s) settings.value = { ...s }; return s; }

let toastSeq = 0;
// t.error (anything thrown) becomes plain words in body plus the raw text in details (lane plainerror, P-H1)
export function toast(t) {
  const id = ++toastSeq;
  t = errorToast(t);
  toasts.value = [...toasts.value, { id, kind: 'info', ...t }];
  setTimeout(() => { toasts.value = toasts.value.filter((x) => x.id !== id || x.pinned); }, t.ms || 6000);
}
// Details opened: the toast stays until dismissed, so the raw text does not vanish mid-read
export function pinToast(id) { toasts.value = toasts.value.map((x) => (x.id === id && !x.pinned ? { ...x, pinned: true } : x)); }

// ---- event wiring ----
async function hello() {
  const h = await rpc('app.hello', {});
  batch(() => {
    appInfo.value = { version: h.version, platform: h.platform, engine: h.engine || 'real', engineReason: h.engineReason || null, logPath: h.logPath || null, test: !!h.test };
    settings.value = h.settings;
    sessions.value = sortSessions(h.sessions);
    usage.value = h.usage;
    queue.value = h.queue;
    itemsBySession.value = {};   // reload lazily; deltas missed while disconnected are not replayed
    ready.value = true;
  });
  helloUpdate(h);   // lane restart (bottom of this file)
  setLook(h.look ?? null);   // lane look-sync (bottom of this file)
  toprowStatus.value = h.toprow ?? null;   // lane helm-toprow-hints
  if (h.auth && h.auth.capabilities) setAuth(h.auth); else auth.value = null;   // lane opensource-auth
  let saved = null; try { saved = localStorage.getItem('helm.active'); } catch {}
  // lane tabs: the tab strip (shell/tabs.js) may choose: its active tab, or null = none (every tab closed)
  let want; try { want = helloPick.fn ? helloPick.fn(h.sessions, activeId.value) : undefined; } catch {}
  const pick = want !== undefined ? h.sessions.find((s) => s.id === want)
    : h.sessions.find((s) => s.id === (activeId.value || saved)) || sortSessions(h.sessions)[0];
  if (pick) selectSession(pick.id);
  else if (want === null && activeId.value) selectSession(null);
}
export const helloPick = { fn: null };   // lane tabs: (sessions, currentId) -> id | null | undefined (default pick)

onStatus((s) => { connection.value = s; });
on('transport.open', () => hello().catch((e) => toast({ title: 'Helm backend not responding', error: e, kind: 'error' })));
on('session.created', upsertSession);
on('session.updated', upsertSession);
on('session.removed', ({ id }) => { sessions.value = sessions.value.filter((s) => s.id !== id); if (activeId.value === id) activeId.value = null; });
on('session.item', ({ sessionId, item }) => {
  const cur = itemsBySession.value[sessionId];
  if (!cur) return; // not loaded yet; history fetch will include it
  if (cur.some((i) => i.id === item.id)) return;
  setItems(sessionId, [...cur, item]);
});
on('session.itemUpdate', ({ sessionId, itemId, patch, appendText }) => {
  const cur = itemsBySession.value[sessionId];
  if (!cur) return;
  const idx = cur.findIndex((i) => i.id === itemId);
  if (idx < 0) return;
  const old = cur[idx];
  const next = { ...old, ...patch, ...(appendText ? { text: (old.text || '') + appendText } : {}) };
  // A queued prompt is sent only after the running turn ends: when it flips to queued:false (not cancelled)
  // it moves to the end, below the reply it was typed during, where Claude actually reads it.
  const sentNow = old.type === 'user' && old.queued && next.queued === false && !next.cancelled && idx < cur.length - 1;
  setItems(sessionId, sentNow ? [...cur.slice(0, idx), ...cur.slice(idx + 1), next] : cur.map((i, k) => (k === idx ? next : i)));
});
on('fleet.updated', ({ sessionId, agents }) => { fleetBySession.value = { ...fleetBySession.value, [sessionId]: agents }; });
on('usage.updated', (u) => { usage.value = u; });
on('queue.updated', ({ queue: q }) => { queue.value = q; });
on('settings.updated', (s) => { settings.value = { ...s }; });
on('notify', (n) => toast(n));

// ---- lane additions below (add, don't change shapes above) ----

// ---- lane ui-features (round 3): paging, fork, sessions running outside Helm ----
export const hasMoreBySession = signal({});          // { [sessionId]: bool } older items exist before the first loaded one
export const externalSessions = signal([]);          // [ExternalSession] (terminal Claude Code), external.list / external.updated
export const externalItems = signal({});             // { [claudeSessionId]: [Item] } read-only transcripts, loaded lazily
export const externalHasMore = signal({});           // { [claudeSessionId]: bool }
export const externalView = signal(null);            // claudeSessionId shown read-only in the main area, or null

const setFlag = (sig, key, v) => { sig.value = { ...sig.value, [key]: v }; };
const loadingEarlier = new Set();
// Prepends the page before the first loaded item. Resolves to the number of items added (0 = nothing more).
export async function loadEarlier(sessionId) {
  const cur = itemsBySession.value[sessionId];
  if (!cur?.length || loadingEarlier.has(sessionId)) return 0;
  loadingEarlier.add(sessionId);
  try {
    const { items, hasMore } = await rpc('sessions.history', { id: sessionId, before: cur[0].id });
    const now = itemsBySession.value[sessionId] || cur;
    const ids = new Set(now.map((i) => i.id));
    const fresh = (items || []).filter((i) => !ids.has(i.id));
    batch(() => { setItems(sessionId, [...fresh, ...now]); setFlag(hasMoreBySession, sessionId, !!hasMore && fresh.length > 0); });
    return fresh.length;
  } finally { loadingEarlier.delete(sessionId); }
}

// Fork (and edit & resend when `text` is given): a NEW session; the source is untouched.
export async function forkSession(id, itemId, text, attachments) {
  const s = await rpc('sessions.fork', { id, ...(itemId ? { itemId } : {}), ...(text != null ? { text } : {}), ...(attachments ? { attachments } : {}) });
  upsertSession(s);
  return s;
}

// External (terminal) sessions. The engine may not implement these yet: failures leave the list empty.
export async function refreshExternal() {
  try { const list = await rpc('external.list', {}); externalSessions.value = Array.isArray(list) ? list : []; } catch { externalSessions.value = []; }
}
export async function loadExternal(claudeSessionId, { refresh = false } = {}) {
  const cur = externalItems.value[claudeSessionId];
  if (cur && !refresh) return;
  const { items, hasMore } = await rpc('external.history', { claudeSessionId });
  const page = items || [];
  let next = page;
  if (cur && refresh) {   // keep older pages already loaded; the latest page replaces its own range
    const ids = new Set(page.map((i) => i.id));
    next = [...cur.filter((i) => !ids.has(i.id) && (!page.length || i.ts <= page[0].ts)), ...page];
  }
  batch(() => { externalItems.value = { ...externalItems.value, [claudeSessionId]: next }; if (!refresh || !cur) setFlag(externalHasMore, claudeSessionId, !!hasMore); });
}
export async function loadExternalEarlier(claudeSessionId) {
  const cur = externalItems.value[claudeSessionId];
  if (!cur?.length) return 0;
  const { items, hasMore } = await rpc('external.history', { claudeSessionId, before: cur[0].id });
  const ids = new Set(cur.map((i) => i.id));
  const fresh = (items || []).filter((i) => !ids.has(i.id));
  batch(() => { externalItems.value = { ...externalItems.value, [claudeSessionId]: [...fresh, ...cur] }; setFlag(externalHasMore, claudeSessionId, !!hasMore && fresh.length > 0); });
  return fresh.length;
}
on('external.updated', ({ sessions: list }) => {
  const prev = new Map(externalSessions.value.map((x) => [x.claudeSessionId, x]));
  externalSessions.value = Array.isArray(list) ? list : [];
  // the open read-only transcript follows along when its session wrote something new
  const open = externalView.value;
  const now = open && externalSessions.value.find((x) => x.claudeSessionId === open);
  if (now && externalItems.value[open] && now.lastActivity !== prev.get(open)?.lastActivity) loadExternal(open, { refresh: true }).catch(() => {});
});
on('transport.open', () => { hasMoreBySession.value = {}; externalItems.value = {}; refreshExternal(); });

// ---- lane fixes: apply a lifecycle RPC's reply at once ----
// sessions.archive answers in ms with the updated session, but its session.updated broadcast can
// trail by over a second; the row should move the moment the reply lands. Same shape as the events.
export function applySessionReply(s) { if (s && typeof s === 'object' && s.id && sessions.value.some((x) => x.id === s.id)) upsertSession(s); }
export function removeSessionLocal(id) {
  if (!id) return;
  sessions.value = sessions.value.filter((s) => s.id !== id);
  if (activeId.value === id) activeId.value = null;
}

// ---- lane smooth: per-session item signals ----
// itemsBySession is ONE signal for every session, so a component that reads itemsBySession.value[id] re-renders on
// every token of EVERY session (a background session streaming at 25 updates/s re-rendered the open transcript and
// every Deck tile). itemsOf(id).value only changes when that session's own array does. Same for externalItems.
const itemsSigs = new Map();
const externalSigs = new Map();
export function itemsOf(id) {
  let c = itemsSigs.get(id);
  if (!c) { c = computed(() => itemsBySession.value[id]); itemsSigs.set(id, c); }
  return c;
}
export function externalItemsOf(claudeSessionId) {
  let c = externalSigs.get(claudeSessionId);
  if (!c) { c = computed(() => externalItems.value[claudeSessionId]); externalSigs.set(claudeSessionId, c); }
  return c;
}
// true once a session's history is in the store: flips once, not on every token
const loadedSigs = new Map();
export function loadedOf(id) {
  let c = loadedSigs.get(id);
  if (!c) { c = computed(() => !!itemsBySession.value[id]); loadedSigs.set(id, c); }
  return c;
}

// ---- lane smooth: bounded item cache ----
// Every session ever opened used to keep its loaded items here until the window closed. A real first page is 2-20 MB
// (Read results carrying screenshots are 300-640 KB each; measured on the user's newest transcripts 2026-10-08), so a day
// of switching between sessions grew the renderer by hundreds of MB. Kept: the active session, the last KEEP_RECENT
// opened, every session working or waiting (Deck live tiles), and anything a mounted view holds (holdItems: split
// panes, the read-only external transcript). Anything else is dropped and reloads tail-first when opened again.
const KEEP_RECENT = 4;
const recent = [];
const held = new Map();   // id -> mount count
function noteViewed(id) {
  const i = recent.indexOf(id);
  if (i >= 0) recent.splice(i, 1);
  recent.unshift(id);
  if (recent.length > KEEP_RECENT) recent.length = KEEP_RECENT;
  trimItems();
}
// A mounted transcript keeps its items: returns the release function (use as a useEffect cleanup).
export function holdItems(id) {
  if (!id) return () => {};
  held.set(id, (held.get(id) || 0) + 1);
  return () => { const n = (held.get(id) || 1) - 1; if (n > 0) held.set(id, n); else held.delete(id); };
}
export function trimItems() {
  const keep = new Set([activeId.value, ...recent, ...held.keys()]);
  for (const s of sessions.value) if (s.status === 'working' || s.status === 'waiting') keep.add(s.id);
  const cur = itemsBySession.value;
  const drop = Object.keys(cur).filter((id) => !keep.has(id));
  const ext = externalItems.value;
  const dropExt = Object.keys(ext).filter((id) => id !== externalView.value && !held.has('ext:' + id));
  if (!drop.length && !dropExt.length) return;
  const omit = (obj, ids) => { const o = { ...obj }; for (const id of ids) delete o[id]; return o; };
  batch(() => {
    if (drop.length) { itemsBySession.value = omit(cur, drop); hasMoreBySession.value = omit(hasMoreBySession.value, drop); }
    if (dropExt.length) { externalItems.value = omit(ext, dropExt); externalHasMore.value = omit(externalHasMore.value, dropExt); }
  });
}

// ---- lane restart: running commit, pending update, restart (PROTOCOL "Restart + updates") ----
// updateState = app.hello `update` / the `app.update` event: { running, pending, autoRestart, restarted, bootedAt }
export const updateState = signal(null);
export const restartingNow = signal(null);   // { at, auto, by } once main says it is restarting
on('app.update', (u) => { updateState.value = u ? { ...updateState.value, ...u } : null; });
on('app.restarting', (r) => { restartingNow.value = r || { at: Date.now() }; });
function helloUpdate(h) {
  restartingNow.value = null;
  updateState.value = h && h.update ? h.update : null;
  restartedToast(updateState.value);
  if (lastInputAt && Date.now() - lastInputAt < 120_000) sendInput(); // input from before a reconnect still counts
}

// One toast per restart per browser profile (the desktop window and the phone each see it once), shown when
// the page is visible (a restart while Helm sat in the tray toasts when the user opens it), within a day of it.
function restartedToast(u) {
  const r = u && u.restarted;
  if (!r || !r.at || Date.now() - r.at > 24 * 3600_000) return;
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
    const later = () => { if (document.visibilityState === 'hidden') return; document.removeEventListener('visibilitychange', later); restartedToast(updateState.value); };
    document.addEventListener('visibilitychange', later);
    return;
  }
  let seen = null; try { seen = localStorage.getItem('helm.restartedSeen'); } catch {}
  if (seen === String(r.at)) return;
  try { localStorage.setItem('helm.restartedSeen', String(r.at)); } catch {}
  const c = (r.commits || [])[0];
  const title = c ? `Helm restarted · ${c.subject || 'update'} (${c.short})` : 'Helm restarted';
  const more = (r.commits || []).length > 1 ? `and ${r.commits.length - 1} earlier commit${r.commits.length > 2 ? 's' : ''}` : '';
  // lane restart: what the restart cut off (Session.restartNote, written at shutdown just before r.at)
  const cut = (sessions.value || []).filter((s) => s.restartNote && Math.abs(s.restartNote.at - r.at) < 5 * 60_000);
  const agents = cut.reduce((a, s) => a + Math.max((s.restartNote.agents || []).length, Number(s.restartNote.agentsTotal) || 0), 0);
  const cutText = !cut.length ? '' : `${agents ? `${agents} agent${agents === 1 ? '' : 's'} stopped` : 'Work stopped'} in ${cut.length === 1 ? `"${cut[0].title || 'a session'}"` : `${cut.length} sessions`}. ${cut.length === 1 ? 'It lists' : 'Each lists'} what stopped, with Continue.`;
  toast({ title, body: [more, cutText].filter(Boolean).join('. ') || undefined, kind: 'info', ms: cut.length ? 12000 : 9000 });
}

// The user's input (keys, pointer, wheel, touch) -> app.input for the auto-restart gate ("not while the user is
// using Helm"). Leading + trailing throttle: main's lastInputAt is never earlier than their real last input.
const INPUT_EVERY = 15_000;
let lastInputAt = 0, lastSentAt = 0, inputTimer = 0;
const composerAtts = new Map();   // composer key -> unsent attachments (drafts are saved; attachments are not)
let draftFor = null;              // session whose draft was typed since the last send (idle CLI close counts it as use)
function sendInput() {
  clearTimeout(inputTimer); inputTimer = 0;
  lastSentAt = Date.now();
  let attachments = 0; for (const n of composerAtts.values()) attachments += n;
  const draft = draftFor; draftFor = null;
  rpc('app.input', { input: true, attachments, ...(draft ? { draft } : {}) }).catch(() => {});
}
export function noteDraft(sessionId) {
  if (!sessionId || isMock) return;
  draftFor = sessionId;
  noteInput();
}
export function noteInput() {
  lastInputAt = Date.now();
  if (isMock) return;
  const wait = lastSentAt + INPUT_EVERY - lastInputAt;
  if (wait <= 0) sendInput();
  else if (!inputTimer) inputTimer = setTimeout(sendInput, wait);
}
export function noteAttachments(key, n) {
  const before = composerAtts.get(key) || 0;
  if (n) composerAtts.set(key, n); else composerAtts.delete(key);
  if (before !== n && !isMock) { let attachments = 0; for (const v of composerAtts.values()) attachments += v; rpc('app.input', { input: false, attachments }).catch(() => {}); }
}
if (typeof addEventListener === 'function') for (const ev of ['keydown', 'pointerdown', 'wheel', 'touchstart']) addEventListener(ev, noteInput, { capture: true, passive: true });

// Restart Helm. Asks main what a restart now would cut off first: busy -> { reasons, kept } for the caller to
// confirm; otherwise (or with force) it restarts -> { restarting: true }.
// confirmKept (lane detach): also stop at { reasons: [], kept } when nothing would be cut off but sessions keep
// running through the restart, so the caller can offer "Restart when finished" for them too.
// whenIdle (lane restart): "Restart when finished": main restarts as soon as nothing would be cut off
// -> { deferred: true, reasons } (UpdateState.deferred shows the wait), or restarts at once when nothing runs.
export async function restartHelm({ force = false, whenIdle = false, confirmKept = false } = {}) {
  if (whenIdle) return rpc('app.restart', { whenIdle: true });
  if (!force) {
    const { reasons, kept } = await rpc('app.restartCheck', {});
    if (reasons && reasons.length) return { reasons, kept: kept || [] };
    if (confirmKept && kept && kept.length) return { reasons: [], kept };
  }
  return rpc('app.restart', { force: true });
}
export const cancelRestartWhenIdle = () => rpc('app.restart', { cancel: true });
// lane installer: installed builds only (UpdateState.release): check GitHub Releases now -> the release state
export const checkForUpdates = () => rpc('app.checkUpdates');

// ---- lane look-sync: shared look with Quartz + Mantle (PROTOCOL "Look Sync") ----
// look = app.hello `look` / the `look.updated` event: { sync: { enabled, state, reason, rev, by, at, skipped },
//   desktop: { source: 'mantle'|'windows'|'none', ok, url, rev, title, type, id, size, reason } }
export const look = signal(null);
// No silent failures: a fallback or a sync problem shows ONCE as a toast (per reason, remembered across restarts
// in localStorage helm.look.toasted); the Appearance settings keep showing it in the status line.
const LOOK_TOASTED_KEY = 'helm.look.toasted';
const lookToasted = new Set((() => { try { return JSON.parse(localStorage.getItem(LOOK_TOASTED_KEY) || '[]'); } catch { return []; } })());
function lookNotice(l) {
  if (!l) return;
  const once = (key, t) => {
    if (lookToasted.has(key)) return;
    lookToasted.add(key);
    try { localStorage.setItem(LOOK_TOASTED_KEY, JSON.stringify([...lookToasted].slice(-20))); } catch {}
    toast(t);
  };
  const d = l.desktop || {};
  const s = l.sync || {};
  if (settings.value?.background?.mode !== 'own' && d.source !== 'mantle' && d.reason) once('d:' + d.reason, { title: 'Desktop wallpaper', body: d.reason, kind: 'info' });
  if (['corrupt', 'newer', 'error'].includes(s.state) && s.reason) once('s:' + s.reason, { title: 'Look sync', body: s.reason, kind: s.state === 'error' ? 'error' : 'info' });
  for (const k of s.skipped || []) if (k && k.text) once('k:' + k.text, { title: 'Look sync', body: k.text, kind: 'info' });
}
function setLook(l) { look.value = l; lookNotice(l); }
on('look.updated', setLook);
// lane helm-toprow-hints: the pipe to Mantle's top bar (main/toprow.js state()):
//   { state: 'connected'|'not-running'|'connecting'|'off', reason, pipe, sent, since, connected, windows }
export const toprowStatus = signal(null);
on('toprow.updated', (s) => { toprowStatus.value = s; });
// ---- lane opensource-auth: who pays for Claude Code (PROTOCOL "Account") ----
// auth = app.hello `auth` / account.changed: { provider: 'claude-code'|'api-key', capabilities: { apiKey, login },
//   ready, reason, usageLimits }. 'claude-code' = sessions use the user's installed Claude Code sign-in (Helm never signs in);
//   'api-key' = a key saved in Settings -> Account. null = an older host that says nothing: always ready (today's behaviour).
export const auth = signal(null);
// Also called with an account.status / account.setApiKey reply (shell/account.js, shell/auth-notice.js), so a
// Check again that finds Claude Code signed in clears the notice even if no account.changed follows.
export function setAuth(a) {
  if (!a || !a.capabilities) return;
  auth.value = { provider: a.provider || null, capabilities: a.capabilities, ready: a.ready !== false, reason: a.reason || null,
    usageLimits: a.usageLimits !== false };   // lane prep-helm-auth-usage: false = no 5-hour/weekly limits (an API key), no 5H / week windows (lib/usage-limits.js)
}
on('account.changed', (x) => { if (x && x.capabilities) setAuth(x); });
