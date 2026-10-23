// Helm never signs in (PROTOCOL "Account"): no file in the repo reads Claude Code's stored login or runs a
// sign-in, sign-out or token command. Its sessions use the user's own Claude Code sign-in, or an API key the
// user saved in Settings > Account. This scans every file git tracks (plus new, not-ignored ones) for the
// patterns that would mean otherwise.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const SELF = path.relative(ROOT, __filename).split(path.sep).join('/');
const TEXT = /\.(js|mjs|cjs|json|md|html|css|ps1|sh|cmd|bat|txt|yml|yaml|webmanifest)$|^[^.]+$/i;

function repoFiles() {
  const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  return [...new Set(out.split('\0').filter(Boolean))]
    .filter((f) => f !== SELF && !f.startsWith('ui/vendor/') && f !== 'package-lock.json' && TEXT.test(path.basename(f)))
    .filter((f) => { try { return fs.statSync(path.join(ROOT, f)).isFile(); } catch { return false; } });
}

// [what it would mean, pattern]
const FORBIDDEN = [
  ['reads the stored login file', /\.credentials\.json/i],
  ['reads the stored login', /claudeAiOauth/],
  ['runs the token command', /setup-token/i],
  ['runs a sign-in or sign-out', /\bauth\s+(login|logout)\b/i],
  ['spawns a sign-in or sign-out', /['"`]auth['"`]\s*,\s*['"`](login|logout)['"`]/i],
  ['loads the removed local sign-in plug-in', /auth-subscription/],
];

test('no tracked file reads the stored Claude login or runs a sign-in, sign-out or token command', () => {
  const files = repoFiles();
  assert.ok(files.length > 100, `scanned ${files.length} files`);
  assert.ok(files.includes('main/account.js') && files.includes('README.md'), 'the scan sees the repo');
  const hits = [];
  for (const f of files) {
    const lines = fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n');
    lines.forEach((line, i) => {
      for (const [why, re] of FORBIDDEN) if (re.test(line)) hits.push(`${f}:${i + 1} ${why}: ${line.trim().slice(0, 140)}`);
    });
  }
  assert.deepEqual(hits, []);
});

test('the sign-in token variable is only ever removed (isolated e2e runs) or passed through (this env test)', () => {
  const ALLOWED_FILES = new Set(['test/host/account.test.js']);
  const hits = [];
  for (const f of repoFiles()) {
    const lines = fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!/CLAUDE_CODE_OAUTH_TOKEN/.test(line)) return;
      if (ALLOWED_FILES.has(f)) return;
      // tools/*-e2e.js: API-key test instances strip it so they never run on the user's own sign-in
      if (/^tools\/[\w-]+-e2e\.js$/.test(f) && /^\s*delete env\.CLAUDE_CODE_OAUTH_TOKEN;/.test(line)) return;
      hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 140)}`);
    });
  }
  assert.deepEqual(hits, []);
});

test('only main/account.js puts an API key into a claude child\'s env', () => {
  const hits = [];
  for (const f of repoFiles().filter((x) => /^main(\/|\.js$)/.test(x) && /\.js$/.test(x))) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    if (/\.ANTHROPIC_API_KEY\s*=[^=]|\[['"]ANTHROPIC_API_KEY['"]\]\s*=[^=]/.test(src) && f !== 'main/account.js') hits.push(f);
  }
  assert.deepEqual(hits, []);
});
