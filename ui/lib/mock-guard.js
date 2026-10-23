// Mock for the production guard (lane guard, main/engine/prod-guard.js), only with ?mock=1&guard=…:
//   guard=1     s_storefront is waiting on a "Production push · Storefront master" card (request item with `guard`)
//   guard=auto  s_storefront shows the line a pre-approved push leaves instead of a card
//   guard=done  the card answered (Allowed once) and a timed-out one (Blocked)
export function applyGuardMock({ sessions, items, pendingSummary, now = Date.now() }) {
  const mode = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('guard') : null;
  if (!mode) return;
  const s = sessions.find((x) => x.id === 's_storefront');
  const list = items.s_storefront;
  if (!s || !list) return;
  const min = 60_000;
  const cmd = 'git add -A && git commit -m "Fix login redirect loop" && git push origin master';
  const tool = (id, status) => ({ id, type: 'tool', ts: now - min, toolUseId: `toolu_${id}`, name: 'Bash', status, startedAt: now - min,
    input: { command: cmd, description: 'Commit the fix and push it' }, result: status === 'done' ? 'To github.com:your-org/storefront.git\n   3f2a1c9..8b7d4e2  master -> master' : '' });
  const guard = { kind: 'push', title: 'Production push · Storefront master', approvable: 'all', hits: [{ kind: 'push', target: 'storefront', branch: 'master' }], waitMin: 30 };
  const req = (id, extra) => ({ id, type: 'request', ts: now - min, requestId: `req_${id}`, kind: 'permission', toolName: 'Bash', toolUseId: `toolu_${id.replace(/^r/, 'g')}`,
    input: { command: cmd, description: 'Commit the fix and push it' }, title: guard.title, description: 'Pushing Storefront master deploys production.', guard, ...extra });
  if (mode === 'auto') {
    list.push({ id: 'gu1', type: 'user', uuid: '9a1b2c3d-0001-4e5f-8a9b-0000000000g1', ts: now - 2 * min, text: 'Looks right. Commit and push.', attachments: [] });
    list.push({ id: 'ga1', type: 'system', subtype: 'info', ts: now - min, text: `Production push to Storefront master allowed · you said “Looks right. Commit and push.” at ${hhmm(now - 2 * min)}`, guard: { auto: true, title: guard.title } });
    list.push(tool('g1', 'done'));
    return;
  }
  list.push({ id: 'gu1', type: 'user', uuid: '9a1b2c3d-0001-4e5f-8a9b-0000000000g1', ts: now - 2 * min, text: 'Looks right. Commit it.', attachments: [] });
  list.push({ id: 'gs1', type: 'assistant', ts: now - min, streaming: false, model: 'claude-opus-5-5', text: 'Committing the fix, then pushing it so the redirect fix goes live.' });
  if (mode === 'done') {
    list.push(tool('g1', 'done'), req('r1', { status: 'answered', answer: { behavior: 'allow' } }));
    list.push(tool('g2', 'error'), req('r2', { status: 'cancelled', timedOut: true }));
    return;
  }
  list.push(tool('g1', 'running'), req('r1', { status: 'pending' }));
  Object.assign(s, { status: 'waiting', activity: `Waiting for your OK: ${guard.title}` });
  s.pendingRequest = pendingSummary(list);
}

function hhmm(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
