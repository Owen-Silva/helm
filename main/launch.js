// How Helm launches itself: the stamped Helm.exe (tools/make-exe.js -> dist/Helm/Helm.exe,
// a renamed copy of Electron that runs this project folder), the Windows login item
// (settings.launchAtLogin) and the arguments a launch / second launch can carry.
// Owner: lane host (B).
const fs = require('fs');
const path = require('path');

const LOGIN_ITEM_NAME = 'Helm';

// dist/Helm/Helm.exe when it has been built, else the Electron that is running us.
function helmExePath(appDir) { return path.join(appDir, 'dist', 'Helm', 'Helm.exe'); }
function launcherExe(appDir, execPath, exists = fs.existsSync) {
  const exe = helmExePath(appDir);
  return exists(exe) ? exe : execPath;
}

/**
 * Options for app.setLoginItemSettings: start Helm.exe with this project folder, in the tray.
 * Windows writes HKCU\...\Run\<name> = "<path>" <args>; openAtLogin:false deletes that value.
 */
function loginItemOptions({ enabled, exe, appDir, name = LOGIN_ITEM_NAME }) {
  return { openAtLogin: !!enabled, path: exe, args: [appDir, '--hidden'], name, enabled: !!enabled };
}

/**
 * Keeps the login item in step with settings.launchAtLogin. The first apply() only writes
 * when the setting is on (so a fresh install never touches the Run key); later calls write
 * whenever the value changes. setLoginItem is app.setLoginItemSettings (or a test stub).
 */
function createLoginItem({ setLoginItem, exe, appDir, log = () => {} }) {
  let last = null;
  function apply(enabled) {
    enabled = !!enabled;
    if (last === enabled) return false;
    const first = last === null;
    last = enabled;
    if (first && !enabled) return false;
    const opts = loginItemOptions({ enabled, exe: exe(), appDir });
    try { setLoginItem(opts); log(`login item ${enabled ? 'on' : 'off'}: ${opts.path} ${opts.args.join(' ')}`); return true; }
    catch (e) { log('login item failed:', e.message); return false; }
  }
  return { apply };
}

/**
 * Launch arguments Helm acts on, both at start and when a second launch hands them over:
 *   --session=<id>   show the window on that session
 *   --quick          open the quick-prompt box
 *   helm://session/<id>, helm://quick   the same as URLs (for links)
 */
function parseLaunchArgs(argv) {
  const out = { sessionId: null, quick: false };
  for (const raw of argv || []) {
    const a = String(raw);
    let m;
    if ((m = /^--session=(.+)$/.exec(a))) out.sessionId = m[1];
    else if (a === '--quick') out.quick = true;
    else if ((m = /^helm:\/\/session\/([^/?#]+)/i.exec(a))) out.sessionId = decodeURIComponent(m[1]);
    else if (/^helm:\/\/quick\b/i.test(a)) out.quick = true;
  }
  if (out.sessionId && !/^[A-Za-z0-9_.:-]{1,120}$/.test(out.sessionId)) out.sessionId = null;
  return out;
}

module.exports = { LOGIN_ITEM_NAME, helmExePath, launcherExe, loginItemOptions, createLoginItem, parseLaunchArgs };
