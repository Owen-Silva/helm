# Helm guide

Short how-tos. Shortcuts are written with Ctrl; the full table is in the [README](../README.md).

## Home

Helm opens on Home: your wallpaper with no blur, a greeting and the time, and your sessions as cards.

- Get there by clicking the **Helm logo** in the top-left corner, with **Ctrl+Shift+H**, or with **Go home** in the
  command palette (**Ctrl+K**). Closing your last tab also lands here.
- The row under the greeting shows how many sessions are working now (one with only agents running counts),
  how many need you, your **5H** and **Week** usage, and **Active today** (the same count as Usage → Active hours).
- **Jump back in** has a card per session: your open tabs first, in tab order, then your other active sessions.
  The dot is the session's status, and a session waiting on you has an amber edge and says **Needs you**.
  The line underneath says what it is doing, how long it has run, how many agents are running and the time left
  when the eta mod has an estimate. Click a card to open the session as a tab.
- **New session** starts one, as **Ctrl+N** does.
- Only the top bar stays on Home: tabs, search and the update chip all still work. Clicking a tab or card, or using
  **Ctrl+Tab**, **Ctrl+1–9**, the palette or a notification, brings the panels and the blur back. **Ctrl+H**,
  **Ctrl+,** and **Ctrl+Shift+D** open History, Settings and Deck; pressing the same key again comes back to Home.
  The sidebar button (or **Ctrl+B**) leaves Home with the sidebar open.
- Your tabs come back after a restart. Helm still opens on Home, with none of them active.
- On the phone, **Home** is the first item in the bottom bar and the phone opens there too. The cards stack in
  one column, and tapping the Helm mark on the Sessions list also goes Home.
- If your system is set to reduce motion, Home appears and disappears instantly instead of fading.

## Sign in (Settings → Account)

Helm never signs you in. Its sessions use whatever your installed Claude Code is signed in with: your
Claude account or your own API key.

- To sign in, open a terminal, run `claude`, and sign in there. Then press **Check again** in
  Settings → Account.
- Settings → Account shows what Claude Code reports: signed in or not, the method, plan, email and
  organization. Helm checks at startup, when you open the panel, and after a session fails because
  Claude Code isn't signed in.
- Optional: paste an Anthropic API key there to make sessions use it instead. Helm shows only its last
  4 characters. **Remove key and use Claude Code's sign-in** goes back to it. Running sessions restart onto the change.
- With an API key, a Console login or a cloud provider there are no 5-hour or weekly limits: the usage
  panels show cost and say so.

## Start a session in a project

1. Press **Ctrl+N** (or **New session** on the welcome screen, or the **+** next to a project in the sidebar).
2. Pick the project folder (type a path or **Browse…**).
3. Choose model, effort and permission mode. The defaults come from Settings → New session defaults.
4. Optionally type a first prompt, then **Start session** (or Ctrl+Enter).

The session appears under its project in the sidebar. It is a real Claude Code session, so the
project's `CLAUDE.md`, your hooks, MCP servers and skills all load.

## Answer a question or a permission request

When Claude needs you, the session's dot turns to "waiting", the sidebar shows a badge, and (if
the window isn't focused) a Windows notification appears. Clicking it opens the session.

- **Permission**: **Allow**, **Allow for this session** (stops asking for that tool), or type a reason and **Deny** (Enter in the reason box also denies).
- **Question**: click options, or press **1–9**; the number after the last option is "Other" with a text box. **Enter** or **Submit** sends.

## Approve a plan

In plan mode, Claude ends with a "Ready to code?" card showing the plan.

- **Approve** starts work with your current permission mode.
- **Approve + auto-accept edits** starts work and lets file edits through without asking.
- **Approve + bypass permissions…** asks once more (an inline warning), then starts work with every
  tool allowed for the rest of the session. Change the mode back from the composer any time.
- **Keep planning** opens a box: say what to change, then **Send feedback** (or Ctrl+Enter).

## Send a message while it works

Just type and press **Enter** while Claude is working. Claude reads the message at its next step
(after the current tool call): the turn is not interrupted and background agents keep running.
Slash commands, and the moments a session is starting, compacting or being stopped, can't go in
mid-turn: those messages wait instead, a "N queued" chip shows next to the context meter, and
they are sent as soon as the current turn ends. This works from the phone and the quick-prompt
box too.

## Talk instead of typing

Click the **mic** in the composer (or press **Ctrl+M**), speak, then click it or press **Ctrl+M**
again. Holding Ctrl+M (or the mic) and letting go works as push-to-talk; **Esc** throws the
take away. The words land at the cursor and are never sent by themselves, so you can fix them
first. The line above the buttons shows what is happening: listening with a timer and a level
meter, transcribing, or the reason it could not (mic blocked, no mic, nothing heard, engine
missing) with **Try again**.

It runs Whisper (`base.en`) on this PC: nothing goes to a cloud service and no audio is saved.
The first take after a while loads the model (a few seconds, while you talk). On the phone the
audio goes over Tailscale to the laptop's Whisper; the phone needs the `https://` link for the mic.
If the line says the engine is missing, install it once: `py -m pip install faster-whisper`.

## Stop a turn

With the composer empty, press **Esc** in the composer or click the square stop button. This
interrupts the current turn; the session stays open and you can keep talking.

To end the whole Claude process for a session, use the session's **⋯** menu → **Stop session**.
It can be resumed later from History.

## Find, archive and delete sessions

- **Filter**: the box at the top of the sidebar (**Ctrl+Shift+F**) filters by title, project or
  folder as you type; Enter opens the first match, Esc clears it. The **Working / Waiting / Error**
  chips show only sessions in that state (combine them freely).
- **Archive** (session menu, the **...** on a row or in the header): stops its Claude Code and
  moves it into the collapsed **Archived** group at the end of the list. Open it to read it; send a
  message to resume it, which also brings it back. **Unarchive** puts it back without starting anything.
- **Close**: stops its Claude Code now; the session stays in the list and resumes on your next message.
- **Delete from Helm…**: removes Helm's record after a confirm. Claude Code's own transcript is
  never touched, so the conversation is still in History and can be resumed.
- **Several at once**: Ctrl-click rows to pick them (the open one joins the first pick), Shift-click
  for a range, then **Archive** (or the bin) in the bar at the bottom. Esc clears the selection.
- Sessions idle for over a week get a quiet "N sessions idle for over a week · Archive them" link at
  the end of the list. Nothing is archived unless you click it.
- **Projects**: a group header's **...** menu pins the project to the top or renames it (only
  Helm's label; the folder is unchanged).
- **Copy link** gives `helm://session/<id>`: opening it (Win+R, a note, a shortcut) brings Helm up
  on that session. **Copy Helm session id** is the id for `helm --session=<id>`.

## Split two sessions

- **Ctrl+Shift+\\** opens the previous session beside the current one (press again to close the other pane).
- Or: a session's **⋯** menu → **Split with …**, a sidebar row's menu → **Open side by side**, or drag a session from the sidebar onto a pane.

The pane you click is the focused one: the inspector, palette and Ctrl+1–9 follow it. Desktop only.

## Four sessions at once (4 corners)

- The layout switch left of **Search** in the top bar picks **1** pane, **2** side by side or **4** corners;
  **Ctrl+Shift+4** turns 4 corners on (and back), or use the palette's **Layout:** commands.
- Picking 4 keeps the session you are on in the top-left corner and fills the others with your tabs in order.
- Each corner has its own header (title, state, context %) and message box, so you can reply in any of them.
- Drag a tab down onto a corner (or a sidebar row) to put it there; if it is already in another corner the two
  swap. An empty corner says **Drag a tab here** and lists open tabs and recent sessions to click in.
- A corner's **×** empties it (the tab stays open); closing a corner's tab empties that corner too. The layout
  stays either way and comes back after a restart or a trip to Home.
- The right panel hides while the corners show; **Ctrl+\\** brings it back. Below about 1100 px wide only the
  focused corner's row shows; widen the window and all four return.

## Tabs

The sessions you are using sit as tabs in the top bar, like a terminal's tabs. Desktop only; the phone keeps its list.

- Opening a session from anywhere (sidebar, Past, palette, a notification, a `helm://` link) adds it as a tab at the end and shows it. **+** starts a new session.
- Closing a tab (**×**, middle-click or **Ctrl+W**) takes it off the bar. The session stays in the sidebar, exactly where it was. The tab next to it takes over; with no tabs you get the home screen.
- Closing a tab also closes that session's Claude process if nothing is running in it, to free memory, even when **Close idle sessions after** is set to Never. Your next message picks the conversation up where it left off; just looking at the session again does not restart anything.
  - If it is still working (a reply, agents, background tasks, a `!` command, queued messages, or a question or permission waiting for you), nothing is interrupted: the process closes within a minute of the work finishing.
  - A `/loop` or scheduled session keeps its process, so its next tick still runs.
  - It is left alone while the session is still on screen: in the other half of a split, or open on the phone. Opening the tab again or sending it a message cancels the pending close.
- Drag a tab to reorder it. **Ctrl+Tab** / **Ctrl+Shift+Tab** step through tabs, **Ctrl+1–8** jump to that tab, **Ctrl+9** to the last one.
- Each tab shows its status dot (a waiting tab is tinted amber) and, while agents run, a small agent count. Hover for the full title and folder.
- Tabs and their order come back after a restart. Helm opens on [Home](#home) with none of them active. Search moved to the right of the bar (**Ctrl+K** as before).

## Find in a session

Press **Ctrl+F**. Matches include text inside collapsed tool and agent cards (they open as you
step to them). **Enter** = next, **Shift+Enter** = previous, **Esc** closes. If the match might be
further back, use the button that loads earlier messages and keeps searching.

## Fork, edit & resend, rewind to here

Hover one of your messages (long-press on the phone):

- **Fork from here**: a new session with the conversation up to, but not including, that message. The original is untouched.
- **Edit & resend**: edit the text; Helm forks at that message and sends your edited version in the new session. The original is untouched.
- **Rewind to here**: opens the rewind dialog at that message's checkpoint (see "Review changes"). If Claude Code recorded no checkpoint there, Helm says so; fork instead.

## Watch agents and the 32% / 40% context marks

Open the inspector (**Ctrl+\\**) → **Agents**. Each sub-agent shows its status, tool count, last
tool and a context bar. The bar spans 0–50% of the window with marks at **32%** (hand off to a
fresh agent) and **40%** (hard ceiling). Click an agent to jump to it in the conversation. The
toggle at the top lists every session's agents instead of just this one.

## Review changes and rewind files

Inspector → **Changes** lists the files this session changed with +/- counts. Click one for its
diff against git HEAD (switch to side by side if you like). Under **Checkpoints**, pick one and
**Rewind…**, then choose **Files only**, **Conversation only** or **Both**. The dialog spells out
exactly which files go back and what is lost. Stop the running turn first; rewinding during a
turn is refused.

## Preview a localhost app

Inspector → **Preview**. Localhost addresses Claude mentions in the session are offered as
one-click picks; or type `3000`, `:3000` or `localhost:3000` in the address bar. The page runs in
its own sandbox; links that open new windows go to your normal browser, and the arrow button
opens the current page there too. On the phone, `localhost` means the phone itself, so Helm
offers the PC's address instead.

## Usage history

The Usage panel's **History** shows the 5-hour window over the last 24 hours (thin marks where
it reset; a gap means Helm was not running), the week over the last 7 days, and cost per day for
the last 14 days. Hover or tap a bar for that day's cost by project. Helm records a reading every
5 minutes while it runs (and whenever usage changes), kept for 14 days in
`usage-history.jsonl` in its profile folder.

## Queue overnight work

Inspector → **Queue** (on the phone, the Queue tab) → **New job**.

1. Write the prompt; pick project, model, effort and permissions.
2. **Start**: "When budget allows" or "After a time".
3. **Don't start above**: the 5-hour usage % a job may start under. Without 5-hour limits (API key,
   Console login or cloud provider) this gate is skipped.

Helm checks every minute and runs one job at a time as a normal session. A waiting job says why
it hasn't started. Done jobs keep a summary; **Open session** shows the full run. Helm must be
running (the tray is enough); the PC must be awake.

## Resume a past session

**Ctrl+H** (or the History item). Search by title, prompt or project; **Resume** reopens it as a
Helm session with its full history. If it is already open in Helm, the button says **Open**.
Sessions run from a temp folder (scratch and test runs) are hidden; **Include temp folders** shows them.

## Watch terminal sessions (Elsewhere)

Claude Code sessions you run in a terminal appear in the sidebar's **Elsewhere** section: active
ones first, then recent idle ones. Click one to read its transcript live (read-only) with its ETA
and agent count. When the terminal session is idle, **Resume in Helm** takes it over. Helm will not
offer that while the terminal is still writing to it.

## Quick prompt from anywhere

Press **Ctrl+Alt+Space** (change or clear it in Settings → Startup & shortcuts). A small box
appears over whatever you are doing. Type, pick an open session or "New session in <project>"
from the drop-down, press **Enter**. The box hides itself a moment later; the confirmation has a
link to open that session. **Esc** hides it. Also from `helm --quick` or the tray menu.

## Change the background

Settings → Appearance. Click any photo (it applies immediately), filter by category, or
**Shuffle**. **Add photo** (or drop an image on the gallery) uses your own JPEG, PNG or WebP up
to 15 MB. Adjust **Blur** and **Dim**, and pick the theme: dark, light or system. [Home](#home) shows the
photo without blur. Dim still applies.

## Use it from the phone

One-time setup is in the README ("Phone setup"): Tailscale on both devices, run
`bin\firewall.ps1` from an elevated PowerShell, then Settings → Phone → **Allow phone access**
and scan the QR code. The phone gets a bottom bar (Home, Sessions, History, Queue, Settings); the
panels button in a session's header opens the inspector as a sheet. On the phone, Enter adds a new
line; use the send button.

## If something goes wrong

**"Claude Code isn't signed in"**
- Open a terminal, run `claude`, and sign in there; then press **Check again** in Settings → Account.
  Until then new messages are refused and queued jobs wait. Helm has no sign-in button.
- If the panel says it couldn't check, nothing is blocked: a session that fails shows Claude Code's own error.

**The phone can't connect**
- "Not paired" banner: the key is wrong or old. Re-scan the QR code from Settings → Phone on the PC.
- Settings → Phone says "Waiting for Tailscale": the PC isn't on the tailnet. Helm rechecks every minute.
- Page won't load at all: check Tailscale is on for both devices and the firewall rule exists (re-run `bin\firewall.ps1` elevated).
- The phone link must use port 4871. If another program held 4871 when Helm started, Helm picked a random port and the firewall rule won't match; the log says "port 4871 in use". Free the port and restart Helm.

**A "stand-in engine" banner at the top**
- The real engine did not load, so sessions are not running Claude Code. The banner says why and
  where the log is (**Copy log path**). Fix the cause it names, then quit Helm from the tray and start it again.

**The window won't open**
- Helm is probably already running in the tray (closing the window only hides it). Click the tray icon or launch Helm again; a second launch focuses the first.
- To restart cleanly: tray icon → right-click → **Quit Helm**, then start it again.
- Look at `%APPDATA%\Helm\logs\main.log` for "boot failed", "load failed" or "renderer gone". If Helm can't start at all it shows a "Helm could not start" error box.
