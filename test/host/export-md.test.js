// Unit tests for ui/lib/export-md.js (session "…" menu: Export / Copy as Markdown). The UI module is
// ESM with no imports, so require(esm) loads it directly (same as fleet-timeline.test.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { sessionToMarkdown, toolSummary, lineDelta, code, relPath, exportFileName } = require('../../ui/lib/export-md.js');

const CWD = 'C:\\Users\\you\\proj';
const T = new Date(2026, 9, 8, 14, 5).getTime();   // local time: the export prints local dates
const session = { id: 's1', title: 'Fix login redirect', cwd: CWD, model: 'claude-opus-5-5', effort: 'xhigh', createdAt: T };

test('code(): wraps in backticks, survives backticks inside, flattens newlines', () => {
  assert.equal(code('npm test'), '`npm test`');
  assert.equal(code('echo `date`'), '`` echo `date` ``');
  assert.equal(code('a `b` c'), '``a `b` c``');
  assert.equal(code('a\nb'), '`a b`');
});

test('relPath(): inside the folder -> relative posix; outside stays as is', () => {
  assert.equal(relPath('C:\\Users\\you\\proj\\src\\a.js', CWD), 'src/a.js');
  assert.equal(relPath('c:/users/you/proj/src/a.js', CWD), 'src/a.js');
  assert.equal(relPath('C:\\Users\\you\\other\\b.js', CWD), 'C:\\Users\\you\\other\\b.js');
  assert.equal(relPath('C:\\Users\\you\\project2\\b.js', CWD), 'C:\\Users\\you\\project2\\b.js');
});

test('lineDelta(): counts only changed lines', () => {
  assert.deepEqual(lineDelta('a\nb\nc\nd\ne', 'a\nb\nX\nd\ne'), { added: 1, removed: 1 });
  assert.deepEqual(lineDelta('', 'x\ny\nz'), { added: 3, removed: 0 });
  assert.deepEqual(lineDelta('one\n', 'one\ntwo\nthree\nfour\n'), { added: 3, removed: 0 });
});

test('toolSummary(): one line per tool', () => {
  assert.equal(toolSummary({ name: 'Bash', input: { command: 'npm test' }, status: 'done' }, CWD), 'Ran `npm test`');
  assert.equal(toolSummary({ name: 'Edit', input: { file_path: `${CWD}\\src\\a.js`, old_string: 'x', new_string: 'y\nz\nw' } }, CWD), 'Edited `src/a.js` (+3 −1)');
  assert.equal(toolSummary({ name: 'MultiEdit', input: { file_path: `${CWD}\\a.js`, edits: [{ old_string: 'a', new_string: 'b' }, { old_string: '', new_string: 'c' }] } }, CWD), 'Edited `a.js` (+2 −1)');
  assert.equal(toolSummary({ name: 'Write', input: { file_path: `${CWD}\\n.md`, content: 'a\nb\n' } }, CWD), 'Wrote `n.md` (2 lines)');
  assert.equal(toolSummary({ name: 'Read', input: { file_path: `${CWD}\\r.js` } }, CWD), 'Read `r.js`');
  assert.equal(toolSummary({ name: 'Grep', input: { pattern: 'TODO' } }, CWD), 'Searched for `TODO`');
  assert.equal(toolSummary({ name: 'Agent', input: { description: 'audit pages' } }, CWD), 'Ran an agent: audit pages');
  assert.equal(toolSummary({ name: 'mcp__eta__Eta', input: {} }, CWD), 'Called `Eta` (eta)');
  assert.equal(toolSummary({ name: 'Bash', input: { command: 'false' }, status: 'error' }, CWD), 'Ran `false` (failed)');
  assert.equal(toolSummary({ name: 'Bash', input: { command: 'sleep 9' }, status: 'error', interrupted: true }, CWD), 'Ran `sleep 9` (stopped)');
  assert.equal(toolSummary({ name: 'Weird', input: null }, CWD), 'Used `Weird`');
  assert.ok(toolSummary({ name: 'Bash', input: { command: 'x'.repeat(500) } }, CWD).length < 175);
});

test('sessionToMarkdown(): header, prompts, replies, tool one-liners; thinking and noise left out', () => {
  const items = [
    { id: '0', type: 'system', subtype: 'init', text: 'init' },
    { id: '1', type: 'user', text: 'Fix the redirect bug', ts: T, attachments: [{ kind: 'image', name: 'shot.png' }] },
    { id: '2', type: 'thinking', text: 'SECRET THOUGHTS' },
    { id: '3', type: 'assistant', text: 'Looking at the middleware.' },
    { id: '4', type: 'tool', name: 'Bash', input: { command: 'npm test' }, status: 'done' },
    { id: '5', type: 'tool', name: 'Edit', input: { file_path: `${CWD}\\src\\a.js`, old_string: 'a', new_string: 'b\nc\nd' }, status: 'done' },
    { id: '5a', type: 'tool', name: 'Read', input: { file_path: `${CWD}\\inner.js` }, parentToolUseId: 'agent1' },
    { id: '6', type: 'assistant', text: 'Fixed. **Tests pass.**' },
    { id: '7', type: 'result', durationMs: 1000, costUsd: 0.1 },
    { id: '8', type: 'user', text: 'queued one', queued: true },
    { id: '9', type: 'user', text: 'Thanks' },
    { id: '10', type: 'request', kind: 'question', questions: [{ question: 'Which name?' }], answer: { answers: { 'Which name?': 'Helm' } }, status: 'answered' },
  ];
  const md = sessionToMarkdown(session, items, { now: T });
  const expected = [
    '# Fix login redirect',
    '',
    '- **Folder:** `C:\\Users\\you\\proj`',
    '- **Model:** claude-opus-5-5 (xhigh effort)',
    '- **Started:** 2026-10-08 14:05',
    '- **Exported:** 2026-10-08 14:05 from Helm',
    '',
    '---',
    '',
    '## You',
    '',
    'Fix the redirect bug',
    '',
    '*Attached: `shot.png`*',
    '',
    '---',
    '',
    '## Claude',
    '',
    'Looking at the middleware.',
    '',
    '- Ran `npm test`',
    '- Edited `src/a.js` (+3 −1)',
    '',
    'Fixed. **Tests pass.**',
    '',
    '---',
    '',
    '## You',
    '',
    'Thanks',
    '',
    '---',
    '',
    '## Claude',
    '',
    '> **Asked:** Which name?',
    '>',
    '> **Answer:** Helm',
    '',
  ].join('\n');
  assert.equal(md, expected);
  assert.ok(!md.includes('SECRET'));
  assert.ok(!md.includes('inner.js'));
  assert.ok(!md.includes('queued one'));
});

test('sessionToMarkdown(): tools that end a turn are flushed; empty session still has a header', () => {
  const md = sessionToMarkdown(session, [
    { id: '1', type: 'user', text: 'go' },
    { id: '2', type: 'tool', name: 'Bash', input: { command: 'ls' } },
  ], { now: T });
  assert.ok(md.endsWith('## Claude\n\n- Ran `ls`\n'), md);
  const empty = sessionToMarkdown({ title: '' }, [], { now: T });
  assert.ok(empty.startsWith('# Helm session\n'));
  assert.ok(!empty.includes('Folder'));
});

test('exportFileName(): title + date, no characters Windows refuses', () => {
  assert.equal(exportFileName({ title: 'Fix: a/b?' }, T), 'Fix a b 2026-10-08.md');
  assert.equal(exportFileName({}, T), 'Helm session 2026-10-08.md');
});
