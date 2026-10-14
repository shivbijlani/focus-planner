<#
.SYNOPSIS
  Deterministic checks for the Overnight Agent's sandbox mode (tests/e2e, item 0c). No model calls.

.DESCRIPTION
  Sandbox mode is three environment variables the live agent never sets:
    OVERNIGHT_AGENT_HOME          replaces %LOCALAPPDATA%\overnight-agent in unbound defaults
    OVERNIGHT_AGENT_PLANNER_DIR   replaces %USERPROFILE%\OneDrive\Apps\Focus Planner likewise
    OA_SANDBOX_ROOT               tripwire: a resolved path outside it is a hard error
  This proves, against the real scripts:
    1. UNSET is behaviour-neutral: the defaults resolve to exactly the paths they always did.
    2. The overrides redirect the defaults (and an explicit parameter still wins).
    3. The tripwire refuses an outside path in oa-state.ps1, write-turn.ps1, mcp-probe.mjs and
       check-critical-tools.mjs, and the machine-wide/external steps (reaper, deploy, Telegram
       mirror) refuse or no-op under it.
    4. Each tripwire is load-bearing: a mutant with the assertion removed is caught.
  Runs on Windows PowerShell 7 and on the Linux CI runner.
#>
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$plugin = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$skill = Join-Path $plugin 'skills/overnight-agent'
$checks = Join-Path $plugin 'checks'
$psExe = (Get-Process -Id $PID).Path
$root = Join-Path ([IO.Path]::GetTempPath()) ('oa-sbx-' + [guid]::NewGuid().ToString('N'))
$sb = Join-Path $root 'sandbox'
$outside = Join-Path $root 'outside'
$utf8 = New-Object Text.UTF8Encoding($false)
$passed = 0
$vars = 'OA_SANDBOX_ROOT', 'OVERNIGHT_AGENT_HOME', 'OVERNIGHT_AGENT_PLANNER_DIR', 'COPILOT_HOME', 'USERPROFILE', 'LOCALAPPDATA', 'OVERNIGHT_AGENT_SETTINGS'
$saved = @{}; foreach ($v in $vars) { $saved[$v] = [Environment]::GetEnvironmentVariable($v) }

function Check([string]$Name, [bool]$Ok, [string]$Detail = '') {
  if (-not $Ok) { throw "FAIL: $Name $Detail" }
  $script:passed++
}
function Set-Vars([hashtable]$h) {
  foreach ($v in $vars) { [Environment]::SetEnvironmentVariable($v, $saved[$v]) }
  foreach ($k in $h.Keys) { [Environment]::SetEnvironmentVariable($k, $h[$k]) }
}
function Run([string]$Script, [string[]]$Arguments) {
  $out = if ($Script -like '*.mjs') { & node $Script @Arguments 2>&1 } else { & $psExe -NoProfile -File $Script @Arguments 2>&1 }
  [pscustomobject]@{ code = $LASTEXITCODE; text = (($out | ForEach-Object { "$_" }) -join "`n") }
}
function Write-Text([string]$Path, [string]$Text) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
  [IO.File]::WriteAllText($Path, $Text, $utf8)
}
function Mutant([string]$Source, [string]$Needle, [string]$Replacement) {
  $text = [IO.File]::ReadAllText($Source)
  if (-not $text.Contains($Needle)) { throw "mutant anchor missing in $Source : $Needle" }
  $dir = Join-Path $root 'mutants'
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $path = Join-Path $dir ([IO.Path]::GetFileName($Source))
  [IO.File]::WriteAllText($path, $text.Replace($Needle, $Replacement), $utf8)
  return $path
}

$planner = Join-Path $sb 'planner'
$oaHome = Join-Path $sb 'oa-home'
$copilotHome = Join-Path $sb 'copilot-home'
try {
  Write-Text (Join-Path $planner 'planner.md') "## Today`n`n| ID | Task |`n|---|---|`n| 1 | synthetic |`n"
  Write-Text (Join-Path $planner 'agent-gate.md') "# Agent gate`n`n## Always ask (safety floor)`n`n- Spending money`n"
  Write-Text (Join-Path $planner 'journal/task-1.md') "# Task 1: synthetic`n`n- note`n"
  Write-Text (Join-Path $copilotHome 'mcp-config.json') '{"mcpServers":{}}'
  Write-Text (Join-Path $outside 'agent-gate.md') "# Agent gate`n"
  Write-Text (Join-Path $outside 'mcp-config.json') '{"mcpServers":{"email":{"type":"stdio","command":"node","args":["-e","0"]}}}'
  $fakeProfile = Join-Path $root 'profile'
  $sandboxVars = @{ OA_SANDBOX_ROOT = $sb; OVERNIGHT_AGENT_HOME = $oaHome; OVERNIGHT_AGENT_PLANNER_DIR = $planner
    COPILOT_HOME = $copilotHome; OVERNIGHT_AGENT_SETTINGS = '' }
  $state = Join-Path $skill 'oa-state.ps1'
  $turn = Join-Path $skill 'write-turn.ps1'
  $turnNode = Join-Path $skill 'write-turn.mjs'

  # 1. UNSET is behaviour-neutral: `gate` reports the default path it resolved, character for character.
  Set-Vars @{ USERPROFILE = $fakeProfile; LOCALAPPDATA = (Join-Path $root 'local'); OVERNIGHT_AGENT_SETTINGS = '' }
  $r = Run $state @('gate', '-StateDir', (Join-Path $root 'unset-state'))
  $g = $r.text | ConvertFrom-Json
  Check 'unset: gate default is the historical expression' ($g.path -ceq "$fakeProfile\OneDrive\Apps\Focus Planner\agent-gate.md") $g.path

  # 2. Overrides redirect unbound defaults; an explicit parameter still wins.
  Set-Vars $sandboxVars
  $r = Run $state @('gate')
  Check 'override: gate resolves inside the planner dir' ($r.code -eq 0 -and ($r.text | ConvertFrom-Json).path -eq (Join-Path $planner 'agent-gate.md')) $r.text
  $r = Run $state @('mark', '-Id', '1', '-Status', 'proposed')
  Check 'override: state lands in OVERNIGHT_AGENT_HOME' ($r.code -eq 0 -and (Test-Path (Join-Path $oaHome 'state/task-1.json'))) $r.text
  $explicit = Join-Path $sb 'explicit-gate.md'
  Write-Text $explicit "# Agent gate`n"
  $r = Run $state @('gate', '-GatePath', $explicit)
  Check 'override: explicit -GatePath wins' ($r.code -eq 0 -and ($r.text | ConvertFrom-Json).path -eq $explicit) $r.text

  # 3. Tripwires.
  $r = Run $state @('gate', '-GatePath', (Join-Path $outside 'agent-gate.md'))
  Check 'tripwire: oa-state refuses an outside path' ($r.code -ne 0 -and $r.text -match 'oa_sandbox_violation') $r.text
  $r = Run $state @('scan', '-Compact', '-StateDir', (Join-Path $outside 'state'))
  Check 'tripwire: oa-state refuses an outside state dir before writing' ($r.code -ne 0 -and -not (Test-Path (Join-Path $outside 'state'))) $r.text
  Set-Vars @{ OA_SANDBOX_ROOT = $sb; OVERNIGHT_AGENT_PLANNER_DIR = $planner; USERPROFILE = $fakeProfile; OVERNIGHT_AGENT_SETTINGS = '' }
  $r = Run $state @('gate')
  Check 'tripwire: an unredirected default (OA home) is refused too' ($r.code -ne 0 -and $r.text -match 'oa_sandbox_violation') $r.text
  Set-Vars $sandboxVars

  $moon = [char]::ConvertFromUtf32(0x1F319)
  $body = Join-Path $sb 'turn.md'
  Write-Text $body "## $moon Overnight Agent`n<!-- from: overnight-agent -->`n**Status:** In progress`n`nChecked the synthetic task.`n`n**Needs from you:** nothing.`n"
  $r = Run $turn @('-Id', '1', '-BodyFile', $body, '-Ask', 'none', '-JournalDir', (Join-Path $outside 'journal'))
  Check 'tripwire: write-turn refuses an outside journal dir' ($r.code -eq 3 -and $r.text -match 'oa_sandbox_violation') $r.text
  $r = Run $turn @('-Id', '404', '-BodyFile', $body, '-Ask', 'none')
  Check 'override: write-turn resolves its journal inside the planner dir' ($r.text -match [regex]::Escape((Join-Path $planner 'journal'))) $r.text
  # The Node port (item 3) is what SKILL.md invokes; it must carry the same tripwire.
  $r = Run $turnNode @('-Id', '1', '-BodyFile', $body, '-Ask', 'none', '-JournalDir', (Join-Path $outside 'journal'))
  Check 'tripwire: write-turn.mjs refuses an outside journal dir' ($r.code -eq 3 -and $r.text -match 'oa_sandbox_violation') $r.text
  $r = Run $turnNode @('-Id', '404', '-BodyFile', $body, '-Ask', 'none')
  Check 'override: write-turn.mjs resolves its journal inside the planner dir' ($r.text -match [regex]::Escape((Join-Path $planner 'journal'))) $r.text

  $probe = Join-Path $checks 'mcp-probe.mjs'
  $env:MCP_PROBE_CONFIG = Join-Path $outside 'mcp-config.json'
  $out = & node $probe email list 2>&1; $code = $LASTEXITCODE
  Remove-Item Env:MCP_PROBE_CONFIG
  Check 'tripwire: mcp-probe refuses a live mcp-config before spawning' ($code -ne 0 -and "$out" -match 'oa_sandbox_violation') "$out"

  $critical = (Join-Path $skill 'check-critical-tools.mjs').Replace('\', '/')
  $js = "import('file:///' + process.argv[2].replace(/^\/+/, '')).then(m => { try { m.assertSandboxPath(process.argv[3], 'x'); console.log('allowed') } catch (e) { console.log(e.message) } })"
  $in = (& node -e $js 'probe' $critical (Join-Path $oaHome 'capabilities.json')) -join ''
  $outResult = (& node -e $js 'probe' $critical (Join-Path $outside 'capabilities.json')) -join ''
  Check 'tripwire: check-critical-tools allows inside, refuses outside' ($in -eq 'allowed' -and $outResult -match 'oa_sandbox_violation') "$in / $outResult"

  $r = Run (Join-Path $skill 'reap-stale-mcp.ps1') @()
  Check 'sandbox: reaper kills nothing' ($r.code -eq 0 -and ($r.text | ConvertFrom-Json).sandbox -and ($r.text | ConvertFrom-Json).killed -eq 0) $r.text
  $r = Run (Join-Path $checks 'auto-deploy-plugin.ps1') @()
  Check 'sandbox: auto-deploy skips its live targets' ($r.code -eq 0 -and $r.text -match 'SANDBOX: deploy skipped') $r.text
  $r = Run (Join-Path $checks 'run-telegram-mirror.ps1') @()
  Check 'sandbox: Telegram mirror refuses to send' ($r.code -ne 0 -and $r.text -match 'oa_sandbox_violation') $r.text

  # 4. Each tripwire is load-bearing.
  $m1 = Mutant $state 'Assert-OaSandboxPath $pair[1] $pair[0]' '$null = $pair'
  $r = Run $m1 @('gate', '-GatePath', (Join-Path $outside 'agent-gate.md'))
  Check 'mutant: oa-state without the assertion is caught' ($r.code -eq 0 -and $r.text -notmatch 'oa_sandbox_violation') $r.text
  $m2 = Mutant $turn 'if (-not $inside) {' 'if ($false) {'
  $r = Run $m2 @('-Id', '1', '-BodyFile', $body, '-Ask', 'none', '-JournalDir', (Join-Path $outside 'journal'))
  Check 'mutant: write-turn without the assertion is caught' ($r.code -ne 3 -and $r.text -notmatch 'oa_sandbox_violation') $r.text
  $m3 = Mutant $turnNode 'if (!inside) throw' 'if (false) throw'
  $r = Run $m3 @('-Id', '1', '-BodyFile', $body, '-Ask', 'none', '-JournalDir', (Join-Path $outside 'journal'))
  Check 'mutant: write-turn.mjs without the assertion is caught' ($r.code -ne 3 -and $r.text -notmatch 'oa_sandbox_violation') $r.text

  Write-Host "mutcheck-sandbox-mode: $passed passed"
}
finally {
  Set-Vars @{}
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
exit 0
