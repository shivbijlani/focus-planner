<#
  mutcheck-board-linked.ps1 -- prove the board-sourced `linked:` pointer (GH #408) is load-bearing.

  WHAT IS UNDER TEST
  ------------------
  SKILL.md mandates an upstream walk before planning or executing anything ("Gather linked-task
  context FIRST"), tells you to resolve the chain from "A's `Linked ID` (board) and any
  `**Linked:** #B` note in its journal", and then names ONE tool for the reading:

      "Use `extract`. Do NOT open journal\task-<linkedID>.md in full as your default."

  `extract` read only the journal half. So for a task whose parent is recorded on the BOARD --
  the normal case -- it printed:

      - linked: (none)

  That is not a missing field, it is a FALSE POSITIVE FINDING: `(none)` reads as "this task has
  no parent", so the walk is not skipped by accident, it is skipped on the tool's authority, and
  nothing anywhere reports an error. Measured live 2026-09-02: planner.md's row for task 468
  carries `Linked ID = 463`, task-468.md has no `**Linked:**` line, and `extract -Id 468` printed
  `linked: (none)`. #463 carries the agent's GitHub operating contract, so the contract was never
  read, and #404/#405 were then filed describing behaviour that only happened because of it.

  TWO PROPERTIES, and the second is the one people forget:

    MERGED    board `Linked ID` + journal `**Linked:** #N`, de-duplicated. Either source alone
              loses real parents, because on the live folder they disagree in both directions.
    HONEST    `(none)` is emitted ONLY when both sources were read and both were empty. If the
              board could not be consulted the line says THAT. A pointer block that cannot fail
              is worse than one that reports its own gaps.

  ARMS. Each mutation re-opens one hole and must be killed by a DIFFERENT arm. A mutation that
  survives means the guard it targets has gone decorative -- which still reports success.

    b*   baseline behaviour on an UNMUTATED script
    m1   the board half is dropped again      -> `(none)` for task 468's shape  (killed by b1)
    m2   the journal half is dropped          -> journal-only link lost         (killed by b3)
    m3   the merge keeps only one source      -> the other parent vanishes      (killed by b4)
    m4   `(none)` printed unconditionally     -> unread board looks empty       (killed by b6)
    m5   the Linked ID column is read at a
         FIXED index                          -> ragged Deferred rows lose it   (killed by b7)
    m6   trailing `<!-- snooze -->` markers
         are not stripped                     -> the comment is read as a cell  (killed by b8)
  Run:  pwsh -NoProfile -File mutcheck-board-linked.ps1
  Exit: 0 all mutations killed; 1 a mutation SURVIVED (a guard is not load-bearing).
#>

[CmdletBinding()]
param([string]$Target)

$ErrorActionPreference = 'Stop'
$enc = New-Object Text.UTF8Encoding($false)

# Resolve oa-state.ps1 by SEARCH, not one hard-coded home -- and print what was resolved. A check
# that will not say which file it measured cannot be audited, and grading the wrong copy is a
# failure class this repo keeps closing.
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$candidates = @(
  $Target,
  (Join-Path $here 'oa-state.ps1'),
  (Join-Path (Join-Path (Join-Path (Split-Path -Parent $here) 'skills') 'overnight-agent') 'oa-state.ps1')
)
# Only if the variable exists. `Join-Path $null ...` is a hard binding error, not an empty result,
# so building this candidate unconditionally kills the whole check on any non-Windows runner --
# which is exactly how the first CI run of this file failed.
if ($env:LOCALAPPDATA) { $candidates += (Join-Path (Join-Path $env:LOCALAPPDATA 'overnight-agent') 'oa-state.ps1') }
$script:script = $null
foreach ($c in $candidates) { if ($c -and (Test-Path $c)) { $script:script = (Resolve-Path $c).Path; break } }
if (-not $script:script) { throw ("oa-state.ps1 not found. Tried:`n  " + (($candidates | Where-Object { $_ }) -join "`n  ")) }
Write-Host "target: $($script:script)"
$src = [IO.File]::ReadAllText($script:script, $enc)

$pass = 0; $fail = 0
function Check([string]$name, [bool]$cond, [string]$detail) {
  if ($cond) { $script:pass++; Write-Host "  ok   $name" }
  else { $script:fail++; Write-Host "  FAIL $name  <- $detail" }
}

# --- Fixture ----------------------------------------------------------------------------------
# Pure ASCII on purpose (see ps1-encoding-sweep.mjs): this harness carries no BOM, so a non-ASCII
# literal here would itself be corrupted on the way in. The urgency glyph plays no part in the
# link parse, so a plain `-` stands in for it and nothing is lost.
#
# The board is shaped like the LIVE one, including the parts that make a naive parse wrong:
#   - Today rows are 6 cells, Deferred rows are 7 -- so the column index differs per table.
#   - Deferred is RAGGED. Row 863 omits the `Wake` cell entirely, which is how the live board
#     looks (measured 2026-09-02: row 467 has 6 cells, row 437 has 7).
#   - Row 864 sets `Wake` and leaves `Linked ID` empty, so a "last non-empty cell" read without a
#     date guard would report the WAKE DATE as a linked task.
#   - Row 860 carries a trailing `<!-- snooze:... -->` marker AFTER the final pipe (#353).
$Board = @'
## Today

| ID | - | Task | Work Priority | Added | Linked ID |
|---|---|------|---------------|-------|-----------|
| 860 | - | trailing snooze marker after the last pipe | - | 2026-09-02 | 199 | <!-- snooze:2099-01-01 -->
| 861 | - | board link only, journal has none | - | 2026-09-02 | 463 |
| 862 | - | board and journal both link, to different parents | - | 2026-09-02 | 901 |
| 866 | - | no link on the board, journal has one | - | 2026-09-02 |  |
| 867 | - | no link anywhere | - | 2026-09-02 |  |

## Deferred

| ID | - | Task | Work Priority | Added | Wake | Linked ID |
| --- | --- | ------ | --------------- | ------- | ---- | ----------- |
| 863 | - | ragged six-cell deferred row | - | 2026-09-02 | 191 |
| 864 | - | wake date set, linked id empty | - | 2026-09-02 | 2026-12-25 |  |
| 865 | - | ragged row AND a trailing snooze marker | - | 2026-09-02 | 197 | <!-- snooze:2099-01-01 -->
'@

# id -> the journal's own `**Linked:**` line (empty = none). Task 861 is the #408 shape exactly:
# a board link and a journal that says nothing.
$Journals = [ordered]@{
  '860' = ''
  '861' = ''
  '862' = '**Linked:** #900'
  '863' = ''
  '864' = ''
  '865' = ''
  '866' = '**Linked:** #902'
  '867' = ''
}

function New-Sandbox {
  $root = Join-Path ([IO.Path]::GetTempPath()) ('oa408mut-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
  $j = Join-Path $root 'journal'
  New-Item -ItemType Directory -Path $j -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $root 'state') -Force | Out-Null
  foreach ($id in $Journals.Keys) {
    $body = "# Task ${id}: synthetic`n`nUser framing at the top.`n"
    if ($Journals[$id]) { $body += "$($Journals[$id])`n" }
    [IO.File]::WriteAllText((Join-Path $j "task-$id.md"), $body, $enc)
  }
  [IO.File]::WriteAllText((Join-Path $root 'planner.md'), $Board, $enc)
  return $root
}

function Invoke-Extract {
  param([string]$ScriptPath, [string]$Root, [string]$Id, [string]$BoardPath, [int]$TimeoutSec = 90)
  if (-not $BoardPath) { $BoardPath = Join-Path $Root 'planner.md' }
  $a = @('-NoProfile', '-File', $ScriptPath, 'extract', '-Id', $Id,
         '-JournalDir', (Join-Path $Root 'journal'),
         '-StateDir', (Join-Path $Root 'state'),
         '-PlannerBoard', $BoardPath,
         # A snooze store that does not exist must not be inherited from the live environment.
         '-SnoozeStore', (Join-Path $Root 'snooze.json'))
  $so = Join-Path $Root ('o-' + [Guid]::NewGuid().ToString('N').Substring(0, 6) + '.txt')
  $se = "$so.err"
  $p = Start-Process -FilePath 'pwsh' -ArgumentList $a -NoNewWindow -PassThru `
       -RedirectStandardOutput $so -RedirectStandardError $se
  if (-not $p.WaitForExit($TimeoutSec * 1000)) {
    try { $p.Kill($true) } catch { }
    return [pscustomobject]@{ TimedOut = $true; Out = ''; Err = ''; Code = -1 }
  }
  return [pscustomobject]@{
    TimedOut = $false
    Out = $(if (Test-Path $so) { [IO.File]::ReadAllText($so) } else { '' })
    Err = $(if (Test-Path $se) { [IO.File]::ReadAllText($se) } else { '' })
    Code = $p.ExitCode
  }
}

function Get-LinkedLine([string]$out) {
  foreach ($l in ($out -split "`r?`n")) { if ($l -match '^\s*-\s+linked:') { return $l.Trim() } }
  return ''
}

function Get-LinkedResolved([string]$out) {
  # The RESOLVED ids only -- the part before the `(board: ...; journal: ...)` provenance clause.
  #
  # Asserting against the whole line is a false-pass generator, and the first run of this file
  # proved it: m3 ("board wins, journal discarded") produced
  #   `- linked: #901  (board: #901; journal: #900)`
  # and survived, because `#900` still appeared -- in the provenance, describing the very id that
  # had just been dropped. An arm that cannot tell "resolved" from "mentioned" grades nothing.
  $l = Get-LinkedLine $out
  $i = $l.IndexOf('  (', [StringComparison]::Ordinal)
  if ($i -ge 0) { return $l.Substring(0, $i) }
  return $l
}

function New-Mutant {
  param([hashtable[]]$Edits, [string]$Dir)
  $t = $src
  foreach ($e in $Edits) {
    if ($t.IndexOf($e.Find, [StringComparison]::Ordinal) -lt 0) {
      throw "mutation anchor not found in oa-state.ps1 (the script changed shape): $($e.Find)"
    }
    $t = $t.Replace($e.Find, $e.Replace)
  }
  $m = Join-Path $Dir 'oa-state-mutant.ps1'
  [IO.File]::WriteAllText($m, $t, $enc)
  return $m
}

# ==============================================================================================
# BASELINE -- the unmutated script must actually do the job before any mutation means anything.
# ==============================================================================================
Write-Host ''
Write-Host 'baseline (unmutated):'
$root = New-Sandbox

$r = Invoke-Extract -ScriptPath $script:script -Root $root -Id '861'
Check 'b0 extract runs and exits 0' (-not $r.TimedOut -and $r.Code -eq 0) "timedOut=$($r.TimedOut) code=$($r.Code) err=$($r.Err)"

# THE BUG ITSELF. A board `Linked ID` with no journal `**Linked:**` line must resolve the parent.
$l861 = Get-LinkedResolved $r.Out
Check 'b1 a board Linked ID with NO journal Linked line resolves the parent' `
  ($l861 -match '#463') "resolved links were: '$l861'"
Check 'b1a ...and it is not reported as (none)' `
  ($l861 -notmatch '\(none') "resolved links were: '$l861'"

$l866 = Get-LinkedResolved (Invoke-Extract -ScriptPath $script:script -Root $root -Id '866').Out
Check 'b3 a journal Linked line with NO board Linked ID still resolves' `
  ($l866 -match '#902') "resolved links were: '$l866'"

# MERGED, not "one source wins". They disagree in both directions on the live folder.
$l862 = Get-LinkedResolved (Invoke-Extract -ScriptPath $script:script -Root $root -Id '862').Out
Check 'b4 board and journal links are MERGED (both parents survive)' `
  ($l862 -match '#901' -and $l862 -match '#900') "resolved links were: '$l862'"

# HONEST (none): both sources read, both empty.
$r867 = Invoke-Extract -ScriptPath $script:script -Root $root -Id '867'
$l867 = Get-LinkedResolved $r867.Out
Check 'b5 both sources read and both empty -> (none)' ($l867 -match '\(none') "linked line was: '$l867'"
Check 'b5a ...and it states that the board row WAS read' `
  ((Get-LinkedLine $r867.Out) -match '(?i)board') "the (none) gave no account of the board: '$l867'"

# HONEST gap: the board could NOT be consulted, so `(none)` would be a claim it has not earned.
$missing = Join-Path $root 'no-such-board.md'
$lGap = Get-LinkedLine (Invoke-Extract -ScriptPath $script:script -Root $root -Id '867' -BoardPath $missing).Out
Check 'b6 an unreadable board is REPORTED, not silently rendered as (none)' `
  ($lGap -match '(?i)not read' -and $lGap -notmatch '\(none\)') "linked line was: '$lGap'"

# Ragged Deferred rows: same table, different cell counts. A fixed index reads the wrong column.
$l863 = Get-LinkedResolved (Invoke-Extract -ScriptPath $script:script -Root $root -Id '863').Out
Check 'b7 a RAGGED deferred row (no Wake cell) still resolves its link' `
  ($l863 -match '#191') "resolved links were: '$l863'"
# ...and the inverse: a Wake date must never be mistaken for a linked task id.
$l864 = Get-LinkedResolved (Invoke-Extract -ScriptPath $script:script -Root $root -Id '864').Out
Check 'b7a a Wake date is NOT reported as a linked task' `
  ($l864 -match '\(none' -and $l864 -notmatch '2026') "resolved links were: '$l864'"

# A trailing `<!-- snooze:... -->` marker sits AFTER the final pipe (#353), so it is the last
# thing on the line without being a cell. Row 865 is the shape where that actually bites: the row
# is ALSO ragged, so the header's declared index does not apply and the parse falls back to the
# last cell -- which is the comment unless comments are stripped first.
$l865 = Get-LinkedResolved (Invoke-Extract -ScriptPath $script:script -Root $root -Id '865').Out
Check 'b8 a trailing snooze marker on a RAGGED row does not displace the Linked ID' `
  ($l865 -match '#197' -and $l865 -notmatch '2099') "resolved links were: '$l865'"
# The same marker on a well-formed Today row, where the header index is the thing that saves it.
$l860 = Get-LinkedResolved (Invoke-Extract -ScriptPath $script:script -Root $root -Id '860').Out
Check 'b8a ...and on a well-formed row either' `
  ($l860 -match '#199' -and $l860 -notmatch '2099') "resolved links were: '$l860'"

# READ-ONLY still holds: this change reads a second file and writes neither. Paths are composed
# with Join-Path rather than a `journal\...` literal -- a backslash is a legal FILENAME character
# on the Linux runner, not a separator.
$boardPath = Join-Path $root 'planner.md'
$jrnlPath = Join-Path (Join-Path $root 'journal') 'task-861.md'
$bBoard = [IO.File]::ReadAllBytes($boardPath)
$bJrnl = [IO.File]::ReadAllBytes($jrnlPath)
Invoke-Extract -ScriptPath $script:script -Root $root -Id '861' | Out-Null
$aBoard = [IO.File]::ReadAllBytes($boardPath)
$aJrnl = [IO.File]::ReadAllBytes($jrnlPath)
Check 'b9 the board and the journal are byte-identical afterwards (READ-ONLY)' `
  ((-not (Compare-Object $bBoard $aBoard -SyncWindow 0)) -and (-not (Compare-Object $bJrnl $aJrnl -SyncWindow 0))) `
  'extract mutated one of the files it read'

Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue

# ==============================================================================================
# MUTATIONS
# ==============================================================================================
Write-Host ''
Write-Host 'mutations (each must be KILLED):'

# --- m1: the board half is dropped again -- the #408 defect, re-introduced. ---------------------
$root = New-Sandbox
$m1 = New-Mutant -Dir $root -Edits @(@{
  Find    = '  $board = Get-BoardLinkFacts -Id $Id'
  Replace = '  $board = [pscustomobject]@{ Read = $true; RowFound = $true; Ids = @(); Note = ''''; Path = "$PlannerBoard" }'
})
$o = Invoke-Extract -ScriptPath $m1 -Root $root -Id '861'
$l = Get-LinkedResolved $o.Out
Check 'm1 dropping the board half is killed (b1 loses #463)' `
  (-not $o.TimedOut -and $l -notmatch '#463') "the mutant still resolved the parent: '$l'"
Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue

# --- m2: the journal half is dropped. ----------------------------------------------------------
# The fix must ADD a source, not swap one for another. Without this arm, a "fix" that replaced the
# journal reader with the board reader would pass every board-shaped assertion above.
$root = New-Sandbox
$m2 = New-Mutant -Dir $root -Edits @(@{
  Find    = '  $links = Get-LinkedFacts -Id $Id -JournalIds @($ptr.Linked)'
  Replace = '  $links = Get-LinkedFacts -Id $Id -JournalIds @()'
})
$o = Invoke-Extract -ScriptPath $m2 -Root $root -Id '866'
$l = Get-LinkedResolved $o.Out
Check 'm2 dropping the journal half is killed (b3 loses #902)' `
  (-not $o.TimedOut -and $l -notmatch '#902') "the mutant still resolved the journal link: '$l'"
Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue

# --- m3: the merge becomes a preference. -------------------------------------------------------
# The board wins and the journal's own parent is discarded. Both b1 and b3 still pass -- only the
# task that has BOTH can see it, which is why b4 exists.
$root = New-Sandbox
$m3 = New-Mutant -Dir $root -Edits @(@{
  Find    = '  foreach ($n in @($JournalIds)) { if ($n -and $merged -notcontains $n) { $merged += $n } }'
  Replace = '  if (-not $merged.Count) { foreach ($n in @($JournalIds)) { if ($n -and $merged -notcontains $n) { $merged += $n } } }'
})
$o = Invoke-Extract -ScriptPath $m3 -Root $root -Id '862'
$l = Get-LinkedResolved $o.Out
Check 'm3 "board wins" instead of merging is killed (b4 loses #900)' `
  (-not $o.TimedOut -and $l -notmatch '#900') "the mutant still merged both sources: '$l'"
Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue

# --- m4: `(none)` goes back to being unconditional. --------------------------------------------
# Every link still resolves, so b1-b4 all pass. The ONLY thing that changes is that a board which
# could not be read is reported as an empty one -- the exact "it cannot fail" property #408 says
# is worse than a gap. b6 is the only arm that can see it.
$root = New-Sandbox
$m4 = New-Mutant -Dir $root -Edits @(@{
  Find    = '  if (-not $Facts.BoardRead) {
    return "- linked: (board not read'
  Replace = '  if ($false) {
    return "- linked: (board not read'
})
$o = Invoke-Extract -ScriptPath $m4 -Root $root -Id '867' -BoardPath (Join-Path $root 'no-such-board.md')
$l = Get-LinkedLine $o.Out
Check 'm4 an unconditional (none) is killed (b6 can no longer see the gap)' `
  (-not $o.TimedOut -and $l -notmatch '(?i)not read') "the mutant still reported the unread board: '$l'"
Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue

# --- m5: the Linked ID is read at a FIXED column index. ----------------------------------------
# The obvious implementation, and it is wrong on the live board: Deferred rows are ragged, so a
# hard 6 misses the 6-cell ones. b7 is the only arm that covers it.
$root = New-Sandbox
$m5 = New-Mutant -Dir $root -Edits @(@{
  Find    = '  $idx = if ($LinkedIndex -ge $script:BoardLinkedMinIndex -and $LinkedIndex -le $last) { $LinkedIndex } else { $last }'
  Replace = '  $idx = if ($LinkedIndex -ge $script:BoardLinkedMinIndex) { $LinkedIndex } else { $last }
  if ($idx -gt $last) { return @() }'
})
$o = Invoke-Extract -ScriptPath $m5 -Root $root -Id '863'
$l = Get-LinkedResolved $o.Out
Check 'm5 a fixed column index is killed (b7 loses the ragged row''s #191)' `
  (-not $o.TimedOut -and $l -notmatch '#191') "the mutant still read the ragged row: '$l'"
Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue

# --- m6: trailing HTML comments are no longer stripped. ----------------------------------------
# `<!-- snooze:2099-01-01 -->` follows the final pipe, so without stripping it becomes the last
# "cell". On a well-formed row the header's declared index still rescues the parse -- which is why
# this arm targets the RAGGED row 865, where the fallback is all there is and the comment's DATE
# is read in place of the link. b8 is the only arm that covers it.
$root = New-Sandbox
$m6 = New-Mutant -Dir $root -Edits @(@{
  Find    = "  `$clean = [regex]::Replace(`$Line, '<!--.*?-->', '')"
  Replace = '  $clean = $Line'
})
$o = Invoke-Extract -ScriptPath $m6 -Root $root -Id '865'
$l = Get-LinkedResolved $o.Out
Check 'm6 not stripping trailing HTML comments is killed (b8 loses #197)' `
  (-not $o.TimedOut -and $l -notmatch '#197') "the mutant still read past the comment: '$l'"
Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ''
Write-Host "$pass passed, $fail failed"
exit $(if ($fail) { 1 } else { 0 })
