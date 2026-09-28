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
  dies in the same window, nothing catches that. This sweep reports which route is
  actually in use so that gap is visible instead of assumed.

  GH #689 CHANGED THE oa-supervisor UNIT: it is now an OPTIONAL tray app, off by
  default, started by ONE route (a per-user HKCU Run entry) and only while the user
  is signed in. So for that unit:
    * no Run entry            -> OFF     (the user has not opted in; NOT a finding)
    * tray alive, fresh, paused -> PAUSED (the user paused it; NOT a finding)
    * a pre-#689 scheduled task or Startup shim still present -> LEGACY (a finding:
      the retired route is inert and must be removed with install-oa-supervisor.ps1)
  Browser checks are independently opt-in within the same tray. Their old task
  and Startup shim are legacy routes, not alternative dispatchers.

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
  Exit 0 = no unit dormant (HEALTHY, or OFF/PAUSED by user choice).
  Exit 1 = at least one unit ABSENT/DEAD/STALE/LEGACY.
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
# new sweep. Both units are optional and use the SAME HKCU Run tray entry. Task and
# shim names are listed only to detect legacy routes; the browser is not a second daemon.
function Get-UnitSpecs {
  $oaHome  = Join-Path $env:LOCALAPPDATA 'overnight-agent'
  $startup = [Environment]::GetFolderPath('Startup')
  @(
    [ordered]@{
      name        = 'oa-supervisor'
      issue       = '#261/#226/#689'
      purpose     = 'ends a stuck run so the */30 schedule can resume'
      optional    = $true
      runValue    = 'Overnight Agent supervisor'
      legacyTask  = 'Overnight Agent supervisor'
      legacyShim  = (Join-Path $startup 'Overnight Agent supervisor.cmd')
      taskName    = ''
      shimPath    = ''
      lockPath    = (Join-Path $oaHome 'supervisor-daemon.lock')
      signalPath  = (Join-Path $oaHome 'supervisor-daemon-heartbeat.json')
      signalField = 'lastCheckUtc'
      cadence     = 15
    }
    [ordered]@{
      name        = 'browser-watchdog'
      issue       = '#197/#243'
      purpose     = 'restores a dead or stuck browser slot'
      optional    = $true
      runValue    = 'Overnight Agent supervisor'
      legacyTask  = 'Copilot browser watchdog'
      legacyShim  = (Join-Path $startup 'CopilotBrowserWatchdog.vbs')
      taskName    = ''
      shimPath    = ''
      lockPath    = (Join-Path $oaHome 'supervisor-daemon.lock')
      statePath   = (Join-Path $oaHome 'supervisor-tray.json')
      signalPath  = (Join-Path $oaHome 'supervisor-daemon-heartbeat.json')
      signalField = 'lastCheckUtc'
      cadence     = 15
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

function Get-RunValueInstalled([string]$Name) {
  if (-not $Name) { return $false }
  try {
    $v = Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name $Name -ErrorAction Stop
    return [bool]$v.$Name
  } catch { return $false }
}

function Get-HeartbeatPaused([string]$Path) {
  if (-not $Path -or -not (Test-Path $Path)) { return $false }
  try {
    $raw = [IO.File]::ReadAllText($Path, (New-Object Text.UTF8Encoding($false)))
    return [regex]::IsMatch($raw, '"paused"\s*:\s*true')
  } catch { return $false }
}

function Get-BrowserTraySettings([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return @{ enabled = $false; paused = $false } }
  try {
    $beat = Get-Content -LiteralPath $Path -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    return @{ enabled = [bool]$beat.browserEnabled; paused = [bool]$beat.browserPaused }
  } catch { return @{ enabled = $false; paused = $false } }
}

function Get-Facts {
  $units = @()
  foreach ($spec in (Get-UnitSpecs)) {
    $task = Get-TaskFacts $spec.taskName
    $optional = [bool]($spec.Contains('optional') -and $spec.optional)
    $legacyTask = if ($optional) { (Get-TaskFacts $spec.legacyTask).installed } else { $false }
    $legacyShim = [bool]($optional -and $spec.legacyShim -and (Test-Path $spec.legacyShim))
    $runInstalled = if ($optional) { Get-RunValueInstalled $spec.runValue } else { $false }
    $browserSettings = if ($spec.name -eq 'browser-watchdog') {
      Get-BrowserTraySettings $spec.statePath
    } else { $null }
    if ($browserSettings) { $runInstalled = $runInstalled -and $browserSettings.enabled }

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
      optional       = $optional
      runInstalled   = $runInstalled
      legacyInstalled = ($legacyTask -or $legacyShim)
      paused         = $(if ($browserSettings) { $browserSettings.paused }
                         else { Get-HeartbeatPaused $spec.signalPath })
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

  $installed = ([bool]$Unit.taskInstalled) -or ([bool]$Unit.shimInstalled) -or ([bool]$Unit.runInstalled)

  # ARM 'legacy': a pre-#689 task or Startup shim for an optional unit is an
  # independent dispatcher, which the single-tray route forbids.
  if ([bool]$Unit.legacyInstalled) { return 'LEGACY' }

  if (-not $installed) {
    # ARM 'optional': an opt-in unit with no startup entry is the user's choice, not a
    # gap. Reporting it would make a default install permanently red.
    if ([bool]$Unit.optional) { return 'OFF' }
    # ARM 'install': nothing is installed by any route, so the protection this repo
    # believes it has is simply not present. Distinguishing this from DEAD is the whole
    # point - "never installed" and "installed but died" need different fixes.
    return 'ABSENT'
  }

  # ARM 'task': a registered, enabled scheduled task is a live dispatcher even though
  # it leaves NO resident process between firings. Without this arm the elevated
  # install - the better one - would be reported DEAD forever, and a permanently red
  # line is how a real finding gets skimmed.
  $taskHealthy = ([bool]$Unit.taskInstalled) -and
                 ($Unit.taskState -ne 'Disabled') -and
                 (($null -eq $Unit.taskLastRunMin) -or ([double]$Unit.taskLastRunMin -le $tolerance))

  # ARM 'process': a Startup-folder or Run-entry route is only alive while its process
  # is alive. This must be checked independently of the heartbeat, because a daemon
  # killed a minute ago still has a perfectly fresh heartbeat on disk.
  $daemonAlive = (([bool]$Unit.shimInstalled) -or ([bool]$Unit.runInstalled)) -and ([bool]$Unit.processAlive)

  # ARM 'fresh': alive is not the same as working. A daemon wedged inside its own
  # child call stays alive forever and stops beating, which is the failure the
  # heartbeat was written for.
  $daemonFresh = ($null -ne $Unit.signalAgeMin) -and ([double]$Unit.signalAgeMin -le $tolerance)

  # ARM 'paused': the tray is alive and beating but the user paused evaluations.
  # Surfaced as its own verdict so "paused" is never mistaken for "supervising".
  if ([bool]$Unit.paused -and $daemonAlive -and $daemonFresh) { return 'PAUSED' }

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
    $route = if ($u.runInstalled) { 'run' }
             elseif ($u.taskInstalled -and $u.shimInstalled) { 'task+startup' }
             elseif ($u.taskInstalled) { 'task' }
             elseif ($u.shimInstalled) { 'startup' }
             else { 'none' }
    if ($u.legacyInstalled) { $route += '+legacy' }
    $rows += [pscustomobject]@{
      name = $u.name; issue = $u.issue; purpose = $u.purpose; verdict = $verdict
      route = $route; pid = $u.processPid; signalAgeMin = $u.signalAgeMin; cadenceMin = $u.cadenceMin
    }
  }

  # OFF (not opted in) and PAUSED (user paused) are deliberate user states, not gaps.
  $bad = @($rows | Where-Object { $_.verdict -notin @('HEALTHY', 'OFF', 'PAUSED') })

  if ($Json) {
    [pscustomobject]@{ collectedUtc = $facts.collectedUtc; units = $rows; findings = $bad.Count } |
      ConvertTo-Json -Depth 6
  } else {
    foreach ($r in $rows) {
      $tag = switch ($r.verdict) {
        'HEALTHY' { '  ok      ' }
        'OFF'     { '  off     ' }
        'PAUSED'  { '  paused  ' }
        'STALE'   { '  DORMANT ' }
        'DEAD'    { '  DORMANT ' }
        'LEGACY'  { '  LEGACY  ' }
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
          'LEGACY' { "a retired pre-#689 scheduled task / Startup shim is still installed - remove it before using tray-owned checks" }
        }
        Write-Host ("[supervisor-liveness] {0} ({1}) {2}: {3}" -f $r.name, $r.issue, $r.verdict, $why)
      }
      Write-Host ''
      if (@($bad | Where-Object name -eq 'oa-supervisor').Count) {
        Write-Host '[supervisor-liveness] oa-supervisor REPAIR (opt-in tray, one HKCU Run route):'
        Write-Host '                      powershell -NoProfile -ExecutionPolicy Bypass -File plugins/overnight-agent/checks/install-oa-supervisor.ps1 -Enable'
        Write-Host '                      (or -Disable to opt out; both remove legacy leftovers. The tray supervises only while signed in.)'
      }
    } else {
      Write-Host "[supervisor-liveness] $($rows.Count) unit(s) checked; none dormant."
    }
  }

  exit ($(if ($bad.Count) { 1 } else { 0 }))
}
catch {
  Write-Error "[supervisor-liveness] sweep failed: $_"
  exit 2
}
