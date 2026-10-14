[CmdletBinding()]
param(
  # May name the Node port, oa-state.mjs (item 4): same arguments, same arms.
  [string]$StateScript = (Join-Path $PSScriptRoot 'oa-state.ps1'),
  # May name the Node port, write-turn.mjs (item 3): same arguments, same arms.
  [string]$TurnScript = (Join-Path $PSScriptRoot 'write-turn.ps1')
)

function Invoke-Turn([string[]]$A) {
  if ($TurnScript -like '*.mjs') { return (& node $TurnScript @A) }
  return (& $psExe -NoProfile -File $TurnScript @A)
}

$ErrorActionPreference = 'Stop'
$root = Join-Path ([IO.Path]::GetTempPath()) ("oa-plan-" + [guid]::NewGuid().ToString('N'))
$journal = Join-Path $root 'journal'
$state = Join-Path $root 'state'
$board = Join-Path $root 'planner.md'
$snooze = Join-Path $root 'snooze.json'
$settings = Join-Path $root 'settings.md'
$sessionsStatus = Join-Path $root 'sessions-status.json'
$env:WRITE_TURN_OA_HOME = Join-Path $root 'home'
$utf8 = New-Object Text.UTF8Encoding($false)
$psExe = (Get-Process -Id $PID).Path
. (Join-Path (Split-Path -Parent $StateScript) 'oa-state-target.ps1')
$script:OaCmd = Get-OaStateCommand $StateScript
$moon = [char]::ConvertFromUtf32(0x1F319)
$passed = 0

function Check([string]$name, [bool]$ok) {
  if (-not $ok) { throw "FAIL: $name" }
  $script:passed++
}

function StateCall([string[]]$arguments) {
  if ($arguments -contains '-ForDispatch') { $arguments += @('-SessionsStatusFile', $sessionsStatus) }
  $result = & $script:OaCmd.Exe @($script:OaCmd.Prefix + $arguments) `
    -JournalDir $journal -StateDir $state -PlannerBoard $board -SnoozeStore $snooze `
    -UserSettings $settings 2>&1
  if ($LASTEXITCODE -ne 0) { throw "state call failed: $result" }
  return $result | ConvertFrom-Json
}

function ScanRow([string]$id) {
  $scan = StateCall @('scan', '-Compact')
  return @($scan.rows | Where-Object { $_.id -eq $id })[0]
}

function Refused([string[]]$arguments) {
  if ($arguments -contains '-ForDispatch') { $arguments += @('-SessionsStatusFile', $sessionsStatus) }
  $null = & $psExe -NoProfile -File $StateScript @arguments `
    -JournalDir $journal -StateDir $state -PlannerBoard $board -SnoozeStore $snooze `
    -UserSettings $settings 2>&1
  return ($LASTEXITCODE -ne 0)
}

try {
  New-Item -ItemType Directory -Force -Path $journal, $state, $env:WRITE_TURN_OA_HOME | Out-Null
  $boardText = "## Today`n`n| ID | Task |`n|---|---|`n| 901 | research |`n| 902 | paused |`n| 903 | new |`n"
  [IO.File]::WriteAllText($board, $boardText, $utf8)
  [IO.File]::WriteAllText($snooze, '{}', $utf8)
  [IO.File]::WriteAllText($settings, '', $utf8)
  [IO.File]::WriteAllText($sessionsStatus,
    '{"sessions":[{"id":"S-901","activity":{"status":"idle"}},{"id":"S-902","activity":{"status":"idle"}},{"id":"S-903","activity":{"status":"idle"}}]}', $utf8)
  foreach ($id in 901, 902, 903) {
    $text = "# Task $id`: synthetic`n`n---`n<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->`n`n## $moon Overnight Agent`n<!-- from: overnight-agent -->`n**Status:** Proposed`n`n### Proposed plan (v1)`n1. Research`n`n**Needs from you:** approve the research?`n<!-- /overnight-agent turn-end -->`n"
    if ($id -eq 903) { $text = $text.Replace('approve the research?', 'none') }
    [IO.File]::WriteAllText((Join-Path $journal "task-$id.md"), $text, $utf8)
    $status = if ($id -eq 903) { 'in-progress' } else { 'proposed' }
    $by = if ($id -eq 902) { 'user' } else { 'agent' }
    $st = [ordered]@{
      id = "$id"; status = $status; status_by = $by; version = 1
      plan_id = "t$id-v1"; processed_file_hash = ''; has_agent_block = $true
      seeded = $false; updated = '2026-09-01T00:00:00Z'
      session = [ordered]@{
        session_id = "S-$id"; kind = 'chat'; project = 'p'; workspace = $root
        workspace_type = 'folder'; created_at = '2026-09-01T00:00:00Z'
        last_woken_at = ''; state = 'live'; prior_session_id = ''; replaced_at = ''
      }
    }
    [IO.File]::WriteAllText((Join-Path $state "task-$id.json"), ($st | ConvertTo-Json -Depth 8), $utf8)
  }

  $old = ScanRow '901'
  Check 'agent proposal appears in compact scan for review' ($old.plan_review_due -and -not $old.eligible)
  Check 'user pause stays hidden from plan review' (-not (ScanRow '902').plan_review_due)
  Check 'ordinary in-progress task is not plan review' (-not (ScanRow '903').plan_review_due)
  Check 'new work remains normally dispatchable' ((ScanRow '903').eligible)
  Check 'proposal cannot use ordinary dispatch' (Refused @('session', '-Id', '901', '-ForDispatch', '-DispatchInput', $old.dispatch_input))
  Check 'plan dispatch requires fingerprint' (Refused @('session', '-Id', '901', '-ForDispatch', '-PlanDispatch'))
  Check 'user pause cannot use plan dispatch' (Refused @('session', '-Id', '902', '-ForDispatch', '-PlanDispatch', '-DispatchInput', (ScanRow '902').dispatch_input))
  Check 'plan dispatch cannot be used on ordinary row' (Refused @('session', '-Id', '903', '-ForDispatch', '-PlanDispatch', '-DispatchInput', (ScanRow '903').dispatch_input))

  $ok = StateCall @('session', '-Id', '901', '-ForDispatch', '-PlanDispatch', '-DispatchInput', $old.dispatch_input)
  Check 'classified proposal uses normal wake stamp' ($ok.dispatch_authorised -and $ok.dispatch_eligible)
  [IO.File]::AppendAllText((Join-Path $journal 'task-901.md'), "`n<!-- from: me -->`nHold off`n", $utf8)
  Check 'new human reply suppresses plan review' (-not (ScanRow '901').plan_review_due)
  Check 'old plan dispatch cannot override reply' (Refused @('session', '-Id', '901', '-ForDispatch', '-PlanDispatch', '-DispatchInput', $old.dispatch_input))
  $text = [IO.File]::ReadAllText((Join-Path $journal 'task-901.md'))
  [IO.File]::WriteAllText((Join-Path $journal 'task-901.md'), $text.Substring(0, $text.IndexOf("`n<!-- from: me -->")), $utf8)
  $gatedBoard = "## Today`n`n| ID | Task |`n|---|---|`n| 903 | new |`n`n## Deferred`n`n| ID | Task |`n|---|---|`n| 901 | research |`n| 902 | paused |`n"
  [IO.File]::WriteAllText($board, $gatedBoard, $utf8)
  Check 'Deferred proposal respects Today gate' (-not (ScanRow '901').plan_review_due)
  Check 'Deferred proposal cannot bypass Today via plan dispatch' (Refused @('session', '-Id', '901', '-ForDispatch', '-PlanDispatch', '-DispatchInput', $old.dispatch_input))
  [IO.File]::WriteAllText($board, $boardText, $utf8)

  $cases = @(
    @{ name = 'all reversible proposal refused'; status = 'Proposed'; step = '[reversible] Research repair shops'; ask = 'blocking'; reject = $true },
    @{ name = 'gate-allowed first proposal refused'; status = 'Proposed'; step = '[gate-allowed] Open draft PR'; ask = 'blocking'; reject = $true },
    @{ name = 'unclassified proposal refused'; status = 'Proposed'; step = 'Research repair shops'; ask = 'blocking'; reject = $true },
    @{ name = 'unclassified later step refused'; status = 'Proposed'; step = "[gated] Book hotel at `$250`n2. Research"; ask = 'blocking'; reject = $true },
    @{ name = 'gated first proposal accepted'; status = 'Proposed'; step = '[gated] Book hotel at $250'; ask = 'blocking'; reject = $false },
    @{ name = 'reversible work in progress accepted'; status = 'In progress'; step = '[reversible] Research repair shops'; ask = 'none'; reject = $false }
  )
  foreach ($c in $cases) {
    $body = "## $moon Overnight Agent`n<!-- from: overnight-agent -->`n**Status:** $($c.status)`n### Proposed plan (v1)`n1. $($c.step)`n**Needs from you:** Book at `$250?`n"
    $file = Join-Path $root 'turn.md'
    [IO.File]::WriteAllText($file, $body, $utf8)
    $result = Invoke-Turn @('-BodyFile', $file, '-Ask', $c.ask, '-Validate', '-Json') | ConvertFrom-Json
    $g19 = @($result.findings | Where-Object { $_.guard -eq 'G19' }).Count -gt 0
    Check $c.name ($g19 -eq $c.reject)
    if ($c.reject) {
      $mutant = Invoke-Turn @('-BodyFile', $file, '-Ask', $c.ask, '-Validate', '-Json', '-DisableGuard', 'G19') | ConvertFrom-Json
      Check "$($c.name) is killed by G19" (-not (@($mutant.findings | Where-Object { $_.guard -eq 'G19' }).Count -gt 0))
    }
  }
  Write-Host "mutcheck-plan-dispatch: $passed passed"
}
finally {
  Remove-Item -LiteralPath $root -Recurse -Force
}
exit 0
