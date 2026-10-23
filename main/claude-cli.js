// The installed Claude Code CLI as Helm starts it: which executable, and the environment every claude child gets.
//
// Helm never signs Claude Code in or out. In the default mode its claude children run on whatever the user's own
// Claude Code is signed in with: baseChildEnv() passes the user's environment through and adds or removes no
// auth variable. The only changes are Helm's client tag and the two "nested inside a Claude Code terminal"
// markers (Helm may be launched from one; its children must be fresh top-level sessions). The auth provider
// (main/account.js) adds ANTHROPIC_API_KEY on top only when the user saved an API key in Settings > Account.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const CLIENT_APP = 'helm/0.1.0';
// Session-identity markers of a parent Claude Code terminal. Not auth: nothing that signs Claude Code in.
const NESTED_MARKERS = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT'];

const exeName = () => (process.platform === 'win32' ? 'claude.exe' : 'claude');

// The user's installed Claude Code (HELM_CLAUDE_EXE, else ~/.local/bin/claude[.exe]), or null when there is
// none: then the SDK runs its bundled native binary.
function defaultClaudePath() {
  if (process.env.HELM_CLAUDE_EXE) return process.env.HELM_CLAUDE_EXE;
  const p = path.join(os.homedir(), '.local', 'bin', exeName());
  return fs.existsSync(p) ? p : null;
}

// The SDK's bundled native binary (the one the SDK runs when defaultClaudePath() is null), or null.
function bundledClaudePath() {
  try {
    const pkg = require.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`);
    const p = path.join(path.dirname(pkg), exeName());
    return fs.existsSync(p) ? p : null;
  } catch { return null; }
}

// The executable Helm's sessions actually run: what a status check must ask.
function sessionClaudePath() { return defaultClaudePath() || bundledClaudePath(); }

// env -> a fresh copy for a claude child: the user's environment unchanged (every auth variable included),
// tagged as Helm, not nested. Never logged: it may hold the user's own keys.
function baseChildEnv(env = process.env) {
  const out = { ...env, CLAUDE_AGENT_SDK_CLIENT_APP: CLIENT_APP };
  for (const k of NESTED_MARKERS) delete out[k];
  return out;
}

// baseChildEnv() then the provider's additions (main/account.js childEnv: ANTHROPIC_API_KEY in API-key mode only).
function buildChildEnv(childEnv, env = process.env) {
  const base = baseChildEnv(env);
  if (typeof childEnv !== 'function') return base;
  const out = childEnv(base);
  return out && typeof out === 'object' ? out : base;
}

module.exports = { defaultClaudePath, bundledClaudePath, sessionClaudePath, baseChildEnv, buildChildEnv, NESTED_MARKERS, CLIENT_APP };
