// The renderer's only link to the main process (docs/PROTOCOL.md).
//   rpc(method, params) -> Promise<result>
//   on(event, fn)       -> unsubscribe     ('*' receives every event as fn(event, data))
//   onStatus(fn)        -> 'connecting' | 'open' | 'closed' | 'unauthorized' (server refused the key)
// ?mock=1 swaps the WebSocket for an in-memory fake backed by mock-data.js.
// Owner: lane host (B). Other lanes import it; they don't edit it.
import * as mock from './mock-data.js';
import * as mockReview from './mock-review.js';   // review-tools lane: two-hunk diff + image files (mock only)

const listeners = new Map();
const statusFns = new Set();
let status = 'connecting';

function emit(event, data) {
  for (const fn of listeners.get(event) || []) fn(data);
  for (const fn of listeners.get('*') || []) fn(event, data);
}
function setStatus(s) { status = s; for (const fn of statusFns) fn(s); }

export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event).delete(fn);
}
export function onStatus(fn) { statusFns.add(fn); fn(status); return () => statusFns.delete(fn); }
export const isMock = new URLSearchParams(location.search).has('mock');

// ---------- real WebSocket transport ----------
// Auth: the desktop window loads /?token=…; the token is kept in sessionStorage and removed
// from the address bar. The phone pairs once via /?key=… which sets an HttpOnly cookie, so
// its WebSocket carries the cookie and no token. Close code 4401 = the server refused the key.
// Keepalive: app.ping every 20 s (8 s timeout) and on returning to the tab; a dead socket is
// closed and reconnected with backoff. Calls made while connecting wait up to 10 s.
let ws = null;
let nextId = 1;
const pending = new Map();
const waiters = new Set();   // rpc calls waiting for the socket to open
let backoff = 500;
let retryTimer = null;
let pingTimer = null;

function token() {
  const params = new URLSearchParams(location.search);
  // The phone's pairing link (/?key=…) is answered with this page and the cookie: drop the key from
  // the address bar (and history) so a bookmark, screenshot or home-screen icon never carries it.
  if (params.has('key')) {
    params.delete('key');
    const rest = params.toString();
    try { history.replaceState(history.state, '', location.pathname + (rest ? '?' + rest : '') + location.hash); } catch {}
  }
  const q = params.get('token');
  if (q) {
    try { sessionStorage.setItem('helm_token', q); } catch {}
    params.delete('token');
    const rest = params.toString();
    try { history.replaceState(history.state, '', location.pathname + (rest ? '?' + rest : '') + location.hash); } catch {}
    return q;
  }
  try { return sessionStorage.getItem('helm_token') || ''; } catch { return ''; }
}
const authToken = isMock ? '' : token();

function scheduleReconnect(ms) {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(connect, ms);
}

function connect() {
  clearTimeout(retryTimer);
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
  setStatus('connecting');
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const q = authToken ? `?token=${encodeURIComponent(authToken)}` : '';
  const sock = new WebSocket(`${proto}//${location.host}/ws${q}`);
  ws = sock;
  sock.onopen = () => {
    if (ws !== sock) return;
    backoff = 500;
    setStatus('open');
    for (const w of waiters) w();
    waiters.clear();
    emit('transport.open', {});
    startPing();
  };
  sock.onmessage = (e) => {
    if (ws !== sock) return;
    let msg; try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === 'result') {
      const p = pending.get(msg.id); if (!p) return;
      pending.delete(msg.id);
      msg.error ? p.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code, ...(msg.error.data ? { data: msg.error.data } : {}) })) : p.resolve(msg.result);
    } else if (msg.type === 'event') emit(msg.event, msg.data);
  };
  sock.onerror = () => {};
  sock.onclose = (e) => {
    if (ws !== sock) return;
    ws = null;
    stopPing();
    for (const p of pending.values()) p.reject(Object.assign(new Error('connection lost'), { code: 'disconnected' }));
    pending.clear();
    if (e.code === 4401) {
      // Wrong or missing key: retrying fast won't help. The UI should tell the user to re-pair.
      setStatus('unauthorized');
      scheduleReconnect(15000);
      return;
    }
    setStatus('closed');
    const jitter = Math.round(backoff * 0.2 * Math.random());
    scheduleReconnect(backoff + jitter);
    backoff = Math.min(backoff * 2, 8000);
  };
}

function startPing() {
  stopPing();
  pingTimer = setInterval(ping, 20000);
}
function stopPing() { clearInterval(pingTimer); pingTimer = null; }
function ping() {
  const sock = ws;
  if (!sock || sock.readyState !== 1) return;
  const t = setTimeout(() => { if (ws === sock) { try { sock.close(4000, 'ping timeout'); } catch {} sock.onclose({ code: 4000 }); } }, 8000);
  wsRpc('app.ping', {}).then(() => clearTimeout(t), () => clearTimeout(t));
}

if (!isMock) {
  // Phones freeze background tabs and drop sockets; check as soon as the user comes back.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (!ws) { backoff = 500; connect(); } else ping();
  });
  addEventListener('online', () => { if (!ws) { backoff = 500; connect(); } });
}

function send(method, params) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    try { ws.send(JSON.stringify({ id, type: 'rpc', method, params })); }
    catch (e) { pending.delete(id); reject(e); }
  });
}

function wsRpc(method, params = {}) {
  if (ws && ws.readyState === 1) return send(method, params);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiters.delete(go); reject(Object.assign(new Error('not connected'), { code: 'disconnected' })); }, 10000);
    function go() { clearTimeout(timer); send(method, params).then(resolve, reject); }
    waiters.add(go);
  });
}

// ---------- mock transport ----------
const clone = (x) => structuredClone(x);
const mockUsage = new URLSearchParams(location.search).get('usage') === 'unknown' ? mock.usageUnknown : mock.usage;
const mockOrg = new URLSearchParams(location.search).has('org');   // sessions-org extras: an idle-for-a-week and an archived session
const mockState = { sessions: clone(mockOrg ? [...mock.sessions, ...(mock.sessionsOrg || [])] : mock.sessions), items: clone(mock.items), queue: clone(mock.queue), settings: clone(mock.settings),
  older: clone(mock.older || {}), external: clone(mock.external || []), externalItems: clone(mock.externalItems || {}) };
// Mock uploads can't reach /bg/, so their data URLs are kept here and handed out by mockBgUrl().
const mockUploads = new Map();
export function mockBgUrl(file) { return isMock ? mockUploads.get(file) || null : null; }

// sessions.history / external.history paging: `recent` is what a plain call returns, `older` (chronological)
// is handed out a page at a time, newest first, for { before: <first loaded itemId> }.
function mockPage(recent, older, p) {
  if (!p.before) return { items: recent, hasMore: older.length > 0 };
  const lim = p.limit || 20;
  let end = older.findIndex((i) => i.id === p.before);
  if (end < 0) end = recent.some((i) => i.id === p.before) ? older.length : 0;
  const start = Math.max(0, end - lim);
  return { items: older.slice(start, end), hasMore: start > 0 };
}

async function mockRpc(method, p = {}) {
  try { (window.__mockCalls ||= []).push([method, p]); } catch {}   // mock-only call log for click-through scripts
  await new Promise((r) => setTimeout(r, 60));
  const S = mockState;
  switch (method) {
    case 'app.hello': return { version: '0.1.0-mock', settings: S.settings, sessions: S.sessions, usage: mockUsage, queue: S.queue, platform: new URLSearchParams(location.search).get('platform') === 'electron' ? 'electron' : 'web', engine: 'real',
      update: mock.mockUpdateState(new URLSearchParams(location.search).get('update')),   // lane restart
      look: mock.look,   // lane look-sync
      auth: mock.accountHelloAuth(),   // lane opensource-auth: ?account=cc-signed-in (default), cc-signed-out, cc-unknown, cc-console, key-helm, key-error, old-host
      // ?engine=fallback previews the stand-in-engine banner
      ...(new URLSearchParams(location.search).get('engine') === 'fallback' ? { engine: 'fallback', engineReason: 'main/engine failed to load: Cannot find module "@anthropic-ai/claude-agent-sdk"', logPath: 'C:\\Users\\you\\AppData\\Roaming\\Helm\\logs\\main.log' } : {}) };
    case 'sessions.history': return mockPage(S.items[p.id] || [], S.older[p.id] || [], p);
    case 'agents.transcript': return mock.agentTranscriptMock(p);
    case 'sessions.shell': case 'sessions.shellStop': return mock.shellMock(method, p, { state: S, emit });   // lane bang
    case 'sessions.handoff': case 'sessions.handoffCancel': return (await import('./mock-handoff.js')).mockHandoff(method, p, { state: S, emit });   // lane handoff
    case 'sessions.send': {
      mock.shellMockShare(S, emit, p.id);
      const item = { id: 'u' + Date.now(), type: 'user', ts: Date.now(), text: p.text, attachments: p.attachments || [] };
      // lane steer: mid-turn, like the engine: into the running turn at its next step ('pending' → 'seen'), no interrupt
      const ws = S.sessions.find((x) => x.id === p.id);
      if (ws && ws.status === 'working') {
        item.steer = 'pending';
        (S.items[p.id] ||= []).push(item);
        emit('session.item', { sessionId: p.id, item });
        setTimeout(() => { Object.assign(item, { steer: 'seen', seenAt: Date.now() }); emit('session.itemUpdate', { sessionId: p.id, itemId: item.id, patch: { steer: 'seen', seenAt: item.seenAt } }); }, 2500);
        return { itemId: item.id, queued: false, delivery: 'next-step' };
      }
      (S.items[p.id] ||= []).push(item);
      emit('session.item', { sessionId: p.id, item });
      setTimeout(() => {
        const reply = { id: 'a' + Date.now(), type: 'assistant', ts: Date.now(), streaming: true, text: '' };
        S.items[p.id].push(reply);
        emit('session.item', { sessionId: p.id, item: reply });
        const words = '(mock) Got it — this is a streamed reply so the UI can show tokens arriving word by word.'.split(' ');
        words.forEach((w, i) => setTimeout(() => {
          emit('session.itemUpdate', { sessionId: p.id, itemId: reply.id, patch: {}, appendText: (i ? ' ' : '') + w });
          if (i === words.length - 1) emit('session.itemUpdate', { sessionId: p.id, itemId: reply.id, patch: { streaming: false } });
        }, 60 * i));
      }, 300);
      return { itemId: item.id, queued: false };
    }
    case 'sessions.create': {
      const s = { ...S.sessions[0], id: 's_' + Date.now().toString(36), claudeSessionId: null, title: p.prompt?.slice(0, 48) || 'New session',
        cwd: p.cwd, project: p.cwd.split(/[\\/]/).pop(), status: 'idle', costUsd: 0, unread: 0, queued: 0, activity: null, turnStartedAt: null,
        context: { usedTokens: 0, windowTokens: 1000000, percent: 0 }, createdAt: Date.now(), updatedAt: Date.now() };
      S.sessions.unshift(s); S.items[s.id] = [];
      emit('session.created', s);
      return s;
    }
    case 'sessions.update': { const s = S.sessions.find((x) => x.id === p.id); Object.assign(s, p); emit('session.updated', s); return s; }
    case 'sessions.respond': {
      const it = (S.items[p.id] || []).find((x) => x.requestId === p.requestId);
      if (it) { it.status = 'answered'; it.answer = p.response; emit('session.itemUpdate', { sessionId: p.id, itemId: it.id, patch: { status: 'answered', answer: p.response } }); }
      // Like the engine (_afterRequest): pendingRequest moves to the next one; once none are left a waiting
      // session goes back to work, and here the (mock) turn then finishes a moment later.
      const s = S.sessions.find((x) => x.id === p.id);
      if (s) {
        const pendingRequest = mock.pendingSummary(S.items[p.id]);
        const back = !pendingRequest && s.status === 'waiting';
        Object.assign(s, { pendingRequest, updatedAt: Date.now() }, back ? { status: 'working', activity: 'Continuing', turnStartedAt: s.turnStartedAt || Date.now() } : {});
        emit('session.updated', s);
        if (back) setTimeout(() => {
          if (s.status !== 'working') return;
          Object.assign(s, { status: 'idle', activity: null, turnStartedAt: null, updatedAt: Date.now() });
          emit('session.updated', s);
        }, 1500);
      }
      return {};
    }
    case 'sessions.interrupt': {
      // lane steer: refused while agents run unless stopAgents (the UI asks first, naming them)
      const running = (mock.fleet[p.id] || []).filter((a) => a.status === 'running');
      if (running.length && !p.stopAgents) throw Object.assign(new Error(`Stop also stops ${running.length} agents`), { code: 'agents_running', data: { agents: running.map((a) => ({ id: a.id, name: (/^\[lane:([^\]]+)\]/.exec(a.description || '') || [])[1] || a.description })) } });
      // Like the engine: queued prompts are dropped (cancelled), an "Interrupted" line is added, the session goes idle.
      const list = S.items[p.id] || [];
      const dropped = list.filter((i) => i.type === 'user' && i.queued);
      for (const i of dropped) { Object.assign(i, { queued: false, cancelled: true }); emit('session.itemUpdate', { sessionId: p.id, itemId: i.id, patch: { queued: false, cancelled: true } }); }
      for (const i of list) if (i.type === 'tool' && i.status === 'running') { Object.assign(i, { status: 'error', endedAt: Date.now(), result: 'Interrupted' }); emit('session.itemUpdate', { sessionId: p.id, itemId: i.id, patch: { status: 'error', endedAt: i.endedAt, result: 'Interrupted' } }); }
      const sys = { id: 'x' + Date.now(), type: 'system', subtype: 'interrupted', ts: Date.now(), text: dropped.length ? `Interrupted. ${dropped.length} queued prompt${dropped.length > 1 ? 's were' : ' was'} not sent.` : 'Interrupted' };
      list.push(sys); emit('session.item', { sessionId: p.id, item: sys });
      const s = S.sessions.find((x) => x.id === p.id);
      if (s) { Object.assign(s, { status: 'idle', activity: null, turnStartedAt: null, queued: 0, updatedAt: Date.now() }); emit('session.updated', s); }
      return {};
    }
    case 'sessions.close': {
      const s = S.sessions.find((x) => x.id === p.id);
      if (s) { Object.assign(s, { status: 'closed', activity: null, turnStartedAt: null, updatedAt: Date.now() }); emit('session.updated', s); }
      return {};
    }
    // lane sessions-org: archive / delete-from-Helm (the Claude Code transcript is never touched)
    case 'sessions.archive': {
      const s = S.sessions.find((x) => x.id === p.id);
      if (!s) throw new Error(`Unknown session ${p.id}`);
      Object.assign(s, { archived: p.archived !== false, ...(p.archived !== false && (s.status === 'working' || s.status === 'waiting' || s.status === 'idle') ? { status: 'closed', activity: null, turnStartedAt: null } : {}) });
      emit('session.updated', s); return s;
    }
    case 'sessions.delete': S.sessions = S.sessions.filter((x) => x.id !== p.id); emit('session.removed', { id: p.id }); return {};
    case 'usage.history': return (await import('./mock-usage-history.js')).mockUsageHistory(p);
    case 'eta.accuracy': return (await import('./mock-eta-accuracy.js')).mockEtaAccuracy(p);   // lane eta-accuracy
    case 'activity.summary': return (await import('./mock-activity.js')).mockActivitySummary(p);   // lane activity (ui/lib/mock-activity.js)
    case 'railway.status': case 'railway.redeploy': case 'railway.restart': return (await import('./mock-railway.js')).mockRailway(method, p, { emit });   // lane railway
    case 'voice.status': case 'voice.warm': case 'voice.transcribe': return (await import('./mock-voice.js')).mockVoice(method, p);   // lane voice (ui/lib/mock-voice.js)
    case 'sessions.markRead': return {};
    // Like the engine: a "Rewound to before…" info marker whose `rewind` names the prompt rewound to,
    // so the dimmed "N messages rewound" fold (ui/chat/rewound.js) can be clicked through in mock mode.
    case 'sessions.rewind': {
      const list = S.items[p.id] || [];
      const u = list.find((i) => i.type === 'user' && 'cp_' + i.id === p.checkpointId);
      if (!u) throw new Error('Unknown checkpoint');
      const notes = [];
      if (p.files) notes.push('files restored (1 changed, +0 −3)');
      if (p.conversation) notes.push('conversation rewound (Claude no longer sees anything from this prompt on)');
      const one = String(u.text || '').replace(/\s+/g, ' ').trim();
      const sys = { id: 'x' + Date.now(), type: 'system', subtype: 'info', ts: Date.now(),
        text: `Rewound to before “${one.length > 80 ? one.slice(0, 79) + '…' : one}”: ${notes.join('; ')}.`,
        rewind: { checkpointId: p.checkpointId, fromItemId: u.id, files: !!p.files, conversation: !!p.conversation } };
      list.push(sys); emit('session.item', { sessionId: p.id, item: sys });
      return {};
    }
    case 'sessions.commands': return mock.commands;
    case 'sessions.models': return mock.models;
    // one checkpoint per (non-queued) user prompt, like Claude Code's file history; the first carries files
    case 'sessions.checkpoints': return (S.items[p.id] || []).filter((i) => i.type === 'user' && !i.queued)
      .map((u, k) => ({ id: 'cp_' + u.id, itemId: u.id, ts: u.ts, files: k === 0 ? ['src/middleware/auth.js'] : [] }));
    // Round 3: fork / edit & resend → a NEW session holding the history up to (not including) itemId
    case 'sessions.fork': {
      const src = S.sessions.find((x) => x.id === p.id);
      if (!src) throw new Error('no such session');
      const list = S.items[p.id] || [];
      const cut = p.itemId ? list.findIndex((i) => i.id === p.itemId) : -1;
      const s = { ...src, id: 's_' + Date.now().toString(36), claudeSessionId: null, title: `${src.title} (fork)`, status: 'idle', unread: 0, queued: 0,
        activity: null, turnStartedAt: null, pinned: false, eta: null, createdAt: Date.now(), updatedAt: Date.now() };
      S.sessions.unshift(s);
      S.items[s.id] = clone(cut >= 0 ? list.slice(0, cut) : list).filter((i) => !(i.type === 'user' && i.queued));
      emit('session.created', s);
      if (p.text) setTimeout(() => mockRpc('sessions.send', { id: s.id, text: p.text, attachments: p.attachments }), 50);
      return s;
    }
    case 'external.list': return S.external;
    case 'external.history': return mockPage(S.externalItems[p.claudeSessionId] || [], [], p);
    case 'history.search': return mock.history.filter((h) => p.includeTemp || !h.temp).filter((h) => !p.q || (h.title + h.firstPrompt + h.project).toLowerCase().includes(p.q.toLowerCase()));
    case 'files.tree': return mock.tree[p.path || p.cwd] || mockReview.tree(p.path || p.cwd) || [];
    case 'files.read': return mockReview.read(p.path) || { path: p.path, text: '// mock file contents\nmodule.exports = {};\n', truncated: false, mime: 'text/javascript' };
    case 'files.search': return ['src/middleware/auth.js', 'src/routes/account.js', 'server.js', 'test/auth-redirect.test.js']
      .filter((r) => r.includes(p.q || '')).map((rel) => ({ rel, path: p.cwd + '\\' + rel.replaceAll('/', '\\') }));
    case 'files.changes': return mock.changes[p.sessionId] || [];
    case 'files.diff': return mockReview.diff(p.path) || { path: p.path, before: "  if (!session) {\n    return res.redirect('/login');\n  }\n", after: "  if (!session) {\n    const next = encodeURIComponent(req.originalUrl);\n    return res.redirect(`/login?next=${next}`);\n  }\n" };
    case 'files.pickFolder': throw new Error('folder picker needs the desktop app');
    // lane git-export: header git chip + desktop Save-as (mock records the last save on window.__mockSaved)
    case 'git.status': return mock.gitStatus[p.cwd] || { isRepo: false };
    case 'files.saveText': window.__mockSaved = { name: p.suggestedName, text: p.text }; return { path: `C:\\Users\\you\\Downloads\\${p.suggestedName}` };
    case 'queue.add': { const j = { ...p, id: 'q' + Date.now(), status: 'queued', createdAt: Date.now() }; S.queue.push(j); emit('queue.updated', { queue: S.queue }); return j; }
    case 'queue.update': { const j = S.queue.find((x) => x.id === p.id); Object.assign(j, p); emit('queue.updated', { queue: S.queue }); return j; }
    case 'queue.remove': S.queue = S.queue.filter((x) => x.id !== p.id); emit('queue.updated', { queue: S.queue }); return {};
    case 'usage.get': return mockUsage;
    case 'settings.get': return S.settings;
    case 'look.get': return mock.look;
    // lane restart: Settings > Helm, the update chip, input reports (mock: nothing restarts)
    case 'app.input': return {};
    case 'app.restartCheck': return { reasons: S.sessions.some((s) => s.status === 'working') ? ['1 session working'] : [], kept: [] };
    case 'app.restart': throw Object.assign(new Error('The mock does not restart'), { code: 'unsupported' });
    case 'settings.set': {
      // like the host: background merges, glass merges per theme (lane look-sync)
      const { background: bg, glass: gl, ...rest } = p;
      Object.assign(S.settings, rest);
      if (bg) S.settings.background = { ...S.settings.background, ...bg };
      if (gl) { const g = S.settings.glass; S.settings.glass = { ...g, ...(gl.render ? { render: gl.render } : {}), dark: { ...g.dark, ...(gl.dark || {}) }, light: { ...g.light, ...(gl.light || {}) } }; }
      emit('settings.updated', S.settings); return S.settings;
    }
    case 'settings.uploadBackground': {
      if (!String(p.dataUrl || '').startsWith('data:image/')) throw Object.assign(new Error('not an image'), { code: 'bad_request' });
      const name = String(p.name || 'background.png').replace(/[^A-Za-z0-9._-]+/g, '-');
      mockUploads.set(name, p.dataUrl);
      S.settings.backgrounds = [name, ...S.settings.backgrounds.filter((f) => f !== name)];
      S.settings.background = { ...S.settings.background, kind: 'image', file: name }; // like the real host
      emit('settings.updated', S.settings);
      return S.settings;
    }
    case 'app.window': return {};
    case 'claudeConfig.list': case 'claudeConfig.read': case 'claudeConfig.write': case 'claudeConfig.search': case 'claudeConfig.session':
      return mock.claudeConfigMock(method, p);   // lane cc-config (ui/lib/mock-claude-config.js)
    case 'worktrees.info': case 'worktrees.list': case 'worktrees.create': case 'worktrees.deps': case 'worktrees.merge': case 'worktrees.remove': return mock.worktreesMock(method, p);   // lane helm-worktrees (ui/lib/mock-worktrees.js)
    case 'account.status': case 'account.setApiKey': return mock.accountMock(method, p);   // lane account (ui/lib/mock-account.js)
    default: throw new Error(`mock: no handler for ${method}`);
  }
}

export function rpc(method, params) { return isMock ? mockRpc(method, params) : wsRpc(method, params); }

// The mock also replays fleet once so panels have data.
if (isMock) {
  // Test hook (mock only): headless checks replay engine events, e.g. a queued prompt being sent.
  window.__helmMock = { emit, state: mockState };
  // Screenshot attach (review-tools lane): a fake window.helmNative capture API so the composer's camera flow runs in a browser.
  if (!window.helmNative) import('./mock-capture.js').then((m) => m.install()).catch((e) => console.warn('mock capture unavailable', e));
  setTimeout(() => { setStatus('open'); emit('transport.open', {}); for (const [sessionId, agents] of Object.entries(mock.fleet)) emit('fleet.updated', { sessionId, agents }); }, 0);
} else {
  connect();
}
