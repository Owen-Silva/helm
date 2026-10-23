# Lets the phone reach Helm over Tailscale: allows inbound TCP 4871 ONLY from the Tailscale
# range 100.64.0.0/10, so public Wi-Fi can't reach it. Helm itself also only binds 127.0.0.1
# and the Tailscale IP.
# Needs an elevated PowerShell (Run as administrator), from the Helm folder:
#   powershell -ExecutionPolicy Bypass -File .\bin\firewall.ps1
$ErrorActionPreference = 'Stop'
$name = 'Helm (Tailscale)'
$port = 4871

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { throw "Run this from an elevated PowerShell (Run as administrator): powershell -ExecutionPolicy Bypass -File `"$PSScriptRoot\firewall.ps1`"" }

$existing = Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Rule '$name' already exists; updating it."
    $existing | Set-NetFirewallRule -Enabled True -Action Allow -Direction Inbound
    $existing | Get-NetFirewallPortFilter | Set-NetFirewallPortFilter -Protocol TCP -LocalPort $port
    $existing | Get-NetFirewallAddressFilter | Set-NetFirewallAddressFilter -RemoteAddress 100.64.0.0/10
} else {
    New-NetFirewallRule -DisplayName $name -Direction Inbound -Protocol TCP -LocalPort $port -RemoteAddress 100.64.0.0/10 -Action Allow | Out-Null
}
Get-NetFirewallRule -DisplayName $name | Select-Object DisplayName, Enabled, Direction, Action | Format-List
