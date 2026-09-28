<#
.SYNOPSIS
  RETIRED (GH #689). The legacy Scheduled Task / Startup-folder daemon for the
  reliability supervisor. It now exits immediately and never supervises.

.DESCRIPTION
  The supervisor's scheduler moved into the optional tray app, oa-supervisor-tray.ps1,
  which starts through exactly one route (a per-user HKCU Run entry) and only after an
  explicit opt-in: install-oa-supervisor.ps1 -Enable, or "Start with Windows" in the tray.

  This file is kept, and kept in sync-oa-home's required set, on purpose: an older
  install may still have a Scheduled Task or a Startup-folder shim that launches
  %LOCALAPPDATA%\overnight-agent\oa-supervisor-daemon.ps1. Refreshing that copy with
  this stub makes those leftovers inert, so an upgrade can never end up with a legacy
  daemon supervising next to the tray. The leftover entry is reported by the tray, by
  install-oa-supervisor.ps1 and by supervisor-liveness-sweep.ps1 (verdict LEGACY), and
  install-oa-supervisor.ps1 -Enable / -Disable removes it.
#>
[CmdletBinding()]
param(
  [int]$IntervalMinutes = 15,
  [switch]$Once,
  [switch]$NoAct
)

$oaHome = if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'overnight-agent' } else { $null }
if ($oaHome -and (Test-Path $oaHome)) {
  try {
    @{ ts = (Get-Date).ToUniversalTime().ToString('o'); state = 'LEGACY-DAEMON-RETIRED'
       detail = 'legacy scheduled task/Startup shim launched the retired daemon; use install-oa-supervisor.ps1 -Enable (tray app) or -Disable' } |
      ConvertTo-Json -Compress | Add-Content -Path (Join-Path $oaHome 'supervisor-log.jsonl') -Encoding utf8
  } catch { }
}
Write-Host '[oa-daemon] retired: the reliability supervisor now runs as the optional tray app (install-oa-supervisor.ps1 -Enable).'
exit 0
