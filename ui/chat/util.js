// Small pure helpers for the conversation lane. Owner: lane conversation (D).
import { Component, h } from 'preact';

// memo(): skip re-render when props are shallow-equal (items are immutable objects in the
// store, so a streaming delta to one item leaves every other item's reference untouched).
const shallowEq = (a, b) => {
  for (const k in a) if (a[k] !== b[k]) return false;
  for (const k in b) if (!(k in a)) return false;
  return true;
};
export function memo(Comp, eq = shallowEq) {
  function shouldUpdate(next) { return !eq(this.props, next); }
  function Memoed(props) { this.shouldComponentUpdate = shouldUpdate; return h(Comp, props); }
  Memoed.displayName = 'Memo(' + (Comp.displayName || Comp.name) + ')';
  return Memoed;
}
export { Component };

export function fmtDuration(ms) {
  if (ms == null || !isFinite(ms) || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), rs = s % 60;
  if (m < 60) return rs ? `${m}m ${rs}s` : `${m}m`;
  const hh = Math.floor(m / 60), rm = m % 60;
  return rm ? `${hh}h ${rm}m` : `${hh}h`;
}
// Agent elapsed, formatted exactly like the fleet panel (floored seconds, "1m 05s") so the two agree.
export function fmtAgentElapsed(ms) {
  if (ms == null || !Number.isFinite(ms)) return '';
  const s = Math.floor(Math.max(0, ms) / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${s}s`;
}
// "claude-fable-5-1" → "Fable 5.1" (same rule as the fleet panel's shortModel)
export function modelName(m) {
  if (!m || typeof m !== 'string') return '';
  const x = m.replace(/^claude-/, '').replace(/\[1m\]$/, '');
  const [fam, ...v] = x.split('-');
  return fam ? fam[0].toUpperCase() + fam.slice(1) + (v.length ? ' ' + v.join('.') : '') : m;
}
export const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function fmtElapsedShort(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${(ms / 1000).toFixed(1)}s`;
  return fmtDuration(ms);
}
export const fmtCost = (usd) => (typeof usd !== 'number' || !Number.isFinite(usd) ? '' : usd < 0.01 && usd > 0 ? '<$0.01' : `$${usd.toFixed(2)}`);
export const fmtTime = (ts) => { try { return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch { return ''; } };
export const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

export const basename = (p = '') => String(p).split(/[\\/]/).filter(Boolean).pop() || String(p);
// Path relative to the session cwd when it lives inside it, with forward slashes.
export function relPath(p, cwd) {
  if (!p) return '';
  const norm = (x) => String(x).replace(/\\/g, '/');
  const a = norm(p), c = norm(cwd || '').replace(/\/$/, '');
  if (c && a.toLowerCase().startsWith(c.toLowerCase() + '/')) return a.slice(c.length + 1);
  return a;
}
export function hostOf(url) { try { return new URL(url).host.replace(/^www\./, ''); } catch { return url || ''; } }

// eslint-disable-next-line no-control-regex
const ANSI = /[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~]))/g;
export const stripAnsi = (s) => String(s ?? '').replace(ANSI, '');

export function resultText(result) {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  if (typeof result.text === 'string') return result.text;
  try { return JSON.stringify(result, null, 2); } catch { return String(result); }
}
export const resultImages = (result) => (result && typeof result === 'object' && Array.isArray(result.images) ? result.images : []);

export const countLines = (s) => (s ? String(s).replace(/\n$/, '').split('\n').length : 0);

const EXT_LANG = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
  json: 'json', md: 'markdown', css: 'css', scss: 'scss', less: 'less', html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', cs: 'csharp', c: 'c', h: 'c', cpp: 'cpp',
  hpp: 'cpp', sh: 'bash', bash: 'bash', zsh: 'bash', ps1: 'powershell', psm1: 'powershell', yml: 'yaml', yaml: 'yaml',
  toml: 'ini', ini: 'ini', sql: 'sql', php: 'php', swift: 'swift', lua: 'lua', diff: 'diff', prisma: 'graphql', graphql: 'graphql',
};
export function langFromPath(p) {
  const ext = basename(p).split('.').pop()?.toLowerCase();
  return EXT_LANG[ext] || '';
}

export function truncate(s, n) { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
export const firstLine = (s) => String(s ?? '').split('\n')[0];

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {
    try {
      const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); return true;
    } catch { return false; }
  }
}

// "[lane:tests] regression test" → { lane: 'tests', rest: 'regression test' }
export function splitLane(desc = '') {
  const m = /^\s*\[lane:([^\]]+)\]\s*(.*)$/.exec(desc || '');
  return m ? { lane: m[1], rest: m[2] } : { lane: null, rest: desc || '' };
}
