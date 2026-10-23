'use strict';
// lane detach: keep-compat.js decides whether a relaunched Helm may re-attach to a CLI the broker kept running.
const test = require('node:test');
const assert = require('node:assert');
const { keepCompat, reinitProblem, cmpVersion, MIN_CLI_VERSION } = require('../../main/engine/keep-compat');

const here = { v: 2, sdkVersion: '0.3.293', claudePath: 'C:\\Users\\o\\.local\\bin\\claude.exe', minCliVersion: MIN_CLI_VERSION };
const session = { id: 's1', claudeSessionId: 'abcdef12-0000', cwd: 'C:\\work\\helm' };
const entry = (o = {}) => ({
  key: 's1~a', sid: 's1', pid: 42, cwd: 'C:\\work\\helm\\', claudeSessionId: 'abcdef12-0000', cliVersion: '2.1.300',
  meta: { sdk: '0.3.293', claudePath: 'c:\\users\\o\\.local\\bin\\claude.exe' }, exited: null, ending: false, eofAt: null,
  broker: { v: 2, compatible: true, current: true }, ...o,
});

test('keep-compat: a CLI that fits passes (path case and trailing slash do not matter)', () => {
  assert.strictEqual(keepCompat(entry(), session, here), null);
});

test('keep-compat: every mismatch names why', () => {
  const cases = [
    [null, /process that kept it running is gone/],
    [entry({ exited: { code: 1, signal: null } }), /ended while Helm was away \(exit code 1\)/],
    [entry({ eofAt: 5 }), /already closing/],
    [entry({ broker: { v: 1, compatible: false } }), /protocol v1, this Helm speaks v2/],
    [entry({ meta: { sdk: '0.3.200', claudePath: here.claudePath } }), /Agent SDK changed from 0\.3\.200 to 0\.3\.293/],
    [entry({ meta: { sdk: '0.3.293', claudePath: 'D:\\other\\claude.exe' } }), /now starts Claude Code from .*claude\.exe, not D:\\other\\claude\.exe/],
    [entry({ claudeSessionId: '99999999-1111' }), /runs conversation 99999999, but this session is now conversation abcdef12/],
    [entry({ cwd: 'C:\\elsewhere' }), /runs in C:\\elsewhere, but this session is in C:\\work\\helm/],
    [entry({ cliVersion: null }), /never reported its version/],
    [entry({ cliVersion: '2.1.290' }), /2\.1\.290 is older than 2\.1\.295/],
  ];
  for (const [e, re] of cases) assert.match(String(keepCompat(e, session, here)), re);
});

test('keep-compat: unknown fields on either side do not block', () => {
  // an old Helm that recorded no meta, a session not yet told its conversation id
  assert.strictEqual(keepCompat(entry({ meta: null }), { id: 's1', cwd: session.cwd }, here), null);
  assert.strictEqual(keepCompat(entry({ meta: { sdk: null } }), session, { ...here, sdkVersion: null }), null);
});

test('keep-compat: versions compare numerically', () => {
  assert.strictEqual(cmpVersion('2.1.295', '2.1.295'), 0);
  assert.strictEqual(cmpVersion('2.1.1000', '2.1.295'), 1);
  assert.strictEqual(cmpVersion('2.0.999', '2.1.0'), -1);
  assert.strictEqual(cmpVersion('3.0.0-beta.1', '2.9.9'), 1);
});

test('keep-compat: the re-attach verdict', () => {
  assert.strictEqual(reinitProblem({ ok: true, subtype: 'success', hooksApplied: true }), null);
  assert.match(reinitProblem({ subtype: 'error', error: 'unknown request' }), /refused the re-attach \(unknown request\)/);
  assert.match(reinitProblem({ subtype: 'success', hooksApplied: false }), /did not confirm Helm's hooks/);
  assert.match(reinitProblem(null), /did not answer/);
});
