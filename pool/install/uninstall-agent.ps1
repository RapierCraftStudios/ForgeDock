# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
<#
.SYNOPSIS
  Removes the computeshare agent from this Windows host: keep-alive task, firewall rules, portproxy, the dedicated WSL
  distro (with every container, image and cache in it) and the .wslconfig changes (restored from the backup).
#>
param([string] $Distro = 'computeshare', [int] $Port = 7711)
$ErrorActionPreference = 'Continue'
$env:WSL_UTF8 = '1'
Unregister-ScheduledTask -TaskName 'computeshare-keepalive' -Confirm:$false -ErrorAction SilentlyContinue
Get-Process powershell -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match 'computeshare\\keepalive.ps1' } | Stop-Process -Force
Get-NetFirewallRule -Name 'computeshare-agent' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
if (Get-Command Get-NetFirewallHyperVRule -ErrorAction SilentlyContinue) { Get-NetFirewallHyperVRule -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'computeshare*' -or $_.Name -like '*computeshare*' } | ForEach-Object { Remove-NetFirewallHyperVRule -Name $_.Name -ErrorAction SilentlyContinue } }
(netsh interface portproxy show v4tov4) -match " $Port " | ForEach-Object { $a = ($_ -split '\s+')[0]; if ($a) { netsh interface portproxy delete v4tov4 listenaddress=$a listenport=$Port | Out-Null } }
& wsl.exe --unregister $Distro
$cfg = Join-Path $env:USERPROFILE '.wslconfig'
if (Test-Path "$cfg.computeshare-backup") { Move-Item "$cfg.computeshare-backup" $cfg -Force; Write-Host 'Restored .wslconfig from backup (takes effect after wsl --shutdown).' }
Remove-Item -Recurse -Force (Join-Path $env:ProgramData 'computeshare') -ErrorAction SilentlyContinue
Write-Host '[computeshare] agent removed. Remove it from the router with: computeshare status (then delete it from router-state.json).'
