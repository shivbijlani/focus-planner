[CmdletBinding()]
param([string]$ScriptPath = (Join-Path $PSScriptRoot 'oa-state.ps1'))

$ErrorActionPreference = 'Stop'
if (-not (Test-Path $ScriptPath)) { throw "oa-state target not found at $ScriptPath" }
. (Join-Path (Split-Path -Parent $ScriptPath) 'oa-state-target.ps1')
$script:OaCmd = Get-OaStateCommand $ScriptPath
$root = Join-Path ([IO.Path]::GetTempPath()) ('oa-busy-' + [guid]::NewGuid().ToString('N'))
$state = Join-Path $root 'state'
$journal = Join-Path $root 'journal'
$board = Join-Path $root 'planner.md'
$statusFile = Join-Path $root 'sessions.json'
$scanFile = Join-Path $root 'scan.json'
$ledger = Join-Path $root 'ledger.jsonl'
$utf8 = [Text.UTF8Encoding]::new($false)
$ids = @(468, 228, 476, 464, 370, 423, 329, 405, 374, 289, 175, 353, 399, 400)

function Invoke-State([string]$script, [string[]]$arguments) {
  $cmd = Get-OaStateCommand $script
  $output = & $cmd.Exe @($cmd.Prefix + $arguments + @(
      '-StateDir', $state, '-JournalDir', $journal,
      '-PlannerBoard', $board, '-PlannerCompleted', (Join-Path $root 'completed.md'),
      '-SnoozeStore', (Join-Path $root 'snooze.json'), '-UserSettings', (Join-Path $root 'settings.md'))) 2>&1
  return [pscustomobject]@{ Exit = $LASTEXITCODE; Text = ($output | Out-String -Width 4096) }
}

function Check-Scenario([string]$script, [string]$tag) {
  $scan = Invoke-State $script @('scan', '-Compact', '-SessionsStatusFile', $statusFile)
  if ($scan.Exit -ne 0) { throw "scan failed: $($scan.Text)" }
  $result = $scan.Text | ConvertFrom-Json
  $busy = @($result.rows | Where-Object id -eq '468')[0]
  $next = @($result.rows | Where-Object id -eq '228')[0]
  $other = @($result.rows | Where-Object { $_.id -notin @('468', '228') })
  $selection = @($result.rows | Where-Object {
    $_.eligible -and -not $_.dispatch_skip_reason
  } | Select-Object -First 1)[0]
  $scanOk = $result.summary.rows_eligible -eq 14 -and $busy.eligible -and
    $busy.session_activity -eq 'busy' -and $busy.dispatch_skip_reason -eq 'busy_from_earlier_run' -and
    $next.session_activity -eq 'idle' -and $next.eligible -and
    $other.Count -eq 12 -and $selection.id -eq '228'

  $blocked = Invoke-State $script @('session', '-Id', '468', '-ForDispatch',
    '-SessionsStatusFile', $statusFile, '-DispatchInput', $busy.dispatch_input)
  $busyState = Get-Content -LiteralPath (Join-Path $state 'task-468.json') -Raw | ConvertFrom-Json
  $busyOk = $blocked.Exit -ne 0 -and $blocked.Text -match 'busy_from_earlier_run' -and
    -not $busyState.session.last_woken_at
  $allowed = Invoke-State $script @('session', '-Id', '228', '-ForDispatch',
    '-SessionsStatusFile', $statusFile, '-DispatchInput', $next.dispatch_input)
  $nextOk = $allowed.Exit -eq 0 -and ($allowed.Text | ConvertFrom-Json).dispatch_authorised

  [IO.File]::WriteAllText($scanFile, $scan.Text, $utf8)
  $record = Invoke-State $script @('decisions', '-RunId', $tag, '-ScanFile', $scanFile,
    '-Outcomes', '[{"id":"228","outcome":"dispatched"}]', '-RunLedger', $ledger)
  $rows = if ($record.Exit -eq 0) { ($record.Text | ConvertFrom-Json).rows } else { @() }
  $recordOk = $record.Exit -eq 0 -and
    @($rows | Where-Object { $_.id -eq '468' -and $_.reason -eq 'busy_from_earlier_run' }).Count -eq 1 -and
    @($rows | Where-Object { $_.id -eq '228' -and $_.reason -eq 'dispatched' }).Count -eq 1
  return [pscustomobject]@{ Scan = $scanOk; BusyRefused = $busyOk; NextSent = $nextOk; Decision = $recordOk }
}

try {
  New-Item -ItemType Directory -Force -Path $state, $journal | Out-Null
  $lines = @('## Today', '', '| ID | Task |', '|---|---|')
  foreach ($id in $ids) {
    $lines += "| $id | fixture |"
    [IO.File]::WriteAllText((Join-Path $journal "task-$id.md"), "# Task $id`: fixture`n", $utf8)
  }
  [IO.File]::WriteAllText($board, ($lines -join "`n"), $utf8)
  [IO.File]::WriteAllText($statusFile,
    '{"sessions":[{"id":"session-468","activity":{"status":"busy"}},{"id":"session-228","activity":{"status":"idle"}}]}', $utf8)
  foreach ($id in @(468, 228)) {
    $record = [ordered]@{
      id = "$id"; status = 'in-progress'; status_by = 'agent'; version = 1
      plan_id = "t$id-v1"; processed_file_hash = ''; updated = '2026-09-29T15:00:00Z'
      session = [ordered]@{
        session_id = "session-$id"; kind = 'chat'; project = 'fixture'; workspace = $root
        workspace_type = 'folder'; created_at = '2026-09-29T14:00:00Z'
        last_woken_at = ''; state = 'live'; prior_session_id = ''; replaced_at = ''
      }
    }
    [IO.File]::WriteAllText((Join-Path $state "task-$id.json"), ($record | ConvertTo-Json -Depth 6), $utf8)
  }

  $baseline = Check-Scenario $ScriptPath 'baseline'
  foreach ($field in @('Scan', 'BusyRefused', 'NextSent', 'Decision')) {
    if (-not $baseline.$field) { throw "baseline failed: $field" }
  }
  Write-Host 'PASS: busy 468 skipped, idle 228 sent at concurrency 1, 12 rows remain, decision recorded'

  $mutants = @(
    @{
      Name = 'busy-read'; Find = "if (`$activity -eq 'busy')"; Replace = "if (`$activity -eq 'idle')"; Kills = 'Scan'
      JsFind = "dispatch_skip_reason: activity === 'busy' ? 'busy_from_earlier_run'"
      JsReplace = "dispatch_skip_reason: activity === 'idle' ? 'busy_from_earlier_run'"
    },
    @{
      Name = 'dispatch-guard'; Find = 'if ($row.dispatch_skip_reason) {'; Replace = 'if ($false) {'; Kills = 'BusyRefused'
      JsFind = "if (row && psStr(get(row, 'dispatch_skip_reason'))) {"
      JsReplace = 'if (false) {'
    },
    @{ Name = 'decision-reason'; Find = "if (`$row.eligible -and `$row.PSObject.Properties['dispatch_skip_reason'] -and `"`$(`$row.dispatch_skip_reason)`") {"
       Replace = 'if ($false) {'; Kills = 'Decision'
       JsFind = "if (psTruthy(get(row, 'eligible')) && has(row, 'dispatch_skip_reason') && psStr(get(row, 'dispatch_skip_reason'))) {"
       JsReplace = 'if (false) {' }
  )
  foreach ($mutant in $mutants) {
    $find = if (Test-OaStateNodeTarget $ScriptPath) { $mutant.JsFind } else { $mutant.Find }
    $replace = if (Test-OaStateNodeTarget $ScriptPath) { $mutant.JsReplace } else { $mutant.Replace }
    $mutated = New-OaStateMutant $ScriptPath $mutant.Name $find $replace $root
    $outcome = Check-Scenario $mutated $mutant.Name
    if ($outcome.($mutant.Kills)) { throw "mutant survived: $($mutant.Name)" }
    Write-Host "KILLED: $($mutant.Name) by $($mutant.Kills)"
  }

  $withoutSnapshot = Invoke-State $ScriptPath @('session', '-Id', '468', '-ForDispatch',
    '-DispatchInput', 'stale')
  if ($withoutSnapshot.Exit -eq 0 -or $withoutSnapshot.Text -notmatch 'session_status_required') {
    throw 'dispatch without native status evidence was not refused'
  }
  [IO.File]::WriteAllText($statusFile,
    '{"sessions":[{"id":"session-228","activity":{"status":"idle"}}]}', $utf8)
  $unknown = Invoke-State $ScriptPath @('scan', '-Compact', '-SessionsStatusFile', $statusFile)
  if ($unknown.Exit -ne 0 -or
      @((($unknown.Text | ConvertFrom-Json).rows) | Where-Object {
        $_.id -eq '468' -and $_.dispatch_skip_reason -eq 'session_status_unknown'
      }).Count -ne 1) {
    throw 'missing bound-session activity did not fail closed'
  }
  [IO.File]::WriteAllText($statusFile,
    '{"sessions":[{"id":"session-468","activity":{"status":"idle"}},{"id":"session-228","activity":{"status":"idle"}}]}', $utf8)
  $nowIdle = Invoke-State $ScriptPath @('scan', '-Compact', '-SessionsStatusFile', $statusFile)
  $idleRow = @((($nowIdle.Text | ConvertFrom-Json).rows) | Where-Object id -eq '468')[0]
  $resumed = Invoke-State $ScriptPath @('session', '-Id', '468', '-ForDispatch',
    '-SessionsStatusFile', $statusFile, '-DispatchInput', $idleRow.dispatch_input)
  if ($resumed.Exit -ne 0 -or -not ($resumed.Text | ConvertFrom-Json).dispatch_authorised) {
    throw 'formerly busy session did not become dispatchable when idle'
  }
  Write-Host 'PASS: missing status refuses, idle transition re-enables, busy refusal never stamps'
}
finally {
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
