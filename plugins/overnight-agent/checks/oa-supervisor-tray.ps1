<#
.SYNOPSIS
  Optional Windows tray app that owns the overnight-agent reliability supervisor's
  M/N preventive-restart scheduler (GH #695). Off by default; enabled only by an
  explicit user action (see install-oa-supervisor.ps1 -Enable).

.DESCRIPTION
  WHAT IT DOES
    * Runs out of process from both the desktop app it supervises and the
      overnight agent. It calls consumer-reliability-supervisor.mjs as a CHILD
      process on every evaluation, so a checker crash cannot take the tray down
      and the schedule does not depend on anything it supervises being healthy.
    * Evaluates at most every -IntervalMinutes (default 15), but wakes early at
      the M (quiet-opportunity, default 3h), N (hard-deadline, default 4h) and
      cooldown (default 60m) boundaries the checker reports for the next cycle.
    * Shows status and controls in the notification area: last state, next
      evaluation, Check now, Pause/Resume, Start with Windows, Exit.

  WHAT IT DOES NOT DO
    * It never restarts anything itself. Every restart decision, the exclusive
      action lock, the graceful-then-bounded-force sequence, process identity
      checks and the durable audit trail stay in reliability-supervisor.mjs /
      windows-app-actuator.mjs, run inside the child process.
    * It does not run while the user is signed out: it is a per-user app started
      at sign-in by the single HKCU Run entry (see oa-supervisor-startup.ps1).
      While signed out, nothing is supervised; the app it supervises also only
      runs signed in.
    * Pausing here is a TRAY-LIFETIME-ONLY control: it is never written to disk,
      so an Exit or restart of the tray always resumes normal supervision - there
      is no way to leave the checker permanently paused by accident.
    * It does not touch the plugin's own update/deploy lifecycle. Updating this
      plugin (and deciding when a new tray build is deployed) stays with the
      overnight agent / GHCP plugin installer; the tray only supervises whatever
      copy of the checker is already deployed to its own home directory.

  ONE ACTIVE SUPERVISOR: a second tray (or a stale lock from a crashed one) makes
  a new instance exit immediately rather than compete for the same checks.

.PARAMETER IntervalMinutes
  Maximum minutes between evaluations (default 15). The tray wakes earlier when
  the checker reports a sooner M/N or cooldown boundary.

.PARAMETER NoAct
  Pass --no-act to the checker: classify and log only, never restart or launch.

.PARAMETER NoTrayIcon
  Diagnostic/test mode: run the same scheduler loop without creating a
  notification icon, so it can be exercised on a machine/session without a
  desktop (e.g. CI).
#>
[CmdletBinding()]
param(
  [ValidateRange(1, 1440)][int]$IntervalMinutes = 15,
  [switch]$NoAct,
  [switch]$NoTrayIcon
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'oa-supervisor-startup.ps1')

$files = Get-OaSupervisorFiles
if (-not (Test-Path $files.home)) { New-Item -ItemType Directory -Path $files.home -Force | Out-Null }

$consumerScript = if (Test-Path $files.consumer) { $files.consumer } else { Join-Path $PSScriptRoot 'consumer-reliability-supervisor.mjs' }
$startedUtc = (Get-Process -Id $PID).StartTime.ToUniversalTime()

try {
  $lockHandle = [IO.File]::Open($files.lock, [IO.FileMode]::OpenOrCreate,
    [IO.FileAccess]::ReadWrite, [IO.FileShare]::Read)
} catch [IO.IOException] {
  Write-Host '[oa-tray] another supervisor tray owns the lock - exiting.'
  exit 0
}
$record = @{ pid = $PID; startedUtc = $startedUtc.ToString('o') } | ConvertTo-Json
$bytes = (New-Object Text.UTF8Encoding($false)).GetBytes($record)
$lockHandle.SetLength(0)
$lockHandle.Write($bytes, 0, $bytes.Length)
$lockHandle.Flush($true)
Remove-Item -LiteralPath $files.stopRequest -Force -ErrorAction SilentlyContinue

# In-memory only, by design: pausing the tray must never outlive this process, so
# a crash or an intentional restart always comes back supervising (GH #695).
$tray = [ordered]@{
  paused = $false; state = 'STARTING'; error = $null; lastCheckUtc = $null
  nextEvaluationAt = (Get-Date).ToUniversalTime(); evaluating = $false
}

function Write-Heartbeat {
  $now = (Get-Date).ToUniversalTime()
  try {
    [ordered]@{
      pid = $PID; lastCheckUtc = $(if ($tray.lastCheckUtc) { $tray.lastCheckUtc.ToString('o') })
      lastState = $tray.state; paused = $tray.paused; intervalMinutes = $IntervalMinutes
      nextEvaluationAt = $tray.nextEvaluationAt.ToString('o'); evaluating = $tray.evaluating
      error = $tray.error
    } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $files.heartbeat -Encoding utf8
  } catch { $tray.error = "heartbeat failed: $_" }
}

function Invoke-ReliabilityCheck {
  $tray.evaluating = $true
  Write-Heartbeat
  $default = (Get-Date).ToUniversalTime().AddMinutes($IntervalMinutes)
  try {
    $nodeArgs = @($consumerScript)
    if ($NoAct) { $nodeArgs += '--no-act' }
    $output = & node @nodeArgs 2>&1 | Out-String
    $exitCode = $LASTEXITCODE
    $line = ($output -split "`n" | Where-Object { $_.Trim().StartsWith('{') } | Select-Object -Last 1)
    if (-not $line) { throw "checker returned no JSON result (exit $exitCode): $($output.Trim())" }
    $result = $line | ConvertFrom-Json
    $tray.state = [string]$result.status
    $tray.error = $(if ($result.status -eq 'failed') { [string]$result.error } else { $null })
    $next = $default
    if ($result.nextEvaluationAt) {
      try {
        $candidate = [datetime]::Parse([string]$result.nextEvaluationAt, $null,
          [System.Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
        if ($candidate -lt $next) { $next = $candidate }
      } catch { }
    }
    $tray.nextEvaluationAt = $next
  } catch {
    $tray.state = 'CHECK-FAILED'
    $tray.error = "$_"
    $tray.nextEvaluationAt = $default
  } finally {
    $tray.lastCheckUtc = (Get-Date).ToUniversalTime()
    $tray.evaluating = $false
    Write-Heartbeat
  }
}

function Test-StopRequested {
  if (-not (Test-Path -LiteralPath $files.stopRequest)) { return $false }
  try {
    $request = Get-Content -LiteralPath $files.stopRequest -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    return ([int]$request.pid -eq $PID)
  } catch { return $false }
}

if ($NoTrayIcon) {
  # Headless loop for diagnostics/CI: same evaluation logic, no notification icon.
  try {
    while (-not (Test-StopRequested)) {
      if (-not $tray.paused) { Invoke-ReliabilityCheck }
      $sleepMs = [Math]::Max(1000, [Math]::Min(
        ($tray.nextEvaluationAt - (Get-Date).ToUniversalTime()).TotalMilliseconds,
        $IntervalMinutes * 60000))
      Start-Sleep -Milliseconds $sleepMs
    }
  } finally {
    Remove-Item -LiteralPath $files.lock -Force -ErrorAction SilentlyContinue
  }
  exit 0
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$icon = New-Object System.Windows.Forms.NotifyIcon
$icon.Icon = [System.Drawing.SystemIcons]::Application
$icon.Visible = $true
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$checkNowItem = $menu.Items.Add('Check now')
$pauseItem = $menu.Items.Add('Pause')
$startupItem = $menu.Items.Add('Start with Windows')
$startupItem.CheckOnClick = $true
$startupItem.Checked = (Get-OaTrayStartup).enabled
[void]$menu.Items.Add('-')
$exitItem = $menu.Items.Add('Exit')
$icon.ContextMenuStrip = $menu

function Update-TrayIcon {
  $status = if ($tray.paused) { 'paused' } else { $tray.state.ToLowerInvariant() }
  $icon.Text = ("Overnight Agent reliability: {0} (next {1:HH:mm})" -f $status,
    $tray.nextEvaluationAt.ToLocalTime()).Substring(0, [Math]::Min(127, 60))
  $pauseItem.Text = if ($tray.paused) { 'Resume' } else { 'Pause' }
}

$checkNowItem.add_Click({ if (-not $tray.paused) { Invoke-ReliabilityCheck }; Update-TrayIcon })
$pauseItem.add_Click({ $tray.paused = -not $tray.paused; Write-Heartbeat; Update-TrayIcon })
$startupItem.add_Click({
  try {
    if ($startupItem.Checked) {
      $cmd = Get-OaTrayCommandLine -TrayPath $files.tray -IntervalMinutes $IntervalMinutes -NoAct:$NoAct
      Enable-OaTrayStartup -CommandLine $cmd
    } else {
      Disable-OaTrayStartup
    }
  } catch { $tray.error = "$_"; $startupItem.Checked = (Get-OaTrayStartup).enabled }
})

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 1000
$timer.add_Tick({
  if (Test-StopRequested) { $exitItem.PerformClick(); return }
  $now = (Get-Date).ToUniversalTime()
  if (-not $tray.paused -and -not $tray.evaluating -and $now -ge $tray.nextEvaluationAt) {
    Invoke-ReliabilityCheck
    Update-TrayIcon
  }
})
$timer.Start()

$exitItem.add_Click({
  $timer.Stop()
  $icon.Visible = $false
  [System.Windows.Forms.Application]::ExitThread()
})

Update-TrayIcon
Write-Heartbeat
try {
  [System.Windows.Forms.Application]::Run()
} finally {
  $icon.Dispose()
  $lockHandle.Dispose()
  Remove-Item -LiteralPath $files.lock -Force -ErrorAction SilentlyContinue
}
