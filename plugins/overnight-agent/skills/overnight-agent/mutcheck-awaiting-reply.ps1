<#
  mutcheck-awaiting-reply.ps1 -- mutation check for the awaiting-reply state in the #223
  selection gate.

  THE DEFECT. `Test-Workable` excluded `done`/`skip`/`proposed`/`blocked` as "terminal or
  waiting on the user", but not `in-progress`. A run that finishes a step and hands back an
  open question leaves the task `in-progress` while it is, in fact, waiting on the user --
  and user-settings.md separately forbids the run from stacking a new turn on an unanswered
  one. So the gate counted a task the run must not write to as "still workable Today", and
  held every Deferred row shut behind it.

  Measured on the live board 2026-08-30 21:30 PT: ONE Today row (#451, an unanswered
  `**Your call:**` written 14 minutes earlier) made all 55 workable Deferred rows ineligible.
  Eligible rows across the whole board: 1 before, 4 after. Nothing errored -- the gate did
  exactly what it said, which is why it starves silently and reads clean in every sweep.

  Builds a synthetic board + journal folder, runs the REAL oa-state.ps1 against it with an
  isolated -JournalDir / -StateDir / -PlannerBoard / -SnoozeStore, and asserts eligibility.

    powershell -File mutcheck-awaiting-reply.ps1 -ScriptPath <path-to-oa-state.ps1> [-ExpectPreFix]

  Arms, and the distinct mutant each one kills:

    I  awaiting parks the row      (kills: no awaiting state at all -- the shipped defect)
    J  ...and opens the gate       (kills: parking the row but still counting it as Today
                                    workable, i.e. fixing the symptom's name and not the gate)
    K  dismissive ask does NOT park(kills: treating any `Needs from you:` as an ask, which
                                    would park nearly every task and starve the run the other
                                    way -- the over-correction)
    L  qualified dismissal DOES    (kills: `if (starts with none) return null`, the precedence
                                    error the Telegram digest already had to fix once: a
                                    dismissive clause must dismiss only ITSELF)
    M  a reply un-parks it         (kills: awaiting outranking `reopened`, which would strand a
                                    task the user just answered)
    N  a due poll beats the park   (kills: a recurring self-check silently stopping the moment
                                    the user stops replying -- the exact failure polling exists
                                    to prevent. All 3 polled + both recheck tasks on the live
                                    board are awaiting_reply, so this is not hypothetical.)
    O  only the NEWEST turn counts (kills: scanning the whole block, so an ask answered three
                                    turns ago parks the task forever)
    P  a CONSUMED reply un-parks    (kills: awaiting_reply ignoring that the user has since
                                    spoken -- the task would be stranded with no route back,
                                    because it is no longer `reopened` either)
    Q  a declared-unblocked board   (kills: THE RATCHET. The gate reading the digest's generous
       still yields work            ask vocabulary, so the agent's own closing courtesy
                                    ("nothing needed - say the word") parks its own task. Every
                                    turn written then makes the board strictly less workable and
                                    only a human reply releases it. Measured live 2026-08-31:
                                    186/238 rows parked, all others terminal, ZERO eligible rows
                                    anywhere. This arm asserts a board of declared-unblocked
                                    rows is not zero-eligible.)
    R  declared-unblocked + an      (kills: over-correcting Q by dropping the `Your call:` park
       explicit `Your call:` STILL   as well. A direct hand-back makes no claim of
       parks                         self-sufficiency, so it must keep parking -- otherwise the
                                     run stacks a turn on a live question.)

  NOTE: no literal non-ASCII anywhere in this file. A BOM-less .ps1 is decoded as the ANSI
  codepage by Windows PowerShell 5.1, so a literal dash or emoji would be corrupted on the way
  in and an arm would fail for a reason that has nothing to do with the code under test.
#>
[CmdletBinding()]
param(
  [string]$ScriptPath,
  [switch]$ExpectPreFix
)

$ErrorActionPreference = 'Stop'

if (-not $ScriptPath) { $ScriptPath = Join-Path $PSScriptRoot 'oa-state.ps1' }
if (-not (Test-Path $ScriptPath)) { throw "oa-state.ps1 not found at $ScriptPath" }

$EMDASH = [char]0x2014

# A turn whose ask text is supplied by the caller. `{ASK}` is the `Needs from you:` value;
# `{CALL}` is an optional `**Your call:**` line.
$Journal = @'
# Task {ID}: synthetic

User notes at the top.

---
<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->

## Overnight Agent

**Status:** In progress - plan v1 - 2026-08-30

<!-- from: overnight-agent -->
The agent's last turn.

### Run log
**2026-08-30 (overnight):**
- did a thing

**Needs from you:** {ASK}
{CALL}
'@

function New-Journal {
  param([string]$Id, [string]$Ask = 'none', [string]$Call = '')
  return $Journal.Replace('{ID}', $Id).Replace('{ASK}', $Ask).Replace('{CALL}', $Call)
}

# --- isolated sandbox ---------------------------------------------------------------
$root = Join-Path ([IO.Path]::GetTempPath()) ("oa-await-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
$jdir = Join-Path $root 'journal'
$sdir = Join-Path $root 'state'
New-Item -ItemType Directory -Path $jdir -Force | Out-Null
New-Item -ItemType Directory -Path $sdir -Force | Out-Null

$board = Join-Path $root 'planner.md'
$store = Join-Path $root 'snooze.json'
$utf8 = New-Object Text.UTF8Encoding($false)

# 810 = Today, unanswered `Your call:`      -> must park, and must open the gate
# 811 = Today, dismissive `none`            -> must stay workable
# 820 = Deferred, plain work                -> the row that was being starved
# 830 = Today, qualified dismissal          -> must park (clause break)
# 840 = Today, reply below the turn         -> reopened, must stay workable
# 850 = Today, ask + due poll               -> timer must beat the park
# 860 = Today, old ask superseded by a newer turn with none -> must stay workable
[IO.File]::WriteAllText((Join-Path $jdir 'task-810.md'), (New-Journal '810' 'nothing to act on tonight' '**Your call:** `1` or `2`'), $utf8)
[IO.File]::WriteAllText((Join-Path $jdir 'task-811.md'), (New-Journal '811' 'none'), $utf8)
[IO.File]::WriteAllText((Join-Path $jdir 'task-820.md'), (New-Journal '820' 'none'), $utf8)
[IO.File]::WriteAllText((Join-Path $jdir 'task-830.md'), (New-Journal '830' ("none $EMDASH but tell me if you would rather I draft the questions")), $utf8)
[IO.File]::WriteAllText((Join-Path $jdir 'task-840.md'), (New-Journal '840' 'a decision on the vendor'), $utf8)
[IO.File]::WriteAllText((Join-Path $jdir 'task-850.md'), (New-Journal '850' 'a decision on the vendor'), $utf8)
# 870: a real ask, with the user's reply below it, ALREADY consumed by `mark` (so it is no
# longer `reopened`). The ask is stale -- the user answered it -- so the task must not park.
[IO.File]::WriteAllText((Join-Path $jdir 'task-870.md'), (New-Journal '870' 'a decision on the vendor'), $utf8)

# 860: a turn carrying a real ask, then a NEWER agent turn that carries none. Only the newest
# turn may be consulted, so this task is workable.
$superseded = (New-Journal '860' 'a decision on the vendor') + @'


## Overnight Agent

<!-- from: overnight-agent -->
A later turn that closed the question out.

**Needs from you:** none
'@
[IO.File]::WriteAllText((Join-Path $jdir 'task-860.md'), $superseded, $utf8)

# 880: declared-unblocked AND an explicit `Your call:` -> must STILL park (arm R). A direct
# hand-back makes no claim of self-sufficiency, so the dismissive opener beside it must not
# license stacking a turn on a live question.
[IO.File]::WriteAllText((Join-Path $jdir 'task-880.md'), (New-Journal '880' 'nothing to act on' '**Your call:** ship it or hold it'), $utf8)

# 890/891/892: tonight's live shape in miniature -- every row's newest turn ends with the
# agent's own closing courtesy. Under the shared ask vocabulary the whole board parks itself.
[IO.File]::WriteAllText((Join-Path $jdir 'task-890.md'), (New-Journal '890' 'nothing. Both items above are optional; say the word on either and I will pick it up.'), $utf8)
[IO.File]::WriteAllText((Join-Path $jdir 'task-891.md'), (New-Journal '891' 'nothing to unblock it. Two optional calls when you are ready:'), $utf8)
[IO.File]::WriteAllText((Join-Path $jdir 'task-892.md'), (New-Journal '892' 'none to start. One word if you want it faster.'), $utf8)

$sb = New-Object Text.StringBuilder
[void]$sb.AppendLine('## Today')
[void]$sb.AppendLine('')
[void]$sb.AppendLine('| ID | U | Task | Work Priority | Added | Linked ID |')
[void]$sb.AppendLine('|---|---|------|---------------|-------|-----------|')
foreach ($id in 810, 811, 830, 840, 850, 860, 870, 880) {
  [void]$sb.AppendLine("| $id |  | today $id | - | 2026-08-30 |  |")
}
[void]$sb.AppendLine('')
[void]$sb.AppendLine('## Deferred')
[void]$sb.AppendLine('')
[void]$sb.AppendLine('| ID | U | Task | Work Priority | Added | Wake | Linked ID |')
[void]$sb.AppendLine('| --- | --- | ------ | --------------- | ------- | ---- | ----------- |')
[void]$sb.AppendLine('| 820 |  | deferred work | - | 2026-08-30 |  |  |')
[IO.File]::WriteAllText($board, $sb.ToString(), $utf8)
[IO.File]::WriteAllText($store, '{}', $utf8)

function Invoke-Oa {
  param([string[]]$OaArgs)
  & powershell -NoProfile -ExecutionPolicy Bypass -File $ScriptPath @OaArgs `
    -JournalDir $jdir -StateDir $sdir -PlannerBoard $board -SnoozeStore $store 2>&1
}

function Get-Rows {
  $text = (Invoke-Oa @('scan') | Out-String)
  try { return ($text | ConvertFrom-Json) } catch { return @() }
}

function Get-RowsWith {
  # scan with extra flags, for arms that must isolate one mechanism from another.
  param([string[]]$Extra)
  $text = (Invoke-Oa (@('scan') + $Extra) | Out-String)
  try { return ($text | ConvertFrom-Json) } catch { return @() }
}

function Get-Row {
  param($rows, [string]$id)
  return ($rows | Where-Object { "$($_.id)" -eq $id } | Select-Object -First 1)
}

$results = [ordered]@{}
function Check([string]$name, [scriptblock]$body) {
  $ok = $false
  try { $ok = [bool](& $body) } catch { $ok = $false }
  $results[$name] = $ok
}

# Every task starts in-progress so the ONLY thing that can park one is the awaiting state.
foreach ($id in 810, 811, 820, 830, 840, 850, 860, 870, 880, 890, 891, 892) {
  [void](Invoke-Oa @('mark', '-Id', "$id", '-Status', 'in-progress'))
}

# 870: the user answers, and `mark` consumes that reply (re-snapshotting the hash) without the
# agent having written a new turn yet. The task is no longer `reopened`, but the ask above is
# stale -- they answered it -- so it must NOT be parked. This is what the `-not HasTrailingUser`
# term in awaiting_reply guards; without it the task is stranded with no way back.
$p870 = Join-Path $jdir 'task-870.md'
$t870 = [IO.File]::ReadAllText($p870, $utf8) + "`n`n## 2026-08-31`n`n<!-- from: me -->`nuse the second vendor`n"
[IO.File]::WriteAllText($p870, $t870, $utf8)
[void](Invoke-Oa @('mark', '-Id', '870', '-Status', 'in-progress'))

$rows = Get-Rows

# P: a consumed reply leaves the task workable, not stranded.
Check 'P consumed reply does not park' {
  $r = Get-Row $rows '870'
  ($null -ne $r) -and ($r.reopened -eq $false) -and ($r.awaiting_reply -eq $false)
}

# I: the unanswered `Your call:` parks its own row.
Check 'I awaiting parks the row' {
  $r = Get-Row $rows '810'
  ($null -ne $r) -and ($r.awaiting_reply -eq $true) -and ($r.eligible -eq $false)
}

# J: THE POINT. Parking must also release the Today->Deferred gate. Asserted against a board
# whose ONLY Today row is the parked one -- which is exactly the live shape that starved the run
# (#451 alone in Today). With other workable Today rows present the gate SHOULD stay shut, so
# testing it on the mixed board above would assert the wrong thing.
$sbJ = New-Object Text.StringBuilder
[void]$sbJ.AppendLine('## Today')
[void]$sbJ.AppendLine('')
[void]$sbJ.AppendLine('| ID | U | Task | Work Priority | Added | Linked ID |')
[void]$sbJ.AppendLine('|---|---|------|---------------|-------|-----------|')
[void]$sbJ.AppendLine('| 810 |  | today 810 | - | 2026-08-30 |  |')
[void]$sbJ.AppendLine('')
[void]$sbJ.AppendLine('## Deferred')
[void]$sbJ.AppendLine('')
[void]$sbJ.AppendLine('| ID | U | Task | Work Priority | Added | Wake | Linked ID |')
[void]$sbJ.AppendLine('| --- | --- | ------ | --------------- | ------- | ---- | ----------- |')
[void]$sbJ.AppendLine('| 820 |  | deferred work | - | 2026-08-30 |  |  |')
[IO.File]::WriteAllText($board, $sbJ.ToString(), $utf8)
$rowsJ = Get-Rows
Check 'J parked row opens the gate' {
  $t = Get-Row $rowsJ '810'
  $d = Get-Row $rowsJ '820'
  ($null -ne $t) -and ($null -ne $d) -and
  ($t.awaiting_reply -eq $true) -and ($t.eligible -eq $false) -and ($d.eligible -eq $true)
}
[IO.File]::WriteAllText($board, $sb.ToString(), $utf8)   # restore the mixed board

# K: over-correction guard. `Needs from you: none` is NOT an ask; treating it as one would park
# almost every task on the board and starve the run from the other direction.
Check 'K dismissive ask does not park' {
  $r = Get-Row $rows '811'
  ($null -ne $r) -and ($r.awaiting_reply -eq $false) -and ($r.eligible -eq $true)
}

# L1 + L2: `none - but tell me X` is TWO facts, and they belong to two different surfaces.
#
#   L1 (visibility, unchanged): the digest must still SHOW it. This is the arm that kills the
#      old `if (starts with none) return null` precedence error -- a dismissive clause dismisses
#      only ITSELF, so the question after the clause break must remain visible to the user.
#
#   L2 (gate, changed 2026-08-31): it must NOT park the run. The dismissive opener is the agent
#      stating about its own state that it is not blocked; what follows is an OFFER, and silence
#      is a valid answer to an offer. Parking on it is what produced a zero-eligible board.
#
# The original single assertion conflated the two, which is precisely how the digest's
# deliberately generous reading became the scheduler's starvation condition.
Check 'L1 qualified dismissal stays VISIBLE' {
  $r = Get-Row $rows '830'
  ($null -ne $r) -and ($r.has_open_ask -eq $true)
}
Check 'L2 qualified dismissal does NOT park the gate' {
  $r = Get-Row $rows '830'
  ($null -ne $r) -and ($r.awaiting_reply -eq $false) -and ($r.eligible -eq $true)
}

# O: scoping. An ask that a LATER turn closed out must not park the task forever.
Check 'O only newest turn counts' {
  $r = Get-Row $rows '860'
  ($null -ne $r) -and ($r.awaiting_reply -eq $false) -and ($r.eligible -eq $true)
}

# M: a reply outranks the park -- the user answered, so the task is live again.
$p840 = Join-Path $jdir 'task-840.md'
$txt = [IO.File]::ReadAllText($p840, $utf8) + "`n`n## 2026-08-31`n`n<!-- from: me -->`ngo ahead`n"
[IO.File]::WriteAllText($p840, $txt, $utf8)
$rowsM = Get-Rows
Check 'M reply un-parks it' {
  $r = Get-Row $rowsM '840'
  ($null -ne $r) -and ($r.reopened -eq $true) -and ($r.eligible -eq $true)
}

# N: a DUE timer beats the park. Without this a recurring self-check stops firing the moment the
# user stops replying, which is precisely the failure polling exists to prevent.
[void](Invoke-Oa @('mark', '-Id', '850', '-Poll', 'daily'))
$rowsN = Get-Rows
Check 'N due poll beats the park' {
  $r = Get-Row $rowsN '850'
  ($null -ne $r) -and ($r.due_poll -eq $true) -and ($r.awaiting_reply -eq $true) -and ($r.eligible -eq $true)
}

# R: over-correction guard for Q. Loosening the dismissive case must NOT also drop the
# `**Your call:**` park -- that is a direct hand-back with no claim of self-sufficiency beside
# it, so the run would be stacking a turn on a live question.
Check 'R declared-unblocked + Your call still parks' {
  $r = Get-Row $rows '880'
  ($null -ne $r) -and ($r.awaiting_reply -eq $true) -and ($r.eligible -eq $false)
}

# Q: THE ANTI-STARVATION INVARIANT, and the check that would have caught this on its own.
# A board whose every row carries the agent's own "nothing needed, but here's an option"
# sign-off must still yield work. Asserted on a board built ONLY from that shape, because that
# is the live shape: on 2026-08-31 it produced 0 eligible rows out of 238.
$sbQ = New-Object Text.StringBuilder
[void]$sbQ.AppendLine('## Today')
[void]$sbQ.AppendLine('')
[void]$sbQ.AppendLine('| ID | U | Task | Work Priority | Added | Linked ID |')
[void]$sbQ.AppendLine('|---|---|------|---------------|-------|-----------|')
[void]$sbQ.AppendLine('| 890 |  | today 890 | - | 2026-08-31 |  |')
[void]$sbQ.AppendLine('')
[void]$sbQ.AppendLine('## Deferred')
[void]$sbQ.AppendLine('')
[void]$sbQ.AppendLine('| ID | U | Task | Work Priority | Added | Wake | Linked ID |')
[void]$sbQ.AppendLine('| --- | --- | ------ | --------------- | ------- | ---- | ----------- |')
[void]$sbQ.AppendLine('| 891 |  | deferred 891 | - | 2026-08-31 |  |  |')
[void]$sbQ.AppendLine('| 892 |  | deferred 892 | - | 2026-08-31 |  |  |')
[IO.File]::WriteAllText($board, $sbQ.ToString(), $utf8)
# Pinned to -TodayServedMinutes 0 ON PURPOSE. This arm is a test of the awaiting-reply PARK, and
# its distinguishing claim is that the Today row becomes eligible by being UN-PARKED rather than
# by the Today->Deferred gate being opened underneath it. The run-budget gate added later
# (Test-HoldsTodayGate) is a second, independent mechanism that also opens Deferred -- and this
# harness marks every fixture task at setup purely to set its STATUS, which incidentally stamps a
# fresh `updated` and makes 890 read as "served this cycle". Leaving that in would let the two
# mechanisms mask each other: the arm would pass or fail for reasons that have nothing to do with
# the park. `0` disables only the budget gate, so the original assertion below -- including
# "Deferred stays held" -- is preserved in full and still kills the gate-opening mutant.
$rowsQ = Get-RowsWith @('-TodayServedMinutes', '0')
Check 'Q declared-unblocked board is not zero-eligible' {
  $elig = @($rowsQ | Where-Object { $_.eligible })
  $today = Get-Row $rowsQ '890'
  # Not merely "something is eligible": the TODAY row must be the one that is, and the
  # Deferred rows must stay held behind it. A fix that opened the gate instead of un-parking
  # the row would satisfy a bare count and still be wrong.
  ($elig.Count -ge 1) -and ($null -ne $today) -and ($today.eligible -eq $true) -and
  (@($rowsQ | Where-Object { $_.section -eq 'deferred' -and $_.eligible }).Count -eq 0)
}
[IO.File]::WriteAllText($board, $sb.ToString(), $utf8)   # restore the mixed board

# --- report ---------------------------------------------------------------------------
$pass = 0; $fail = 0
foreach ($k in $results.Keys) {
  if ($results[$k]) { "  PASS  $k"; $pass++ } else { "  FAIL  $k"; $fail++ }
}
""
"$pass passed, $fail failed  (script: $ScriptPath)"

Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue

if ($ExpectPreFix) {
  if ($fail -eq 0) { "MUTCHECK FAILED: pre-fix script passed everything - the fix guards nothing."; exit 1 }
  "MUTCHECK OK: pre-fix script fails $fail arm(s), as required."
  exit 0
}

if ($fail -gt 0) { exit 1 }
exit 0
