<#
  mutcheck-task-session-role.ps1 -- mutation check for #727: a task session must not run the
  coordinator skill.

  The first task session to get work through direct dispatch loaded /overnight-agent as its first
  action, because its brief said "overnight dispatch for task #228". The fix has two halves, and
  each arm kills one way of losing them:

    A  session emits role_line          (kills: a brief whose role is left to the coordinator's prose)
    A- role_line names the task and     (kills: a role line that does not forbid the coordinator
       forbids /overnight-agent            skill or dispatching other sessions)
    B  whoami: unbound id -> coordinator (kills: a guard that stops the real coordinator too)
    C  whoami: bound id -> task N        (kills: whoami absent, or not reading the binding)
    D  whoami defaults to the runtime id (kills: a guard that only works when the id is passed)
    E  whoami: replaced id -> task N     (kills: a session that was replaced reading as coordinator)
    F  whoami: no id -> unknown          (kills: an absent id read as "coordinator")
    G  SKILL.md guard precedes the run   (kills: the guard buried where a task session never reads)
    H  PHASE 1 puts role_line first      (kills: the coordinator not being told to use it)

  Runs the REAL oa-state.ps1 against an isolated temp -JournalDir / -StateDir, so the live
  planner is never touched.

    pwsh -File mutcheck-task-session-role.ps1 [-ScriptPath <oa-state.ps1>] [-SkillPath <SKILL.md>] [-ExpectPreFix]
#>
[CmdletBinding()]
param(
  [string]$ScriptPath,
  [string]$SkillPath,
  [switch]$ExpectPreFix
)

$ErrorActionPreference = 'Stop'
if (-not $ScriptPath) { $ScriptPath = Join-Path $PSScriptRoot 'oa-state.ps1' }
if (-not $SkillPath) { $SkillPath = Join-Path $PSScriptRoot 'SKILL.md' }
if (-not (Test-Path $ScriptPath)) { throw "oa-state.ps1 not found at $ScriptPath" }

$script:PsExe = if ($PSVersionTable.PSEdition -eq 'Core') { (Get-Process -Id $PID).Path } else { 'powershell' }
if (-not $script:PsExe) { $script:PsExe = 'pwsh' }

$root = Join-Path ([IO.Path]::GetTempPath()) ("oa-role-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
$jdir = Join-Path $root 'journal'
$sdir = Join-Path $root 'state'
New-Item -ItemType Directory -Path $jdir, $sdir -Force | Out-Null
$utf8 = New-Object Text.UTF8Encoding($false)
$board = Join-Path $root 'planner.md'
$store = Join-Path $root 'snooze.json'
[IO.File]::WriteAllText((Join-Path $jdir 'task-901.md'), "# Task 901: synthetic`n`nUser notes.`n", $utf8)
[IO.File]::WriteAllText($board, "## Today`n`n| ID | Task |`n|---|---|`n| 901 | synthetic |`n", $utf8)
[IO.File]::WriteAllText($store, '{}', $utf8)
$runWs = Join-Path $root 'run-ws'
New-Item -ItemType Directory -Path $runWs -Force | Out-Null

function Invoke-OaJson {
  param([string[]]$OaArgs, [string]$EnvSessionId = '')
  $all = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $ScriptPath) + $OaArgs +
  @('-JournalDir', $jdir, '-StateDir', $sdir, '-PlannerBoard', $board, '-SnoozeStore', $store,
    '-PlannerCompleted', (Join-Path $root 'absent-completed.md'),
    '-UserSettings', (Join-Path $root 'absent-settings.md'), '-RunWorkspace', $runWs)
  $prevEnv = $env:COPILOT_AGENT_SESSION_ID
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $env:COPILOT_AGENT_SESSION_ID = $EnvSessionId
    $out = & $script:PsExe @all 2>&1 | Out-String -Width 4096
  }
  catch { $out = '' }
  finally {
    $env:COPILOT_AGENT_SESSION_ID = $prevEnv
    $ErrorActionPreference = $prev
    $global:LASTEXITCODE = 0
  }
  $start = $out.IndexOf('{')
  if ($start -lt 0) { return $null }
  try { return $out.Substring($start) | ConvertFrom-Json } catch { return $null }
}

$results = [ordered]@{}
function Check([string]$name, [scriptblock]$body) {
  try { $results[$name] = [bool](& $body) }
  catch { $results[$name] = $false; Write-Verbose "$name threw: $($_.Exception.Message)" }
}

$sess = Invoke-OaJson @('session', '-Id', '901')
Check 'A session emits role_line' { "$($sess.role_line)" -like 'You are the task session for planner task #901.*' }
Check 'A- role_line forbids the coordinator and dispatch' {
  $l = "$($sess.role_line)"
  $l -match 'Do this task only' -and $l -match '/overnight-agent' -and $l -match 'do not dispatch'
}

Check 'B whoami: unbound id -> coordinator' {
  $w = Invoke-OaJson @('whoami', '-SessionId', 'SESS_COORD')
  "$($w.role)" -eq 'coordinator' -and -not $w.task_id
}

[void](Invoke-OaJson @('session', '-Id', '901', '-SessionId', 'SESS_A', '-SessionKind', 'chat'))
Check 'C whoami: bound id -> task 901' {
  $w = Invoke-OaJson @('whoami', '-SessionId', 'SESS_A')
  "$($w.role)" -eq 'task' -and "$($w.task_id)" -eq '901' -and "$($w.role_line)" -match '#901'
}
Check 'D whoami defaults to COPILOT_AGENT_SESSION_ID' {
  $w = Invoke-OaJson @('whoami') -EnvSessionId 'SESS_A'
  "$($w.role)" -eq 'task' -and "$($w.task_id)" -eq '901' -and "$($w.session_id_source)" -eq 'COPILOT_AGENT_SESSION_ID'
}

[void](Invoke-OaJson @('session', '-Id', '901', '-SessionDead'))
[void](Invoke-OaJson @('session', '-Id', '901', '-SessionId', 'SESS_B', '-SessionKind', 'chat'))
Check 'E whoami: replaced and replacement ids -> task 901' {
  $old = Invoke-OaJson @('whoami', '-SessionId', 'SESS_A')
  $new = Invoke-OaJson @('whoami', '-SessionId', 'SESS_B')
  "$($old.role)" -eq 'task' -and "$($old.task_id)" -eq '901' -and
  "$($new.role)" -eq 'task' -and "$($new.task_id)" -eq '901'
}
Check 'F whoami: no id -> unknown' {
  $w = Invoke-OaJson @('whoami')
  "$($w.role)" -eq 'unknown'
}

$skill = if (Test-Path $SkillPath) { [IO.File]::ReadAllText($SkillPath) } else { '' }
Check 'G SKILL.md task-session guard precedes the run' {
  $guard = $skill.IndexOf('are you a task session?')
  $settings = $skill.IndexOf('## User settings')
  $guard -ge 0 -and $settings -gt $guard -and
  $skill.Substring($guard, $settings - $guard) -match 'oa-state\.ps1 whoami'
}
Check 'H PHASE 1 puts role_line first in every brief' {
  $p1 = $skill.IndexOf('### PHASE 1 ')
  $p15 = $skill.IndexOf('### PHASE 1.5')
  $p1 -ge 0 -and $p15 -gt $p1 -and
  $skill.Substring($p1, $p15 - $p1) -match '(?s)first line.{0,40}role_line'
}

$pass = 0; $fail = 0
foreach ($key in $results.Keys) {
  if ($results[$key]) { "  PASS  $key"; $pass++ } else { "  FAIL  $key"; $fail++ }
}
""
"$pass passed, $fail failed  (script: $ScriptPath)"
Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue

if ($ExpectPreFix) {
  if ($fail -eq 0) { "MUTCHECK FAILED: pre-fix script passed everything - the fix guards nothing."; exit 1 }
  "MUTCHECK OK: pre-fix script fails $fail arm(s), as required."
  exit 0
}
if ($fail -gt 0) { exit 1 }
exit 0
