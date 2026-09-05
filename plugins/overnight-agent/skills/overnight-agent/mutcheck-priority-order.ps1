<#
  mutcheck-priority-order.ps1 -- mutation check for #223: the agent must work tasks in board
  priority order (Today first, by priority) and only fall through to Deferred once Today is
  exhausted.

  Builds a synthetic board + journal folder, runs the REAL oa-state.ps1 against it with an
  isolated -JournalDir / -StateDir / -PlannerBoard / -SnoozeStore (so live state is never
  touched), and asserts the ORDER and ELIGIBILITY that scan emits.

  Run it against BOTH the pre-fix and post-fix scripts. The change is only load-bearing if the
  pre-fix script FAILS these arms:

    powershell -File mutcheck-priority-order.ps1 -ScriptPath <path-to-oa-state.ps1> [-ExpectPreFix]

  Why this is a mutation check and not a unit test: before #223, `scan` sorted by FILENAME
  (task-id ascending) and emitted no section/priority/order field at all, so "Today first"
  existed only as prose in SKILL.md -- advice to a model, not a mechanism. Every arm below is
  therefore expected to fail on origin/main.

  Arms, and the distinct mutant each one kills:

    A  Today before Deferred        (kills: no section gate -- a P2 Deferred row can eat a run
                                     while a Today row sits untouched, the reported symptom)
    B  P0 < P1 < unset within Today (kills: comparator ignoring Work Priority)
    C  red < yellow within Deferred (kills: urgency tiebreak absent, or -- the subtle one --
                                     an emoji compared as mojibake under PowerShell 5.1)
    D  `## Priorities` breaks ties  (kills: the user's own ordered list being ignored)
    E  Deferred not eligible        (kills: ordering without a GATE, so the agent can still
                                     pick a Deferred row it merely sorted lower)
    F  Today terminal -> eligible   (kills: a gate that never opens, starving Deferred forever)
    G  reopened preempts            (kills: a live reply losing to board rank -- rule 4)
    H  deterministic                (kills: unstable sort; two runs must agree)
    I  declared Today releases       (kills: exclusivity keyed to WORKABLE -- an unbounded Today
                                     row then starves the whole backlog forever, which is what
                                     happened live)
    J  declared Today still first    (kills: the over-correction -- releasing exclusivity must
                                     not cost ORDERING, or the fix is just "ignore the board")
    K  served-minutes 0 reverts      (kills: a one-way change; the flag must restore A-H exactly)
    L  reply reclaims exclusivity    (kills: a declaration muting a Today task the user just
                                     replied to -- dropping live input is worse than starvation)
    M  writing does not release      (kills: exclusivity keyed to RECENCY -- the agent then opens
                                     its own gate by typing, which is #310)

  NOTE: the urgency icons are built from CODEPOINTS, never as literals. A literal emoji in a
  .ps1 is the exact hazard ps1-encoding-sweep.mjs exists to catch -- under Windows PowerShell
  5.1 a BOM-less source file is decoded as the ANSI codepage, so the fixture would be corrupted
  on the way in and arm C would report a false failure that reads like a real defect.
#>
[CmdletBinding()]
param(
  [string]$ScriptPath,
  [switch]$ExpectPreFix
)

$ErrorActionPreference = 'Stop'

if (-not $ScriptPath) { $ScriptPath = Join-Path $PSScriptRoot 'oa-state.ps1' }
if (-not (Test-Path $ScriptPath)) { throw "oa-state.ps1 not found at $ScriptPath" }

$RED = [char]::ConvertFromUtf32(0x1F534)
$YEL = [char]::ConvertFromUtf32(0x1F7E1)

$Journal = @'
# Task {ID}: synthetic

User notes at the top.

---
<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->

## Overnight Agent

**Status:** In progress - plan v1 - 2026-08-30

<!-- from: overnight-agent -->
The agent's last turn.

**Needs from you:** none
'@

# --- isolated sandbox ---------------------------------------------------------------
$root = Join-Path ([IO.Path]::GetTempPath()) ("oa-prio-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
$jdir = Join-Path $root 'journal'
$sdir = Join-Path $root 'state'
New-Item -ItemType Directory -Path $jdir -Force | Out-Null
New-Item -ItemType Directory -Path $sdir -Force | Out-Null

$board = Join-Path $root 'planner.md'
$store = Join-Path $root 'snooze.json'
$utf8 = New-Object Text.UTF8Encoding($false)

# 730/710/720 are Today; 740/760/750 are Deferred. IDs deliberately do NOT ascend in the
# expected order -- a scan that still sorts by filename cannot accidentally pass.
foreach ($id in 730, 710, 720, 740, 760, 750) {
  [IO.File]::WriteAllText((Join-Path $jdir "task-$id.md"), $Journal.Replace('{ID}', "$id"), $utf8)
}

$sb = New-Object Text.StringBuilder
[void]$sb.AppendLine('## Today')
[void]$sb.AppendLine('')
[void]$sb.AppendLine('| ID | U | Task | Work Priority | Added | Linked ID |')
[void]$sb.AppendLine('|---|---|------|---------------|-------|-----------|')
[void]$sb.AppendLine("| 720 | $YEL | today unset yellow | - | 2026-08-30 |  |")
[void]$sb.AppendLine("| 710 | $RED | today P1 red | P1 | 2026-08-30 |  |")
[void]$sb.AppendLine("| 730 | $RED | today P0 red | P0 | 2026-08-30 |  |")
[void]$sb.AppendLine('')
[void]$sb.AppendLine('## Deferred')
[void]$sb.AppendLine('')
[void]$sb.AppendLine('| ID | U | Task | Work Priority | Added | Wake | Linked ID |')
[void]$sb.AppendLine('| --- | --- | ------ | --------------- | ------- | ---- | ----------- |')
[void]$sb.AppendLine("| 750 | $YEL | deferred yellow unlisted | - | 2026-08-30 |  |  |")
[void]$sb.AppendLine("| 760 | $YEL | deferred yellow listed | - | 2026-08-30 |  |  |")
[void]$sb.AppendLine("| 740 | $RED | deferred red | - | 2026-08-30 |  |  |")
[void]$sb.AppendLine('')
[void]$sb.AppendLine('## Priorities')
[void]$sb.AppendLine('')
[void]$sb.AppendLine('1. 760')
[IO.File]::WriteAllText($board, $sb.ToString(), $utf8)
[IO.File]::WriteAllText($store, '{}', $utf8)

function Invoke-Oa {
  param([string[]]$OaArgs)
  & powershell -NoProfile -ExecutionPolicy Bypass -File $ScriptPath @OaArgs `
    -JournalDir $jdir -StateDir $sdir -PlannerBoard $board -SnoozeStore $store 2>&1
}

function Get-Rows {
  $raw = Invoke-Oa @('scan')
  $text = ($raw | Out-String)
  try { return ($text | ConvertFrom-Json) } catch { return @() }
}

function Get-RowsWith {
  # scan with extra flags, for arms that must isolate one gate from the other.
  #
  # Tolerates failure ON PURPOSE. This is called from top level, not from inside Check, and a
  # script that lacks the flag (e.g. the pre-fix build this harness is meant to be run against)
  # writes a NativeCommandError -- which, under $ErrorActionPreference='Stop', would abort the
  # whole run and report NOTHING. A harness that dies instead of reporting is the inverse of the
  # vacuous-pass hazard documented on arms E and H, and just as useless. Returning an empty set
  # makes the dependent arm FAIL, which is the correct verdict for "this build cannot do that".
  param([string[]]$Extra)
  try {
    $text = (Invoke-Oa (@('scan') + $Extra) | Out-String)
  } catch {
    return @()
  }
  try { return ($text | ConvertFrom-Json) } catch { return @() }
}

function Get-Row {
  param($rows, [string]$id)
  return ($rows | Where-Object { "$($_.id)" -eq $id } | Select-Object -First 1)
}

function Try-Oa {
  # For calls that a build may not understand at all (e.g. `-Exhausted` against the pre-fix
  # script this harness is meant to be run against). Same reasoning as Get-RowsWith: under
  # $ErrorActionPreference='Stop' the NativeCommandError would abort the whole run and report
  # NOTHING, and a harness that dies instead of reporting is worse than a vacuous pass. Swallow
  # it and let the dependent arm FAIL, which is the correct verdict for "this build cannot".
  param([string[]]$OaArgs)
  try { [void](Invoke-Oa $OaArgs) } catch { }
}

function Ord {
  param($rows, [string]$id)
  $r = Get-Row $rows $id
  if ($null -eq $r -or $null -eq $r.order) { return -1 }
  return [int]$r.order
}

$results = [ordered]@{}
function Check([string]$name, [scriptblock]$body) {
  $ok = $false
  try { $ok = [bool](& $body) } catch { $ok = $false }
  $results[$name] = $ok
}

# --- baseline: every task workable ----------------------------------------------------
$rows = Get-Rows

# A: section gate -- every Today row outranks every Deferred row.
Check 'A Today before Deferred' {
  $t = @(720, 710, 730 | ForEach-Object { Ord $rows "$_" })
  $d = @(740, 760, 750 | ForEach-Object { Ord $rows "$_" })
  ($t -notcontains -1) -and ($d -notcontains -1) -and (($t | Measure-Object -Maximum).Maximum -lt ($d | Measure-Object -Minimum).Minimum)
}

# B: Work Priority orders within a section (P0 > P1 > unset).
Check 'B P0<P1<unset in Today' {
  (Ord $rows '730') -lt (Ord $rows '710') -and (Ord $rows '710') -lt (Ord $rows '720')
}

# C: urgency breaks the tie when Work Priority is unset. Also proves the emoji survived the
# round-trip: compared as mojibake, red and yellow are indistinguishable and this fails.
Check 'C red before yellow' {
  (Ord $rows '740') -lt (Ord $rows '760') -and (Ord $rows '740') -lt (Ord $rows '750')
}

# D: with section, priority and urgency all equal, the user's `## Priorities` list decides.
Check 'D Priorities list breaks tie' {
  (Ord $rows '760') -lt (Ord $rows '750')
}

# E: THE GATE. Sorting alone is not enough -- a Deferred row must be ineligible while any
# Today row is still workable. The explicit non-null assertion matters: without it this arm
# passes VACUOUSLY on a build that emits no `eligible` field at all (every value is $null, so
# "contains no $true" is trivially satisfied) -- a green check that asserts nothing.
Check 'E Deferred ineligible' {
  $d = @(740, 760, 750 | ForEach-Object { (Get-Row $rows "$_").eligible })
  $t = @(720, 710, 730 | ForEach-Object { (Get-Row $rows "$_").eligible })
  ($d -notcontains $null) -and ($t -notcontains $null) -and
  ($d -notcontains $true) -and ($t -notcontains $false)
}

# H: determinism -- an unchanged board must produce an identical order. Asserting the order
# field is a real 1..N permutation keeps this from passing vacuously too: with no `order`
# field, Sort-Object is a no-op and both runs trivially match in filename order.
Check 'H deterministic order' {
  $again = Get-Rows
  $a = ($rows | Sort-Object order | ForEach-Object { "$($_.id)" }) -join ','
  $b = ($again | Sort-Object order | ForEach-Object { "$($_.id)" }) -join ','
  $ords = @($rows | ForEach-Object { $_.order }) | Sort-Object
  $expected = 1..6
  ($a -eq $b) -and $a.Length -gt 0 -and (($ords -join ',') -eq ($expected -join ','))
}

# --- M/I/J/K/L: WHAT RELEASES the Today gate (#223's rule 1, corrected again in #310) ------
# Arms A-H prove Today is worked FIRST. They do not prove Deferred is ever REACHABLE when a
# Today row is unbounded, and they do not say what may open the gate. Both gaps were
# load-bearing in production, in opposite directions:
#
#   keyed to WORKABILITY  the gate never opens for an unbounded row. Measured live 2026-08-31:
#                         the entire `## Today` section was a SINGLE standing meta-task ("triage
#                         and ship GitHub issues") -- there is always another issue -- so arm E's
#                         gate held 121 Deferred rows shut on every run. `scan` reported 1
#                         eligible row out of 238, and three runs in one night each re-worked
#                         that one task and touched nothing else.
#   keyed to RECENCY      the gate opens the moment the agent TYPES, because `mark` stamps
#                         `last_turn_at` on every turn. That was the replacement, and it was
#                         worse: the run released the whole backlog by writing one turn to a row
#                         whose own journal said the work had not started (#310).
#
# So the release is now an affirmative DECLARATION -- its own call, naming what was examined --
# and writing a turn does not release anything. Arm M pins the second failure, arm I the first,
# and they pull in opposite directions, so neither can be satisfied by deleting the feature.
foreach ($id in 730, 710, 720) { [void](Invoke-Oa @('mark', '-Id', "$id", '-Status', 'in-progress')) }
$rowsM = Get-Rows

# M: writing is not finishing. Every Today row was just worked and is still `in-progress` with
# work left; the deployed script handed over the entire backlog at exactly this point.
Check 'M writing a turn does not release Deferred' {
  $t = @(730, 710, 720 | ForEach-Object { (Get-Row $rowsM "$_").holds_today_gate })
  $d = @(740, 760, 750 | ForEach-Object { (Get-Row $rowsM "$_").eligible })
  ($d -notcontains $null) -and ($t -notcontains $null) -and
  ($d -notcontains $true) -and ($t -notcontains $false)
}

# I: THE FIX. The Today rows are unchanged -- still `in-progress`, still workable, still
# unbounded -- and the ONLY thing that has happened is that the run has said, in its own call,
# what it examined. Pre-fix this is false in one direction (workability) or true for the wrong
# reason in the other (recency), which is why arm M has to sit next to it.
foreach ($id in 730, 710, 720) {
  Try-Oa @('mark', '-Id', "$id", '-Exhausted', "gh:197,gh:179,task:$id", '-ExhaustedNote', 'queue drained this run')
}
$rowsI = Get-Rows
Check 'I declared-exhausted Today releases Deferred' {
  $t = @(730, 710, 720 | ForEach-Object { (Get-Row $rowsI "$_").eligible })
  $d = @(740, 760, 750 | ForEach-Object { (Get-Row $rowsI "$_").eligible })
  $reasons = @(730, 710, 720 | ForEach-Object { "$((Get-Row $rowsI "$_").today_release_reason)" })
  ($d -notcontains $null) -and ($t -notcontains $null) -and
  ($d -notcontains $false) -and ($t -notcontains $false) -and
  (@($reasons | Where-Object { $_ -ne 'declared_exhausted' }).Count -eq 0)
}

# J: releasing exclusivity must NOT cost ordering. Without this arm the fix could degenerate
# into "ignore the board", which is a worse defect than the starvation it replaces: Today is
# still worked first, only its monopoly lapses. It also pins that the release lives in the GATE
# and not in Test-Workable -- a declared row that stopped being workable would drop off the
# worklist entirely, and the agent would abandon its own top-priority task.
Check 'J declared-exhausted Today still ranks first' {
  $t = @(730, 710, 720 | ForEach-Object { Ord $rowsI "$_" })
  $d = @(740, 760, 750 | ForEach-Object { Ord $rowsI "$_" })
  ($t -notcontains -1) -and ($d -notcontains -1) -and
  (($t | Measure-Object -Maximum).Maximum -lt ($d | Measure-Object -Minimum).Minimum)
}

# K: the escape hatch is real, not decorative. The strict flag must restore pre-#223-correction
# exclusivity EXACTLY, so this is revertible with a flag instead of a redeploy. Asserted through
# the LEGACY spelling `-TodayServedMinutes 0`, because that is what existing callers pass and it
# must keep meaning the same thing after the parameter's other meanings were removed.
$rowsK = Get-RowsWith @('-TodayServedMinutes', '0')
Check 'K served-minutes 0 restores exclusivity' {
  $d = @(740, 760, 750 | ForEach-Object { (Get-Row $rowsK "$_").eligible })
  ($d -notcontains $null) -and ($d -notcontains $true)
}

# L: a live reply RECLAIMS exclusivity, even with a declaration standing. This is the arm that
# keeps the fix from trading one silent failure for another: without it, a declaration made
# seconds earlier would mute a Today task the user had just replied to, and dropping the user's
# own input is strictly worse than making them wait.
$p730 = Join-Path $jdir 'task-730.md'
[IO.File]::WriteAllText($p730,
  ([IO.File]::ReadAllText($p730, $utf8) + "`n`n## 2026-08-31`n`n<!-- from: me -->`nactually do this one now`n"), $utf8)
$rowsL = Get-Rows
Check 'L reply reclaims Today exclusivity' {
  $r = Get-Row $rowsL '730'
  $d = @(740, 760, 750 | ForEach-Object { (Get-Row $rowsL "$_").eligible })
  $r.reopened -eq $true -and $r.holds_today_gate -eq $true -and
  ($d -notcontains $null) -and ($d -notcontains $true)
}
# ANSWERING a reply, which since #501 is the only thing that clears one.
#
# This used to be `mark -Id 730` on its own, described as "consume that reply". That is exactly
# the absorption #501 is about: a bare `mark` re-snapshots the journal, so `changed` goes false
# and the reply looks handled while the message is still sitting there unanswered. It is what
# erased three of Shiv's messages on task #245.
#
# `unanswered_user` is now read off the file's STRUCTURE rather than off the hash, so the only
# way to clear it is the way a real run clears it: write a turn BELOW the message, then mark.
# The arms below need the reply genuinely dealt with -- not merely hidden -- so they do that.
function Answer-Reply {
  param([string]$Id)
  $p = Join-Path $jdir "task-$Id.md"
  $turn = "`n`n## 2026-08-31 Overnight Agent`n`n<!-- from: overnight-agent -->`nPicked this up - noted and handled.`n"
  [IO.File]::WriteAllText($p, ([IO.File]::ReadAllText($p, $utf8) + $turn), $utf8)
  [void](Invoke-Oa @('mark', '-Id', $Id, '-Status', 'in-progress'))
}

# Answer that reply, so G and F below still see the board they were written against.
Answer-Reply '730'

# --- G: a live reply preempts board rank ----------------------------------------------
# Mark stamps the turn-end terminator; appending below it is the user speaking.
[void](Invoke-Oa @('mark', '-Id', '750', '-Status', 'in-progress'))
$p750 = Join-Path $jdir 'task-750.md'
$txt = [IO.File]::ReadAllText($p750, $utf8) + "`n`n## 2026-08-31`n`n<!-- from: me -->`nplease pick this up`n"
[IO.File]::WriteAllText($p750, $txt, $utf8)
$rowsG = Get-Rows
Check 'G reopened preempts' {
  $r = Get-Row $rowsG '750'
  (Ord $rowsG '750') -eq 1 -and $r.reopened -eq $true -and $r.eligible -eq $true
}

# --- F: once Today is TERMINAL the gate opens -----------------------------------------
# Pinned to `-TodayServedMinutes 0` ON PURPOSE. F's distinguishing claim is that a Today row
# which is genuinely FINISHED (or parked on the user) opens the gate without anyone having to
# declare anything. Arm I's declaration path opens it too, and the declarations made above are
# still standing -- so left unpinned, F would pass for the other mechanism's reason and stop
# killing its own mutant (a gate that never opens on exhaustion). The flag disables only the
# declaration and backstop paths, preserving F's original assertion in full.
[void](Invoke-Oa @('mark', '-Id', '730', '-Status', 'done'))
[void](Invoke-Oa @('mark', '-Id', '710', '-Status', 'blocked'))
[void](Invoke-Oa @('mark', '-Id', '720', '-Status', 'proposed'))
$rowsF = Get-RowsWith @('-TodayServedMinutes', '0')
Check 'F terminal Today opens gate' {
  (Get-Row $rowsF '740').eligible -eq $true -and (Get-Row $rowsF '760').eligible -eq $true
}

# --- report ---------------------------------------------------------------------------
$pass = 0; $fail = 0
foreach ($k in $results.Keys) {
  if ($results[$k]) { "  PASS  $k"; $pass++ } else { "  FAIL  $k"; $fail++ }
}
""
"$pass passed, $fail failed  (script: $ScriptPath)"

Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue

if ($ExpectPreFix) {
  # Against the PRE-FIX script these arms must fail. If they all pass, the change is a no-op
  # restatement of existing behaviour and is not load-bearing.
  if ($fail -eq 0) { "MUTCHECK FAILED: pre-fix script passed everything - the fix guards nothing."; exit 1 }
  "MUTCHECK OK: pre-fix script fails $fail arm(s), as required."
  exit 0
}

if ($fail -gt 0) { exit 1 }
exit 0
