# Adds (or updates) the `helm` function in the user's PowerShell profile. `helm` starts Helm detached
# as dist\Helm\Helm.exe "<this repo>" (its own name + icon; tools/make-exe.js builds it), falling
# back to node_modules\electron\dist\electron.exe when Helm.exe hasn't been built. A second call
# brings the running window forward (Helm is single-instance) and hands over its args, e.g.
# `helm --quick` (quick-prompt box) or `helm --session=<id>`; `helm --hidden` starts in the tray.
# Re-running replaces the block this script wrote (old unmarked version included); the profile is
# backed up next to itself first.
# Usage: powershell -ExecutionPolicy Bypass -File bin\install-profile.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$profilePath = (powershell -NoProfile -Command '$PROFILE').Trim()
if (-not (Test-Path $profilePath)) { throw "PowerShell profile not found at $profilePath" }

$bytes = [IO.File]::ReadAllBytes($profilePath)
$hasBom = $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
$text = [IO.File]::ReadAllText($profilePath)
$nl = if ($text -match "`r`n") { "`r`n" } else { "`n" }

$begin = '# >>> helm (bin\install-profile.ps1) >>>'
$end = '# <<< helm <<<'
$lines = @(
    $begin,
    "# Helm ($root): desktop + phone deck over the real Claude Code, as Helm.exe. Starts detached;",
    '# a second call brings the running window forward and passes its args (helm --quick, helm --session=<id>).',
    'function helm {',
    "    `$root = '$root'",
    "    `$exe = Join-Path `$root 'dist\Helm\Helm.exe'",
    "    if (-not (Test-Path `$exe)) { `$exe = Join-Path `$root 'node_modules\electron\dist\electron.exe' }",
    "    if (-not (Test-Path `$exe)) { Write-Host `"Helm: no Helm.exe or electron.exe under `$root (npm install, then node tools\make-exe.js)`" -ForegroundColor Red; return }",
    "    `$argList = @(`"```"`$root```"`") + `$args",
    "    Start-Process -FilePath `$exe -ArgumentList `$argList -WorkingDirectory `$root | Out-Null",
    '}',
    $end
)
$block = $lines -join $nl

$marked = '(?s)' + [regex]::Escape($begin) + '.*?' + [regex]::Escape($end)
# the first version of this script wrote an unmarked block: "# Helm (...)" comment lines + function helm { ... }
$legacy = '(?ms)^# Helm \([^\r\n]*\r?\n# call brings the running window forward \(single instance\)\. Added by bin\\install-profile\.ps1\.\r?\nfunction helm \{.*?^\}'

if ($text -match $marked) { $new = [regex]::Replace($text, $marked, { param($m) $block }); $how = 'updated' }
elseif ($text -match $legacy) { $new = [regex]::Replace($text, $legacy, { param($m) $block }); $how = 'replaced the old' }
elseif ($text -match '(?m)^\s*function\s+helm\b') { Write-Host "A 'helm' function not written by this script exists in $profilePath; left it alone."; exit 0 }
else { $new = $text.TrimEnd() + $nl + $nl + $block + $nl; $how = 'added' }

if ($new -eq $text) { Write-Host "'helm' in $profilePath is already current."; exit 0 }
$backup = "$profilePath.bak-helm-$(Get-Date -Format yyyyMMdd-HHmmss)"
Copy-Item -LiteralPath $profilePath -Destination $backup
[IO.File]::WriteAllText($profilePath, $new, (New-Object System.Text.UTF8Encoding($hasBom)))

# prove the profile still parses
$errs = $null
[void][System.Management.Automation.Language.Parser]::ParseFile($profilePath, [ref]$null, [ref]$errs)
if ($errs -and $errs.Count) { Copy-Item -LiteralPath $backup -Destination $profilePath -Force; throw "profile no longer parsed ($($errs[0].Message)); restored $backup" }
Write-Host "$how 'helm' in $profilePath (backup: $backup). Open a new terminal (or run . `$PROFILE) to use it."
