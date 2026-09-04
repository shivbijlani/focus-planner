<#
.SYNOPSIS
  The Overnight Agent's OUT-OF-BAND supervisor. Dispatched by Windows Task Scheduler,
  never by an agent run.

.DESCRIPTION
  WHY THIS EXISTS (GH #226)
  -------------------------
  Every supervisory mechanism this system has is dispatched by the thing it would
  need to supervise:

      reap-stale-mcp.ps1   -> SKILL.md PHASE 0        -> inside an agent run
      run-sweeps.ps1 (52)  -> SKILL.md                -> inside an agent run
      stuck-run-sweep.mjs  -> run-sweeps.ps1          -> inside an agent run
      Browser watchdog     -> the app scheduler       -> the same scheduler
      Overnight Agent      -> the app scheduler       -> the thing being supervised

  Measured on this machine 2026-08-31: OS-level scheduled tasks supervising any of
  it = 0. So "the agent stopped running" is unobservable from inside the agent.

  THE COST, MEASURED - not estimated (1,222 real runs in the app's own store)
  --------------------------------------------------------------------------
    median healthy run                                       7.7 min
    runs that occupied the */30 slot for > 60 min            32
    of those, ended ONLY by 'Interrupted by app shutdown'    18  = 314.8 h (13.1 d)
    of those, slow but self-terminating                      14  =  25.7 h
    worst single stall  2026-07-10 -> 2026-07-14             5,463 min (182 ticks)
    same-day recurrence on 2026-08-31 alone                  3 (82, 104, 430 min)

  Not one of the 18 was ended by anything noticing. A human restarting the app ended
  all 18. That is this issue in one line.

  WHAT THIS ADDS, AND WHAT IT DELIBERATELY DOES NOT REIMPLEMENT
  -------------------------------------------------------------
  `stuck-run-sweep.mjs` already detects an orphaned/hung run and can repair it
  (`--repair`), using a liveness signal (`inuse.<pid>.lock`) that is provably safe
  for the live run executing it. That logic is good and is NOT duplicated here.
  Its only defect is WHERE IT IS DISPATCHED FROM. So arm 1 simply runs it from
  outside the failure domain.

  Arm 2 is the check `stuck-run-sweep` is structurally incapable of making. It
  inspects rows at status='running'; if the app is closed, or a run was accepted and
  never started, there is no such row and nothing new is written - the table just
  goes quiet. Silence is indistinguishable from health to any detector that only
  reads rows. Arm 2 therefore dates the NEWEST run of any status and alarms on
  absence, which is the F1/F6 failure the issue names.

  SAFETY POSTURE
  --------------
    * Opens the app DB read-only for classification.
    * ACTS instead of alerting (Shiv, 2026-08-31: "it should act, restart ghcp - don't
      message me"). The remedy is a silent app restart, GATED ON LIVENESS, not age: a run
      is only restarted when stuck-run-sweep proves it is a genuine orphan (owning process
      dead) or hung-alive (its own log says the task finished, then went silent). A run
      that is merely long but still emitting events is NEVER touched - that is the
      false-positive class that used to page a healthy 40-min run (GH #296).
    * The row is cleared with the existing vetted sweep (--repair) BEFORE any restart, so
      the schedule can resume even if the relaunch does not reconcile it. A restart is
      only added on top when there is a live process to reclaim (hung-alive) or the
      scheduler itself is wedged (schedule-dead while the app is up).
    * One incident drives at most one restart per -RestartCooldownMinutes, so a bad state
      cannot become a reboot loop.
    * Fully silent: no Telegram, ever. Every decision is still written to supervisor-log.jsonl.

.PARAMETER StuckMinutes
  A run at status='running' older than this is STUCK. Default 45.
  Justified against measurement, not taste: the median healthy run is 7.7 min, so 45
  is ~6x median. 14 historical runs legitimately ran 61-364 min while still
  completing on their own - those SHOULD warn (a 364-min run froze ~11 ticks), so the
  threshold is deliberately below them rather than above.

.PARAMETER DeadMinutes
  No run of ANY status started within this window => SCHEDULE-DEAD. Default 90,
  i.e. three consecutive missed */30 ticks, so one skipped tick is never an alarm.

.PARAMETER RestartCooldownMinutes
  Do not restart the same incident more than once inside this window. Default 20, so a
  state that keeps looking stuck cannot drive a reboot loop.

.PARAMETER NoAct
  Classify, run the sweep in DETECT-ONLY mode, and log the decision, but never kill or
  launch anything. The safe mode for testing and replay.

.PARAMETER Repair, NoAlert, TestAlert
  LEGACY and inert. Alerting was removed in favour of silent auto-restart, but these are
  still accepted so an already-registered task or daemon that passes them keeps parsing.

.OUTPUTS
  One line of JSON on stdout. Exit 0 = healthy / no action, 1 = acted (or would act under
  -NoAct), 2 = supervisor itself failed.
#>
[CmdletBinding()]
param(
  [int]$StuckMinutes   = 45,
  [int]$DeadMinutes    = 90,
  [int]$ReAlertMinutes = 240,
  # Don't restart the same incident more than once inside this window (anti-loop).
  [int]$RestartCooldownMinutes = 20,
  [string]$WorkflowName = 'Overnight Agent',
  # Detect + log only; never kill or launch anything. For testing/replay.
  [switch]$NoAct,
  # LEGACY and inert: alerting was removed in favour of silent auto-restart
  # (Shiv, 2026-08-31). Retained only so an already-registered task/daemon that
  # still passes them keeps parsing.
  [switch]$Repair,
  [switch]$NoAlert,
  [switch]$TestAlert,
  # Replay a recorded resource sample instead of measuring the machine (GH #403).
  # The mutation harness drives the REAL classifier in this file through this parameter, so
  # what is proven load-bearing is the shipped code rather than a copy of it that can drift --
  # mutcheck-supervisor.ps1 predates this and reimplements the classifier, which is exactly the
  # weakness this avoids.
  [string]$ResourceFactsJson,
  [switch]$Json
)

$ErrorActionPreference = 'Stop'

$OaHome    = Join-Path $env:LOCALAPPDATA 'overnight-agent'
$StatePath = Join-Path $OaHome 'supervisor-state.json'
$LogPath   = Join-Path $OaHome 'supervisor-log.jsonl'
$Db        = Join-Path $env:USERPROFILE '.copilot\data.db'
$NowUtc    = (Get-Date).ToUniversalTime()

function Write-Log([hashtable]$Record) {
  try {
    if (-not (Test-Path $OaHome)) { New-Item -ItemType Directory -Path $OaHome -Force | Out-Null }
    $Record['ts'] = $NowUtc.ToString('o')
    ($Record | ConvertTo-Json -Compress -Depth 6) | Add-Content -Path $LogPath -Encoding utf8
  } catch { }   # logging must never be the reason supervision fails
}

# --- the classifier is a pure function of (newest run, now) so it is unit-testable ---
function Get-SupervisorVerdict {
  param(
    [psobject]$NewestRun,      # $null when the workflow has never run
    [datetime]$Now,
    [int]$StuckMinutes,
    [int]$DeadMinutes,
    [bool]$AppRunning
  )

  if ($null -eq $NewestRun) {
    return @{ state = 'SCHEDULE-DEAD'; detail = 'no run has ever been recorded for this workflow'; ageMin = $null }
  }

  $started = [datetime]::Parse($NewestRun.started_at, $null, [System.Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
  $ageMin  = [math]::Round(($Now - $started).TotalMinutes, 1)

  # A run still marked 'running' is the slot holder. If it has held the slot past the
  # threshold, every subsequent tick is being refused - that is the 18-incident class.
  if ($NewestRun.status -eq 'running') {
    if ($ageMin -gt $StuckMinutes) {
      return @{ state = 'STUCK'; detail = "run has held the slot for $ageMin min (threshold $StuckMinutes)"; ageMin = $ageMin }
    }
    return @{ state = 'HEALTHY'; detail = "run in progress, $ageMin min"; ageMin = $ageMin }
  }

  # Terminal newest row + nothing newer started => the schedule itself has gone quiet.
  # This is the arm stuck-run-sweep cannot have: there is no 'running' row to inspect.
  if ($ageMin -gt $DeadMinutes) {
    $why = if ($AppRunning) { 'app is running but the schedule is not firing' } else { 'the app is not running' }
    return @{ state = 'SCHEDULE-DEAD'; detail = "no run started in $ageMin min (threshold $DeadMinutes) - $why"; ageMin = $ageMin }
  }

  return @{ state = 'HEALTHY'; detail = "last run started $ageMin min ago, status $($NewestRun.status)"; ageMin = $ageMin }
}

# --- the RESOURCE detector: a second, independent verdict (GH #403) -------------------
#
# WHY THIS EXISTS
# ---------------
# Every state the schedule classifier above can reach is derived from the run slot, so
# "the app is responsive and runs are starting on time" was the entire definition of
# healthy. A process that is responsive AND eating a quarter of the machine satisfies it
# completely. Measured on shiv-devbox 2026-09-02, while Shiv reported the machine
# unusable: CPU pinned at 100%, processor queue length 21 on 4 cores, disk 99% idle --
# and the app's own WebView2 renderer plus GPU helper had burned 7.05 CPU-hours in 14.7
# hours of uptime, about 48% of one core continuously since boot. The supervisor logged
# `"state":"HEALTHY","action":"none"` throughout. It reached STUCK three times that day
# and correctly recorded `action: none` each time, because the owning process was alive:
# it saw the symptom and had no way to say "this live run is pathologically expensive
# rather than merely slow".
#
# THE HARD PART IS NOT THE RESTART, IT IS DEFINING "LEAKING" SO IT CANNOT FIRE ON A
# HEALTHY MACHINE UNDER LEGITIMATE LOAD. Three independent conditions must hold at once,
# and each exists to refuse a specific false positive:
#
#   1. SUSTAINED, not instantaneous. The rate is accumulated CPU-hours per wall-hour of
#      PROCESS AGE, so a brief legitimate burst -- a build, a test run, a video call --
#      cannot reach the threshold no matter how hard it spikes. Keying on instantaneous
#      CPU is the obvious wrong implementation and has its own mutation arm.
#   2. THE MACHINE IS ACTUALLY CONTENDED. Processor queue length is the metric that
#      tracked the felt sluggishness (21 when bad, 0 after remediation). Expensive work
#      on a machine that is keeping up is not a fault; it is a machine doing its job.
#   3. IT IS OUR TREE. Only the app's own WebView2 family is attributable. Restarting the
#      app cannot fix somebody else's compiler, so a foreign hog is reported and never
#      acted on.
#
# AGE IS DELIBERATELY NOT A CONDITION. #178 recorded that age-only heuristics kill
# legitimate work, and Shiv keeps interactive sessions open for hours. A long-lived
# process with a low rate is healthy and must stay HEALTHY; that has its own arm too.
function Get-ResourceVerdict {
  param(
    [psobject]$Sample,              # $null when sampling failed or was skipped
    [double]$LeakCpuRatio = 0.35,   # CPU-hours burned per wall-hour of process age
    [int]$QueueThreshold = 8        # runnable threads waiting; 4-core box reads 0 when healthy
  )

  # Sampling failure is NOT health. A detector that cannot look must not report the same
  # bytes as one that looked and found nothing (#346), so it says so and stays out of the
  # way of the schedule verdict rather than silently voting HEALTHY.
  if ($null -eq $Sample) {
    return @{ state = 'RESOURCE-UNKNOWN'; detail = 'resource sampling unavailable'; ratio = $null; queue = $null }
  }

  $queue = [double]$Sample.queueLength
  $ratio = if ([double]$Sample.appAgeHours -gt 0) {
    [math]::Round(([double]$Sample.appCpuHours / [double]$Sample.appAgeHours), 3)
  } else { 0 }

  $detail = "app tree {0} CPU-h over {1} h uptime (rate {2}), queue {3}" -f `
    [math]::Round([double]$Sample.appCpuHours, 2), [math]::Round([double]$Sample.appAgeHours, 1), $ratio, $queue

  # Condition 2 first, so a contended machine is required before anything is called a leak.
  if ($queue -lt $QueueThreshold) {
    return @{ state = 'HEALTHY'; detail = "machine keeping up - $detail"; ratio = $ratio; queue = $queue }
  }
  # Condition 1: sustained cost, not a spike.
  if ($ratio -lt $LeakCpuRatio) {
    return @{ state = 'RESOURCE-CONTENDED'; detail = "contended but not attributable to the app - $detail"; ratio = $ratio; queue = $queue }
  }
  return @{ state = 'RESOURCE-LEAK'; detail = $detail; ratio = $ratio; queue = $queue }
}

# Measure the machine. Kept separate from the classifier so the classifier stays pure and
# replayable, and so a sampling failure degrades to $null rather than throwing the tick away.
function Get-ResourceSample {
  try {
    # Processor queue length: the metric that actually tracked the felt sluggishness.
    $queue = 0
    try {
      $q = Get-Counter '\System\Processor Queue Length' -ErrorAction Stop
      $queue = [double]$q.CounterSamples[0].CookedValue
    } catch { return $null }   # cannot measure contention -> cannot judge -> RESOURCE-UNKNOWN

    # The app's own WebView2 tree, identified the way the app itself names it. Attribution
    # matters: restarting the app cannot fix a foreign process, so only our tree counts.
    $procs = @(Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" -ErrorAction Stop |
      Where-Object { "$($_.CommandLine)" -match '--webview-exe-name=github\.exe' })
    if (-not $procs) { return @{ queueLength = $queue; appCpuHours = 0; appAgeHours = 0; procCount = 0 } }

    $cpuSec = 0.0
    $oldest = [datetime]::MaxValue
    foreach ($p in $procs) {
      $perf = Get-CimInstance Win32_PerfFormattedData_PerfProc_Process -Filter "IDProcess=$($p.ProcessId)" -ErrorAction SilentlyContinue
      $ps = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue
      if ($ps) { $cpuSec += [double]$ps.CPU }
      $start = $p.CreationDate
      if ($start -and $start -lt $oldest) { $oldest = $start }
    }
    $ageH = if ($oldest -ne [datetime]::MaxValue) { ($NowUtc - $oldest.ToUniversalTime()).TotalHours } else { 0 }
    return @{ queueLength = $queue; appCpuHours = ($cpuSec / 3600.0); appAgeHours = $ageH; procCount = $procs.Count }
  } catch { return $null }
}

# --- the ACTION is a pure function of (state, orphan findings, app-running) ----------
# Kept side-effect-free so mutcheck-supervisor.ps1 can prove each arm is load-bearing.
function Get-SupervisorAction {
  param(
    [string]$State,
    [int]$FlaggedOrphans,   # genuine orphans the sweep found (STUCK only)
    [bool]$HasHungAlive,    # at least one orphan is a LIVE, leaked process
    [bool]$AppRunning
  )
  switch ($State) {
    'STUCK' {
      if ($FlaggedOrphans -le 0) { return 'none' }     # live, still-progressing long run
      if ($HasHungAlive)         { return 'restart' }  # leaked live process: only a restart reclaims it
      return 'repair-only'                              # process already dead: sweep --repair unblocked it
    }
    'SCHEDULE-DEAD' {
      if ($AppRunning) { return 'restart' }             # app up but scheduler wedged
      return 'launch'                                   # app down: just bring it back
    }
    # GH #403. The condition the supervisor is already trusted to fix, for a fault it could
    # not previously name. It ADDS a trigger and relaxes no guard: the caller applies the
    # same `-RestartCooldownMinutes` anti-loop, so a persistent leak cannot become a restart
    # loop. Gated on the app running, because there is nothing to restart otherwise -- and
    # notably NOT on the run slot, since the whole point is that the schedule looked fine.
    'RESOURCE-LEAK' {
      if ($AppRunning) { return 'restart' }
      return 'none'
    }
    # Contended, but not attributable to our tree. Reported so the next investigation does
    # not start from zero, never acted on: restarting the app cannot fix somebody else's
    # process, and acting on an unattributable signal is how a detector earns being ignored.
    'RESOURCE-CONTENDED' { return 'none' }
    default { return 'none' }                           # HEALTHY / unknown
  }
}

# --- the DB read path: snapshot then read, kept as functions so the mutcheck can drive
# --- the REAL code rather than a shadow copy of it -----------------------------------

# Snapshot the app's SQLite database for read-only inspection.
#
# The app holds the live DB open, and a WAL-mode reader can still trip on a concurrent
# checkpoint, so we deliberately read a copy rather than the original. The copy MUST
# include the -wal (and -shm) sidecars: in WAL mode a committed transaction lives in
# the -wal file until a checkpoint folds it into the .db, so copying the .db alone
# yields the database AS OF THE LAST CHECKPOINT, not as of now (GH #348).
#
# Measured cost of getting this wrong, replaying 93 real supervisor ticks: 21 (23%)
# read stale, lag up to 97.6 min, and 18 alarms fired against runs that were healthy.
# That matters because SCHEDULE-DEAD has no liveness veto - it restarts the app - so a
# stale read alone could kill live sessions on a perfectly healthy machine.
#
# SQLite recovers the WAL when it opens the copy, so the snapshot reads as of NOW.
function Copy-DbSnapshot {
  param([string]$Source, [string]$Destination)
  Copy-Item $Source $Destination -Force
  foreach ($suffix in @('-wal', '-shm')) {
    $sidecar = $Source + $suffix
    if (Test-Path $sidecar) { Copy-Item $sidecar ($Destination + $suffix) -Force }
  }
}

# Newest run of any status for $WorkflowName, read out of a snapshot of $Db.
# Returns $null when the workflow exists but has never run; throws otherwise.
function Get-NewestWorkflowRun {
  param([string]$Db, [string]$WorkflowName)

  $tmp = Join-Path $env:TEMP ("oa-supervisor-{0}.db" -f [guid]::NewGuid().ToString('N'))
  Copy-DbSnapshot -Source $Db -Destination $tmp
  $probe = @'
import { DatabaseSync } from 'node:sqlite';
const [dbPath, wfName] = process.argv.slice(2);
const db = new DatabaseSync(dbPath, { readOnly: true });
const wf = db.prepare('SELECT id FROM workflows WHERE name = ?').get(wfName);
if (!wf) { console.log(JSON.stringify({ error: 'workflow-not-found' })); process.exit(0); }
// NOTE: the FK column in workflow_runs is `task_id`, not `workflow_id`; and
// workflows.last_run_at is not maintained for every trigger path, so date from runs.
const r = db.prepare(
  'SELECT status, trigger, started_at, completed_at, error_message FROM workflow_runs WHERE task_id = ? ORDER BY started_at DESC LIMIT 1'
).get(wf.id);
console.log(JSON.stringify({ run: r ?? null }));
'@
  $probeFile = Join-Path $env:TEMP ("oa-supervisor-probe-{0}.mjs" -f [guid]::NewGuid().ToString('N'))
  $probe | Out-File -FilePath $probeFile -Encoding utf8
  try {
    $raw = & node $probeFile $tmp $WorkflowName 2>&1
    if ($LASTEXITCODE -ne 0) { throw "probe failed: $raw" }
    $parsed = $raw | ConvertFrom-Json
    if ($parsed.error) { throw "workflow '$WorkflowName' not found in $Db" }
    return $parsed.run
  } finally {
    # sqlite creates -wal/-shm sidecars next to the copy; deleting only the .db leaks
    # two files per invocation, which at a 15-minute cadence is ~200 files a day.
    Remove-Item $probeFile -Force -ErrorAction SilentlyContinue
    foreach ($suffix in @('', '-wal', '-shm')) {
      Remove-Item ($tmp + $suffix) -Force -ErrorAction SilentlyContinue
    }
  }
}

# The app we supervise is the desktop GUI process 'github.exe'; its children are the
# 'copilot.exe --server' backends. Resolve its exe from the live process when we can
# (survives version bumps), else the stable per-user install path.
function Resolve-AppExe {
  $p = Get-Process -Name 'github' -ErrorAction SilentlyContinue |
         Where-Object { $_.Path } | Select-Object -First 1
  if ($p -and $p.Path) { return $p.Path }
  $stable = Join-Path $env:LOCALAPPDATA 'Programs\GitHub Copilot\github.exe'
  if (Test-Path $stable) { return $stable }
  return $null
}

# Kill the app process tree (GUI + server backends) by explicit PID, then relaunch it.
function Restart-App {
  $exe = Resolve-AppExe
  $killed = @()
  foreach ($name in @('github', 'copilot')) {
    foreach ($proc in (Get-Process -Name $name -ErrorAction SilentlyContinue)) {
      try { Stop-Process -Id $proc.Id -Force -ErrorAction Stop; $killed += "$name#$($proc.Id)" } catch { }
    }
  }
  Start-Sleep -Seconds 3
  $launched = $false
  if ($exe) { try { Start-Process -FilePath $exe | Out-Null; $launched = $true } catch { } }
  return @{ exe = $exe; killed = $killed; launched = $launched }
}

# Schedule-dead with the app DOWN: nothing to kill, just launch it.
function Start-App {
  $exe = Resolve-AppExe
  $launched = $false
  if ($exe) { try { Start-Process -FilePath $exe | Out-Null; $launched = $true } catch { } }
  return @{ exe = $exe; killed = @(); launched = $launched }
}

if ($TestAlert) {
  # Alerting was removed in favour of silent auto-restart; keep the flag inert so an old
  # caller does not error, but do nothing and say so in the machine-readable line.
  ('{"state":"TEST-ALERT","acted":false,"note":"alerting removed - supervisor now acts silently"}')
  exit 0
}

if ($MyInvocation.InvocationName -eq '.') { return }   # dot-sourced by the mutcheck: expose functions only

# ---------------------------------------------------------------- read app state --
$newest = $null
$appRunning = [bool](Get-Process -Name 'copilot' -ErrorAction SilentlyContinue)

try {
  if (-not (Test-Path $Db)) { throw "app database not found at $Db" }
  $newest = Get-NewestWorkflowRun -Db $Db -WorkflowName $WorkflowName
} catch {
  $err = @{ state = 'SUPERVISOR-FAILED'; error = "$_" }
  Write-Log $err
  ($err | ConvertTo-Json -Compress)
  exit 2
}

$verdict = Get-SupervisorVerdict -NewestRun $newest -Now $NowUtc `
             -StuckMinutes $StuckMinutes -DeadMinutes $DeadMinutes -AppRunning $appRunning

# ------------------------------------------------ arm 1: reuse the vetted sweep -------
# Never reimplement orphan detection. When the run LOOKS stuck by age, ask stuck-run-sweep
# for the truth: it distinguishes a live, still-working run (leave alone) from a genuine
# orphan, and further splits orphans into process-dead vs hung-alive (a finished run whose
# live process leaked). In act mode we pass --repair so a genuine orphan's row is cleared
# regardless of whether we then restart.
$sweepResult    = 'skipped'
$flaggedOrphans = 0
$hasHungAlive   = $false
if ($verdict.state -eq 'STUCK') {
  $sweep = Join-Path $PSScriptRoot 'stuck-run-sweep.mjs'
  if (-not (Test-Path $sweep)) { $sweep = Join-Path $OaHome 'stuck-run-sweep.mjs' }
  if (Test-Path $sweep) {
    try {
      $sweepArgs = @($sweep)
      if (-not $NoAct) { $sweepArgs += '--repair' }   # detect-only under -NoAct
      $out = & node @sweepArgs 2>&1 | Out-String
      $m = [regex]::Match($out, 'orphaned runs blocking their workflow:\s*(\d+)')
      if ($m.Success) { $flaggedOrphans = [int]$m.Groups[1].Value }
      $hasHungAlive = ($out -match 'hung-alive')
      $sweepResult  = ($out -split "`n" | Where-Object { $_ -match 'FLAGGED|repaired|ok\s|arm\s' } | Select-Object -First 4) -join ' | '
    } catch { $sweepResult = "sweep-failed: $_" }
  } else { $sweepResult = 'sweep-not-found' }
}

$action = Get-SupervisorAction -State $verdict.state -FlaggedOrphans $flaggedOrphans `
            -HasHungAlive $hasHungAlive -AppRunning $appRunning

# --------------------------------------------- arm 2: the resource detector (GH #403) --
# Sampled EVERY tick and recorded in supervisor-log.jsonl regardless of verdict, so a future
# investigation reads history instead of being done by hand at 100% CPU, which is how #403
# was found in the first place.
#
# The schedule verdict wins when it already has something to say: it is the older, vetted
# signal and it carries the orphan/liveness veto. The resource verdict only takes over when
# the schedule says HEALTHY -- which is exactly the blind spot, since the machine was
# unusable while the schedule looked perfect.
$resSample = $null
if ($ResourceFactsJson) {
  if (-not (Test-Path $ResourceFactsJson)) { Write-Error "resource facts file not found: $ResourceFactsJson"; exit 2 }
  $resSample = [IO.File]::ReadAllText($ResourceFactsJson, (New-Object Text.UTF8Encoding($false))) | ConvertFrom-Json
} else {
  $resSample = Get-ResourceSample
}
$resVerdict = Get-ResourceVerdict -Sample $resSample

if ($verdict.state -eq 'HEALTHY' -and $resVerdict.state -ne 'HEALTHY') {
  $verdict = @{ state = $resVerdict.state; detail = $resVerdict.detail; ageMin = $verdict.ageMin }
  $action = Get-SupervisorAction -State $resVerdict.state -FlaggedOrphans 0 `
              -HasHungAlive $false -AppRunning $appRunning
}

# ---------------------------------------------------------------- anti-loop cooldown --
# One incident (state + the run it is about) may drive at most one restart per cooldown,
# so a state that keeps looking stuck cannot become a reboot loop.
$incidentKey = '{0}:{1}' -f $verdict.state, ($(if ($newest) { $newest.started_at } else { 'none' }))
$state = @{}
if (Test-Path $StatePath) {
  try { $state = Get-Content $StatePath -Raw | ConvertFrom-Json -AsHashtable } catch { $state = @{} }
}
$onCooldown = $false
if ($action -in @('restart','launch') -and $state.lastActionKey -eq $incidentKey -and $state.lastActionUtc) {
  $since = ($NowUtc - [datetime]::Parse($state.lastActionUtc, $null, [System.Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()).TotalMinutes
  if ($since -lt $RestartCooldownMinutes) { $onCooldown = $true }
}

# ----------------------------------------------------------------------- act (silent) --
$acted     = $false
$actResult = $null
$actError  = $null
if ($action -in @('restart','launch') -and -not $onCooldown -and -not $NoAct) {
  try {
    $actResult = if ($action -eq 'restart') { Restart-App } else { Start-App }
    $acted = [bool]$actResult.launched
    if (-not $acted) { $actError = 'app exe not found or relaunch failed' }
  } catch {
    $actError = "$_"
  }
  # Record the incident so the cooldown holds even if the relaunch itself failed - a
  # failing restart must not become a hot loop.
  $state.lastActionKey = $incidentKey
  $state.lastActionUtc = $NowUtc.ToString('o')
  try {
    if (-not (Test-Path $OaHome)) { New-Item -ItemType Directory -Path $OaHome -Force | Out-Null }
    ($state | ConvertTo-Json -Depth 6) | Set-Content -Path $StatePath -Encoding utf8
  } catch { }
}

$result = @{
  state          = $verdict.state
  detail         = $verdict.detail
  ageMin         = $verdict.ageMin
  lastStatus     = $(if ($newest) { $newest.status } else { $null })
  lastStarted    = $(if ($newest) { $newest.started_at } else { $null })
  appRunning     = $appRunning
  action         = $action
  acted          = $acted
  actResult      = $actResult
  actError       = $actError
  onCooldown     = $onCooldown
  noAct          = [bool]$NoAct
  flaggedOrphans = $flaggedOrphans
  hasHungAlive   = $hasHungAlive
  sweep          = $sweepResult
  # GH #403: recorded on EVERY tick, not only when it fires, so the history exists before
  # the next investigation needs it.
  resource       = @{
    state       = $resVerdict.state
    detail      = $resVerdict.detail
    cpuRatio    = $resVerdict.ratio
    queueLength = $resVerdict.queue
    sampled     = [bool]($null -ne $resSample)
    replayed    = [bool]$ResourceFactsJson
  }
  thresholds     = @{ stuckMin = $StuckMinutes; deadMin = $DeadMinutes; restartCooldownMin = $RestartCooldownMinutes }
}
Write-Log $result
($result | ConvertTo-Json -Compress -Depth 6)

if ($action -eq 'none') { exit 0 } else { exit 1 }
