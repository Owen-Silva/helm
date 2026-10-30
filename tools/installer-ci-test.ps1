# Install test for Helm-Setup.exe on a throwaway CI runner (.github/workflows/installer.yml). Never run it on a
# PC you use: it installs Helm for the current user, launches it, and uninstalls it again.
#
#   pwsh tools/installer-ci-test.ps1 -Setup dist/installer/out/Helm-Setup.exe [-Out dist/installer/ci]
#
# 1. silent install (/S); the files, the Start Menu shortcut and the Settings > Apps entry are there
# 2. the licensing guard over the installed folder (tools/check-installer.js)
# 3. first run with the npm registry unreachable: the SDK download fails VISIBLY (exit 1, a reason, a screenshot)
# 4. first run online: Helm downloads the Claude Agent SDK from npm, loads it and gets to ready (engine "real")
# 5. a second run with the registry unreachable still starts (the downloaded copy is reused, no network)
# 6. the UI renders and Settings > Helm shows the Updates row (tools/installer-ui-check.js); an uninstall while
#    this install's Helm runs refuses (exit 3) and leaves Helm running
# 7. silent uninstall: the folder, shortcut, Apps entry and the downloaded SDK are gone
# Prints one summary line: INSTALL_TEST PASS|FAIL ...
# Owner: lane installer.
param(
  [Parameter(Mandatory = $true)][string]$Setup,
  [string]$Out = 'dist/installer/ci'
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$Out = (Resolve-Path $Out).Path
$Setup = (Resolve-Path $Setup).Path
$notes = [System.Collections.Generic.List[string]]::new()
function CopyLogs { Get-ChildItem -Directory -ErrorAction SilentlyContinue (Join-Path $env:TEMP 'helm-test-*') | ForEach-Object { $l = Join-Path $_.FullName 'logs\main.log'; if (Test-Path $l) { Copy-Item $l (Join-Path $Out "$($_.Name)-main.log") -Force } } }
function Fail([string]$m) { CopyLogs; Write-Host "INSTALL_TEST FAIL: $m"; Write-Host ("passed so far: " + ($notes -join ' | ')); exit 1 }
function Ok([string]$m) { Write-Host "ok: $m"; $notes.Add($m) }

$dir = Join-Path $env:LOCALAPPDATA 'Programs\helm'
$exe = Join-Path $dir 'Helm.exe'
$lnk = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Helm.lnk'
$sdkRoot = Join-Path $env:LOCALAPPDATA 'Helm\claude-agent-sdk'
$unKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'
function AppsEntry { Get-ChildItem $unKey -ErrorAction SilentlyContinue | Get-ItemProperty | Where-Object { $_.DisplayName -like 'Helm*' } | Select-Object -First 1 }

# Start Helm.exe with arguments, stdout/stderr to files; returns the process.
function StartHelm([string]$name, [string[]]$arguments) {
  Start-Process -FilePath $exe -ArgumentList $arguments -PassThru -RedirectStandardOutput (Join-Path $Out "$name.out.txt") -RedirectStandardError (Join-Path $Out "$name.err.txt")
}
function WaitExit($p, [int]$sec, [string]$what) {
  if (-not $p.WaitForExit($sec * 1000)) { try { Stop-Process -Id $p.Id -Force } catch {} ; Fail "$what did not exit within $sec s" }
  $p.WaitForExit()
  return $p.ExitCode
}
function OutText([string]$name) { (Get-Content -Raw -ErrorAction SilentlyContinue (Join-Path $Out "$name.out.txt")) + '' }

# ---------- 1. install ----------
$size = [math]::Round((Get-Item $Setup).Length / 1MB, 1)
$t0 = Get-Date
$p = Start-Process -FilePath $Setup -ArgumentList '/S' -PassThru -Wait
if ($p.ExitCode -ne 0) { Fail "silent install exited $($p.ExitCode)" }
for ($i = 0; $i -lt 60 -and -not (Test-Path $exe); $i++) { Start-Sleep -Milliseconds 500 }
$secs = [math]::Round(((Get-Date) - $t0).TotalSeconds, 1)
if (-not (Test-Path $exe)) { Fail "no $exe after the silent install" }
$appPkg = Get-Content -Raw (Join-Path $dir 'resources\app\package.json') | ConvertFrom-Json
if ($appPkg.helmDistribution -ne 'installer') { Fail 'installed package.json has no helmDistribution=installer' }
if (-not $appPkg.helmSdk.version) { Fail 'installed package.json has no helmSdk pin' }
if (-not (Test-Path (Join-Path $dir 'resources\app\main.js'))) { Fail 'resources\app\main.js missing' }
Ok "installed $size MB setup in $secs s to $dir (Helm $($appPkg.version), SDK pin $($appPkg.helmSdk.version))"
if (-not (Test-Path $lnk)) { Fail "no Start Menu shortcut at $lnk" }
$target = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk).TargetPath
if ($target -ne $exe) { Fail "the Start Menu shortcut points at $target" }
Ok 'Start Menu shortcut -> Helm.exe'
$entry = AppsEntry
if (-not $entry -or -not $entry.UninstallString) { Fail 'no Settings > Apps (HKCU Uninstall) entry' }
Ok "Apps entry '$($entry.DisplayName)' $($entry.DisplayVersion) by '$($entry.Publisher)'"
$vi = (Get-Item $exe).VersionInfo
$si = (Get-Item $Setup).VersionInfo
if ($vi.CompanyName -ne $entry.Publisher) { Fail "Helm.exe CompanyName '$($vi.CompanyName)' is not the Apps entry publisher '$($entry.Publisher)'" }
Ok "Properties: Helm.exe '$($vi.CompanyName)' / '$($vi.LegalCopyright)'; setup '$($si.CompanyName)' / '$($si.LegalCopyright)'"

# ---------- 2. licensing guard over the installed folder ----------
node tools/check-installer.js $dir
if ($LASTEXITCODE -ne 0) { Fail 'the installed folder contains Anthropic software' }
Ok 'guard: no Anthropic files installed'
if (Test-Path $sdkRoot) { Fail "$sdkRoot exists before the first run" }

# ---------- 3. first run, npm registry unreachable: must fail visibly ----------
$env:HELM_NPM_REGISTRY = 'http://127.0.0.1:59999/'
$p = StartHelm 'offline-first-run' @('--test', '--profile=ci-offline', "--sdk-capture=$(Join-Path $Out 'sdk-failed.png')")
$code = WaitExit $p 120 'the offline first run'
$o = OutText 'offline-first-run'
if ($code -ne 1) { Fail "the offline first run exited $code, expected 1" }
$m = [regex]::Match($o, 'HELM_SDK_FAILED (\{.*\})')
if (-not $m.Success) { Fail 'the offline first run printed no HELM_SDK_FAILED line' }
$why = $m.Groups[1].Value | ConvertFrom-Json
if (-not $why.reason) { Fail 'the failure has no reason' }
if (Test-Path (Join-Path $sdkRoot 'installed')) { Fail 'a failed download left an installed SDK' }
Ok "offline first run failed visibly ($($why.code)): $($why.reason)"
Remove-Item Env:HELM_NPM_REGISTRY

# ---------- 4. first run online: download from npm, load, ready ----------
$ready = Join-Path $env:TEMP 'helm-test-ci\ready.json'
Remove-Item -Force -ErrorAction SilentlyContinue $ready
$t0 = Get-Date
$p = StartHelm 'first-run' @('--test', '--profile=ci', '--exit-when-ready', "--capture=$(Join-Path $Out 'home.png')", "--sdk-capture=$(Join-Path $Out 'sdk-ready.png')")
$code = WaitExit $p 240 'the first run'
$o = OutText 'first-run'
if ($code -ne 0) { Fail "the first run exited $code (see first-run.out.txt)" }
if (-not (Test-Path $ready)) { Fail 'the first run wrote no ready.json' }
$r = Get-Content -Raw $ready | ConvertFrom-Json
if ($r.engine -ne 'real') { Fail "engine is '$($r.engine)', expected real" }
if (-not $r.installed -or -not $r.sdk.fetched) { Fail 'ready.json does not show an installed build that fetched the SDK' }
if ($r.sdk.version -ne $appPkg.helmSdk.version) { Fail "SDK $($r.sdk.version) loaded, pin is $($appPkg.helmSdk.version)" }
if ($o -notmatch 'HELM_EXIT_WHEN_READY \{[^}]*"sdkQuery":true') { Fail 'the downloaded SDK did not load (no sdkQuery:true)' }
$sdkPkg = Join-Path $sdkRoot 'installed\node_modules\@anthropic-ai\claude-agent-sdk\package.json'
if (-not (Test-Path $sdkPkg)) { Fail "no SDK at $sdkPkg" }
$fetchLine = [regex]::Match($o, 'HELM_SDK (\{.*\})')
$bytes = if ($fetchLine.Success) { ($fetchLine.Groups[1].Value | ConvertFrom-Json).bytes } else { 0 }
Ok ("first run downloaded SDK $($r.sdk.version) from npm ({0:N1} MB) and reached ready in {1:N1} s" -f ($bytes / 1MB), ((Get-Date) - $t0).TotalSeconds)

# ---------- 5. second run, registry unreachable: reuses the downloaded copy ----------
$env:HELM_NPM_REGISTRY = 'http://127.0.0.1:59999/'
Remove-Item -Force -ErrorAction SilentlyContinue $ready
$p = StartHelm 'second-run' @('--test', '--profile=ci', '--exit-when-ready')
$code = WaitExit $p 120 'the second run'
Remove-Item Env:HELM_NPM_REGISTRY
if ($code -ne 0) { Fail "the offline second run exited $code" }
$r = Get-Content -Raw $ready | ConvertFrom-Json
if ($r.sdk.fetched) { Fail 'the second run downloaded the SDK again' }
Ok 'second run offline: reused the downloaded SDK'

# ---------- 6. uninstall while Helm runs: refuses, Helm keeps running ----------
$readyRun = Join-Path $env:TEMP 'helm-test-ci-running\ready.json'
Remove-Item -Force -ErrorAction SilentlyContinue $readyRun
$helm = StartHelm 'running' @('--test', '--profile=ci-running')
for ($i = 0; $i -lt 120 -and -not (Test-Path $readyRun); $i++) { Start-Sleep -Milliseconds 500 }
if (-not (Test-Path $readyRun)) { Fail 'the long-running Helm never got ready' }
# the UI renders from the installed files; Settings > Helm shows the Updates row (real check + a simulated new version)
$ui = node tools/installer-ui-check.js $readyRun $Out dist/installer/app/node_modules/ws
$ui | ForEach-Object { Write-Host $_ }
if ($LASTEXITCODE -ne 0) { Fail 'the UI check failed' }
Ok (($ui | Select-String 'UI_CHECK PASS: (.*)').Matches[0].Groups[1].Value)
$un = Join-Path $dir 'Uninstall Helm.exe'
$p = Start-Process -FilePath $un -ArgumentList @('/S', "_?=$dir") -PassThru -Wait
$helm.Refresh()
if ($helm.HasExited) { Fail "the uninstaller closed the running Helm (uninstaller exit $($p.ExitCode))" }
if ($p.ExitCode -ne 3) { Fail "an uninstall with Helm running exited $($p.ExitCode), expected 3" }
if (-not (Test-Path $exe)) { Fail 'the refused uninstall still removed Helm.exe' }
Ok 'uninstall with Helm running: refused (exit 3), Helm kept running'
Stop-Process -Id $helm.Id -Force
$helm.WaitForExit(15000) | Out-Null
for ($i = 0; $i -lt 30 -and (Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $exe }); $i++) { Start-Sleep -Milliseconds 500 }

# ---------- 7. uninstall ----------
$p = Start-Process -FilePath $un -ArgumentList '/S' -PassThru -Wait
for ($i = 0; $i -lt 120 -and (Test-Path $exe); $i++) { Start-Sleep -Milliseconds 500 }
Start-Sleep -Seconds 2
if (Test-Path $exe) { Fail 'Helm.exe is still there after the uninstall' }
if (Test-Path $lnk) { Fail 'the Start Menu shortcut is still there' }
if (AppsEntry) { Fail 'the Settings > Apps entry is still there' }
if (Test-Path $sdkRoot) { Fail "the downloaded SDK is still in $sdkRoot" }
$left = if (Test-Path $dir) { @(Get-ChildItem -Recurse -Force $dir).Count } else { 0 }
Ok "uninstalled: Helm.exe, shortcut, Apps entry and downloaded SDK gone ($left leftover files in $dir)"

CopyLogs
Write-Host ("INSTALL_TEST PASS: " + ($notes -join ' | '))
