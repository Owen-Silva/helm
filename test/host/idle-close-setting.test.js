// Settings "Close idle sessions after" (closeIdleAfterMin, main/settings.js; the engine's idle reaper reads it via main.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSettings } = require('../../main/settings');

test('closeIdleAfterMin: defaults to 15, whole minutes 0 (never) to 1440, persists', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-idle-setting-'));
  try {
    const mk = () => createSettings({ userDataDir: dir, uiBgDir: path.join(dir, 'bg'), appDataDir: dir, home: dir });
    const s = mk();
    assert.equal(s.get().closeIdleAfterMin, 15);
    for (const bad of ['15', -1, 1.5, 1441, null, true]) assert.throws(() => s.set({ closeIdleAfterMin: bad }), (e) => e.code === 'bad_params', String(bad));
    assert.equal(s.set({ closeIdleAfterMin: 0 }).closeIdleAfterMin, 0);
    assert.equal(s.set({ closeIdleAfterMin: 60 }).closeIdleAfterMin, 60);
    assert.equal(mk().get().closeIdleAfterMin, 60);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
