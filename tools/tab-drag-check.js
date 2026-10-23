require('./lowcpu-optional'); // FIRST: caps CPU + one browser (Electron counts) machine-wide
// Drives REAL tab drags in an isolated `electron . --test --fallback-engine` window (lane tabsmooth, 2026-10-08).
// Input goes through Chromium's pipeline (test.input -> webContents.sendInputEvent): mouseDown, mouseMove in
// small steps, mouseUp, Escape. Mock sessions only (ui/lib/mock-data.js via the fallback engine).
// Checks: the lifted tab follows the pointer 1:1; a neighbour moves once the dragged tab covers half of it (not
// at the far edge), with equal and mixed widths, both directions; the DOM order and localStorage do not change
// until release, then commit once and survive a reload; Esc / blur / pointercancel restore; a plain click still
// activates; a session update and a new tab mid-drag don't break it; auto-scroll at the edge of an overflowing
// strip; the empty strip stays a window drag region. Off-screen, never focused; stopped BY PID; profile deleted.
// Usage: node tools/tab-drag-check.js [--shots=<dir>]   (mid-drag strip captures; default %TEMP%\helm-tabdrag-shots)
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const profile = 'tabdrag' + process.pid;
const userData = path.join(os.tmpdir(), 'helm-test-' + profile);
const SHOTS = (process.argv.find((a) => a.startsWith('--shots=')) || '').slice(8) || path.join(os.tmpdir(), 'helm-tabdrag-shots');
const electronExe = require(path.join(ROOT, 'node_modules', 'electron'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0, passes = 0;
function check(name, ok, detail) {
  if (ok) { passes++; console.log('  ok   ' + name + (detail ? '  (' + detail + ')' : '')); }
  else { failures++; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')); }
}
function killTree(pid) { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} }

function client(ws) {
  let id = 1; const pending = new Map();
  ws.on('message', (raw) => { const m = JSON.parse(String(raw)); if (m.type === 'result') { const p = pending.get(m.id); pending.delete(m.id); p && p(m); } });
  return (method, params = {}) => new Promise((resolve, reject) => {
    const i = id++;
    const t = setTimeout(() => { pending.delete(i); reject(new Error(method + ' timed out')); }, 20000);
    pending.set(i, (m) => { clearTimeout(t); if (m.error) reject(new Error(method + ': ' + (m.error.message || JSON.stringify(m.error)))); else resolve(m.result); });
    ws.send(JSON.stringify({ id: i, type: 'rpc', method, params }));
  });
}

// ---- page probes ----
const SNAP = `(() => {
  const strip = document.querySelector('.tabs-scroll');
  if (!strip) return null;
  const tabs = [...strip.children].filter((t) => t.classList.contains('tab'));
  const num = (t) => (t && t.startsWith('translateX(') ? parseFloat(t.slice(11)) : 0);
  const live = (t) => { const c = getComputedStyle(t).transform; return c && c !== 'none' ? Math.round(new DOMMatrix(c).m41 * 10) / 10 : 0; };
  let store = null; try { store = JSON.parse(localStorage.getItem('helm.tabs')).ids; } catch {}
  const l = strip.querySelector('.tab.lifted');
  return { order: tabs.map((t) => t.dataset.sid), tx: Object.fromEntries(tabs.map((t) => [t.dataset.sid, num(t.style.transform)])),
    live: Object.fromEntries(tabs.map((t) => [t.dataset.sid, live(t)])), lifted: l ? l.dataset.sid : null,
    reordering: strip.classList.contains('reordering'), scroll: strip.scrollLeft, over: strip.scrollWidth - strip.clientWidth, store };
})()`;
const RECTS = `(() => {
  const strip = document.querySelector('.tabs-scroll');
  const sr = strip.getBoundingClientRect();
  return { strip: { l: sr.left, r: sr.right, t: sr.top, b: sr.bottom }, tabs: [...strip.children].filter((t) => t.classList.contains('tab')).map((t) => {
    const r = t.getBoundingClientRect(); return { sid: t.dataset.sid, l: r.left, r: r.right, w: r.width, cy: r.top + r.height / 2 }; }) };
})()`;
const ACTIVE = `import('/lib/store.js').then((m) => m.activeId.value)`;

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const child = spawn(electronExe, ['.', '--test', '--profile=' + profile, '--fallback-engine'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  console.log(`started electron pid ${child.pid} (throwaway profile, off-screen, unfocusable)`);
  let out = '';
  child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
  try {
    let ready = null;
    for (let i = 0; i < 90 && !ready; i++) { await sleep(500); const m = /HELM_READY (\{.*\})/.exec(out); if (m) ready = JSON.parse(m[1]); }
    if (!ready) throw new Error('no HELM_READY within 45 s');
    const { port, token } = ready;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`, { origin: `http://127.0.0.1:${port}` });
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    const rpc = client(ws);
    const evalJs = (js) => rpc('test.eval', { js });
    const input = (events) => rpc('test.input', { events });
    const snap = () => evalJs(SNAP);
    const rects = () => evalJs(RECTS);
    const L = { modifiers: ['leftButtonDown'] };
    const down = (x, y) => input([{ type: 'mouseMove', x, y }, { type: 'mouseDown', x, y, button: 'left', clickCount: 1 }]);
    const move = (x, y, waitMs = 22) => input([{ type: 'mouseMove', x: Math.round(x), y: Math.round(y), ...L, waitMs }]);
    const up = (x, y) => input([{ type: 'mouseUp', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 }]);
    const shot = async (name, R) => {
      const s = R.strip;
      const rect = { x: Math.max(0, Math.floor(s.l) - 10), y: Math.max(0, Math.floor(s.t) - 8), width: Math.ceil(s.r - s.l) + 20, height: Math.ceil(s.b - s.t) + 16 };
      const f = path.join(SHOTS, name + '.png');
      await rpc('test.capture', { file: f, waitMs: 0, rect });
      return f;
    };
    let consoleFrom = (await rpc('test.console', { since: 0 })).next;

    // wait for the UI, then set the tabs and reload
    for (let i = 0; i < 60; i++) { if (await evalJs(`!!document.querySelector('.strip')`).catch(() => false)) break; await sleep(500); }
    const setTabs = async (ids) => {
      await evalJs(`window.__old = 1; localStorage.setItem('helm.tabs', JSON.stringify({ v: 1, ids: ${JSON.stringify(ids)}, active: null })); setTimeout(() => location.reload(), 30); true`);
      await sleep(800);
      let prev = '';   // a tab whose session doesn't exist drops out: wait for the strip to settle
      for (let i = 0; i < 60; i++) { const s = await evalJs(`window.__old ? null : ${SNAP}`).catch(() => null); const k = s ? s.order.join() : ''; if (s && s.order.length && k === prev) return s; prev = k; await sleep(400); }
      throw new Error('tabs did not render: ' + JSON.stringify(ids));
    };
    await evalJs(`addEventListener('pointerdown', (e) => { window.__pid = e.pointerId; }, true); true`);
    const FIVE = ['s_storefront', 's_booking', 's_helm', 's_api', 's_mobile'];
    let s = await setTabs(FIVE);
    await evalJs(`addEventListener('pointerdown', (e) => { window.__pid = e.pointerId; }, true); true`);
    check('5 tabs render from helm.tabs', s.order.join() === FIVE.join(), s.order.join(' '));

    // ---- A: equal widths, drag the first tab right ----
    let R = await rects();
    const pitch = R.tabs[1].l - R.tabs[0].l;
    const t0 = R.tabs[0], y = t0.cy, x0 = t0.l + t0.w / 2;
    const active0 = await evalJs(ACTIVE);
    await down(x0, y);
    const first = {}; let followErr = 0, orderStable = true, storeStable = true, liftedOk = true, midSlide = null, shotA = null;
    for (let dx = 2; dx <= 2 * pitch + 24; dx += 4) {
      await move(x0 + dx, y);
      s = await snap();
      if (dx >= 6) { followErr = Math.max(followErr, Math.abs(s.tx[t0.sid] - dx)); if (s.lifted !== t0.sid || !s.reordering) liftedOk = false; }
      if (s.order.join() !== FIVE.join()) orderStable = false;
      if ((s.store || []).join() !== FIVE.join()) storeStable = false;
      for (const k of FIVE) if (k !== t0.sid && s.tx[k] !== 0 && !(k in first)) {
        first[k] = dx;
        if (k === FIVE[1] && !midSlide) { midSlide = { target: s.tx[k], live: s.live[k] }; shotA = await shot('a-mid-slide', R); const s2 = await snap(); midSlide.liveAfterShot = s2.live[k]; }
      }
    }
    const lastX = x0 + 2 * pitch + 22;
    console.log(`     pitch ${pitch.toFixed(1)} px; neighbour 1 moved at ${first[FIVE[1]]} px, neighbour 2 at ${first[FIVE[2]]} px (old rule: ~${pitch.toFixed(0)} / ~${(2 * pitch).toFixed(0)})`);
    check('A lifted tab follows the pointer 1:1 (transform, x only)', followErr <= 1.01, `max error ${followErr.toFixed(2)} px`);
    check('A .lifted + .reordering while dragging', liftedOk);
    check('A first neighbour slides at ~half a tab of travel, not the far edge', first[FIVE[1]] >= pitch * 0.4 && first[FIVE[1]] <= pitch * 0.6, `${first[FIVE[1]]} px of ${pitch.toFixed(0)}`);
    check('A second neighbour at ~1.5 tabs', first[FIVE[2]] >= pitch * 1.4 && first[FIVE[2]] <= pitch * 1.6, `${first[FIVE[2]]} px`);
    check('A neighbours slide by one pitch (width + gap)', Math.abs((await snap()).tx[FIVE[1]] + pitch) < 1.01);
    check('A neighbour animates (mid-slide when first seen)', midSlide && Math.abs(midSlide.live) < Math.abs(midSlide.target) - 1, midSlide && `live ${midSlide.live} -> target ${midSlide.target}; after the capture ${midSlide.liveAfterShot}`);
    check('A DOM order unchanged during the drag', orderStable);
    check('A localStorage unchanged during the drag', storeStable);
    const shotA2 = await shot('a-lifted', R);
    await up(lastX, y);
    const s30 = await snap();
    await sleep(400);
    s = await snap();
    const wantA = [FIVE[1], FIVE[2], FIVE[0], FIVE[3], FIVE[4]];
    check('A release settles (still lifted right after mouseUp)', s30.lifted === t0.sid, `lifted=${s30.lifted}`);
    check('A order commits on release', s.order.join() === wantA.join(), s.order.join(' '));
    check('A localStorage commits the same order', (s.store || []).join() === wantA.join());
    check('A transforms + classes cleared after landing', Object.values(s.tx).every((v) => v === 0) && Object.values(s.live).every((v) => v === 0) && !s.lifted && !s.reordering);
    check('A a drag is not a click (active tab unchanged)', (await evalJs(ACTIVE)) === active0, `active ${active0}`);

    // ---- B: plain click still activates; a 2 px wobble stays a click ----
    R = await rects();
    const tb = R.tabs[3];
    await down(tb.l + tb.w / 2, tb.cy); await move(tb.l + tb.w / 2 + 2, tb.cy, 10); await up(tb.l + tb.w / 2 + 2, tb.cy);
    await sleep(300);
    check('B plain click activates that tab', (await evalJs(ACTIVE)) === tb.sid, tb.sid);
    check('B order unchanged by a click', (await snap()).order.join() === wantA.join());

    // ---- C: Escape mid-drag restores; the release after it is not a click ----
    R = await rects();
    let order0 = (await snap()).order.join();
    const ta = R.tabs[0];
    const activeC = await evalJs(ACTIVE);
    await down(ta.l + ta.w / 2, ta.cy);
    for (let dx = 4; dx <= pitch * 1.3; dx += 8) await move(ta.l + ta.w / 2 + dx, ta.cy, 18);
    const midC = await snap();
    await input([{ type: 'keyDown', keyCode: 'Escape' }, { type: 'keyUp', keyCode: 'Escape' }]);
    await sleep(350);
    s = await snap();
    check('C a swap had happened before Esc', midC.tx[R.tabs[1].sid] !== 0);
    check('C Esc: everything back, nothing lifted', Object.values(s.tx).every((v) => v === 0) && !s.lifted && !s.reordering);
    await up(ta.l + ta.w / 2 + pitch * 1.3, ta.cy);
    await sleep(300);
    s = await snap();
    check('C Esc: order + localStorage unchanged after the release', s.order.join() === order0 && (s.store || []).join() === order0);
    check('C Esc: the release did not activate a tab', (await evalJs(ACTIVE)) === activeC);

    // ---- D: window blur and pointercancel end the drag cleanly ----
    for (const [label, js] of [['blur', `dispatchEvent(new Event('blur')); true`], ['pointercancel', `dispatchEvent(new PointerEvent('pointercancel', { pointerId: window.__pid })); true`]]) {
      R = await rects(); order0 = (await snap()).order.join();
      const td = R.tabs[1];
      await down(td.l + td.w / 2, td.cy);
      for (let dx = 4; dx <= pitch * 1.3; dx += 8) await move(td.l + td.w / 2 + dx, td.cy, 18);
      const before = await snap();
      await evalJs(js);
      await sleep(350);
      s = await snap();
      await up(td.l + td.w / 2 + pitch * 1.3, td.cy); await sleep(250);
      const after = await snap();
      check(`D ${label} ends the drag: restored, nothing saved`, before.lifted === td.sid && !s.lifted && !s.reordering && Object.values(s.tx).every((v) => v === 0) && after.order.join() === order0 && (after.store || []).join() === order0);
    }

    // ---- E: mixed widths (one tab forced to 330 px), both directions ----
    R = await rects();
    const wide = R.tabs[1].sid;
    await evalJs(`(() => { const st = document.createElement('style'); st.id = '__wide'; st.textContent = '.tab[data-sid="${wide}"] { width: 330px !important; flex: none !important; }'; document.head.appendChild(st); return true; })()`);
    await sleep(150);
    R = await rects();
    const W = R.tabs[1], N = R.tabs[2], gap = N.l - W.r;
    const firstMove = async (tab, dir, other, limit) => {
      await down(tab.l + tab.w / 2, tab.cy);
      let at = null;
      for (let dx = 2; dx <= limit; dx += 2) {
        await move(tab.l + tab.w / 2 + dir * dx, tab.cy, 18);
        const q = await snap();
        if (at == null && q.tx[other] !== 0) at = dx;
      }
      await input([{ type: 'keyDown', keyCode: 'Escape' }, { type: 'keyUp', keyCode: 'Escape' }]);
      await up(tab.l + tab.w / 2 + dir * limit, tab.cy); await sleep(300);
      return at;
    };
    const nLeft = await firstMove(N, -1, W.sid, 220);
    const wRight = await firstMove(W, 1, N.sid, 160);
    const expNL = (W.w + gap) / 2, expWR = (N.w + gap) / 2;   // nearest slot: half of (neighbour + gap)
    console.log(`     wide ${W.w.toFixed(0)} px beside ${N.w.toFixed(0)} px: narrow->left swapped at ${nLeft} px (expect ~${expNL.toFixed(0)}), wide->right at ${wRight} px (expect ~${expWR.toFixed(0)})`);
    check('E narrow tab dragged left past a wide one: swaps when its edge passes the wide tab\'s midpoint', nLeft != null && Math.abs(nLeft - expNL) <= 3);
    check('E wide tab dragged right past a narrow one: swaps at half the narrow tab', wRight != null && Math.abs(wRight - expWR) <= 3);
    await evalJs(`document.getElementById('__wide').remove(); true`);
    await sleep(150);

    // ---- F: a session update and a new tab mid-drag ----
    R = await rects(); order0 = (await snap()).order;
    const tf = R.tabs[0];
    await down(tf.l + tf.w / 2, tf.cy);
    for (let dx = 4; dx <= pitch * 0.8; dx += 8) await move(tf.l + tf.w / 2 + dx, tf.cy, 18);
    await rpc('test.emit', { event: 'session.updated', data: { id: tf.sid, status: 'waiting' } });
    await rpc('test.emit', { event: 'session.updated', data: { id: order0[1], status: 'working' } });
    await evalJs(`import('/lib/store.js').then((m) => { m.selectSession('s_sim'); return true; })`);   // opens a 6th tab mid-drag
    await sleep(250);
    let lastF = 0;
    for (let dx = Math.round(pitch * 0.8); dx <= pitch * 1.3; dx += 8) { await move(tf.l + tf.w / 2 + dx, tf.cy, 18); lastF = dx; }
    s = await snap();
    const RF = await rects();
    const liveCls = await evalJs(`(() => { const t = document.querySelector('.tab[data-sid="${tf.sid}"]'); return t.className; })()`);
    check('F mid-drag re-render keeps the lift (class + transform)', s.lifted === tf.sid && /lifted/.test(liveCls) && /st-waiting/.test(liveCls) && Math.abs(s.tx[tf.sid] - lastF) <= 1.01, `${liveCls.split(" ").join(".")}; tx ${s.tx[tf.sid]} for ${lastF} px`);
    check('F the new tab appeared during the drag', s.order.includes('s_sim') && s.order.length === 6);
    const sPre = s;   // the snapshot that matches RF (taken before release; after it every transform is cleared)
    await up(tf.l + tf.w / 2 + lastF, tf.cy); await sleep(400);
    s = await snap();
    // the order on screen at release: each tab's untransformed left + its target offset, by centre
    const wantF = RF.tabs.map((t) => ({ sid: t.sid, c: t.l - sPre.live[t.sid] + sPre.tx[t.sid] + t.w / 2 })).sort((a, b) => a.c - b.c).map((t) => t.sid);
    check('F the shown order differs from the start (a swap happened)', wantF.join() !== [...order0, 's_sim'].join(), wantF.join(' '));
    check('F commits exactly the order shown at release (new tab included)', s.order.join() === wantF.join() && (s.store || []).join() === wantF.join(), s.order.join(' '));

    // ---- G: reload keeps the committed order ----
    const beforeReload = s.order.join();
    await evalJs(`setTimeout(() => location.reload(), 30); true`);
    await sleep(900);
    for (let i = 0; i < 40; i++) { s = await evalJs(SNAP).catch(() => null); if (s && s.order.length === 6) break; await sleep(300); }
    check('G order persists across a reload', s && s.order.join() === beforeReload, s && s.order.join(' '));
    await evalJs(`addEventListener('pointerdown', (e) => { window.__pid = e.pointerId; }, true); true`);

    // ---- H: auto-scroll an overflowing strip ----
    // only some mock sessions are live ones; make more through the (fallback) engine so the strip overflows
    const made = [];
    for (let i = 0; i < 8; i++) { const c = await rpc('sessions.create', { cwd: os.tmpdir() }).catch((e) => ({ error: e.message })); if (c && c.id) made.push(c.id); await sleep(15); }
    if (made.length < 8) console.log('     sessions.create made ' + made.length);
    const ALL = [...s.order, ...made];
    s = await setTabs(ALL);
    console.log(`     ${s.order.length} tabs, overflow ${s.over} px`);
    if (s.over <= 0) { check('H strip overflows with 12 tabs', false, `over=${s.over}`); }
    else {
      R = await rects();
      const th = R.tabs[0];
      await down(th.l + th.w / 2, th.cy);
      const edgeX = R.strip.r - 12;
      for (let x = th.l + th.w / 2; x < edgeX; x += 24) await move(Math.min(x, edgeX), th.cy, 12);
      await move(edgeX, th.cy, 10);
      await sleep(700);   // hold still at the edge
      const sh = await snap();
      const shotH = await shot('h-autoscroll', R);
      await sleep(900);
      const sh2 = await snap();
      await up(edgeX, th.cy); await sleep(400);
      s = await snap();
      const at = s.order.indexOf(th.sid);
      check('H holding at the edge scrolls the strip', sh.scroll > 0 && sh2.scroll >= sh.scroll, `scrollLeft ${sh.scroll} -> ${sh2.scroll} of ${sh.over}`);
      check('H the dragged tab rides along and lands far right', at >= s.order.length - 3, `index ${at} of ${s.order.length - 1}`);
      check('H committed + saved', (s.store || []).join() === s.order.join() && !s.lifted);
      console.log('     shots: ' + [shotA, shotA2, shotH].filter(Boolean).join('  '));
    }

    // ---- I: reduced motion (JS path): no settle wait ----
    await evalJs(`document.querySelector('.tabs-scroll').scrollLeft = 0; true`);   // H left it scrolled to the end
    await sleep(100);
    R = await rects(); order0 = (await snap()).order;
    await evalJs(`window.__mm = window.matchMedia; window.matchMedia = (q) => (/reduced-motion/.test(q) ? { matches: true } : window.__mm(q)); true`);
    const ti = R.tabs[0];
    await down(ti.l + ti.w / 2, ti.cy);
    for (let dx = 4; dx <= pitch * 0.7; dx += 8) await move(ti.l + ti.w / 2 + dx, ti.cy, 14);
    const im = await snap();
    await up(ti.l + ti.w / 2 + pitch * 0.7, ti.cy);
    const i0 = await snap();
    await evalJs(`window.matchMedia = window.__mm; true`);
    check('I reduced motion: live swap still happens', im.tx[order0[1]] !== 0);
    check('I reduced motion: lands immediately on release', !i0.lifted && i0.order[1] === ti.sid, `lifted=${i0.lifted} order[1]=${i0.order[1]}`);

    // ---- J: the empty strip is still a window drag region ----
    const reg = await evalJs(`(() => { const g = (sel) => { const el = document.querySelector(sel); return el ? getComputedStyle(el).webkitAppRegion || getComputedStyle(el).getPropertyValue('-webkit-app-region') : null; };
      return { strip: g('.strip'), fill: g('.strip-fill'), tabs: g('.tabs'), tab: g('.tab') }; })()`);
    const dr = await rpc('test.dragRegion');
    check('J strip + empty fill = drag, tabs = no-drag (after the drags)', reg.strip === 'drag' && reg.fill === 'drag' && reg.tabs === 'no-drag' && dr.strip === 'drag', JSON.stringify(reg));

    // ---- K (lane quad): a tab dragged DOWN onto a corner shows there (a tab already in one swaps); never a reorder ----
    const k0 = await evalJs(`(async () => { const sp = await import('/shell/split.js'); const st = await import('/shell/state.js');
      st.go('session'); if (sp.narrow.value) sp.narrow.value = false; sp.setLayout(4); await new Promise((r) => setTimeout(r, 800));
      const mid = (el) => { const b = el.getBoundingClientRect(); return { cx: b.left + b.width / 2, cy: b.top + b.height / 2 }; };
      const seen = [...document.querySelectorAll('.tab')].filter((el) => { const p = mid(el); const hit = document.elementFromPoint(p.cx, p.cy); return hit && hit.closest('.tab') === el; }).map((el) => el.dataset.sid);
      return { ids: sp.layout.value.ids, seen, panes: [...document.querySelectorAll('.quad > .main.pane')].map(mid) }; })()`);
    R = await rects();
    const orderK = (await snap()).order.join();
    const vis = (sid) => k0.seen && k0.seen.includes(sid);
    const outside = R.tabs.find((t) => vis(t.sid) && !k0.ids.includes(t.sid));
    const inCorner = R.tabs.find((t) => vis(t.sid) && t.sid === k0.ids[1]);
    const layoutNow = () => evalJs(`import('/shell/split.js').then((m) => m.layout.value)`);
    const dragTo = async (t, p) => {
      const x0 = t.l + t.w / 2;
      await down(x0, t.cy);
      for (let k = 1; k <= 12; k++) await move(x0 + (p.cx - x0) * k / 12, t.cy + (p.cy - t.cy) * k / 12, 24);
      await sleep(150); await up(p.cx, p.cy); await sleep(450);
    };
    if (k0.panes && k0.panes.length === 4 && outside && inCorner) {
      await dragTo(outside, k0.panes[3]);
      const k1 = await layoutNow();
      check('K a tab dragged down onto the bottom-right corner shows there (focused)', k1.n === 4 && k1.ids[3] === outside.sid && k1.focus === 3, JSON.stringify(k1));
      R = await rects();
      await dragTo(R.tabs.find((t) => t.sid === inCorner.sid), k0.panes[0]);
      const k2 = await layoutNow();
      check('K a tab already in a corner swaps with the corner it is dropped on', k2.ids[0] === inCorner.sid && k2.ids[1] === k0.ids[0], JSON.stringify(k2));
      const sK = await snap();
      check('K dropping on a corner never reorders the tabs; nothing stays lifted', sK.order.join() === orderK && !sK.lifted && !sK.reordering, sK.order.join(' '));
    } else check('K 4 corners set up with visible tabs in and out of them', false, JSON.stringify({ k0, outside: !!outside, inCorner: !!inCorner }));
    await evalJs(`import('/shell/split.js').then((m) => { m.setLayout(1); return true; })`);

    const con = await rpc('test.console', { since: consoleFrom });
    const errs = con.entries.filter((e) => e.level === 'error' || e.level === 'crash');
    check('no renderer errors during the run', errs.length === 0, errs.slice(0, 3).map((e) => e.message.slice(0, 160)).join(' | '));
    ws.close();
  } catch (e) {
    failures++;
    console.log('  FAIL run: ' + e.message);
  } finally {
    killTree(child.pid);
    await sleep(500);
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch {}
  }
  console.log(`\ntab-drag-check: ${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}
main();
