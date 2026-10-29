# Helm protocol (the contract every lane builds against)

The renderer (`ui/`) never talks to Claude Code directly. The main process hosts
one HTTP + WebSocket server; the Electron window and the phone both load the UI
from it and speak this protocol over one WebSocket. `ui/lib/transport.js` is the
only client; `ui/lib/mock-data.js` is a worked example of every shape below.

Change this file first (and say so in your report) if a shape has to change.

## Transport

`GET /` serves `ui/`. `GET /ws` upgrades to a WebSocket. Every connection must
present the token (`?token=` on the WS URL, or the `helm_key` cookie set by
`GET /?key=<token>`), loopback included: a WebSocket has no CORS, so without the
token any web page could drive Claude with bypass permissions. The server also
rejects a WS whose `Origin` is not its own host (HTTP 403 before the handshake). A WS
with a missing or wrong token is accepted and immediately closed with code **4401**;
`transport.onStatus` then reports `'unauthorized'` (statuses: `connecting | open | closed |
unauthorized`) so the UI can tell the user to re-pair instead of spinning. The window's
`?token=` is moved to sessionStorage and stripped from the address bar on load. Token lives in
`<userData>/token.txt`. Bind `127.0.0.1` always, plus the Tailscale IPv4 when
the interface is up. Never `0.0.0.0`.

Frames are JSON:

```
client → server   { "id": 7, "type": "rpc", "method": "sessions.send", "params": { ... } }
server → client   { "id": 7, "type": "result", "result": { ... } }
                  { "id": 7, "type": "result", "error": { "message": "...", "code": "...", "data"?: { ... } } }   (data: e.g. agents_running)
server → client   { "type": "event", "event": "session.item", "data": { ... } }
```

On (re)connect the client calls `app.hello` and replaces its whole state with
the snapshot; events after that are deltas.

## Objects

### Session
```js
{
  id: "s_8f2a",                 // Helm's id (stable across restarts)
  claudeSessionId: "uuid|null",  // Claude Code's session id once known (resume key)
  title: "Fix login redirect",   // auto from first prompt, renamable
  cwd: "C:\\Users\\you\\code\\storefront",
  project: "storefront",         // basename of cwd (grouping key in the sidebar)
  status: "idle" | "working" | "waiting" | "error" | "closed",
  // waiting = a request (permission / question / plan) needs the user
  model: "claude-opus-5-5", effort: "xhigh",
  permissionMode: "bypassPermissions" | "default" | "acceptEdits" | "plan",
  createdAt: 1791400000000, updatedAt: 1791400100000,
  costUsd: 0.42,                 // Claude Code's own cumulative total for the conversation (result.total_cost_usd,
                                 // else its status line / transcript cost-state); null = unknown. Never Helm's sum.
  context: { usedTokens: 84000, windowTokens: 1000000, percent: 8.4 },
  activity: "Running npm test",  // one-line "what it is doing now", null when idle
  turnStartedAt: 1791400090000 | null,
  unread: 3,                     // items since the user last looked (ui-side may override)
  queued: 1,                     // prompts waiting to send after the current turn
  pinned: false,                 // "Keep in list" in the sidebar
  resumedAt: null                // when picked back up from Past (see "Sidebar: active sessions + Past")
}
```

### Item (transcript entry)

Every item has `id` (unique within the session), `type`, `ts`. Items stream:
`session.item` appends, `session.itemUpdate` patches (shallow merge; `appendText`
appends to `text` for streaming).

| type | fields |
| --- | --- |
| `user` | `text`, `attachments: [{ kind:"image"|"file", name, mime, dataUrl? , path? }]`, `queued?: bool`, `steer?: "pending"|"seen"|"after"` (sent while a turn ran, see "Mid-turn messages and Stop"), `seenAt?`, `helmNote?` (Helm's note to Claude that rode with this message, e.g. which agents a Stop ended: render as a small line, never inside the bubble) |
| `assistant` | `text` (markdown, grows while streaming), `streaming: bool`, `model` |
| `thinking` | `text`, `streaming: bool`, `redacted?: bool` |
| `tool` | `toolUseId`, `name` (e.g. `Bash`, `Edit`, `mcp__eta__Eta`), `input` (raw tool input object), `status: "running"|"done"|"error"|"denied"`, `interrupted?: true` (status is `"error"` but the tool was stopped by `sessions.interrupt`, a session close, or a "[Request interrupted by user…]" line in history: render a neutral "Stopped", not "Failed"; absent on old items and on real failures), `result` (string or `{ text, images?: [dataUrl] }`), `startedAt`, `endedAt?`, `parentToolUseId?` (set when emitted inside a subagent: the `Agent`/`Task` tool_use that owns it) |
| `request` | `requestId`, `kind: "permission"|"question"|"plan"`, `toolName`, `input`, `questions?` (AskUserQuestion shape: `[{question, header, multiSelect, options:[{label, description, preview?}]}]`), `plan?` (markdown, ExitPlanMode), `status: "pending"|"answered"|"cancelled"`, `answer?`, `parentToolUseId?` |
| `system` | `subtype: "init"|"compact"|"error"|"interrupted"|"info"|"hook"`, `text`, `rewind?: { checkpointId, fromItemId, files, conversation }` (only on the `info` marker `sessions.rewind` adds; with `conversation: true`, the items from `fromItemId` up to this marker are what Claude no longer sees, and the UI folds them into a dimmed "N messages rewound" row) |
| `result` | `durationMs`, `costUsd`, `numTurns`, `isError`, `usage: { input, output, cacheRead, cacheWrite }`, `subtype?` (Claude Code's result subtype), `interrupted?: true` — renders as "Worked for 28s · $0.12". `interrupted` is set when the turn ended because of `sessions.interrupt`: then `isError` is always false (even though Claude Code reports `error_during_execution`), no `system`/`error` item follows (the `system`/`interrupted` item added by the interrupt already explains it), and the row renders as a muted "Stopped after 0s". Error text in `system`/`error` items never carries Claude Code's internal diagnostic lines (`[ede_diagnostic] …`, any line led by a bracketed snake_case tag). |

Rendering notes for the conversation lane: `TodoWrite` → checklist; `Edit` /
`MultiEdit` / `Write` → diff from `input` (`old_string`/`new_string`,
`edits[]`, `content`); `Agent`/`Task` → collapsible card holding every item
whose `parentToolUseId` equals its `toolUseId`; `AskUserQuestion` arrives as a
`request` of kind `question` (and its matching `tool` item); `mcp__*` → generic
card with the server name.

### Request answers (`sessions.respond`)
```js
// permission
{ behavior: "allow" | "deny", message?: "why", always?: true /* allow this tool for the session */ }
// question (AskUserQuestion): answers keyed by question text; Other = free text
{ answers: { "Which name?": "Helm", "What extras?": "History search, Preview pane" } }
// plan (ExitPlanMode)
{ behavior: "allow", mode?: "acceptEdits" | "bypassPermissions" } | { behavior: "deny", message: "change X" }
// production guard (a permission request with `guard`, see "Production guard"): allow once or deny;
// `always` is ignored for it
{ behavior: "allow" } | { behavior: "deny", message?: "the user's note" }
```

### Agent (fleet)
```js
{ id: "toolu_01..", sessionId, parentId: null | "toolu_..", depth: 0,
  description: "[lane:engine] build engine", subagentType: "opus-high",
  status: "running" | "done" | "error" | "stopped", startedAt, endedAt?,
  context: { usedTokens, windowTokens, percent }, toolCount: 14, lastTool: "Edit",
  costUsd?,
  // lane fleet (2026-10-08):
  agentId?: "a89cb7bcc497b64c3",   // Claude Code's agent id (= SDK task_id; SendMessage `to`)
  endEstimated?: true,             // endedAt is inferred (last event in the agent's own transcript), not a completion record
  resumedAt?, runs?: [{ startedAt, endedAt, estimated? }] }   // SendMessage resume: this run's start + the earlier runs
```
- `stopped`: ended with no completion record: its CLI exited (background agents run inside the CLI and stop
  with it), it was killed, or the transcript has no task notification for it. Not a failure.
- A non-running agent may have NO `endedAt` (stopped, end unknown: no own transcript on disk). Clients must
  never treat that as "still going": no duration, no overlap. Running = `status === "running"` only.
- SendMessage to a stopped agent resumes it: `status` back to `running`, `resumedAt` = now, the finished
  run appended to `runs`, `endedAt` cleared. Run time = sum of `runs` + the current run.
- Rebuilding from a transcript (open, older page) keeps the live state of agents already tracked.
- `Session.agentsRunning`: number of fleet agents with `status: "running"` (live only, never persisted;
  re-sent on `session.updated` when it changes). `status` keeps meaning "a turn is active"; an `idle`
  session with `agentsRunning > 0` DISPLAYS as working (ui/lib/session-status.js `displayStatus`).
  `recycleClis` treats it as busy; a conversation rewind answers `busy` while its agents run.
  `ExternalSession.agentsRunning` = max(the eta mod's count while its snapshot is under 10 min old, agent transcripts written in the last 90 s).

### Usage
```js
{ fiveHour: { percent: 12, resetsAt: 1791410000000 }, week: { percent: 3, resetsAt },
  costTodayUsd, source: "statusline|sdk|estimate", updatedAt }
```
Fields may be null when unknown; the UI shows the reason, never a fake number.

Accuracy additions (lane accuracy, 2026-10-14):
- `ageMs`: now minus `updatedAt`. `stale: true` when over 30 min: no Claude Code turn has refreshed the
  reading, so claude.ai or other-device use since is missing. Meters dim and say "as of N ago"; usage
  history does not sample a stale reading.
- `costTodayUsd` comes from the persisted ledger (`usage-history.jsonl`), so a Helm restart no longer resets
  it. `costTodaySince` (epoch ms | null): counting began after local midnight (the ledger's v2 marker).
- Turn cost = the rise of Claude Code's counter since the CLI's last result (first result: since the
  figure the CLI restored from the transcript's newest `cost-state`). Before 2026-10-14 every resume
  re-added the conversation's lifetime cost; those ledger records (no `v:2`) are never summed.
- `usage.history` → `costByDay[i]` may carry `unknown: true, usd: null` (before the v2 marker) or
  `partial: true, since` (the marker's day); the result carries `costSince` (null = all days complete).

### Queue job (overnight queue)
```js
{ id: "q_1", prompt, cwd, model, effort, permissionMode,
  runAfter: 1791420000000 | null,   // null = as soon as the 5H budget allows
  maxFiveHourPercent: 85,           // don't start while 5H use is above this
  status: "queued" | "running" | "done" | "failed" | "cancelled",
  sessionId?: "s_..", summary?: "what happened (filled when done)", createdAt,
  waitReason?: "5-hour usage is 91%, above this job's 85% limit",  // why a queued job hasn't started
  startedAt?, endedAt? }
```
One job runs at a time. The 5H gate (`maxFiveHourPercent`) applies only when Account `usageLimits` is true. With an
API key (Helm's, or the one Claude Code is signed in with), a Console login or a cloud provider there is no 5-hour
window, so jobs run without the gate, still one at a time. While Account `ready` is false (e.g. Claude Code isn't
signed in), the next job waits with `waitReason` = the Account `reason`.

### History entry (past Claude Code sessions on disk)
```js
{ claudeSessionId, cwd, project, title /* first prompt or summary */, firstPrompt,
  lastActivity, messageCount, sizeBytes, helmSessionId? /* if already open */ }
```

### Settings
```js
{ background: { kind: "image", file: "forest.jpg", blur: 28, dim: 0.45 },
  backgrounds: ["forest.jpg", ...],      // files in <userData>/backgrounds, served at /bg/<file>
  theme: "dark" | "light" | "system",
  defaults: { model, effort, permissionMode, cwd },
  projects: [{ cwd, name, pinned }],     // sidebar projects (recent cwd list)
  snippets: [{ id, name, text }],
  notifications: { waiting: true, done: true, error: true },
  phone: { enabled: true, url: "http://my-pc.example.ts.net:4871/?key=..." | null } }
```

Look Sync keys (lane look-sync, 2026-10-10; see "Look Sync" below):
```js
{ background: { kind: "image", mode: "desktop" | "own", file, blur, dim },  // mode default "desktop"
  accentHue: null | 0..360,              // whole number; null = Helm's own accent
  accentTokens: null | { dark, light },  // derived from accentHue (main/accent.js); read-only, settings.set drops it
  glass: { dark:  { blurPx: 0..64, dim: 0.20..0.90, panel: -0.30..0.15 },
           light: { blurPx, dim, panel },
           render: "picture" | "seeThrough" },
  lookSync: { enabled: true } }
```
- `background.mode`: `desktop` follows the desktop wallpaper (served at `/bg/desktop`); `own` shows `background.file`.
  The mode and the own picture are always per app; they are never synced.
- `glass` is per theme. A partial `glass` in `settings.set` merges per theme: `{ glass: { light: { dim: 0.6 } } }`
  changes only that value. Out-of-range values are refused (`bad_params`). Seed: dark `{ 5, 0.50, 0 }`,
  light `{ 12, 0.45, 0 }`, render `picture`.
- Helm paints the glass of the theme showing (look-sync CONTRACT "Light look", 2026-10-14, superseding the
  2026-10-10 light hold): `glass.dark` in dark, `glass.light` in light (blur, dim and panel shift alike; the
  light ground adds saturate(150%) and the wash is white). The Appearance sliders (Blur, Dim, See-through) edit
  the glass of the theme showing and say which ("· light look" / "· dark look").
- `background.blur` / `dim` are now a legacy mirror of `glass.dark`, kept for older clients. An older client
  that sets them changes `glass.dark`, clamped into the ranges above. Only a value that
  differs from the mirror counts, so echoing the whole `background` object back changes nothing.
- Migration (2026-10-10): a settings.json with no `glass` gets its old `background.blur` / `dim` copied into
  BOTH themes (Helm used one value for both), clamped into the ranges, `panel: 0`, render `picture`, so Helm
  looks exactly as before. `background.mode` becomes `desktop`; the picked `file` stays as the own picture.
- A hand-edited bad value falls back to the seed, per value.

## RPC methods

| method | params | result |
| --- | --- | --- |
| `app.hello` | `{}` | `{ version, settings, sessions: [Session], usage, queue: [Job], platform: "electron"|"web", engine: "real"|"fallback", look, test?: true }` (`look`: see "Look Sync") (`test` is present only when main runs with `--test`; the UI then skips first-run sheets such as What's new) |
| `app.ping` | `{}` | `{ t }` (transport keepalive: every 20 s and when the tab becomes visible) |
| `sessions.create` | `{ cwd, model?, effort?, permissionMode?, prompt?, attachments?, resumeClaudeSessionId? }` | `Session` |
| `sessions.history` | `{ id, before?: itemId, limit? }` | `{ items: [Item], hasMore }` |
| `sessions.send` | `{ id, text, attachments?, origin?: "helm" }` (origin: see "Production guard") | `{ itemId, queued: bool, delivery: "now"|"next-step"|"queued" }` (mid-turn: `next-step`; Helm's queue only as the fallback, see "Mid-turn messages and Stop") |
| `sessions.interrupt` | `{ id, stopAgents?: bool }` | `{ stoppedAgents: [name] }`. Refused with code `agents_running` (`error.data.agents: [{ id, name, background }]`) while agents run, unless `stopAgents: true` |
| `sessions.respond` | `{ id, requestId, response }` | `{}` |
| `sessions.update` | `{ id, title?, model?, effort?, permissionMode?, pinned? }` | `Session` |
| `sessions.close` | `{ id }` | `{}` (stops the CLI; session stays resumable) |
| `sessions.commands` | `{ id }` | `[{ name, description, argumentHint }]` (slash commands incl. skills) |
| `sessions.models` | `{}` | `[{ value, displayName, description }]` |
| `sessions.checkpoints` | `{ id }` | `[{ id, itemId, ts, files: [path] }]` |
| `sessions.rewind` | `{ id, checkpointId, files: bool, conversation: bool }` | `{}` — adds the "Rewound to before…" `system`/`info` marker (`rewind` field, see Item). With `conversation`, the session gets a new `claudeSessionId` and a pending fork (`forkFrom`, saved in sessions.json, never sent to clients): the next send forks the old transcript just before `checkpointId` (`resume` + `resumeSessionAt` + `forkSession`). Until then, including across a Helm restart, `sessions.history` shows the old transcript plus the marker(s), so the rewound fold still works; once the CLI reports init the pending fork becomes a sent rewind (`rewinds: [{ forkId, shownId, firstNew, markers }]`, also saved in sessions.json, never sent), and from then on `sessions.history` stitches, tail-first: the history the user was looking at when they rewound (`shownId`, itself stitched if it had rewinds; the rewound part still folds), the marker(s), then the fork's own lines from the first prompt sent after the rewind (`firstNew`). So the marker and fold look the same before and after a restart, while Claude's context is the fork alone. Marker ids are `rw<k>_<j>`; items of older transcripts get `s<k>t…` ids. If a transcript in the chain is missing on disk, history falls back to the fork's own transcript, whole. A marker's `fromItemId` may name an item in an older page not loaded yet: the UI then folds from the top of what it has. Rewinding again before sending forks the same old transcript and keeps the earlier marker(s). Errors: `busy` (turn running), `not_found` (unknown checkpoint, or the prompt is not on disk yet), `rewind_failed` (files). |
| `sessions.markRead` | `{ id }` | `{}` |
| `sessions.release` | `{ id }` | `{ action: 'closed' | 'marked' | 'kept' | 'none', reason? }`: the user closed this session's tab; closes its idle claude.exe now, or once idle (see "Release on tab close") |
| `sessions.viewing` | `{ ids: [id] }` (up to 8; `[]` = none) | `{}`: the sessions this client has on screen now (replaces its last report) |
| `history.search` | `{ q?, limit?, includeTemp? }` | `[HistoryEntry]` (empty q = most recent; sessions whose cwd is under the OS temp dir are left out unless `includeTemp: true`) |
| `files.tree` | `{ cwd, path? }` | `[{ name, path, dir: bool, size, mtime, gitStatus? }]` (one level) |
| `files.read` | `{ path, maxBytes? }` | `{ path, text, truncated, mime, size, binary?, dataUrl? }` (cap 512 KB; binary → text ""; images ≤ 5 MB also get `dataUrl`) |
| `files.search` | `{ cwd, q, limit? }` | `[{ path, rel }]` (for @mentions; git ls-files aware) |
| `files.changes` | `{ sessionId }` | `[{ path, rel, status: "M"|"A"|"D", additions, deletions, touchedBy: [toolUseId] }]` |
| `files.diff` | `{ cwd, path }` | `{ path, before, after }` (git HEAD vs disk) |
| `files.pickFolder` | `{}` | `{ path | null }` (Electron dialog; web → error) |
| `queue.add` | `Job` minus id/status | `Job` |
| `queue.update` | `{ id, ...fields }` | `Job` |
| `queue.remove` | `{ id }` | `{}` |
| `usage.get` | `{}` | `Usage` |
| `settings.get` / `settings.set` | `{}` / partial `Settings` | `Settings` |
| `settings.uploadBackground` | `{ name, dataUrl }` | `Settings` |
| `app.window` | `{ action: "minimize"|"maximize"|"close"|"devtools" }` | `{}` (Electron only) |

## Events

| event | data |
| --- | --- |
| `session.created` / `session.updated` | `Session` (full object) |
| `session.removed` | `{ id }` |
| `session.item` | `{ sessionId, item }` |
| `session.itemUpdate` | `{ sessionId, itemId, patch, appendText? }` |
| `fleet.updated` | `{ sessionId, agents: [Agent] }` (full list for that session) |
| `usage.updated` | `Usage` |
| `queue.updated` | `{ queue: [Job] }` |
| `settings.updated` | `Settings` |
| `files.changed` | `{ sessionId, path }` (a session wrote a file) |
| `notify` | `{ title, body, sessionId?, kind: "waiting"|"done"|"error"|"info" }` |
| `app.select` | `{ sessionId }` (the user clicked a desktop notification: open that session) |

## Desktop-only bridge (preload.js)

`window.helmNative` exists only in the Electron window (undefined on the phone):

```js
window.helmNative = {
  platform: "electron",
  pathForFile(file)  // real filesystem path of a dropped File (File.path is gone in Electron 44), or null
  // Screenshot attach (main/capture.js; IPC helm:capture-sources | helm:capture | helm:capture-crop,
  // answered only for the main window's webContents). desktopCapturer thumbnails: no permission prompt.
  captureSources()   // -> [{ id, name, kind: "screen"|"window", displayId, thumb (JPEG data URL, 320 px box),
                     //       icon (app icon data URL) | null, self (Helm's own window) }], screens first
  capture(id, { hideSelf = true })  // hides a visible Helm ~300 ms (never for its own window, never shows a
                     // hidden one), full native res -> { token, name, width, height, attachment }
                     // (full-res image kept in memory 2 min, latest capture only)
  captureCrop(token, { x, y, width, height })  // full-res px, clamped -> { width, height, rect, attachment }
}
```

`attachment` = `{ kind: "image", name: "Screenshot <source> <YYYY-MM-DD HH.MM>.png|jpg", mime, dataUrl, size, width, height }`:
longest side <= 2000 px (never upscaled), PNG when it is <= 1.5 MB, else JPEG at falling quality, else
smaller dimensions until it fits. The composer's camera button (desktop width only) opens the picker
(`ui/composer/capture.js`); attaching dispatches `helm:composer-attach`. In `?mock=1`,
`ui/lib/mock-capture.js` installs a canvas fake (`platform: "mock"`) and fires `helm:native-ready`.

Window chrome: `titleBarStyle: "hidden"` + `titleBarOverlay`, height **40 px**. Windows draws
min/max/close in the top-right ~140 px, so keep that clear and mark the top bar
`-webkit-app-region: drag` (interactive children `no-drag`). The Preview pane's `<webview>`
always gets partition `persist:helm-preview` (the host forces it), no preload, no node;
links that open new windows go to the user's default browser.

## Round 3 additions (2026-10-08)

### Session.eta
Live ETA from an optional Claude Code eta mod, which writes `~/.claude/mods-data/eta/<claudeSessionId>.json`
inside every Claude Code session (Helm's included). `null` when no snapshot exists.
```js
eta: { state: "working"|"idle"|"ended"|..., label, summary, note?, step?, steps?: [label],
       etaAt: 1791450000000 | null, workStartedAt, isOverdue, agentsRunning, updatedAt }
```
Delivered on `Session` via `session.updated` (engine watches the file while the session is live).
`step` is what the mod wrote: a 1-based number into `steps`, or a step label string. Times are epoch ms.

### Fork / edit-and-resend
| method | params | result |
| --- | --- | --- |
| `sessions.fork` | `{ id, itemId?, text?, attachments? }` | `Session` — a NEW Helm session whose conversation is the source's history up to but NOT including the user item `itemId` (whole conversation when omitted). With `text`, that text is sent as the new session's first prompt (= edit & resend). The source session is untouched. Title: "<source title> (fork)". Errors: `bad_request` (itemId is not a sent prompt of yours), `busy` (no itemId while a turn runs), `not_found`. |

### Sessions running outside Helm (terminal Claude Code)
```js
ExternalSession = { claudeSessionId, cwd, project, title, lastActivity,
  active: bool,            // transcript written in the last ~90 s
  agentsRunning: 0, eta: Session.eta-shape | null, transcriptPath }
```
| method / event | params / data | result |
| --- | --- | --- |
| `external.list` | `{}` | `[ExternalSession]` (active ones first, then the last ~10 idle from the past 24 h) |
| `external.history` | `{ claudeSessionId, before?, limit? }` | `{ items, hasMore }` (read-only view, same normalizer) |
| event `external.updated` | `{ sessions: [ExternalSession] }` | pushed ~every 15 s while any is active, only when something changed |

Resuming an external session in Helm uses the existing `sessions.create({ cwd, resumeClaudeSessionId })`;
the UI only offers it when `active` is false (two writers on one transcript corrupt it).

### Settings additions
`launchAtLogin: false`, `quickPromptHotkey: "Control+Alt+Space"` ('' disables).
The quick-prompt window (host) is a small always-on-top glass box: type a prompt, pick
"new session in <project>" or an existing session, Enter sends, Esc hides.

Host methods behind it (page: `ui/quick/`, served at `/quick/index.html`; `main/quick.js`):
| method | params | result |
| --- | --- | --- |
| `quick.targets` | `{}` | `{ targets: [{ id: "session:<id>" \| "project:<cwd>", kind, label, detail }], defaultId, hotkey }` (open sessions newest first, then one "New session in <project>" per settings project; default = last used, else the first project) |
| `quick.send` | `{ target, text }` | `{ sessionId, title, created, queued? }` (`sessions.send` or `sessions.create { cwd, prompt }`) |
| `quick.hide` | `{}` | `{}` desktop windows only (`unsupported` from the phone) |
| `quick.open` | `{ sessionId }` | `{}` hides the box, shows the main window on that session; desktop only |

A hotkey that is taken or invalid is never fatal: the host logs it and emits
`notify { kind: "info", title: "Quick prompt hotkey unavailable", body }`.
Showing a session from the host (notification click, "Open in Helm", `helm --session=<id>`)
broadcasts `app.select { sessionId }` AND calls `selectSession` in the desktop window's
`/lib/store.js`, so it works whether or not the UI listens for `app.select`.

### Phone health + install (lane phone, 2026-10-08)
| method | params | result |
|---|---|---|
| `phone.status` | `{ refresh? }` | `{ enabled, tailscaleUp, tailscaleIp, tailscaleState, boundAddresses, boundOnTailscale, port, expectedPort: 4871, portIsFallback, portOwner: { pid, name } \| null, firewallRule: "present" \| "missing" \| "unknown", firewallDetail, firewallRuleName, httpsAvailable, certDomains, magicDnsName, phones: [{ name, os, online }], phoneClientsNow, lastPhoneAt, lastPhoneRemote, url, checkedAt }` (`main/phone.js`; PowerShell + `tailscale status` probes cached 60 s, `refresh: true` re-probes) |

If 4871 was busy and the server fell back to a random port, the first client to connect gets one
`notify { kind: "info", title: "Port 4871 was busy", body }` naming the process that holds 4871.
`/manifest.webmanifest` and its icons (`/assets/app-icon-{192,512,maskable-512}.png`,
`/assets/apple-touch-icon.png`) are served WITHOUT the key (browsers fetch manifests without
cookies); every other path still needs the token or cookie, and the Host guard applies to all.

### Phone over HTTPS + push (lane https, 2026-10-08)
**How:** `tailscale serve` (not `tailscale cert` + a Node https listener). Tailscale terminates TLS with the
tailnet's own Let's Encrypt certificate and renews it; Helm never holds a private key, the phone URL has no
port (`https://<MagicDNS name>/`), and the setup survives Helm restarts. `main/https.js`:
- reads `tailscale serve status --json` BEFORE any change; takes HTTPS port 443, else 8443, only if that port
  is completely unused; never replaces a handler it did not make; after the change re-reads the config and
  checks every earlier handler is still there. Other existing `:80` handlers stay.
- the command: `tailscale serve --bg --yes --https=443 http://127.0.0.1:4871`
- **undo:** `tailscale serve --https=443 off` (removes only Helm's 443 handler; `tailscale serve status` to check)
- never `tailscale funnel`; a Helm handler with Funnel on is reported as `state: "funnel"`, never "live"
- a `--test` run reads serve but never changes it, unless started with `--test-https-port=<p>` (never 443),
  which lets it use that one port for its own loopback port (`tools/verify-https.js` uses 8443)

When live, `settings.phone.url` (the QR) is `https://<name>/?key=…` and `settings.phone.httpUrl` is the
plain-http fallback (absent while https is not live).

**Proxied requests** (`main/server.js`): tailscale serve connects from 127.0.0.1 and adds `X-Forwarded-For`
(the phone's tailnet IP; a client-sent value is replaced), `X-Forwarded-Proto: https`, `X-Forwarded-Host`,
`Tailscale-Headers-Info` and `Tailscale-User-*` (identity, includes the account email: never logged). A
loopback request with any of those is "proxied": it needs the cookie / key like any other, its Host must be
this PC's own MagicDNS name, it is refused (403) while phone access is off, its WebSocket Origin may be
`https://<host>`, the cookie it gets is also `Secure`, `client.remote` is the X-Forwarded-For address and
`client.platform` is always `web`. Forwarding headers from a non-loopback socket are ignored. The desktop
window (`electron`) additionally needs a loopback Host. Direct requests: `*.ts.net` Hosts are limited to
this PC's own name once it is known.

**Install:** `/sw.js` (public, like the manifest) is registered by the phone page on https only. Its fetch
handler passes page loads through and answers with a small offline page when the PC can't be reached (or
"Helm isn't answering" on a 502/504 from tailscale serve); it caches nothing.

**Push** (`main/push.js`, `web-push`): VAPID keys + subscriptions in `<userData>/push/` (`vapid.json`,
`subscriptions.json`). A subscription is only ever shown/logged as `{ id: sha256(endpoint)[0:12], host }`.
Pushed: the `notify` events notify.js toasts for a session, `kind` `waiting` | `done` | `error` (plus the
queue's done/error), filtered by `settings.notifications[kind]`, skipped while the desktop window is focused
(no desktop toast then either) or while a phone page reports itself visible; never `info` notices or context
hand-off alerts. 404/410 from the push service drops the subscription. Payload `{ title, body, sessionId,
kind, tag: "helm-<sessionId>" }`; tapping the notification focuses Helm on that session (`/?session=<id>`).

| method | params | result |
|---|---|---|
| `phone.status` | `{ refresh? }` | as above, plus `https: { state: "no-certs" \| "off" \| "live" \| "busy" \| "funnel" \| "tailscale-down" \| "unknown", certs, domain, httpsPort?, url?, target?, undo?, nextPort?, otherHandlers, canChange, detail, probe: { at, ok, status?, error? } \| null }`, `push: { available, reason, count, subscriptions: [{ id, host, label, addedAt, lastOkAt, lastError, lastErrorAt }], lastSend }`, `client: { secure, proxied }` (`probe` = a real https GET of `/manifest.webmanifest`, reused 60 s; `refresh` forces it) |
| `phone.httpsOn` | `{}` | the `https` status after `tailscale serve --bg --https=<443\|8443> http://127.0.0.1:<port>`; desktop window only; errors `no_certs`, `busy`, `failed`, `unsupported` |
| `phone.httpsOff` | `{}` | the `https` status after `tailscale serve --https=<port> off` (Helm's handler only); desktop window only |
| `phone.visible` | `{ visible }` | `{}`; a web client says it is in view (repeated every 60 s while visible; forgotten after 150 s or on disconnect) |
| `push.key` | `{}` | `{ publicKey }` the VAPID key; error `unavailable` if web-push did not load |
| `push.subscribe` | `{ subscription: PushSubscription.toJSON(), label? }` | `{ id, subscribed: true, count }`; web clients over https only |
| `push.unsubscribe` | `{ endpoint }` or `{ id }` | `{ removed, count }` |
| `push.test` | `{}` | `{ sent, failed, removed, results: [{ id, ok, status, error }] }`; error `no_subscribers` / `unavailable` |

End to end on the real certificate: `node tools/verify-https.js` (isolated `--test` Helm on its own port +
`--test-https-port=8443`, headless Chromium as an Android phone; leaves the serve config exactly as it was).

### Session lifecycle, usage history, engine banner (lane sessions-org, 2026-10-08)
`Session` gains `archived: false | true` (persisted in sessions.json; sessions saved before this
load as `false`). The sidebar keeps archived sessions out of the project groups, in a collapsed
"Archived" group at the end. Sending to an archived session resumes it and sets `archived: false`.

| method | params | result |
|---|---|---|
| `sessions.archive` | `{ id, archived?: bool = true }` | `Session` (archiving stops a live CLI first, so `status: "closed"`; unarchive never starts one) + `session.updated` |
| `sessions.delete` | `{ id }` | `{}` + `session.removed { id }`. Removes Helm's record ONLY: the Claude Code transcript under `~/.claude/projects` is never touched, so the conversation stays in History and resumable. A live CLI is stopped first. |
| `usage.history` | `{ days?: 1..14 = 1 }` | `{ samples: [{ ts, fiveHour, week, fiveHourResetsAt?, weekResetsAt? }], costByDay: [{ day: "YYYY-MM-DD" (local), usd, byProject: { [project]: usd } }] }` |

`usage.history` reads `<userData>/usage-history.jsonl`, kept to 14 days. The engine appends a
sample (`fiveHour` / `week` are percents, `null` when unknown) on every `usage.updated` and every
5 minutes while Helm runs (unchanged readings within 5 minutes are skipped), and one cost line per
result message (the turn's delta of `total_cost_usd`, filed under the session's project).
`costByDay` has one entry per local day in range, oldest first, zero days included. When the
engine could not start the history it returns error code `unavailable`.

`app.hello` adds, only when `engine: "fallback"`: `engineReason` (why the real engine is not
running) and `logPath` (the main log). The UI shows both in a banner that stays up.

Links: `helm://session/<id>` opens Helm on that session and `helm://quick` opens the quick-prompt
box (parsed by `main/launch.js` at start and from a second launch). Helm.exe registers the
`helm` scheme for itself on start (`app.setAsDefaultProtocolClient('helm', Helm.exe, [appDir])`;
never from `--test` or a bare electron.exe run). The session menus have "Copy link" and
"Copy Helm session id" (for `helm --session=<id>`).

`history.search { includeTemp: true }` is wired to History's "Include temp folders" toggle
(remembered per browser). The plan card's third answer is
`{ behavior: "allow", mode: "bypassPermissions" }` and only goes out after an inline confirm.

### Deck summary (lane deck, 2026-10-08)
`Session` gains two small fields so the Deck (every session as a live tile) never loads histories:
```js
lastText: "…and all 42 tests pass." | null,   // tail of the latest MAIN-THREAD assistant reply, one line,
                                               // ≤ 280 chars ("…" + the end when longer); subagent text never
                                               // replaces it. Persisted in sessions.json. While a reply streams it
                                               // reaches session.updated at most every 400 ms. Sessions saved
                                               // before this field learn it when their transcript is first loaded.
pendingRequest: null | {                       // the OLDEST request still waiting on the user; live only (never persisted)
  requestId, itemId, kind: "permission"|"question"|"plan", toolName,
  title,          // "Allow Bash?" (or the engine's request title) | the first question's text | "A plan is ready for review"
  detail,         // Bash/PowerShell command (one line) | file_path | url | the first question's option labels
                  // joined " · " | the plan's first line; null when there is nothing to add
  parentToolUseId?,   // set when a subagent asked
  choice?,        // kind "question" only, and only for the simple case: exactly ONE question, single-select,
                  // 2-4 options: { question, options: [{ label, description? }] }. `question` and `label` are
                  // exact (they key the answer); description ≤ 160 chars. Absent otherwise. (lane deck-pace)
  count           // pending requests in this session (≥ 1)
}
```
Answering from a tile uses the same `sessions.respond { id, requestId, response }`; the Deck answers
permissions inline (`{ behavior: "allow" }` / `{ behavior: "deny" }`), answers a question that has `choice`
inline with one click (`{ answers: { [choice.question]: label } }`, the chat's own shape, which the engine
hands Claude as `updatedInput.answers`; an "Other…" button opens the session), and opens the session for
every other question and for plans. The UI prefers the transcript items when it already has them loaded (exact and full-rate) and falls back
to these fields (absent or null both mean "none"). The stand-in engine sends both too (see Round D additions).

## Round D additions

### Agent transcript: open any subagent (lane agent-drill, 2026-10-08)

| method | params | result |
| --- | --- | --- |
| `agents.transcript` | `{ sessionId, agentId, before?: itemId, limit?: 1-1000 (default 200), rev?: string }` | `{ items: [Item], hasMore, agent: Agent, file, prompt, rev, via }`, or `{ unchanged: true, rev, agent }`, or `{ items: [], hasMore: false, agent, file: null, missing: "why" }` |

`agentId` is the Agent's `id` (the parent's `Agent`/`Task` tool_use id). The result is that subagent's
OWN transcript (`~/.claude/projects/<slug>/<claudeSessionId>/subagents/agent-<hex>.jsonl`), tail-first and
paged exactly like `sessions.history` (`before` = the oldest item id you hold). Items use the normal Item
shapes: the agent's own steps are top level (no `parentToolUseId`); steps of agents IT launched follow
their `Agent` card with `parentToolUseId` set, as in the main transcript. The first prompt is not an item:
it comes back as `prompt` (later `user` items are follow-ups the parent sent with SendMessage).

- `agent`: the live fleet Agent when the session has one, else built from `agent-<hex>.meta.json` and the
  transcript (`context` from its last usage, `model`). Adds `transcriptId` (the `<hex>`). `costUsd` stays
  absent: Claude Code reports cost per session, not per subagent.
- `via`: how the file was matched: `"meta"` (meta.json `toolUseId` equals `agentId`: exact; Claude Code
  writes it when the agent starts), `"agentId"` (the `agentId: <hex>` line of the Agent tool result, or the
  SDK `task_id` the fleet saw for that tool_use), `"prompt"` (a transcript with no usable meta whose first
  prompt equals the Agent tool input's prompt).
- `missing`: set (with `file: null`) when no transcript matches, saying why (session not started, no
  transcript on disk, no subagents dir, nothing matched). Never an empty list that looks like "no steps".
- Item ids are derived from line offsets (`a<hex>-<offset36>`), stable across reads and appends.

Live updates are a poll, not events: while the agent runs and the view is visible the client calls
`agents.transcript { sessionId, agentId, rev, limit: 60 }` every 1.5 s with the `rev` it last saw. The same
`rev` (file size plus the sizes of nested agents' files) answers `{ unchanged: true }` after a stat, without
parsing. A new `rev` returns the newest `limit` items; the client replaces its list from the first returned
id onward (ids are stable), and reloads when they no longer overlap. Chosen over subscribe/unsubscribe
events because it needs no per-client state in the engine, survives reconnects, and also follows agents
whose transcript appears after the view opened.

### Launch presets (lane presets, 2026-10-08)
Settings gains `presets`, saved launch configurations for the New session dialog:
```js
presets: [{ id: "pr_…", name: "storefront fix", cwd: "C:/Users/you/code/storefront",
            model?: "claude-opus-5-5", effort?: "xhigh", permissionMode?: "bypassPermissions", prompt?: "…" }]
```
`settings.set { presets }` replaces the whole list. `main/settings.js` validates it: at most 20 entries, ids unique
(≤ 64 chars), name 1–80 chars (trimmed), cwd non-empty (≤ 1000), model ≤ 200, effort ≤ 40, permissionMode one of
the four modes, prompt ≤ 20,000. Unknown keys and blank prompts are dropped; a non-array value in a hand-edited
settings.json loads as `[]`. Anything else is `bad_params`. The palette lists each preset as "New session: <name>"
and opens the dialog filled from it (Ctrl+Enter starts). The session "…" menu has "Start another like this",
which opens the dialog filled with that session's cwd, model, effort and permission mode.
UI only: `newSessionOpen` may be `{ presetId }` or `{ cwd, model, effort, permissionMode, prompt }` to prefill.

The stand-in engine (`main/engine-fallback.js`) now sends the Deck summary fields too: `lastText` (tail of its
canned reply) and `pendingRequest` (recomputed on `sessions.respond`; a waiting session with none left goes idle).
The mock (`?mock=1`) `sessions.respond` does the same, but goes to `working` and then `idle` 1.5 s later, the way
a real turn continues after an answer. Both build `pendingRequest` with `pendingSummary(items)` from mock-data.js.

### Context hand-off alerts (2026-10-08, lane infra)
Setting: `notifyContextHandoff: true` (boolean; anything else is `bad_params`; old settings.json files load it as
`true`). Settings → Notifications has the "Agent context hand-off" switch.
When a RUNNING agent in a `fleet.updated` list first reaches `context.percent >= 32`, the host raises one `notify`
(broadcast to every client, plus a native toast and a frame flash when the window isn't focused); reaching `>= 40`
raises a second. Never more than one per agent per threshold; an agent first seen past 40 gets only the 40 one.
Additive fields on those `notify` payloads:
`{ title: "Agent 'lane:audit' is at 33% context — hand it off" | "… — over the 40% ceiling", body, sessionId,
kind: "waiting" (32) | "error" (40), source: "context", agentId, threshold: 32 | 40 }`.
`source: "context"` alerts ignore `notifications[kind]` (they have their own switch). With the setting off the
crossings are recorded silently, so switching it back on never replays them. Tracker: `ContextAlerts` in
`main/engine/fleet.js`; wiring: `main/notify.js` (`fleet.updated` → check). The agent name is the `lane:x` tag
when its `description` starts with `[lane:x]`, else the description, else `subagentType` (`Agent '<name>'`), else
"An agent".

Lane ctxwarn (2026-10-08):
- The numbers 32 / 40 live in ONE file, `ui/lib/context-limits.js` (`CONTEXT_HANDOFF_PCT`, `CONTEXT_CEILING_PCT`,
  `contextLevel(pct)` → `''` | `'warn'` | `'danger'`): pure ESM the UI imports and the engine `require()`s.
- Phone: context alerts are pushed too (`main/notify.js` option `onContextAlert` → `main.js` `pushNotify`;
  `main/push.js` `pushDecision` lets `source: "context"` through regardless of `notifications[kind]`, with the
  same focused-window / visible-phone-page / subscriber rules). The push gets its own tag
  `helm-<sessionId>-ctx-<agentId>` and collapse topic, so it never replaces the session's "needs you" push.
- `Agent.context` is computed exactly like `~/.claude/tools/agent-context.js`: the latest assistant turn's
  `input + cache_creation + cache_read + output` over the window, where the window is `windowFor(model)` and,
  once any request of that agent passed 200k, at least 1M (it could not have fit a 200k window).
  `test/engine/context-match.test.js` runs the real tool and the Fleet on the same fixture transcripts.
  Known difference: a model id the tool doesn't know as 1M (it only knows `[1m]` and `claude-opus-5*`) but
  `windowFor` does (other 5.x / Sonnet / Opus ids, or a window learned from `result.modelUsage`) reads lower in
  the tool until a request passes 200k.
- UI: the Agents panel shows each agent's % (Tree: the bar + value; Timeline: at the end of the row's label),
  amber at 32, red at 40 while running; its summary adds the session's own % ("session 21%", neutral). The
  session status line adds `ctxWarn` (`ui/lib/session-header.js contextWarn(fleet)`: running agents at or past
  32%, "1 agent at 34%" / "2 agents at 33-41%", priority 2.5, just below the agent count) and lists them in the
  details popover.

Test windows: `--test` (not `--test-desktop`) now shows a real window parked at (-20000, -20000) with
skipTaskbar, focusable:false and type toolbar (no taskbar button, no focus, not in Alt+Tab), plus
`--disable-features=CalculateNativeWinOcclusion`. It renders at ~60 fps and `test.capture` returns the current
frame (the never-shown window ran at ~1 fps and returned the previous frame). `app.window` minimize/maximize are
ignored in that mode so nothing can pull it onto a monitor. `test.hostState().window.visible` is now `true`.

### Claude Code config: Settings -> Claude Code (lane cc-config, 2026-10-08)
The user's CLAUDE.md files and auto-memory notes, viewable and editable in Settings, plus what the selected
session's Claude Code reported at init. Host side is `main/claude-config.js` (registered in `main/rpc.js`); the
phone gets the same read AND write access as the desktop window (token-authenticated, like every RPC).

| method | params | result |
| --- | --- | --- |
| `claudeConfig.list` | `{}` | `{ claudeDir, home, backupDir, writable, instructions: { global: File, projects: [{ cwd, name, files: [File] }] }, memory: { folders: [Folder], emptyFolders, skipped: [{ slug, reason }] } }` |
| `claudeConfig.read` | `{ path }` | `{ path, kind: "instructions"|"memory", scope: "global"|"project"|"memory", project, text, size, mtime, crlf, slug?, frontmatter?: { name, description, type, present }, body? }` |
| `claudeConfig.write` | `{ path, text, expectMtime }` | `{ path, mtime, size, backup, backupName, pruned }` |
| `claudeConfig.search` | `{ q, limit? }` | `{ q, results: [{ path, slug, where: "name"|"description"|"body", snippet? }], capped? }` (memory notes only) |
| `claudeConfig.session` | `{ id? }` | `{ id, info: InitInfo | null, at, reason, latest: { info, at } | null }` |

```js
File   = { path, scope, rel: "CLAUDE.md"|"CLAUDE.local.md"|".claude/CLAUDE.md", project, exists, size, mtime, blocked?: "why" }
Folder = { slug, dir, project: cwd | null, isHome, fileCount, broken,
           index: { path, exists, size?, mtime?, lines? },
           entries: [{ line, title, hook, link, path, status: "ok"|"missing"|"outside", file?: { size, mtime, name, description, type } }],
           unindexed: [{ path, file, size, mtime, name, description, type }] }      // .md files MEMORY.md does not link
InitInfo = { model, permissionMode, version, tools: [name], plugins: [{ name, path }], mcpServers: [{ name, status }], slashCommands: [name] }
```

- **Allowlist (main only).** `<claudeDir>/CLAUDE.md`; `CLAUDE.md`, `CLAUDE.local.md`, `.claude/CLAUDE.md` in each project
  folder Helm knows (Settings `projects` + session cwds); `*.md` directly inside `<claudeDir>/projects/<one folder>/memory/`.
  `claudeDir` = `$HELM_CLAUDE_DIR`, else `$CLAUDE_CONFIG_DIR`, else `~/.claude`. Refused (`forbidden`): relative paths,
  any `.` / `..` segment, UNC and `\\?\` device paths, `:` past the drive (alternate data streams), anything outside the
  slots above, symlinks, hard-linked files (nlink > 1), and any path whose real path (junctions/symlinks resolved) is not
  exactly the slot's real base + the same relative path. Missing file: `not_found`. Over 1 MB: `too_large`.
- **Writes** edit existing files only. `expectMtime` (the `mtime` from `read`, whole ms) must still match, else `conflict`
  with "This file changed on disk since you opened it. …" (re-checked right before the write too). The old file is copied
  first to `<userData>/claude-config-backups/<ISO timestamp>-<tag>-<name>` (no backup, no write; the newest 50 are kept),
  then written with `main/atomic.js`. A CRLF or BOM file keeps its line endings and BOM. The UI saves only on a Save click.
- `claudeConfig.session` reads the engine READ-ONLY (`engine._internal.sessions.get(id).initInfo`, and `lastInit()` as
  `latest` when the session has not started). The stand-in engine has neither and answers with a `reason`.
- Mock: `ui/lib/mock-claude-config.js` (one broken index line and one unindexed note on purpose; `window.__ccTouch(path)`
  bumps a file's mtime so the next save conflicts).

### Git chip + Markdown export (lane git-export, 2026-10-08)

| method | params | result |
| --- | --- | --- |
| `git.status` | `{ cwd }` | `{ isRepo: false }` or `{ isRepo: true, branch, detached, dirty, staged, untracked, ahead, behind, upstream, lastCommit: { subject, ts } | null }` |
| `files.saveText` | `{ suggestedName, text }` | `{ path | null }` (Electron Save dialog; `null` = cancelled; web client → `unsupported`) |

- **`git.status`** (`main/git.js`) is READ-ONLY and never touches the network: one `git status --porcelain=v2 --branch -z
  --untracked-files=normal` plus `git log -1` through `files.js`'s safe `git()` (`--no-optional-locks`,
  `core.fsmonitor=false`; `log.showSignature=false` for the log). `cwd` is validated like `files.*` (`bad_params` for
  missing / NUL / not a folder, `not_found` for a missing folder); a subfolder of a repo reports the whole repo.
  `dirty` counts every changed path (staged, unstaged, conflicted and untracked); `staged` and `untracked` are subsets.
  `ahead`/`behind` compare with the remote-tracking ref already on disk (as of the last fetch the user or Claude ran) and
  are `null` with no upstream, or when the upstream ref is gone (`upstream` set, `ahead` null). Detached HEAD:
  `detached: true`, `branch` = short sha. No commits yet: `lastCommit: null`. Not a repo, or a repo git refuses
  (`safe.directory`): `{ isRepo: false }`. Concurrent calls for one folder share one read. Errors: `git_unavailable`,
  `git_failed`.
- **Header chip** (`ui/shell/header.js`): branch (mono), "N changed", `↑ahead ↓behind` / "no upstream" /
  "upstream gone" / "detached HEAD"; click or tap opens the details (counts, upstream, last commit subject + age).
  Refreshed when a header shows the session, when its status leaves `working`, and at most every 30 s while the
  window is visible; only rendered headers ask, so unselected sessions never poll. Phone shows the branch only.
- **`files.saveText`** writes UTF-8 text to the path the user picks in the native dialog (never a client-given path);
  `suggestedName` is reduced to a bare file name; 20 MB cap (`too_large`).
- **Export** (session "…" menu: Export as Markdown… / Copy as Markdown): `ui/lib/export-md.js`
  `sessionToMarkdown(session, items)` (pure, host-tested) over the WHOLE transcript (`sessions.history` paged back
  until `hasMore` is false): title, folder, model, start date, then each prompt (`## You`) and reply (`## Claude`);
  tool calls as one-liners (``Ran `npm test` ``, ``Edited `src/a.js` (+3 −1)``), answered questions and plans as
  quotes; thinking, results, init/hook lines and subagent internals left out. Desktop saves through
  `files.saveText`; phone/browser downloads a Blob.
- Mock: `mock.gitStatus` (per cwd; mobile-app is not a repo), `files.saveText` records `window.__mockSaved`.
- Startup preload was tried and NOT kept: a `<link rel="modulepreload">` block for the 66 static modules below the
  3 entry scripts (`node tools/gen-modulepreload.js` writes it, `--remove` takes it out) measured no gain in hidden
  `--test` instances (`node tools/bench-startup.js`, launch -> first sidebar row, 5 alternating runs per arm, two
  passes): median 2157 vs 2262 ms, then 2169 vs 2178 ms (none vs preload). Every module is fetched by about 0.75 s
  after navigation; the list paints about 0.85 s after that, so the time is in boot work after the module graph
  (app.hello round trip, first render), not in the import waterfall over loopback.

### Account: Settings -> Account (lane account, 2026-10-08; rewritten 2026-10-22)
How Helm's sessions authenticate. Helm never signs in: it runs no sign-in or sign-out, never reads, copies or stores
a sign-in token, never sees the login, and has no login UI (`capabilities.login` is always `false`). Two modes:
- `claude-code` (default): sessions use whatever the user's installed Claude Code is signed in with (a Claude account
  or the user's own API key). The user signs in by running `claude` in a terminal. Helm passes its environment through
  to the Claude Code child unchanged: it adds no auth variables and removes none.
- `api-key`: the user saved an Anthropic API key in Settings -> Account. It is stored in Helm's profile on this PC
  (`<userData>/api-key.json`, OS-encrypted via Electron safeStorage when available, never in `settings.json`) and
  passed only to the Claude Code processes Helm starts, as `ANTHROPIC_API_KEY`. It is never logged and never sent to a
  window or the phone; clients only see `apiKeyLast4`.

Host side: `main/account.js` is the one provider; `main/claude-cli.js` holds the `claude` path and the base child env;
`main/rpc.js` registers `account.status` / `account.setApiKey`; the engine takes `childEnv(env)` (adds
`ANTHROPIC_API_KEY` only in `api-key` mode) and `startBlock()`. The phone gets the same methods.

| method | params | result |
| --- | --- | --- |
| `account.status` | `{ refresh? }` | `AccountState` (`refresh` re-runs the sign-in status check first) |
| `account.setApiKey` | `{ key: string \| null }` | `AccountState`. Saves / replaces the trimmed key, or clears it with `null` (back to Claude Code's own sign-in); running sessions restart onto the change (`restart.reason: 'apiKey'`). `bad_params` (with a message) when not a string, empty, containing whitespace, too long, or a Claude sign-in token (`sk-ant-oat…`): Helm doesn't store sign-in tokens. The key is never sent back to any client |

Event `account.changed` → `AccountState`, on every status change and restart progress.

```
AccountState = {
  provider: 'claude-code' | 'api-key',
  capabilities: { apiKey: true, login: false },   // login is always false: Helm never signs in
  usageLimits: boolean, ready: boolean, reason: string|null,
  status: { ok: true, apiKeySet, apiKeyLast4: string|null, apiKeySource: 'helm'|null, keyError: string|null, canSave, checkedAt },
  claudeCode: { state: 'unchecked'|'signed-in'|'signed-out'|'unknown', checking: boolean, loggedIn: boolean|null,
                kind: 'subscription'|'console'|'api_key'|'provider'|'none'|null, plan, methodLabel, email, orgName,
                reason: string|null, source: 'auth-status'|'session'|null, checkedAt: number|null },
  restart: { at, reason: 'apiKey', restarted, waiting, unsupported? } | null }
```
- Sign-in status (`claudeCode`): Helm runs Claude Code's own read-only status command, `claude auth status --json`
  (it prints no secret), at startup, when Settings -> Account opens or the user presses Check again
  (`account.status { refresh: true }`), and after a session fails because Claude Code isn't signed in
  (`source: 'session'`). It keeps only loggedIn / method / plan / email / org name. A stale signed-out answer is
  re-checked in the background.
- Not signed in (`state: 'signed-out'`, default mode): `ready: false` with `reason` = "Claude Code isn't signed in.
  Open a terminal, run `claude`, and sign in there; then press Check again." Settings -> Account (desktop and phone
  alike) and the composer show that text. There is no sign-in button.
- `ready: false`: `sessions.send`, `sessions.create` / `sessions.fork` with a prompt and the commands/models probe
  (`sessions.commands` / `sessions.models` with no live CLI) are refused with `{ code: 'auth_required', message: reason }`;
  no claude child starts, and queued jobs wait with that reason. A CLI that is already running (or re-attached after a
  restart) is not affected.
- Check can't run (`state: 'unknown'`, with `claudeCode.reason`): nothing is blocked (`ready` stays true); Claude Code's
  own error shows in the session, and the panel says why it couldn't check.
- `keyError`: a saved key that can't be decrypted on this PC keeps `api-key` mode with `ready: false` and `keyError`
  (enter the key again). Helm never silently switches to another account.
- `usageLimits`: `false` (no 5-hour / weekly windows) in `api-key` mode, or when Claude Code reports it is signed in
  with a Console login, an API key or a cloud provider (`kind` `console` / `api_key` / `provider`); `true` otherwise.
  When `false` the queue skips its 5-hour gate and the usage panels say so instead of showing empty windows.
- `app.hello` carries `auth: { provider, capabilities, usageLimits, ready, reason }`; `account.changed` keeps it
  current (client: `auth` signal in `ui/lib/store.js`).
- `settings.get` / `settings.updated` carry `account: { apiKeySet, apiKeyLast4 }`, derived and read-only
  (`settings.set` ignores it, and refuses `apiKey` with `bad_params`).
- After the key changes Helm calls `engine.recycleClis()` (main/engine/index.js): idle live CLIs close (resumable; the
  next message starts a fresh CLI on the new setting), mid-turn ones are retried every 5 s until their turn ends (up
  to 1 h). `restart.waiting` counts those. The stand-in engine has no hook: `restart.unsupported`.
- A pasted Claude sign-in token (`sk-ant-oat...`) is refused with `bad_params`: Helm doesn't store sign-in tokens.
- Mock: `ui/lib/mock-account.js`; start state from `?account=` `cc-signed-in` (default) | `cc-signed-out` |
  `cc-unknown` | `cc-console` | `key-helm` | `key-error` | `old-host`.

### Shell runs: `!` in the composer (lane bang, 2026-10-08)

Claude Code's `!` mode: a prompt that starts with `!` runs as a local command and Claude sees its output
with the NEXT prompt. Works whether the CLI is running, idle, mid-turn or never started (no CLI needed).

| method | params | result |
| --- | --- | --- |
| `sessions.shell` | `{ id, command }` (command without the `!`) | `{ itemId }` — adds a `shell` item (below) and streams its output. Runs in the session `cwd` with the shell Claude Code's Bash tool uses: Git Bash (`CLAUDE_CODE_GIT_BASH_PATH`, else the usual install paths) via `bash -c` (no login profile); `powershell.exe -NoProfile -EncodedCommand` only when no bash is found; POSIX `/bin/bash -c`. Env is Helm's minus `ELECTRON_*`, `NODE_OPTIONS`, `HELM_*`. stdin is closed. Errors: `bad_request` (empty command, folder gone), `busy` (8 already running in this session), `not_found`. |
| `sessions.shellStop` | `{ id, itemId }` | `{}` — ends the run's whole process tree by PID (MSYS process group, then `taskkill /PID <pid> /T /F`; never by name). No-op when it already finished; `not_found` for an unknown id. |

Item type `shell` (streams like any item: `session.item`, then `session.itemUpdate` with `appendText` for
output, at most every 100 ms, then one patch when it ends):

| field | meaning |
| --- | --- |
| `command`, `cwd`, `shell` | what ran, where, and with what: `"bash"`, `"powershell"` or `"sh"` (`null` on cards read back from a transcript) |
| `text` | stdout + stderr as they arrived (display copy): utf-8, ANSI escapes and stray control characters removed, CRLF → LF (a bare `\r` from a progress bar is left in; render the text after the last `\r` of each line). Keeps the last ~1 MB; `clipped: true` when earlier output was dropped. |
| `stdout`, `stderr` | Claude's copy, set when the run ends (`""` while running): each stream is whole up to 30,000 chars (Claude Code's default `BASH_MAX_OUTPUT_LENGTH`), else its first and last 15,000 around `... [N characters truncated] ...` |
| `exitCode` | number, or `null` (still running, stopped, could not start, or a terminal `!` run read from disk, which records none) |
| `status` | `"running"` → `"done"` (any exit code), `"error"` (could not start; the reason is in `stderr` and `text`) or `"stopped"` (`sessions.shellStop`, a session delete, or Helm quitting) |
| `startedAt`, `endedAt` | ms; `endedAt` null while running |
| `shared` | `false` until the run reaches Claude: the next prompt sent to the CLI (`sessions.send`, or a queued prompt when it is dequeued; `sessions.fork` leaves the source's runs pending there) takes every finished unshared run, oldest first, then patches `shared: true`. A run still going when a prompt is sent waits for the prompt after. If the CLI cannot start, they go back to `false`. |

Context format (prepended to the text of the prompt Claude receives; the `user` item keeps only what the user typed):

```
<bash-input>npm run lint</bash-input>
<bash-stdout>…stdout…</bash-stdout><bash-stderr>…stderr…
Exit code 1</bash-stderr>

what does this mean?
```

One `<bash-input>` + `<bash-stdout><bash-stderr>` pair per run, joined by `\n`, then a blank line and the prompt.
A non-zero exit adds an `Exit code N` line to the stderr block, a stopped run `Command stopped by the user`;
a literal closing tag inside output is written `<\/bash-stdout>` (and read back unescaped).

- **Restart:** unshared runs are saved in sessions.json (`pendingShell`, never sent to clients; display text
  capped at 64 KB, a run still going is saved as `stopped` with what it printed so far) and put back at the end
  of the transcript, still unshared, so the next prompt sends them.
- **Reload from disk:** a prompt Helm sent with runs in front normalises back into `shell` items (`shared: true`,
  `exitCode` from the trailer line, else 0) followed by the `user` item with the typed text and its `uuid`, so
  rewind/fork checkpoints still work and the cards Helm showed live are not doubled. A terminal session's own
  `!` runs (`<bash-input>` and `<bash-stdout>` as two user lines) become one `shell` card each (no user bubble);
  output whose input line is in an older page shows as a plain `system`/`info` line, as before.
- **Mock:** `mock.shellMock(method, p, { state, emit })` in `ui/lib/mock-data.js` streams fake output (git
  status, ls, test runs; `false` exits 1); `mock.shellMockShare(state, emit, sid)` marks pending runs shared on
  send. The seeded storefront session has one shared and one unshared card.

### Active hours (lane activity, 2026-10-08)

How long Claude was actually working, from every Claude Code transcript on this PC (Helm sessions, terminal
sessions and every subagent), read-only. Usage panel → "Active hours".

| method | params | result |
| --- | --- | --- |
| `activity.summary` | `{ days?: 1..30 = 14, allTime?: boolean }` | `{ days: [{ date: "YYYY-MM-DD" (local), activeMs, agentMs }] (oldest first, zero days included), today: { activeMs, agentMs }, week: { activeMs, agentMs } (last 7 local days incl. today), byProject: [{ project, cwd, activeMs, agentMs }] (over `days`, by activeMs desc), live: { workingNow }, scannedAt, scanMs, files, filesRead, capMs, windowDays, dir, missing?: true, warnings?: [string], allTime? }` (`allTime` only when asked; shape below) |

- **activeMs** = wall-clock time with at least one Claude working (union of every stream's intervals);
  **agentMs** = sum over streams (parallel work counts several times). A project's numbers are the union / sum of
  its own files; `project` is the cwd's last folder name (History's rule), temp-folder cwds group as
  "Temp folders", a file with no cwd falls back to its projects-folder slug. `live.workingNow` = streams with an
  open turn whose latest event is under 10 min old and that are not only waiting (agent / the user).
- **Counting rule** (per file; `main/activity.js` header has the full text): a turn starts at a real prompt
  (`user` line that is not a tool_result, isMeta, compact summary or "[Request interrupted…"; also
  `system/scheduled_task_fire`), runs through assistant / tool_result / compact / `stop_hook_summary` /
  `turn_duration` events, and the gap between consecutive events counts capped at 10 min (`capMs`). Gaps where
  every unanswered tool call is Agent/Task or AskUserQuestion/ExitPlanMode don't count for that stream. Time
  between turns never counts; a running turn counts up to its latest event. Days are local; intervals split at
  midnight.
- **All time** (lane alltime, 2026-10-08): `allTime` is `{ activeMs, agentMs, since: "YYYY-MM-DD" | null (local day of the
  first counted moment), byMonth: [{ month: "YYYY-MM" (local), activeMs, agentMs }] (oldest first, zero months included,
  at most 120), byProject: [{ project, cwd, activeMs, agentMs }] (by activeMs desc), files, scannedAt, scanMs,
  warnings?: [string] }` once a full pass has finished; before that `{ scanning: { done, total } }` (files checked so far
  of every transcript; `total` 0 while listing) and no numbers; `{ error }` when the last all-time pass failed and none
  ever finished. Same rule, union and project grouping as the days; it covers every transcript still on disk (Claude
  Code deletes old ones per its `cleanupPeriodDays`). The call never waits for it: a scan's phase 1 (the window)
  answers, phase 2 (every older file) carries on in the same worker; while `scanning` is set the UI polls every 2 s
  (answered from memory, no rescan). The 60 s prewarm in `main/rpc.js` asks `{ days: 14, allTime: true }`, so it
  is warm before the panel opens. Measured on a heavy user's PC (3,502 files / 7.76 GB): cold phase 1 6.4 s, cold all time 13.4 s
  (worker heap peak 23 MB, buffers 123 MB, process RSS 145 MB), warm rescan 0.30-0.37 s, cache 1.5 MB.
- **Scan**: `<projectsDir>/<slug>/*.jsonl` + `<slug>/<id>/subagents/*.jsonl` (projectsDir honours
  `HELM_CLAUDE_PROJECTS`). Phase 1 reads files whose mtime is in the last `windowDays` = 30 local days; phase 2 (2
  files at a time, cache saved every 30 s) every other one. Lines are skimmed as
  bytes (no JSON.parse; big values skipped). Runs in a worker thread (`main/activity-worker.js`, inline fallback
  logged); at most one rescan a minute, concurrent calls share it. Cache `<userData>/activity-cache.json`: per path
  size, mtime, byte offset of the last complete line, sha1 of the 64 bytes before it, stream state (timestamps,
  pending tool ids), intervals, cwd; no prompt text. A grown file whose hash still matches is read from the offset;
  anything else is re-read whole; a partial last line waits for its newline. Entries keep their full interval list
  (cache v2; a v1 cache is dropped and everything read once) and leave the cache only when the file is gone.
- **Errors**: `bad_params` (days, allTime not boolean), `scan_failed` (first scan failed; a later failure serves the last scan).
  `missing: true` when the projects folder doesn't exist. The UI says why for loading, error, missing, no files in
  the window and no work in range.
- **Mock**: `ui/lib/mock-activity.js` (`&activity=empty|missing|error|slow|unknown|alltime-scanning` previews the states; all-time data when asked), routed in
  `transport.js` mockRpc next to `usage.history`.
- **Sidebar meters** (`UsageMeter`, `ui/panels/usage.js`): `5H n%` and `Week n%` side by side (stacked with
  `compact`), one button that opens the Usage panel when no `onClick` is given; resets in the tooltip. The weekly
  meter is left out while `usage.week.percent` is unknown and the tooltip says why.

### Sidebar: active sessions + Past (lane sessions, 2026-10-08)
No new methods or fields: UI over `sessions.*`, `history.search`, `external.list` and `sessions.create`.
- **Main list = active only** (`ui/lib/session-activity.js`, pure, host-tested): `waiting`, working (lane fleet's
  `displayStatus` = `working`, so an ended turn with background agents counts), `error`, `pinned`, or used within
  `ACTIVE_WINDOW_MS` (1 h, one constant; a Settings control would go in Settings > General as
  `settings.sidebar.activeWindowMin`). Re-checked on the minute (`ui/shell/activity.js`); the open session never leaves
  while open once it has been in the list; a session the user just left stays until a tick at least 30 s later.
  `state.js` `projectGroups` is built from this list, so Ctrl+1..9 and split view follow it.
- **`Session.pinned` is "Keep in list"** (menu label). Already persisted in sessions.json and broadcast by
  `sessions.update`, so the phone and the desktop agree. It no longer moves the row to the top (start order below).
- **"Used" = `updatedAt`**, which the engine now bumps for real use only: `sessions.markRead` (every open) and
  Helm stopping a CLI itself (`close({ final: false })`: quit, account switch, delete, rewind; and the expected
  exit that follows) save and broadcast without touching it. The user's Close still touches it. So opening a Past
  session leaves it in Past (highlighted) until the user sends; phone and desktop behave the same.
- **Order = start order, never activity** (as the user put it: "the order of these is literally constantly moving"):
  `Session.resumedAt` (new, persisted, `null` until set) is stamped by `sessions.send` when the session was
  idle/closed, not pinned, without running agents and unused for `RESUME_GAP_MS` (1 h, mirrors
  `ACTIVE_WINDOW_MS`), i.e. picked back up from Past or Archived. Rows inside a project sort by
  `resumedAt || createdAt`, newest first; projects: pinned ones first (settings order), then by their newest start
  (`buildProjectGroups`). Status, activity, unread, pin and `updatedAt` never reorder (host-tested). The store's
  own `sessions` order (pinned, then `updatedAt`) is unchanged for its other users (palette, Deck).
- **No count badge in sidebar rows**: the right side is always the relative time; unread = bold title only.
- **Past** (`ui/shell/past.js`): inactive, non-archived Helm sessions merged with `history.search` pages (40 per page,
  asked as `limit + 1` so "more" is exact; "Show older" auto-loads when scrolled into view) plus idle `external.list`
  entries, newest first, in Today / Yesterday / Previous 7 days / Previous 30 days / Older. A transcript is dropped
  when any Helm session (archived included) has that `claudeSessionId`, when it runs in a terminal right now
  (`active` or `agentsRunning > 0`), or when `messageCount === 0`. Sessions that never got a prompt
  (`!claudeSessionId && !lastText && !costUsd`) are in neither list once outside the window; Past offers
  "N empty sessions · Delete" (`sessions.delete` confirm). The sidebar filter's text also searches Past; the Archived
  group sits at the bottom of Past. A terminal row opens the read-only view (`external.history` finds any transcript);
  its "Resume in Helm" is `sessions.create { cwd, resumeClaudeSessionId }`.
- **Elsewhere** lists only terminal sessions running now; idle ones are in Past.

### Restart + updates (lane restart, 2026-10-08)

Helm.exe runs this folder, so new code loads only when the main process restarts. A NEW COMMIT is the
update signal (`main/update.js`): HEAD (read from `.git`: HEAD -> loose ref -> packed-refs, or detached; no
git process) resolving to a different commit than the one this process started on. Polled every 30 s plus
`fs.watch` on `.git` and the branch's ref folder; file edits alone never count. After the LAST HEAD change
it waits 60 s of quiet, then re-checks the gate every 30 s and restarts only when it is clear, re-confirmed
3 s later with fresh state. The gate (`restartBlockers`, pure) blocks on: a session working, waiting on the user,
starting or compacting; queued sends; agents running; background tasks inside a CLI (`openTasks`); `!` runs;
an overnight queue job running; a git rebase/merge/cherry-pick/revert/bisect in progress; uncommitted changes
to tracked files Helm loads (`main.js`, `preload.js`, `package.json`, `main/`, `ui/`; `git status -uno`,
fails closed); unsent composer attachments (drafts are already saved per keystroke in
`localStorage["helm.draft.<id>"]`); the user's input in any window or the phone in the last 2 min; `autoRestart`
off. A manual restart (Settings, chip, palette, tray, phone) checks only what would be cut off or loaded
half-done (sessions, agents, tasks, `!` runs, queue, git op, uncommitted code).

| method | params | result |
| --- | --- | --- |
| `app.restart` | `{ force?: bool, whenIdle?: bool, cancel?: bool }` | `{ restarting: true }`; `whenIdle` while busy: `{ restarting: false, deferred: true, reasons }` (see "Restart when finished"); `cancel`: `{ cancelled }`; without `force` and something would be cut off: error `busy` (message names the reasons); a `--test` run without `HELM_TEST_ALLOW_RESTART`: error `unsupported`. Desktop window and phone (token-authenticated like every RPC). |
| `app.restartCheck` | `{}` | `{ reasons: [string] }` what a manual restart now would cut off (the Restart button's confirm) |
| `app.input` | `{ input?: bool, attachments?: number, draft?: sessionId }` | `{}`. The UI reports the user's input (keydown / pointerdown / wheel / touchstart, leading + trailing throttle, 15 s) and, from the desktop window, the count of unsent composer attachments (`input: false` = count only). `draft`: the session whose composer draft was typed into since the last report (counts as use for the idle CLI close). Desktop keystrokes are also seen in main (`before-input-event`). |
| `app.updateState` | `{}` | `UpdateState` |

`app.hello` gains `update: UpdateState | null`. Event **`app.update`** = `UpdateState` (whenever it changes);
event **`app.restarting`** = `{ at, auto, by: "desktop"|"phone"|"tray"|"update" }` just before Helm quits.

```js
UpdateState = {
  running: { sha, short, subject, branch, startedAt },   // the commit this process loaded
  repo: "C:\Users\you\helm", autoRestart: true, bootedAt,
  pending: null | { sha, short, commits: [{ sha, short, subject }] /* newest first */, detectedAt, settleAt,
    phase: "settling"|"waiting"|"restarting", reasons: ["1 session working", "2 agents running"],
    reason: "waiting: 1 session working · 2 agents running" },
  restarted: null | { at, auto, by, from, to, commits },  // the restart this process came from (restart.json)
  release?: ReleaseState,   // INSTALLED builds only (lane installer); a clone build never has the key
}
```

**Installed builds (lane installer).** An installed Helm has no git checkout, so the commit watcher above has
nothing to watch. `main/release-check.js` asks GitHub Releases instead (`GET
https://api.github.com/repos/Owen-Silva/helm/releases/latest` through Electron's `net.fetch`, so the system
proxy applies; 20 s timeout), 20 s after start and then every 6 h, and compares the release's `tag_name`
(leading `v` stripped, numeric x.y.z) with the running version. It never downloads or installs anything: the
UI links the installer and the user runs it. `UpdateState.release` (also on `app.hello` `update` and every
`app.update` event while it changes):

```js
ReleaseState = {
  mode: "installer", current: "1.2.0",            // the running version
  phase: "idle"|"checking"|"current"|"available"|"none"|"failed",
  checkedAt: null | ms,                            // when the last check finished (any outcome)
  latest: null | { version: "1.3.0", tag: "v1.3.0", name, url /* the release page (html_url) */,
    download /* the Helm-Setup.exe asset's browser_download_url, or null when the release has none */, publishedAt },
  reason: null | string,   // one plain sentence, for "failed" and "none" ("No release of Helm has been published yet.")
  detail: null | string,   // failures only: the technical part (HTTP status, error code / message)
}
```

`latest` survives a later failed check (the last good answer). A newer tag = `available`; equal or older =
`current`; 404 = `none`; a tag that is not x.y.z, a network error (offline, DNS, refused, proxy, certificate),
the timeout, GitHub's rate limit (403 with `x-ratelimit-remaining: 0`, or 429: the reason says when it can
check again), another HTTP status or an unreadable answer = `failed` with a reason. Settings > Helm shows the
installed version in "Running", an "Updates" row for every phase (Download the installer / What's new /
Check now) and hides the auto-restart toggle; the chip shows "Update available · <version>" when nothing else
is showing.

| method | params | result |
| --- | --- | --- |
| `app.checkUpdates` | `{}` | INSTALLED builds only: runs a release check now (joins one already running) and resolves to `ReleaseState` when it finishes; it never rejects for a failed check (that is `phase: "failed"`). A clone build answers error `not_installed`. |

Session gains `openTasks: number` (live only, like `agentsRunning`): non-agent background tasks in the CLI
(`local_bash`, Monitor, workflows, MCP tasks), from `task_started` / `task_notification` / `task_updated`
until the CLI's first `background_tasks_changed`, then that level signal alone (REPLACE). Seen live
(claude 2.1.294): `background_tasks_changed {tasks:[{task_id,task_type:"local_bash",description}]}` arrives
just before `task_started {task_id, task_type:"local_bash", is_backgrounded:true, tool_use_id, description}`;
the end is `task_notification {task_id, status:"completed", tool_use_id}` then `background_tasks_changed {tasks:[]}`.
`recycleClis` (account switch) respects them too.

Setting **`autoRestart`** (boolean, default `true`): "Restart automatically when Helm updates".

A restart writes `<userData>/restart.json` `{ at, auto, by, window: "focused"|"shown"|"minimized"|"hidden", from, to, commits }`;
the next process reads and deletes it: the window comes back the same way (hidden in the tray stays hidden,
shown-but-unfocused does not steal focus), the UI toasts "Helm restarted · <subject> (<sha>)" (or "Helm restarted")
once per browser profile when the page is visible, and the selected session is restored (`helm.active`).
Quit and restart end with `app.exit(0)` after Helm's own shutdown: in Electron 44 a second `app.quit()` after a
prevented `will-quit` does nothing, which left the process alive with no window (and a relaunch waiting on it).
Test-only (deleted unless `--test`): `HELM_TEST_UPDATE_REPO` (watch this repo), `HELM_TEST_ALLOW_RESTART=1`
(really relaunch), `HELM_TEST_UPDATE_TIMING` (JSON `{pollMs, quietMs, gateMs, confirmMs, deferMs, inputQuietMs}`).
End to end: `node tools/restart-e2e.js` (hidden `--test` Helm.exe + temp repo + a live claude-haiku-5-5 turn;
summary `restart-e2e: N passed, M failed`).

**Restart when finished** (lane restart, 2026-10-15). The 17:34 restart on 2026-10-14 (main.log
`restart (desktop) -> 5a94378`) was a MANUAL one: the automatic gate had held the update for 22 min, and
`app.restart` refuses while anything runs unless `force`, so the cut-off came through the confirm's "Restart
anyway" (or the palette's second pick). Since then:
- the confirm (Settings > Helm, the chip, the tray dialog, the palette) offers **Restart when finished** first:
  `app.restart { whenIdle: true }` -> `{ restarting: false, deferred: true, reasons }` when something runs (it
  restarts at once when nothing does). Main re-checks the manual gate every 5 s and restarts once it is clear and
  still clear 3 s later. `app.restart { cancel: true }` -> `{ cancelled }` takes it back. `UpdateState.deferred =
  null | { at, by, phase: "waiting"|"restarting", reasons, reason }`; the chip shows "Restarts when finished ·
  <first reason>" with Cancel. "Restart now" (`force`) stays, and its log line names what it cut off
  (`restart (desktop) -> sha; window …; confirmed past: 1 session working · 5 agents running`).
- the legacy `app.window { action: "restart" }` is checked like `app.restart` (it used to restart unchecked).
- `busyState().agents` (the gate, the idle reaper, `recycleClis`) = max(fleet running agents, `local_agent`
  tasks in the CLI's own `background_tasks_changed` list), so an agent the fleet lost still blocks.

### Restart note (lane restart, 2026-10-15)

A restart or quit ends every claude.exe, so the turn, its background agents, background tasks and `!` runs stop.
`engine.shutdown({ cause: "restart"|"quit" })` first records, per session with something running, **`Session.restartNote`**
(saved in sessions.json at once; cleared by any send, by Continue, or by Dismiss; dropped after 3 days):

```js
restartNote = { at, cause: "restart"|"quit", working, waiting,      // working: a turn (or a question to the user) was cut off
  agents: [{ id /* tool_use id | null */, agentId /* Claude Code agent id */, name }], agentsTotal,   // max 20 listed
  tasks: [{ type, description }], shells, queued }
```

The conversation ends with a card: "Helm restarted at 5:34 PM: 5 agents stopped", the facts (turn, tasks, `!`
runs, unsent queued messages), the agents and tasks (`ui/lib/restart-note.js`, `ui/chat/restart-note.js`),
Continue and Dismiss. The sidebar row reads "Stopped by restart · 5 agents"; the "Helm restarted" toast adds
"5 agents stopped in "<title>"".

| method | params | result |
| --- | --- | --- |
| `sessions.continueAfterRestart` | `{ id }` | `{ action: "continued", itemId, prompt, message }`, or `{ action: "none", reason: "no_note"\|"working", message }` |
| `sessions.dismissRestartNote` | `{ id }` | `{ dismissed: bool }` |

Continue sends `Continue where you left off.` (origin `helm`). Like an explicit Stop's note (lane steer), the next
message to the session (Continue or anything the user types) carries a `<helm-note>` for Claude, e.g. "Helm: Helm
restarted at 17:34 while you were working, which ended your turn before it finished. It also stopped 2 background
agents: guard (agent a1228099…), recap. They are not running; SendMessage to an agent id resumes it with its
context. …". Item.helmNote shows it as the small line above the bubble. A crash or a killed process writes no note.
End to end: `node tools/restart-note-e2e.js` (hidden `--test` Helm.exe, throwaway CLAUDE_CONFIG_DIR, live
claude-haiku-5-5; needs 2.5 GB free and the headless-browser lock; summary `restart-note-e2e: N passed, M failed`).

### Keep sessions running through a restart (lane detach, 2026-10-15)

- **Setting** `keepSessionsThroughRestart` (bool, default false; Settings > Helm). `HELM_DETACH=1` / `=0` overrides
  it. When on, new claude.exe processes run in the CLI broker (`main/engine/broker.js`, one per profile and broker.js
  version, state in `<userData>/brokers/<stamp>.json`), so a Helm restart detaches instead of killing them. Engine
  option `getKeep()`.
- **Only a restart Helm performs keeps sessions** (2026-10-15). Restart Helm (button, tray, phone), an update
  restart and "Restart when finished" all go through `performRestart` -> `engine.shutdown({ cause: 'restart' })`,
  which first sends each broker the **restart intent** `keep { keys, ms }` (`KEEP_MS` 60 s: old Helm's shutdown
  <= 4 s + a cold Electron start + the re-attach pass, several times over) and only then a `detach` frame per kept
  CLI. The intent is single-use per CLI: a re-attach consumes it. A CLI whose broker did not confirm the intent is
  closed like any other (restart note).
- **Every other end stops everything.** Quit (tray "Quit Helm", or anything that quits the app): each CLI gets stdin
  EOF, then `shutdownAll` makes every broker end what is left (tree killed by PID 5 s after EOF) and exit. A crash,
  Task Manager End task, Windows shutdown or sign-out: Helm's pipes close with no intent and the broker does a
  **full stop** by itself: stdin EOF to every CLI, the tree by PID 5 s later if one hangs, state file removed, pipe
  closed, broker exits. The same full stop when an intent's deadline passes with nothing re-attached (when the new
  Helm re-attached some, only the unclaimed CLIs are ended). A `detach` frame with no intent ends that CLI. Each
  stop is logged in `<userData>/logs/broker.log` with its reason.
- **Stop records** `<userData>/brokers/stopped/*.json` `{ at, reason, broker, clis: [{ key, sid, pid, busy,
  pending, startedAt, turnStartedAt }] }`: written by a full stop / missed deadline for CLIs Helm had not ended
  itself; the next engine start reads them once (`broker.takeStops()`) and deletes them. A session there gets a
  system item `{ subtype: 'closed-stopped', text: 'Stopped when Helm closed', detail }` (not when a restart note
  already lists what stopped); a session the last Helm kept gets the stop's reason in its restart note instead.
- **Window close is not a quit:** the window X, Alt+F4 and the taskbar's Close window hide Helm to the tray
  (`win.on('close')`, desktop mode); sessions keep running in the still-running Helm. That is unchanged.
- **Restart:** `engine.busy()` rows carry `keep: true` for sessions a restart would keep; `restartBlockers` skips
  their turn, agents and tasks (not `!` runs, queued messages, questions, starting). `{ strict: true }` ("Restart
  when finished") counts everything. **RPC** `app.restartCheck` -> `{ reasons, kept: [phrase] }`.
- **Session.kept** (sessions.json only, not public): `{ at, key, pid, costBase, note }` written at detach. The next
  start re-attaches (keep-compat.js: protocol, SDK, claude path, conversation id, cwd, CLI >= 2.1.295, then
  `hooks_applied` on the live re-attach within 15 s). Success: a system item `{ subtype: 'kept', text: 'Kept running
  through the restart', detail }`. Failure: the CLI is ended,
  `Session.restartNote` gets `reason` (shown as the note's first fact and told to Claude on Continue) and a system
  item `{ subtype: 'kept-failed', text }`.
- **RPC** `sessions.keepStatus` -> `{ on, override: 'on'|'off'|null, safe: true|false|null, job, kept, brokers:
  [{ pid, stamp, v, current, draining, job, clis, attached, orphaned }] }` (Settings > Helm status line). `safe:
  false` = the broker sits in a Windows job it could not leave (broker-launch.js): restarts still stop sessions.
- End to end: `node tools/detach-e2e.js` (hidden `--test` Helm.exe, real setting over RPC, live Haiku).

### Railway: deploy status + Redeploy / Restart (lane railway, 2026-10-08)

A **Railway** inspector tab (`ui/panels/railway.js`) and a Home chip (`ui/shell/railway-chip.js`) show the live
deploy status of every service in every Railway project on the user's account. Host side: `main/railway.js`.

**Auth.** Everything runs through the user's own Railway CLI: `railway api -f - --compact --allow-errors` sends a
GraphQL document (stdin) to backboard.railway.com with the CLI's own `railway login`, and the CLI refreshes its
token itself. Helm never reads `~/.railway/config.json` and stores no token. The npm `railway.cmd` shim cannot be
spawned without a shell, so Helm runs the `railway.exe` beside it (`node_modules/@railway/cli/bin`). The CLI also
honours `RAILWAY_API_TOKEN` if set. No CLI -> error kind `missing`; signed out -> kind `auth` ("run `railway login`").
Projects = `me.workspaces[].projects` UNION `me.projects` (deduped): a project shared from another workspace is only
in `me.projects` (same as `railway list`). Deleted projects / service instances are skipped.

| method | params | result |
|---|---|---|
| `railway.status` | `{ watch?: 'panel'\|'chip', refresh?: true }` | RailwayStatus (cached; a fetch starts in the background when due) |
| `railway.redeploy` | `{ serviceId, environmentId, deploymentId, confirm: true }` | `{ ok, action }` |
| `railway.restart` | `{ serviceId, environmentId, deploymentId, confirm: true }` | `{ ok, action }` |

Event `railway.changed` = RailwayStatus, pushed when projects/statuses, the error, the warning or an action change
(not on every identical poll).

RailwayStatus: `{ mode: 'ready'|'off', offReason?, projects: Project[]|null, fetchedAt, checkedAt, fetching,
error: { kind: 'missing'|'old'|'auth'|'rate'|'network'|'timeout'|'other', message, detail, at }|null, warning, actions[],
canAct, actReason?, poll: { intervalMs, nextAt, watching[] } }`. `projects` stays the last good copy while
`error` is set. Project `{ id, name, services[] }`; service `{ key: 'serviceId:environmentId', serviceId,
environmentId, name, environment, prod, status, tone, raw, since, deploymentId, restartId, olderLive, canRedeploy,
canRestart, redeployWhy, restartWhy }`.

Status mapping (Railway DeploymentStatus -> `status`, `tone`): SUCCESS -> live (ok; `deploymentStopped` -> stopped,
idle); BUILDING -> building, DEPLOYING -> deploying, INITIALIZING/QUEUED/WAITING/NEEDS_APPROVAL -> queued (busy,
amber); FAILED -> failed, CRASHED -> crashed (bad, red); SLEEPING -> sleeping, REMOVED/REMOVING -> removed,
SKIPPED -> skipped, none -> none (idle). A SKIPPED latest deployment shows the deployment still serving instead.
`olderLive`: a failed or in-progress new deploy while an older SUCCESS deployment still serves. `prod` = the
environment is named production/prod. `since` = statusUpdatedAt (else createdAt), ms.

**Polling** is lease-based: `railway.status { watch }` renews a lease (panel 75 s, chip 6 min); the UI renews every
25 s (panel) / 2 min (chip) only while mounted and the window is visible. No lease = no polling. Cadence: anything
busy or an action in flight 10 s; panel open 30 s; chip only 3 min. Errors back off 30 s, 1, 2, 4, 8 min, capped
at 10 min; a rate limit (429) waits at least 5 min and refuses actions meanwhile. `refresh: true` (the panel's
refresh button) re-checks unless the last check was under 5 s ago. One CLI process at a time.

**Actions.** Without `confirm: true` -> `confirm_required` and the CLI is never called (the UI sends it only from
the confirm dialog, which names project, service and environment and says "This redeploys production." /
"This restarts production." for prod). A snapshot older than 20 s is refreshed first; the service must exist and
`deploymentId` must still be the target, else `not_found` / `stale`; a busy service -> `unavailable`; one action
per service at a time -> `busy`. Redeploy = `deploymentRedeploy(id: latest deployment)`; action `running` -> `sent`
-> `done` when the new deployment settles (message "Redeployed: live" / "Redeploy ended: failed"; 20 min give-up).
Restart = `deploymentRestart(id: the running SUCCESS/CRASHED/SLEEPING deployment)`; `done` at once, fast polls for
60 s. Failures -> action `error` + RPC error `railway_failed` / `rate_limited`. Finished actions stay 90 s.

**Redaction.** Every error string passes `redact()`: JWTs, `Bearer`/`token=` values, 32+ char secrets, UUIDs,
emails, `C:\Users\<name>` paths and the values of `RAILWAY_API_TOKEN` / `RAILWAY_TOKEN` are cut; 300 chars max.

**Test runs.** A `--test` Helm is `mode: 'off'` (no CLI call ever) unless `HELM_RAILWAY_CLI=<fake CLI .js>` (run
with Electron-as-node; actions allowed against the fake only) or `HELM_RAILWAY_LIVE=1` (read-only real status,
actions refused). Mock UI: `?mock=1&railway=live|building|failed|error|auth|off|empty|readonly` (ui/lib/mock-railway.js).
Tests: `test/host/railway.test.js`.

### Idle CLI close (lane reaper, 2026-10-08)

Every live session holds its own claude.exe (measured 2026-10-08 in a `--test` run: ~300 MB working set and
~500 MB private bytes per idle CLI tree). The engine closes the CLI of a session that is truly idle and resumes it
on the next use, the same path a Helm restart already takes (e2e S9).

- **Idle** = `es.busyState()` is null (the same per-session check `engine.busy()` feeds the restart gate in
  main/update.js: no turn, not starting, nothing queued, no pending permission / question / plan, no compaction,
  no agents, no background tasks, no `!` runs) AND nothing used it for the window: `Session.updatedAt` (send, turn
  end, any item, CLI start) and the engine's `lastActiveAt` (a composer draft typed for it, `app.input.draft`).
  Checked every 60 s, and again right before the close.
- **Close** is quiet: `close({ final: false, quiet: true })`. `status`, `activity` and `updatedAt` stay as shown
  (no sidebar reorder); the session stays in the list. Viewing it (`sessions.history`, `sessions.markRead`) never
  starts a CLI. The next send, rewind-files or anything else needing the CLI starts one with `resume` (activity
  `Starting`); a failed start sets `status: 'error'` with the reason in `activity` and a system item.
- **Setting** `closeIdleAfterMin` (whole minutes, 0 = never, max 1440; default 15). Settings -> Helm: "Close idle
  sessions after 15 / 30 / 60 min / Never", with "N idle sessions closed since Helm started".
- **RPC** `sessions.idleStats` -> `{ idleMs, closed, resumed, lastClosedAt, live }` (this process only).
- **Logs** one line per close (`engine: closed idle CLI for <id> after N min idle`) and per resume
  (`engine: resumed idle-closed CLI for <id> (closed N min earlier)`), or `resume of idle-closed <id> failed: <why>`.
- **Tests**: `test.idleClose({ idleMs?, everyMs?, sweep? })` (`--test` only; `idleMs: null` back to the setting) ->
  `{ idleMs, closed, resumed, live, sessions: [{ id, live, pid, busy, idleClosedAt, lastActiveAt, held }] }`. e2e S18;
  unit tests in test/engine/idle-reaper.test.js + test/engine/schedules.test.js, setting in
  test/host/idle-close-setting.test.js.
- **In-CLI schedules hold it** (main/engine/schedules.js, reaper only). `/loop` and autoloop sessions sit idle between
  ticks while the next tick lives inside claude.exe, so the reaper also keeps a CLI with, from its own live tool items:
  a `ScheduleWakeup` (pending until the call's time + `delaySeconds` + 5 min grace; a later call replaces it,
  `stop: true` or a failed call clears it), or a `CronCreate` job without a matching `CronDelete` (matched by the
  result's id; pending for as long as that CLI lives). Reset whenever a CLI starts or exits. A held session logs
  `engine: kept idle CLI for <id>: scheduled wake-up pending until <time>` (or `N scheduled cron jobs pending`) once
  per hold, not once per sweep or per tick; `test.idleClose` shows it as `held`.
- **The restart gate does not use the hold**: `busyState()` and update.js are unchanged, so a cron never blocks an
  update forever. An update restart (or any Helm restart / quit) still ends in-CLI schedules; the loop does not
  survive it.

### Release on tab close (lane tabrelease, 2026-10-08)

Closing a session's tab (×, middle-click, Ctrl+W, the last tab) closes that session's claude.exe straight away when
nothing runs in it, instead of waiting for the idle window. It never interrupts work.

- **`sessions.release { id }`** (ui/shell/tabs.js `closeTabById`, after the tab is gone and only when this window no
  longer shows the session: `releaseOnClose` / `onScreen` in ui/lib/tab-state.js, so a session still in a split pane
  is not released). Engine (main/engine/index.js -> idle-reaper.js `release(es)`):
  - **Another client has it on screen** (`sessions.viewing`, below; the caller's own report is dropped first) ->
    `{ action: 'kept', reason: 'open on another screen' }`. Nothing changes; the idle window still applies.
  - **No CLI** (already closed / never started) -> `{ action: 'none', reason: 'no CLI running' }`.
  - **Idle** (`busyState()` null) **and not schedule-held** -> the reaper's own quiet close
    (`close({ final: false, quiet: true })`, status / activity / `updatedAt` unchanged, resumes on the next send),
    awaited -> `{ action: 'closed' }`. Logs `engine: closed CLI for <id>: released on tab close`.
  - **Busy** (turn, starting, compacting, queued prompts, pending permission / question, agents, background tasks,
    `!` runs) **or schedule-held** (/loop ScheduleWakeup, CronCreate) -> **marked** `{ action: 'marked', reason }`
    (logs `engine: <id> released on tab close; CLI kept until idle (<reason>)` once). Every reaper sweep (60 s)
    closes a marked session as soon as it is idle, not held and on no client's screen, without waiting for the idle
    window (`engine: closed CLI for <id> released on tab close (now idle)`). The schedule hold always wins.
  - **The mark clears** when any client reports the session on screen (`sessions.viewing`: the tab re-opened, the
    phone opened it), and on `sessions.send` / `sessions.shell`; the normal idle window applies again. A mark whose
    CLI is gone some other way is dropped.
  - **Settings "Never"** (`closeIdleAfterMin: 0`) does not stop a release: the tab close is an explicit action. The
    Settings row says so ("Closing a tab also closes its idle Claude process.").
  - Counted in `sessions.idleStats` `closed` (and `released`).
- **`sessions.viewing { ids }`**: every UI reports the sessions it shows whenever that set changes and after each
  reconnect (ui/shell/tabs.js): the desktop its session view (both split panes, else the open session; nothing on
  Home / Settings / an external session), a phone or web page its open session while the page is visible (`[]` when
  hidden). Kept per WebSocket client (`client.id`) and forgotten when the client disconnects (`engine.clientClosed`).
  Used only by release; the idle window ignores it.
- **Tests**: test/engine/tab-release.test.js (reaper release + split-pane rule + engine over the fake SDK); e2e S19
  (real CLI: an idle release really ends the claude.exe child, a release mid-turn lets the turn finish and closes
  the CLI within one sweep, a follow-up resumes in context). `test.idleClose` sessions carry `releasePending`.

### Since you left: Home recap (lane recap, 2026-10-09)

Home shows one row per session that did something since the user last had it on screen on ANY client. Zero Claude calls.

- **`sessions.recap {}`** -> `{ rows: [{ id, title, project, outcome: 'done'|'failed'|'waiting'|'working'|'stopped',
  error (short, failed only), commits, commitSubject (first), fileCount, files (first 3 base names), costUsd, from, to
  (first / last activity ms), seenAt }] }`, waiting then failed first, then newest. `{ rows: [] }` when empty.
- **Event `recap.updated {}`** (at most every 800 ms) when a row may have changed; Home refetches (also on its minute tick).
- **lastSeen** = the moment a session left every client's screen (`sessions.viewing` unioned across clients, plus
  `sessions.release` and a client disconnect). While on screen nothing accumulates; viewing a session clears its row.
- **Incremental** (main/engine/recap.js): the engine's own `session.item` / `session.itemUpdate` stream is folded into a
  per-session summary as it happens (no transcript re-parse). Commits = `[branch <hash>] subject` lines in the result
  of a Bash/PowerShell tool whose command runs `git … commit`; files = distinct `file_path` / `notebook_path` of
  finished Edit/Write/NotebookEdit/MultiEdit; cost = sum of `result.costUsd`. Persisted to `<userData>/recap.json`
  (every 2 s while changing, and at shutdown), so it survives a restart and desktop + phone share it. Sessions Helm
  had before the file existed start "seen now"; a session created later counts from its creation.

### Scheduled: one list (lane sched, 2026-10-09)

Every pending in-session schedule across sessions: a `/loop` ScheduleWakeup (kind `loop`, or `wakeup` when its prompt
is not a /loop input) and CronCreate jobs (kind `cron`, or `loop` for a /loop prompt). Tracked from the CURRENT CLI's
live tool calls (main/engine/schedules.js; the reaper hold `pending()` is unchanged). Shown in the Queue panel
("Scheduled in sessions", ui/panels/scheduled.js) and the Home "Next up" card (ui/shell/next-up.js, next 3).

- **`schedules.list {}`** -> `{ now, items: [Sched], ended: [Ended] }`.
  `Sched = { id, key, sessionId, sessionTitle, project, kind, label, prompt, detail, cron?, nextAt, recurring, durable,
  cronId, expiresAt, createdAt, others, askedAt, askText, canClose, closeWhy }`, soonest first. `nextAt`: a wake's
  `scheduledFor` (else call time + delay clamped to 60-3600 s); a cron's next local-time match (5-field cron, computed
  in main). A fired wake / one-shot cron and a recurring cron past its 7-day auto-expiry are left out.
  `Ended = { id, sessionId, sessionTitle, project, kind, label, detail, why, at, asked? }`, `why`: `deleted`
  (CronDelete), `stopped` (ScheduleWakeup stop), `closed` (Close process below), `session-closed`, `exited` (CLI
  died), `restart`. Kept 30 min (`restart`: until dismissed, max 24 h).
- **Event `schedules.updated`**: the same payload, debounced 150 ms, on every tracker change.
- **`schedules.cancel { sessionId, key, how }`**. Helm cannot delete a schedule itself (it lives inside claude.exe):
  - `how: 'ask'` sends `askText` to the session through `sessions.send` (visible in the transcript, queued if a turn
    runs) -> `{ how, asked: true, queued, text }`. Nothing is cancelled until Claude runs CronDelete / ScheduleWakeup
    stop; the item then moves to `ended` with `asked: true`. `askedAt` shows it was asked.
  - `how: 'close'` closes the session's CLI (`close({ final: false })`, session stays, resumes on the next send), which
    ends EVERY schedule in it -> `{ how, closed, ended, left }`. Refused while `busyState()` is set (`code: 'busy'`)
    and for durable crons (`code: 'durable'`: saved in the project, they come back on the next start there).
  - Errors: `gone` (no longer pending), `bad_params`, `not_found`.
- **`schedules.dismiss { id } | { all: true }`** -> `{}`: drops ended rows for every client.
- **Ended by restart**: `engine.shutdown()` first writes `<userData>/schedules-at-exit.json` (non-durable items still
  due). The next engine start reads it once, deletes it and lists them as `why: 'restart'`. A crash writes nothing.
- **Tests**: test/engine/schedules.test.js (cron math, list, ended reasons, board cancel / guards / restart file).

### Stopped and stalled (lane stall, 2026-10-09)

The user's Esc stops every background agent of the session, and nothing tells the model; a hung stream leaves a turn
"working" forever. Thresholds and words live in `ui/lib/stall-limits.js` (engine and UI import it):
`AGENT_QUIET_MS` and `SESSION_STALL_MS` (10 min each), `INTERRUPT_WINDOW_MS` (15 s), `RESUME_PROMPT`.
- **Agent** additions: `stopReason?: 'interrupted' | 'closed' | 'exited'` (status `stopped` only; `interrupted` = Claude
  Code stopped it within 15 s of Helm's `sessions.interrupt`, or its own transcript's last line is the
  `[Request interrupted by user…]` marker, live or when rebuilt from history; then `endedAt` is that exact time),
  `lastActivityAt?` (ms: its last sign of life: a child tool, usage, task_progress, tool_progress, or its own
  transcript's newest line), `quiet?: true` (still `running`, but no sign of life for `AGENT_QUIET_MS`: "No activity
  12m", maybe stalled). Stopped agents are not running anywhere (counts, Working filter, timeline, Deck); quiet ones
  still are, and say so.
- Measured live (tools/stall-live.js, 2026-10-09): on Helm's interrupt Claude Code sends `task_updated {status:"killed"}`,
  `task_notification {status:"stopped"}` and `background_tasks_changed []` in the same millisecond, and writes the
  marker line into each agent's transcript.
- **Session** additions: `agentsQuiet` (running agents with `quiet`; live only), `stalledSince` (ms or null: a turn is
  active, status `working`, and Helm has had no SDK message since then for `SESSION_STALL_MS`; cleared by the next
  message). The engine checks every 30 s (`main/engine/stall.js`) and reads each running agent's transcript tail then.
- **`sessions.resumeStalled { id, stopAgents? }`** (refused with `agents_running` like `sessions.interrupt`) -> `{ action: 'continued' | 'none' | 'failed', restarted, reason?, message,
  itemId?, prompt }`. Only after the user confirms (header Resume). Refuses (`none`, `not_stalled` / `not_working`) unless
  stalled right now. Otherwise interrupts the turn; if the CLI sends nothing back within 10 s it is closed (the send
  starts a fresh one on the same conversation, `restarted: true`); then sends `RESUME_PROMPT` with `origin: 'helm'`.
- Tests: test/engine/stall.test.js, test/host/stall-ui.test.js.

### Fresh start with handoff (lane handoff, 2026-10-09)

Button only (session header menu, Ctrl+K "Fresh start with handoff"); Helm never nudges or switches by itself.
- **`sessions.handoff { id }`** -> `{ text, from: { id, title, cwd, model, effort, permissionMode } }`. Sends the
  session ONE visible prompt (`HANDOFF_PROMPT` in main/engine/handoff.js, `origin: 'helm'`): a compact handoff, Done /
  Left / Files / Test state, under about 250 words, no preamble, no tools. Resolves when that turn ends with its final
  assistant text (the SDK result's `result`, else the main-thread assistant text after the last tool; capped at 20k
  chars). Rejects with `code`: `busy` (a turn / permission wait is in flight, or a handoff already is),
  `cancelled` (`sessions.handoffCancel`), `interrupted` (stopped some other way), `failed` (turn error, CLI exit, failed
  start; message says why), `empty` (no text), `not_found`.
- **`sessions.handoffCancel { id, stopAgents? }`** -> `{ cancelled: boolean }`: interrupts the handoff turn in flight (refused with `agents_running` like `sessions.interrupt`).
- Engine hook: `EngineSession.turnWaiters` (one-shot, settled by `_settleTurn` from `_onTurnEnd`, `_onExit` and a
  failed start).
- UI (ui/shell/session-actions.js): on success `sessions.create` with `from`'s folder / model / effort / permission
  mode, the composer draft (`helm.draft.<newId>`) set to `Handoff from “<old title>”:\n\n<text>` (not sent), the tab
  placed right after the old one (tabs.js `openTabAfter`), the new session active. Progress / failure card
  (`HandoffStatus`, ui/shell/handoff.css) with Cancel, Retry, Copy handoff. Off (tooltip says why) while the session
  works, waits, or has agents running. Mock: ui/lib/mock-handoff.js (`?handoff=hold|fail`).
- Tests: test/engine/handoff.test.js; live: `node tools/handoff-live.js` (claude-haiku-5-5, temp cwd, ~$0.01).

## Production guard (lane guard, 2026-10-09)

`main/engine/prod-guard.js`, an Agent SDK **PreToolUse hook** on every session (`opts.hooks.PreToolUse`, no matcher:
it sees every tool call and returns `{}` at once for anything but Bash / PowerShell / Monitor / `mcp__*railway*`).
Guarded, in EVERY permission mode: a git push to a repo listed in `<userData>/prod-guard.json` (see
docs/prod-guard.example.json; each entry names remotes and either the guarded branches or `null` = every push; no file =
no repos guarded; a file that cannot be read or parsed fails CLOSED: every push and gh write asks, worktree merges
are refused, and each session shows a `guard-warn` system line naming the file and the error), `railway up|redeploy|restart|down|deploy` on any project, and
Railway MCP tools named deploy / redeploy / restart / up / down / remove / delete / rollback. Repos are matched by
remote URL (any form). `git push --dry-run` / `-n` is not guarded. What the command scanner follows and what it
can't see (scripts, `npm run ship`, commands built from variables) is listed at the top of prod-guard.js.

- **Card.** A guarded call opens a normal `request` item (`kind: "permission"`, `toolName`, `input`) with
  `title` ("Production push · storefront master" | "Production push · booking-portal" | "Railway up · railway up" |
  "Possible production push · folder unknown"), `description`, and
  `guard: { kind: "push"|"railway", title, approvable: "all"|"restart"|false, hits: [...], waitMin: 30 }`.
  So the session goes `waiting`, `pendingRequest` / the Deck / phone push / toasts all fire as for a permission,
  and `activity` is "Waiting for your OK: <title>". "Allow for this session" never covers it.
  A card closed by the timeout is `status: "cancelled"` with `timedOut: true`.
- **Waiting.** The hook blocks until `sessions.respond`. Allow → the hook returns no decision (the normal flow runs
  the tool); Deny → `permissionDecision: "deny"` with "the user declined … NOT run" (+ their note), scoped to that attempt
  (a later message asking again gets a fresh card, not a refusal citing the old decline). No answer in 30 min,
  an interrupt / close (the request is cancelled), or ANY guard error → deny. The CLI's own hook timeout is
  30 min + 60 s; verified live: a CLI-side hook timeout refuses the tool ("did not respond before its timeout … not
  executed"), a 1900 s timeout is honoured past 700 s, deny blocks under bypassPermissions, an interrupt aborts the
  hook's signal, and a THROWN hook error lets the tool run (so the hook never throws). `ask` under bypass does reach
  canUseTool, but the guard does not rely on it.
- **The user already said so.** `sessions.send` / `sessions.create {prompt}` / `sessions.fork {text}` take
  `origin?: "helm"` for sends Helm generates itself (handoff, stall Resume): those never count and never reset
  anything; any other client send is the user's. When an the user prompt reaches the CLI it becomes the session's last
  human prompt (live only). If it says push / ship / deploy / redeploy / go live / release (whole words, not negated
  anywhere in the message, not a question, not past tense), or is a bare yes / ok / go ahead / do it / ship it / y
  right after Claude's reply asked about pushing, the guarded calls of the following turns pass with no card and a
  `system`/`info` line "<what> allowed · you said “…” at HH:MM" (`guard: { auto: true }`), logged. "restart" only
  covers a Railway restart; `railway down` always asks. An AskUserQuestion answer about pushing sets or clears it.
- **Setting** `prodGuard` (boolean, default `true`): Settings → Safety → Production guard. Read by the hook from
  `<userData>/settings.json` (unreadable = on).
- Test-only: `HELM_TEST_PROD_GUARD={"repos":[{name,remotes,branches}]}` appends repos, or `{"<id or name>":["<url>"]}` adds
  remotes to a configured repo; honoured only under `--test`.
  Mock: `?mock=1&guard=1|auto|done` (ui/lib/mock-guard.js). Tests: test/engine/prod-guard.test.js; live:
  `node test/engine/prod-guard.live.js` (hidden Helm.exe --test, claude-haiku-5-5, local bare repo, stub railway).

## Mid-turn messages and Stop (lane steer, 2026-10-09)

- **A message sent while a turn runs never interrupts.** `sessions.send` pushes it into the CLI at once; Claude Code
  folds it into the running turn after the current tool call (like the terminal). Item `steer`: `pending` (sent, not
  taken yet) → `seen` (taken mid-turn; the item moves to where Claude read it) or `after` (Claude was already
  writing its reply, so the CLI ran it as the next turn; the session stays `working`). The text is never inspected:
  "stop" is an ordinary message and Claude decides. Fallback to Helm's queue (`queued: true`, "sends when this turn
  ends") only when the CLI cannot take it now: starting, stopping, compacting, a turn Helm itself waits on (handoff),
  or a `/command`. History: a folded message is a `queued_command` attachment in the transcript and loads as a
  `user` item with `steer: "seen"`. Folded messages are not rewind/fork points.
- **Stop is explicit.** Claude Code's interrupt stops every running agent of the session and the model is never told.
  `sessions.interrupt` (and `sessions.resumeStalled`, `sessions.handoffCancel`) refuse with `agents_running` while
  agents run unless `stopAgents: true`; the UI asks first ("Stop also stops 2 agents: guard, recap", Keep going / Stop
  all, `ui/lib/stop.js`). Esc only closes menus; Enter on an empty box does nothing; Send never turns into Stop.
  Stop withdraws mid-turn messages Claude has not taken (`cancelled: true`, "Not sent").
- **Claude is told.** After a Stop that ended agents, the next message carries `<helm-note>Helm: your Stop at 18:54 also
  stopped background agents: guard, recap. They are not running.</helm-note>` as its own first text block; the item
  shows it as `helmNote`, apart from the user's text (history parsing strips it the same way).

## Look Sync (lane look-sync, 2026-10-10)

Helm, Quartz and Mantle share one look: theme, accent hue and glass. The shared file is
`%APPDATA%\look-sync\look.json`; Mantle also writes the desktop wallpaper record and its still
(`stills\wall-<rev>.jpg`). Spec: `~/look-sync/CONTRACT.md`. Host: `main/look.js`. The settings keys are under
"Settings" above. While `lookSync.enabled` is on, a local change to `theme`, `accentHue` or `glass` is published,
and a change from another app lands through `settings.updated` like any other. Turning the switch on adopts the
shared values. With the switch off Helm keeps its values and still follows the desktop wallpaper.

```js
LookState = {
  sync: { enabled: bool,
          state: "ok"|"missing"|"corrupt"|"newer"|"off"|"error",
          reason: string | null,   // why it is not ok, or the skipped fields joined
          rev, by, at,             // the shared file's last revision, writer app, time
          skipped: [{ field, by?, reason, text }] },  // shared fields Helm refused (bad value from another app)
  desktop: { source: "mantle"|"windows"|"none",
             ok: bool,             // true only when Mantle's record is used
             url: "/bg/desktop?v=..." | null,
             rev, title, type, id, size,   // from Mantle's record (null for windows/none); size = [w, h]
             reason: string | null,        // why a fallback shows, e.g. "Following Windows' wallpaper: ..."
             // Shared top-band darkening (look-sync CONTRACT "desktop.guard"): Mantle's one dark alpha for the
             // top band of the still. Usable only with sync on, Mantle's picture showing, alpha .50-.88, and its
             // dim + blurPx equal to settings.glass.dark. The UI paints --bg-dim = guard.alpha in the DARK theme
             // in 'desktop' mode (own picture keeps glass.dark.dim). Otherwise null + guardReason.
             guard: { alpha, dim, blurPx } | null,
             guardReason: string | null,
             // The light twin (CONTRACT "Light look", desktop.guard.light): Mantle's WHITE alpha for the same band
             // (ink-2 keeps 4.7:1). Usable with sync on, Mantle's picture showing, alpha from its dim to .88, and
             // its dim + blurPx equal to settings.glass.light; the LIGHT theme paints it in 'desktop' mode.
             // Otherwise null + guardLightReason ("light top band not published by Mantle yet", "... is stale: ...").
             guardLight: { alpha, dim, blurPx } | null,
             guardLightReason: string | null },
  dir: "C:\\Users\\you\\AppData\\Roaming\\look-sync",
  mantleOpen: { available: false, reason: "Helm can't open Mantle's Wallpapers yet: ..." } }   // see look.openMantle
```

| method / event | params / data | result |
| --- | --- | --- |
| `look.get` | `{}` | `LookState` |
| `look.openMantle` | `{}` | `{ ok: true }`: runs Mantle's open-Wallpapers command (`MANTLE_OPEN` in main/look.js). Until Mantle reports that command it is `null`, the call fails `unsupported`, and `LookState.mantleOpen` is `{ available: false, reason }` (Settings shows text plus the reason instead of a button). A `--test` run only logs the command |
| `app.hello` | | carries `look: LookState` (null if the host has not started it) |
| event `look.updated` | `LookState` | sent only when the state changed |

The UI shows a fallback or a sync problem once per reason per page load, as a toast (`ui/lib/store.js`, bottom).

**`/bg/desktop`.** The picture `background.mode: "desktop"` shows. Same token / cookie rule as every route.
Main picks and checks the file; the route serves only that. In order: Mantle's still (must be inside Mantle's
`stills` folder), then the file Mantle's record names, then Windows' own wallpaper
(`%APPDATA%\Microsoft\Windows\Themes\TranscodedWallpaper`). Each must be on disk and sniff as PNG, JPEG, WebP or
GIF. `?v=` is only a cache key (`m<rev>` for Mantle, `w<mtime>` for Windows). 404 when there is no picture.

**Window placement (desktop window only; IPC, not WS).** Lining the still up with the screen needs where the
window is. In DIPs:
```js
placement = { content: { x, y, width, height },                 // the window's content area on screen
              display: { x, y, width, height, scaleFactor } }   // the monitor it is mostly on
```
- `helmNative.placement()` -> `ipcRenderer.invoke('helm:placement-get')` -> `placement | null`
  (answered only for the main window's webContents).
- `helmNative.onPlacement(cb)` listens on `helm:placement`; returns an unsubscribe. Main sends it on move, resize,
  maximize / unmaximize / restore, full screen in / out, page load, and display changes.
- The phone has no `helmNative`, so it never lines up: the still is cover-fit as before.

**Test hooks (`--test` only).** `test.placement { content, display }` makes the window pretend to sit there
(`display.scaleFactor` defaults to 1) and sends `helm:placement`; `{}` (anything without both) clears it.
Returns `{ placement }`. A `--test` run never touches the user's real `%APPDATA%\look-sync`: it uses `LOOK_SYNC_DIR`
if set, else `<profile>/look-sync` inside its throwaway profile. `HELM_TEST_WALLPAPER` (`--test` only) replaces
the Windows wallpaper fallback path; empty means no fallback.

## Top-row hints to Mantle (lane helm-toprow-hints, 2026-10-11)

Mantle's top bar takes the colour of the window under it. Helm tells it what its window's TOP PIXEL ROW is about
to be, in the same JS task that changes it, so the bar can paint on the same frame instead of waiting for its
screen capture. Wire format: look-sync CONTRACT "Top-row hints" (protocol v1, pipe `\.\pipe\look-sync-toprow`).

- **Renderer** (ui/shell/toprow.js, maths in ui/lib/toprow.js): works TOP out from the background layers and sends
  it with `helmNative.topRow(top)` (preload, `ipcRenderer.send('helm:toprow')`, fire-and-forget). Send points:
  Background's layout effect (every render: view, Home, theme, picture, dim, guard), the lined-up layer's move
  (chrome.js moveLayers), Home's fade (one per frame from requestAnimationFrame), `<TopScrim>` mount / unmount
  (ui/lib/top-scrim.js: modals, palette, lightbox), a picture finishing decoding.
- **Main** (main/toprow.js): keeps each window's latest TOP and seq, writes at once, re-sends all on (re)connect,
  retries at most once per 2 s, logs only state changes. Window create: the backgroundColor as `flat`; maximize /
  restore / fullscreen: the same TOP with a new seq; close / quit: `none`. A `--test` run connects only to
  `HELM_TOPROW_PIPE` (tools/toprow-check.js runs a fake Mantle), never to the real pipe.
- **RPC** `toprow.get` -> `{ state: 'connected'|'not-running'|'connecting'|'off', reason, pipe, sent, since,
  connected, windows }`; app.hello `toprow` (same); event `toprow.updated` (same). Settings > Appearance shows it
  under "Match the other apps", with what Helm is telling the bar.
- The quick-prompt box never sends: it opens at 24% of the work area, not movable, so it never sits under the bar.

## Voice input (lane voice, 2026-10-14)

- **Engine:** local Whisper. `main/voice.js` runs `main/voice/whisper_worker.py` (faster-whisper, model `base.en`,
  int8 on the CPU) in a Python found as `HELM_VOICE_PYTHON` > `py -3.13` > `py -3` > `python`; later spawns use the
  `python.exe` the first worker reported. JSON lines over stdio (ops `probe`, `load`, `transcribe`). The worker
  starts on first use, loads the model on `voice.warm` (plus a 1 s warm-up pass) and exits after 10 min unused.
  `HELM_VOICE_MODEL` picks another cached model (e.g. `small.en`).
- **Private:** the renderer records the mic (desktop window or the phone page over the tailnet), downsamples to
  16 kHz Int16 and sends it in memory; nothing is written to disk, the worker runs with `HF_HUB_OFFLINE=1` and
  `local_files_only` (it never downloads, never calls a cloud API), and the log has timings and lengths only,
  never audio or dictated text.
- **RPC** `voice.status {}` -> `{ state: 'off'|'loading'|'ready'|'unavailable', reason?, engine: 'faster-whisper',
  model }` (`off` = available, not loaded). `voice.warm {}` -> `{ state: 'ready', loadMs }`, rejects
  `voice_unavailable` with the reason (no Python / faster-whisper missing / model not downloaded; a failure is
  remembered 15 s, then retried). `voice.transcribe { pcm: base64 Int16LE mono, rate: 16000 }` ->
  `{ text, audioMs, ms }`; rejects `bad_params` (other rate, empty, > 120 s), `voice_unavailable`, `voice_failed`
  (worker crash or timeout: the worker is replaced, the next press respawns it).
- **Test only (`--test`):** `test.voice { unavailable?: reason }` forces the unavailable state; `test.resize
  { width, height }` sets the window's content size. `node tools/voice-check.js` drives it end to end with
  Chromium's fake mic playing a TTS WAV.

## Worktrees: a session in its own git worktree (lane helm-worktrees, 2026-10-14)

Backlog H4. A common habit made one click: every lane runs in its own worktree beside the repo. `main/worktrees.js`
(host methods, registered in main.js) and `ui/shell/worktrees.js` (the New session dialog's worktree part, and the
Worktrees panel).

- **Layout:** a worktree of `<parent>/<repo>` is `<parent>/<repo>-wt/<name>` on a new branch `wk/<name>`
  (`git worktree add --no-track -b wk/<name> <folder> <base>`). The repo is always the MAIN folder, so a worktree made
  from inside `~/helm-wt/pace` still lands in `~/helm-wt/`. The base is recorded in `git config branch.wk/<name>.helmBase`
  (git drops it with the branch); a worktree made by hand has no record and its base is the main folder's branch.
- **node_modules is never linked.** On Windows, `git worktree remove --force` follows a junction inside the
  worktree and deletes the TARGET's files (reproduced by test/host/worktrees.test.js's control case on git 2.53).
  Deps are a real copy (`robocopy /E /XJ /MT:8`, junctions neither followed nor copied; `fs.cp` skipping links
  elsewhere) or `npm ci` / `npm install` in the new folder. Copy is the default when node_modules is at most 800 MB
  and 60,000 files and measured within 5 s; otherwise Install.
- **Remove is junction-safe:** it walks the worktree without following links, takes every link out (`rmdir` on a
  junction removes only the link), checks each is gone and each target still exists, and only then runs
  `git worktree remove` (with `--force` only when "Discard changes" is ticked, or the folder is already gone).
  Afterwards it checks the folder is gone and the main folder and every link target are still there.
- **Merge** (the worktree's branch into its base): fast-forward when the base has not moved, otherwise a merge
  commit (`git merge --ff --no-edit` in the base's checkout; when the base is checked out nowhere, `merge-tree
  --write-tree` + `commit-tree` + `update-ref <new> <old>`, which fails if the ref moved). Never forced. Conflicts are
  found with `git merge-tree` BEFORE anything is touched. Refused, in plain words, when: the worktree has
  uncommitted changes; there is nothing to merge; the branch or the base is behind its own upstream (as of the last
  fetch; Helm never fetches); the base's checkout has uncommitted changes or a merge/rebase in progress; the merge
  would conflict; the base is not a local branch. **Prod guard:** a base that `main/engine/prod-guard.js` TARGETS
  protect (by remote URL, from `<userData>/prod-guard.json`) is refused with code `protected`. **Helm's own repo:**
  merging into the branch the running Helm's folder has checked out moves its HEAD, and main/update.js then restarts
  Helm; that needs `confirmRestart: true`, else code `confirm_restart` with "Merging into Helm's own master restarts
  Helm and stops running sessions." The UI shows the warning in the first confirm and asks a second time.

| method | params | result |
| --- | --- | --- |
| `worktrees.info` | `{ cwd }` | `{ root, name, wtDir, here, currentBranch, detached, branches: [string], taken: [branch], deps: { exists, link?, copyable?, source?, install: 'npm ci'\|'npm install'\|null, bytes?, files?, partial?, why?, suggest: 'copy'\|'install'\|'none' }, copyMaxBytes }` |
| `worktrees.create` | `{ cwd, name, base? }` | `{ path, branch, base, head, repo }`. Rejects `bad_params` (name, detached HEAD with no base), `not_found` (base), `exists` (folder or branch), `not_repo`, `bare_repo`, `git_failed` (git's words in `data.git`) |
| `worktrees.deps` | `{ path, mode: 'copy'\|'install', from? }` | copy: `{ mode, from, ms, skippedLinks }`; install: `{ mode, command, ms }`. Rejects `exists` (node_modules already there), `refused` (the source is a link), `copy_failed`, `install_failed` (output in `data.git`) |
| `worktrees.list` | `{ cwd }` | `{ root, name, wtDir, mainBranch, worktrees: [{ path, name, main, branch, detached, head, locked, missing, prunable, dirty, statusError, nodeModules: 'copy'\|'link'\|'none', lastCommit: { hash, subject, ts }, sessions: [{ id, title, status, archived }], base?, ahead?, behind?, merge?: { can, why, kind: 'ff'\|'merge'\|null, protected, restartsHelm } }] }`; [0] is the main folder |
| `worktrees.merge` | `{ path, confirmRestart? }` | `{ base, branch, kind: 'ff'\|'merge', head, restartsHelm }`. Rejects `refused` / `protected` / `confirm_restart` (plain words), `git_failed` |
| `worktrees.remove` | `{ path, cwd?, discard?, deleteBranch? }` | `{ removed, branch, linksRemoved: [path], branchDeleted, branchKept }`. Rejects the main folder, `dirty` (unless `discard`), `in_use` (a session not closed is in it), locked, `link_stuck`. `deleteBranch` uses `git branch -d`, so an unmerged branch is kept and `branchKept` says why |

- **UI:** New session dialog, "Run it in its own git worktree" (name, base branch defaulting to the folder's own
  branch, Dependencies: Copy dependencies (real copy) / Install (npm ci) / None) -> `Create worktree and start`
  (create, deps, then `sessions.create` in the new folder; if deps fail, the worktree stays and the button becomes
  `Start in the worktree`). Worktrees panel (palette "Worktrees of this repo", the header git popover's
  Worktrees…, palette "New session in a worktree"): one row per worktree with its flags, ahead/behind, last commit,
  sessions, and Open session / Merge into <base> / Remove; a disabled Merge shows its reason under the row.
- **Checks:** `node --test test/host/worktrees.test.js` (real temp repos, real junctions);
  `node tools/worktrees-shot.js [outDir] --width 1280|393` (mock backend, dark + light screenshots).

## Overlap audit (lane helm-overlap, 2026-10-16)

- **What:** `npm run test:overlap` (`tools/overlap-audit.js`) renders 33 screens and states on the mock backend
  (home, every chat fixture with long and short messages, edit box, find bar, phone long-press menu, all seven
  inspector panels, phone list, settings, history, deck, every dialog, toasts, every `aria-haspopup` menu) at
  1280, 393 and 320 (phone widths with touch), pages through each screen's biggest scroller, and forces
  `:hover` and `:focus-visible` on every control over CDP (`CSS.forcePseudoState`).
- **Reports:** overlap, hit-overlap, ring (a hover or focus ink reaching a neighbour, a painted box or loose
  text), clipped-ring, text-collide, text-clip, text-spill, outside, page-overflow, small-target (WCAG 2.2
  SC 2.5.8, spacing exception), hover-shift, no-focus-style, no-hover-style. The rules are in
  `tools/overlap-core.js` (unit tests: `test/host/overlap-audit.test.js`, part of `test:host`); the in-page
  measuring is `tools/overlap-measure.js`. Reasoned exceptions: `test/overlap-allow.json` (a reason is required).
- **Flags:** `--widths=1280,393,320 --only=<screen,...> --shots --zoom --out=<dir> --json=<file> --ui=<other ui dir>`.
  `tools/overlap-sheet.js` builds before / after contact sheets from two `--shots` runs.
- **Design rule it enforces:** `--focus-ring` is drawn inside the control (no outer ring), so focus never bleeds
  into a neighbour or gets cut by a scroller; image-filled controls use an inset outline in `--focus-color`.
  base.css's `:focus-visible` is one class deep, so any control or state rule that sets its own `box-shadow` (or
  `all: unset`) at that weight in a later file silently drops the ring: give it a matching `:focus-visible` rule
  (`.btn`, `.seg > button`, `.tab-x`, `.rail-btn.on`, `.srow.picked` do). On an accent fill use
  `--focus-ring-on-accent`. Focused, a selected control trades any outer lift shadow for the ring (a blur
  reaches the next control across a tight gap).
  Heavy (headless Chromium): run it in the heavy-test queue.
