// Mock worktrees.* (lane helm-worktrees, H4) for the browser mock (serve-ui) and tools/worktrees-shot.js.
// Helm's repo has a few lanes in every state the panel shows; a folder under "storefront" shows the production refusal.
const now = Date.now();
const min = 60_000, hour = 60 * min;
const refuse = (message, code = 'refused', data) => Object.assign(new Error(message), { code }, data ? { data } : {});

function repoFor(cwd) {
  const c = String(cwd || '');
  if (/storefront/i.test(c)) return 'storefront';
  if (/helm/i.test(c)) return 'helm';
  return null;
}

const HELM = () => ({
  root: 'C:\\Users\\you\\helm', name: 'helm', wtDir: 'C:\\Users\\you\\helm-wt', mainBranch: 'master',
  worktrees: [
    { path: 'C:\\Users\\you\\helm', name: 'helm', main: true, branch: 'master', head: '5a94378', dirty: 0, nodeModules: 'copy',
      lastCommit: { hash: '5a94378', subject: 'Merge wk/next: the restart note and plain-words errors', ts: now - 9 * hour }, sessions: [{ id: 's_helm', title: 'Helm design system', status: 'idle' }] },
    { path: 'C:\\Users\\you\\helm-wt\\pace', name: 'pace', branch: 'wk/pace', head: 'b69795b', dirty: 0, nodeModules: 'copy', base: 'master', ahead: 6, behind: 0,
      lastCommit: { hash: 'b69795b', subject: 'Pace chip: an old reading\'s used / elapsed say they are as of the reading', ts: now - 2 * hour },
      sessions: [{ id: 's_old', title: 'Tray icon audit', status: 'idle' }],
      merge: { can: true, why: null, kind: 'ff', protected: false, restartsHelm: true } },
    { path: 'C:\\Users\\you\\helm-wt\\worktrees', name: 'worktrees', branch: 'wk/worktrees', head: 'c1d2e3f', dirty: 4, nodeModules: 'copy', base: 'wk/pace', ahead: 3, behind: 0,
      lastCommit: { hash: 'c1d2e3f', subject: 'Worktrees panel: Merge and Remove behind confirms', ts: now - 14 * min }, sessions: [],
      merge: { can: false, why: 'wk/worktrees has 4 uncommitted changes. Commit or discard them first, so the merge carries everything you see.', kind: null, protected: false, restartsHelm: false } },
    { path: 'C:\\Users\\you\\helm-wt\\restart', name: 'restart', branch: 'wk/restart', head: 'dc4ea1c', dirty: 0, nodeModules: 'copy', base: 'master', ahead: 2, behind: 5,
      lastCommit: { hash: 'dc4ea1c', subject: 'Restart: keep the note through a crash', ts: now - 30 * hour }, sessions: [],
      merge: { can: false, why: 'Merging would conflict in 2 files (main/update.js, ui/shell/update.js). Merge master into wk/restart in the worktree and resolve them there first.', kind: null, protected: false, restartsHelm: true } },
    { path: 'C:\\Users\\you\\helm-wt\\voice', name: 'voice', branch: 'wk/voice', head: '60f665a', dirty: 0, nodeModules: 'link', base: 'master', ahead: 0, behind: 3,
      lastCommit: { hash: '60f665a', subject: 'Voice: unload Whisper after 10 min idle', ts: now - 3 * 24 * hour }, sessions: [{ id: 's_closed', title: 'Voice model check', status: 'closed' }],
      merge: { can: false, why: 'Nothing to merge: wk/voice has no commits that master does not already have.', kind: null, protected: false, restartsHelm: true } },
  ],
});
const STOREFRONT = () => ({
  root: 'C:\\Users\\you\\code\\storefront', name: 'storefront', wtDir: 'C:\\Users\\you\\code\\storefront-wt', mainBranch: 'master',
  worktrees: [
    { path: 'C:\\Users\\you\\code\\storefront', name: 'storefront', main: true, branch: 'master', head: '8e1f2a0', dirty: 0, nodeModules: 'copy',
      lastCommit: { hash: '8e1f2a0', subject: 'v1.3.2: digest timezone per account', ts: now - 26 * hour }, sessions: [{ id: 's_storefront', title: 'Fix the login redirect loop', status: 'working' }] },
    { path: 'C:\\Users\\you\\code\\storefront-wt\\login-fix', name: 'login-fix', branch: 'wk/login-fix', head: '4b5c6d7', dirty: 0, nodeModules: 'copy', base: 'master', ahead: 2, behind: 0,
      lastCommit: { hash: '4b5c6d7', subject: 'Auth: stop the redirect loop after sign-out', ts: now - 40 * min }, sessions: [],
      merge: { can: false, why: 'Merging into storefront master is refused: storefront master is production, and the production guard keeps it for you to merge and push by hand.', kind: 'ff', protected: true, restartsHelm: false } },
  ],
});
const state = { helm: null, storefront: null };
const data = (k) => (state[k] ||= k === 'helm' ? HELM() : STOREFRONT());

export async function worktreesMock(method, p = {}) {
  await new Promise((r) => setTimeout(r, 120));
  const k = repoFor(p.cwd || p.path);
  if (method === 'worktrees.info') {
    if (!k) throw refuse(`${p.cwd} is not inside a git repository, so it cannot have worktrees. Pick a folder inside a repo.`, 'not_repo');
    const d = data(k);
    const big = k === 'storefront';
    return { root: d.root, name: d.name, wtDir: d.wtDir, here: d.root, currentBranch: k === 'helm' && /helm-wt/i.test(p.cwd) ? 'wk/pace' : 'master', detached: false,
      branches: [...new Set([k === 'helm' && /helm-wt/i.test(p.cwd) ? 'wk/pace' : 'master', ...d.worktrees.map((w) => w.branch), 'master'])],
      taken: d.worktrees.map((w) => w.branch), copyMaxBytes: 800 * 1024 * 1024,
      deps: { exists: true, link: false, copyable: true, source: `${d.root}\\node_modules`, install: 'npm ci', bytes: big ? 1_480_000_000 : 717_000_000, files: big ? 41_200 : 8950, partial: false, suggest: big ? 'install' : 'copy' } };
  }
  if (!k) throw refuse(`${p.cwd || p.path} is not inside a git repository, so it cannot have worktrees.`, 'not_repo');
  const d = data(k);
  if (method === 'worktrees.list') return JSON.parse(JSON.stringify(d));
  if (method === 'worktrees.create') {
    const path = `${d.wtDir}\\${p.name}`;
    d.worktrees.push({ path, name: p.name, branch: `wk/${p.name}`, head: '5a94378', dirty: 0, nodeModules: 'none', base: p.base, ahead: 0, behind: 0, lastCommit: d.worktrees[0].lastCommit, sessions: [],
      merge: { can: false, why: `Nothing to merge: wk/${p.name} has no commits that ${p.base} does not already have.`, kind: null, protected: false, restartsHelm: false } });
    return { path, branch: `wk/${p.name}`, base: p.base, head: '5a94378', repo: d.root };
  }
  const w = d.worktrees.find((x) => x.path === p.path);
  if (method === 'worktrees.deps') {
    await new Promise((r) => setTimeout(r, 900));
    if (w) w.nodeModules = 'copy';
    return p.mode === 'copy' ? { mode: 'copy', ms: 21_000, skippedLinks: 0 } : { mode: 'install', command: 'npm ci', ms: 95_000 };
  }
  if (!w) throw refuse(`${p.path} is not a worktree of ${d.name}.`, 'not_worktree');
  if (method === 'worktrees.merge') {
    if (!w.merge.can) throw refuse(w.merge.why, w.merge.protected ? 'protected' : 'refused');
    if (w.merge.restartsHelm && !p.confirmRestart) throw refuse("Merging into Helm's own master restarts Helm and stops running sessions.", 'confirm_restart');
    Object.assign(w, { ahead: 0, merge: { can: false, why: `Nothing to merge: ${w.branch} has no commits that ${w.base} does not already have.` } });
    return { base: w.base, branch: w.branch, kind: w.behind ? 'merge' : 'ff', head: 'abc1234', restartsHelm: !!p.confirmRestart };
  }
  if (method === 'worktrees.remove') {
    if (w.dirty && !p.discard) throw refuse(`${w.branch} has ${w.dirty} uncommitted changes. Tick "Discard changes" to remove it anyway; they will be lost.`, 'dirty');
    d.worktrees = d.worktrees.filter((x) => x !== w);
    return { removed: w.path, branch: w.branch, linksRemoved: w.nodeModules === 'link' ? [`${w.path}\\node_modules`] : [], branchDeleted: !!p.deleteBranch && w.ahead === 0, branchKept: null };
  }
  throw new Error(`mock: no handler for ${method}`);
}
