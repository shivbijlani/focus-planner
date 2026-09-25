<#
  mutcheck-board-row-no-journal.ps1 -- a board row with no journal must be VISIBLE (GH #534).

  THE DEFECT

  `oa-state.ps1 scan` is the run's worklist: SKILL.md says "Run this first, every run" and
  "Work the rows in the order scan gives you". But the loop is JOURNAL-DRIVEN -- it
  enumerates `task-*.md` and joins board data onto what it finds. A row that is ON THE BOARD
  with no journal yet produced NO ROW AT ALL, so it was invisible to every phase: it could
  not be ordered, gated, proposed for, or counted.

  Measured live 2026-09-05: `## Today` row 1 (`473`, added that day) was absent from all 248
  scan rows. No error, no `eligible: false`, no warning -- the id simply did not appear.
  Measured again 2026-09-24 while fixing it: THREE live board rows were invisible, two of
  them on Today.

  That is the #346 shape on the primary worklist. "This task does not exist" and "this task
  exists and I could not see it" are byte-identical, because both are absence. It also makes
  an exhaustion declaration unsound: a journal-less Today row cannot hold the Today gate, so
  `-Exhausted` could be declared truthfully over a Today section with unexamined rows in it.

  WHAT THE ARMS GUARD

  The row is SURFACED, not invented. The synthesised row must carry `has_journal: false` and
  must NOT fabricate journal facts -- an invented `reopened` or `unanswered_user` would be a
  worse failure than the invisibility, because it would send the run to answer a message
  nobody wrote. So the arms check both halves: it appears, AND it appears honestly.

  Hermetic: synthetic journal dir, state dir and board under TEMP, driving the REAL
  oa-state.ps1. No live store is read or written.

  Exit 0 = every arm agreed.
#>
[CmdletBinding()]
param([string]$ScriptPath)

$ErrorActionPreference = 'Stop'
if (-not $ScriptPath) { $ScriptPath = Join-Path $PSScriptRoot 'oa-state.ps1' }
if (-not (Test-Path $ScriptPath)) { throw "oa-state.ps1 not found at $ScriptPath" }

$script:PsExe = if ($PSVersionTable.PSEdition -eq 'Core') { (Get-Process -Id $PID).Path } else { 'powershell' }
$utf8 = New-Object Text.UTF8Encoding($false)
$root = Join-Path ([IO.Path]::GetTempPath()) ("oa-534-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
$J = Join-Path $root 'journal'; New-Item -ItemType Directory -Path $J -Force | Out-Null
$S = Join-Path $root 'state';   New-Item -ItemType Directory -Path $S -Force | Out-Null
$board = Join-Path $root 'planner.md'

$script:pass = 0
$script:fail = 0
function Assert([bool]$ok, [string]$name, [string]$why, [string]$detail = '') {
  if ($ok) { Write-Host "  PASS  $name  -- $why"; $script:pass++ }
  else {
    Write-Host "  FAIL  $name  -- $why" -ForegroundColor Red
    if ($detail) { Write-Host ("        got: " + $detail) -ForegroundColor DarkGray }
    $script:fail++
  }
}

# One row WITH a journal and one WITHOUT, with the journal-less row FIRST on the board --
# the measured shape, where the missing row was the top Today row.
[IO.File]::WriteAllText((Join-Path $J 'task-901.md'),
  "# Task 901: has a journal`n`n## 2026-09-24`n`n<!-- from: me -->`nnote`n", $utf8)
[IO.File]::WriteAllText($board,
  "# Planner`n`n## Today`n`n| ID | Urgency | Task |`n| 902 | Red | no journal yet |`n| 901 | Yellow | has a journal |`n", $utf8)

function Scan([string]$path) {
  $argv = @($path, 'scan', '-JournalDir', $J, '-StateDir', $S, '-PlannerBoard', $board)
  $out = (& $script:PsExe -NoProfile -ExecutionPolicy Bypass -File @argv 2>&1 | Out-String)
  $rows = @()
  # ConvertFrom-Json on a JSON ARRAY returns the array as ONE object here, so @() wraps
  # rather than unrolls it. Assigning first and then indexing gives the rows themselves.
  try { $parsed = $out | ConvertFrom-Json; $rows = @($parsed) ; if ($rows.Count -eq 1 -and $rows[0] -is [array]) { $rows = @($rows[0]) } } catch { }
  # The rows are returned via a script-scope variable rather than a property on a returned
  # object. Putting an array on a [pscustomobject] property and reading it back through the
  # pipeline re-wraps it, so `$s.rows | Where-Object` yielded a nested array and every
  # field comparison below silently compared against Object[] instead of a value -- arms
  # failing for a harness reason while the subject was correct.
  $script:LastScanRows = $rows
  Write-Host "DBG rows=$(@($rows).Count) rawlen=$($out.Length)"
  $script:LastScanRaw = $out.Trim()
}
function Row([string]$id) {
  return @(@($script:LastScanRows) | Where-Object { "$($_.id)" -eq $id })[0]
}
function D() {
  $o = ($script:LastScanRaw -replace '\s+', ' ')
  if ($o.Length -gt 240) { $o = $o.Substring(0, 240) + '...' }
  return $o
}

Write-Host ''
Write-Host 'VISIBLE -- the board row must appear at all'

Scan $ScriptPath
$row902 = Row '902'
$row901 = Row '901'

Assert ($null -ne $row902) 'VISIBLE' 'a board row with no journal appears in scan' (D)
Assert ($null -ne $row901) 'PAIRS' 'and the ordinary journal-backed row is still there (not a swap)' (D)

Write-Host ''
Write-Host 'HONEST -- surfaced, not invented'

if ($row902) {
  Assert ("$($row902.has_journal)" -eq 'False') 'FLAGGED' 'it is marked has_journal:false, so a reader need not infer it' ''
  Assert ("$($row902.on_board)" -eq 'True') 'ONBOARD' 'and carries the board facts it does have' ''
  Assert ("$($row902.section)".Trim() -eq 'today') 'SECTION' 'including the section, so Today ordering and the Today gate can see it' ''
  # THE ARM THAT MATTERS MOST. Fabricating journal facts would be worse than the
  # invisibility: it would send a run to answer a message nobody wrote.
  Assert (("$($row902.reopened)" -eq 'False') -and ("$($row902.unanswered_user)" -eq 'False')) 'NO-FICTION' 'and invents no journal facts -- nobody has written to it' ''
  Assert ("$($row902.no_journal_reason)".Contains('no journal')) 'REASON' 'and says why it is different, in the row itself' ''
}
else {
  Assert $false 'FLAGGED' 'no row to inspect' ''
}

if ($row901) {
  Assert ("$($row901.has_journal)" -eq 'True') 'TRUE-ROW' 'a journal-backed row reports has_journal:true, so the flag is not always-false' ''
}

Write-Host ''
Write-Host 'LOAD-BEARING -- remove the fix and the row vanishes again'

# Mutated IN PLACE and restored from the ORIGINAL BYTES in a `finally` -- a copy in TEMP
# cannot resolve the helpers this script expects beside it, and a text-mode restore would
# strip the subject's UTF-8 BOM (measured on a sibling check; ps1-encoding-sweep caught it).
$srcBytes = [IO.File]::ReadAllBytes($ScriptPath)
$src = [IO.File]::ReadAllText($ScriptPath)
$anchor = '    if ($seenScanIds.ContainsKey("$bid")) { continue }'
if (-not $src.Contains($anchor)) { throw 'anchor not found: the #534 synthesis loop moved' }
$mutated = $src.Replace($anchor, '    if ($true) { continue }')


try {
  [IO.File]::WriteAllText($ScriptPath, $mutated, (New-Object Text.UTF8Encoding($true)))
  Scan $ScriptPath
}
finally {
  [IO.File]::WriteAllBytes($ScriptPath, $srcBytes)
}

$mutRow = Row '902'
Assert ($null -eq $mutRow) 'KILLED' 'with the synthesis skipped the row disappears again (the fix is load-bearing)' (D)

# Byte-compare the restore: a harness that silently re-encodes its subject is the defect
# wearing the harness's clothes.
$restored = [IO.File]::ReadAllBytes($ScriptPath)
$same = ($restored.Length -eq $srcBytes.Length)
if ($same) { for ($i = 0; $i -lt $srcBytes.Length; $i++) { if ($restored[$i] -ne $srcBytes[$i]) { $same = $false; break } } }
Assert $same 'RESTORED' 'and the subject is byte-identical afterwards, BOM included' ''

Write-Host ''
if ($script:fail -gt 0) {
  Write-Host ("FAILED: {0} arm(s) disagreed, {1} passed." -f $script:fail, $script:pass) -ForegroundColor Red
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
  exit 1
}
Write-Host ("OK: {0} arms agreed. The row is visible, honest, and the fix is load-bearing." -f $script:pass) -ForegroundColor Green
Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
exit 0
