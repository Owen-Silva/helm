// lane helm-plainerror (2026-10-14, backlog P-H1): ui/lib/plain-error.js turns whatever was thrown into a true
// sentence for a toast, with the raw text kept for the toast's "Details" disclosure. Real shapes only: the
// messages below are what Node 24, Chromium, the Agent SDK 0.3.x and Helm's own main/rpc.js actually produce.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { plainError, errorToast } = require('../../ui/lib/plain-error.js');

// a real Node error object, built the way Node builds it (no fake shapes)
function nodeErr(fn) { try { fn(); } catch (e) { return e; } throw new Error('expected a throw'); }

test('ENOENT from fs: names the file, says it is missing, raw text under Details', () => {
  const e = nodeErr(() => fs.readFileSync(path.join(__dirname, 'no-such-dir', 'settings.json')));
  assert.equal(e.code, 'ENOENT');
  const p = plainError(e);
  assert.equal(p.text, '"settings.json" was not found. It may have been moved or deleted.');
  assert.equal(p.details, e.message);
  assert.match(p.details, /^ENOENT: no such file or directory, open '.+settings\.json'$/);
  assert.equal(p.code, 'ENOENT');
});

test('ENOENT after main/rpc.js: a coded error crosses the socket as { message, code }', () => {
  // ui/lib/transport.js: Object.assign(new Error(msg.error.message), { code: msg.error.code })
  const e = Object.assign(new Error("ENOENT: no such file or directory, scandir 'C:\\Users\\you\\proj\\gone'"), { code: 'ENOENT' });
  assert.equal(plainError(e).text, '"gone" was not found. It may have been moved or deleted.');
});

test('EACCES: access denied, with what to do', () => {
  const e = Object.assign(new Error("EACCES: permission denied, open '/etc/shadow'"), { code: 'EACCES', errno: -13, syscall: 'open', path: '/etc/shadow' });
  const p = plainError(e);
  assert.equal(p.text, 'Access to "shadow" was denied. Close any app that is using it, or check its permissions, then try again.');
  assert.equal(p.details, "EACCES: permission denied, open '/etc/shadow'");
});

test('ECONNREFUSED: says nothing answered at the address', () => {
  const e = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:4871'), { code: 'ECONNREFUSED', address: '127.0.0.1', port: 4871 });
  const p = plainError(e);
  assert.equal(p.text, 'Nothing answered at 127.0.0.1:4871. The service there may not be running.');
  assert.equal(p.details, 'connect ECONNREFUSED 127.0.0.1:4871');
});

test('ETIMEDOUT: connection timed out', () => {
  const e = Object.assign(new Error('connect ETIMEDOUT 140.82.112.3:443'), { code: 'ETIMEDOUT' });
  const p = plainError(e);
  assert.equal(p.text, 'The connection timed out. Check the network and try again.');
  assert.equal(p.details, 'connect ETIMEDOUT 140.82.112.3:443');
});

test('AbortError (a real DOMException from AbortController): cancelled', () => {
  const ac = new AbortController(); ac.abort();
  const e = ac.signal.reason;
  assert.equal(e.name, 'AbortError');
  const p = plainError(e);
  assert.equal(p.text, 'It was cancelled before it finished.');
  assert.equal(p.details, 'This operation was aborted (AbortError)');
});

test('a JSON-RPC error object: the service answered with an error, code and message under Details', () => {
  const reply = { jsonrpc: '2.0', id: 7, error: { code: -32601, message: 'Method not found' } };
  const p = plainError(reply);
  assert.equal(p.text, 'The service it was sent to answered with an error. The exact error is under Details.');
  assert.equal(p.details, 'Method not found (-32601)');
  // the bare error object behaves the same
  assert.equal(plainError(reply.error).details, 'Method not found (-32601)');
});

test("Helm's own RPC codes: disconnected and unknown_method", () => {
  const lost = Object.assign(new Error('connection lost'), { code: 'disconnected' });
  const p = plainError(lost);
  assert.match(p.text, /^Helm lost its connection to its backend, so this may not have gone through\./);
  assert.equal(p.details, 'connection lost (disconnected)');
  const um = Object.assign(new Error('unknown method: sessions.fork'), { code: 'unknown_method' });
  assert.match(plainError(um).text, /needs a restart\.$/);
});

test('a CLI stderr blob from the Agent SDK: exit code in words, the whole stderr under Details', () => {
  const raw = 'Claude Code process exited with code 1. stderr: Error: Invalid API key · Please run /login\n    at file:///C:/Users/you/.local/bin/cli.js:4012:15';
  const e = new Error(raw);
  const p = plainError(e);
  assert.equal(p.text, 'Claude Code stopped with an error (exit code 1). Its own output is under Details.');
  assert.equal(p.details, raw);
  // through main/rpc.js it arrives with code 'internal': same words
  assert.equal(plainError(Object.assign(new Error(raw), { code: 'internal' })).text, p.text);
});

test('a stack string: V8 bug wording becomes "a bug", the stack stays under Details', () => {
  const stack = "TypeError: Cannot read properties of undefined (reading 'items')\n    at forkAt (C:\\Users\\you\\helm\\main\\engine\\session.js:1590:22)\n    at async handle (C:\\Users\\you\\helm\\main\\rpc.js:107:14)";
  const p = plainError(stack);
  assert.equal(p.text, 'Helm hit a programming error (a bug, not something you did). The exact error is under Details.');
  assert.equal(p.details, stack);
});

test('a TypeError by name alone is NOT called a bug (new URL throws one for bad input)', () => {
  const e = nodeErr(() => new URL('not a url'));
  assert.equal(e.name, 'TypeError');
  const p = plainError(e);
  assert.doesNotMatch(p.text, /bug/);
  assert.equal(p.text, 'Invalid URL.');
  assert.equal(p.details, 'Invalid URL (ERR_INVALID_URL)');
});

test('a non-Error throw: a number, an object, a plain string', () => {
  const n = plainError(42);
  assert.equal(n.text, 'Something unexpected went wrong. The exact error is under Details.');
  assert.equal(n.details, '42');
  const o = plainError({ status: 503, body: 'upstream' });
  assert.equal(o.text, 'Something unexpected went wrong. The exact error is under Details.');
  assert.equal(o.details, '{"status":503,"body":"upstream"}');
  // a sentence a person wrote is shown as it is (it IS the raw text, nothing hidden)
  const s = plainError('the queue is paused');
  assert.equal(s.text, 'The queue is paused.');
  assert.equal(s.details, null);
});

test('undefined / null / empty Error: an honest line, no empty Details', () => {
  for (const v of [undefined, null, new Error(), '']) {
    const p = plainError(v);
    assert.equal(p.text, 'Something went wrong, and no error text came with it.');
    assert.equal(p.details, null);
  }
});

test("Helm's own sentence from the engine is kept word for word", () => {
  const e = Object.assign(new Error('3 commands are already running here'), { code: 'busy' });
  assert.deepEqual(plainError(e), { text: '3 commands are already running here.', details: null, code: 'busy' });
  const f = Object.assign(new Error('Folder not found: C:\\Users\\you\\old-proj'), { code: 'internal' });
  assert.equal(plainError(f).text, 'Folder not found: C:\\Users\\you\\old-proj.');
});

test('a plain lead-in keeps its words; the technical rest becomes known words', () => {
  const e = new Error("Could not read the transcripts: ENOENT: no such file or directory, scandir 'C:\\Users\\you\\.claude\\projects'");
  assert.equal(plainError(e).text, 'Could not read the transcripts. "projects" was not found. It may have been moved or deleted.');
});

test('spawn ENOENT and a missing Claude Code executable', () => {
  const sp = Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT', syscall: 'spawn git', path: 'git' });
  assert.equal(plainError(sp).text, 'Helm could not start "git": the program, or the folder it runs in, was not found.');
  const cc = new Error('Claude Code executable not found at C:\\Users\\you\\.local\\bin\\claude.exe. Is options.pathToClaudeCodeExecutable set?');
  assert.match(plainError(cc).text, /^Claude Code was not found at C:\\Users\\you\\\.local\\bin\\claude\.exe\./);
});

test('Chromium fetch failure and clipboard NotAllowedError', () => {
  const f = new TypeError('Failed to fetch');
  assert.equal(plainError(f).text, 'The network request failed. Check the connection and try again.');
  const c = new DOMException("Failed to execute 'writeText' on 'Clipboard': Document is not focused.", 'NotAllowedError');
  const p = plainError(c);
  assert.match(p.text, /^The browser blocked it/);
  assert.ok(p.details.includes('Document is not focused'));
});

test('an unknown technical message: generic line, never a guessed reason', () => {
  const raw = 'ERR_SOCKET_CLOSED_BEFORE_CONNECTION: socket closed';
  const p = plainError(new Error(raw));
  assert.equal(p.text, 'Something unexpected went wrong. The exact error is under Details.');
  assert.equal(p.details, raw);
});

test('errorToast: { error } becomes the plain body plus details; context body is kept first', () => {
  const e = Object.assign(new Error("ENOENT: no such file or directory, open 'C:\\p\\notes.md'"), { code: 'ENOENT' });
  const t = errorToast({ title: 'Export failed', body: 'Could not read the conversation', error: e, kind: 'error' });
  assert.deepEqual(t, {
    title: 'Export failed', kind: 'error',
    body: 'Could not read the conversation. "notes.md" was not found. It may have been moved or deleted.',
    details: "ENOENT: no such file or directory, open 'C:\\p\\notes.md'",
  });
  // a toast without error passes through untouched
  const plain = { title: 'Saved', body: 'x' };
  assert.equal(errorToast(plain), plain);
});

// The toast as rendered: ToastText (ui/shell/toast-text.js, used by chrome.js Toasts) built with the real
// preact + htm, then walked to HTML. No DOM needed: the vnode tree is what Preact would put on screen.
function toHtml(v) {
  if (v == null || v === false || v === true) return '';
  if (Array.isArray(v)) return v.map(toHtml).join('');
  if (typeof v !== 'object') return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  if (typeof v.type === 'function') return toHtml(v.type(v.props));
  const { children, ...attrs } = v.props || {};
  const a = Object.entries(attrs).filter(([k, x]) => typeof x === 'string').map(([k, x]) => ` ${k}="${x}"`).join('');
  return `<${v.type}${a}>${toHtml(children)}</${v.type}>`;
}

test('a toast built from a raw error shows the plain line, with the raw text under Details', () => {
  const { ToastText } = require('../../ui/shell/toast-text.js');
  const e = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:4871'), { code: 'ECONNREFUSED' });
  const t = errorToast({ title: 'Could not fork', error: e, kind: 'error' });
  const out = toHtml(ToastText({ t }));
  assert.equal(out,
    '<div class="toast-text"><div class="toast-title">Could not fork</div>'
    + '<div class="toast-body">Nothing answered at 127.0.0.1:4871. The service there may not be running.</div>'
    + '<details class="toast-details"><summary>Details</summary><pre class="toast-raw">connect ECONNREFUSED 127.0.0.1:4871</pre></details></div>');
  // the raw text is NOT in the body line, only under Details
  assert.doesNotMatch(out.split('<details')[0], /ECONNREFUSED/);
});

test('a toast whose error is already a plain sentence has no Details', () => {
  const { ToastText } = require('../../ui/shell/toast-text.js');
  const e = Object.assign(new Error('Stop the current turn before rewinding'), { code: 'busy' });
  const out = toHtml(ToastText({ t: errorToast({ title: 'Could not rewind', error: e, kind: 'error' }) }));
  assert.equal(out, '<div class="toast-text"><div class="toast-title">Could not rewind</div><div class="toast-body">Stop the current turn before rewinding.</div></div>');
});

test('opening Details pins the toast; clicks inside it do not reach the toast', () => {
  const { ToastText } = require('../../ui/shell/toast-text.js');
  let pinned = 0;
  const v = ToastText({ t: { title: 'x', body: 'y', details: 'raw' }, onPin: () => pinned++ });
  const details = [].concat(v.props.children).find((c) => c && c.type === 'details');
  let stopped = false;
  details.props.onClick({ stopPropagation: () => { stopped = true; } });
  assert.ok(stopped);
  details.props.onToggle({ currentTarget: { open: false } });
  assert.equal(pinned, 0);
  details.props.onToggle({ currentTarget: { open: true } });
  assert.equal(pinned, 1);
});
