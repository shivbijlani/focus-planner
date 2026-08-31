<#
  mutcheck-blocked-recheck.ps1 -- mutation check for #395: blocked-task rechecks + snooze
  precedence over both timers.

  Builds a synthetic planner journal folder, runs the REAL oa-state.ps1 against it with an
  isolated -JournalDir / -StateDir / -PlannerBoard / -SnoozeStore (so live state is never
  touched), and asserts the scan verdicts.

  Run it against BOTH the pre-fix and post-fix scripts. The change is only load-bearing if the
  pre-fix script FAILS the new arms and PASSES nothing it should:

    powershell -File mutcheck-blocked-recheck.ps1 -ScriptPath <path-to-oa-state.ps1> [-ExpectPreFix]

  Arms, and the distinct mutant each one kills:

    A  recheck armed          -> due_recheck TRUE      (kills: feature absent entirely)
    B  recheck kind echoed    -> recheck_kind returned (kills: timer without a selector, so a run
                                                        cannot tell WHICH check it can perform)
    C  -RecheckDone           -> due_recheck FALSE     (kills: timer that never re-arms, so a
                                                        blocked task is reported due forever)
    D  -RecheckClear          -> due_recheck FALSE     (kills: recheck that cannot be retired once
                                                        the task is unblocked)
    E  snoozed + due poll     -> due_poll FALSE        (kills: snooze precedence missing on poll --
                                                        this one FAILS on origin/main today)
    F  snoozed + due recheck  -> due_recheck FALSE     (kills: snooze precedence missing on recheck)
    G  snooze lapses          -> due_poll TRUE again   (kills: snooze DISARMING the timer instead of
                                                        merely suppressing the verdict)
    H  blocked + due recheck  -> eligible TRUE         (kills: the timer firing and the verdict being
                                                        DISCARDED by the `blocked` status gate, which
                                                        made the whole recheck feature inert)
    I  done + due recheck     -> eligible FALSE        (kills: an over-broad fix to H that lets a
                                                        recheck REOPEN a closed task -- the #170
                                                        "agent executes in closed tasks" bug)

  H and I are the pair that matters: every arm above asserts the SIGNAL (`due_recheck`) and none
  asserted the CONSEQUENCE (`eligible`), which is exactly how a timer that fired into a closed gate
  read as healthy for as long as it did.
#>
[CmdletBinding()]
param(
  [string]$ScriptPath,
  [switch]$ExpectPreFix
)

$ErrorActionPreference = 'Stop'

if (-not $ScriptPath) { $ScriptPath = Join-Path $PSScriptRoot 'oa-state.ps1' }
if (-not (Test-Path $ScriptPath)) { throw "oa-state.ps1 not found at $ScriptPath" }

$Journal = @'
# Task {ID}: synthetic

User notes at the top.

---
<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->

## Overnight Agent

**Status:** Blocked - plan v1 - 2026-08-28

<!-- from: overnight-agent -->
Waiting on a prerequisite.

**Needs from you:** none
'@

# --- isolated sandbox ---------------------------------------------------------------
$root = Join-Path ([IO.Path]::GetTempPath()) ("oa-recheck-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
$jdir = Join-Path $root 'journal'
$sdir = Join-Path $root 'state'
New-Item -ItemType Directory -Path $jdir -Force | Out-Null
New-Item -ItemType Directory -Path $sdir -Force | Out-Null

$board = Join-Path $root 'planner.md'
$store = Join-Path $root 'snooze.json'
$utf8 = New-Object Text.UTF8Encoding($false)

foreach ($id in 601, 602, 603, 604, 605) {
  [IO.File]::WriteAllText((Join-Path $jdir "task-$id.md"), $Journal.Replace('{ID}', "$id"), $utf8)
}
[IO.File]::WriteAllText($board, "## Today`n`n| ID | Task |`n|---|---|`n", $utf8)
[IO.File]::WriteAllText($store, '{}', $utf8)

function Invoke-Oa {
  param([string[]]$OaArgs)
  $all = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $ScriptPath) + $OaArgs +
  @('-JournalDir', $jdir, '-StateDir', $sdir, '-PlannerBoard', $board, '-SnoozeStore', $store)
  # Must not throw: the whole point of -ExpectPreFix is to run this against a build that
  # REJECTS the new parameters. A hard failure there has to surface as a failed arm, not as a
  # crashed harness -- otherwise "pre-fix fails" is indistinguishable from "harness is broken".
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { $out = & powershell @all 2>&1 | Out-String }
  catch { $out = '' }
  finally { $ErrorActionPreference = $prev; $global:LASTEXITCODE = 0 }
  return $out
}

function Get-Row([string]$id) {
  $json = Invoke-Oa @('scan')
  # A pre-fix build can emit warnings/errors alongside the JSON; keep only the array.
  $start = $json.IndexOf('[')
  if ($start -lt 0) { return $null }
  try { $rows = $json.Substring($start) | ConvertFrom-Json } catch { return $null }
  return $rows | Where-Object { "$($_.id)" -eq $id }
}

function Set-Snooze([string]$id, [string]$date) {
  if ($date) { [IO.File]::WriteAllText($store, "{ ""$id"": ""$date"" }", $utf8) }
  else { [IO.File]::WriteAllText($store, '{}', $utf8) }
}

$results = [ordered]@{}
function Check([string]$name, [scriptblock]$body) {
  try { $results[$name] = [bool](& $body) }
  catch { $results[$name] = $false; Write-Verbose "$name threw: $($_.Exception.Message)" }
}

# --- seed state so every task is tracked ---------------------------------------------
[void](Invoke-Oa @('seed'))

$today = (Get-Date).ToString('yyyy-MM-dd')
$past = (Get-Date).AddDays(-2).ToString('yyyy-MM-dd')

# A/B: arm a recheck on #601 and read it back.
[void](Invoke-Oa @('mark', '-Id', '601', '-Status', 'blocked', '-Recheck', '12h', '-RecheckKind', 'ci'))
$r601 = Get-Row '601'
Check 'A recheck armed is due'      { $r601.due_recheck -eq $true }
Check 'B recheck kind echoed'       { "$($r601.recheck_kind)" -eq 'ci' -and "$($r601.recheck_cadence)" -eq '12h' }

# C: running it pushes next_due forward, so it stops being due.
[void](Invoke-Oa @('mark', '-Id', '601', '-RecheckDone'))
Check 'C RecheckDone clears due'    { (Get-Row '601').due_recheck -eq $false }

# D: clearing retires it entirely.
[void](Invoke-Oa @('mark', '-Id', '601', '-RecheckClear'))
$r601c = Get-Row '601'
Check 'D RecheckClear retires it'   { $r601c.due_recheck -eq $false -and -not $r601c.recheck_cadence }

# E: a snoozed task with an overdue POLL must not report due_poll.
[void](Invoke-Oa @('mark', '-Id', '602', '-Poll', 'daily'))
Check 'E- poll due before snooze'   { (Get-Row '602').due_poll -eq $true }   # guard: arm actually worked
Set-Snooze '602' $today
Check 'E snooze outranks poll'      { (Get-Row '602').due_poll -eq $false }

# G: snooze only SUPPRESSES; once it lapses the same armed timer fires again.
Set-Snooze '602' $past
$r602g = Get-Row '602'
Check 'G lapsed snooze re-fires'    { $r602g.due_poll -eq $true -and $r602g.snoozed -eq $false }

# F: a snoozed task with an overdue RECHECK must not report due_recheck.
[void](Invoke-Oa @('mark', '-Id', '603', '-Status', 'blocked', '-Recheck', 'daily', '-RecheckKind', 'oauth'))
Check 'F- recheck due before snooze' { (Get-Row '603').due_recheck -eq $true }
Set-Snooze '603' $today
Check 'F snooze outranks recheck'   { (Get-Row '603').due_recheck -eq $false }

# H: the consequence, not just the signal. A blocked task whose recheck is DUE must actually
# become workable -- otherwise the timer fires into a closed gate and the feature does nothing.
[void](Invoke-Oa @('mark', '-Id', '604', '-Status', 'blocked', '-Recheck', 'daily', '-RecheckKind', 'ci'))
$r604 = Get-Row '604'
Check 'H- blocked recheck is due'   { $r604.due_recheck -eq $true }   # guard: arm actually worked
Check 'H due recheck is ELIGIBLE'   { $r604.eligible -eq $true }

# I: the opposite failure. Yielding the status gate too broadly would let a recheck re-surface a
# CLOSED task, which is the #170 "agent executes in closed tasks" bug. done must stay ineligible.
[void](Invoke-Oa @('mark', '-Id', '605', '-Status', 'blocked', '-Recheck', 'daily', '-RecheckKind', 'ci'))
Check 'I- recheck armed while blocked' { (Get-Row '605').due_recheck -eq $true }
[void](Invoke-Oa @('mark', '-Id', '605', '-Status', 'done'))
$r605 = Get-Row '605'
Check 'I done stays INELIGIBLE'     { $r605.due_recheck -eq $true -and $r605.eligible -eq $false }

# --- report ---------------------------------------------------------------------------
$pass = 0; $fail = 0
foreach ($k in $results.Keys) {
  if ($results[$k]) { "  PASS  $k"; $pass++ } else { "  FAIL  $k"; $fail++ }
}
""
"$pass passed, $fail failed  (script: $ScriptPath)"

Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue

if ($ExpectPreFix) {
  # Against the PRE-FIX script the new arms must fail. If they all pass, the change is a
  # no-op restatement of existing behaviour and is not load-bearing.
  if ($fail -eq 0) { "MUTCHECK FAILED: pre-fix script passed everything - the fix guards nothing."; exit 1 }
  "MUTCHECK OK: pre-fix script fails $fail arm(s), as required."
  exit 0
}

if ($fail -gt 0) { exit 1 }
exit 0
