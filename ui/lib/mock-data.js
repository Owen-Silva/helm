// Worked example of every protocol shape (docs/PROTOCOL.md). Used by the mock transport
// (?mock=1) so UI lanes can build and screenshot without the engine. Keep it realistic:
// long paths, long outputs, nested subagents, a pending question and a pending permission.
import { simpleChoice, questionsOf } from '../deck/choice.js';
import { applyGuardMock } from './mock-guard.js';   // lane guard

const now = Date.now();
const min = 60_000;

export const settings = {
  // Look Sync (PROTOCOL "Look Sync"): ?bgmode=own previews the own-picture mode
  background: { kind: 'image', mode: new URLSearchParams(globalThis.location?.search || '').get('bgmode') === 'own' ? 'own' : 'desktop', file: 'wallpaper.png', blur: 5, dim: 0.5 },
  glass: { dark: { blurPx: 5, dim: 0.5, panel: 0 }, light: { blurPx: 12, dim: 0.45, panel: 0 }, render: 'picture' },
  accentHue: null,
  accentTokens: null,
  lookSync: { enabled: true },
  // Uploaded files come first, then the bundled set (main/settings.js lists <userData>/backgrounds + ui/assets/backgrounds).
  backgrounds: ['wallpaper.png', 'forest.jpg', 'lake.jpg', 'stone.jpg'],
  // ?theme=light|system previews the light look (lane wk-light); default dark
  theme: ['light', 'system'].includes(new URLSearchParams(globalThis.location?.search || '').get('theme')) ? new URLSearchParams(globalThis.location.search).get('theme') : 'dark',
  defaults: { model: 'claude-opus-5-5', effort: 'xhigh', permissionMode: 'bypassPermissions', cwd: 'C:\\Users\\you' },
  projects: [
    { cwd: 'C:\\Users\\you\\code\\storefront', name: 'storefront', pinned: true },
    { cwd: 'C:\\Users\\you\\code\\booking-portal', name: 'booking-portal', pinned: true },
    { cwd: 'C:\\Users\\you\\helm', name: 'helm', pinned: false },
    { cwd: 'C:\\Users\\you\\code\\api-server', name: 'api-server', pinned: false },
  ],
  snippets: [
    { id: 'sn1', name: 'Ship check', text: 'Run the full test suite and report the summary line, then show git diff --stat.' },
    { id: 'sn2', name: 'Mobile check', text: 'Verify this change at 393px and 320px and prove 1280 is unmoved.' },
  ],
  // lane presets: launch presets for the New session dialog (PROTOCOL "Launch presets")
  presets: [
    { id: 'pr_storefront', name: 'Storefront fix', cwd: 'C:\\Users\\you\\code\\storefront', model: 'claude-opus-5-5', effort: 'xhigh', permissionMode: 'bypassPermissions' },
    { id: 'pr_review', name: 'Helm review', cwd: 'C:\\Users\\you\\helm', model: 'claude-opus-5-5', effort: 'high', permissionMode: 'plan', prompt: 'Review the uncommitted diff for correctness bugs. Report findings only.' },
  ],
  notifications: { waiting: true, done: true, error: true },
  phone: { enabled: true, url: 'https://my-pc.example.ts.net/?key=demo', httpUrl: 'http://my-pc.example.ts.net:4871/?key=demo' },
  // Round 3
  launchAtLogin: false,
  notifyContextHandoff: true,
  quickPromptHotkey: 'Control+Alt+Space',
};

const base = { model: 'claude-opus-5-5', effort: 'xhigh', permissionMode: 'bypassPermissions', pinned: false, queued: 0 };

export const sessions = [
  { ...base, id: 's_storefront', claudeSessionId: '6b1d6c1e-2f0a-4d7e-9c55-0d6c2b8f1a11', title: 'Fix the login redirect loop',
    cwd: 'C:\\Users\\you\\code\\storefront', project: 'storefront', status: 'working', createdAt: now - 42 * min, updatedAt: now - 5000,
    costUsd: 3.84, context: { usedTokens: 212000, windowTokens: 1000000, percent: 21.2 }, activity: 'Running npm test',
    turnStartedAt: now - 3 * min, unread: 0, queued: 1, pinned: true,
    // Round 3: live ETA from the eta mod (null when no snapshot)
    eta: { state: 'working', label: 'Fix the redirect loop', summary: 'Patch auth middleware, add a regression test, run the suite',
      step: 2, steps: ['Trace the loop', 'Patch + test', 'Run the suite', 'Commit locally'], etaAt: now + 14 * min, workStartedAt: now - 28 * min,
      isOverdue: false, agentsRunning: 2, updatedAt: now - 20_000 } },
  { ...base, id: 's_booking', claudeSessionId: 'a0c4e2d9-7d61-4a8e-8d2a-5e9b6f3c0b22', title: 'Customer import preview',
    cwd: 'C:\\Users\\you\\code\\booking-portal', project: 'booking-portal', status: 'waiting', createdAt: now - 90 * min,
    updatedAt: now - 2 * min, costUsd: 1.12, context: { usedTokens: 96000, windowTokens: 1000000, percent: 9.6 },
    activity: 'Waiting for your answer', turnStartedAt: now - 6 * min, unread: 2 },
  { ...base, id: 's_helm', claudeSessionId: 'f3e2d1c0-1111-4b2b-9c9c-7a7a7a7a7a33', title: 'Helm design system', model: 'claude-fable-5-1',
    effort: 'high', cwd: 'C:\\Users\\you\\helm', project: 'helm', status: 'idle', createdAt: now - 3 * 60 * min, updatedAt: now - 25 * min,
    costUsd: 0.61, context: { usedTokens: 41000, windowTokens: 1000000, percent: 4.1 }, activity: null, turnStartedAt: null, unread: 0 },
  { ...base, id: 's_api', claudeSessionId: null, title: 'Scheduler clock drift', cwd: 'C:\\Users\\you\\code\\api-server', project: 'api-server',
    status: 'error', createdAt: now - 5 * 60 * min, updatedAt: now - 70 * min, costUsd: 0.2, context: { usedTokens: 12000, windowTokens: 1000000, percent: 1.2 },
    activity: 'API error: overloaded', turnStartedAt: null, unread: 1, permissionMode: 'default' },
  // Waiting on a permission whose request carries the engine's optional title/description/reason/blockedPath.
  // costUsd/context are null: nothing reported yet (a fresh real session looks like this).
  { ...base, id: 's_mobile', claudeSessionId: '0e7f1a2b-3c4d-4e5f-8a9b-1c2d3e4f5a66', title: 'Bundle size report on release', cwd: 'C:\\Users\\you\\code\\mobile-app',
    project: 'mobile-app', status: 'waiting', createdAt: now - 20 * min, updatedAt: now - 1 * min, costUsd: null, context: null,
    activity: 'Waiting for permission', turnStartedAt: now - 4 * min, unread: 1, permissionMode: 'default', model: 'claude-sonnet-5-5', effort: 'high' },
  // lane deck-pace: waiting on the one-question, three-option ask a user CLAUDE.md makes every session start
  // with; the Deck answers it on the tile (pendingRequest.choice).
  { ...base, id: 's_sim', claudeSessionId: '5b6c7d8e-0000-4f1a-9b2c-3d4e5f6a7b99', title: 'Match simulated load to real traffic', cwd: 'C:\\Users\\you\\code\\simulator',
    project: 'simulator', status: 'waiting', createdAt: now - 3 * min, updatedAt: now - 30_000, costUsd: 0.04, context: { usedTokens: 31000, windowTokens: 1000000, percent: 3.1 },
    activity: 'Waiting for your answer', turnStartedAt: now - 2 * min, unread: 1 },
  // lane stall: a turn with no stream event for 12 min ("Stalled · 12m" + Resume); one agent stopped by the user's
  // interrupt earlier, one running agent quiet for 13 min (agentsQuiet).
  { ...base, id: 's_stall', claudeSessionId: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c44', title: 'Release notes for v1.3.2', cwd: 'C:\\Users\\you\\code\\storefront',
    project: 'storefront', status: 'working', createdAt: now - 50 * min, updatedAt: now - 12 * min, costUsd: 0.88, context: { usedTokens: 132000, windowTokens: 1000000, percent: 13.2 },
    activity: 'Running npm run build', turnStartedAt: now - 19 * min, unread: 0, agentsRunning: 1, agentsQuiet: 1, stalledSince: now - 12 * min - 20_000 },
];

// Deck summary (lane deck, PROTOCOL "Deck summary"): lastText = tail of the latest main-thread reply,
// pendingRequest = the oldest request waiting on the user (matches the pending request items below).
const deckSummary = {
  s_storefront: { lastText: 'The loop is the auth middleware running on /login itself. Patched it to skip /login and carry ?next=, added a regression test; running the full suite now.', pendingRequest: null },
  s_booking: { lastText: 'The CSV has **3 repeated header rows** (one per region). Preview: 41 customers, 2 duplicates by email, 1 missing country.',
    pendingRequest: { requestId: 'req_q1', itemId: 't4', kind: 'question', toolName: 'AskUserQuestion', title: 'Two customers share an email with an existing account. How should I handle them?',
      detail: 'Link to the existing account (Recommended) · Create new accounts · Skip them', count: 1 } },
  s_helm: { lastText: 'Desaturated blue it is. The tokens live in ui/styles/tokens.css.', pendingRequest: null },
  s_api: { lastText: 'The drift comes from the clock re-arming on a 60 s interval instead of aligning to the next minute boundary.', pendingRequest: null },
  s_mobile: { lastText: 'The report path in the config points outside the project, so I need your OK to write it.',
    pendingRequest: { requestId: 'req_cw', itemId: 'c4', kind: 'permission', toolName: 'Write', title: 'Claude wants to write bundle-size-report.md',
      detail: 'C:\\Users\\you\\Documents\\reports\\bundle-size-report.md', count: 1 } },
  s_sim: { lastText: 'Before I fan this out: the fit splits cleanly into three lanes (loader, rate sweep, comparison plots).',
    pendingRequest: null },   // filled from the s_sim items below by pendingSummary()
};
for (const s of sessions) Object.assign(s, deckSummary[s.id] || { lastText: null, pendingRequest: null });

// lane presets: Session.pendingRequest from a transcript (oldest pending request item, or null), the way
// main/engine/session.js builds it. Used by the mock sessions.respond and main/engine-fallback.js.
export function pendingSummary(items) {
  const pending = (items || []).filter((i) => i.type === 'request' && i.status === 'pending');
  const it = pending[0];
  if (!it) return null;
  const inp = it.input || {};
  const q = questionsOf(it)?.[0];
  const line = (x) => (typeof x === 'string' && x.trim() ? x.trim().split('\n')[0].slice(0, 280) : null);
  const title = it.title || (it.kind === 'question' ? q?.question || 'Claude has a question' : it.kind === 'plan' ? 'A plan is ready for review' : `Allow ${it.toolName}?`);
  const detail = it.kind === 'question' ? (q?.options || []).map((o) => o.label).join(' · ') || null
    : it.kind === 'plan' ? line(inp.plan) : line(inp.command) || inp.file_path || inp.url || null;
  const choice = it.kind === 'question' ? simpleChoice(questionsOf(it)) : null;
  return { requestId: it.requestId, itemId: it.id, kind: it.kind, toolName: it.toolName, title, detail,
    ...(choice ? { choice } : {}),
    ...(it.parentToolUseId ? { parentToolUseId: it.parentToolUseId } : {}), count: pending.length };
}

// Extra sessions for the sessions-org mock (?mock=1&org=1): one idle for 9 days, one archived.
export const sessionsOrg = [
  { ...base, id: 's_old', claudeSessionId: '9a8b7c6d-0000-4e5f-8a9b-1c2d3e4f5a77', title: 'Tray icon audit', cwd: 'C:\\Users\\you\\helm', project: 'helm',
    status: 'idle', createdAt: now - 10 * 24 * 60 * min, updatedAt: now - 9 * 24 * 60 * min, costUsd: 0.31, context: null, activity: null, turnStartedAt: null, unread: 0, archived: false },
  { ...base, id: 's_arch', claudeSessionId: '1f2e3d4c-0000-4b5a-9c8d-7e6f5a4b3c88', title: 'Old pricing page copy', cwd: 'C:\\Users\\you\\code\\storefront', project: 'storefront',
    status: 'closed', createdAt: now - 20 * 24 * 60 * min, updatedAt: now - 12 * 24 * 60 * min, costUsd: 0.88, context: null, activity: null, turnStartedAt: null, unread: 0, archived: true },
  // lane sessions (Past): idle 3 h and 2 days (Past), pinned and idle 5 days (stays in the list), empty for 2 days (hidden)
  { ...base, id: 's_3h', claudeSessionId: '2b3c4d5e-0000-4a1b-8c2d-3e4f5a6b7c01', title: 'Sidebar spacing pass', cwd: 'C:\\Users\\you\\helm', project: 'helm',
    status: 'idle', createdAt: now - 5 * 60 * min, updatedAt: now - 3 * 60 * min, costUsd: 0.64, context: null, activity: null, turnStartedAt: null, unread: 0, archived: false },
  { ...base, id: 's_2d', claudeSessionId: '2b3c4d5e-0000-4a1b-8c2d-3e4f5a6b7c02', title: 'Fee model check', cwd: 'C:\\Users\\you\\code\\mobile-app', project: 'mobile-app',
    status: 'closed', createdAt: now - 50 * 60 * min, updatedAt: now - 2 * 24 * 60 * min, costUsd: 1.9, context: null, activity: null, turnStartedAt: null, unread: 0, archived: false },
  { ...base, id: 's_pin', claudeSessionId: '2b3c4d5e-0000-4a1b-8c2d-3e4f5a6b7c03', title: 'Release checklist', cwd: 'C:\\Users\\you\\code\\storefront', project: 'storefront', pinned: true,
    status: 'idle', createdAt: now - 6 * 24 * 60 * min, updatedAt: now - 5 * 24 * 60 * min, costUsd: 0.4, context: null, activity: null, turnStartedAt: null, unread: 0, archived: false },
  { ...base, id: 's_empty', claudeSessionId: null, title: 'New session', cwd: 'C:\\Users\\you\\code\\api-server', project: 'api-server',
    status: 'closed', createdAt: now - 2 * 24 * 60 * min, updatedAt: now - 2 * 24 * 60 * min, costUsd: 0, context: null, activity: null, turnStartedAt: null, unread: 0, archived: false },
];

const editOld = `  if (!session) {\n    return res.redirect('/login');\n  }`;
const editNew = `  if (!session) {\n    const next = encodeURIComponent(req.originalUrl);\n    return res.redirect(\`/login?next=\${next}\`);\n  }\n  if (req.path === '/login') return next();`;

// lane bang: output of the seeded `!npm run lint` card (long enough to fold)
const MOCK_LINT = ['> storefront@1.3.1 lint', '> eslint src test', '', ...[
  ['src/middleware/auth.js', '14:7', "'nextUrl' is assigned a value but never used", 'no-unused-vars'],
  ['src/middleware/auth.js', '31:3', 'Unexpected console statement', 'no-console'],
  ['src/routes/dashboard.js', '8:1', 'Import order: "express" should come first', 'import/order'],
  ['src/routes/login.js', '22:11', 'Expected === and instead saw ==', 'eqeqeq'],
  ['test/auth-redirect.test.js', '5:1', 'Unexpected skipped test', 'jest/no-disabled-tests'],
].flatMap(([f, at, msg, rule]) => [f, `  ${at}  ${rule === 'no-console' || rule === 'import/order' ? 'warning' : 'error  '}  ${msg}  ${rule}`, '']),
  '✖ 5 problems (3 errors, 2 warnings)', '  1 error and 1 warning potentially fixable with the `--fix` option.', ''].join('\n');

export const items = {
  s_storefront: [
    { id: 'i1', type: 'system', subtype: 'init', ts: now - 42 * min, text: 'Claude Code 2.1.294 · claude-opus-5-5 · C:\\Users\\you\\code\\storefront · 14 MCP tools · 9 skills' },
    { id: 'i2', type: 'user', uuid: '9a1b2c3d-0001-4e5f-8a9b-000000000002', ts: now - 41 * min, text: 'Logged-out users hitting /dashboard get stuck in a redirect loop between /login and /dashboard. Find it and fix it, then run the tests.', attachments: [] },
    { id: 'i3', type: 'thinking', ts: now - 41 * min, streaming: false, text: 'The loop suggests the auth middleware runs on /login itself. Check src/middleware/auth.js and the route order in server.js before touching anything.' },
    { id: 'i4', type: 'assistant', ts: now - 40 * min, streaming: false, model: 'claude-opus-5-5', text: "I'll trace the redirect. First the auth middleware and where it's mounted." },
    { id: 'i5', type: 'tool', ts: now - 40 * min, toolUseId: 'toolu_g1', name: 'Grep', status: 'done', startedAt: now - 40 * min, endedAt: now - 40 * min + 900,
      input: { pattern: "redirect\\('/login'", path: 'src', output_mode: 'content' },
      result: "src/middleware/auth.js:14:    return res.redirect('/login');\nsrc/routes/account.js:88:  res.redirect('/login');" },
    { id: 'i6', type: 'tool', ts: now - 39 * min, toolUseId: 'toolu_r1', name: 'Read', status: 'done', startedAt: now - 39 * min, endedAt: now - 39 * min + 300,
      input: { file_path: 'C:\\Users\\you\\code\\storefront\\src\\middleware\\auth.js', offset: 1, limit: 40 },
      result: "1\tconst { getSession } = require('../session');\n2\t\n3\tmodule.exports = async function requireAuth(req, res, next) {\n...\n14\t    return res.redirect('/login');\n15\t  }\n16\t  next();\n17\t};" },
    { id: 'i7', type: 'assistant', ts: now - 38 * min, streaming: false, model: 'claude-opus-5-5',
      text: "Found it. `requireAuth` is mounted **globally** in `server.js`, before the `/login` route, so the login page itself requires a session:\n\n```js\napp.use(requireAuth);          // line 61 — runs for every path\napp.get('/login', loginPage);  // line 74 — never reached logged-out\n```\n\nTwo fixes:\n1. Let `/login` (and static assets) through the middleware.\n2. Keep the original URL in `?next=` so users land where they meant to go." },
    { id: 'i8', type: 'tool', ts: now - 37 * min, toolUseId: 'toolu_t1', name: 'TodoWrite', status: 'done', startedAt: now - 37 * min, endedAt: now - 37 * min + 50,
      input: { todos: [
        { content: 'Let /login bypass requireAuth', status: 'completed', activeForm: 'Letting /login bypass requireAuth' },
        { content: 'Preserve ?next= on redirect', status: 'completed', activeForm: 'Preserving ?next=' },
        { content: 'Add a regression test for the loop', status: 'in_progress', activeForm: 'Adding a regression test' },
        { content: 'Run the full suite', status: 'pending', activeForm: 'Running the full suite' },
      ] }, result: 'Todos updated' },
    { id: 'i9', type: 'tool', ts: now - 36 * min, toolUseId: 'toolu_e1', name: 'Edit', status: 'done', startedAt: now - 36 * min, endedAt: now - 36 * min + 200,
      input: { file_path: 'C:\\Users\\you\\code\\storefront\\src\\middleware\\auth.js', old_string: editOld, new_string: editNew },
      result: 'The file C:\\Users\\you\\code\\storefront\\src\\middleware\\auth.js has been updated successfully.' },
    { id: 'i10', type: 'tool', ts: now - 30 * min, toolUseId: 'toolu_a1', name: 'Agent', status: 'done', startedAt: now - 30 * min, endedAt: now - 12 * min,
      input: { description: '[lane:tests] regression test for redirect loop', subagent_type: 'opus-high', prompt: 'Write a supertest regression test proving a logged-out GET /dashboard ends at /login?next=%2Fdashboard in at most one redirect...' },
      result: 'Added test/auth-redirect.test.js (3 cases). All 3 pass. No other files touched.' },
    { id: 'i11', type: 'tool', ts: now - 29 * min, toolUseId: 'toolu_a1w', name: 'Write', status: 'done', parentToolUseId: 'toolu_a1', startedAt: now - 29 * min, endedAt: now - 29 * min + 100,
      input: { file_path: 'C:\\Users\\you\\code\\storefront\\test\\auth-redirect.test.js', content: "const request = require('supertest');\nconst app = require('../server');\n\ntest('logged-out /dashboard goes to /login once', async () => {\n  const res = await request(app).get('/dashboard');\n  expect(res.status).toBe(302);\n  expect(res.headers.location).toBe('/login?next=%2Fdashboard');\n});\n" },
      result: 'File created successfully' },
    { id: 'i12', type: 'tool', ts: now - 20 * min, toolUseId: 'toolu_a1b', name: 'Bash', status: 'done', parentToolUseId: 'toolu_a1', startedAt: now - 20 * min, endedAt: now - 19 * min,
      input: { command: 'npx jest test/auth-redirect.test.js', description: 'Run the new regression test' },
      result: 'PASS test/auth-redirect.test.js\n  ✓ logged-out /dashboard goes to /login once (41 ms)\n  ✓ /login itself is reachable logged-out (12 ms)\n  ✓ next= survives encoding (9 ms)\n\nTests:       3 passed, 3 total' },
    { id: 'i13', type: 'result', ts: now - 12 * min, durationMs: 29 * min + 14_000, costUsd: 2.91, numTurns: 18, isError: false, usage: { input: 18000, output: 9400, cacheRead: 1_240_000, cacheWrite: 61000 } },
    // lane bang: a `!` run Claude has already seen (it went with i14)
    { id: 'sh_5eed0001', type: 'shell', ts: now - 5 * min, command: 'git log --oneline -3', cwd: 'C:\\Users\\you\\code\\storefront', shell: 'bash',
      text: 'a41c9e2 Auth: skip the guard on /login and /signup\n7d03b18 Add redirect-loop regression test\n19fe6c0 v1.3.1.1 changelog\n', stdout: 'a41c9e2 Auth: skip the guard on /login and /signup\n7d03b18 Add redirect-loop regression test\n19fe6c0 v1.3.1.1 changelog\n', stderr: '',
      exitCode: 0, status: 'done', startedAt: now - 5 * min, endedAt: now - 5 * min + 380, shared: true },
    { id: 'i14', type: 'user', uuid: '9a1b2c3d-0001-4e5f-8a9b-000000000014', ts: now - 4 * min, text: 'Nice. Run the whole suite now and show me the summary line.', attachments: [] },
    { id: 'i15', type: 'tool', ts: now - 3 * min, toolUseId: 'toolu_b2', name: 'Bash', status: 'running', startedAt: now - 3 * min,
      input: { command: 'npm test -- --silent 2>&1 | tail -20', description: 'Run the full test suite' }, result: '' },
    // lane bang: a `!` run during the turn, not seen by Claude yet (goes with the next prompt sent)
    { id: 'sh_5eed0002', type: 'shell', ts: now - 90_000, command: 'npm run lint', cwd: 'C:\\Users\\you\\code\\storefront', shell: 'bash',
      text: MOCK_LINT, stdout: MOCK_LINT, stderr: '', exitCode: 1, status: 'done', startedAt: now - 90_000, endedAt: now - 90_000 + 4_200, shared: false },
    { id: 'i16', type: 'user', ts: now - 60_000, text: 'Then commit it locally, no push.', attachments: [], queued: true },
  ],
  s_booking: [
    { id: 't1', type: 'user', ts: now - 8 * min, text: 'Preview the new customer CSV before committing anything.', attachments: [{ kind: 'file', name: 'customers-2026.csv', mime: 'text/csv', path: 'C:\\Users\\you\\Downloads\\customers-2026.csv' }] },
    { id: 't2', type: 'assistant', ts: now - 7 * min, streaming: false, text: 'The CSV has **3 repeated header rows** (one per region). Preview: 41 customers, 2 duplicates by email, 1 missing country.' },
    { id: 't3', type: 'tool', ts: now - 6 * min, toolUseId: 'toolu_q1', name: 'AskUserQuestion', status: 'running', startedAt: now - 6 * min,
      input: { questions: [] }, result: '' },
    { id: 't4', type: 'request', ts: now - 6 * min, requestId: 'req_q1', kind: 'question', toolName: 'AskUserQuestion', status: 'pending', input: {},
      questions: [
        { question: 'Two customers share an email with an existing account. How should I handle them?', header: 'Duplicates', multiSelect: false,
          options: [
            { label: 'Link to the existing account (Recommended)', description: 'Adds the customers under the account that already has that email.' },
            { label: 'Create new accounts', description: 'Keeps them separate; you merge later.' },
            { label: 'Skip them', description: 'Leaves both out of this import.' },
          ] },
        { question: 'Which regions should this import touch?', header: 'Regions', multiSelect: true,
          options: [
            { label: 'North America', description: '18 customers' }, { label: 'Europe', description: '15 customers' }, { label: 'APAC', description: '8 customers' },
          ] },
      ] },
  ],
  s_helm: [
    { id: 'h1', type: 'user', ts: now - 30 * min, text: 'What tokens does docs-site use for its glass?', attachments: [] },
    { id: 'h2', type: 'assistant', ts: now - 29 * min, streaming: false, text: 'docs-site defines everything under `--lg-*` in `src/styles/glass.css`.' },
    { id: 'h3', type: 'result', ts: now - 29 * min, subtype: 'success', durationMs: 28_000, costUsd: 0.08, numTurns: 2, isError: false, usage: { input: 900, output: 300, cacheRead: 40000, cacheWrite: 2000 } },
    { id: 'h4', type: 'user', ts: now - 27 * min, text: 'Port them to Helm. Ask me anything you need.', attachments: [] },
    { id: 'h5', type: 'tool', ts: now - 26 * min, toolUseId: 'toolu_hq', name: 'AskUserQuestion', status: 'done', startedAt: now - 26 * min, endedAt: now - 25 * min,
      input: { questions: [{ question: 'Which accent should state colours use?', header: 'Accent', multiSelect: false, options: [{ label: 'Desaturated blue' }, { label: 'Warm grey' }] }] },
      answers: { 'Which accent should state colours use?': 'Desaturated blue' }, result: 'User answered: Desaturated blue' },
    { id: 'h6', type: 'request', ts: now - 26 * min, requestId: 'req_hq', kind: 'question', toolName: 'AskUserQuestion', toolUseId: 'toolu_hq', status: 'answered', input: {},
      questions: [{ question: 'Which accent should state colours use?', header: 'Accent', multiSelect: false,
        options: [{ label: 'Desaturated blue', description: 'Matches the docs-site header.' }, { label: 'Warm grey', description: 'No colour at all; state by weight only.' }] }],
      answer: { answers: { 'Which accent should state colours use?': 'Desaturated blue' } } },
    { id: 'h7', type: 'assistant', ts: now - 25 * min, streaming: false, model: 'claude-fable-5-1', text: 'Desaturated blue it is. The tokens live in ui/styles/tokens.css.' },
    { id: 'h8', type: 'result', ts: now - 25 * min, subtype: 'success', durationMs: 61_000, costUsd: 0.21, numTurns: 4, isError: false, usage: { input: 2100, output: 900, cacheRead: 88000, cacheWrite: 4000 } },
  ],
  s_api: [
    { id: 'm1', type: 'user', ts: now - 72 * min, text: 'The job scheduler drifts a minute behind after sleep. Why?', attachments: [] },
    { id: 'm2', type: 'tool', ts: now - 71 * min, toolUseId: 'toolu_mp', name: 'Bash', status: 'denied', startedAt: now - 71 * min, endedAt: now - 71 * min,
      input: { command: 'git push --force origin main', description: 'Force-push main' }, result: 'Blocked by rails: force-push' },
    { id: 'm3', type: 'request', ts: now - 71 * min, requestId: 'req_p1', kind: 'permission', toolName: 'Bash', status: 'answered', answer: { behavior: 'deny', message: 'never force-push main' },
      input: { command: 'git push --force origin main', description: 'Force-push main' } },
    { id: 'm4', type: 'system', subtype: 'error', ts: now - 70 * min, text: 'API Error: 529 overloaded. The turn stopped; send again to retry.' },
    { id: 'm5', type: 'result', ts: now - 70 * min, subtype: 'error_during_execution', durationMs: 4_200, costUsd: null, numTurns: 1, isError: true, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    { id: 'm6', type: 'user', uuid: '9a1b2c3d-0001-4e5f-8a9b-0000000000a6', ts: now - 70 * min, text: 'Then rebuild the worker and restart the API.', attachments: [], queued: false, cancelled: true },
    { id: 'm7', type: 'system', subtype: 'interrupted', ts: now - 70 * min, text: 'Interrupted. 1 queued prompt was not sent.' },
    { id: 'm8', type: 'result', ts: now - 70 * min, subtype: 'error_during_execution', durationMs: 600, costUsd: 0, numTurns: 1, isError: false, interrupted: true, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
  ],
  s_mobile: [
    { id: 'c1', type: 'user', ts: now - 5 * min, text: 'Run the bundle size report on the release build and save it next to the config.', attachments: [] },
    { id: 'c2', type: 'assistant', ts: now - 4 * min, streaming: false, model: 'claude-sonnet-5-5', text: 'The report path in the config points outside the project, so I need your OK to write it.' },
    { id: 'c3', type: 'tool', ts: now - 4 * min, toolUseId: 'toolu_cw', name: 'Write', status: 'running', startedAt: now - 4 * min,
      input: { file_path: 'C:\\Users\\you\\Documents\\reports\\bundle-size-report.md', content: '# Bundle size report (release)\n\nTotal 1.84 MB · largest chunk vendor.js 612 KB\n' }, result: '' },
    { id: 'c4', type: 'request', ts: now - 4 * min, requestId: 'req_cw', kind: 'permission', toolName: 'Write', toolUseId: 'toolu_cw', status: 'pending',
      input: { file_path: 'C:\\Users\\you\\Documents\\reports\\bundle-size-report.md', content: '# Bundle size report (release)\n\nTotal 1.84 MB · largest chunk vendor.js 612 KB\n' },
      title: 'Claude wants to write bundle-size-report.md', description: 'Save the size report',
      reason: 'Path is outside the allowed working directories', blockedPath: 'C:\\Users\\you\\Documents\\reports\\bundle-size-report.md' },
  ],
  s_sim: [
    { id: 'f1', type: 'user', ts: now - 3 * min, text: 'Fit the simulated request rates to the production traces and show me where they disagree with real traffic.', attachments: [] },
    { id: 'f2', type: 'assistant', ts: now - 2 * min, streaming: false, model: 'claude-opus-5-5', text: 'Before I fan this out: the fit splits cleanly into three lanes (loader, rate sweep, comparison plots).' },
    { id: 'f3', type: 'tool', ts: now - 2 * min, toolUseId: 'toolu_sub', name: 'AskUserQuestion', status: 'running', startedAt: now - 2 * min, input: { questions: [] }, result: '' },
    { id: 'f4', type: 'request', ts: now - 2 * min, requestId: 'req_sub', kind: 'question', toolName: 'AskUserQuestion', toolUseId: 'toolu_sub', status: 'pending', input: {},
      questions: [{ question: 'Let agents spawn sub-agents this session?', header: 'Sub-agents', multiSelect: false, options: [
        { label: 'Yes, one level below them (grandchildren never spawn)', description: 'Each agent may spawn helpers split by file; those helpers never spawn.' },
        { label: 'No', description: 'Every agent works alone with direct tool calls.' },
        { label: 'Free rein', description: 'Agents spawn as many sub-agents as they judge useful, at any depth.' },
      ] }] },
  ],
};
// s_sim's summary is built from its items, exactly as the engine would (includes pendingRequest.choice).
for (const s of sessions) if (s.id === 's_sim') s.pendingRequest = pendingSummary(items.s_sim);
// lane guard: ?guard=1|auto|done adds a production-guard card / line to s_storefront (no-op without the flag)
applyGuardMock({ sessions, items, pendingSummary });

export const fleet = {
  s_storefront: [
    { id: 'toolu_a1', sessionId: 's_storefront', parentId: null, depth: 0, description: '[lane:tests] regression test for redirect loop', subagentType: 'opus-high',
      status: 'done', startedAt: now - 30 * min, endedAt: now - 12 * min, context: { usedTokens: 88000, windowTokens: 1000000, percent: 8.8 }, toolCount: 14, lastTool: 'Bash', costUsd: 0.94 },
    { id: 'toolu_a2', sessionId: 's_storefront', parentId: null, depth: 0, description: '[lane:audit] audit other redirects for the same bug', subagentType: 'opus-high',
      status: 'running', startedAt: now - 9 * min, context: { usedTokens: 241000, windowTokens: 1000000, percent: 24.1 }, toolCount: 31, lastTool: 'Grep', costUsd: 1.3 },
    { id: 'toolu_a3', sessionId: 's_storefront', parentId: 'toolu_a2', depth: 1, description: '[lane:audit-routes] scan src/routes', subagentType: 'opus-high',
      status: 'running', startedAt: now - 6 * min, context: { usedTokens: 336000, windowTokens: 1000000, percent: 33.6, estimated: true }, toolCount: 22, lastTool: 'Read', costUsd: 0.7,
      model: 'claude-fable-5-1', background: false },
    // Just started in the background: no context, tools or cost reported yet.
    { id: 'toolu_a4', sessionId: 's_storefront', parentId: null, depth: 0, description: '[lane:docs] update the changelog entry', subagentType: 'general-purpose',
      status: 'running', startedAt: now - 20_000, context: null, toolCount: 0, lastTool: null, model: 'claude-sonnet-5-5', background: true },
    // Timeline mode (lane fleet-timeline): finished lanes, a nested child and one error, 4 at once around now-24m.
    { id: 'toolu_a5', sessionId: 's_storefront', parentId: null, depth: 0, description: '[lane:repro] reproduce the loop in a browser', subagentType: 'opus-high',
      status: 'done', startedAt: now - 34 * min, endedAt: now - 22 * min, context: { usedTokens: 142000, windowTokens: 1000000, percent: 14.2 }, toolCount: 19, lastTool: 'Bash', costUsd: 0.61 },
    { id: 'toolu_a6', sessionId: 's_storefront', parentId: 'toolu_a1', depth: 1, description: '[lane:fixture] build the logged-out session fixture', subagentType: 'opus-high',
      status: 'done', startedAt: now - 27 * min, endedAt: now - 21 * min, context: { usedTokens: 54000, windowTokens: 1000000, percent: 5.4 }, toolCount: 8, lastTool: 'Write', costUsd: 0.22 },
    { id: 'toolu_a7', sessionId: 's_storefront', parentId: null, depth: 0, description: '[lane:e2e] run the full e2e suite', subagentType: 'opus-high',
      status: 'error', startedAt: now - 26 * min, endedAt: now - 19 * min, context: { usedTokens: 97000, windowTokens: 1000000, percent: 9.7 }, toolCount: 11, lastTool: 'Bash', costUsd: 0.38 },
    // lane fleet: stopped when an earlier CLI exited (no completion record): end from its own transcript,
    // one whose end is unknown, and one resumed with SendMessage (its first run kept in runs).
    { id: 'toolu_a8', sessionId: 's_storefront', parentId: null, depth: 0, description: '[lane:perf] profile the login page', subagentType: 'opus-high',
      status: 'stopped', startedAt: now - 300 * min, endedAt: now - 266 * min, endEstimated: true, context: { usedTokens: 120000, windowTokens: 1000000, percent: 12 }, toolCount: 17, lastTool: 'Bash', background: true },
    { id: 'toolu_a9', sessionId: 's_storefront', parentId: null, depth: 0, description: '[lane:css] tidy auth form styles', subagentType: 'opus-high',
      status: 'stopped', startedAt: now - 280 * min, toolCount: 6, lastTool: 'Edit', background: true },
    { id: 'toolu_a10', sessionId: 's_storefront', parentId: null, depth: 0, description: '[lane:review] review the redirect fix', subagentType: 'opus-high',
      status: 'running', startedAt: now - 70 * min, resumedAt: now - 2 * min, runs: [{ startedAt: now - 70 * min, endedAt: now - 48 * min }],
      context: { usedTokens: 150000, windowTokens: 1000000, percent: 15 }, toolCount: 12, lastTool: 'Read', background: true },
  ],
  // lane stall: stopped by an interrupt (exact end from the CLI's killed event) and a quiet running agent.
  s_stall: [
    { id: 'toolu_s1', sessionId: 's_stall', parentId: null, depth: 0, description: '[lane:notes] draft the release notes', subagentType: 'opus-high',
      status: 'stopped', stopReason: 'interrupted', startedAt: now - 44 * min, endedAt: now - 31 * min, context: { usedTokens: 92000, windowTokens: 1000000, percent: 9.2 }, toolCount: 9, lastTool: 'Read', background: true },
    { id: 'toolu_s2', sessionId: 's_stall', parentId: null, depth: 0, description: '[lane:shots] capture the release screenshots', subagentType: 'opus-high',
      status: 'running', startedAt: now - 28 * min, lastActivityAt: now - 13 * min, quiet: true, context: { usedTokens: 64000, windowTokens: 1000000, percent: 6.4 }, toolCount: 5, lastTool: 'Bash', background: true },
    { id: 'toolu_s3', sessionId: 's_stall', parentId: null, depth: 0, description: '[lane:links] check the changelog links', subagentType: 'opus-high',
      status: 'done', startedAt: now - 40 * min, endedAt: now - 33 * min, context: { usedTokens: 41000, windowTokens: 1000000, percent: 4.1 }, toolCount: 7, lastTool: 'WebFetch', costUsd: 0.21 },
  ],
  // An earlier burst in another session (All sessions grouping; the idle gap collapses on the timeline).
  s_helm: [
    { id: 'toolu_h1', sessionId: 's_helm', parentId: null, depth: 0, description: '[lane:tokens] audit tokens.css contrast', subagentType: 'opus-high',
      status: 'done', startedAt: now - 150 * min, endedAt: now - 118 * min, context: { usedTokens: 188000, windowTokens: 1000000, percent: 18.8 }, toolCount: 27, lastTool: 'Edit', costUsd: 1.12 },
    { id: 'toolu_h2', sessionId: 's_helm', parentId: null, depth: 0, description: '[lane:light] light theme pass', subagentType: 'opus-high',
      status: 'done', startedAt: now - 131 * min, endedAt: now - 104 * min, context: { usedTokens: 162000, windowTokens: 1000000, percent: 16.2 }, toolCount: 23, lastTool: 'Edit', costUsd: 0.97 },
  ],
};

export const usage = { fiveHour: { percent: 37, resetsAt: now + 2 * 60 * min + 14 * min }, week: { percent: 11, resetsAt: now + 4 * 24 * 60 * min }, costTodayUsd: 41.2, costTodayScope: 'helm', source: 'statusline', updatedAt: now - 20_000 };
// What the engine sends before any session has reported limits (mock: add &usage=unknown to the URL).
export const usageUnknown = { fiveHour: null, week: null, costTodayUsd: 0.42, costTodayScope: 'helm', source: null, updatedAt: null,
  reason: 'no live session has reported limits yet; status line file not found' };

export const queue = [
  { id: 'q1', prompt: 'Audit every storefront page at 393px and 320px; fix anything that overflows, local commits only.', cwd: 'C:\\Users\\you\\code\\storefront',
    model: 'claude-opus-5-5', effort: 'xhigh', permissionMode: 'bypassPermissions', runAfter: now + 5 * 60 * min, maxFiveHourPercent: 85, status: 'queued', createdAt: now - 10 * min },
  { id: 'q2', prompt: 'Regenerate the search index and diff it against prod.', cwd: 'C:\\Users\\you\\code\\storefront', model: 'claude-opus-5-5', effort: 'high',
    permissionMode: 'bypassPermissions', runAfter: null, maxFiveHourPercent: 85, status: 'done', sessionId: 's_storefront', summary: 'Index regenerated: 412 entries, 3 changed.', createdAt: now - 9 * 60 * min },
  { id: 'q3', prompt: 'Run the api-server integration suite and file every failure as a TODO.', cwd: 'C:\\Users\\you\\code\\api-server', model: 'claude-opus-5-5', effort: 'high',
    permissionMode: 'bypassPermissions', runAfter: null, maxFiveHourPercent: 30, status: 'queued', waitReason: "5-hour usage is 37%, above this job's 30% limit", createdAt: now - 25 * min },
  { id: 'q4', prompt: 'Rebuild the crash-free sessions dashboard', cwd: 'C:\\Users\\you\\code\\mobile-app', model: 'claude-opus-5-5', effort: 'high', permissionMode: 'bypassPermissions',
    runAfter: null, maxFiveHourPercent: 85, status: 'failed', summary: 'Stopped: the release build cache is locked by another process.', createdAt: now - 50 * min, startedAt: now - 48 * min, endedAt: now - 33 * min },
  { id: 'q5', prompt: 'Draft the v1.3.2 changelog entry.', cwd: 'C:\\Users\\you\\code\\storefront', model: 'claude-opus-5-5', effort: 'high', permissionMode: 'bypassPermissions',
    runAfter: now + 9 * 60 * min, maxFiveHourPercent: 85, status: 'cancelled', createdAt: now - 3 * 60 * min },
];

export const history = [
  { claudeSessionId: 'c-temp', cwd: 'C:\\Users\\you\\AppData\\Local\\Temp\\helm-e2e-1', project: 'helm-e2e-1', title: 'e2e scratch run', firstPrompt: 'reply with the word ok', lastActivity: now - 2 * 60 * min, messageCount: 4, sizeBytes: 9_000, temp: true },
  { claudeSessionId: 'c1', cwd: 'C:\\Users\\you\\code\\storefront', project: 'storefront', title: 'v1.3.1.1 changelog + X post', firstPrompt: 'ship v1.3.1.1', lastActivity: now - 3 * 24 * 60 * min, messageCount: 412, sizeBytes: 4_200_000, transcriptPath: 'C:\\Users\\you\\.claude\\projects\\C--Users-you-code-storefront\\c1.jsonl' },
  { claudeSessionId: 'c2', cwd: 'C:\\Users\\you\\code\\api-server', project: 'api-server', title: 'Search endpoint ranking', firstPrompt: 'the search endpoint ranks drafts above posts', lastActivity: now - 6 * 24 * 60 * min, messageCount: 188, sizeBytes: 1_900_000, transcriptPath: 'C:\\Users\\you\\.claude\\projects\\C--Users-you-code-api-server\\c2.jsonl' },
  { claudeSessionId: 'c3', cwd: 'C:\\Users\\you\\code\\mobile-app', project: 'mobile-app', title: 'Release build size report', firstPrompt: 'run the bundle size report on release', lastActivity: now - 8 * 24 * 60 * min, messageCount: null, sizeBytes: 47_700_000, transcriptPath: 'C:\\Users\\you\\.claude\\projects\\C--Users-you-code-mobile-app\\c3.jsonl' }, // too big to count: messageCount null
  // lane sessions (Past): a terminal session from this morning, and s_helm's own transcript (Past drops it: Helm owns it)
  { claudeSessionId: 'c4', cwd: 'C:\\Users\\you\\code\\blog', project: 'blog', title: 'Hero shader tuning', firstPrompt: 'the hero shader stutters on scroll', lastActivity: now - 5 * 60 * min, messageCount: 96, sizeBytes: 820_000, transcriptPath: 'C:\\Users\\you\\.claude\\projects\\C--Users-you-code-blog\\c4.jsonl' },
  { claudeSessionId: 'f3e2d1c0-1111-4b2b-9c9c-7a7a7a7a7a33', cwd: 'C:\\Users\\you\\helm', project: 'helm', title: 'Helm design system', firstPrompt: 'design system pass', lastActivity: now - 25 * min, messageCount: 60, sizeBytes: 400_000 },
];

export const commands = [
  { name: 'compact', description: 'Clear conversation history but keep a summary in context', argumentHint: '[instructions]' },
  { name: 'code-review', description: 'Review the current diff for correctness bugs', argumentHint: '[low|medium|high|xhigh|max]' },
  { name: 'autoloop', description: 'Run an unattended 30-minute-tick session', argumentHint: '' },
  { name: 'model', description: 'Set the AI model for this session', argumentHint: '[model]' },
  { name: 'cost', description: 'Show the total cost of this session', argumentHint: '' },
];

export const models = [
  { value: 'claude-opus-5-5', displayName: 'Opus 5.5', description: 'Most capable for complex work' },
  { value: 'claude-fable-5-1', displayName: 'Fable 5.1', description: 'Fast, strong all-rounder' },
  { value: 'claude-sonnet-5-5', displayName: 'Sonnet 5.5', description: 'Balanced speed and capability' },
  { value: 'claude-haiku-5-5', displayName: 'Haiku 5.5', description: 'Fastest' },
];

export const tree = {
  'C:\\Users\\you\\code\\storefront': [
    { name: 'src', path: 'C:\\Users\\you\\code\\storefront\\src', dir: true, size: 0, mtime: now - min },
    { name: 'test', path: 'C:\\Users\\you\\code\\storefront\\test', dir: true, size: 0, mtime: now - 12 * min },
    { name: 'public', path: 'C:\\Users\\you\\code\\storefront\\public', dir: true, size: 0, mtime: now - 3 * 24 * 60 * min },
    { name: 'server.js', path: 'C:\\Users\\you\\code\\storefront\\server.js', dir: false, size: 18_204, mtime: now - 36 * min, gitStatus: 'M' },
    { name: 'package.json', path: 'C:\\Users\\you\\code\\storefront\\package.json', dir: false, size: 2_104, mtime: now - 9 * 24 * 60 * min },
  ],
};

export const changes = {
  s_storefront: [
    { path: 'C:\\Users\\you\\code\\storefront\\src\\middleware\\auth.js', rel: 'src/middleware/auth.js', status: 'M', additions: 4, deletions: 1, touchedBy: ['toolu_e1'] },
    { path: 'C:\\Users\\you\\code\\storefront\\test\\auth-redirect.test.js', rel: 'test/auth-redirect.test.js', status: 'A', additions: 9, deletions: 0, touchedBy: ['toolu_a1w'] },
  ],
};

// Round 3 additions (older pages, external sessions)
export * from './mock-round3.js';
// lane cc-config: Settings -> Claude Code (claudeConfig.*)
export { claudeConfigMock } from './mock-claude-config.js';
export { accountMock, accountHelloAuth } from './mock-account.js';   // lane account: Settings -> Account (account.*)
export { worktreesMock } from './mock-worktrees.js';   // lane helm-worktrees: worktrees.* (H4)

// ---- lane agent-drill: agents.transcript (one subagent's own transcript; see PROTOCOL "Round D additions") ----
// The mock transport answers it: ui/lib/transport.js mockRpc's 'agents.transcript' case calls agentTranscriptMock().
const agentTx = {
  toolu_a2: {
    prompt: '[lane:audit] Audit every other redirect in src/ for the same login-loop bug.\n\nContext ceiling: stay under 40% of your window. Read line ranges, grep, tail output.\n\n## What to check\n- every res.redirect that builds a path from req\n- middleware that runs before auth\n- tests that cover logged-out access\n\nSpawn one sub-agent for src/routes. Report file:line for each hit.',
    items: [
      { id: 'ax1', type: 'assistant', ts: now - 9 * min, streaming: false, model: 'claude-opus-5-5', text: 'I will grep for every `res.redirect` first, then read the middleware order.' },
      { id: 'ax2', type: 'tool', ts: now - 9 * min, toolUseId: 'toolu_ax_g', name: 'Grep', status: 'done', startedAt: now - 9 * min, endedAt: now - 9 * min + 700,
        input: { pattern: 'res\\.redirect\\(', path: 'src', output_mode: 'content', '-n': true }, result: 'src/middleware/auth.js:14:    return res.redirect(`/login?next=${next}`);\nsrc/routes/account.js:41:  return res.redirect(\'/login\');\nsrc/routes/billing.js:88:  res.redirect(req.query.back || \'/\');' },
      { id: 'ax3', type: 'thinking', ts: now - 8 * min, streaming: false, text: 'billing.js:88 trusts req.query.back: that is an open redirect, not the loop. account.js:41 drops the next param.' },
      { id: 'ax4', type: 'tool', ts: now - 8 * min, toolUseId: 'toolu_ax_r', name: 'Read', status: 'done', startedAt: now - 8 * min, endedAt: now - 8 * min + 200,
        input: { file_path: 'C:\\Users\\you\\code\\storefront\\src\\routes\\account.js', offset: 36, limit: 10 }, result: '    36\trouter.get(\'/account\', (req, res) => {\n    37\t  const session = req.session;\n    38\t  if (!session) {\n    39\t    // logged out\n    40\t  }\n    41\t  return res.redirect(\'/login\');\n    42\t});' },
      { id: 'ax5', type: 'tool', ts: now - 7 * min, toolUseId: 'toolu_ax_e', name: 'Edit', status: 'done', startedAt: now - 7 * min, endedAt: now - 7 * min + 150,
        input: { file_path: 'C:\\Users\\you\\code\\storefront\\src\\routes\\account.js', old_string: "  return res.redirect('/login');", new_string: "  return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);" }, result: 'The file has been updated successfully.' },
      { id: 'ax6', type: 'tool', ts: now - 6 * min, toolUseId: 'toolu_a3', name: 'Agent', status: 'running', startedAt: now - 6 * min,
        input: { description: '[lane:audit-routes] scan src/routes', subagent_type: 'opus-high', prompt: 'Scan src/routes for redirects built from request input. Report file:line.' }, result: '' },
      { id: 'ax7', type: 'tool', ts: now - 5 * min, toolUseId: 'toolu_ax3_g', name: 'Glob', status: 'done', parentToolUseId: 'toolu_a3', startedAt: now - 5 * min, endedAt: now - 5 * min + 90,
        input: { pattern: 'src/routes/**/*.js' }, result: 'src/routes/account.js\nsrc/routes/billing.js\nsrc/routes/admin.js' },
      { id: 'ax8', type: 'tool', ts: now - 1 * min, toolUseId: 'toolu_ax3_r', name: 'Read', status: 'running', parentToolUseId: 'toolu_a3', startedAt: now - 1 * min,
        input: { file_path: 'C:\\Users\\you\\code\\storefront\\src\\routes\\admin.js' }, result: '' },
      { id: 'ax9', type: 'assistant', ts: now - 1 * min, streaming: false, model: 'claude-opus-5-5', text: 'Fixed **account.js:41** (it dropped `next`). `billing.js:88` is a separate open-redirect; flagging it rather than fixing. Waiting on the routes scan.' },
    ],
  },
  toolu_a3: {
    prompt: 'Scan src/routes for redirects built from request input. Report file:line.',
    items: [
      { id: 'ay1', type: 'tool', ts: now - 5 * min, toolUseId: 'toolu_ax3_g', name: 'Glob', status: 'done', startedAt: now - 5 * min, endedAt: now - 5 * min + 90,
        input: { pattern: 'src/routes/**/*.js' }, result: 'src/routes/account.js\nsrc/routes/billing.js\nsrc/routes/admin.js' },
      { id: 'ay2', type: 'tool', ts: now - 1 * min, toolUseId: 'toolu_ax3_r', name: 'Read', status: 'running', startedAt: now - 1 * min,
        input: { file_path: 'C:\\Users\\you\\code\\storefront\\src\\routes\\admin.js' }, result: '' },
    ],
  },
  toolu_a1: {
    prompt: '[lane:tests] Write a regression test for the login redirect loop. Run it before and after the fix.',
    items: [
      { id: 'az1', type: 'tool', ts: now - 29 * min, toolUseId: 'toolu_a1w', name: 'Write', status: 'done', startedAt: now - 29 * min, endedAt: now - 29 * min + 100,
        input: { file_path: 'C:\\Users\\you\\code\\storefront\\test\\auth-redirect.test.js', content: "test('logged-out /account keeps next', async () => {\n  const r = await get('/account');\n  expect(r.headers.location).toBe('/login?next=%2Faccount');\n});\n" }, result: 'File created successfully' },
      { id: 'az2', type: 'tool', ts: now - 20 * min, toolUseId: 'toolu_a1b', name: 'Bash', status: 'done', startedAt: now - 20 * min, endedAt: now - 19 * min,
        input: { command: 'npm test -- auth-redirect', description: 'Run the new test' }, result: 'PASS test/auth-redirect.test.js\n  ✓ logged-out /account keeps next (41 ms)\n\nTests: 1 passed, 1 total' },
      { id: 'az3', type: 'assistant', ts: now - 12 * min, streaming: false, model: 'claude-opus-5-5', text: 'Added `test/auth-redirect.test.js`. It failed before the fix and passes after.' },
    ],
  },
};
export function agentTranscriptMock(p = {}) {
  const fa = Object.values(fleet).flat().find((a) => a.id === p.agentId) || null;
  const tx = agentTx[p.agentId];
  if (!tx) return { items: [], hasMore: false, agent: fa, file: null,
    missing: `No transcript in C:\\Users\\you\\.claude\\projects\\C--Users-you-code-storefront\\<session>\\subagents matches this agent (mock: only toolu_a1, toolu_a2 and toolu_a3 have one).` };
  if (p.rev === 'mock-1' && !p.before) return { unchanged: true, rev: 'mock-1', agent: fa };
  return { items: p.before ? [] : tx.items, hasMore: false, agent: fa, prompt: tx.prompt, rev: 'mock-1', via: 'meta',
    file: `C:\\Users\\you\\.claude\\projects\\C--Users-you-code-storefront\\<session>\\subagents\\agent-${p.agentId.slice(6)}0f3c.jsonl` };
}

// lane git-export: git.status per session folder (header git chip). Missing folder = not a repo.
const gitAt = (subject, ago) => ({ subject, ts: now - ago });
export const gitStatus = {
  'C:\\Users\\you\\code\\storefront': { isRepo: true, branch: 'master', detached: false, dirty: 3, staged: 1, untracked: 1, ahead: 2, behind: 0, upstream: 'origin/master', lastCommit: gitAt('Login redirect keeps ?next= through Clerk', 42 * min) },
  'C:\\Users\\you\\code\\booking-portal': { isRepo: true, branch: 'feat/customer-import', detached: false, dirty: 0, staged: 0, untracked: 0, ahead: null, behind: null, upstream: null, lastCommit: gitAt('Customer import: preview before commit', 26 * 60 * min) },
  'C:\\Users\\you\\helm': { isRepo: true, branch: 'master', detached: false, dirty: 0, staged: 0, untracked: 0, ahead: 0, behind: 1, upstream: 'origin/master', lastCommit: gitAt('Idle CPU: live dot + spinner driven by one visibility-aware timer', 3 * 60 * min) },
  'C:\\Users\\you\\code\\api-server': { isRepo: true, branch: 'a1b2c3d', detached: true, dirty: 12, staged: 0, untracked: 4, ahead: null, behind: null, upstream: null, lastCommit: gitAt('Taskbar: clock drift fix', 5 * 24 * 60 * min) },
};

// ---- lane bang: `!` shell mode (sessions.shell / sessions.shellStop, PROTOCOL "Shell runs") ----
// mockRpc hookup (ui/lib/transport.js): case 'sessions.shell': case 'sessions.shellStop': return mock.shellMock(method, p, { state: S, emit });
// and in its sessions.send case: mock.shellMockShare(S, emit, p.id) marks pending runs "Shared with Claude".
const mockShellRuns = new Map(); // itemId → { timer, sid, item }
function mockShellOutput(cmd) {
  if (/^git\s+status/.test(cmd)) return { out: ['On branch master', "Your branch is ahead of 'origin/master' by 2 commits.", '', 'Changes not staged for commit:', '\tmodified:   src/middleware/auth.js', '\tmodified:   test/auth-redirect.test.js'], code: 0 };
  if (/^(ls|dir)\b/.test(cmd)) return { out: ['README.md', 'package.json', 'public', 'server.js', 'src', 'test'], code: 0 };
  if (/\b(test|jest)\b/.test(cmd)) return { out: ['PASS test/auth-redirect.test.js', 'PASS test/billing.test.js', 'PASS test/digest.test.js', '', 'Tests:       214 passed, 214 total', 'Time:        8.41 s'], code: 0 };
  if (/^(false|exit [1-9])/.test(cmd)) return { out: [], err: ['command failed'], code: 1 };
  return { out: [`(mock) ran: ${cmd}`, 'done'], code: 0 };
}
export function shellMock(method, p = {}, { state, emit }) {
  const sid = p.id;
  if (method === 'sessions.shellStop') {
    const run = mockShellRuns.get(p.itemId);
    if (!run) return {};
    clearInterval(run.timer);
    mockShellRuns.delete(p.itemId);
    const patch = { status: 'stopped', exitCode: null, endedAt: Date.now(), stdout: run.item.text };
    Object.assign(run.item, patch);
    emit('session.itemUpdate', { sessionId: run.sid, itemId: p.itemId, patch });
    return {};
  }
  const command = String(p.command || '').trim();
  if (!command) throw Object.assign(new Error('Type a command after !'), { code: 'bad_request' });
  const s = (state.sessions || []).find((x) => x.id === sid);
  if (!s) throw Object.assign(new Error(`Unknown session ${sid}`), { code: 'not_found' });
  const t = Date.now();
  const item = { id: 'sh_' + Math.random().toString(16).slice(2, 10), type: 'shell', ts: t, command, cwd: s.cwd, shell: 'bash', text: '', stdout: '', stderr: '', exitCode: null, status: 'running', startedAt: t, endedAt: null, shared: false };
  (state.items[sid] ||= []).push(item);
  emit('session.item', { sessionId: sid, item: { ...item } });
  const { out, err = [], code } = mockShellOutput(command);
  const lines = [...out, ...err];
  let k = 0;
  const timer = setInterval(() => {
    if (k < lines.length) {
      const chunk = lines[k++] + '\n';
      item.text += chunk;
      emit('session.itemUpdate', { sessionId: sid, itemId: item.id, patch: {}, appendText: chunk });
      return;
    }
    clearInterval(timer);
    mockShellRuns.delete(item.id);
    const patch = { status: 'done', exitCode: code, endedAt: Date.now(), stdout: out.length ? out.join('\n') + '\n' : '', stderr: err.length ? err.join('\n') + '\n' : '' };
    Object.assign(item, patch);
    emit('session.itemUpdate', { sessionId: sid, itemId: item.id, patch });
  }, 160);
  mockShellRuns.set(item.id, { timer, sid, item });
  return { itemId: item.id };
}
export function shellMockShare(state, emit, sid) {
  for (const it of state.items[sid] || []) {
    if (it.type !== 'shell' || it.shared || it.status === 'running') continue;
    it.shared = true;
    emit('session.itemUpdate', { sessionId: sid, itemId: it.id, patch: { shared: true } });
  }
}

// ---- lane restart: app.hello `update` (PROTOCOL "Restart + updates"). ?update=pending | settling |
// restarted previews the chip, the Settings > Helm states and the "Helm restarted" toast.
export function mockUpdateState(kind) {
  const now = Date.now();
  const running = { sha: '40bd297c1e0a9b7d5f3e2a1c0b9d8e7f6a5b4c3d', short: '40bd297', subject: 'Taskbar pin opens Helm, not Electron\'s default app', branch: 'master', startedAt: now - 3 * 3600_000 };
  const commits = [{ sha: '9f3c2a1b0e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b', short: '9f3c2a1', subject: 'Restart button in Settings; Helm restarts itself after an update' }];
  const pending = kind === 'pending' ? { sha: commits[0].sha, short: commits[0].short, commits, detectedAt: now - 140_000, settleAt: now - 80_000, phase: 'waiting',
    reasons: ['1 session working', '2 agents running'], reason: 'waiting: 1 session working · 2 agents running' }
    : kind === 'settling' ? { sha: commits[0].sha, short: commits[0].short, commits, detectedAt: now - 20_000, settleAt: now + 40_000, phase: 'settling', reasons: [], reason: 'waiting for commits to settle' }
    : null;
  const restarted = kind === 'restarted' ? { at: now - 4000, auto: true, by: 'update', from: running.sha, to: commits[0].sha, commits } : null;
  return { bootedAt: now - 2000, restarted, running, repo: 'C:\Users\you\helm', autoRestart: true, pending };
}

// Look Sync state (look.get / app.hello look): the mock "desktop" is a bundled photo standing in for Mantle's still.
export const look = {
  sync: { enabled: true, state: 'ok', reason: null, rev: 57, by: 'quartz', at: new Date(Date.now() - 2 * min).toISOString(), skipped: [] },
  desktop: { source: 'mantle', ok: true, url: '/assets/backgrounds/snow-peak.jpg', rev: 41, title: 'Snow peak', type: 'builtin', id: 'builtin:snow-peak', size: [2560, 1440], reason: null,
    guard: null, guardReason: "Mantle hasn't shared a darkening for this wallpaper",
    guardLight: null, guardLightReason: 'light top band not published by Mantle yet' },
};
// ?lguard=0.55 previews Mantle's shared light top band (desktop.guard.light) at that alpha, for the seed light glass
{
  const a = Number(new URLSearchParams(globalThis.location?.search || '').get('lguard'));
  if (a > 0) Object.assign(look.desktop, { guardLight: { alpha: a, dim: 0.45, blurPx: 12 }, guardLightReason: null });
}
