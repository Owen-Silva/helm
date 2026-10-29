; Helm's additions to electron-builder's NSIS installer (tools/build-installer.js passes this file as nsis.include).
; Owner: lane installer.

; "Is Helm running?" Asks; never kills it.
; electron-builder's default check closes every Helm.exe the user runs, by image name, and silently in /S mode.
; Helm's Quit stops every Claude Code session it runs, so a killed Helm cuts work off mid-turn, and the image name
; also matches a Helm.exe launcher built from a git checkout. This check looks at THIS install's Helm.exe only:
; Windows refuses to open a running program's file for writing, so if $INSTDIR\Helm.exe exists and can't be opened
; (nothing is written to it), a Helm from this install is running. The user is asked to quit it from the tray.
; Silent installs (/S) and uninstalls stop instead (exit code 3) and leave Helm running.
!macro customCheckAppRunning
  Push $R9
  ${Do}
    ${IfNot} ${FileExists} "$INSTDIR\Helm.exe"
      ${ExitDo}
    ${EndIf}
    ClearErrors
    FileOpen $R9 "$INSTDIR\Helm.exe" a
    ${IfNot} ${Errors}
      FileClose $R9
      ${ExitDo}
    ${EndIf}
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "Helm is running.$\r$\n$\r$\nQuit it first: right-click the Helm icon in the system tray (next to the clock) and choose Quit Helm. That also stops any Claude Code sessions it is running.$\r$\n$\r$\nThen click Retry." /SD IDCANCEL IDRETRY +3
    SetErrorLevel 3
    Quit
  ${Loop}
  Pop $R9
!macroend

; Uninstall (not the silent uninstall an update runs first): also remove the Claude Agent SDK that Helm downloaded
; on first run (main/sdk-fetch.js). Settings, sessions and logs in %APPDATA%\Helm stay, like every app's user data.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    RMDir /r "$LOCALAPPDATA\Helm\claude-agent-sdk"
    RMDir "$LOCALAPPDATA\Helm"
  ${endIf}
!macroend
