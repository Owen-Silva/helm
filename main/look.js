// Look Sync for Helm (lane 3 of ~/look-sync/CONTRACT.md). Helm, Quartz and Mantle share one look file
// (%APPDATA%\look-sync\look.json): theme, accent hue and glass (blur / dim / panel per theme). This module
// owns Helm's LookSync instance (main/look-sync.js, vendored) and is the only bridge between it and the
// settings store:
//   - local change (settings.set without fromSync) -> publish the changed field(s)
//   - remote change ('apply')                       -> settings.applyLook(changes) (fromSync: never published)
//   - the switch (settings lookSync.enabled)        -> sync.setEnabled(on); ON adopts the shared values
//   - Mantle's desktop record ('desktop')           -> the picture /bg/desktop serves in 'desktop' mode,
//     with Windows' own wallpaper (TranscodedWallpaper) as the announced fallback
// State for the UI: look.get / app.hello `look` / event look.updated = { sync, desktop } (PROTOCOL "Look Sync").
// Owner: lane look-sync.
const fs = require('fs');
const path = require('path');
const LS = require('./look-sync');
const { imageExt } = require('./settings');

// "Change it in Mantle": Mantle's live instance opens its Wallpapers window when a second instance starts with
// --open=wallpapers (Mantle look-sync lane, 2026-10-10). The Settings button appears only when Mantle is installed
// at ~/mantle-live (look state mantleOpen.available).
const MANTLE_DIR = path.join(require('os').homedir(), 'mantle-live');
const MANTLE_EXE = path.join(MANTLE_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
const MANTLE_OPEN = fs.existsSync(MANTLE_EXE) ? { exe: MANTLE_EXE, args: ['.', '--open=wallpapers'], cwd: MANTLE_DIR } : null;
const MANTLE_EXIT = {
  3: 'Mantle is not running, so its Wallpapers could not be opened',
  4: 'Mantle refused the request',
};
const MANTLE_OPEN_REASON = "Helm can't open Mantle's Wallpapers: Mantle was not found at " + MANTLE_DIR + '.';

const TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
const IMAGE_FILE = /\.(png|jpe?g|webp|gif)$/i;

// Shared top-band darkening (CONTRACT "Shared top-band darkening (desktop.guard)"): Mantle publishes ONE dark
// alpha for the top band of the desktop still, so Mantle's top bar, Quartz's strip and Helm's wash match on every
// photo. Helm's dark wash uses it in 'desktop' mode; this validates it. Anything unusable -> guard null + the reason.
const GUARD_MIN = 0.5, GUARD_MAX = 0.88;
const isNum = (n) => typeof n === 'number' && Number.isFinite(n);
const near = (a, b) => Math.abs(a - b) < 0.005;
const f2 = (n) => (isNum(n) ? n.toFixed(2) : String(n));
/**
 * checkGuard(record, glassDark, { syncOn, source }) -> { guard: { alpha, dim, blurPx } | null, guardReason: text | null }
 *   record: Mantle's desktop record; glassDark: Helm's synced dark glass { blurPx, dim }; source: which picture shows
 */
function checkGuard(rec, glassDark, { syncOn, source }) {
  const no = (why) => ({ guard: null, guardReason: why });
  if (!syncOn) return no('Look Sync is off, so the shared darkening is not used');
  if (source !== 'mantle' || !rec) return no("Mantle is not sharing the desktop picture, so there is no shared darkening for it");
  if (rec.guard === undefined || rec.guard === null) {
    return no(rec.guardReason ? `Mantle could not work out the shared darkening: ${rec.guardReason}` : "Mantle hasn't shared a darkening for this wallpaper");
  }
  const d = rec.guard && rec.guard.dark;
  if (!d || typeof d !== 'object') return no("Mantle's shared darkening has no dark value");
  if (!isNum(d.alpha) || d.alpha < GUARD_MIN - 1e-9 || d.alpha > GUARD_MAX + 1e-9) {
    return no(`Mantle's shared darkening (${f2(d.alpha)}) is outside ${f2(GUARD_MIN)}-${f2(GUARD_MAX)}`);
  }
  if (!isNum(d.dim) || !isNum(d.blurPx)) return no("Mantle's shared darkening does not say which dim and blur it was worked out for");
  const g = glassDark || {};
  if (!near(d.dim, g.dim) || !near(d.blurPx, g.blurPx)) {
    return no(`Mantle's shared darkening is out of date: worked out for dim ${f2(d.dim)} / blur ${d.blurPx}px, the glass is now dim ${f2(g.dim)} / blur ${g.blurPx}px`);
  }
  return { guard: { alpha: d.alpha, dim: d.dim, blurPx: d.blurPx }, guardReason: null };
}

// The light twin (CONTRACT "Light look", desktop.guard.light): Mantle's WHITE alpha for the same top band, so ink-2
// keeps 4.7:1 on Helm's light wash. Its floor is the light dim it was worked out for (Mantle starts there), ceiling
// .88. Missing, invalid or stale (dim / blur differ from the synced glass.light) -> null + the reason; Helm then
// paints glass.light.dim unraised and the Appearance status line says why.
const LIGHT_MAX = 0.88;
/**
 * checkGuardLight(record, glassLight, { syncOn, source }) -> { guardLight: { alpha, dim, blurPx } | null, guardLightReason }
 */
function checkGuardLight(rec, glassLight, { syncOn, source }) {
  const no = (why) => ({ guardLight: null, guardLightReason: why });
  if (!syncOn) return no('Look Sync is off, so the shared light top band is not used');
  if (source !== 'mantle' || !rec) return no('Mantle is not sharing the desktop picture, so there is no shared light top band for it');
  const l = rec.guard && typeof rec.guard === 'object' ? rec.guard.light : undefined;
  if (l === undefined || l === null) {
    return no(rec.guardReason && !rec.guard ? `Mantle could not work out the light top band: ${rec.guardReason}` : 'light top band not published by Mantle yet');
  }
  if (typeof l !== 'object') return no("Mantle's light top band is not readable");
  if (!isNum(l.dim) || !isNum(l.blurPx)) return no("Mantle's light top band does not say which dim and blur it was worked out for");
  if (!isNum(l.alpha) || l.alpha < l.dim - 1e-9 || l.alpha > LIGHT_MAX + 1e-9) {
    return no(`Mantle's light top band (${f2(l.alpha)}) is outside ${f2(l.dim)}-${f2(LIGHT_MAX)}`);
  }
  const g = glassLight || {};
  if (!near(l.dim, g.dim) || !near(l.blurPx, g.blurPx)) {
    return no(`Mantle's light top band is stale: worked out for dim ${f2(l.dim)} / blur ${l.blurPx}px, the light glass is now dim ${f2(g.dim)} / blur ${g.blurPx}px`);
  }
  return { guardLight: { alpha: l.alpha, dim: l.dim, blurPx: l.blurPx }, guardLightReason: null };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const norm = (p) => path.resolve(String(p)).toLowerCase();
// a path inside dir (not dir itself), compared case-insensitively like Windows does
function inside(dir, p) {
  const d = norm(dir) + path.sep;
  return norm(p).startsWith(d);
}

// Sniff the first bytes: the served file must really be an image (TranscodedWallpaper has no extension).
function sniff(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(16);
    const n = fs.readSync(fd, buf, 0, 16, 0);
    const ext = imageExt(buf.subarray(0, n));
    return ext ? TYPES[ext] : null;
  } catch { return null; } finally { if (fd !== null) try { fs.closeSync(fd); } catch {} }
}

/**
 * createLook({ settings, emit, log, dir?, windowsWallpaper?, syncOpts? })
 *   settings: main/settings.js store (get, applyLook, lookValues)
 *   dir: the shared folder (default: LOOK_SYNC_DIR or %APPDATA%\look-sync; main.js gives --test runs a temp one)
 *   windowsWallpaper: path of Windows' own wallpaper copy (the fallback picture)
 * -> { start(), close(), refresh(), state(), desktopFile(), onLocalChange(before, after), methods }
 */
function createLook(opts) {
  const { settings, emit = () => {}, log = () => {} } = opts;
  const windowsWallpaper = opts.windowsWallpaper !== undefined ? opts.windowsWallpaper
    : (process.env.APPDATA ? path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Themes', 'TranscodedWallpaper') : null);
  const sync = LS.create({
    app: 'helm',
    dir: opts.dir,
    enabled: settings.get().lookSync.enabled !== false,
    local: () => settings.lookValues(),
    ...(opts.syncOpts || {}),
  });
  const stillsDir = path.join(sync.dir, 'stills');
  // opts.mantleOpen overrides MANTLE_OPEN (tests); opts.launch(exe, args) starts it (a --test run only records)
  const mantleOpen = opts.mantleOpen !== undefined ? opts.mantleOpen : MANTLE_OPEN;
  // The default launch waits for Mantle's answer: the second instance exits 0 = opened,
  // 3 = Mantle is not running, 4 = value refused (Mantle look-sync lane, 2026-10-10).
  const launch = opts.launch || ((exe, args, cwd) => new Promise((resolve) => {
    let done = false;
    let err = '';
    let child = null;
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    const timer = setTimeout(() => {
      finish({ ok: false, reason: 'Mantle did not answer within 10 s' });
      try { child && child.kill(); } catch (_) {}
    }, 10000);
    try {
      child = require('child_process').spawn(exe, args, { cwd, windowsHide: true });
    } catch (e) {
      finish({ ok: false, reason: 'Could not start Mantle: ' + e.message });
      return;
    }
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => finish({ ok: false, reason: 'Could not start Mantle: ' + e.message }));
    child.on('exit', (code) => finish(code === 0 ? { ok: true }
      : { ok: false, reason: err.trim() || MANTLE_EXIT[code] || ('Mantle exited with code ' + code) }));
  }));

  let syncState = sync.status();
  let desktop = { source: 'none', ok: false, url: null, rev: null, title: null, type: null, id: null, size: null, reason: 'Not started', file: null, mime: null, guard: null, guardReason: 'Not started', guardLight: null, guardLightReason: 'Not started' };
  let lastSent = null;

  function publicState() {
    const { file, mime, ...d } = desktop;
    return { sync: { enabled: sync.enabled, ...syncState }, desktop: d, dir: sync.dir,
      mantleOpen: mantleOpen && mantleOpen.exe ? { available: true, reason: null } : { available: false, reason: MANTLE_OPEN_REASON } };
  }
  function broadcast() {
    const st = publicState();
    if (same(st, lastSent)) return;
    lastSent = st;
    emit('look.updated', st);
  }

  // Which picture 'desktop' mode shows. Mantle's still first, then the file its record names, then
  // Windows' own wallpaper, each checked on disk; the reason says why a fallback is showing.
  function computeDesktop() {
    const { record: rec, reason } = sync.desktop();
    let why = reason;
    if (rec && rec.ok) {
      if (rec.still && inside(stillsDir, rec.still) && IMAGE_FILE.test(rec.still)) {
        const mime = sniff(rec.still);
        if (mime) return use('mantle', rec.still, mime, rec, null);
        why = `the still Mantle shared is missing or unreadable (${path.basename(rec.still)})`;
      } else if (rec.still) {
        why = `the still Mantle shared is outside its stills folder (${path.basename(rec.still)})`;
      } else why = 'Mantle shared no still';
      if (rec.file && IMAGE_FILE.test(rec.file)) {
        const mime = sniff(rec.file);
        if (mime) return use('mantle', rec.file, mime, rec, null);
      }
    }
    const fallbackReason = `Following Windows' wallpaper: ${why || "Mantle hasn't shared one"}`;   // why: the module's text ("Mantle hasn't…") or ours (lower case)
    if (windowsWallpaper) {
      const mime = sniff(windowsWallpaper);
      if (mime) {
        let v = 0; try { v = Math.round(fs.statSync(windowsWallpaper).mtimeMs); } catch {}
        return { source: 'windows', ok: false, url: `/bg/desktop?v=w${v}`, rev: null, title: "Windows' wallpaper", type: 'picture', id: null, size: null, reason: fallbackReason, file: windowsWallpaper, mime };
      }
    }
    return { source: 'none', ok: false, url: null, rev: null, title: null, type: null, id: null, size: null, reason: `No desktop picture: ${why || "Mantle hasn't shared one"}, and Windows' wallpaper can't be read`, file: null, mime: null };
  }
  function use(source, file, mime, rec, reason) {
    return { source, ok: true, url: `/bg/desktop?v=m${rec.rev}${file === rec.still ? '' : 'f'}`, rev: rec.rev, title: rec.title || null, type: rec.type || null, id: rec.id || null, size: rec.stillSize || null, reason, file, mime };
  }
  function updateDesktop() {
    const next = computeDesktop();
    const rec = sync.desktop().record, gl = settings.get().glass || {}, how = { syncOn: sync.enabled, source: next.source };
    Object.assign(next, checkGuard(rec, gl.dark, how), checkGuardLight(rec, gl.light, how));
    if (!same(next, desktop)) {
      const prev = desktop;
      desktop = next;
      if (next.source !== 'mantle' && next.reason !== prev.reason) log(`look sync desktop: ${next.reason}`);
      if (next.guardReason && next.guardReason !== prev.guardReason) log(`look sync darkening: ${next.guardReason}`);
      if (next.guardLightReason && next.guardLightReason !== prev.guardLightReason) log(`look sync light top band: ${next.guardLightReason}`);
    }
    broadcast();
  }

  sync.on('status', (s) => {
    syncState = s;
    if (s.state !== 'ok' && s.state !== 'off') log(`look sync ${s.state}: ${s.reason || ''}`);
    updateDesktop();
  });
  sync.on('desktop', () => updateDesktop());
  sync.on('apply', (e) => {
    try {
      settings.applyLook(e.changes);
      if (e.changes.glass) updateDesktop();   // the guard's freshness is judged against the synced glass
      log(`look sync applied ${Object.keys(e.changes).join(', ')} from ${e.by || '?'} (rev ${e.rev}, ${e.cause})`);
    } catch (err) { log('look sync apply failed', err); }
  });

  // settings.set from Helm itself (not fromSync): publish what changed; the switch goes to setEnabled.
  function onLocalChange(before, after) {
    const wasOn = before.lookSync.enabled !== false, isOn = after.lookSync.enabled !== false;
    if (!same(before.glass, after.glass)) updateDesktop();   // re-judge the shared darkening against the new glass
    if (wasOn !== isOn) {
      sync.setEnabled(isOn).then(() => updateDesktop()).catch((e) => log('look sync switch', e));
      return; // turning ON adopts the shared values; nothing local to publish
    }
    if (!isOn) return;
    const jobs = [];
    if (before.theme !== after.theme) jobs.push(['theme', after.theme]);
    if (before.accentHue !== after.accentHue) jobs.push(['accent', { hue: after.accentHue }]);
    if (!same(before.glass, after.glass)) jobs.push(['glass', after.glass]);
    for (const [field, value] of jobs) {
      sync.publish(field, value).then((r) => {
        if (!r.ok) log(`look sync publish ${field} failed: ${r.reason}`);
      }).catch((e) => log('look sync publish', e));
    }
  }

  return {
    start() { sync.start(); updateDesktop(); return this; },
    close() { sync.close(); },
    refresh() { sync.refresh(); },
    state: publicState,
    // what /bg/desktop serves: { file, type } or null
    desktopFile() { return desktop.file ? { file: desktop.file, type: desktop.mime } : null; },
    onLocalChange,
    sync,
    methods: {
      'look.get': async () => publicState(),
      // Settings > Appearance "Change it in Mantle's Wallpapers"
      'look.openMantle': async () => {
        if (!mantleOpen || !mantleOpen.exe) throw Object.assign(new Error(MANTLE_OPEN_REASON), { code: 'unsupported' });
        const r = await launch(mantleOpen.exe, mantleOpen.args || [], mantleOpen.cwd);
        if (r && r.ok === false) {
          log('look sync: Mantle wallpapers did not open: ' + r.reason);
          throw Object.assign(new Error(r.reason), { code: 'mantle' });
        }
        log('look sync: opened Mantle wallpapers');
        return { ok: true };
      },
    },
  };
}

module.exports = { createLook, checkGuard, checkGuardLight };
