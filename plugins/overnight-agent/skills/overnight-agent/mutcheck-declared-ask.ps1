<#
  mutcheck-declared-ask.ps1 -- mutation check for the DECLARED ask (GH #560).

  THE DEFECT. `awaiting_reply` -- the fact that decides whether a task is schedulable, and the
  fact that opens the Today->Deferred gate -- was recovered by REGEX from the agent's own
  narrative closing line. `oa-state.ps1` matched `**Needs from you:**` / `**Your call:**` out of
  the newest turn's prose and read a boolean back out of the sentence a language model happened
  to write. The turn's author knew that boolean at the moment it wrote the text.

  It is a RATCHET, because the agent writes the text its own gate reads: writing a turn parks
  the task the turn is about. The file had already grown THREE layers of heuristics
  reconstructing the one bit -- a generous reading for the digest (`Test-AskTextIsOpen`), a
  strict one for the gate (`Test-AskTextIsBlocking`), and a dismissive-opener carve-out added
  after the ratchet starved the board once already. Three readings of one clause is the tell.

  MEASURED. 2026-08-31: 186 of 238 rows parked, every other row terminal, ZERO eligible rows.
  After the dismissive-opener narrowing, 2026-09-06: still only 2 eligible rows out of 249.
  `SKILL.md`'s OWN agent-block example prints `**Your call:** reply below in plain English`;
  that exact line is in 81 journals and the gate reads every one of them as blocking. The
  documented template instructs the agent to write the sentence that starves the board.

  THE FIX. `write-turn.ps1 -Ask blocking|offer|none` is REQUIRED (guard G13) and stamps
  `<!-- oa-ask: VALUE -->` into the turn beneath its provenance marker. `Get-BlockingAskVerdict`
  in `oa-state.ps1` prefers that declaration; the regexes survive only as a documented fallback
  for the ~81 journals written before the flag existed, and `scan` reports `ask_source` per row
  so the fallback's share is a number rather than an assumption.

  This harness drives the REAL `oa-state.ps1` and the REAL `write-turn.ps1` against an isolated
  -JournalDir / -StateDir / -PlannerBoard / -SnoozeStore under TEMP, and MUTATES THOSE REAL
  FILES rather than a re-implementation of their logic -- a re-implemented subject can drift
  from what ships, which is #463's "green where it was written, broken where it runs".

    pwsh -File mutcheck-declared-ask.ps1 [-ScriptPath <oa-state.ps1>] [-WriteTurnPath <write-turn.ps1>]

  BASELINE ARMS, and the distinct claim each one makes:

    D_OFFER     the live defect, exactly: a turn whose prose carries the boilerplate
                `**Your call:** reply below in plain English` but which declares `-Ask offer`
                does NOT park its task.
    D_BLOCKING  the other direction: `-Ask blocking` parks even when the wording opens
                dismissively (`none`/`nothing`), which the fallback would read as unblocked.
    D_VISIBLE   `has_open_ask` does not regress -- a declared `offer` is still shown to the
                digest. Only the GATE reading changed.
    D_NONE_VIS  ...and a declared `none` whose prose still carries a real ask stays VISIBLE too.
                The declaration may only ever ADD visibility, never suppress a question.
    B_COMPAT    an undeclared turn behaves EXACTLY as it did before, and reports `inferred`.
                This is the arm the 81 existing journals depend on.
    B_DISMISS   ...including the dismissive-opener carve-out, which is fallback-only semantics
                now but must not have changed for turns that never declare.
    N_NEWEST    only the NEWEST turn's declaration counts (a `blocking` from three turns ago
                cannot park a task forever) -- the declared analogue of arm O.
    N_UNDECL    ...and a newest turn with NO declaration falls back to ITS OWN prose, rather
                than inheriting an older turn's stamp.
    N_LAST      within one turn the LAST declaration wins, so a correction appended below the
                emitted stamp outranks it -- the premise G13's refusal of hand-written stamps
                rests on, and the rule every other "newest statement" reader here follows.
    F_FENCE     a stamp inside a fenced example declares nothing. The turn ANNOUNCING this
                feature necessarily quotes the stamp (#320/#325, and G8's lesson that the
                READER decides what a fence means).
    G_GATE      the Today->Deferred gate moves with it: a declared-blocking Today row parks and
                releases Deferred; a declared-offer Today row is worked ITSELF and holds
                Deferred behind it. Asserting both is what stops "fixed by opening the gate"
                passing as "fixed by un-parking the row".
    W_REQUIRED  write-turn.ps1 REFUSES a turn that declares nothing, and writes nothing.
    W_BADVALUE  ...and refuses a value it does not recognise, rather than stamping it.
    W_HANDSTAMP ...and refuses a hand-written stamp in the body, which would silently outrank
                the flag (the reader takes the LAST stamp in the turn).
    W_STAMP     a clean write stamps the declaration beneath the provenance marker.
    W_E2E       END TO END, both real files: write a turn through write-turn.ps1 whose prose is
                the boilerplate, declared `offer`, then read it back with oa-state.ps1. This is
                the arm that would have caught the whole defect on its own.

  NOTE: no literal non-ASCII anywhere in this file. A BOM-less .ps1 is decoded as the ANSI
  codepage by Windows PowerShell 5.1, so a literal dash or emoji would be corrupted on the way
  in and an arm would fail for a reason that has nothing to do with the code under test.
#>
[CmdletBinding()]
param(
  [string]$ScriptPath,
  [string]$WriteTurnPath
)

$ErrorActionPreference = 'Stop'

if (-not $ScriptPath) { $ScriptPath = Join-Path $PSScriptRoot 'oa-state.ps1' }
if (-not $WriteTurnPath) { $WriteTurnPath = Join-Path $PSScriptRoot 'write-turn.ps1' }
if (-not (Test-Path $ScriptPath)) { throw "oa-state.ps1 not found at $ScriptPath" }
if (-not (Test-Path $WriteTurnPath)) { throw "write-turn.ps1 not found at $WriteTurnPath" }

# Under pwsh this is pwsh itself, so the whole harness runs on Linux in CI. Under Windows
# PowerShell it is `powershell`, matching how the skill actually invokes these scripts.
$script:PsExe = if ($PSVersionTable.PSEdition -eq 'Core') { (Get-Process -Id $PID).Path } else { 'powershell' }
$utf8 = New-Object Text.UTF8Encoding($false)
$MOON = [char]::ConvertFromUtf32(0x1F319)

# THE LINE THIS ISSUE IS ABOUT, built once and reused so every arm is testing the same string
# that appears in SKILL.md and in 81 live journals.
$BOILERPLATE = '**Your call:** reply below in plain English'

$root = Join-Path ([IO.Path]::GetTempPath()) ("oa-ask-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $root -Force | Out-Null

# write-turn.ps1 keeps its backups in %LOCALAPPDATA%\overnight-agent unless told otherwise, and
# a guard whose evidence can only be produced by writing into the real OA home is a guard that
# cannot run in CI. Redirected for the whole harness.
$env:WRITE_TURN_OA_HOME = Join-Path $root 'oa-home'
New-Item -ItemType Directory -Path $env:WRITE_TURN_OA_HOME -Force | Out-Null

# --- fixtures -------------------------------------------------------------------------
# `{DECL}` is the declaration stamp line (or empty, for a pre-#560 turn); `{ASK}` is the
# `Needs from you:` value; `{CALL}` an optional closing line. Deliberately the same journal
# skeleton mutcheck-awaiting-reply.ps1 uses, so a difference between the two harnesses is a
# difference in the DECLARATION and not in the fixture.
$Journal = @'
# Task {ID}: synthetic

User notes at the top.

---
<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->

## {MOON} Overnight Agent

**Status:** In progress - plan v1 - 2026-09-06

<!-- from: overnight-agent -->
{DECL}
The agent's last turn.

### Run log
**2026-09-06 (overnight):**
- did a thing

**Needs from you:** {ASK}
{CALL}
'@

function New-Journal {
  param([string]$Id, [string]$Ask = 'none', [string]$Call = '', [string]$Decl = '')
  return $Journal.Replace('{ID}', $Id).Replace('{MOON}', $MOON).Replace('{ASK}', $Ask).
    Replace('{CALL}', $Call).Replace('{DECL}', $Decl)
}

function New-Sandbox {
  param([string]$Name)
  $sx = Join-Path $root $Name
  $jdir = Join-Path $sx 'journal'
  $sdir = Join-Path $sx 'state'
  New-Item -ItemType Directory -Path $jdir -Force | Out-Null
  New-Item -ItemType Directory -Path $sdir -Force | Out-Null
  $board = Join-Path $sx 'planner.md'
  $store = Join-Path $sx 'snooze.json'

  # 910 the live defect: boilerplate prose, declared `offer`      -> must NOT park
  # 911 dismissive prose, declared `blocking`                     -> must park
  # 912 boilerplate prose, NO declaration                         -> must park (pre-#560, unchanged)
  # 913 dismissive prose, NO declaration                          -> must NOT park (fallback carve-out)
  # 914 declared `blocking`, superseded by a turn declaring `none` -> newest wins, must NOT park
  # 915 the stamp only inside a fenced example                    -> declares nothing, prose rules
  # 916 declared `none`, but the prose carries a REAL ask         -> gate open, digest still shows it
  # 917 declared `blocking`, superseded by an UNDECLARED turn     -> falls back to that turn's prose
  # 920 Deferred, plain                                           -> the row that gets starved
  [IO.File]::WriteAllText((Join-Path $jdir 'task-910.md'), (New-Journal '910' 'nothing blocking' $BOILERPLATE '<!-- oa-ask: offer -->'), $utf8)
  [IO.File]::WriteAllText((Join-Path $jdir 'task-911.md'), (New-Journal '911' 'none - nothing is blocking here' '' '<!-- oa-ask: blocking -->'), $utf8)
  [IO.File]::WriteAllText((Join-Path $jdir 'task-912.md'), (New-Journal '912' 'nothing blocking' $BOILERPLATE), $utf8)
  [IO.File]::WriteAllText((Join-Path $jdir 'task-913.md'), (New-Journal '913' 'none'), $utf8)
  [IO.File]::WriteAllText((Join-Path $jdir 'task-916.md'), (New-Journal '916' 'a decision on the vendor' '' '<!-- oa-ask: none -->'), $utf8)
  [IO.File]::WriteAllText((Join-Path $jdir 'task-920.md'), (New-Journal '920' 'none' '' '<!-- oa-ask: none -->'), $utf8)

  # 914: an older turn that declared `blocking`, then a NEWER turn declaring `none`. Kills a
  # reader that takes the FIRST declaration in the block instead of the newest turn's.
  $superseded = (New-Journal '914' 'a decision on the vendor' '' '<!-- oa-ask: blocking -->') + @'


## {MOON} Overnight Agent

<!-- from: overnight-agent -->
<!-- oa-ask: none -->
A later turn that closed the question out.

**Needs from you:** none
'@
  [IO.File]::WriteAllText((Join-Path $jdir 'task-914.md'), $superseded.Replace('{MOON}', $MOON), $utf8)

  # 917: an older turn that declared `blocking`, then a newer turn with NO declaration and
  # dismissive prose. Kills a reader that scans the WHOLE agent block for a declaration: the
  # newest turn declared nothing, so it must fall back to its own prose and read `inferred`.
  $stale = (New-Journal '917' 'a decision on the vendor' '' '<!-- oa-ask: blocking -->') + @'


## {MOON} Overnight Agent

<!-- from: overnight-agent -->
A later turn, written by an older build that had no -Ask flag.

**Needs from you:** none
'@
  [IO.File]::WriteAllText((Join-Path $jdir 'task-917.md'), $stale.Replace('{MOON}', $MOON), $utf8)

  # 918: TWO declarations inside ONE turn, `blocking` then `none`. Reachable because a journal is
  # a file Shiv edits by hand and other tooling appends to -- `write-turn.ps1`'s G13 refuses a
  # hand-written stamp at write time, but it cannot police what lands in the file afterwards. The
  # newest statement wins, which is the rule every other reader in oa-state.ps1 follows, and it is
  # also the premise G13's own refusal message rests on ("the reader takes the LAST stamp, so a
  # hand-written one would silently outrank the flag"). The prose carries no ask at all, so the
  # only thing that can decide this row is which of the two stamps is read.
  $twice = (New-Journal '918' 'nothing' '' '<!-- oa-ask: blocking -->') + @'


A correction appended after the fact:

<!-- oa-ask: none -->
'@
  [IO.File]::WriteAllText((Join-Path $jdir 'task-918.md'), $twice, $utf8)

  # 915: the stamp appears ONLY inside a fenced example -- the shape of the turn that documents
  # this feature. The prose is blocking, so a fence-blind reader would report `declared`/offer
  # and un-park a genuinely blocked task.
  $fenced = (New-Journal '915' 'a decision on the vendor') + @'


Documentation of the format:

```markdown
<!-- from: overnight-agent -->
<!-- oa-ask: offer -->
```
'@
  [IO.File]::WriteAllText((Join-Path $jdir 'task-915.md'), $fenced, $utf8)

  $sb = New-Object Text.StringBuilder
  [void]$sb.AppendLine('## Today')
  [void]$sb.AppendLine('')
  [void]$sb.AppendLine('| ID | U | Task | Work Priority | Added | Linked ID |')
  [void]$sb.AppendLine('|---|---|------|---------------|-------|-----------|')
  foreach ($id in 910, 911, 912, 913, 914, 915, 916, 917, 918) {
    [void]$sb.AppendLine("| $id |  | today $id | - | 2026-09-06 |  |")
  }
  [void]$sb.AppendLine('')
  [void]$sb.AppendLine('## Deferred')
  [void]$sb.AppendLine('')
  [void]$sb.AppendLine('| ID | U | Task | Work Priority | Added | Wake | Linked ID |')
  [void]$sb.AppendLine('| --- | --- | ------ | --------------- | ------- | ---- | ----------- |')
  [void]$sb.AppendLine('| 920 |  | deferred work | - | 2026-09-06 |  |  |')
  [IO.File]::WriteAllText($board, $sb.ToString(), $utf8)
  [IO.File]::WriteAllText($store, '{}', $utf8)

  return [pscustomobject]@{ JDir = $jdir; SDir = $sdir; Board = $board; Store = $store }
}

function Invoke-Oa {
  param([string]$Subject, $Sx, [string[]]$OaArgs)
  return (& $script:PsExe -NoProfile -ExecutionPolicy Bypass -File $Subject @OaArgs `
      -JournalDir $Sx.JDir -StateDir $Sx.SDir -PlannerBoard $Sx.Board -SnoozeStore $Sx.Store 2>&1)
}

function Initialize-Sandbox {
  # Every fixture starts `in-progress`, so the ONLY thing that can park one is the ask.
  param([string]$Subject, $Sx)
  foreach ($id in 910, 911, 912, 913, 914, 915, 916, 917, 918, 920) {
    [void](Invoke-Oa $Subject $Sx @('mark', '-Id', "$id", '-Status', 'in-progress'))
  }
}

function Get-Rows {
  param([string]$Subject, $Sx, [string[]]$Extra = @())
  $text = (Invoke-Oa $Subject $Sx (@('scan') + $Extra) | Out-String)
  try { return ($text | ConvertFrom-Json) } catch { return @() }
}

function Get-Row { param($rows, [string]$id) return ($rows | Where-Object { "$($_.id)" -eq $id } | Select-Object -First 1) }

function New-Mutant {
  param([string]$Name, [string]$Source, [string]$Find, [string]$Replace)
  $src = [IO.File]::ReadAllText($Source, $utf8)
  if (-not $src.Contains($Find)) { throw "mutant $Name : anchor not found in $Source -> $Find" }
  $dst = Join-Path $root ("mutant-$Name-" + [IO.Path]::GetFileName($Source))
  [IO.File]::WriteAllText($dst, $src.Replace($Find, $Replace), $utf8)
  return $dst
}

# --- assertion plumbing ---------------------------------------------------------------
$script:pass = 0
$script:fail = 0
function Assert([bool]$ok, [string]$name, [string]$why) {
  if ($ok) { Write-Host "  PASS  $name  -- $why"; $script:pass++ }
  else { Write-Host "  FAIL  $name  -- $why" -ForegroundColor Red; $script:fail++ }
}

# =======================================================================================
# BASELINE -- the real files, asserted against the real defect
# =======================================================================================
Write-Host ''
Write-Host '[baseline] the declared ask, against the boilerplate line that parks 81 journals'

$sx = New-Sandbox 'baseline'
$script:BaselineSx = $sx
Initialize-Sandbox $ScriptPath $sx
$rows = Get-Rows $ScriptPath $sx

$r910 = Get-Row $rows '910'
$r911 = Get-Row $rows '911'
$r912 = Get-Row $rows '912'
$r913 = Get-Row $rows '913'
$r914 = Get-Row $rows '914'
$r915 = Get-Row $rows '915'
$r916 = Get-Row $rows '916'
$r917 = Get-Row $rows '917'
$r918 = Get-Row $rows '918'

# --- preconditions. A fixture that stopped reproducing the defect would make every arm below
# pass for the wrong reason, which is how a guard rots without failing.
Assert ($null -ne $r910 -and $r910.status -eq 'in-progress') 'P_STATUS' 'fixtures are in-progress, so only the ask can park them'
Assert ($r912.awaiting_reply -eq $true) 'P_DEFECT' 'the boilerplate line really does park an undeclared turn (the defect reproduces)'

# --- D_OFFER: THE LIVE DEFECT. Same prose as 912, one stamp different.
Assert ($r910.awaiting_reply -eq $false) 'D_OFFER' 'declared offer does NOT park, despite carrying the boilerplate blocking line'
Assert ($r910.ask_source -eq 'declared') 'D_OFFER_SRC' 'and reports where that verdict came from'
Assert ($r910.ask_declared -eq 'offer') 'D_OFFER_VAL' 'and reports the declared value verbatim'

# --- D_BLOCKING: the opposite direction, which is what stops the fix being "never park".
Assert ($r911.awaiting_reply -eq $true) 'D_BLOCKING' 'declared blocking DOES park, despite opening dismissively'
Assert ($r911.ask_source -eq 'declared') 'D_BLOCKING_SRC' 'from the declaration, not the prose'

# --- D_VISIBLE / D_NONE_VIS: the digest must not lose anything.
Assert ($r910.has_open_ask -eq $true) 'D_VISIBLE' 'a declared offer is still SHOWN to the digest -- only the gate reading changed'
Assert ($r916.has_open_ask -eq $true) 'D_NONE_VIS' 'a declared none whose prose still asks something stays visible (declaration only ever ADDS visibility)'
Assert ($r916.awaiting_reply -eq $false) 'D_NONE_GATE' '...while the GATE honours the declaration and does not park it'

# --- B_COMPAT / B_DISMISS: the ~81 pre-#560 journals, unchanged.
Assert ($r912.ask_source -eq 'inferred') 'B_COMPAT' 'an undeclared turn reads as inferred, so the fallback share is countable'
Assert ($null -eq $r912.ask_declared) 'B_COMPAT_NULL' 'and declares nothing -- "undeclared" is never confused with "none"'
Assert ($r913.awaiting_reply -eq $false -and $r913.ask_source -eq 'inferred') 'B_DISMISS' 'the dismissive-opener carve-out still applies to undeclared turns (arms L2/Q of the sibling check)'

# --- N_NEWEST / N_UNDECL: scoping.
Assert ($r914.awaiting_reply -eq $false -and $r914.ask_declared -eq 'none') 'N_NEWEST' 'the NEWEST turn declaration wins; a blocking from an earlier turn cannot park forever'
Assert ($r917.ask_source -eq 'inferred' -and $r917.awaiting_reply -eq $false) 'N_UNDECL' 'a newest turn that declares nothing falls back to ITS prose, not an older turn stamp'
Assert ($r918.ask_declared -eq 'none' -and $r918.awaiting_reply -eq $false) 'N_LAST' 'within one turn the LAST declaration wins -- a correction appended below outranks the one above it'

# --- F_FENCE: a quoted stamp declares nothing.
Assert ($r915.ask_source -eq 'inferred' -and $r915.awaiting_reply -eq $true) 'F_FENCE' 'a stamp inside a fenced example declares nothing, so the prose still rules'

# --- G_GATE: the Today->Deferred gate, both directions, on single-Today-row boards.
# Asserted separately because on the mixed board above other workable Today rows would hold the
# gate for reasons that have nothing to do with the ask.
function Set-SingleTodayBoard {
  param($Sx, [string]$TodayId)
  $b = New-Object Text.StringBuilder
  [void]$b.AppendLine('## Today')
  [void]$b.AppendLine('')
  [void]$b.AppendLine('| ID | U | Task | Work Priority | Added | Linked ID |')
  [void]$b.AppendLine('|---|---|------|---------------|-------|-----------|')
  [void]$b.AppendLine("| $TodayId |  | today $TodayId | - | 2026-09-06 |  |")
  [void]$b.AppendLine('')
  [void]$b.AppendLine('## Deferred')
  [void]$b.AppendLine('')
  [void]$b.AppendLine('| ID | U | Task | Work Priority | Added | Wake | Linked ID |')
  [void]$b.AppendLine('| --- | --- | ------ | --------------- | ------- | ---- | ----------- |')
  [void]$b.AppendLine('| 920 |  | deferred work | - | 2026-09-06 |  |  |')
  [IO.File]::WriteAllText($Sx.Board, $b.ToString(), $utf8)
}

# `-TodayServedMinutes 0` for the reason arm Q of mutcheck-awaiting-reply.ps1 gives: this harness
# marks every fixture at setup to set its STATUS, which incidentally stamps a fresh `updated` and
# would let the independent run-budget gate open Deferred underneath the assertion. Pinning it to
# 0 disables only that second mechanism, so what is measured here is the PARK.
Set-SingleTodayBoard $sx '911'
$rowsBlock = Get-Rows $ScriptPath $sx @('-TodayServedMinutes', '0')
Assert ((Get-Row $rowsBlock '911').eligible -eq $false -and (Get-Row $rowsBlock '920').eligible -eq $true) `
  'G_GATE_BLOCK' 'a declared-blocking Today row is parked AND releases Deferred behind it'

Set-SingleTodayBoard $sx '910'
$rowsOffer = Get-Rows $ScriptPath $sx @('-TodayServedMinutes', '0')
Assert ((Get-Row $rowsOffer '910').eligible -eq $true -and (Get-Row $rowsOffer '920').eligible -eq $false) `
  'G_GATE_OFFER' 'a declared-offer Today row is WORKED itself and holds Deferred -- un-parked, not gate-opened'

# =======================================================================================
# WRITE-TURN -- the declaration is required, validated, and actually written
# =======================================================================================
Write-Host ''
Write-Host '[write-turn] the turn must declare its ask, and the declaration must reach the journal'

function New-WriteSandbox {
  param([string]$Name)
  $sx = New-Sandbox $Name
  # A journal with NO sentinel and no prior agent turn: write-turn adds the sentinel itself, and
  # G12 (one turn per wake) is inert with no managed turn to be the second writer for.
  [IO.File]::WriteAllText((Join-Path $sx.JDir 'task-930.md'), "# Task 930: synthetic`n`nUser notes at the top.`n", $utf8)
  return $sx
}

function New-BodyFile {
  param([string]$Path, [string]$Extra = '')
  $body = "## $MOON Overnight Agent`n`n<!-- from: overnight-agent -->`n`n**Status:** In progress - 2026-09-06`n`nDid the thing.`n`n$BOILERPLATE`n$Extra"
  [IO.File]::WriteAllText($Path, $body, $utf8)
  return $Path
}

function Invoke-WriteTurn {
  param([string]$Subject, $Sx, [string[]]$Extra)
  $out = (& $script:PsExe -NoProfile -ExecutionPolicy Bypass -File $Subject `
      -Id 930 -BodyFile (Join-Path $root 'body.md') -JournalDir $Sx.JDir @Extra 2>&1 | Out-String)
  return [pscustomobject]@{ out = $out; code = $LASTEXITCODE }
}

$wsx = New-WriteSandbox 'write'
[void](New-BodyFile (Join-Path $root 'body.md'))
$before = [IO.File]::ReadAllText((Join-Path $wsx.JDir 'task-930.md'), $utf8)

$noAsk = Invoke-WriteTurn $WriteTurnPath $wsx @()
$after = [IO.File]::ReadAllText((Join-Path $wsx.JDir 'task-930.md'), $utf8)
Assert ($noAsk.code -eq 2 -and $noAsk.out -match 'G13' -and $after -eq $before) `
  'W_REQUIRED' 'a turn that declares nothing is refused (exit 2, G13) and NOTHING is written'

$bad = Invoke-WriteTurn $WriteTurnPath $wsx @('-Ask', 'maybe')
Assert ($bad.code -eq 2 -and $bad.out -match 'G13') `
  'W_BADVALUE' 'an unrecognised -Ask value is refused rather than stamped and then ignored by the reader'

[void](New-BodyFile (Join-Path $root 'body.md') "`n<!-- oa-ask: blocking -->`n")
$hand = Invoke-WriteTurn $WriteTurnPath $wsx @('-Ask', 'offer')
[void](New-BodyFile (Join-Path $root 'body.md'))
Assert ($hand.code -eq 2 -and $hand.out -match 'G13') `
  'W_HANDSTAMP' 'a hand-written stamp is refused -- the reader takes the LAST stamp, so it would outrank the flag'

$ok = Invoke-WriteTurn $WriteTurnPath $wsx @('-Ask', 'offer')
$written = [IO.File]::ReadAllText((Join-Path $wsx.JDir 'task-930.md'), $utf8)
Assert ($ok.code -eq 0 -and $written -match '(?m)^<!--\s*from:\s*overnight-agent\s*-->\r?\n<!--\s*oa-ask:\s*offer\s*-->') `
  'W_STAMP' 'a clean write stamps the declaration on the line directly beneath the provenance marker'

# W_E2E: both real files, in the real order (write the turn, then mark it). The prose written
# here is the boilerplate, so a reader that still infers would park this row.
[void](Invoke-Oa $ScriptPath $wsx @('mark', '-Id', '930', '-Status', 'in-progress'))
$b930 = New-Object Text.StringBuilder
[void]$b930.AppendLine('## Today')
[void]$b930.AppendLine('')
[void]$b930.AppendLine('| ID | U | Task | Work Priority | Added | Linked ID |')
[void]$b930.AppendLine('|---|---|------|---------------|-------|-----------|')
[void]$b930.AppendLine('| 930 |  | today 930 | - | 2026-09-06 |  |')
[IO.File]::WriteAllText($wsx.Board, $b930.ToString(), $utf8)
$rowsE2E = Get-Rows $ScriptPath $wsx
$r930 = Get-Row $rowsE2E '930'
Assert ($null -ne $r930 -and $r930.ask_source -eq 'declared' -and $r930.ask_declared -eq 'offer' -and $r930.awaiting_reply -eq $false) `
  'W_E2E' 'end to end: write-turn stamps it, oa-state reads it, and the boilerplate no longer parks the task'

# =======================================================================================
# MUTANTS -- each must bring the defect back
# =======================================================================================
Write-Host ''
Write-Host '[mutants] each must bring the ratchet back'

# The G_GATE arms above rewrote the board to a single Today row. Restore the mixed board the
# mutant assertions were written against -- every one of them reads a row's own fields rather
# than the gate, but a board they did not expect is a difference nobody intended to test.
$restore = New-Object Text.StringBuilder
[void]$restore.AppendLine('## Today')
[void]$restore.AppendLine('')
[void]$restore.AppendLine('| ID | U | Task | Work Priority | Added | Linked ID |')
[void]$restore.AppendLine('|---|---|------|---------------|-------|-----------|')
foreach ($id in 910, 911, 912, 913, 914, 915, 916, 917, 918) {
  [void]$restore.AppendLine("| $id |  | today $id | - | 2026-09-06 |  |")
}
[void]$restore.AppendLine('')
[void]$restore.AppendLine('## Deferred')
[void]$restore.AppendLine('')
[void]$restore.AppendLine('| ID | U | Task | Work Priority | Added | Wake | Linked ID |')
[void]$restore.AppendLine('| --- | --- | ------ | --------------- | ------- | ---- | ----------- |')
[void]$restore.AppendLine('| 920 |  | deferred work | - | 2026-09-06 |  |  |')
[IO.File]::WriteAllText($sx.Board, $restore.ToString(), $utf8)

function Test-Mutant {
  param([string]$Name, [string]$Why, [string]$Subject, [scriptblock]$Body)
  # A mutant PASSES the check when the assertion it targets no longer holds. `$Body` returns
  # $true when the behaviour is still correct, so correct-under-mutation is the failure.
  $stillCorrect = $true
  try { $stillCorrect = [bool](& $Body) } catch { $stillCorrect = $false }
  if ($stillCorrect) {
    Write-Host "  FAIL  $Name  -- NOT KILLED: $Why" -ForegroundColor Red
    $script:fail++
  }
  else {
    Write-Host "  PASS  $Name  -- killed: $Why"
    $script:pass++
  }
}

function Get-MutantRows {
  # Scans the ALREADY-INITIALISED baseline sandbox with the mutant, rather than building and
  # marking a fresh one per mutant.
  #
  # Sound because every mutant below M7 changes only the READ path (`scan`), and `scan` never
  # writes -- oa-state.ps1 is explicit that a read command which writes is a read command nobody
  # can run twice safely. The state those fixtures need was produced by the REAL `mark`, which no
  # mutant touches, so sharing it cannot launder a mutation.
  #
  # It is also what makes this harness runnable: each invocation is a fresh PowerShell parsing a
  # 300 KB script, measured at ~13 s on a Windows laptop. Rebuilding a sandbox per mutant cost
  # ~85 spawns; this costs ~26, and a check too slow to run is a check that gets skipped.
  param([string]$Mutant)
  return (Get-Rows $Mutant $script:BaselineSx)
}

# M1 -- THE ARM THE ISSUE NAMES. Key `awaiting_reply` back to the prose regex even when a
#       declaration exists. This is the shipped defect, restored in one line.
$m1 = New-Mutant 'M1' $ScriptPath `
  '    HasBlockingAsk  = [bool]$askVerdict.blocking          # gate: does it stop the run proceeding?' `
  '    HasBlockingAsk  = (Test-HasBlockingAsk $agentLeft)'
Test-Mutant 'M1' 'awaiting_reply keyed back to the prose when a declaration exists' $m1 {
  $rm = Get-MutantRows $m1
  ((Get-Row $rm '910').awaiting_reply -eq $false) -and ((Get-Row $rm '911').awaiting_reply -eq $true)
}

# M2 -- report every row as `declared`. The fix would look complete while the fallback's share
#       is unmeasurable, which is the only way anyone would notice it not shrinking.
$m2 = New-Mutant 'M2' $ScriptPath `
  '      ask_source     = "$($facts.AskSource)"' `
  '      ask_source     = ''declared'''
Test-Mutant 'M2' 'ask_source always reports declared, so the inferred share is invisible' $m2 {
  $rm = Get-MutantRows $m2
  ((Get-Row $rm '912').ask_source -eq 'inferred') -and ((Get-Row $rm '910').ask_source -eq 'declared')
}

# M3 -- read declarations without the fence mask. The turn documenting this feature quotes the
#       stamp, so this un-parks a genuinely blocked task on the strength of a code sample.
$m3 = New-Mutant 'M3' $ScriptPath `
  '  $scan = Get-FenceMaskedText $turn
  $val = ''''' `
  '  $scan = $turn
  $val = '''''
Test-Mutant 'M3' 'a stamp inside a fenced example is read as a live declaration' $m3 {
  $rm = Get-MutantRows $m3
  ((Get-Row $rm '915').ask_source -eq 'inferred') -and ((Get-Row $rm '915').awaiting_reply -eq $true)
}

# M4 -- scan the WHOLE agent block for a declaration instead of the newest turn. An old
#       `blocking` then outlives the turn that said it, which is arm O's failure in declared form.
$m4 = New-Mutant 'M4' $ScriptPath `
  '  $turn = Get-NewestAgentTurn $agentLeft
  if ([string]::IsNullOrEmpty($turn)) { return '''' }
  $scan = Get-FenceMaskedText $turn' `
  '  $turn = $agentLeft
  if ([string]::IsNullOrEmpty($turn)) { return '''' }
  $scan = Get-FenceMaskedText $turn'
Test-Mutant 'M4' 'the declaration is read from the whole block, so an old blocking outlives its turn' $m4 {
  $rm = Get-MutantRows $m4
  ((Get-Row $rm '917').ask_source -eq 'inferred') -and ((Get-Row $rm '917').awaiting_reply -eq $false)
}

# M5 -- take the FIRST declaration in the turn rather than the last. Within one turn that is the
#       same "an earlier statement outranks a later one" error, one scope down: a correction
#       appended below the emitted stamp would be ignored, which is also the premise G13's refusal
#       of hand-written stamps rests on.
$m5 = New-Mutant 'M5' $ScriptPath `
  '  foreach ($m in [regex]::Matches($scan, $script:AskDeclRe)) { $val = $m.Groups[1].Value }' `
  '  foreach ($m in [regex]::Matches($scan, $script:AskDeclRe)) { if (-not $val) { $val = $m.Groups[1].Value } }'
Test-Mutant 'M5' 'the FIRST declaration in a turn wins, so a correction below it is ignored' $m5 {
  $rm = Get-MutantRows $m5
  ((Get-Row $rm '918').ask_declared -eq 'none') -and ((Get-Row $rm '918').awaiting_reply -eq $false)
}

# M6 -- let the declaration SUPPRESS digest visibility as well as the gate. This is the
#       regression the issue explicitly forbids: the digest would stop showing offers, and a
#       question Shiv could have answered would reach no surface at all.
$m6 = New-Mutant 'M6' $ScriptPath `
  '  if ($declared -eq ''blocking'' -or $declared -eq ''offer'') { return $true }' `
  '  if ($declared) { return ($declared -ne ''none'') }'
Test-Mutant 'M6' 'a declared none suppresses has_open_ask, hiding a question the prose still asks' $m6 {
  $rm = Get-MutantRows $m6
  ((Get-Row $rm '916').has_open_ask -eq $true) -and ((Get-Row $rm '910').has_open_ask -eq $true)
}

# M7 -- drop G13's refusal. The flag becomes optional, so a forgotten `-Ask` silently reverts
#       that turn to the prose inference and the ratchet comes back one turn at a time.
$m7 = New-Mutant 'M7' $WriteTurnPath '  if (& $on ''G13'') {' '  if ($false) {'
Test-Mutant 'M7' 'write-turn accepts a turn that declares nothing' $m7 {
  $wsm = New-WriteSandbox 'm7'
  [void](New-BodyFile (Join-Path $root 'body.md'))
  $b = [IO.File]::ReadAllText((Join-Path $wsm.JDir 'task-930.md'), $utf8)
  $res = Invoke-WriteTurn $m7 $wsm @()
  $a = [IO.File]::ReadAllText((Join-Path $wsm.JDir 'task-930.md'), $utf8)
  ($res.code -eq 2) -and ($a -eq $b)
}

# M8 -- validate the flag but never write the stamp. Every refusal still fires, the author is
#       told nothing is wrong, and the reader falls back to the prose: green and broken.
$m8 = New-Mutant 'M8' $WriteTurnPath `
  '((Add-AskStamp -Body $body.TrimEnd() -Ask $askVal) -replace "`r?`n", $nl)' `
  '($body.TrimEnd() -replace "`r?`n", $nl)'
Test-Mutant 'M8' 'the declaration is validated but never written to the journal' $m8 {
  $wsm = New-WriteSandbox 'm8'
  [void](New-BodyFile (Join-Path $root 'body.md'))
  $res = Invoke-WriteTurn $m8 $wsm @('-Ask', 'offer')
  $w = [IO.File]::ReadAllText((Join-Path $wsm.JDir 'task-930.md'), $utf8)
  ($res.code -eq 0) -and ($w -match '(?m)^<!--\s*oa-ask:\s*offer\s*-->')
}

# --- report ---------------------------------------------------------------------------
Write-Host ''
"$script:pass passed, $script:fail failed  (oa-state: $ScriptPath; write-turn: $WriteTurnPath)"

Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue

if ($script:fail -gt 0) { exit 1 }
exit 0
