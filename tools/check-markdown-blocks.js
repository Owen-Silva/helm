require('./lowcpu-optional'); // FIRST: caps CPU + one headless browser machine-wide
// Equivalence check for the block-incremental <Markdown> (ui/lib/markdown.js): for every text in the corpus,
//   1. markdownBlocks(text).join('') === renderMarkdown(text)          (same markup, or a deliberate fallback)
//   2. the component's DOM equals a fresh innerHTML of renderMarkdown(text)   (isEqualNode)
//   3. streamed: painting every ~60-char prefix in turn into ONE element ends equal to the fresh render
//      at every step (not only the last)
// Corpus: hand-written edge cases + assistant texts read (read-only) from the newest Claude Code transcripts in
// ~/.claude/projects (--max=N texts, default 1500). Prints `check-markdown-blocks: N texts, M mismatches`.
// Owner: lane smooth.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright-core');

const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d; };
const MAX = Number(arg('max', 1500));

const EDGE = [
  '', 'plain', 'a\nb', 'para one\n\npara two',
  '1. one\n\n2. two\n\n3. three', '- a\n- b\n\n  continued in b\n- c', '- a\n  - nested\n    - deeper\n- b',
  '| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |', 'Title\n=====\n\ntext', 'Sub\n---', 'text\n---\nmore',
  'see [the docs][d] and [x][y]\n\n[d]: https://example.com\n[y]: https://y.example',
  '[early][late]\n\npara\n\n[late]: https://late.example', '> quote\n>\n> more quote\n\nafter',
  '```js\nconst a = 1;\n\nconst b = 2;\n```\n\nafter', '```\nunclosed fence\n\nstill code', '~~~py\nx = 1\n~~~',
  'inline <b>bold</b> html', '<div>\n\nblock html\n\n</div>', 'a <b>unclosed\n\nnext para', 'x < y and y > z', '<https://auto.link>',
  '    indented code\n\n    more', '***\n\n___', '# h1\n## h2\n### h3', '- [ ] todo\n- [x] done', 'line  \nbreak', '**bold** _em_ `code` ~~del~~',
  'Line one\nLine two\n\n- list right after\n1. ordered after', '![img](data:image/png;base64,iVBORw0KGgo=)', '![remote](https://x.example/a.png)',
  'term\n: not a dl', '\\* escaped', '&amp; &lt; entities', 'a | b\n--|--\n1 | 2', '1) paren list\n2) two', '* star\n+ plus\n- dash',
];

function corpus() {
  const out = [...EDGE];
  const root = path.join(os.homedir(), '.claude', 'projects');
  let files = [];
  try {
    for (const d of fs.readdirSync(root)) {
      const dir = path.join(root, d);
      try { for (const f of fs.readdirSync(dir)) if (f.endsWith('.jsonl')) { const p = path.join(dir, f); files.push({ p, t: fs.statSync(p).mtimeMs }); } } catch {}
    }
  } catch {}
  files.sort((a, b) => b.t - a.t);
  for (const { p } of files) {
    if (out.length >= MAX) break;
    let raw; try { raw = fs.readFileSync(p, 'utf8'); } catch { continue; }
    for (const line of raw.split('\n')) {
      if (out.length >= MAX) break;
      if (!line.includes('"assistant"')) continue;
      try {
        const m = JSON.parse(line);
        for (const c of (m.message && Array.isArray(m.message.content) ? m.message.content : [])) if (c.type === 'text' && c.text && c.text.length > 40) out.push(c.text);
      } catch {}
    }
  }
  return out.slice(0, MAX);
}

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'serve-ui.js'), '0'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let buf = '';
    child.stdout.on('data', (d) => { buf += d; const m = /127\.0\.0\.1:(\d+)/.exec(buf); if (m) resolve({ child, port: Number(m[1]) }); });
    setTimeout(() => reject(new Error('serve-ui did not start')), 10000);
  });
}

(async () => {
  const texts = corpus();
  const { child, port } = await startServer();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/?mock=1&nolive`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.sidebar-scroll .srow', { timeout: 20000 });
    const res = await page.evaluate(async (texts) => {
      const m = await import('/lib/markdown.js');
      const { render } = await import('preact');
      const { html } = await import('/lib/html.js');
      const host = document.createElement('div'); document.body.append(host);
      const fresh = (t) => { const d = document.createElement('div'); d.innerHTML = m.renderMarkdown(t); return d; };
      const same = (el, t) => { const a = fresh(t); if (a.childNodes.length !== el.childNodes.length) return false; for (let i = 0; i < a.childNodes.length; i++) if (!a.childNodes[i].isEqualNode(el.childNodes[i])) return false; return true; };
      const bad = []; let fallbacks = 0, steps = 0;
      for (const t of texts) {
        const blocks = m.markdownBlocks(t);
        if (!blocks) fallbacks++;
        else if (blocks.join('') !== m.renderMarkdown(t)) { bad.push({ kind: 'markup', t: t.slice(0, 160) }); continue; }
        render(html`<${m.Markdown} text=${t} />`, host);
        if (!same(host.firstChild, t)) { bad.push({ kind: 'dom', t: t.slice(0, 160) }); render(null, host); continue; }
        render(null, host);
        // streamed into one element
        let ok = true;
        for (let n = 0; n <= t.length && ok; n += 60) {
          const p = t.slice(0, n); steps++;
          render(html`<${m.Markdown} text=${p} />`, host);
          if (!same(host.firstChild, p)) { ok = false; bad.push({ kind: 'stream', at: n, t: p.slice(-160) }); }
        }
        if (ok) { render(html`<${m.Markdown} text=${t} />`, host); if (!same(host.firstChild, t)) bad.push({ kind: 'stream-end', t: t.slice(0, 160) }); }
        render(null, host);
      }
      return { n: texts.length, fallbacks, steps, bad: bad.slice(0, 8), mismatches: bad.length };
    }, texts);
    console.log(JSON.stringify(res.bad, null, 1));
    console.log(`check-markdown-blocks: ${res.n} texts (${res.fallbacks} whole-text fallbacks, ${res.steps} streamed steps), ${res.mismatches} mismatches`);
    process.exitCode = res.mismatches ? 1 : 0;
  } finally {
    await browser.close();
    child.kill();
  }
})().catch((e) => { console.error(e); process.exit(1); });
