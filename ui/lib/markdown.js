// Markdown + syntax highlighting for untrusted model output. Owner: lane conversation (D).
// marked → DOMPurify (own instance, strict config) → innerHTML. Highlighting via hljs.
//   renderMarkdown(text) → sanitized HTML string (cached per text)
//   highlight(code, lang) → safe HTML string; highlightLines(code, lang) → [safe HTML per line]
//   <Markdown text=… class=… /> component (copy buttons on code blocks work out of the box); renders block by
//     block (markdownBlocks) so a streaming reply only re-renders its last block. Same markup as renderMarkdown:
//     node tools/check-markdown-blocks.js proves it on real transcripts.
import { Marked } from 'marked';
import createPurify from 'dompurify';
import hljs from 'hljs';
import powershell from 'hljs-powershell';
import { useLayoutEffect, useRef } from 'preact/hooks';
import { html } from './html.js';

try { if (!hljs.getLanguage('powershell')) hljs.registerLanguage('powershell', powershell); } catch {}
try { hljs.registerAliases(['ps1', 'pwsh', 'ps'], { languageName: 'powershell' }); } catch {}
try { hljs.registerAliases(['sh', 'shell', 'zsh', 'console'], { languageName: 'bash' }); } catch {}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

export function langKnown(lang) { return !!(lang && hljs.getLanguage(lang)); }

export function highlight(code, lang) {
  const text = String(code ?? '');
  if (lang && hljs.getLanguage(lang)) {
    try { return hljs.highlight(text, { language: lang, ignoreIllegals: true }).value; } catch {}
  }
  return escapeHtml(text);
}

// Highlight the whole block (so multi-line strings/comments keep their state), then split the
// HTML into lines, closing and reopening any spans that cross a newline.
export function highlightLines(code, lang) {
  const out = [];
  const src = highlight(code, lang);
  const open = [];
  let line = '';
  const re = /(<span[^>]*>)|(<\/span>)|(\n)|([^<\n]+|<)/g;
  let m;
  while ((m = re.exec(src))) {
    if (m[1]) { open.push(m[1]); line += m[1]; }
    else if (m[2]) { open.pop(); line += m[2]; }
    else if (m[3]) { line += '</span>'.repeat(open.length); out.push(line); line = open.join(''); }
    else line += m[4];
  }
  out.push(line + '</span>'.repeat(open.length));
  return out;
}

// ---- sanitizer: a private DOMPurify instance so hooks never leak into other lanes ----
const purify = createPurify(window);
const PURIFY_CFG = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ['style', 'form', 'video', 'audio', 'source', 'picture', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'svg', 'math', 'dialog'],
  FORBID_ATTR: ['style', 'srcset', 'background', 'poster', 'ping', 'formaction', 'autofocus'],
  ALLOW_DATA_ATTR: false,
};
purify.addHook('uponSanitizeAttribute', (node, data) => {
  // Remote images could exfiltrate data via the URL; only inline data: images render.
  if (node.nodeName === 'IMG' && data.attrName === 'src' && !/^data:image\/(png|jpe?g|gif|webp);/i.test(data.attrValue || '')) data.keepAttr = false;
});
purify.addHook('afterSanitizeAttributes', (node) => {
  if (node.nodeName === 'A' && node.hasAttribute('href')) {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
  if (node.nodeName === 'INPUT') node.setAttribute('disabled', '');   // GFM task list boxes are display-only
});
export const sanitize = (dirty) => purify.sanitize(String(dirty ?? ''), PURIFY_CFG);

// ---- marked instance ----
// breaks: a single newline is a line break, as in Claude Code's terminal (a "one per line" list rendered as
// one run-on paragraph with breaks:false).
const md = new Marked({ gfm: true, breaks: true, async: false });
md.use({
  renderer: {
    code({ text, lang }) {
      const l = String(lang || '').trim().split(/\s+/)[0].toLowerCase();
      const label = l || 'text';
      const body = highlight(text, l);
      return `<div class="md-code"><div class="md-code-head"><span class="md-code-lang">${escapeHtml(label)}</span>`
        + `<button type="button" class="md-copy" aria-label="Copy code">Copy</button></div>`
        + `<pre><code class="hljs${l ? ' language-' + escapeHtml(l) : ''}">${body}</code></pre></div>`;
    },
    image({ href, text }) {
      if (/^data:image\//i.test(href || '')) return false; // default renderer
      return `<a href="${escapeHtml(href)}">${escapeHtml(text || href)}</a>`;
    },
  },
});

const wrapTables = (raw) => raw.replace(/<table>/g, '<div class="md-table"><table>').replace(/<\/table>/g, '</table></div>');

const cache = new Map();
const CACHE_MAX = 600;
let lastKey = null;   // the previous insert: a streaming reply's prefix, dropped once the next, longer text arrives
export function renderMarkdown(text) {
  const key = String(text ?? '');
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let out;
  try {
    out = sanitize(wrapTables(md.parse(key)));
  } catch (e) {
    out = `<pre>${escapeHtml(key)}</pre>`;
  }
  // A streamed reply arrives as ever-longer texts; without this every prefix stayed cached (up to 600 copies of
  // a long reply, and the finished texts other messages need got evicted).
  if (lastKey !== null && key.length > lastKey.length && key.startsWith(lastKey)) cache.delete(lastKey);
  cache.set(key, out);
  lastKey = key;
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return out;
}

// ---- block rendering (what <Markdown> uses) ----
// The text is lexed once into top-level blocks (paragraph, list, code fence, table, ...). Each block is parsed,
// highlighted and sanitized on its own and cached by its source, and the DOM is patched block by block: while a
// reply streams only its LAST block is re-rendered and only that block's nodes are replaced, so the cost of a token
// no longer grows with the length of the reply (it was a full marked + hljs + DOMPurify pass and a whole-subtree
// innerHTML swap, style, layout and text shaping included, on every 40 ms flush).
// The output is the same markup renderMarkdown() produces: marked's parser emits a document as the concatenation of
// its top-level tokens, each one balanced HTML. Text containing raw HTML (which may open in one block and close in
// another) and anything unusual falls back to the whole-text render.
const blockCache = new Map();
const BLOCK_CACHE_MAX = 3000;
const MAYBE_HTML = /<[A-Za-z!?/]/;
function hasHtmlToken(tokens) {
  for (const t of tokens || []) {
    if (t.type === 'html' || t.type === 'tag') return true;
    if (t.tokens && hasHtmlToken(t.tokens)) return true;
    if (t.type === 'list' && t.items.some((it) => hasHtmlToken(it.tokens))) return true;
    if (t.type === 'table' && (t.header.some((c) => hasHtmlToken(c.tokens)) || t.rows.some((r) => r.some((c) => hasHtmlToken(c.tokens))))) return true;
  }
  return false;
}
// → [html per block] or null (render the whole text instead)
export function markdownBlocks(text) {
  const src = String(text ?? '');
  let tokens;
  try { tokens = md.lexer(src); } catch { return null; }
  if (MAYBE_HTML.test(src) && hasHtmlToken(tokens)) return null;
  const links = tokens.links && Object.keys(tokens.links).length ? '\u0000' + JSON.stringify(tokens.links) : '';
  const last = tokens.length - 1;
  const out = [];
  for (let i = 0; i <= last; i++) {
    const t = tokens[i];
    if (t.type === 'space') continue;
    if (t.type === 'text') return null;   // top-level text runs are merged by the parser: not block-separable
    const key = t.type + '\u0000' + t.raw + links;
    let h = blockCache.get(key);
    if (h === undefined) {
      try { h = sanitize(wrapTables(md.parser([t]))); } catch { return null; }
      // the last block is the one still streaming: never cache it (every prefix would be a dead entry)
      if (i !== last) { blockCache.set(key, h); if (blockCache.size > BLOCK_CACHE_MAX) blockCache.delete(blockCache.keys().next().value); }
    } else if (i !== last) { blockCache.delete(key); blockCache.set(key, h); }   // LRU touch
    if (h) out.push(h);
  }
  return out;
}

// Block lists per whole text, so remounting a finished message (switching sessions) does not lex it again.
const blocksCache = new Map();
function blocksFor(text) {
  const hit = blocksCache.get(text);
  if (hit !== undefined) return hit;
  const b = markdownBlocks(text);
  blocksCache.set(text, b);
  if (blocksCache.size > CACHE_MAX) blocksCache.delete(blocksCache.keys().next().value);
  return b;
}

const scratch = typeof document !== 'undefined' ? document.createElement('div') : null;
function nodesOf(markup) { scratch.innerHTML = markup; const nodes = [...scratch.childNodes]; scratch.textContent = ''; return nodes; }
// Bring root's children in line with `text`, touching only the blocks that changed. st = { text, blocks: [{ html, nodes, whole }] }
// A fresh element gets one innerHTML (as fast as before); the first change after that replaces it once, and from
// then on only the changed tail blocks are replaced.
function paintMarkdown(root, text, st) {
  if (st.text === text && st.root === root) return;
  // this element's previous text was a prefix of the new one (a streaming reply): it is dead, drop its cache entries
  if (st.text && st.root === root && text.length > st.text.length && text.startsWith(st.text)) { blocksCache.delete(st.text); cache.delete(st.text); }
  const blocks = blocksFor(text);
  const old = st.root === root ? st.blocks : [];
  if (!old.length) {
    const markup = blocks ? blocks.join('') : renderMarkdown(text);
    root.innerHTML = markup;
    st.text = text; st.root = root; st.blocks = [{ html: markup, nodes: [...root.childNodes], whole: true }];
    return;
  }
  const want = blocks || [renderMarkdown(text)];
  let i = 0;
  if (blocks) while (i < old.length && i < want.length && !old[i].whole && old[i].html === want[i]) i++;
  for (let k = i; k < old.length; k++) for (const n of old[k].nodes) n.remove();
  const next = old.slice(0, i);
  if (i < want.length) {
    const frag = document.createDocumentFragment();
    for (let k = i; k < want.length; k++) { const nodes = nodesOf(want[k]); next.push({ html: want[k], nodes, whole: !blocks }); frag.append(...nodes); }
    root.append(frag);
  }
  st.text = text; st.blocks = next; st.root = root;
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}
function onMdClick(e) {
  const btn = e.target.closest?.('.md-copy');
  if (!btn) return;
  const code = btn.closest('.md-code')?.querySelector('code');
  if (!code) return;
  copy(code.textContent).then((ok) => {
    btn.textContent = ok ? 'Copied' : 'Copy failed';
    btn.classList.add('done');
    setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('done'); }, 1400);
  });
}

// The children of the .md element are owned by paintMarkdown (Preact renders the element with no children and
// never touches nodes it did not create); the layout effect fills it before the browser paints.
export function Markdown({ text, class: cls = '' }) {
  const ref = useRef(null);
  const st = useRef(null);
  if (!st.current) st.current = { text: null, blocks: [], root: null };
  useLayoutEffect(() => { if (ref.current) paintMarkdown(ref.current, String(text ?? ''), st.current); });
  return html`<div class=${'md ' + cls} onClick=${onMdClick} ref=${ref} />`;
}
