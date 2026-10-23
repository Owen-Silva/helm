// End-to-end check of the real Electron host, invisible to the user: starts `electron . --test`
// (hidden window, throwaway profile in %TEMP%, free port, no tray/toasts), connects over the
// WebSocket with the token, runs app.hello / settings / files / queue calls, checks auth is
// enforced, optionally captures the rendered window, then stops the app BY PID (never by name).
// Usage: node tools/host-smoke.js [--capture=.shots/host.png] [--fallback-engine]
// Owner: lane host (B).
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const profile = 'smoke' + process.pid;
const userData = path.join(os.tmpdir(), 'helm-test-' + profile);
const capture = (process.argv.find((a) => a.startsWith('--capture=')) || '').slice(10) || null;
const electronExe = require(path.join(ROOT, 'node_modules', 'electron'));

let failures = 0, passes = 0;
function check(name, ok, detail) {
  if (ok) { passes++; console.log('  ok  ' + name); }
  else { failures++; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')); }
}

function killTree(pid) {
  try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
}

function get(port, p, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, headers }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

function wsOpen(url, opts) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, opts);
    ws.once('open', () => resolve({ ws, open: true }));
    ws.once('unexpected-response', (_req, res) => resolve({ ws, open: false, status: res.statusCode }));
    ws.once('close', (code) => resolve({ ws, open: false, code }));
    ws.once('error', (e) => resolve({ ws, open: false, error: e.message }));
  });
}

function client(ws) {
  let id = 1; const pending = new Map(); const events = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw));
    if (m.type === 'result') { const p = pending.get(m.id); pending.delete(m.id); p && p(m); }
    else events.push(m);
  });
  return {
    events,
    call(method, params = {}) {
      return new Promise((resolve, reject) => {
        const i = id++;
        const t = setTimeout(() => { pending.delete(i); reject(new Error(method + ' timed out')); }, 15000);
        pending.set(i, (m) => { clearTimeout(t); resolve(m); });
        ws.send(JSON.stringify({ id: i, type: 'rpc', method, params }));
      });
    },
  };
}

async function main() {
  const args = ['.', '--test', '--profile=' + profile];
  if (capture) args.push('--capture=' + path.resolve(capture));
  if (process.argv.includes('--fallback-engine')) args.push('--fallback-engine');
  const child = spawn(electronExe, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  console.log(`started electron pid ${child.pid} (profile ${userData})`);
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const deadline = Date.now() + 45000;
  let ready = null;
  try {
    while (!ready && Date.now() < deadline) {
      const m = /HELM_READY (\{.*\})/.exec(out);
      if (m) ready = JSON.parse(m[1]);
      else if (child.exitCode !== null) throw new Error('electron exited early:\n' + out.slice(-2000));
      else await new Promise((r) => setTimeout(r, 250));
    }
    if (!ready) throw new Error('no HELM_READY within 45 s:\n' + out.slice(-2000));
    const { port, token } = ready;
    console.log(`ready on port ${port}, engine ${ready.engine}`);

    // --- HTTP auth ---
    check('GET / without token -> 401', (await get(port, '/')).status === 401);
    check('GET /app.js without token -> 401', (await get(port, '/app.js')).status === 401);
    check('GET / with wrong token -> 401', (await get(port, '/?token=' + 'f'.repeat(64))).status === 401);
    const ok = await get(port, '/?token=' + token);
    check('GET /?token=good -> 200 html + cookie', ok.status === 200 && /<title>Helm/.test(ok.body) && /helm_key=/.test(ok.headers['set-cookie']));
    const pair = await get(port, '/?key=' + token);
    // 200 with the page itself, not a redirect: a 302 dropped the cookie on some phone browsers (pairing loop)
    check('GET /?key= -> 200 html + HttpOnly SameSite=Lax cookie, no-referrer', pair.status === 200 && /<title>Helm/.test(pair.body) && /HttpOnly/.test(pair.headers['set-cookie']) && /SameSite=Lax/.test(pair.headers['set-cookie']) && pair.headers['referrer-policy'] === 'no-referrer');
    const cookie = `helm_key=${token}`;
    check('cookie -> /app.js 200', (await get(port, '/app.js', { cookie })).status === 200);
    check('traversal /..%2f..%2fpackage.json blocked', ![200].includes((await get(port, '/..%2f..%2fpackage.json', { cookie })).status) || false);
    check('/bg/ serves the selected background', (await get(port, '/bg/' + 'nope.png', { cookie })).status === 404);

    // --- WS auth ---
    const origin = `http://127.0.0.1:${port}`;
    const bad = await wsOpen(`ws://127.0.0.1:${port}/ws`, { origin });
    check('WS without token -> closed 4401', !bad.open || (await new Promise((r) => bad.ws.once('close', (c) => r(c)))) === 4401, JSON.stringify({ open: bad.open, code: bad.code, status: bad.status }));
    const evil = await wsOpen(`ws://127.0.0.1:${port}/ws?token=${token}`, { origin: 'http://evil.example' });
    check('WS with foreign Origin -> 403', !evil.open && evil.status === 403, JSON.stringify({ open: evil.open, status: evil.status }));
    const good = await wsOpen(`ws://127.0.0.1:${port}/ws?token=${token}`, { origin });
    check('WS with token + own Origin opens', good.open);
    const viaCookie = await wsOpen(`ws://127.0.0.1:${port}/ws`, { origin, headers: { cookie } });
    check('WS with cookie opens', viaCookie.open);
    if (viaCookie.open) viaCookie.ws.close();
    if (!good.open) throw new Error('cannot continue without a WS');
    const c = client(good.ws);

    // --- RPC ---
    const hello = await c.call('app.hello');
    const h = hello.result || {};
    check('app.hello returns settings/sessions/queue', !!h.settings && Array.isArray(h.sessions) && Array.isArray(h.queue), JSON.stringify(hello.error || {}));
    check('app.hello platform web for a non-window client', h.platform === 'web');
    check('settings defaults', h.settings && h.settings.defaults.model === 'claude-opus-5-5' && h.settings.defaults.effort === 'xhigh' && h.settings.defaults.permissionMode === 'bypassPermissions');
    console.log(`    engine=${h.engine} sessions=${(h.sessions || []).length} background=${h.settings && h.settings.background.file} backgrounds=${JSON.stringify(h.settings && h.settings.backgrounds)}`);
    if (h.settings && h.settings.background.file) check('/bg/<selected> served', (await get(port, '/bg/' + encodeURIComponent(h.settings.background.file), { cookie })).status === 200);
    else console.log('  skip /bg/<selected> served (no background selected: one check fewer)');
    // Look Sync: a fresh profile starts on the shared seed (dark glass blur 5, dim .50); a legacy background.dim
    // lands in the glass of the theme showing and the background mirror follows it
    const set = await c.call('settings.set', { background: { dim: 0.6 } });
    check('settings.set merges + emits settings.updated', set.result && set.result.background.dim === 0.6 && set.result.glass.dark.dim === 0.6 && set.result.background.blur === 5 && set.result.glass.dark.blurPx === 5 && c.events.some((e) => e.event === 'settings.updated'), JSON.stringify(set.result && { background: set.result.background, glass: set.result.glass }));
    const badSet = await c.call('settings.set', { theme: 'neon' });
    check('settings.set rejects bad theme with code', badSet.error && badSet.error.code === 'bad_params');
    const tree = await c.call('files.tree', { cwd: ROOT });
    check('files.tree on repo', Array.isArray(tree.result) && tree.result.some((r) => r.name === 'main' && r.dir) && !tree.result.some((r) => r.name === 'node_modules'));
    const read = await c.call('files.read', { path: path.join(ROOT, 'package.json') });
    check('files.read', read.result && /"name": "helm"/.test(read.result.text));
    const search = await c.call('files.search', { cwd: ROOT, q: 'server' });
    check('files.search finds main/server.js', search.result && search.result.some((r) => r.rel === 'main/server.js'), JSON.stringify((search.result || []).slice(0, 3)));
    const pick = await c.call('files.pickFolder');
    check('files.pickFolder refused for web client', pick.error && pick.error.code === 'unsupported');
    const win = await c.call('app.window', { action: 'minimize' });
    check('app.window refused for web client', win.error && win.error.code === 'unsupported');
    const unknown = await c.call('nope.method');
    check('unknown method -> error, server alive', unknown.error && unknown.error.code === 'unknown_method');
    const usage = await c.call('usage.get');
    check('usage.get routed to engine', !usage.error, JSON.stringify(usage.error));
    const hist = await c.call('history.search', { q: '', limit: 3 });
    check('history.search routed to engine', !hist.error && Array.isArray(hist.result), JSON.stringify(hist.error));
    const qa = await c.call('queue.add', { prompt: 'smoke job', cwd: ROOT, runAfter: Date.now() + 3600e3 });
    check('queue.add', qa.result && qa.result.status === 'queued');
    const qr = await c.call('queue.remove', { id: qa.result && qa.result.id });
    check('queue.remove', !qr.error);
    const ping = await c.call('app.ping');
    check('app.ping', ping.result && ping.result.t > 0);

    // lane quad: 4 corners in the real window. Every corner counts as on screen (sessions.viewing): another
    // client's release of any of them is 'kept'; closing one corner's tab empties that corner (the layout stays)
    // and the window releases only that session, never one still in a corner; a session another screen still
    // shows is kept even when its tab closes here. Sessions are created without a prompt, so no CLI starts.
    const made = [];
    for (let i = 0; i < 5; i++) { const r = await c.call('sessions.create', { cwd: os.tmpdir(), title: `quad ${i}` }); if (r.result) made.push(r.result.id); }
    check('quad: 5 sessions created (no CLI)', made.length === 5, JSON.stringify(made));
    if (made.length === 5) {
      const [qa, qb, qc, qd, qe] = made;
      const PAGE = `const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const [store, st, sp, tabs] = await Promise.all([import('/lib/store.js'), import('/shell/state.js'), import('/shell/split.js'), import('/shell/tabs.js')]);`;
      const setup = await c.call('test.eval', { js: `(async () => { ${PAGE}
        const ids = ${JSON.stringify(made)};
        for (let i = 0; i < 100 && !(store.ready.value && ids.every((id) => store.sessions.value.some((s) => s.id === id))); i++) await sleep(100);
        const wasNarrow = sp.narrow.value; if (wasNarrow) sp.narrow.value = false;   // a hidden test window may be under 1100 px
        for (const id of ids) { st.openSession(id); await sleep(80); }
        st.openSession(ids[0]); await sleep(80);
        sp.setLayout(4); await sleep(800);
        return { layout: sp.layout.value, shown: sp.shownPaneIds.value, wasNarrow, quad: document.querySelectorAll('.quad > .main.pane').length };
      })()` });
      const s0 = setup.result || {};
      check('quad: 4 corners filled from the tabs, active top-left', s0.layout && s0.layout.n === 4 && JSON.stringify(s0.layout.ids) === JSON.stringify([qa, qb, qc, qd]) && s0.quad === 4, JSON.stringify(setup.error || s0));
      const rel = async (id) => ((await c.call('sessions.release', { id })).result || {}).action;
      const kept0 = await Promise.all([qa, qb, qc, qd].map(rel));
      check('quad: sessions.viewing reports all 4 corners (another client\'s release of each is kept)', kept0.every((a) => a === 'kept'), JSON.stringify(kept0));
      check('quad: a tab not in a corner is not on screen', (await rel(qe)) !== 'kept');
      const close1 = await c.call('test.eval', { js: `(async () => { ${PAGE}
        const sent = []; const orig = WebSocket.prototype.send;
        WebSocket.prototype.send = function (d) { try { const m = JSON.parse(d); if (m.method === 'sessions.release' || m.method === 'sessions.viewing') sent.push([m.method, m.params]); } catch {} return orig.call(this, d); };
        try { tabs.closeTabById(${JSON.stringify(qb)}); await sleep(600); } finally { WebSocket.prototype.send = orig; }
        return { layout: sp.layout.value, sent };
      })()` });
      const s1 = close1.result || {};
      const released = (s1.sent || []).filter((x) => x[0] === 'sessions.release').map((x) => x[1].id);
      const lastView = (s1.sent || []).filter((x) => x[0] === 'sessions.viewing').map((x) => x[1].ids).pop();
      check('quad: closing a corner\'s tab empties that corner, the layout stays', s1.layout && s1.layout.n === 4 && s1.layout.ids[1] === null && s1.layout.ids[0] === qa, JSON.stringify(close1.error || s1.layout));
      check('quad: the window released only the closed tab, none still in a corner', JSON.stringify(released) === JSON.stringify([qb]), JSON.stringify(s1.sent));
      check('quad: viewing then reports the 3 corners left', JSON.stringify(lastView) === JSON.stringify([qa, qc, qd]), JSON.stringify(lastView));
      const kept1 = await Promise.all([qa, qc, qd].map(rel));
      check('quad: the 3 corners left are still kept', kept1.every((a) => a === 'kept') && (await rel(qb)) !== 'kept', JSON.stringify(kept1));
      // another screen (this client, like the phone) shows qd; the window closes qd's tab -> Helm keeps it
      await c.call('sessions.viewing', { ids: [qd] });
      const close2 = await c.call('test.eval', { js: `(async () => { ${PAGE}
        tabs.closeTabById(${JSON.stringify(qd)}); await sleep(300);
        const again = await store.rpc('sessions.release', { id: ${JSON.stringify(qd)} });
        return { layout: sp.layout.value, again };
      })()` });
      const s2 = close2.result || {};
      check('quad: a tab closed here but still shown on another screen is kept', s2.again && s2.again.action === 'kept' && s2.layout && s2.layout.ids[3] === null, JSON.stringify(close2.error || s2));
      await c.call('sessions.viewing', { ids: [] });
      await c.call('test.eval', { js: `(async () => { ${PAGE} sp.setLayout(1); return true; })()` });
    }
    good.ws.close();

    if (capture) {
      const capDeadline = Date.now() + 30000;
      while (!/HELM_CAPTURED/.test(out) && Date.now() < capDeadline) await new Promise((r) => setTimeout(r, 300));
      const m = /HELM_CAPTURED (\{.*\})/.exec(out);
      const info = m ? JSON.parse(m[1]) : null;
      check('window captured', info && !info.error && !info.empty && fs.existsSync(info.file), JSON.stringify(info));
      if (info) console.log(`    capture ${info.file} ${info.width}x${info.height}`);
    } else console.log('  skip window captured (no --capture=<png>: 41 checks instead of 42)');
    // the window's own WS client must have connected as 'electron'
    const logTxt = fs.readFileSync(path.join(userData, 'logs', 'main.log'), 'utf8');
    check('window client connected as platform electron', /client open: electron via token from (127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)/.test(logTxt));
    check('no renderer crash in log', !/renderer gone/.test(logTxt));
    check('no rpc internal errors in log', !/rpc .* (failed|threw)/.test(logTxt), (logTxt.match(/rpc .* (failed|threw).*/g) || []).slice(0, 3).join(' | '));
  } finally {
    killTree(child.pid);
    await new Promise((r) => setTimeout(r, 800));
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch {}
  }
  console.log(`\nhost-smoke: ${passes} passed, ${failures} failed`);
  process.exitCode = failures ? 1 : 0;
}

main().catch((e) => { console.error('host-smoke crashed:', e.message); process.exitCode = 2; });
