// Stand-in engine used ONLY while main/engine (lane engine) is missing or fails to load,
// so the app still runs. Serves ui/lib/mock-data.js and fakes a streamed reply.
// Same interface as main/engine: createEngine({ userDataDir, emit, log }) -> { methods, snapshot, shutdown }.
// Delete this file (and the fallback in main.js) once the real engine is in.
// Owner: lane host (B).
const path = require('path');
const { pathToFileURL } = require('url');

function createEngine({ emit = () => {} } = {}) {
  const ready = import(pathToFileURL(path.join(__dirname, '..', 'ui', 'lib', 'mock-data.js')).href).then((m) => ({
    sessions: structuredClone(m.sessions), items: structuredClone(m.items), usage: structuredClone(m.usage),
    history: structuredClone(m.history), commands: m.commands, models: m.models, changes: structuredClone(m.changes),
    pendingSummary: m.pendingSummary,
  }));
  // Deck summary (PROTOCOL "Deck summary"): lastText = the tail of the latest reply, one line, at most 280 chars.
  const tail = (t) => { const one = String(t || '').replace(/\s+/g, ' ').trim(); return !one ? null : one.length <= 280 ? one : '…' + one.slice(-279); };
  const timers = new Set();
  const later = (fn, ms) => { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); };
  const find = (S, id) => {
    const s = S.sessions.find((x) => x.id === id);
    if (!s) throw Object.assign(new Error('no such session'), { code: 'not_found' });
    return s;
  };
  const touch = (s, patch) => { Object.assign(s, patch, { updatedAt: Date.now() }); emit('session.updated', structuredClone(s)); };

  function fakeTurn(S, s, text) {
    touch(s, { status: 'working', activity: 'Thinking', turnStartedAt: Date.now() });
    later(() => {
      const reply = { id: 'a' + Date.now(), type: 'assistant', ts: Date.now(), streaming: true, text: '', model: s.model };
      (S.items[s.id] ||= []).push(reply);
      emit('session.item', { sessionId: s.id, item: reply });
      const words = `(fallback engine) The real engine is not loaded yet, so this is a canned reply to: ${text.slice(0, 80)}`.split(' ');
      words.forEach((w, i) => later(() => {
        reply.text += (i ? ' ' : '') + w;
        emit('session.itemUpdate', { sessionId: s.id, itemId: reply.id, patch: {}, appendText: (i ? ' ' : '') + w });
        if (i === words.length - 1) {
          reply.streaming = false;
          emit('session.itemUpdate', { sessionId: s.id, itemId: reply.id, patch: { streaming: false } });
          touch(s, { status: 'idle', activity: null, turnStartedAt: null, lastText: tail(reply.text) });
        }
      }, 40 * i));
    }, 300);
  }

  const methods = {
    'sessions.create': async (p) => {
      const S = await ready;
      const cwd = p.cwd || process.cwd();
      const s = {
        id: 's_' + Date.now().toString(36), claudeSessionId: null, title: (p.prompt || 'New session').slice(0, 48), cwd,
        project: path.basename(cwd), status: 'idle', model: p.model || 'claude-opus-5-5', effort: p.effort || 'xhigh',
        permissionMode: p.permissionMode || 'bypassPermissions', createdAt: Date.now(), updatedAt: Date.now(), costUsd: 0,
        context: { usedTokens: 0, windowTokens: 1000000, percent: 0 }, activity: null, turnStartedAt: null, unread: 0, queued: 0, pinned: false,
        lastText: null, pendingRequest: null,
      };
      S.sessions.unshift(s); S.items[s.id] = [];
      emit('session.created', structuredClone(s));
      if (p.prompt) {
        const item = { id: 'u' + Date.now(), type: 'user', ts: Date.now(), text: p.prompt, attachments: p.attachments || [] };
        S.items[s.id].push(item);
        emit('session.item', { sessionId: s.id, item });
        fakeTurn(S, s, p.prompt);
      }
      return structuredClone(s);
    },
    'sessions.history': async (p) => { const S = await ready; return { items: structuredClone(S.items[p.id] || []), hasMore: false }; },
    'sessions.send': async (p) => {
      const S = await ready; const s = find(S, p.id);
      const item = { id: 'u' + Date.now(), type: 'user', ts: Date.now(), text: String(p.text || ''), attachments: p.attachments || [] };
      (S.items[s.id] ||= []).push(item);
      emit('session.item', { sessionId: s.id, item });
      fakeTurn(S, s, item.text);
      return { itemId: item.id, queued: false };
    },
    'sessions.interrupt': async () => ({}),
    'sessions.respond': async (p) => {
      const S = await ready;
      const it = (S.items[p.id] || []).find((x) => x.requestId === p.requestId);
      if (it) { it.status = 'answered'; it.answer = p.response; emit('session.itemUpdate', { sessionId: p.id, itemId: it.id, patch: { status: 'answered', answer: p.response } }); }
      // like the engine: pendingRequest moves on; with none left a waiting session goes idle (no turn runs here)
      const s = S.sessions.find((x) => x.id === p.id);
      if (s) {
        const pendingRequest = S.pendingSummary(S.items[p.id]);
        touch(s, { pendingRequest, ...(!pendingRequest && s.status === 'waiting' ? { status: 'idle', activity: null, turnStartedAt: null } : {}) });
      }
      return {};
    },
    'sessions.update': async (p) => {
      const S = await ready; const s = find(S, p.id);
      const patch = {};
      for (const k of ['title', 'model', 'effort', 'permissionMode', 'pinned']) if (p[k] !== undefined) patch[k] = p[k];
      touch(s, patch);
      return structuredClone(s);
    },
    'sessions.close': async (p) => { const S = await ready; touch(find(S, p.id), { status: 'closed', activity: null }); return {}; },
    'sessions.commands': async () => (await ready).commands,
    'sessions.models': async () => (await ready).models,
    'sessions.checkpoints': async () => [],
    'sessions.rewind': async () => ({}),
    'sessions.markRead': async (p) => { const S = await ready; const s = S.sessions.find((x) => x.id === p.id); if (s && s.unread) touch(s, { unread: 0 }); return {}; },
    'history.search': async (p) => {
      const S = await ready; const q = String(p.q || '').toLowerCase();
      return S.history.filter((h) => !q || (h.title + h.firstPrompt + h.project).toLowerCase().includes(q)).slice(0, p.limit || 50);
    },
    'usage.get': async () => (await ready).usage,
    'files.changes': async (p) => (await ready).changes[p.sessionId] || [],
  };

  return {
    methods,
    kind: 'fallback',
    async snapshot() { const S = await ready; return { sessions: structuredClone(S.sessions), usage: structuredClone(S.usage) }; },
    async shutdown() { for (const t of timers) clearTimeout(t); timers.clear(); },
  };
}

module.exports = { createEngine };
