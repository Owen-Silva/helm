// Screenshots of the accuracy lane's UI in mock mode (lane helm-integrate2): the Usage panel with a STALE reading
// (2 h 15 min old) and the cost chart with "unknown" days before the corrected record and a partial day; Home's
// chips dimmed by the stale reading; a session costing $116.56 (cents, not "$117") in the composer and the header
// popover. Native title tooltips can't be screenshotted, so their text is printed and checked instead.
// One headless Chromium, closed at the end. Checks per shot: no page errors, no horizontal overflow, the element.
// Usage: node tools/accuracy-shot.js [outDir=.shots/accuracy] [--channel=chrome]
// Summary line: `accuracy-shot: N shots, M problems`.
'use strict';
// On the user's laptop: cap CPU and hold the machine-wide one-browser lock (absent on a cloud runner).
require('./lowcpu-optional'); // FIRST: optional CPU cap (see tools/lowcpu-optional.js)
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright-core');

const out = path.resolve(process.argv.slice(2).find((a) => !a.startsWith('--')) || '.shots/accuracy');
const channel = (process.argv.find((a) => a.startsWith('--channel=')) || '').slice(10) || undefined;
fs.mkdirSync(out, { recursive: true });
const problems = [];
let shots = 0;
const MIN = 60_000;

// The mock usage.history, rewritten the way the engine reports it when the corrected cost record began 4 days ago
// at 14:05: older days unknown (usd null), that day partial with `since`.
const HISTORY_PATCH = `
  const sinceD = new Date(now); sinceD.setDate(sinceD.getDate() - 4); sinceD.setHours(14, 5, 0, 0);
  const costSince = sinceD.getTime(), sinceKey = dayKey(costSince);
  for (const e of costByDay) {
    if (e.day < sinceKey) { e.usd = null; e.byProject = {}; e.unknown = true; }
    else if (e.day === sinceKey) { e.partial = true; e.since = costSince; }
  }
  return { samples, costByDay, costSince };`;

async function page0(browser, url, w, h) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.route('**/lib/mock-usage-history.js', async (route) => {
    const res = await route.fetch();
    let body = await res.text();
    if (!body.includes('return { samples, costByDay };')) problems.push('mock-usage-history.js: patch point not found');
    body = body.replace('return { samples, costByDay };', HISTORY_PATCH);
    await route.fulfill({ response: res, body });
  });
  await page.goto(url, { waitUntil: 'networkidle' });
  // A stale reading, as engine/usage.js sends it (ageMs + stale), and today's cost counted from 14:05.
  await page.evaluate(async (MIN) => {
    const m = await import('/lib/store.js');
    for (let i = 0; i < 50 && !m.sessions.value.length; i++) await new Promise((ok) => setTimeout(ok, 100));
    const now = Date.now();
    const since = new Date(now); since.setHours(0, 25, 0, 0);
    m.usage.value = { ...m.usage.value, updatedAt: now - 135 * MIN, ageMs: 135 * MIN, stale: true, costTodayUsd: 116.56, costTodaySince: since.getTime(),
      fiveHour: { percent: 99.6, resetsAt: now + 74 * MIN }, week: { percent: 0.4, resetsAt: now + 4 * 24 * 60 * MIN } };
  }, MIN);
  return { page, errors };
}
const overflow = (page) => page.evaluate(() => { const de = document.scrollingElement || document.documentElement; return de.scrollWidth > de.clientWidth; });
function verdict(name, r, errors, need) {
  const bad = [...need.filter(([ok]) => !ok).map(([, what]) => what), r.overflow && 'horizontal overflow', errors.length && `page errors: ${errors.join(' | ').slice(0, 300)}`].filter(Boolean);
  problems.push(...bad.map((x) => `${name}: ${x}`));
  console.log(`${name}: ${JSON.stringify(r)}${bad.length ? ' PROBLEMS ' + bad.join('; ') : ''}`);
}

(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, 'serve-ui.js'), '0'], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
  const url = await new Promise((res, rej) => { srv.stdout.on('data', (d) => { const m = /(http:\/\/\S+)/.exec(String(d)); if (m) res(m[1]); }); setTimeout(() => rej(new Error('serve-ui did not start')), 15000); });
  const browser = await chromium.launch(channel ? { channel } : {});
  try {
    // 1. Usage panel, top: the stale note, the meters' and cards' rounding, today's cost with its "Counted from" note.
    for (const [w, h, sfx] of [[1280, 900, '1280'], [393, 852, '393']]) {
      const { page, errors } = await page0(browser, url, w, h);
      const r = await page.evaluate(async () => {
        const p = await import('/panels/state.js');
        const sh = await import('/shell/state.js');
        const m = await import('/lib/store.js');
        sh.openSession(m.sessions.value[0].id);
        p.showPanel('usage');
        try { (await import('/shell/state.js')).sheetOpen.value = true; } catch {}
        await new Promise((ok) => setTimeout(ok, 900));
        const note = [...document.querySelectorAll('.pn-note-warn')].map((e) => e.innerText).find((t) => /Last reading/.test(t)) || null;
        const meter = document.querySelector('.pn-umeters');
        return { note, meterTip: meter ? meter.title : null, meterStale: document.querySelectorAll('.pn-umeter.stale').length,
          meters: [...document.querySelectorAll('.pn-umeter-val')].map((e) => e.innerText), cardPcts: [...document.querySelectorAll('.pn-us-pct')].map((e) => e.innerText),
          whys: [...document.querySelectorAll('.pn-us-why')].map((e) => e.innerText).filter((t) => /Counted from|Claude Code's own/.test(t)) };
      });
      r.overflow = await overflow(page);
      await page.screenshot({ path: path.join(out, `usage-top-${sfx}.png`) });
      shots++;
      verdict(`usage-top-${sfx}`, r, errors, [[r.note && /Last reading 2h/.test(r.note), 'stale note'], [r.cardPcts.includes('$116.56'), 'cost $116.56'], [!r.cardPcts.includes('100%') && !r.meters.includes('100%'), '99.6% shown as 100%']]);
      // 2. The cost chart: scroll it into view, pick the oldest day (unknown) and the partial day with the arrow keys.
      const plot = page.locator('.pn-uh-bars[aria-label^="Cost per day"]');
      if (await plot.count()) {
        await plot.scrollIntoViewIfNeeded();
        await plot.focus();
        const pick = async (name, n) => {
          for (let i = 0; i < n; i++) await page.keyboard.press('ArrowLeft');
          await page.waitForTimeout(250);
          const card = page.locator('.pn-uh-card').filter({ has: plot });
          const rr = await card.evaluate((el) => ({ head: el.querySelector('.pn-uh-detail-head')?.innerText.replace(/\s+/g, ' '), detail: el.querySelector('.pn-uh-detail')?.innerText.replace(/\s+/g, ' ').slice(0, 220),
            note: [...el.querySelectorAll(':scope > .pn-us-why')].map((e) => e.innerText).join(' | '), totalTip: el.querySelector('.pn-uh-aside')?.title, bars: el.querySelectorAll('.pn-uh-bar').length }));
          rr.overflow = await overflow(page);
          await card.screenshot({ path: path.join(out, `${name}.png`) });
          shots++;
          return rr;
        };
        const part = await pick(`chart-partial-${sfx}`, 4);
        verdict(`chart-partial-${sfx}`, part, errors, [[/From .*corrected cost record/.test(part.detail || ''), 'partial-day note'], [/unknown/.test(part.note), 'unknown note above the chart']]);
        const unk = await pick(`chart-unknown-${sfx}`, 9);
        verdict(`chart-unknown-${sfx}`, unk, errors, [[/unknown/.test(unk.head || ''), 'unknown day head'], [/No reliable record/.test(unk.detail || ''), 'unknown day detail']]);
      } else problems.push(`usage-${sfx}: no cost chart`);
      await page.close();
    }
    // 3. Home: the 5H / Week chips dimmed, with "as of" in their tooltips; the pace chip from the reading's time.
    {
      const { page, errors } = await page0(browser, url, 1280, 800);
      const r = await page.evaluate(async () => {
        (await import('/shell/state.js')).go('home');
        await new Promise((ok) => setTimeout(ok, 700));
        return { chips: [...document.querySelectorAll('.hchip')].map((e) => ({ text: e.innerText.replace(/\s+/g, ' '), stale: e.classList.contains('stale'), title: e.title })) };
      });
      r.overflow = await overflow(page);
      await page.screenshot({ path: path.join(out, 'home-1280.png') });
      shots++;
      const st = r.chips.filter((c) => c.stale);
      verdict('home-1280', r, errors, [[st.length >= 3, 'three dimmed chips (5H, Week, pace)'], [!r.chips.some((c) => /5H 100%|Week 0%/.test(c.text)), '99.6% / 0.4% rounded to 100% / 0%'], [st.every((c) => /as of 2 h 1[45] min ago/.test(c.title)), 'chip tooltips say their age']]);
      await page.close();
    }
    // 4. A session that cost $116.56: the composer meta and the header popover show cents.
    {
      const { page, errors } = await page0(browser, url, 1280, 800);
      const r = await page.evaluate(async () => {
        const m = await import('/lib/store.js');
        const sh = await import('/shell/state.js');
        const s = m.sessions.value.find((x) => x.status === 'idle') || m.sessions.value[0];
        m.sessions.value = m.sessions.value.map((x) => (x.id === s.id ? { ...x, costUsd: 116.56 } : x));
        sh.openSession(s.id);
        await new Promise((ok) => setTimeout(ok, 700));
        const meta = [...document.querySelectorAll('.cmp-bar [title]')].map((e) => e.title).find((t) => /session cost/.test(t)) || null;
        const txt = document.querySelector('.cmp-bar')?.innerText.replace(/\s+/g, ' ') || '';
        return { metaTip: meta, composerShows116: txt.includes('$116.56'), composerShows117: /\$117\b/.test(txt) };
      });
      r.overflow = await overflow(page);
      await page.screenshot({ path: path.join(out, 'session-cost-1280.png') });
      shots++;
      verdict('session-cost-1280', r, errors, [[r.composerShows116 || /\$116\.56/.test(r.metaTip || ''), '$116.56 in the composer'], [!r.composerShows117, 'rounded $117']]);
      await page.close();
    }
  } catch (e) {
    problems.push('threw: ' + e.message);
  } finally {
    await browser.close();
    srv.kill();
    console.log(`accuracy-shot: ${shots} shots, ${problems.length} problems${problems.length ? '\n  ' + problems.join('\n  ') : ''}`);
  }
})();
