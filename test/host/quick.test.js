// Quick prompt: target list, routing, hotkey (re-)registration, quick.* methods.
const test = require('node:test');
const assert = require('node:assert/strict');
const { quickTargets, routeQuickPrompt, createHotkey, quickMethods, DEFAULT_HOTKEY } = require('../../main/quick');

const sessions = [
  { id: 's_old', title: 'Old one', cwd: 'C:\\code\\storefront', project: 'storefront', status: 'idle', updatedAt: 10 },
  { id: 's_new', title: 'Fix login', cwd: 'C:\\code\\storefront', project: 'storefront', status: 'waiting', updatedAt: 30 },
  { id: 's_gone', title: 'Closed', cwd: 'C:\\code\\x', status: 'closed', updatedAt: 99 },
];
const projects = [{ cwd: 'C:\\code\\storefront', name: 'Storefront' }, { cwd: 'C:\\code\\helm\\', name: 'helm' }, { cwd: 'c:\\code\\storefront', name: 'dupe' }];

test.describe('quickTargets()', () => {
  test.it('lists open sessions newest first, then one "New session in" per project', () => {
    const { targets, defaultId } = quickTargets({ sessions, projects });
    assert.deepEqual(targets.map((t) => t.id), ['session:s_new', 'session:s_old', 'project:C:\\code\\storefront', 'project:C:\\code\\helm\\']);
    assert.equal(targets[0].label, 'Fix login');
    assert.match(targets[0].detail, /storefront · waiting/);
    assert.equal(targets[2].label, 'New session in Storefront');
    assert.equal(defaultId, 'project:C:\\code\\storefront', 'defaults to a new session, never into a running one');
  });
  test.it('remembers the last target while it still exists', () => {
    assert.equal(quickTargets({ sessions, projects, lastTarget: 'session:s_old' }).defaultId, 'session:s_old');
    assert.equal(quickTargets({ sessions, projects, lastTarget: 'session:s_gone' }).defaultId, 'project:C:\\code\\storefront');
  });
  test.it('falls back to defaults.cwd when there are no projects', () => {
    const { targets, defaultId } = quickTargets({ sessions: [], projects: [], defaultCwd: 'C:\\Users\\you' });
    assert.deepEqual(targets.map((t) => t.label), ['New session in you']);
    assert.equal(defaultId, 'project:C:\\Users\\you');
  });
  test.it('empty state has no default', () => {
    assert.deepEqual(quickTargets({}), { targets: [], defaultId: null });
  });
});

test.describe('routeQuickPrompt()', () => {
  test.it('session target -> sessions.send with trimmed text', () => {
    const r = routeQuickPrompt({ target: 'session:s_new', text: '  run the tests \n', sessions, projects });
    assert.deepEqual({ method: r.method, params: r.params, title: r.title }, { method: 'sessions.send', params: { id: 's_new', text: 'run the tests' }, title: 'Fix login' });
  });
  test.it('project target -> sessions.create with the prompt (path match ignores case and trailing slash)', () => {
    const r = routeQuickPrompt({ target: 'project:c:\\code\\HELM', text: 'hi', sessions, projects });
    assert.equal(r.method, 'sessions.create');
    assert.deepEqual(r.params, { cwd: 'c:\\code\\HELM', prompt: 'hi' });
  });
  test.it('defaults.cwd is a valid project target', () => {
    assert.equal(routeQuickPrompt({ target: 'project:C:\\Users\\you', text: 'x', projects: [], defaultCwd: 'C:\\Users\\you' }).method, 'sessions.create');
  });
  for (const [name, args] of [
    ['empty text', { target: 'session:s_new', text: '   ' }],
    ['non-string text', { target: 'session:s_new', text: 42 }],
    ['unknown session', { target: 'session:nope', text: 'x' }],
    ['unknown project', { target: 'project:C:\\elsewhere', text: 'x' }],
    ['no target', { target: '', text: 'x' }],
    ['bad prefix', { target: 'file:C:\\x', text: 'x' }],
  ]) {
    test.it(`rejects ${name} with bad_params`, () => {
      assert.throws(() => routeQuickPrompt({ ...args, sessions, projects }), (e) => e.code === 'bad_params');
    });
  }
});

function fakeShortcuts({ taken = [], invalid = [] } = {}) {
  const reg = new Map();
  return {
    reg,
    register(a, fn) { if (invalid.includes(a)) throw new Error('conversion failure'); if (taken.includes(a) || reg.has(a)) return false; reg.set(a, fn); return true; },
    unregister(a) { reg.delete(a); },
    isRegistered: (a) => reg.has(a),
  };
}

test.describe('createHotkey()', () => {
  test.it('registers, re-registers on change and unregisters the old one', () => {
    const gs = fakeShortcuts();
    let fired = 0;
    const hk = createHotkey({ globalShortcut: gs, onTrigger: () => fired++ });
    assert.deepEqual(hk.apply(DEFAULT_HOTKEY), { ok: true, accelerator: 'Control+Alt+Space' });
    gs.reg.get('Control+Alt+Space')();
    assert.equal(fired, 1);
    assert.equal(hk.apply('Control+Alt+Space'), null, 'unchanged value is a no-op');
    assert.equal(hk.apply('Alt+Shift+H').ok, true);
    assert.deepEqual([...gs.reg.keys()], ['Alt+Shift+H']);
    assert.equal(hk.current(), 'Alt+Shift+H');
  });
  test.it('empty string disables it', () => {
    const gs = fakeShortcuts();
    const hk = createHotkey({ globalShortcut: gs, onTrigger() {} });
    hk.apply('Control+Alt+Space');
    assert.deepEqual(hk.apply(''), { ok: true, accelerator: null });
    assert.equal(gs.reg.size, 0);
    assert.equal(hk.current(), null);
  });
  test.it('a taken accelerator reports once through onError and never throws', () => {
    const gs = fakeShortcuts({ taken: ['Control+Alt+Space'] });
    const errors = [];
    const hk = createHotkey({ globalShortcut: gs, onTrigger() {}, onError: (msg) => errors.push(msg) });
    const r = hk.apply('Control+Alt+Space');
    assert.equal(r.ok, false);
    assert.match(r.error, /already used by another app/);
    assert.equal(hk.apply('Control+Alt+Space'), null, 'same setting again (another settings change) does not re-nag');
    assert.equal(errors.length, 1);
    assert.equal(hk.current(), null);
  });
  test.it('an invalid accelerator is caught and reported', () => {
    const gs = fakeShortcuts({ invalid: ['Nope+Key'] });
    const errors = [];
    const hk = createHotkey({ globalShortcut: gs, onTrigger() {}, onError: (msg) => errors.push(msg) });
    hk.apply('Control+Alt+Space');
    const r = hk.apply('Nope+Key');
    assert.equal(r.ok, false);
    assert.match(errors[0], /not a valid shortcut/);
    assert.equal(gs.reg.size, 0, 'the old one was released before trying the new one');
  });
  test.it('dispose() releases it and a later apply registers again', () => {
    const gs = fakeShortcuts();
    const hk = createHotkey({ globalShortcut: gs, onTrigger() {} });
    hk.apply('Control+Alt+Space');
    hk.dispose();
    assert.equal(gs.reg.size, 0);
    assert.equal(hk.apply('Control+Alt+Space').ok, true);
  });
});

test.describe('quickMethods()', () => {
  function setup() {
    const calls = [];
    const engine = {
      snapshot: async () => ({ sessions }),
      methods: {
        'sessions.send': async (p) => { calls.push(['send', p]); return { itemId: 'i1', queued: true }; },
        'sessions.create': async (p) => { calls.push(['create', p]); return { id: 's_created', title: 'Hi there' }; },
      },
    };
    const settings = { get: () => ({ projects, defaults: { cwd: 'C:\\Users\\you' }, quickPromptHotkey: 'Control+Alt+Space' }) };
    const quick = { hidden: 0, hide() { this.hidden++; } };
    const selected = [];
    const m = quickMethods({ engine, settings, quick, selectSession: (id) => selected.push(id) });
    return { m, calls, quick, selected };
  }
  const desktop = { platform: 'electron' };
  const phone = { platform: 'web' };

  test.it('quick.targets returns the list plus the hotkey', async () => {
    const { m } = setup();
    const r = await m['quick.targets']({}, desktop);
    assert.equal(r.targets.length, 4);
    assert.equal(r.hotkey, 'Control+Alt+Space');
  });
  test.it('quick.send to a project creates a session and makes it the next default', async () => {
    const { m, calls } = setup();
    const r = await m['quick.send']({ target: 'project:C:\\code\\storefront', text: 'hello' }, desktop);
    assert.deepEqual(calls, [['create', { cwd: 'C:\\code\\storefront', prompt: 'hello' }]]);
    assert.deepEqual(r, { sessionId: 's_created', title: 'Hi there', created: true });
    // s_created is not in the (static) snapshot, so the default falls back to the first project
    assert.equal((await m['quick.targets']({}, desktop)).defaultId, 'project:C:\\code\\storefront');
  });
  test.it('quick.send to a session sends and reports queued', async () => {
    const { m, calls } = setup();
    const r = await m['quick.send']({ target: 'session:s_old', text: 'next' }, desktop);
    assert.deepEqual(calls, [['send', { id: 's_old', text: 'next' }]]);
    assert.deepEqual(r, { sessionId: 's_old', title: 'Old one', created: false, queued: true });
    assert.equal((await m['quick.targets']({}, desktop)).defaultId, 'session:s_old');
  });
  test.it('quick.hide / quick.open are desktop-only; open hides the box and selects', async () => {
    const { m, quick, selected } = setup();
    await assert.rejects(m['quick.hide']({}, phone), (e) => e.code === 'unsupported');
    await assert.rejects(m['quick.open']({ sessionId: 's_new' }, null), (e) => e.code === 'unsupported');
    await m['quick.open']({ sessionId: 's_new' }, desktop);
    assert.equal(quick.hidden, 1);
    assert.deepEqual(selected, ['s_new']);
  });
});
