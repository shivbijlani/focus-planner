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
    * Opens the app DB read-only. Arm 2 never writes.
    * Alerting is the default action. Killing a run mid-write is more dangerous than
      the stall, so repair is opt-in (-Repair) and is delegated to the existing
      sweep's own vetted guards rather than reimplemented here.
    * One incident produces ONE alert. A permanently-red channel trains the reader to
      skim it - that exact failure cost 11 hours of dead watchdog on 2026-08-27, when
      workflow-health-sweep flagged correctly in 16 consecutive runs and every one of
      them skimmed the line. Escalation re-alerts only after -ReAlertMinutes.
    * Never prints the bot token.

.PARAMETER StuckMinutes
  A run at status='running' older than this is STUCK. Default 45.
  Justified against measurement, not taste: the median healthy run is 7.7 min, so 45
  is ~6x median. 14 historical runs legitimately ran 61-364 min while still
  completing on their own - those SHOULD warn (a 364-min run froze ~11 ticks), so the
  threshold is deliberately below them rather than above.

.PARAMETER DeadMinutes
  No run of ANY status started within this window => SCHEDULE-DEAD. Default 90,
  i.e. three consecutive missed */30 ticks, so one skipped tick is never an alarm.

.PARAMETER Repair
  Opt-in. Passes --repair to stuck-run-sweep.mjs so an orphaned row is cleared.
  OFF by default.

.PARAMETER NoAlert
  Classify and log, but send nothing. For testing.

.PARAMETER TestAlert
  Send one unmistakably-labelled TEST message through the real alert path and exit.
  An alerting system that has never delivered a message is not known to work - that is
  the same "verified by nobody" gap this whole issue is about - so the path is testable
  on demand rather than only on a real outage.

.OUTPUTS
  One line of JSON on stdout. Exit 0 healthy, 1 alerted, 2 supervisor itself failed.
#>
[CmdletBinding()]
param(
  [int]$StuckMinutes   = 45,
  [int]$DeadMinutes    = 90,
  [int]$ReAlertMinutes = 240,
  [string]$WorkflowName = 'Overnight Agent',
  [switch]$Repair,
  [switch]$NoAlert,
  [switch]$TestAlert,
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

function Send-SupervisorAlert([string[]]$Lines) {
  $secret = Join-Path $OaHome 'secrets\telegram-secret.ps1'
  $token  = (& $secret get).Trim()
  if (-not $token) { throw 'no telegram token in the credential vault' }
  $body = @{
    chat_id = '-1004310604015'
    message_thread_id = 1767      # the sanctioned interrupt topic; deliberately NOT General
    text = ($Lines -join "`n")
    parse_mode = 'Markdown'
  } | ConvertTo-Json -Compress
  $null = Invoke-RestMethod -Method Post -Uri "https://api.telegram.org/bot$token/sendMessage" `
            -ContentType 'application/json; charset=utf-8' `
            -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 30
}

if ($TestAlert) {
  try {
    Send-SupervisorAlert @(
      '*TEST - no action needed*',
      '',
      'This is a one-off check that the Overnight Agent supervisor can reach you.',
      'From now on, if the agent gets stuck or stops running, a message like this arrives here instead of nothing happening at all.',
      'Nothing is wrong right now.'
    )
    ('{"state":"TEST-ALERT","alerted":true}')
    exit 0
  } catch {
    $m = "$_"; if ($m -match 'bot\d+:') { $m = 'telegram send failed (redacted)' }
    ('{"state":"TEST-ALERT","alerted":false,"error":"' + $m + '"}')
    exit 2
  }
}

if ($MyInvocation.InvocationName -eq '.') { return }   # dot-sourced by the mutcheck: expose functions only

# ---------------------------------------------------------------- read app state --
$newest = $null
$appRunning = [bool](Get-Process -Name 'copilot' -ErrorAction SilentlyContinue)

try {
  if (-not (Test-Path $Db)) { throw "app database not found at $Db" }

  # Read-only, via Node's built-in sqlite. Copy first: the app holds the DB open and a
  # WAL-mode reader can still trip on a concurrent checkpoint. A stale-by-seconds copy
  # is fine for a 15-minute supervisor and cannot corrupt the original.
  $tmp = Join-Path $env:TEMP ("oa-supervisor-{0}.db" -f [guid]::NewGuid().ToString('N'))
  Copy-Item $Db $tmp -Force
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
    $newest = $parsed.run
  } finally {
    Remove-Item $probeFile, $tmp -Force -ErrorAction SilentlyContinue
  }
} catch {
  $err = @{ state = 'SUPERVISOR-FAILED'; error = "$_" }
  Write-Log $err
  ($err | ConvertTo-Json -Compress)
  exit 2
}

$verdict = Get-SupervisorVerdict -NewestRun $newest -Now $NowUtc `
             -StuckMinutes $StuckMinutes -DeadMinutes $DeadMinutes -AppRunning $appRunning

# --------------------------------------------------- arm 1: reuse the existing sweep --
# Do not reimplement orphan detection - dispatch the vetted one from out here.
$sweepResult = 'skipped'
if ($verdict.state -eq 'STUCK') {
  $sweep = Join-Path $PSScriptRoot 'stuck-run-sweep.mjs'
  if (-not (Test-Path $sweep)) { $sweep = Join-Path $OaHome 'stuck-run-sweep.mjs' }
  if (Test-Path $sweep) {
    try {
      $args = @($sweep); if ($Repair) { $args += '--repair' }
      $out = & node @args 2>&1 | Out-String
      $sweepResult = ($out -split "`n" | Where-Object { $_ -match 'FLAGGED|repaired|ok\s' } | Select-Object -First 3) -join ' | '
    } catch { $sweepResult = "sweep-failed: $_" }
  } else { $sweepResult = 'sweep-not-found' }
}

# ------------------------------------------------------------------ anti-spam state --
# An incident is keyed by (state + the run it is about). A NEW incident must always be
# able to alert even if an older one was suppressed, or suppression would reintroduce
# the very blindness this script exists to remove.
$incidentKey = '{0}:{1}' -f $verdict.state, ($(if ($newest) { $newest.started_at } else { 'none' }))
$state = @{}
if (Test-Path $StatePath) {
  try { $state = Get-Content $StatePath -Raw | ConvertFrom-Json -AsHashtable } catch { $state = @{} }
}

$shouldAlert = $false
if ($verdict.state -ne 'HEALTHY') {
  $shouldAlert = $true
  if ($state.incidentKey -eq $incidentKey -and $state.lastAlertUtc) {
    $since = ($NowUtc - [datetime]::Parse($state.lastAlertUtc, $null, [System.Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()).TotalMinutes
    if ($since -lt $ReAlertMinutes) { $shouldAlert = $false }
  }
}

# ------------------------------------------------------------------------- alerting --
$alertSent = $false
$alertError = $null
if ($shouldAlert -and -not $NoAlert) {
  try {
    $lines = @(
      "*Overnight Agent supervisor*",
      "",
      "State: *$($verdict.state)*",
      $verdict.detail,
      ""
    )
    if ($verdict.state -eq 'STUCK') {
      $lines += "The scheduled run has been stuck. While it is stuck, every following run is refused, so the agent is doing nothing."
      $lines += "Fix: restart the app (that is what has ended all 18 previous stalls), or run the supervisor with -Repair."
    } elseif ($verdict.state -eq 'SCHEDULE-DEAD') {
      $lines += "The agent has not started a run recently. It is not working on anything."
      $lines += "Fix: open the app; the schedule resumes on its own."
    }
    Send-SupervisorAlert $lines
    $alertSent = $true
  } catch {
    $alertError = "$_"    # never surface the token; only the failure shape
    if ($alertError -match 'bot\d+:') { $alertError = 'telegram send failed (redacted)' }
  }
}

if ($alertSent) {
  $state.incidentKey  = $incidentKey
  $state.lastAlertUtc = $NowUtc.ToString('o')
  try {
    if (-not (Test-Path $OaHome)) { New-Item -ItemType Directory -Path $OaHome -Force | Out-Null }
    ($state | ConvertTo-Json -Depth 6) | Set-Content -Path $StatePath -Encoding utf8
  } catch { }
}

$result = @{
  state       = $verdict.state
  detail      = $verdict.detail
  ageMin      = $verdict.ageMin
  lastStatus  = $(if ($newest) { $newest.status } else { $null })
  lastStarted = $(if ($newest) { $newest.started_at } else { $null })
  appRunning  = $appRunning
  alerted     = $alertSent
  alertError  = $alertError
  suppressed  = ($verdict.state -ne 'HEALTHY' -and -not $shouldAlert)
  sweep       = $sweepResult
  thresholds  = @{ stuckMin = $StuckMinutes; deadMin = $DeadMinutes; reAlertMin = $ReAlertMinutes }
}
Write-Log $result
($result | ConvertTo-Json -Compress -Depth 6)

if ($verdict.state -eq 'HEALTHY') { exit 0 } else { exit 1 }
