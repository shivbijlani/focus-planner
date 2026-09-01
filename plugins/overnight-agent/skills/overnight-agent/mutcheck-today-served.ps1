<#
  mutcheck-today-served.ps1 -- mutation check for the Today->Deferred RUN BUDGET (#223's missing
  half, fixed 2026-08-31).

  THE DEFECT THIS GUARDS

  "Today before Deferred" was implemented as "a Deferred row is ineligible while any Today row is
  WORKABLE". Workability is a property of the BOARD, not of the run, so the gate can only open if a
  Today row stops being workable. That is fine while Today rows finish. It starves the board
  permanently as soon as one does not.

  Measured live 2026-08-31: the whole `## Today` section was a SINGLE standing meta-task (#448,
  "triage fix and ship GitHub issues"). It is unbounded by construction, so it is `in-progress` and
  workable on every run, forever -- holding 121 Deferred rows (10 workable) shut on every run.
  Three runs in one night each re-worked #448 and touched nothing else. Nothing errored: the gate
  did exactly what it said, which is why this reads clean and starves silently.

  The user's own spec for #223 carries the missing half -- *"only if its blocked on all today
  items, can it move to deferred items, ASSUMING THAT THERE IS STILL PLENTY OF TIME before the next
  scheduled automation kicks in"*. That clause is about the RUN's remaining budget, not the row's
  status, and it was never implemented.

  So a Today row is now SERVED once the agent has written a turn to it within
  -TodayServedMinutes, and a served row steps OUT of the gate while staying fully eligible itself
  at its own board rank. Today is still worked FIRST; only the exclusivity lapses.

  WHY A MUTATION CHECK. Both halves of this are easy to get wrong in a way that still looks green:
  implement it too broadly and Deferred opens while a genuinely fresh Today row is waiting (rule 1
  gone); implement it in Test-Workable instead of the gate and the standing task stops being
  eligible at all (the agent abandons its own top-priority row). Arms L and J exist specifically to
  kill those two, and they pull in opposite directions -- neither can be satisfied by deleting the
  feature.

  Run against BOTH the pre-fix and post-fix scripts:

    powershell -File mutcheck-today-served.ps1 -ScriptPath <path-to-oa-state.ps1> [-ExpectPreFix]

  Arms, and the distinct mutant each one kills:

    J  never-served Today still gates   (kills: dropping the gate entirely / always-served --
                                         this is the NARROW half, and it is also #223 rule 1 and
                                         #282's "un-park, don't open the gate" claim, re-asserted
                                         with the budget gate switched ON)
    K  served Today opens Deferred      (kills: the pre-fix gate -- the starvation itself)
    L  served Today stays eligible #1   (kills: implementing "served" inside Test-Workable, which
                                         would drop the standing task instead of the gate)
    M  reopened reclaims exclusivity    (kills: forgetting that a live reply outranks "served")
    N  -TodayServedMinutes 0 restores   (kills: a hard-coded window -- proves this is a DECISION
                                         and not a constant, and gives a one-flag rollback)
    O  a stale turn gates again         (kills: "has any state at all" being treated as served,
                                         i.e. an age check that never actually reads the age)

  NOTE: no literal emoji anywhere. A BOM-less .ps1 is decoded as the ANSI codepage under Windows
  PowerShell 5.1, so a literal would be corrupted on the way in and report a false failure.
#>
[CmdletBinding()]
param(
  [string]$ScriptPath,
  [switch]$ExpectPreFix
)

$ErrorActionPreference = 'Stop'

if (-not $ScriptPath) { $ScriptPath = Join-Path $PSScriptRoot 'oa-state.ps1' }
if (-not (Test-Path $ScriptPath)) { throw "oa-state.ps1 not found at $ScriptPath" }

# A journal whose newest agent turn declares itself unblocked, so the row is WORKABLE and the only
# thing that can move it is the gate under test. This is the live #448 shape in miniature.
$Journal = @'
# Task {ID}: synthetic

User notes at the top.

---
<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->

## Overnight Agent

**Status:** In progress - 2026-08-31

<!-- from: overnight-agent -->
The agent's last turn on a standing task that never finishes.

**Needs from you:** none
'@

$root = Join-Path ([IO.Path]::GetTempPath()) ("oa-served-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
$jdir = Join-Path $root 'journal'
$sdir = Join-Path $root 'state'
New-Item -ItemType Directory -Path $jdir -Force | Out-Null
New-Item -ItemType Directory -Path $sdir -Force | Out-Null

$board = Join-Path $root 'planner.md'
$store = Join-Path $root 'snooze.json'
$utf8 = New-Object Text.UTF8Encoding($false)

foreach ($id in 910, 920, 921) {
  [IO.File]::WriteAllText((Join-Path $jdir "task-$id.md"), $Journal.Replace('{ID}', "$id"), $utf8)
}

$sb = New-Object Text.StringBuilder
[void]$sb.AppendLine('## Today')
[void]$sb.AppendLine('')
[void]$sb.AppendLine('| ID | U | Task | Work Priority | Added | Linked ID |')
[void]$sb.AppendLine('|---|---|------|---------------|-------|-----------|')
[void]$sb.AppendLine('| 910 |  | standing today task | - | 2026-08-31 |  |')
[void]$sb.AppendLine('')
[void]$sb.AppendLine('## Deferred')
[void]$sb.AppendLine('')
[void]$sb.AppendLine('| ID | U | Task | Work Priority | Added | Wake | Linked ID |')
[void]$sb.AppendLine('| --- | --- | ------ | --------------- | ------- | ---- | ----------- |')
[void]$sb.AppendLine('| 920 |  | deferred one | - | 2026-08-31 |  |  |')
[void]$sb.AppendLine('| 921 |  | deferred two | - | 2026-08-31 |  |  |')
[IO.File]::WriteAllText($board, $sb.ToString(), $utf8)
[IO.File]::WriteAllText($store, '{}', $utf8)

function Invoke-Oa {
  param([string[]]$OaArgs)
  & powershell -NoProfile -ExecutionPolicy Bypass -File $ScriptPath @OaArgs `
    -JournalDir $jdir -StateDir $sdir -PlannerBoard $board -SnoozeStore $store 2>&1
}

function Get-Rows {
  param([string[]]$Extra = @())
  $text = (Invoke-Oa (@('scan') + $Extra) | Out-String)
  try { return ($text | ConvertFrom-Json) } catch { return @() }
}

function Get-Row {
  param($rows, [string]$id)
  return ($rows | Where-Object { "$($_.id)" -eq $id } | Select-Object -First 1)
}

function Test-DeferredOpen {
  # $true only if BOTH Deferred rows are eligible, and never vacuously: a build that emits no
  # `eligible` field at all must not read as "open".
  param($rows)
  $d = @(920, 921 | ForEach-Object { (Get-Row $rows "$_").eligible })
  return (($d -notcontains $null) -and ($d -notcontains $false) -and ($d.Count -eq 2))
}

function Test-DeferredHeld {
  param($rows)
  $d = @(920, 921 | ForEach-Object { (Get-Row $rows "$_").eligible })
  return (($d -notcontains $null) -and ($d -notcontains $true) -and ($d.Count -eq 2))
}

$results = [ordered]@{}
function Check([string]$name, [scriptblock]$body) {
  $ok = $false
  try { $ok = [bool](& $body) } catch { $ok = $false }
  $results[$name] = $ok
}

# --- J: NEVER served -> the gate still holds ------------------------------------------
# No state exists yet, so the agent has never written a turn to 910. This is the narrow half:
# it must behave exactly as it did before the fix, or the fix is over-broad and has simply
# deleted rule 1. It also re-asserts #282's claim with the budget gate switched ON.
$rowsJ = Get-Rows
Check 'J never-served Today still gates' {
  $t = Get-Row $rowsJ '910'
  ($null -ne $t) -and ($t.eligible -eq $true) -and (Test-DeferredHeld $rowsJ)
}

# --- K: served -> Deferred opens ------------------------------------------------------
# `mark` stamps `last_turn_at`, which is the agent recording that it just wrote a turn here.
[void](Invoke-Oa @('mark', '-Id', '910', '-Status', 'in-progress'))
$rowsK = Get-Rows
Check 'K served Today opens Deferred' {
  Test-DeferredOpen $rowsK
}

# --- L: ...and the Today row is STILL first and STILL eligible -------------------------
# The fix must live in the GATE, not in Test-Workable. If "served" made the row unworkable the
# agent would stop working its own highest-priority task -- the opposite failure, and a silent
# one, because the backlog would look healthy while the top row went dark.
Check 'L served Today stays eligible and first' {
  $t = Get-Row $rowsK '910'
  ($null -ne $t) -and ($t.eligible -eq $true) -and ([int]$t.order -eq 1) -and
  ($t.holds_today_gate -eq $false)
}

# --- M: a live reply reclaims exclusivity ---------------------------------------------
# `mark` stamped the turn-end terminator, so text appended below it is the user speaking.
$p910 = Join-Path $jdir 'task-910.md'
# Kept so arm P can restore a journal with NO trailing user prose -- see the note there.
$quiet910 = [IO.File]::ReadAllText($p910, $utf8)
$txt = $quiet910 + "`n`n## 2026-08-31`n`n<!-- from: me -->`nactually do this one first`n"
[IO.File]::WriteAllText($p910, $txt, $utf8)
$rowsM = Get-Rows
Check 'M reopened Today reclaims the gate' {
  $t = Get-Row $rowsM '910'
  ($null -ne $t) -and ($t.reopened -eq $true) -and ($t.eligible -eq $true) -and
  ($t.holds_today_gate -eq $true) -and (Test-DeferredHeld $rowsM)
}

# Re-mark to absorb the reply, so the remaining arms test the served path again rather than the
# reopened one.
[void](Invoke-Oa @('mark', '-Id', '910', '-Status', 'in-progress'))

# --- N: the window is a DECISION, not a constant --------------------------------------
# `0` must restore the pre-fix gate exactly. This is both the mutation that kills a hard-coded
# window and the one-flag rollback if this behaviour is ever unwanted.
$rowsN = Get-Rows @('-TodayServedMinutes', '0')
Check 'N TodayServedMinutes 0 restores pre-fix gate' {
  $t = Get-Row $rowsN '910'
  ($null -ne $t) -and ($t.eligible -eq $true) -and ($t.holds_today_gate -eq $true) -and
  (Test-DeferredHeld $rowsN)
}

# --- O: a STALE turn gates again ------------------------------------------------------
# Backdate the recorded turn beyond the window. If the implementation merely asks "is there any
# state?" rather than reading the age, this passes when it must not -- and the feature would
# silently become permanent rather than per-run.
#
# Backdates `last_turn_at`, NOT `updated`. Those were the same field until the gate was found
# releasing on a freshly SEEDED board: `updated` means "this state record was touched", and
# `seed`/`resnapshot` touch it without the agent having written anything, so a bootstrap read as
# work. `last_turn_at` is stamped only by a real `mark`. Writing to the old name here would make
# this arm backdate a field the gate no longer reads -- it would still be green while asserting
# nothing, which is the vacuous-pass hazard this suite exists to avoid.
$statePath = Join-Path $sdir 'task-910.json'
$st = Get-Content $statePath -Raw | ConvertFrom-Json
$st.last_turn_at = (Get-Date).AddHours(-3).ToString('yyyy-MM-ddTHH:mm:sszzz')
$st | ConvertTo-Json -Depth 6 | Set-Content $statePath -Encoding UTF8
$rowsO = Get-Rows
Check 'O stale turn gates again' {
  $t = Get-Row $rowsO '910'
  ($null -ne $t) -and ($t.eligible -eq $true) -and ($t.holds_today_gate -eq $true) -and
  (Test-DeferredHeld $rowsO)
}

# --- P: a BOOTSTRAP is not a turn -----------------------------------------------------
# The regression that made this distinction necessary, pinned so it cannot come back. `seed`
# stamps state for every journal on disk; if the gate reads that as "the agent just worked this
# row", then a single seed or migration releases the Today gate for the ENTIRE board at once --
# silently, and for every task simultaneously. Found via mutcheck-board-compound-id, whose
# fixture happens to seed before it scans; asserted here directly so it is guarded on purpose
# rather than by luck.
#
# TWO fixture details are load-bearing, and both were got wrong first time:
#  1. The journal is restored to its QUIET form. `seed` rebaselines to the agent-LEFT hash, which
#     excludes trailing user prose -- so arm M's leftover reply would make the row read `reopened`
#     after seeding, and `reopened` holds the gate on its own. The arm then passes for a reason
#     that has nothing to do with seeding, i.e. it goes green while asserting nothing.
#  2. `reopened -eq $false` is asserted explicitly, so that masking can never silently return.
[IO.File]::WriteAllText($p910, $quiet910, $utf8)
Remove-Item (Join-Path $sdir 'task-910.json') -Force -ErrorAction SilentlyContinue
[void](Invoke-Oa @('seed'))
$rowsP = Get-Rows
Check 'P seed alone does not count as a turn' {
  $t = Get-Row $rowsP '910'
  ($null -ne $t) -and ($t.reopened -eq $false) -and
  ($t.holds_today_gate -eq $true) -and (Test-DeferredHeld $rowsP)
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
  if ($fail -eq 0) { "MUTCHECK FAILED: pre-fix script passed everything - the fix guards nothing."; exit 1 }
  "MUTCHECK OK: pre-fix script fails $fail arm(s), as required."
  exit 0
}

if ($fail -gt 0) { exit 1 }
exit 0
