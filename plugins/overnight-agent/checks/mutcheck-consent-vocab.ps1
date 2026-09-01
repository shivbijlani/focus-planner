<#
  mutcheck-consent-vocab.ps1 -- mutation check for the command-shaped `merge <n>` consent
  vocabulary (#301).

  THE BUG THIS GUARDS
  -------------------
  For months the agent ended merge asks with "reply `merge 300`". `merge <number>` was not in
  `$script:ConsentAffirmRe`, so a correctly attributed `merge 300` returned
  `human-spoke-but-no-affirmative` -- silently indistinguishable from the user declining.

  The fix cannot be a bare `merge` token: "merge", "merged" and "merge it later" run through the
  agent's OWN prose constantly, and since #272 an unstamped agent turn reads as `unknown` (not
  `me`), so a broad token would widen the self-authorised-consent surface #227 exists to close.
  Only the COMMAND-shaped `merge <number>` is added; bare `merge`/`merged`/`merge it later` stay
  out.

  WHAT IS ASSERTED (three guarantees, one mutation arm each, 1:1 with its fixture)
  -------------------------------------------------------------------------------
    G_pos    `merge 300` from a `<!-- from: me -->` segment  -> consent_ok TRUE
             killed by, and ONLY by, dropping the `merge <n>` token from the regex.
    G_narrow bare `merge` (no number) from the human         -> consent_ok FALSE
             killed by, and ONLY by, broadening the token so the number is optional.
    G_author the agent's OWN unstamped turn (reads `unknown`) naming "merged" / "merge 300"
             -> consent_ok FALSE   killed by, and ONLY by, dropping the human-attribution gate.

  This harness is STRICT: every mutation must be killed by EXACTLY its own fixture. A mutation
  caught by no fixture (a guard that is not load-bearing), by a fixture other than its own, or by
  more than one fixture, all fail the check -- so the arms cannot silently overlap or rot.

  The control fixtures (`yes`, `approve`) must never flip under any mutation: they prove the
  merge arms do not disturb the rest of the vocabulary.

  Runs the REAL oa-state.ps1 against an isolated synthetic journal folder (-JournalDir /
  -StateDir), so live state and live journals are never touched. Mutations run BY DEFAULT.

    powershell -File mutcheck-consent-vocab.ps1 -ScriptPath <path-to-oa-state.ps1>
    powershell -File mutcheck-consent-vocab.ps1 -BaselineOnly     # skip the mutants
#>
[CmdletBinding()]
param(
  [string]$ScriptPath,
  [switch]$BaselineOnly
)

$ErrorActionPreference = 'Stop'

if (-not $ScriptPath) {
  $candidates = @(
    (Join-Path $PSScriptRoot '..\skills\overnight-agent\oa-state.ps1'),
    (Join-Path $env:LOCALAPPDATA 'overnight-agent\oa-state.ps1'),
    "$env:USERPROFILE\.copilot\installed-plugins\focus-planner\overnight-agent\skills\overnight-agent\oa-state.ps1"
  )
  foreach ($c in $candidates) { if (Test-Path $c) { $ScriptPath = (Resolve-Path $c).Path; break } }
}
if (-not $ScriptPath -or -not (Test-Path $ScriptPath)) { throw "oa-state.ps1 not found (pass -ScriptPath)" }

$AgentBlock = @'
# Task {ID}: synthetic

Some user notes at the top.

---
<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->

## Overnight Agent

**Status:** Proposed - plan v1 - 2026-08-31

<!-- from: overnight-agent -->
The agent's last turn. Awaiting a decision.

**Needs from you:** reply to approve the merge.
'@

function New-Journal {
  param([string]$Dir, [string]$Id, [string[]]$Entries)
  $sb = [System.Text.StringBuilder]::new()
  [void]$sb.AppendLine(($AgentBlock -replace '\{ID\}', $Id))
  foreach ($e in $Entries) {
    [void]$sb.AppendLine()
    [void]$sb.AppendLine($e)
  }
  [System.IO.File]::WriteAllText((Join-Path $Dir "task-$Id.md"), $sb.ToString(), [System.Text.UTF8Encoding]::new($false))
}

# --- fixtures ---------------------------------------------------------------------------
# The command-shaped approval, correctly attributed to the human. THE #301 CASE.
$humanMergeNum = "## 2026-08-31`n`n<!-- from: me -->`nmerge 300"

# Bare `merge` from the human -- a question, not a command. Must NOT be consent: this is the
# whole reason the token is number-shaped rather than a bare word.
$humanBareMerge = "## 2026-08-31`n`n<!-- from: me -->`nremind me, should we merge or wait?"

# THE NEGATIVE ARM the issue demands: the agent's OWN turn, appended WITHOUT a
# `<!-- from: overnight-agent -->` stamp under its own `## ` heading, so #272 reads it as
# `unknown`. It names "merged", "merge it later" AND the literal "merge 300" -- none of which may
# ever be read back as the human's approval. The human's own segment above is a bare question.
$agentMergeNarrative = @'
## 2026-08-31

<!-- from: me -->
what's the status on that PR?

## Overnight Agent

**Status:** In progress

Done for tonight: I merged 300 earlier and can merge it later if you want; to ship the rest,
reply merge 300 and I will finish it.
'@

# Controls: the pre-existing vocabulary must be untouched by anything the merge arms do.
$humanYes     = "## 2026-08-31`n`n<!-- from: me -->`nyes"
$humanApprove = "## 2026-08-31`n`n<!-- from: me -->`napprove"

# id -> { entries; expected consent; the mutation this fixture (and only this fixture) must kill }
$cases = [ordered]@{
  '9611' = @{ entries = @($humanMergeNum);       consent = $true;  kills = 'M_pos';    why = '#301: human "merge 300" -> CONSENT' }
  '9612' = @{ entries = @($humanBareMerge);       consent = $false; kills = 'M_bare';   why = 'bare "merge" from the human (no number) -> NOT consent' }
  '9613' = @{ entries = @($agentMergeNarrative);  consent = $false; kills = 'M_author'; why = 'unstamped agent turn naming "merged"/"merge 300" -> NOT the human''s approval' }
  '9614' = @{ entries = @($humanYes);             consent = $true;  kills = $null;      why = 'control: "yes" still approves' }
  '9615' = @{ entries = @($humanApprove);         consent = $true;  kills = $null;      why = 'control: "approve" still approves' }
}

function Invoke-Scan([string]$Script) {
  $root = Join-Path $env:TEMP ("oa-vocab-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
  $jdir = Join-Path $root 'journal'
  $sdir = Join-Path $root 'state'
  New-Item -ItemType Directory -Path $jdir -Force | Out-Null
  New-Item -ItemType Directory -Path $sdir -Force | Out-Null
  try {
    foreach ($id in $cases.Keys) { New-Journal -Dir $jdir -Id $id -Entries $cases[$id].entries }
    & powershell -NoProfile -ExecutionPolicy Bypass -File $Script seed -JournalDir $jdir -StateDir $sdir | Out-Null
    $raw = & powershell -NoProfile -ExecutionPolicy Bypass -File $Script scan -JournalDir $jdir -StateDir $sdir
    $rows = ($raw -join "`n") | ConvertFrom-Json
    $byId = @{}
    foreach ($r in $rows) { $byId["$($r.id)"] = [bool]$r.consent_ok }
    return $byId
  }
  finally { Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue }
}

function Get-Failures($byId) {
  # Ids whose observed consent differs from the baseline expectation.
  $out = @()
  foreach ($id in $cases.Keys) {
    if ($byId[$id] -ne [bool]$cases[$id].consent) { $out += $id }
  }
  return $out
}

# --- baseline ----------------------------------------------------------------------------
Write-Host "=== BASELINE (real oa-state.ps1) ==="
Write-Host ("{0,-5} {1,-9} {2,-9} {3}" -f 'case', 'expect', 'actual', 'why')
$base = Invoke-Scan $ScriptPath
$baseFail = 0
foreach ($id in $cases.Keys) {
  $ec = [bool]$cases[$id].consent
  $ac = [bool]$base[$id]
  $ok = ($ac -eq $ec)
  if (-not $ok) { $baseFail++ }
  Write-Host ("{0,-5} {1,-9} {2,-9} {3}  [{4}]" -f $id, $ec, $ac, $cases[$id].why, $(if ($ok) { 'PASS' } else { 'FAIL' }))
}
if ($baseFail -gt 0) { Write-Host ""; Write-Host "BASELINE FAILED"; exit 1 }
Write-Host "baseline OK"

if ($BaselineOnly) { exit 0 }

# --- mutations ---------------------------------------------------------------------------
$src = [IO.File]::ReadAllText($ScriptPath, (New-Object Text.UTF8Encoding($false)))

$mutations = @(
  @{
    name = 'M_pos'
    desc = 'reader drops the command-shaped `merge <n>` token (the original #301 bug)'
    apply = { param($s) $s -replace [regex]::Escape('|merge[ \t]+#?\d+'), '' }
  },
  @{
    name = 'M_bare'
    desc = 'reader accepts BARE `merge` (the PR number made optional) -- the unsafe widening'
    apply = { param($s) $s -replace [regex]::Escape('merge[ \t]+#?\d+'), 'merge(?:[ \t]+#?\d+)?' }
  },
  @{
    name = 'M_author'
    desc = 'any author satisfies consent (drops the #227 human-attribution gate)'
    apply = { param($s) $s -replace [regex]::Escape('if ($seg.Author -eq $script:HumanAuthor) {'), 'if ($true) {' }
  }
)

# Which fixture is SUPPOSED to kill each mutation.
$expectedKiller = @{}
foreach ($id in $cases.Keys) { if ($cases[$id].kills) { $expectedKiller[$cases[$id].kills] = $id } }

$mutDir = Join-Path $env:TEMP ("oa-vocab-mut-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $mutDir -Force | Out-Null
$problems = 0
$killerOf = @{}   # fixture id -> list of mutations it killed (to assert 1:1)
try {
  foreach ($m in $mutations) {
    Write-Host ""
    Write-Host "=== $($m.name): $($m.desc) ==="
    $mutated = & $m.apply $src
    if ($mutated -eq $src) {
      Write-Host "  !! mutation did not apply (anchor text moved) -- FAIL"
      $problems++
      continue
    }
    $path = Join-Path $mutDir ("oa-state-" + [guid]::NewGuid().ToString('N').Substring(0, 6) + '.ps1')
    [IO.File]::WriteAllText($path, $mutated, (New-Object Text.UTF8Encoding($false)))

    $killSet = @()
    try { $killSet = @(Get-Failures (Invoke-Scan $path)) }
    catch { Write-Host "  (mutant threw: $($_.Exception.Message))"; $killSet = @('<threw>') }

    $want = $expectedKiller[$m.name]
    $killList = ($killSet -join ', ')
    Write-Host ("  designated killer: {0}   actual killers: [{1}]" -f $want, $killList)

    if ($killSet.Count -eq 0) {
      Write-Host "  -> SURVIVED (guard is not load-bearing)"; $problems++
    }
    elseif ($killSet.Count -eq 1 -and $killSet[0] -eq $want) {
      Write-Host "  -> KILLED by its own fixture only"
      foreach ($k in $killSet) { if (-not $killerOf.ContainsKey($k)) { $killerOf[$k] = @() }; $killerOf[$k] += $m.name }
    }
    else {
      Write-Host "  -> WRONG: expected ONLY $want to catch this, got [$killList]"; $problems++
      foreach ($k in $killSet) { if (-not $killerOf.ContainsKey($k)) { $killerOf[$k] = @() }; $killerOf[$k] += $m.name }
    }
  }
}
finally { Remove-Item -Recurse -Force $mutDir -ErrorAction SilentlyContinue }

# --- 1:1 assertion: no fixture may kill more than one mutation --------------------------
foreach ($k in $killerOf.Keys) {
  if ($killerOf[$k].Count -gt 1) {
    Write-Host ""
    Write-Host ("  !! fixture {0} killed multiple mutations [{1}] -- arms are not independent" -f $k, ($killerOf[$k] -join ', '))
    $problems++
  }
}

Write-Host ""
if ($problems -gt 0) { Write-Host "mutation mapping FAILED ($problems problem(s))"; exit 1 }
Write-Host "all $($mutations.Count) mutations killed, each by exactly its own fixture"
exit 0
