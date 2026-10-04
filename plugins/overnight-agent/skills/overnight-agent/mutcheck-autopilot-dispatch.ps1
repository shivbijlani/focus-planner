[CmdletBinding()]
param(
  [string]$StateScript = (Join-Path $PSScriptRoot 'oa-state.ps1'),
  [string]$SkillPath = (Join-Path $PSScriptRoot 'SKILL.md')
)

$ErrorActionPreference = 'Stop'
$root = Join-Path ([IO.Path]::GetTempPath()) ("oa-autopilot-" + [guid]::NewGuid().ToString('N'))
$journal = Join-Path $root 'journal'
$state = Join-Path $root 'state'
$board = Join-Path $root 'planner.md'
$snooze = Join-Path $root 'snooze.json'
$settings = Join-Path $root 'settings.md'
$sessionsStatus = Join-Path $root 'sessions-status.json'
$utf8 = New-Object Text.UTF8Encoding($false)
$psExe = (Get-Process -Id $PID).Path
$moon = [char]::ConvertFromUtf32(0x1F319)
$passed = 0

function Check([string]$name, [bool]$ok, [string]$detail = '') {
  if (-not $ok) { throw "FAIL: $name $detail" }
  $script:passed++
}

function StateCall([string[]]$arguments) {
  if ($arguments -contains '-ForDispatch') { $arguments += @('-SessionsStatusFile', $sessionsStatus) }
  $result = & $psExe -NoProfile -File $StateScript @arguments `
    -JournalDir $journal -StateDir $state -PlannerBoard $board -SnoozeStore $snooze `
    -UserSettings $settings 2>&1
  if ($LASTEXITCODE -ne 0) { throw "state call failed: $result" }
  return $result | ConvertFrom-Json
}

function ScanRow([string]$id) {
  $rows = StateCall @('scan')
  return @($rows | Where-Object { $_.id -eq $id })[0]
}

function Refused([string[]]$arguments) {
  if ($arguments -contains '-ForDispatch') { $arguments += @('-SessionsStatusFile', $sessionsStatus) }
  $null = & $psExe -NoProfile -File $StateScript @arguments `
    -JournalDir $journal -StateDir $state -PlannerBoard $board -SnoozeStore $snooze `
    -UserSettings $settings 2>&1
  return ($LASTEXITCODE -ne 0)
}

try {
  New-Item -ItemType Directory -Force -Path $journal, $state | Out-Null
  [IO.File]::WriteAllText($board,
    "## Today`n`n| ID | Task |`n|---|---|`n| 901 | new instruction |`n| 902 | user-paused |`n| 903 | legacy proposal |`n",
    $utf8)
  [IO.File]::WriteAllText($snooze, '{}', $utf8)
  [IO.File]::WriteAllText($settings, '', $utf8)
  [IO.File]::WriteAllText($sessionsStatus,
    '{"sessions":[{"id":"S-901","activity":{"status":"idle"}},{"id":"S-902","activity":{"status":"idle"}},{"id":"S-903","activity":{"status":"idle"}}]}',
    $utf8)

  [IO.File]::WriteAllText((Join-Path $journal 'task-901.md'),
    "# Task 901: new instruction`n`n## 2026-09-29`n`n- TODO: Generate the requested report`n", $utf8)
  $legacyBlock = "# Task 902: user-paused`r`n`r`n## 2026-09-29`r`n`r`n---`r`n" +
    "<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->`r`n`r`n" +
    "## $moon Overnight Agent`r`n<!-- from: overnight-agent -->`r`n`r`n" +
    "**Status:** In progress - fixture.`r`n`r`n<!-- /overnight-agent turn-end -->`r`n"
  [IO.File]::WriteAllText((Join-Path $journal 'task-902.md'), $legacyBlock, $utf8)
  $agentProposal = "# Task 903: legacy proposal`r`n`r`n## 2026-09-29`r`n`r`n---`r`n" +
    "<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->`r`n`r`n" +
    "## $moon Overnight Agent`r`n<!-- from: overnight-agent -->`r`n`r`n" +
    "**Status:** Proposed`r`n**Needs from you:** approve this plan?`r`n`r`n<!-- /overnight-agent turn-end -->`r`n"
  [IO.File]::WriteAllText((Join-Path $journal 'task-903.md'), $agentProposal, $utf8)

  foreach ($id in 901, 902, 903) {
    $status = switch ($id) { 901 { 'none' } 902 { 'proposed' } 903 { 'proposed' } }
    $by = if ($id -eq 902) { 'user' } else { 'agent' }
    $pausedAt = if ($id -eq 902) { (Get-Date).ToUniversalTime().ToString('o') } else { $null }
    $st = [ordered]@{
      id = "$id"; status = $status; status_by = $by; paused_at = $pausedAt; version = 1
      processed_file_hash = ''; has_agent_block = ($id -ne 901)
      seeded = $false; updated = '2026-09-01T00:00:00Z'
      session = [ordered]@{
        session_id = "S-$id"; kind = 'chat'; project = 'p'; workspace = $root
        workspace_type = 'folder'; created_at = '2026-09-01T00:00:00Z'
        last_woken_at = ''; state = 'live'; prior_session_id = ''; replaced_at = ''
      }
    }
    [IO.File]::WriteAllText((Join-Path $state "task-$id.json"), ($st | ConvertTo-Json -Depth 8), $utf8)
  }

  $new = ScanRow '901'
  Check 'new task without an agent block is ordinarily eligible' ($new.eligible -and -not $new.has_agent_block)
  $newDispatch = StateCall @('session', '-Id', '901', '-ForDispatch', '-DispatchInput', $new.dispatch_input)
  Check 'new task uses ordinary dispatch authority' ($newDispatch.dispatch_authorised -and $newDispatch.dispatch_eligible)

  $paused = ScanRow '902'
  Check 'user pause remains ineligible' (-not $paused.eligible -and $paused.session_paused) `
    ($paused | ConvertTo-Json -Compress)
  Check 'ordinary dispatch cannot bypass a user pause' (Refused @('session', '-Id', '902', '-ForDispatch', '-DispatchInput', $paused.dispatch_input))

  $legacy = ScanRow '903'
  Check 'legacy agent proposal is eligible without plan review' ($legacy.eligible -and -not $legacy.PSObject.Properties['plan_review_due'])
  $legacyDispatch = StateCall @('session', '-Id', '903', '-ForDispatch', '-DispatchInput', $legacy.dispatch_input)
  Check 'legacy agent proposal uses ordinary dispatch authority' ($legacyDispatch.dispatch_authorised -and $legacyDispatch.dispatch_eligible)

  $skill = [IO.File]::ReadAllText($SkillPath)
  $stateSource = [IO.File]::ReadAllText($StateScript)
  $skillDir = Split-Path -Parent $StateScript
  $scanSource = [IO.File]::ReadAllText((Join-Path $skillDir 'oa-state-lib\plan\scan.mjs'))
  $sessionSource = [IO.File]::ReadAllText((Join-Path $skillDir 'oa-state-lib\act\session.mjs'))
  $argsSource = [IO.File]::ReadAllText((Join-Path $skillDir 'oa-state-lib\core\args.mjs'))
  $writerSource = [IO.File]::ReadAllText((Join-Path $skillDir 'write-turn.mjs'))
  $livenessSource = [IO.File]::ReadAllText((Join-Path $skillDir '..\..\checks\recurring-liveness-sweep.mjs'))
  Check 'task sessions are sent in autopilot' ($skill.Contains('`mode: autopilot`'))
  Check 'read-only portal access is not gated by model sensitivity' ($skill.Contains('read-only portal access even if the') -and $skill.Contains('model considers the data sensitive'))
  Check 'unrequested email is an offer, not a blocker' ($skill.Contains('sending an email') -and $skill.Contains('`-Ask offer` after the task is done'))
  Check 'only a user pause counts as a not-yet-started proposal' ($livenessSource.Contains("String(st.status_by).toLowerCase() === 'user'"))
  Check 'plan-review dispatch and gated-plan approval paths are removed' `
    (-not $skill.Contains('PlanDispatch') -and -not $skill.Contains('plan_review_due') `
      -and -not $stateSource.Contains('PlanDispatch') -and -not $stateSource.Contains('plan_review_due') `
      -and -not $scanSource.Contains('plan_review_due') -and -not $sessionSource.Contains('PlanDispatch') `
      -and -not $sessionSource.Contains('assertGatedPlanConsent') -and -not $argsSource.Contains('PlanDispatch') `
      -and -not $writerSource.Contains('G19'))

  Write-Host "mutcheck-autopilot-dispatch: $passed passed"
}
finally {
  Remove-Item -LiteralPath $root -Recurse -Force
}
exit 0
