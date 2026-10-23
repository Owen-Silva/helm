# Helm architecture

Helm is a desktop (Electron 44) + phone command deck for Claude Code. It runs the
REAL Claude Code underneath (the installed `claude.exe` 2.1.294 via the Agent
SDK 0.3.293 / stream-json), so the user's CLAUDE.md, memory, hooks,
MCP servers, skills and mods all keep working. Helm only replaces the terminal UI.

```
Electron main (main.js)
 ├─ main/engine/      Claude Code sessions: SDK query per session → normalized items (lane A)
 ├─ main/server.js    HTTP static (ui/) + /ws protocol + /bg/ + token auth (lane B)
 ├─ main/rpc.js       method → handler routing (lane B)
 ├─ main/files.js, queue.js, settings.js, launch.js, quick.js (lane B)
 ├─ main/notify.js    native toasts, taskbar badge, frame flash AND the tray icon (there is no tray.js)
 ├─ main/look.js      Look Sync with Quartz + Mantle; vendored look-sync.js, accent.js (lane look-sync)
 └─ BrowserWindow → http://127.0.0.1:<port>/?token=…   (same UI the phone loads over Tailscale)
ui/  (no build step: Preact + htm + signals via import map, ui/vendor/)
 ├─ app.js, shell/, styles/   window layout, sidebar, rail, settings, design system (lane C)
 ├─ chat/, composer/          transcript, tool cards, requests, input (lane D)
 ├─ panels/                   fleet, usage, changes, files, preview, queue (lane E)
 └─ lib/                      transport.js (B), store.js (C), mock-data.js, html.js, live.js
```

Contract: `docs/PROTOCOL.md`. If you must change a shape, edit PROTOCOL.md and
`ui/lib/mock-data.js` in the same change and say so in your report.

## File ownership (never edit another lane's files; ask main via your report)

| lane | owns |
| --- | --- |
| A engine | `main/engine/**`, `test/engine/**` |
| B host | `main.js`, `preload.js`, `main/*.js` (not engine), `ui/lib/transport.js`, `bin/**`, `tools/**` except shot/serve-ui/vendor/dev-window, `package.json` |
| C shell | `ui/index.html`, `ui/app.js`, `ui/shell/**`, `ui/styles/**`, `ui/lib/store.js`, `ui/assets/**` |
| D conversation | `ui/chat/**`, `ui/composer/**`, `ui/lib/markdown.js` |
| E panels | `ui/panels/**` |
| look-sync | `main/look.js`, `ui/lib/bg-placement.js`, `test/host/look.test.js`, `test/host/bg-placement.test.js`, `tools/look-measure.js`, `tools/look-check.js` (real-app check, `--test` only); `main/look-sync.js` and `main/accent.js` are vendored copies (never edit them here) |

Shared, append-only: `ui/lib/store.js` bottom section ("lane additions"). Only lane B
runs `npm install`; others list needed packages in their report.

## Run

- UI only, mock data, live reload: `node tools/serve-ui.js 4870` → `http://127.0.0.1:4870/?mock=1`
  (dev window: `electron tools/dev-window.js 4870`).
- Screenshot: `node tools/shot.js "<url>" .shots/<name>.png 1440 900` (CPU-capped, one browser
  machine-wide; keep it to a few captures, never a size sweep). Phone: 393x852 and 320x700.
- Real app: `dist\Helm\Helm.exe "C:\Users\you\helm"` (Start Menu "Helm", or `helm` in PowerShell).
  `node tools/make-exe.js` builds it: Electron copied to `dist/Helm/`, `electron.exe` renamed to
  `Helm.exe` and stamped with `ui/assets/icon.ico` + version info, so Windows shows Helm's name and
  icon everywhere. App code is NOT copied (the exe runs this folder), so only re-run it when the icon
  or Electron changes; then `bin\install-shortcut.ps1`. Helm.exe counts as a packaged app
  (`app.isPackaged` true, NODE_OPTIONS ignored). `npx electron .` still works for dev.
- Desktop-only features for real (visible; run while nobody is using the PC): `node tools/desktop-check.js` (Helm.exe,
  `--test --test-desktop` throwaway profile: tray, close-to-tray, hotkey, webview, toast, login item,
  second launch, Tailscale pairing).
- Real-app verifier: `node tools/verify-round3.js [--only=3,5]` drives a hidden `--test` Helm.exe with
  live `claude-haiku-5-5` turns (~$0.015 a full run; summary line `verify-round3: N passed, M failed`
  plus `live spend`). Stops only the PIDs it starts; never touches port 4871 or `%APPDATA%\Helm`.
  Two checks are built not to depend on timing outside their control:
  C3 (split view) warms both CLIs with a one-word turn, sends two 300-line prompts at once, and
  measures only after BOTH sessions report `working`: the WS stream windows must overlap and both
  panes' DOM text must grow in the same 500 ms. If the API alone staggered the streams it retries
  once with fresh words and says `RETRIED` in the evidence.
  C5 (Elsewhere) writes its own active external transcript into a temp projects folder
  (`%TEMP%\helm-v3-ext-<pid>`, removed at exit) and passes it as `HELM_TEST_EXTERNAL_DIRS`; that
  variable adds folders to the external scanner (`main/engine/external.js`) and `main.js` deletes it
  unless `--test`, so it never depends on the terminal session that launched the verifier.

- Restart + updates for real: `node tools/restart-e2e.js` (hidden `--test` Helm.exe watching a temp git repo via
  `HELM_TEST_UPDATE_REPO`, allowed to relaunch itself via `HELM_TEST_ALLOW_RESTART`; a live claude-haiku-5-5
  turn with a background shell; summary `restart-e2e: N passed, M failed`). Note `dist/Helm/resources/app/index.js`
  always loads THIS folder's `main.js`: never start Helm.exe without `--test` from a script (it would be a second
  launch of the installed Helm and focus its window).

## Design direction (lane C sets it; D and E follow `ui/styles/tokens.css`)

Design taste: premium = restraint and
precision. Glass panels over a blurred background photo the user picks (default: the desktop
wallpaper). Neutral greys with almost no colour cast, exact 1px hairlines at ~10%
white, real shadow for depth, one desaturated accent used for state only, glow only
as a focus ring. No neon, no sheen washes, no text-shadow, no gradient rims, no
always-running animations (Electron burns CPU on them; use short stepped
transitions). Blur the background image ONCE (one fixed layer) and make panels
translucent tints; never `backdrop-filter` on tall scrolling cards (drops raster
tiles on this GPU); blur only small overlays (menus, modals, popovers).
Loose reference: dark tinted glass over a misty landscape, slim icon
rail, projects→chats sidebar, centred chat column, user bubbles right, assistant
as plain text, rounded hairline cards, composer pinned at the bottom with model
picker. Layout and functions are ours to design: make it the best Claude Code UI,
not a copy.

## Look Sync (lane look-sync, 2026-10-10)

Helm shares theme, accent hue and glass with Quartz and Mantle through one file,
`%APPDATA%\look-sync\look.json`. Spec: `~/look-sync/CONTRACT.md`. Protocol: PROTOCOL.md "Look Sync".

- Each theme paints its own synced glass (CONTRACT "Light look", 2026-10-14): `glass.dark` in dark,
  `glass.light` in light (ui/lib/glass.js, ui/shell/state.js `glass`). The light ground is the picture at
  blur(glass.light.blurPx) saturate(150%) under a WHITE wash; following the desktop the wash alpha is Mantle's
  `desktop.guard.light` (ui/lib/wash.js), else glass.light.dim with the reason in Settings > Appearance.
- "Change it in Mantle's Wallpapers" is a button only once `MANTLE_OPEN` in main/look.js holds Mantle's
  second-instance command; until then Settings shows text with the reason.

- `main/look-sync.js` and `main/accent.js` are copied from `~/look-sync` at commit `4f82c4b`. Never edit the
  copies: change `~/look-sync`, run its tests, and copy them again.
- `main/look.js` owns Helm's one LookSync instance. It is the only bridge between it and `main/settings.js`.
- Data flow:
  - Local change: `settings.set` (not from sync) calls `onLocalChange(before, after)`; `look.js` publishes the
    changed `theme`, `accent` or `glass`.
  - Remote change: LookSync emits `apply`; `look.js` calls `settings.applyLook(changes)`, which runs
    `settings.set(..., { fromSync: true })`. It is saved and sent as `settings.updated` over the existing WS,
    and never published back.
  - The switch: a change to `lookSync.enabled` calls `sync.setEnabled(on)`. Turning it on adopts the shared values.
  - Window focus and system resume call `look.refresh()` (fs.watch can drop events).
  - Mantle's desktop record -> `look.js` picks the picture `/bg/desktop` serves (Windows' wallpaper as the
    announced fallback) and sends `look.updated`.
- Lining up: in `desktop` mode the desktop window draws the still where the desktop draws it. It is cover-fit
  to the monitor the window is mostly on and offset by the window's content-area position (placement IPC, in
  DIPs). The blurred still is drawn once on a canvas, per picture, blur value and monitor size. A move or
  resize only translates that canvas, once per animation frame; it is never blurred again for a move. The
  phone view is not lined up: it shows the still cover-fit, as before. Renderer: `ui/shell/chrome.js`
  `Background()` + `ui/lib/bg-placement.js`.

## Security rules

- Model output is untrusted: markdown → `marked` → `DOMPurify` before innerHTML. Never
  `eval`, never `dangerouslySetInnerHTML` without DOMPurify.
- Every WS/HTTP request needs the token (loopback too). Never bind 0.0.0.0.
- Preview pane shows arbitrary localhost pages: Electron `<webview>` with no node
  integration and a separate partition; on the phone an `<iframe sandbox>`.
- `/bg/desktop` never takes a path from the request. It serves only the file `main/look.js` chose: inside
  Mantle's `stills` folder, the file Mantle's record names, or Windows' TranscodedWallpaper. Each must sniff
  as an image. Look Sync values from other apps are range-checked before they reach settings.
- A `--test` run never reads or writes the real `%APPDATA%\look-sync`.
