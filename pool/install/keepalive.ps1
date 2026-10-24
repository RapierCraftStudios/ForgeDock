# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
# Runs at logon (scheduled task). Keeps the computeshare distro running, keeps Windows awake while lanes are active,
# and on NAT networking keeps a portproxy from the Tailscale IP to the distro's current address.
param([string] $Distro = 'computeshare', [int] $Port = 7711, [string] $TailscaleIp, [switch] $Mirrored)
$ErrorActionPreference = 'Continue'
$env:WSL_UTF8 = '1'

Add-Type -Namespace CS -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);'
$ES_CONTINUOUS = [uint32]'0x80000000'; $ES_SYSTEM_REQUIRED = [uint32]'0x00000001'

$holder = $null
while ($true) {
  if (-not $holder -or $holder.HasExited) {
    # A long-lived process keeps the distro (and its systemd services) from being stopped by WSL.
    $holder = Start-Process -FilePath 'wsl.exe' -ArgumentList @('-d', $Distro, '-u', 'root', '--', 'sleep', 'infinity') -WindowStyle Hidden -PassThru
    Start-Sleep -Seconds 5
  }
  if (-not $Mirrored -and $TailscaleIp) {
    $wslIp = ((& wsl.exe -d $Distro -u root -- hostname -I) -split '\s+' | Where-Object { $_ -match '^\d+\.' } | Select-Object -First 1)
    if ($wslIp) {
      $cur = (netsh interface portproxy show v4tov4) -match [regex]::Escape("$TailscaleIp") -match "$Port"
      if (-not ($cur -match [regex]::Escape($wslIp))) {
        netsh interface portproxy delete v4tov4 listenaddress=$TailscaleIp listenport=$Port | Out-Null
        netsh interface portproxy add v4tov4 listenaddress=$TailscaleIp listenport=$Port connectaddress=$wslIp connectport=$Port | Out-Null
      }
    }
  }
  $active = 0
  try { $active = [int](Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 5).active } catch {
    if ($TailscaleIp) { try { $active = [int](Invoke-RestMethod -Uri "http://${TailscaleIp}:$Port/health" -TimeoutSec 5).active } catch {} }
  }
  if ($active -gt 0) { [void][CS.Power]::SetThreadExecutionState($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED) }
  else { [void][CS.Power]::SetThreadExecutionState($ES_CONTINUOUS) }
  Start-Sleep -Seconds 60
}
