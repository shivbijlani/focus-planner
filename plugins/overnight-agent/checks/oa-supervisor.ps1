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
    * GH #648 adds an independent preventive lifecycle. A=12 hours opens a quiet
      opportunity window; B=24 hours forces a restart even while BUSY or UNKNOWN.
      These are configurable implementation defaults, not user-selected values.
    * Before B, every restart trigger requires freshly observed all-session quiet
      time and an immediate recheck. No admission hold exists: this is best-effort.
      Completion of one run, or silence during a tool, is never global idle proof.
    * B permits interruption, not unrelated process termination. Only the exact
      configured GUI instance and creation-time-proven descendants are targeted.
    * Durable cycle/attempt state, an exclusive tick lock, bounded failed-recovery
      backoff and separate readiness/resumption observations survive supervisor crashes.
    * Workflow enabled flags and schedules are never changed. Row-only stuck-run
      repair is quiet-gated; it is not a request to restart all session hosts.
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
  Minimum uptime for fault-triggered quiet restarts. Default 20 minutes. This is
  fault-only spacing, not a global Y: preventive restarts use A; B overrides it.

.PARAMETER OaHome
  State, logs and supervisor-config.json directory. Defaults to the flat deployed
  OA home. Code/defaults are resolved beside this script, not from the data directory.

.PARAMETER NoAct
  Classify, run the sweep in DETECT-ONLY mode, and log the decision, but never kill or
  launch anything. The safe mode for testing and replay.

.PARAMETER Repair, NoAlert, TestAlert
  LEGACY and inert. Alerting was removed in favour of silent auto-restart, but these are
  still accepted so an already-registered task or daemon that passes them keeps parsing.

.OUTPUTS
  One JSON line with nextCheckUtc. Exit 0 = no action, 1 = action, 2 = failed recovery
  or supervisor error. Launch, responsive-window readiness and observed work/schedule
  recovery are distinct fields; a launch is not a success claim.
#>
[CmdletBinding()]
param(
  [string]$OaHome = (Join-Path $env:LOCALAPPDATA 'overnight-agent'),
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

$StatePath = Join-Path $OaHome 'supervisor-state.json'
$LogPath   = Join-Path $OaHome 'supervisor-log.jsonl'
$Db        = Join-Path $env:USERPROFILE '.copilot\data.db'
$NowUtc    = (Get-Date).ToUniversalTime()

function Write-Log([hashtable]$Record) {
  try {
    if (-not (Test-Path $OaHome)) { New-Item -ItemType Directory -Path $OaHome -Force | Out-Null }
    $Record['ts'] = $NowUtc.ToString('o')
    ($Record | ConvertTo-Json -Compress -Depth 20) | Add-Content -Path $LogPath -Encoding utf8
  } catch { Write-Warning "supervisor log write failed: $_" }
}

. (Join-Path $PSScriptRoot 'oa-supervisor-lifecycle.ps1')

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

  $started = ConvertTo-SupervisorUtc $NewestRun.started_at
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
    $raw = & node --disable-warning=ExperimentalWarning $probeFile $tmp $WorkflowName 2>&1
    if ($LASTEXITCODE -ne 0) { throw "probe failed: $raw" }
    $parsed = ConvertFrom-SupervisorJson ($raw -join "`n")
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

if ($TestAlert) {
  # Alerting was removed in favour of silent auto-restart; keep the flag inert so an old
  # caller does not error, but do nothing and say so in the machine-readable line.
  ('{"state":"TEST-ALERT","acted":false,"note":"alerting removed - supervisor now acts silently"}')
  exit 0
}

if ($MyInvocation.InvocationName -eq '.') { return }   # dot-sourced by the mutcheck: expose functions only

# An OS-held exclusive handle, not a PID lock: crashes release it automatically and
# simultaneous Task Scheduler/Startup/manual ticks cannot double-restart the app.
$lock = $null
try {
  if (-not (Test-Path $OaHome)) { New-Item -ItemType Directory -Path $OaHome -Force | Out-Null }
  try {
    $lock = [IO.File]::Open((Join-Path $OaHome 'supervisor-tick.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
  } catch [IO.IOException] {
    if (($_.Exception.HResult -band 0xffff) -notin @(32,33)) { throw }
    $result = @{ state = 'TICK-BUSY'; action = 'none'; acted = $false; nextCheckUtc = $NowUtc.AddSeconds(10).ToString('o') }
  }
  if ($lock) { $result = Invoke-RestartTick }
} catch {
  $result = @{ state = 'SUPERVISOR-FAILED'; action = 'none'; acted = $false; error = "$_"; nextCheckUtc = (Get-Date).ToUniversalTime().AddSeconds(60).ToString('o') }
} finally { if ($lock) { $lock.Dispose() } }
Write-Log $result
($result | ConvertTo-Json -Compress -Depth 20)
if ($result.state -eq 'SUPERVISOR-FAILED' -or $result.error) { exit 2 }
if ($result.action -ne 'none') { exit 1 }
exit 0
