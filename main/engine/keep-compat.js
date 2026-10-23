'use strict';
// Before a relaunched Helm re-attaches to a claude.exe the broker kept running (lane detach), it checks that the
// two still fit together. Any miss -> Helm does not attach: it ends that CLI and shows today's restart note with
// the reason and Continue (session.js _keepFailed). Pure, so test/engine/keep-compat.test.js covers it directly.
//
//   keepCompat(entry, session, here) -> null (fine) | reason (one plain sentence fragment)
//     entry   a broker list() row: { key, sid, pid, cwd, meta: { sdk, claudePath, v }, claudeSessionId, cliVersion,
//             exited, ending, eofAt, broker: { v, compatible } }
//     session { id, claudeSessionId, cwd }
//     here    { v, sdkVersion, claudePath, minCliVersion }
// After the attach, the CLI's answer to the repeated initialize is checked too (hooks_applied === true; session.js
// _onReinit); that part needs the live CLI.

const path = require('path');

// The first Claude Code version proven to take a repeated initialize from a re-attached Helm (detach e2e 20/0,
// 2026-10-15, CLI 2.1.295). Older CLIs are not kept: Helm stops them and shows the restart note.
const MIN_CLI_VERSION = '2.1.295';

function cmpVersion(a, b) {
  const pa = String(a).split(/[.+-]/).map((x) => parseInt(x, 10));
  const pb = String(b).split(/[.+-]/).map((x) => parseInt(x, 10));
  for (let i = 0; i < 3; i++) {
    const x = Number.isFinite(pa[i]) ? pa[i] : 0;
    const y = Number.isFinite(pb[i]) ? pb[i] : 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

const normPath = (p) => (p ? path.resolve(String(p)).replace(/[\\/]+$/, '').toLowerCase() : '');
const short = (id) => String(id || '').slice(0, 8);

function keepCompat(entry, session = {}, here = {}) {
  if (!entry) return 'the process that kept it running is gone';
  if (entry.exited) return `Claude Code ended while Helm was away (exit code ${entry.exited.code == null ? 'none' : entry.exited.code}${entry.exited.signal ? `, ${entry.exited.signal}` : ''})`;
  if (entry.ending || entry.eofAt) return 'Claude Code was already closing when Helm came back';
  const b = entry.broker || {};
  if (!b.compatible) return `the process that kept it running speaks broker protocol v${b.v}, this Helm speaks v${here.v}`;
  const meta = entry.meta || {};
  if (meta.sdk && here.sdkVersion && meta.sdk !== here.sdkVersion) return `Helm's Agent SDK changed from ${meta.sdk} to ${here.sdkVersion} across the restart`;
  if (Object.prototype.hasOwnProperty.call(meta, 'claudePath') && normPath(meta.claudePath) !== normPath(here.claudePath)) {
    return `Helm now starts Claude Code from ${here.claudePath || 'the SDK default'}, not ${meta.claudePath || 'the SDK default'}`;
  }
  if (session.claudeSessionId && entry.claudeSessionId && entry.claudeSessionId !== session.claudeSessionId) {
    return `it runs conversation ${short(entry.claudeSessionId)}, but this session is now conversation ${short(session.claudeSessionId)}`;
  }
  if (session.cwd && entry.cwd && normPath(session.cwd) !== normPath(entry.cwd)) return `it runs in ${entry.cwd}, but this session is in ${session.cwd}`;
  if (!entry.cliVersion) return 'Claude Code never reported its version (it had not started a turn)';
  const min = here.minCliVersion || MIN_CLI_VERSION;
  if (cmpVersion(entry.cliVersion, min) < 0) return `Claude Code ${entry.cliVersion} is older than ${min}, the first version known to take a re-attach`;
  return null;
}

// What the CLI said to the repeated initialize (the broker's `reinit` frame) -> null (fine) | reason
function reinitProblem(r) {
  if (!r) return 'Claude Code did not answer the re-attach';
  if (r.subtype && r.subtype !== 'success') return `Claude Code refused the re-attach${r.error ? ` (${r.error})` : ''}`;
  if (r.hooksApplied !== true) return 'Claude Code took the re-attach but did not confirm Helm\'s hooks (hooks_applied was not true)';
  return null;
}

module.exports = { keepCompat, reinitProblem, cmpVersion, MIN_CLI_VERSION };
