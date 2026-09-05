<#
  mutcheck-agent-declared-done.ps1 -- the GH #501 regression, reproduced exactly.

  THE INCIDENT. On 2026-09-04 Shiv said, live:

      "245 is on my today list and it doesn't seem like it's getting picked up."

  He was right, and the reason was that THE AGENT HAD CLOSED HIS TASK. Planner task #245 was
  row 1 of `## Today` in planner.md. It was absent from planner-completed.md, so the user had
  never completed it. But the agent's own 2026-08-31 turn had marked it `done` ("Why I am
  marking this done"), and that self-declared status was read as though the USER had closed the
  task. Three consequences, all silent:

    1. THREE OF HIS MESSAGES BECAME INVISIBLE. Below the turn-end stamp, dated 2026-09-03 and
       each carrying `<!-- from: me -->`, sat: a request for the catch-up doc link; a new
       requirement (three phone lines, two transferred, one net new) plus a new Xfinity
       broadband-programme link; and a new question about bundling phone and internet. Not
       nudges -- new scope. The agent's newest turn predated all three.

    2. THE COMPENSATING CONTROL WAS DEFEATED. The design tolerates a missed nudge precisely
       because it "stays visible" as `reopened_closed: true` in the wrap-up. An `oa-state mark`
       re-snapshot landed 62 SECONDS after the messages were folded in (journal written
       11:32:20, mark 11:33:22), which set processed_file_hash to the FULL hash. From then on
       `changed` and `reopened_closed` were both false on every run. The nudge was not missed;
       it was gone. It stayed gone for over a day.

    3. IT RELEASED THE TODAY GATE. `done` gave `today_release_reason: not_workable`, so #245
       stopped holding Today-before-Deferred and the run dispatched Deferred task #362 at
       order 68 -- work Shiv did not want touched -- while a Today row holding three of his
       unanswered messages sat inert.

  The measured scan row, verbatim, before the fix:

      id 245  section today  status done
      changed: false  reopened: false  reopened_closed: false  awaiting_reply: false
      consent_reason: "human-spoke-but-no-affirmative"
      eligible: false  holds_today_gate: false  today_release_reason: "not_workable"

  `consent_reason` is the tell: the machinery COULD see that a human had spoken. Nothing acted
  on it.

  WHAT THIS FILE DOES. It rebuilds that exact situation from scratch -- agent-declared `done`,
  row present on planner.md `## Today` and absent from planner-completed.md, three
  `<!-- from: me -->` messages appended AFTER the turn-end stamp, and then a `mark` applied
  AFTER the fold so the re-snapshot absorbs them -- and asserts the task is OFFERED rather than
  silent. It then mutates each load-bearing line in turn and requires the silence to come back.

    powershell -File mutcheck-agent-declared-done.ps1 [-ScriptPath <path-to-oa-state.ps1>]

  Arms, and the distinct mutant each one kills:

    M1  authority  -> `Test-UserClosed` agrees with whatever the agent last said about itself.
                      The #501 defect verbatim: the row is suppressed as closed work again.
    M2  standing   -> the unanswered-message signal is one-shot again, so the re-snapshot at
                      T+62s erases it and every later run reads the row as quiet.
    M3  offer      -> the signal is reported but `Test-Workable` ignores it: the row is visible
                      in the JSON and still never handed to the run. Visible-but-unworkable is
                      how a Today row can sit inert for a day while looking healthy.
    M4  gate       -> the row stops holding Today-before-Deferred, which is what sent the run
                      to Deferred order 68. Reported, worked, and STILL leaking the backlog.
    M5  attribution-> the strict `<!-- from: me -->` requirement is dropped for the
                      fail-open reader, so a sibling skill's own turn would pin a row as an
                      unanswered user message forever. The over-correction arm.

  M3 and M4 are separate on purpose, and the reason is the same one recorded in
  mutcheck-reopened-closed.ps1: this rule lives at more than one call site and the sites fail
  DIFFERENTLY. A fix that only makes the row eligible still leaks the Deferred backlog; a fix
  that only holds the gate freezes it behind a row nobody is offered. Neither arm can see the
  other's hole.

  NOTE: no literal non-ASCII anywhere in this file. A BOM-less .ps1 is decoded as the ANSI
  codepage by Windows PowerShell 5.1, so a literal dash or emoji would be corrupted on the way
  in and an arm would fail for a reason that has nothing to do with the code under test.
#>
[CmdletBinding()]
param(
  [string]$ScriptPath,
  [switch]$KeepFixtures
)

$ErrorActionPreference = 'Stop'

if (-not $ScriptPath) { $ScriptPath = Join-Path $PSScriptRoot 'oa-state.ps1' }
if (-not (Test-Path $ScriptPath)) { throw "oa-state.ps1 not found at $ScriptPath" }

$script:pass = 0
$script:fail = 0
function Ok   { param([string]$n, [string]$m = '') $script:pass++; Write-Host ("  ok    {0} {1}" -f $n, $m) }
function Bad  { param([string]$n, [string]$m = '') $script:fail++; Write-Host ("  FAIL  {0} {1}" -f $n, $m) -ForegroundColor Red }
function Assert { param([bool]$c, [string]$n, [string]$m = '') if ($c) { Ok $n $m } else { Bad $n $m } }

# The journal as the agent left it on 2026-08-31: a turn that declares itself done.
$Journal = @'
# Task {ID}: Amy phone lines

Shiv's own notes at the top.

---
<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->

## Overnight Agent

**Status:** Done - plan v2 - 2026-08-31

<!-- from: overnight-agent -->

Why I am marking this done: the lines are ordered and nothing is outstanding.

### Run log
**2026-08-31 (overnight):**
- Placed the order.
- Next: complete.

**Needs from you:** none
'@

# The three messages, verbatim in shape: each its own `## <date>` entry, each stamped
# `<!-- from: me -->`, all appended BELOW the turn-end stamp that `mark` wrote.
$Messages = @'

## 2026-09-03

<!-- from: me -->
Give me link to catch up doc

## 2026-09-03

<!-- from: me -->
Amy needs 3 lines. 2 can be transferred from my account. 1 net new. They have
https://www.xfinity.com/support/articles/comcast-broadband-opportunity-program

## 2026-09-03

<!-- from: me -->
What are options on xfinity, since they can bundle phone and internet
'@

# A sibling skill's turn, for the over-correction arm. It is machine text with its own
# attribution, so it is NOT one of Shiv's unanswered messages and must never pin a row.
$SiblingTurn = @'

## 2026-09-03

<!-- from: dance-church -->
Ran the loop - nothing to change, quick status.
'@

# UNATTRIBUTED trailing prose: no provenance marker at all. This is the case that separates the
# two readers, and choosing between them is the one genuine judgement call in this fix.
#
#   Test-TrailingHasUser  (drives `reopened`)      FAILS OPEN -- unmarked text counts as Shiv.
#   Test-TrailingHasHuman (drives `unanswered_user`) FAILS CLOSED -- marked, or nothing.
#
# The opposite defaults are deliberate and the reason is the SHAPE of each signal, not caution:
# `reopened` is ONE-SHOT (armed by the hash moving, gone next run), so failing open costs a
# single look. `unanswered_user` is STANDING -- by design it does not clear until a turn is
# written below it -- so failing open on unattributed text would let an unstamped machine turn
# pin a row with no message in it for anyone to answer. #272 measured that exposure directly:
# 164 of 244 journals carry no provenance marker, and unstamped AGENT turns are the specific
# thing that made a human's marker own text the human never wrote.
#
# The choice was measured, not assumed. Running the live 244-journal corpus through BOTH readers
# on 2026-09-04 returned the SAME six rows, so strict attribution costs nothing real today and
# removes the pinning hazard entirely. Unmarked prose is still caught the run it lands (by
# `reopened`) and, when it is truly invisible, by checks/swallowed-message-sweep.mjs.
$UnmarkedProse = @'

## 2026-09-03

one more thing, can you also check the deductible
'@

$root = Join-Path ([IO.Path]::GetTempPath()) ("oa-adone-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
$utf8 = New-Object Text.UTF8Encoding($false)

# 245 = the victim, reproduced: agent-declared done, Today row 1, three messages, re-marked.
# 246 = the control: identical in every way EXCEPT that Shiv completed it in the app, so it is
#       on planner-completed.md. It must stay suppressed -- that is #170, and it must not
#       regress while #501 is being fixed.
# 247 = the over-correction control: same shape, but the trailing content is a SIBLING SKILL's
#       turn rather than Shiv's. There is no message to answer, so it must read quiet.
$Victim = '245'
$UserClosed = '246'
$Sibling = '247'
# 248 = the fail-open control: same shape again, but the trailing content carries NO attribution
#       at all. Strict-by-design, it must read quiet -- and M5 proves that is a choice rather
#       than an accident.
$Unmarked = '248'
$Subjects = @($Victim, $UserClosed, $Sibling, $Unmarked)

function New-Sandbox {
  param([string]$Name)
  $base = Join-Path $root $Name
  $jdir = Join-Path $base 'journal'
  $sdir = Join-Path $base 'state'
  New-Item -ItemType Directory -Path $jdir -Force | Out-Null
  New-Item -ItemType Directory -Path $sdir -Force | Out-Null
  $board = Join-Path $base 'planner.md'
  $done = Join-Path $base 'planner-completed.md'
  $store = Join-Path $base 'snooze.json'

  foreach ($id in $Subjects) {
    [IO.File]::WriteAllText((Join-Path $jdir "task-$id.md"), $Journal.Replace('{ID}', $id), $utf8)
  }
  # A Deferred row, so "the gate leaked" is observable rather than theoretical: this is the
  # stand-in for the real #362 the run went to instead of #245.
  [IO.File]::WriteAllText((Join-Path $jdir 'task-362.md'),
    ($Journal.Replace('{ID}', '362') -replace 'Done - plan v2 - 2026-08-31', 'In-progress - plan v1 - 2026-09-01'), $utf8)

  $sb = New-Object Text.StringBuilder
  [void]$sb.AppendLine('## Today')
  [void]$sb.AppendLine('')
  [void]$sb.AppendLine('| ID | U | Task | Work Priority | Added | Linked ID |')
  [void]$sb.AppendLine('|---|---|------|---------------|-------|-----------|')
  # Row 1 of Today, exactly where #245 sat.
  [void]$sb.AppendLine("| $Victim |  | Amy phone lines | - | 2026-08-20 |  |")
  [void]$sb.AppendLine("| $Sibling |  | sibling-touched row | - | 2026-08-20 |  |")
  [void]$sb.AppendLine("| $Unmarked |  | unattributed-prose row | - | 2026-08-20 |  |")
  [void]$sb.AppendLine('')
  [void]$sb.AppendLine('## Deferred')
  [void]$sb.AppendLine('')
  [void]$sb.AppendLine('| ID | U | Task | Work Priority | Added | Wake | Linked ID |')
  [void]$sb.AppendLine('| --- | --- | ------ | --------------- | ------- | ---- | ----------- |')
  [void]$sb.AppendLine('| 362 |  | deferred work | - | 2026-09-01 |  |  |')
  [IO.File]::WriteAllText($board, $sb.ToString(), $utf8)

  # The completed board. Only 246 is on it: Shiv closed that one himself.
  $cb = New-Object Text.StringBuilder
  [void]$cb.AppendLine('## Week of 2026-08-31')
  [void]$cb.AppendLine('')
  [void]$cb.AppendLine('| ID | U | Task | Work Priority | Completed | Linked ID |')
  [void]$cb.AppendLine('|---|---|------|---------------|-----------|-----------|')
  [void]$cb.AppendLine("| $UserClosed |  | closed in the app | - | 2026-08-31 |  |")
  [IO.File]::WriteAllText($done, $cb.ToString(), $utf8)
  [IO.File]::WriteAllText($store, '{}', $utf8)

  return [pscustomobject]@{ JDir = $jdir; SDir = $sdir; Board = $board; Done = $done; Store = $store }
}

function Invoke-Oa {
  param([string]$Subject, $Sx, [string[]]$OaArgs)
  return (& powershell -NoProfile -ExecutionPolicy Bypass -File $Subject @OaArgs `
    -JournalDir $Sx.JDir -StateDir $Sx.SDir -PlannerBoard $Sx.Board -PlannerCompleted $Sx.Done -SnoozeStore $Sx.Store 2>&1)
}

function Initialize-Sandbox {
  # THE SEQUENCE IS THE WHOLE FIXTURE, and it is the real one, in order:
  #
  #   1. the agent marks the task `done` (2026-08-31). This stamps the turn-end terminator.
  #   2. Shiv's messages are appended BELOW that stamp (2026-09-03 11:32:20).
  #   3. a `mark` runs 62 seconds later and re-snapshots the journal (11:33:22).
  #
  # Step 3 is what makes this a regression test rather than a restatement: without it the
  # journal is simply `changed`, the ordinary reopen path fires, and the bug is invisible.
  param([string]$Subject, $Sx)
  foreach ($id in $Subjects) {
    [void](Invoke-Oa $Subject $Sx @('mark', '-Id', $id, '-Status', 'done'))
  }
  [void](Invoke-Oa $Subject $Sx @('mark', '-Id', '362', '-Status', 'in-progress'))

  foreach ($id in @($Victim, $UserClosed)) {
    $p = Join-Path $Sx.JDir "task-$id.md"
    [IO.File]::WriteAllText($p, ([IO.File]::ReadAllText($p, $utf8) + $Messages), $utf8)
  }
  $ps = Join-Path $Sx.JDir "task-$Sibling.md"
  [IO.File]::WriteAllText($ps, ([IO.File]::ReadAllText($ps, $utf8) + $SiblingTurn), $utf8)
  $pu = Join-Path $Sx.JDir "task-$Unmarked.md"
  [IO.File]::WriteAllText($pu, ([IO.File]::ReadAllText($pu, $utf8) + $UnmarkedProse), $utf8)

  # ...and the re-mark that absorbed them.
  foreach ($id in $Subjects) {
    [void](Invoke-Oa $Subject $Sx @('mark', '-Id', $id, '-Status', 'done'))
  }

  # A STANDING EXHAUSTION DECLARATION on the victim, and it is not decoration.
  #
  # Without it this fixture cannot test the gate branch at all: `Get-TodayGateVerdict` holds by
  # DEFAULT for anything it is unsure about, so deleting the unanswered-message branch would
  # still leave the row holding (as `holding:no_declaration`) and the arm would pass while
  # guarding nothing. The branch only earns its place when something is actively trying to
  # RELEASE the gate -- and a declaration is the one thing that can.
  #
  # This is also the honest reading of the claim. "I examined everything Today holds" cannot be
  # true of a row carrying three questions nobody has answered, so the declaration must lose.
  [void](Invoke-Oa $Subject $Sx @('mark', '-Id', $Victim, '-Exhausted', 'gh:501,gh:245,board:today'))
}

function Get-Rows {
  param([string]$Subject, $Sx)
  $text = (Invoke-Oa $Subject $Sx @('scan') | Out-String)
  try { return ($text | ConvertFrom-Json) } catch { return @() }
}

function Get-Row { param($rows, [string]$id) return ($rows | Where-Object { "$($_.id)" -eq $id } | Select-Object -First 1) }

function New-Mutant {
  param([string]$Name, [string]$Find, [string]$Replace)
  $src = [IO.File]::ReadAllText($ScriptPath, $utf8)
  if ($src -notmatch [regex]::Escape($Find)) { throw "mutant $Name : anchor not found -> $Find" }
  $dst = Join-Path $root "mutant-$Name.ps1"
  New-Item -ItemType Directory -Path $root -Force | Out-Null
  [IO.File]::WriteAllText($dst, $src.Replace($Find, $Replace), $utf8)
  return $dst
}

Write-Host ''
Write-Host '[baseline] #245 reproduced: agent-declared done, Today row 1, 3 messages, re-marked after the fold'

$sx = New-Sandbox 'baseline'
Initialize-Sandbox $ScriptPath $sx
$rows = Get-Rows $ScriptPath $sx
$v = Get-Row $rows $Victim
$u = Get-Row $rows $UserClosed
$s = Get-Row $rows $Sibling
$n = Get-Row $rows $Unmarked
$d = Get-Row $rows '362'

# --- the situation is genuinely the one from the incident ---------------------------------
# Asserting the PRECONDITIONS matters as much as asserting the fix: if the re-mark stopped
# absorbing, this file would pass for the wrong reason and would stop guarding anything.
Assert ($v.status -eq 'done')            'P_STATUS'    'skill state says done'
Assert ($v.status_by -eq 'agent')        'P_BY'        'and the AGENT declared it, not Shiv'
Assert ($v.section -eq 'today')          'P_TODAY'     'the row is still in Today on planner.md'
Assert ($v.on_board -eq $true)           'P_ONBOARD'   'present on the live board'
Assert ($v.user_completed -eq $false)    'P_NOTDONE'   'and absent from planner-completed.md'
Assert ($v.changed -eq $false)           'P_ABSORBED'  'the re-mark absorbed the messages (changed is false)'
Assert ($v.reopened -eq $false)          'P_NOREOPEN'  'so the one-shot reopen signal is gone, exactly as measured live'
Assert ($v.consent_reason -eq 'human-spoke-but-no-affirmative') `
                                         'P_CONSENT'   'and the machinery can still see that a human spoke'

# --- the fix ------------------------------------------------------------------------------
Assert ($v.unanswered_user -eq $true)    'T_STANDING'  'the unanswered message survives the re-snapshot'
Assert ($v.reopened_closed -eq $false)   'T_NOT_CLOSED' 'an agent-declared done is NOT user-closed work'
Assert ($v.eligible -eq $true)           'T_OFFERED'   'so the run is OFFERED #245 instead of reading it quiet'
Assert ($v.holds_today_gate -eq $true)   'T_HOLDS'     'and it holds Today-before-Deferred'
Assert ($v.today_release_reason -eq 'holding:unanswered_user') `
                                         'T_REASON'    'with an auditable reason naming why'
Assert ($v.order -eq 1)                  'T_FIRST'     'and it sorts first, ahead of everything else'
Assert ($d.eligible -eq $false)          'T_NO_LEAK'   'the Deferred row is NOT dispatched while it holds'

# --- the two controls, which keep the fix from being an over-correction --------------------
Assert ($u.user_completed -eq $true)     'C_USER_DONE' 'the control really is on the completed board'
Assert ($u.eligible -eq $false)          'C_USER_SUPPRESSED' 'so a reply on work SHIV closed is still not worked (#170)'
Assert ($s.unanswered_user -eq $false)   'C_SIBLING'   "a sibling skill's own turn is not an unanswered user message"
Assert ($s.eligible -eq $false)          'C_SIBLING_QUIET' 'so it does not reanimate the row'
Assert ($n.unanswered_user -eq $false)   'C_UNMARKED'  'and neither is unattributed trailing prose (fails closed by design)'
Assert ($n.eligible -eq $false)          'C_UNMARKED_QUIET' 'so an unstamped machine turn can never pin a row'
Assert ($v.exhaustion -ne $null)         'C_DECLARED'  'the victim really does carry a standing exhaustion declaration'

Write-Host ''
Write-Host '[mutants] each must bring the silence back'

# M1 - AUTHORITY. Let the agent's own status decide, which is the shipped defect verbatim.
$m1 = New-Mutant 'M1' @'
  if ($row.user_completed) { return $true }
  if ("$($row.status_by)".ToLowerInvariant() -eq 'user') { return $true }
  if (-not $row.on_board) { return $true }
  return $false
'@ '  return $true
'
$sx1 = New-Sandbox 'm1'
Initialize-Sandbox $m1 $sx1
$v1 = Get-Row (Get-Rows $m1 $sx1) $Victim
Assert ($v1.eligible -ne $true) 'M1' 'the agent closing its own task silences #245 again'

# M2 - STANDING. Make the signal one-shot, so the re-snapshot at T+62s erases it. This is the
#      arm that proves the compensating control actually compensates.
$m2 = New-Mutant 'M2' '    unanswered_user    = [bool]$facts.HasTrailingHuman' '    unanswered_user    = $false'
$sx2 = New-Sandbox 'm2'
Initialize-Sandbox $m2 $sx2
$v2 = Get-Row (Get-Rows $m2 $sx2) $Victim
Assert ($v2.eligible -ne $true) 'M2' 'a one-shot signal is erased by the re-mark, as it was live'

# M3 - OFFER. Report it, then refuse to work it. The row is visible in the JSON and still never
#      reaches the run -- which is indistinguishable from the bug for the person waiting.
$m3 = New-Mutant 'M3' '  if (Test-UnansweredUser $row) { return $true }' '  if ($false) { return $true }'
$sx3 = New-Sandbox 'm3'
Initialize-Sandbox $m3 $sx3
$rows3 = Get-Rows $m3 $sx3
$v3 = Get-Row $rows3 $Victim
Assert ($v3.unanswered_user -eq $true) 'M3_REPORTED' 'the message is still reported...'
Assert ($v3.holds_today_gate -ne $true) 'M3' '...but the row stops holding the gate, so the backlog leaks again'

# M4 - GATE. Keep it eligible but stop the unanswered message beating the standing exhaustion
#      declaration. The run works #245 AND dispatches Deferred work in the same pass, which is
#      the third symptom returning on its own: eligibility alone does not fix it.
#
#      The declaration is what gives this arm teeth. Every branch of Get-TodayGateVerdict that
#      is unsure HOLDS, so with nothing trying to release the gate the mutant would look
#      identical to the fix. With a declaration standing, removing the branch hands it the
#      release -- and Deferred order 68 gets dispatched again.
$m4 = New-Mutant 'M4' @'
  if (Test-UnansweredUser $row) {
    return [pscustomobject]@{ holds = $true; reason = 'holding:unanswered_user' }
  }
'@ ''
$sx4 = New-Sandbox 'm4'
Initialize-Sandbox $m4 $sx4
$rows4 = Get-Rows $m4 $sx4
$v4 = Get-Row $rows4 $Victim
Assert ($v4.eligible -eq $true) 'M4_STILL_OFFERED' 'the row is still offered...'
Assert ($v4.today_release_reason -eq 'declared_exhausted') 'M4_RELEASED' '...but the declaration now releases the gate...'
Assert ((Get-Row $rows4 '362').eligible -ne $false) 'M4' '...so Deferred work is dispatched alongside it, as on 2026-09-04'

# M5 - OVER-CORRECTION. Drop the strict `<!-- from: me -->` requirement and reuse the fail-open
#      reopen reader instead. UNATTRIBUTED trailing prose then reads as an unanswered user
#      message -- and because this signal is STANDING rather than one-shot, an unstamped machine
#      turn would pin that row until someone wrote a turn under it.
#
#      Aimed at 248 (no marker), not at 247: `Test-TrailingHasUser` already rejects a MARKED
#      sibling turn, so the two readers only diverge on text nobody signed. Measured while
#      writing this arm -- pointing it at 247 passed against both readers and proved nothing.
$m5 = New-Mutant 'M5' '  return [bool]($consent.human_segments -gt 0)' '  return (Test-TrailingHasUser $trailing)'
$sx5 = New-Sandbox 'm5'
Initialize-Sandbox $m5 $sx5
$rows5 = Get-Rows $m5 $sx5
Assert ((Get-Row $rows5 $Unmarked).unanswered_user -ne $false) 'M5' 'a fail-open reader pins a row on text nobody signed'
Assert ((Get-Row $rows5 $Victim).eligible -eq $true) 'M5_NARROW' 'while the real victim is still offered, so the mutant is narrow'

Write-Host ''
Write-Host ("[mutcheck-agent-declared-done] {0} passed, {1} failed" -f $script:pass, $script:fail)

if (-not $KeepFixtures) { Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue }
if ($script:fail -gt 0) { exit 1 }
exit 0
