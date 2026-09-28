<#
.SYNOPSIS
  Optional Windows tray app that owns the Overnight Agent reliability supervisor's
  M/N scheduler (GH #689). Off by default; enabled only by an explicit user action.

.DESCRIPTION
  WHAT IT DOES
    * Runs out of process from the Overnight Agent and the desktop app. It calls
      oa-supervisor.ps1 (and through it consumer-reliability-supervisor.mjs) as a CHILD
      process, so a checker crash or a hung agent cannot take the tray down, and the
      scheduler does not depend on the overnight agent being healthy.
    * Evaluates at most every -IntervalMinutes (default 15), but wakes early at the
      supervisor's quiet-opportunity (M, default 3h), hard-deadline (N, default 4h) and
      cooldown (default 60m) boundaries reported by the checker.
    * Shows status and controls in the notification area: policy, cycle boundaries,
      cooldown, recent outcomes, Check now, Pause/Resume, Start with Windows, Exit.

  WHAT IT DOES NOT DO
    * It never restarts anything itself. Every restart decision, the action lock, the
      graceful-then-bounded-force sequence, process identity checks, durable audit and
      the anti-loop cooldown stay in reliability-supervisor.mjs.
    * It does not run while you are signed out: it is a per-user app started at sign-in
      by the single HKCU Run entry (see oa-supervisor-startup.ps1). While signed out,
      nothing is supervised. The desktop app it supervises also only runs signed in.

  ONE ACTIVE SUPERVISOR: it takes the same exclusive lock as the retired legacy daemon,
  so a second tray or a still-running legacy daemon makes this instance exit.

.PARAMETER IntervalMinutes
  Maximum minutes between evaluations (default 15).

.PARAMETER NoAct
  Pass -NoAct to the checker: classify and log only, never restart or launch.

.PARAMETER NoTrayIcon
  Diagnostic/test mode: run the same scheduler without a notification icon.
#>
[CmdletBinding()]
param(
  [ValidateRange(1, 1440)][int]$IntervalMinutes = 15,
  [ValidateRange(1, 3600)][int]$EvaluationTimeoutSeconds = 900,
  [switch]$NoAct,
  [switch]$NoTrayIcon
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'oa-supervisor-startup.ps1')
. (Join-Path $PSScriptRoot 'oa-supervisor-components.ps1')

$files = Get-OaSupervisorFiles
$oaHome = $files.home
if (-not (Test-Path $oaHome)) { New-Item -ItemType Directory -Path $oaHome -Force | Out-Null }
$components = @(Get-OaSupervisorComponents -OaHome $oaHome -IntervalMinutes $IntervalMinutes -NoAct:$NoAct)
$componentStates = @{}
foreach ($component in $components) {
  $componentStates[$component.name] = New-OaComponentState -Enabled ($component.name -eq 'oa-supervisor')
}
$statusScript = Join-Path $oaHome 'consumer-reliability-supervisor.mjs'
if (-not (Test-Path $statusScript)) { $statusScript = Join-Path $PSScriptRoot 'consumer-reliability-supervisor.mjs' }
$psExe = (Get-Process -Id $PID).Path
$trayPath = if (Test-Path $files.tray) { $files.tray } else { $PSCommandPath }
$startedUtc = (Get-Process -Id $PID).StartTime.ToUniversalTime()

try {
  $lockHandle = [IO.File]::Open($files.lock, [IO.FileMode]::OpenOrCreate,
    [IO.FileAccess]::ReadWrite, [IO.FileShare]::Read)
} catch [IO.IOException] {
  Write-Host '[oa-tray] another supervisor owns the lock - exiting.'
  exit 0
}
$record = @{ pid = $PID; startedUtc = $startedUtc.ToString('o'); kind = 'tray' } | ConvertTo-Json
$bytes = (New-Object Text.UTF8Encoding($false)).GetBytes($record)
$lockHandle.SetLength(0)
$lockHandle.Write($bytes, 0, $bytes.Length)
$lockHandle.Flush($true)
Remove-Item -LiteralPath $files.stopRequest -Force -ErrorAction SilentlyContinue

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$tray = [ordered]@{
  paused = $false; state = 'STARTING'
  statusProc = $null; statusOut = $null; status = $null; statusRefreshAt = (Get-Date).ToUniversalTime()
  statusStartedUtc = $null; lastBeatUtc = [datetime]::MinValue; error = $null; legacy = $null
}
if (Test-Path $files.trayState) {
  try {
    $saved = Get-Content $files.trayState -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    $tray.paused = [bool]$saved.paused
    $browser = $componentStates['browser-watchdog']
    $browser.enabled = [bool]$saved.browserEnabled
    $browser.paused = [bool]$saved.browserPaused
    if ($saved.browserRecent) { $browser.recent = @($saved.browserRecent | Select-Object -Last 5) }
    if ($browser.enabled) { $browser.state = 'STARTING' }
  } catch {
    $tray.paused = $true
    $componentStates['browser-watchdog'].enabled = $false
    $tray.error = "Invalid saved tray state; paused for safety: $_"
  }
}

function Save-TrayState {
  try {
    $browser = $componentStates['browser-watchdog']
    @{ paused = $tray.paused; updatedUtc = (Get-Date).ToUniversalTime().ToString('o')
       browserEnabled = $browser.enabled; browserPaused = $browser.paused; browserRecent = @($browser.recent) } |
      ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $files.trayState -Encoding utf8 -ErrorAction Stop
    return $true
  } catch { $tray.error = "could not save tray state: $_"; return $false }
}

function Write-Heartbeat {
  $now = (Get-Date).ToUniversalTime()
  try {
    $states = @{}
    foreach ($component in $components) {
      $s = $componentStates[$component.name]
      $states[$component.name] = [ordered]@{
        state = $s.state; error = $s.error; lastExitCode = $s.lastExitCode
        enabled = $s.enabled; paused = $s.paused
        lastEvaluationUtc = $(if ($s.lastEvaluationUtc) { $s.lastEvaluationUtc.ToString('o') })
        nextEvaluationAt = $s.nextEvaluationAt.ToString('o'); evaluating = [bool]$s.process
        intervalMinutes = $component.intervalMinutes
      }
    }
    $oa = $componentStates['oa-supervisor']
    [ordered]@{
      pid = $PID; kind = 'tray'; lastCheckUtc = $now.ToString('o')
      lastEvaluationUtc = $states['oa-supervisor'].lastEvaluationUtc
      lastState = $tray.state; paused = $tray.paused; intervalMinutes = $IntervalMinutes
      nextEvaluationAt = $oa.nextEvaluationAt.ToString('o'); overdue = $oa.overdue
      evaluating = [bool]$oa.process; components = $states; error = $tray.error
    } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $files.heartbeat -Encoding utf8
  } catch { $tray.error = "heartbeat failed: $_" }
  $tray.lastBeatUtc = $now
}

function Start-Evaluation($Component) {
  $s = $componentStates[$Component.name]
  $s.startedUtc = (Get-Date).ToUniversalTime()
  $s.error = $null
  if ($Component.name -eq 'browser-watchdog') {
    $legacy = Get-OaLegacyInstall
    if ($legacy.browserTaskInstalled -or $legacy.browserShimInstalled -or $legacy.taskError -or
        (Test-OaLegacyBrowserProcessRunning)) {
      Complete-Evaluation -Component $Component -Failure 'Legacy browser dispatcher or another browser check remains; remove the old route or let that check finish.'
      return
    }
  }
  if (-not (Test-Path $Component.script)) {
    Complete-Evaluation -Component $Component -Failure "Component missing: $($Component.script)"
    return
  }
  $stamp = [Guid]::NewGuid().ToString('N').Substring(0, 8)
  $s.stdout = Join-Path ([IO.Path]::GetTempPath()) "oa-tray-eval-$stamp.out"
  $s.stderr = Join-Path ([IO.Path]::GetTempPath()) "oa-tray-eval-$stamp.err"
  $argList = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', "`"$($Component.script)`"") +
    @($Component.arguments | Where-Object { $_ })
  try {
    $s.process = Start-Process -FilePath $psExe -ArgumentList $argList -NoNewWindow -PassThru `
      -RedirectStandardOutput $s.stdout -RedirectStandardError $s.stderr
    # Windows PowerShell otherwise loses ExitCode when the child exits between ticks.
    $null = $s.process.Handle
  } catch {
    Complete-Evaluation -Component $Component -Failure "Could not start component: $_"
  }
}

function Complete-Evaluation {
  param($Component, [string]$Output, $ExitCode, [string]$Failure)
  $s = $componentStates[$Component.name]
  $next = (Get-Date).ToUniversalTime().AddMinutes($Component.intervalMinutes)
  $s.overdue = $null
  $s.lastExitCode = $ExitCode
  try {
    if ($Failure) { throw $Failure }
    if (-not $Output -or -not $Output.Trim()) { throw 'Component returned no result.' }
    if ($Component.name -eq 'oa-supervisor') {
        $line = ($Output -split "`n" | Where-Object { $_.Trim().StartsWith('{') } | Select-Object -Last 1)
        if (-not $line) { throw 'Component returned no JSON result.' }
        $result = $line | ConvertFrom-Json
        if (-not $result.state) { throw 'Component result has no state.' }
        $s.state = [string]$result.state
        $s.overdue = $result.actResult.overdue
        if ($ExitCode -notin @(0, 1) -or $result.error -or $result.actError) {
          throw "Exit $ExitCode`: $($result.error) $($result.actError)"
        }
        $candidate = $result.actResult.nextEvaluationAt
        if ($candidate) {
          $date = [datetime]::Parse($candidate, $null,
            [System.Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
          if ($date -lt $next) { $next = $date }
        }
    } else {
      $result = $Output | ConvertFrom-Json
      if ($ExitCode -notin @(0, 2) -or $result.healthy -isnot [bool] -or $result.error) {
        throw "Invalid browser result (exit $ExitCode): $($result.error)"
      }
      $s.state = if ($result.healthy -and $ExitCode -eq 0) { 'HEALTHY' } else { 'UNHEALTHY' }
    }
  } catch {
    $s.state = 'ERROR'
    $s.error = "$_"
  }
  $s.lastEvaluationUtc = (Get-Date).ToUniversalTime()
  $s.recent = @(@($s.recent) + @([ordered]@{
    at = $s.lastEvaluationUtc.ToString('o'); state = $s.state; exitCode = $s.lastExitCode; error = $s.error
  }) | Select-Object -Last 5)
  if ($Component.name -eq 'browser-watchdog') { [void](Save-TrayState) }
  $s.nextEvaluationAt = $next
  if ($s.process) { $s.process.Dispose(); $s.process = $null }
  Remove-OaComponentOutput $s
  $tray.state = $componentStates['oa-supervisor'].state
  $tray.statusRefreshAt = (Get-Date).ToUniversalTime()
  Write-Heartbeat
  Update-Ui
}

function Start-StatusRefresh {
  if ($NoTrayIcon -or $tray.statusProc -or -not (Test-Path $statusScript)) { return }
  $tray.statusOut = Join-Path ([IO.Path]::GetTempPath()) ("oa-tray-status-" + [Guid]::NewGuid().ToString('N').Substring(0, 8) + '.out')
  try {
    $tray.statusStartedUtc = (Get-Date).ToUniversalTime()
    $tray.statusProc = Start-Process -FilePath 'node' -ArgumentList @("`"$statusScript`"", '--status') `
      -NoNewWindow -PassThru -RedirectStandardOutput $tray.statusOut `
      -RedirectStandardError ($tray.statusOut + '.err')
    $null = $tray.statusProc.Handle
  } catch { $tray.statusProc = $null; $tray.error = "status unavailable: $_" }
}

function Complete-StatusRefresh {
  try {
    $raw = Get-Content -LiteralPath $tray.statusOut -Raw -ErrorAction Stop
    $tray.status = $raw | ConvertFrom-Json
  } catch { $tray.status = $null; $tray.error = "Status unavailable: $_" }
  Remove-Item -LiteralPath $tray.statusOut, ($tray.statusOut + '.err') -Force -ErrorAction SilentlyContinue
  if ($tray.statusProc) { $tray.statusProc.Dispose() }
  $tray.statusProc = $null
  $tray.statusRefreshAt = (Get-Date).ToUniversalTime().AddSeconds(60)
  Update-Ui
}

function Format-Local($iso) {
  if (-not $iso) { return 'n/a' }
  try {
    return ([datetime]::Parse([string]$iso, $null,
      [System.Globalization.DateTimeStyles]::RoundtripKind)).ToLocalTime().ToString('ddd HH:mm')
  } catch { return [string]$iso }
}

$icon = $null
$menu = $null
$items = @{}
function Add-InfoItem([string]$Key) {
  $item = New-Object System.Windows.Forms.ToolStripMenuItem
  $item.Enabled = $false
  [void]$menu.Items.Add($item)
  $items[$Key] = $item
}

function Update-Ui {
  if ($NoTrayIcon -or -not $icon) { return }
  $oa = $componentStates['oa-supervisor']
  $summary = if ($tray.paused) { 'Paused' } elseif ($oa.process) { 'Checking...' } else { $tray.state }
  $tip = "Overnight Agent supervisor: $summary"
  $icon.Text = $tip.Substring(0, [math]::Min(63, $tip.Length))
  $icon.Icon = if ($tray.paused) { [System.Drawing.SystemIcons]::Information }
               elseif ($tray.error -or @($componentStates.Values | Where-Object { $_.state -match 'FAIL|ERROR|MISSING|UNHEALTHY' }).Count) { [System.Drawing.SystemIcons]::Warning }
               else { [System.Drawing.SystemIcons]::Shield }
  $items.state.Text = "State: $summary (last check $(Format-Local $(if ($oa.lastEvaluationUtc) { $oa.lastEvaluationUtc.ToString('o') })))"
  $items.next.Text = if ($tray.paused) { 'Next check: paused' } else { "Next OA check: $(Format-Local $oa.nextEvaluationAt.ToString('o'))" }
  $browser = $componentStates['browser-watchdog']
  $browserSummary = if (-not $browser.enabled) { 'OFF' }
    elseif ($tray.paused -or $browser.paused) { 'PAUSED' } else { $browser.state }
  $items.browser.Text = "Browser watchdog: $browserSummary$(if ($browser.process) { ' (checking)' }) - last $(Format-Local $(if ($browser.lastEvaluationUtc) { $browser.lastEvaluationUtc.ToString('o') }))"
  $items.browserNext.Text = if ($browser.enabled -and -not $browser.paused -and -not $tray.paused) {
    "Next browser check: $(Format-Local $browser.nextEvaluationAt.ToString('o'))"
  } else { 'Next browser check: off/paused' }
  $items.browserEnable.Checked = $browser.enabled
  $items.browserPause.Checked = $browser.paused
  $items.browserPause.Enabled = $browser.enabled
  $items.browserCheck.Enabled = $browser.enabled -and -not $browser.paused -and -not $tray.paused -and -not $browser.process
  $items.browserRecent.DropDownItems.Clear()
  foreach ($outcome in @($browser.recent)) {
    $entry = $items.browserRecent.DropDownItems.Add("$(Format-Local $outcome.at) $($outcome.state) $($outcome.error)")
    $entry.Enabled = $false
  }
  $items.error.Text = (@($tray.error) + @($componentStates.Values | ForEach-Object { $_.error }) | Where-Object { $_ }) -join '; '
  $items.error.Visible = [bool]$items.error.Text
  $s = $tray.status
  if ($s -and $s.policy.valid) {
    $p = $s.policy
    $items.policy.Text = "Policy: quiet restart after $($p.quietOpportunityHours)h (needs $($p.quietWindowMinutes)m quiet), hard deadline $($p.hardDeadlineHours)h, cooldown $($p.cooldownMinutes)m" +
      $(if (-not $p.enabled) { ' - DISABLED in policy' } else { '' })
  } elseif ($s) { $items.policy.Text = "Policy: INVALID - restarts blocked ($($s.policy.error))" }
  else { $items.policy.Text = 'Policy: default (3h quiet / 4h hard / 15m quiet / 60m cooldown) - status pending' }
  $items.cycle.Text = if ($s -and $s.cycle) {
      "Cycle: quiet opportunity $(Format-Local $s.cycle.opportunityAt), hard deadline $(Format-Local $s.cycle.hardDeadlineAt)"
    } else { 'Cycle: not started (app age not yet observed)' }
  $items.cooldown.Text = if ($s -and $s.cooldown -and $s.cooldown.active) { "Cooldown: active until $(Format-Local $s.cooldown.until)" } else { 'Cooldown: none' }
  $items.recent.DropDownItems.Clear()
  if ($s -and $s.recent -and @($s.recent).Count) {
    foreach ($r in @($s.recent)) {
      $text = "$(Format-Local $r.at)  $($r.outcome)  $($r.reason)"
      if ($r.error) { $text += " - $($r.error)" }
      $entry = $items.recent.DropDownItems.Add($text)
      $entry.Enabled = $false
    }
  } else { ($items.recent.DropDownItems.Add('No restart or launch attempts recorded')).Enabled = $false }
  $items.pause.Text = if ($tray.paused) { 'Resume supervision' } else { 'Pause supervision' }
  $startup = Get-OaTrayStartup
  $items.startup.Checked = $startup.enabled
  if (-not $tray.legacy) { $tray.legacy = Get-OaLegacyInstall }
  $items.legacy.Visible = ($tray.legacy.taskInstalled -or $tray.legacy.shimInstalled -or
    $tray.legacy.browserTaskInstalled -or $tray.legacy.browserShimInstalled -or
    @($tray.legacy.browserProcesses).Count -gt 0 -or $tray.legacy.taskError)
}

function Exit-Tray {
  $timer.Stop()
  foreach ($component in $components) {
    $s = $componentStates[$component.name]
    Stop-OaComponentProcess $s.process
    $s.process = $null
    Remove-OaComponentOutput $s
  }
  Stop-OaComponentProcess $tray.statusProc
  if ($icon) { $icon.Visible = $false; $icon.Dispose() }
  [System.Windows.Forms.Application]::ExitThread()
}

if (-not $NoTrayIcon) {
  $menu = New-Object System.Windows.Forms.ContextMenuStrip
  $title = $menu.Items.Add('Overnight Agent reliability supervisor')
  $title.Enabled = $false
  [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
  foreach ($k in @('state', 'next', 'browser', 'browserNext', 'error', 'policy', 'cycle', 'cooldown')) { Add-InfoItem $k }
  $items.browserRecent = New-Object System.Windows.Forms.ToolStripMenuItem('Recent browser outcomes')
  [void]$menu.Items.Add($items.browserRecent)
  $items.recent = New-Object System.Windows.Forms.ToolStripMenuItem('Recent outcomes')
  [void]$menu.Items.Add($items.recent)
  $note = $menu.Items.Add('Supervises only while you are signed in to Windows')
  $note.Enabled = $false
  [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

  $check = $menu.Items.Add('Check now')
  $check.add_Click({
    if (-not $tray.paused) {
      foreach ($s in $componentStates.Values) {
        if ($s.enabled -and -not $s.paused -and -not $s.process) { $s.nextEvaluationAt = (Get-Date).ToUniversalTime() }
      }
    }
  })
  $items.pause = New-Object System.Windows.Forms.ToolStripMenuItem('Pause supervision')
  $items.pause.add_Click({
    $tray.paused = -not $tray.paused
    if (-not (Save-TrayState)) { $tray.paused = -not $tray.paused }
    Write-Heartbeat; Update-Ui
  })
  [void]$menu.Items.Add($items.pause)
  $items.browserEnable = $menu.Items.Add('Enable browser checks')
  $items.browserEnable.add_Click({
    $browser = $componentStates['browser-watchdog']
    $browser.enabled = -not $browser.enabled
    if (-not (Save-TrayState)) { $browser.enabled = -not $browser.enabled }
    if ($browser.enabled) { $browser.nextEvaluationAt = (Get-Date).ToUniversalTime() }
    Write-Heartbeat; Update-Ui
  })
  $items.browserPause = $menu.Items.Add('Pause browser checks')
  $items.browserPause.add_Click({
    $browser = $componentStates['browser-watchdog']
    $browser.paused = -not $browser.paused
    if (-not (Save-TrayState)) { $browser.paused = -not $browser.paused }
    Write-Heartbeat; Update-Ui
  })
  $items.browserCheck = $menu.Items.Add('Check browsers now')
  $items.browserCheck.add_Click({ $componentStates['browser-watchdog'].nextEvaluationAt = (Get-Date).ToUniversalTime() })

  $items.startup = New-Object System.Windows.Forms.ToolStripMenuItem('Start with Windows')
  $items.startup.add_Click({
    try {
      if ((Get-OaTrayStartup).enabled) {
        Disable-OaTrayStartup
        $icon.ShowBalloonTip(5000, 'Overnight Agent supervisor',
          'Will not start at sign-in. It keeps running until you choose Exit.', 'Info')
      } else {
        $removed = Remove-OaLegacyInstall
        Enable-OaTrayStartup (Get-OaTrayCommandLine -TrayPath $trayPath -IntervalMinutes $IntervalMinutes -NoAct:$NoAct)
        $msg = 'Will start at sign-in (HKCU Run).'
        if (@($removed).Count) { $msg += " Removed legacy: $($removed -join '; ')." }
        $icon.ShowBalloonTip(5000, 'Overnight Agent supervisor', $msg, 'Info')
      }
    } catch { $icon.ShowBalloonTip(8000, 'Overnight Agent supervisor', "$_", 'Error') }
    $tray.legacy = $null
    Update-Ui
  })
  [void]$menu.Items.Add($items.startup)

  $items.legacy = New-Object System.Windows.Forms.ToolStripMenuItem('Remove legacy scheduled task / Startup shim')
  $items.legacy.add_Click({
    try {
      $removed = Remove-OaLegacyInstall
      $icon.ShowBalloonTip(5000, 'Overnight Agent supervisor', "Removed: $(@($removed) -join '; ')", 'Info')
    } catch { $icon.ShowBalloonTip(8000, 'Overnight Agent supervisor', "$_", 'Error') }
    $tray.legacy = $null
    Update-Ui
  })
  [void]$menu.Items.Add($items.legacy)

  $open = $menu.Items.Add('Open supervisor folder (policy, audit)')
  $open.add_Click({ Start-Process explorer.exe -ArgumentList "`"$oaHome`"" })
  [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
  $exit = $menu.Items.Add('Exit')
  $exit.add_Click({ Exit-Tray })

  $icon = New-Object System.Windows.Forms.NotifyIcon
  $icon.ContextMenuStrip = $menu
  $icon.Icon = [System.Drawing.SystemIcons]::Shield
  $icon.Text = 'Overnight Agent supervisor'
  $icon.Visible = $true
  $menu.add_Opening({ Update-Ui })
}

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 1000
$timer.add_Tick({
  try {
    if (Test-Path -LiteralPath $files.stopRequest) {
      try { $req = Get-Content -LiteralPath $files.stopRequest -Raw | ConvertFrom-Json } catch { $req = $null }
      if ($req -and [int]$req.pid -eq $PID) { Exit-Tray; return }
    }
    $now = (Get-Date).ToUniversalTime()
    foreach ($component in $components) {
      $s = $componentStates[$component.name]
      if ($s.process -and $s.process.HasExited) {
        $s.process.WaitForExit()
        $out = Get-Content -LiteralPath $s.stdout -Raw -ErrorAction SilentlyContinue
        $err = Get-Content -LiteralPath $s.stderr -Raw -ErrorAction SilentlyContinue
        $exitCode = $s.process.ExitCode
        Complete-Evaluation -Component $component -Output $out -ExitCode $exitCode -Failure $(if (-not $out) { $err })
      } elseif ($s.process -and ($now - $s.startedUtc).TotalSeconds -ge $EvaluationTimeoutSeconds) {
        Stop-OaComponentProcess $s.process
        Complete-Evaluation -Component $component -ExitCode 124 -Failure "Timed out after ${EvaluationTimeoutSeconds}s."
      } elseif (-not $s.process -and $s.enabled -and -not $s.paused -and -not $tray.paused -and $now -ge $s.nextEvaluationAt) {
        Start-Evaluation $component
        Write-Heartbeat
        Update-Ui
      }
    }
    if ($tray.statusProc -and $tray.statusProc.HasExited) { Complete-StatusRefresh }
    elseif ($tray.statusProc -and ($now - $tray.statusStartedUtc).TotalSeconds -ge 30) {
      Stop-OaComponentProcess $tray.statusProc
      $tray.error = 'Status refresh timed out.'
      Complete-StatusRefresh
    }
    elseif (-not $tray.statusProc -and $now -ge $tray.statusRefreshAt) { Start-StatusRefresh }
    if (($now - $tray.lastBeatUtc).TotalSeconds -ge 15) { Write-Heartbeat }
  } catch { $tray.error = "$_"; Write-Heartbeat; Update-Ui }
})

try {
  Write-Heartbeat
  Update-Ui
  $timer.Start()
  [System.Windows.Forms.Application]::Run()
} finally {
  $timer.Dispose()
  foreach ($s in $componentStates.Values) { Stop-OaComponentProcess $s.process; Remove-OaComponentOutput $s }
  Stop-OaComponentProcess $tray.statusProc
  if ($tray.statusOut) { Remove-Item -LiteralPath $tray.statusOut, ($tray.statusOut + '.err') -Force -ErrorAction SilentlyContinue }
  if ($icon) { $icon.Dispose() }
  $lockHandle.Dispose()
  Remove-Item -LiteralPath $files.lock -Force -ErrorAction SilentlyContinue
}
