<#
.SYNOPSIS
  End-to-end sandbox run of the Overnight Agent, with monitoring and machine-checked assertions.

.DESCRIPTION
  Builds a throwaway sandbox (planner folder, OA home, isolated COPILOT_HOME, redirected profile
  variables), seeds a small synthetic planner with one task per scenario, proves each seed means
  what it claims using the code under test, then launches a real headless coordinator run
  (`copilot -p /overnight-agent`) against the plugin exported from -Ref, and asserts on what it
  did: journals, state, dispatches, tool calls, and invariants (gate untouched, nothing outside
  the sandbox, no denied tool, timeout honoured).

  Nothing external is reachable from inside: no live MCP server is configured (the isolated
  COPILOT_HOME has only the stub app host), GitHub is unreachable for gh and git, Telegram and the
  inbox are off, and every tripwired script refuses a path outside OA_SANDBOX_ROOT.

  See README.md beside this file for monitoring a run live and the baseline-vs-candidate rule.

.PARAMETER Ref
  The source under test: a git ref (exported with git archive) or a directory (a worktree, copied
  as-is including uncommitted changes). Default: this checkout's working tree.

.PARAMETER Scenario
  A scenario name, letter or task id from lib\scenarios.ps1, or `all` (one run, every scenario).

.PARAMETER SeedOnly
  Build, seed and precheck only. No model call, no credits. This is what CI runs.

.EXAMPLE
  pwsh -File run-sandbox.ps1 -Ref origin/main -Label baseline
  pwsh -File run-sandbox.ps1 -Ref . -Label candidate
  pwsh -File compare.ps1 -Baseline <baseline report.json> -Candidate <candidate report.json>
#>
[CmdletBinding()]
param(
  [string]$Ref,
  [string]$Scenario = 'all',
  [string]$OutDir,
  [string]$Label = 'run',
  [string]$Model = 'claude-sonnet-5',
  [int]$MaxCredits = 800,
  [int]$TimeoutMinutes = 28,
  [int]$MinWindowMinutes = 26,
  [ValidateSet('record', 'execute')][string]$Dispatch = 'record',
  [int]$Retries = 1,
  [int]$Concurrency = 3,
  [switch]$SeedOnly,
  [switch]$NoWait
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib\sandbox.ps1')
. (Join-Path $PSScriptRoot 'lib\scenarios.ps1')
. (Join-Path $PSScriptRoot 'lib\planner.ps1')

$harnessRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..')).Path
if (-not $Ref) { $Ref = $harnessRoot }
if (-not $OutDir) { $OutDir = Join-Path ([IO.Path]::GetTempPath()) 'oa-e2e' }
$copilotExe = (Get-Command copilot -ErrorAction SilentlyContinue).Source
if (-not $SeedOnly -and -not $copilotExe) { throw 'copilot CLI not found on PATH' }

# Tools the coordinator must never use from a sandbox, whatever its prompt says. Every attempt is
# reported as a failure (invariant i3), so a regression that starts reaching out is visible.
$DenyTools = @(
  'shell(git push)', 'shell(gh pr merge)', 'shell(gh pr create)', 'shell(gh issue comment)',
  'shell(gh issue create)', 'shell(gh api)', 'shell(gh release)', 'shell(curl)', 'shell(Invoke-WebRequest)',
  'shell(Invoke-RestMethod)', 'web_fetch', 'web_search'
)

function Get-LiveRoots {
  $roots = @($env:USERPROFILE, $env:LOCALAPPDATA, $env:APPDATA, $env:OneDrive, $env:OneDriveConsumer,
    $env:OneDriveCommercial, (Join-Path $env:USERPROFILE '.copilot'), $harnessRoot)
  return @($roots | Where-Object { $_ } | Select-Object -Unique)
}

function Write-CopilotHome($L, [string]$AppScript, [hashtable]$AppEnv) {
  # Identity only (which login to use); the credential itself stays in the OS store.
  $real = Join-Path $env:USERPROFILE '.copilot\config.json'
  $cfg = [ordered]@{}
  if (Test-Path -LiteralPath $real) {
    $r = Get-Content -LiteralPath $real -Raw | ConvertFrom-Json
    if ($r.PSObject.Properties['lastLoggedInUser']) { $cfg.lastLoggedInUser = $r.lastLoggedInUser }
    if ($r.PSObject.Properties['loggedInUsers']) { $cfg.loggedInUsers = $r.loggedInUsers }
  }
  Write-Utf8 (Join-Path $L.CopilotHome 'config.json') ($cfg | ConvertTo-Json -Depth 6)
  $mcp = [ordered]@{ mcpServers = [ordered]@{ 'sandbox-app' = [ordered]@{
        type = 'stdio'; command = (Get-Command node).Source; args = @($AppScript); env = $AppEnv; tools = @('*') } } }
  Write-Utf8 (Join-Path $L.CopilotHome 'mcp-config.json') ($mcp | ConvertTo-Json -Depth 6)
}

function Assert-SandboxSupport($L, $src) {
  foreach ($f in @('skills\overnight-agent\oa-state.ps1', 'skills\overnight-agent\write-turn.ps1')) {
    $p = Join-Path $L.PluginDir $f
    if (-not (Test-Path -LiteralPath $p) -or -not (Select-String -LiteralPath $p -Pattern 'OA_SANDBOX_ROOT' -SimpleMatch -Quiet)) {
      throw "ref $($src.ref) ($($src.sha)) predates sandbox mode: $f has no OA_SANDBOX_ROOT tripwire, so a run could write live data. Refusing."
    }
  }
}

function Wait-ForWindow {
  if ($NoWait) { return }
  $now = Get-Date
  $left = ((Get-HardEnd $now) - $now).TotalMinutes
  if ($left -ge $MinWindowMinutes) { return }
  $next = (Get-HardEnd $now).AddMinutes(1).AddSeconds(20)
  Write-Host ("[e2e] {0:N1} min left before this half-hour's hard end; waiting until {1:HH:mm:ss} for a full window" -f $left, $next)
  Start-Sleep -Seconds ([Math]::Max(1, [int]($next - (Get-Date)).TotalSeconds))
}

function Invoke-Attempt($Scenarios, [int]$Attempt, [string]$SessionRoot, [string]$Name) {
  $dir = Join-Path $SessionRoot ("attempt-{0}-{1}" -f $Attempt, $Name)
  $art = Join-Path $dir 'artifacts'
  $L = Get-SandboxLayout (Join-Path $dir 'sandbox')
  New-SandboxDirs $L
  New-Item -ItemType Directory -Force -Path $art | Out-Null
  $src = Export-SourceUnderTest $Ref $harnessRoot $L.Repo
  Assert-SandboxSupport $L $src

  $harnessDir = Join-Path $L.Root 'harness'
  New-Item -ItemType Directory -Force -Path $harnessDir | Out-Null
  Copy-Item (Join-Path $PSScriptRoot 'lib\sandbox-app-mcp.mjs') $harnessDir
  $env0 = Get-SandboxEnv $L
  $ctx = New-SandboxPlanner $L $env0 $Scenarios $Concurrency
  $appEnv = [ordered]@{
    SANDBOX_APP_DIR = $L.AppDir; SANDBOX_APP_MODE = $Dispatch; SANDBOX_APP_PROJECT_ID = $ctx.ProjectId
    SANDBOX_APP_TASK_CHATS = $L.TaskChats; SANDBOX_APP_PLUGIN_DIR = $L.PluginDir; SANDBOX_APP_MODEL = $Model
    SANDBOX_APP_COPILOT = "$copilotExe"; SANDBOX_APP_DENY = ($DenyTools -join "`n")
  }
  Write-CopilotHome $L (Join-Path $harnessDir 'sandbox-app-mcp.mjs') $appEnv
  $pre = @($ctx.PreexistingSessions | ForEach-Object {
      [ordered]@{ id = $_.id; name = $_.name; project_id = $ctx.ProjectId; path = $L.TaskChats; created_at = (Get-Date).AddDays(-3).ToString('o'); sends = 1 } })
  Write-Utf8 (Join-Path $L.AppDir 'sessions.json') (ConvertTo-Json -InputObject @($pre) -Depth 5)

  $prechecks = @(Invoke-Prechecks $ctx $Scenarios)
  $meta = [ordered]@{ attempt = $Attempt; dir = $dir; scenarios = @($Scenarios.Name); source = $src
    sandbox = $L.Root; prechecks = $prechecks; valid = -not @($prechecks | Where-Object { -not $_.pass }).Count }
  if (-not $meta.valid -or $SeedOnly) { return [pscustomobject]$meta }

  # --- before snapshot -------------------------------------------------------------------
  $beforeManifest = Get-DataManifest $L
  $before = Get-TaskSnapshot $L
  $gatePath = Join-Path $L.Planner 'agent-gate.md'
  $gateBefore = (Get-FileHash -LiteralPath $gatePath -Algorithm SHA256).Hash
  Copy-Item -Recurse -LiteralPath $L.Planner (Join-Path $art 'before\planner')
  Copy-Item -Recurse -LiteralPath $L.StateDir (Join-Path $art 'before\state')

  # --- launch -----------------------------------------------------------------------------
  # The CLI unpacks its runtime (~145 MB) under %LOCALAPPDATA%\copilot\pkg, and LOCALAPPDATA is
  # redirected, so every fresh sandbox would unpack it again (minutes on a loaded machine). Share
  # one harness-owned cache across runs through a junction. It holds only the CLI's own package.
  $pkgCache = Join-Path $OutDir '_cache\copilot-pkg'
  New-Item -ItemType Directory -Force -Path $pkgCache, (Join-Path $L.LocalAppData 'copilot') | Out-Null
  $pkgLink = Join-Path $L.LocalAppData 'copilot\pkg'
  if (-not (Test-Path -LiteralPath $pkgLink)) { New-Item -ItemType Junction -Path $pkgLink -Target $pkgCache | Out-Null }
  Wait-ForWindow
  $cpuLoad = try { [int](Get-CimInstance Win32_Processor | Measure-Object LoadPercentage -Average).Average } catch { $null }
  $sessionId = [guid]::NewGuid().ToString()
  $start = Get-Date
  $hardEnd = Get-HardEnd $start
  $budget = [Math]::Min($TimeoutMinutes, [Math]::Max(3, ($hardEnd - $start).TotalMinutes + 2))
  $argv = @('-C', $L.Root, '--plugin-dir', $L.PluginDir, '-p', '/overnight-agent', '--allow-all-tools',
    '--session-id', $sessionId, '--share', (Join-Path $art 'transcript.md'), '--log-dir', (Join-Path $art 'logs'),
    '--no-ask-user', '--disable-builtin-mcps', '--no-custom-instructions', '--no-auto-update', '--no-remote',
    '--max-ai-credits', "$MaxCredits", '--model', $Model, '--usage-output-file', (Join-Path $art 'usage.json'),
    '--output-format', 'json')
  foreach ($d in $DenyTools) { $argv += @('--deny-tool', $d) }
  $psi = [Diagnostics.ProcessStartInfo]::new($copilotExe)
  foreach ($a in $argv) { $psi.ArgumentList.Add($a) }
  foreach ($k in $env0.Keys) {
    if ($null -eq $env0[$k]) { [void]$psi.Environment.Remove($k) } else { $psi.Environment[$k] = "$($env0[$k])" }
  }
  $psi.WorkingDirectory = $L.Root
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $eventsLive = Join-Path $L.CopilotHome "session-state\$sessionId\events.jsonl"
  Write-Utf8 (Join-Path $dir 'monitor.txt') ("session id : $sessionId`nevents     : $eventsLive`ntranscript : $(Join-Path $art 'transcript.md') (written at exit)`n" +
    "dispatches : $(Join-Path $L.AppDir 'dispatch-log.jsonl')`nstarted    : $($start.ToString('o'))`nhard end   : $($hardEnd.ToString('o'))`n" +
    "monitor    : pwsh -File $(Join-Path $PSScriptRoot 'monitor.ps1') -RunDir `"$dir`"`n")
  Write-Host "[e2e] attempt $Attempt ($Name): session $sessionId, budget $([int]$budget) min, sandbox $($L.Root)"
  $p = [Diagnostics.Process]::Start($psi)
  $stdoutTask = $p.StandardOutput.ReadToEndAsync()
  $stderrTask = $p.StandardError.ReadToEndAsync()
  $timedOut = -not $p.WaitForExit([int]($budget * 60 * 1000))
  if ($timedOut) { Stop-ProcessTree $p.Id; $p.WaitForExit(15000) | Out-Null }
  $end = Get-Date
  [IO.File]::WriteAllText((Join-Path $art 'stdout.jsonl'), $stdoutTask.Result)
  [IO.File]::WriteAllText((Join-Path $art 'stderr.log'), $stderrTask.Result)

  # --- stop children, collect ---------------------------------------------------------------
  $leftovers = @()
  $sessions = @()
  try { $sessions = @((Read-Utf8 (Join-Path $L.AppDir 'sessions.json')) | ConvertFrom-Json) } catch { }
  foreach ($s in $sessions) {
    if ($s.PSObject.Properties['pid'] -and $s.pid -and (Get-Process -Id $s.pid -ErrorAction SilentlyContinue)) {
      $leftovers += $s.id; Stop-ProcessTree ([int]$s.pid)
    }
  }
  foreach ($f in @('dispatch-log.jsonl', 'sessions.json')) {
    $pth = Join-Path $L.AppDir $f; if (Test-Path -LiteralPath $pth) { Copy-Item -LiteralPath $pth $art }
  }
  if (Test-Path -LiteralPath (Join-Path $L.AppDir 'children')) { Copy-Item -Recurse -LiteralPath (Join-Path $L.AppDir 'children') (Join-Path $art 'children') }
  if (Test-Path -LiteralPath $eventsLive) { Copy-Item -LiteralPath $eventsLive (Join-Path $art 'events.jsonl') }
  Copy-Item -Recurse -LiteralPath $L.Planner (Join-Path $art 'after\planner')
  Copy-Item -Recurse -LiteralPath $L.StateDir (Join-Path $art 'after\state')
  foreach ($f in @('run-ledger.jsonl', 'capabilities.json')) {
    $pth = Join-Path $L.OaHome $f; if (Test-Path -LiteralPath $pth) { Copy-Item -LiteralPath $pth $art }
  }
  $afterManifest = Get-DataManifest $L
  $after = Get-TaskSnapshot $L
  $diff = Compare-Manifest $beforeManifest $afterManifest
  $gateAfter = if (Test-Path -LiteralPath $gatePath) { (Get-FileHash -LiteralPath $gatePath -Algorithm SHA256).Hash } else { 'deleted' }
  $null = & git diff --no-index --no-color -- (Join-Path $art 'before\planner') (Join-Path $art 'after\planner') 2>$null |
    Set-Content -LiteralPath (Join-Path $art 'planner.diff') -Encoding utf8

  $analysisFile = Join-Path $art 'analysis.json'
  $liveArgs = @(); foreach ($r in Get-LiveRoots) { $liveArgs += @('--live', $r) }
  & node (Join-Path $PSScriptRoot 'lib\analyze-events.mjs') --events (Join-Path $art 'events.jsonl') --sandbox $L.Root `
    --skill $L.SkillDir @liveArgs --out $analysisFile | Out-Null
  $analysis = Get-Content -LiteralPath $analysisFile -Raw | ConvertFrom-Json -Depth 30
  $usage = $null
  if (Test-Path -LiteralPath (Join-Path $art 'usage.json')) { $usage = Get-Content -LiteralPath (Join-Path $art 'usage.json') -Raw | ConvertFrom-Json -Depth 30 }
  $credits = if ($usage -and $usage.PSObject.Properties['totalNanoAiu']) { [math]::Round($usage.totalNanoAiu / 1e9, 1) } else { $null }
  $result = @($stdoutTask.Result -split "`r?`n" | Where-Object { $_ -match '^\{"type":"result"' } | Select-Object -Last 1)
  $exitCode = if ($timedOut) { $null } else { $p.ExitCode }

  # --- facts for the assertions -------------------------------------------------------------
  $bindings = @{}
  foreach ($k in $after.States.Keys) {
    $st = $after.States[$k]
    if ($st -and $st.PSObject.Properties['session'] -and $st.session -and "$($st.session.session_id)") { $bindings["$($st.session.session_id)"] = $k }
    if ($st -and $st.PSObject.Properties['session'] -and $st.session -and $st.session.PSObject.Properties['prior_session_ids']) {
      foreach ($old in @($st.session.prior_session_ids)) { if ($old) { $bindings["$old"] = $k } }
    }
  }
  $dispatches = @()
  $logFile = Join-Path $art 'dispatch-log.jsonl'
  if (Test-Path -LiteralPath $logFile) {
    foreach ($line in Get-Content -LiteralPath $logFile) {
      if (-not $line.Trim()) { continue }
      $e = $line | ConvertFrom-Json -Depth 20
      $msg = $null; $sid = $null
      if ($e.tool -eq 'send_session_message') { $msg = "$($e.args.message)"; $sid = "$($e.args.session_id)" }
      elseif ($e.tool -eq 'create_session' -and $e.args.PSObject.Properties['kickoff'] -and $e.args.kickoff) { $msg = "$($e.args.kickoff.prompt)"; $sid = "$($e.result.id)" }
      else { continue }
      if ($e.error) { continue }
      $task = $null
      if ($msg -match 'task session for planner task #(\d+)') { $task = $Matches[1] }
      elseif ($bindings.ContainsKey($sid)) { $task = $bindings[$sid] }
      $dispatches += [pscustomobject]@{ at = $e.at; tool = $e.tool; session_id = $sid; task_id = $task; message = $msg }
    }
  }
  $facts = [pscustomobject]@{
    Before = $before; After = $after; Diff = $diff; Dispatches = $dispatches; DispatchMode = $Dispatch
    GateBefore = $gateBefore; GateAfter = $gateAfter
    LivePathHits = @($analysis.livePathHits); TripwireHits = @($analysis.tripwireHits)
    DeniedCalls = @($analysis.deniedCalls); Provenance = $analysis.provenance
    FinalMessage = "$($analysis.finalMessage)"
    Run = [pscustomobject]@{ timedOut = $timedOut; completed = [bool]$result.Count; exitCode = $exitCode
      durationSec = ($end - $start).TotalSeconds }
  }
  $scenarioResults = @()
  foreach ($s in $Scenarios) {
    $checks = @(& $s.Assert $facts)
    $scenarioResults += [pscustomobject]@{ name = $s.Name; letter = $s.Letter; id = $s.Id
      pass = -not @($checks | Where-Object { -not $_.pass }).Count; checks = $checks }
  }
  $inv = @(Get-InvariantChecks $facts)
  # j: completion is reported as its own outcome, not as a safety invariant. A run that its own
  # hard end cut short, or that the harness had to kill, cannot prove a scenario either way, so a
  # scenario that failed in such a run is `inconclusive` rather than `fail`.
  $cut = @($analysis.cutShort)
  $completion = @(
    New-Check 'j1' 'run finished on its own within the timeout' (-not $timedOut -and [bool]$result.Count) "exit $exitCode, $([int]($end - $start).TotalSeconds)s$(if ($timedOut) { ', killed at the timeout' })"
    New-Check 'j2' 'run was not cut short by the coordinator hard end' (-not $cut.Count) (($cut | Select-Object -First 2) -join ' | ')
  )
  $meta.completion = [pscustomobject]@{ pass = -not @($completion | Where-Object { -not $_.pass }).Count; checks = $completion }
  $meta.sessionId = $sessionId
  $meta.startedAt = $start.ToString('o'); $meta.durationSec = [int]($end - $start).TotalSeconds
  $meta.timedOut = $timedOut; $meta.exitCode = $exitCode; $meta.credits = $credits; $meta.cpuLoadAtStart = $cpuLoad
  $meta.toolCalls = @($analysis.toolCalls).Count; $meta.toolCounts = $analysis.toolCounts
  $meta.dispatches = @($dispatches | Select-Object at, tool, session_id, task_id)
  $meta.leftoverChildren = $leftovers
  $meta.diff = $diff
  $meta.results = $scenarioResults
  $meta.invariants = [pscustomobject]@{ pass = -not @($inv | Where-Object { -not $_.pass }).Count; checks = $inv }
  $meta.finalMessage = $facts.FinalMessage
  $meta.artifacts = $art
  return [pscustomobject]$meta
}

# ---------------------------------------------------------------------------------------------

$chosen = @(Get-Scenario $Scenario)
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$sessionRoot = Join-Path $OutDir "$stamp-$Label"
New-Item -ItemType Directory -Force -Path $sessionRoot | Out-Null
$t0 = Get-Date
$attempts = @()
$first = Invoke-Attempt $chosen 1 $sessionRoot $Scenario
$attempts += $first

$outcomes = [ordered]@{}
if (-not $first.valid) {
  foreach ($s in $chosen) { $outcomes[$s.Name] = 'invalid-seed' }
} elseif ($SeedOnly) {
  foreach ($s in $chosen) { $outcomes[$s.Name] = 'seeded' }
} else {
  $inc = -not $first.completion.pass
  foreach ($r in $first.results) { $outcomes[$r.name] = if ($r.pass) { 'pass' } elseif ($inc) { 'inconclusive' } else { 'fail' } }
  $n = 1
  if ($Retries -gt 0) {
    # A failed or inconclusive scenario is retried ONCE in a fresh sandbox. Passing then marks a
    # failed one flaky (reported, not hidden). If the first run did not complete, every scenario
    # is undecided, so the whole set is retried together (one run) rather than one by one.
    # Invariants are safety properties: no retry clears a violation, so the invariants outcome
    # below is the worst across every attempt.
    $retryNames = @($first.results | Where-Object { -not $_.pass } | ForEach-Object name)
    $groups = New-Object Collections.ArrayList
    if ($inc -and $retryNames.Count -gt 1) { [void]$groups.Add([string[]]$retryNames) }
    else { foreach ($nm in $retryNames) { [void]$groups.Add([string[]]@($nm)) } }
    foreach ($group in $groups) {
      $n++
      $set = @($group | ForEach-Object { Get-Scenario $_ })
      $a = Invoke-Attempt $set $n $sessionRoot $(if ($group.Count -gt 1) { 'retry-set' } else { $group[0] })
      $attempts += $a
      foreach ($name in $group) {
        $r = @($a.results | Where-Object name -eq $name)[0]
        if ($r -and $r.pass) { $outcomes[$name] = if ($outcomes[$name] -eq 'fail') { 'flaky' } else { 'pass' } }
        elseif ($r -and $a.completion.pass) { $outcomes[$name] = 'fail' }
      }
    }
  }
  $invFailed = @($attempts | Where-Object { $_.PSObject.Properties['invariants'] -and $_.invariants -and -not $_.invariants.pass }).Count
  $outcomes['invariants'] = if ($invFailed) { 'fail' } else { 'pass' }
  $outcomes['completion'] = if ($first.completion.pass) { 'pass' } else { 'fail' }
}

$overall = if (@($outcomes.Values | Where-Object { $_ -in @('fail', 'invalid-seed') }).Count) { 'fail' }
           elseif (@($outcomes.Values | Where-Object { $_ -eq 'inconclusive' }).Count) { 'inconclusive' } else { 'pass' }
$report = [ordered]@{
  schema = 'oa-e2e-report/1'
  label = $Label; ref = $first.source; scenario = $Scenario; model = $Model; dispatch = $Dispatch
  seedOnly = [bool]$SeedOnly; startedAt = $t0.ToString('o'); durationSec = [int]((Get-Date) - $t0).TotalSeconds
  credits = (@($attempts | Where-Object { $null -ne $_.credits } | ForEach-Object credits) | Measure-Object -Sum).Sum
  result = $overall; outcomes = $outcomes; attempts = $attempts
}
$reportJson = Join-Path $sessionRoot 'report.json'
Write-Utf8 $reportJson ($report | ConvertTo-Json -Depth 12)

$md = New-Object Text.StringBuilder
[void]$md.Append("# Overnight Agent e2e sandbox run: $Label`n`n")
[void]$md.Append("- Result: **$overall**`n- Source: $($first.source.kind) ``$($first.source.ref)`` @ ``$($first.source.sha)``$(if ($first.source.dirty) { ' (dirty)' })`n")
[void]$md.Append("- Model: ``$Model`` - dispatch mode: ``$Dispatch`` - started $($t0.ToString('yyyy-MM-dd HH:mm'))`n")
[void]$md.Append("- Credits: $($report.credits) - wall time: $($report.durationSec)s`n`n")
[void]$md.Append("| Scenario | Outcome |`n|---|---|`n")
foreach ($k in $outcomes.Keys) { [void]$md.Append("| $k | $($outcomes[$k]) |`n") }
foreach ($a in $attempts) {
  [void]$md.Append("`n## Attempt $($a.attempt): $($a.scenarios -join ', ')`n`n")
  if ($a.PSObject.Properties['sessionId']) {
    [void]$md.Append("- Session ``$($a.sessionId)`` - $($a.durationSec)s - credits $($a.credits) - exit $($a.exitCode)$(if ($a.timedOut) { ' - TIMED OUT' }) - $($a.toolCalls) tool calls`n")
    [void]$md.Append("- Transcript: [$($a.artifacts)\transcript.md]($(($a.artifacts + '\transcript.md') -replace '\\', '/'))`n")
    [void]$md.Append("- Dispatches: $(@($a.dispatches).Count) ($((@($a.dispatches) | ForEach-Object { "#$($_.task_id)" }) -join ', '))`n")
  }
  [void]$md.Append("`n| Check | Result | Detail |`n|---|---|---|`n")
  foreach ($c in $a.prechecks) { [void]$md.Append("| $($c.id) $($c.name) | $(if ($c.pass) { 'pass' } else { '**FAIL**' }) | $($c.detail) |`n") }
  foreach ($r in @($a.results)) { foreach ($c in $r.checks) { [void]$md.Append("| $($c.id) $($c.name) | $(if ($c.pass) { 'pass' } else { '**FAIL**' }) | $($c.detail -replace '\|', '/') |`n") } }
  if ($a.PSObject.Properties['invariants'] -and $a.invariants) {
    foreach ($c in @($a.invariants.checks) + @($a.completion.checks)) { [void]$md.Append("| $($c.id) $($c.name) | $(if ($c.pass) { 'pass' } else { '**FAIL**' }) | $($c.detail -replace '\|', '/') |`n") }
  }
}
Write-Utf8 (Join-Path $sessionRoot 'report.md') $md.ToString()
Write-Host "[e2e] $overall - report: $reportJson"
foreach ($k in $outcomes.Keys) { Write-Host ("  {0,-28} {1}" -f $k, $outcomes[$k]) }
if ($overall -eq 'fail') { exit 1 }
if ($overall -eq 'inconclusive') { exit 2 }
exit 0
