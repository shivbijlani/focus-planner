<#
  mutcheck-consent-authorship.ps1 -- mutation check for the consent-authorship boundary (#227).

  THE BUG THIS GUARDS
  -------------------
  Approval for an irreversible action was inferred from prose in a file the agent writes.
  `Test-TrailingHasUser` treats text with NO provenance marker as the human -- correct for
  reopen detection (losing a user's message is worse than an extra look) and exactly wrong as
  a consent boundary, because it attributes ANY unmarked text below the turn-end stamp to the
  human. Sibling skills, a crash mid-write, or a refactor that drops a marker all produce text
  that would then read as "Shiv said approve".

  WHAT IS ASSERTED
  ----------------
  Two verdicts on the SAME fixtures, which is the whole point of the fix:

    reopened   -- fail OPEN  : unmarked prose counts as the human   (unchanged by #227)
    consent_ok -- fail CLOSED: unmarked prose does NOT count        (added by #227)

  A case where those two disagree is the fix doing its job. If a mutation makes them agree
  everywhere, the boundary has collapsed back into the reopen reader and a case here fails.

  Runs the REAL oa-state.ps1 against an isolated synthetic journal folder (-JournalDir /
  -StateDir), so live state and live journals are never touched.

  Mutations run BY DEFAULT, because run-sweeps.ps1 invokes these with no arguments beyond
  -ScriptPath; a mutcheck that only ran its baseline unless asked would report a comfortable
  green every night while proving nothing.

    powershell -File mutcheck-consent-authorship.ps1 -ScriptPath <path-to-oa-state.ps1>
    powershell -File mutcheck-consent-authorship.ps1 -BaselineOnly     # skip the mutants
#>
[CmdletBinding()]
param(
  [string]$ScriptPath,
  [switch]$BaselineOnly
)

$ErrorActionPreference = 'Stop'

# Default to the installed skill's oa-state.ps1 when run by hand; run-sweeps.ps1 passes
# -ScriptPath explicitly so the nightly sweep guards the PRODUCTION copy, not the repo's.
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

**Status:** Proposed - plan v1 - 2026-08-29

<!-- from: overnight-agent -->
The agent's last turn. Awaiting a decision.

**Needs from you:** approve to send the email.
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
$humanApprove   = "## 2026-08-29`n`n<!-- from: me -->`napprove"
$humanChat      = "## 2026-08-29`n`n<!-- from: me -->`nWhat is the status here?"
$unmarkedApprove = "## 2026-08-29`n`napproved, go ahead"          # THE #227 CASE
$siblingApprove = "## 2026-08-29`n`n<!-- from: dance-church -->`nApproved the class booking."
$agentApprove   = "## 2026-08-29`n`n<!-- from: overnight-agent -->`nYou said approve, so I shipped it."

# A single heading block holding BOTH authors: the human asks, and a SIBLING SKILL appends an
# affirmative under the same heading. Per-entry attribution ("does this ## block contain a
# human marker?") would let the sibling's "Approved" inherit the human's provenance. Positional
# attribution must not. A sibling marker is used rather than the agent's own because an
# `overnight-agent` marker also moves the turn-end boundary, which would mask the effect.
$mixedSiblingAffirm = @'
## 2026-08-29

<!-- from: me -->
What do you think?

<!-- from: dance-church -->
Approved the class booking.
'@

# The agent answering inline under the user's heading. Here the agent's own marker legitimately
# moves the turn boundary (the user HAS been answered), so this asserts the pair: not reopened,
# and the agent's own "approve" is still not consent.
$mixedAgentAffirm = @'
## 2026-08-29

<!-- from: me -->
What do you think?

<!-- from: overnight-agent -->
I would approve this myself, but that is not my call.
'@

# The mirror image: a machine turn first, then the genuine human approval below it. Finding a
# non-human affirmative first must NOT short-circuit the scan.
$machineThenHuman = @'
## 2026-08-29

<!-- from: dance-church -->
Approved the class booking.

<!-- from: me -->
yes, ship it
'@

# Word-boundary guards: these contain the LETTERS of an affirmative but not the word.
$humanNoGo      = "## 2026-08-29`n`n<!-- from: me -->`nI am going to think about it. Undo it for now."
$humanNegative  = "## 2026-08-29`n`n<!-- from: me -->`nPlease hold off, do not send that yet."

# id -> expectations. `reopened` is asserted alongside `consent_ok` so a mutation that
# collapses one into the other is caught rather than silently passing.
$cases = [ordered]@{
  '940' = @{ entries = @();                  consent = $false; reopened = $false; why = 'nothing below the block -> no consent, quiet' }
  '941' = @{ entries = @($humanApprove);     consent = $true;  reopened = $true;  why = 'human-marked "approve" -> CONSENT' }
  '942' = @{ entries = @($unmarkedApprove);  consent = $false; reopened = $true;  why = '#227: unmarked "approved" -> reopen YES, consent NO' }
  '943' = @{ entries = @($siblingApprove);   consent = $false; reopened = $false; why = 'sibling skill wrote "Approved" -> NOT consent' }
  '944' = @{ entries = @($agentApprove);     consent = $false; reopened = $false; why = 'the agent wrote "approve" -> NOT consent (self-authored)' }
  '945' = @{ entries = @($humanChat);        consent = $false; reopened = $true;  why = 'human spoke but did not approve -> reopen, no consent' }
  '946' = @{ entries = @($mixedSiblingAffirm); consent = $false; reopened = $true;  why = 'sibling affirmative under the human heading -> reopen YES, consent NO' }
  '947' = @{ entries = @($machineThenHuman); consent = $true;  reopened = $true;  why = 'machine affirmative first, human approval after -> CONSENT' }
  '948' = @{ entries = @($humanNoGo);        consent = $false; reopened = $true;  why = 'word boundary: "going"/"Undo it" are not affirmatives' }
  '949' = @{ entries = @($humanNegative);    consent = $false; reopened = $true;  why = 'explicit refusal -> no consent' }
  '950' = @{ entries = @($mixedAgentAffirm); consent = $false; reopened = $false; why = 'agent answered inline; its own "approve" is not consent' }
}

function Invoke-Scan([string]$Script) {
  $root = Join-Path $env:TEMP ("oa-consent-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
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
    foreach ($r in $rows) { $byId["$($r.id)"] = $r }
    return $byId
  }
  finally { Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue }
}

function Test-Cases($byId, [string]$Label) {
  $pass = 0; $fail = 0
  Write-Host ""
  Write-Host "=== $Label ==="
  Write-Host ("{0,-5} {1,-9} {2,-9} {3,-9} {4,-9} {5}" -f 'case', 'consent', 'actual', 'reopen', 'actual', 'why')
  foreach ($id in $cases.Keys) {
    $row = $byId[$id]
    $ac = [bool]$row.consent_ok
    $ar = [bool]$row.reopened
    $ec = [bool]$cases[$id].consent
    $er = [bool]$cases[$id].reopened
    $ok = ($ac -eq $ec) -and ($ar -eq $er)
    if ($ok) { $pass++ } else { $fail++ }
    Write-Host ("{0,-5} {1,-9} {2,-9} {3,-9} {4,-9} {5}  [{6}]" -f $id, $ec, $ac, $er, $ar, $cases[$id].why, $(if ($ok) { 'PASS' } else { 'FAIL' }))
  }
  Write-Host "passed $pass / $($pass + $fail)"
  return $fail
}

# --- baseline ----------------------------------------------------------------------------
$fail = Test-Cases (Invoke-Scan $ScriptPath) 'BASELINE (real oa-state.ps1)'
if ($fail -gt 0) { Write-Host ""; Write-Host "BASELINE FAILED"; exit 1 }

if ($BaselineOnly) { exit 0 }
# --- mutations ---------------------------------------------------------------------------
# Each mutation removes ONE load-bearing property. A mutation that no case detects is a guard
# that is not doing work -- the check fails, rather than reporting a comfortable green.
$src = [IO.File]::ReadAllText($ScriptPath, (New-Object Text.UTF8Encoding($false)))

$mutations = @(
  @{
    name  = 'M1: consent falls back to the reopen reader (the original #227 bug)'
    apply = { param($s) $s -replace [regex]::Escape('return [bool](Get-ConsentFacts $trailing).consent_ok'), 'return (Test-TrailingHasUser $trailing)' }
    hook  = 'Consent         = (Get-ConsentFacts $trailing)'
    swap  = 'Consent         = ([pscustomobject]@{ consent_ok = (Test-TrailingHasUser $trailing); reason = "mutated"; human_segments = 0; affirmative_phrase = $null; affirmative_author = $null; affirmative_unattributed = $false })'
  },
  @{
    name  = 'M2: unmarked text is attributed to the human (fail OPEN instead of closed)'
    apply = { param($s) $s -replace [regex]::Escape("Author = 'unknown'; Text = `$region"), "Author = `$script:HumanAuthor; Text = `$region" }
  },
  @{
    name  = 'M3: any author satisfies consent (drops the human requirement)'
    apply = { param($s) $s -replace [regex]::Escape('if ($seg.Author -eq $script:HumanAuthor) {'), 'if ($true) {' }
  },
  @{
    name  = 'M4: consent inherits provenance from the region (human spoke somewhere -> any affirmative counts)'
    apply = { param($s) $s -replace [regex]::Escape('if ($seg.Author -eq $script:HumanAuthor) {'), 'if ($result.human_segments -gt 0) {' }
  }
)

$mutDir = Join-Path $env:TEMP ("oa-consent-mut-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $mutDir -Force | Out-Null
$killed = 0; $survived = 0
try {
  foreach ($m in $mutations) {
    $mutated = & $m.apply $src
    if ($m.hook) { $mutated = $mutated.Replace($m.hook, $m.swap) }
    if ($mutated -eq $src) {
      Write-Host ""
      Write-Host "!! $($m.name): mutation did not apply (anchor text moved) -- treating as SURVIVED"
      $survived++
      continue
    }
    $path = Join-Path $mutDir ("oa-state-" + [guid]::NewGuid().ToString('N').Substring(0, 6) + '.ps1')
    [IO.File]::WriteAllText($path, $mutated, (New-Object Text.UTF8Encoding($false)))
    $f = 0
    try { $f = Test-Cases (Invoke-Scan $path) $m.name }
    catch { $f = 1; Write-Host "  (mutant threw: $($_.Exception.Message))" }
    if ($f -gt 0) { $killed++; Write-Host "  -> KILLED" } else { $survived++; Write-Host "  -> SURVIVED (guard is not load-bearing)" }
  }
}
finally { Remove-Item -Recurse -Force $mutDir -ErrorAction SilentlyContinue }

Write-Host ""
Write-Host "mutations killed $killed / $($killed + $survived)"
if ($survived -gt 0) { exit 1 }
exit 0
