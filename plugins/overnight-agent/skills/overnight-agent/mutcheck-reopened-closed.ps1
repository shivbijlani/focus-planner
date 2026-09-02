<#
  mutcheck-reopened-closed.ps1 -- mutation check for GH #170 cause 3: a reply on a task the
  user CLOSED must be reported, never acted on.

  THE DEFECT. `Test-Workable` opened with `if ($row.reopened) { return $true }`, one line
  ABOVE the status gate. So a reply arriving on a `done`/`skip` task jumped the gate that
  keeps finished work finished, and the run wrote a fresh turn into closed work -- which the
  Telegram bridge then mirrored, floating a settled task back to the top of the group.

  Measured on the live board 2026-08-22 (issue #170): task #385 (Levolor shades) was
  cancelled 2026-07-28 and sits on the completed board; a JULY journal entry was re-posted
  into its topic. 4 of 23 recently re-posted tasks were completed-board tasks -- ~17% of
  mirror traffic going into tasks nobody had reopened. Shiv, on task #400: "I don't think we
  need to handle the case where a reply on a closed task is considered [a reopen]".

  THE TWO WAYS TO GET THIS WRONG, which is why there are arms in both directions:

    - Too narrow: keep reanimating closed work (the shipped defect).
    - Too broad:  swallow the reply. Suppressing the WORK is the fix; suppressing the
                  MESSAGE would trade a loud failure for a silent one, and `proposed` /
                  `blocked` tasks -- which are *waiting on the user* -- must still reopen
                  normally or the run stops answering the questions it asked.

  Builds a synthetic board + journal folder, runs the REAL oa-state.ps1 against it with an
  isolated -JournalDir / -StateDir / -PlannerBoard / -SnoozeStore, and asserts the verdict.

    powershell -File mutcheck-reopened-closed.ps1 [-ScriptPath <path-to-oa-state.ps1>]

  Arms, and the distinct mutant each one kills:

    A  a reply on a `done` task is NOT workable   (kills: the shipped defect -- `reopened`
                                                   returning workable above the status gate)
    B  ...and on a `skip` task too                (kills: a fix that special-cases only `done`,
                                                   leaving the other closed status live)
    C  it is REPORTED, not swallowed              (kills: suppressing the work without emitting
                                                   `reopened_closed`, so the message vanishes --
                                                   a silent failure replacing a loud one)
    D  a reply on an ACTIVE task still works      (kills: over-correcting into "a reply never
                                                   reopens anything", which stops live
                                                   conversation dead)
    E  a reply on a `proposed` task still works   (kills: treating waiting-on-the-user as
                                                   closed -- the run would stop answering the
                                                   very questions it asked)
    F  a closed reply does not HOLD the Today     (kills: an ineligible row still monopolising
       gate                                        the gate, freezing the Deferred backlog
                                                   behind work nobody may touch)

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

# 910 = done, then a reply         -> must be reported and NOT worked
# 911 = skip, then a reply         -> same, via the other closed status
# 912 = in-progress, then a reply  -> must stay workable (live conversation)
# 913 = proposed, then a reply     -> must stay workable (the reply IS the awaited answer)
$Ids = @{ '910' = 'done'; '911' = 'skip'; '912' = 'in-progress'; '913' = 'proposed' }

function New-Sandbox {
  # A fresh sandbox per subject, so a mutant can never read state a previous run wrote.
  param([string]$Name)
  $base = Join-Path $root $Name
  $jdir = Join-Path $base 'journal'
  $sdir = Join-Path $base 'state'
  New-Item -ItemType Directory -Path $jdir -Force | Out-Null
  New-Item -ItemType Directory -Path $sdir -Force | Out-Null
  $board = Join-Path $base 'planner.md'
  $store = Join-Path $base 'snooze.json'

  foreach ($id in $Ids.Keys) {
    [IO.File]::WriteAllText((Join-Path $jdir "task-$id.md"),
      $Journal.Replace('{ID}', $id).Replace('{STATUS}', $Ids[$id]), $utf8)
  }

  $sb = New-Object Text.StringBuilder
  [void]$sb.AppendLine('## Today')
  [void]$sb.AppendLine('')
  [void]$sb.AppendLine('| ID | U | Task | Work Priority | Added | Linked ID |')
  [void]$sb.AppendLine('|---|---|------|---------------|-------|-----------|')
  foreach ($id in ($Ids.Keys | Sort-Object)) {
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
  [IO.File]::WriteAllText($store, '{}', $utf8)

  return [pscustomobject]@{ Base = $base; JDir = $jdir; SDir = $sdir; Board = $board; Store = $store }
}

function Invoke-Oa {
  param([string]$Subject, $Sx, [string[]]$OaArgs)
  return (& powershell -NoProfile -ExecutionPolicy Bypass -File $Subject @OaArgs `
    -JournalDir $Sx.JDir -StateDir $Sx.SDir -PlannerBoard $Sx.Board -SnoozeStore $Sx.Store 2>&1)
}

function Initialize-Sandbox {
  # Mark every task with its status (which snapshots the journal and stamps the turn-end
  # boundary), THEN append the user's reply below that boundary. The reply must land after the
  # mark or it is not a reply at all -- it is just part of the agent's own turn, which is the
  # #272 attribution hazard and would make every arm here meaningless.
  param([string]$Subject, $Sx)
  foreach ($id in ($Ids.Keys | Sort-Object)) {
    [void](Invoke-Oa $Subject $Sx @('mark', '-Id', "$id", '-Status', $Ids[$id]))
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

Assert ($r910.reopened -eq $true)          'T_SEEN'          'the reply on a done task is still DETECTED as a reply'
Assert ($r910.reopened_closed -eq $true)   'T_CLOSED_FLAG'   'and is flagged as landing on closed work'
Assert ($r910.eligible -eq $false)         'T_CLOSED_INELIG' 'so the run is never offered it'
Assert ($r911.reopened_closed -eq $true)   'T_SKIP_FLAG'     'skip is closed too, not just done'
Assert ($r911.eligible -eq $false)         'T_SKIP_INELIG'   'and is equally ineligible'
Assert ($r912.reopened -eq $true -and $r912.reopened_closed -eq $false -and $r912.eligible -eq $true) `
                                           'T_ACTIVE'        'a reply on an ACTIVE task still reopens it normally'
Assert ($r913.reopened_closed -eq $false -and $r913.eligible -eq $true) `
                                           'T_PROPOSED'      'and on a proposed task, where the reply is the awaited answer'

# The gate half. A row nobody may touch must not hold Today-before-Deferred shut: that would
# freeze the whole backlog behind work that is, by construction, unworkable forever.
Assert ($r910.today_release_reason -eq 'not_workable') 'T_NO_GATE' 'a closed reply does not hold the Today gate'

Write-Host ''
Write-Host '[mutants] each must FLIP the case it protects'

# M1 - break the SHARED predicate, which is the only mutation that restores the defect
#      everywhere at once. Both readers below depend on it, so this is the core kill.
$m1 = New-Mutant 'M1' '  return [bool]($row.reopened -and ($script:ClosedStatus -contains "$($row.status)"))' '  return $false'
$sx1 = New-Sandbox 'm1'
Initialize-Sandbox $m1 $sx1
$rows1 = Get-Rows $m1 $sx1
Assert ((Get-Row $rows1 '910').eligible -ne $false) 'M1' 'without the closed check, a reply on a done task is worked again'

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

# M3 - THE OVER-CORRECTION, and the one that matters most. Treat every closed status as covering
#      the waiting-on-the-user states too. The run would stop answering the questions it asked,
#      which is a silent failure that looks like a quiet board.
$m3 = New-Mutant 'M3' "`$script:ClosedStatus = @('done', 'skip')" "`$script:ClosedStatus = @('done', 'skip', 'proposed', 'blocked')"
$sx3 = New-Sandbox 'm3'
Initialize-Sandbox $m3 $sx3
$rows3 = Get-Rows $m3 $sx3
Assert ((Get-Row $rows3 '913').eligible -ne $true) 'M3' 'widening closed to proposed strands the answer the run was waiting for'

# M4 - suppress the work AND the message. This is the arm that keeps the fix honest: the whole
#      justification for not reanimating closed work is that the nudge STAYS VISIBLE. Drop the
#      report and that justification is gone -- a loud failure has become a silent one.
$m4 = New-Mutant 'M4' '      reopened_closed = [bool]($reopened -and ($script:ClosedStatus -contains "$status"))' '      reopened_closed = $false'
$sx4 = New-Sandbox 'm4'
Initialize-Sandbox $m4 $sx4
$rows4 = Get-Rows $m4 $sx4
Assert ((Get-Row $rows4 '910').reopened_closed -ne $true) 'M4' 'without the report the message is swallowed entirely'
Assert ((Get-Row $rows4 '910').eligible -eq $false) 'M4_STILL_SUPPRESSED' 'and the work is still suppressed, so the loss is silent'

Write-Host ''
Write-Host ("[mutcheck-reopened-closed] {0} passed, {1} failed" -f $script:pass, $script:fail)

if (-not $KeepFixtures) { Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue }
if ($script:fail -gt 0) { exit 1 }
exit 0
