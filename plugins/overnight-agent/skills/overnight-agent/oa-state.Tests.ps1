<#
  mutcheck-sibling-reopen.ps1 -- mutation check for the sibling-skill false-reopen fix.

  Builds a synthetic planner journal folder covering every author ordering, runs the REAL
  oa-state.ps1 against it (isolated -JournalDir / -StateDir, so live state is never touched),
  and asserts the `reopened` verdict for each case.

  Run it against BOTH the pre-fix and post-fix scripts. The fix is only load-bearing if the
  pre-fix script FAILS the sibling cases and PASSES everything else -- that is what proves the
  change fixes a real bug rather than restating existing behaviour.

    powershell -File mutcheck-sibling-reopen.ps1 -ScriptPath <path-to-oa-state.ps1> [-ExpectPreFix]
#>
[CmdletBinding()]
param(
  [string]$ScriptPath,
  [switch]$ExpectPreFix
)

$ErrorActionPreference = 'Stop'

# Default to the oa-state.ps1 sitting next to this test. ($PSScriptRoot is not reliably
# populated inside a param() default block, so resolve it here instead.)
if (-not $ScriptPath) { $ScriptPath = Join-Path $PSScriptRoot 'oa-state.ps1' }
if (-not (Test-Path $ScriptPath)) { throw "oa-state.ps1 not found at $ScriptPath" }

$AgentBlock = @'
# Task {ID}: synthetic

Some user notes at the top.

---
<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->

## Overnight Agent

**Status:** Done - plan v1 - 2026-08-26

<!-- from: overnight-agent -->
The agent's last turn. Nothing outstanding.

**Needs from you:** none
'@

# The historical shape, and still the majority of the corpus: the agent's turn carries NO
# `<!-- from: overnight-agent -->` stamp at all, so the only boundary marker is the sentinel.
$UnstampedBlock = @'
# Task {ID}: synthetic

Some user notes at the top.

---
<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->

## Overnight Agent

**Status:** Done - plan v1 - 2026-08-26

### Proposed plan (v1)
1. Do the thing.

**Needs from you:** none
'@

function New-Journal {
  param([string]$Dir, [string]$Id, [string[]]$Entries, [string]$Block = $AgentBlock)
  $sb = [System.Text.StringBuilder]::new()
  [void]$sb.AppendLine(($Block -replace '\{ID\}', $Id))
  foreach ($e in $Entries) {
    [void]$sb.AppendLine()
    [void]$sb.AppendLine($e)
  }
  $path = Join-Path $Dir "task-$Id.md"
  [System.IO.File]::WriteAllText($path, $sb.ToString(), [System.Text.UTF8Encoding]::new($false))
}

$userTurn    = "## 2026-08-26`n`n<!-- from: me -->`nHey, one more thing - can you also check X?"
$danceTurn   = "## 2026-08-26`n`n<!-- from: dance-church -->`nRan the loop - nothing to change, quick status."
$kranboxTurn = "## 2026-08-26`n`n<!-- from: kranbox-backup -->`nUploaded 0 new files."
$rawProse    = "## 2026-08-26`n`nRaw text with no provenance marker at all."

# --- unstamped-run-log fixtures -------------------------------------------------------
# The user speaks under an unmarked `## <date>` heading and the agent answers by appending a
# bare `### Run log` beneath it. Before the fix the boundary landed on the user's heading, so
# the agent's own reply was counted as unanswered user prose.
$answeredByRunLog = @'
## 2026-07-27

He accidentally purchased from orbit, so we are just going to use that

### Run log
**2026-07-27 (overnight):**
- Got it, closing this out.
- Result: done. No further action.
- Next: complete.
'@

$unansweredUser = @'
## 2026-07-27

He accidentally purchased from orbit, so we are just going to use that
'@

# The reason the recovery is guarded. SKILL.md allows the user to append "raw text at the
# bottom", i.e. with no heading of its own. That must never be swallowed into the agent's turn.
$rawTextBelowRunLog = @'
## 2026-07-27

Earlier question?

### Run log
**2026-07-27 (overnight):**
- Answered it.
- Next: complete.

Actually wait, one more thing - can you also check the deductible?
'@

# id -> @{ entries; expectNew; expectOld; why }
$cases = [ordered]@{
  '901' = @{ entries = @($danceTurn);                 new = $false; old = $true;  why = 'sibling-skill turn only -> NOT a reopen (the bug)' }
  '902' = @{ entries = @($userTurn);                  new = $true;  old = $true;  why = 'genuine user reply -> reopen' }
  '903' = @{ entries = @($danceTurn, $userTurn);      new = $true;  old = $true;  why = 'sibling then user -> reopen' }
  '904' = @{ entries = @($userTurn, $danceTurn);      new = $true;  old = $true;  why = 'user then sibling -> reopen (blind-spot guard)' }
  '905' = @{ entries = @();                           new = $false; old = $false; why = 'nothing below the agent block -> quiet' }
  '906' = @{ entries = @($rawProse);                  new = $true;  old = $true;  why = 'unmarked prose -> treat as user (conservative)' }
  '907' = @{ entries = @($danceTurn, $kranboxTurn);   new = $false; old = $true;  why = 'two different sibling skills -> still NOT a reopen' }

  # Unstamped run log: the agent answered without a provenance marker.
  '911' = @{ entries = @($answeredByRunLog);              block = $UnstampedBlock; new = $false; old = $true;  why = 'unstamped run log answered the user -> quiet (the bug)' }
  '912' = @{ entries = @($unansweredUser);                block = $UnstampedBlock; new = $true;  old = $true;  why = 'unanswered unmarked user message -> reopen' }
  '913' = @{ entries = @($rawTextBelowRunLog);            block = $UnstampedBlock; new = $true;  old = $true;  why = 'GUARD: raw user text below a run log -> reopen' }
  '914' = @{ entries = @($answeredByRunLog, $userTurn);   block = $UnstampedBlock; new = $true;  old = $true;  why = 'new user reply after an answered turn -> reopen' }
  '915' = @{ entries = @($answeredByRunLog, $danceTurn);  block = $UnstampedBlock; new = $false; old = $true;  why = 'sibling turn after an answered turn -> quiet' }
  '916' = @{ entries = @($userTurn);                      block = $UnstampedBlock; new = $true;  old = $true;  why = 'marked user reply, unstamped block -> reopen' }
  '917' = @{ entries = @($danceTurn);                     block = $UnstampedBlock; new = $false; old = $true;  why = 'sibling turn, unstamped block -> quiet' }
}

$root = Join-Path $env:TEMP ("oa-mutcheck-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
$jdir = Join-Path $root 'journal'
$sdir = Join-Path $root 'state'
New-Item -ItemType Directory -Path $jdir -Force | Out-Null
New-Item -ItemType Directory -Path $sdir -Force | Out-Null

try {
  foreach ($id in $cases.Keys) {
    $block = if ($cases[$id].block) { $cases[$id].block } else { $AgentBlock }
    New-Journal -Dir $jdir -Id $id -Entries $cases[$id].entries -Block $block
  }

  & powershell -NoProfile -ExecutionPolicy Bypass -File $ScriptPath seed -JournalDir $jdir -StateDir $sdir | Out-Null
  $raw = & powershell -NoProfile -ExecutionPolicy Bypass -File $ScriptPath scan -JournalDir $jdir -StateDir $sdir
  $rows = ($raw -join "`n") | ConvertFrom-Json
  $byId = @{}
  foreach ($r in $rows) { $byId["$($r.id)"] = $r }

  $pass = 0; $fail = 0
  Write-Host ("{0,-5} {1,-9} {2,-9} {3}" -f 'case', 'expect', 'actual', 'why')
  foreach ($id in $cases.Keys) {
    $expected = if ($ExpectPreFix) { $cases[$id].old } else { $cases[$id].new }
    $actual = [bool]$byId[$id].reopened
    $ok = ($actual -eq $expected)
    if ($ok) { $pass++ } else { $fail++ }
    $tag = if ($ok) { 'PASS' } else { 'FAIL' }
    Write-Host ("{0,-5} {1,-9} {2,-9} {3}  [{4}]" -f $id, $expected, $actual, $cases[$id].why, $tag)
  }
  Write-Host ''
  Write-Host "passed $pass / $($pass + $fail)"

  # --- Phase 2: the production sequence (seed -> mark -> user speaks -> scan) --------------
  # Phase 1 never calls `mark`, so it cannot see the class of bug where the agent's turn is
  # the LAST section in the file: nothing closes it, so anything appended below is absorbed
  # into the turn. SKILL.md promises "raw text at the bottom" reopens the task, and 217 of the
  # 239 live journals have exactly that shape, so this phase is the one that holds the promise.
  $p2root = Join-Path $env:TEMP ("oa-mutcheck2-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
  $p2j = Join-Path $p2root 'journal'
  $p2s = Join-Path $p2root 'state'
  New-Item -ItemType Directory -Path $p2j -Force | Out-Null
  New-Item -ItemType Directory -Path $p2s -Force | Out-Null

  try {
    # append -> @{ new; old; why }.  `old` = the pre-fix verdict, so -ExpectPreFix still passes
    # and the change is provably load-bearing rather than a restatement.
    $p2cases = [ordered]@{
      '921' = @{ append = "`r`n## 2026-08-27`r`n`r`n<!-- from: me -->`r`napprove`r`n"; new = $true;  old = $true;  why = 'GUARD: app-written reply (## date + from: me) -> reopen' }
      '922' = @{ append = "`r`n## 2026-08-27`r`n`r`napprove`r`n";                      new = $true;  old = $true;  why = 'GUARD: ## date entry, no marker -> reopen' }
      '923' = @{ append = "`r`n`r`napprove - go ahead please`r`n";                     new = $true;  old = $false; why = 'raw text at EOF -> reopen (the bug)' }
      '924' = @{ append = '';                                                          new = $false; old = $false; why = 'GUARD: untouched answered journal -> quiet (no crying wolf)' }
    }
    foreach ($id in $p2cases.Keys) { New-Journal -Dir $p2j -Id $id -Entries @() }

    & powershell -NoProfile -ExecutionPolicy Bypass -File $ScriptPath seed -JournalDir $p2j -StateDir $p2s | Out-Null
    foreach ($id in $p2cases.Keys) {
      & powershell -NoProfile -ExecutionPolicy Bypass -File $ScriptPath mark -Id $id -JournalDir $p2j -StateDir $p2s | Out-Null
    }
    # The user speaks only AFTER the agent finished and marked -- that ordering is the point.
    # TrimEnd mirrors an editor that normalises trailing whitespace, so the boundary cannot
    # rely on the file being byte-identical to what was marked.
    foreach ($id in $p2cases.Keys) {
      $a = $p2cases[$id].append
      if (-not $a) { continue }
      $f = Join-Path $p2j "task-$id.md"
      [System.IO.File]::WriteAllText($f, ([System.IO.File]::ReadAllText($f).TrimEnd() + $a), [System.Text.UTF8Encoding]::new($false))
    }

    $raw2 = & powershell -NoProfile -ExecutionPolicy Bypass -File $ScriptPath scan -JournalDir $p2j -StateDir $p2s
    $by2 = @{}
    foreach ($r in (($raw2 -join "`n") | ConvertFrom-Json)) { $by2["$($r.id)"] = $r }

    Write-Host ''
    Write-Host ("{0,-5} {1,-9} {2,-9} {3}" -f 'case', 'expect', 'actual', 'why (seed -> mark -> append -> scan)')
    foreach ($id in $p2cases.Keys) {
      $expected = if ($ExpectPreFix) { $p2cases[$id].old } else { $p2cases[$id].new }
      $actual = [bool]$by2[$id].reopened
      $ok = ($actual -eq $expected)
      if ($ok) { $pass++ } else { $fail++ }
      $tag = if ($ok) { 'PASS' } else { 'FAIL' }
      Write-Host ("{0,-5} {1,-9} {2,-9} {3}  [{4}]" -f $id, $expected, $actual, $p2cases[$id].why, $tag)
    }

    # `mark` must never stamp a turn-end over prose the user is still waiting on an answer to
    # -- that would swallow the message permanently, which is the failure this whole mechanism
    # exists to prevent. Assert the file itself, not just the verdict.
    New-Journal -Dir $p2j -Id '925' -Entries @($userTurn)
    & powershell -NoProfile -ExecutionPolicy Bypass -File $ScriptPath mark -Id 925 -JournalDir $p2j -StateDir $p2s | Out-Null
    $stamped = [System.IO.File]::ReadAllText((Join-Path $p2j 'task-925.md')) -match '/overnight-agent\s+turn-end'
    $ok = (-not $stamped)
    if ($ok) { $pass++ } else { $fail++ }
    Write-Host ("{0,-5} {1,-9} {2,-9} {3}  [{4}]" -f '925', 'no-stamp', $(if ($stamped) { 'stamped' } else { 'no-stamp' }),
      'mark must NOT stamp over an unanswered user message', $(if ($ok) { 'PASS' } else { 'FAIL' }))
  }
  finally {
    Remove-Item -Recurse -Force $p2root -ErrorAction SilentlyContinue
  }

  Write-Host ''
  Write-Host "TOTAL passed $pass / $($pass + $fail)"
  if ($fail -gt 0) { exit 1 }
  exit 0
}
finally {
  Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue
}
