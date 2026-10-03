<#
  mutcheck-coordinator-no-task-work.ps1 -- #804 part 2

  Approved task work belongs to the bound task session. The coordinator may dispatch and record
  user decisions, but it must not write the outcome turn or mark the approved work done itself.

  Hermetic: synthetic planner/state under TEMP, no live data, driving the real write-turn and
  oa-state engines. -ScriptPath may name write-turn.ps1/write-turn.mjs; -OaStatePath may name
  oa-state.ps1/oa-state.mjs. Mutants are made in copied skill directories so sibling engine calls
  still resolve normally.
#>
[CmdletBinding()]
param(
  [string]$ScriptPath,
  [string]$WriteTurnPath,
  [string]$OaStatePath
)

$ErrorActionPreference = 'Stop'
if (-not $ScriptPath -and $WriteTurnPath) { $ScriptPath = $WriteTurnPath }
if (-not $OaStatePath) {
  $base = if ($ScriptPath) { Split-Path -Parent $ScriptPath } else { $PSScriptRoot }
  $OaStatePath = Join-Path $base ($(if ($ScriptPath -like '*.mjs') { 'oa-state.mjs' } else { 'oa-state.ps1' }))
}
if (-not (Test-Path -LiteralPath $OaStatePath)) { throw "oa-state not found at $OaStatePath" }
if (-not $ScriptPath) {
  $ScriptPath = Join-Path (Split-Path -Parent $OaStatePath) ($(if ($OaStatePath -like '*.mjs') { 'write-turn.mjs' } else { 'write-turn.ps1' }))
}
if (-not (Test-Path -LiteralPath $ScriptPath)) { throw "script not found at $ScriptPath" }

$script:PsExe = if ($PSVersionTable.PSEdition -eq 'Core') { (Get-Process -Id $PID).Path } else { 'powershell' }
$script:pass = 0
$script:fail = 0
$utf8 = New-Object Text.UTF8Encoding($false)
$MOON = [char]::ConvertFromUtf32(0x1F319)

function Assert([bool]$ok, [string]$name, [string]$why, [string]$detail = '') {
  if ($ok) { Write-Host "  PASS  $name -- $why"; $script:pass++ }
  else {
    Write-Host "  FAIL  $name -- $why" -ForegroundColor Red
    if ($detail) { Write-Host "        $detail" -ForegroundColor DarkGray }
    $script:fail++
  }
}

function New-Root {
  $root = Join-Path ([IO.Path]::GetTempPath()) ("oa-804-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
  New-Item -ItemType Directory -Path $root -Force | Out-Null
  foreach ($d in @('planner\journal', 'home\state', 'input')) { New-Item -ItemType Directory -Path (Join-Path $root $d) -Force | Out-Null }
  [IO.File]::WriteAllText((Join-Path $root 'planner\planner.md'), "## Today`n`n| ID | Task |`n|---|---|`n| 970 | task 970 |`n", $utf8)
  [IO.File]::WriteAllText((Join-Path $root 'planner\planner-completed.md'), '', $utf8)
  [IO.File]::WriteAllText((Join-Path $root 'planner\snooze.json'), '{}', $utf8)
  [IO.File]::WriteAllText((Join-Path $root 'planner\user-settings.md'), '', $utf8)
  [IO.File]::WriteAllText((Join-Path $root 'planner\agent-gate.md'), '', $utf8)
  return $root
}

function Write-TaskFixture([string]$root, [string]$id, [switch]$Approved, [string]$SessionId = 'task-session') {
  $approval = if ($Approved) { "`n## 2020-03-02`n`n<!-- from: me -->`napprove`n" } else { '' }
  $journal = "# Task ${id}: task ${id}`n`n---`n<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->`n`n" +
    "## $MOON Overnight Agent -- ask`n`n<!-- from: overnight-agent -->`n<!-- oa-ask: blocking -->`n" +
    "**Status:** Proposed`n`n### Proposed plan (v1)`n1. [gated] Do the work.`n`n" +
    "**Needs from you:** approve?`n<!-- /overnight-agent turn-end -->`n" + $approval
  [IO.File]::WriteAllText((Join-Path $root "planner\journal\task-$id.md"), $journal, $utf8)
  $state = [ordered]@{
    id = $id; status = 'proposed'; status_by = 'agent'; version = 1; plan_id = "t$id-v1";
    processed_file_hash = ''; has_agent_block = $true; seeded = $false; updated = '2020-03-01T12:00:00Z';
    session = [ordered]@{ session_id = $SessionId; prior_session_id = 'prior-task-session' }
  }
  [IO.File]::WriteAllText((Join-Path $root "home\state\task-$id.json"), ($state | ConvertTo-Json -Depth 5), $utf8)
}

function Invoke-WriteTurn([string]$Path, [string]$root, [string]$id, [string]$author, [switch]$NoApproval, [switch]$DisableG23) {
  Write-TaskFixture $root $id -Approved:(!$NoApproval)
  $body = Join-Path $root "input\body-$id.md"
  [IO.File]::WriteAllText($body, "## $MOON Overnight Agent -- done`n`n<!-- from: overnight-agent -->`n`n**Status:** Done`n`nDid it.`n`n**Needs from you:** nothing.`n", $utf8)
  $env:WRITE_TURN_OA_HOME = Join-Path $root 'home'
  $env:LOCALAPPDATA = Join-Path $root 'lad'
  $args = @('-BodyFile', $body, '-Ask', 'none', '-Validate', '-Id', $id, '-JournalDir', (Join-Path $root 'planner\journal'), '-Author', $author)
  if ($DisableG23) { $args += @('-DisableGuard', 'G23') }
  $exe = if ($Path -like '*.mjs') { 'node' } else { $script:PsExe }
  $prefix = if ($Path -like '*.mjs') { @($Path) } else { @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $Path) }
  $cmdArgs = @($prefix) + @($args)
  $out = & $exe @cmdArgs 2>&1
  [pscustomobject]@{ code = $LASTEXITCODE; out = (@($out) | Out-String) }
}

function Invoke-Mark([string]$Path, [string]$root, [string]$id, [string]$turnBy, [string]$status = 'in-progress', [switch]$NoApproval) {
  Write-TaskFixture $root $id -Approved:(!$NoApproval)
  $args = @('mark', '-Id', $id, '-Status', $status, '-TurnBy', $turnBy,
    '-JournalDir', (Join-Path $root 'planner\journal'), '-StateDir', (Join-Path $root 'home\state'),
    '-PlannerBoard', (Join-Path $root 'planner\planner.md'), '-PlannerCompleted', (Join-Path $root 'planner\planner-completed.md'),
    '-SnoozeStore', (Join-Path $root 'planner\snooze.json'), '-GatePath', (Join-Path $root 'planner\agent-gate.md'),
    '-UserSettings', (Join-Path $root 'planner\user-settings.md'))
  $exe = if ($Path -like '*.mjs') { 'node' } else { $script:PsExe }
  $prefix = if ($Path -like '*.mjs') { @($Path) } else { @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $Path) }
  $cmdArgs = @($prefix) + @($args)
  $out = & $exe @cmdArgs 2>&1
  [pscustomobject]@{ code = $LASTEXITCODE; out = (@($out) | Out-String) }
}

function Copy-SkillForMutation([string]$sourceFile) {
  $srcDir = Split-Path -Parent $sourceFile
  $dst = Join-Path ([IO.Path]::GetTempPath()) ("oa-804-skill-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
  Copy-Item -LiteralPath $srcDir -Destination $dst -Recurse
  return (Join-Path $dst (Split-Path -Leaf $sourceFile))
}

function Mutate([string]$source, [string]$find, [string]$replace) {
  $mut = Copy-SkillForMutation $source
  $text = [IO.File]::ReadAllText($mut)
  if (([regex]::Matches($text, [regex]::Escape($find))).Count -ne 1) { throw "mutation target not unique in $mut :: $find" }
  [IO.File]::WriteAllText($mut, $text.Replace($find, $replace), $utf8)
  return $mut
}

function MutateSkillFile([string]$enginePath, [string]$relativePath, [string]$find, [string]$replace) {
  $engine = Copy-SkillForMutation $enginePath
  $skillDir = Split-Path -Parent $engine
  $target = Join-Path $skillDir $relativePath
  $text = [IO.File]::ReadAllText($target)
  if (([regex]::Matches($text, [regex]::Escape($find))).Count -ne 1) { throw "mutation target not unique in $target :: $find" }
  [IO.File]::WriteAllText($target, $text.Replace($find, $replace), $utf8)
  return $engine
}

Write-Host ''
Write-Host "ARMS -- write-turn $ScriptPath"
$root = New-Root
try {
  $r = Invoke-WriteTurn $ScriptPath $root '970' 'coordinator-session'
  Assert ($r.code -eq 2 -and $r.out -match 'G23') 'WT-REFUSE' 'coordinator outcome turn on approved task is refused' $r.out
  $r = Invoke-WriteTurn $ScriptPath $root '971' 'task-session'
  Assert ($r.code -eq 0 -and $r.out -notmatch 'G23') 'WT-OWNER' 'bound task session may write the outcome turn' $r.out
  $r = Invoke-WriteTurn $ScriptPath $root '972' 'coordinator-session' -NoApproval
  Assert ($r.code -eq 0 -and $r.out -notmatch 'G23') 'WT-NO-CONSENT' 'coordinator turn without pending approval is allowed' $r.out
  $r = Invoke-WriteTurn $ScriptPath $root '973' 'coordinator-session' -DisableG23
  Assert ($r.code -eq 2 -and $r.out -match 'G23') 'WT-NOT-DISABLEABLE' '-DisableGuard G23 does not bypass' $r.out
}
finally { Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue }

Write-Host ''
Write-Host "ARMS -- oa-state mark $OaStatePath"
$root = New-Root
try {
  $r = Invoke-Mark $OaStatePath $root '980' 'coordinator-session'
  Assert ($r.code -ne 0 -and $r.out -match 'approved_task_status_owned_by_task_session') 'MARK-REFUSE' 'coordinator cannot mark approved work in-progress' $r.out
  $r = Invoke-Mark $OaStatePath $root '981' 'task-session' 'done'
  Assert ($r.code -eq 0 -and $r.out -notmatch 'approved_task_status_owned_by_task_session') 'MARK-OWNER' 'bound task session can mark approved work done' $r.out
  $r = Invoke-Mark $OaStatePath $root '982' 'coordinator-session' 'in-progress' -NoApproval
  Assert ($r.code -eq 0) 'MARK-NO-CONSENT' 'without pending approval, coordinator status mark is not in this guard' $r.out
  $r = Invoke-Mark $OaStatePath $root '983' 'coordinator-session' 'approved'
  Assert ($r.code -eq 0) 'MARK-APPROVED-STATUS' 'coordinator may record approval itself; outcome statuses are guarded' $r.out
}
finally { Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue }

Write-Host ''
Write-Host 'MUTANTS -- write-turn'
$wtMutations = if ($ScriptPath -like '*.mjs') {
  @(
    @('guard-skipped', 'const approvedOwner = approvedTaskOwnerFinding(ctx, id);', 'const approvedOwner = null;'),
    @('bound-check-inverted', 'if (owner.bound) return null;', 'if (!owner.bound) return null;'),
    @('consent-ignored', "if (consent.ok && !psTruthy(get(consent.verdict, 'consent_ok'))) return null;", "if (false && consent.ok && !psTruthy(get(consent.verdict, 'consent_ok'))) return null;"),
    @('made-disableable', 'const approvedOwner = approvedTaskOwnerFinding(ctx, id);', "const approvedOwner = ciContains(disabled, 'G23') ? null : approvedTaskOwnerFinding(ctx, id);")
  )
} else {
  @(
    @('guard-skipped', '$approvedOwner = Get-ApprovedTaskOwnerFinding $Id $Author', '$approvedOwner = $null'),
    @('bound-check-inverted', 'if ($owner.bound) { return $null }', 'if (-not $owner.bound) { return $null }'),
    @('consent-ignored', 'if ($consent.ok -and -not [bool]$consent.verdict.consent_ok) { return $null }', 'if ($false -and $consent.ok -and -not [bool]$consent.verdict.consent_ok) { return $null }'),
    @('made-disableable', '$approvedOwner = Get-ApprovedTaskOwnerFinding $Id $Author', '$approvedOwner = if ($DisableGuard -contains ''G23'') { $null } else { Get-ApprovedTaskOwnerFinding $Id $Author }')
  )
}
foreach ($m in $wtMutations) {
  $mut = Mutate $ScriptPath $m[1] $m[2]
  $root = New-Root
  $killed = $false
  try {
    $a = Invoke-WriteTurn $mut $root '990' 'coordinator-session'
    $b = Invoke-WriteTurn $mut $root '991' 'task-session'
    $c = Invoke-WriteTurn $mut $root '992' 'coordinator-session' -NoApproval
    $d = Invoke-WriteTurn $mut $root '993' 'coordinator-session' -DisableG23
    $killed = -not ($a.code -eq 2 -and $b.code -eq 0 -and $c.code -eq 0 -and $d.code -eq 2)
  }
  finally { Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue; Remove-Item -LiteralPath (Split-Path -Parent $mut) -Recurse -Force -ErrorAction SilentlyContinue }
  Assert $killed "WT-MUTANT-$($m[0])" 'mutant is killed by the arms'
}

Write-Host ''
Write-Host 'MUTANTS -- oa-state mark'
$markMutations = if ($OaStatePath -like '*.mjs') {
  @(
    @('mark-guard-skipped', "consent && psTruthy(get(consent, 'consent_ok')) && !taskSessionOwnsStatusChange(ctx, st)", "false && consent && psTruthy(get(consent, 'consent_ok')) && !taskSessionOwnsStatusChange(ctx, st)"),
    @('mark-bound-inverted', '!taskSessionOwnsStatusChange(ctx, st)', 'taskSessionOwnsStatusChange(ctx, st)'),
    @('mark-consent-ignored', "consent && psTruthy(get(consent, 'consent_ok')) && ", '')
  )
} else {
  @(
    @('mark-guard-skipped', '$facts.Consent -and [bool]$facts.Consent.consent_ok -and -not (Test-TaskSessionOwnsStatusChange $st)', '$false -and $facts.Consent -and [bool]$facts.Consent.consent_ok -and -not (Test-TaskSessionOwnsStatusChange $st)'),
    @('mark-bound-inverted', '-not (Test-TaskSessionOwnsStatusChange $st)', '(Test-TaskSessionOwnsStatusChange $st)'),
    @('mark-consent-ignored', '$facts.Consent -and [bool]$facts.Consent.consent_ok -and ', '')
  )
}
foreach ($m in $markMutations) {
  $mut = if ($OaStatePath -like '*.mjs') { MutateSkillFile $OaStatePath 'oa-state-lib\act\mark.mjs' $m[1] $m[2] } else { Mutate $OaStatePath $m[1] $m[2] }
  $root = New-Root
  $killed = $false
  try {
    $a = Invoke-Mark $mut $root '994' 'coordinator-session'
    $b = Invoke-Mark $mut $root '995' 'task-session' 'done'
    $c = Invoke-Mark $mut $root '996' 'coordinator-session' 'in-progress' -NoApproval
    $killed = -not ($a.code -ne 0 -and $b.code -eq 0 -and $c.code -eq 0)
  }
  finally { Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue; Remove-Item -LiteralPath (Split-Path -Parent $mut) -Recurse -Force -ErrorAction SilentlyContinue }
  Assert $killed "MARK-MUTANT-$($m[0])" 'mutant is killed by the arms'
}

Write-Host ''
if ($script:fail -gt 0) {
  Write-Host "FAILED: $script:fail arm(s) failed, $script:pass passed." -ForegroundColor Red
  exit 1
}
Write-Host "OK: $script:pass arms passed; coordinator cannot do an approved task's work." -ForegroundColor Green
exit 0
