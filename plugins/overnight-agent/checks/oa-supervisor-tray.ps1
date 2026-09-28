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
  [int]$IntervalMinutes = 15,
  [switch]$NoAct,
  [switch]$NoTrayIcon
)

$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'oa-supervisor-startup.ps1')

$files = Get-OaSupervisorFiles
$oaHome = $files.home
if (-not (Test-Path $oaHome)) { New-Item -ItemType Directory -Path $oaHome -Force | Out-Null }
$supervisor = Join-Path $oaHome 'oa-supervisor.ps1'
$statusScript = Join-Path $oaHome 'consumer-reliability-supervisor.mjs'
if (-not (Test-Path $statusScript)) { $statusScript = Join-Path $PSScriptRoot 'consumer-reliability-supervisor.mjs' }
$psExe = (Get-Process -Id $PID).Path
$trayPath = if (Test-Path $files.tray) { $files.tray } else { $PSCommandPath }
$startedUtc = (Get-Date).ToUniversalTime()

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
  paused = $false; state = 'STARTING'; lastEvaluationUtc = $null; overdue = $null
  nextEvaluationAt = (Get-Date).ToUniversalTime()
  evaluation = $null; evaluationStartedUtc = $null; evalOut = $null; evalErr = $null
  statusProc = $null; statusOut = $null; status = $null; statusRefreshAt = (Get-Date).ToUniversalTime()
  lastBeatUtc = [datetime]::MinValue; error = $null; legacy = $null
}
if (Test-Path $files.trayState) {
  try { $tray.paused = [bool]((Get-Content $files.trayState -Raw | ConvertFrom-Json).paused) } catch { }
}

function Save-TrayState {
  try {
    @{ paused = $tray.paused; updatedUtc = (Get-Date).ToUniversalTime().ToString('o') } |
      ConvertTo-Json | Set-Content -LiteralPath $files.trayState -Encoding utf8
  } catch { $tray.error = "could not save tray state: $_" }
}

function Write-Heartbeat {
  $now = (Get-Date).ToUniversalTime()
  try {
    [ordered]@{
      pid = $PID; kind = 'tray'; lastCheckUtc = $now.ToString('o')
      lastEvaluationUtc = $(if ($tray.lastEvaluationUtc) { $tray.lastEvaluationUtc.ToString('o') })
      lastState = $tray.state; paused = $tray.paused; intervalMinutes = $IntervalMinutes
      nextEvaluationAt = $tray.nextEvaluationAt.ToString('o'); overdue = $tray.overdue
      evaluating = [bool]$tray.evaluation
    } | ConvertTo-Json | Set-Content -LiteralPath $files.heartbeat -Encoding utf8
  } catch { $tray.error = "heartbeat failed: $_" }
  $tray.lastBeatUtc = $now
}

function Start-Evaluation {
  $tray.evaluationStartedUtc = (Get-Date).ToUniversalTime()
  if (-not (Test-Path $supervisor)) {
    $tray.state = 'SUPERVISOR-MISSING'
    Complete-Evaluation $null
    return
  }
  $stamp = [Guid]::NewGuid().ToString('N').Substring(0, 8)
  $tray.evalOut = Join-Path ([IO.Path]::GetTempPath()) "oa-tray-eval-$stamp.out"
  $tray.evalErr = Join-Path ([IO.Path]::GetTempPath()) "oa-tray-eval-$stamp.err"
  $argList = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', "`"$supervisor`"")
  if ($NoAct) { $argList += '-NoAct' }
  try {
    # A child process on purpose: a checker crash must not kill the scheduler.
    $tray.evaluation = Start-Process -FilePath $psExe -ArgumentList $argList -NoNewWindow -PassThru `
      -RedirectStandardOutput $tray.evalOut -RedirectStandardError $tray.evalErr
  } catch {
    $tray.state = "TRAY-ERROR: $_"
    Complete-Evaluation $null
  }
}

function Complete-Evaluation($Output) {
  $next = (Get-Date).ToUniversalTime().AddMinutes($IntervalMinutes)
  $tray.overdue = $null
  if ($Output) {
    $line = ($Output -split "`n" | Where-Object { $_.Trim().StartsWith('{') } | Select-Object -Last 1)
    if ($line) {
      try {
        $result = $line | ConvertFrom-Json
        $tray.state = [string]$result.state
        $tray.overdue = $result.actResult.overdue
        $candidate = $result.actResult.nextEvaluationAt
        if ($candidate) {
          $date = [datetime]::Parse($candidate, $null,
            [System.Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
          if ($date -lt $next) { $next = $date }
        }
      } catch { $tray.state = 'UNPARSEABLE-RESULT' }
    } elseif ($tray.state -notmatch '^(SUPERVISOR-MISSING|TRAY-ERROR)') { $tray.state = 'NO-RESULT' }
  }
  $tray.lastEvaluationUtc = (Get-Date).ToUniversalTime()
  $tray.nextEvaluationAt = $next
  $tray.evaluation = $null
  foreach ($p in @($tray.evalOut, $tray.evalErr)) { if ($p) { Remove-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue } }
  $tray.statusRefreshAt = (Get-Date).ToUniversalTime()
  Write-Heartbeat
  Update-Ui
}

function Start-StatusRefresh {
  if ($NoTrayIcon -or $tray.statusProc -or -not (Test-Path $statusScript)) { return }
  $tray.statusOut = Join-Path ([IO.Path]::GetTempPath()) ("oa-tray-status-" + [Guid]::NewGuid().ToString('N').Substring(0, 8) + '.out')
  try {
    $tray.statusProc = Start-Process -FilePath 'node' -ArgumentList @("`"$statusScript`"", '--status') `
      -NoNewWindow -PassThru -RedirectStandardOutput $tray.statusOut `
      -RedirectStandardError ($tray.statusOut + '.err')
  } catch { $tray.statusProc = $null; $tray.error = "status unavailable: $_" }
}

function Complete-StatusRefresh {
  try {
    $raw = Get-Content -LiteralPath $tray.statusOut -Raw -ErrorAction Stop
    $tray.status = $raw | ConvertFrom-Json
  } catch { $tray.status = $null }
  Remove-Item -LiteralPath $tray.statusOut, ($tray.statusOut + '.err') -Force -ErrorAction SilentlyContinue
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
  $summary = if ($tray.paused) { 'Paused' } elseif ($tray.evaluation) { 'Checking...' } else { $tray.state }
  $tip = "Overnight Agent supervisor: $summary"
  $icon.Text = $tip.Substring(0, [math]::Min(63, $tip.Length))
  $icon.Icon = if ($tray.paused) { [System.Drawing.SystemIcons]::Information }
               elseif ($tray.state -match 'FAIL|ERROR|MISSING|UNPARSEABLE') { [System.Drawing.SystemIcons]::Warning }
               else { [System.Drawing.SystemIcons]::Shield }
  $items.state.Text = "State: $summary (last check $(Format-Local $(if ($tray.lastEvaluationUtc) { $tray.lastEvaluationUtc.ToString('o') })))"
  $items.next.Text = if ($tray.paused) { 'Next check: paused' } else { "Next check: $(Format-Local $tray.nextEvaluationAt.ToString('o'))" }
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
  $items.legacy.Visible = ($tray.legacy.taskInstalled -or $tray.legacy.shimInstalled)
}

function Exit-Tray {
  $timer.Stop()
  if ($icon) { $icon.Visible = $false; $icon.Dispose() }
  [System.Windows.Forms.Application]::ExitThread()
}

if (-not $NoTrayIcon) {
  $menu = New-Object System.Windows.Forms.ContextMenuStrip
  $title = $menu.Items.Add('Overnight Agent reliability supervisor')
  $title.Enabled = $false
  [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
  foreach ($k in @('state', 'next', 'policy', 'cycle', 'cooldown')) { Add-InfoItem $k }
  $items.recent = New-Object System.Windows.Forms.ToolStripMenuItem('Recent outcomes')
  [void]$menu.Items.Add($items.recent)
  $note = $menu.Items.Add('Supervises only while you are signed in to Windows')
  $note.Enabled = $false
  [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

  $check = $menu.Items.Add('Check now')
  $check.add_Click({ if (-not $tray.evaluation -and -not $tray.paused) { $tray.nextEvaluationAt = (Get-Date).ToUniversalTime() } })
  $items.pause = New-Object System.Windows.Forms.ToolStripMenuItem('Pause supervision')
  $items.pause.add_Click({ $tray.paused = -not $tray.paused; Save-TrayState; Write-Heartbeat; Update-Ui })
  [void]$menu.Items.Add($items.pause)

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
    if ($tray.evaluation -and $tray.evaluation.HasExited) {
      $out = Get-Content -LiteralPath $tray.evalOut -Raw -ErrorAction SilentlyContinue
      Complete-Evaluation $(if ($out) { $out } else { ' ' })
    } elseif (-not $tray.evaluation -and -not $tray.paused -and $now -ge $tray.nextEvaluationAt) {
      Start-Evaluation
      Write-Heartbeat
      Update-Ui
    }
    if ($tray.statusProc -and $tray.statusProc.HasExited) { Complete-StatusRefresh }
    elseif (-not $tray.statusProc -and $now -ge $tray.statusRefreshAt) { Start-StatusRefresh }
    if (($now - $tray.lastBeatUtc).TotalSeconds -ge 15) { Write-Heartbeat }
  } catch { $tray.error = "$_" }
})

try {
  Write-Heartbeat
  Update-Ui
  $timer.Start()
  [System.Windows.Forms.Application]::Run()
} finally {
  $timer.Dispose()
  if ($icon) { $icon.Dispose() }
  $lockHandle.Dispose()
  Remove-Item -LiteralPath $files.lock -Force -ErrorAction SilentlyContinue
}
