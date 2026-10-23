// Production guard, hidden pushes (backlog H3): gh writes, git push hidden in re-entry / chains /
// refspecs, and pushes inside local scripts and package scripts. Real git in throwaway repos whose
// remotes only LOOK like Shop / Client Portal (nothing is pushed); gh is a fake runner (no network).
// Every case that must still pass (reads, non-protected branches, everyday npm) is checked too.
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-guard-hidden-'));
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
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const fwd = (p) => p.replace(/\\/g, '/');
const put = (dir, rel, text) => { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); return f; };

// fake gh: PR 1 targets master, PR 2 targets next, anything else fails (no network, not logged in…)
const ghCalls = [];
const gh = async (dir, args) => {
  ghCalls.push(args.join(' '));
  const n = args[2] && !/^-/.test(args[2]) ? args[2] : null;
  if (n === '1' || /\/pull\/1$/.test(n || '')) return { ok: true, out: 'master', err: '' };
  if (n === '2') return { ok: true, out: 'next', err: '' };
  return { ok: false, out: '', err: 'no pull requests found' };
};
const bash = (command, cwd = shop) => G.assess('Bash', { command }, { cwd, gh, targets: T });
const ps = (command, cwd = shop) => G.assess('PowerShell', { command }, { cwd, gh, targets: T });

async function hit(p, re, label, descRe) {
  const v = await p;
  assert.ok(v, `${label}: expected a guard hit, got none`);
  if (re) assert.match(v.title, re, label);
  if (descRe) assert.match(v.description, descRe, `${label}: description "${v.description}"`);
  return v;
}
async function none(p, label) {
  const v = await p;
  assert.strictEqual(v, null, `${label}: expected no guard, got ${v && v.title}`);
}

// ---------- git push hidden in re-entry, chains and refspecs ----------
test('git push hidden in shells, chains, eval, env prefixes, -C and refspecs', async () => {
  const A = fwd(shop);
  await hit(bash(`bash -c "cd '${A}' && git push origin master"`, helm), /Shop master/, 'bash -c');
  await hit(bash(`sh -c 'git -C "${A}" push'`, helm), /Shop master/, 'sh -c + git -C');
  await hit(bash(`powershell -Command "Set-Location '${A}'; git push origin master"`, helm), /Shop master/, 'powershell -Command');
  await hit(bash(`pwsh -c "git -C '${A}' push origin HEAD:master"`, helm), /Shop master/, 'pwsh -c');
  await hit(bash(`cmd /c "cd /d ${shop} && git push origin master"`, helm), /Shop master/, 'cmd /c');
  await hit(bash('npm test && git push origin master'), /Shop master/, '&& chain');
  await hit(bash('echo ok; git push origin master'), /Shop master/, '; chain');
  await hit(bash('git log -1 | git push origin master'), /Shop master/, '| chain');
  await hit(bash(`eval "git -C '${A}' push"`, helm), /Shop master/, 'eval');
  await hit(bash('GIT_SSH_COMMAND="ssh -q" HUSKY=0 git push origin master'), /Shop master/, 'env prefix');
  await hit(bash(`env -u FOO git -C "${A}" push`, helm), /Shop master/, 'env + -C');
  await hit(bash(`git -C "${A}" push origin master`, helm), /Shop master/, 'git -C <path> push');
  await hit(bash('git push origin HEAD:master', shopNext), /Shop master/, 'HEAD:master');
  await hit(bash('git push origin next:master', shopNext), /Shop master/, 'next:master');
  await hit(bash('git push origin +master'), /Shop master/, '+master');
  await hit(bash('git push --force origin master', shopNext), /Shop master/, '--force to master');
  await hit(bash('git push -f origin next:refs/heads/master', shopNext), /Shop master/, '-f full ref');
  await hit(ps(`pwsh -NoProfile -c "cd '${shop}'; git push origin master"`, helm), /Shop master/, 'PowerShell tool → pwsh -c');
});

// ---------- gh ----------
test('gh: merges, releases and api writes that ship to Shop master / Client Portal are guarded', async () => {
  await hit(bash('gh pr merge 1 --squash --delete-branch'), /Production merge · Shop master/, 'pr merge into master',
    /^This command \(gh pr merge\) merges a pull request into Shop master, which is production\.$/);
  await hit(bash('gh pr merge --auto --merge'), /Shop master/, 'pr merge, base unknown', /could not confirm the target branch/);
  await hit(bash('gh pr merge https://github.com/Example/shop/pull/1 --rebase', plain), /Shop master/, 'PR URL from anywhere');
  await hit(bash('gh pr merge 1 -R Example/shop', helm), /Shop master/, '-R from Helm');
  await hit(bash('gh pr merge 1 --repo=github.com/Example/shop', helm), /Shop master/, '--repo=host/owner/repo');
  await hit(bash('GH_REPO=Example/shop gh pr merge 1', helm), /Shop master/, 'GH_REPO= prefix');
  await hit(bash('git fetch && gh pr merge 1 --admin'), /Shop master/, 'gh in a chain');
  await hit(bash(`bash -c "cd '${fwd(shop)}' && gh pr merge 1"`, helm), /Shop master/, 'gh inside bash -c');
  await hit(bash('gh release create v1.4.0 --generate-notes'), /Production release · Shop master/, 'release create',
    /publishes a GitHub release of Shop master, which is production/);
  await hit(bash('gh release edit v1.4.0 --draft=false'), /Shop master/, 'publishing a draft');
  await hit(bash('gh release create v9', portal), /Client Portal/, 'Client Portal release', /the Client Portal repo, where every push is guarded/);
  await hit(bash('gh repo sync Example/shop --branch master', plain), /Shop master/, 'repo sync of the remote');
  await hit(bash('gh api -X PATCH repos/Example/shop/git/refs/heads/master -f sha=abc -F force=true', plain), /Production GitHub write · Shop master/, 'api PATCH ref',
    /changes Shop master, which is production/);
  await hit(bash('gh api --method=DELETE /repos/Example/shop/git/refs/heads/master', plain), /Shop master/, 'api DELETE ref');
  await hit(bash('gh api repos/Example/shop/git/refs -f ref=refs/heads/master -f sha=abc', plain), /Shop master/, 'api POST via -f (implied)');
  await hit(bash('gh api repos/{owner}/{repo}/merges -f base=master -f head=next'), /Production merge · Shop master/, 'api merges, {owner}/{repo}');
  await hit(bash('gh api -XPUT repos/Example/shop/contents/README.md -f message=x -f content=eA==', plain), /Shop master/, 'api contents (default branch)');
  await hit(bash('gh api -X PUT repos/Example/shop/pulls/1/merge', plain), /Production merge · Shop master/, 'api pull merge');
  await hit(bash('gh api repos/Example/shop/releases -f tag_name=v2', plain), /Production release · Shop master/, 'api release');
  await hit(bash('gh api repos/Example/shop/actions/workflows/deploy.yml/dispatches -f ref=master', plain), /Shop master/, 'api workflow dispatch on master');
  await hit(bash("gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: \"X\"}) { clientMutationId } }'"), /Shop master/, 'graphql merge mutation');
  await hit(bash('gh api -X POST repos/Example/client-portal/git/refs -f ref=refs/heads/x -f sha=abc', plain), /Client Portal/, 'Client Portal ref write');
  await hit(ps('gh pr merge 1 --squash'), /Shop master/, 'PowerShell tool');
  await hit(bash('cd "$WHERE" && gh pr merge 3', helm), /folder unknown/, 'unknown folder asks');
});

test('gh: reads and writes that do not ship stay automatic', async () => {
  for (const c of ['gh pr view 1', 'gh pr view 1 --json baseRefName', 'gh pr list', 'gh pr list --base master', 'gh pr status', 'gh pr checks 1',
    'gh pr diff 1', 'gh pr create --base master --title x --body y', 'gh pr merge 2 --squash', 'gh pr merge 1 --disable-auto',
    'gh run list', 'gh run view 5 --log', 'gh release list', 'gh release view v1', 'gh release create v1 --draft', 'gh release create v1 --target next',
    'gh repo view', 'gh repo sync', 'gh issue create -t x -b y', 'gh issue comment 3 -b hi', 'gh auth status',
    'gh api repos/Example/shop/commits', 'gh api repos/Example/shop/pulls --jq .[].number', 'gh api -X GET repos/Example/shop/branches -f per_page=100',
    'gh api repos/Example/shop/issues/3/comments -f body=hi', 'gh api -X DELETE repos/Example/shop/git/refs/heads/feature-x',
    'gh api repos/Example/shop/merges -f base=next -f head=feature', 'gh api -X POST repos/Example/shop/git/refs -f ref=refs/tags/v1 -f sha=abc',
    "gh api graphql -f query='query { viewer { login } }'", 'echo "gh pr merge 1"', 'git commit -m "gh pr merge 1"']) {
    await none(bash(c), c);
  }
  for (const c of ['gh pr merge 1', 'gh release create v1', 'gh api -X PATCH repos/{owner}/{repo}/git/refs/heads/master -f sha=a']) await none(bash(c, helm), `Helm: ${c}`);
  await none(bash('gh pr merge 1', plain), 'not a repo, no -R: gh fails');
});

// ---------- scripts ----------
test('scripts: a push inside a local script is caught, in every way of running it', async () => {
  put(shop, 'deploy.sh', '#!/usr/bin/env bash\nset -e\nnpm test\ngit push origin master\n');
  put(shop, 'deploy.ps1', '$ErrorActionPreference = "Stop"\ngit push origin HEAD:master\n');
  fs.writeFileSync(path.join(shop, 'deploy16.ps1'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('git push origin master\r\n', 'utf16le')]));
  put(shop, 'deploy.cmd', '@echo off\r\ncd /d %~dp0\r\ngit push origin master\r\n');
  put(shop, 'bin/ship', '#!/bin/sh\ngit push --force origin master\n');
  put(shop, 'release.js', "const { execSync } = require('child_process');\nexecSync('git push origin master', { stdio: 'inherit' });\n");
  put(shop, 'spawn.mjs', "import { spawnSync } from 'node:child_process';\nspawnSync('git', ['push', 'origin', 'master']);\n");
  put(shop, 'tmpl.js', "const b = process.argv[2];\nrequire('child_process').execSync(`git push origin ${b}`);\n");
  put(shop, 'gh.js', "require('child_process').execFileSync('gh', ['pr', 'merge', '1', '--squash']);\n");
  put(shop, 'self.sh', 'cd "$(dirname "$0")" && git push origin master\n');

  await hit(bash('./deploy.sh'), /Production push · Shop master · script deploy\.sh/, './deploy.sh',
    /^The script \.\/deploy\.sh pushes to Shop master, which is production\.$/);
  await hit(bash('bash deploy.sh'), /Shop master/, 'bash deploy.sh');
  await hit(bash('sh -e ./deploy.sh'), /Shop master/, 'sh -e ./deploy.sh');
  await hit(bash('source ./deploy.sh'), /Shop master/, 'source');
  await hit(bash('. ./deploy.sh'), /Shop master/, '. (dot)');
  await hit(bash(`"${fwd(shop)}/deploy.sh"`, shop), /Shop master/, 'full path');
  await hit(bash('npm run lint && ./deploy.sh'), /Shop master/, 'script in a chain');
  await hit(ps('.\\deploy.ps1'), /Shop master/, '.\\deploy.ps1', /The script \.\\deploy\.ps1 pushes to Shop master/);
  await hit(ps('& ./deploy.ps1 -Verbose'), /Shop master/, '& ./deploy.ps1');
  await hit(bash('powershell -ExecutionPolicy Bypass -File deploy.ps1'), /Shop master/, 'powershell -File');
  await hit(bash('pwsh -File ./deploy16.ps1'), /Shop master/, 'UTF-16 .ps1');
  await hit(bash(`cmd /c "${path.join(shop, 'deploy.cmd')}"`, helm), /Shop master/, 'cmd /c x.cmd (cd /d %~dp0)');
  await hit(bash('./bin/ship'), /Shop master/, '#! file with no extension');
  await hit(bash('node release.js'), /Shop master/, 'node release.js (execSync string)');
  await hit(bash('node spawn.mjs'), /Shop master/, 'spawnSync array');
  await hit(bash('node tmpl.js next'), /Shop master/, 'template literal with a run-time branch');
  await hit(bash('node gh.js'), /Production merge · Shop master/, 'gh inside a JS script', /The script gh\.js runs gh pr merge: it merges a pull request into Shop master/);
  await hit(bash(`node -e "require('child_process').execSync('git push origin master')"`), /Shop master/, 'node -e');
  await hit(bash(`bash ${fwd(path.join(shop, 'self.sh'))}`, helm), /Shop master/, 'script cds to its own folder ($0)');
  await hit(bash(`bash -c "./deploy.sh"`), /Shop master/, 'script inside bash -c');
});

test('scripts: package scripts (npm / pnpm / yarn / bun), pre/post hooks, one nested level', async () => {
  put(shop, 'scripts/inner.sh', 'git push origin master\n');
  put(shop, 'scripts/outer.sh', 'echo releasing\nbash scripts/inner.sh\n');
  put(shop, 'package.json', JSON.stringify({
    scripts: {
      ship: 'npm test && git push origin master', test: 'node -e 1', build: 'node -e 1', 'deploy-next': 'git push origin next',
      release: 'bash scripts/outer.sh', predeploy2: 'git push origin master', deploy2: 'echo hi', lint: 'echo lint',
    },
  }));
  await hit(bash('npm run ship'), /Production push · Shop master · npm run ship/, 'npm run ship',
    /^The package script “npm run ship” pushes to Shop master, which is production\.$/);
  await hit(bash('npm run-script ship -- --yes'), /Shop master/, 'npm run-script');
  await hit(bash('pnpm run ship'), /Shop master/, 'pnpm run');
  await hit(bash('pnpm ship'), /Shop master/, 'pnpm <script>');
  await hit(bash('yarn ship'), /Shop master/, 'yarn <script>');
  await hit(bash('bun run ship'), /Shop master/, 'bun run');
  await hit(bash(`npm --prefix "${fwd(shop)}" run ship`, helm), /Shop master/, 'npm --prefix');
  await hit(bash(`yarn --cwd ${fwd(shop)} ship`, helm), /Shop master/, 'yarn --cwd');
  await hit(bash('npm run deploy2'), /Shop master/, 'pre-script pushes');
  await hit(ps('npm run ship'), /Shop master/, 'PowerShell tool');
  const v = await hit(bash('npm run release'), /Shop master · script inner\.sh/, 'npm script → outer.sh → inner.sh (nested)');
  assert.match(v.description, /^The script scripts\/inner\.sh \(run by “npm run release”, then scripts\/outer\.sh\) pushes to Shop master, which is production\.$/);
  await hit(bash('bash scripts/outer.sh'), /Shop master/, 'script calls a script');
  put(portal, 'go.sh', 'git push origin feature-x\n');
  await hit(bash('./go.sh', portal), /Client Portal/, 'Client Portal script, any branch', /The script \.\/go\.sh pushes to the Client Portal repo, where every push is guarded/);
});

test('scripts: everyday commands and scripts that do not reach production stay automatic', async () => {
  put(shopNext, 'push-next.sh', 'git push origin next\n');
  put(helm, 'ship.sh', 'git push origin master\ngh release create v1\n');
  put(helm, 'package.json', JSON.stringify({ scripts: { ship: 'bash ship.sh', test: 'node --test test/*.test.js' } }));
  put(plain, 'other.sh', `git -C "${fwd(helm)}" push origin master\n`);
  put(plain, 'notes.js', "console.log('remember to run tests');\nconst x = require('./lib.js');\n");
  for (const [c, cwd] of [
    ['./push-next.sh', shopNext], ['git push origin next', shopNext], ['git push origin feature-x', shop], ['git push', helm],
    ['./ship.sh', helm], ['npm run ship', helm], ['npm test', helm], ['npm test', shop], ['npm run build', shop], ['npm run deploy-next', shop],
    ['npm run lint', shop], ['npm run missing', shop], ['npm install', shop], ['yarn install', shop], ['pnpm install', shop], ['pnpm deploy ../out', shop],
    ['bun test', shop], ['npx vitest run', shop], ['bash other.sh', plain], ['node notes.js', plain], ['./nope.sh', shop], ['bash nope.sh', shop],
    ['cat deploy.sh', shop], ['ls ./scripts', shop], ['code ./deploy.sh', shop], ['git diff -- ./deploy.sh', shop], ['node -e "console.log(1)"', shop],
    ['git status && git log --oneline -5', shop], ['gh pr view 1', shop],
  ]) await none(bash(c, cwd), `${c} (in ${path.basename(cwd)})`);
});

test('scripts: a script that cannot be read asks only when the command names a guarded repo or branch', async () => {
  put(shop, 'big.sh', 'git push origin master\n' + '# padding\n'.repeat(30000)); // > 256 KB
  put(shop, 'a.sh', 'bash b.sh\n');
  put(shop, 'b.sh', 'bash c.sh\n');
  put(shop, 'c.sh', 'git push origin master\n');
  // not named: runs (the trade-off: no false positives on everyday scripts)
  await none(bash('./big.sh'), 'too big, not named');
  await none(bash('./a.sh'), 'third level not read, not named');
  await none(bash('bash "$SCRIPT"'), 'path only known at run time, not named');
  await none(bash('pnpm --filter web run deploy'), 'workspace filter, not named');
  // named: asks, and says why in plain words
  await hit(bash('./big.sh --branch master'), /Possible production push · \.\/big\.sh not read/, 'too big, names master',
    /^Helm could not read the script \.\/big\.sh \(it is larger than 256 KB\), and this command names master, so it asks in case it pushes to production\.$/);
  await hit(bash('./a.sh master'), /not read/, 'too deep, names master', /nested too deep/);
  await hit(bash(`bash "$SCRIPT" ${fwd(shop)}`, helm), /not read/, 'run-time path, names the Shop folder');
  await hit(bash('pnpm --filter shop run deploy'), /not read/, 'workspace filter, names shop', /other workspace packages/);
  await none(bash('./big.sh --branch next', shopNext), 'missing file + names nothing');
});

test('verdict: hits carry the script chain and gh command; a typed "push" can still pre-approve', async () => {
  put(shop, 'deploy.sh', 'git push origin master\n');
  const v = await bash('./deploy.sh');
  assert.deepStrictEqual(v.hits[0].via, ['./deploy.sh']);
  assert.strictEqual(v.approvable, 'all');
  const m = await bash('gh pr merge 1');
  assert.strictEqual(m.hits[0].gh, 'gh pr merge');
  assert.strictEqual(m.hits[0].target, 'shop');
  assert.ok(ghCalls.some((c) => c === 'pr view 1 --json baseRefName --jq .baseRefName'), 'base branch looked up with gh pr view');
});

test('scripts: JavaScript is best-effort, so what it cannot follow never asks (no false positives in Shop)', async () => {
  put(shop, 'tools/run-tests.js', "const { execSync } = require('child_process');\nfor (const f of files) execSync(`node ${f}`);\nexecSync('node tools/more.js');\n");
  put(shop, 'tools/more.js', "require('child_process').execSync('node tools/even-more.js');\n");
  put(shop, 'tools/even-more.js', "console.log('done');\n");
  put(shop, 'tools/package.json', JSON.stringify({ scripts: { test: 'node run-tests.js' } }));
  put(shop, 'package.json', JSON.stringify({ scripts: { test: 'node tools/run-tests.js', 'ci:master': 'node tools/run-tests.js' } }));
  await none(bash(`cd "${fwd(shop)}" && npm test`, helm), 'npm test in a folder named shop');
  await none(bash('npm run ci:master'), 'script name says master; its JS spawns run-time paths');
});

// ---------- false positives from 2026-10-17: node --check, and JS git calls with a run-time subcommand ----------
// HELPER_JS mirrors browser-preview's preview-helper.js: git(cwd, args) -> execFileSync('git', ['-C', cwd, ...args])
// with only literal fetch / worktree / rev-parse / branch / merge subcommands, and array .push( calls (the word
// push never appears as a string).
const HELPER_JS = [
  '#!/usr/bin/env node',
  "'use strict';",
  "const { spawn, execFileSync } = require('child_process');",
  'const LIVE_REPO = process.env.LIVE_REPO;',
  'function git(cwd, gitArgs, opts = {}) {',
  "  return execFileSync('git', ['-C', cwd, ...gitArgs], { encoding: 'utf8', windowsHide: true, ...opts }).trim();",
  '}',
  "function head(dir) { try { return git(dir, ['rev-parse', '--short', 'HEAD']); } catch { return '?'; } }",
  "function branch(dir) { try { return git(dir, ['branch', '--show-current']) || 'detached'; } catch { return '?'; } }",
  "function sync(dir, br) { git(LIVE_REPO, ['fetch', '--quiet', 'origin', br]); git(LIVE_REPO, ['worktree', 'add', '--detach', dir, 'origin/' + br]); git(dir, ['merge', '--ff-only', 'origin/' + br]); }",
  'const queue = []; const handlers = [];',
  'function on(h) { handlers.push(h); }',
  "queue.push({ head: head('.'), branch: branch('.') });",
  "const a = []; a .push('--test-profile'); a?.push('--offscreen');",
  "spawn(process.execPath, a, { stdio: 'inherit' });",
  '',
].join('\n');

test('false positives: node --check never runs the file; a JS git call with a run-time subcommand needs a "push" in sight', async () => {
  const gb = (p) => fwd(p).replace(/^([A-Za-z]):/, (_, d) => '/' + d.toLowerCase());
  const preview = path.join(root, 'browser-preview');
  put(preview, 'preview-helper.js', HELPER_JS);
  const pv = gb(preview);
  // the exact command that fired ("Possible production push · folder unknown · script preview-helper.js")
  const exact = `cd ${pv} && node -e "const fs=require('fs');let s=fs.readFileSync('preview-helper.js','utf8');s=s.split(String.fromCharCode(0)).join('');fs.writeFileSync('preview-helper.js',s)" && node --check preview-helper.js && grep -n "execFileSync('git'" preview-helper.js | head -2; grep -n "gitArgs" preview-helper.js`;
  await none(bash(exact, helm), 'the exact command from the false alarm');
  await none(bash(`cd ${pv} && node --check preview-helper.js`, helm), 'node --check');
  await none(bash(`cd ${pv} && node -c preview-helper.js`, helm), 'node -c');
  await none(bash(`cd ${pv} && node preview-helper.js`, helm), 'running it: no push word, folder not guarded');
  await none(bash(`cd "${fwd(helm)}" && node "${fwd(path.join(preview, 'preview-helper.js'))}"`, helm), 'run from a non-guarded repo');
  // stray NULs (what the command was fixing): early ones used to make the file look binary; now it is read either way
  const nulHead = path.join(root, 'nul-head');
  const nulLate = path.join(root, 'nul-late');
  fs.mkdirSync(nulHead);
  fs.mkdirSync(nulLate);
  const buf = Buffer.from(HELPER_JS);
  fs.writeFileSync(path.join(nulHead, 'preview-helper.js'), Buffer.concat([buf.slice(0, 40), Buffer.from([0, 0]), buf.slice(40)]));
  fs.writeFileSync(path.join(nulLate, 'preview-helper.js'), Buffer.concat([buf, Buffer.alloc(600, 32), Buffer.from([0, 0])]));
  for (const d of [nulHead, nulLate]) {
    await none(bash(`cd ${gb(d)} && node --check preview-helper.js && node preview-helper.js`, helm), `NULs in ${path.basename(d)}`);
  }

  // ---- real pushes are still caught ----
  const shop2 = repo('shop-guardfp', 'https://github.com/Example/shop.git');
  put(shop2, 'ship.sh', 'git push origin master\n');
  put(shop2, 'ship.ps1', 'git push origin HEAD:master\n');
  put(shop2, 'ship.js', "require('child_process').execFileSync('git', ['push', 'origin', 'master']);\n");
  put(shop2, 'ship-str.js', "require('child_process').execSync('git push origin master');\n");
  put(shop2, 'helper.js', HELPER_JS);
  put(shop2, 'package.json', JSON.stringify({ scripts: { ship: 'node --check ship.js && git push origin master', check: 'node --check ship.js', verify: 'node --check helper.js && node helper.js' } }));
  await hit(bash('bash ship.sh', shop2), /Shop master/, 'git push in a .sh');
  await hit(ps('.\\ship.ps1', shop2), /Shop master/, 'git push in a .ps1');
  await hit(bash('node ship.js', shop2), /Shop master/, "execFileSync('git', ['push', ...])");
  await hit(bash('node --check ship.js && node ship.js', shop2), /Shop master/, '--check, then really running it');
  await hit(bash('node ship.js --check', shop2), /Shop master/, "--check after the script is the script's own argument");
  await hit(bash('node --check ship-str.js; node ship-str.js', shop2), /Shop master/, 'execSync string after a --check');
  await hit(bash(`node -c -e "require('child_process').execSync('git push origin master')"`, shop2), /Shop master/, '-e code is still scanned');
  await hit(bash('npm run ship', shop2), /Shop master/, 'npm script that checks then pushes');
  await none(bash('npm run check', shop2), 'npm script that only checks');
  // a run-time subcommand whose "push" is spelled in the script, or on the command line
  const subs = [
    ['sub-const.js', "const { execFileSync } = require('child_process');\nconst git = (dir, a) => execFileSync('git', ['-C', dir, ...a]);\nconst sub = 'push';\ngit(process.cwd(), [sub, 'origin', 'master']);\n"],
    ['sub-dq.js', 'const cp = require("child_process");\nconst verb = "push";\ncp.execFileSync("git", ["-C", process.cwd(), verb, "origin", "master"]);\n'],
    ['sub-tmpl.js', "const cp = require('child_process');\nconst v = `push`;\ncp.execFileSync('git', ['-C', process.cwd(), v]);\n"],
    ['sub-hole.js', "const cp = require('child_process');\nconst v = 'push';\ncp.execSync(`git -C ${process.cwd()} ${v} origin master`);\n"],
  ];
  for (const [name, src] of subs) {
    put(preview, name, src);
    await hit(bash(`cd ${pv} && node ${name}`, helm), /Possible production push · folder unknown · script sub-/, `${name} from a plain folder`);
  }
  put(preview, 'argv.js', "const cp = require('child_process');\ncp.execFileSync('git', ['-C', process.cwd(), ...process.argv.slice(2)]);\n");
  await hit(bash(`cd ${pv} && node argv.js push origin master`, helm), /Possible production push/, 'push passed on the command line');
  await none(bash(`cd ${pv} && node argv.js status`, helm), 'argv.js status');
  // no "push" anywhere, but run in an Shop / Client Portal folder: still asks
  put(portal, 'helper.js', HELPER_JS);
  await hit(bash('node helper.js', shop2), /Shop master/, 'run-time subcommand, run in Shop');
  await hit(bash('node helper.js', portal), /Client Portal/, 'run-time subcommand, run in Client Portal');
  await hit(bash('npm run verify', shop2), /Shop master/, 'npm script running the helper in Shop');
  // a NUL early in a JS file that pushes no longer hides it
  fs.writeFileSync(path.join(shop2, 'nul-ship.js'), Buffer.concat([Buffer.from('// x'), Buffer.from([0]), Buffer.from("\nrequire('child_process').execSync('git push origin master');\n")]));
  await hit(bash('node nul-ship.js', shop2), /Shop master/, 'NUL in the head of a pushing script');
});
