# Win32 probes for tools/desktop-check.js (things Electron can't report about itself).
#   -Action icon   -Hwnd <n> -Out <png>  : read the window's icon (WM_GETICON / class icon) and save it
#   -Action hotkey                       : press Ctrl+Alt+Space system-wide (keybd_event)
#   -Action hotkey-f9                    : press Ctrl+Alt+Shift+F9 (when Ctrl+Alt+Space is another app's)
#   -Action procname -ProcId <n>         : image name of a process
# Owner: lane host (B).
param([string]$Action, [string]$Hwnd = '0', [string]$Out = '', [int]$ProcId = 0)
$ErrorActionPreference = 'Stop'
Add-Type -Namespace HelmProbe -Name U -MemberDefinition @'
[DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
[DllImport("user32.dll")] public static extern IntPtr GetClassLongPtr(IntPtr h, int i);
[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
'@
switch ($Action) {
  'icon' {
    Add-Type -AssemblyName System.Drawing
    $h = [IntPtr][Int64]$Hwnd
    $big = [HelmProbe.U]::SendMessage($h, 0x7F, [IntPtr]1, [IntPtr]0)
    $small = [HelmProbe.U]::SendMessage($h, 0x7F, [IntPtr]0, [IntPtr]0)
    $cls = [HelmProbe.U]::GetClassLongPtr($h, -14)
    $use = @($big, $small, $cls) | Where-Object { $_ -ne [IntPtr]::Zero } | Select-Object -First 1
    $saved = $false
    if ($use -and $Out) { [System.Drawing.Icon]::FromHandle($use).ToBitmap().Save($Out, [System.Drawing.Imaging.ImageFormat]::Png); $saved = $true }
    @{ big = [Int64]$big; small = [Int64]$small; cls = [Int64]$cls; saved = $saved } | ConvertTo-Json -Compress
  }
  'hotkey' {
    $up = 2
    [HelmProbe.U]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero); [HelmProbe.U]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
    [HelmProbe.U]::keybd_event(0x20, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 60
    [HelmProbe.U]::keybd_event(0x20, 0, $up, [UIntPtr]::Zero); [HelmProbe.U]::keybd_event(0x12, 0, $up, [UIntPtr]::Zero)
    [HelmProbe.U]::keybd_event(0x11, 0, $up, [UIntPtr]::Zero)
    '{"pressed":true}'
  }
  'hotkey-f9' {
    # Ctrl+Alt+Shift+F9: used when Ctrl+Alt+Space belongs to another app (the user's running Helm),
    # so the test never pops someone else's window.
    $up = 2
    foreach ($k in 0x11, 0x12, 0x10, 0x78) { [HelmProbe.U]::keybd_event([byte]$k, 0, 0, [UIntPtr]::Zero) }
    Start-Sleep -Milliseconds 60
    foreach ($k in 0x78, 0x10, 0x12, 0x11) { [HelmProbe.U]::keybd_event([byte]$k, 0, $up, [UIntPtr]::Zero) }
    '{"pressed":true}'
  }
  'procname' { (Get-Process -Id $ProcId).ProcessName }
  default { throw "unknown action $Action" }
}
