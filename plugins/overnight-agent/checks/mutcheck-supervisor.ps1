<#
  mutcheck-supervisor.ps1 - proves every arm of the #226 supervisor classifier is
  load-bearing, in the style the repo already uses for its other guards.

  A test suite that passes on broken code is worse than none, so this does not merely
  assert the happy path: it MUTATES the classifier one arm at a time and requires that
  exactly the fixture belonging to that arm starts failing. If a mutation changes
  nothing, the arm it broke was decoration and the check says so.

  Run: powershell -NoProfile -ExecutionPolicy Bypass -File mutcheck-supervisor.ps1
  Exit 0 = every arm proven load-bearing. Exit 1 = a mutation survived, or a fixture failed.
#>
[CmdletBinding()]
param([switch]$Json)

$ErrorActionPreference = 'Stop'
$now = [datetime]::Parse('2026-08-31T23:00:00Z', $null, [System.Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()

function New-Run([string]$status, [double]$ageMin) {
  [pscustomobject]@{ status = $status; started_at = $now.AddMinutes(-$ageMin).ToString('o') }
}

# The classifier under test, kept byte-identical in shape to oa-supervisor.ps1's copy.
# $script:Mutation names the arm to break, so each arm can be disabled independently.
function Invoke-Classifier {
  param([psobject]$NewestRun, [datetime]$Now, [int]$StuckMinutes, [int]$DeadMinutes, [bool]$AppRunning)

  if ($null -eq $NewestRun) {
    if ($script:Mutation -eq 'never-ran') { return 'HEALTHY' }
    return 'SCHEDULE-DEAD'
  }
  $started = [datetime]::Parse($NewestRun.started_at, $null, [System.Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
  $ageMin  = ($Now - $started).TotalMinutes

  if ($NewestRun.status -eq 'running') {
    if ($script:Mutation -eq 'stuck') { return 'HEALTHY' }          # arm 1 disabled
    if ($ageMin -gt $StuckMinutes) { return 'STUCK' }
    return 'HEALTHY'
  }
  if ($script:Mutation -eq 'dead') { return 'HEALTHY' }             # arm 2 disabled
  if ($ageMin -gt $DeadMinutes) { return 'SCHEDULE-DEAD' }
  return 'HEALTHY'
}

# --- fixtures: each is owned by exactly one arm -------------------------------------
$fixtures = @(
  @{ name = 'healthy-short-running'; run = (New-Run 'running'    7);  expect = 'HEALTHY';       owner = 'stuck' }
  @{ name = 'stuck-46-min';          run = (New-Run 'running'   46);  expect = 'STUCK';         owner = 'stuck' }
  @{ name = 'stuck-tonight-430-min'; run = (New-Run 'running'  430);  expect = 'STUCK';         owner = 'stuck' }
  @{ name = 'healthy-recent-done';   run = (New-Run 'completed'  12); expect = 'HEALTHY';       owner = 'dead'  }
  @{ name = 'healthy-one-missed';    run = (New-Run 'completed'  61); expect = 'HEALTHY';       owner = 'dead'  }
  @{ name = 'schedule-dead-91-min';  run = (New-Run 'completed'  91); expect = 'SCHEDULE-DEAD'; owner = 'dead'  }
  @{ name = 'schedule-dead-failed';  run = (New-Run 'failed'    600); expect = 'SCHEDULE-DEAD'; owner = 'dead'  }
  @{ name = 'never-ran';             run = $null;                     expect = 'SCHEDULE-DEAD'; owner = 'never-ran' }
)

function Test-All {
  $fails = @()
  foreach ($f in $fixtures) {
    $got = Invoke-Classifier -NewestRun $f.run -Now $now -StuckMinutes 45 -DeadMinutes 90 -AppRunning $true
    if ($got -ne $f.expect) { $fails += "$($f.name): expected $($f.expect), got $got" }
  }
  return ,$fails
}

$report = [ordered]@{}
$ok = $true

# 1. Baseline: unmutated classifier must pass every fixture.
$script:Mutation = ''
$baseline = Test-All
$report['baseline'] = @{ failures = $baseline.Count; detail = $baseline }
if ($baseline.Count -ne 0) { $ok = $false }

# 2. Each mutation must break ONLY its own fixtures - and must break at least one.
foreach ($arm in @('stuck', 'dead', 'never-ran')) {
  $script:Mutation = $arm
  $f = Test-All
  $owned    = @($f | Where-Object { $_ -match '^(?<n>[^:]+):' -and ($fixtures | Where-Object { $_.name -eq $Matches['n'] }).owner -eq $arm })
  $foreign  = @($f | Where-Object { $_ -match '^(?<n>[^:]+):' -and ($fixtures | Where-Object { $_.name -eq $Matches['n'] }).owner -ne $arm })
  $survived = ($f.Count -eq 0)
  $leaked   = ($foreign.Count -gt 0)
  $report[$arm] = @{ broke = $f.Count; ownFixtures = $owned.Count; foreignFixtures = $foreign.Count; survived = $survived }
  if ($survived) { $ok = $false; $report[$arm]['verdict'] = 'MUTATION SURVIVED - this arm is decoration' }
  elseif ($leaked) { $ok = $false; $report[$arm]['verdict'] = 'arm is entangled - it also broke another arm''s fixture' }
  else { $report[$arm]['verdict'] = 'load-bearing' }
}
$script:Mutation = ''

# 3. Anti-spam must not be able to silence a NEW incident. Suppression keyed on the
#    incident identity, so a different run id must always alert even while an older
#    one is inside its re-alert window. This is the arm that, done wrong, would
#    reintroduce exactly the blindness the supervisor exists to remove.
function Test-Suppression {
  param([string]$storedKey, [string]$incomingKey, [double]$minutesSinceAlert, [int]$reAlert = 240)
  if ($storedKey -eq $incomingKey -and $minutesSinceAlert -lt $reAlert) { return $false }  # suppressed
  return $true
}
$sup = @()
if (Test-Suppression -storedKey 'STUCK:A' -incomingKey 'STUCK:A' -minutesSinceAlert 10)  { $sup += 'same incident within window should be SUPPRESSED' }
if (-not (Test-Suppression -storedKey 'STUCK:A' -incomingKey 'STUCK:B' -minutesSinceAlert 10)) { $sup += 'a NEW incident must alert even inside the window' }
if (-not (Test-Suppression -storedKey 'STUCK:A' -incomingKey 'STUCK:A' -minutesSinceAlert 999)) { $sup += 'escalation re-alert must fire after the window' }
if (-not (Test-Suppression -storedKey $null -incomingKey 'STUCK:A' -minutesSinceAlert 0)) { $sup += 'first ever incident must alert' }
$report['anti-spam'] = @{ failures = $sup.Count; detail = $sup }
if ($sup.Count -ne 0) { $ok = $false }

# --- the ACTION arm: prove liveness-gated restart is load-bearing -------------------
# The classifier decides IF a run looks stuck; the action decides WHAT to do about it.
# The load-bearing property here is the one Shiv cares about: a live, still-working long
# run (flaggedOrphans = 0) must resolve to 'none' - never a restart. Each arm is mutated
# independently and must break only its own fixture.
function Invoke-Action {
  param([string]$State, [int]$FlaggedOrphans, [bool]$HasHungAlive, [bool]$AppRunning)
  switch ($State) {
    'STUCK' {
      if ($FlaggedOrphans -le 0) { if ($script:AMutation -eq 'live-longrun') { return 'restart' } return 'none' }
      if ($HasHungAlive)         { if ($script:AMutation -eq 'hung-restart') { return 'none' }    return 'restart' }
      if ($script:AMutation -eq 'orphan-repair') { return 'restart' }
      return 'repair-only'
    }
    'SCHEDULE-DEAD' {
      if ($AppRunning) { if ($script:AMutation -eq 'dead-app-up') { return 'none' } return 'restart' }
      if ($script:AMutation -eq 'dead-app-down') { return 'restart' } return 'launch'
    }
    default { return 'none' }
  }
}

$aFixtures = @(
  @{ name = 'live-longrun-untouched'; state = 'STUCK';         o = 0; h = $false; app = $true;  expect = 'none';        owner = 'live-longrun' }
  @{ name = 'hung-alive-restart';     state = 'STUCK';         o = 1; h = $true;  app = $true;  expect = 'restart';     owner = 'hung-restart' }
  @{ name = 'dead-orphan-repair';     state = 'STUCK';         o = 1; h = $false; app = $true;  expect = 'repair-only'; owner = 'orphan-repair' }
  @{ name = 'schedule-dead-app-up';   state = 'SCHEDULE-DEAD'; o = 0; h = $false; app = $true;  expect = 'restart';     owner = 'dead-app-up' }
  @{ name = 'schedule-dead-app-down'; state = 'SCHEDULE-DEAD'; o = 0; h = $false; app = $false; expect = 'launch';      owner = 'dead-app-down' }
  @{ name = 'healthy-none';           state = 'HEALTHY';       o = 0; h = $false; app = $true;  expect = 'none';        owner = 'healthy' }
)

function Test-AllActions {
  $fails = @()
  foreach ($f in $aFixtures) {
    $got = Invoke-Action -State $f.state -FlaggedOrphans $f.o -HasHungAlive $f.h -AppRunning $f.app
    if ($got -ne $f.expect) { $fails += "$($f.name): expected $($f.expect), got $got" }
  }
  return ,$fails
}

$script:AMutation = ''
$aBaseline = Test-AllActions
$report['action-baseline'] = @{ failures = $aBaseline.Count; detail = $aBaseline }
if ($aBaseline.Count -ne 0) { $ok = $false }

foreach ($arm in @('live-longrun', 'hung-restart', 'orphan-repair', 'dead-app-up', 'dead-app-down')) {
  $script:AMutation = $arm
  $f = Test-AllActions
  $foreign  = @($f | Where-Object { $_ -match '^(?<n>[^:]+):' -and ($aFixtures | Where-Object { $_.name -eq $Matches['n'] }).owner -ne $arm })
  $survived = ($f.Count -eq 0)
  $leaked   = ($foreign.Count -gt 0)
  $report["action:$arm"] = @{ broke = $f.Count; foreignFixtures = $foreign.Count; survived = $survived }
  if ($survived) { $ok = $false; $report["action:$arm"]['verdict'] = 'MUTATION SURVIVED - this arm is decoration' }
  elseif ($leaked) { $ok = $false; $report["action:$arm"]['verdict'] = 'arm is entangled - it also broke another arm''s fixture' }
  else { $report["action:$arm"]['verdict'] = 'load-bearing' }
}
$script:AMutation = ''

# ================================================================================
# THE READ PATH: prove the snapshot sees UNCHECKPOINTED commits (GH #348)
# ================================================================================
# Everything above tests the classifier's arithmetic. None of it can catch the defect
# that actually shipped, because that defect was upstream of the arithmetic: the
# supervisor snapshotted the app DB by copying `data.db` alone. The app runs SQLite in
# WAL mode, where a committed transaction sits in the `-wal` sidecar until a checkpoint
# folds it into the .db - so the copy read the database AS OF THE LAST CHECKPOINT and
# the classifier then did perfect arithmetic on stale input.
#
# Replaying 93 real supervisor ticks: 21 (23%) read stale, lag up to 97.6 min, 18
# alarms against runs that were actually healthy. STUCK is vetoed by stuck-run-sweep,
# but SCHEDULE-DEAD is not - it restarts the app - so a stale read alone can kill live
# sessions on a healthy machine.
#
# This section drives the REAL functions out of oa-supervisor.ps1 (not a shadow copy),
# against a real WAL-mode database whose newest row has deliberately NOT been
# checkpointed. Then it mutates a temp copy of the real script back to `.db`-only and
# requires that this fixture - and ONLY this fixture - starts failing.

$SUT = Join-Path $PSScriptRoot 'oa-supervisor.ps1'

# Builds a WAL-mode DB carrying the app's run schema and holds it open, exactly as the
# app does. The OLD run is checkpointed into the .db; the NEW run is committed and left
# in the -wal. A `.db`-only copy therefore sees a 100-min-old terminal run
# (=> SCHEDULE-DEAD => restart the app), while the truth is a 2-min-old run (=> HEALTHY).
$writerSrc = @'
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';
const [dbPath, readyFile, oldIso, newIso, holdMs] = process.argv.slice(2);
const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode=WAL');
db.exec('CREATE TABLE workflows (id INTEGER PRIMARY KEY, name TEXT)');
db.exec(`CREATE TABLE workflow_runs (
  id INTEGER PRIMARY KEY, task_id INTEGER, status TEXT, trigger TEXT,
  started_at TEXT, completed_at TEXT, error_message TEXT)`);
db.exec("INSERT INTO workflows (id, name) VALUES (1, 'Overnight Agent')");
db.prepare("INSERT INTO workflow_runs (task_id, status, trigger, started_at) VALUES (1,'completed','schedule',?)").run(oldIso);
// Fold everything so far into the .db, so the OLD row is what a .db-only copy sees.
db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
// This commit lives ONLY in the -wal until the app next checkpoints.
db.prepare("INSERT INTO workflow_runs (task_id, status, trigger, started_at) VALUES (1,'completed','schedule',?)").run(newIso);
writeFileSync(readyFile, 'ready');
// Hold the DB open like the app does, then self-terminate: a test must never need to
// kill a process it started.
setTimeout(() => process.exit(0), Number(holdMs));
'@

# Runs in a CHILD PowerShell so each dot-source of the SUT is isolated - a mutant must
# not be able to leak its function definitions into the baseline's session.
$runnerSrc = @'
param([string]$Supervisor, [string]$FixtureDb, [string]$NowIso, [string]$OutFile)
$ErrorActionPreference = 'Stop'
# NOTE: dot-sourcing runs the SUT's top-level assignments in THIS scope, and the SUT
# defines $Db as the live app database. Hold the fixture path under a name it cannot
# clobber, or this test silently measures the real machine instead of the fixture.
$probeDb = $FixtureDb
. $Supervisor
$now = [datetime]::Parse($NowIso, $null, [System.Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
$res = [ordered]@{}
try {
  $run = Get-NewestWorkflowRun -Db $probeDb -WorkflowName 'Overnight Agent'
  $v   = Get-SupervisorVerdict -NewestRun $run -Now $now -StuckMinutes 45 -DeadMinutes 90 -AppRunning $true
  $res['newestStarted'] = $run.started_at
  $res['state']  = $v.state
  $res['ageMin'] = $v.ageMin
  $res['action'] = Get-SupervisorAction -State $v.state -FlaggedOrphans 0 -HasHungAlive $false -AppRunning $true
} catch { $res['error'] = "$_" }
# The pure arms, evaluated through the REAL functions, so we can prove a read-path
# mutation does not disturb them.
$pure = @()
foreach ($f in @(
  @{ n = 'healthy-short-running'; s = 'running';   a = 7;   e = 'HEALTHY' },
  @{ n = 'stuck-46-min';          s = 'running';   a = 46;  e = 'STUCK' },
  @{ n = 'healthy-recent-done';   s = 'completed'; a = 12;  e = 'HEALTHY' },
  @{ n = 'schedule-dead-91-min';  s = 'completed'; a = 91;  e = 'SCHEDULE-DEAD' },
  @{ n = 'schedule-dead-failed';  s = 'failed';    a = 600; e = 'SCHEDULE-DEAD' }
)) {
  $r = [pscustomobject]@{ status = $f.s; started_at = $now.AddMinutes(-$f.a).ToString('o') }
  $g = (Get-SupervisorVerdict -NewestRun $r -Now $now -StuckMinutes 45 -DeadMinutes 90 -AppRunning $true).state
  if ($g -ne $f.e) { $pure += "$($f.n): expected $($f.e), got $g" }
}
$g = (Get-SupervisorVerdict -NewestRun $null -Now $now -StuckMinutes 45 -DeadMinutes 90 -AppRunning $true).state
if ($g -ne 'SCHEDULE-DEAD') { $pure += "never-ran: expected SCHEDULE-DEAD, got $g" }
foreach ($f in @(
  @{ n = 'live-longrun-untouched'; st = 'STUCK';         o = 0; h = $false; app = $true;  e = 'none' },
  @{ n = 'hung-alive-restart';     st = 'STUCK';         o = 1; h = $true;  app = $true;  e = 'restart' },
  @{ n = 'dead-orphan-repair';     st = 'STUCK';         o = 1; h = $false; app = $true;  e = 'repair-only' },
  @{ n = 'schedule-dead-app-up';   st = 'SCHEDULE-DEAD'; o = 0; h = $false; app = $true;  e = 'restart' },
  @{ n = 'schedule-dead-app-down'; st = 'SCHEDULE-DEAD'; o = 0; h = $false; app = $false; e = 'launch' },
  @{ n = 'healthy-none';           st = 'HEALTHY';       o = 0; h = $false; app = $true;  e = 'none' }
)) {
  $g = Get-SupervisorAction -State $f.st -FlaggedOrphans $f.o -HasHungAlive $f.h -AppRunning $f.app
  if ($g -ne $f.e) { $pure += "$($f.n): expected $($f.e), got $g" }
}
$res['pureFailures'] = @($pure)
($res | ConvertTo-Json -Depth 6) | Set-Content -Path $OutFile -Encoding UTF8
'@

$walRoot   = Join-Path $env:TEMP ('mutcheck-supervisor-wal-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $walRoot -Force | Out-Null
$writerFile = Join-Path $walRoot 'wal-writer.mjs'
$runnerFile = Join-Path $walRoot 'runner.ps1'
$writerSrc | Set-Content -Path $writerFile -Encoding UTF8
$runnerSrc | Set-Content -Path $runnerFile -Encoding UTF8

$walNow    = [datetime]::Parse('2026-09-01T12:00:00Z', $null, [System.Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
$oldRunIso = $walNow.AddMinutes(-100).ToString('o')   # stale: past DeadMinutes => SCHEDULE-DEAD
$newRunIso = $walNow.AddMinutes(-2).ToString('o')     # truth: well inside every threshold

# Each probe gets its own DB + writer, so nothing depends on two reads racing one holder.
function Invoke-WalProbe([string]$SupervisorPath, [string]$Tag) {
  $dir = Join-Path $walRoot $Tag
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
  $db    = Join-Path $dir 'data.db'
  $ready = Join-Path $dir 'ready.txt'
  $out   = Join-Path $dir 'result.json'
  Start-Process node -ArgumentList @($writerFile, $db, $ready, $oldRunIso, $newRunIso, 60000) -WindowStyle Hidden
  for ($i = 0; $i -lt 150 -and -not (Test-Path $ready); $i++) { Start-Sleep -Milliseconds 100 }
  if (-not (Test-Path $ready)) { return @{ error = 'wal fixture writer never became ready' } }
  if (-not (Test-Path ($db + '-wal'))) { return @{ error = 'fixture is not in WAL mode - no -wal sidecar' } }
  & powershell -NoProfile -ExecutionPolicy Bypass -File $runnerFile `
      -Supervisor $SupervisorPath -FixtureDb $db -NowIso $walNow.ToString('o') -OutFile $out | Out-Null
  if (-not (Test-Path $out)) { return @{ error = 'runner produced no result' } }
  return (Get-Content $out -Raw | ConvertFrom-Json)
}

# --- baseline: the real script must read the UNCHECKPOINTED row --------------------
$walBase   = Invoke-WalProbe -SupervisorPath $SUT -Tag 'baseline'
$walFails  = @()
if ($walBase.error) { $walFails += "baseline: $($walBase.error)" }
else {
  if ($walBase.newestStarted -ne $newRunIso) {
    $walFails += "snapshot missed the uncheckpointed commit: read $($walBase.newestStarted), expected $newRunIso"
  }
  if ($walBase.state -ne 'HEALTHY') {
    $walFails += "a 2-min-old run was classified $($walBase.state) (age believed $($walBase.ageMin) min)"
  }
  if ($walBase.action -ne 'none') { $walFails += "healthy run drove action '$($walBase.action)'" }
  if (@($walBase.pureFailures).Count -ne 0) { $walFails += "pure arms: $(@($walBase.pureFailures) -join '; ')" }
}
$report['wal-read-baseline'] = @{ failures = $walFails.Count; detail = $walFails }
if ($walFails.Count -ne 0) { $ok = $false }

# --- mutation: copy the .db WITHOUT its sidecars, i.e. the pre-#348 behaviour ------
# The mutant must be KILLED by the WAL fixture and must leave every other arm intact.
# That one-changed-one-failed asymmetry is what makes this test load-bearing rather
# than decorative.
$anchor  = "foreach (`$suffix in @('-wal', '-shm')) {"
$srcText = Get-Content $SUT -Raw
$mutFails = @()
if ($srcText -notmatch [regex]::Escape($anchor)) {
  $mutFails += "mutation anchor not found - this mutcheck is stale: '$anchor'"
} else {
  $mutant = Join-Path $walRoot 'oa-supervisor-mutant.ps1'
  ($srcText -replace [regex]::Escape($anchor), "foreach (`$suffix in @()) {") |
    Set-Content -Path $mutant -Encoding UTF8
  $walMut = Invoke-WalProbe -SupervisorPath $mutant -Tag 'mutant'
  if ($walMut.error) { $mutFails += "mutant run failed outright: $($walMut.error)" }
  else {
    # Killed = it now reads the stale row and misclassifies a healthy machine.
    if ($walMut.newestStarted -ne $oldRunIso) {
      $mutFails += 'MUTATION SURVIVED - dropping the sidecars changed nothing, so copying them is decoration'
    }
    if ($walMut.state -ne 'SCHEDULE-DEAD') {
      $mutFails += "mutant did not reach the dangerous verdict (got $($walMut.state)) - fixture no longer proves the harm"
    }
    if ($walMut.action -ne 'restart') {
      $mutFails += "mutant did not reach the unvetoed restart (got '$($walMut.action)')"
    }
    # ...and nothing else may move.
    if (@($walMut.pureFailures).Count -ne 0) {
      $mutFails += "read-path mutation leaked into the pure arms: $(@($walMut.pureFailures) -join '; ')"
    }
  }
}
$report['wal-read-mutation'] = @{ failures = $mutFails.Count; detail = $mutFails }
if ($mutFails.Count -ne 0) { $ok = $false }

Remove-Item $walRoot -Recurse -Force -ErrorAction SilentlyContinue

if ($Json) { ($report | ConvertTo-Json -Depth 6); }
else {
  foreach ($k in $report.Keys) {
    $v = $report[$k]
    $verdict = if ($v.verdict) { $v.verdict } elseif ($v.failures -eq 0) { 'pass' } else { "FAIL: $($v.detail -join '; ')" }
    "{0,-24} {1}" -f $k, $verdict
  }
}
if ($ok) { Write-Host "`nmutcheck-supervisor: PASS - all arms load-bearing."; exit 0 }
Write-Host "`nmutcheck-supervisor: FAIL"; exit 1
