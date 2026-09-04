<#
.SYNOPSIS
  Detects that an OUT-OF-BAND reliability daemon has gone dormant. The supervisors
  watch the app; nothing watched the supervisors. This is that reader.

.DESCRIPTION
  WHAT WAS ACTUALLY BROKEN (GH #261, measured 2026-09-03)
  -------------------------------------------------------
  #261 is "a stuck run freezes the */30 schedule with no timeout to fail and
  reschedule". The recovery mechanism for it already exists and is already RUNNING:

      oa-supervisor-daemon.ps1   pid 18196   up 9h41m   lastState HEALTHY
      browser-watchdog.ps1       pid  4144   up 9h42m   hourly log lines

  Both are dispatched by Explorer from the Startup folder, NOT by Task Scheduler
  (install-oa-supervisor.ps1 falls back to a Startup shim because registering a
  scheduled task is denied without elevation on this machine). A check that queries
  only `Get-ScheduledTask` therefore reports "no supervisor installed" while two
  supervisors are running - which is how this was nearly mis-diagnosed as dormant.

  So the gap #261 still has is NOT that supervision is missing. It is that
  supervision is UNOBSERVED:

      supervisor-daemon-heartbeat.json   written every 15 min   readers: 0
      browser-watchdog.log               written every ~62 min  readers: 0

  Both numbers were measured with a repo-wide grep. The daemon's own source says
  the heartbeat exists so "its absence is observable" - but nothing was ever
  written to observe it. Both daemons also share one documented weakness:

      "if it dies it stays dead until next logon"   (oa-supervisor-daemon.ps1)

  A daemon that dies at 02:00 is gone until the next logon, silently, and #261's
  freeze comes straight back with no signal. This sweep is the missing reader.

  WHY THIS IS NOT THE CIRCULAR SELF-HEAL (GH #243 / #226)
  -------------------------------------------------------
  #243's trap is supervision that lives inside the failure domain it repairs. This
  deliberately does not do that, and the direction of the relationship is the whole
  argument:

      the daemons     supervise   the app and its schedule   (dispatched by the OS)
      this sweep      supervises  the daemons                (dispatched by a run)

  Those are two DIFFERENT dispatch domains watching each other, not one domain
  watching itself. If a run freezes, the daemons catch it - that is #261. If a
  daemon dies, the next run catches it - that is this file. Neither is inside the
  other.

  THE LIMIT, STATED PLAINLY RATHER THAN BURIED: if the app freezes AND a daemon
  dies in the same window, nothing catches that. Closing it needs a dispatcher
  outside both, i.e. the elevated scheduled task install-oa-supervisor.ps1 already
  registers when run as admin. This sweep reports which route is actually in use so
  that gap is visible instead of assumed.

  FALSE POSITIVES ARE THE REAL FAILURE MODE
  -----------------------------------------
  run-sweeps.ps1 carries the lesson at length: workflow-health-sweep flagged a real
  OVERDUE watchdog in 16 consecutive runs and every one of them skimmed it, because
  a line that is permanently red teaches the reader to ignore it. So the tolerance
  here is deliberately loose - a unit must miss SEVERAL consecutive beats before it
  is called stale, and a unit that is healthy by EITHER route is healthy.

.PARAMETER FactsJson
  Classify from a facts file instead of collecting from this machine. This is the
  replay path (the same idea as supervisor-replay.mjs) and it is what lets the
  mutation check drive the real classifier with synthetic units on a Linux runner,
  where Get-ScheduledTask does not exist.

.PARAMETER StaleMultiplier
  A unit is STALE when its liveness signal is older than cadence * this. Default 3,
  so three consecutive missed beats are required. At the supervisor's 15 min cadence
  that is 45 min; at the watchdog's ~62 min cadence it is ~3.1 h.

.PARAMETER MinStaleMinutes
  Floor for the staleness window, so a unit with a very short cadence cannot be
  called stale on a single slow cycle. Default 45.

.OUTPUTS
  Human lines on stdout, plus one JSON object under -Json.
  Exit 0 = every unit healthy. Exit 1 = at least one unit ABSENT/DEAD/STALE.
  Exit 2 = the sweep itself could not run.
#>
[CmdletBinding()]
param(
  [string]$FactsJson,
  [double]$StaleMultiplier = 3,
  [int]$MinStaleMinutes    = 45,
  [switch]$Json
)

$ErrorActionPreference = 'Stop'

# --- the units this machine expects to be supervising it ----------------------------
# Kept as data, not code, so adding the next out-of-band daemon is a row rather than a
# new sweep. Each row names BOTH install routes (scheduled task and Startup shim)
# because the fallback route is the one actually in use here.
function Get-UnitSpecs {
  $oaHome  = Join-Path $env:LOCALAPPDATA 'overnight-agent'
  $startup = [Environment]::GetFolderPath('Startup')
  @(
    [ordered]@{
      name        = 'oa-supervisor'
      issue       = '#261/#226'
      purpose     = 'ends a stuck run so the */30 schedule can resume'
      taskName    = 'Overnight Agent supervisor'
      shimPath    = (Join-Path $startup 'Overnight Agent supervisor.cmd')
      lockPath    = (Join-Path $oaHome 'supervisor-daemon.lock')
      signalPath  = (Join-Path $oaHome 'supervisor-daemon-heartbeat.json')
      signalField = 'lastCheckUtc'
      cadence     = 15
    }
    [ordered]@{
      name        = 'browser-watchdog'
      issue       = '#197/#243'
      purpose     = 'restores a dead or stuck browser slot'
      taskName    = 'Copilot browser watchdog'
      shimPath    = (Join-Path $startup 'CopilotBrowserWatchdog.vbs')
      lockPath    = ''
      signalPath  = (Join-Path $env:LOCALAPPDATA 'playwright-mcp\browser-watchdog.log')
      signalField = ''      # no structured field: freshness comes from the file mtime
      cadence     = 62
      procMatch   = 'browser-watchdog'
    }
  )
}

function Test-ProcessAlive([int]$ProcessId) {
  if ($ProcessId -le 0) { return $false }
  return [bool](Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
}

# Windows-only. Wrapped so the sweep degrades to "no task route" rather than throwing
# on a runner that has no Task Scheduler at all.
function Get-TaskFacts([string]$TaskName) {
  $out = [ordered]@{ installed = $false; state = ''; lastRunMinutes = $null }
  if (-not $TaskName) { return $out }
  if (-not (Get-Command Get-ScheduledTask -ErrorAction SilentlyContinue)) { return $out }
  try {
    $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $t) { return $out }
    $out.installed = $true
    $out.state     = [string]$t.State
    $info = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($info -and $info.LastRunTime -and $info.LastRunTime -gt [datetime]'1900-01-01') {
      $out.lastRunMinutes = [math]::Round(((Get-Date) - $info.LastRunTime).TotalMinutes, 1)
    }
  } catch { }
  return $out
}

function Get-SignalAgeMinutes([string]$Path, [string]$Field) {
  if (-not $Path -or -not (Test-Path $Path)) { return $null }
  # A structured field is preferred: it dates the last COMPLETED cycle, whereas an
  # mtime only proves the file was touched. Fall back to mtime when there is no field.
  if ($Field) {
    try {
      $raw = [IO.File]::ReadAllText($Path, (New-Object Text.UTF8Encoding($false)))
      $m = [regex]::Match($raw, ('"' + [regex]::Escape($Field) + '"\s*:\s*"([^"]+)"'))
      if ($m.Success) {
        $when = [datetimeoffset]::Parse($m.Groups[1].Value)
        return [math]::Round(([datetimeoffset]::UtcNow - $when).TotalMinutes, 1)
      }
    } catch { }
  }
  try { return [math]::Round(((Get-Date) - (Get-Item $Path).LastWriteTime).TotalMinutes, 1) }
  catch { return $null }
}

function Get-Facts {
  $units = @()
  foreach ($spec in (Get-UnitSpecs)) {
    $task = Get-TaskFacts $spec.taskName

    $pid_ = 0
    if ($spec.lockPath -and (Test-Path $spec.lockPath)) {
      try {
        $raw = [IO.File]::ReadAllText($spec.lockPath, (New-Object Text.UTF8Encoding($false)))
        $m = [regex]::Match($raw, '"pid"\s*:\s*(\d+)')
        if ($m.Success) { $pid_ = [int]$m.Groups[1].Value }
      } catch { }
    }
    $alive = Test-ProcessAlive $pid_
    # Not every unit writes a lock file. Fall back to matching the command line, which
    # is how the browser watchdog is identifiable at all.
    if (-not $alive -and $spec.Contains('procMatch') -and $spec.procMatch) {
      try {
        $hit = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
                 Where-Object { $_.CommandLine -and $_.CommandLine -match [regex]::Escape($spec.procMatch) } |
                 Select-Object -First 1
        if ($hit) { $alive = $true; $pid_ = [int]$hit.ProcessId }
      } catch { }
    }

    $units += [ordered]@{
      name           = $spec.name
      issue          = $spec.issue
      purpose        = $spec.purpose
      taskInstalled  = $task.installed
      taskState      = $task.state
      taskLastRunMin = $task.lastRunMinutes
      shimInstalled  = [bool]($spec.shimPath -and (Test-Path $spec.shimPath))
      shimPath       = $spec.shimPath
      processAlive   = $alive
      processPid     = $pid_
      signalPath     = $spec.signalPath
      signalAgeMin   = (Get-SignalAgeMinutes $spec.signalPath $spec.signalField)
      cadenceMin     = $spec.cadence
    }
  }
  return [ordered]@{ collectedUtc = ([datetimeoffset]::UtcNow.ToString('o')); units = $units }
}

# --- the classifier: a pure function of the facts -----------------------------------
# Pure on purpose. Every arm below is mutated one at a time by
# mutcheck-supervisor-liveness.ps1 and must break exactly one fixture.
function Get-UnitVerdict {
  param([psobject]$Unit, [double]$Multiplier, [int]$Floor)

  $cadence   = if ($Unit.cadenceMin) { [double]$Unit.cadenceMin } else { 15 }
  $tolerance = [math]::Max($cadence * $Multiplier, $Floor)

  $installed = ([bool]$Unit.taskInstalled) -or ([bool]$Unit.shimInstalled)
  # ARM 'install': nothing is installed by either route, so the protection this repo
  # believes it has is simply not present. Distinguishing this from DEAD is the whole
  # point - "never installed" and "installed but died" need different fixes.
  if (-not $installed) { return 'ABSENT' }

  # ARM 'task': a registered, enabled scheduled task is a live dispatcher even though
  # it leaves NO resident process between firings. Without this arm the elevated
  # install - the better one - would be reported DEAD forever, and a permanently red
  # line is how a real finding gets skimmed.
  $taskHealthy = ([bool]$Unit.taskInstalled) -and
                 ($Unit.taskState -ne 'Disabled') -and
                 (($null -eq $Unit.taskLastRunMin) -or ([double]$Unit.taskLastRunMin -le $tolerance))

  # ARM 'process': the Startup-folder route is only alive while its process is alive.
  # This must be checked independently of the heartbeat, because a daemon killed a
  # minute ago still has a perfectly fresh heartbeat on disk.
  $daemonAlive = ([bool]$Unit.shimInstalled) -and ([bool]$Unit.processAlive)

  # ARM 'fresh': alive is not the same as working. A daemon wedged inside its own
  # child call stays alive forever and stops beating, which is the failure the
  # heartbeat was written for.
  $daemonFresh = ($null -ne $Unit.signalAgeMin) -and ([double]$Unit.signalAgeMin -le $tolerance)

  if ($taskHealthy -or ($daemonAlive -and $daemonFresh)) { return 'HEALTHY' }
  if ($daemonAlive) { return 'STALE' }
  return 'DEAD'
}

# --- run ----------------------------------------------------------------------------
try {
  if ($FactsJson) {
    if (-not (Test-Path $FactsJson)) { Write-Error "facts file not found: $FactsJson"; exit 2 }
    $facts = [IO.File]::ReadAllText($FactsJson, (New-Object Text.UTF8Encoding($false))) | ConvertFrom-Json
  } else {
    $facts = Get-Facts | ConvertTo-Json -Depth 6 | ConvertFrom-Json
  }

  $rows = @()
  foreach ($u in $facts.units) {
    $verdict = Get-UnitVerdict -Unit $u -Multiplier $StaleMultiplier -Floor $MinStaleMinutes
    $route = if ($u.taskInstalled -and $u.shimInstalled) { 'task+startup' }
             elseif ($u.taskInstalled) { 'task' }
             elseif ($u.shimInstalled) { 'startup' }
             else { 'none' }
    $rows += [pscustomobject]@{
      name = $u.name; issue = $u.issue; purpose = $u.purpose; verdict = $verdict
      route = $route; pid = $u.processPid; signalAgeMin = $u.signalAgeMin; cadenceMin = $u.cadenceMin
    }
  }

  $bad = @($rows | Where-Object verdict -ne 'HEALTHY')

  if ($Json) {
    [pscustomobject]@{ collectedUtc = $facts.collectedUtc; units = $rows; findings = $bad.Count } |
      ConvertTo-Json -Depth 6
  } else {
    foreach ($r in $rows) {
      $tag = switch ($r.verdict) {
        'HEALTHY' { '  ok      ' }
        'STALE'   { '  DORMANT ' }
        'DEAD'    { '  DORMANT ' }
        default   { '  DORMANT ' }
      }
      Write-Host ("{0} {1,-18} {2,-8} route={3,-12} pid={4,-7} signal_age={5} min (cadence {6})" -f `
        $tag, $r.name, $r.verdict, $r.route, $r.pid, $r.signalAgeMin, $r.cadenceMin)
    }
    Write-Host ''
    if ($bad.Count) {
      foreach ($r in $bad) {
        $why = switch ($r.verdict) {
          'ABSENT' { "installed by NEITHER route - $($r.purpose) is not protected at all" }
          'DEAD'   { "installed but not running - it stays dead until next logon" }
          'STALE'  { "running but its liveness signal stopped - it is wedged, not working" }
        }
        Write-Host ("[supervisor-liveness] {0} ({1}) {2}: {3}" -f $r.name, $r.issue, $r.verdict, $why)
      }
      Write-Host ''
      Write-Host '[supervisor-liveness] REPAIR: powershell -NoProfile -ExecutionPolicy Bypass -File plugins/overnight-agent/checks/install-oa-supervisor.ps1'
      Write-Host '[supervisor-liveness] (run it ELEVATED to get the scheduled-task route, which survives logoff and restarts itself)'
    } else {
      Write-Host "[supervisor-liveness] $($rows.Count) unit(s) healthy."
    }
  }

  exit ($(if ($bad.Count) { 1 } else { 0 }))
}
catch {
  Write-Error "[supervisor-liveness] sweep failed: $_"
  exit 2
}
