// Overlap detector (lane helm-overlap, 2026-10-15). Renders every Helm screen and state on the mock backend
// (tools/serve-ui.js + ui/lib/mock-data.js) in headless Chromium, forces :hover and :focus-visible on each
// control through CDP (CSS.forcePseudoState), and reports:
//   overlap        two control boxes intersect, or a control sits on loose text
//   hit-overlap    two hit areas (box + ::before/::after extension) intersect
//   ring           a hover highlight / focus ring / outline reaches into a neighbour or loose text
//   clipped-ring   a focus ring cut off by an overflow ancestor
//   text-collide   two text runs on top of each other
//   text-clip      text cut by an overflow:hidden box with no ellipsis / line-clamp
//   text-spill     text sticking out of the box it is drawn in
//   outside        a control sticking out of the box it is drawn in
//   page-overflow  the page is wider than the window
//   small-target   under 24x24 px with a neighbour inside its 24 px circle (WCAG 2.2 SC 2.5.8)
//   hover-shift    a control moves or resizes on hover / focus
//   no-focus-style keyboard focus changes nothing visible (a text field's wrapper :focus-within counts)
//   no-hover-style a button that does not react to hover (desktop; selected / pressed ones excepted)
// at 1280 (desktop) and 393 / 320 (phone, touch). Rules live in tools/overlap-core.js (unit-tested in
// test/host/overlap-audit.test.js); known, reasoned exceptions in test/overlap-allow.json.
//
// Usage: node tools/overlap-audit.js [--widths=1280,393,320] [--only=chat,settings] [--out=<dir>] [--shots]
//          [--json=<file>] [--allow=<file>] [--list] [--zoom] [--ui=<another ui/ dir>] [--theme=light|dark]
//   Prints one line per finding, then `overlap-audit: N screens, C controls, F findings (A allowed), X new, S setup failures`;
//   exit 1 when anything is new or a screen did not open. --shots saves a screenshot per screen with findings outlined (red = the
//   control, orange dashed = what it hits). --zoom saves 3x crops of the message action row in each state.
//   HELM_SHOT_CHANNEL=chrome uses the installed Chrome.
try { require('./lowcpu-optional'); } catch { /* not on this machine: cloud runner */ }
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');
const core = require('./overlap-core');
const { install } = require('./overlap-measure');

const arg = (k, d = null) => { const a = process.argv.find((x) => x.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
const flag = (k) => process.argv.includes('--' + k);
const WIDTHS = arg('widths', '1280,393,320').split(',').map(Number);
const ONLY = arg('only') ? arg('only').split(',') : null;
const OUT = path.resolve(arg('out', path.join(__dirname, '..', '.shots', 'overlap')));
const ALLOW = path.resolve(arg('allow', path.join(__dirname, '..', 'test', 'overlap-allow.json')));
const SHOTS = flag('shots'), ZOOM = flag('zoom');
const THEME = arg('theme');   // the mock's settings say dark; --theme=light audits the light look
const HEIGHT = { 1280: 860, 393: 852, 320: 640 };

// Freeze motion so a forced state is measured where it ends, not mid-transition.
const FREEZE = '*, *::before, *::after { transition-duration: 0s !important; transition-delay: 0s !important; animation-duration: 0s !important; animation-delay: 0s !important; animation-iteration-count: 1 !important; caret-color: transparent !important; }';

// ---- screens and states. `setup` runs in the page (ESM imports from the ui/ root); `root` limits the audit
// to a dialog / menu; `pages` pages through the biggest scroller; `phone` / `desktop` limit the widths.
const S = (name, setup, o = {}) => ({ name, setup, ...o });
const OPEN = async (id) => { (await import('/shell/state.js')).openSession(id); };
const EXTRA = `[
  { id: 'ov1', type: 'user', ts: Date.now() - 50000, text: 'ok', attachments: [] },
  { id: 'ov2', type: 'assistant', ts: Date.now() - 45000, streaming: false, model: 'claude-opus-5-5', text: 'Done. The fix is in \`C:\\\\Users\\\\you\\\\code\\\\storefront\\\\server\\\\middleware\\\\requireAuthenticatedSessionOrRedirect.js\`.\\n\\n| File | Change | Tests |\\n| --- | --- | --- |\\n| server/middleware/auth.js | the redirect now keeps ?next= | 14 passed |\\n| web/src/pages/login.tsx | reads ?next= once | 3 passed |\\n\\n\`\`\`js\\nconst next = new URL(req.originalUrl, \\'http://x\\').searchParams.get(\\'next\\') ?? \\'/dashboard\\'; // a very long line that has to scroll sideways inside the code block\\n\`\`\`' },
  { id: 'ov3', type: 'user', ts: Date.now() - 40000, text: 'https://shop.example.com/dashboard?next=%2Fsettings%2Fbilling%2Finvoices%2F2026-10%2Fdownload-the-whole-thing-as-a-pdf-please and then explain why the old middleware sent logged-out users back and forth between the two pages without ever stopping, in plain words, with the exact lines.', attachments: [] },
]`;
const CHAT = `async () => {
  (await import('/shell/state.js')).openSession('s_storefront');
  const st = await import('/lib/store.js');
  for (let i = 0; i < 40 && !(st.itemsBySession.value.s_storefront || []).length; i++) await new Promise((r) => setTimeout(r, 50));
  const cur = st.itemsBySession.value.s_storefront || [];
  const q = cur.filter((x) => x.queued), rest = cur.filter((x) => !x.queued);
  st.itemsBySession.value = { ...st.itemsBySession.value, s_storefront: [...rest, ...${EXTRA}, ...q] };
}`;
const PANEL = (id) => `async () => {
  (await import('/shell/state.js')).openSession('s_storefront');
  const p = await import('/panels/state.js');
  p.inspectorOpen.value = true; p.showPanel(${JSON.stringify(id)});
  const st = await import('/shell/state.js'); if (st.isPhone.value) st.sheetOpen.value = true;
}`;
const SCENARIOS = [
  S('home', `async () => { (await import('/shell/state.js')).view.value = 'home'; }`, { pages: 3 }),
  S('chat', CHAT, { pages: 6, from: 'top' }),
  S('chat-hover-row', CHAT, { pages: 1, from: 'bottom', root: '.chat-col' }),
  S('chat-booking', `async () => { (await import('/shell/state.js')).openSession('s_booking'); }`, { pages: 2 }),
  S('chat-helm', `async () => { (await import('/shell/state.js')).openSession('s_helm'); }`, { pages: 3 }),
  S('chat-mantle', `async () => { (await import('/shell/state.js')).openSession('s_api'); }`, { pages: 2 }),
  S('chat-stall', `async () => { (await import('/shell/state.js')).openSession('s_stall'); }`, { pages: 2 }),
  S('chat-empty', `async () => { (await import('/shell/state.js')).openSession('s_empty'); }`),
  S('edit-box', `async () => { await (${CHAT})(); (await import('/chat/actions.js')).editing.value = 's_storefront:i2'; }`, { pages: 1, from: 'top', wait: 500 }),
  S('find-bar', `async () => { await (${CHAT})(); await new Promise((r) => setTimeout(r, 200)); (await import('/shell/phone.js')).openFind(); }`, { wait: 500 }),
  S('acts-menu', `async () => { await (${CHAT})(); (await import('/chat/actions.js')).actsOpen.value = 's_storefront:i2'; }`, { phone: true, root: '.msg-acts-menu', scrollInto: '.msg-acts-menu' }),
  S('panel-fleet', PANEL('fleet'), { pages: 2 }),
  S('panel-changes', PANEL('changes'), { pages: 2 }),
  S('panel-files', PANEL('files'), { pages: 2 }),
  S('panel-preview', PANEL('preview')),
  S('panel-queue', PANEL('queue'), { pages: 2 }),
  S('panel-usage', PANEL('usage'), { pages: 3 }),
  S('panel-railway', PANEL('railway'), { pages: 2 }),
  S('phone-list', `async () => { const s = await import('/shell/state.js'); s.view.value = 'session'; s.phoneScreen.value = 'list'; }`, { phone: true, pages: 3 }),
  S('settings', `async () => { (await import('/shell/state.js')).go('settings'); }`, { pages: 12 }),
  S('history', `async () => { (await import('/shell/state.js')).go('history'); }`, { pages: 3 }),
  S('deck', `async () => { (await import('/shell/state.js')).go('deck'); }`, { pages: 3 }),
  S('new-session', `async () => { (await import('/shell/state.js')).newSessionOpen.value = true; }`, { root: '.modal', pages: 2 }),
  S('palette', `async () => { (await import('/shell/state.js')).paletteOpen.value = true; }`, { root: '.palette, .modal, [role=dialog]' }),
  // desktop only: the phone has no keyboard sheet (ShortcutsSheet renders nothing when isPhone)
  S('shortcuts', `async () => { (await import('/shell/shortcuts.js')).shortcutsOpen.value = true; }`, { root: '.modal, [role=dialog]', pages: 2, desktop: true }),
  S('whats-new', `async () => { (await import('/shell/whats-new.js')).whatsNewOpen.value = true; }`, { root: '.modal, [role=dialog]', pages: 2 }),
  S('worktrees', `async () => { (await import('/shell/worktrees.js')).openWorktrees('C:\\\\Users\\\\you\\\\helm'); }`, { root: '.modal', pages: 2, wait: 900 }),
  // DeleteDialog closes itself when none of the ids is in the session list yet, so wait for the mock list first
  // (two ids that are in the list: s_old / s_3h when the mock lists them, else the last two)
  S('delete-dialog', `async () => {
    const st = await import('/lib/store.js');
    for (let i = 0; i < 80 && (st.sessions.value || []).length < 2; i++) await new Promise((r) => setTimeout(r, 50));
    const all = st.sessions.value || [];
    const want = ['s_old', 's_3h'].filter((id) => all.some((s) => s.id === id));
    const ids = want.length === 2 ? want : all.slice(-2).map((s) => s.id);
    const sa = await import('/shell/session-actions.js');
    sa.askDelete(ids);
    await new Promise((r) => setTimeout(r, 150));
    if (!document.querySelector('.modal')) throw new Error('delete dialog did not open: ' + all.length + ' sessions listed, asked ' + JSON.stringify(ids) + ', deleteAsk ' + JSON.stringify(sa.deleteAsk.value));
  }`, { root: '.modal, [role=dialog]' }),
  // the restart confirm is an inline role=alertdialog in Settings > Helm (ui/shell/update.js), not a modal
  S('restart-dialog', `async () => {
    const u = await import('/shell/update.js');
    u.openHelmSettings();
    u.restartConfirm.value = { reasons: ['2 sessions are working (Fix the login redirect loop, Release notes for v1.3.2)', 'A scheduled run starts in 4 min'] };
  }`, { root: '.upd-confirm, [role=alertdialog]', scrollInto: '.upd-confirm', wait: 700 }),
  S('agent-view', `async () => {
    (await import('/shell/state.js')).openSession('s_storefront');
    const st = await import('/lib/store.js');
    for (let i = 0; i < 40 && !(st.fleetBySession.value.s_storefront || []).length; i++) await new Promise((r) => setTimeout(r, 50));
    const a = (st.fleetBySession.value.s_storefront || [])[0]; if (a) (await import('/panels/agent-view.js')).openAgent(a);
  }`, { pages: 2, wait: 600 }),
  S('toasts', `async () => {
    (await import('/shell/state.js')).openSession('s_storefront');
    const st = await import('/lib/store.js');
    st.toast({ title: 'Forked', body: 'New session with the conversation up to this message; its text is back in the composer. The original is untouched.', ms: 600000 });
    st.toast({ title: 'Could not fork', error: new Error('sessions.fork: the transcript C:\\\\Users\\\\you\\\\.claude\\\\projects\\\\C--Users-you-code-storefront\\\\6b1d6c1e-2f0a-4d7e-9c55-0d6c2b8f1a11.jsonl is locked by another process'), kind: 'error', ms: 600000 });
    st.toast({ title: 'Copied', ms: 600000 });
  }`, { wait: 500 }),
  S('menus', `async () => { (await import('/shell/state.js')).openSession('s_storefront'); }`, { menus: true }),
  S('menus-home', `async () => { (await import('/shell/state.js')).view.value = 'home'; }`, { menus: true }),
];

const lines = [];
const all = [];
let ctlCount = 0, screens = 0, setupFails = 0;   // a screen that never opened was not audited: it fails the run
const quality = { radius: {}, font: {} };   // control radii and font sizes seen, for the scale check
const log = (s) => { lines.push(s); console.log(s); };

function ink(p) {
  const reach = core.ringReach(p);
  const ringPx = Math.max(reach.l, reach.t, reach.r, reach.b);
  let box = p.painted || ringPx > 0.5 ? core.grow(p.rect, reach) : null;
  for (const ps of p.pseudoPaint || []) {
    const g = core.grow(ps.box, core.ringReach({ boxShadow: ps.boxShadow }));
    box = box ? { x: Math.min(box.x, g.x), y: Math.min(box.y, g.y), w: Math.max(box.x + box.w, g.x + g.w) - Math.min(box.x, g.x), h: Math.max(box.y + box.h, g.y + g.h) - Math.min(box.y, g.y) } : g;
  }
  return { ink: box, ring: ringPx > 0.5 };
}

async function auditOnce(page, cdp, sc, width, tag) {
  const m = await page.evaluate((r) => window.__ovl.mark(r), sc.root || null);
  if (m.missing) { setupFails++; log(`  FAIL ${width} ${tag} setup :: root ${sc.root} not found`); return []; }
  const { root: doc } = await cdp.send('DOM.getDocument', { depth: 0 });
  const hov = (await cdp.send('DOM.querySelectorAll', { nodeId: doc.nodeId, selector: '[data-ovlh]' })).nodeIds;
  for (const n of hov) await cdp.send('CSS.forcePseudoState', { nodeId: n, forcedPseudoClasses: ['hover'] }).catch(() => {});
  const hovSet = new Set(hov);
  const ctlNodes = (await cdp.send('DOM.querySelectorAll', { nodeId: doc.nodeId, selector: '[data-ovl]' })).nodeIds;
  const idOf = new Map();
  for (const n of ctlNodes) {
    const { attributes } = await cdp.send('DOM.getAttributes', { nodeId: n }).catch(() => ({ attributes: [] }));
    const k = attributes.indexOf('data-ovl'); if (k >= 0) idOf.set(+attributes[k + 1], n);
  }
  await page.waitForTimeout(30);
  const snap = await page.evaluate((r) => window.__ovl.collect(r), sc.root || null);
  const keep = [];
  for (const rec of snap.els) {
    if (rec.kind !== 'ctl') { keep.push(rec); continue; }
    const nodeId = idOf.get(rec.id);
    if (nodeId == null) continue;
    // keyboard focus alone, then hover alone: the ink is both; each must look different from rest
    const force = (on) => cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: on }).catch(() => {});
    const asHov = hovSet.has(nodeId);
    const wrap = rec.texty ? (await cdp.send('DOM.querySelectorAll', { nodeId: doc.nodeId, selector: `[data-ovlfa~="${rec.id}"]` }).catch(() => ({ nodeIds: [] }))).nodeIds : [];
    for (const w of wrap) await cdp.send('CSS.forcePseudoState', { nodeId: w, forcedPseudoClasses: hovSet.has(w) ? ['hover', 'focus-within'] : ['focus-within'] }).catch(() => {});
    await force(asHov ? ['hover', 'focus', 'focus-visible', 'focus-within'] : ['focus', 'focus-visible', 'focus-within']);
    const pf = await page.evaluate((id) => window.__ovl.probe(id), rec.id);
    for (const w of wrap) await cdp.send('CSS.forcePseudoState', { nodeId: w, forcedPseudoClasses: hovSet.has(w) ? ['hover'] : [] }).catch(() => {});
    await force(['hover']);
    const ph = await page.evaluate((id) => window.__ovl.probe(id), rec.id);
    await force(asHov ? ['hover'] : []);
    if (!pf || !ph) continue;
    const p = pf;
    if (!rec.disabled && !rec.ghost && rec.vis) {
      if (pf.sig === rec.rest && !asHov && !rec.focused) rec.noFocus = true;   // already focused at rest (autofocus): its rest IS the focus look
      if (ph.sig === rec.rest && !asHov && rec.buttonish && !rec.selected && width > 820) rec.noHover = true;   // a selected tab / pressed toggle may stay put
    }
    if (!rec.vis || p.opacity < 0.05) continue;   // scrolled out, or still invisible when hovered + focused
    const k = ink(pf), kh = ink(ph);
    const u = (a, b) => (!a ? b : !b ? a : { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.max(a.x + a.w, b.x + b.w) - Math.min(a.x, b.x), h: Math.max(a.y + a.h, b.y + b.h) - Math.min(a.y, b.y) });
    rec.ink = u(k.ink, kh.ink); rec.ring = k.ring || kh.ring;
    for (const q of [ph]) if (Math.abs(q.rect.x - rec.rect.x) + Math.abs(q.rect.w - rec.rect.w) + Math.abs(q.rect.y - rec.rect.y) + Math.abs(q.rect.h - rec.rect.h) > 0.75) p.rect = q.rect;
    const dx = Math.abs(p.rect.x - rec.rect.x) + Math.abs(p.rect.w - rec.rect.w), dy = Math.abs(p.rect.y - rec.rect.y) + Math.abs(p.rect.h - rec.rect.h);
    // back at rest, look once more: if it is still where the hover probe saw it, the content changed under the
    // audit (a live agent row gained or lost a line), not the hover / focus style
    const moved = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.w - b.w) + Math.abs(a.y - b.y) + Math.abs(a.h - b.h) > 0.75;
    const again = dx > 0.75 || dy > 0.75 ? await page.evaluate((id) => window.__ovl.probe(id), rec.id) : null;
    if (again && moved(again.rect, p.rect)) rec.shift = `${Math.round(rec.rect.w)}x${Math.round(rec.rect.h)} -> ${Math.round(p.rect.w)}x${Math.round(p.rect.h)} at ${Math.round(p.rect.x - rec.rect.x)},${Math.round(p.rect.y - rec.rect.y)}`;
    keep.push(rec);
  }
  ctlCount += keep.filter((r) => r.kind === 'ctl').length;
  snap.els = keep;
  const found = core.analyze(snap, { scenario: tag, width });
  for (const r of keep) {
    if (r.noFocus) found.push({ kind: 'no-focus-style', scenario: tag, width, a: r.sel, b: '', rect: r.rect, detail: 'keyboard focus changes nothing visible' });
    if (r.noHover) found.push({ kind: 'no-hover-style', scenario: tag, width, a: r.sel, b: '', rect: r.rect, detail: 'hover changes nothing visible' });
    if (r.kind === 'ctl' && r.vis) { quality.radius[r.radius] = (quality.radius[r.radius] || 0) + 1; quality.font[r.fs] = (quality.font[r.fs] || 0) + 1; }
  }
  for (const r of keep) if (r.shift) found.push({ kind: 'hover-shift', scenario: tag, width, a: r.sel, b: '', rect: r.rect, detail: `moves on hover/focus: ${r.shift}` });
  for (const n of hov) await cdp.send('CSS.forcePseudoState', { nodeId: n, forcedPseudoClasses: [] }).catch(() => {});
  if (SHOTS) {
    // shoot in the revealed (hover) state so the hover-only rows are in the picture
    for (const n of hov) await cdp.send('CSS.forcePseudoState', { nodeId: n, forcedPseudoClasses: ['hover'] }).catch(() => {});
    const boxes = [];
    for (const f of found) { if (f.rect) boxes.push(f.rect); if (f.brect) boxes.push({ ...f.brect, b: 1 }); }
    await page.evaluate((b) => window.__ovl.overlay(b), boxes);
    const dir = path.join(OUT, String(width)); fs.mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: path.join(dir, `${tag}.png`) });
    await page.evaluate(() => window.__ovl.overlay(null));
    for (const n of hov) await cdp.send('CSS.forcePseudoState', { nodeId: n, forcedPseudoClasses: [] }).catch(() => {});
  }
  return found;
}

async function newPage(ctx, url) {
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.querySelector('#app')?.children.length > 0, null, { timeout: 15000 });
  await page.addStyleTag({ content: FREEZE });
  if (THEME) {
    const got = await page.evaluate(async (t) => {
      const st = await import('/lib/store.js');
      for (let i = 0; i < 60 && !st.settings.value; i++) await new Promise((r) => setTimeout(r, 50));
      st.settings.value = { ...(st.settings.value || {}), theme: t };
      await new Promise((r) => setTimeout(r, 50));
      return document.documentElement.dataset.theme;
    }, THEME);
    if (got !== THEME) throw new Error(`--theme=${THEME}: the page is in ${got}`);
  }
  return { page, errors };
}

async function runScenario(ctx, url, sc, width) {
  const { page, errors } = await newPage(ctx, url);
  const found = [];
  try {
    await page.evaluate(`(${sc.setup})()`);
    await page.waitForTimeout(sc.wait || 400);
    await page.evaluate(`(${install})()`);
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
    if (sc.scrollInto) await page.evaluate((s) => document.querySelector(s)?.scrollIntoView({ block: 'center' }), sc.scrollInto);
    if (sc.menus) return await runMenus(page, cdp, sc, width);
    const sc0 = (await page.evaluate((r) => window.__ovl.scrollers(r), sc.root || null))[0];
    const pages = sc0 ? Math.min(sc.pages || 1, Math.ceil(sc0.sh / Math.max(1, sc0.h * 0.85))) : 1;
    let top = sc0 ? (sc.from === 'bottom' ? sc0.sh : 0) : 0;
    if (sc0) top = await page.evaluate(([k, t]) => window.__ovl.scrollTo(k, t), [sc0.key, top]);
    for (let i = 0; i < pages; i++) {
      if (i > 0) {
        const want = top + Math.round(sc0.h * 0.85);
        const got = await page.evaluate(([k, t]) => window.__ovl.scrollTo(k, t), [sc0.key, want]);
        if (got == null || got <= top) break;
        top = got;
        await page.waitForTimeout(120);
      }
      screens++;
      found.push(...await auditOnce(page, cdp, sc, width, pages > 1 ? `${sc.name}@${i + 1}` : sc.name));
    }
    if (errors.length) log(`  FAIL ${width} ${sc.name} page-error :: ${errors.join(' | ')}`);
  } catch (e) {
    setupFails++; log(`  FAIL ${width} ${sc.name} setup :: ${String(e.message || e).split('\n')[0]}`);
  } finally { await page.close(); }
  return found;
}

// Open each popup trigger on the screen in turn and audit what it opens.
async function runMenus(page, cdp, sc, width) {
  const found = [];
  const triggers = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('[aria-haspopup]').forEach((el, i) => {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1 || getComputedStyle(el).visibility !== 'visible') return;
      el.dataset.ovlTrig = String(i);
      out.push({ i, name: (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 24) });
    });
    return out;
  });
  for (const t of triggers.slice(0, 16)) {
    const before = await page.evaluate(() => document.querySelectorAll('[role=menu], [role=listbox], [role=dialog], .menu:not(.m-leave)').length);
    await page.locator(`[data-ovl-trig="${t.i}"]`).click({ timeout: 2000 }).catch(() => {});
    await page.waitForTimeout(250);
    const opened = await page.evaluate((n) => {
      const all = [...document.querySelectorAll('[role=menu], [role=listbox], [role=dialog], .menu:not(.m-leave)')].filter((e) => e.getBoundingClientRect().width > 0);
      if (all.length <= n) return null;
      const el = all[all.length - 1]; document.querySelectorAll('[data-ovl-menu]').forEach((x) => x.removeAttribute('data-ovl-menu'));
      el.dataset.ovlMenu = '1'; return true;
    }, before);
    if (opened) {
      screens++;
      const slug = t.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 20) || String(t.i);
      found.push(...await auditOnce(page, cdp, { ...sc, root: '[data-ovl-menu]' }, width, `${sc.name}:${slug}`));
    }
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(120);
  }
  return found;
}

// 3x crops of the message action row: rest, then each button hovered + focus-visible (the 2026-10-15 report).
async function zoomActions(browser, url) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 3 });
  const { page } = await newPage(ctx, url);
  await page.evaluate(`(${CHAT})()`);
  await page.waitForTimeout(500);
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
  const target = await page.evaluate(() => {
    const m = [...document.querySelectorAll('.msg-user')].find((u) => u.querySelectorAll('.msg-act').length >= 4);
    if (!m) return null; m.scrollIntoView({ block: 'center' }); m.dataset.ovlZoom = '1'; return true;
  });
  if (!target) { log('  FAIL zoom :: no user message with 4 actions'); await ctx.close(); return; }
  await page.waitForTimeout(200);
  const { root: doc } = await cdp.send('DOM.getDocument', { depth: 0 });
  const msg = (await cdp.send('DOM.querySelector', { nodeId: doc.nodeId, selector: '[data-ovl-zoom]' })).nodeId;
  await cdp.send('CSS.forcePseudoState', { nodeId: msg, forcedPseudoClasses: ['hover'] });
  const btns = (await cdp.send('DOM.querySelectorAll', { nodeId: msg, selector: '.msg-meta button' })).nodeIds;
  const dir = path.join(OUT, 'zoom'); fs.mkdirSync(dir, { recursive: true });
  const shoot = async (name) => {
    const box = await page.evaluate(() => { const r = document.querySelector('[data-ovl-zoom] .msg-meta').getBoundingClientRect(); return { x: r.left - 24, y: r.top - 14, width: r.width + 48, height: r.height + 28 }; });
    await page.screenshot({ path: path.join(dir, `${name}.png`), clip: box });
  };
  await shoot('0-rest');
  const names = ['copy', 'edit', 'fork', 'rewind'];
  for (let i = 0; i < btns.length; i++) {
    await cdp.send('CSS.forcePseudoState', { nodeId: btns[i], forcedPseudoClasses: ['hover', 'focus', 'focus-visible'] });
    await shoot(`${i + 1}-${names[i] || i}`);
    await cdp.send('CSS.forcePseudoState', { nodeId: btns[i], forcedPseudoClasses: [] });
  }
  await ctx.close();
  console.log('zoom crops in', dir);
}

(async () => {
  if (flag('list')) { for (const s of SCENARIOS) console.log(s.name + (s.phone ? ' (phone)' : '') + (s.desktop ? ' (desktop)' : '')); return; }
  const allow = fs.existsSync(ALLOW) ? JSON.parse(fs.readFileSync(ALLOW, 'utf8')).allow || [] : [];
  const env = arg('ui') ? { ...process.env, HELM_UI_DIR: path.resolve(arg('ui')) } : process.env;
  const srv = spawn(process.execPath, [path.join(__dirname, 'serve-ui.js'), '0'], { stdio: ['ignore', 'pipe', 'inherit'], env });
  const base = await new Promise((res, rej) => {
    srv.stdout.on('data', (b) => { const m = /(http:\/\/\S+)/.exec(String(b)); if (m) res(m[1]); });
    setTimeout(() => rej(new Error('serve-ui did not start')), 15000);
  });
  const browser = await chromium.launch(process.env.HELM_SHOT_CHANNEL ? { channel: process.env.HELM_SHOT_CHANNEL } : {});
  const t0 = Date.now();
  try {
    if (ZOOM) await zoomActions(browser, base);
    for (const width of WIDTHS) {
      const phone = width <= 820;
      const ctx = await browser.newContext({ viewport: { width, height: HEIGHT[width] || 860 }, deviceScaleFactor: 1, isMobile: phone, hasTouch: phone });
      for (const sc of SCENARIOS) {
        if (ONLY && !ONLY.some((o) => sc.name.includes(o))) continue;
        if ((sc.phone && !phone) || (sc.desktop && phone)) continue;
        all.push(...await runScenario(ctx, base, sc, width));
      }
      await ctx.close();
    }
  } finally {
    await browser.close();
    srv.kill();
  }
  const uniq = core.dedupe(all);
  let allowedN = 0, fresh = 0;
  const byKind = {}, byScreen = {};
  for (const f of uniq) {
    const a = core.allowed(f, allow);
    const screen = f.scenario.replace(/[@:].*$/, '');
    if (a) { allowedN++; console.log(`  allow ${f.width} ${f.scenario} ${f.kind} ${f.a}${f.b ? ' x ' + f.b : ''} (${a.reason})`); continue; }
    fresh++;
    byKind[f.kind] = (byKind[f.kind] || 0) + 1;
    byScreen[`${screen}@${f.width}`] = (byScreen[`${screen}@${f.width}`] || 0) + 1;
    log(`  FAIL ${f.width} ${f.scenario} ${f.kind} ${f.a}${f.b ? ' x ' + f.b : ''}${f.count > 1 ? ` (x${f.count})` : ''} :: ${f.detail}`);
  }
  if (arg('json')) fs.writeFileSync(path.resolve(arg('json')), JSON.stringify({ findings: uniq, byKind, byScreen, quality }, null, 1));
  console.log('control radii:', JSON.stringify(quality.radius));
  console.log('control font sizes:', JSON.stringify(quality.font));
  console.log('by kind:', JSON.stringify(byKind));
  console.log('by screen:', JSON.stringify(byScreen));
  console.log(`overlap-audit: ${THEME ? THEME + ' theme, ' : ''}${screens} screens, ${ctlCount} controls, ${uniq.length} findings (${allowedN} allowed), ${fresh} new, ${setupFails} setup failures, ${Math.round((Date.now() - t0) /1000)} s`);
  process.exit(fresh || setupFails ? 1 : 0);
})().catch((e) => { console.error(e); console.log(`overlap-audit: crashed: ${e.message}`); process.exit(1); });
