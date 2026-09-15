<#
  The parked-capacity safety property (#487/#500/#541), now measured against execution (#589).

  Old tests treated readiness, due timers and one-shot wake stamps as evidence of execution.
  Those fixtures encoded the deadlock itself. Keep every parked/timer/doc/status shape, but
  supply the missing independent fact: IDLE occupies zero; BUSY occupies one, even when its
  journal says paused/done. Unknown activity is charged and visible, never silently free.

  Selection/ask/timer/pause guards remain in their dedicated mutation suites. This suite tests
  the actual capacity reader and mutates it, including reinstating the due-before-start bug.
  Every path is isolated, including settings; no live planner/state/app data is accessed.
#>
[CmdletBinding()]
param([string]$ScriptPath)
$ErrorActionPreference = 'Stop'
if (-not $ScriptPath) { $ScriptPath = Join-Path $PSScriptRoot 'oa-state.ps1' }
$source = [IO.File]::ReadAllText($ScriptPath) -replace "`r`n", "`n"
$psExe = if ($PSVersionTable.PSEdition -eq 'Core') { (Get-Process -Id $PID).Path } else { 'powershell' }
$root = Join-Path ([IO.Path]::GetTempPath()) ('parked-capacity-' + [guid]::NewGuid().ToString('N'))
$pass = 0; $fail = 0
New-Item -ItemType Directory -Path $root | Out-Null

function Check([string]$name, [bool]$condition) {
  if ($condition) { $script:pass++; Write-Host "PASS $name" }
  else { $script:fail++; Write-Host "FAIL $name" }
}

function New-World([string]$name, [string]$status = 'in-progress', [string]$shape = '') {
  $dir = Join-Path $root $name
  $stateDir = Join-Path $dir 'state'; $journalDir = Join-Path $dir 'journal'
  New-Item -ItemType Directory -Path $stateDir, $journalDir -Force | Out-Null
  $state = [ordered]@{
    id = '901'; status = $status; status_by = 'user'; version = 1
    session = @{ session_id = 'S-901'; state = 'live'; last_woken_at = '2026-09-06T16:16:00-07:00' }
  }
  if ($shape -eq 'unbound') { $state.session = $null }
  if ($shape -eq 'recent-wake') { $state.session.last_woken_at = [datetimeoffset]::UtcNow.ToString('o') }
  $timer = @{ cadence = 'daily'; interval_minutes = 1440; next_due = '2026-01-01T00:00:00Z' }
  if ($shape -eq 'poll') { $state.poll = $timer }
  if ($shape -eq 'recheck') { $state.recheck = $timer }
  if ($shape -like 'doc-*') {
    $state.doc = @{
      doc_id = 'fixture'; pending_ids = @()
      observed_at = if ($shape -eq 'doc-stale') { '2026-01-01T00:00:00Z' }
        elseif ($shape -eq 'doc-never') { '' } else { [datetimeoffset]::UtcNow.ToString('o') }
    }
    if ($shape -eq 'doc-comments') { $state.doc.pending_ids = @('comment-1') }
  }
  $statePath = Join-Path $stateDir 'task-901.json'
  $state | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $statePath -Encoding utf8
  $moon = [char]::ConvertFromUtf32(0x1F319)
  $journal = "# Task 901: fixture`n`n## $moon Overnight Agent`n<!-- from: overnight-agent -->`n"
  $ask = if ($shape -in @('awaiting', 'reply', 'poll', 'recheck')) { 'blocking' } else { 'none' }
  $journal += "<!-- oa-ask: $ask -->`n**Needs from you:** please confirm.`n<!-- /overnight-agent turn-end -->`n"
  if ($shape -eq 'reply') { $journal += "<!-- from: me -->`nPlease continue.`n" }
  if ($shape -ne 'no-journal') {
    Set-Content -LiteralPath (Join-Path $journalDir 'task-901.md') -Value $journal -Encoding utf8
  }
  if ($shape -eq 'corrupt') { Set-Content -LiteralPath $statePath -Value '{broken' -Encoding utf8 }
  if ($shape -eq 'alias') {
    $state.id = '902'; $state.session.session_id = 'S-902'
    $state | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $stateDir 'task-902.json') -Encoding utf8
  }
  return @{ State = $stateDir; Journal = $journalDir; Path = $statePath; Shape = $shape }
}

function Measure-CapacityFixture([string]$script, $world, [string]$activity = 'idle') {
  $snapshotPath = Join-Path (Split-Path $world.State -Parent) 'activity.json'
  $sessions = @()
  if ($activity -ne 'missing') {
    $sessions += @{ binding_id = 'S-901'; session_id = 'execution'; status = $(if ($activity -eq 'stale') { 'idle' } else { $activity }) }
    if ($world.Shape -eq 'alias') { $sessions += @{ binding_id = 'S-902'; session_id = 'execution'; status = $activity } }
  }
  @{
    schema_version = 1; source = 'copilot-app'; sessions = $sessions; receipts = @()
    observed_at = if ($activity -eq 'stale') { '2026-01-01T00:00:00Z' } else { [datetimeoffset]::UtcNow.ToString('o') }
  } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $snapshotPath -Encoding utf8
  $args = @('-NoProfile', '-NonInteractive', '-File', $script, 'session', '-InFlight',
    '-StateDir', $world.State, '-JournalDir', $world.Journal, '-ActivitySnapshot', $snapshotPath,
    '-UserSettings', (Join-Path $root 'absent-settings.md'))
  $out = & $psExe @args
  if ($LASTEXITCODE -ne 0) { throw 'Capacity reader failed; a crash is not a mutation kill.' }
  return ($out | ConvertFrom-Json)
}

try {
  $worlds = @{}
  foreach ($status in @('in-progress', 'done', 'skip', 'blocked', 'proposed')) {
    $worlds[$status] = New-World $status $status
  }
  foreach ($shape in @('awaiting', 'reply', 'poll', 'recheck', 'doc-fresh', 'doc-stale', 'doc-never',
      'doc-comments', 'recent-wake', 'no-journal', 'unbound', 'corrupt', 'alias')) {
    $worlds[$shape] = New-World $shape 'in-progress' $shape
  }
  foreach ($key in $worlds.Keys) {
    $world = $worlds[$key]
    $hash = (Get-FileHash -LiteralPath $world.Path).Hash
    foreach ($activity in @('idle', 'busy')) {
      $result = Measure-CapacityFixture $ScriptPath $world $activity
      $expected = if ($key -eq 'unbound') { 0 } elseif ($key -eq 'corrupt' -or $activity -eq 'busy') { 1 } else { 0 }
      Check "$key / $activity occupies $expected" ($result.in_flight -eq $expected)
    }
    Check "$key preserves the persisted task" ((Get-FileHash -LiteralPath $world.Path).Hash -eq $hash)
  }
  foreach ($activity in @('unknown', 'missing', 'stale')) {
    $result = Measure-CapacityFixture $ScriptPath $worlds['in-progress'] $activity
    Check "$activity is charged, visible, and refuses admission" `
      ($result.in_flight -eq 1 -and $result.admits -eq 0 -and $result.requires_attention -and $result.members[0].reason)
  }

  $mutants = @(
    @{ Name = 'busy-not-counted'; World = 'in-progress'; Activity = 'busy'; Want = 1
      Find = "holds_capacity = [bool](`$status -eq 'busy' -or `$unknown)"
      Replace = 'holds_capacity = [bool]$unknown' },
    @{ Name = 'idle-counted'; World = 'awaiting'; Activity = 'idle'; Want = 0
      Find = "holds_capacity = [bool](`$status -eq 'busy' -or `$unknown)"
      Replace = 'holds_capacity = $true' },
    @{ Name = 'unknown-freed'; World = 'no-journal'; Activity = 'unknown'; Want = 1
      Find = "holds_capacity = [bool](`$status -eq 'busy' -or `$unknown)"
      Replace = "holds_capacity = [bool](`$status -eq 'busy')" },
    @{ Name = 'due-counted-before-start'; World = 'poll'; Activity = 'idle'; Want = 0
      Find = '        $member.binding_ids = @($member.binding_ids + $bindingId | Select-Object -Unique)'
      Replace = "        `$member.binding_ids = @(`$member.binding_ids + `$bindingId | Select-Object -Unique)`n        if (Test-PollDue `$state.poll) { `$member.holds_capacity = `$true }" },
    @{ Name = 'binding-counted-instead-of-execution'; World = 'alias'; Activity = 'busy'; Want = 1
      Find = '        $key = if ($activity) { "$($activity.session_id)" } else { $bindingId }'
      Replace = '        $key = $bindingId' },
    @{ Name = 'stale-snapshot-trusted'; World = 'in-progress'; Activity = 'stale'; Want = 1
      Find = "if (`$age -lt 0 -or `$age -gt `$script:ActivitySnapshotSeconds) { throw 'activity snapshot is stale or future-dated' }"
      Replace = "if (`$false) { throw 'activity snapshot is stale or future-dated' }" }
  )
  foreach ($mutant in $mutants) {
    if (-not $source.Contains($mutant.Find)) { throw "Mutation did not apply: $($mutant.Name)" }
    $mutantPath = Join-Path $root "$($mutant.Name).ps1"
    [IO.File]::WriteAllText($mutantPath, $source.Replace($mutant.Find, $mutant.Replace), [Text.UTF8Encoding]::new($true))
    $result = Measure-CapacityFixture $mutantPath $worlds[$mutant.World] $mutant.Activity
    Check "mutation killed: $($mutant.Name)" ($result.in_flight -ne $mutant.Want)
  }
  Write-Host "$pass passed, $fail failed; 6 capacity mutants exercised."
}
finally { Remove-Item -LiteralPath $root -Recurse -Force }
if ($fail) { exit 1 }
