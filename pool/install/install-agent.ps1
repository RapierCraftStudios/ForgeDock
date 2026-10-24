# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
<#
.SYNOPSIS
  Installs a computeshare agent on a Windows host: a dedicated WSL2 distro ("computeshare") running Docker and the agent,
  reachable on this machine's Tailscale IP, with a CPU/RAM ceiling enforced by the WSL VM itself.
.NOTES
  Run in an elevated PowerShell. Normally started by the router's bootstrap one-liner (computeshare install-command).
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string] $RouterUrl,
  [Parameter(Mandatory)] [string] $EnrollToken,
  [Parameter(Mandatory)] [string] $BundlePath,
  [string] $AgentName = $env:COMPUTERNAME.ToLower(),
  [int] $Port = 7711,
  [int] $AllowCpus = 0,      # 0 = logical CPUs minus 4 (min 2)
  [int] $AllowMemGb = 0,     # 0 = half of physical RAM (min 4)
  [string] $Distro = 'computeshare',
  [switch] $Force            # kept for compatibility; the install never prompts
)
$ErrorActionPreference = 'Stop'
$env:WSL_UTF8 = '1'
function Say($m) { Write-Host "[computeshare] $m" -ForegroundColor Cyan }
function Fail($m) { Write-Host "[computeshare] $m" -ForegroundColor Red; exit 1 }

$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Fail 'Run this from an elevated (Administrator) PowerShell.' }

$installDir = Join-Path $env:ProgramData 'computeshare'
New-Item -ItemType Directory -Force -Path $installDir | Out-Null

# --- Tailscale ---------------------------------------------------------------------------------------------------
$ts = (Get-Command tailscale.exe -ErrorAction SilentlyContinue).Source
if (-not $ts) { $ts = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe' }
if (-not (Test-Path $ts)) { Fail 'Tailscale is not installed.' }
$tsIp = (& $ts ip -4 | Select-Object -First 1).Trim()
if ($tsIp -notmatch '^100\.') { Fail "Could not read this machine's Tailscale IPv4 (got '$tsIp')." }
Say "Tailscale IP $tsIp"

# --- Resource ceiling --------------------------------------------------------------------------------------------
$threads = [Environment]::ProcessorCount
Add-Type -AssemblyName Microsoft.VisualBasic
$ramGb = [math]::Floor((New-Object Microsoft.VisualBasic.Devices.ComputerInfo).TotalPhysicalMemory / 1GB)
if ($AllowCpus -le 0) { $AllowCpus = [math]::Max(2, $threads - 4) }
if ($AllowMemGb -le 0) { $AllowMemGb = [math]::Max(4, [math]::Floor($ramGb / 2)) }
$vmMemGb = $AllowMemGb + 2   # docker + agent overhead inside the VM
Say "Host: $threads threads, $ramGb GB RAM. Lanes get $AllowCpus CPUs / $AllowMemGb GB (WSL VM capped at $AllowCpus CPUs / $vmMemGb GB)."

# --- WSL ---------------------------------------------------------------------------------------------------------
# wsl.exe can hang when the WSL service is wedged. Every call runs in a job with a timeout; on a hang the service is
# restarted once and the call retried, so the install never needs a manual fix.
function Reset-WslService {
  Say 'WSL service is not responding: restarting it'
  Get-Process wsl, wslhost, wslrelay, wslservice -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
  Start-Service WSLService -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 3
}
function Invoke-Wsl([string[]] $WslArgs, [int] $TimeoutSec = 120, [switch] $Optional) {
  for ($try = 1; $try -le 2; $try++) {
    $job = Start-Job -ScriptBlock { param($a) $env:WSL_UTF8 = '1'; $o = & wsl.exe @a 2>&1 | Out-String; [pscustomobject]@{ rc = $LASTEXITCODE; out = $o } } -ArgumentList (, $WslArgs)
    if (Wait-Job $job -Timeout $TimeoutSec) { $r = Receive-Job $job; Remove-Job $job -Force; return $r }
    Stop-Job $job -ErrorAction SilentlyContinue; Remove-Job $job -Force -ErrorAction SilentlyContinue
    if ($Optional) { return $null }
    if ($try -eq 1) { Reset-WslService }
  }
  Fail "wsl $($WslArgs -join ' ') still hangs after restarting the WSL service. Reboot this PC, then run a fresh install command."
}
Say 'Checking WSL'
$v = Invoke-Wsl @('--version') 60
if ($v.rc -ne 0) {
  Say 'WSL is missing or the old inbox version: installing it. Reboot when it finishes, then run a fresh install command.'
  $r = Invoke-Wsl @('--install', '--no-distribution', '--web-download') 1200
  Write-Host $r.out
  exit 3010
}
$wslVer = [version]'0.0'
if ($v.out -match 'WSL[^:\r\n]*:\s*([0-9]+(\.[0-9]+)+)') { $wslVer = [version]$Matches[1] }
Say "WSL $wslVer"
if ($wslVer -lt [version]'2.0') {
  # mirrored networking and the current --import behaviour need WSL 2.0+; only then is an update worth the wait
  Say 'Updating WSL (up to 10 min; skipped if it stalls)'
  $u = Invoke-Wsl @('--update', '--web-download') 600 -Optional
  if ($null -eq $u) { Say 'wsl --update stalled; continuing with the installed version.' }
}

# WSL 2 needs the Virtual Machine Platform feature and CPU virtualisation enabled in firmware (wsl.exe alone is not enough).
$cpu = Get-CimInstance Win32_Processor -ErrorAction SilentlyContinue | Select-Object -First 1
$hvPresent = [bool](Get-CimInstance Win32_ComputerSystem -ErrorAction SilentlyContinue).HypervisorPresent
if (-not $hvPresent -and $cpu -and $cpu.VirtualizationFirmwareEnabled -eq $false) {
  Fail 'CPU virtualisation is disabled in the BIOS/UEFI (Intel VT-x / AMD SVM). Enable it in the firmware setup, boot Windows, then run a fresh install command.'
}
$needReboot = $false
foreach ($f in 'VirtualMachinePlatform', 'Microsoft-Windows-Subsystem-Linux') {
  $st = (Get-WindowsOptionalFeature -Online -FeatureName $f -ErrorAction SilentlyContinue).State
  if ($st -and $st -ne 'Enabled') {
    Say "Enabling Windows feature $f"
    $r = Enable-WindowsOptionalFeature -Online -FeatureName $f -All -NoRestart -ErrorAction Stop
    if ($r.RestartNeeded) { $needReboot = $true }
  }
}
if ($needReboot) {
  Say 'Windows features for WSL 2 were enabled. Reboot this PC, then run a fresh install command (computeshare install-command).'
  exit 3010
}

$build = [int](Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion').CurrentBuildNumber
$mirrored = $build -ge 22621
Say ("Networking: " + ($(if ($mirrored) { 'mirrored (agent listens on the Tailscale IP directly)' } else { 'NAT + portproxy (Windows 10 / older 11)' })))

# .wslconfig is per Windows user and applies to every distro: merge our keys, keep everything else.
$wslConfig = Join-Path $env:USERPROFILE '.wslconfig'
$lines = @(); if (Test-Path $wslConfig) { $lines = Get-Content $wslConfig }
$want = [ordered]@{ processors = "$AllowCpus"; memory = "${vmMemGb}GB"; vmIdleTimeout = '-1' }
if ($mirrored) { $want['networkingMode'] = 'mirrored' }
$out = New-Object System.Collections.Generic.List[string]; $inWsl2 = $false; $seen = @{}
foreach ($l in $lines) {
  if ($l -match '^\s*\[(.+)\]\s*$') {
    if ($inWsl2) { foreach ($k in $want.Keys) { if (-not $seen[$k]) { $out.Add("$k=$($want[$k])"); $seen[$k] = $true } } }
    $inWsl2 = ($Matches[1].Trim().ToLower() -eq 'wsl2')
    $out.Add($l); continue
  }
  if ($inWsl2 -and $l -match '^\s*([A-Za-z]+)\s*=') {
    $k = $want.Keys | Where-Object { $_ -ieq $Matches[1] } | Select-Object -First 1
    if ($k) { $out.Add("$k=$($want[$k])"); $seen[$k] = $true; continue }
  }
  $out.Add($l)
}
if ($inWsl2) { foreach ($k in $want.Keys) { if (-not $seen[$k]) { $out.Add("$k=$($want[$k])"); $seen[$k] = $true } } }
if (-not ($out | Where-Object { $_ -match '^\s*\[wsl2\]\s*$' })) { $out.Add('[wsl2]'); foreach ($k in $want.Keys) { $out.Add("$k=$($want[$k])") } }
$changed = (($lines -join "`n") -ne ($out -join "`n"))
if ($changed) {
  if (Test-Path $wslConfig) { Copy-Item $wslConfig "$wslConfig.computeshare-backup" -Force }
  Set-Content -Path $wslConfig -Value $out -Encoding ascii
  Say "Updated $wslConfig (backup: .wslconfig.computeshare-backup). NOTE: these limits apply to all your WSL distros."
}

# --- Dedicated distro -------------------------------------------------------------------------------------------
$distros = (Invoke-Wsl @('-l', '-q') 60).out -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ }
if ($distros -notcontains $Distro) {
  $base = 'https://cloud-images.ubuntu.com/wsl/releases/24.04/current'
  $file = 'ubuntu-noble-wsl-amd64-wsl.rootfs.tar.gz'
  $tar = Join-Path $installDir $file
  # SHA256SUMS is served without a content type, so PowerShell 5.1 would hand back bytes: save it and read it as text.
  $sumsFile = Join-Path $installDir 'SHA256SUMS'
  Invoke-WebRequest -UseBasicParsing "$base/SHA256SUMS" -OutFile $sumsFile
  $expected = ((Get-Content $sumsFile | Where-Object { $_ -match [regex]::Escape($file) } | Select-Object -First 1) -split '\s+')[0]
  if (-not $expected) { Fail "no checksum for $file in SHA256SUMS" }
  $actual = if (Test-Path $tar) { (Get-FileHash -Algorithm SHA256 $tar).Hash.ToLower() } else { '' }
  if ($actual -ne $expected.ToLower()) {
    Say "Downloading Ubuntu 24.04 WSL rootfs"
    Invoke-WebRequest -UseBasicParsing "$base/$file" -OutFile $tar
    $actual = (Get-FileHash -Algorithm SHA256 $tar).Hash.ToLower()
    if ($actual -ne $expected.ToLower()) { Remove-Item $tar -Force; Fail "rootfs checksum mismatch ($actual vs $expected)" }
  } else { Say 'Reusing the already downloaded rootfs (checksum verified)' }
  Say "Importing WSL distro '$Distro'"
  $r = Invoke-Wsl @('--import', $Distro, (Join-Path $installDir 'wsl'), $tar, '--version', '2') 900
  if ($r.rc -ne 0) {
    if ($r.out -match 'HCS_E_HYPERV_NOT_INSTALLED|Virtual Machine Platform') { Fail "WSL 2 cannot start a VM here: enable virtualisation (Intel VT-x / AMD SVM) in the BIOS/UEFI, reboot, and run a fresh install command. Details: $($r.out.Trim())" }
    Fail "wsl --import failed: $($r.out)"
  }
  Remove-Item $tar -Force
}

# systemd for docker + the agent; no Windows PATH or Windows binaries inside the lane distro.
$wslConf = "[boot]\nsystemd=true\n\n[network]\nhostname=$AgentName-cs\n\n[interop]\nappendWindowsPath=false\n"
$before = (Invoke-Wsl @('-d', $Distro, '-u', 'root', '--', 'cat', '/etc/wsl.conf') 120).out
[void](Invoke-Wsl @('-d', $Distro, '-u', 'root', '--', 'sh', '-c', "printf '$wslConf' > /etc/wsl.conf") 120)
$after = (Invoke-Wsl @('-d', $Distro, '-u', 'root', '--', 'cat', '/etc/wsl.conf') 120).out
$confChanged = ($before -ne $after)

if ($changed -or $confChanged -or -not ((Invoke-Wsl @('-d', $Distro, '-u', 'root', '--', 'ps', '-p', '1', '-o', 'comm=') 120).out -match 'systemd')) {
  Say 'Restarting WSL to apply the settings (this briefly stops every running WSL distro)'
  [void](Invoke-Wsl @('--shutdown') 120)
  Start-Sleep -Seconds 3
  $p1 = (Invoke-Wsl @('-d', $Distro, '-u', 'root', '--', 'ps', '-p', '1', '-o', 'comm=') 180).out
  if ($p1 -notmatch 'systemd') { Fail "systemd did not start in the '$Distro' distro (PID 1: $($p1.Trim()))." }
}

# --- Firewall ------------------------------------------------------------------------------------------------------
# Idempotent: re-runs replace the rules (a leftover rule must never stop the install).
Remove-NetFirewallRule -Name 'computeshare-agent' -ErrorAction SilentlyContinue
New-NetFirewallRule -Name 'computeshare-agent' -DisplayName 'computeshare agent (Tailscale only)' -Direction Inbound -Protocol TCP -LocalPort $Port -InterfaceAlias 'Tailscale' -Action Allow | Out-Null
if ($mirrored -and (Get-Command New-NetFirewallHyperVRule -ErrorAction SilentlyContinue)) {
  $wslCreator = '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}'
  # Hyper-V rules are not always addressable by the -Name they were created with: match ours by display name or port.
  Get-NetFirewallHyperVRule -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -like 'computeshare*' -or $_.Name -like '*computeshare*' -or ("$($_.LocalPorts)" -eq "$Port" -and "$($_.VMCreatorId)" -eq $wslCreator) } |
    ForEach-Object { Remove-NetFirewallHyperVRule -Name $_.Name -ErrorAction SilentlyContinue }
  try {
    New-NetFirewallHyperVRule -Name "computeshare-agent-$Port" -DisplayName 'computeshare agent' -Direction Inbound -VMCreatorId $wslCreator -Protocol TCP -LocalPorts $Port -Action Allow -ErrorAction Stop | Out-Null
  } catch {
    Say "Hyper-V firewall rule not created ($($_.Exception.Message.Trim())); continuing, reachability is checked at the end."
  }
}

# --- Agent inside the distro --------------------------------------------------------------------------------------
$bundleWsl = (Invoke-Wsl @('-d', $Distro, '-u', 'root', '--', 'wslpath', '-a', ($BundlePath -replace '\\', '/')) 60).out.Trim()
$r = Invoke-Wsl @('-d', $Distro, '-u', 'root', '--', 'sh', '-c', "tar -xzf '$bundleWsl' -C /tmp pool/install/install-agent.sh && cp '$bundleWsl' /tmp/computeshare-bundle.tar.gz") 120
if ($r.rc -ne 0) { Fail "could not stage the bundle in the distro: $($r.out)" }
$envs = "ROUTER_URL='$RouterUrl' ENROLL_TOKEN='$EnrollToken' AGENT_NAME='$AgentName' AGENT_URL='http://${tsIp}:$Port' AGENT_PORT='$Port' ALLOW_CPUS='$AllowCpus' ALLOW_MEM_GB='$AllowMemGb' BUNDLE=/tmp/computeshare-bundle.tar.gz"
Say 'Installing Docker, Node and the agent inside the distro (first run builds the lane image; this takes a while)'
& wsl.exe -d $Distro -u root -- bash -c "$envs bash /tmp/pool/install/install-agent.sh"
if ($LASTEXITCODE -ne 0) { Fail 'Linux-side install failed (see output above).' }

# --- Keep-alive task: keeps the distro up, holds off sleep while lanes run, refreshes portproxy on NAT -----------------
$keep = Join-Path $installDir 'keepalive.ps1'
Copy-Item (Join-Path $PSScriptRoot 'keepalive.ps1') $keep -Force
$taskArgs = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$keep`" -Distro $Distro -Port $Port -TailscaleIp $tsIp" + $(if ($mirrored) { ' -Mirrored' } else { '' })
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $taskArgs
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName 'computeshare-keepalive' -Action $action -Trigger $trigger -Settings $settings -Description 'computeshare agent keep-alive' -Force | Out-Null
Start-ScheduledTask -TaskName 'computeshare-keepalive'

Start-Sleep -Seconds 5
try {
  # Windows cannot reach its own Tailscale IP through the mirrored WSL network (no hairpin), so check via loopback;
  # the router reaches the agent on the Tailscale IP.
  $h = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 10
  Say "Agent '$AgentName' is up on http://${tsIp}:$Port : $($h.cpus_total) CPUs / $($h.mem_total_gb) GB reserved for lanes."
} catch {
  Say "Installed, but http://${tsIp}:$Port/health is not answering yet. Check: wsl -d $Distro -u root -- journalctl -u computeshare-agent -n 50"
}
