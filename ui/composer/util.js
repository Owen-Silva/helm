// Composer helpers: persistence (drafts, prompt history), media queries, model/command caches.
// Owner: lane composer. Everything localStorage is wrapped: storage can throw or be absent.
import { signal } from '@preact/signals';
import { rpc } from '../lib/store.js';

const mq = (q) => (typeof matchMedia === 'function' ? matchMedia(q) : null);
const phoneMq = mq('(max-width: 820px)');      // the shell's phone layout breakpoint
const touchMq = mq('(pointer: coarse)');
export const isPhone = signal(!!phoneMq?.matches);
try { phoneMq?.addEventListener('change', (e) => { isPhone.value = e.matches; }); } catch {}
export const isTouch = () => !!touchMq?.matches;

const ls = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { if (v == null || v === '') localStorage.removeItem(k); else localStorage.setItem(k, v); } catch {} },
};

export const loadDraft = (id) => (id && ls.get('helm.draft.' + id)) || '';
export const saveDraft = (id, text) => { if (id) ls.set('helm.draft.' + id, text); };

const HMAX = 100;
const hkey = (id) => 'helm.history.' + id;
export function loadHistory(id) {
  if (!id) return [];
  try { const a = JSON.parse(ls.get(hkey(id)) || '[]'); return Array.isArray(a) ? a.filter((x) => typeof x === 'string') : []; } catch { return []; }
}
export function pushHistory(id, text) {
  if (!id || !text.trim()) return;
  const a = loadHistory(id).filter((t) => t !== text);
  a.push(text);
  ls.set(hkey(id), JSON.stringify(a.slice(-HMAX)));
}

export const readDataUrl = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result);
  r.onerror = () => reject(r.error || new Error('could not read file'));
  r.readAsDataURL(file);
});

export function fmtBytes(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

let seq = 0;
export const uid = () => 'a' + Date.now().toString(36) + (++seq);

// ---- models (fetched once per app run) ----
export const models = signal([]);
let modelsP = null;
export function loadModels() {
  if (!modelsP) {
    modelsP = rpc('sessions.models', {})
      .then((m) => { models.value = Array.isArray(m) ? m : []; })
      .catch(() => { modelsP = null; });
  }
  return modelsP;
}
export function modelLabel(value) {
  const m = models.value.find((x) => x.value === value);
  if (m) return m.displayName;
  if (!value) return 'Model';
  const parts = String(value).replace(/^claude-/, '').split('-').filter((p) => !/^\d{8}$/.test(p));
  const name = parts.shift() || String(value);
  return name.charAt(0).toUpperCase() + name.slice(1) + (parts.length ? ' ' + parts.join('.') : '');
}

// ---- slash commands (cached per session) ----
const cmdCache = new Map();
export function getCommands(id) {
  if (!cmdCache.has(id)) {
    cmdCache.set(id, rpc('sessions.commands', { id })
      .then((c) => (Array.isArray(c) ? c.filter((x) => x && x.name) : []))
      .catch((e) => { cmdCache.delete(id); throw e; }));
  }
  return cmdCache.get(id);
}
export function filterCommands(all, q) {
  q = q.toLowerCase();
  if (!q) return all;
  const pre = [], sub = [];
  for (const c of all) {
    const n = c.name.toLowerCase();
    if (n.startsWith(q)) pre.push(c);
    else if (n.includes(q) || (c.description || '').toLowerCase().includes(q)) sub.push(c);
  }
  return [...pre, ...sub];
}

export const normFile = (r) => {
  if (typeof r === 'string') return { rel: r.replaceAll('\\', '/'), path: r };
  if (r && (r.rel || r.path)) return { rel: (r.rel || r.path).replaceAll('\\', '/'), path: r.path || r.rel };
  return null;
};

// "@query" (at start or after whitespace) or "/cmd" (the whole text before the caret).
export function detectToken(text, caret) {
  const before = text.slice(0, caret);
  let m = /^\/([^\s/]*)$/.exec(before);
  if (m) return { kind: 'cmd', start: 0, q: m[1] };
  m = /(?:^|\s)@([^\s@]*)$/.exec(before);
  if (m) return { kind: 'file', start: before.length - m[1].length - 1, q: m[1] };
  return null;
}

export const EFFORTS = [
  { value: 'low', desc: 'Quickest, least thinking' },
  { value: 'medium', desc: 'Balanced' },
  { value: 'high', desc: 'Thorough' },
  { value: 'xhigh', desc: 'Extra thorough' },
  { value: 'max', desc: 'Everything it has' },
];
export const PERMS = [
  { value: 'default', label: 'Ask', desc: 'Ask before edits and commands' },
  { value: 'acceptEdits', label: 'Accept edits', desc: 'Edit files freely, ask for commands' },
  { value: 'plan', label: 'Plan', desc: 'Read and plan, change nothing' },
  { value: 'bypassPermissions', label: 'Bypass', desc: 'Never ask' },
];
export const permLabel = (v) => PERMS.find((p) => p.value === v)?.label || v || 'Mode';
