'use strict';
// Helm's side of the CLI broker (broker.js, lane detach): starts the broker when needed and gives the SDK a
// SpawnedProcess (stdin/stdout/exit/kill) whose other end is a claude.exe owned by the broker.
//
//   const broker = createBrokerClient({ stateDir, execPath, log })
//   broker.spawnProcess({ key, sid, meta }, sdkSpawnOptions, hooks) -> SpawnedProcess   (SDK spawnClaudeCodeProcess)
//   broker.attachProcess(entry, hooks)                               -> SpawnedProcess   (re-attach after a restart)
//   await broker.list()   -> [entry] every CLI of every running broker of this profile, each with entry.broker
//                            { pid, stamp, v, current, draining, job, compatible } ([] when none runs; starts none)
//   await broker.end(entry, why)  stdin EOF, then the tree by PID after 5 s
//   await broker.drainOld()       brokers from an older broker.js take no new CLIs and exit after their last
//   await broker.keepForRestart(procs, ms) -> Set(procs)   the restart intent: each proc's broker keeps it for ms
//                            (single-use; a re-attach consumes it). Only procs in the returned set may detach.
//   await broker.shutdownAll(why)  every broker of this profile ends all its CLIs and exits (Quit)
//   broker.takeStops()    -> [{ at, reason, broker, clis: [{ key, sid, pid, busy, ... }] }] what brokers stopped
//                            because Helm closed (read once: the files are removed)
//   broker.job()          what the launcher found for THIS Helm's broker (broker-launch.js), null before one ran
//   proc.detach()         drop the pipe WITHOUT ending claude.exe (Helm restarting, after keepForRestart);
//                         stdin.end()/kill() go quiet. Without an intent the broker ends the CLI instead.
// hooks: { onPid(pid), onStderr(text), onAttached(info), onReinit({ ok, hooksApplied, subtype, error, ms }) }

const fs = require('fs');
const path = require('path');
const net = require('net');
const { EventEmitter } = require('events');
const { Writable, PassThrough } = require('stream');
const { V, STAMP, STATE_DIR, STOPS_DIR, KEEP_MS, pipeName, stateFile } = require('./broker');
const { launchBroker, jobSafe } = require('./broker-launch');

const BROKER_JS = path.join(__dirname, 'broker.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

class BrokerProcess extends EventEmitter {
  constructor(open, hooks = {}) {
    super();
    this.pid = undefined;
    this.killed = false;
    this.exitCode = null;
    this.signalCode = null;
    this.detached = false;
    this._hooks = hooks;
    this._queue = [];
    this._sock = null;
    this._exited = false;
    const self = this;
    this.stdout = new PassThrough();
    this.stdin = new Writable({
      decodeStrings: false,
      write(chunk, enc, cb) { self._send({ t: 'in', d: String(chunk) }); cb(); },
      final(cb) { if (!self.detached) self._send({ t: 'eof' }); cb(); },
    });
    open().then((sock) => this._bind(sock)).catch((e) => this._fail(e));
  }

  _send(f) {
    if (this.detached) return;
    if (this._sock) { try { this._sock.write(JSON.stringify(f) + '\n'); } catch {} } else this._queue.push(f);
  }

  _bind(sock) {
    if (this.detached || this._exited) { try { sock.end(); } catch {} return; }
    this._sock = sock;
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const l = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!l) continue;
        let f;
        try { f = JSON.parse(l); } catch { continue; }
        this._frame(f);
      }
    });
    sock.on('error', () => {});
    sock.on('close', () => {
      if (this.detached || this._exited) return;
      // the broker went away under a live CLI: as far as the SDK knows, the process ended
      this._exit(null, null, 'the CLI broker closed the connection');
    });
    for (const f of this._queue.splice(0)) sock.write(JSON.stringify(f) + '\n');
  }

  _frame(f) {
    if (f.t === 'out') this.stdout.write(f.d + '\n');
    else if (f.t === 'err') { if (this._hooks.onStderr) this._hooks.onStderr(f.d); }
    else if (f.t === 'spawned' || f.t === 'attached') {
      this.pid = f.pid;
      if (this._hooks.onPid) this._hooks.onPid(f.pid);
      if (f.t === 'attached' && this._hooks.onAttached) this._hooks.onAttached(f);
    } else if (f.t === 'reinit') { if (this._hooks.onReinit) { try { this._hooks.onReinit(f); } catch {} } }
    else if (f.t === 'exit') this._exit(f.code, f.signal, f.error);
    else if (f.t === 'error') this._fail(Object.assign(new Error(f.message || 'broker error'), { code: f.code }));
  }

  _exit(code, signal, why) {
    if (this._exited) return;
    this._exited = true;
    this.exitCode = code == null && !signal ? 1 : code;
    this.signalCode = signal || null;
    if (why && this._hooks.onStderr) this._hooks.onStderr(why);
    try { this.stdout.end(); } catch {}
    if (this._sock) { try { this._sock.end(); } catch {} } // the broker counts open connections before it may exit
    this.emit('exit', this.exitCode, this.signalCode);
  }

  _fail(e) {
    if (this._exited) return;
    this.emit('error', e);
    this._exit(null, null, e.message);
  }

  get exited() { return this._exited; }

  kill() {
    if (this.detached || this._exited) return false;
    this.killed = true;
    this._send({ t: 'kill' });
    return true;
  }

  // Helm is restarting: leave claude.exe running in the broker. After this the SDK may end stdin or kill (its exit
  // handler, the shutdown path): both are no-ops, and no 'exit' is emitted.
  detach() {
    if (this.detached || this._exited || !this._sock) return false;
    try { this._sock.write(JSON.stringify({ t: 'detach' }) + '\n'); this._sock.end(); } catch { return false; }
    this.detached = true;
    return true;
  }
}

function createBrokerClient({ stateDir, execPath = process.execPath, log = () => {}, env = process.env, launch = launchBroker, binDir = null } = {}) {
  const dir = path.join(stateDir, STATE_DIR);
  const myPipe = pipeName(stateDir);
  const readOne = (file) => {
    try {
      const s = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!s || !s.pid || !s.pipe || !s.token || !s.stamp) return null;
      if (!alive(s.pid)) { try { fs.rmSync(file, { force: true }); } catch {} return null; } // a broker that died hard
      return s;
    } catch { return null; }
  };
  const readAll = () => {
    let names = [];
    try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch { return []; }
    return names.map((n) => readOne(path.join(dir, n))).filter(Boolean);
  };
  // this Helm's broker: same protocol, same broker.js, not draining
  const readCurrent = () => { const s = readOne(stateFile(stateDir)); return s && s.v === V && s.stamp === STAMP && s.pipe === myPipe && !s.draining ? s : null; };
  let starting = null;
  let lastJob = null;

  function connect(pipe) {
    return new Promise((res, rej) => {
      const sock = net.connect(pipe);
      sock.once('connect', () => { sock.removeAllListeners('error'); res(sock); });
      sock.once('error', rej);
    });
  }

  // one request, one answer, then the broker closes the connection
  async function ask(st, frame) {
    const sock = await connect(st.pipe);
    sock.write(JSON.stringify({ v: V, token: st.token, ...frame }) + '\n');
    return new Promise((res, rej) => {
      let buf = '';
      const timer = setTimeout(() => { try { sock.destroy(); } catch {} rej(new Error(`the broker (pid ${st.pid}) did not answer ${frame.op}`)); }, 5000);
      sock.setEncoding('utf8');
      sock.on('data', (d) => { buf += d; });
      sock.on('error', (e) => { clearTimeout(timer); rej(e); });
      sock.on('close', () => { clearTimeout(timer); try { res(JSON.parse(buf.split('\n')[0])); } catch (e) { rej(new Error(`the broker (pid ${st.pid}) answered ${frame.op} with nothing usable`)); } });
    });
  }

  async function ensure() {
    const s = readCurrent();
    if (s) { if (!lastJob && s.job) lastJob = s.job; return s; }
    if (starting) return starting;
    starting = (async () => {
      try { fs.mkdirSync(dir, { recursive: true }); } catch {}
      const childEnv = { ...env, ELECTRON_RUN_AS_NODE: '1' };
      const t0 = Date.now();
      const { pid, job } = await launch({ execPath, args: [BROKER_JS, stateDir], env: childEnv, cwd: stateDir, binDir: binDir || path.join(stateDir, 'bin'), log });
      lastJob = job;
      log(jobSafe(job) === false ? 'warn' : 'info', `broker: started pid ${pid} (${job.method}${job.parentInJob ? ', Helm is in a job' : ''}${job.brokeAway ? ', broke away' : ''}${jobSafe(job) === false ? ', broker STILL IN A JOB: sessions will not be kept through restarts' : ''}${job.note && jobSafe(job) !== false ? `; ${job.note}` : ''})`);
      for (const end = Date.now() + 10e3; Date.now() < end; await sleep(100)) {
        const st = readCurrent();
        if (st && st.pid === pid) {
          try { await ask(st, { op: 'setjob', job }); } catch (e) { log('warn', `broker: could not record the job state: ${e.message}`); }
          log('info', `broker: pid ${pid} ready in ${Date.now() - t0} ms`);
          return { ...st, job };
        }
      }
      throw new Error('the CLI broker did not start in 10 s');
    })();
    try { return await starting; } finally { starting = null; }
  }

  async function open(st, first) {
    const sock = await connect(st.pipe);
    sock.write(JSON.stringify({ v: V, token: st.token, ...first }) + '\n');
    return sock;
  }

  return {
    stamp: STAMP,
    v: V,
    running: () => !!readCurrent(),
    job: () => lastJob || ((readCurrent() || {}).job || null),
    // Start a CLI in this Helm's broker. key: unique per spawn; sid: Helm's session id; meta: what the re-attach
    // compatibility check needs later (see keep-compat.js)
    spawnProcess({ key, sid, meta }, o, hooks = {}) {
      let p = null;
      p = new BrokerProcess(async () => { const st = await ensure(); p._st = st; return open(st, { op: 'spawn', key, sid, meta, command: o.command, args: o.args, cwd: o.cwd, env: o.env }); }, hooks);
      p.key = key;
      // the SDK aborts this only after its own stdin-EOF + grace (see SpawnOptions.signal): then end the tree
      if (o.signal) o.signal.addEventListener('abort', () => p.kill(), { once: true });
      return p;
    },
    attachProcess(entry, hooks = {}, o = {}) {
      const st = entry.broker;
      const p = new BrokerProcess(async () => open(st, { op: 'attach', key: entry.key }), hooks);
      p.key = entry.key;
      p._st = st;
      if (o && o.signal) o.signal.addEventListener('abort', () => p.kill(), { once: true });
      return p;
    },
    async list() {
      const out = [];
      for (const st of readAll()) {
        let r;
        try { r = await ask(st, { op: 'list' }); } catch (e) { log('warn', `broker: list from pid ${st.pid} failed: ${e.message}`); continue; }
        if (!r || r.t !== 'list') continue;
        const b = { pid: r.pid, stamp: r.stamp, v: r.v, pipe: st.pipe, token: st.token, draining: !!r.draining, job: r.job || null, startedAt: r.startedAt || null, current: r.v === V && r.stamp === STAMP, compatible: r.v === V };
        for (const c of r.children || []) out.push({ ...c, broker: b });
      }
      return out;
    },
    async end(entry, why) {
      try { return await ask(entry.broker, { op: 'end', key: entry.key, why }); } catch (e) { log('warn', `broker: end ${entry.key} failed: ${e.message}`); return null; }
    },
    // The restart intent (broker.js "keep"): sent just before a restart Helm performs, per broker, naming the CLIs
    // it hands over. Resolves to the procs whose broker confirmed; a proc not in it must not detach (it is closed
    // like any other, and the restart note covers it).
    async keepForRestart(procs, ms = KEEP_MS) {
      const ok = new Set();
      const by = new Map();
      for (const p of procs) {
        if (!p || !p._st || !p.key || p.detached || p.exited) continue;
        const k = p._st.pipe;
        if (!by.has(k)) by.set(k, { st: p._st, procs: [] });
        by.get(k).procs.push(p);
      }
      await Promise.all([...by.values()].map(async ({ st, procs: list }) => {
        try {
          const r = await ask(st, { op: 'keep', keys: list.map((p) => p.key), ms });
          if (!r || r.t !== 'ok') throw new Error(r && r.message ? r.message : 'no answer');
          const got = new Set(r.keys || []);
          for (const p of list) if (got.has(p.key)) ok.add(p);
          log('info', `broker: pid ${st.pid} keeps ${got.size} of ${list.length} CLI(s) for the restart, ${Math.round(((r.until || Date.now()) - Date.now()) / 1000)} s`);
        } catch (e) { log('warn', `broker: restart intent to pid ${st.pid} failed: ${e.message}; its CLIs stop with this Helm`); }
      }));
      return ok;
    },
    // Quit: every broker of this profile ends all its CLIs (stdin EOF, the tree after 5 s) and exits.
    async shutdownAll(why = 'Helm quit') {
      const done = [];
      await Promise.all(readAll().map(async (st) => {
        try { await ask(st, { op: 'shutdown', why }); done.push(st.pid); } catch (e) { log('warn', `broker: shutdown pid ${st.pid} failed: ${e.message}`); }
      }));
      return done;
    },
    // What brokers stopped because Helm closed (broker.js fullStop / a missed restart deadline). Read once.
    takeStops() {
      const sdir = path.join(dir, STOPS_DIR);
      let names = [];
      try { names = fs.readdirSync(sdir).filter((n) => n.endsWith('.json')); } catch { return []; }
      const out = [];
      for (const n of names.sort()) {
        const f = path.join(sdir, n);
        try { const r = JSON.parse(fs.readFileSync(f, 'utf8')); if (r && Array.isArray(r.clis)) out.push(r); } catch {}
        try { fs.rmSync(f, { force: true }); } catch {}
      }
      return out;
    },
    // A broker from an older broker.js: no new CLIs; it exits on its own once its last CLI has ended.
    async drainOld() {
      const drained = [];
      for (const st of readAll()) {
        if (st.stamp === STAMP && st.v === V) continue;
        if (st.draining) continue;
        try { await ask(st, { op: 'drain' }); drained.push(st.pid); log('info', `broker: pid ${st.pid} (broker.js ${st.stamp}, protocol v${st.v}) drains; new CLIs go to a broker for ${STAMP}`); } catch (e) { log('warn', `broker: drain pid ${st.pid} failed: ${e.message}`); }
      }
      return drained;
    },
    // Settings > Helm: what runs now. [{ pid, stamp, v, current, draining, job, clis, attached, orphaned }]
    async status() {
      const by = new Map();
      for (const st of readAll()) by.set(st.pid, { pid: st.pid, stamp: st.stamp, v: st.v, current: st.v === V && st.stamp === STAMP, draining: !!st.draining, job: st.job || null, clis: 0, attached: 0, orphaned: 0 });
      let entries = [];
      try { entries = await this.list(); } catch {}
      for (const e of entries) {
        if (e.exited) continue;
        const b = by.get(e.broker.pid);
        if (!b) continue;
        b.clis++;
        if (e.attached) b.attached++; else b.orphaned++;
      }
      return [...by.values()];
    },
  };
}

module.exports = { createBrokerClient, BrokerProcess };
