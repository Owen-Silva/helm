// Mock for "Fresh start with handoff" (lane handoff): sessions.handoff / sessions.handoffCancel in ?mock=1.
// ?handoff=hold keeps the handoff writing until Cancel (to see the progress card); ?handoff=fail ends it with an error.
const HANDOFF_PROMPT = 'Write a compact handoff so a fresh session can pick this work up. Under about 250 words, no preamble, no sign-off. Four short sections: Done, Left, Files (the paths that matter), Test state (exact summary lines, or "not run"). Write it from what you already know; don\'t run tools. Reply with the handoff only.';
const MOCK_TEXT = `**Done**
- Added the tab strip release on close (ui/shell/tabs.js) and its engine method.

**Left**
- Phone: the session menu item still needs a 320px check.

**Files**
- main/engine/idle-reaper.js, ui/shell/tabs.js, test/engine/tab-release.test.js

**Test state**
- node --test "test/engine/*.test.js": 175 tests, 174 pass, 1 skip`;

const pending = new Map();   // session id -> { cancel }

export function mockHandoff(method, p, { state: S, emit }) {
  const s = S.sessions.find((x) => x.id === p.id);
  if (!s) throw Object.assign(new Error(`Unknown session ${p.id}`), { code: 'not_found' });
  if (method === 'sessions.handoffCancel') {
    const job = pending.get(s.id);
    if (!job) return { cancelled: false };
    job.cancel();
    return { cancelled: true };
  }
  if (pending.has(s.id) || s.status === 'working' || s.status === 'waiting') throw Object.assign(new Error('This session is working.'), { code: 'busy' });
  const mode = new URLSearchParams(location.search).get('handoff');
  const user = { id: 'u' + Date.now(), type: 'user', ts: Date.now(), text: HANDOFF_PROMPT, attachments: [] };
  (S.items[s.id] ||= []).push(user);
  emit('session.item', { sessionId: s.id, item: user });
  const set = (status, activity) => { Object.assign(s, { status, activity, turnStartedAt: status === 'working' ? Date.now() : null }); emit('session.updated', { ...s }); };
  set('working', 'Writing');
  return new Promise((resolve, reject) => {
    let timer = 0;
    const done = () => { pending.delete(s.id); clearTimeout(timer); };
    pending.set(s.id, { cancel: () => { done(); set('idle', null); reject(Object.assign(new Error('Handoff cancelled'), { code: 'cancelled' })); } });
    if (mode === 'hold') return;
    timer = setTimeout(() => {
      done();
      if (mode === 'fail') { set('error', 'API overloaded'); reject(Object.assign(new Error('The handoff turn failed: API overloaded'), { code: 'failed' })); return; }
      const reply = { id: 'a' + Date.now(), type: 'assistant', ts: Date.now(), streaming: false, text: MOCK_TEXT };
      S.items[s.id].push(reply);
      emit('session.item', { sessionId: s.id, item: reply });
      set('idle', null);
      resolve({ text: MOCK_TEXT, from: { id: s.id, title: s.title || 'New session', cwd: s.cwd, model: s.model || null, effort: s.effort || null, permissionMode: s.permissionMode || null } });
    }, 1500);
  });
}
