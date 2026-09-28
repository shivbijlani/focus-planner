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
  Maximum minutes between checks (default 15); the supervisor also wakes at
  M/N boundaries and cooldown expiry, with a heartbeat every 15 seconds.
#>
[CmdletBinding()]
param(
  [int]$IntervalMinutes = 15,
  [switch]$Once,
  [switch]$NoAct
)

$ErrorActionPreference = 'Continue'
$oaHome     = Join-Path $env:LOCALAPPDATA 'overnight-agent'
$supervisor = Join-Path $oaHome 'oa-supervisor.ps1'
$lockPath   = Join-Path $oaHome 'supervisor-daemon.lock'
$beatPath   = Join-Path $oaHome 'supervisor-daemon-heartbeat.json'

if (-not (Test-Path $oaHome)) { New-Item -ItemType Directory -Path $oaHome -Force | Out-Null }

# Holding the file open denies a second writer even if a PID is reused; a stale
# file from a crashed daemon is reclaimable as soon as its handle is closed.
try {
  $lockHandle = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate,
    [IO.FileAccess]::ReadWrite, [IO.FileShare]::Read)
} catch [IO.IOException] {
  Write-Host '[oa-daemon] another supervisor owns the daemon lock - exiting.'
  exit 0
}
try {
  $record = @{ pid = $PID; startedUtc = (Get-Date).ToUniversalTime().ToString('o') } |
    ConvertTo-Json
  $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes($record)
  $lockHandle.SetLength(0)
  $lockHandle.Write($bytes, 0, $bytes.Length)
  $lockHandle.Flush($true)
} catch {
  $lockHandle.Dispose()
  throw
}

try {
  do {
    $state = 'SUPERVISOR-MISSING'
    $nextEvaluationAt = (Get-Date).ToUniversalTime().AddMinutes($IntervalMinutes)
    $overdue = $null
    try {
      if (Test-Path $supervisor) {
        # Child process on purpose: a crash inside the checker must not kill the loop
        # that is supposed to outlive everything.
        $args = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $supervisor)
        if ($NoAct) { $args += '-NoAct' }
        $out = & powershell.exe @args 2>&1 | Out-String
        $line = ($out -split "`n" | Where-Object { $_.Trim().StartsWith('{') } | Select-Object -Last 1)
        if ($line) {
          $result = $line | ConvertFrom-Json
          $state = $result.state
          $overdue = $result.actResult.overdue
          $candidate = $result.actResult.nextEvaluationAt
          if ($candidate) {
            $date = [datetime]::Parse($candidate, $null,
              [System.Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
            if ($date -lt $nextEvaluationAt) { $nextEvaluationAt = $date }
          }
        }
      }
    } catch { $state = "DAEMON-ERROR: $_" }

    if ($Once) { break }
    do {
      $now = (Get-Date).ToUniversalTime()
      try {
        @{ pid = $PID; lastCheckUtc = $now.ToString('o')
           lastState = $state; intervalMinutes = $IntervalMinutes
           nextEvaluationAt = $nextEvaluationAt.ToString('o'); overdue = $overdue } |
          ConvertTo-Json | Set-Content -Path $beatPath -Encoding utf8
      } catch { Write-Error "supervisor heartbeat failed: $_" }
      $remainingMs = ($nextEvaluationAt - $now).TotalMilliseconds
      if ($remainingMs -gt 0) { Start-Sleep -Milliseconds ([int][math]::Min(15000, $remainingMs)) }
    } while ($remainingMs -gt 0)
  } while ($true)
} finally {
  $lockHandle.Dispose()
  Remove-Item $lockPath -Force -ErrorAction SilentlyContinue
}
