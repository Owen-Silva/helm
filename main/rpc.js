// RPC routing: method name -> handler (PROTOCOL "RPC methods"). Engine methods come from
// main/engine (sessions.*, history.search, usage.get, files.changes); the host adds app.*,
// files.*, queue.*, settings.*. Errors become { message, code } and never crash the server.
// Owner: lane host (B).

const path = require('path');
const { createClaudeConfig, engineSessionReader } = require('./claude-config');
const gitInfo = require('./git');
const { createAccount } = require('./account');

function rpcError(message, code) { return Object.assign(new Error(message), { code }); }

/**
 * createRouter({ engine, files, queue, settings, windowCtl, version, engineKind, testMethods, test, auth })
 *   auth: the auth provider (main/account.js createAccount; main.js makes it before the engine). Absent: one
 *   built here from settings (+ accountOptions: env, claudePath, spawn, ... for tests)
 *   helloExtras: () => fields added to app.hello (main.js: { update })
 *   test: true when main runs with --test; app.hello then says so (the UI keeps first-run sheets quiet)
 *   windowCtl: { minimize, maximize, close, devtools } (Electron window actions) or null
 *   testMethods: extra `test.*` handlers, passed only in --test mode (tools/e2e.js)
 * -> { handle(client, method, params), methods }
 */
function createRouter({ engine, files, queue, settings, windowCtl, version, engineKind = 'real', engineReason = null, logPath = null, hostMethods = null, helloExtras = null, testMethods = null, claudeConfigOptions = null, accountOptions = null, auth = null, emit = () => {}, test = false, log = () => {} }) {
  const host = {
    'app.hello': async (_p, client) => {
      const snap = (await engine.snapshot()) || {};
      return {
        version,
        settings: settings.get(),
        sessions: snap.sessions || [],
        usage: snap.usage ?? null,
        queue: queue.list(),
        platform: client && client.platform === 'electron' ? 'electron' : 'web',
        engine: engineKind,
        // why the stand-in engine runs, and where the log is (the UI shows both in a banner)
        ...(engineKind === 'fallback' ? { engineReason: engineReason || 'The real engine did not load', logPath } : {}),
        // a `--test` run (throwaway profile, random port): the UI skips first-run sheets such as What's new
        ...(test ? { test: true } : {}),
        // how sessions reach Claude (main/account.js): Claude Code's sign-in or the saved API key, and why not ready
        auth: account.public(),
        // more host state for the snapshot (main.js: `update`, the running commit + a pending update)
        ...(helloExtras ? helloExtras() : {}),
      };
    },
    'app.ping': async () => ({ t: Date.now() }),
    'app.window': async (p, client) => {
      if (!client || client.platform !== 'electron' || !windowCtl) throw rpcError('window controls are only for the desktop window', 'unsupported');
      const action = p && p.action;
      const fn = typeof action === 'string' && Object.prototype.hasOwnProperty.call(windowCtl, action) ? windowCtl[action] : null;
      if (typeof fn !== 'function') throw rpcError(`unknown window action: ${p && p.action}`, 'bad_params');
      await fn();
      return {};
    },
    'files.tree': (p) => files.tree(p),
    'files.read': (p) => files.read(p),
    'files.search': (p) => files.search(p),
    'files.diff': (p) => files.diff(p),
    'files.pickFolder': (p, client) => files.pickFolder(p, client),
    // lane git-export: native Save-as for a session exported as Markdown; header git chip (read-only)
    'files.saveText': (p, client) => {
      if (typeof files.saveText !== 'function') throw rpcError('saving a file needs the desktop app', 'unsupported');
      return files.saveText(p, client);
    },
    'git.status': (p) => gitInfo.status(p),
    'activity.summary': require('./activity').rpcHandler({ settings, log }), // lane activity: Active hours (worker-thread scan, lazy)
    'queue.add': (p) => queue.add(p),
    'queue.update': (p) => queue.update(p),
    'queue.remove': (p) => queue.remove(p),
    'settings.get': () => settings.get(),
    'settings.set': (p) => settings.set(p),
    'settings.uploadBackground': (p) => settings.uploadBackground(p),
  };

  // Settings -> Claude Code (main/claude-config.js): CLAUDE.md files + memory notes, allowlisted in main.
  // Backups go to the profile (settings.json's folder); project folders = sidebar projects + session cwds.
  // claudeConfigOptions overrides (claudeDir, profileDir, ...) are for tests.
  const claudeConfig = createClaudeConfig({
    profileDir: settings && settings.file ? path.dirname(settings.file) : null,
    getProjectDirs: async () => {
      const projects = ((settings && typeof settings.get === 'function' && settings.get()) || {}).projects || [];
      // only the cwds: engine.snapshot() also reads the status line folder synchronously (usage), which Settings
      // does not need here (lane helm-settings-freeze: every ms of main-thread work on the Settings open counts)
      const cwds = typeof engine.sessionCwds === 'function' ? engine.sessionCwds() : (((await engine.snapshot()) || {}).sessions || []).map((s) => s && s.cwd);
      return [...projects.map((p) => p && p.cwd), ...(cwds || [])];
    },
    getSession: engineSessionReader(engine),
    log,
    ...(claudeConfigOptions || {}),
  });

  // Settings -> Account (main/account.js): account.status / account.setApiKey, pushing account.changed. Helm
  // never signs Claude Code in or out, so there is no sign-in method. accountOptions overrides are for tests.
  const account = auth || createAccount({ engine, emit, log, settings, ...(accountOptions || {}) });
  const accountMethods = { ...account.methods };

  // Engine methods first, host methods win on a clash (the host owns files.* except files.changes).
  // testMethods (test.* hooks) exist only when main.js runs with --test.
  // hostMethods: more host-side methods from main.js (quick.* for the quick-prompt box).
  // Active hours: the first scan of a month of transcripts takes 10-40 s, so do it in the background a
  // minute after start (worker thread, cached in the profile) instead of on the first Usage open.
  if (!test) { const warm = setTimeout(() => host['activity.summary']({ days: 14, allTime: true }).catch((e) => log('activity prewarm failed:', e && e.message)), 60_000); if (warm.unref) warm.unref(); }
  const methods = { ...(engine.methods || {}), ...host, ...claudeConfig.methods, ...accountMethods, ...(hostMethods || {}), ...(testMethods || {}) };

  async function handle(client, method, params) {
    const fn = Object.prototype.hasOwnProperty.call(methods, method) ? methods[method] : null;
    if (typeof fn !== 'function') throw rpcError(`unknown method: ${method}`, 'unknown_method');
    try {
      return await fn(params || {}, client);
    } catch (e) {
      if (e && e.code && typeof e.code === 'string') throw e;
      log(`rpc ${method} threw:`, e && e.stack ? e.stack : e);
      throw rpcError((e && e.message) || String(e), 'internal');
    }
  }

  return { handle, methods, account };
}

module.exports = { createRouter, rpcError };
