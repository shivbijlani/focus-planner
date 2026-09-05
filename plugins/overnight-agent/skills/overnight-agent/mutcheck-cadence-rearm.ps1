<#
  mutcheck-cadence-rearm.ps1 -- changing a cadence must not make a task MORE aggressive (GH #506).

  WHY THIS EXISTS
  ---------------
  Measured live on 2026-09-04. Task 468 was polling every 2h while blocked on Shiv, holding the
  only dispatch slot at concurrency 1. The deliberate remedy was to lengthen the cadence:

      oa-state.ps1 mark -Id 468 -Poll 6h

  That set `next_due` to the CURRENT MINUTE -- strictly more aggressive than the 2h it replaced.
  The task went from "due in 92 minutes" to "due now" as a direct result of being told to run
  less often. It took a second, undocumented `-PollDone` to push the schedule out.

  At concurrency 1 that is not a cosmetic surprise. A due poll outranks the `awaiting_reply`
  park in `Test-SessionHoldsCapacity`, so an accidental due-now BOTH consumes the only slot AND
  re-qualifies the task to hold the Today gate -- the one-call form of "free up the backlog"
  starves the backlog it was meant to free.

  WHY A GUARD RATHER THAN A NOTE
  ------------------------------
  The hazard was first written down in `agent-lore.md`. That file is GH #454: 903 KB, 160
  headings, ZERO readers. A hazard recorded where nothing reads it does not prevent the next
  occurrence -- and this repo's own lesson, from write-turn.ps1's header, is that "each of these
  classes was documented in prose first and broken anyway". So it is pinned executably here.

  Hermetic: builds its own state dir and journal, and never reads or writes the live store.

      pwsh -File mutcheck-cadence-rearm.ps1 [-ScriptPath <oa-state.ps1>]
#>
[CmdletBinding()]
param(
  [string]$ScriptPath
)

$ErrorActionPreference = 'Stop'

# Resolved HERE, not as a param default. Under Windows PowerShell 5.1 `$PSScriptRoot` is still
# empty when param defaults are evaluated, so `Join-Path $PSScriptRoot ...` throws before the
# script body ever runs -- and it throws on 5.1 ONLY, which is the host the nightly uses while CI
# uses pwsh. That is the same Windows/Linux split this repo has already been bitten by, pointing
# the other way.
if (-not $ScriptPath) {
  $here = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
  $ScriptPath = Join-Path $here 'oa-state.ps1'
}

# Launch the host that actually EXISTS here. `powershell` is Windows-only, so hardcoding it makes
# the guard die on the Linux runner with "The term 'powershell' is not recognized" -- which is how
# this file first failed CI while passing locally. Same idiom as mutcheck-doc-binding.ps1: under
# Core, re-launch the very executable running this script; under 5.1, `powershell`.
$script:PsExe = if ($PSVersionTable.PSEdition -eq 'Core') { (Get-Process -Id $PID).Path } else { 'powershell' }
if (-not $script:PsExe) { $script:PsExe = 'pwsh' }

$root = Join-Path ([IO.Path]::GetTempPath()) ("oa-cadence-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
$jdir = Join-Path $root 'journal'
$sdir = Join-Path $root 'state'
New-Item -ItemType Directory -Path $jdir -Force | Out-Null
New-Item -ItemType Directory -Path $sdir -Force | Out-Null
$board = Join-Path $root 'planner.md'
$store = Join-Path $root 'snooze.json'
$utf8 = New-Object Text.UTF8Encoding($false)

$MOON = [char]::ConvertFromUtf32(0x1F319)
$Journal = @"
# Task {ID}: Synthetic

<!-- tg-meta chatId=-100123 threadId=7 -->

---
<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->

## $MOON Overnight Agent

<!-- from: overnight-agent -->

**Status:** In-progress $([char]0x00B7) 2026-09-04

work

**Needs from you:** none

<!-- /overnight-agent turn-end -->
"@

foreach ($id in 801, 802, 803, 804) {
  [IO.File]::WriteAllText((Join-Path $jdir "task-$id.md"), $Journal.Replace('{ID}', "$id"), $utf8)
}
$boardText = "## Today`n`n| ID | Task |`n|---|---|`n"
foreach ($id in 801, 802, 803, 804) { $boardText += "| $id | synthetic |`n" }
[IO.File]::WriteAllText($board, $boardText, $utf8)
[IO.File]::WriteAllText($store, '{}', $utf8)

function Invoke-Oa {
  param([string[]]$OaArgs)
  $all = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $ScriptPath) + $OaArgs +
    @('-JournalDir', $jdir, '-StateDir', $sdir, '-PlannerBoard', $board, '-SnoozeStore', $store)
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $out = & $script:PsExe @all 2>&1 | Out-String -Width 4096
  $ErrorActionPreference = $prev
  return $out
}
function Invoke-OaJson { param([string[]]$OaArgs) return (Invoke-Oa $OaArgs | ConvertFrom-Json) }

$results = [ordered]@{}
function Check([string]$name, [scriptblock]$body) {
  try { $results[$name] = [bool](& $body) }
  catch { $results[$name] = $false }
}

[void](Invoke-Oa @('seed'))

# --- A: arming a NEW poll is still due-now (the intentional behaviour, must not regress) ------
[void](Invoke-Oa @('mark', '-Id', '801', '-Poll', '2h'))
$a = Invoke-OaJson @('get', '-Id', '801')
Check 'A a NEWLY armed poll is due immediately' {
  $due = [datetime]::Parse("$($a.poll.next_due)", [Globalization.CultureInfo]::InvariantCulture)
  ($due - (Get-Date)).TotalMinutes -lt 1
}
Check 'A- and it records no last_polled yet' { "$($a.poll.last_polled)" -eq '' }

# --- B: THE DEFECT. Lengthening an existing cadence must push next_due OUT, not to now. -------
# 802 is polled (last_polled = now, next_due = now + 2h), then moved to 6h. The correct answer
# is last_polled + 6h; the defect answered "now", which is 2h EARLIER than it was already due.
[void](Invoke-Oa @('mark', '-Id', '802', '-Poll', '2h'))
[void](Invoke-Oa @('mark', '-Id', '802', '-PollDone'))
$before = Invoke-OaJson @('get', '-Id', '802')
$dueBefore = [datetime]::Parse("$($before.poll.next_due)", [Globalization.CultureInfo]::InvariantCulture)
[void](Invoke-Oa @('mark', '-Id', '802', '-Poll', '6h'))
$after = Invoke-OaJson @('get', '-Id', '802')
$dueAfter = [datetime]::Parse("$($after.poll.next_due)", [Globalization.CultureInfo]::InvariantCulture)

Check 'B lengthening a cadence does NOT make it due now' { ($dueAfter - (Get-Date)).TotalMinutes -gt 60 }
Check 'B- lengthening pushes next_due LATER than it already was' { $dueAfter -gt $dueBefore }
Check 'B-- and it is measured from the last actual poll (~6h out)' {
  $delta = ($dueAfter - (Get-Date)).TotalMinutes
  $delta -gt 330 -and $delta -lt 361
}
Check 'B--- the cadence itself was applied' { "$($after.poll.cadence)" -eq '6h' -and [int]$after.poll.interval_minutes -eq 360 }
Check 'B---- and the poll history is preserved, not reset' { "$($after.poll.last_polled)" -ne '' }

# --- C: SHORTENING still fires promptly -- from arithmetic, not from a reset ------------------
# A task last polled ~now, moved 6h -> 1m, is genuinely overdue and must say so. This is the arm
# that stops "never reset" being implemented as "never due", which would be the opposite defect.
[void](Invoke-Oa @('mark', '-Id', '803', '-Poll', '6h'))
[void](Invoke-Oa @('mark', '-Id', '803', '-PollDone'))
[void](Invoke-Oa @('mark', '-Id', '803', '-Poll', '1m'))
$c = Invoke-OaJson @('get', '-Id', '803')
Check 'C shortening a cadence still comes due promptly' {
  $due = [datetime]::Parse("$($c.poll.next_due)", [Globalization.CultureInfo]::InvariantCulture)
  ($due - (Get-Date)).TotalMinutes -lt 2
}

# --- D: the -Recheck half, which has the identical shape ---------------------------------------
[void](Invoke-Oa @('mark', '-Id', '804', '-Recheck', '2h', '-RecheckKind', 'blocker'))
[void](Invoke-Oa @('mark', '-Id', '804', '-RecheckDone'))
[void](Invoke-Oa @('mark', '-Id', '804', '-Recheck', '6h'))
$d = Invoke-OaJson @('get', '-Id', '804')
Check 'D lengthening a RECHECK cadence does NOT make it due now' {
  $due = [datetime]::Parse("$($d.recheck.next_due)", [Globalization.CultureInfo]::InvariantCulture)
  ($due - (Get-Date)).TotalMinutes -gt 60
}
Check 'D- and the recheck kind survives the cadence change' { "$($d.recheck.kind)" -eq 'blocker' }

# --- report ------------------------------------------------------------------------------------
$pass = 0; $fail = 0
foreach ($k in $results.Keys) {
  if ($results[$k]) { "  PASS  $k"; $pass++ } else { "  FAIL  $k"; $fail++ }
}
"`n$pass passed, $fail failed  (script: $ScriptPath)"

Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue
if ($fail) { exit 1 }
exit 0
