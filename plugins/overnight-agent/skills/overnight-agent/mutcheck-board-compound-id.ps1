<#
  mutcheck-board-compound-id.ps1 -- mutation check for the compound board-ID fix.

  The planner board's ID column is not always a bare integer. It carries the task id
  optionally followed by external references:

      | 448,[176](https://github.com/shivbijlani/focus-planner/issues/176) | 🔴 | ... |

  The pre-fix pattern (`^\s*\|\s*(\d+)\s*\|`) required the cell to be digits and nothing
  else, so such a row was skipped entirely -- it disappeared from the board map, taking its
  `section` with it. When that row is the only `## Today` row, `Get-BoardMap` reports NO
  today rows, the Today->Deferred gate (#223 rule 1) has nothing to hold it shut, and the
  board's highest-priority task sorts below every Deferred row.

  This builds a synthetic board + journals, runs the REAL oa-state.ps1 against them with an
  isolated -JournalDir / -StateDir / -PlannerBoard (live state is never touched), and asserts
  the section/eligibility verdicts.

  The fix is only load-bearing if the PRE-FIX script FAILS the compound cases and PASSES the
  plain ones -- that is what proves it fixes a real bug rather than restating behaviour.

    powershell -File mutcheck-board-compound-id.ps1 -ScriptPath <path-to-oa-state.ps1> [-ExpectPreFix]
#>
[CmdletBinding()]
param(
  [string]$ScriptPath,
  [switch]$ExpectPreFix
)

$ErrorActionPreference = 'Stop'

if (-not $ScriptPath) { $ScriptPath = Join-Path $PSScriptRoot 'oa-state.ps1' }
if (-not (Test-Path $ScriptPath)) { throw "oa-state.ps1 not found at $ScriptPath" }

# A journal whose agent turn is finished and carries no open ask, so `Test-Workable` depends
# purely on status -- keeping this check about the BOARD parse and nothing else.
$Block = @'
# Task {ID}: synthetic

---
<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->

## 🌙 Overnight Agent

<!-- from: overnight-agent -->

**Status:** In progress · plan v1 · 2026-08-31

### Proposed plan (v1)
1. Do the thing.

**Needs from you:** none

<!-- /overnight-agent turn-end -->
'@

function New-Journal {
  param([string]$Dir, [string]$Id)
  $path = Join-Path $Dir "task-$Id.md"
  [System.IO.File]::WriteAllText($path, ($Block -replace '\{ID\}', $Id), [System.Text.UTF8Encoding]::new($false))
}

# 801 = the compound form actually on the live board (id + a markdown link to a GitHub issue).
# 802 = a plain Today row, to prove the fix does not depend on the compound form existing.
# 803 = a plain Deferred row, the thing the gate must hold back while Today is workable.
# 804 = a compound Deferred row (comma, no link) -- the same cell shape, other section.
$Board = @'
## Today

| ID | 🎯 | Task | Work Priority | Added | Linked ID |
|---|---|------|---------------|-------|-----------|
| 801,[176](https://github.com/shivbijlani/focus-planner/issues/176) | 🔴 | compound id row | - | 2026-08-24 | 192 |

## Deferred

| ID | 🎯 | Task | Work Priority | Added | Wake | Linked ID |
| --- | --- | ------ | --------------- | ------- | ---- | ----------- |
| 803 | 🟡 | plain deferred row | - | 2026-08-30 |  | 191 |
| 804,999 | 🟡 | compound deferred row | - | 2026-08-30 |  | 191 |

## Priorities

1. 801
'@

# Board variant with ONLY a plain Today row, proving the pre-fix script handles that fine --
# i.e. the failure is specific to the compound cell, not to Today parsing in general.
$BoardPlainToday = @'
## Today

| ID | 🎯 | Task | Work Priority | Added | Linked ID |
|---|---|------|---------------|-------|-----------|
| 802 | 🔴 | plain today row | - | 2026-08-24 | 192 |

## Deferred

| ID | 🎯 | Task | Work Priority | Added | Wake | Linked ID |
| --- | --- | ------ | --------------- | ------- | ---- | ----------- |
| 803 | 🟡 | plain deferred row | - | 2026-08-30 |  | 191 |
'@

function Invoke-Scan {
  param([string]$BoardText, [string[]]$Ids)
  $root = Join-Path $env:TEMP ("oa-board-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
  $jdir = Join-Path $root 'journal'
  $sdir = Join-Path $root 'state'
  New-Item -ItemType Directory -Path $jdir -Force | Out-Null
  New-Item -ItemType Directory -Path $sdir -Force | Out-Null
  $board = Join-Path $root 'planner.md'
  [System.IO.File]::WriteAllText($board, $BoardText, [System.Text.UTF8Encoding]::new($false))
  # A snooze store that does not exist must not be inherited from the live environment.
  $snooze = Join-Path $root 'snooze.json'
  try {
    foreach ($id in $Ids) { New-Journal -Dir $jdir -Id $id }
    & powershell -NoProfile -ExecutionPolicy Bypass -File $ScriptPath seed `
      -JournalDir $jdir -StateDir $sdir -PlannerBoard $board -SnoozeStore $snooze | Out-Null
    $raw = & powershell -NoProfile -ExecutionPolicy Bypass -File $ScriptPath scan `
      -JournalDir $jdir -StateDir $sdir -PlannerBoard $board -SnoozeStore $snooze
    $rows = ($raw -join "`n") | ConvertFrom-Json
    $byId = @{}
    foreach ($r in $rows) { $byId["$($r.id)"] = $r }
    return $byId
  }
  finally { Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue }
}

$main  = Invoke-Scan -BoardText $Board          -Ids @('801', '803', '804')
$plain = Invoke-Scan -BoardText $BoardPlainToday -Ids @('802', '803')

# name -> @{ actual; new (post-fix expectation); old (pre-fix); why }
$cases = [ordered]@{
  'compound-today-section' = @{
    actual = "$($main['801'].section)"; new = 'today'; old = 'other'
    why    = 'compound Today id is parsed into the Today section (the bug)'
  }
  'compound-today-eligible' = @{
    actual = "$($main['801'].eligible)"; new = 'True'; old = 'True'
    why    = 'the Today row is workable either way'
  }
  'gate-holds-deferred-shut' = @{
    actual = "$($main['803'].eligible)"; new = 'False'; old = 'True'
    why    = 'GATE: a Deferred row must NOT be eligible while a Today row is workable'
  }
  'compound-deferred-section' = @{
    actual = "$($main['804'].section)"; new = 'deferred'; old = 'other'
    why    = 'a compound id in Deferred is parsed too (comma form, no link)'
  }
  'compound-today-outranks-deferred' = @{
    actual = "$([int]$main['801'].order -lt [int]$main['803'].order)"; new = 'True'; old = 'False'
    why    = 'ORDER: the Today row must sort above the Deferred rows'
  }
  'compound-urgency-read' = @{
    # Deliberately non-empty rather than the literal 🔴. The scan's stdout is captured through a
    # child `powershell` pipe, and under 5.1 that transport is lossy for astral-plane characters
    # (HAZARD 4) -- asserting the exact glyph here failed on a TRANSPORT artifact while the parse
    # itself was correct, i.e. the checker would have invented a bug that is not in the product.
    # Empty vs non-empty is the real distinction: pre-fix the row is absent so urgency is ''.
    actual = "$([bool]$main['801'].urgency)"; new = 'True'; old = 'False'
    why    = 'the urgency icon is still read off a compound row'
  }
  'priorities-rank-applies' = @{
    actual = "$($main['801'].priorities_rank -lt 999999)"; new = 'True'; old = 'True'
    why    = 'the ## Priorities list resolves by bare id regardless of the cell form'
  }
  'plain-today-section' = @{
    actual = "$($plain['802'].section)"; new = 'today'; old = 'today'
    why    = 'CONTROL: a plain Today row was never broken'
  }
  'plain-gate-holds' = @{
    actual = "$($plain['803'].eligible)"; new = 'False'; old = 'False'
    why    = 'CONTROL: the gate already worked for a plain Today row'
  }
}

$pass = 0; $fail = 0
Write-Host ("{0,-34} {1,-10} {2,-10} {3}" -f 'case', 'expect', 'actual', 'why')
foreach ($name in $cases.Keys) {
  $expected = if ($ExpectPreFix) { $cases[$name].old } else { $cases[$name].new }
  $actual = $cases[$name].actual
  $ok = ($actual -eq $expected)
  if ($ok) { $pass++ } else { $fail++ }
  $tag = if ($ok) { 'PASS' } else { 'FAIL' }
  Write-Host ("{0,-34} {1,-10} {2,-10} {3}  [{4}]" -f $name, $expected, $actual, $cases[$name].why, $tag)
}
Write-Host ''
Write-Host "passed $pass / $($pass + $fail)"
if ($fail -gt 0) { exit 1 }
exit 0
