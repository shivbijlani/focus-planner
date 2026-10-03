<#
  mutcheck-lanes.ps1 -- lanes are enforced in code, in both engines (docs/spec/Domain-lanes.md).

  WHY: lanes scope each PC to part of the plan. The lesson of items 4-5 is that anything the agent
  must do every run has to be a property of the commands it calls, never a SKILL.md step -- the
  model skips prose. So `scan` must not offer another PC's task, and `session` must refuse to wake
  or bind it. And lanes OFF (no agent-lanes.json) must be exactly today.

  ARMS (each runs the REAL engine against a synthetic planner; the target may be oa-state.ps1 or
  oa-state.mjs -- see oa-state-target.ps1). This PC is device A, which serves lane `ado` only:
    A  a `#lane:home` Today task with his unanswered reply      -> not eligible here
    B  an `ado` Deferred task (assigned in agent-lanes.json)    -> eligible (out-of-lane Today rows do not hold the gate)
    F  its child (Linked ID 941, no lane of its own)            -> eligible (inherited)
    C  session -CheckDispatch for the home task                 -> session_lane_not_served
    D  session -SessionId (bind) for the home task              -> session_lane_not_served, binding unchanged
    E  the same planner with NO agent-lanes.json                -> the home task is eligible (off is off)
    G  agent-lanes.json that does not parse                     -> the home task with his reply (eligible when lanes are off) is not (fail closed)
  MUTANTS (each must be killed by the arm named):
    M1 scan ignores lanes for eligibility                       -> A
    M2 out-of-lane Today rows still hold the Today gate         -> B
    M3 the dispatch check skips the lane floor                  -> C
    M4 a bind skips the lane floor                              -> D
    M5 no inheritance through Linked ID                         -> F
    M6 an invalid file is treated as lanes off                  -> G
    M7 an absent file is treated as invalid                     -> E

  Usage: pwsh -File mutcheck-lanes.ps1 [-ScriptPath <oa-state.ps1|oa-state.mjs>]
  Exit 0: every arm holds and every mutant is killed by its arm.
#>
[CmdletBinding()]
param([string]$ScriptPath)
$ErrorActionPreference = 'Stop'
if (-not $ScriptPath) { $ScriptPath = Join-Path $PSScriptRoot 'oa-state.ps1' }
$ScriptPath = (Resolve-Path $ScriptPath).Path
. (Join-Path (Split-Path -Parent $ScriptPath) 'oa-state-target.ps1')
$isNode = Test-OaStateNodeTarget $ScriptPath
$utf8 = New-Object Text.UTF8Encoding($false)
$root = Join-Path ([IO.Path]::GetTempPath()) ('oa-lanes-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $root -Force | Out-Null
$moon = [char]::ConvertFromUtf32(0x1F319)
$deviceA = '{"schema":"fp-agent-device@1","id":"3f2b9c4e-8d1a-4b7e-9f60-2c5d8e1a7b34","createdAt":"2020-03-01T00:00:00.000Z"}'
$lanesFile = '{"schema":"fp-agent-lanes@1","devices":{"86b8ff7cab63af69cc52ff83591b0ffd":{"lanes":["ado"],"catchAll":false},"49c15e85f7f7ffd841a8cb86d233f965":{"lanes":["home"],"catchAll":true}},"tasks":{"941":"ado"}}'

function Write-Utf8([string]$p, [string]$s) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $p) | Out-Null
  [IO.File]::WriteAllText($p, $s, $utf8)
}

function New-Sandbox([string]$name, $lanes) {
  $sx = Join-Path $root $name
  $board = "## Today`n`n| ID | 🎯 | Task | Work Priority | Added | Linked ID |`n|---|---|---|---|---|---|`n" +
    "| 940 | 🟡 | Home errand #lane:home | - | 2020-01-10 | |`n| 943 | 🟡 | Home today #lane:home | - | 2020-01-10 | |`n`n" +
    "## Deferred`n`n| ID | 🎯 | Task | Work Priority | Added | Wake | Linked ID |`n|---|---|---|---|---|---|---|`n" +
    "| 941 | 🟡 | ADO report | - | 2020-01-05 | | |`n| 942 | 🟡 | ADO follow-up | - | 2020-01-05 | | 941 |`n"
  Write-Utf8 (Join-Path $sx 'data\planner.md') $board
  foreach ($f in 'planner-completed.md', 'user-settings.md', 'agent-gate.md') { Write-Utf8 (Join-Path $sx "data\$f") '' }
  Write-Utf8 (Join-Path $sx 'data\snooze.json') '{}'
  if ($null -ne $lanes) { Write-Utf8 (Join-Path $sx 'data\agent-lanes.json') $lanes }
  Write-Utf8 (Join-Path $sx 'device.json') $deviceA
  Write-Utf8 (Join-Path $sx 'data\journal\task-940.md') ("# Task 940: Home errand`n`nUser notes.`n`n---`n<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->`n`n" +
    "## $moon Overnight Agent - 2020-03-01`n`n<!-- from: overnight-agent -->`n<!-- oa-ask: offer -->`n**Status:** In progress`n`nWorking on it.`n<!-- /overnight-agent turn-end -->`n`n" +
    "## 2020-03-02`n`n<!-- from: me -->`nplease also check the gutters`n")
  foreach ($id in '941', '942', '943') { Write-Utf8 (Join-Path $sx "data\journal\task-$id.md") "# Task ${id}: task $id`n`nUser notes.`n" }
  # 941 is QUIET (tracked, unchanged since its last turn): only the Today gate decides whether it is
  # eligible, so arm B really measures that out-of-lane Today rows do not hold the gate here. An
  # untracked journal would read as `reopened` and be eligible through the gate.
  $sha = [Security.Cryptography.SHA256]::Create()
  $h941 = -join ($sha.ComputeHash($utf8.GetBytes("# Task 941: task 941`n`nUser notes.`n")) | ForEach-Object { $_.ToString('x2') })
  $sha.Dispose()
  $quiet = [ordered]@{ id = '941'; status = 'in-progress'; status_by = 'agent'; version = 1; plan_id = 't941-v1'; processed_file_hash = $h941
    has_agent_block = $false; seeded = $true; updated = '2020-03-01T12:00:00Z' }
  Write-Utf8 (Join-Path $sx 'state\task-941.json') ($quiet | ConvertTo-Json -Depth 6)
  $state = [ordered]@{ id = '940'; status = 'in-progress'; status_by = 'agent'; version = 1; plan_id = 't940-v1'; processed_file_hash = ''
    has_agent_block = $true; seeded = $false; updated = '2020-03-01T12:00:00Z'
    session = [ordered]@{ session_id = 'S-940'; kind = 'chat'; project = 'p'; workspace = ''; workspace_type = 'folder'
      created_at = '2020-03-01T00:00:00Z'; last_woken_at = ''; state = 'live'; prior_session_id = ''; replaced_at = '' } }
  # The agent home is the parent of the state folder: device.json sits beside state\.
  Write-Utf8 (Join-Path $sx 'state\task-940.json') ($state | ConvertTo-Json -Depth 6)
  Write-Utf8 (Join-Path $sx 'sessions.json') '{"sessions":[{"id":"S-940","activity":{"status":"idle"}}]}'
  return $sx
}

function Invoke-Engine([string]$engine, [string]$sx, [string[]]$a) {
  $cmd = Get-OaStateCommand $engine
  $common = @('-JournalDir', (Join-Path $sx 'data\journal'), '-StateDir', (Join-Path $sx 'state'),
    '-PlannerBoard', (Join-Path $sx 'data\planner.md'), '-PlannerCompleted', (Join-Path $sx 'data\planner-completed.md'),
    '-SnoozeStore', (Join-Path $sx 'data\snooze.json'), '-GatePath', (Join-Path $sx 'data\agent-gate.md'),
    '-UserSettings', (Join-Path $sx 'data\user-settings.md'), '-SessionStateDir', (Join-Path $sx 'session-state'),
    '-McpConfig', (Join-Path $sx 'mcp.json'))
  $out = & $cmd.Exe @($cmd.Prefix + $a + $common) 2>&1 | Out-String
  return [pscustomobject]@{ exit = $LASTEXITCODE; text = $out }
}

function Get-Eligible([string]$engine, [string]$sx, [string]$id) {
  $scan = Invoke-Engine $engine $sx @('scan')
  if ($scan.exit -ne 0) { return "scan exit $($scan.exit)" }
  $row = @($scan.text | ConvertFrom-Json) | Where-Object { "$($_.id)" -eq $id } | Select-Object -First 1
  if (-not $row) { return 'no row' }
  return [bool]$row.eligible
}

function Test-Arms([string]$engine, [string]$label) {
  $failed = @()
  $lanes = New-Sandbox "$label-lanes" $lanesFile
  $off = New-Sandbox "$label-off" $null
  $invalid = New-Sandbox "$label-invalid" 'not json'
  $checks = [ordered]@{}
  $checks.A = ((Get-Eligible $engine $lanes '940') -eq $false)
  $scan = Invoke-Engine $engine $lanes @('scan')
  $rows = if ($scan.exit -eq 0) { @($scan.text | ConvertFrom-Json) } else { @() }
  $checks.B = [bool](@($rows | Where-Object { "$($_.id)" -eq '941' -and $_.eligible }).Count)
  $checks.F = [bool](@($rows | Where-Object { "$($_.id)" -eq '942' -and $_.eligible }).Count)
  $r = Invoke-Engine $engine $lanes @('session', '-Id', '940', '-CheckDispatch', '-SessionsStatusFile', (Join-Path $lanes 'sessions.json'))
  $checks.C = ($r.exit -ne 0 -and $r.text -match 'session_lane_not_served')
  $before = [IO.File]::ReadAllText((Join-Path $lanes 'state\task-940.json'))
  $r = Invoke-Engine $engine $lanes @('session', '-Id', '940', '-SessionId', 'S-NEW', '-Force')
  $after = [IO.File]::ReadAllText((Join-Path $lanes 'state\task-940.json'))
  $checks.D = ($r.exit -ne 0 -and $r.text -match 'session_lane_not_served' -and $before -ceq $after)
  $checks.E = ((Get-Eligible $engine $off '940') -eq $true)
  $checks.G = ((Get-Eligible $engine $invalid '940') -eq $false)
  foreach ($k in $checks.Keys) {
    if (-not $checks[$k]) { $failed += $k }
    if ($label -eq 'baseline') { Write-Host ("  {0} {1}" -f $(if ($checks[$k]) { 'PASS' } else { 'FAIL' }), $k) }
  }
  return , $failed
}

$mutants = if ($isNode) {
  @(
    @{ n = 'M1'; kills = 'A'; find = "    if (notHere(r)) eligible = false;`n    else if (!r.snoozed) {"; repl = "    if (!r.snoozed) {" },
    @{ n = 'M2'; kills = 'B'; find = "if (r.section === 'today' && !notHere(r)) verdicts"; repl = "if (r.section === 'today') verdicts" },
    @{ n = 'M3'; kills = 'C'; find = "  assertLaneServed(ctx, psStr(get(st, 'id')));"; repl = '' },
    @{ n = 'M4'; kills = 'D'; find = "    assertLaneServed(ctx, ctx.p.Id);"; repl = '' },
    @{ n = 'M5'; kills = 'F'; find = "  for (const p of own(board.linked, id) ? board.linked[id] : []) {"; repl = "  for (const p of []) {" },
    @{ n = 'M6'; kills = 'G'; find = "  if (cfg === null) return null;"; repl = "  if (cfg === null || cfg.state !== 'ok') return null;" },
    @{ n = 'M7'; kills = 'E'; find = "  try { st = fs.statSync(file); } catch { return null; }"; repl = "  try { st = fs.statSync(file); } catch { return { state: 'invalid', reason: 'absent', devices: {}, tasks: {} }; }" }
  )
} else {
  @(
    @{ n = 'M1'; kills = 'A'; find = "    if (& `$notHere `$r) { `$eligible = `$false }`r`n    elseif (-not `$r.snoozed) {"; repl = "    if (-not `$r.snoozed) {" },
    @{ n = 'M2'; kills = 'B'; find = "if (`$r.section -eq 'today' -and -not (& `$notHere `$r)) { `$verdicts"; repl = "if (`$r.section -eq 'today') { `$verdicts" },
    @{ n = 'M3'; kills = 'C'; find = "  Assert-LaneServed `"`$(`$st.id)`""; repl = '' },
    @{ n = 'M4'; kills = 'D'; find = "    Assert-LaneServed `"`$Id`""; repl = '' },
    @{ n = 'M5'; kills = 'F'; find = "  `$stack.Add(@(`$id, 0, 0))"; repl = '' },
    @{ n = 'M6'; kills = 'G'; find = "  if (`$null -eq `$cfg) { return `$null }"; repl = "  if (`$null -eq `$cfg -or `$cfg.state -ne 'ok') { return `$null }" },
    @{ n = 'M7'; kills = 'E'; find = "  if (-not `$item) { return `$null }"; repl = "  if (-not `$item) { return (& `$bad 'absent') }" }
  )
}

$bad = 0
try {
  Write-Host "[mutcheck-lanes] target = $ScriptPath"
  Write-Host '[baseline]'
  $base = Test-Arms $ScriptPath 'baseline'
  if ($base.Count) { Write-Host "FAIL: baseline arms failed: $($base -join ', ')" -ForegroundColor Red; $bad++ }
  foreach ($m in $mutants) {
    $find = $m.find
    if (-not $isNode) {
      $src = [IO.File]::ReadAllText($ScriptPath)
      if (-not $src.Contains($find)) { $find = $find.Replace("`r`n", "`n") }
    } else {
      $hit = @(Get-ChildItem -LiteralPath (Join-Path (Split-Path -Parent $ScriptPath) 'oa-state-lib') -Recurse -File -Filter '*.mjs' |
        Where-Object { [IO.File]::ReadAllText($_.FullName).Contains($find.Replace("`n", "`r`n")) })
      if ($hit.Count -and -not @(Get-ChildItem -LiteralPath (Join-Path (Split-Path -Parent $ScriptPath) 'oa-state-lib') -Recurse -File -Filter '*.mjs' |
          Where-Object { [IO.File]::ReadAllText($_.FullName).Contains($find) }).Count) { $find = $find.Replace("`n", "`r`n") }
    }
    $mut = New-OaStateMutant $ScriptPath $m.n $find $m.repl (Join-Path $root 'mutants')
    $killed = Test-Arms $mut $m.n
    $ok = ($killed -contains $m.kills)
    Write-Host ("  [{0}] {1} killed by {2} (expected {3})" -f $(if ($ok) { 'KILLED' } else { 'SURVIVED' }), $m.n, $(if ($killed.Count) { $killed -join ',' } else { 'nothing' }), $m.kills)
    if (-not $ok) { $bad++ }
  }
}
finally { Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue }
if ($bad) { Write-Host "FAILED ($bad)" -ForegroundColor Red; exit 1 }
Write-Host 'PASS: every arm holds and every mutant is killed by its arm.'
exit 0
