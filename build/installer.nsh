; Helm's additions to electron-builder's NSIS installer (tools/build-installer.js passes this file as nsis.include).
; Owner: lane installer.

; "Is Helm running?" Asks; never kills it.
; electron-builder's default check closes every Helm.exe the user runs, by image name, and silently in /S mode.
; Helm's Quit stops every Claude Code session it runs, so a killed Helm cuts work off mid-turn, and the image name
; also matches a Helm.exe launcher built from a git checkout. This check only looks for THIS install's Helm.exe (by
; full path, through CIM, so a 32-bit installer sees 64-bit processes) and asks the user to quit it from the tray.
; Silent installs (/S) and uninstalls stop instead (exit code 3) and leave Helm running.
!macro customCheckAppRunning
  Push $R8
  Push $R9
  System::Call 'Kernel32::SetEnvironmentVariable(t "HELM_INSTDIR", t "$INSTDIR")'
  ${Do}
    nsExec::ExecToStack `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$p = Join-Path $$env:HELM_INSTDIR 'Helm.exe'; if (@(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $$_.Name -eq 'Helm.exe' -and $$_.ExecutablePath -eq $$p }).Count) { exit 3 }; exit 0"`
    Pop $R8
    Pop $R9
    ${If} $R8 != 3
      ${ExitDo}
    ${EndIf}
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "Helm is running.$\r$\n$\r$\nQuit it first: right-click the Helm icon in the system tray (next to the clock) and choose Quit Helm. That also stops any Claude Code sessions it is running.$\r$\n$\r$\nThen click Retry." /SD IDCANCEL IDRETRY +3
    SetErrorLevel 3
    Quit
  ${Loop}
  Pop $R9
  Pop $R8
!macroend

; Uninstall (not the silent uninstall an update runs first): also remove the Claude Agent SDK that Helm downloaded
; on first run (main/sdk-fetch.js). Settings, sessions and logs in %APPDATA%\Helm stay, like every app's user data.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    RMDir /r "$LOCALAPPDATA\Helm\claude-agent-sdk"
    RMDir "$LOCALAPPDATA\Helm"
  ${endIf}
!macroend
