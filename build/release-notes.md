Helm for Windows: a per-user installer (no admin prompt).

**Download:** Helm-Setup.exe below.

**Before you start:** install Claude Code from Anthropic (https://code.claude.com/docs) and sign in to it once in a terminal (`claude`). Helm runs your own Claude Code; it never signs you in.

**Windows will warn you.** The installer isn't code-signed, so Microsoft Defender SmartScreen says "Windows protected your PC". Click **More info**, then **Run anyway**.

**What's inside:** Helm's own code (GPL-3.0), Electron and three small open-source libraries. **No Anthropic software:** on first run Helm downloads Anthropic's Claude Agent SDK onto your PC from the npm registry, the same package `npm install` gets, and checks it against a pinned sha512. It installs to `%LOCALAPPDATA%\Programs\helm`; uninstall from Settings > Apps.

Building from source still works exactly as before: see the README.

**Code signing policy:** https://github.com/Owen-Silva/helm#code-signing-policy
