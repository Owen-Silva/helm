// Plain error words for toasts (lane helm-plainerror, 2026-10-14; backlog P-H1). Before this, ~50 toasts
// put e.message straight into the body, so the user read whatever the RPC, Node or the browser threw:
// "ENOENT: no such file or directory, open 'C:\...'", "connect ECONNREFUSED 127.0.0.1:4871", stack text,
// Claude Code's stderr. Modelled on Mantle's lib/plain-error.js, cut down to what can happen in Helm (no
// HRESULTs, Win32 numbers or Windows Update codes: Helm's errors come from Node, the browser, the Agent
// SDK and Helm's own RPC codes).
//
// The rule: a WRONG plain reason is worse than the raw text, so only codes with a documented meaning are
// put into words (Node errno names, DOM exception names, V8's own TypeError wording, the SDK's exit
// message, Helm's 'disconnected' / 'unknown_method' / 'internal' codes). A message Helm wrote itself that
// is already a plain sentence is shown as it is. Anything else gets an honest generic line. In every case
// where the words differ from the raw text, the raw text goes to `details`, which the toast shows under a
// "Details" disclosure, so nothing is hidden (feedback: no silent failures).
//
//   plainError(e)  -> { text, details, code }   text: one or two sentences, ends with a full stop.
//                     details: the raw text (message, plus the code when the message lacks it), or null
//                     when text already IS the raw text. code: e.code / e.name when there was one.
//   errorToast(t)  -> t with { error } replaced by { body, details }: store.js toast() calls it, so a call
//                     site writes toast({ title: 'Could not fork', error: e, kind: 'error' }). A t.body
//                     given as well is kept as the first sentence (context), the plain words follow it.
// Pure: no DOM, no imports; loaded by node tests via require(esm).

/* Node errno names (nodejs.org/api/errors.html#common-system-errors and libuv's uv_strerror list). `n` is
   the file or folder name when Node's message carries one ("..., open 'C:\x\y.json'" -> "y.json"). */
const ERRNO = {
  ENOENT: (n) => n ? `"${n}" was not found. It may have been moved or deleted.` : 'A file or folder it needed was not found. It may have been moved or deleted.',
  EACCES: (n) => `Access to ${n ? `"${n}"` : 'a file or folder'} was denied. Close any app that is using it, or check its permissions, then try again.`,
  EPERM: (n) => `Access to ${n ? `"${n}"` : 'a file or folder'} was denied. Close any app that is using it, or check its permissions, then try again.`,
  EBUSY: (n) => `${n ? `"${n}"` : 'A file Helm needed'} is in use by another app. Close it there and try again.`,
  ENOSPC: () => 'The disk is full. Free up some space and try again.',
  EEXIST: (n) => `${n ? `"${n}"` : 'Something with that name'} already exists.`,
  ENOTEMPTY: (n) => `${n ? `The folder "${n}"` : 'The folder'} is not empty.`,
  EISDIR: (n) => `${n ? `"${n}"` : 'That'} is a folder, not a file.`,
  ENOTDIR: () => 'Part of that path is a file, not a folder.',
  ENAMETOOLONG: () => 'The file path is too long.',
  EMFILE: () => 'Too many files are open at once. Try again in a moment.',
  ENFILE: () => 'Too many files are open at once. Try again in a moment.',
  EROFS: () => 'The disk is read-only.',
  ECONNREFUSED: (n) => `Nothing answered at ${n || 'that address'}. The service there may not be running.`,
  ETIMEDOUT: () => 'The connection timed out. Check the network and try again.',
  ECONNRESET: () => 'The other side closed the connection before it finished. Try again.',
  ECONNABORTED: () => 'The other side closed the connection before it finished. Try again.',
  EPIPE: () => 'The other side closed the connection before it finished. Try again.',
  ENOTFOUND: (n) => `${n ? `The address "${n}"` : 'The address'} could not be looked up. Check the address and the internet connection.`,
  EAI_AGAIN: (n) => `${n ? `The address "${n}"` : 'The address'} could not be looked up just now. Check the internet connection and try again.`,
  ENETUNREACH: () => 'The network could not be reached. Check the internet connection.',
  EHOSTUNREACH: () => 'The network could not be reached. Check the internet connection.',
  ENETDOWN: () => 'The network could not be reached. Check the internet connection.',
};
const ERRNO_RE = new RegExp(`\\b(${Object.keys(ERRNO).join('|')})\\b`);

/* DOMException names (webidl.spec.whatwg.org#idl-DOMException-error-names). */
const DOM = {
  AbortError: 'It was cancelled before it finished.',
  TimeoutError: 'It took too long and was stopped. Try again.',
  NotAllowedError: 'The browser blocked it, or a permission was turned down. Click into Helm and try again.',
  NotReadableError: 'The file could not be read. It may be open in another app, or it changed while being read.',
  QuotaExceededError: 'There is not enough storage space left for it.',
  SecurityError: 'The browser blocked it for security reasons.',
};

const GENERIC = 'Something unexpected went wrong. The exact error is under Details.';
const GENERIC_TAIL = 'The exact error is under Details.';
const NO_TEXT = 'Something went wrong, and no error text came with it.';
// JSON-RPC 2.0 reserves -32768..-32000 for errors the SERVER sends back (jsonrpc.org/specification#error_object)
const JSONRPC = 'The service it was sent to answered with an error. The exact error is under Details.';
const BUG = 'Helm hit a programming error (a bug, not something you did). The exact error is under Details.';
const NET = 'The network request failed. Check the connection and try again.';
// main/rpc.js rejects every pending call when the socket closes, so a call may or may not have run first
const DISCONNECTED = 'Helm lost its connection to its backend, so this may not have gone through. Check, then try again once it reconnects.';
const UNKNOWN_METHOD = 'Helm\'s backend does not know this action. This usually means Helm was updated and needs a restart.';

/* V8's own wording for programming mistakes: these only ever mean a bug in Helm's code. */
const BUG_RE = /\b(?:Cannot read propert(?:y|ies) of (?:undefined|null)|Cannot set propert(?:y|ies) of (?:undefined|null)|is not a function|is not defined|is not iterable|is not a constructor|Maximum call stack size exceeded|Cannot access '[^']+' before initialization)\b/;
/* Browser fetch failures: Chromium "Failed to fetch", Firefox "NetworkError when attempting...", Safari "Load failed". */
const FETCH_RE = /^(?:Failed to fetch|NetworkError when attempting to fetch resource\.?|Load failed)$/;
/* Agent SDK 0.3.x wording (node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs): "Claude Code process exited with
   code N. stderr: <tail>", "Claude Code process terminated by signal X", "Claude Code executable not found at P. ..." */
const CC_EXIT_RE = /\bClaude Code process exited with code (-?\d+)|\bClaude Code process terminated by signal (\w+)/;
const CC_MISSING_RE = /\bClaude Code executable not found at (.+?)\. Is options\.pathToClaudeCodeExecutable set\?/;
const SPAWN_RE = /\bspawn (\S+) ENOENT\b/;

/* What makes a message technical rather than a sentence for a person. */
const TECH = [
  ERRNO_RE,
  /\bERR_[A-Z_]{3,}\b/,
  /^\s*at\s.+(?::\d+:\d+\)?|\(native\))\s*$/m,                    // a stack frame
  /\b[A-Z]\w*(?:Error|Exception)\b/,                                // TypeError, AbortError, DOMException
  /(?:^|\s)Error:/,                                                 // "Error: ..." prefixes
  /\b0x[0-9a-fA-F]{4,}\b/,
  /\[object \w+\]/,
  /\b(?:undefined|NaN)\b/,
  /\bstderr\b|\bstdout\b/i,
  /\bexited with code\b|\bterminated by signal\b|\bSIG[A-Z]{3,}\b/,
  /[{[]\s*"[\w$-]+"\s*:/,                                           // JSON
  BUG_RE,
];

function techAt(s) {
  let at = -1;
  for (const re of TECH) { const m = re.exec(s); if (m && (at < 0 || m.index < at)) at = m.index; }
  return at;
}
// a sentence for a person: two or more words with letters, short, no technical marks ("42" or "boom" is not one)
const isPlainSentence = (s) => !!s && s.length <= 300 && s.split('\n').length <= 2 && /[A-Za-z]{2,}\S*\s+\S*[A-Za-z]/.test(s) && techAt(s) < 0;
const sentence = (s) => { s = String(s).trim().replace(/[\s:;,-]+$/, ''); if (!s) return s; s = s[0].toUpperCase() + s.slice(1); return /[.!?]$/.test(s) ? s : s + '.'; };
const baseName = (p) => String(p).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;

/* The raw text and code of anything thrown: Error, DOMException, a JSON-RPC error object, a string, junk. */
function rawOf(e) {
  if (e == null) return { message: '', code: null, name: null };
  if (typeof e === 'string') return { message: e, code: null, name: null };
  if (typeof e !== 'object') return { message: String(e), code: null, name: null };
  // a JSON-RPC style reply object { error: { code, message } } or the error object itself
  const o = e.error && typeof e.error === 'object' && !(e instanceof Error) ? e.error : e;
  let message = typeof o.message === 'string' ? o.message : '';
  if (!message && !(o instanceof Error)) { try { message = JSON.stringify(o); } catch { message = String(o); } if (message === '{}') message = ''; }
  // a DOMException's numeric .code is a legacy number (20 = ABORT_ERR); its name is the meaning
  const legacyDom = typeof DOMException !== 'undefined' && o instanceof DOMException;
  const code = !legacyDom && o.code != null && o.code !== '' ? String(o.code) : null;
  const name = typeof o.name === 'string' && o.name !== 'Error' ? o.name : null;
  return { message, code, name };
}

/* Node fs / net messages carry the subject: "ENOENT: ..., open 'C:\a\b.json'", "connect ECONNREFUSED 127.0.0.1:4871",
   "getaddrinfo ENOTFOUND api.example.com". */
function subjectOf(code, msg) {
  const q = /, \w+ '([^']+)'/.exec(msg);
  if (q) return baseName(q[1]);
  const net = new RegExp(`\\b${code} (\\S+)`).exec(msg);
  if (net && /^[\w.:[\]-]+$/.test(net[1])) return net[1];
  return null;
}

/* Words for the technical part, or null when nothing in it has a meaning we can vouch for. */
/* Messages whose whole wording is known (read against the full text, before any lead-in split). */
function wholeReason(msg) {
  const missing = CC_MISSING_RE.exec(msg);
  if (missing) return `Claude Code was not found at ${missing[1]}. Install it (or set HELM_CLAUDE_EXE) and try again.`;
  const sp = SPAWN_RE.exec(msg);
  if (sp) return `Helm could not start "${baseName(sp[1])}": the program, or the folder it runs in, was not found.`;
  const ex = CC_EXIT_RE.exec(msg);
  if (ex) return ex[1] != null ? `Claude Code stopped with an error (exit code ${ex[1]}). Its own output is under Details.` : `Claude Code was stopped (signal ${ex[2]}).`;
  if (FETCH_RE.test(msg)) return NET;
  return null;
}

/* Words for the technical part after a lead-in, or null when nothing in it has a meaning we can vouch for. */
function reasonOf(msg, code) {
  // only V8's wording, not the name: a TypeError is also what new URL('x') or a bad argument throws
  if (BUG_RE.test(msg)) return BUG;
  const errno = (code && ERRNO[code] && code) || (ERRNO_RE.exec(msg) || [])[1];
  if (errno) return ERRNO[errno](subjectOf(errno, msg));
  return null;
}

export function plainError(e) {
  const { message, code, name } = rawOf(e);
  const msg = message.trim();
  const tag = code || name;
  if (!msg && !tag) return { text: NO_TEXT, details: null, code: null };   // undefined, null, '', new Error()
  const details = !msg ? tag : tag && !msg.includes(tag) ? `${msg} (${tag})` : msg;

  const out = (text) => ({ text, details: details !== text ? details : null, code: tag });

  // Helm's transport and RPC codes: the message is a developer's word ("connection lost", "unknown method: x").
  if (code === 'disconnected') return out(DISCONNECTED);
  if (code === 'unknown_method') return out(UNKNOWN_METHOD);
  // A DOMException's name is its documented meaning; its message is browser wording
  // ("Failed to execute 'writeText' on 'Clipboard': Document is not focused.").
  if (name && DOM[name]) return out(DOM[name]);
  if (code && /^-32[0-7]\d\d$/.test(code)) return out(JSONRPC);
  if (!msg) return out(GENERIC);

  // A message that is already a sentence for a person ("Folder not found: C:\p", "3 commands are already running
  // here") is shown as it is: it IS the raw text, so no reason is invented and nothing is hidden. This includes
  // code 'internal' (main/rpc.js gives that to anything thrown without a code, Helm's own throws among them).
  const whole = wholeReason(msg);
  if (whole) return out(whole);
  const at = techAt(msg);
  // (a Node/system code the words leave out, e.g. "Invalid URL" + ERR_INVALID_URL, still goes to Details)
  if (at < 0 && isPlainSentence(msg)) return { text: sentence(msg), details: tag && /^(?:E[A-Z]{2,}|ERR_[A-Z_]+)$/.test(tag) && details !== msg ? details : null, code: tag };

  // A plain lead-in ("Could not read the Claude Code transcripts: ENOENT: ...") keeps its words; the technical
  // rest becomes known words, or the generic tail.
  const reason = reasonOf(at > 0 ? msg.slice(at) : msg, code);
  const lead = at > 0 ? msg.slice(0, at).replace(/[\s:;,(—-]+$/, '') : '';
  if (lead.length >= 8 && /\s/.test(lead) && isPlainSentence(lead)) return out(`${sentence(lead)} ${reason || GENERIC_TAIL}`);
  return out(reason || GENERIC);
}

export function errorToast(t) {
  if (!t || !('error' in t)) return t;
  const { error, ...rest } = t;
  const p = plainError(error);
  const body = rest.body ? `${sentence(rest.body)} ${p.text}` : p.text;
  return { ...rest, body, ...(p.details ? { details: p.details } : {}) };
}
