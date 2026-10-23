// Settings -> Account: how Helm's sessions reach Claude (PROTOCOL "Account"; main/account.js). Helm never signs in.
// By default its sessions use whatever the user's installed Claude Code is signed in with (the user signs in
// themselves, in a terminal, by running `claude`); Helm only reads Claude Code's own status, read-only. Optionally
// the user saves an Anthropic API key here, and then sessions use that key. This panel says plainly which one is in
// use, offers the switch (add a key / remove it), and always shows Claude Code's own sign-in with a Check again
// (account.status { refresh: true }). There are no sign-in or sign-out controls. Every state says what and why:
// signed out (the host's reason), could not check, a key that can't be read, an older host with no `claudeCode`.
// The desktop window and the phone both follow account.changed.
// Owner: lane account.
import { useState, useEffect, useRef } from 'preact/hooks';
import { html } from '../lib/html.js';
import { Icon } from '../lib/icons.js';
import { rpc, toast, setAuth } from '../lib/store.js';
import { on } from '../lib/transport.js';

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const errText = (e) => String((e && e.message) || e || 'unknown error').split('\n')[0].slice(0, 300);
const CONSOLE_KEYS = 'https://console.anthropic.com/settings/keys';
const NOT_SIGNED_IN = "Claude Code isn't signed in. Open a terminal, run `claude`, and sign in there; then press Check again.";

// What happened to running sessions after the switch (account.changed `restart`).
function RestartNote({ restart, what }) {
  if (!restart || !(restart.waiting > 0 || Date.now() - restart.at < 5 * 60_000)) return null;
  const text = restart.unsupported
    ? 'Helm could not restart its running sessions (the stand-in engine is running). Restart Helm so they pick up the change.'
    : restart.waiting > 0
      ? `${plural(restart.waiting, 'working session')} ${restart.waiting === 1 ? 'switches' : 'switch'} when ${restart.waiting === 1 ? 'its' : 'their'} turn ends${restart.restarted ? `; ${plural(restart.restarted, 'idle session')} already restarted ${what}` : ''}.`
      : restart.restarted ? `${plural(restart.restarted, 'session')} restarted ${what}; each picks up its conversation on the next message.` : '';
  return text ? html`<div class="acct-outcome"><p class="acct-msg muted" data-state="restart"><${Icon} name="refresh" size=${14} />${text}</p></div>` : null;
}

const who = (state, { name, sub, initial, off }) => html`<div class="acct-who" data-state=${state}>
  <div class=${off ? 'acct-avatar off' : 'acct-avatar'} aria-hidden="true">${initial || html`<${Icon} name="key" size=${16} />`}</div>
  <div class="acct-id"><span class="acct-name">${name}</span>${sub && html`<span class="acct-sub">${sub}</span>`}</div>
</div>`;

// Claude Code's own sign-in (`claudeCode`, from its read-only status check). Text only: never a control to change it.
function ClaudeCodeWho({ cc }) {
  if (cc.checking || cc.state === 'unchecked' || !cc.state) {
    return html`<div class="acct-checking" data-state="cc-checking"><span class="spinner sm"></span>Checking Claude Code's sign-in…</div>`;
  }
  if (cc.state === 'signed-in') {
    const sub = [cc.plan, cc.methodLabel, cc.orgName].filter(Boolean).join(' · ');
    return who('cc-signed-in', { name: cc.email || cc.plan || 'Signed in', sub: cc.email ? sub : [cc.methodLabel, cc.orgName].filter(Boolean).join(' · '),
      initial: cc.email ? cc.email[0].toUpperCase() : null });
  }
  if (cc.state === 'signed-out') {
    return who('cc-signed-out', { off: true, name: "Claude Code isn't signed in",
      sub: `${cc.reason || NOT_SIGNED_IN}${cc.source === 'session' ? ' (A session reported this when it started.)' : ''}` });
  }
  return who('cc-unknown', { off: true, name: "Helm couldn't check Claude Code's sign-in", sub: cc.reason || 'Claude Code gave no reason.' });
}

export function AccountSettings() {
  const [st, setSt] = useState(null);         // account.status / account.changed
  const [loadErr, setLoadErr] = useState(null);
  const live = useRef(true);
  const load = (refresh) => rpc('account.status', refresh ? { refresh: true } : {})
    .then((x) => { setAuth(x); if (live.current) { if (x) setSt(x); setLoadErr(null); } return x; }, (e) => { if (live.current) setLoadErr(errText(e)); throw e; });

  useEffect(() => {
    live.current = true;
    load(false).catch(() => {});
    const off = on('account.changed', (x) => x && setSt(x));
    // Signed in or out in a terminal meanwhile: look again when Helm comes back to the front.
    const vis = () => { if (document.visibilityState === 'visible') load(false).catch(() => {}); };
    document.addEventListener('visibilitychange', vis);
    return () => { live.current = false; off(); document.removeEventListener('visibilitychange', vis); };
  }, []);

  if (loadErr && !st) {
    return html`<div class="set-row acct" data-state="rpc-error"><div class="set-row-label"><span>Could not check the account</span><span class="hint">${loadErr}</span></div>
      <div class="set-row-ctl"><button class="btn btn-sm" data-act="acct-retry" onClick=${() => load(true).catch(() => {})}>Try again</button></div></div>`;
  }
  if (!st) return html`<div class="set-row acct"><div class="acct-checking" data-state="loading"><span class="spinner sm"></span>Checking how Helm's sessions reach Claude…</div></div>`;
  return html`<${AccountPanel} st=${st} setSt=${setSt} load=${load} />`;
}

// account.setApiKey { key } saves or replaces, { key: null } removes it (back to Claude Code's sign-in). The key never
// comes back from the host: only apiKeySet / apiKeyLast4 / apiKeySource. The input is never prefilled.
function AccountPanel({ st, setSt, load }) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(null);       // 'save' | 'clear' | 'check'
  const [err, setErr] = useState(null);         // { where: 'key' | 'clear' | 'check', text }
  const [clearAsk, setClearAsk] = useState(false);
  const s = st.status || {};
  const cc = st.claudeCode && typeof st.claudeCode === 'object' ? st.claudeCode : null;
  const keyMode = st.provider ? st.provider === 'api-key' : !!(s.apiKeySet || s.keyError);
  const saved = s.apiKeySource === 'helm' || !!s.keyError;   // something Helm stored (even unreadable) that Remove clears

  const save = async (e) => {
    e.preventDefault();
    const k = key.trim();
    if (!k || busy) return;
    setBusy('save'); setErr(null);
    try {
      const x = await rpc('account.setApiKey', { key: k });
      setAuth(x);
      setKey('');
      if (x) setSt(x);
      toast({ title: keyMode ? 'API key replaced' : 'API key saved: sessions use it now', ms: 2500 });
    } catch (x) { setErr({ where: 'key', text: errText(x) }); }
    setBusy(null);
  };
  const clear = async () => {
    setBusy('clear'); setErr(null);
    try {
      const x = await rpc('account.setApiKey', { key: null });
      setAuth(x);
      if (x) setSt(x);
      toast({ title: "API key removed: sessions use Claude Code's sign-in", ms: 2500 });
    } catch (x) { setErr({ where: 'clear', text: errText(x) }); }
    setClearAsk(false);
    setBusy(null);
  };
  const check = async () => {
    if (busy) return;
    setBusy('check'); setErr(null);
    try { await load(true); } catch (x) { setErr({ where: 'check', text: errText(x) }); }
    setBusy(null);
  };

  // What Helm's sessions use right now.
  let inUse;
  if (keyMode) {
    inUse = s.keyError
      ? who('in-use-key-error', { off: true, name: "API key (it can't be read)", sub: 'Saved in Helm' })
      : who('in-use-key', { name: html`API key${s.apiKeyLast4 ? html` <span class="mono">••••${s.apiKeyLast4}</span>` : ''}`,
        sub: s.apiKeySource === 'helm' ? "Saved in Helm · billed to the key's Anthropic Console account" : "Billed to the key's Anthropic Console account" });
  } else {
    inUse = html`<p class="acct-note" data-state="in-use-claude-code"><${Icon} name="check" size=${14} /><span>Sessions use whatever Claude Code on this PC is signed in with.</span></p>`;
  }
  // The host's reason sessions can't start, unless the block below already says it.
  const ccSaysWhy = !keyMode && cc && (cc.state === 'signed-out' || cc.state === 'unknown' || st.reason === cc.reason);
  const reason = st.ready === false && st.reason && st.reason !== s.keyError && !ccSaysWhy ? st.reason : null;
  const ccChecking = !!(cc && (cc.checking || cc.state === 'unchecked')) || busy === 'check';

  return html`<div class="acct" data-mode=${keyMode ? 'api-key' : 'claude-code'}>
    <div class="acct-body">
      <div class="acct-sec">
        <span class="acct-label">In use: ${keyMode ? 'an API key' : "Claude Code's sign-in"}</span>
        ${inUse}
        ${s.ok === false && html`<p class="acct-msg danger" role="alert" data-state="key-status-error"><${Icon} name="alert" size=${14} /><span>Helm could not read its saved key state: ${(s.error && s.error.message) || 'no answer yet.'}</span></p>`}
        ${s.keyError && html`<p class="acct-msg danger" role="alert" data-state="key-error"><${Icon} name="alert" size=${14} /><span>${s.keyError}</span></p>`}
        ${reason && html`<p class="acct-msg warn" role="alert" data-state="not-ready"><${Icon} name="alert" size=${14} /><span>${reason}</span></p>`}
        ${!keyMode && st.usageLimits === false && html`<p class="acct-note" data-state="no-limits"><${Icon} name="info" size=${14} /><span>No 5-hour or weekly usage limits with this sign-in${cc && cc.methodLabel ? ` (${cc.methodLabel})` : ''}: it is billed per token.</span></p>`}
      </div>

      <div class="acct-sec">
        <span class="acct-label">${keyMode ? "Claude Code's own sign-in (used if you remove the key)" : "Claude Code's sign-in"}</span>
        ${cc ? html`<${ClaudeCodeWho} cc=${cc} />`
          : html`<p class="acct-msg warn" data-state="old-host"><${Icon} name="alert" size=${14} /><span>Helm's host is older than this window, so it did not report Claude Code's sign-in. Restart Helm so the host and this window match.</span></p>`}
        ${cc && html`<div class="acct-actions">
          <button class="btn btn-sm" data-act="acct-check" disabled=${ccChecking} onClick=${check}><${Icon} name="refresh" size=${13} />${ccChecking ? 'Checking…' : 'Check again'}</button>
        </div>`}
        ${err && err.where === 'check' && html`<p class="acct-msg danger" role="alert" data-state="check-error"><${Icon} name="alert" size=${14} /><span>${err.text}</span></p>`}
      </div>

      <div class="acct-sec">
        <form class="acct-code acct-keyform" onSubmit=${save}>
          <label for="acct-key-in">${keyMode ? 'Replace the key with a new one' : 'Use an API key instead'}</label>
          <div class="acct-code-row">
            <input id="acct-key-in" type="password" class="input mono" data-act="acct-key-input" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"
              placeholder="Paste an Anthropic API key" value=${key} disabled=${busy === 'save'} onInput=${(e) => { setKey(e.currentTarget.value); if (err) setErr(null); }} />
            <button class="btn btn-primary btn-sm" type="submit" data-act="acct-key-save" disabled=${!key.trim() || !!busy}>${busy === 'save' ? 'Saving…' : keyMode ? 'Replace key' : 'Save key'}</button>
          </div>
          ${err && err.where === 'key' && html`<p class="acct-msg danger" role="alert" data-state="key-save-error"><${Icon} name="alert" size=${14} /><span>${err.text}</span></p>`}
        </form>
        <p class="acct-note acct-keyhint"><${Icon} name="lock" size=${14} /><span>A key saved here stays on this PC, in Helm's profile, and goes only to the Claude Code processes Helm starts. Usage is billed to that key's Anthropic Console account. <a href=${CONSOLE_KEYS} target="_blank" rel="noopener noreferrer" data-act="acct-key-console">Get a key in the Anthropic Console</a></span></p>
        ${keyMode && (clearAsk
          ? html`<div class="acct-keyclear" role="group" aria-label="Remove the saved key">
              <p class="acct-confirm-p">Remove the saved key and use Claude Code's sign-in? Running sessions restart onto it.</p>
              <div class="acct-actions">
                <button class="btn btn-ghost btn-sm" data-act="acct-key-clear-cancel" disabled=${busy === 'clear'} onClick=${() => setClearAsk(false)}>Cancel</button>
                <button class="btn btn-danger btn-sm" data-act="acct-key-clear-confirm" disabled=${busy === 'clear'} onClick=${clear}>${busy === 'clear' ? 'Removing…' : 'Remove key'}</button>
              </div>
            </div>`
          : html`<div class="acct-actions">
              <button class="btn btn-sm acct-signout" data-act="acct-key-clear" disabled=${!saved || !!busy}
                title=${saved ? "Remove the key saved in Helm and use Claude Code's sign-in" : 'No key is saved in Helm, so there is nothing to remove here'} onClick=${() => setClearAsk(true)}>Remove key and use Claude Code's sign-in</button>
            </div>`)}
        ${err && err.where === 'clear' && html`<p class="acct-msg danger" role="alert" data-state="key-clear-error"><${Icon} name="alert" size=${14} /><span>${err.text}</span></p>`}
      </div>
    </div>
    <${RestartNote} restart=${st.restart} what=${keyMode ? 'with the new key' : "onto Claude Code's sign-in"} />
  </div>`;
}
