// Unit tests for main/settings.js (defaults, wallpaper import, set/merge, backgrounds, projects, phone url).
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createSettings, imageExt, defaults } = require('../../main/settings.js');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(24, 2)]);
const GIF = Buffer.concat([Buffer.from('GIF89a', 'ascii'), Buffer.alloc(24, 3)]);
const WEBP = Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.alloc(4), Buffer.from('WEBP', 'ascii'), Buffer.alloc(16)]);

const tmpRoots = [];
after(() => { for (const d of tmpRoots) fs.rmSync(d, { recursive: true, force: true }); });

// A fresh sandbox: userData, a bundled bg dir with two images, an AppData dir, and a home.
function sandbox({ wallpaper } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-settings-'));
  tmpRoots.push(root);
  const dirs = {
    root,
    userDataDir: path.join(root, 'userData'),
    uiBgDir: path.join(root, 'uiBg'),
    appDataDir: path.join(root, 'AppData'),
    home: path.join(root, 'home'),
  };
  for (const d of [dirs.userDataDir, dirs.uiBgDir, dirs.appDataDir, dirs.home]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(dirs.uiBgDir, 'a-bundled.png'), PNG);
  fs.writeFileSync(path.join(dirs.uiBgDir, 'b-bundled.jpg'), JPEG);
  fs.writeFileSync(path.join(dirs.uiBgDir, 'notes.txt'), 'not an image');
  if (wallpaper) setWallpaper(dirs, wallpaper);
  return dirs;
}
function setWallpaper(dirs, buf) {
  const themes = path.join(dirs.appDataDir, 'Microsoft', 'Windows', 'Themes');
  fs.mkdirSync(themes, { recursive: true });
  fs.writeFileSync(path.join(themes, 'TranscodedWallpaper'), buf);
}
function open(dirs) {
  const emits = [];
  const st = createSettings({
    userDataDir: dirs.userDataDir, uiBgDir: dirs.uiBgDir, appDataDir: dirs.appDataDir, home: dirs.home,
    emit: (ev, data) => emits.push({ ev, data }),
  });
  return { st, emits };
}
const bgPath = (dirs, f) => path.join(dirs.userDataDir, 'backgrounds', f);
const dataUrl = (mime, buf) => `data:${mime};base64,${buf.toString('base64')}`;

describe('imageExt / defaults', () => {
  test('sniffs magic bytes', () => {
    assert.equal(imageExt(PNG), '.png');
    assert.equal(imageExt(JPEG), '.jpg');
    assert.equal(imageExt(GIF), '.gif');
    assert.equal(imageExt(WEBP), '.webp');
    assert.equal(imageExt(Buffer.from('hello world, not an image')), null);
    assert.equal(imageExt(Buffer.from([0x89, 0x50])), null);
    assert.equal(imageExt(null), null);
  });

  test('defaults(home)', () => {
    const d = defaults('C:\\Users\\me');
    assert.equal(d.theme, 'dark');
    assert.deepEqual(d.defaults, { model: 'claude-opus-5-5', effort: 'xhigh', permissionMode: 'bypassPermissions', cwd: 'C:\\Users\\me' });
    assert.deepEqual(d.notifications, { waiting: true, done: true, error: true });
    assert.deepEqual(d.phone, { enabled: true, url: null });
    assert.deepEqual(d.projects, []);
  });
});

describe('createSettings first run', () => {
  test('defaults with home as cwd, saved to settings.json', () => {
    const dirs = sandbox();
    const { st } = open(dirs);
    const s = st.get();
    assert.equal(st.firstRun, true);
    assert.equal(s.theme, 'dark');
    assert.equal(s.defaults.model, 'claude-opus-5-5');
    assert.equal(s.defaults.effort, 'xhigh');
    assert.equal(s.defaults.permissionMode, 'bypassPermissions');
    assert.equal(s.defaults.cwd, dirs.home);
    assert.equal(st.file, path.join(dirs.userDataDir, 'settings.json'));
    assert.ok(fs.existsSync(st.file));
    assert.deepEqual(st.bgDirs, [path.join(dirs.userDataDir, 'backgrounds'), dirs.uiBgDir]);
    // get() returns a copy
    st.get().theme = 'light';
    assert.equal(st.get().theme, 'dark');
  });

  test('copies a PNG Windows wallpaper and selects it', () => {
    const dirs = sandbox({ wallpaper: PNG });
    const { st } = open(dirs);
    const s = st.get();
    assert.ok(fs.existsSync(bgPath(dirs, 'wallpaper.png')));
    assert.deepEqual(fs.readFileSync(bgPath(dirs, 'wallpaper.png')), PNG);
    assert.equal(s.background.file, 'wallpaper.png');
    assert.equal(s.backgrounds[0], 'wallpaper.png');
    assert.ok(s.backgrounds.includes('a-bundled.png'));
    assert.ok(!s.backgrounds.includes('notes.txt'));
  });

  test('copies a JPEG Windows wallpaper as wallpaper.jpg', () => {
    const dirs = sandbox({ wallpaper: JPEG });
    const { st } = open(dirs);
    assert.ok(fs.existsSync(bgPath(dirs, 'wallpaper.jpg')));
    assert.ok(!fs.existsSync(bgPath(dirs, 'wallpaper.png')));
    assert.equal(st.get().background.file, 'wallpaper.jpg');
  });

  test('no wallpaper -> first bundled image', () => {
    const dirs = sandbox();
    const { st } = open(dirs);
    const s = st.get();
    assert.equal(s.background.file, 'a-bundled.png');
    assert.deepEqual(s.backgrounds, ['a-bundled.png', 'b-bundled.jpg']);
  });

  test('non-image wallpaper is skipped -> first bundled image', () => {
    const dirs = sandbox({ wallpaper: Buffer.from('this is definitely not an image file') });
    const { st } = open(dirs);
    assert.equal(st.get().background.file, 'a-bundled.png');
    assert.deepEqual(fs.readdirSync(path.join(dirs.userDataDir, 'backgrounds')), []);
  });

  test('second run does not re-copy and keeps saved values', () => {
    const dirs = sandbox({ wallpaper: PNG });
    const first = open(dirs).st;
    first.set({ theme: 'light', background: { file: 'b-bundled.jpg' } });
    setWallpaper(dirs, JPEG); // the Windows wallpaper changed since
    const { st } = open(dirs);
    const s = st.get();
    assert.equal(st.firstRun, false);
    assert.equal(s.theme, 'light');
    assert.equal(s.background.file, 'b-bundled.jpg');
    assert.ok(!fs.existsSync(bgPath(dirs, 'wallpaper.jpg')));
    assert.deepEqual(fs.readFileSync(bgPath(dirs, 'wallpaper.png')), PNG);
  });

  test('a saved background that no longer exists falls back to the first available', () => {
    const dirs = sandbox();
    open(dirs).st.set({ background: { file: 'deleted-later.png' } });
    const { st } = open(dirs);
    assert.equal(st.get().background.file, 'a-bundled.png');
  });
});

describe('set()', () => {
  test('validates', () => {
    const { st } = open(sandbox());
    const bad = [
      null, 'x', [], { theme: 'neon' }, { defaults: 'x' }, { defaults: { permissionMode: 'yolo' } },
      { defaults: { cwd: 5 } }, { background: 'x' }, { background: { file: '../evil.png' } },
      { background: { file: 'sub/x.png' } }, { background: { blur: 500 } }, { background: { dim: 2 } },
      { projects: 'x' }, { projects: [{ name: 'no cwd' }] }, { snippets: {} }, { notifications: true }, { phone: 'on' },
    ];
    for (const p of bad) assert.throws(() => st.set(p), { code: 'bad_params' }, JSON.stringify(p));
    assert.equal(st.get().theme, 'dark');
  });

  test('deep-merges background / defaults / notifications', () => {
    const { st } = open(sandbox());
    const before = st.get();
    st.set({ defaults: { model: 'claude-fable' } });
    st.set({ background: { blur: 10 } });
    st.set({ notifications: { done: false } });
    const s = st.get();
    assert.deepEqual(s.defaults, { ...before.defaults, model: 'claude-fable' });
    assert.deepEqual(s.background, { ...before.background, blur: 10 });
    assert.deepEqual(s.notifications, { waiting: true, done: false, error: true });
  });

  test('ignores backgrounds and phone.url; keeps phone.enabled edits', () => {
    const { st } = open(sandbox());
    const before = st.get().backgrounds;
    st.set({ backgrounds: ['evil.png'], phone: { url: 'http://evil.example', enabled: false } });
    const s = st.get();
    assert.deepEqual(s.backgrounds, before);
    assert.deepEqual(s.phone, { enabled: false, url: null });
    st.setPhoneUrl('http://100.64.0.1:7777');
    st.set({ phone: { enabled: true } });
    assert.deepEqual(st.get().phone, { enabled: true, url: 'http://100.64.0.1:7777' });
  });

  test('normalizes projects and emits + persists settings.updated', () => {
    const dirs = sandbox();
    const { st, emits } = open(dirs);
    const proj = path.join(dirs.root, 'my-proj');
    const out = st.set({ theme: 'system', projects: [{ cwd: proj, pinned: 1, extra: 'x' }] });
    assert.deepEqual(out.projects, [{ cwd: proj, name: 'my-proj', pinned: true }]);
    assert.equal(emits.length, 1);
    assert.equal(emits[0].ev, 'settings.updated');
    assert.deepEqual(emits[0].data, st.get());
    const saved = JSON.parse(fs.readFileSync(st.file, 'utf8'));
    assert.equal(saved.theme, 'system');
  });
});

describe('uploadBackground()', () => {
  test('saves, selects, lists; sanitizes the name; never overwrites', () => {
    const dirs = sandbox();
    const { st, emits } = open(dirs);
    const s1 = st.uploadBackground({ name: 'My Pic!.png', dataUrl: dataUrl('image/png', PNG) });
    assert.equal(s1.background.file, 'My-Pic-.png');
    assert.equal(s1.background.kind, 'image');
    assert.ok(s1.backgrounds.includes('My-Pic-.png'));
    assert.deepEqual(fs.readFileSync(bgPath(dirs, 'My-Pic-.png')), PNG);
    assert.equal(emits.at(-1).ev, 'settings.updated');

    const s2 = st.uploadBackground({ name: 'My Pic!.png', dataUrl: dataUrl('image/png', PNG) });
    assert.equal(s2.background.file, 'My-Pic--2.png');
    assert.ok(fs.existsSync(bgPath(dirs, 'My-Pic-.png')));
    assert.ok(fs.existsSync(bgPath(dirs, 'My-Pic--2.png')));
  });

  test('extension comes from the bytes; path parts are stripped', () => {
    const dirs = sandbox();
    const { st } = open(dirs);
    const s = st.uploadBackground({ name: '..\\..\\..\\evil.png', dataUrl: dataUrl('image/jpeg', JPEG) });
    assert.equal(s.background.file, 'evil.jpg');
    assert.ok(fs.existsSync(bgPath(dirs, 'evil.jpg')));
    const s2 = st.uploadBackground({ dataUrl: dataUrl('image/gif', GIF) });
    assert.equal(s2.background.file, 'background.gif');
    const s3 = st.uploadBackground({ name: '...', dataUrl: dataUrl('image/webp', WEBP) });
    assert.equal(s3.background.file, 'background.webp');
  });

  test('rejects non-image mime, non-image bytes, and > 15 MB', () => {
    const dirs = sandbox();
    const { st } = open(dirs);
    assert.throws(() => st.uploadBackground({ name: 'x.txt', dataUrl: dataUrl('text/plain', PNG) }), { code: 'bad_params' });
    assert.throws(() => st.uploadBackground({ name: 'x.svg', dataUrl: dataUrl('image/svg+xml', PNG) }), { code: 'bad_params' });
    assert.throws(() => st.uploadBackground({ name: 'x.png' }), { code: 'bad_params' });
    assert.throws(() => st.uploadBackground({ name: 'x.png', dataUrl: dataUrl('image/png', Buffer.from('hello there, plain text')) }),
      { code: 'bad_params', message: /not a PNG/ });
    const big = Buffer.concat([PNG, Buffer.alloc(15 * 1024 * 1024)]);
    assert.throws(() => st.uploadBackground({ name: 'big.png', dataUrl: dataUrl('image/png', big) }),
      { code: 'bad_params', message: /15 MB/ });
    assert.throws(() => st.uploadBackground(undefined), { code: 'bad_params' });
    assert.deepEqual(fs.readdirSync(path.join(dirs.userDataDir, 'backgrounds')), []);
  });
});

describe('projects follow sessions', () => {
  test('session.created adds a project once, case-insensitively, after pinned ones', () => {
    const dirs = sandbox();
    const { st, emits } = open(dirs);
    const pinned = path.join(dirs.root, 'pinned');
    const a = path.join(dirs.root, 'proj-a');
    const b = path.join(dirs.root, 'proj-b');
    st.set({ projects: [{ cwd: pinned, pinned: true }] });

    st.onEngineEvent('session.created', { id: 's1', cwd: a });
    assert.deepEqual(st.get().projects.map((p) => p.cwd), [pinned, a]);
    assert.deepEqual(st.get().projects[1], { cwd: a, name: 'proj-a', pinned: false });

    st.onEngineEvent('session.created', { id: 's2', cwd: b });
    assert.deepEqual(st.get().projects.map((p) => p.cwd), [pinned, b, a]);

    const n = emits.length;
    st.onEngineEvent('session.created', { id: 's3', cwd: a.toUpperCase() });
    const cwds = st.get().projects.map((p) => p.cwd);
    assert.equal(cwds.length, 3, 'no duplicate for a case variant');
    assert.deepEqual(cwds, [pinned, a, b]);
    assert.equal(emits.length, n + 1);

    st.onEngineEvent('session.created', { id: 's4', cwd: pinned.toUpperCase() });
    assert.deepEqual(st.get().projects.map((p) => p.cwd), [pinned, a, b]);
  });

  test('ignores other events and missing cwd', () => {
    const { st, emits } = open(sandbox());
    st.onEngineEvent('session.updated', { cwd: 'C:\\x' });
    st.onEngineEvent('session.created', {});
    st.onEngineEvent('session.created', null);
    st.onEngineEvent('session.created', { cwd: '' });
    assert.deepEqual(st.get().projects, []);
    assert.equal(emits.length, 0);
  });

  test('with no pinned projects the newest goes first', () => {
    const dirs = sandbox();
    const { st } = open(dirs);
    const a = path.join(dirs.root, 'a');
    const b = path.join(dirs.root, 'b');
    st.onEngineEvent('session.created', { cwd: a });
    st.onEngineEvent('session.created', { cwd: b });
    assert.deepEqual(st.get().projects.map((p) => p.cwd), [b, a]);
  });
});

describe('setPhoneUrl()', () => {
  test('sets the url and emits only on change', () => {
    const dirs = sandbox();
    const { st, emits } = open(dirs);
    st.setPhoneUrl('http://100.64.0.1:7777');
    assert.equal(st.get().phone.url, 'http://100.64.0.1:7777');
    assert.equal(st.get().phone.enabled, true);
    assert.equal(emits.length, 1);
    st.setPhoneUrl('http://100.64.0.1:7777');
    assert.equal(emits.length, 1);
    st.setPhoneUrl(null);
    assert.equal(st.get().phone.url, null);
    assert.equal(emits.length, 2);
    assert.equal(JSON.parse(fs.readFileSync(st.file, 'utf8')).phone.url, null);
  });
});

describe('round 3: launchAtLogin + quickPromptHotkey', () => {
  test('defaults: off at login, Control+Alt+Space', () => {
    const { st } = open(sandbox());
    assert.equal(st.get().launchAtLogin, false);
    assert.equal(st.get().quickPromptHotkey, 'Control+Alt+Space');
  });
  test('set + persist, hotkey trimmed, empty string allowed', () => {
    const dirs = sandbox();
    const { st, emits } = open(dirs);
    st.set({ launchAtLogin: true, quickPromptHotkey: '  Alt+Shift+H ' });
    assert.equal(emits.at(-1).ev, 'settings.updated');
    assert.equal(emits.at(-1).data.quickPromptHotkey, 'Alt+Shift+H');
    st.set({ quickPromptHotkey: '' });
    const again = open(dirs).st.get();
    assert.equal(again.launchAtLogin, true);
    assert.equal(again.quickPromptHotkey, '');
  });
  test('rejects bad types with bad_params', () => {
    const { st } = open(sandbox());
    for (const bad of [{ launchAtLogin: 'yes' }, { launchAtLogin: 1 }, { quickPromptHotkey: 5 }, { quickPromptHotkey: 'x'.repeat(61) }, { quickPromptHotkey: 'Ctrl+A\nB' }]) {
      assert.throws(() => st.set(bad), (e) => e.code === 'bad_params', JSON.stringify(bad));
    }
  });
});

// ---------- review-main round: corruption recovery, atomic save, tighter validation ----------
describe('review: persistence + validation', () => {
  test('an unreadable settings.json is kept aside (not silently overwritten with defaults)', () => {
    const dirs = sandbox();
    const file = path.join(dirs.userDataDir, 'settings.json');
    const broken = '{"theme": "light", "projects": [{"cwd": "C:/work"}], ';
    fs.writeFileSync(file, broken);
    const { st } = open(dirs);
    assert.equal(st.get().theme, 'dark'); // defaults in memory...
    const aside = fs.readdirSync(dirs.userDataDir).filter((f) => /^settings\.json\.bad-/.test(f));
    assert.equal(aside.length, 1, 'the broken file was not kept');
    assert.equal(fs.readFileSync(path.join(dirs.userDataDir, aside[0]), 'utf8'), broken); // ...but the user's data survives
    assert.equal(st.firstRun, false, 'a broken file is not a first run (no wallpaper re-import)');
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(file, 'utf8')));
  });

  test('save leaves no temp file and survives a stale one', () => {
    const dirs = sandbox();
    fs.writeFileSync(path.join(dirs.userDataDir, 'settings.json.tmp'), 'junk');
    const { st } = open(dirs);
    st.set({ theme: 'light' });
    assert.equal(JSON.parse(fs.readFileSync(path.join(dirs.userDataDir, 'settings.json'), 'utf8')).theme, 'light');
    assert.equal(fs.existsSync(path.join(dirs.userDataDir, 'settings.json.tmp')), false);
  });

  test('rejects values that would reach the engine or the UI with the wrong type', () => {
    const { st } = open(sandbox());
    const bad = [
      { defaults: { model: {} } }, { defaults: { model: 'x'.repeat(201) } }, { defaults: { effort: 5 } },
      { background: { file: '..' } }, { background: { file: '.' } }, { background: { file: 'a\u0000.png' } }, { background: { kind: {} } },
      { projects: [{ cwd: 'C:/x', name: {} }] }, { projects: [{ cwd: '' }] },
      { snippets: ['x'] }, { snippets: [{ id: 'a', name: 'n', text: 5 }] },
    ];
    for (const p of bad) assert.throws(() => st.set(p), { code: 'bad_params' }, JSON.stringify(p));
    // the shapes the UI really sends still pass
    st.set({ defaults: { model: 'claude-opus-5-5', effort: 'high', cwd: 'C:/x' }, snippets: [{ id: 's1', name: 'Review', text: 'review this' }], background: { kind: 'image', file: 'a-bundled.png' } });
    st.set({ defaults: { model: null, effort: null } });
  });

  test('an upload named like a Windows device (CON, NUL, COM1) is saved under a safe name', () => {
    const dirs = sandbox();
    const { st } = open(dirs);
    for (const name of ['CON.png', 'nul.png', 'COM1.png', 'aux']) {
      const s = st.uploadBackground({ name, dataUrl: dataUrl('image/png', PNG) });
      assert.doesNotMatch(s.background.file, /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i, name);
      assert.ok(fs.existsSync(bgPath(dirs, s.background.file)), name);
      assert.ok(s.backgrounds.includes(s.background.file), name);
    }
  });
});

// ---------- lane presets: launch presets for the New session dialog ----------
describe('presets', () => {
  const P = (over = {}) => ({ id: 'p1', name: 'Shop xhigh', cwd: 'C:/work/shop', model: 'claude-opus-5-5', effort: 'xhigh', permissionMode: 'bypassPermissions', ...over });
  test('default is an empty list', () => {
    assert.deepEqual(open(sandbox()).st.get().presets, []);
    assert.deepEqual(defaults('C:/h').presets, []);
  });
  test('set replaces the list, trims, drops unknown keys and empty prompts, persists', () => {
    const dirs = sandbox();
    const { st, emits } = open(dirs);
    st.set({ presets: [P({ name: '  Shop xhigh ', cwd: ' C:/work/shop ', extra: 'nope', prompt: '   ' }), P({ id: 'p2', name: 'Review', prompt: 'Review the diff', permissionMode: 'plan' })] });
    assert.equal(emits.at(-1).ev, 'settings.updated');
    const again = open(dirs).st.get().presets;
    assert.deepEqual(again, [
      { id: 'p1', name: 'Shop xhigh', cwd: 'C:/work/shop', model: 'claude-opus-5-5', effort: 'xhigh', permissionMode: 'bypassPermissions' },
      { id: 'p2', name: 'Review', cwd: 'C:/work/shop', model: 'claude-opus-5-5', effort: 'xhigh', permissionMode: 'plan', prompt: 'Review the diff' },
    ]);
    st.set({ presets: [] });
    assert.deepEqual(open(dirs).st.get().presets, []);
  });
  test('model / effort / permissionMode / prompt are optional', () => {
    const { st } = open(sandbox());
    st.set({ presets: [{ id: 'a', name: 'Bare', cwd: 'C:/x' }] });
    assert.deepEqual(st.get().presets, [{ id: 'a', name: 'Bare', cwd: 'C:/x' }]);
  });
  test('caps the list at 20 and rejects bad entries with bad_params', () => {
    const { st } = open(sandbox());
    const twenty = Array.from({ length: 20 }, (_, i) => P({ id: 'p' + i }));
    st.set({ presets: twenty });
    assert.equal(st.get().presets.length, 20);
    const bad = [
      { presets: 'x' }, { presets: {} }, { presets: [...twenty, P({ id: 'p20' })] },
      { presets: [null] }, { presets: ['str'] },
      { presets: [P({ id: '' })] }, { presets: [P({ id: 5 })] }, { presets: [P({ id: 'x'.repeat(65) })] },
      { presets: [P(), P()] },                                       // duplicate id
      { presets: [P({ name: '' })] }, { presets: [P({ name: '   ' })] }, { presets: [P({ name: 'n'.repeat(81) })] },
      { presets: [P({ cwd: '' })] }, { presets: [P({ cwd: 3 })] }, { presets: [P({ cwd: 'c'.repeat(1001) })] },
      { presets: [P({ model: 7 })] }, { presets: [P({ effort: 'e'.repeat(41) })] },
      { presets: [P({ permissionMode: 'yolo' })] }, { presets: [P({ prompt: 'p'.repeat(20_001) })] }, { presets: [P({ prompt: 4 })] },
    ];
    for (const b of bad) assert.throws(() => st.set(b), (e) => e.code === 'bad_params', JSON.stringify(b).slice(0, 120));
    assert.equal(st.get().presets.length, 20, 'a rejected set leaves the list untouched');
  });
  test('a hand-edited non-array presets value loads as []', () => {
    const dirs = sandbox();
    fs.writeFileSync(path.join(dirs.userDataDir, 'settings.json'), JSON.stringify({ theme: 'light', presets: 'oops' }));
    const s = open(dirs).st.get();
    assert.equal(s.theme, 'light');
    assert.deepEqual(s.presets, []);
  });
});

// ---------- context hand-off alerts toggle (lane infra, 2026-10-08) ----------
describe('notifyContextHandoff', () => {
  test('defaults on, also for a settings.json written before the setting existed', () => {
    const dirs = sandbox();
    assert.equal(open(dirs).st.get().notifyContextHandoff, true);
    const file = path.join(dirs.userDataDir, 'settings.json');
    const old = JSON.parse(fs.readFileSync(file, 'utf8')); delete old.notifyContextHandoff;
    fs.writeFileSync(file, JSON.stringify(old));
    assert.equal(open(dirs).st.get().notifyContextHandoff, true);
  });
  test('set false persists and emits settings.updated', () => {
    const dirs = sandbox();
    const { st, emits } = open(dirs);
    st.set({ notifyContextHandoff: false });
    assert.equal(emits.at(-1).ev, 'settings.updated');
    assert.equal(emits.at(-1).data.notifyContextHandoff, false);
    assert.equal(open(dirs).st.get().notifyContextHandoff, false);
  });
  test('rejects non-booleans with bad_params', () => {
    const { st } = open(sandbox());
    for (const bad of [{ notifyContextHandoff: 'no' }, { notifyContextHandoff: 0 }, { notifyContextHandoff: null }]) {
      assert.throws(() => st.set(bad), (e) => e.code === 'bad_params', JSON.stringify(bad));
    }
  });
});

// The Anthropic API key (main/settings.js createKeyStore): its own file, never in settings.json or settings.get().
describe('API key store', () => {
  const KEY = 'sk-ant-api03-FAKEsettingsTEST-not-real-0000-qrst';
  const mkSt = (dirs, extra = {}) => createSettings({ userDataDir: dirs.userDataDir, uiBgDir: dirs.uiBgDir, appDataDir: dirs.appDataDir, home: dirs.home, ...extra });

  test('get() shows only apiKeySet / apiKeyLast4; settings.updated never carries the key', () => {
    const dirs = sandbox();
    const events = [];
    const st = mkSt(dirs, { emit: (ev, d) => events.push([ev, d]) });
    assert.deepEqual(st.get().account, { apiKeySet: false, apiKeyLast4: null });
    st.setApiKey(KEY);
    assert.equal(st.getApiKey(), KEY);
    assert.deepEqual(st.get().account, { apiKeySet: true, apiKeyLast4: 'qrst' });
    assert.equal(JSON.stringify(st.get()).includes(KEY), false);
    assert.equal(JSON.stringify(events).includes(KEY), false);
    assert.ok(events.some(([ev, d]) => ev === 'settings.updated' && d.account.apiKeySet));
    assert.equal(fs.readFileSync(path.join(dirs.userDataDir, 'settings.json'), 'utf8').includes(KEY), false);
    st.setApiKey(null);
    assert.equal(st.getApiKey(), null);
    assert.equal(fs.existsSync(path.join(dirs.userDataDir, 'api-key.json')), false);
  });

  test('settings.set refuses a key and ignores an echoed account; a key typed into settings.json moves out', () => {
    const dirs = sandbox();
    const st = mkSt(dirs);
    assert.throws(() => st.set({ apiKey: KEY }), (e) => e.code === 'bad_params' && /account\.setApiKey/.test(e.message));
    assert.throws(() => st.set({ anthropicApiKey: KEY }), (e) => e.code === 'bad_params');
    st.set({ ...st.get(), account: { apiKeySet: true, apiKeyLast4: 'zzzz' } });
    assert.deepEqual(st.get().account, { apiKeySet: false, apiKeyLast4: null }, 'derived, never stored');
    assert.equal('account' in JSON.parse(fs.readFileSync(path.join(dirs.userDataDir, 'settings.json'), 'utf8')), false);
    // hand-edited settings.json with a key: moved to api-key.json on the next start
    const file = path.join(dirs.userDataDir, 'settings.json');
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), apiKey: KEY }));
    const logs = [];
    const st2 = mkSt(dirs, { log: (...a) => logs.push(a.join(' ')) });
    assert.equal(st2.getApiKey(), KEY);
    assert.equal(fs.readFileSync(file, 'utf8').includes(KEY), false);
    assert.equal(JSON.stringify(st2.get()).includes(KEY), false);
    assert.equal(logs.join('\n').includes(KEY), false);
  });
});
