// Screenshots of the restart note UI in mock mode (lane restart): the conversation card at 1280, 393 and 320 wide,
// plus the Settings > Helm confirm ("Restart when finished") and the waiting chip at 1280. One headless Chromium,
// closed at the end. Checks per shot: no page errors, the card is there, no horizontal overflow.
// Usage: node tools/restart-note-shot.js [outDir=.shots/restart-note] [--channel=chrome]
// Summary line: `restart-note-shot: N shots, M problems`.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright-core');

const out = path.resolve(process.argv.slice(2).find((a) => !a.startsWith('--')) || '.shots/restart-note');
const channel = (process.argv.find((a) => a.startsWith('--channel=')) || '').slice(10) || undefined;
fs.mkdirSync(out, { recursive: true });
const AT = Date.now() - 90_000;
const NOTE = {
  at: AT, cause: 'restart', working: true, waiting: false, shells: 0, queued: 1, agentsTotal: 5,
  agents: [
    { id: 't1', agentId: 'a122809973b846dfa', name: 'storefront silent controls fix' },
    { id: 't2', agentId: 'ac51ec66d95c6a86d', name: 'storefront time-zone default before DST' },
    { id: 't3', agentId: 'aa080c972b7b64106', name: 'storefront compare-orders hardening' },
    { id: 't4', agentId: 'ab398935fb00caf85', name: 'Portfolio hero scroll hand-off' },
    { id: 't5', agentId: 'a5e975114e949a590', name: '[lane:apps-backlog] Rank Helm/Mantle/Quartz backlog' },
  ],
  tasks: [{ type: 'local_bash', description: 'Run the before scroll sequence in the cloud' }],
};
const problems = [];
let shots = 0;

(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, 'serve-ui.js'), '0'], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
  const url = await new Promise((res, rej) => { srv.stdout.on('data', (d) => { const m = /(http:\/\/\S+)/.exec(String(d)); if (m) res(m[1]); }); setTimeout(() => rej(new Error('serve-ui did not start')), 15000); });
  const browser = await chromium.launch(channel ? { channel } : {});
  try {
    for (const [w, h, name] of [[1280, 800, 'card-1280'], [393, 852, 'card-393'], [320, 700, 'card-320']]) {
      const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
      await page.goto(url, { waitUntil: 'networkidle' });
      const r = await page.evaluate(async (note) => {
        const m = await import('/lib/store.js');
        const st = await import('/shell/state.js');
        for (let i = 0; i < 50 && !m.sessions.value.length; i++) await new Promise((ok) => setTimeout(ok, 100)); // mock hello
        const s = m.sessions.value.find((x) => x.status === 'idle') || m.sessions.value[0];
        if (!s) return { card: false, sessions: 0 };
        m.sessions.value = m.sessions.value.map((x) => (x.id === s.id ? { ...x, status: 'idle', restartNote: note } : x));
        m.selectSession(s.id);
        st.openSession(s.id);
        await new Promise((ok) => setTimeout(ok, 700));
        const el = document.querySelector('.restart-note');
        if (!el) return { card: false };
        el.scrollIntoView({ block: 'end' });
        await new Promise((ok) => setTimeout(ok, 300));
        const b = el.getBoundingClientRect();
        const de = document.scrollingElement || document.documentElement;
        return { card: true, title: el.querySelector('.rn-title').innerText, rows: el.querySelectorAll('.rn-row').length, box: [Math.round(b.x), Math.round(b.width)], overflow: de.scrollWidth > de.clientWidth || b.right > innerWidth + 1, sub: (document.querySelector('.srow .sub, .srow-sub') || {}).innerText || null };
      }, NOTE);
      await page.screenshot({ path: path.join(out, `${name}.png`) });
      shots++;
      const bad = [!r.card && 'no card', r.overflow && 'horizontal overflow', errors.length && `page errors: ${errors.join(' | ').slice(0, 300)}`].filter(Boolean);
      problems.push(...bad.map((x) => `${name}: ${x}`));
      console.log(`${name}: ${JSON.stringify(r)}${bad.length ? ' PROBLEMS ' + bad.join('; ') : ''}`);
      await page.close();
    }
    // Settings > Helm: the confirm with "Restart when finished", then the waiting chip
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(url, { waitUntil: 'networkidle' });
    const conf = await page.evaluate(async () => {
      const u = await import('/shell/update.js');
      const st = await import('/shell/state.js');
      u.restartConfirm.value = { reasons: ['1 session working', '5 agents running', '1 background task running'] };
      st.go('settings');
      await new Promise((ok) => setTimeout(ok, 700));
      const el = document.getElementById('set-helm');
      if (el) el.scrollIntoView({ block: 'start' });
      await new Promise((ok) => setTimeout(ok, 300));
      return { confirm: !!document.querySelector('.upd-confirm'), buttons: [...document.querySelectorAll('.upd-confirm button')].map((b) => b.innerText.trim()) };
    });
    await page.screenshot({ path: path.join(out, 'confirm-1280.png') });
    shots++;
    console.log(`confirm-1280: ${JSON.stringify(conf)}`);
    if (!conf.confirm || conf.buttons.join('|') !== 'Cancel|Restart now|Restart when finished') problems.push('confirm-1280: buttons ' + conf.buttons.join('|'));
    const chip = await page.evaluate(async () => {
      const m = await import('/lib/store.js');
      const u = await import('/shell/update.js');
      u.restartConfirm.value = null;
      m.updateState.value = { ...(m.updateState.value || {}), running: { sha: 'x', short: '5a94378', subject: 'Merge wk/tests' }, pending: null,
        deferred: { at: Date.now(), by: 'desktop', phase: 'waiting', reasons: ['5 agents running', '1 background task running'], reason: 'waiting: 5 agents running · 1 background task running' } };
      await new Promise((ok) => setTimeout(ok, 400));
      const c = document.querySelector('.upd-chip');
      return { chip: c ? c.innerText.replace(/\s+/g, ' ').trim() : null, row: (document.querySelector('#set-helm') ? document.body.innerText.match(/Restarts when finished[^\n]*/) || [] : [])[0] || null };
    });
    await page.screenshot({ path: path.join(out, 'waiting-1280.png') });
    shots++;
    console.log(`waiting-1280: ${JSON.stringify(chip)}`);
    if (!chip.chip || !/Restarts when finished/.test(chip.chip)) problems.push('waiting-1280: no chip');
    if (errors.length) problems.push('settings page errors: ' + errors.join(' | ').slice(0, 300));
  } catch (e) {
    problems.push('threw: ' + e.message);
  } finally {
    await browser.close();
    srv.kill();
    console.log(`restart-note-shot: ${shots} shots, ${problems.length} problems${problems.length ? '\n  ' + problems.join('\n  ') : ''}`);
  }
})();
