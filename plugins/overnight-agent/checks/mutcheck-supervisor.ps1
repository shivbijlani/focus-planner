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
