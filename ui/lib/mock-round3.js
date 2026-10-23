// Round 3 mock data (docs/PROTOCOL.md "Round 3 additions"): older history pages, sessions running
// outside Helm (terminal Claude Code) and their transcripts. Re-exported by mock-data.js.
const now = Date.now();
const min = 60_000;
const ROUTES = ['/login', '/logout', '/dashboard', '/billing', '/api/me'];

// ---- older history pages (sessions.history { before }) ----
// s_storefront has two earlier pages so "Show earlier" / "Search older" have something to load.
export const older = {
  s_storefront: Array.from({ length: 40 }, (_, k) => {
    const n = Math.floor(k / 2), ts = now - (3 * 60 + 40 - k * 4) * min, r = ROUTES[n % 5];
    return k % 2 === 0
      ? { id: 'o' + k, type: 'user', ts, text: `Earlier ask #${n + 1}: check the session cookie flags on ${r}.`, attachments: [] }
      : { id: 'o' + k, type: 'assistant', ts, streaming: false, model: 'claude-opus-5-5', text: `Checked ${r}: the cookie is **HttpOnly** and **SameSite=Lax**; nothing to change there (pass ${n + 1}).` };
  }),
};

// ---- Claude Code sessions running outside Helm ----
const P = 'C:\\Users\\you\\';
export const external = [
  { claudeSessionId: 'e1a2b3c4-0000-4d00-8000-00000000e001', cwd: P + 'code\\api-server', project: 'api-server', title: 'Sidecar memory leak hunt',
    lastActivity: now - 20_000, active: true, agentsRunning: 3, transcriptPath: P + '.claude\\projects\\C--Users-you-code-api-server\\e1a2b3c4-e001.jsonl',
    eta: { state: 'working', label: 'Leak hunt', summary: 'Heap snapshots, then patch the listener', step: 3, steps: ['Repro', 'Snapshot', 'Patch', 'Verify'],
      etaAt: now - 3 * min, workStartedAt: now - 47 * min, isOverdue: true, agentsRunning: 3, updatedAt: now - 30_000 } },
  { claudeSessionId: 'e1a2b3c4-0000-4d00-8000-00000000e002', cwd: P + 'code\\blog', project: 'blog', title: 'WebGL hero perf pass',
    lastActivity: now - 50_000, active: true, agentsRunning: 0, transcriptPath: P + '.claude\\projects\\C--Users-you-code-blog\\e1a2b3c4-e002.jsonl',
    eta: { state: 'working', label: 'Perf pass', summary: 'Cut the draw calls', step: 1, steps: ['Profile', 'Fix'], etaAt: now + 9 * min,
      workStartedAt: now - 6 * min, isOverdue: false, agentsRunning: 0, updatedAt: now - 40_000 } },
  { claudeSessionId: 'e1a2b3c4-0000-4d00-8000-00000000e003', cwd: P + 'code\\mobile-app', project: 'mobile-app', title: 'Overnight research plan review',
    lastActivity: now - 3 * 60 * min, active: false, agentsRunning: 0, eta: null, transcriptPath: P + '.claude\\projects\\C--Users-you-code-mobile-app\\e1a2b3c4-e003.jsonl' },
];

export const externalItems = {
  'e1a2b3c4-0000-4d00-8000-00000000e001': [
    { id: 'x1', type: 'user', ts: now - 47 * min, text: 'The sidecar grows ~40 MB an hour. Find the leak and fix it.', attachments: [] },
    { id: 'x2', type: 'assistant', ts: now - 46 * min, streaming: false, model: 'claude-opus-5-5', text: "I'll take two heap snapshots ten minutes apart and diff the retained listeners." },
    { id: 'x3', type: 'tool', ts: now - 45 * min, toolUseId: 'toolu_x3', name: 'Bash', status: 'done', startedAt: now - 45 * min, endedAt: now - 44 * min,
      input: { command: 'dotnet-gcdump collect -p 18244', description: 'Snapshot the sidecar heap' }, result: 'Writing gcdump to sidecar_1.gcdump\nComplete' },
    { id: 'x4', type: 'tool', ts: now - 30 * min, toolUseId: 'toolu_x4', name: 'Grep', status: 'done', startedAt: now - 30 * min, endedAt: now - 30 * min + 600,
      input: { pattern: 'SystemEvents\\.', path: 'sidecar' }, result: 'sidecar/Power.cs:41\nsidecar/Clock.cs:88' },
    { id: 'x5', type: 'assistant', ts: now - 2 * min, streaming: false, model: 'claude-opus-5-5',
      text: 'Found it: `Clock.cs` subscribes to `SystemEvents.TimeChanged` on every tick and never unsubscribes. Patching now.' },
  ],
  'e1a2b3c4-0000-4d00-8000-00000000e002': [
    { id: 'y1', type: 'user', ts: now - 6 * min, text: 'The hero drops to 40 fps on the laptop. Profile it.', attachments: [] },
    { id: 'y2', type: 'assistant', ts: now - 5 * min, streaming: false, model: 'claude-opus-5-5', text: 'Profiling the render loop with the CPU cap on.' },
  ],
  'e1a2b3c4-0000-4d00-8000-00000000e003': [
    { id: 'z1', type: 'user', ts: now - 3 * 60 * min - 5 * min, text: 'Review the overnight research plan. Coordinator only touches TEST.', attachments: [] },
    { id: 'z2', type: 'assistant', ts: now - 3 * 60 * min, streaming: false, model: 'claude-opus-5-5',
      text: 'The plan holds: TEST stays locked, lanes only see TRAIN/VAL. One fix: the cost model needs the 2 bp slippage term.' },
    { id: 'z3', type: 'result', ts: now - 3 * 60 * min, durationMs: 182000, costUsd: 0.41, numTurns: 6, isError: false,
      usage: { input: 21000, output: 3100, cacheRead: 88000, cacheWrite: 4000 } },
  ],
};
