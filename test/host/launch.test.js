// Helm.exe resolution, login item options and launch arguments.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { launcherExe, helmExePath, loginItemOptions, createLoginItem, parseLaunchArgs } = require('../../main/launch');

const APP = 'C:\\Users\\you\\helm';

test.describe('launcherExe()', () => {
  test.it('prefers dist/Helm/Helm.exe when it exists', () => {
    assert.equal(helmExePath(APP), path.join(APP, 'dist', 'Helm', 'Helm.exe'));
    assert.equal(launcherExe(APP, 'C:\\e\\electron.exe', () => true), path.join(APP, 'dist', 'Helm', 'Helm.exe'));
  });
  test.it('falls back to the running Electron', () => {
    assert.equal(launcherExe(APP, 'C:\\e\\electron.exe', () => false), 'C:\\e\\electron.exe');
  });
});

test.describe('login item', () => {
  test.it('options start Helm.exe with the project folder, hidden in the tray', () => {
    assert.deepEqual(loginItemOptions({ enabled: true, exe: 'C:\\x\\Helm.exe', appDir: APP }),
      { openAtLogin: true, path: 'C:\\x\\Helm.exe', args: [APP, '--hidden'], name: 'Helm', enabled: true });
    assert.equal(loginItemOptions({ enabled: false, exe: 'x', appDir: APP }).openAtLogin, false);
  });
  test.it('first apply writes only when on; later applies write on change only', () => {
    const writes = [];
    const li = createLoginItem({ setLoginItem: (o) => writes.push(o), exe: () => 'C:\\x\\Helm.exe', appDir: APP });
    assert.equal(li.apply(false), false, 'boot with it off never touches the Run key');
    assert.equal(writes.length, 0);
    assert.equal(li.apply(false), false);
    assert.equal(li.apply(true), true);
    assert.equal(li.apply(true), false, 'unchanged');
    assert.equal(li.apply(false), true);
    assert.deepEqual(writes.map((w) => w.openAtLogin), [true, false]);
    assert.deepEqual(writes[0].args, [APP, '--hidden']);
  });
  test.it('boot with it on refreshes the entry (picks up a newly built Helm.exe)', () => {
    const writes = [];
    let exe = 'C:\\e\\electron.exe';
    const li = createLoginItem({ setLoginItem: (o) => writes.push(o), exe: () => exe, appDir: APP });
    exe = 'C:\\x\\Helm.exe';
    li.apply(true);
    assert.equal(writes[0].path, 'C:\\x\\Helm.exe');
  });
  test.it('a failing setLoginItem is logged, not thrown', () => {
    const logs = [];
    const li = createLoginItem({ setLoginItem: () => { throw new Error('denied'); }, exe: () => 'x', appDir: APP, log: (...a) => logs.push(a.join(' ')) });
    assert.equal(li.apply(true), false);
    assert.match(logs[0], /login item failed: denied/);
  });
});

test.describe('parseLaunchArgs()', () => {
  test.it('reads --session and --quick among Electron args', () => {
    assert.deepEqual(parseLaunchArgs(['C:\\x\\Helm.exe', APP, '--session=s_8f2a', '--hidden']), { sessionId: 's_8f2a', quick: false });
    assert.deepEqual(parseLaunchArgs([APP, '--quick']), { sessionId: null, quick: true });
  });
  test.it('reads helm:// URLs', () => {
    assert.deepEqual(parseLaunchArgs(['helm://session/s_1']), { sessionId: 's_1', quick: false });
    assert.deepEqual(parseLaunchArgs(['helm://quick']), { sessionId: null, quick: true });
  });
  test.it('drops a session id with odd characters', () => {
    assert.equal(parseLaunchArgs(['--session=<script>']).sessionId, null);
    assert.equal(parseLaunchArgs(['--session=' + 'a'.repeat(200)]).sessionId, null);
  });
  test.it('nothing given -> nothing to do', () => {
    assert.deepEqual(parseLaunchArgs([]), { sessionId: null, quick: false });
    assert.deepEqual(parseLaunchArgs(undefined), { sessionId: null, quick: false });
  });
});
