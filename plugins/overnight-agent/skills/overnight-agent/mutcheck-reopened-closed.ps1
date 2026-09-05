<#
  mutcheck-reopened-closed.ps1 -- mutation check for GH #170 cause 3 as narrowed by GH #501:
  a reply on a task the USER closed must be reported, never acted on -- and a `done` the AGENT
  declared about its own work is not that.

  THE ORIGINAL DEFECT (#170). `Test-Workable` opened with `if ($row.reopened) { return $true }`,
  one line ABOVE the status gate. So a reply arriving on a `done`/`skip` task jumped the gate
  that keeps finished work finished, and the run wrote a fresh turn into closed work -- which
  the Telegram bridge then mirrored, floating a settled task back to the top of the group.

  Measured on the live board 2026-08-22 (issue #170): task #385 (Levolor shades) was
  cancelled 2026-07-28 and sits on the completed board; a JULY journal entry was re-posted
  into its topic. 4 of 23 recently re-posted tasks were completed-board tasks -- ~17% of
  mirror traffic going into tasks nobody had reopened.

  THE SECOND DEFECT (#501), and why this file changed. The fix above was keyed to the STATUS,
  not to WHO SET IT, so it treated the agent's own `done` as though the user had closed the
  task. SKILL.md says the opposite -- "Completion is the USER's action in the Focus Planner
  app... leave the board row untouched" -- so the agent is explicitly not the authority, yet its
  own claim was what switched the protection on.

  Measured live 2026-09-04: task #245 was row 1 of `## Today`, ABSENT from planner-completed.md,
  self-declared `done` by the agent on 2026-08-31. Three of Shiv's messages -- new requirements,
  a new link, a new question -- sat unanswered under the turn-end stamp for over a day, reading
  `reopened: false, reopened_closed: false, eligible: false`, and the released Today gate sent
  the run to Deferred row 68 instead. Shiv, live: "245 is on my today list and it doesn't seem
  like it's getting picked up."

  So the fixtures now model the BOARD, which is where the authority actually lives:
  user-closed tasks sit on planner-completed.md, and an agent-declared `done` stays on
  planner.md where the user left it.

  THE THREE WAYS TO GET THIS WRONG, which is why there are arms in every direction:

    - Too narrow: keep reanimating user-closed work (the #170 defect).
    - Too broad:  swallow the reply. Suppressing the WORK is the fix; suppressing the
                  MESSAGE would trade a loud failure for a silent one, and `proposed` /
                  `blocked` tasks -- which are *waiting on the user* -- must still reopen
                  normally or the run stops answering the questions it asked.
    - Wrong authority: let the AGENT close a task on the user's behalf (the #501 defect).
                  This is the worst of the three, because the agent can reach it unilaterally
                  and the result is indistinguishable from a quiet board.

  Builds a synthetic board + completed board + journal folder, runs the REAL oa-state.ps1
  against it with an isolated -JournalDir / -StateDir / -PlannerBoard / -PlannerCompleted /
  -SnoozeStore, and asserts the verdict.

    powershell -File mutcheck-reopened-closed.ps1 [-ScriptPath <path-to-oa-state.ps1>]

  Arms, and the distinct mutant each one kills:

    A  a reply on a USER-completed `done` task is    (kills: the #170 defect -- `reopened`
       NOT workable                                   returning workable above the status gate)
    B  ...and on a user-completed `skip` task too    (kills: a fix that special-cases only
                                                      `done`, leaving `skip` live)
    C  it is REPORTED, not swallowed                 (kills: suppressing the work without
                                                      emitting `reopened_closed`, so the message
                                                      vanishes -- a silent failure for a loud one)
    D  a reply on an ACTIVE task still works         (kills: over-correcting into "a reply never
                                                      reopens anything")
    E  a reply on a `proposed` task still works      (kills: treating waiting-on-the-user as
                                                      closed -- the run would stop answering the
                                                      very questions it asked)
    F  a user-closed reply does not HOLD the Today   (kills: an ineligible row still monopolising
       gate                                           the gate, freezing the Deferred backlog)
    G  a reply on an AGENT-declared `done` that is   (kills: #501 -- suppression keyed to skill
       still on planner.md REOPENS normally           status rather than to user completion)
    H  ...but an explicit USER `skip` on a board     (kills: over-correcting into "only the
       row is still suppressed                        completed board counts", which would ignore
                                                      the user saying so in the journal)

  THE RULE LIVES AT TWO CALL SITES, AND THEY FAIL DIFFERENTLY. `Test-Workable` and the
  eligibility pass each carried their own "a reply always wins" shortcut, so patching one left
  the other intact -- measured while writing this file: the gate verdict read `not_workable`
  while `eligible` still came back `true`. Hence M5 and M6, one per site:

    M5 (eligibility only)  -> the row is handed to the run anyway. Closed work gets a turn.
    M6 (Test-Workable only)-> the row is not worked, but becomes WORKABLE, and a workable Today
                              row holds the Today-before-Deferred gate. The backlog freezes
                              behind a task nobody may ever touch.

  A single arm would have found neither, because each site is covered by the other.

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

# Launch the host that actually EXISTS here. `powershell` is Windows-only, so hardcoding it makes
# the guard die on the Linux runner with "The term 'powershell' is not recognized". This file
# never ran in CI until #501 wired it in, which is why it still had the Windows-only spelling.
# Same idiom as mutcheck-cadence-rearm.ps1: under Core, re-launch the very executable running
# this script; under 5.1, `powershell`.
$script:PsExe = if ($PSVersionTable.PSEdition -eq 'Core') { (Get-Process -Id $PID).Path } else { 'powershell' }
if (-not $script:PsExe) { $script:PsExe = 'pwsh' }

$script:pass = 0
$script:fail = 0
function Ok   { param([string]$n, [string]$m = '') $script:pass++; Write-Host ("  ok    {0} {1}" -f $n, $m) }
function Bad  { param([string]$n, [string]$m = '') $script:fail++; Write-Host ("  FAIL  {0} {1}" -f $n, $m) -ForegroundColor Red }
function Assert { param([bool]$c, [string]$n, [string]$m = '') if ($c) { Ok $n $m } else { Bad $n $m } }

$Journal = @'
# Task {ID}: synthetic

User notes at the top.

---
<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->

## Overnight Agent

**Status:** {STATUS}

<!-- from: overnight-agent -->
The agent's last turn.

### Run log
**2026-08-30 (overnight):**
- did a thing

**Needs from you:** none
'@

$root = Join-Path ([IO.Path]::GetTempPath()) ("oa-reclosed-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
$utf8 = New-Object Text.UTF8Encoding($false)

# The subjects, and WHERE EACH ONE SITS ON THE BOARD -- which is the whole point since #501.
#
# 910 = done, on the COMPLETED board          -> user-closed: reported, never worked
# 911 = skip, on the COMPLETED board          -> same, via the other closed status
# 912 = in-progress, on planner.md            -> must stay workable (live conversation)
# 913 = proposed, on planner.md               -> must stay workable (the reply IS the answer)
# 914 = done DECLARED BY THE AGENT, still on  -> #501: must reopen NORMALLY. The agent is not
#       planner.md Today                         the authority on completion.
# 915 = skip declared BY THE USER, still on   -> user-closed even though it is on the live
#       planner.md Today                         board, because he said so and it was recorded
# 916 = proposed, on NEITHER board            -> still waiting on the user, so a reply is the
#                                                answer it wants. This is where widening the
#                                                closed-status list actually bites (see M3).
$Ids = @{ '910' = 'done'; '911' = 'skip'; '912' = 'in-progress'; '913' = 'proposed'; '914' = 'done'; '915' = 'skip'; '916' = 'proposed' }
# Which subjects the USER closed, and how that is evidenced. Everything else is agent-declared.
$OnCompletedBoard = @('910', '911')
$UserDeclared = @('915')
# Off BOTH boards: no live row, no completed row. A closed status here is treated as user-closed
# (the row is not open work any more); a waiting status here must still reopen.
$OffBoard = @('916')

function New-Sandbox {
  # A fresh sandbox per subject, so a mutant can never read state a previous run wrote.
  param([string]$Name)
  $base = Join-Path $root $Name
  $jdir = Join-Path $base 'journal'
  $sdir = Join-Path $base 'state'
  New-Item -ItemType Directory -Path $jdir -Force | Out-Null
  New-Item -ItemType Directory -Path $sdir -Force | Out-Null
  $board = Join-Path $base 'planner.md'
  $doneBoard = Join-Path $base 'planner-completed.md'
  $store = Join-Path $base 'snooze.json'

  foreach ($id in $Ids.Keys) {
    [IO.File]::WriteAllText((Join-Path $jdir "task-$id.md"),
      $Journal.Replace('{ID}', $id).Replace('{STATUS}', $Ids[$id]), $utf8)
  }

  # The LIVE board carries only what the user has not closed. A task he completes in the app
  # LEAVES planner.md and appears on planner-completed.md -- modelling that is what makes the
  # #501 distinction testable at all, because before this the two were indistinguishable.
  $sb = New-Object Text.StringBuilder
  [void]$sb.AppendLine('## Today')
  [void]$sb.AppendLine('')
  [void]$sb.AppendLine('| ID | U | Task | Work Priority | Added | Linked ID |')
  [void]$sb.AppendLine('|---|---|------|---------------|-------|-----------|')
  foreach ($id in ($Ids.Keys | Sort-Object)) {
    if ($OnCompletedBoard -contains $id) { continue }
    if ($OffBoard -contains $id) { continue }
    [void]$sb.AppendLine("| $id |  | today $id | - | 2026-09-01 |  |")
  }
  [void]$sb.AppendLine('')
  [void]$sb.AppendLine('## Deferred')
  [void]$sb.AppendLine('')
  [void]$sb.AppendLine('| ID | U | Task | Work Priority | Added | Wake | Linked ID |')
  [void]$sb.AppendLine('| --- | --- | ------ | --------------- | ------- | ---- | ----------- |')
  [void]$sb.AppendLine('| 920 |  | deferred work | - | 2026-09-01 |  |  |')
  [IO.File]::WriteAllText((Join-Path $jdir 'task-920.md'),
    $Journal.Replace('{ID}', '920').Replace('{STATUS}', 'in-progress'), $utf8)
  [IO.File]::WriteAllText($board, $sb.ToString(), $utf8)

  $cb = New-Object Text.StringBuilder
  [void]$cb.AppendLine('## Week of 2026-09-01')
  [void]$cb.AppendLine('')
  [void]$cb.AppendLine('| ID | U | Task | Work Priority | Completed | Linked ID |')
  [void]$cb.AppendLine('|---|---|------|---------------|-----------|-----------|')
  foreach ($id in $OnCompletedBoard) {
    [void]$cb.AppendLine("| $id |  | closed by me $id | - | 2026-09-01 |  |")
  }
  [IO.File]::WriteAllText($doneBoard, $cb.ToString(), $utf8)
  [IO.File]::WriteAllText($store, '{}', $utf8)

  return [pscustomobject]@{ Base = $base; JDir = $jdir; SDir = $sdir; Board = $board; Done = $doneBoard; Store = $store }
}

function Invoke-Oa {
  param([string]$Subject, $Sx, [string[]]$OaArgs)
  return (& $script:PsExe -NoProfile -ExecutionPolicy Bypass -File $Subject @OaArgs `
    -JournalDir $Sx.JDir -StateDir $Sx.SDir -PlannerBoard $Sx.Board -PlannerCompleted $Sx.Done -SnoozeStore $Sx.Store 2>&1)
}

function Initialize-Sandbox {
  # Mark every task with its status (which snapshots the journal and stamps the turn-end
  # boundary), THEN append the user's reply below that boundary. The reply must land after the
  # mark or it is not a reply at all -- it is just part of the agent's own turn, which is the
  # #272 attribution hazard and would make every arm here meaningless.
  param([string]$Subject, $Sx)
  foreach ($id in ($Ids.Keys | Sort-Object)) {
    $markArgs = @('mark', '-Id', "$id", '-Status', $Ids[$id])
    # 915 is the user's own decision, relayed by the run. Everything else is the agent talking
    # about its own work, which is what an unset -StatusBy records.
    if ($UserDeclared -contains $id) { $markArgs += @('-StatusBy', 'user') }
    [void](Invoke-Oa $Subject $Sx $markArgs)
  }
  [void](Invoke-Oa $Subject $Sx @('mark', '-Id', '920', '-Status', 'in-progress'))
  foreach ($id in ($Ids.Keys | Sort-Object)) {
    $p = Join-Path $Sx.JDir "task-$id.md"
    $t = [IO.File]::ReadAllText($p, $utf8) + "`n`n## 2026-09-02`n`n<!-- from: me -->`nthanks, one more thought on this`n"
    [IO.File]::WriteAllText($p, $t, $utf8)
  }
}

function Get-Rows {
  param([string]$Subject, $Sx, [string[]]$Extra = @())
  $text = (Invoke-Oa $Subject $Sx (@('scan') + $Extra) | Out-String)
  try { return ($text | ConvertFrom-Json) } catch { return @() }
}

function Get-Row {
  param($rows, [string]$id)
  return ($rows | Where-Object { "$($_.id)" -eq $id } | Select-Object -First 1)
}

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
Write-Host '[baseline] the rule as shipped'

$sx = New-Sandbox 'baseline'
Initialize-Sandbox $ScriptPath $sx
$rows = Get-Rows $ScriptPath $sx

$r910 = Get-Row $rows '910'
$r911 = Get-Row $rows '911'
$r912 = Get-Row $rows '912'
$r913 = Get-Row $rows '913'
$r914 = Get-Row $rows '914'
$r915 = Get-Row $rows '915'
$r916 = Get-Row $rows '916'

Assert ($r910.reopened -eq $true)          'T_SEEN'          'the reply on a user-completed task is still DETECTED as a reply'
Assert ($r910.reopened_closed -eq $true)   'T_CLOSED_FLAG'   'and is flagged as landing on closed work'
Assert ($r910.eligible -eq $false)         'T_CLOSED_INELIG' 'so the run is never offered it'
Assert ($r911.reopened_closed -eq $true)   'T_SKIP_FLAG'     'skip is closed too, not just done'
Assert ($r911.eligible -eq $false)         'T_SKIP_INELIG'   'and is equally ineligible'
Assert ($r912.reopened -eq $true -and $r912.reopened_closed -eq $false -and $r912.eligible -eq $true) `
                                           'T_ACTIVE'        'a reply on an ACTIVE task still reopens it normally'
Assert ($r913.reopened_closed -eq $false -and $r913.eligible -eq $true) `
                                           'T_PROPOSED'      'and on a proposed task, where the reply is the awaited answer'
Assert ($r916.reopened_closed -eq $false -and $r916.eligible -eq $true) `
                                           'T_PROPOSED_OFFBOARD' 'a proposed row off the board is still waiting on the user, not closed'

# The gate half. A row nobody may touch must not hold Today-before-Deferred shut: that would
# freeze the whole backlog behind work that is, by construction, unworkable forever. (910 is off
# the live board entirely, so it has no Today verdict at all -- which is the strongest form of
# "does not hold the gate". 911 is the same.)
Assert ($null -eq $r910.today_release_reason) 'T_NO_GATE' 'a user-completed reply is off the board and cannot hold the Today gate'

# --- #501: the AGENT is not the authority on completion ----------------------------------
# 914 is `done`, but the agent said so and the row is still sitting on planner.md where the user
# left it. That is a claim about the agent's own work, not a completion, so a reply must reopen
# it exactly as it would on any other open row.
Assert ($r914.status -eq 'done')             'T_AGENT_STATUS' 'the subject really is done in skill state'
Assert ($r914.on_board -eq $true)            'T_AGENT_ONBOARD' 'and is still on planner.md, where the user left it'
Assert ($r914.user_completed -eq $false)     'T_AGENT_NOTDONE' 'and the user has NOT completed it'
Assert ($r914.status_by -eq 'agent')         'T_AGENT_BY'     'and the state records who declared it'
Assert ($r914.reopened_closed -eq $false)    'T_AGENT_NOTSUPPRESSED' 'so the reply is NOT suppressed as closed work'
Assert ($r914.eligible -eq $true)            'T_AGENT_ELIGIBLE' 'and the run is offered the task (#501)'

# ...and the mirror. An explicit USER `skip` on a row still on the live board IS a closure, even
# though the row never reached planner-completed.md. Without this the fix would only honour the
# board and would ignore him saying so directly.
Assert ($r915.status_by -eq 'user')          'T_USER_BY'      'an explicit user decision is recorded as the user'
Assert ($r915.reopened_closed -eq $true)     'T_USER_FLAG'    'and confers closed semantics on a live board row'
Assert ($r915.eligible -eq $false)           'T_USER_INELIG'  'so it is reported and not worked'

Write-Host ''
Write-Host '[mutants] each must FLIP the case it protects'

# M1 - break the SHARED predicate, which is the only mutation that restores the defect
#      everywhere at once. Both readers below depend on it, so this is the core kill.
$m1 = New-Mutant 'M1' '  return [bool]($row.reopened -and (Test-UserClosed $row))' '  return $false'
$sx1 = New-Sandbox 'm1'
Initialize-Sandbox $m1 $sx1
$rows1 = Get-Rows $m1 $sx1
Assert ((Get-Row $rows1 '910').eligible -ne $false) 'M1' 'without the closed check, a reply on a completed task is worked again'

# The two CALL SITES are load-bearing for DIFFERENT consequences, so each needs its own arm.
# Removing either one alone leaves a hole, and the holes are not the same shape -- which is
# exactly why the fix needed both, and why one arm could not have found that out. (Measured
# while writing this: fixing only `Test-Workable` left the gate verdict reading `not_workable`
# while `eligible` still came back `true`. One reader said no and the other said yes.)

# M5 - remove only the check in the ELIGIBILITY pass. `Test-Workable` still refuses, but the
#      `reopened` shortcut sits ABOVE it and hands the row to the run anyway.
$m5 = New-Mutant 'M5' '      if (Test-ReopenedClosed $r) { $eligible = $false }' '      if ($false) { $eligible = $false }'
$sx5 = New-Sandbox 'm5'
Initialize-Sandbox $m5 $sx5
$rows5 = Get-Rows $m5 $sx5
Assert ((Get-Row $rows5 '910').eligible -ne $false) 'M5' 'the eligibility shortcut re-offers closed work on its own'

# M6 - remove only the check in `Test-Workable`. The row stays ineligible (M5's guard holds it),
#      so nothing is worked -- but it becomes WORKABLE, and a workable Today row HOLDS the
#      Today-before-Deferred gate. The whole Deferred backlog would then be frozen behind a task
#      nobody is permitted to touch: unworkable forever, and blocking forever.
$m6 = New-Mutant 'M6' '  if (Test-ReopenedClosed $row) { return $false }' '  if ($false) { return $false }'
$sx6 = New-Sandbox 'm6'
Initialize-Sandbox $m6 $sx6
$rows6 = Get-Rows $m6 $sx6
Assert ((Get-Row $rows6 '910').today_release_reason -ne 'not_workable') 'M6' 'without it a closed reply becomes workable and freezes the backlog'
Assert ((Get-Row $rows6 '910').eligible -eq $false) 'M6_STILL_INELIG' 'while the other call site still keeps it out of the run'

# M2 - the half-fix: protect `done` and forget `skip`. Both are closed; a fix that names one is
#      a fix with a hole in it, and the hole is invisible because the `done` case passes.
$m2 = New-Mutant 'M2' "`$script:ClosedStatus = @('done', 'skip')" "`$script:ClosedStatus = @('done')"
$sx2 = New-Sandbox 'm2'
Initialize-Sandbox $m2 $sx2
$rows2 = Get-Rows $m2 $sx2
Assert ((Get-Row $rows2 '911').eligible -ne $false) 'M2' 'naming only done leaves skip reanimatable'
Assert ((Get-Row $rows2 '910').eligible -eq $false) 'M2_NARROW' 'while done itself still holds (so the mutant is narrow)'

# M3 - THE OVER-CORRECTION, and the one that matters most. Treat the waiting-on-the-user states
#      as closed too. The run would stop answering the questions it asked, which is a silent
#      failure that looks like a quiet board.
#
#      Aimed at 916 -- `proposed`, off both boards -- because that is where the widening now
#      bites. Since #501 a closed STATUS is only a precondition: an on-board row is still open
#      work whatever the status says, so 913 would survive this mutant and prove nothing. The
#      arm had to move with the rule it guards, or it would have quietly stopped testing.
$m3 = New-Mutant 'M3' "`$script:ClosedStatus = @('done', 'skip')" "`$script:ClosedStatus = @('done', 'skip', 'proposed', 'blocked')"
$sx3 = New-Sandbox 'm3'
Initialize-Sandbox $m3 $sx3
$rows3 = Get-Rows $m3 $sx3
Assert ((Get-Row $rows3 '916').eligible -ne $true) 'M3' 'widening closed to proposed strands the answer the run was waiting for'
Assert ((Get-Row $rows3 '912').eligible -eq $true) 'M3_NARROW' 'while an in-progress row is untouched, so the mutant is narrow'

# M4 - suppress the work AND the message. This is the arm that keeps the fix honest: the whole
#      justification for not reanimating closed work is that the nudge STAYS VISIBLE. Drop the
#      report and that justification is gone -- a loud failure has become a silent one.
$m4 = New-Mutant 'M4' '      -NotePropertyValue ([bool](Test-ReopenedClosed $r)) -Force' '      -NotePropertyValue $false -Force'
$sx4 = New-Sandbox 'm4'
Initialize-Sandbox $m4 $sx4
$rows4 = Get-Rows $m4 $sx4
Assert ((Get-Row $rows4 '910').reopened_closed -ne $true) 'M4' 'without the report the message is swallowed entirely'
Assert ((Get-Row $rows4 '910').eligible -eq $false) 'M4_STILL_SUPPRESSED' 'and the work is still suppressed, so the loss is silent'

# M7 - THE #501 ARM. Key the suppression to the skill's STATUS instead of to user completion,
#      which is exactly the shipped defect: `Test-UserClosed` stops consulting the board and
#      simply agrees with whatever the agent last wrote about itself. Task 914 -- `done` by the
#      agent, still sitting on planner.md Today with a reply under it -- goes silent again.
#
#      This is the arm the issue asks for by name, and it is the one that would have caught #245
#      before it cost Shiv three messages and a day of a Today row reading quiet.
$m7 = New-Mutant 'M7' @'
  if ($row.user_completed) { return $true }
  if ("$($row.status_by)".ToLowerInvariant() -eq 'user') { return $true }
  if (-not $row.on_board) { return $true }
  return $false
'@ '  return $true
'
$sx7 = New-Sandbox 'm7'
Initialize-Sandbox $m7 $sx7
$rows7 = Get-Rows $m7 $sx7
Assert ((Get-Row $rows7 '914').eligible -ne $true) 'M7' 'keying suppression to skill status silences an agent-declared done (#501)'
Assert ((Get-Row $rows7 '912').eligible -eq $true) 'M7_NARROW' 'while an in-progress row is untouched, so the mutant is narrow'

# M8 - drop the STANDING signal and keep only the one-shot `reopened`. The row is still not
#      suppressed (M7 covers that), but the message is only visible on the single run the
#      journal's hash moved -- and #245 proves a `mark` 62 seconds later closes that window
#      for good. This arm is what makes the fix survive a re-snapshot rather than merely
#      survive the first scan after the reply.
$m8 = New-Mutant 'M8' '    unanswered_user    = [bool]$facts.HasTrailingHuman' '    unanswered_user    = $false'
$sx8 = New-Sandbox 'm8'
Initialize-Sandbox $m8 $sx8
# Re-mark 914 AFTER the reply landed: this is the #245 sequence exactly, and it is what erases
# `changed`/`reopened` on the real board.
[void](Invoke-Oa $m8 $sx8 @('mark', '-Id', '914', '-Status', 'done'))
$rows8 = Get-Rows $m8 $sx8
Assert ((Get-Row $rows8 '914').eligible -ne $true) 'M8' 'without the standing signal a re-mark erases the reply again'

# ...and the same sequence against the REAL script must keep the task visible. Without this the
# arm above only proves the mutant is different, not that the shipped code is right.
$sx8b = New-Sandbox 'm8-baseline'
Initialize-Sandbox $ScriptPath $sx8b
[void](Invoke-Oa $ScriptPath $sx8b @('mark', '-Id', '914', '-Status', 'done'))
$rows8b = Get-Rows $ScriptPath $sx8b
$r914b = Get-Row $rows8b '914'
Assert ($r914b.changed -eq $false)         'T_REMARK_ABSORBED' 'the re-mark really did absorb the reply (changed is false)'
Assert ($r914b.reopened -eq $false)        'T_REMARK_NOREOPEN' 'so the one-shot reopen signal is genuinely gone'
Assert ($r914b.unanswered_user -eq $true)  'T_REMARK_STANDING' 'but the standing signal survives the re-snapshot'
Assert ([bool]$r914b.unanswered_user_at)   'T_REMARK_STAMPED'  'and mark stamped WHEN it was first seen unanswered'
Assert ($r914b.eligible -eq $true)         'T_REMARK_ELIGIBLE' 'so the task is still offered rather than silent (#501)'

Write-Host ''
Write-Host ("[mutcheck-reopened-closed] {0} passed, {1} failed" -f $script:pass, $script:fail)

if (-not $KeepFixtures) { Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue }
if ($script:fail -gt 0) { exit 1 }
exit 0
