// Mock (?mock=1) for Settings -> Claude Code: claudeConfig.list / read / write / search / session
// (PROTOCOL "Claude Code config"). In-memory files only. One index line is broken and one note is
// missing from the index on purpose, so the flags show. Click-through scripts can simulate a save
// from the terminal with window.__ccTouch(path) (bumps that file's mtime -> the next save conflicts).
// Owner: lane cc-config.
const H = 'C:\\Users\\you';
const CD = `${H}\\.claude`;
const MEMDIR = `${CD}\\projects\\C--Users-you\\memory`;
const STORE = `${H}\\code\\storefront`;
const STORE_MEM = `${CD}\\projects\\C--Users-you-code-storefront\\memory`;
const t0 = Date.now() - 3 * 86400_000;

const note = (name, description, type, body) => `---\nname: ${name}\ndescription: "${description}"\nmetadata: \n  node_type: memory\n  type: ${type}\n---\n\n${body}\n`;

const files = new Map(Object.entries({
  [`${CD}\\CLAUDE.md`]: `# Standing instructions — every session, every project

## Always use agents

**Default to delegating substantive work to subagents.** The user is optimising for wall-clock, usually against a deadline.

- **Delegate any substantive multi-step work**: a bug to find and fix, a file to audit, a sweep across pages.
- **Split by FILE** so agents cannot collide, and **launch them in one message**.
- **Verify their claims yourself.** Confirm with \`git diff\` before believing a report.

## Agent context ceiling: 40%

Measure, don't guess: \`node ~/.claude/tools/agent-context.js\`.

## Reporting

- Report outcomes faithfully. If tests fail, say so with the numbers.
`,
  [`${STORE}\\CLAUDE.md`]: '# storefront\n\nExpress + Postgres + Clerk. `master` is PROD: never push without approval.\n',
  [`${STORE}\\.claude\\CLAUDE.md`]: '# storefront (team)\n\nRun `npm test` before every commit.\n',
  [`${H}\\helm\\CLAUDE.local.md`]: '# Helm local notes\n\nPort 4871 is the Helm you are running. Never touch it.\n',
  [`${MEMDIR}\\MEMORY.md`]: [
    '- [storefront](project_storefront.md) — online store, code/storefront/ (shop.example.com), Express+Postgres+Clerk',
    '- [Agent Budget](feedback_agent-budget.md) — ASK once per session if agents may spawn sub-agents; 40% context ceiling',
    '- [Helm](project_helm.md) — desktop Claude Code app at ~/helm: Electron + phone, real claude.exe via Agent SDK',
    '- [Local Model](project_local-model.md) — GONE since 2026-09-02, so the offline eval scripts are broken',
    '- [No AI Slop Dark Neon](feedback_no-ai-slop-dark-neon.md) — no dark+neon glow; neutral grey, restrained accent',
    '- [Mobile App](project_mobile-app.md) — ~/code/mobile-app React Native client + 155-screen snapshot suite',
    '',
  ].join('\n'),
  [`${MEMDIR}\\project_storefront.md`]: note('storefront', 'Online store at code/storefront, live since 2026-08-27', 'project',
    'storefront is the online store.\n\n- Stack: Express, Postgres, Clerk\n- Domain: shop.example.com\n- `master` is PROD; local is the only staging.\n'),
  [`${MEMDIR}\\feedback_agent-budget.md`]: note('agent-budget', 'Rules on agent count and usage pacing: never nested, pace to the 5-hour window', 'feedback',
    'On 2026-09-02 a session burned through the usage limit: 205 agents, 34 at once, three levels deep.\n\n**Why:** nesting multiplies.\n\n**How to apply:** ask once per session whether agents may spawn sub-agents.\n'),
  [`${MEMDIR}\\project_helm.md`]: note('Helm', 'Desktop Claude Code app at ~/helm (Electron + phone)', 'project',
    'Helm runs the real claude.exe through the Agent SDK. Lanes and the contract live in docs/PROTOCOL.md.\n'),
  [`${MEMDIR}\\feedback_no-ai-slop-dark-neon.md`]: note('No AI slop', 'No dark+neon glow; neutral grey, restrained accent, plain hairlines', 'feedback',
    'Premium = restraint and precision. One desaturated accent for state only.\n'),
  [`${MEMDIR}\\project_mobile-app.md`]: note('Mobile App', 'React Native client + snapshot suite at ~/code/mobile-app', 'project',
    'Metro runs on :8081. A snapshot run with zero diffs is a bug until proven.\n'),
  [`${MEMDIR}\\reference_heredoc-backslash.md`]: note('Heredoc backslash collapse', 'Heredocs and node -e drop Windows-path backslashes; use Write/Edit', 'reference',
    'A heredoc ate the backslashes in C:\\\\Users paths. Use the Write tool for any file with Windows paths.\n'),
  [`${STORE_MEM}\\MEMORY.md`]: '- [Deploy](project_deploy.md) — Railway; asset hash is the check\n',
  [`${STORE_MEM}\\project_deploy.md`]: note('Deploy', 'Railway deploy notes; the asset hash is the check', 'project', 'Check the asset hash after every push.\n'),
}).map(([p, text], i) => [p, { text, mtime: t0 + i * 3_600_000 }]));

const sep = (p) => p.lastIndexOf('\\');
const dirOf = (p) => p.slice(0, sep(p));
const baseOf = (p) => p.slice(sep(p) + 1);

function parse(text) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) return { name: '', description: '', type: '', body: text, present: false };
  const get = (k) => { const r = new RegExp(`^\\s*${k}:\\s*(.*)$`, 'm').exec(m[1]); if (!r) return ''; const v = r[1].trim(); try { return /^".*"$/.test(v) ? JSON.parse(v) : v; } catch { return v; } };
  return { name: get('name'), description: get('description'), type: get('type'), body: text.slice(m[0].length), present: true };
}
const info = (p) => { const f = files.get(p); return f ? { size: new Blob([f.text]).size, mtime: f.mtime } : null; };

function memFolder(dir, slug, project, isHome) {
  const names = [...files.keys()].filter((p) => dirOf(p) === dir).map(baseOf);
  const idx = `${dir}\\MEMORY.md`;
  const linked = new Set();
  const entries = [];
  (files.get(idx)?.text || '').split('\n').forEach((line, i) => {
    const m = /^\s*[-*+]\s+\[([^\]]+)\]\(([^)\s]+)\)\s*(?:[—–:-]+\s*)?(.*)$/.exec(line);
    if (!m) return;
    const p = `${dir}\\${m[2]}`;
    const ok = files.has(p);
    if (ok) linked.add(m[2]);
    const meta = ok ? parse(files.get(p).text) : null;
    entries.push({ line: i + 1, title: m[1], hook: m[3], link: m[2], path: p, status: ok ? 'ok' : 'missing',
      ...(ok ? { file: { ...info(p), name: meta.name, description: meta.description, type: meta.type } } : {}) });
  });
  const unindexed = names.filter((n) => n !== 'MEMORY.md' && !linked.has(n)).sort().map((n) => {
    const p = `${dir}\\${n}`; const meta = parse(files.get(p).text);
    return { path: p, file: n, ...info(p), name: meta.name, description: meta.description, type: meta.type };
  });
  return { slug, dir, project, isHome, index: files.has(idx) ? { path: idx, exists: true, ...info(idx), lines: files.get(idx).text.split('\n').length } : { path: idx, exists: false },
    entries, unindexed, fileCount: names.length, broken: entries.filter((e) => e.status !== 'ok').length };
}

const fail = (message, code) => Object.assign(new Error(message), { code });
const allowed = (p) => typeof p === 'string' && !/(^|[\\/])\.\.?([\\/]|$)/.test(p) && files.has(p);

const initInfo = {
  model: 'claude-opus-5-5', permissionMode: 'bypassPermissions', version: '2.1.294',
  tools: ['Task', 'Bash', 'Glob', 'Grep', 'Read', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'TodoWrite', 'Skill', 'mcp__github__create_issue', 'mcp__linear__list_issues', 'mcp__postgres__query'],
  plugins: [{ name: 'github', path: `${CD}\\plugins\\github` }, { name: 'linear', path: `${CD}\\plugins\\linear` }, { name: 'postgres', path: `${CD}\\plugins\\postgres` }, { name: 'sentry', path: `${CD}\\plugins\\sentry` }, { name: 'frontend-design', path: `${CD}\\plugins\\frontend-design` }],
  mcpServers: [{ name: 'github', status: 'connected' }, { name: 'linear', status: 'connected' }, { name: 'filesystem', status: 'connected' }, { name: 'postgres', status: 'connected' }, { name: 'sentry', status: 'failed' }, { name: 'claude-in-chrome', status: 'pending' }],
  slashCommands: ['compact', 'context', 'cost', 'init', 'review', 'security-review', 'commit', 'pr-review', 'feature-dev', 'frontend-design:frontend-design', 'code-review', 'simplify', 'loop', 'schedule'],
};

export async function claudeConfigMock(method, p = {}) {
  switch (method) {
    case 'claudeConfig.list': {
      const proj = (cwd, rels) => ({ cwd, name: baseOf(cwd), files: rels.map((rel) => `${cwd}\\${rel.replace('/', '\\')}`).filter((f) => files.has(f))
        .map((f) => ({ path: f, scope: 'project', rel: f.slice(cwd.length + 1).replace('\\', '/'), project: cwd, exists: true, ...info(f) })) });
      const rels = ['CLAUDE.md', 'CLAUDE.local.md', '.claude/CLAUDE.md'];
      return {
        claudeDir: CD, home: H, backupDir: 'C:\\Users\\you\\AppData\\Roaming\\Helm\\claude-config-backups', writable: true,
        instructions: {
          global: { path: `${CD}\\CLAUDE.md`, scope: 'global', rel: 'CLAUDE.md', project: null, exists: true, ...info(`${CD}\\CLAUDE.md`) },
          projects: [proj(STORE, rels), proj(`${H}\\code\\booking-portal`, rels), proj(`${H}\\helm`, rels), proj(`${H}\\code\\api-server`, rels)],
        },
        memory: { folders: [memFolder(MEMDIR, 'C--Users-you', H, true), memFolder(STORE_MEM, 'C--Users-you-code-storefront', STORE, false)], emptyFolders: 9, skipped: [] },
      };
    }
    case 'claudeConfig.read': {
      if (!allowed(p.path)) throw fail('Helm only opens CLAUDE.md files and Claude Code memory notes.', 'forbidden');
      const f = files.get(p.path);
      const mem = p.path.includes('\\memory\\');
      const out = { path: p.path, kind: mem ? 'memory' : 'instructions', scope: mem ? 'memory' : p.path === `${CD}\\CLAUDE.md` ? 'global' : 'project', text: f.text, ...info(p.path), crlf: false };
      if (mem) { const m = parse(f.text); out.frontmatter = { name: m.name, description: m.description, type: m.type, present: m.present }; out.body = m.body; }
      return out;
    }
    case 'claudeConfig.write': {
      if (!allowed(p.path)) throw fail('Helm only opens CLAUDE.md files and Claude Code memory notes.', 'forbidden');
      const f = files.get(p.path);
      if (typeof p.text !== 'string') throw fail('text must be a string', 'bad_params');
      if (f.mtime !== p.expectMtime) throw fail('This file changed on disk since you opened it. Reload it to see the new version, then make your edit again.', 'conflict');
      f.text = p.text; f.mtime = Date.now();
      const backupName = `${new Date().toISOString().replace(/[:.]/g, '-')}-${baseOf(p.path)}`;
      return { path: p.path, ...info(p.path), backup: `C:\\Users\\you\\AppData\\Roaming\\Helm\\claude-config-backups\\${backupName}`, backupName, pruned: 0 };
    }
    case 'claudeConfig.search': {
      const q = String(p.q || '').trim().toLowerCase();
      if (!q) return { q: '', results: [] };
      const results = [];
      for (const [path, f] of files) {
        if (!path.includes('\\memory\\')) continue;
        const m = parse(f.text);
        if (baseOf(path).toLowerCase().includes(q) || m.name.toLowerCase().includes(q)) results.push({ path, where: 'name' });
        else if (m.description.toLowerCase().includes(q)) results.push({ path, where: 'description' });
        else { const i = m.body.toLowerCase().indexOf(q); if (i >= 0) results.push({ path, where: 'body', snippet: `${i > 50 ? '…' : ''}${m.body.slice(Math.max(0, i - 50), i + q.length + 70).replace(/\s+/g, ' ').trim()}…` }); }
      }
      return { q, results };
    }
    case 'claudeConfig.session': {
      if (p.id === 's_storefront') return { id: p.id, info: initInfo, at: null, reason: null, latest: null };
      return { id: p.id || null, info: null, at: null, reason: p.id ? 'This session has not started Claude Code yet. Send it a message and its setup shows up here.' : 'No session is selected.',
        latest: { info: initInfo, at: Date.now() - 12 * 60_000 } };
    }
    default: throw fail(`mock: no handler for ${method}`, 'unknown_method');
  }
}

try { window.__ccTouch = (path) => { const f = files.get(path); if (f) { f.mtime += 7000; f.text += '\n<!-- edited in the terminal -->\n'; } return !!f; }; } catch {}
