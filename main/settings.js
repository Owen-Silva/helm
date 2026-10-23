// Settings (PROTOCOL "Settings"): JSON in <userData>/settings.json, backgrounds in
// <userData>/backgrounds (served at /bg/<file>, with ui/assets/backgrounds as the fallback set).
// First run copies the user's Windows wallpaper in and selects it.
// Owner: lane host (B).
const fs = require('fs');
const path = require('path');
const os = require('os');
const { writeFileAtomic, readJson } = require('./atomic');
const LS = require('./look-sync');                     // Look Sync (vendored): SEED + RANGES for the glass values
const { tokens: accentTokensFor } = require('./accent'); // vendored: accent tokens for a shared hue

const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i;
const MAX_BG_BYTES = 15 * 1024 * 1024;

function defaults(home) {
  return {
    // mode 'desktop' = follow the desktop wallpaper (Look Sync), 'own' = the picture in `file`.
    // blur/dim are a legacy mirror of glass.dark (older clients); glass is the real source.
    background: { kind: 'image', mode: 'desktop', file: null, blur: LS.SEED.glass.dark.blurPx, dim: LS.SEED.glass.dark.dim },
    backgrounds: [],
    theme: 'dark',
    // Look Sync (~/look-sync/CONTRACT.md): shared with Quartz and Mantle while lookSync.enabled
    accentHue: null,                      // null = Helm's own accent tokens; 0..360 = tokens from accent.js
    accentTokens: null,                   // derived from accentHue: { dark, light } token sets, or null
    glass: structuredClone(LS.SEED.glass), // { dark|light: { blurPx 0..64, dim .20..90, panel -.30..+.15 }, render }
    lookSync: { enabled: true },
    defaults: { model: 'claude-opus-5-5', effort: 'xhigh', permissionMode: 'bypassPermissions', cwd: home },
    projects: [],
    snippets: [],
    presets: [],                          // launch presets: [{ id, name, cwd, model, effort, permissionMode, prompt? }]
    notifications: { waiting: true, done: true, error: true },
    phone: { enabled: true, url: null },
    launchAtLogin: false,                 // Windows login item -> Helm.exe <project> --hidden (tray)
    quickPromptHotkey: 'Control+Alt+Space', // global hotkey for the quick-prompt box; '' disables
    notifyContextHandoff: true,           // toast when a running subagent first crosses 32% / 40% of its context window
    autoRestart: true,                    // restart Helm by itself once a new commit lands and nothing is running (main/update.js)
    keepSessionsThroughRestart: false,    // lane detach: a Helm restart re-attaches to running sessions instead of stopping them (main/engine/broker.js)
    closeIdleAfterMin: 15,                // close an idle session's claude.exe after this many minutes (0 = never; main/engine/idle-reaper.js)
    prodGuard: true,                      // ask before pushes to protected repos (<userData>/prod-guard.json) and Railway deploys, in every mode (main/engine/prod-guard.js)
  };
}

// Sniff an image by magic bytes -> extension (null if not an image we accept).
function imageExt(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return '.png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return '.webp';
  if (buf.toString('ascii', 0, 4) === 'GIF8') return '.gif';
  return null;
}

const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
// undefined / null / a string of at most max chars
const optStr = (x, max) => x === undefined || x === null || (typeof x === 'string' && x.length <= max);
// a plain file name: no separators, drive colons, wildcards or control characters
const BG_NAME = /^[^\\/:*?"<>|\x00-\x1f]+$/;
const MAX_PRESETS = 20;
const ENUMS = {
  theme: ['dark', 'light', 'system'],
  permissionMode: ['bypassPermissions', 'default', 'acceptEdits', 'plan'],
};

// Look Sync ranges (look-sync.js RANGES): blurPx 0..64, dim .20..90, panel -.30..+.15
const inRange = (v, k) => typeof v === 'number' && Number.isFinite(v) && v >= LS.RANGES[k][0] && v <= LS.RANGES[k][1];
const clampRange = (v, k) => (Number.isFinite(v) ? Math.min(LS.RANGES[k][1], Math.max(LS.RANGES[k][0], v)) : LS.SEED.glass.dark[k]);

function badParams(message) { return Object.assign(new Error(message), { code: 'bad_params' }); }

// ---------- the Anthropic API key (main/account.js, the public Helm's sign-in) ----------
// Kept in <userData>/api-key.json, NOT settings.json: settings.get() goes to every client (desktop and phone)
// and settings.updated is broadcast, so they only ever see { apiKeySet, apiKeyLast4 }. Encrypted with the OS
// (Electron safeStorage: DPAPI on Windows, Keychain on macOS) when main.js passes a secretBox and it is
// available; plain JSON otherwise (mode 0600 off Windows). The key is never logged.
const KEY_FILE = 'api-key.json';
const keyLast4 = (k) => (typeof k === 'string' && k.length >= 12 ? k.slice(-4) : null);

/** secretBox: { available() -> bool, encrypt(string) -> Buffer, decrypt(Buffer) -> string } (optional) */
function createKeyStore({ file, secretBox = null, log = () => {} }) {
  let key = null;
  let error = null;    // why a saved key could not be read (shown in Settings > Account)
  const boxOk = () => { try { return !!(secretBox && secretBox.available()); } catch { return false; } };
  const r = readJson(file);
  if (r.status === 'ok' && isObj(r.value)) {
    const v = r.value;
    if (typeof v.key === 'string' && v.key) key = v.key;
    else if (v.enc === 'os' && typeof v.data === 'string') {
      if (!boxOk()) error = 'The saved API key is encrypted and this PC cannot decrypt it. Enter the key again.';
      else {
        try { key = String(secretBox.decrypt(Buffer.from(v.data, 'base64'))) || null; } catch (e) {
          error = 'The saved API key could not be decrypted on this PC (was the profile copied from another one?). Enter the key again.';
          log('api key: decrypt failed:', e && e.message);
        }
      }
    }
  } else if (r.status === 'corrupt') {
    error = 'The saved API key file was unreadable. Enter the key again.';
    log('api key: api-key.json unreadable', r.movedTo ? `(kept as ${path.basename(r.movedTo)})` : '');
  }

  function write(text) {
    const tmp = `${file}.tmp`;
    try { fs.unlinkSync(tmp); } catch {}
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    for (let i = 0; ; i++) {
      try { fs.renameSync(tmp, file); break; } catch (e) {
        if (i >= 4 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
        const until = Date.now() + 25 * (i + 1);
        while (Date.now() < until) { /* brief sync backoff */ }
      }
    }
    if (process.platform !== 'win32') { try { fs.chmodSync(file, 0o600); } catch {} }
  }

  function set(next) {
    if (next === null) {
      try { fs.unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    } else if (boxOk()) {
      write(JSON.stringify({ v: 1, enc: 'os', data: Buffer.from(secretBox.encrypt(next)).toString('base64') }));
    } else {
      write(JSON.stringify({ v: 1, key: next }));
    }
    key = next;
    error = null;
  }

  return { get: () => key, error: () => error, set, info: () => ({ apiKeySet: !!key, apiKeyLast4: keyLast4(key) }) };
}

/**
 * createSettings({ userDataDir, uiBgDir, emit, appDataDir?, home?, log?, onLocalChange?, secretBox? })
 *   -> { get(), set(partial, { fromSync }?), applyLook(changes), lookValues(), uploadBackground({ name, dataUrl }),
 *        onEngineEvent(event, data), setPhoneUrl(url), getApiKey(), setApiKey(key|null), apiKeyError(), bgDirs, file }
 *   onLocalChange(before, after): every set() that did NOT come from Look Sync (main/look.js publishes it)
 *   secretBox: OS encryption for the API key (main.js: Electron safeStorage); absent = plain JSON
 *   get() adds account: { apiKeySet, apiKeyLast4 } (derived; the key itself never leaves main)
 */
function createSettings(opts) {
  const { userDataDir, uiBgDir, emit = () => {}, log = () => {}, onLocalChange = () => {} } = opts;
  const home = opts.home || os.homedir();
  const appDataDir = opts.appDataDir ?? process.env.APPDATA;
  const file = path.join(userDataDir, 'settings.json');
  const bgDir = path.join(userDataDir, 'backgrounds');
  fs.mkdirSync(bgDir, { recursive: true });
  const keyStore = createKeyStore({ file: path.join(userDataDir, KEY_FILE), secretBox: opts.secretBox || null, log });

  let s = defaults(home);
  let firstRun = true;
  const loaded = readJson(file);
  if (loaded.status === 'ok') { firstRun = false; s = merge(s, isObj(loaded.value) ? loaded.value : {}); migrateLook(isObj(loaded.value) ? loaded.value : {}); }
  else if (loaded.status === 'corrupt') {
    firstRun = false; // the user has used Helm; don't re-import the wallpaper over their choice
    log('settings.json unreadable, using defaults:', loaded.error, loaded.movedTo ? `(kept as ${loaded.movedTo})` : '');
  }
  // a key hand-typed into settings.json moves to api-key.json (settings.json goes to every client)
  if (typeof s.apiKey === 'string' && s.apiKey.trim() && !keyStore.get()) {
    try { keyStore.set(s.apiKey.trim()); log('api key: moved from settings.json to api-key.json'); } catch (e) { log('api key: could not move it out of settings.json:', e.message); }
  }
  delete s.apiKey;
  delete s.account;   // derived in get()

  if (firstRun) {
    const copied = copyWallpaper();
    if (copied) s.background.file = copied;
  }
  if (!Array.isArray(s.presets)) s.presets = []; // a hand-edited settings.json never breaks the dialog
  sanitizeLook();
  derive();
  refreshBackgrounds();
  if (!s.background.file || !s.backgrounds.includes(s.background.file)) s.background.file = s.backgrounds[0] || null;
  save();

  function merge(base, patch) {
    const out = structuredClone(base);
    for (const [k, v] of Object.entries(patch || {})) {
      if (isObj(v) && isObj(out[k])) out[k] = { ...out[k], ...v };
      else out[k] = v;
    }
    return out;
  }

  function copyWallpaper() {
    if (!appDataDir) return null;
    const src = path.join(appDataDir, 'Microsoft', 'Windows', 'Themes', 'TranscodedWallpaper');
    try {
      const buf = fs.readFileSync(src);
      const ext = imageExt(buf);
      if (!ext) { log('wallpaper is not a PNG/JPEG/WebP; skipped'); return null; }
      const name = 'wallpaper' + ext;
      fs.writeFileSync(path.join(bgDir, name), buf);
      return name;
    } catch (e) {
      if (e.code !== 'ENOENT') log('wallpaper copy failed:', e.message);
      return null;
    }
  }

  function listImages(dir) {
    try { return fs.readdirSync(dir).filter((f) => IMAGE_EXT.test(f) && fs.statSync(path.join(dir, f)).isFile()); }
    catch { return []; }
  }

  function refreshBackgrounds() {
    const own = listImages(bgDir);
    const bundled = uiBgDir ? listImages(uiBgDir).filter((f) => !own.includes(f)) : [];
    s.backgrounds = [...own, ...bundled];
  }

  // Look Sync migration (2026-10-10): a settings.json from before it has background.blur/dim and no glass.
  // Both themes start from those values (Helm used one blur/dim for both), clamped into the shared ranges,
  // so Helm looks exactly as before; background.mode defaults to 'desktop' and the picked file stays the own picture.
  function migrateLook(raw) {
    if (isObj(raw.glass)) return;
    const b = isObj(raw.background) ? raw.background : {};
    const g = { blurPx: clampRange(Math.round(Number(b.blur ?? 28)), 'blurPx'), dim: clampRange(Number(b.dim ?? 0.45), 'dim'), panel: 0 };
    s.glass = { dark: { ...g }, light: { ...g }, render: 'picture' };
    log('look sync: migrated background blur/dim', JSON.stringify(g));
  }

  // a hand-edited file never breaks the look: each bad value falls back to the seed
  function sanitizeLook() {
    const seed = LS.SEED.glass;
    const g = isObj(s.glass) ? s.glass : {};
    const theme = (t) => {
      const v = isObj(g[t]) ? g[t] : {};
      const out = {};
      for (const k of Object.keys(LS.RANGES)) out[k] = inRange(v[k], k) ? v[k] : seed[t][k];
      return out;
    };
    s.glass = { dark: theme('dark'), light: theme('light'), render: ['picture', 'seeThrough'].includes(g.render) ? g.render : seed.render };
    if (!(s.accentHue === null || (Number.isInteger(s.accentHue) && s.accentHue >= 0 && s.accentHue <= 360))) s.accentHue = null;
    if (!isObj(s.lookSync) || typeof s.lookSync.enabled !== 'boolean') s.lookSync = { enabled: true };
    if (!['desktop', 'own'].includes(s.background.mode)) s.background.mode = 'desktop';
    if (!ENUMS.theme.includes(s.theme)) s.theme = 'dark';
  }

  // derived fields: accent tokens for the hue, and background.blur/dim mirroring glass.dark for older clients
  function derive() {
    const h = s.accentHue;
    s.accentTokens = h === null || h === undefined ? null : { dark: accentTokensFor(h, 'dark'), light: accentTokensFor(h, 'light') };
    s.background.blur = s.glass.dark.blurPx;
    s.background.dim = s.glass.dark.dim;
  }

  function save() { writeFileAtomic(file, JSON.stringify(s, null, 2)); }

  function changed() { save(); emit('settings.updated', get()); }

  // account: what clients may know about the API key (set or not, last 4), never the key
  function get() { return { ...structuredClone(s), account: keyStore.info() }; }

  function validate(p) {
    if (!isObj(p)) throw badParams('settings.set expects an object');
    if ('apiKey' in p || 'anthropicApiKey' in p) throw badParams('The API key is saved with account.setApiKey, never in settings');
    if ('theme' in p && !ENUMS.theme.includes(p.theme)) throw badParams(`theme must be one of ${ENUMS.theme.join(', ')}`);
    if (p.defaults !== undefined) {
      if (!isObj(p.defaults)) throw badParams('defaults must be an object');
      if (p.defaults.permissionMode !== undefined && !ENUMS.permissionMode.includes(p.defaults.permissionMode)) throw badParams('bad defaults.permissionMode');
      if (p.defaults.cwd !== undefined && p.defaults.cwd !== null && typeof p.defaults.cwd !== 'string') throw badParams('defaults.cwd must be a path');
      for (const k of ['model', 'effort']) if (!optStr(p.defaults[k], 200)) throw badParams(`defaults.${k} must be a short string`);
    }
    if (p.background !== undefined) {
      if (!isObj(p.background)) throw badParams('background must be an object');
      const b = p.background;
      if (b.file !== undefined && b.file !== null && (typeof b.file !== 'string' || path.basename(b.file) !== b.file || !BG_NAME.test(b.file) || /^\.+$/.test(b.file))) throw badParams('background.file must be a file name');
      if (!optStr(b.kind, 20)) throw badParams('background.kind must be a short string');
      if (b.blur !== undefined && !(Number.isFinite(b.blur) && b.blur >= 0 && b.blur <= 200)) throw badParams('background.blur out of range');
      if (b.dim !== undefined && !(Number.isFinite(b.dim) && b.dim >= 0 && b.dim <= 1)) throw badParams('background.dim must be 0..1');
      if (b.mode !== undefined && !['desktop', 'own'].includes(b.mode)) throw badParams('background.mode must be desktop or own');
    }
    // Look Sync keys
    if (p.accentHue !== undefined && !(p.accentHue === null || (Number.isInteger(p.accentHue) && p.accentHue >= 0 && p.accentHue <= 360))) throw badParams('accentHue must be null or a whole number 0..360');
    if (p.glass !== undefined) {
      if (!isObj(p.glass)) throw badParams('glass must be an object');
      for (const k of Object.keys(p.glass)) if (!['dark', 'light', 'render'].includes(k)) throw badParams(`unknown glass key ${k}`);
      for (const t of ['dark', 'light']) {
        if (p.glass[t] === undefined) continue;
        if (!isObj(p.glass[t])) throw badParams(`glass.${t} must be an object`);
        for (const [k, v] of Object.entries(p.glass[t])) {
          if (!LS.RANGES[k]) throw badParams(`unknown glass.${t} key ${k}`);
          if (!inRange(v, k)) throw badParams(`glass.${t}.${k} must be ${LS.RANGES[k][0]}..${LS.RANGES[k][1]}`);
        }
      }
      if (p.glass.render !== undefined && !['picture', 'seeThrough'].includes(p.glass.render)) throw badParams('glass.render must be picture or seeThrough');
    }
    if (p.lookSync !== undefined && (!isObj(p.lookSync) || typeof p.lookSync.enabled !== 'boolean')) throw badParams('lookSync must be { enabled: true|false }');
    for (const k of ['projects', 'snippets']) if (p[k] !== undefined && !Array.isArray(p[k])) throw badParams(`${k} must be an array`);
    if (p.projects) for (const pr of p.projects) {
      if (!isObj(pr) || typeof pr.cwd !== 'string' || !pr.cwd.trim() || pr.cwd.length > 1000) throw badParams('each project needs a cwd');
      if (!optStr(pr.name, 200)) throw badParams('project name must be a short string');
    }
    if (p.snippets) {
      if (p.snippets.length > 1000) throw badParams('too many snippets');
      for (const sn of p.snippets) if (!isObj(sn) || !optStr(sn.id, 200) || !optStr(sn.name, 500) || !optStr(sn.text, 200_000)) throw badParams('each snippet is { id, name, text } strings');
    }
    if (p.presets !== undefined) validatePresets(p.presets);
    for (const k of ['notifications', 'phone']) if (p[k] !== undefined && !isObj(p[k])) throw badParams(`${k} must be an object`);
    if (p.launchAtLogin !== undefined && typeof p.launchAtLogin !== 'boolean') throw badParams('launchAtLogin must be true or false');
    if (p.notifyContextHandoff !== undefined && typeof p.notifyContextHandoff !== 'boolean') throw badParams('notifyContextHandoff must be true or false');
    if (p.autoRestart !== undefined && typeof p.autoRestart !== 'boolean') throw badParams('autoRestart must be true or false');
    if (p.prodGuard !== undefined && typeof p.prodGuard !== 'boolean') throw badParams('prodGuard must be true or false');
    if (p.keepSessionsThroughRestart !== undefined && typeof p.keepSessionsThroughRestart !== 'boolean') throw badParams('keepSessionsThroughRestart must be true or false');
    if (p.closeIdleAfterMin !== undefined && !(Number.isInteger(p.closeIdleAfterMin) && p.closeIdleAfterMin >= 0 && p.closeIdleAfterMin <= 1440)) throw badParams('closeIdleAfterMin must be whole minutes, 0 (never) to 1440');
    if (p.quickPromptHotkey !== undefined && (typeof p.quickPromptHotkey !== 'string' || p.quickPromptHotkey.length > 60 || /[\r\n]/.test(p.quickPromptHotkey))) throw badParams('quickPromptHotkey must be an accelerator like Control+Alt+Space, or empty');
  }

  // Launch presets (New session dialog): the whole list is replaced on every set.
  function validatePresets(list) {
    if (!Array.isArray(list)) throw badParams('presets must be an array');
    if (list.length > MAX_PRESETS) throw badParams(`at most ${MAX_PRESETS} presets`);
    const ids = new Set();
    for (const pr of list) {
      if (!isObj(pr)) throw badParams('each preset is an object');
      if (typeof pr.id !== 'string' || !pr.id || pr.id.length > 64) throw badParams('each preset needs an id');
      if (ids.has(pr.id)) throw badParams('preset ids must be unique');
      ids.add(pr.id);
      if (typeof pr.name !== 'string' || !pr.name.trim() || pr.name.length > 80) throw badParams('preset name must be 1-80 characters');
      if (typeof pr.cwd !== 'string' || !pr.cwd.trim() || pr.cwd.length > 1000) throw badParams('each preset needs a project folder');
      if (!optStr(pr.model, 200)) throw badParams('preset model must be a short string');
      if (!optStr(pr.effort, 40)) throw badParams('preset effort must be a short string');
      if (pr.permissionMode !== undefined && pr.permissionMode !== null && !ENUMS.permissionMode.includes(pr.permissionMode)) throw badParams('bad preset permissionMode');
      if (!optStr(pr.prompt, 20_000)) throw badParams('preset prompt must be at most 20,000 characters');
    }
  }
  // keeps only the known fields, trimmed; an empty prompt is dropped
  const cleanPreset = (pr) => {
    const out = { id: pr.id, name: pr.name.trim(), cwd: pr.cwd.trim() };
    for (const k of ['model', 'effort', 'permissionMode']) if (pr[k]) out[k] = pr[k];
    if (typeof pr.prompt === 'string' && pr.prompt.trim()) out.prompt = pr.prompt;
    return out;
  };

  // set(patch, { fromSync }): fromSync marks a value that came FROM Look Sync; only a local change
  // (fromSync false) reaches onLocalChange, which publishes it (contract section 2, loop prevention 4).
  function set(patch, { fromSync = false } = {}) {
    validate(patch);
    const before = get();
    const p = { ...patch };
    delete p.backgrounds; // derived from disk
    delete p.accentTokens; // derived from accentHue
    delete p.account; // derived from the API key store (a client echoing settings back)
    // glass merges per theme (a slider sends one value); legacy background.blur/dim (older clients) land in
    // glass.dark, clamped into the shared ranges: Helm's one blur/dim is the dark glass (it serves the light
    // theme too: decided 2026-10-10, the light look stays as it is until the user changes it)
    let glass = p.glass ? mergeGlass(s.glass, p.glass) : null;
    // (only a value that differs from the mirror counts: a client echoing the whole background object back
    // must not copy the dark mirror into the light glass)
    const legacyBlur = p.background && p.background.blur !== undefined && p.background.blur !== s.background.blur;
    const legacyDim = p.background && p.background.dim !== undefined && p.background.dim !== s.background.dim;
    if (legacyBlur || legacyDim) {
      const g = { ...(glass || s.glass).dark };
      if (legacyBlur) g.blurPx = clampRange(Math.round(p.background.blur), 'blurPx');
      if (legacyDim) g.dim = clampRange(p.background.dim, 'dim');
      glass = mergeGlass(glass || s.glass, { dark: g });
    }
    delete p.glass;
    // url (and httpUrl, the plain-http fallback while https is live) are computed by the host
    if (p.phone) p.phone = { enabled: p.phone.enabled ?? s.phone.enabled, url: s.phone.url, ...(s.phone.httpUrl ? { httpUrl: s.phone.httpUrl } : {}) };
    if (typeof p.quickPromptHotkey === 'string') p.quickPromptHotkey = p.quickPromptHotkey.trim();
    s = merge(s, p);
    if (p.presets) s.presets = p.presets.map(cleanPreset);
    if (p.projects) s.projects = p.projects.map((pr) => ({ cwd: pr.cwd, name: pr.name || path.basename(pr.cwd) || pr.cwd, pinned: !!pr.pinned }));
    if (glass) s.glass = glass;
    derive();
    changed();
    const after = get();
    if (!fromSync) { try { onLocalChange(before, after); } catch (e) { log('look sync hook', e); } }
    return after;
  }

  function mergeGlass(base, patch) {
    const out = structuredClone(base);
    for (const t of ['dark', 'light']) if (isObj(patch[t])) out[t] = { ...out[t], ...patch[t] };
    if (patch.render !== undefined) out.render = patch.render;
    return out;
  }

  // Look Sync -> Helm: changes = { theme?, accent?: { hue }, glass? }, already validated by look-sync.js.
  // Goes through the normal store with fromSync, so it is saved and broadcast but never published back.
  function applyLook(changes) {
    const patch = {};
    if (changes.theme !== undefined && ENUMS.theme.includes(changes.theme)) patch.theme = changes.theme;
    if (changes.accent && (changes.accent.hue === null || Number.isInteger(changes.accent.hue))) patch.accentHue = changes.accent.hue;
    if (isObj(changes.glass)) patch.glass = { dark: changes.glass.dark, light: changes.glass.light, render: changes.glass.render };
    if (!Object.keys(patch).length) return get();
    return set(patch, { fromSync: true });
  }

  // Helm's look in the shared shape (look-sync.js local())
  function lookValues() {
    return { theme: s.theme, accent: { hue: s.accentHue }, glass: structuredClone(s.glass) };
  }

  function uploadBackground(params) {
    const { name, dataUrl } = params || {};
    const m = /^data:(image\/(png|jpeg|jpg|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl || ''));
    if (!m) throw badParams('background must be a PNG, JPEG, WebP or GIF data URL');
    const approx = Math.floor(m[3].length * 3 / 4);
    if (approx > MAX_BG_BYTES + 4) throw badParams('background is larger than 15 MB');
    const buf = Buffer.from(m[3], 'base64');
    if (buf.length > MAX_BG_BYTES) throw badParams('background is larger than 15 MB');
    const ext = imageExt(buf);
    if (!ext) throw badParams('file content is not a PNG, JPEG, WebP or GIF image');
    let stem = path.basename(String(name || 'background')).replace(/\.[^.]*$/, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+/, '').slice(0, 60) || 'background';
    if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(stem)) stem = 'bg-' + stem; // Windows device names
    let out = stem + ext;
    for (let i = 2; fs.existsSync(path.join(bgDir, out)); i++) out = `${stem}-${i}${ext}`;
    fs.writeFileSync(path.join(bgDir, out), buf);
    refreshBackgrounds();
    s.background = { ...s.background, kind: 'image', file: out };
    changed();
    return get();
  }

  // Sidebar projects follow the sessions the user opens: a new session's cwd joins the list (most recent first).
  function onEngineEvent(event, data) {
    if (event !== 'session.created' || !data || typeof data.cwd !== 'string' || !data.cwd) return;
    addProject(data.cwd);
  }

  function addProject(cwd) {
    const norm = (x) => path.resolve(x).toLowerCase();
    const i = s.projects.findIndex((p) => norm(p.cwd) === norm(cwd));
    if (i === 0) return;
    const entry = i > 0 ? s.projects.splice(i, 1)[0] : { cwd, name: path.basename(cwd) || cwd, pinned: false };
    // pinned projects stay where they are; a new/recent one goes right after them
    const firstUnpinned = s.projects.findIndex((p) => !p.pinned);
    s.projects.splice(firstUnpinned < 0 ? s.projects.length : firstUnpinned, 0, entry);
    s.projects = s.projects.slice(0, 40);
    changed();
  }

  // url: the link the QR shows (https://<MagicDNS name>/... once tailnet HTTPS is live, else plain http);
  // httpUrl: the plain-http fallback, present only while url is the https one.
  function setPhoneUrl(url, httpUrl = null) {
    if (s.phone.url === url && (s.phone.httpUrl || null) === (httpUrl || null)) return;
    const { httpUrl: _old, ...rest } = s.phone;
    s.phone = { ...rest, url, ...(httpUrl ? { httpUrl } : {}) };
    changed();
  }

  // The API key (main/account.js validates it). settings.updated then carries only account.apiKeySet / apiKeyLast4.
  function setApiKey(key) {
    if (key !== null && (typeof key !== 'string' || !key)) throw badParams('key must be a string, or null to clear it');
    const before = keyStore.get();
    keyStore.set(key);
    if (before !== key) emit('settings.updated', get());
  }

  return { get, set, applyLook, lookValues, uploadBackground, onEngineEvent, addProject, setPhoneUrl, getApiKey: () => keyStore.get(), setApiKey, apiKeyError: () => keyStore.error(), bgDirs: [bgDir, uiBgDir].filter(Boolean), file, firstRun };
}

module.exports = { createSettings, imageExt, defaults };
