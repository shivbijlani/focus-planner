# mutcheck-turn-terminator.ps1
#
# Proves the turn-terminator fix in oa-state.ps1 does BOTH halves of its job:
#
#   1. It HEARS the shape that was being swallowed -- raw text typed at the bottom of a
#      journal with no `## <date>` heading and no `<!-- from: me -->` marker.
#   2. It has NOT gone deaf to the shapes that already worked. This is the half that
#      matters: a reopen fix that suppresses too much silently eats the user's messages,
#      so "it went green" is worthless without evidence of what it can still hear.
#
# Every case is BEHAVIOURAL -- it runs the real script against a synthetic journal folder
# with isolated -JournalDir/-StateDir, so it cannot be fooled by source text that merely
# mentions the fix.
#
# Usage:  pwsh mutcheck-turn-terminator.ps1 [-Script <path to oa-state.ps1>]
# Exit:   0 all assertions pass - 1 one or more failed.

[CmdletBinding()]
param(
  [string]$Script
)

$ErrorActionPreference = 'Stop'

# Resolved in the body, not the param default: $PSScriptRoot is not yet populated while
# the param block is being bound under Windows PowerShell 5.1.
if (-not $Script) { $Script = Join-Path $PSScriptRoot 'oa-state.ps1' }

$AGENT_BLOCK = @'
# Task 9xx: synthetic

The user's own notes.

---
<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->

## Overnight Agent

**Status:** Done - plan v1 - 2026-08-26

<!-- from: overnight-agent -->

### What I did

Wrote the thing.

**Needs from you:** nothing.
'@

# The four shapes a journal can be in after the agent has answered. The first two are the
# paths the Focus Planner app and the Telegram fold-back actually write, so they are
# REGRESSION GUARDS and must stay true while the third is being fixed.
$APP_SHAPED   = "`r`n## 2026-08-27`r`n`r`n<!-- from: me -->`r`napprove`r`n"
$HEADING_ONLY = "`r`n## 2026-08-27`r`n`r`napprove`r`n"
$RAW_APPEND   = "`r`n`r`napprove - go ahead please`r`n"
$SIBLING_TURN = "`r`n## 2026-08-27`r`n`r`n<!-- from: dance-church -->`r`nposted 3 classes`r`n"

$failures = New-Object System.Collections.ArrayList
$passes = 0

function Invoke-Oa {
  param([string]$Cmd, [string]$JDir, [string]$SDir, [string]$TaskId)
  $a = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $Script, $Cmd,
         '-JournalDir', $JDir, '-StateDir', $SDir)
  if ($TaskId) { $a += @('-Id', $TaskId) }
  & powershell @a 2>&1
}

function Assert-Reopened {
  <#
    Drives the REAL production sequence:
      write journal -> seed -> mark (this is when the terminator gets stamped)
        -> the user appends $Append -> scan
    and asserts the verdict.
  #>
  param([string]$Name, [string]$Append, [bool]$Expected, [string]$Why, [switch]$SkipMark)

  $root = Join-Path ([IO.Path]::GetTempPath()) ("oa-term-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
  $jdir = Join-Path $root 'journal'
  $sdir = Join-Path $root 'state'
  New-Item -ItemType Directory -Path $jdir -Force | Out-Null
  New-Item -ItemType Directory -Path $sdir -Force | Out-Null
  try {
    $journal = Join-Path $jdir 'task-901.md'
    [IO.File]::WriteAllText($journal, $AGENT_BLOCK, (New-Object Text.UTF8Encoding($false)))

    [void](Invoke-Oa -Cmd 'seed' -JDir $jdir -SDir $sdir)
    if (-not $SkipMark) { [void](Invoke-Oa -Cmd 'mark' -JDir $jdir -SDir $sdir -TaskId '901') }

    if ($Append) {
      $cur = [IO.File]::ReadAllText($journal)
      [IO.File]::WriteAllText($journal, $cur.TrimEnd() + $Append, (New-Object Text.UTF8Encoding($false)))
    }

    $rows = (Invoke-Oa -Cmd 'scan' -JDir $jdir -SDir $sdir) -join "`n" | ConvertFrom-Json
    $row = @($rows) | Where-Object { "$($_.id)" -eq '901' } | Select-Object -First 1
    $actual = [bool]$row.reopened

    if ($actual -eq $Expected) {
      $script:passes++
      Write-Host ("  PASS  {0}" -f $Name) -ForegroundColor Green
    } else {
      [void]$script:failures.Add(("{0}: expected reopened={1}, got {2} -- {3}" -f $Name, $Expected, $actual, $Why))
      Write-Host ("  FAIL  {0}: expected {1}, got {2}" -f $Name, $Expected, $actual) -ForegroundColor Red
    }
  } finally {
    Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Assert-True {
  param([string]$Name, [bool]$Condition, [string]$Why)
  if ($Condition) {
    $script:passes++
    Write-Host ("  PASS  {0}" -f $Name) -ForegroundColor Green
  } else {
    [void]$script:failures.Add(("{0} -- {1}" -f $Name, $Why))
    Write-Host ("  FAIL  {0}" -f $Name) -ForegroundColor Red
  }
}

Write-Host "mutcheck-turn-terminator -- script under test: $Script"
Write-Host ''
Write-Host 'THE FIX: the shape that was silently swallowed'
Assert-Reopened -Name 'raw text at EOF, no heading, no marker' -Append $RAW_APPEND -Expected $true `
  -Why 'this is the defect: SKILL.md promises raw text at the bottom reopens, and it did not'

Write-Host ''
Write-Host 'THE DEAFNESS TEST: everything that already worked must still work'
Assert-Reopened -Name 'app-written reply (## date + from: me)' -Append $APP_SHAPED -Expected $true `
  -Why 'the path the Focus Planner app writes -- breaking it loses every reply'
Assert-Reopened -Name '## date entry with no marker' -Append $HEADING_ONLY -Expected $true `
  -Why 'hand-written and older app entries take this shape'
Assert-Reopened -Name 'untouched answered journal stays quiet' -Append '' -Expected $false `
  -Why 'crying wolf on a settled task is how a detector becomes decorative'
Assert-Reopened -Name "a sibling skill's own turn is not a user reply" -Append $SIBLING_TURN -Expected $false `
  -Why 'sibling skills append here too; counting one as the user pins the task reopened forever'

Write-Host ''
Write-Host 'THE STAMP ITSELF: it must be append-only, idempotent, and never precede a reply'
$root = Join-Path ([IO.Path]::GetTempPath()) ("oa-term-s-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
$jdir = Join-Path $root 'journal'; $sdir = Join-Path $root 'state'
New-Item -ItemType Directory -Path $jdir -Force | Out-Null
New-Item -ItemType Directory -Path $sdir -Force | Out-Null
try {
  $j = Join-Path $jdir 'task-902.md'
  [IO.File]::WriteAllText($j, $AGENT_BLOCK, (New-Object Text.UTF8Encoding($false)))
  [void](Invoke-Oa -Cmd 'seed' -JDir $jdir -SDir $sdir)
  [void](Invoke-Oa -Cmd 'mark' -JDir $jdir -SDir $sdir -TaskId '902')
  $after1 = [IO.File]::ReadAllText($j)

  Assert-True -Name 'mark stamps the terminator' `
    -Condition ($after1 -match '/overnight-agent turn-end') `
    -Why 'without the stamp there is no boundary and the blind spot remains'
  Assert-True -Name 'the stamp is append-only (original bytes untouched)' `
    -Condition ($after1.StartsWith($AGENT_BLOCK.TrimEnd())) `
    -Why 'a rewrite could eat existing content; this must only ever add to the end'

  [void](Invoke-Oa -Cmd 'mark' -JDir $jdir -SDir $sdir -TaskId '902')
  $after2 = [IO.File]::ReadAllText($j)
  Assert-True -Name 'marking twice does not stack a second terminator' `
    -Condition (([regex]::Matches($after2, '/overnight-agent turn-end')).Count -eq 1) `
    -Why 'mark runs every turn; a stacking stamp would grow the file without bound'

  # The dangerous ordering: a reply already sitting below the turn must NOT get a
  # terminator stamped over the top of it, which would mark it answered.
  $j2 = Join-Path $jdir 'task-903.md'
  [IO.File]::WriteAllText($j2, $AGENT_BLOCK.TrimEnd() + $APP_SHAPED, (New-Object Text.UTF8Encoding($false)))
  [void](Invoke-Oa -Cmd 'seed' -JDir $jdir -SDir $sdir)
  [void](Invoke-Oa -Cmd 'mark' -JDir $jdir -SDir $sdir -TaskId '903')
  $after3 = [IO.File]::ReadAllText($j2)
  Assert-True -Name 'an unanswered reply below the turn is never stamped over' `
    -Condition (-not ($after3 -match '/overnight-agent turn-end')) `
    -Why 'stamping past a pending reply would silently mark it answered -- the exact harm being fixed'
} finally {
  Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ''
if ($failures.Count -eq 0) {
  Write-Host ("ALL GREEN - {0} assertions passed." -f $passes) -ForegroundColor Green
  exit 0
}
Write-Host ("FAILURES: {0} of {1} assertions" -f $failures.Count, ($passes + $failures.Count)) -ForegroundColor Red
foreach ($f in $failures) { Write-Host "  - $f" -ForegroundColor Red }
exit 1
