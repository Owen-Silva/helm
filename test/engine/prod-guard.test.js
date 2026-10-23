// Production guard (main/engine/prod-guard.js): the command matcher (real git, throwaway repos whose
// remotes only LOOK like Shop / Client Portal — nothing is ever pushed), the prompt-approval matcher, the
// per-session approval state and the hook's allow / deny / timeout / error paths.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const G = require('../../main/engine/prod-guard');
// The protected repos these tests configure, in prod-guard.json's shape: Shop deploys from master; every
// push from Client Portal is guarded. (The public default is an empty list: see prod-guard-config.test.js.)
const CONFIG = { repos: [
  { name: 'Shop', remotes: ['github.com/Example/shop'], branches: ['master'] },
  { name: 'Client Portal', remotes: ['git@github.com:example/client-portal.git'], branches: null },
] };
const T = G.parseConfig(CONFIG);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-guard-test-'));
const g = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).toString().trim();
function repo(name, remote, branch = 'master') {
  const d = path.join(root, name);
  fs.mkdirSync(d, { recursive: true });
  g(d, 'init', '-q', '-b', branch);
  g(d, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
  if (remote) g(d, 'remote', 'add', 'origin', remote);
  return d;
}
const shop = repo('shop', 'https://github.com/Example/shop.git');
const shopNext = repo('shop-next', 'git@github.com:Example/shop.git', 'next');
const portal = repo('client-portal', 'git@github.com:Example/client-portal.git');
const helm = repo('helm', 'https://github.com/Example/helm.git');
const plain = path.join(root, 'plain');
fs.mkdirSync(plain);
// shop-feature: on branch "feature" whose push target is origin/master (push.default=upstream)
const shopFeature = repo('shop-feature', 'https://github.com/Example/shop', 'feature');
g(shopFeature, 'update-ref', 'refs/remotes/origin/master', 'HEAD');
g(shopFeature, 'config', 'branch.feature.remote', 'origin');
g(shopFeature, 'config', 'branch.feature.merge', 'refs/heads/master');
g(shopFeature, 'config', 'push.default', 'upstream');
g(shop, 'config', 'alias.p', 'push');
g(shop, 'config', 'alias.sync', '!git pull && git push');
g(shop, 'config', 'alias.st', 'status');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const bash = (command, cwd = shop) => G.assess('Bash', { command }, { cwd, targets: T });
const ps = (command, cwd = shop) => G.assess('PowerShell', { command }, { cwd, targets: T });
const fwd = (p) => p.replace(/\\/g, '/');
const gitBash = (p) => fwd(p).replace(/^([A-Za-z]):/, (_, d) => '/' + d.toLowerCase());

async function expectHit(p, re, label) {
  const v = await p;
  assert.ok(v, `${label}: expected a guard hit, got none`);
  if (re) assert.match(v.title, re, label);
  return v;
}
async function expectNone(p, label) {
  const v = await p;
  assert.strictEqual(v, null, `${label}: expected no guard, got ${v && v.title}`);
}

test('normalizeRemote: every URL form of the same repo is one key', () => {
  const k = 'github.com/example/shop';
  for (const u of ['https://github.com/Example/shop.git', 'https://github.com/Example/shop', 'https://x:tok@github.com/Example/shop.git/',
    'git@github.com:Example/shop.git', 'ssh://git@github.com/Example/shop.git', 'ssh://git@github.com:22/Example/shop', 'git+https://github.com/example/SHOP.git']) {
    assert.strictEqual(G.normalizeRemote(u), k, u);
  }
  assert.notStrictEqual(G.normalizeRemote('https://github.com/Example/shop-site.git'), k);
  assert.strictEqual(G.normalizeRemote('C:\\Temp\\bare.git'), G.normalizeRemote('/c/Temp/bare'));
  assert.strictEqual(G.normalizeRemote('file:///C:/Temp/bare.git'), G.normalizeRemote('C:\\Temp\\bare'));
});

test('Shop: pushes that reach master are guarded', async () => {
  await expectHit(bash('git push'), /Shop master/, 'plain push on master');
  await expectHit(bash('git push origin master'), /Shop master/, 'explicit master');
  await expectHit(bash('git push --force origin master'), /Shop master/, '--force');
  await expectHit(bash('git push -f'), /Shop master/, '-f');
  await expectHit(bash('git push --force-with-lease'), /Shop master/, 'lease');
  await expectHit(bash('git push -u origin HEAD'), /Shop master/, 'HEAD on master');
  await expectHit(bash('git push origin HEAD:master', shopNext), /Shop master/, 'HEAD:master from next');
  await expectHit(bash('git push origin next:refs/heads/master', shopNext), /Shop master/, 'full dst ref');
  await expectHit(bash('git push origin +next:master', shopNext), /Shop master/, 'forced refspec');
  await expectHit(bash('git push origin :master'), /Shop master/, 'delete via empty src');
  await expectHit(bash('git push origin --delete master'), /Shop master/, '--delete master');
  await expectHit(bash('git push --all'), /Shop/, '--all');
  await expectHit(bash('git push --mirror'), /Shop/, '--mirror');
  await expectHit(bash("git push origin 'refs/heads/*:refs/heads/*'"), /Shop/, 'wildcard');
  await expectHit(bash('git push', shopFeature), /Shop master/, 'feature tracks origin/master (push.default=upstream)');
  await expectHit(bash('git push https://github.com/Example/shop.git HEAD:master', plain), /Shop master/, 'URL remote from a non-repo');
});

test('Shop: pushes that do not reach master are not guarded', async () => {
  await expectNone(bash('git push', shopNext), 'on next, no refspec');
  await expectNone(bash('git push origin next', shopNext), 'next');
  await expectNone(bash('git push origin next'), 'next from master checkout');
  await expectNone(bash('git push origin master:next'), 'master → next');
  await expectNone(bash('git push origin --delete old-branch'), 'delete another branch');
  await expectNone(bash('git push --dry-run'), '--dry-run (chosen: never guarded, it changes nothing)');
  await expectNone(bash('git push -n origin master'), '-n');
  await expectNone(bash('git push --dry-run --force origin HEAD:master', shopNext), 'dry-run wins');
});

test('Client Portal: every push is guarded, dry-run is not', async () => {
  await expectHit(bash('git push', portal), /Client Portal/, 'plain');
  await expectHit(bash('git push origin feature-x', portal), /Client Portal/, 'any branch');
  await expectHit(bash('git push --tags', portal), /Client Portal/, 'tags');
  await expectNone(bash('git push --dry-run', portal), 'dry-run');
});

test('other repos and non-pushes stay automatic', async () => {
  await expectNone(bash('git push', helm), 'Helm repo');
  await expectNone(bash('git push origin master', helm), 'Helm master');
  await expectNone(bash('git push', plain), 'not a repo');
  await expectNone(bash('echo "git push"'), 'echo of the words');
  await expectNone(bash("echo 'git push origin master' > notes.txt"), 'single-quoted');
  await expectNone(bash('git commit -m "railway up"'), 'commit message mentioning railway up');
  await expectNone(bash('git commit -m "then git push to master"'), 'commit message mentioning git push');
  await expectNone(bash('git log --grep="push"'), 'git log');
  await expectNone(bash('git status && git diff'), 'other git');
  await expectNone(bash('git st'), 'alias to status');
  await expectNone(bash('# git push\nls'), 'comment');
  await expectNone(bash('cat <<EOF > notes.md\ngit push origin master\nrailway up\nEOF'), 'heredoc to cat');
  await expectNone(bash('git commit -F- <<\'EOF\'\nrailway up\ngit push\nEOF'), 'heredoc commit message');
  await expectNone(bash('grep -rn "git push" docs/'), 'grep for it');
  await expectNone(G.assess('Read', { file_path: 'x' }, { cwd: shop, targets: T }), 'Read tool');
  await expectNone(G.assess('Write', { file_path: 'x', content: 'git push' }, { cwd: shop, targets: T }), 'Write tool');
});

test('folders: cd, -C, subshells, chains', async () => {
  await expectNone(bash(`cd "${helm}" && git push`), 'cd to Helm from Shop');
  await expectHit(bash(`cd "${shop}" && git push`, helm), /Shop/, 'cd to Shop from Helm');
  await expectHit(bash(`cd ${gitBash(shop)} && git push`, helm), /Shop/, 'Git Bash /c/ path');
  await expectHit(bash(`git -C "${shop}" push`, helm), /Shop/, 'git -C');
  await expectHit(bash(`git -C "${root}" -C shop push`, helm), /Shop/, 'stacked -C');
  await expectNone(bash(`git -C "${helm}" push`, shop), 'git -C Helm from Shop');
  await expectHit(bash('npm test; git push origin master'), /Shop/, '; chain');
  await expectHit(bash('git add -A && git commit -m "x; y" && git push'), /Shop/, '&& chain');
  await expectHit(bash('npm test || git push'), /Shop/, '|| chain');
  await expectHit(bash('git push 2>&1 | tail -5'), /Shop/, 'piped output');
  await expectHit(bash('nohup git push > /dev/null 2>&1 &'), /Shop/, 'background');
  await expectHit(bash(`(cd "${helm}" && git push); git push`), /Shop/, 'subshell cd does not leak');
  await expectNone(bash(`(cd "${shop}" && git status); git push`, helm), 'subshell cd into Shop does not leak');
  await expectHit(bash(`pushd "${shop}" && git push && popd`, helm), /Shop/, 'pushd');
  await expectHit(bash('if npm test; then\n  git push origin master\nfi'), /Shop/, 'if body');
  await expectHit(bash('for r in a b; do git push; done'), /Shop/, 'loop body');
  await expectHit(bash('echo $(git push)'), /Shop/, 'command substitution');
  await expectHit(bash('x=`git push`'), /Shop/, 'backticks');
  await expectHit(bash('cd "$REPO" && git push', helm), /folder unknown/, 'unknown folder asks');
  await expectHit(bash(`cd ~ && cd "${shop}" && git push`, helm), /Shop/, 'home then Shop');
});

test('wrappers and re-entry', async () => {
  await expectHit(bash('GIT_TRACE=1 git push'), /Shop/, 'env assignment');
  await expectHit(bash('env GIT_SSH_COMMAND="ssh -v" git push'), /Shop/, 'env');
  await expectHit(bash('time git push'), /Shop/, 'time');
  await expectHit(bash('timeout 60 git push'), /Shop/, 'timeout');
  await expectHit(bash('"/c/Program Files/Git/cmd/git.exe" push'), /Shop/, 'full path to git.exe');
  await expectHit(bash('bash -c "git push origin master"'), /Shop/, 'bash -c');
  await expectHit(bash(`sh -lc 'cd "${fwd(shop)}" && git push'`, helm), /Shop/, 'sh -lc with cd');
  await expectHit(bash('echo "git push" | bash'), /Shop/, 'piped into bash');
  await expectHit(bash('bash <<EOF\ngit push\nEOF'), /Shop/, 'heredoc into bash');
  await expectHit(bash('bash <<< "git push"'), /Shop/, 'here-string into bash');
  await expectHit(bash("eval 'git push'"), /Shop/, 'eval');
  await expectHit(bash('powershell -NoProfile -Command "git push"'), /Shop/, 'powershell -Command');
  await expectHit(bash(`cmd /c "cd /d ${shop} && git push"`, helm), /Shop/, 'cmd /c');
  await expectHit(bash('git p'), /Shop/, 'alias p = push');
  await expectHit(bash('git sync'), /Shop/, '! alias that pushes');
  await expectHit(bash('railway run git push'), /Shop/, 'railway run');
});

test('PowerShell tool', async () => {
  await expectHit(ps('git push'), /Shop master/, 'plain');
  await expectHit(ps(`Set-Location "${shop}"; git push`, helm), /Shop/, 'Set-Location');
  await expectHit(ps(`Set-Location -Path '${shop}'; if ($?) { git push origin master }`, helm), /Shop/, 'Set-Location -Path + if block');
  await expectHit(ps(`sl ${shop}\ngit push`, helm), /Shop/, 'sl + newline');
  await expectNone(ps(`cd "${helm}"; git push`), 'cd to Helm');
  await expectHit(ps('& git push origin master 2>&1'), /Shop/, 'call operator');
  await expectHit(ps(`& "C:\\Program Files\\Git\\cmd\\git.exe" -C "${shop}" push`, helm), /Shop/, 'call git.exe by path');
  await expectHit(ps('$out = $(git push)'), /Shop/, 'subexpression');
  await expectHit(ps("Invoke-Expression 'git push'"), /Shop/, 'Invoke-Expression');
  await expectHit(ps("'git push' | iex"), /Shop/, 'piped to iex');
  await expectHit(ps(`powershell -EncodedCommand ${Buffer.from('git push', 'utf16le').toString('base64')}`), /Shop/, '-EncodedCommand');
  await expectHit(ps("Start-Process git -ArgumentList 'push','origin','master' -Wait"), /Shop/, 'Start-Process');
  await expectHit(ps('git push `\n  origin master'), /Shop/, 'backtick continuation');
  await expectNone(ps('Write-Host "git push"'), 'Write-Host of the words');
  await expectNone(ps("git commit -m 'railway up'"), 'commit message');
  await expectNone(ps('git push --dry-run'), 'dry-run');
});

test('Railway: deploy actions anywhere, nothing else', async () => {
  for (const c of ['railway up', 'railway up --detach', 'railway redeploy --service api -y', 'railway restart', 'railway down', 'railway --service api up',
    'npx @railway/cli up', 'npx -y @railway/cli@latest redeploy', 'pnpm dlx @railway/cli up', 'cd /tmp && railway up', 'RAILWAY_TOKEN=x railway up']) {
    await expectHit(bash(c, plain), /Railway/, c);
  }
  await expectHit(ps('railway up --detach', plain), /Railway/, 'PowerShell railway up');
  for (const c of ['railway status', 'railway logs', 'railway variables', 'railway up --help', 'railway help up', 'echo "railway up"', 'git commit -m "railway up"', 'railway link']) {
    await expectNone(bash(c, plain), c);
  }
  const r = await bash('railway restart', plain);
  assert.strictEqual(r.approvable, 'restart');
  assert.strictEqual((await bash('railway down', plain)).approvable, false, 'down is never auto-approved');
});

test('Railway MCP tools', async () => {
  await expectHit(G.assess('mcp__railway__deploy', {}, {}), /Railway/, 'deploy');
  await expectHit(G.assess('mcp__plugin_railway_railway__deploy-template', {}, {}), /Railway/, 'deploy-template');
  await expectHit(G.assess('mcp__railway-mcp-server__restart_service', {}, {}), /Railway restart/, 'restart');
  await expectNone(G.assess('mcp__railway__list-services', {}, {}), 'list');
  await expectNone(G.assess('mcp__railway__get-logs', {}, {}), 'logs');
  await expectNone(G.assess('mcp__github__push_files', {}, {}), 'not railway');
});

test('test-only HELM_TEST_PROD_GUARD needs --test: remotes by id, or whole repos', () => {
  const dir = fs.mkdtempSync(path.join(root, 'ud-'));
  fs.writeFileSync(path.join(dir, G.CONFIG_FILE), JSON.stringify(CONFIG));
  const env = { HELM_TEST_PROD_GUARD: JSON.stringify({ shop: ['C:\\Temp\\bare-shop.git'] }) };
  assert.ok(G.targets(dir, { env, argv: ['electron', '.', '--test'] })[0].remotes.includes(G.normalizeRemote('C:\\Temp\\bare-shop.git')));
  assert.ok(!G.targets(dir, { env, argv: ['electron', '.'] })[0].remotes.includes(G.normalizeRemote('C:\\Temp\\bare-shop.git')));
  assert.ok(!G.targets(dir)[0].remotes.includes(G.normalizeRemote('C:\\Temp\\bare-shop.git')), 'the configured list itself is unchanged');
  // whole repos, in prod-guard.json's shape, with no config file at all
  const env2 = { HELM_TEST_PROD_GUARD: JSON.stringify({ repos: [{ name: 'Bare', remotes: ['C:\\Temp\\bare.git'], branches: ['main'] }] }) };
  const on = G.targets(null, { env: env2, argv: ['electron', '.', '--test'] });
  assert.deepStrictEqual(on.map((t) => [t.id, t.branches]), [['bare', ['main']]]);
  assert.ok(on[0].remotes.includes(G.normalizeRemote('C:\\Temp\\bare.git')));
  assert.deepStrictEqual(G.targets(null, { env: env2, argv: ['electron', '.'] }), []);
});

// ---------- prompt approval ----------
const A = (t, prev) => G.promptApproval(t, prev, T);
test('prompt approval: says push / ship / deploy / redeploy / go live / release', () => {
  for (const t of ['commit and push', 'Commit and push.', 'fix the bug and push', '…and push', 'ship it', 'Ship it!', 'deploy', 'please redeploy', 'go live',
    'release it', 'push to master', 'ok push it', 'you can push', 'PUSH', 'can you commit and push', 'run the tests, then push', 'looks good. deploy it']) {
    const a = A(t);
    assert.ok(a, `should approve: ${t}`);
    assert.strictEqual(a.scope, 'all', t);
  }
  assert.match(A('fix the header spacing on mobile and push').quote, /push/);
});

test('prompt approval: negated, held, questions, past tense, other meanings', () => {
  for (const t of ["don't push", 'dont push', 'do not push', "commit but don't push", 'commit, don’t push', 'commit locally, no push', 'commit without pushing',
    'not yet', 'hold off on pushing', 'never push', 'did you push?', 'should we push?', 'did you push', 'should we deploy to prod', 'pushed', 'i pushed it already',
    'can you push?', 'fix the phone push notifications', 'write the release notes', 'why did the deploy fail', 'the deploy failed, look at the logs',
    'commit and push later', 'push it, but not to master', 'skip pushing for now', 'commit it', '', 'yes', 'go ahead']) {
    assert.strictEqual(A(t), null, `should NOT approve: ${JSON.stringify(t)}`);
  }
});

test('prompt approval: restart approves only a Railway restart', () => {
  assert.deepStrictEqual(A('restart the api').scope, 'restart');
  assert.strictEqual(A('restart it and push').scope, 'all');
  assert.strictEqual(A("don't restart anything"), null);
});

test('prompt approval (b): short yes after Claude asked about pushing', () => {
  const asked = 'All 42 tests pass and the build is clean. Want me to push this to master?';
  for (const t of ['yes', 'Yes!', 'yep', 'yeah', 'ok', 'okay', 'sure', 'go', 'go ahead', 'do it', 'ship it', 'y', 'yes please', 'ok, go ahead']) {
    const a = A(t, asked);
    assert.ok(a, `should approve after a push question: ${t}`);
    assert.strictEqual(a.scope, 'all');
  }
  assert.strictEqual(A('yes', 'All 42 tests pass.'), null, 'no question before it');
  assert.strictEqual(A('yes', 'Did that fix it?'), null, 'question not about pushing');
  assert.strictEqual(A('yes', 'Should I hold off on pushing until CI is green?'), null, 'question about NOT pushing');
  assert.strictEqual(A('yes', 'I pushed it. Anything else?'), null, 'push mentioned outside the question');
  assert.strictEqual(A('yes and also fix the footer', asked), null, 'not a short affirmative');
  assert.strictEqual(A('ok', 'Want me to restart the Railway service?').scope, 'restart');
  assert.strictEqual(A('go ahead', 'Should I deploy it?').scope, 'all');
});

test('AskUserQuestion answers about pushing', () => {
  assert.strictEqual(G.answerApproval('Push to master now?', 'Yes, push', T).scope, 'all');
  assert.strictEqual(G.answerApproval('Push to master now?', 'Yes', T).scope, 'all');
  assert.strictEqual(G.answerApproval('Ship it?', 'Push now (Recommended)', T).scope, 'all');
  assert.strictEqual(G.answerApproval('Push to master now?', 'Not yet', T), null);
  assert.strictEqual(G.answerApproval('Push to master now?', 'Commit only', T), null);
  assert.strictEqual(G.answerApproval('Which colour?', 'Blue', T), undefined);
});

// ---------- session state + hook ----------
function fakeSession(opts = {}) {
  const dir = fs.mkdtempSync(path.join(root, 'ud-'));
  fs.writeFileSync(path.join(dir, G.CONFIG_FILE), JSON.stringify(CONFIG)); // the hook reads prod-guard.json
  const lines = [];
  const logs = [];
  const s = {
    s: { id: 's1', cwd: opts.cwd || shop, lastText: opts.lastText || null },
    engine: { userDataDir: dir, log: (lvl, m) => logs.push(m) },
    norm: { system: (st, text, ts, extra) => lines.push({ st, text, extra }), store: { patch: (id, p) => { s.patched.push({ id, ...p }); } } },
    requests: new Map(),
    patched: [],
    asked: [],
    _canUseTool(name, input, o) {
      this.asked.push({ name, input, o });
      if (opts.canUse === 'throw') throw new Error('boom');
      return new Promise((resolve) => {
        const r = { resolve, item: { id: 'i' + this.asked.length, requestId: 'r' + this.asked.length, guard: o.guard, toolUseId: o.toolUseID, status: 'pending', title: o.title }, toolUseId: o.toolUseID };
        this.requests.set(r.item.requestId, r);
        if (opts.answer) setTimeout(() => { this.requests.delete(r.item.requestId); resolve(opts.answer); }, 5);
      });
    },
    _cancelRequest(r, why) { this.requests.delete(r.item.requestId); r.item.status = 'cancelled'; r.resolve({ behavior: 'deny', message: why, interrupt: true }); },
  };
  s.lines = lines;
  s.logs = logs;
  return s;
}
const pre = (command, cwd = shop) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, tool_use_id: 'tu1', cwd });
const decision = (out) => out && out.hookSpecificOutput && out.hookSpecificOutput.permissionDecision;
const send = (es, text, origin) => { const item = { uuid: 'u' + Math.random(), text }; G.noteSend(es, item, origin); G.notePushed(es, item); };

test('hook: not guarded → no decision, nothing asked', async () => {
  const es = fakeSession();
  const h = G.createHook(es);
  assert.ok(h.timeout * 1000 > G.WAIT_MS, 'CLI hook timeout is past our own wait');
  assert.deepStrictEqual(await h.hooks[0](pre('git push', helm), 'tu1', { signal: new AbortController().signal }), {});
  assert.strictEqual(es.asked.length, 0);
});

test('hook: the user allows → no decision (normal flow runs it); denies → deny with their note', async () => {
  const es = fakeSession({ answer: { behavior: 'allow', updatedInput: {} } });
  const out = await G.createHook(es).hooks[0](pre('git push'), 'tu1', { signal: new AbortController().signal });
  assert.deepStrictEqual(out, {});
  assert.strictEqual(es.asked[0].o.title, 'Production push · Shop master');
  assert.ok(es.asked[0].o.guard, 'request is marked as a guard request');
  const es2 = fakeSession({ answer: { behavior: 'deny', message: 'not today' } });
  const out2 = await G.createHook(es2).hooks[0](pre('git push'), 'tu1', { signal: new AbortController().signal });
  assert.strictEqual(decision(out2), 'deny');
  assert.match(out2.hookSpecificOutput.permissionDecisionReason, /The user declined.*NOT run.*not today/);
  // the decline is scoped to this attempt, never a standing block Claude cites against the user's later asks
  assert.match(out2.hookSpecificOutput.permissionDecisionReason, /in this turn.*this attempt only.*Helm will ask the user again/);
});

test('hook: no answer in time → card cancelled + deny (fail closed)', async () => {
  const es = fakeSession();
  const out = await G.createHook(es, { waitMs: 60 }).hooks[0](pre('git push'), 'tu1', { signal: new AbortController().signal });
  assert.strictEqual(decision(out), 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /did not answer/);
  assert.strictEqual(es.requests.size, 0, 'the card is withdrawn');
  assert.ok(es.patched.some((p) => p.timedOut), 'card marked timed out');
});

test('hook: interrupt (signal abort) → deny', async () => {
  const es = fakeSession();
  const ac = new AbortController();
  es._canUseTool = function (name, input, o) {
    return new Promise((resolve) => o.signal.addEventListener('abort', () => resolve({ behavior: 'deny', message: 'Cancelled', interrupt: true })));
  };
  setTimeout(() => ac.abort(), 20);
  const out = await G.createHook(es).hooks[0](pre('git push'), 'tu1', { signal: ac.signal });
  assert.strictEqual(decision(out), 'deny');
});

test('hook: any error → deny, never a throw (a thrown hook error lets the tool run)', async () => {
  const es = fakeSession({ canUse: 'throw' });
  const out = await G.createHook(es).hooks[0](pre('git push'), 'tu1', { signal: new AbortController().signal });
  assert.strictEqual(decision(out), 'deny');
  const es2 = fakeSession();
  const out2 = await G.createHook(es2, { git: async () => { throw new Error('git exploded'); } }).hooks[0](pre('git push'), 'tu1', {});
  assert.strictEqual(decision(out2), 'deny');
  assert.match(out2.hookSpecificOutput.permissionDecisionReason, /could not check/);
});

test('hook: settings prodGuard:false turns it off; unreadable settings keep it on', async () => {
  const es = fakeSession();
  fs.writeFileSync(path.join(es.engine.userDataDir, 'settings.json'), JSON.stringify({ prodGuard: false }));
  assert.deepStrictEqual(await G.createHook(es).hooks[0](pre('git push'), 'tu1', {}), {});
  assert.strictEqual(es.asked.length, 0);
  const es2 = fakeSession({ answer: { behavior: 'deny' } });
  fs.writeFileSync(path.join(es2.engine.userDataDir, 'settings.json'), '{not json');
  assert.strictEqual(decision(await G.createHook(es2).hooks[0](pre('git push'), 'tu1', {})), 'deny');
});

test('prior approval: the user typed "commit and push" → through with a visible line, no card', async () => {
  const es = fakeSession();
  send(es, 'fix the footer, commit and push', 'user');
  const out = await G.createHook(es).hooks[0](pre('git push'), 'tu1', {});
  assert.deepStrictEqual(out, {});
  assert.strictEqual(es.asked.length, 0, 'no card');
  assert.match(es.lines[0].text, /^Production push to Shop master allowed · you said “.*push” at \d\d:\d\d$/);
  assert.ok(es.logs.some((l) => /let .*git push.* through/.test(l)), 'logged');
  // covers later pushes too, until a new prompt
  assert.deepStrictEqual(await G.createHook(es).hooks[0](pre('git push origin master'), 'tu2', {}), {});
});

test('prior approval: "commit, don\'t push" → card', async () => {
  const es = fakeSession({ answer: { behavior: 'deny' } });
  send(es, "commit, don't push", 'user');
  assert.strictEqual(decision(await G.createHook(es).hooks[0](pre('git push'), 'tu1', {})), 'deny');
  assert.strictEqual(es.asked.length, 1);
});

test('prior approval: Helm-generated and origin-less sends neither count nor reset', async () => {
  const es = fakeSession({ answer: { behavior: 'deny' } });
  send(es, 'push it', 'helm');
  send(es, 'push it'); // internal call, no origin
  assert.strictEqual(decision(await G.createHook(es).hooks[0](pre('git push'), 'tu1', {})), 'deny', 'not counted');
  const es2 = fakeSession();
  send(es2, 'commit and push', 'user');
  send(es2, 'Continue where you left off', 'helm'); // stall Resume
  send(es2, 'Write a handoff', 'helm');             // fresh start handoff
  assert.deepStrictEqual(await G.createHook(es2).hooks[0](pre('git push'), 'tu1', {}), {}, 'still approved');
  send(es2, 'now fix the tests', 'user'); // a newer typed prompt replaces it
  es2._canUseTool = () => Promise.resolve({ behavior: 'deny' });
  assert.strictEqual(decision(await G.createHook(es2).hooks[0](pre('git push'), 'tu1', {})), 'deny');
});

test('prior approval: a queued prompt counts only once it reaches Claude', () => {
  const es = fakeSession();
  const item = { uuid: 'q1', text: 'push it' };
  G.noteSend(es, item, 'user');
  assert.strictEqual(G.priorApproval(es, { approvable: 'all' }), null, 'not yet pushed to the CLI');
  G.notePushed(es, item);
  assert.ok(G.priorApproval(es, { approvable: 'all' }));
});

test('prior approval: "yes" after Claude asked, AskUserQuestion answers, restart scope, railway down', () => {
  const es = fakeSession({ lastText: 'Tests pass. Want me to push to master?' });
  send(es, 'yes', 'user');
  assert.ok(G.priorApproval(es, { approvable: 'all' }));
  const es2 = fakeSession();
  G.noteAnswer(es2, { questions: [{ question: 'Push to master now?' }] }, { 'Push to master now?': 'Yes, push' });
  assert.ok(G.priorApproval(es2, { approvable: 'all' }));
  G.noteAnswer(es2, { questions: [{ question: 'Push to master now?' }] }, { 'Push to master now?': 'Not yet' });
  assert.strictEqual(G.priorApproval(es2, { approvable: 'all' }), null, 'a later "not yet" clears it');
  const es3 = fakeSession();
  send(es3, 'restart the api on railway', 'user');
  assert.ok(G.priorApproval(es3, { approvable: 'restart' }));
  assert.strictEqual(G.priorApproval(es3, { approvable: 'all' }), null, 'restart does not approve a push');
  send(es3, 'push and deploy', 'user');
  assert.strictEqual(G.priorApproval(es3, { approvable: false }), null, 'railway down always asks');
});
