// Unit tests for main/claude-config.js (Settings -> Claude Code). Everything runs in temp dirs:
// claudeDir, home, project folders and the profile are all under os.tmpdir(); the real ~/.claude is
// never read or written (the guard test below fails loudly if the module ever resolves there).
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createClaudeConfig, engineSessionReader, parseFrontmatter, memoryMeta, slugOf } = require('../../main/claude-config.js');
const { createRouter } = require('../../main/rpc.js');

const REAL_CLAUDE = path.join(os.homedir(), '.claude').toLowerCase();
const tmpRoots = [];
after(() => { for (const d of tmpRoots) fs.rmSync(d, { recursive: true, force: true }); });

const w = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; };
const MEM = (name, description, type, body = 'Body text.') => `---\nname: ${name}\ndescription: "${description}"\nmetadata: \n  node_type: memory\n  type: ${type}\n---\n\n${body}\n`;

// home/.claude/{CLAUDE.md, settings.json, projects/<home slug>/memory/*, projects/<proj slug>/memory/*}
// home/proj (a project with CLAUDE.md, CLAUDE.local.md, .claude/CLAUDE.md); outside/ (not allowed)
function sandbox(extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-ccfg-'));
  tmpRoots.push(root);
  const home = path.join(root, 'home');
  const claudeDir = path.join(home, '.claude');
  const proj = path.join(home, 'proj');
  const outside = path.join(root, 'outside');
  const profileDir = path.join(root, 'profile');
  fs.mkdirSync(profileDir, { recursive: true });
  w(path.join(claudeDir, 'CLAUDE.md'), '# Global rules\n\nAlways use agents.\n');
  w(path.join(claudeDir, 'settings.json'), '{"secret":true}');
  w(path.join(proj, 'CLAUDE.md'), '# Proj\n');
  w(path.join(proj, 'CLAUDE.local.md'), '# Local\n');
  w(path.join(proj, '.claude', 'CLAUDE.md'), '# Dot claude\n');
  w(path.join(proj, 'README.md'), 'not allowed');
  w(path.join(outside, 'CLAUDE.md'), 'outside');
  w(path.join(outside, 'secret.md'), 'secret');
  const homeMem = path.join(claudeDir, 'projects', slugOf(home), 'memory');
  w(path.join(homeMem, 'MEMORY.md'), [
    '- [Storefront](project_storefront.md) — AI task SaaS',
    '- [Gone](project_gone.md) — this file was deleted',
    '- [Escape](../../../secret.md) — points outside',
    '- [Docs](https://example.com) — an external link is not a memory link',
    'Some prose that is not an index line.',
    '* [Budget](feedback_agent-budget.md): ask about sub-agents',
  ].join('\n') + '\n');
  w(path.join(homeMem, 'project_storefront.md'), MEM('Storefront', 'AI task automation SaaS', 'project', 'Express plus Postgres plus Clerk.'));
  w(path.join(homeMem, 'feedback_agent-budget.md'), '---\nname: agent-budget\ndescription: >\n  Rules on agent count\n  and pacing\ntype: feedback\n---\nNever nested. The magic word is zebracorn.\n');
  w(path.join(homeMem, 'orphan_note.md'), MEM('Orphan', 'Not in the index', 'reference'));
  w(path.join(homeMem, 'notes.txt'), 'not markdown');
  w(path.join(homeMem, 'sub', 'nested.md'), MEM('Nested', 'too deep', 'project'));
  const projMem = path.join(claudeDir, 'projects', slugOf(proj), 'memory');
  w(path.join(projMem, 'only.md'), MEM('Only', 'no index here', 'project'));
  fs.mkdirSync(path.join(claudeDir, 'projects', 'C--empty', 'memory'), { recursive: true });
  w(path.join(claudeDir, 'projects', slugOf(proj), 'abc.md'), 'a transcript-ish md outside memory');
  let t = Date.parse('2026-10-08T12:00:00Z');
  const cfg = createClaudeConfig({ home, claudeDir, profileDir, getProjectDirs: async () => [proj, home, outside + '-missing'], now: () => (t += 1000), ...extra });
  return { root, home, claudeDir, proj, outside, profileDir, homeMem, projMem, cfg };
}

test('guard: the sandbox never points at the real ~/.claude', () => {
  const s = sandbox();
  assert.ok(!s.cfg.claudeDir.toLowerCase().startsWith(REAL_CLAUDE), s.cfg.claudeDir);
  assert.ok(s.cfg.claudeDir.startsWith(os.tmpdir()));
  assert.ok(s.cfg.backupDir.startsWith(os.tmpdir()));
});

describe('list', () => {
  test('instructions: global + the three project variants, home .claude/CLAUDE.md not listed twice', async () => {
    const s = sandbox();
    const r = await s.cfg.list();
    assert.equal(r.instructions.global.exists, true);
    assert.equal(r.instructions.global.path, path.join(s.claudeDir, 'CLAUDE.md'));
    assert.ok(r.instructions.global.size > 0 && r.instructions.global.mtime > 0);
    const p = r.instructions.projects.find((x) => x.cwd === s.proj);
    assert.deepEqual(p.files.map((f) => f.rel).sort(), ['.claude/CLAUDE.md', 'CLAUDE.local.md', 'CLAUDE.md']);
    const h = r.instructions.projects.find((x) => x.cwd === s.home);
    assert.deepEqual(h.files, [], 'home/.claude/CLAUDE.md is the global file');
    assert.ok(!r.instructions.projects.some((x) => x.cwd.endsWith('-missing')), 'missing folders are skipped');
  });

  test('memory: index lines, broken links, outside links, unindexed files, frontmatter', async () => {
    const s = sandbox();
    const { memory } = await s.cfg.list();
    assert.equal(memory.emptyFolders, 1);
    const home = memory.folders[0];
    assert.equal(home.isHome, true);
    assert.equal(home.project, s.home);
    assert.equal(home.index.exists, true);
    const byTitle = Object.fromEntries(home.entries.map((e) => [e.title, e]));
    assert.deepEqual(Object.keys(byTitle), ['Storefront', 'Gone', 'Escape', 'Budget']);
    assert.equal(byTitle.Storefront.status, 'ok');
    assert.equal(byTitle.Storefront.hook, 'AI task SaaS');
    assert.equal(byTitle.Storefront.file.type, 'project');
    assert.equal(byTitle.Storefront.file.description, 'AI task automation SaaS');
    assert.equal(byTitle.Gone.status, 'missing');
    assert.equal(byTitle.Gone.line, 2);
    assert.equal(byTitle.Escape.status, 'outside');
    assert.equal(byTitle.Escape.path, null);
    assert.equal(byTitle.Budget.status, 'ok');
    assert.equal(byTitle.Budget.hook, 'ask about sub-agents');
    assert.equal(byTitle.Budget.file.description, 'Rules on agent count and pacing');
    assert.equal(home.broken, 2);
    assert.deepEqual(home.unindexed.map((u) => u.file), ['orphan_note.md']);
    assert.equal(home.unindexed[0].name, 'Orphan');
    const pm = memory.folders.find((f) => f.slug === slugOf(s.proj));
    assert.equal(pm.project, s.proj);
    assert.equal(pm.index.exists, false);
    assert.deepEqual(pm.unindexed.map((u) => u.file), ['only.md']);
  });
});

describe('read', () => {
  test('global CLAUDE.md, a project variant, and a memory note with frontmatter', async () => {
    const s = sandbox();
    const g = await s.cfg.read({ path: path.join(s.claudeDir, 'CLAUDE.md') });
    assert.equal(g.kind, 'instructions');
    assert.equal(g.scope, 'global');
    assert.match(g.text, /Always use agents/);
    assert.equal(typeof g.mtime, 'number');
    const d = await s.cfg.read({ path: path.join(s.proj, '.claude', 'CLAUDE.md') });
    assert.equal(d.scope, 'project');
    assert.equal(d.project, s.proj);
    const m = await s.cfg.read({ path: path.join(s.homeMem, 'project_storefront.md') });
    assert.equal(m.kind, 'memory');
    assert.deepEqual(m.frontmatter, { name: 'Storefront', description: 'AI task automation SaaS', type: 'project', present: true });
    assert.match(m.body, /^\s*Express plus Postgres/);
  });

  test('a missing allowlisted file is not_found', async () => {
    const s = sandbox();
    await assert.rejects(s.cfg.read({ path: path.join(s.homeMem, 'project_gone.md') }), { code: 'not_found' });
  });
});

describe('allowlist and traversal', () => {
  const deniedCases = (s) => [
    ['settings.json in claudeDir', path.join(s.claudeDir, 'settings.json')],
    ['README in a project', path.join(s.proj, 'README.md')],
    ['CLAUDE.md in a folder that is not a project', path.join(s.outside, 'CLAUDE.md')],
    ['a .md in projects/<x>/ but not memory/', path.join(s.claudeDir, 'projects', slugOf(s.proj), 'abc.md')],
    ['nested below memory/', path.join(s.homeMem, 'sub', 'nested.md')],
    ['non-markdown in memory/', path.join(s.homeMem, 'notes.txt')],
    ['.. escaping memory/', path.join(s.homeMem) + path.sep + ['..', '..', '..', '..', '..', 'outside', 'secret.md'].join(path.sep)],
    ['.. that lands back on an allowed file', s.homeMem + path.sep + '..' + path.sep + 'memory' + path.sep + 'project_storefront.md'],
    ['forward-slash ..', s.homeMem.replace(/\\/g, '/') + '/../../../../outside/secret.md'],
    ['. segment', s.claudeDir + path.sep + '.' + path.sep + 'CLAUDE.md'],
    ['relative path', 'CLAUDE.md'],
    ['relative traversal', '../outside/secret.md'],
    ['UNC path', '\\\\server\\share\\CLAUDE.md'],
    ['device path', '\\\\?\\' + path.join(s.claudeDir, 'CLAUDE.md')],
    ['projects/memory itself (no project folder)', path.join(s.claudeDir, 'projects', 'memory', 'x.md')],
  ];

  test('every denied path is refused with forbidden/bad_params by read AND write, and nothing changes', async () => {
    const s = sandbox();
    const before = fs.readFileSync(path.join(s.outside, 'secret.md'), 'utf8');
    for (const [label, p] of deniedCases(s)) {
      await assert.rejects(s.cfg.read({ path: p }), (e) => ['forbidden', 'bad_params'].includes(e.code), `read: ${label}`);
      await assert.rejects(s.cfg.write({ path: p, text: 'pwned', expectMtime: 0 }), (e) => ['forbidden', 'bad_params'].includes(e.code), `write: ${label}`);
    }
    for (const bogus of [undefined, '', 42, null, 'a\0b', 'x'.repeat(2000)]) {
      await assert.rejects(s.cfg.read({ path: bogus }), { code: 'bad_params' }, String(bogus).slice(0, 10));
    }
    assert.equal(fs.readFileSync(path.join(s.outside, 'secret.md'), 'utf8'), before);
    assert.equal(fs.readFileSync(path.join(s.claudeDir, 'settings.json'), 'utf8'), '{"secret":true}');
    assert.equal(fs.existsSync(path.join(s.profileDir, 'claude-config-backups')), false, 'no backup for refused writes');
  });

  test('Windows alternate data streams are refused', { skip: process.platform !== 'win32' }, async () => {
    const s = sandbox();
    await assert.rejects(s.cfg.read({ path: path.join(s.homeMem, 'x:y.md') }), { code: 'forbidden' });
    await assert.rejects(s.cfg.read({ path: path.join(s.claudeDir, 'CLAUDE.md') + ':evil' }), { code: 'forbidden' });
  });

  test('a junction memory folder that points outside is refused and skipped by list', async () => {
    const s = sandbox();
    const evil = path.join(s.outside, 'evilmem');
    w(path.join(evil, 'secret.md'), MEM('Secret', 'outside', 'project'));
    const link = path.join(s.claudeDir, 'projects', 'C--evil', 'memory');
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(evil, link, 'junction');
    await assert.rejects(s.cfg.read({ path: path.join(link, 'secret.md') }), { code: 'forbidden' });
    await assert.rejects(s.cfg.write({ path: path.join(link, 'secret.md'), text: 'x', expectMtime: 0 }), { code: 'forbidden' });
    const { memory } = await s.cfg.list();
    assert.ok(!memory.folders.some((f) => f.slug === 'C--evil'));
    assert.ok(memory.skipped.some((x) => x.slug === 'C--evil' && x.reason === 'link'));
    const r = await s.cfg.search({ q: 'outside' });
    assert.ok(!r.results.some((x) => x.path.includes('evilmem') || x.slug === 'C--evil'));
  });

  test('a junction project folder slug pointing outside is refused', async () => {
    const s = sandbox();
    const evil = path.join(s.outside, 'evilproj');
    w(path.join(evil, 'memory', 'secret.md'), 'x');
    fs.symlinkSync(evil, path.join(s.claudeDir, 'projects', 'C--evil2'), 'junction');
    await assert.rejects(s.cfg.read({ path: path.join(s.claudeDir, 'projects', 'C--evil2', 'memory', 'secret.md') }), { code: 'forbidden' });
  });

  test('a project .claude junction pointing outside is refused (and flagged in list)', async () => {
    const s = sandbox();
    const proj2 = path.join(s.root, 'proj2');
    fs.mkdirSync(proj2, { recursive: true });
    const evil = path.join(s.outside, 'dotclaude');
    w(path.join(evil, 'CLAUDE.md'), 'outside text');
    fs.symlinkSync(evil, path.join(proj2, '.claude'), 'junction');
    const cfg = createClaudeConfig({ home: s.home, claudeDir: s.claudeDir, profileDir: s.profileDir, getProjectDirs: async () => [proj2] });
    await assert.rejects(cfg.read({ path: path.join(proj2, '.claude', 'CLAUDE.md') }), { code: 'forbidden' });
    await assert.rejects(cfg.write({ path: path.join(proj2, '.claude', 'CLAUDE.md'), text: 'x', expectMtime: 0 }), { code: 'forbidden' });
    assert.equal(fs.readFileSync(path.join(evil, 'CLAUDE.md'), 'utf8'), 'outside text');
    const listed = (await cfg.list()).instructions.projects[0].files;
    assert.equal(listed.length, 1);
    assert.match(listed[0].blocked, /link/);
  });

  test('a file symlink is refused', async (t) => {
    const s = sandbox();
    const link = path.join(s.homeMem, 'linked.md');
    try { fs.symlinkSync(path.join(s.outside, 'secret.md'), link, 'file'); } catch (e) {
      if (e.code === 'EPERM') { t.skip('file symlinks need Developer Mode or admin on Windows'); return; }
      throw e;
    }
    await assert.rejects(s.cfg.read({ path: link }), { code: 'forbidden' });
    await assert.rejects(s.cfg.write({ path: link, text: 'x', expectMtime: 0 }), { code: 'forbidden' });
    assert.equal(fs.readFileSync(path.join(s.outside, 'secret.md'), 'utf8'), 'secret');
  });

  test('a hard link to a file outside is refused', async () => {
    const s = sandbox();
    const link = path.join(s.homeMem, 'hard.md');
    fs.linkSync(path.join(s.outside, 'secret.md'), link);
    await assert.rejects(s.cfg.read({ path: link }), { code: 'forbidden' });
    await assert.rejects(s.cfg.write({ path: link, text: 'x', expectMtime: fs.statSync(link).mtimeMs }), { code: 'forbidden' });
    assert.equal(fs.readFileSync(path.join(s.outside, 'secret.md'), 'utf8'), 'secret');
  });

  test('case differences resolve to the same allowed file on Windows', { skip: process.platform !== 'win32' }, async () => {
    const s = sandbox();
    const r = await s.cfg.read({ path: path.join(s.claudeDir, 'claude.md') });
    assert.match(r.text, /Global rules/);
  });
});

describe('write', () => {
  test('saves, keeps a backup of the old text, returns the new mtime, and a second save works', async () => {
    const s = sandbox();
    const file = path.join(s.homeMem, 'project_storefront.md');
    const r = await s.cfg.read({ path: file });
    const res = await s.cfg.write({ path: file, text: r.text + 'More.\n', expectMtime: r.mtime });
    assert.match(fs.readFileSync(file, 'utf8'), /More\.\n$/);
    assert.ok(res.backup.startsWith(path.join(s.profileDir, 'claude-config-backups')));
    assert.match(res.backupName, /^2026-10-08T12-00-\d{2}-\d{3}Z-.+-memory-project_storefront\.md$/);
    assert.equal(fs.readFileSync(res.backup, 'utf8'), r.text);
    assert.equal(res.mtime, Math.round(fs.statSync(file).mtimeMs));
    const res2 = await s.cfg.write({ path: file, text: 'v3\n', expectMtime: res.mtime });
    assert.equal(fs.readFileSync(file, 'utf8'), 'v3\n');
    assert.notEqual(res2.backup, res.backup);
    assert.ok(!fs.existsSync(file + '.tmp'), 'atomic temp file is gone');
  });

  test('a stale expectMtime is refused with the "changed on disk" message and nothing is written or backed up', async () => {
    const s = sandbox();
    const file = path.join(s.claudeDir, 'CLAUDE.md');
    const r = await s.cfg.read({ path: file });
    fs.writeFileSync(file, 'edited in the terminal\n');
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
    await assert.rejects(s.cfg.write({ path: file, text: 'from Helm', expectMtime: r.mtime }), (e) => {
      assert.equal(e.code, 'conflict');
      assert.match(e.message, /changed on disk since you opened it/);
      return true;
    });
    assert.equal(fs.readFileSync(file, 'utf8'), 'edited in the terminal\n');
    assert.equal(fs.existsSync(path.join(s.profileDir, 'claude-config-backups')), false);
  });

  test('bad params: missing expectMtime, non-string text, too large', async () => {
    const s = sandbox();
    const file = path.join(s.claudeDir, 'CLAUDE.md');
    const { mtime } = await s.cfg.read({ path: file });
    await assert.rejects(s.cfg.write({ path: file, text: 'x' }), { code: 'bad_params' });
    await assert.rejects(s.cfg.write({ path: file, text: 7, expectMtime: mtime }), { code: 'bad_params' });
    await assert.rejects(s.cfg.write({ path: file, text: 'x'.repeat(1024 * 1024 + 1), expectMtime: mtime }), { code: 'too_large' });
    assert.match(fs.readFileSync(file, 'utf8'), /Global rules/);
  });

  test('without a profile folder it refuses to save (no backup, no write)', async () => {
    const s = sandbox({ profileDir: null });
    const file = path.join(s.claudeDir, 'CLAUDE.md');
    const { mtime } = await s.cfg.read({ path: file });
    await assert.rejects(s.cfg.write({ path: file, text: 'x', expectMtime: mtime }), { code: 'unsupported' });
    assert.match(fs.readFileSync(file, 'utf8'), /Global rules/);
  });

  test('a new file cannot be created through write', async () => {
    const s = sandbox();
    await assert.rejects(s.cfg.write({ path: path.join(s.homeMem, 'brand_new.md'), text: 'x', expectMtime: 0 }), { code: 'not_found' });
    assert.equal(fs.existsSync(path.join(s.homeMem, 'brand_new.md')), false);
  });

  test('CRLF and BOM files keep their line endings and BOM', async () => {
    const s = sandbox();
    const file = path.join(s.proj, 'CLAUDE.local.md');
    fs.writeFileSync(file, '\uFEFF# Local\r\nline two\r\n');
    const r = await s.cfg.read({ path: file });
    assert.equal(r.crlf, true);
    assert.equal(r.text.charCodeAt(0), '#'.charCodeAt(0), 'BOM stripped for the editor');
    await s.cfg.write({ path: file, text: '# Local\nline two\nline three\n', expectMtime: r.mtime });
    assert.equal(fs.readFileSync(file, 'utf8'), '\uFEFF# Local\r\nline two\r\nline three\r\n');
  });

  test('keeps only the newest 50 backups', async () => {
    const s = sandbox();
    const file = path.join(s.homeMem, 'orphan_note.md');
    let { mtime } = await s.cfg.read({ path: file });
    for (let i = 0; i < 53; i++) ({ mtime } = await s.cfg.write({ path: file, text: `v${i}\n`, expectMtime: mtime }));
    const dir = path.join(s.profileDir, 'claude-config-backups');
    const names = fs.readdirSync(dir).sort();
    assert.equal(names.length, 50);
    assert.equal(fs.readFileSync(path.join(dir, names[names.length - 1]), 'utf8'), 'v51\n', 'newest backup = text before the last save');
    assert.equal(fs.readFileSync(path.join(dir, names[0]), 'utf8'), 'v2\n', 'oldest kept = 4th save');
  });
});

describe('search', () => {
  test('matches name, description and body (with a snippet); skips nested and non-md files', async () => {
    const s = sandbox();
    const byName = await s.cfg.search({ q: 'storefront' });
    assert.ok(byName.results.some((r) => r.path.endsWith('project_storefront.md') && r.where === 'name'));
    const byDesc = await s.cfg.search({ q: 'pacing' });
    assert.deepEqual(byDesc.results.map((r) => [path.basename(r.path), r.where]), [['feedback_agent-budget.md', 'description']]);
    const byBody = await s.cfg.search({ q: 'ZEBRACORN' });
    assert.equal(byBody.results.length, 1);
    assert.equal(byBody.results[0].where, 'body');
    assert.match(byBody.results[0].snippet, /zebracorn/);
    assert.deepEqual((await s.cfg.search({ q: 'too deep' })).results, []);
    assert.deepEqual((await s.cfg.search({ q: '' })).results, []);
  });
});

describe('frontmatter', () => {
  test('top-level and metadata.type, quoted values, block scalars, no frontmatter', () => {
    assert.deepEqual(memoryMeta(MEM('A', 'say "hi"', 'user')).type, 'user');
    assert.equal(memoryMeta('---\nname: x\ndescription: \'it\'\'s\'\ntype: project\n---\nB').description, "it's");
    assert.equal(memoryMeta('---\ndescription: |\n  one\n  two\n---\n').description, 'one\ntwo');
    const none = parseFrontmatter('# Just a heading\n');
    assert.equal(none.hasFrontmatter, false);
    assert.equal(none.body, '# Just a heading\n');
  });
});

describe('session (engine init info, read-only)', () => {
  const info = { tools: ['Bash', 'Read'], model: 'claude-opus-5-5', permissionMode: 'bypassPermissions', version: '2.1.294',
    plugins: [{ name: 'fleet', path: 'C:/x' }], mcpServers: [{ name: 'eta', status: 'connected' }, { name: 'broken', status: 'failed' }], slashCommands: ['compact', 'review'] };
  const engine = { _internal: { sessions: new Map([['s1', { initInfo: info }], ['s2', { initInfo: null }]]), lastInit: () => ({ ...info, at: 123 }) } };

  test('a started session returns its init info', async () => {
    const cfg = createClaudeConfig({ claudeDir: os.tmpdir(), getSession: engineSessionReader(engine) });
    const r = await cfg.session({ id: 's1' });
    assert.equal(r.info.version, '2.1.294');
    assert.deepEqual(r.info.mcpServers, [{ name: 'eta', status: 'connected' }, { name: 'broken', status: 'failed' }]);
    assert.deepEqual(r.info.plugins, [{ name: 'fleet', path: 'C:/x' }]);
    assert.equal(r.reason, null);
  });

  test('not started / unknown / no id / stand-in engine say why', async () => {
    const cfg = createClaudeConfig({ claudeDir: os.tmpdir(), getSession: engineSessionReader(engine) });
    const s2 = await cfg.session({ id: 's2' });
    assert.equal(s2.info, null);
    assert.match(s2.reason, /not started Claude Code yet/);
    assert.equal(s2.latest.at, 123);
    assert.match((await cfg.session({ id: 'nope' })).reason, /not in Helm/);
    assert.match((await cfg.session({})).reason, /No session/);
    const fb = createClaudeConfig({ claudeDir: os.tmpdir(), getSession: engineSessionReader({ methods: {} }) });
    assert.match((await fb.session({ id: 's1' })).reason, /stand-in engine/);
  });
});

test('router: claudeConfig.* are registered and use the projects from settings + sessions', async () => {
  const s = sandbox();
  const router = createRouter({
    engine: { methods: {}, snapshot: async () => ({ sessions: [{ id: 'a', cwd: s.proj }] }) }, version: 't', files: {}, queue: { list: () => [] },
    settings: { get: () => ({ projects: [] }), file: path.join(s.profileDir, 'settings.json') },
    claudeConfigOptions: { home: s.home, claudeDir: s.claudeDir },
  });
  for (const m of ['claudeConfig.list', 'claudeConfig.read', 'claudeConfig.write', 'claudeConfig.search', 'claudeConfig.session']) assert.equal(typeof router.methods[m], 'function', m);
  const list = await router.handle({ platform: 'web' }, 'claudeConfig.list', {});
  assert.equal(list.backupDir, path.join(s.profileDir, 'claude-config-backups'));
  assert.equal(list.instructions.projects.find((p) => p.cwd === s.proj).files.length, 3);
  const r = await router.handle({ platform: 'web' }, 'claudeConfig.read', { path: path.join(s.proj, 'CLAUDE.md') });
  await router.handle({ platform: 'web' }, 'claudeConfig.write', { path: r.path, text: '# Proj v2\n', expectMtime: r.mtime });
  assert.equal(fs.readFileSync(path.join(s.proj, 'CLAUDE.md'), 'utf8'), '# Proj v2\n');
  await assert.rejects(router.handle({ platform: 'web' }, 'claudeConfig.read', { path: path.join(s.outside, 'CLAUDE.md') }), { code: 'forbidden' });
  await assert.rejects(router.handle({ platform: 'web' }, 'claudeConfig.write', { path: r.path, text: 'x', expectMtime: r.mtime }), { code: 'conflict' });
});
