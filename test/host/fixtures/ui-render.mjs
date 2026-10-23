// A DOM-free renderer for Helm's Preact+htm UI modules in plain node (lane prep-helm-auth-localui).
// It renders a component tree to plain objects ({ t, p, c }) with a tiny hooks runtime (useState / useEffect /
// useRef / useMemo / useCallback), so a test can mount a ui/ component, drive it through its own handlers
// (click / input / submit) and compare what it would show. No browser, no Electron, no preact-render-to-string.
//
// Module loading: node:module registerHooks maps the imports of the files under test to shims that read this
// runtime (globalThis.__helmUiTest): preact/hooks, ../lib/html.js, ../lib/icons.js, ../lib/store.js,
// ../lib/transport.js, ./util.js, ./phone.js.
//   const ui = await import('./fixtures/ui-render.mjs');
//   const mod = await ui.importUnderTest(file);     // the file's imports go to the shims
//   ui.R.rpcImpl = async (method, params) => ...;   // what rpc() answers
//   ui.mount(mod.AccountSettings); await ui.settle(); ui.json(); ui.click('acct-check');
import { registerHooks } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import htm from 'htm';

export const available = typeof registerHooks === 'function';

// ---- vnodes ----
export function h(type, props, ...children) {
  const p = { ...(props || {}) };
  if (children.length === 1) p.children = children[0];
  else if (children.length > 1) p.children = children;
  return { type, props: p };
}
export const html = htm.bind(h);

// ---- runtime the shims read ----
export const R = globalThis.__helmUiTest || (globalThis.__helmUiTest = {});
Object.assign(R, {
  h, html,
  rpcImpl: async (method) => { throw Object.assign(new Error(`no rpc mock for ${method}`), { code: 'unknown_method' }); },
  rpcLog: [], toasts: [], listeners: [], copied: [],
  appInfo: { platform: 'web' }, auth: undefined,
});
R.rpc = (method, params) => { R.rpcLog.push(params === undefined ? [method] : [method, params]); try { return Promise.resolve(R.rpcImpl(method, params)); } catch (e) { return Promise.reject(e); } };
R.toast = (t) => { R.toasts.push({ title: t && t.title, kind: t && t.kind, error: t && t.error ? String(t.error.message || t.error) : undefined }); };
R.on = (ev, fn) => { const e = [ev, fn]; R.listeners.push(e); return () => { const i = R.listeners.indexOf(e); if (i >= 0) R.listeners.splice(i, 1); }; };
R.emit = (ev, data) => { for (const [e, fn] of [...R.listeners]) if (e === ev) fn(data); };
R.copyText = async (t) => { R.copied.push(t); return true; };
if (!globalThis.document) {
  globalThis.document = { visibilityState: 'visible', _l: [], addEventListener(ev, fn) { this._l.push([ev, fn]); }, removeEventListener(ev, fn) { this._l = this._l.filter((x) => x[0] !== ev || x[1] !== fn); } };
}

// ---- hooks ----
let current = null;          // { inst, i } while a component function runs
let pendingEffects = [];
const slot = (init) => { const { inst } = current; const i = current.i++; if (!(i in inst.hooks)) inst.hooks[i] = init(); return inst.hooks[i]; };
R.useState = (init) => {
  const s = slot(() => ({ v: typeof init === 'function' ? init() : init }));
  if (!s.set) s.set = (nv) => { const v = typeof nv === 'function' ? nv(s.v) : nv; if (!Object.is(v, s.v)) { s.v = v; R.dirty = true; } };
  return [s.v, s.set];
};
R.useRef = (init) => slot(() => ({ current: init }));
const changedDeps = (a, b) => !a || !b || a.length !== b.length || a.some((x, k) => !Object.is(x, b[k]));
R.useMemo = (fn, deps) => { const s = slot(() => ({ deps: null, v: undefined, init: false })); if (!s.init || changedDeps(s.deps, deps)) { s.v = fn(); s.deps = deps; s.init = true; } return s.v; };
R.useCallback = (fn, deps) => R.useMemo(() => fn, deps);
R.useEffect = (fn, deps) => {
  const s = slot(() => ({ deps: undefined, cleanup: null, ran: false, effect: true }));
  if (!s.ran || changedDeps(s.deps, deps)) {
    s.ran = true; s.deps = deps;
    pendingEffects.push(() => { if (s.cleanup) { try { s.cleanup(); } catch {} } const c = fn(); s.cleanup = typeof c === 'function' ? c : null; });
  }
};
R.useLayoutEffect = R.useEffect;

// ---- render ----
let instances = new Map();   // path -> { type, hooks }
let root = null;
let last = null;             // the last rendered tree (live handlers)
const typeIds = new WeakMap(); let typeSeq = 0;
const typeId = (f) => { if (!typeIds.has(f)) typeIds.set(f, ++typeSeq); return typeIds.get(f); };

function unmount(inst) { for (const s of inst.hooks) if (s && s.effect && s.cleanup) { try { s.cleanup(); } catch {} } }

function renderNode(node, at, seen) {
  if (node == null || typeof node === 'boolean') return [];
  if (Array.isArray(node)) return node.flatMap((n, k) => renderNode(n, `${at}.${k}`, seen));
  if (typeof node !== 'object') return [String(node)];
  const { type, props } = node;
  if (typeof type === 'function') {
    const p = `${at}/${type.name || 'anon'}${props.key != null ? '#' + props.key : ''}`;
    let inst = instances.get(p);
    if (!inst || inst.type !== type) { if (inst) unmount(inst); inst = { type, hooks: [], id: typeId(type) }; instances.set(p, inst); }
    seen.add(p);
    const { key, ...rest } = props;
    const prev = current; current = { inst, i: 0 };
    let out; try { out = type(rest); } finally { current = prev; }
    return renderNode(out, p, seen);
  }
  const { children, key, ...attrs } = props;
  return [{ t: type, p: attrs, c: mergeText(renderNode(children, `${at}>${type}`, seen)) }];
}
function mergeText(list) {
  const out = [];
  for (const x of list) { if (typeof x === 'string' && typeof out[out.length - 1] === 'string') out[out.length - 1] += x; else if (x !== '') out.push(x); }
  return out;
}

function renderRoot() {
  const seen = new Set();
  pendingEffects = [];
  R.dirty = false;
  const tree = root ? mergeText(renderNode(h(root.type, root.props), 'root', seen)) : [];
  for (const [p, inst] of instances) if (!seen.has(p)) { unmount(inst); instances.delete(p); }
  const fx = pendingEffects; pendingEffects = [];
  for (const f of fx) f();
  last = tree;
  return tree;
}

export function reset() {
  for (const inst of instances.values()) unmount(inst);
  instances = new Map(); root = null; last = null;
  R.rpcLog = []; R.toasts = []; R.listeners = []; R.copied = [];
  R.appInfo = { platform: 'web' }; R.auth = undefined;
}
// Mount (replacing whatever was mounted; R's rpc mock, logs, appInfo and auth are kept: reset() clears those).
export function mount(type, props = {}) { unmountAll(); root = { type, props }; return renderRoot(); }
export function unmountAll() { for (const inst of instances.values()) unmount(inst); instances = new Map(); root = null; last = null; }

const tick = () => new Promise((r) => setImmediate(r));
// Render, run effects, let promises (rpc answers) land, and render again until nothing changes.
// quietMs: how long nothing may change before it counts as settled.
export async function settle({ quietMs = 15 } = {}) {
  for (let i = 0; i < 200; i++) {
    renderRoot();
    await tick(); await tick();
    if (!R.dirty) { await new Promise((r) => setTimeout(r, quietMs)); if (!R.dirty) return last; }
  }
  throw new Error('ui-render: the tree never settled');
}

// ---- reading the tree ----
export function walk(tree = last, fn) { for (const n of tree || []) { if (typeof n === 'object') { fn(n); walk(n.c, fn); } } }
export function findAll(pred, tree = last) { const out = []; walk(tree, (n) => { if (pred(n)) out.push(n); }); return out; }
export const byAct = (act) => (n) => n.p['data-act'] === act;
export const byState = (st) => (n) => n.p['data-state'] === st;
export function text(tree = last) {
  if (tree && !Array.isArray(tree)) tree = [tree]; let s = ''; for (const n of tree || []) s += typeof n === 'string' ? n : text(n.c); return s; }
const findOne = (sel) => { const pred = typeof sel === 'function' ? sel : byAct(sel); const n = findAll(pred)[0]; if (!n) throw new Error(`ui-render: nothing matches ${typeof sel === 'string' ? sel : 'the selector'}`); return n; };
export function click(sel) { const n = findOne(sel); n.p.onClick({ preventDefault() {}, currentTarget: n, target: n }); }
export function input(sel, value) { const n = findOne(sel); const t = { value }; n.p.onInput({ target: t, currentTarget: t }); }
export function submit(sel) { const n = findOne(sel); n.p.onSubmit({ preventDefault() {} }); }

// The tree as JSON: handlers become "[fn]", undefined/null attributes are dropped (Preact renders them as absent).
export function json(tree = last) {
  const norm = (list) => list.map((n) => typeof n === 'string' ? n : {
    t: n.t,
    p: Object.fromEntries(Object.entries(n.p).filter(([, v]) => v != null).map(([k, v]) => [k, typeof v === 'function' ? '[fn]' : v])),
    c: norm(n.c),
  });
  return JSON.stringify(norm(tree || []));
}

// ---- module loading ----
const SHIM = 'helm-ui-shim:';
const shimSource = {
  'preact/hooks': 'const R = globalThis.__helmUiTest; export const useState = (...a) => R.useState(...a); export const useEffect = (...a) => R.useEffect(...a); export const useLayoutEffect = (...a) => R.useLayoutEffect(...a); export const useRef = (...a) => R.useRef(...a); export const useMemo = (...a) => R.useMemo(...a); export const useCallback = (...a) => R.useCallback(...a);',
  '../lib/html.js': 'const R = globalThis.__helmUiTest; export const html = R.html; export const h = R.h;',
  '../lib/icons.js': 'const R = globalThis.__helmUiTest; export function Icon(p) { return R.h("icon", { name: p.name, size: p.size }); }',
  '../lib/store.js': 'const R = globalThis.__helmUiTest; export const rpc = (...a) => R.rpc(...a); export const toast = (...a) => R.toast(...a); export const appInfo = { get value() { return R.appInfo; } }; export const auth = { get value() { return R.auth; } }; export const setAuth = (a) => { if (a && a.capabilities) R.authSet = (R.authSet || 0) + 1; };',
  '../lib/transport.js': 'const R = globalThis.__helmUiTest; export const on = (...a) => R.on(...a);',
  './util.js': 'const R = globalThis.__helmUiTest; export const cx = (...a) => a.filter(Boolean).join(" "); export function Modal(p) { return R.h("modal", { title: p.title, width: p.width, class: p.class, onClose: p.onClose }, R.h("modal-footer", null, p.footer), p.children); }',
  './phone.js': 'const R = globalThis.__helmUiTest; export const copyText = (...a) => R.copyText(...a);',
};
const underTest = new Set();   // file URLs (no query) whose imports go to the shims
const noQuery = (u) => String(u).split('?')[0];

let hooked = false;
function hook() {
  if (hooked || !available) return;
  hooked = true;
  registerHooks({
    resolve(specifier, context, next) {
      const parent = context.parentURL && noQuery(context.parentURL);
      if (parent && underTest.has(parent)) {
        if (Object.hasOwn(shimSource, specifier)) return { url: SHIM + encodeURIComponent(specifier), format: 'module', shortCircuit: true };
      }
      return next(specifier, context);
    },
    load(url, context, next) {
      if (url.startsWith(SHIM)) return { format: 'module', source: shimSource[decodeURIComponent(url.slice(SHIM.length))], shortCircuit: true };
      if (underTest.has(noQuery(url))) return { format: 'module', source: fs.readFileSync(fileURLToPath(noQuery(url)), 'utf8'), shortCircuit: true };
      return next(url, context);
    },
  });
}

// Import a ui/ module (or a copy of one) with its imports mapped to the shims.
export async function importUnderTest(file, tag = '') {
  hook();
  const url = pathToFileURL(path.resolve(file)).href;
  underTest.add(url);
  return import(tag ? `${url}?${tag}` : url);
}
