'use strict';
// Production guard (lane guard). A PreToolUse hook (Agent SDK callback) that makes a Claude session
// stop and ask the user before it
//   (a) git-pushes a protected branch of a protected repo (e.g. `main` of the repo that is production),
//   (b) git-pushes anything from a repo protected on every branch,
//   (c) runs a Railway deploy action: `railway up | redeploy | restart | down | deploy`, on any
//       project, or a Railway MCP tool whose name says deploy / redeploy / restart / up / down / remove.
// It works in every permission mode, bypassPermissions included: a PreToolUse hook runs before the
// mode is consulted (verified live, see docs/PROTOCOL.md "Production guard").
//
// Protected repos are the user's own list in <userDataDir>/prod-guard.json, beside settings.json
// (example: docs/prod-guard.example.json):
//   {"repos":[{"name":"My App","remotes":["github.com/your-org/your-app"],"branches":["main"]},
//             {"name":"Client Portal","remotes":["git@github.com:your-org/client-portal.git"],"branches":null}]}
// `remotes`: any URL form (see normalizeRemote). `branches`: only pushes to these ask; null, missing or []
// = every push from that repo asks. `id` is optional (default: the name, lower case, dashes). The file is
// read lazily and re-read when it changes. MISSING = nothing protected (logged once), so the public default
// asks only before Railway deploys. UNREADABLE (bad JSON, wrong shape, a read error) fails CLOSED: every
// push asks and every worktree merge is refused until it is fixed, and each session shows a warning line
// with the reason (never thrown). It is a file of its own, not a
// settings.json key, because Helm rewrites settings.json from memory and never touches this one.
// `prodGuard: false` in settings.json still turns the whole guard (Railway included) off.
//
// Repos are identified by REMOTE URL (any form: https, ssh, scp-like, with or without .git), never
// by folder name. Pushes in every other repo stay automatic.
//
// What the command scanner catches (Bash, PowerShell and Monitor tool calls):
//   - `git push`, `git -C <dir> push`, `git --git-dir=… push`, `hub push`, a full path to git(.exe)
//   - chains and nesting: ; && || | & newlines, ( subshells ), { groups }, $( … ), `…`, <( … ),
//     if/then/do/for/while bodies, PowerShell { } blocks, $( ) and @( ) subexpressions, here-strings
//   - the folder: `cd`, `pushd`/`popd`, `Set-Location`/`sl`/`Push-Location`/`Pop-Location`
//     (sequentially, scoped to bash subshells), then -C, then the session's current folder
//   - wrappers: VAR=x, env, command, builtin, exec, nohup, sudo, time, timeout, nice, xargs,
//     winpty, call, `railway run …`
//   - re-entry: bash/sh/zsh -c "…", heredocs and <<< strings fed to a shell, `… | bash`,
//     powershell/pwsh -Command / -EncodedCommand, cmd /c, Invoke-Expression/iex, eval,
//     Start-Process git -ArgumentList …, wsl …
//   - git aliases (`git p` where alias.p = push, or a `!sh` alias that pushes), looked up in the repo
//   - Railway through npx / bunx / pnpm dlx / yarn dlx / npm exec (@railway/cli)
//   - gh writes that ship: `gh pr merge` (into a guarded base branch, looked up with `gh pr view`),
//     `gh release create` (not --draft), `gh release edit --draft=false`, `gh repo sync <repo>`, and
//     `gh api` writes (-X POST/PUT/PATCH/DELETE, or -f/-F fields) to refs, merges, contents, pull
//     merges, releases, workflow dispatches, merge-upstream, branch renames, or GraphQL ref / merge
//     mutations. The repo: -R, GH_REPO=, a PR URL, the endpoint, else the folder's remotes. Reads
//     (pr view / list / checks, api GETs) and issues / comments are never guarded.
//   - local scripts, read and scanned with these same rules: `./deploy.sh`, `bash x.sh`, `source`,
//     `.\ship.ps1`, `powershell -File`, `cmd /c x.bat`, `node x.js` / `node -e`, a `#!` file, and
//     `npm run x` / `npm test` / `pnpm x` / `yarn x` / `bun run x` (the package.json script plus its
//     pre / post). JavaScript is read for command-line strings and spawn('git', [...]) arrays.
//     A JS git call whose subcommand is only known at run time (git(dir, [...args])) counts as a
//     possible push only if "push" appears as a word in the script other than as a method (.push()),
//     in the command's own words, or the folder it runs in is a protected repo. `node --check` / `-c`
//     only parses the file, so it is not followed.
//     Bounded: MAX_SCRIPT_LEVEL files deep (the script run + one it calls), MAX_SCRIPT_BYTES each,
//     MAX_SCRIPT_READS per call. A script that cannot be read (too big, too deep, path built at run
//     time, unreadable, a workspace filter) asks ONLY if the command itself names a protected repo or
//     branch (its id, name, repo name or a protected branch); otherwise it runs. A missing script is not guarded
//     (the command fails). A script's own folder ($0, BASH_SOURCE, $PSScriptRoot, %~dp0) is resolved.
// What it does NOT catch: a command assembled at run time from variables, Python / Makefile / other
// interpreters' scripts, a JS script whose spawn sets its own `cwd` (judged in the caller's folder),
// pushes made by other programs (IDEs, GitHub Desktop), and anything that does not go through a
// Claude tool call. `git push --dry-run` / `-n` is NOT guarded: it changes nothing on the remote.
//
// Waiting: the hook shows a request card (sessions.respond answers it) and blocks until the user picks
// "Allow once" or "Deny", for at most WAIT_MS; then it denies. The CLI's own hook timeout is set just
// past that, and a CLI-side hook timeout also refuses the tool call (verified). Any error in the
// guard denies (a thrown hook error would let the tool run, so the hook never throws).
//
// Prior approval: if the last prompt the user TYPED in the session (desktop, phone, quick prompt, queue)
// already said to push / ship / deploy / redeploy / go live / release (not negated, not a question),
// or was a short "yes / go ahead / do it" right after Claude asked about pushing, the guard lets the
// call through with no card and adds a visible line instead. Helm-generated sends (origin: 'helm')
// never count and never reset it. See promptApproval().

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const WAIT_MS = 30 * 60 * 1000;                     // the user's window to answer a card; then denied
const HOOK_TIMEOUT_S = Math.ceil(WAIT_MS / 1000) + 60; // the CLI's limit for the hook, just past ours
const GIT_TIMEOUT_MS = 8000;
const MAX_DEPTH = 4;                                  // nested -c / eval / alias levels we follow
const MAX_SCRIPT_LEVEL = 2;                           // script files read: the one run + one it calls
const MAX_SCRIPT_BYTES = 256 * 1024;                  // bigger script files are not read
const MAX_SCRIPT_READS = 12;                          // files read per tool call
const SCRIPT_EXT_RE = /\.(sh|bash|zsh|ps1|psm1|cmd|bat|js|mjs|cjs|ts|mts|cts)$/i;
// "push" as a word, except as a method call (arr.push(x), a?.push(x)): 'push', "push", `git push`,
// const push = …, a comment. Over-matching only means asking, so this errs towards asking.
const PUSH_WORD_RE = /(?<![\w$]|\.\s*)push(?![\w$])/i;
const PUSH_ARG_RE = /(?<![\w$])push(?![\w$])/i; // a command word that mentions push (node x.js push)

const CONFIG_FILE = 'prod-guard.json'; // <userDataDir>/prod-guard.json: the protected repos (header)
const RAILWAY_SUBS = new Set(['up', 'redeploy', 'restart', 'down', 'deploy']);
const RAILWAY_MCP_RE = /(^|[-_.])(deploy|redeploy|restart|up|down|remove|delete|rollback)([-_.]|$)/i;

// ---------- remotes ----------
// "https://user:tok@GitHub.com/Your-Org/app.git/" | "git@github.com:Your-Org/app" |
// "ssh://git@github.com/Your-Org/app.git" → "github.com/your-org/app"; a local path →
// its absolute path, forward slashes, lower case, no trailing ".git".
function normalizeRemote(url) {
  let u = String(url || '').trim();
  if (!u) return '';
  u = u.replace(/^git\+/, '');
  if (/^file:\/\//i.test(u)) u = decodeURIComponent(u.replace(/^file:\/\/\/?/i, ''));
  else {
    let m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:]+)(?::\d+)?\/(.*)$/i.exec(u);
    if (m) return `${m[1]}/${m[2]}`.toLowerCase().replace(/\/+$/, '').replace(/\.git$/, '');
    m = /^(?:[^@/\\]+@)?([^/\\:]{2,}):(?!\\)(.+)$/.exec(u); // scp-like (a drive letter "C:" is one char)
    if (m) return `${m[1]}/${m[2]}`.toLowerCase().replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/, '');
  }
  const gb = /^\/([a-z])(\/.*)?$/i.exec(u); // Git Bash /c/…
  if (gb) u = `${gb[1]}:${gb[2] || '/'}`;
  return path.resolve(u).replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '').replace(/\.git$/, '');
}

// ---------- protected repos (prod-guard.json) ----------
// A config remote: a bare "github.com/your-org/app" (no scheme, no user@) is a URL, not a relative folder;
// every other form goes through normalizeRemote like the remotes git reports.
function configRemote(url) {
  const u = String(url || '').trim();
  if (/^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?\/[^\\]+$/i.test(u)) {
    return u.replace(/^([^/]+?):\d+\//, '$1/').toLowerCase().replace(/\/+$/, '').replace(/\.git$/, '');
  }
  return normalizeRemote(u);
}
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// {"repos":[{ name, remotes, branches?, id? }]} → [{ id, name, remotes: [key], branches: [..] | null }].
// Entries without a usable remote are skipped; `branches` null / missing / [] = every push is guarded.
function parseConfig(j) {
  if (!j || typeof j !== 'object' || !Array.isArray(j.repos)) throw new Error('expected {"repos": [...]}');
  const out = [];
  for (const r of j.repos) {
    if (!r || typeof r !== 'object') continue;
    const remotes = [...new Set([].concat(r.remotes || r.remote || []).filter((u) => typeof u === 'string' && u.trim()).map(configRemote).filter(Boolean))];
    if (!remotes.length) continue;
    const name = typeof r.name === 'string' && r.name.trim() ? r.name.trim() : remotes[0].split('/').pop();
    let id = slug(typeof r.id === 'string' && r.id.trim() ? r.id : name) || `repo-${out.length + 1}`;
    while (out.some((t) => t.id === id)) id += '-2';
    const br = Array.isArray(r.branches) ? [...new Set(r.branches.filter((b) => typeof b === 'string' && b.trim()).map((b) => b.trim().replace(/^refs\/heads\//, '')))] : [];
    out.push(Object.freeze({ id, name, remotes: Object.freeze(remotes), branches: br.length ? Object.freeze(br) : null }));
  }
  return Object.freeze(out);
}

// An unreadable prod-guard.json fails CLOSED: the list is this one stand-in, which every repo matches
// (targetFor), so every push asks; `why` is the reason shown to the user.
function unreadableTarget(file, why) {
  return Object.freeze({ id: 'prod-guard-unreadable', name: 'any repo (prod-guard.json is unreadable)', remotes: Object.freeze([]), branches: null, all: true, file, why });
}

// One cached read of <userDataDir>/prod-guard.json, re-read when its mtime or size changes. A missing file
// is an empty list; an unreadable one is [unreadableTarget]. The note goes to the log once (the first
// caller that has a logger).
let configCache = { file: null, key: null, list: Object.freeze([]), note: null, logged: true, status: null };
function configured(userDataDir, log) {
  if (!userDataDir) return Object.freeze([]);
  const file = path.join(userDataDir, CONFIG_FILE);
  let key;
  try { const s = fs.statSync(file); key = `${s.mtimeMs}:${s.size}`; } catch { key = 'missing'; }
  if (configCache.file !== file || configCache.key !== key) {
    let list = Object.freeze([]);
    let note;
    let status = { state: 'missing', file, why: null, count: 0 };
    if (key === 'missing') note = `prod-guard: no ${file}, so no repos are protected (Railway deploys still ask)`;
    else {
      try {
        list = parseConfig(JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')));
        note = `prod-guard: ${list.length} protected repo${list.length === 1 ? '' : 's'} from ${file}` +
          (list.length ? `: ${list.map((t) => `${t.name} (${t.branches ? t.branches.join(', ') : 'every push'})`).join(', ')}` : '');
        status = { state: 'ok', file, why: null, count: list.length };
      } catch (e) {
        list = Object.freeze([unreadableTarget(file, e.message)]);
        note = `prod-guard: could not read ${file} (${e.message}), so EVERY push asks until it is fixed (fail closed)`;
        status = { state: 'unreadable', file, why: e.message, count: 0 };
      }
    }
    configCache = { file, key, list, note, logged: false, status: Object.freeze({ ...status, key: `${file}|${key}` }) };
  }
  if (!configCache.logged && typeof log === 'function') {
    configCache.logged = true;
    try { log(/could not read/.test(configCache.note) ? 'warn' : 'info', configCache.note); } catch {}
  }
  return configCache.list;
}

// What prod-guard.json means right now, for warnings and settings: { state: 'none' (no data folder) |
// 'missing' | 'ok' | 'unreadable', file, why, count, key }.
function configStatus(userDataDir) {
  if (!userDataDir) return { state: 'none', file: null, why: null, count: 0, key: 'none' };
  configured(userDataDir);
  return configCache.status;
}

// The protected repos: prod-guard.json in userDataDir, plus test-only additions from
// HELM_TEST_PROD_GUARD, honoured only in a --test instance (a normal Helm runs without --test):
//   {"repos":[{ name, remotes, branches }]} appends repos (prod-guard.json's shape), and
//   {"<id or name>":["<url>", ...]} adds remotes to a configured repo.
function targets(userDataDir, { env = process.env, argv = process.argv, log } = {}) {
  const base = configured(userDataDir, log);
  const raw = env.HELM_TEST_PROD_GUARD;
  if (!raw || !argv.includes('--test')) return base;
  const out = base.map((t) => ({ ...t, remotes: [...t.remotes] }));
  try {
    const add = JSON.parse(raw);
    for (const [k, v] of Object.entries(add || {})) {
      if (k === 'repos') continue;
      const t = out.find((x) => x.id === slug(k) || slug(x.name) === slug(k));
      if (t) for (const u of [].concat(v || [])) if (typeof u === 'string' && u) t.remotes.push(configRemote(u));
    }
    if (Array.isArray(add && add.repos)) {
      for (const t of parseConfig({ repos: add.repos })) out.push(out.some((x) => x.id === t.id) ? { ...t, id: `${t.id}-test` } : t);
    }
  } catch {}
  return out;
}

function targetFor(urls, list) {
  const norm = urls.map(normalizeRemote).filter(Boolean);
  return list.find((t) => t.remotes.some((r) => norm.includes(r))) || list.find((t) => t.all) || null; // t.remotes are already keys; t.all = unreadable file
}

// ---------- shell scanning ----------
// scan(src, 'bash' | 'ps') → events: { type: 'cmd', words: [{ t, dyn, q }], heredocs: [string], pipe }
// | { type: 'open' } | { type: 'close' } (bash subshell scope). Nested $( ) / backticks / @( ) come
// out as their own commands, before the command that contains them (they run first). `dyn` marks a
// word built from a variable or substitution; `q` a word that was quoted.
function scan(src, dialect) {
  const s = String(src || '');
  const n = s.length;
  const ps = dialect === 'ps';
  const events = [];
  let i = 0;
  const newCmd = (pipe) => ({ type: 'cmd', words: [], heredocs: [], pipe: !!pipe });

  function nested(text, d) {
    for (const ev of scan(text, d)) events.push(ev);
  }

  function parseSeq(stop) {
    let cmd = newCmd(false);
    let cur = null;
    let dyn = false;
    let quoted = false;
    let qAt = -1;           // where quoting began in the current word (FOO="a b" is still an assignment)
    let redirect = false;
    let hereString = false;
    let heredocWant = null; // { strip } while waiting for the delimiter word
    const heredocs = [];    // [{ delim, strip, cmd }] bodies read after the next newline

    const pushWord = () => {
      if (cur === null) return;
      const w = { t: cur, dyn, q: quoted, qAt: quoted ? qAt : -1 };
      cur = null;
      dyn = false;
      quoted = false;
      if (heredocWant) { heredocs.push({ delim: w.t, strip: heredocWant.strip, cmd }); heredocWant = null; return; }
      if (hereString) { hereString = false; cmd.heredocs.push(w.t); return; }
      if (redirect) { redirect = false; return; }
      cmd.words.push(w);
    };
    const endCmd = (pipe) => {
      pushWord();
      if (cmd.words.length || cmd.heredocs.length) events.push(cmd);
      cmd = newCmd(pipe);
    };
    const readHeredocs = () => {
      while (heredocs.length) {
        const h = heredocs.shift();
        const lines = [];
        while (i < n) {
          let e = s.indexOf('\n', i);
          if (e < 0) e = n;
          let line = s.slice(i, e).replace(/\r$/, '');
          i = e + 1;
          if ((h.strip ? line.replace(/^\t+/, '') : line) === h.delim) break;
          lines.push(line);
        }
        h.cmd.heredocs.push(lines.join('\n'));
      }
    };
    const readDouble = () => {
      let t = '';
      while (i < n) {
        const c = s[i];
        if (c === '"') {
          if (ps && s[i + 1] === '"') { t += '"'; i += 2; continue; }
          i++;
          return t;
        }
        if (!ps && c === '\\' && i + 1 < n) {
          const d = s[i + 1];
          if (d === '\n') { i += 2; continue; }
          if ('$`"\\'.includes(d)) { t += d; i += 2; continue; }
          t += c; i++; continue;
        }
        if (ps && c === '`' && i + 1 < n) { t += s[i + 1]; i += 2; continue; }
        if (c === '$' && s[i + 1] === '(') { i += 2; parseSeq(')'); t += '\u0000'; dyn = true; continue; }
        if (!ps && c === '`') {
          const e = closeBacktick(i + 1);
          nested(s.slice(i + 1, e), 'bash');
          i = e + 1;
          t += '\u0000';
          dyn = true;
          continue;
        }
        if (c === '$' && /[A-Za-z_{@*#?!$0-9]/.test(s[i + 1] || '')) dyn = true;
        t += c;
        i++;
      }
      return t;
    };
    const closeBacktick = (from) => {
      let k = from;
      while (k < n && s[k] !== '`') k += s[k] === '\\' ? 2 : 1;
      return Math.min(k, n);
    };

    while (i < n) {
      const c = s[i];
      if (c === ' ' || c === '\t' || c === '\r' || (ps && c === ',')) { pushWord(); i++; continue; }
      if (c === '\n') { endCmd(false); i++; readHeredocs(); continue; }
      if (c === '#' && cur === null) { while (i < n && s[i] !== '\n') i++; continue; }
      if (ps && c === '<' && s[i + 1] === '#') { const e = s.indexOf('#>', i + 2); i = e < 0 ? n : e + 2; continue; }
      if (c === ')') { endCmd(false); i++; if (stop === ')') return; continue; }
      if (c === '(') {
        endCmd(false);
        i++;
        if (!ps) events.push({ type: 'open' });
        parseSeq(')');
        if (!ps) events.push({ type: 'close' });
        continue;
      }
      if (c === '{' || c === '}') {
        if (ps || cur === null) { endCmd(false); i++; continue; }
        cur += c; i++; continue; // bash brace expansion inside a word
      }
      if (c === ';') { endCmd(false); i++; continue; }
      if (c === '&') {
        if (s[i + 1] === '&') { endCmd(false); i += 2; continue; }
        if (!ps && s[i + 1] === '>') { pushWord(); i += s[i + 2] === '>' ? 3 : 2; redirect = true; continue; }
        if (ps && cur === null && !cmd.words.length) { i++; continue; } // call operator
        endCmd(false); i++; continue;
      }
      if (c === '|') {
        if (s[i + 1] === '|') { endCmd(false); i += 2; continue; }
        endCmd(true);
        i += !ps && s[i + 1] === '&' ? 2 : 1;
        continue;
      }
      if (c === '>' || c === '<') {
        if (!ps && s[i + 1] === '(') {
          pushWord();
          i += 2;
          events.push({ type: 'open' });
          parseSeq(')');
          events.push({ type: 'close' });
          continue;
        }
        if (cur !== null && !quoted && /^(\d+|\*)$/.test(cur)) { cur = null; dyn = false; } else pushWord();
        if (!ps && c === '<' && s[i + 1] === '<') {
          if (s[i + 2] === '<') { i += 3; hereString = true; continue; }
          i += 2;
          let strip = false;
          if (s[i] === '-') { strip = true; i++; }
          heredocWant = { strip };
          continue;
        }
        i++;
        if (s[i] === '>' || s[i] === '|') i++;
        if (s[i] === '&') {
          i++;
          if (/[\d-]/.test(s[i] || '')) { while (/[\d-]/.test(s[i] || '')) i++; continue; }
        }
        redirect = true;
        continue;
      }
      if (c === "'") {
        i++;
        let t = '';
        if (ps) {
          while (i < n) {
            if (s[i] === "'") { if (s[i + 1] === "'") { t += "'"; i += 2; continue; } i++; break; }
            t += s[i++];
          }
        } else {
          const e = s.indexOf("'", i);
          t = e < 0 ? s.slice(i) : s.slice(i, e);
          i = e < 0 ? n : e + 1;
        }
        if (!quoted) qAt = (cur || '').length; cur = (cur || '') + t;
        quoted = true;
        continue;
      }
      if (c === '"') { i++; const t = readDouble(); if (!quoted) qAt = (cur || '').length; cur = (cur || '') + t; quoted = true; continue; }
      if (ps && c === '@' && (s[i + 1] === '"' || s[i + 1] === "'") && /^\r?\n/.test(s.slice(i + 2, i + 4))) {
        const q = s[i + 1];
        const start = s.indexOf('\n', i) + 1;
        const re = new RegExp(`\\r?\\n${q}@`, 'g');
        re.lastIndex = start - 1;
        const m = re.exec(s);
        const body = m ? s.slice(start, m.index) : s.slice(start);
        i = m ? m.index + m[0].length : n;
        if (q === '"' && /\$\(/.test(body)) { nested(body.replace(/^[^]*?\$\(/, ''), 'ps'); dyn = true; }
        if (!quoted) qAt = (cur || '').length; cur = (cur || '') + body;
        quoted = true;
        continue;
      }
      if (c === '$') {
        if (s[i + 1] === '(') { i += 2; parseSeq(')'); cur = (cur || '') + '\u0000'; dyn = true; continue; }
        if (!ps && s[i + 1] === "'") { // $'…' ANSI-C quoting
          i += 2;
          let t = '';
          while (i < n && s[i] !== "'") { if (s[i] === '\\' && i + 1 < n) { t += s[i + 1]; i += 2; continue; } t += s[i++]; }
          i++;
          if (!quoted) qAt = (cur || '').length; cur = (cur || '') + t;
          quoted = true;
          continue;
        }
        if (/[A-Za-z_{@*#?!$0-9]/.test(s[i + 1] || '')) dyn = true;
        cur = (cur || '') + c;
        i++;
        continue;
      }
      if (ps && c === '@' && s[i + 1] === '(') { i += 2; parseSeq(')'); cur = (cur || '') + '\u0000'; dyn = true; continue; }
      if (c === '`') {
        if (ps) {
          if (s[i + 1] === '\n') { i += 2; continue; }
          if (s[i + 1] === '\r' && s[i + 2] === '\n') { i += 3; continue; }
          cur = (cur || '') + (s[i + 1] || '');
          i += 2;
          continue;
        }
        const e = closeBacktick(i + 1);
        nested(s.slice(i + 1, e), 'bash');
        i = e + 1;
        cur = (cur || '') + '\u0000';
        dyn = true;
        continue;
      }
      if (!ps && c === '\\') {
        if (s[i + 1] === '\n') { i += 2; continue; }
        if (s[i + 1] === '\r' && s[i + 2] === '\n') { i += 3; continue; }
        cur = (cur || '') + (s[i + 1] || '');
        i += 2;
        continue;
      }
      cur = (cur || '') + c;
      i++;
    }
    endCmd(false);
    readHeredocs();
  }

  parseSeq(null);
  return events;
}

// ---------- commands → actions ----------
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', 'for', 'case', 'esac', '!', '{', '}', 'function', 'select', 'elseif', 'foreach', 'try', 'catch', 'finally', 'switch', 'trap', 'begin', 'process', 'end']);
const WRAPPERS = new Set(['command', 'builtin', 'exec', 'nohup', 'sudo', 'winpty', 'time', 'stdbuf', 'unbuffer', 'call']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'git-bash']);
const POWERSHELLS = new Set(['powershell', 'pwsh', 'powershell_ise']);
const CD = new Set(['cd', 'chdir', 'set-location', 'sl', 'pushd', 'push-location']);
const POPD = new Set(['popd', 'pop-location']);
// git subcommands that are not pushes (anything else may be an alias and is looked up)
const KNOWN_GIT = new Set(('add am annotate apply archive bisect blame branch bundle cat-file check-attr check-ignore check-mailmap '
  + 'check-ref-format checkout checkout-index cherry cherry-pick citool clean clone column commit commit-graph commit-tree config '
  + 'count-objects credential daemon describe diff diff-files diff-index diff-tree difftool fast-export fast-import fetch fetch-pack '
  + 'filter-branch fmt-merge-msg for-each-ref for-each-repo format-patch fsck gc get-tar-commit-id grep gui hash-object help '
  + 'http-backend index-pack init instaweb interpret-trailers lfs log ls-files ls-remote ls-tree mailinfo mailsplit maintenance '
  + 'merge merge-base merge-file merge-index merge-tree mergetool mktag mktree multi-pack-index mv name-rev notes pack-objects '
  + 'pack-refs prune prune-packed pull range-diff read-tree rebase reflog remote repack replace request-pull rerere reset restore '
  + 'rev-list rev-parse revert rm send-email shortlog show show-branch show-index show-ref sparse-checkout stage stash status '
  + 'stripspace submodule switch symbolic-ref tag unpack-file unpack-objects update-index update-ref update-server-info var '
  + 'verify-commit verify-pack verify-tag version whatchanged worktree write-tree backfill replay').split(/\s+/));

const cmdName = (t) => {
  const b = String(t || '').replace(/\\/g, '/').split('/').pop().toLowerCase();
  return b.replace(/\.(exe|cmd|bat|com|ps1)$/, '');
};
const word = (t) => ({ t, dyn: false, q: false });

// NAME=value (bash): unquoted, or quoted only after the "=" (FOO="a b"); "FOO=x" is a command name
const isAssign = (w) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w.t) && (!w.q || (w.qAt > 0 && /=/.test(w.t.slice(0, w.qAt))));

function stripPrefix(words, dialect) {
  let k = 0;
  for (;;) {
    const w = words[k];
    if (!w) break;
    const low = w.t.toLowerCase();
    if (dialect === 'bash' && isAssign(w)) { k++; continue; }
    if (!w.q && KEYWORDS.has(low)) { k++; continue; }
    const nm = cmdName(w.t);
    if (nm === 'env') {
      k++;
      while (words[k] && (words[k].t.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[k].t))) {
        if (/^(-u|-C|-S|--unset|--chdir)$/.test(words[k].t)) k++;
        k++;
      }
      continue;
    }
    if (WRAPPERS.has(nm)) { k++; while (words[k] && /^-./.test(words[k].t)) k++; continue; }
    if (nm === 'nice') { k++; if (words[k] && words[k].t === '-n') k += 2; else while (words[k] && /^-./.test(words[k].t)) k++; continue; }
    if (nm === 'timeout') {
      k++;
      while (words[k] && /^-./.test(words[k].t)) { if (/^(-s|-k|--signal|--kill-after)$/.test(words[k].t)) k++; k++; }
      k++; // duration
      continue;
    }
    if (nm === 'xargs') {
      k++;
      while (words[k] && /^-./.test(words[k].t)) { if (/^-[IinLPdaEs]$/.test(words[k].t)) k++; k++; }
      continue;
    }
    break;
  }
  return words.slice(k);
}

function expandPath(w, base, home) {
  if (!w) return null;
  let t = w.t;
  if (w.dyn) {
    t = t.replace(/\$\{?(HOME|USERPROFILE)\}?|\$env:(USERPROFILE|HOME)/gi, () => home)
      .replace(/\$\{?PWD\}?/gi, () => (base == null ? '\u0000' : base));
    if (/\$|\u0000/.test(t)) return null;
  }
  if (t === '~' || /^~[\\/]/.test(t)) t = home + t.slice(1);
  const gb = /^\/([a-zA-Z])(\/.*)?$/.exec(t);
  if (gb) t = `${gb[1].toUpperCase()}:${gb[2] || '/'}`;
  if (/^[a-zA-Z]:/.test(t)) return path.resolve(t);
  if (base == null) return null;
  return path.resolve(base, t);
}

// Walk one script: returns actions [{ kind: 'git', dir, words } | { kind: 'railway', sub, raw } |
// { kind: 'gitAlias', dir, sub, args }]. `dir` null = could not tell which folder.
function collect(src, dialect, cwd, home, out, depth, ctx) {
  if (depth > MAX_DEPTH) return out;
  ctx = ctx || { level: 0, via: null, reads: { n: 0 } };
  const events = scan(src, dialect);
  let dir = cwd;
  const scopes = [];
  const dirStack = [];
  let prev = null;
  let argPush = false; // the command being handled mentions push in its own words (node x.js push)
  const handle = (ev, words) => {
    const ghEnv = words.find((w) => isAssign(w) && /^GH_REPO=/.test(w.t));
    argPush = words.some((w) => PUSH_ARG_RE.test(w.t));
    words = stripPrefix(words, dialect);
    if (!words.length) {
      if (ev.heredocs.length && prev) {} // a bare redirect: nothing runs
      return;
    }
    const nm = cmdName(words[0].t);
    const args = words.slice(1);
    if (CD.has(nm)) {
      const pos = [];
      for (let k = 0; k < args.length; k++) {
        const a = args[k];
        if (/^-(path|literalpath)$/i.test(a.t)) { if (args[k + 1]) pos.push(args[k + 1]); k++; continue; }
        if (/^-(stackname)$/i.test(a.t)) { k++; continue; }
        if (/^(-[LPe@]+|\/d|-passthru)$/i.test(a.t)) continue;
        pos.push(a);
      }
      if (nm === 'pushd' || nm === 'push-location') dirStack.push(dir);
      if (!pos.length) { if (nm === 'cd' && dialect === 'bash') dir = home; return; }
      dir = pos[0].t === '-' ? null : expandPath(pos[0], dir, home);
      return;
    }
    if (POPD.has(nm)) { dir = dirStack.length ? dirStack.pop() : null; return; }
    if (nm === 'git' || nm === 'hub') {
      const s0 = out.length;
      gitAction(args, dir, home, out);
      // A run-time subcommand in a JS script that never says push: judged by its folders only (see assess).
      if (ctx.jsPushFree) for (let j = s0; j < out.length; j++) if (out[j].unknownSub) { out[j].jsHole = true; out[j].runDir = ctx.jsRunDir; }
      return;
    }
    if (nm === 'gh') { ghAction(args, dir, out, ghEnv ? ghEnv.t.slice(8) : null); return; }
    if (nm === 'railway') { railwayAction(args, out, (rest) => handle({ heredocs: [], pipe: false }, rest)); return; }
    if (['npm', 'pnpm', 'yarn', 'bun'].includes(nm) && !(args[0] && ['dlx', 'exec', 'x'].includes(args[0].t))) {
      runPackageScript(nm, args);
      return;
    }
    if (nm === 'node' || nm === 'tsx' || nm === 'ts-node') {
      let checkOnly = false; // node --check / -c x.js parses the file and never runs it
      for (let k = 0; k < args.length; k++) {
        const a = args[k].t;
        if (nm === 'node' && !args[k].dyn && (a === '--check' || a === '-c')) { checkOnly = true; continue; }
        if (/^(-e|--eval|-p|--print)$/.test(a)) { scanText(args[k + 1] ? args[k + 1].t : '', 'js', dir, `${nm} ${a}`, null); return; }
        if (/^(-r|--require|--import|--loader|--experimental-loader|-C|--conditions|--env-file|--title|--input-type)$/.test(a)) { k++; continue; }
        if (/^-/.test(a)) continue;
        if (!checkOnly) runScriptFile(args[k], 'js');
        return;
      }
      return;
    }
    if (nm === 'source' || nm === '.') { if (args[0]) runScriptFile(args[0], dialect === 'ps' ? 'ps' : 'bash'); return; }
    if (['npx', 'bunx', 'pnpx'].includes(nm) || (['pnpm', 'yarn', 'npm', 'bun'].includes(nm) && args[0] && ['dlx', 'exec', 'x'].includes(args[0].t))) {
      const rest = ['npx', 'bunx', 'pnpx'].includes(nm) ? args : args.slice(1);
      let k = 0;
      while (rest[k] && /^-/.test(rest[k].t)) { if (/^(-p|--package)$/.test(rest[k].t)) k++; k++; }
      if (rest[k] && /(^|\/)(@railway\/cli|railway)(@[^/]*)?$/i.test(rest[k].t)) railwayAction(rest.slice(k + 1), out, null);
      return;
    }
    if (SHELLS.has(nm)) {
      let script = null;
      let file = null;
      for (let k = 0; k < args.length; k++) {
        const a = args[k].t;
        if (/^-[A-Za-z]*c[A-Za-z]*$/.test(a)) { script = args[k + 1] ? args[k + 1].t : ''; break; }
        if (/^-/.test(a)) { if (/^(-o|\+o|--rcfile|--init-file)$/.test(a)) k++; continue; }
        file = args[k];
        break;
      }
      if (script !== null) collect(script, 'bash', dir, home, out, depth + 1, ctx);
      else if (file) runScriptFile(file, 'bash');
      else stdinScripts(ev, 'bash');
      return;
    }
    if (POWERSHELLS.has(nm)) {
      for (let k = 0; k < args.length; k++) {
        const a = args[k].t;
        if (/^[-/](c|co|com|comm|comma|comman|command)$/i.test(a)) {
          const rest = args.slice(k + 1);
          if (rest.length === 1 && rest[0].t === '-') stdinScripts(ev, 'ps');
          else collect(rest.map((x) => x.t).join(' '), 'ps', dir, home, out, depth + 1, ctx);
          return;
        }
        if (/^[-/](e|ec|en|enc|enco|encod|encode|encoded|encodedc\w*)$/i.test(a)) {
          try { collect(Buffer.from(String(args[k + 1] ? args[k + 1].t : ''), 'base64').toString('utf16le'), 'ps', dir, home, out, depth + 1, ctx); } catch {}
          return;
        }
        if (/^[-/](f|fi|fil|file)$/i.test(a)) { if (args[k + 1]) runScriptFile(args[k + 1], 'ps'); return; }
        if (/^[-/](executionpolicy|ep|ex|windowstyle|w|version|v|inputformat|outputformat|of|if|configurationname|workingdirectory|wd|settingsfile)$/i.test(a)) { k++; continue; }
        if (/^[-/]/.test(a)) continue;
        collect(args.slice(k).map((x) => x.t).join(' '), 'ps', dir, home, out, depth + 1, ctx);
        return;
      }
      stdinScripts(ev, 'ps');
      return;
    }
    if (nm === 'cmd') {
      const k = args.findIndex((a) => /^\/[ck]$/i.test(a.t));
      if (k >= 0) collect(args.slice(k + 1).map((x) => x.t).join(' '), 'ps', dir, home, out, depth + 1, ctx);
      return;
    }
    if (nm === 'invoke-expression' || nm === 'iex') {
      const rest = args.filter((a) => !/^-command$/i.test(a.t));
      if (rest.length) collect(rest.map((x) => x.t).join(' '), 'ps', dir, home, out, depth + 1, ctx);
      else stdinScripts(ev, 'ps');
      return;
    }
    if (nm === 'eval' && dialect === 'bash') { collect(args.map((x) => x.t).join(' '), 'bash', dir, home, out, depth + 1, ctx); return; }
    if (nm === 'wsl') {
      let k = 0;
      while (args[k] && /^-/.test(args[k].t)) { if (/^(-d|--distribution|-u|--user|--cd)$/.test(args[k].t)) k++; k++; }
      if (args[k]) handle({ heredocs: [], pipe: false }, args.slice(k));
      return;
    }
    if (nm === 'start-process' || nm === 'saps' || (nm === 'start' && dialect === 'ps')) {
      let file = null;
      let argList = [];
      let wd = null;
      const pos = [];
      for (let k = 0; k < args.length; k++) {
        const a = args[k].t;
        if (/^-(filepath|path)$/i.test(a)) { file = args[++k]; continue; }
        if (/^-(argumentlist|args)$/i.test(a)) { k++; while (args[k] && !/^-[a-z]/i.test(args[k].t)) argList.push(args[k++]); k--; continue; }
        if (/^-workingdirectory$/i.test(a)) { wd = args[++k]; continue; }
        if (/^-/.test(a)) continue;
        pos.push(args[k]);
      }
      if (!file) file = pos.shift();
      if (!argList.length) argList = pos;
      if (!file) return;
      const synth = [word(file.t)];
      for (const a of argList) for (const p of scan(a.t, 'ps').filter((e) => e.type === 'cmd').flatMap((e) => e.words)) synth.push(p);
      const saved = dir;
      if (wd) dir = expandPath(wd, dir, home);
      handle({ heredocs: [], pipe: false }, synth);
      dir = saved;
      return;
    }
    // a local script run by its path: ./deploy.sh, scripts\ship.ps1, cmd /c release.bat, ./bin/ship (#!)
    const w0 = words[0];
    if (!w0.dyn && (SCRIPT_EXT_RE.test(w0.t) || /[\\/]/.test(w0.t))) runScriptFile(w0, null, true);
  };
  // ----- script files and package scripts (read, then scanned with the same rules) -----
  // JavaScript is read best-effort (command-like strings), so what it cannot follow never asks.
  const unread = (label, why) => { if (!ctx.quiet) out.push({ kind: 'scriptUnread', label, why }); };
  // Scan a script's text. Its actions carry `via`: the chain of scripts that led to them.
  // A package.json script is the command itself spelled elsewhere, so it does not use up a level.
  const scanText = (text, kind, runDir, label, file, sameLevel) => {
    const child = { level: ctx.level + (sameLevel ? 0 : 1), via: [...(ctx.via || []), label], reads: ctx.reads, quiet: ctx.quiet || kind === 'js' };
    if (kind === 'js' && !argPush && !PUSH_WORD_RE.test(text)) { child.jsPushFree = true; child.jsRunDir = runDir; }
    const start = out.length;
    if (kind === 'js') for (const c of jsCommands(text)) collect(c, 'bash', runDir, home, out, depth + 1, child);
    else collect(file ? selfPaths(text, file) : text, kind === 'cmd' ? 'ps' : kind, runDir, home, out, depth + 1, child);
    for (let k = start; k < out.length; k++) if (!out[k].via) out[k].via = child.via;
  };
  // `optional`: the word only looks like a script path (a missing or non-script file is ignored)
  const runScriptFile = (w, kind, optional) => {
    const label = w.t;
    if (w.dyn) { if (!optional) unread(label, 'its path is only known when it runs'); return; }
    const p = expandPath(w, dir, home);
    if (!p) { if (!optional) unread(label, 'Helm could not tell which folder it is in'); return; }
    if (ctx.level >= MAX_SCRIPT_LEVEL || depth + 1 > MAX_DEPTH) { unread(label, 'it is nested too deep to follow'); return; }
    if (ctx.reads.n >= MAX_SCRIPT_READS) { unread(label, `the command runs more than ${MAX_SCRIPT_READS} scripts`); return; }
    const r = readScript(p, kind);
    if (r.skip) return; // missing (the command fails) or not a script
    ctx.reads.n++;
    if (r.why) { unread(label, r.why); return; }
    scanText(r.text, r.kind, dir, label, p);
  };
  // npm run x / npm test / pnpm x / yarn x / bun run x → the package.json script (+ pre / post)
  const runPackageScript = (pm, args) => {
    let pdir = dir;
    let filtered = false;
    const pos = [];
    for (let k = 0; k < args.length && pos.length < 2; k++) {
      const a = args[k].t;
      if (a === '--') break;
      if (/^(--prefix|-C|--dir|--cwd)$/.test(a)) { pdir = expandPath(args[k + 1], pdir, home); k++; continue; }
      if (/^--(prefix|dir|cwd)=/.test(a)) { pdir = expandPath({ ...args[k], t: a.replace(/^--\w+=/, '') }, pdir, home); continue; }
      if (/^(--filter|-F|-w|--workspace|--recursive|-r|--workspaces|-ws)$/.test(a)) { filtered = true; if (!/^(--recursive|-r|--workspaces|-ws)$/.test(a)) k++; continue; }
      if (/^--(filter|workspace)=/.test(a)) { filtered = true; continue; }
      if (/^-/.test(a)) continue;
      pos.push(args[k]);
    }
    if (!pos.length) return;
    const sub = pos[0].t.toLowerCase();
    let nameW = null;
    if (['run', 'run-script', 'rum', 'urn'].includes(sub)) nameW = pos[1] || null;
    else if (pm !== 'bun' && ['test', 't', 'tst', 'start', 'stop', 'restart'].includes(sub)) nameW = word(/^t/.test(sub) ? 'test' : sub);
    else if (pm !== 'npm' && !PM_BUILTINS.has(sub)) nameW = pos[0]; // pnpm / yarn / bun run unknown commands as scripts
    else return;
    if (!nameW) return;
    const label = `${pm} run ${nameW.t}`;
    if (nameW.dyn) { unread(label, 'the script name is only known when it runs'); return; }
    if (filtered) { unread(label, 'it runs in other workspace packages'); return; }
    if (pdir == null) { unread(label, 'Helm could not tell which folder it runs in'); return; }
    if (ctx.level >= MAX_SCRIPT_LEVEL || depth + 1 > MAX_DEPTH) { unread(label, 'it is nested too deep to follow'); return; }
    const pj = findUp(pdir, 'package.json');
    if (!pj) return; // no package.json: the command fails
    if (ctx.reads.n >= MAX_SCRIPT_READS) { unread(label, `the command runs more than ${MAX_SCRIPT_READS} scripts`); return; }
    ctx.reads.n++;
    let scripts;
    try {
      if (fs.statSync(pj).size > MAX_SCRIPT_BYTES) { unread(label, `package.json is larger than ${MAX_SCRIPT_BYTES / 1024} KB`); return; }
      scripts = (JSON.parse(fs.readFileSync(pj, 'utf8').replace(/^﻿/, '')) || {}).scripts || {};
    } catch (e) { unread(label, `package.json could not be read (${e.code || 'not valid JSON'})`); return; }
    const name = nameW.t;
    if (typeof scripts[name] !== 'string') return; // "missing script": nothing runs (or a yarn/pnpm bin, not a script)
    for (const n of [`pre${name}`, name, `post${name}`]) if (typeof scripts[n] === 'string') scanText(scripts[n], 'bash', path.dirname(pj), label, null, true);
  };
  const stdinScripts = (ev, d) => {
    for (const h of ev.heredocs) collect(h, d, dir, home, out, depth + 1, ctx);
    if (ev.pipe && prev) {
      const pw = stripPrefix(prev.words, dialect);
      // `echo "git push" | bash` → its arguments; `'git push' | iex` (a bare string) → all of it
      collect((pw[0] && pw[0].q ? pw : pw.slice(1)).map((x) => x.t).join(' '), d, dir, home, out, depth + 1, ctx);
    }
  };
  for (const ev of events) {
    if (ev.type === 'open') { scopes.push(dir); continue; }
    if (ev.type === 'close') { if (scopes.length) dir = scopes.pop(); continue; }
    handle(ev, ev.words);
    prev = ev;
  }
  return out;
}

function gitAction(args, dir, home, out) {
  let k = 0;
  let d = dir;
  let gitDir = null;
  for (; k < args.length; k++) {
    const a = args[k].t;
    if (a === '-C') { d = expandPath(args[k + 1], d, home); k++; continue; }
    if (a === '-c' || a === '--namespace' || a === '--config-env' || a === '--super-prefix') { k++; continue; }
    if (a === '--git-dir' || a === '--work-tree') { const p = expandPath(args[k + 1], d, home); if (a === '--git-dir') gitDir = p; else d = p; k++; continue; }
    if (/^--git-dir=/.test(a)) { gitDir = expandPath({ ...args[k], t: a.slice(10) }, d, home); continue; }
    if (/^--work-tree=/.test(a)) { d = expandPath({ ...args[k], t: a.slice(12) }, d, home); continue; }
    if (/^-/.test(a)) continue;
    break;
  }
  const subW = args[k];
  if (!subW) return;
  const sub = subW.t.toLowerCase();
  if (gitDir) d = /[\\/]\.git[\\/]?$/i.test(gitDir) ? path.dirname(gitDir) : gitDir;
  if (sub === 'push') out.push({ kind: 'git', dir: d, words: args.slice(k + 1) });
  else if (subW.dyn) out.push({ kind: 'git', dir: d, words: args.slice(k + 1), unknownSub: true });
  else if (!KNOWN_GIT.has(sub)) out.push({ kind: 'gitAlias', dir: d, sub: subW.t, args: args.slice(k + 1) });
}

function railwayAction(args, out, runCmd) {
  const pos = [];
  let help = false;
  for (let k = 0; k < args.length; k++) {
    const a = args[k].t;
    if (a === '-h' || a === '--help') { help = true; continue; }
    if (/^(-s|--service|-e|--environment|-p|--project|-t|--team)$/.test(a)) { k++; continue; }
    if (/^-/.test(a)) continue;
    if (!pos.length && a.toLowerCase() === 'run' && runCmd) { runCmd(args.slice(k + 1)); return; }
    pos.push(args[k]);
  }
  if (help || !pos.length) return;
  let sub = pos[0].t.toLowerCase();
  if ((sub === 'service' || sub === 'services') && pos[1]) sub = pos[1].t.toLowerCase();
  if (pos[0].dyn) sub = 'up'; // `railway $CMD`: can't tell, so treat it as a deploy
  if (RAILWAY_SUBS.has(sub)) out.push({ kind: 'railway', sub, raw: ['railway', ...args.map((x) => x.t)].join(' ') });
}

// ---------- script files ----------
// pnpm / yarn / bun subcommands that are NOT package scripts (`pnpm deploy` is pnpm's own command)
const PM_BUILTINS = new Set(('add audit bin build cache config create dedupe deploy dlx env exec fetch help i import info init install '
  + 'licenses link list login logout ls outdated pack patch plugin pm prune publish rebuild remove rm root set setup store test unlink '
  + 'up update upgrade version why workspace workspaces x global node npm').split(' '));

function findUp(dir, name) {
  let d = dir;
  for (let k = 0; k < 40 && d; k++) {
    const f = path.join(d, name);
    try { if (fs.statSync(f).isFile()) return f; } catch {}
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return null;
}

// Script kind from the extension, else from a #! line: 'bash' | 'ps' | 'cmd' | 'js' | null (not a script)
function kindOf(file, head) {
  const ext = path.extname(file).toLowerCase();
  if (['.sh', '.bash', '.zsh'].includes(ext)) return 'bash';
  if (['.ps1', '.psm1'].includes(ext)) return 'ps';
  if (['.cmd', '.bat'].includes(ext)) return 'cmd';
  if (['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts'].includes(ext)) return 'js';
  const m = /^#!\s*(\S+)(?:\s+(?:-\S+\s+)*(\S+))?/.exec(head);
  if (!m) return null;
  const prog = path.basename(/(^|\/)env$/.test(m[1]) ? m[2] || '' : m[1]).toLowerCase();
  if (SHELLS.has(prog)) return 'bash';
  if (['node', 'bun', 'deno', 'tsx', 'ts-node', 'nodejs'].includes(prog)) return 'js';
  if (POWERSHELLS.has(prog)) return 'ps';
  return null;
}

// → { text, kind } | { skip: true } (missing, or not a script) | { why } (exists but was not read)
function readScript(file, kind) {
  let st;
  try { st = fs.statSync(file); } catch (e) { return e.code === 'ENOENT' || e.code === 'ENOTDIR' ? { skip: true } : { why: `it could not be opened (${e.code || 'error'})` }; }
  if (!st.isFile()) return { skip: true };
  let head;
  try {
    const fd = fs.openSync(file, 'r');
    try { head = Buffer.alloc(Math.min(512, st.size)); fs.readSync(fd, head, 0, head.length, 0); } finally { fs.closeSync(fd); }
  } catch (e) { return { why: `it could not be read (${e.code || 'error'})` }; }
  const utf16 = head[0] === 0xff && head[1] === 0xfe;
  const k = kind || kindOf(file, (utf16 ? head.toString('utf16le') : head.toString('latin1')).replace(/^\uFEFF/, ''));
  if (!k) return { skip: true };
  // A binary. Not when an interpreter was named (node x.js, bash x.sh): it runs the file anyway, and a
  // stray NUL in a comment or string does not stop it, so it is still read.
  if (!kind && !utf16 && head.includes(0)) return { skip: true };
  if (st.size > MAX_SCRIPT_BYTES) return { why: `it is larger than ${MAX_SCRIPT_BYTES / 1024} KB` };
  try {
    const buf = fs.readFileSync(file);
    return { text: (utf16 ? buf.toString('utf16le') : buf.toString('utf8')).replace(/^\uFEFF/, ''), kind: k };
  } catch (e) { return { why: `it could not be read (${e.code || 'error'})` }; }
}

// A script that finds its own folder ($0, BASH_SOURCE, $PSScriptRoot, %~dp0) gets the real path,
// so `cd "$(dirname "$0")" && git push` is judged in the script's folder instead of "unknown".
function selfPaths(text, file) {
  const f = file.replace(/\\/g, '/');
  const d = path.dirname(file).replace(/\\/g, '/');
  const SELF = String.raw`(?:\$0|\$\{0\}|\$\{BASH_SOURCE(?:\[0\])?\}|\$BASH_SOURCE)`;
  return text
    .replace(new RegExp(String.raw`\$\(\s*dirname\s+"?${SELF}"?\s*\)|` + '`' + String.raw`dirname\s+"?${SELF}"?` + '`', 'g'), d)
    .replace(/\$\(\s*cd\s+"?([^"$()`;&|]+?)"?\s*(?:&&|;)\s*pwd(?:\s+-P)?\s*\)/g, (_, p) => path.resolve(p).replace(/\\/g, '/'))
    .replace(new RegExp(SELF + '(?![A-Za-z0-9_])', 'g'), f)
    .replace(/\$PSScriptRoot\b/gi, d)
    .replace(/\$MyInvocation\.MyCommand\.(Path|Definition)\b/gi, f)
    .replace(/%~dp0\\?/gi, d + '/');
}

// Command lines inside JavaScript: string literals that read like one ('git push origin master',
// `gh pr merge ${n}`), and spawn / execFile argument arrays ('git', ['push', 'origin', 'master']).
// A ${…} hole or a non-literal array item becomes a word only known at run time.
const JS_CMD_RE = /(?:^|[;&|(]\s*|&&\s*)\s*(?:git|gh|hub|railway|npm|pnpm|yarn|bun|npx|node|bash|sh|pwsh|powershell|cmd)(?:\.exe)?(?:\s|$)|^\s*\S+\.(?:sh|ps1|cmd|bat)\b/i;
function jsCommands(text) {
  const out = [];
  const hole = (s) => s.replace(/\$\{[^}]*\}/g, '$V');
  const sq = (s) => `'${s.replace(/'/g, "'\\''")}'`;
  const dq = (s) => `"${s.replace(/["\\`]/g, '\\$&')}"`;
  const ARR = /(['"`])(git|gh|hub|railway|bash|sh|pwsh|powershell|cmd|node)(?:\.exe)?\1\s*,\s*\[([^\]]*)\]/g;
  for (const m of text.matchAll(ARR)) {
    const parts = [];
    for (const e of m[3].split(',')) {
      const s = e.trim();
      if (!s) continue;
      const q = /^(['"`])([\s\S]*)\1$/.exec(s);
      if (!q) parts.push('$V');
      else if (q[1] === '`' && /\$\{/.test(q[2])) parts.push(dq(hole(q[2])));
      else parts.push(sq(q[2]));
    }
    out.push(`${m[2]} ${parts.join(' ')}`);
  }
  const STR = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g;
  for (const m of text.matchAll(STR)) {
    const s = m[3] != null ? hole(m[3]) : (m[1] != null ? m[1] : m[2]);
    if (JS_CMD_RE.test(s)) out.push(s.replace(/\\(["'`\\])/g, '$1'));
    if (out.length >= 200) break;
  }
  return out;
}

// ---------- gh (GitHub CLI) ----------
// gh flags that take a value (so the next word is not a positional argument)
const GH_VALUE_FLAGS = new Set(['-R', '--repo', '-X', '--method', '-f', '--raw-field', '-F', '--field', '-H', '--header', '--input',
  '-q', '--jq', '-t', '--template', '--hostname', '--cache', '-p', '--preview', '-b', '--body', '--body-file', '--subject',
  '--match-head-commit', '-A', '--author-email', '-n', '--notes', '--notes-file', '--target', '--discussion-category',
  '--notes-start-tag', '--title', '--branch', '-B', '--base', '--source', '--tag']);
const ghRepoUrl = (spec) => {
  const s = String(spec || '').trim();
  if (!s) return null;
  if (/^[a-z]+:\/\/|^git@/i.test(s)) return s;
  const parts = s.split('/').filter(Boolean);
  if (parts.length === 2) return `https://github.com/${parts[0]}/${parts[1]}`;
  if (parts.length === 3) return `https://${parts[0]}/${parts[1]}/${parts[2]}`;
  return null;
};

// gh writes that ship code: pr merge, release create (not --draft), a draft release published,
// repo sync of a remote fork, and `gh api` writes to refs / merges / contents / pull merges /
// releases / workflow dispatches / merge-upstream (REST) or ref / merge mutations (GraphQL).
// Everything else (pr view / list / checks, api GETs, issues, comments) is not a push.
// → { kind: 'gh', dir, repo (URL) | null, repoSpec, what, branch: name | null (default / unknown),
//     tag?, needBase?, pr? }
function ghAction(args, dir, out, envRepo) {
  const pos = [];
  const flags = {};
  const fields = [];
  for (let k = 0; k < args.length; k++) {
    const w = args[k];
    const a = w.t;
    if (a === '--') { pos.push(...args.slice(k + 1)); break; }
    let name = null;
    let val = null;
    let m;
    if ((m = /^(--[A-Za-z][\w-]*)=([\s\S]*)$/.exec(a))) { name = m[1]; val = { ...w, t: m[2] }; }
    else if ((m = /^-([XRfFH])(.+)$/.exec(a))) { name = '-' + m[1]; val = { ...w, t: m[2] }; }
    else if (/^-./.test(a)) { name = a; if (GH_VALUE_FLAGS.has(a)) val = args[++k] || null; }
    else { pos.push(w); continue; }
    (flags[name] = flags[name] || []).push(val);
    if (/^(-f|-F|--field|--raw-field)$/.test(name) && val) {
      const i = val.t.indexOf('=');
      fields.push({ key: i >= 0 ? val.t.slice(0, i) : val.t, value: i >= 0 ? val.t.slice(i + 1) : '', dyn: val.dyn });
    }
  }
  const flag = (...names) => { for (const n of names) if (flags[n]) return flags[n][flags[n].length - 1] || { t: '', dyn: false }; return null; };
  const field = (key) => fields.filter((f) => f.key === key).pop() || null;
  const fieldBranch = (key) => { const f = field(key); return !f ? null : f.dyn ? undefined : f.value.replace(/^refs\/heads\//, ''); };
  const repoW = flag('-R', '--repo');
  let repoSpec = repoW && !repoW.dyn ? repoW.t : (!repoW && envRepo ? envRepo : null);
  const g0 = pos[0] ? pos[0].t.toLowerCase() : '';
  const g1 = pos[1] ? pos[1].t.toLowerCase() : '';
  const push = (what, extra) => out.push({ kind: 'gh', dir, repo: ghRepoUrl(repoSpec), repoSpec, what, branch: null, ...extra });

  if (g0 === 'pr' && g1 === 'merge') {
    if (flags['--disable-auto']) return;
    const sel = pos[2] || null;
    const u = sel && /github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/\d+/i.exec(sel.t);
    if (u) repoSpec = `${u[1]}/${u[2]}`;
    push('gh pr merge', { needBase: true, pr: sel && !sel.dyn ? sel.t : null });
    return;
  }
  if (g0 === 'release' && (g1 === 'create' || g1 === 'new' || g1 === 'edit')) {
    const draft = flags['--draft'] || flags['-d'];
    const draftOff = draft && draft.some((v) => v && /^false$/i.test(v.t));
    if (g1 === 'edit' ? !draftOff : (draft && !draftOff)) return; // a draft publishes nothing
    const tgt = flag('--target');
    push(`gh release ${g1 === 'edit' ? 'edit --draft=false' : 'create'}`, { branch: tgt ? (tgt.dyn ? undefined : tgt.t) : null });
    return;
  }
  if (g0 === 'repo' && g1 === 'sync') {
    if (!pos[2]) return; // syncs the LOCAL clone from its remote: nothing is pushed
    if (!pos[2].dyn) repoSpec = pos[2].t;
    const b = flag('-b', '--branch');
    push('gh repo sync', { branch: b ? (b.dyn ? undefined : b.t) : null });
    return;
  }
  if (g0 !== 'api' || !pos[1]) return;
  const mW = flag('-X', '--method');
  const method = mW ? mW.t.toUpperCase() : (fields.length || flags['--input'] ? 'POST' : 'GET');
  if (method === 'GET' || method === 'HEAD') return;
  const ep = pos[1].t.replace(/^https?:\/\/[^/]+\//i, '').replace(/^\/+/, '').replace(/^api\/v3\//, '').replace(/[?#].*$/, '');
  if (ep.toLowerCase() === 'graphql') {
    const body = fields.map((f) => f.value).join('\n');
    if (!/\bmutation\b/i.test(body) || !/merge|ref\b|refs\b|createRef|updateRef|deleteRef|createCommitOnBranch/i.test(body)) return;
    const o = field('owner');
    const n = field('name') || field('repo');
    const r = /repository\s*\(\s*owner\s*:\s*"([^"]+)"\s*,\s*name\s*:\s*"([^"]+)"/i.exec(body);
    if (o && n && !o.dyn && !n.dyn) repoSpec = `${o.value}/${n.value}`;
    else if (r) repoSpec = `${r[1]}/${r[2]}`;
    push('gh api graphql', { branch: null });
    return;
  }
  const m = /^repos\/([^/]+)\/([^/]+)\/(.*)$/i.exec(ep);
  if (!m) return;
  if (!/^[{:]/.test(m[1]) && !/^[{:]/.test(m[2])) repoSpec = `${m[1]}/${m[2]}`; // {owner}/{repo}: the current repo
  const rest = m[3].replace(/\/+$/, '');
  const what = `gh api ${method} ${ep}`;
  let r;
  if ((r = /^git\/refs\/(.+)$/i.exec(rest))) {
    if (/^heads\//i.test(r[1])) push(what, { branch: r[1].slice(6) });
    else push(what, { tag: true });
  } else if (/^git\/refs$/i.test(rest)) {
    const f = field('ref');
    if (f && !f.dyn && /^refs\/tags\//.test(f.value)) push(what, { tag: true });
    else push(what, { branch: f ? fieldBranch('ref') : undefined });
  } else if (/^merges$/i.test(rest)) push(what, { branch: field('base') ? fieldBranch('base') : undefined });
  else if (/^merge-upstream$/i.test(rest)) push(what, { branch: field('branch') ? fieldBranch('branch') : null });
  else if (/^contents\//i.test(rest)) push(what, { branch: field('branch') ? fieldBranch('branch') : null });
  else if ((r = /^pulls\/([^/]+)\/merge$/i.exec(rest))) push(what, { needBase: true, pr: /^\d+$/.test(r[1]) ? r[1] : null });
  else if (/^releases$/i.test(rest)) {
    const d = field('draft');
    if (d && /^true$/i.test(d.value)) return;
    push(what, { branch: field('target_commitish') ? fieldBranch('target_commitish') : null });
  } else if (/^actions\/workflows\/[^/]+\/dispatches$/i.test(rest)) push(what, { branch: field('ref') ? fieldBranch('ref') : undefined });
  else if ((r = /^branches\/([^/]+)\/rename$/i.exec(rest))) push(what, { branch: r[1] });
}

// ---------- git queries ----------
function runGh(dir, args) {
  return new Promise((resolve) => {
    execFile('gh', args, { cwd: dir || undefined, timeout: GIT_TIMEOUT_MS, windowsHide: true, env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' } }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || '').trim(), err: String(stderr || '').trim() });
    });
  });
}

function runGit(dir, args) {
  return new Promise((resolve) => {
    execFile('git', ['-C', dir, ...args], { timeout: GIT_TIMEOUT_MS, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, out: String(stdout || '').trim(), err: String(stderr || '').trim() });
    });
  });
}

// "not a git repository" / missing folder: the push would fail anyway (not guarded). Anything else
// (git missing, timeout) is a reason to guard.
const notARepo = (r) => r.code === 128 && /not a git repository|cannot change to|no such file|does not exist/i.test(r.err);

async function pushHit(act, list, git) {
  const pushOpt = { dryRun: false, all: false, del: false, repo: null, pos: [], dynPos: false };
  const ws = act.words;
  let dashdash = false;
  for (let k = 0; k < ws.length; k++) {
    const w = ws[k];
    const a = w.t;
    if (dashdash || !a.startsWith('-') || a === '-') { pushOpt.pos.push(w); continue; }
    if (a === '--') { dashdash = true; continue; }
    if (a === '--dry-run') { pushOpt.dryRun = true; continue; }
    if (a === '--all' || a === '--branches' || a === '--mirror') { pushOpt.all = true; continue; }
    if (a === '--delete') { pushOpt.del = true; continue; }
    if (a.startsWith('--repo=')) { pushOpt.repo = { ...w, t: a.slice(7) }; continue; }
    if (a === '--repo') { pushOpt.repo = ws[++k] || null; continue; }
    if (/^--(push-option|receive-pack|exec)$/.test(a)) { k++; continue; }
    if (a.startsWith('--')) continue;
    for (let j = 1; j < a.length; j++) {
      const ch = a[j];
      if (ch === 'n') pushOpt.dryRun = true;
      else if (ch === 'd') pushOpt.del = true;
      else if (ch === 'o') { if (j === a.length - 1) k++; break; }
    }
  }
  if (pushOpt.dryRun) return null;
  const remoteW = pushOpt.repo || pushOpt.pos[0] || null;
  const refs = pushOpt.repo ? pushOpt.pos : pushOpt.pos.slice(1);
  const looksUrl = (t) => /[/\\:@]/.test(t) || /\.git$/i.test(t);
  if (act.dir == null) {
    if (remoteW && !remoteW.dyn && looksUrl(remoteW.t)) {
      const t = targetFor([remoteW.t], list);
      return t ? await branchCheck(t, null, refs, pushOpt, git) : null;
    }
    return { unknown: true };
  }
  const rv = await git(act.dir, ['remote', '-v']);
  let remotes = {};
  if (!rv.ok) {
    if (!notARepo(rv)) return { unknown: true, why: 'git failed' };
    if (!(remoteW && !remoteW.dyn && looksUrl(remoteW.t))) return null;
  } else {
    for (const line of rv.out.split(/\r?\n/)) {
      const m = /^(\S+)\s+(\S+)\s+\((fetch|push)\)/.exec(line);
      if (m) (remotes[m[1]] = remotes[m[1]] || []).push(m[2]);
    }
  }
  let urls;
  if (!remoteW || remoteW.dyn) urls = Object.values(remotes).flat();
  else if (remotes[remoteW.t]) urls = remotes[remoteW.t];
  else if (looksUrl(remoteW.t)) urls = [remoteW.t];
  else urls = Object.values(remotes).flat(); // unknown name: be safe and look at the repo's remotes
  const t = targetFor(urls, list);
  if (!t) return null;
  return branchCheck(t, rv.ok ? act.dir : null, refs, pushOpt, git, remoteW && !remoteW.dyn && remotes[remoteW.t] ? remoteW.t : null);
}

async function currentBranch(dir, git) {
  if (!dir) return null;
  const r = await git(dir, ['symbolic-ref', '--short', '-q', 'HEAD']);
  return r.ok && r.out ? r.out : null;
}

function branchGuarded(t, ref) {
  const r = String(ref).replace(/^refs\/heads\//, '');
  if (/[*]/.test(ref)) {
    const re = new RegExp('^' + String(ref).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    return t.branches.some((b) => re.test(b) || re.test('refs/heads/' + b));
  }
  return t.branches.includes(r);
}

// A gh write → hit | null. The repo is -R / GH_REPO / the URL / the endpoint, else the folder's
// remotes. A pull request's base branch is looked up (`gh pr view`); if that fails, it is assumed
// to be the guarded branch.
async function ghHit(a, list, git, gh) {
  let t;
  if (a.repo) t = targetFor([a.repo], list);
  else {
    if (a.dir == null) return { unknown: true };
    const rv = await git(a.dir, ['remote', '-v']);
    if (!rv.ok) return notARepo(rv) ? null : { unknown: true, why: 'git failed' };
    t = targetFor(rv.out.split(/\r?\n/).map((l) => (/^\S+\s+(\S+)/.exec(l) || [])[1]).filter(Boolean), list);
  }
  if (!t) return null;
  if (!t.branches) return { target: t, branch: null };
  if (a.tag) return null;
  let b = a.branch;
  let guess = b === undefined;
  if (a.needBase) {
    const r = await gh(a.dir, ['pr', 'view', ...(a.pr ? [a.pr] : []), '--json', 'baseRefName', '--jq', '.baseRefName', ...(a.repoSpec ? ['-R', a.repoSpec] : [])]);
    b = r.ok && r.out && !/\s/.test(r.out) ? r.out : null;
    guess = b == null;
  }
  if (b == null) return { target: t, branch: t.branches[0], guess };
  return branchGuarded(t, b) ? { target: t, branch: b.replace(/^refs\/heads\//, '') } : null;
}

// The words that name a protected repo or branch: its id, name, repo names (last remote segment) and branches.
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const targetNames = (t) => (t.all ? [] : [...new Set([t.id, t.name, ...t.remotes.map((r) => r.split('/').pop()), ...(t.branches || [])].filter(Boolean))]);

// Does the command text name a guarded repo or branch? (a configured repo's id / name / repo name / branch)
function namedTarget(text, list) {
  for (const t of list) {
    if (t.all) return { target: t, word: null }; // unreadable prod-guard.json: every unread script asks
    const m = new RegExp(`(?:^|[^A-Za-z0-9_-])(${targetNames(t).map(esc).join('|')})(?![A-Za-z0-9_-])`, 'i').exec(String(text || ''));
    if (m) return { target: t, word: m[1] };
  }
  return null;
}

// "A", "A or B", "A, B or C": the configured repos, for "asks in case it is …".
function repoNames(list) {
  const n = [...new Set(list.map((t) => t.name))];
  return n.length > 1 ? `${n.slice(0, -1).join(', ')} or ${n[n.length - 1]}` : n[0] || 'a protected repo';
}

// Does this push touch one of the target's guarded branches? (branches null: every push is guarded.)
async function branchCheck(t, dir, refs, o, git, remoteName) {
  const hit = (branch) => ({ target: t, branch: branch || null });
  if (!t.branches) return hit(null);
  const guarded = (ref) => branchGuarded(t, ref);
  if (o.all) return hit(t.branches[0]);
  const specs = refs.filter((w) => !w.t.startsWith('^'));
  if (specs.length) {
    for (const w of specs) {
      if (w.dyn) return hit(t.branches[0]);
      let s = w.t.replace(/^\+/, '');
      let dst;
      if (o.del) dst = s;
      else if (s.includes(':')) { dst = s.slice(s.indexOf(':') + 1) || s.slice(0, s.indexOf(':')); }
      else dst = s;
      if (/^(HEAD|@)$/i.test(dst)) {
        dst = await currentBranch(dir, git);
        if (!dst) return hit(t.branches[0]);
      }
      if (guarded(dst)) return hit(String(dst).replace(/^refs\/heads\//, ''));
    }
    return null;
  }
  // No refspec: git pushes the current branch to its push target (push.default simple/current/upstream).
  if (!dir) return hit(t.branches[0]);
  const pd = await git(dir, ['config', '--get', 'push.default']);
  if (pd.ok && pd.out === 'matching') return hit(t.branches[0]);
  const up = await git(dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{push}']);
  if (up.ok && up.out && up.out !== '@{push}') {
    const rv = await git(dir, ['remote']);
    const names = rv.ok ? rv.out.split(/\r?\n/).filter(Boolean) : [];
    const rn = names.sort((a, b) => b.length - a.length).find((x) => up.out.startsWith(x + '/'));
    const br = rn ? up.out.slice(rn.length + 1) : up.out.replace(/^[^/]+\//, '');
    if (guarded(br)) return hit(br);
  }
  const cb = await currentBranch(dir, git);
  if (!cb) return hit(t.branches[0]); // detached / unreadable: can't tell, so ask
  return guarded(cb) ? hit(cb) : null;
}

// ---------- assessment ----------
// assess(toolName, toolInput, { cwd, home?, targets?, userDataDir?, git?, gh? }) → null (not guarded) or
// { kind: 'push' | 'railway', title, short, description, approvable: 'all' | 'restart' | false, hits }
// targets: the protected repos (default: targets(userDataDir)). An empty list guards Railway only.
async function assess(toolName, toolInput, opts = {}) {
  const list = opts.targets || targets(opts.userDataDir);
  const home = opts.home || os.homedir();
  const git = opts.git || runGit;
  const gh = opts.gh || runGh;
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {};
  if (/^mcp__/i.test(toolName || '')) {
    const m = /^mcp__(.+?)__(.+)$/i.exec(toolName);
    if (m && /railway/i.test(m[1]) && RAILWAY_MCP_RE.test(m[2])) {
      const sub = /restart/i.test(m[2]) ? 'restart' : /down|remove|delete/i.test(m[2]) ? 'down' : 'deploy';
      return describe([{ kind: 'railway', sub, raw: `${m[1]} · ${m[2]}`, mcp: true }]);
    }
    return null;
  }
  let dialect;
  if (toolName === 'Bash' || toolName === 'Monitor') dialect = 'bash';
  else if (toolName === 'PowerShell') dialect = 'ps';
  else return null;
  const command = typeof input.command === 'string' ? input.command : '';
  if (!command || !/git|railway|hub|\bgh\b|npm|pnpm|yarn|bun|node|tsx|source|\.(sh|bash|zsh|ps1|psm1|cmd|bat|m?js|cjs|m?ts|cts)\b|[\\/]|(^|[;&|(\s])\.\s|-e[a-z]*\b|iex|invoke-expression|eval|start-process|saps/i.test(command)) return null;
  const acts = collect(command, dialect, opts.cwd ? path.resolve(opts.cwd) : null, home, [], 0);
  const hits = [];
  for (let k = 0; k < acts.length && k < 40; k++) {
    const a = acts[k];
    if (a.kind === 'railway') { hits.push(a); continue; }
    if (a.kind === 'gitAlias') {
      if (a.dir == null) continue;
      const r = await git(a.dir, ['config', '--get', `alias.${a.sub}`]);
      if (!r.ok || !r.out) continue;
      const start = acts.length;
      if (r.out.startsWith('!')) collect(`${r.out.slice(1)} ${a.args.map((x) => x.t).join(' ')}`, 'bash', a.dir, home, acts, 1);
      else {
        const first = scan(r.out, 'bash').find((e) => e.type === 'cmd');
        if (first) gitAction([...first.words, ...a.args], a.dir, home, acts);
      }
      if (a.via) for (let j = start; j < acts.length; j++) if (!acts[j].via) acts[j].via = a.via;
      continue;
    }
    // No protected repos: no push, gh write or unread script can touch one, and a push from an unknown
    // folder has nothing to be (no git calls, no "in case it is …" card). Railway still asks above.
    if (!list.length) continue;
    if (a.kind === 'gh') {
      const h = await ghHit(a, list, git, gh);
      if (h) hits.push({ kind: 'push', gh: a.what, via: a.via, ...h });
      continue;
    }
    if (a.kind === 'scriptUnread') {
      // Not read: ask only when the command itself names a guarded repo or branch (see the header).
      const n = namedTarget(command, list);
      if (n) hits.push({ kind: 'push', unread: { label: a.label, why: a.why, word: n.word }, via: a.via, target: n.target, branch: n.target.branches ? n.target.branches[0] : null });
      continue;
    }
    let h = await pushHit(a, list, git);
    // A JS git call with a run-time subcommand and no "push" in sight: ask only if a folder it could
    // act on is guarded (its -C folder, else the folder the script runs in). Unknown both ways: ask.
    if (h && h.unknown && a.jsHole && a.runDir) h = await pushHit({ ...a, dir: a.runDir }, list, git);
    if (h) hits.push({ kind: 'push', via: a.via, ...h });
  }
  return hits.length ? describe(hits, list) : null;
}

// The fail-closed reason, in words: the file and its parse or read error.
const unreadableWhy = (t) => `Helm could not read ${t.file} (${t.why}); fix or delete that file to go back to your list`;

function describe(hits, list = []) {
  const h = hits[0];
  let title;
  let short;
  let description;
  let approvable;
  if (h.kind === 'push' && (h.via || h.gh || h.unread)) {
    // Plain words: who does it (a script, a package script, gh), what it does, and why that matters.
    const isPkg = (l) => /^(npm|pnpm|yarn|bun) run /.test(l);
    const chain = h.via || [];
    const inner = chain[chain.length - 1];
    const runBy = chain.length > 1 ? ` (run by ${chain.slice(0, -1).map((l) => (isPkg(l) ? `“${l}”` : l)).join(', then ')})` : '';
    let who = inner ? (isPkg(inner) ? `The package script “${inner}”` : /^(node|tsx|ts-node) -/.test(inner) ? `The ${inner} code` : `The script ${inner}`) + runBy : 'This command';
    if (h.gh && inner) who += ` runs ${h.gh.split(' ').slice(0, 3).join(' ')}: it`;
    const verb = !h.gh ? 'pushes to'
      : /pr merge|pulls\/.*\/merge/.test(h.gh) ? 'merges a pull request into'
      : /release|releases/.test(h.gh) ? 'publishes a GitHub release of'
      : /repo sync|merge-upstream/.test(h.gh) ? 'syncs'
      : /merges$/.test(h.gh) ? 'merges a branch into'
      : /dispatches$/.test(h.gh) ? 'starts a workflow on'
      : 'changes';
    const ghNote = h.gh && !inner ? ` (${h.gh})` : '';
    const noun = !h.gh ? 'push' : /merge/.test(verb) ? 'merge' : /release/.test(verb) ? 'release' : 'GitHub write';
    const scriptTag = inner ? ` · ${isPkg(inner) ? inner : `script ${path.basename(inner)}`}` : '';
    if (h.unread) {
      title = `Possible production push · ${h.unread.label} not read`;
      short = 'Possible production push';
      description = h.target && h.target.all
        ? `Helm could not read ${isPkg(h.unread.label) ? `the package script “${h.unread.label}”` : `the script ${h.unread.label}`} (${h.unread.why}), and ${unreadableWhy(h.target)}, so it asks in case it pushes.`
        : `Helm could not read ${isPkg(h.unread.label) ? `the package script “${h.unread.label}”` : `the script ${h.unread.label}`} (${h.unread.why}), and this command names ${h.unread.word}, so it asks in case it pushes to production.`;
    } else if (h.unknown) {
      title = `Possible production ${noun} · folder unknown${scriptTag}`;
      short = `Possible production ${noun}`;
      description = `${who}${ghNote} ${h.gh ? 'acts on a repo' : 'pushes from a folder'} Helm could not work out, so it asks in case it is ${repoNames(list)}.`;
    } else if (h.target.all) {
      title = `Push · prod-guard.json unreadable${scriptTag}`;
      short = `${noun.charAt(0).toUpperCase()}${noun.slice(1)} (prod-guard.json unreadable)`;
      description = `${who}${ghNote} ${verb} a repo. Every ${noun} asks because ${unreadableWhy(h.target)}.`;
    } else if (h.target.branches) {
      const b = h.branch || h.target.branches[0];
      title = `Production ${noun} · ${h.target.name} ${b}${scriptTag}`;
      short = `Production ${noun} to ${h.target.name} ${b}`;
      description = `${who}${ghNote} ${verb} ${h.target.name} ${b}, which is production.`;
      if (h.guess) description += ` Helm could not confirm the target branch, so it assumes ${b}.`;
    } else {
      title = `Production ${noun} · ${h.target.name}${scriptTag}`;
      short = `Production ${noun} from ${h.target.name}`;
      description = `${who}${ghNote} ${verb} the ${h.target.name} repo, where every push is guarded.`;
    }
    approvable = 'all';
  } else if (h.kind === 'push') {
    if (h.unknown) {
      title = 'Possible production push · folder unknown';
      short = 'Possible production push';
      description = `Helm could not tell which repo this pushes from, so it asks in case it is ${repoNames(list)}.`;
    } else if (h.target.all) {
      title = 'Push · prod-guard.json unreadable';
      short = 'Push (prod-guard.json unreadable)';
      description = `Every push asks because ${unreadableWhy(h.target)}.`;
    } else if (h.target.branches) {
      title = `Production push · ${h.target.name} ${h.branch || h.target.branches[0]}`;
      short = `Production push to ${h.target.name} ${h.branch || h.target.branches[0]}`;
      description = `Pushing ${h.target.name} ${h.branch || h.target.branches[0]} deploys production.`;
    } else {
      title = `Production push · ${h.target.name}`;
      short = `Production push from ${h.target.name}`;
      description = `Every push from the ${h.target.name} repo is guarded.`;
    }
    approvable = 'all';
  } else {
    const what = h.mcp ? h.raw : `railway ${h.sub}`;
    title = `Railway ${h.sub === 'deploy' ? 'deploy' : h.sub} · ${what}`;
    short = `Railway ${h.sub}`;
    description = h.sub === 'down' ? 'Removes the latest Railway deployment.' : h.sub === 'restart' ? 'Restarts a Railway service.' : 'Deploys to Railway.';
    approvable = h.sub === 'down' ? false : h.sub === 'restart' ? 'restart' : 'all';
  }
  if (hits.length > 1) description += ` (${hits.length} guarded actions in this command.)`;
  for (const x of hits.slice(1)) {
    const a = x.kind === 'push' ? 'all' : x.sub === 'down' ? false : x.sub === 'restart' ? 'restart' : 'all';
    if (a === false || approvable === false) approvable = false;
    else if (a === 'all' && approvable === 'restart') approvable = 'all';
  }
  return { kind: h.kind, title, short, description, approvable, hits: hits.map((x) => (x.kind === 'push' ? { kind: 'push', target: x.unknown ? null : x.target.id, branch: x.branch || null, ...(x.gh ? { gh: x.gh } : {}), ...(x.via ? { via: x.via } : {}), ...(x.unread ? { unread: true } : {}) } : { kind: 'railway', sub: x.sub })) };
}

// ---------- prior approval from the user's own words ----------
const APPROVE_RE = /\b(push|ship|deploy|redeploy|release|go live)\b/gi;
const RESTART_RE = /\b(restart)\b/gi;
const ANY_RE = /\b(push(?:es|ed|ing)?|ship(?:s|ped|ping)?|deploy(?:s|ed|ing|ments?)?|redeploy(?:s|ed|ing)?|releas(?:e|es|ed|ing)|go(?:es|ing)? live|went live|restart(?:s|ed|ing)?)\b/i;
const NEG_RE = /\b(?:don'?t|dont|do not|does not|doesn'?t|did not|didn'?t|not|no|never|without|nor|neither|won'?t|wont|shouldn'?t|can'?t|cannot|mustn'?t|hold off|refrain|fail(?:s|ed)? to|unable to|couldn'?t)\b/i;
const NEG_NEAR_RE = /\b(?:skip|avoid|stop|pause)\s+(?:\w+\s+)?(?:push|ship|deploy|redeploy|releas|go live|restart)/i;
const HOLD_RE = /\b(?:not yet|hold off|hold on|not now|later)\b/i;
// Words aimed at production: these, plus every configured repo's id / name / repo name / branches.
const TARGET_WORDS = ['master', 'main', 'prod', 'production', 'live', 'railway'];
let targetWordCache = { key: null, re: null };
function targetWordRe(list) {
  const words = [...new Set([...TARGET_WORDS, ...(list || []).flatMap(targetNames).map((w) => w.toLowerCase())])];
  const key = words.join('\n');
  if (targetWordCache.key !== key) targetWordCache = { key, re: new RegExp(`(?<!\\w)(?:${words.map(esc).join('|')})(?!\\w)`, 'i') };
  return targetWordCache.re;
}
// a question without its "?": "did you push", "should we deploy" (not "can you push", a request)
const QUESTION_START_RE = /^(?:(?:did|do|does|should|shall|have|has|had|is|are|was|were)\s+(?:you|we|i|it|they|he|she|this|that|there|anyone|claude)\b|(?:why|what|when|how|where|which|who|whether)\b)/i;
const NOUN_BEFORE_RE = /\b(?:the|a|an|this|that|these|those|last|latest|previous|next|our|my|your|its|each|every|any|first|failed|broken)\s+$/i;
const NOT_DEPLOY_RE = /\b(?:push notifications?|push alerts?|push subscriptions?|push tokens?|push api|push service|push messages?|push server|push events?|push-notif\w*|release notes?|release dates?|release candidates?|release branch|release tag)\b|\b(?:phone|web|mobile|browser|desktop) push(?:es)?\b/gi;
const AFFIRM_WORDS = ['go ahead', 'do it', 'ship it', 'yes', 'yep', 'yeah', 'ok', 'okay', 'sure', 'go', 'y'];
const AFFIRM_EXTRA = ['please', 'pls', 'thanks', 'thank you'];

const clean = (text) => String(text || '')
  .replace(/[\u2018\u2019\u02bc]/g, "'")
  .replace(/```[\s\S]*?(```|$)/g, ' ')
  .replace(/`[^`\n]*`/g, ' ')
  .replace(/^\s*>.*$/gm, ' ')
  .replace(NOT_DEPLOY_RE, ' ');

function sentences(text) {
  return String(text).split(/(?<=[.!?])\s+|\n+/).map((x) => x.trim()).filter(Boolean);
}

// The user's typed prompt → { scope: 'all' | 'restart', quote } when it tells Claude to push / deploy;
// null otherwise. Negations ("don't push", "commit, no push", "without pushing", "never push",
// "hold off on pushing", "not yet") anywhere in the message cancel it; so does a question
// ("did you push?", "should we push?") or past tense ("pushed"). `prevAssistant` = the text of
// Claude's reply just before it, for a bare "yes / go ahead / do it" (rule b). `list` = the protected
// repos, whose names count as production words ("push it, but not to <repo>").
function promptApproval(text, prevAssistant, list) {
  const TARGET_WORD_RE = targetWordRe(list);
  const raw = String(text || '');
  const c = clean(raw);
  if (!c.trim()) return null;
  if (isAffirmative(c)) {
    const q = askedAbout(prevAssistant);
    if (q) return { scope: q, quote: raw.trim(), via: 'affirm' };
    // a bare "yes" with no push question before it says nothing; "ship it" still counts below
  }
  if (HOLD_RE.test(c)) return null;
  let scope = null;
  let quote = null;
  for (const sen of sentences(c)) {
    const isQ = /\?\s*$/.test(sen) || QUESTION_START_RE.test(sen);
    for (const clause of sen.split(/[,;:]|\s(?:but|however|except|although|though)\s/i)) {
      // "push it, but not to master" / "no prod deploys": a negation aimed at production vetoes too
      if (TARGET_WORD_RE.test(clause) && (NEG_RE.test(clause) || HOLD_RE.test(clause))) return null;
      if (!ANY_RE.test(clause)) continue;
      if (NEG_RE.test(clause) || NEG_NEAR_RE.test(clause)) return null;
      if (isQ) continue;
      for (const [re, sc] of [[APPROVE_RE, 'all'], [RESTART_RE, 'restart']]) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(clause))) {
          if (NOUN_BEFORE_RE.test(clause.slice(0, m.index))) continue;
          if (sc === 'all' || !scope) { scope = sc; quote = quoteAround(raw, m[0]); }
          break;
        }
      }
    }
  }
  return scope ? { scope, quote, via: 'prompt' } : null;
}

function isAffirmative(text) {
  let t = String(text || '').toLowerCase().replace(/[^a-z' ]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return false;
  let any = false;
  while (t) {
    const w = AFFIRM_WORDS.find((x) => t === x || t.startsWith(x + ' '));
    if (w) { any = true; t = t.slice(w.length).trim(); continue; }
    const e = AFFIRM_EXTRA.find((x) => t === x || t.startsWith(x + ' '));
    if (e) { t = t.slice(e.length).trim(); continue; }
    return false;
  }
  return any;
}

// Did Claude's reply end by asking about pushing / deploying? → 'all' | 'restart' | null
function askedAbout(prev) {
  const c = clean(prev);
  let scope = null;
  for (const sen of sentences(c)) {
    if (!/\?\s*$/.test(sen) || !ANY_RE.test(sen)) continue;
    if (NEG_RE.test(sen) || HOLD_RE.test(sen) || NEG_NEAR_RE.test(sen)) return null; // "Should I hold off on pushing?" + "yes" = don't
    const all = /\b(push(?:es|ed|ing)?|ship(?:s|ping)?|deploy(?:s|ing)?|redeploy(?:s|ing)?|releas(?:e|es|ing)|go(?:es|ing)? live)\b/i.test(sen);
    scope = all ? 'all' : scope || 'restart';
  }
  return scope;
}

function quoteAround(raw, kw) {
  const t = String(raw).replace(/\s+/g, ' ').trim();
  if (t.length <= 40) return t;
  // whole words: up to four before the keyword and two after ("…commit it and push to origin…")
  const words = t.split(' ');
  const first = String(kw).toLowerCase().split(' ')[0];
  const k = words.findIndex((w) => w.toLowerCase().replace(/[^a-z']/g, '') === first);
  if (k < 0) return words.slice(0, 6).join(' ') + '…';
  const from = Math.max(0, k - 4);
  const to = Math.min(words.length, k + 3);
  return (from > 0 ? '…' : '') + words.slice(from, to).join(' ') + (to < words.length ? '…' : '');
}

// An AskUserQuestion answer about pushing / deploying: approves, declines (null) or says nothing (undefined).
function answerApproval(question, label, list) {
  const q = clean(question);
  if (!ANY_RE.test(q)) return undefined;
  const l = String(label || '');
  const direct = promptApproval(l, null, list);
  if (direct) return { ...direct, via: 'answer', quote: l.trim() };
  if (isAffirmative(clean(l).split(/[,(—-]/)[0]) && !NEG_RE.test(q) && !HOLD_RE.test(q)) {
    const sc = askedAbout(q.endsWith('?') ? q : q + '?') || 'all';
    return { scope: sc, quote: l.trim(), via: 'answer' };
  }
  return null;
}

// ---------- per-session state ----------
// last: the user's last typed prompt { text, at, approval } — set when Helm hands it to the CLI.
const state = new WeakMap();
// The protected repos for this session's Helm (its prod-guard.json), for the approval words.
const sessionTargets = (session) => targets(session && session.engine && session.engine.userDataDir);
const st = (session) => {
  let x = state.get(session);
  if (!x) { x = { human: new Set(), last: null }; state.set(session, x); }
  return x;
};

// session.send(): only origin 'user' (a client send RPC) counts; Helm-generated sends ('helm') and
// internal calls without an origin neither count nor reset anything.
function noteSend(session, item, origin) {
  if (origin !== 'user' || !item || !item.uuid) return;
  const x = st(session);
  x.human.add(item.uuid);
  if (x.human.size > 50) x.human.delete(x.human.values().next().value);
}

// session._pushToCli(): the prompt reaches Claude now (a queued one only when its turn comes).
function notePushed(session, item) {
  if (!item || !item.uuid) return;
  const x = state.get(session);
  if (!x || !x.human.has(item.uuid)) return;
  x.human.delete(item.uuid);
  const prev = session.s && session.s.lastText;
  x.last = { text: String(item.text || ''), at: Date.now(), approval: promptApproval(item.text, prev, sessionTargets(session)) };
}

// lane steer: the user's prompt went to Helm's queue (it reaches Claude only when the turn ends). It cannot grant
// an approval before Claude reads it, but one that grants none ("don't push", or any other prompt, the way
// notePushed would decide) takes a standing approval back NOW, so the running turn cannot push on it.
function noteQueued(session, item) {
  if (!item || !item.uuid) return;
  const x = state.get(session);
  if (!x || !x.human.has(item.uuid) || !x.last || !x.last.approval) return;
  if (promptApproval(item.text, session.s && session.s.lastText, sessionTargets(session))) return;
  x.last = { text: String(item.text || ''), at: Date.now(), approval: null };
}

// session.respond() for an AskUserQuestion: an answer to a question about pushing sets or clears it.
function noteAnswer(session, item, answers) {
  const qs = Array.isArray(item && item.questions) ? item.questions : [];
  for (const [q, v] of Object.entries(answers || {})) {
    const qt = (qs.find((x) => x && x.question === q) || {}).question || q;
    const a = answerApproval(qt, v, sessionTargets(session));
    if (a === undefined) continue;
    st(session).last = { text: String(v), at: Date.now(), approval: a };
  }
}

function priorApproval(session, verdict) {
  const x = state.get(session);
  const a = x && x.last && x.last.approval;
  if (!a || !verdict.approvable) return null;
  if (verdict.approvable === 'restart' && (a.scope === 'all' || a.scope === 'restart')) return { ...a, at: x.last.at };
  if (verdict.approvable === 'all' && a.scope === 'all') return { ...a, at: x.last.at };
  return null;
}

// ---------- settings ----------
let settingsCache = { file: null, mtime: -1, on: true };
function enabled(userDataDir) {
  if (!userDataDir) return true;
  const file = path.join(userDataDir, 'settings.json');
  try {
    const m = fs.statSync(file).mtimeMs;
    if (settingsCache.file === file && settingsCache.mtime === m) return settingsCache.on;
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    settingsCache = { file, mtime: m, on: !(j && j.prodGuard === false) };
    return settingsCache.on;
  } catch {
    return true; // missing or unreadable settings: the guard stays on
  }
}

// ---------- the hook ----------
const deny = (reason) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
const hhmm = (ts) => { const d = new Date(ts); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

// opts: { waitMs?, targets?, git?, gh?, home? } (tests)
// An unreadable prod-guard.json is never only a log line: the session shows a warning with the reason, once
// per broken version of the file (fixing it and breaking it again warns again). Guard off: nothing to say.
function warnIfUnreadable(session) {
  try {
    const dataDir = session && session.engine && session.engine.userDataDir;
    const x = st(session);
    const s = enabled(dataDir) ? configStatus(dataDir) : null;
    if (!s || s.state !== 'unreadable') { x.unreadableWarned = null; return; }
    if (x.unreadableWarned === s.key) return;
    x.unreadableWarned = s.key;
    session.norm.system('guard-warn', `Production guard: Helm could not read ${s.file} (${s.why}). Until it is fixed, Helm asks before every git push and refuses worktree merges. Fix or delete the file to go back to your list.`);
  } catch {}
}

function createHook(session, opts = {}) {
  const waitMs = opts.waitMs || WAIT_MS;
  if (!opts.targets) warnIfUnreadable(session);
  const callback = async (input, toolUseID, ctx = {}) => {
    const signal = ctx.signal;
    let verdict = null;
    try {
      const toolName = input && input.tool_name;
      if (!toolName) return {};
      const dataDir = session.engine && session.engine.userDataDir;
      if (!enabled(dataDir)) return {};
      const list = opts.targets || targets(dataDir, { log: (level, msg) => log(session, level, msg) });
      if (!opts.targets) warnIfUnreadable(session);
      verdict = await assess(toolName, input.tool_input, { cwd: input.cwd || session.s.cwd, targets: list, git: opts.git, gh: opts.gh, home: opts.home });
      if (!verdict) return {};
      const cmd = input.tool_input && typeof input.tool_input.command === 'string' ? input.tool_input.command : toolName;
      const prior = priorApproval(session, verdict);
      if (prior) {
        const line = `${verdict.short} allowed · you said “${prior.quote}” at ${hhmm(prior.at)}`;
        session.norm.system('info', line, undefined, { guard: { auto: true, title: verdict.title } });
        log(session, 'info', `prod-guard: ${session.s.id} let "${oneLine(cmd, 120)}" through (${verdict.title}); the user said "${prior.quote}" at ${hhmm(prior.at)}`);
        return {};
      }
      if (signal && signal.aborted) return deny('Cancelled before the user answered; the command was NOT run.');
      log(session, 'info', `prod-guard: ${session.s.id} asking the user: ${verdict.title}: ${oneLine(cmd, 160)}`);
      const result = await ask(session, toolName, input.tool_input || {}, toolUseID, signal, verdict, waitMs);
      if (result.behavior === 'allow') {
        log(session, 'info', `prod-guard: ${session.s.id} the user allowed ${verdict.title}`);
        return {};
      }
      log(session, 'info', `prod-guard: ${session.s.id} blocked ${verdict.title} (${result.why})`);
      return deny(result.reason);
    } catch (e) {
      log(session, 'error', `prod-guard: ${session.s && session.s.id} guard failed, denying: ${e.stack || e.message}`);
      return deny(`Helm's production guard could not check this command (${e.message}), so it was blocked and NOT run. Ask the user before pushing or deploying.`);
    }
  };
  return { hooks: [callback], timeout: HOOK_TIMEOUT_S };
}

function oneLine(s, max) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}
function log(session, level, msg) {
  try { session.engine.log(level, msg); } catch {}
}

// Show the card (session._canUseTool's request flow: Deck, phone push, notifications, waiting status)
// and wait. Resolves { behavior: 'allow' } or { behavior: 'deny', reason, why }.
function ask(session, toolName, toolInput, toolUseID, signal, verdict, waitMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
    const what = verdict.title.replace(/^[^·]*·\s*/, '');
    const timer = setTimeout(() => {
      const r = [...session.requests.values()].find((x) => x.item.guard && x.item.toolUseId === toolUseID && x.item.status === 'pending');
      if (r) {
        session.norm.store.patch(r.item.id, { timedOut: true });
        session._cancelRequest(r, 'No answer');
      }
      finish({ behavior: 'deny', why: 'no answer', reason: `The user did not answer the production approval (${verdict.title}) within ${Math.round(waitMs / 60000)} minutes, so it was blocked and NOT run. Do not retry it or work around the guard; tell them it is waiting for their go-ahead.` });
    }, waitMs);
    let p;
    try {
      p = session._canUseTool(toolName, toolInput, {
        toolUseID,
        signal,
        title: verdict.title,
        description: verdict.description,
        guard: { kind: verdict.kind, title: verdict.title, approvable: verdict.approvable, hits: verdict.hits, waitMin: Math.round(waitMs / 60000) },
      });
    } catch (e) {
      finish({ behavior: 'deny', why: 'error', reason: `Helm's production guard failed to show the user the approval (${e.message}), so it was blocked and NOT run.` });
      return;
    }
    Promise.resolve(p).then((r) => {
      if (r && r.behavior === 'allow') return finish({ behavior: 'allow' });
      const msg = r && r.message ? String(r.message) : '';
      if (r && r.interrupt) return finish({ behavior: 'deny', why: msg || 'cancelled', reason: `${msg || 'Cancelled'}: the production approval (${what}) was withdrawn and the command was NOT run.` });
      const note = msg && msg !== 'The user denied this action.' ? ` Their note: "${msg}"` : '';
      // The decline covers THIS attempt only. Worded as a standing block, Claude refused later pushes the user asked
      // for in new messages ("you'll need to lift that block first"; fixup 2026-10-09). Any retry still gets a card.
      finish({ behavior: 'deny', why: 'denied', reason: `The user declined this production action (${verdict.title}). It was NOT run. Do not retry it or work around the guard in this turn. The decline covers this attempt only, not later ones: if a later message asks for it again, run it again and Helm will ask the user again.${note}` });
    }, (e) => finish({ behavior: 'deny', why: 'error', reason: `Helm's production guard failed (${e && e.message}), so it was blocked and NOT run.` }));
  });
}

module.exports = {
  WAIT_MS,
  HOOK_TIMEOUT_S,
  CONFIG_FILE,
  targets,
  configStatus,
  parseConfig,
  normalizeRemote,
  scan,
  collect,
  assess,
  promptApproval,
  answerApproval,
  isAffirmative,
  askedAbout,
  noteSend,
  notePushed,
  noteQueued,
  noteAnswer,
  priorApproval,
  enabled,
  createHook,
  runGit,
};
