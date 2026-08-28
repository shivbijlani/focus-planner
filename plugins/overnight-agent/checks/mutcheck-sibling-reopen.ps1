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
  [Parameter(Mandatory)][string]$ScriptPath,
  [switch]$ExpectPreFix
)

$ErrorActionPreference = 'Stop'

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

function New-Journal {
  param([string]$Dir, [string]$Id, [string[]]$Entries)
  $sb = [System.Text.StringBuilder]::new()
  [void]$sb.AppendLine(($AgentBlock -replace '\{ID\}', $Id))
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

# id -> @{ entries; expectNew; expectOld; why }
$cases = [ordered]@{
  '901' = @{ entries = @($danceTurn);                 new = $false; old = $true;  why = 'sibling-skill turn only -> NOT a reopen (the bug)' }
  '902' = @{ entries = @($userTurn);                  new = $true;  old = $true;  why = 'genuine user reply -> reopen' }
  '903' = @{ entries = @($danceTurn, $userTurn);      new = $true;  old = $true;  why = 'sibling then user -> reopen' }
  '904' = @{ entries = @($userTurn, $danceTurn);      new = $true;  old = $true;  why = 'user then sibling -> reopen (blind-spot guard)' }
  '905' = @{ entries = @();                           new = $false; old = $false; why = 'nothing below the agent block -> quiet' }
  '906' = @{ entries = @($rawProse);                  new = $true;  old = $true;  why = 'unmarked prose -> treat as user (conservative)' }
  '907' = @{ entries = @($danceTurn, $kranboxTurn);   new = $false; old = $true;  why = 'two different sibling skills -> still NOT a reopen' }
}

$root = Join-Path $env:TEMP ("oa-mutcheck-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
$jdir = Join-Path $root 'journal'
$sdir = Join-Path $root 'state'
New-Item -ItemType Directory -Path $jdir -Force | Out-Null
New-Item -ItemType Directory -Path $sdir -Force | Out-Null

try {
  foreach ($id in $cases.Keys) { New-Journal -Dir $jdir -Id $id -Entries $cases[$id].entries }

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
  if ($fail -gt 0) { exit 1 }
  exit 0
}
finally {
  Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue
}
