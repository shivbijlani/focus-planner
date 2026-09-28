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

  BROWSER-CHECK WORKLOAD (GH #698): the tray is also the ONE resident dispatcher
  for browser checks. It is an INDEPENDENT workload with its own policy
  (`## Tray browser checks` in user-settings.md), its own schedule, its own
  in-memory pause, its own state file and its own lock; it shares no M/N state,
  cooldown or action lock with reliability. It runs consumer-browser-watchdog.mjs
  as an ASYNCHRONOUS child so a slow browser probe never delays reliability. It
  is COMPLETELY OFF by default - including observation - and Observe, Thaw and
  Auto-launch are separate opt-ins; enabling checks never launches a closed
  browser slot unless Auto-launch is explicitly on. The tray never kills or
  reparents a browser or MCP worker process.

.PARAMETER IntervalMinutes
  Maximum minutes between evaluations (default 15). The tray wakes earlier when
  the checker reports a sooner M/N or cooldown boundary.

.PARAMETER NoAct
  Pass --no-act to the reliability checker (classify and log only, never restart
  or launch) and --report-only to the browser workload (it can then only observe,
  and only if the user enabled browser checks at all).

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
$browserConsumerScript = if (Test-Path $files.browserConsumer) { $files.browserConsumer } else { Join-Path $PSScriptRoot 'consumer-browser-watchdog.mjs' }
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

# The browser workload's OWN state. Separate object, separate pause, separate
# schedule: nothing here is read or written by the reliability workload.
$browser = [ordered]@{
  paused = $false; state = 'STARTING'; summary = 'reading browser-check policy'; error = $null
  lastCheckUtc = $null; nextEvaluationAt = (Get-Date).ToUniversalTime()
  process = $null; outFile = $null; errFile = $null; startedUtc = $null
  recent = @(); settingsPath = $null
}

function Write-Heartbeat {
  $now = (Get-Date).ToUniversalTime()
  try {
    [ordered]@{
      pid = $PID; lastCheckUtc = $(if ($tray.lastCheckUtc) { $tray.lastCheckUtc.ToString('o') })
      lastState = $tray.state; paused = $tray.paused; intervalMinutes = $IntervalMinutes
      nextEvaluationAt = $tray.nextEvaluationAt.ToString('o'); evaluating = $tray.evaluating
      error = $tray.error
      browser = [ordered]@{
        state = $browser.state; summary = $browser.summary; paused = $browser.paused
        running = [bool]$browser.process; error = $browser.error
        lastCheckUtc = $(if ($browser.lastCheckUtc) { $browser.lastCheckUtc.ToString('o') })
        nextEvaluationAt = $browser.nextEvaluationAt.ToString('o'); recent = @($browser.recent)
      }
    } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $files.heartbeat -Encoding utf8
  } catch { $tray.error = "heartbeat failed: $_" }
}

function Start-BrowserCheck {
  if ($browser.process) { return }
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) {
    $browser.state = 'CHECK-FAILED'; $browser.error = 'node not found on PATH'
    $browser.summary = 'cannot run: node not found on PATH'
    $browser.nextEvaluationAt = (Get-Date).ToUniversalTime().AddMinutes(15)
    return
  }
  $browser.outFile = [IO.Path]::GetTempFileName()
  $browser.errFile = [IO.Path]::GetTempFileName()
  $nodeArgs = @("`"$browserConsumerScript`"")
  if ($NoAct) { $nodeArgs += '--report-only' }
  try {
    $browser.process = Start-Process -FilePath $node.Source -ArgumentList $nodeArgs -NoNewWindow -PassThru `
      -RedirectStandardOutput $browser.outFile -RedirectStandardError $browser.errFile
    # Opened now so ExitCode stays readable under Windows PowerShell 5.1.
    $null = $browser.process.Handle
    $browser.startedUtc = (Get-Date).ToUniversalTime()
  } catch {
    $browser.process = $null
    $browser.state = 'CHECK-FAILED'; $browser.error = "$_"; $browser.summary = "cannot start: $_"
    $browser.nextEvaluationAt = (Get-Date).ToUniversalTime().AddMinutes(15)
  }
  Write-Heartbeat
}

# Non-blocking: returns $true only when a running browser check just finished.
function Complete-BrowserCheck {
  if (-not $browser.process -or -not $browser.process.HasExited) { return $false }
  $default = (Get-Date).ToUniversalTime().AddMinutes(15)
  try {
    $output = Get-Content -LiteralPath $browser.outFile -Raw -ErrorAction SilentlyContinue
    $line = (([string]$output) -split "`n" | Where-Object { $_.Trim().StartsWith('{') } | Select-Object -Last 1)
    if (-not $line) {
      $stderr = Get-Content -LiteralPath $browser.errFile -Raw -ErrorAction SilentlyContinue
      throw "browser workload returned no JSON result (exit $($browser.process.ExitCode)): $(([string]$stderr).Trim())"
    }
    $result = $line | ConvertFrom-Json
    $view = ConvertFrom-OaBrowserResult $result
    $browser.state = $view.state; $browser.summary = $view.summary; $browser.error = $view.error
    if ($view.recent.Count) { $browser.recent = $view.recent }
    if ($view.settingsPath) { $browser.settingsPath = $view.settingsPath }
    $next = $default
    if ($result.nextEvaluationAt) {
      try {
        $next = [datetime]::Parse([string]$result.nextEvaluationAt, $null,
          [System.Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
      } catch { }
    }
    $browser.nextEvaluationAt = $next
  } catch {
    $browser.state = 'CHECK-FAILED'; $browser.error = "$_"; $browser.summary = "check failed: $_"
    $browser.nextEvaluationAt = $default
  } finally {
    Remove-Item -LiteralPath $browser.outFile, $browser.errFile -Force -ErrorAction SilentlyContinue
    $browser.process.Dispose()
    $browser.process = $null
    $browser.lastCheckUtc = (Get-Date).ToUniversalTime()
    Write-Heartbeat
  }
  return $true
}

# One scheduler step for the browser workload; safe to call every tick.
function Step-BrowserWorkload {
  param([switch]$Force)
  $changed = Complete-BrowserCheck
  $now = (Get-Date).ToUniversalTime()
  if (-not $browser.paused -and -not $browser.process -and ($Force -or $now -ge $browser.nextEvaluationAt)) {
    Start-BrowserCheck
    $changed = $true
  }
  return $changed
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
  # A 1s step, so the two workloads keep their own schedules and a stop request
  # is noticed promptly.
  try {
    while (-not (Test-StopRequested)) {
      if (-not $tray.paused -and (Get-Date).ToUniversalTime() -ge $tray.nextEvaluationAt) { Invoke-ReliabilityCheck }
      $null = Step-BrowserWorkload
      Start-Sleep -Milliseconds 1000
    }
  } finally {
    $lockHandle.Dispose()
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
$checkNowItem = $menu.Items.Add('Check reliability now')
$pauseItem = $menu.Items.Add('Pause reliability')
[void]$menu.Items.Add('-')
# Browser checks: a separate workload with its own controls. Its policy lives
# in `## Tray browser checks` in user-settings.md; the tray only shows it.
$browserMenu = New-Object System.Windows.Forms.ToolStripMenuItem('Browser checks')
$browserStatusItem = New-Object System.Windows.Forms.ToolStripMenuItem('Status: starting')
$browserStatusItem.Enabled = $false
$browserRecentItem = New-Object System.Windows.Forms.ToolStripMenuItem('Recent outcomes')
$browserCheckNowItem = New-Object System.Windows.Forms.ToolStripMenuItem('Check browsers now')
$browserPauseItem = New-Object System.Windows.Forms.ToolStripMenuItem('Pause browser checks')
$browserSettingsItem = New-Object System.Windows.Forms.ToolStripMenuItem('Open user-settings.md')
[void]$browserMenu.DropDownItems.Add($browserStatusItem)
[void]$browserMenu.DropDownItems.Add($browserRecentItem)
[void]$browserMenu.DropDownItems.Add('-')
[void]$browserMenu.DropDownItems.Add($browserCheckNowItem)
[void]$browserMenu.DropDownItems.Add($browserPauseItem)
[void]$browserMenu.DropDownItems.Add($browserSettingsItem)
[void]$menu.Items.Add($browserMenu)
[void]$menu.Items.Add('-')
$startupItem = $menu.Items.Add('Start with Windows')
$startupItem.CheckOnClick = $true
$startupItem.Checked = (Get-OaTrayStartup).enabled
[void]$menu.Items.Add('-')
$exitItem = $menu.Items.Add('Exit')
$icon.ContextMenuStrip = $menu

function Limit-Text([string]$Text, [int]$Max) {
  if ($Text.Length -le $Max) { return $Text }
  return $Text.Substring(0, $Max - 3) + '...'
}

function Update-TrayIcon {
  $status = if ($tray.paused) { 'paused' } else { $tray.state.ToLowerInvariant() }
  $browserStatus = if ($browser.paused) { 'paused' } elseif ($browser.process) { 'checking' } else { $browser.state.ToLowerInvariant() }
  # NotifyIcon.Text is limited to 63 characters.
  $icon.Text = Limit-Text ("OA reliability: {0} (next {1:HH:mm}); browser: {2}" -f $status,
    $tray.nextEvaluationAt.ToLocalTime(), $browserStatus) 63
  $pauseItem.Text = if ($tray.paused) { 'Resume reliability' } else { 'Pause reliability' }
  $browserPauseItem.Text = if ($browser.paused) { 'Resume browser checks' } else { 'Pause browser checks' }
  $browserCheckNowItem.Enabled = (-not $browser.paused) -and (-not $browser.process)
  $browserStatusItem.Text = Limit-Text ("Status: {0}{1}" -f $(if ($browser.paused) { 'PAUSED - ' } else { '' }), $browser.summary) 120
  $browserRecentItem.DropDownItems.Clear()
  if ($browser.recent.Count) {
    foreach ($line in $browser.recent) {
      $entry = New-Object System.Windows.Forms.ToolStripMenuItem((Limit-Text $line 120))
      $entry.Enabled = $false
      [void]$browserRecentItem.DropDownItems.Add($entry)
    }
  } else {
    $none = New-Object System.Windows.Forms.ToolStripMenuItem('(no browser checks have run)')
    $none.Enabled = $false
    [void]$browserRecentItem.DropDownItems.Add($none)
  }
  $browserSettingsItem.Enabled = [bool]($browser.settingsPath -and (Test-Path -LiteralPath $browser.settingsPath))
}

$checkNowItem.add_Click({ if (-not $tray.paused) { Invoke-ReliabilityCheck }; Update-TrayIcon })
$pauseItem.add_Click({ $tray.paused = -not $tray.paused; Write-Heartbeat; Update-TrayIcon })
$browserCheckNowItem.add_Click({ $null = Step-BrowserWorkload -Force; Update-TrayIcon })
# In-memory only, like the reliability pause: a tray restart always clears it.
$browserPauseItem.add_Click({ $browser.paused = -not $browser.paused; Write-Heartbeat; Update-TrayIcon })
$browserSettingsItem.add_Click({
  if ($browser.settingsPath -and (Test-Path -LiteralPath $browser.settingsPath)) {
    Start-Process -FilePath $browser.settingsPath
  }
})
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
  if (Step-BrowserWorkload) { Update-TrayIcon }
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