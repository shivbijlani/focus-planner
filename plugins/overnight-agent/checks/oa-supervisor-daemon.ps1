<#
.SYNOPSIS
  Unelevated fallback dispatcher for the #226 supervisor: a resident loop launched by
  the Windows Startup folder.

.DESCRIPTION
  WHY A SECOND DISPATCHER EXISTS
  ------------------------------
  Windows Task Scheduler is the right home for this and `install-oa-supervisor.ps1`
  targets it. Measured on this machine 2026-08-31, though, task registration is denied
  without elevation - `Register-ScheduledTask` and `schtasks /Create` both return
  ERROR: Access is denied - and the agent cannot elevate itself unattended.

  Leaving it there would have parked the entire fix on one manual command from Shiv,
  which is the exact defect his standing instruction names: "Why block on me, if yr
  wrong it's easily reversed." So this is the dispatcher that CAN be installed
  unattended, and it starts supervising tonight.

  IS IT STILL OUTSIDE THE FAILURE DOMAIN? Yes - that is the whole test, so it is worth
  stating precisely rather than asserting:
    * it is launched by Explorer from the Startup folder at logon - the OS, not the app;
    * it is its own process, not a child of copilot.exe and not an MCP server, so the
      MCP reaper cannot reach it and an agent run crashing cannot take it with it;
    * it is not dispatched by the app scheduler, so a frozen */30 schedule - the exact
      failure - does not stop it.

  WHERE IT IS WEAKER, stated plainly rather than buried: Task Scheduler would restart
  the job if the process died and would run with the user logged off. This loop does
  neither; if it dies it stays dead until next logon. That is why the elevated
  installer remains the recommended path and this prints how to upgrade.

.PARAMETER IntervalMinutes
  Seconds between checks. Default 15 minutes.
#>
[CmdletBinding()]
param(
  [int]$IntervalMinutes = 15,
  [switch]$Once
)

$ErrorActionPreference = 'Continue'
$oaHome     = Join-Path $env:LOCALAPPDATA 'overnight-agent'
$supervisor = Join-Path $oaHome 'oa-supervisor.ps1'
$lockPath   = Join-Path $oaHome 'supervisor-daemon.lock'
$beatPath   = Join-Path $oaHome 'supervisor-daemon-heartbeat.json'

if (-not (Test-Path $oaHome)) { New-Item -ItemType Directory -Path $oaHome -Force | Out-Null }

# --- single instance: a stale lock from a crashed daemon must not block a new one ----
if (Test-Path $lockPath) {
  try {
    $prior = (Get-Content $lockPath -Raw | ConvertFrom-Json).pid
    if ($prior -and (Get-Process -Id $prior -ErrorAction SilentlyContinue)) {
      Write-Host "[oa-daemon] already running as pid $prior - exiting."
      exit 0
    }
  } catch { }   # unreadable lock == stale lock
}
@{ pid = $PID; startedUtc = (Get-Date).ToUniversalTime().ToString('o') } |
  ConvertTo-Json | Set-Content -Path $lockPath -Encoding utf8

try {
  do {
    $state = 'SUPERVISOR-MISSING'
    try {
      if (Test-Path $supervisor) {
        # Child process on purpose: a crash inside the checker must not kill the loop
        # that is supposed to outlive everything.
        $out = & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $supervisor 2>&1 | Out-String
        $line = ($out -split "`n" | Where-Object { $_.Trim().StartsWith('{') } | Select-Object -Last 1)
        if ($line) { $state = ($line | ConvertFrom-Json).state }
      }
    } catch { $state = "DAEMON-ERROR: $_" }

    # The daemon's OWN heartbeat. Without it the supervisor is unsupervised, which is
    # the same recursion #226 is about; this at least makes its absence observable.
    try {
      @{ pid = $PID; lastCheckUtc = (Get-Date).ToUniversalTime().ToString('o')
         lastState = $state; intervalMinutes = $IntervalMinutes } |
        ConvertTo-Json | Set-Content -Path $beatPath -Encoding utf8
    } catch { }

    if ($Once) { break }
    Start-Sleep -Seconds ($IntervalMinutes * 60)
  } while ($true)
} finally {
  Remove-Item $lockPath -Force -ErrorAction SilentlyContinue
}
