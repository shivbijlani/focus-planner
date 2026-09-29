<#
  mutcheck-dead-session-verdict.ps1 -- proves a dead CLI process reads `replace` (#728).

  The session binding is persistent state and can still say `live` after its CLI exits. This
  check runs the real oa-state.ps1 against isolated task state and synthetic session-state
  directories. It requires both a dead `inuse.<pid>.lock` owner and an old events.jsonl before
  replacing, and mutates each of those safeguards to prove they matter.
#>
[CmdletBinding()]
param([string]$ScriptPath)

$ErrorActionPreference = 'Stop'
if (-not $ScriptPath) { $ScriptPath = Join-Path $PSScriptRoot 'oa-state.ps1' }
if (-not (Test-Path $ScriptPath)) { throw "oa-state.ps1 not found at $ScriptPath" }

$script:PsExe = if ($PSVersionTable.PSEdition -eq 'Core') { (Get-Process -Id $PID).Path } else { 'powershell' }
if (-not $script:PsExe) { $script:PsExe = 'pwsh' }
$script:Root = Join-Path ([IO.Path]::GetTempPath()) ("oa-dead-session-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
$script:JournalDir = Join-Path $script:Root 'journal'
$script:Board = Join-Path $script:Root 'planner.md'
$script:Store = Join-Path $script:Root 'snooze.json'
$utf8 = [Text.UTF8Encoding]::new($false)
New-Item -ItemType Directory -Path $script:JournalDir -Force | Out-Null
[IO.File]::WriteAllText((Join-Path $script:JournalDir 'task-900.md'), @'
# Task 900: synthetic

User notes.

---
<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->

## Overnight Agent

<!-- from: overnight-agent -->

**Status:** In-progress - plan v1
'@, $utf8)
[IO.File]::WriteAllText($script:Board, "## Today`n`n| ID | Task |`n|---|---|`n| 900 | synthetic |`n", $utf8)
[IO.File]::WriteAllText($script:Store, '{}', $utf8)

$script:DeadPid = [int]::MaxValue
function New-Fixture {
  $id = [guid]::NewGuid().ToString()
  $stateDir = Join-Path $script:Root ("state-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
  $sessionStateDir = Join-Path $script:Root ("session-state-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
  New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
  New-Item -ItemType Directory -Path $sessionStateDir -Force | Out-Null
  $state = [ordered]@{
    id = '900'
    status = 'in-progress'
    status_by = 'agent'
    version = 1
    updated = '2026-09-01T12:00:00Z'
    session = [ordered]@{
      session_id = $id
      kind = 'chat'
      project = ''
      workspace = ''
      workspace_type = ''
      created_at = '2026-09-01T12:00:00Z'
      last_woken_at = ''
      state = 'live'
      prior_session_id = ''
      replaced_at = ''
    }
  }
  [IO.File]::WriteAllText((Join-Path $stateDir 'task-900.json'),
    ($state | ConvertTo-Json -Depth 8), $utf8)
  $sessionDir = Join-Path $sessionStateDir $id
  New-Item -ItemType Directory -Path $sessionDir -Force | Out-Null
  return [pscustomobject]@{
    id = $id
    stateDir = $stateDir
    sessionStateDir = $sessionStateDir
    sessionDir = $sessionDir
  }
}

function Get-Session {
  param($Fixture, [string]$Build, [string[]]$Action = @('session', '-Id', '900'))
  $args = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $Build) + $Action +
    @(
    '-JournalDir', $script:JournalDir, '-StateDir', $Fixture.stateDir,
    '-SessionStateDir', $Fixture.sessionStateDir, '-PlannerBoard', $script:Board, '-SnoozeStore', $script:Store)
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { $out = & $script:PsExe @args 2>&1 }
  finally { $ErrorActionPreference = $old }
  $script:LastCommandOutput = ($out -join "`n")
  if ($LASTEXITCODE -ne 0 -or -not $out) { return $null }
  try { return (($out -join "`n") | ConvertFrom-Json) } catch { return $null }
}

function Test-AliveMarkRefused {
  param([string]$Build)
  $fixture = New-Fixture
  Add-Lock $fixture $PID
  Add-Events $fixture 20
  $dead = Get-Session $fixture $Build @('session', '-Id', '900', '-SessionDead')
  $after = Get-Session $fixture $Build
  if ($dead -or "$($after.verdict)" -ne 'reuse' -or "$($after.state)" -ne 'live') {
    return 'E_idle-alive: a silent session with a live host must refuse -SessionDead and remain reusable'
  }
  return $null
}

function Test-ReplacementCount {
  param([string]$Build)
  $fixture = New-Fixture
  $statePath = Join-Path $fixture.stateDir 'task-900.json'
  $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
  $old = [datetimeoffset]::UtcNow.AddHours(-25).ToString('o')
  $recent = [datetimeoffset]::UtcNow.AddMinutes(-84).ToString('o')
  Add-Member -InputObject $state -NotePropertyName session_replacements -NotePropertyValue @(
    [pscustomobject]@{ session_id = 'old'; at = $old },
    [pscustomobject]@{ session_id = 'previous'; at = $recent }
  )
  [IO.File]::WriteAllText($statePath, ($state | ConvertTo-Json -Depth 8), $utf8)
  $row = @(Get-Session $fixture $Build @('scan') | Where-Object { "$($_.id)" -eq '900' })
  if ($row.Count -ne 1 -or $row[0].replacements_24h -ne 1) {
    return 'F_rolling-window: scan must count only the replacement within 24 hours'
  }
  $marked = Get-Session $fixture $Build @('session', '-Id', '900', '-SessionDead')
  $markOutput = $script:LastCommandOutput
  $bind = Get-Session $fixture $Build @('session', '-Id', '900', '-SessionId', ([guid]::NewGuid().ToString()),
    '-SessionKind', 'code', '-SessionProject', 'focus-planner', '-SessionWorkspace', $fixture.sessionDir,
    '-WorkspaceType', 'branch', '-RunWorkspace', $script:Root)
  $script:LastBindError = $script:LastCommandOutput
  $row = @(Get-Session $fixture $Build @('scan') | Where-Object { "$($_.id)" -eq '900' })
  if ($row.Count -ne 1 -or $row[0].replacements_24h -ne 2) {
    return "F_rolling-window: binding a replacement must increment the 24-hour count (mark=$($marked.state), markOutput=$markOutput, bind=$($bind.verdict), count=$($row[0].replacements_24h), error=$($script:LastBindError))"
  }
  $compact = Get-Session $fixture $Build @('scan', '-Compact')
  $compactRow = @($compact.rows | Where-Object { "$($_.id)" -eq '900' })
  if ($compactRow.Count -ne 1 -or $compactRow[0].replacements_24h -ne 2) {
    return 'F_rolling-window: compact scan must retain a churned task and its count'
  }
  return $null
}

function Add-Lock {
  param($Fixture, [int]$PidValue)
  [IO.File]::WriteAllText((Join-Path $Fixture.sessionDir "inuse.$PidValue.lock"), '', $utf8)
}

function Add-Events {
  param($Fixture, [int]$AgeMinutes, [switch]$RoutineShutdown)
  $path = Join-Path $Fixture.sessionDir 'events.jsonl'
  $event = if ($RoutineShutdown) { '{"type":"session.shutdown","data":{"shutdownType":"routine"}}' }
    else { '{"type":"assistant.turn_start"}' }
  [IO.File]::WriteAllText($path, $event + "`n", $utf8)
  if ($AgeMinutes -gt 0) {
    $item = Get-Item -LiteralPath $path
    $item.LastWriteTimeUtc = [datetime]::UtcNow.AddMinutes(-$AgeMinutes)
  }
}

function Test-OneCase {
  param([string]$Build, [string]$Case)
  $fixture = New-Fixture
  switch ($Case) {
    'A_dead-stale' {
      Add-Lock $fixture $script:DeadPid
      Add-Events $fixture 20
    }
    'B_live-owner' {
      Add-Lock $fixture $PID
      Add-Events $fixture 20
    }
    'C_recent-events' {
      Add-Lock $fixture $script:DeadPid
      Add-Events $fixture 0
    }
    'D_missing-events' { Add-Lock $fixture $script:DeadPid }
    'G_routine-shutdown' {
      Add-Lock $fixture $script:DeadPid
      Add-Events $fixture 20 -RoutineShutdown
    }
  }
  $result = Get-Session $fixture $Build
  switch ($Case) {
    'A_dead-stale' {
      if ("$($result.verdict)" -ne 'replace' -or "$($result.process_dead)" -ne 'True') {
        return 'A_dead-stale: a dead lock owner and stale events must read replace'
      }
    }
    'B_live-owner' {
      if ("$($result.verdict)" -ne 'reuse' -or "$($result.process_dead)" -ne 'False') {
        return 'B_live-owner: a live lock owner must remain reusable'
      }
    }
    'C_recent-events' {
      if ("$($result.verdict)" -ne 'reuse' -or "$($result.process_dead)" -ne 'False') {
        return 'C_recent-events: a recent event must prevent replacement'
      }
    }
    'D_missing-events' {
      if ("$($result.verdict)" -ne 'reuse' -or "$($result.process_dead)" -ne 'False') {
        return 'D_missing-events: a missing event log is not proof of staleness'
      }
    }
    'G_routine-shutdown' {
      if ("$($result.verdict)" -ne 'reuse' -or "$($result.process_dead)" -ne 'False') {
        return 'G_routine-shutdown: an idle resumable CLI must not read replace'
      }
    }
  }
  return $null
}

function Test-Cases {
  param([string]$Build)
  $failures = @()
  foreach ($case in 'A_dead-stale', 'B_live-owner', 'C_recent-events', 'D_missing-events', 'G_routine-shutdown') {
    $failure = Test-OneCase $Build $case
    if ($failure) { $failures += $failure }
  }
  $failures += @(Test-AliveMarkRefused $Build | Where-Object { $_ })
  $failures += @(Test-ReplacementCount $Build | Where-Object { $_ })
  return $failures
}

$Source = (Get-Content -Raw $ScriptPath) -replace "`r`n", "`n"
$mutants = @(
  @{
    Name = 'M1_no-dead-process-replacement'
    Expect = 'A_dead-stale'
    Find = "  if (`$sessionProcessDead) { return 'replace' }"
    Replace = '  if ($false) { return ''replace'' }'
  }
  @{
    Name = 'M2_ignore-event-freshness'
    Expect = 'C_recent-events'
    Find = '  if ((Get-Item -LiteralPath $eventsPath -ErrorAction Stop).LastWriteTimeUtc -gt $staleBefore) { return $false }'
    Replace = '  if ($false) { return $false }'
  }
  @{
    Name = 'M3_ignore-live-lock-owner'
    Expect = 'B_live-owner'
    Find = '      if (-not $process.HasExited) { return $false }'
    Replace = '      if ($false) { return $false }'
  }
  @{
    Name = 'M4_mark-live-session-dead'
    Expect = 'E_idle-alive'
    Find = '    if (Test-SessionProcessAlive "$($sess.session_id)") {'
    Replace = '    if ($false) {'
  }
  @{
    Name = 'M5_drop-replacement-count'
    Expect = 'F_rolling-window'
    Find = '      replacements_24h = (Get-Replacements24h $st)'
    Replace = '      replacements_24h = 0'
  }
  @{
    Name = 'M6_routine-shutdown-means-dead'
    Expect = 'G_routine-shutdown'
    Find = '  if ("$($lastEvent.type)" -eq ''session.shutdown'' -and "$($lastEvent.data.shutdownType)" -eq ''routine'') {'
    Replace = '  if ($false) {'
  }
)

Write-Host ''
Write-Host 'mutcheck-dead-session-verdict -- GH #728 and #761 liveness and replacement count'
Write-Host ''

$baseline = Test-Cases $ScriptPath
if ($baseline.Count) {
  foreach ($failure in $baseline) { Write-Host "  FAIL  baseline  $failure" -ForegroundColor Red }
  exit 1
}
Write-Host '  [baseline] OK -- dead+stale=>replace, idle-alive=>reuse, rolling replacements counted'

$survived = @()
foreach ($mutant in $mutants) {
  if (-not $Source.Contains($mutant.Find)) {
    Write-Host "  [ERROR  ] $($mutant.Name) target not found" -ForegroundColor Red
    $survived += $mutant.Name
    continue
  }
  $mutated = $Source.Replace($mutant.Find, $mutant.Replace)
  if ($mutated -eq $Source) {
    Write-Host "  [ERROR  ] $($mutant.Name) did not change source" -ForegroundColor Red
    $survived += $mutant.Name
    continue
  }
  $path = Join-Path $script:Root ($mutant.Name + '.ps1')
  [IO.File]::WriteAllText($path, $mutated, $utf8)
  $failure = switch ($mutant.Expect) {
    'E_idle-alive' { Test-AliveMarkRefused $path }
    'F_rolling-window' { Test-ReplacementCount $path }
    default { Test-OneCase $path $mutant.Expect }
  }
  $failures = if ($failure) { @($failure) } else { @() }
  if (@($failures | Where-Object { $_ -like "$($mutant.Expect)*" }).Count -gt 0) {
    Write-Host "  [KILLED ] $($mutant.Name) by $($mutant.Expect)"
  } else {
    Write-Host "  [SURVIVED] $($mutant.Name) expected $($mutant.Expect); got: $($failures -join '; ')" -ForegroundColor Red
    $survived += $mutant.Name
  }
}
if ($survived.Count) { exit 1 }
Write-Host ''
Write-Host '  All declared mutations killed.'
Remove-Item -LiteralPath $script:Root -Recurse -Force
