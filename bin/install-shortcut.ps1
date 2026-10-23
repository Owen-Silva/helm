# Creates (or refreshes) the Start Menu shortcut "Helm" -> dist\Helm\Helm.exe "<this repo>", with
# Helm.exe's own icon (tools/make-exe.js stamps ui/assets/icon.ico into it). Falls back to
# electron.exe + icon.ico when Helm.exe hasn't been built. Electron writes the shortcut
# (shell.writeShortcutLink) so it carries Helm's AppUserModelID (com.owensilva.helm): Windows needs
# that for toasts to show as "Helm" and for the taskbar button to group with the running window.
# No admin rights needed (per-user Start Menu).
# Usage: powershell -ExecutionPolicy Bypass -File bin\install-shortcut.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $root 'dist\Helm\Helm.exe'
if (-not (Test-Path $exe)) {
    Write-Host "dist\Helm\Helm.exe not built (node tools\make-exe.js); using electron.exe for now."
    $exe = Join-Path $root 'node_modules\electron\dist\electron.exe'
}
if (-not (Test-Path $exe)) { throw "no Helm.exe or electron.exe under $root (run npm install)" }

# Helm.exe counts as a packaged app, so it warns on stderr about NODE_OPTIONS (the user's profile sets
# one); clear it for this call and don't let PowerShell 5.1 turn stderr lines into errors.
$env:NODE_OPTIONS = $null
$ErrorActionPreference = 'Continue'
$out = & $exe $root --install-shortcut 2>&1 | Out-String
$ErrorActionPreference = 'Stop'
$lnk = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Helm.lnk'
if ($out -match 'HELM_SHORTCUT (\{.*\})' -and (Test-Path $lnk)) {
    $info = $Matches[1] | ConvertFrom-Json
    Write-Host "Start Menu shortcut ready: $lnk"
    Write-Host "  target $($info.target)  icon $($info.icon)  AUMID $($info.appUserModelId)"
} else {
    throw "shortcut was not created. Helm said: $out"
}
