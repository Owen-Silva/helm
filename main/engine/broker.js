'use strict';
// Helm CLI broker (lane detach, 2026-10-15; prototype wk/detach-proto, production wk/detach).
//
// A small DETACHED process that owns the claude.exe children and their stdio, so a Helm restart does not kill
// running turns and agents. Helm hands the SDK a SpawnedProcess whose stdin/stdout run over a named pipe to this
// broker (broker-client.js, via the SDK's spawnClaudeCodeProcess option); after a restart the new Helm re-attaches
// to the same claude.exe and the broker replays what it missed. Only used when Settings > Helm "Keep sessions
// running through a restart" is on (or HELM_DETACH=1).
//
//   ELECTRON_RUN_AS_NODE=1 <Helm.exe|electron.exe> broker.js <stateDir>     (plain `node broker.js <stateDir>` too)
//
// Why a broker and not claude.exe spawned detached: claude.exe's protocol is stdin/stdout (stream-json + control
// requests). A pipe has to live in SOME process that outlives Helm; files alone cannot carry the control channel
// (can_use_tool, hook callbacks such as prod-guard) that blocks the CLI until someone answers.
//
// Why it survives: libuv puts every non-detached child into a job object with KILL_ON_JOB_CLOSE, so claude.exe
// spawned by Helm dies with Helm. The broker is started detached, and on Windows through broker-launch.js, which
// breaks it out of any job Helm itself was started in (CREATE_BREAKAWAY_FROM_JOB). Its own claude.exe children sit
// in the BROKER's job and die only with the broker.
//
// Versions: STAMP is a hash of this file. The pipe name and the state file carry protocol V and STAMP, so a Helm
// whose broker.js changed across a restart starts a NEW broker for new CLIs, re-attaches to the old broker's CLIs
// (same V) and tells the old one to drain: it takes no new spawns and exits once its last CLI has ended.
//
// Wire protocol (newline-delimited JSON, one connection per CLI):
//   client first frame: { v, token, op, ... }   (list / drain / end / setjob / shutdown accept any v; spawn and
//   attach need v === V)
//     spawn  { key, sid, command, args, cwd, env, meta }  -> { t: 'spawned', pid }
//     attach { key }                                      -> { t: 'attached', ...info } (or { t: 'error' })
//     list                                                -> { t: 'list', v, stamp, pid, draining, job, children }
//     end    { key, why }                                 -> { t: 'ok' }  (stdin EOF, then the tree by PID after 5 s)
//     keep   { keys, ms }                                 -> { t: 'ok', keys, until }  (the restart intent, below)
//     drain | setjob { job } | shutdown                   -> { t: 'ok' }
//   then client -> broker: { t: 'in', d } (stdin text) | { t: 'eof' } | { t: 'kill' } | { t: 'detach' }
//        broker -> client: { t: 'out', d } (one stdout line) | { t: 'err', d } | { t: 'exit', code, signal }
//                          { t: 'reinit', ok, hooksApplied, pending, error, ms } (re-attach handshake result)
// Re-attach: the new SDK query() sends `initialize` again; the broker forwards it to the CLI, which supports a
// repeated initialize from its stdin owner (SDK 0.3.293 Query.reinitialize: "reattaching to a daemon"): the new
// Helm's hooks replace the old, pending permission requests come back in the response, and a hook call the dead
// Helm never answered is resolved by the CLI (a pending PreToolUse is denied with a retry notice, then retried).
// The broker reports the CLI's answer as a `reinit` frame BEFORE the response line, so Helm can fall back (stop +
// restart note) when hooks were not applied. Then it replays the current turn's lines (no deltas, no control frames).
//
// Only a restart Helm performs keeps a CLI (the user, 2026-10-15: "when i manually close helm everything needs to stop").
// The broker cannot tell a crash from Task Manager's End task, a Windows shutdown or sign-out, or a quit, so:
//   - Restart intent: just before a restart it performs, Helm sends `keep { keys, ms }` naming the CLIs it hands
//     over, then a `detach` frame on each of their pipes. The intent lasts ms (Helm sends KEEP_MS, 60 s; clamped
//     to 1 s..5 min) and is single-use per CLI: a re-attach consumes it.
//   - A CLI pipe that closes with no intent for that CLI is "Helm closed": FULL STOP. Every CLI gets stdin EOF,
//     its tree is killed by PID 5 s later if it still runs, the broker stops listening and exits.
//     (A pipe the old Helm opened before the intent, for a CLI it did not keep, only ends that CLI: a restart is
//     closing it anyway. A CLI whose stdin Helm already ended is just ended, not a full stop.)
//   - Deadline with nothing re-attached: the same full stop. When the new Helm re-attached some CLIs but not
//     others, the unclaimed ones are ended.
//   - A `detach` frame without an intent ends that CLI.
// Every stop is logged with its reason, and the CLIs a full stop or a missed deadline ended are written to
// brokers/stopped/*.json, so the next Helm says "Stopped when Helm closed" in those sessions.
// The broker exits once it has no children and no clients for IDLE_EXIT_MS.

const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const V = 2;
const STAMP = (() => { try { return crypto.createHash('sha1').update(fs.readFileSync(__filename)).digest('hex').slice(0, 10); } catch { return 'unknown'; } })();
const STATE_DIR = 'brokers'; // <userData>/brokers/<stamp>.json, one per running broker
const STOPS_DIR = 'stopped'; // <userData>/brokers/stopped/*.json: CLIs a full stop ended, for the next Helm to report
// How long a restart intent holds the CLIs it names. The old Helm's shutdown takes up to 4 s (main.js), the
// relaunch is a cold Electron start (5-15 s on a slow laptop) and the re-attach pass then attaches every kept CLI
// within a second or two. 60 s covers a slow start several times over, and bounds how long a CLI can run with
// no Helm at all if the relaunch never comes back.
const KEEP_MS = 60e3;
const KEEP_MS_MIN = 1000;
const KEEP_MS_MAX = 5 * 60e3;
const MAX_LINES = 5000;
const MAX_BYTES = 4 * 1024 * 1024; // the current turn only (trimmed at each turn start)

function profileHash(stateDir) {
  return crypto.createHash('sha1').update(path.resolve(stateDir).toLowerCase()).digest('hex').slice(0, 16);
}
function pipeName(stateDir, stamp = STAMP, v = V) {
  const name = `helm-broker-${profileHash(stateDir)}-v${v}-${stamp}`;
  return process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : path.join(require('os').tmpdir(), `${name}.sock`);
}
function stateFile(stateDir, stamp = STAMP) { return path.join(stateDir, STATE_DIR, `${stamp}.json`); }
// Only Claude Code may be started through the broker (any same-user process can reach the pipe once it has the token).
function allowedCommand(cmd) {
  return typeof cmd === 'string' && /^(claude|node|bun)(\.exe)?$/i.test(path.basename(cmd));
}

function main(stateDir) {
  const num = (k, d) => { const v = Number(process.env[k]); return Number.isFinite(v) && v > 0 ? v : d; };
  const IDLE_EXIT_MS = num('HELM_BROKER_IDLE_EXIT_MS', 30e3);
  const SWEEP_MS = num('HELM_BROKER_SWEEP_MS', 5000);
  const logDir = path.join(stateDir, 'logs');
  try { fs.mkdirSync(logDir, { recursive: true }); } catch {}
  try { fs.mkdirSync(path.join(stateDir, STATE_DIR), { recursive: true }); } catch {}
  const logFile = path.join(logDir, 'broker.log');
  const log = (...a) => { try { fs.appendFileSync(logFile, `${new Date().toISOString()} [broker ${process.pid} ${STAMP}] ${a.join(' ')}\n`); } catch {} };
  process.on('uncaughtException', (e) => log('uncaught', e && e.stack || e));
  process.on('unhandledRejection', (e) => log('unhandled', e && e.stack || e));

  const token = crypto.randomBytes(24).toString('hex');
  const pipe = pipeName(stateDir);
  const myState = stateFile(stateDir);
  const children = new Map(); // key -> child record
  const clients = new Set();
  let emptySince = Date.now();
  let draining = false;
  let job = null; // what broker-launch.js found: { method, parentInJob, brokeAway, childInJob, note }
  const startedAt = Date.now();

  const writeState = () => {
    const tmp = `${myState}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify({ v: V, stamp: STAMP, pid: process.pid, pipe, token, startedAt, draining, job }));
      fs.renameSync(tmp, myState);
    } catch (e) { log(`state file not written: ${e.message}`); }
  };
  const removeState = () => { try { const s = JSON.parse(fs.readFileSync(myState, 'utf8')); if (s.pid === process.pid) fs.rmSync(myState, { force: true }); } catch {} };

  const send = (sock, f) => { if (sock && !sock.destroyed) { try { sock.write(JSON.stringify(f) + '\n'); } catch {} } };
  const info = (c) => ({
    key: c.key, sid: c.sid, pid: c.pid, cwd: c.cwd, command: c.command, meta: c.meta, startedAt: c.startedAt,
    attached: !!c.client, detachedAt: c.detachedAt, busy: c.busy, turnStartedAt: c.turnStartedAt, turnEndedAt: c.turnEndedAt,
    lastOutAt: c.lastOutAt, pending: c.pending.size, lines: c.seq, exited: c.exited, ending: c.ending, eofAt: c.eofAt || null,
    claudeSessionId: c.claudeSessionId, cliVersion: c.cliVersion, lastCost: c.lastCost,
  });

  function killTree(c, why) {
    if (!c.pid || c.exited) return;
    log(`kill ${c.key} pid ${c.pid}: ${why}`);
    if (process.platform === 'win32') execFile('taskkill', ['/PID', String(c.pid), '/T', '/F'], { windowsHide: true }, () => {});
    else { try { process.kill(c.pid, 'SIGKILL'); } catch {} }
  }
  function end(c, why) {
    if (c.ending || c.exited) return;
    c.ending = true;
    log(`end ${c.key} pid ${c.pid}: ${why}`);
    try { c.child.stdin.end(); } catch {}
    const t = setTimeout(() => killTree(c, `${why}; still running 5 s after stdin closed`), 5000);
    t.unref();
  }

  // ---- the restart intent and the full stop ----
  let intent = null; // { at, until, keys: Set<key>, timer }
  let stopping = null; // the reason, once a full stop began
  const live = () => [...children.values()].filter((c) => !c.exited);
  const brief = (c) => ({ key: c.key, sid: c.sid, pid: c.pid, busy: c.busy, pending: c.pending.size, startedAt: c.startedAt, turnStartedAt: c.turnStartedAt });

  // what the next Helm reports in each session ("Stopped when Helm closed"); only CLIs Helm did not end itself
  function recordStop(reason, list) {
    const clis = list.filter((c) => !c.eofAt).map(brief);
    if (!clis.length) return;
    const dir = path.join(stateDir, STATE_DIR, STOPS_DIR);
    try {
      fs.mkdirSync(dir, { recursive: true });
      const f = path.join(dir, `${Date.now()}-${process.pid}-${crypto.randomBytes(3).toString('hex')}.json`);
      fs.writeFileSync(`${f}.tmp`, JSON.stringify({ at: Date.now(), reason, broker: process.pid, clis }));
      fs.renameSync(`${f}.tmp`, f);
    } catch (e) { log(`stop record not written: ${e.message}`); }
  }

  // Helm is gone (no restart intent covered the pipe that closed, or nothing re-attached in time): end every CLI
  // and exit. New connections are refused at once (state file removed, pipe closed) so a Helm starting right now
  // starts a fresh broker instead of attaching to this one.
  function fullStop(reason) {
    if (stopping) return;
    stopping = reason;
    if (intent) { clearTimeout(intent.timer); intent = null; }
    const list = live();
    log(`FULL STOP: ${reason}; ending ${list.length} CLI(s)${list.length ? `: ${list.map((c) => `${c.key} pid ${c.pid}${c.busy ? ' (mid-turn)' : ''}`).join(', ')}` : ''}`);
    recordStop(reason, list.filter((c) => !c.ending));
    for (const c of list) end(c, `full stop: ${reason}`);
    removeState();
    try { server.close(); } catch {}
    const t0 = Date.now();
    const iv = setInterval(() => {
      // end() kills a tree 5 s after stdin closed; give taskkill a moment past that
      if (live().length && Date.now() - t0 < 7000) return;
      clearInterval(iv);
      log(`full stop done: ${live().length ? `${live().length} CLI(s) still listed, exiting anyway` : 'every CLI ended'}; exiting`);
      process.exit(0);
    }, 100);
  }

  function setIntent(keys, ms) {
    const now = Date.now();
    const until = Math.max(intent ? intent.until : 0, now + ms);
    if (intent) clearTimeout(intent.timer);
    intent = { at: intent ? intent.at : now, until, keys: new Set([...(intent ? intent.keys : []), ...keys]), timer: null };
    intent.timer = setTimeout(onDeadline, until - now);
    log(`restart intent: keep ${[...intent.keys].join(', ')} for ${Math.round((until - now) / 1000)} s`);
  }

  function consume(c) {
    if (!intent || !intent.keys.delete(c.key)) return;
    log(`restart intent for ${c.key} used: re-attached ${Math.round((Date.now() - intent.at) / 1000)} s after it was sent${intent.keys.size ? `; ${intent.keys.size} still to come` : ''}`);
    if (!intent.keys.size) { clearTimeout(intent.timer); intent = null; }
  }

  function onDeadline() {
    if (!intent) return;
    const secs = Math.round((Date.now() - intent.at) / 1000);
    const left = [...intent.keys].map((k) => children.get(k)).filter((c) => c && !c.exited && !c.client);
    intent = null;
    if (!left.length) return;
    const reason = `no Helm re-attached within ${secs} s of the restart`;
    if (!live().some((c) => c.client)) return fullStop(reason);
    log(`restart deadline: ${left.length} CLI(s) were not re-attached (${left.map((c) => c.key).join(', ')}); ending them`);
    recordStop(reason, left.filter((c) => !c.ending));
    for (const c of left) end(c, reason);
  }

  function markBusy(c) {
    if (c.busy) return;
    c.busy = true;
    c.turnSeq = c.seq + 1; // the turn's first stdout line
    c.turnStartedAt = Date.now();
    // only the current turn is ever replayed: drop the rest
    c.lines = [];
    c.bytes = 0;
  }

  function onOut(c, line) {
    if (!line) return;
    let m = null;
    try { m = JSON.parse(line); } catch {}
    const type = m && m.type;
    if (type === 'control_response' && c.reinit && m.response && m.response.request_id === c.reinit.reqId) {
      const r = m.response.response || {};
      const ok = m.response.subtype === 'success' && r.hooks_applied === true;
      const ms = Date.now() - c.reinit.at;
      const pending = Array.isArray(r.pending_permission_requests) ? r.pending_permission_requests.length : null;
      log(`re-initialize ${c.key}: ${m.response.subtype}${m.response.error ? ` (${m.response.error})` : ''}, hooks_applied ${r.hooks_applied}, pending_permission_requests ${pending == null ? '-' : pending}, ${ms} ms`);
      // the verdict goes out BEFORE the response line: Helm decides keep-or-fall-back before the SDK reacts
      if (c.client) send(c.client, { t: 'reinit', ok, subtype: m.response.subtype || null, hooksApplied: r.hooks_applied === true, pending, error: m.response.error || null, ms });
      c.reinit = null;
    } else if (type === 'control_response' && c.init && !c.init.resp && m.response && m.response.request_id === c.init.reqId) c.init.resp = m.response;
    else if (type === 'control_request' && m.request_id) c.pending.set(m.request_id, line);
    else if (type === 'control_cancel_request' && m.request_id) c.pending.delete(m.request_id);
    else if (type === 'system' && m.subtype === 'init') {
      if (m.session_id) c.claudeSessionId = m.session_id;
      if (m.claude_code_version) c.cliVersion = m.claude_code_version;
    } else if (type === 'result') {
      c.busy = false;
      c.turnEndedAt = Date.now();
      if (typeof m.total_cost_usd === 'number') c.lastCost = m.total_cost_usd;
      if (m.session_id) c.claudeSessionId = m.session_id;
    } else if (type === 'assistant' || type === 'stream_event') markBusy(c); // a turn the CLI started on its own (agent notification)
    c.lines.push({ seq: ++c.seq, line, type });
    c.bytes += line.length;
    while (c.lines.length > MAX_LINES || c.bytes > MAX_BYTES) { const x = c.lines.shift(); c.bytes -= x.line.length; c.trimmedTo = x.seq; }
    c.lastOutAt = Date.now();
    if (c.client && c.clientReady) send(c.client, { t: 'out', d: line });
  }

  // What a re-attaching client missed: the current turn (or the one that ended while nobody was attached), minus
  // stream deltas (the whole message follows) and control frames (pending ones come back through the CLI).
  function replayFor(c) {
    const out = [];
    const turnMissed = c.busy || (c.turnEndedAt && c.detachedAt && c.turnEndedAt >= c.detachedAt);
    if (!turnMissed) return out;
    for (const e of c.lines) {
      if (e.seq < c.turnSeq) continue;
      if (e.type === 'stream_event' || e.type === 'control_request' || e.type === 'control_response' || e.type === 'control_cancel_request') continue;
      out.push(e.line);
    }
    return out;
  }

  function onIn(c, sock, line) {
    if (!line) return;
    let m = null;
    try { m = JSON.parse(line); } catch {}
    if (m && m.type === 'control_request' && m.request && m.request.subtype === 'initialize') {
      if (c.init && c.init.resp) {
        // a re-attached SDK: the CLI takes a repeated initialize from whoever owns its stdin. Forward it, replay.
        c.reinit = { reqId: m.request_id, at: Date.now() };
        try { c.child.stdin.write(line + '\n'); } catch (e) { log(`stdin write ${c.key} failed: ${e.message}`); }
        const replay = replayFor(c);
        for (const l of replay) send(sock, { t: 'out', d: l });
        log(`attach ${c.key}: forwarded initialize to the CLI; replayed ${replay.length} line(s)${c.trimmedTo && c.trimmedTo >= c.turnSeq ? ` (turn trimmed to line ${c.trimmedTo})` : ''}; ${c.pending.size} control request(s) were pending`);
        c.pending.clear(); // the CLI resolves or re-sends them itself on the repeated initialize
        c.clientReady = true;
        return;
      }
      c.init = { reqId: m.request_id, resp: null };
    }
    if (m && m.type === 'control_response' && m.response && m.response.request_id) c.pending.delete(m.response.request_id);
    if (m && m.type === 'user') markBusy(c);
    try { c.child.stdin.write(line + '\n'); } catch (e) { log(`stdin write ${c.key} failed: ${e.message}`); }
  }

  function doSpawn(sock, f) {
    if (stopping) return send(sock, { t: 'error', code: 'draining', message: `this broker is stopping (${stopping})` });
    if (draining) return send(sock, { t: 'error', code: 'draining', message: 'this broker is draining (a newer Helm runs a newer broker)' });
    if (typeof f.key !== 'string' || !f.key) return send(sock, { t: 'error', message: 'spawn needs a key' });
    const prev = children.get(f.key);
    if (prev && !prev.exited) return send(sock, { t: 'error', message: `${f.key} already has a running CLI (pid ${prev.pid})` });
    if (!allowedCommand(f.command)) return send(sock, { t: 'error', message: `refused command ${path.basename(String(f.command))}` });
    let child;
    try {
      child = spawn(f.command, Array.isArray(f.args) ? f.args : [], { cwd: f.cwd, env: f.env || process.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      return send(sock, { t: 'error', message: `spawn failed: ${e.message}` });
    }
    const c = {
      key: f.key, sid: typeof f.sid === 'string' ? f.sid : f.key, child, pid: child.pid, cwd: f.cwd, command: f.command,
      meta: f.meta && typeof f.meta === 'object' ? f.meta : null, startedAt: Date.now(), client: sock, clientReady: true,
      detachedAt: null, busy: false, turnSeq: 1, turnStartedAt: null, turnEndedAt: null, lastOutAt: null, lines: [], bytes: 0,
      seq: 0, trimmedTo: 0, pending: new Map(), init: null, reinit: null, exited: null, ending: false, inBuf: '',
      claudeSessionId: null, cliVersion: null, lastCost: null,
    };
    children.set(f.key, c);
    sock._child = c;
    log(`spawn ${f.key} pid ${child.pid} in ${f.cwd}`);
    let outBuf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => { outBuf += d; let i; while ((i = outBuf.indexOf('\n')) >= 0) { onOut(c, outBuf.slice(0, i)); outBuf = outBuf.slice(i + 1); } });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { if (c.client) send(c.client, { t: 'err', d }); });
    child.stdin.on('error', (e) => log(`stdin ${c.key}: ${e.message}`));
    child.on('error', (e) => { log(`child ${c.key} error: ${e.message}`); if (!c.exited) { c.exited = { code: null, signal: null, error: e.message, at: Date.now() }; if (c.client) send(c.client, { t: 'exit', code: null, signal: null, error: e.message }); } });
    child.on('exit', (code, signal) => {
      if (outBuf) { onOut(c, outBuf); outBuf = ''; }
      c.exited = { code, signal, at: Date.now() };
      log(`exit ${c.key} pid ${c.pid}: code ${code} signal ${signal}${c.client ? '' : ' (no client attached)'}`);
      if (c.client) { send(c.client, { t: 'exit', code, signal }); try { c.client.end(); } catch {} }
      // keep the record a while so a re-attaching Helm learns the CLI ended (and why) instead of guessing
      setTimeout(() => { if (children.get(c.key) === c) children.delete(c.key); }, 10 * 60e3).unref();
    });
    send(sock, { t: 'spawned', pid: child.pid });
  }

  function doAttach(sock, f) {
    const c = children.get(f.key);
    if (!c || c.exited) return send(sock, { t: 'error', code: 'gone', message: c ? `the CLI for ${f.key} exited (code ${c.exited.code})` : `no CLI for ${f.key}` });
    if (c.ending || stopping) return send(sock, { t: 'error', code: 'gone', message: `the CLI for ${f.key} is being ended` });
    if (c.client && c.client !== sock) { log(`attach ${f.key}: replacing the previous client`); send(c.client, { t: 'error', code: 'replaced', message: 'another Helm attached' }); try { c.client.end(); } catch {} }
    c.client = sock;
    c.clientReady = false; // until its initialize is forwarded (onIn); live lines meanwhile are covered by the replay
    sock._child = c;
    consume(c);
    log(`attach ${f.key} pid ${c.pid}: busy ${c.busy}, away ${c.detachedAt ? Math.round((Date.now() - c.detachedAt) / 1000) + ' s' : '-'}, ${c.pending.size} pending`);
    send(sock, { t: 'attached', ...info(c) });
    if (!c.init || !c.init.resp) c.clientReady = true; // attached before the first initialize finished: plain pass-through
  }

  const server = net.createServer((sock) => {
    clients.add(sock);
    sock._at = Date.now(); // a pipe opened before a restart intent belongs to the Helm that is restarting
    sock.setEncoding('utf8');
    let buf = '';
    let authed = false;
    const handle = (line) => {
      let f;
      try { f = JSON.parse(line); } catch { return; }
      if (!authed) {
        if (f.token !== token) { send(sock, { t: 'error', code: 'auth', message: 'bad token' }); sock.end(); return; }
        authed = true;
        if (f.op === 'list') { send(sock, { t: 'list', v: V, stamp: STAMP, pid: process.pid, draining, job, startedAt, children: [...children.values()].map(info) }); sock.end(); return; }
        if (f.op === 'drain') { if (!draining) { draining = true; log('draining: a newer broker takes new CLIs; exiting after the last one here ends'); writeState(); } send(sock, { t: 'ok' }); sock.end(); return; }
        if (f.op === 'setjob') { job = f.job && typeof f.job === 'object' ? f.job : null; log(`job state: ${JSON.stringify(job)}`); writeState(); send(sock, { t: 'ok' }); sock.end(); return; }
        if (f.op === 'end') { const c = children.get(f.key); if (c) end(c, String(f.why || 'Helm asked')); send(sock, { t: 'ok', found: !!c }); sock.end(); return; }
        if (f.op === 'keep') {
          if (stopping) { send(sock, { t: 'error', code: 'gone', message: `this broker is stopping (${stopping})` }); sock.end(); return; }
          const ms = Math.min(KEEP_MS_MAX, Math.max(KEEP_MS_MIN, Number(f.ms) || KEEP_MS));
          const keys = (Array.isArray(f.keys) ? f.keys : []).filter((k) => { const c = typeof k === 'string' && children.get(k); return c && !c.exited && !c.ending; });
          if (keys.length) setIntent(keys, ms);
          send(sock, { t: 'ok', keys, until: intent ? intent.until : null }); sock.end(); return;
        }
        if (f.op === 'shutdown') { log(`shutdown asked${f.why ? `: ${f.why}` : ''}`); if (intent) { clearTimeout(intent.timer); intent = null; } for (const c of children.values()) end(c, 'broker shutdown'); setTimeout(() => { removeState(); process.exit(0); }, 6000).unref(); send(sock, { t: 'ok' }); sock.end(); return; }
        if (f.v !== V) { send(sock, { t: 'error', code: 'version', message: `this broker speaks protocol v${V}, Helm sent v${f.v}` }); sock.end(); return; }
        if (f.op === 'spawn') return doSpawn(sock, f);
        if (f.op === 'attach') return doAttach(sock, f);
        send(sock, { t: 'error', message: `unknown op ${f.op}` });
        sock.end();
        return;
      }
      const c = sock._child;
      if (!c || c.client !== sock) return;
      if (f.t === 'in') {
        c.inBuf += String(f.d || '');
        let i;
        while ((i = c.inBuf.indexOf('\n')) >= 0) { const l = c.inBuf.slice(0, i); c.inBuf = c.inBuf.slice(i + 1); onIn(c, sock, l); }
      } else if (f.t === 'eof') { log(`eof ${c.key} from Helm`); c.eofAt = Date.now(); try { c.child.stdin.end(); } catch {} }
      else if (f.t === 'kill') killTree(c, 'Helm asked');
      else if (f.t === 'detach') {
        c.client = null; c.clientReady = false; c.detachedAt = Date.now(); sock._child = null;
        if (intent && intent.keys.has(c.key)) log(`detach ${c.key} (Helm restarting; turn ${c.busy ? 'running' : 'idle'}; kept ${Math.round((intent.until - Date.now()) / 1000)} s for the new Helm)`);
        else { log(`detach ${c.key} with no restart intent: ending it`); end(c, 'detached with no restart intent'); }
      }
    };
    sock.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l) handle(l); } });
    sock.on('error', () => {});
    sock.on('close', () => {
      clients.delete(sock);
      const c = sock._child;
      if (!c || c.client !== sock) return;
      c.client = null; c.clientReady = false; c.detachedAt = Date.now();
      if (c.exited) return;
      if (c.ending || c.eofAt) { log(`pipe of ${c.key} closed after Helm ended its stdin (pid ${c.pid})`); end(c, 'Helm closed its pipe after ending stdin'); return; }
      if (intent && intent.keys.has(c.key)) { log(`pipe of ${c.key} closed before its detach; kept for the restart (${Math.round((intent.until - Date.now()) / 1000)} s left)`); return; }
      if (intent && sock._at < intent.at) { log(`pipe of ${c.key} closed: the restarting Helm did not keep it`); recordStop('Helm restarted without keeping it', [c]); end(c, 'not kept through the restart'); return; }
      fullStop(`the pipe of ${c.key} (pid ${c.pid}${c.busy ? ', mid-turn' : ''}) closed with no restart intent: Helm closed, crashed or was ended`);
    });
  });

  setInterval(() => {
    const now = Date.now();
    let live = 0;
    for (const c of children.values()) {
      if (c.exited) continue;
      live++;
      // safety net: a CLI with no Helm and no restart intent never lingers (a pipe close stops it before this)
      if (c.client || c.ending || stopping || (intent && intent.keys.has(c.key))) continue;
      if (now - (c.detachedAt || c.startedAt) < 2000) continue; // a spawn or attach in flight
      recordStop('no Helm attached and no restart pending', [c]);
      end(c, 'no Helm attached and no restart intent');
    }
    if (live || clients.size) emptySince = now;
    else if (now - emptySince >= IDLE_EXIT_MS) {
      log(`no CLIs and no clients: exiting${draining ? ' (drained)' : ''}`);
      removeState();
      process.exit(0);
    }
  }, SWEEP_MS);

  server.on('error', (e) => { log(`listen ${pipe} failed: ${e.message}`); process.exit(1); });
  server.listen(pipe, () => {
    writeState();
    log(`listening on ${pipe} (protocol v${V}; CLIs survive only a restart Helm performs; exit when empty ${IDLE_EXIT_MS} ms)`);
  });
}

module.exports = { V, STAMP, STATE_DIR, STOPS_DIR, KEEP_MS, MAX_BYTES, pipeName, stateFile, allowedCommand };
if (require.main === module) {
  const dir = process.argv[2];
  if (!dir) { console.error('usage: broker.js <stateDir>'); process.exit(2); }
  main(path.resolve(dir));
}
