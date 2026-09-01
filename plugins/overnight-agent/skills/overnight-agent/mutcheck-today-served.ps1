<#
  mutcheck-today-served.ps1 -- mutation check for the Today->Deferred RELEASE SIGNAL: what is
  allowed to open the gate that keeps the run on Today before it touches Deferred.

  (Filename kept from the 2026-08-31 "served" design it supersedes, so existing references keep
  resolving. The subject is no longer "served"; see below.)

  THE DEFECT THIS GUARDS, AND ITS PREDECESSOR

  Rule 1 of #223 is "Today before Deferred". The only hard question is what RELEASES it, and it
  has been answered wrongly twice, in OPPOSITE directions. Both are recorded because the current
  design is only defensible as the thing that satisfies both at once.

    keyed to WORKABILITY  (original)  never opens for an unbounded row. Live 2026-08-31 the whole
                                      `## Today` was ONE standing meta-task ("triage fix and ship
                                      GitHub issues") -- workable forever -- so it froze 121
                                      Deferred rows on every run. Measured: 1 eligible of 238.
    keyed to RECENCY      (#310)      opens the moment the agent TYPES. `mark` stamps
                                      `last_turn_at` on every turn, so ONE turn -- any content,
                                      any completion state -- released the whole backlog for the
                                      rest of the run. Sandboxed against the deployed script:
                                      a Today row whose journal read "I have done nothing at all.
                                      The work is not started." went holds_gate True -> False on
                                      one `mark`, and Deferred eligibility went 0/12 -> 12/12.

  The second is this repo's recurring failure class: THE AGENT AUTHORS THE SIGNAL ITS OWN GATE
  READS (cf. #227/#272 consent; the `awaiting_reply` ratchet, 186 of 238 rows parked by the
  agent's own closing courtesy line). So the release is now an affirmative DECLARATION the run
  must make in its own call, naming what it examined -- and the four things that CANCEL a
  declaration are state the agent does not author: the clock, the human's board, a live reply,
  and the run's own later turns.

  WHY A MUTATION CHECK. Every arm below pulls against at least one other, so no arm can be
  satisfied by deleting the feature:

    B says a declaration MUST open the gate      <-> A says writing MUST NOT
    K says a wedged run MUST eventually open it  <-> A/C/D/E say it must stay shut otherwise
    L says a finished row MUST NOT hold          <-> J says the rollback flag holds everything

  ARM <-> MUTANT BIJECTION. Each arm kills exactly one mutant and each mutant is killed by
  exactly one arm. That is asserted MECHANICALLY, not just claimed: run with -Matrix and the
  harness patches the real oa-state.ps1 twelve ways, re-runs all twelve arms against each
  mutant, and fails if any mutant is killed by zero arms (a claim nothing pins) or by more than
  one (two arms asserting the same thing).

  MUTANT TARGET PRE-FLIGHT, and why it runs unconditionally. Every mutant is a literal patch of
  oa-state.ps1, so it stops biting the moment someone reformats the line it matches -- and the
  ARMS DO NOT NOTICE, because they test the real script, which still works. The count assertion
  that catches this used to live only inside New-Mutant, which is reached only under -Matrix. So
  a default run printed "12 passed, 0 failed" and exited 0 with every mutant silently dead.
  Nothing about that output was false; it simply implied a check it had not performed.

  That is a distinct class from a vacuous pass, and a worse one to find: a vacuous arm has a tell
  (it passes against an empty fixture), whereas this has none -- every fixture non-empty, every
  number correct, the exit code right. Demonstrated: a whitespace-only reformat of one line in
  oa-state.ps1 kills mutant M10, and before this change the suite reported 12/12 and exit 0.
  It now reports the drift and exits 1 while still printing 12 passed, which is the honest
  summary -- the arms ARE passing; what has rotted is the proof that they are load-bearing.

  A drift check that is itself opt-in has exactly the same defect one level up, so this one is
  not behind a flag. It is pure string matching over a file already in memory and spawns nothing.

    A  writing a turn does not release      M1  recency release restored (the #310 defect)
    B  a named declaration releases         M2  the declaration release deleted
    C  an expired declaration gates again   M3  the TTL check deleted
    D  editing `## Today` revokes it        M4  the board-hash check deleted
    E  a later turn refutes it              M5  the supersede check deleted
    F  a declaration naming nothing fails   M6  the "name what you examined" guard deleted
    G  a declaration cannot ride on a turn  M7  the separate-call guard deleted
    H  cannot declare an unworked row       M8  the "worked it this run" precondition deleted
    I  a live reply reclaims exclusivity    M9  the reopened branch deleted
    J  the strict rollback holds everything M10 the rollback flag ignored
    K  a wedged run releases (backstop)     M11 the backstop disabled
    L  a terminal Today row does not hold   M12 the workability check deleted

  DROPPED ON PURPOSE: the old arm P ("seed alone is not a turn"). It existed because a stamp on
  the state record RELEASED the gate, so a bootstrap over every journal released the whole board
  at once. Nothing about `last_turn_at` releases any more -- a fresh stamp only ever makes the
  gate hold LONGER -- so that hazard is now structurally impossible rather than merely tested.
  What survives of it is arm H: a seeded-but-never-worked row still cannot be declared exhausted.

  Usage:

    powershell -File mutcheck-today-served.ps1 [-ScriptPath <oa-state.ps1>] [-ExpectPreFix]
    powershell -File mutcheck-today-served.ps1 -Matrix     # prove the bijection (slow, ~12x)

  NOTE: no literal emoji or dashes anywhere. A BOM-less .ps1 is decoded as the ANSI codepage
  under Windows PowerShell 5.1, so a literal would be corrupted on the way in and report a false
  failure. Mutants are written back WITH a BOM for the same reason.
#>
[CmdletBinding()]
param(
  [string]$ScriptPath,
  [switch]$ExpectPreFix,
  [switch]$Matrix
)

$ErrorActionPreference = 'Stop'

if (-not $ScriptPath) { $ScriptPath = Join-Path $PSScriptRoot 'oa-state.ps1' }
if (-not (Test-Path $ScriptPath)) { throw "oa-state.ps1 not found at $ScriptPath" }
$ScriptPath = (Resolve-Path $ScriptPath).Path

$utf8 = New-Object Text.UTF8Encoding($false)

# A journal whose newest agent turn declares itself unblocked, so the row is WORKABLE and the
# only thing that can move it is the gate under test. This is the live #448/#463 shape in
# miniature: a standing meta-task that is never done and never will be.
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

function Iso([int]$minutesAgo) {
  return (Get-Date).AddMinutes(-$minutesAgo).ToString('yyyy-MM-ddTHH:mm:ssK')
}

function New-Sandbox {
  $root = Join-Path ([IO.Path]::GetTempPath()) ("oa-served-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
  $jdir = Join-Path $root 'journal'
  $sdir = Join-Path $root 'state'
  New-Item -ItemType Directory -Path $jdir -Force | Out-Null
  New-Item -ItemType Directory -Path $sdir -Force | Out-Null
  $board = Join-Path $root 'planner.md'
  $store = Join-Path $root 'snooze.json'

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

  return [pscustomobject]@{ root = $root; jdir = $jdir; sdir = $sdir; board = $board; store = $store }
}

function Invoke-Arms {
  # Runs all twelve arms against ONE build and returns an ordered name -> bool map. Every arm
  # gets a fresh, fully-specified state file rather than inheriting the previous arm's, so the
  # arms are order-independent and each one pins exactly the situation named in its title.
  param([string]$Build)

  $box = New-Sandbox
  $sp = Join-Path $box.sdir 'task-910.json'
  $p910 = Join-Path $box.jdir 'task-910.md'

  function Oa {
    param([string[]]$OaArgs)
    # 'Continue' is function-scoped and restores itself on exit. It is required: `2>&1` turns a
    # child's stderr into ErrorRecords in this pipeline, and under 'Stop' the harness would die
    # instead of reporting -- which is exactly the failure the sibling suites document as worse
    # than a vacuous pass. Arms that expect a command to FAIL depend on getting the output back.
    $ErrorActionPreference = 'Continue'
    & powershell -NoProfile -ExecutionPolicy Bypass -File $Build @OaArgs `
      -JournalDir $box.jdir -StateDir $box.sdir -PlannerBoard $box.board -SnoozeStore $box.store 2>&1
  }
  function Oa-Ok {
    # $true when the command succeeded. Used by the arms that assert a declaration is REFUSED.
    param([string[]]$OaArgs)
    $global:LASTEXITCODE = 0
    try { [void](Oa $OaArgs) } catch { return $false }
    return ($LASTEXITCODE -eq 0)
  }
  function Rows {
    param([string[]]$Extra = @())
    $text = ''
    try { $text = ((Oa (@('scan') + $Extra)) | Out-String) } catch { return @() }
    try { return @($text | ConvertFrom-Json) } catch { return @() }
  }
  function Row {
    param($rows, [string]$id)
    return ($rows | Where-Object { "$($_.id)" -eq $id } | Select-Object -First 1)
  }
  function DeferredOpen {
    # Never vacuously true: a build that emits no `eligible` field must not read as "open".
    param($rows)
    $d = @(920, 921 | ForEach-Object { (Row $rows "$_").eligible })
    return (($d -notcontains $null) -and ($d -notcontains $false) -and ($d.Count -eq 2))
  }
  function DeferredHeld {
    param($rows)
    $d = @(920, 921 | ForEach-Object { (Row $rows "$_").eligible })
    return (($d -notcontains $null) -and ($d -notcontains $true) -and ($d.Count -eq 2))
  }
  function HasDeclaration {
    if (-not (Test-Path $sp)) { return $false }
    $s = Get-Content $sp -Raw | ConvertFrom-Json
    return [bool]($s.PSObject.Properties['today_exhausted'] -and $s.today_exhausted)
  }

  # --- setup: one genuine turn, then one genuine declaration ---------------------------------
  # The turn gives a real processed_file_hash (a fabricated one would read as `reopened` and
  # every arm would then pass for the wrong reason). The declaration is made through the CLI
  # purely to learn the real `## Today` hash, which the fabricated declarations below reuse.
  [void](Oa @('mark', '-Id', '910', '-Status', 'in-progress'))
  $templateJson = Get-Content $sp -Raw
  $quiet910 = [IO.File]::ReadAllText($p910, $utf8)
  $boardText = [IO.File]::ReadAllText($box.board, $utf8)
  [void](Oa @('mark', '-Id', '910', '-Exhausted', 'setup:1'))
  $goodHash = ''
  if (Test-Path $sp) {
    $probe = Get-Content $sp -Raw | ConvertFrom-Json
    if ($probe.PSObject.Properties['today_exhausted'] -and $probe.today_exhausted) {
      $goodHash = "$($probe.today_exhausted.today_hash)"
    }
  }

  function Set-Row {
    # Write task-910's state from the template, with an exactly specified turn age and an
    # exactly specified declaration (or none).
    param(
      [int]$TurnMinutesAgo = 0,
      [string]$Status = 'in-progress',
      [int]$DeclMinutesAgo = -1,
      [string[]]$Examined = @('gh:197', 'gh:179'),
      [string]$Hash = ''
    )
    $st = $templateJson | ConvertFrom-Json
    $st.status = $Status
    if ($st.PSObject.Properties['last_turn_at']) { $st.last_turn_at = (Iso $TurnMinutesAgo) }
    else { $st | Add-Member -NotePropertyName 'last_turn_at' -NotePropertyValue (Iso $TurnMinutesAgo) }
    if ($TurnMinutesAgo -lt 0) { $st.last_turn_at = $null }
    $decl = $null
    if ($DeclMinutesAgo -ge 0) {
      # `if ($Hash)`, never `if ($null -ne $Hash)`: a [string] parameter defaulted to $null
      # arrives as the EMPTY STRING, so the null test is always true and every fabricated
      # declaration would silently carry an empty board hash. That made arm D pass for
      # `stale_board` no matter what the board said -- green while asserting nothing.
      $h = if ($Hash) { $Hash } else { $goodHash }
      $decl = [pscustomobject]@{ at = (Iso $DeclMinutesAgo); examined = $Examined; note = ''; today_hash = $h }
    }
    $st | Add-Member -NotePropertyName 'today_exhausted' -NotePropertyValue $decl -Force
    ($st | ConvertTo-Json -Depth 6) | Set-Content -Path $sp -Encoding UTF8
  }

  $r = [ordered]@{}
  function Check([string]$name, [scriptblock]$body) {
    $ok = $false
    try { $ok = [bool](& $body) } catch { $ok = $false }
    $r[$name] = $ok
  }

  # --- A: WRITING A TURN DOES NOT RELEASE ----------------------------------------------------
  # The #310 defect, stated as its negation. The row was worked seconds ago and is still
  # `in-progress` with work left; that is the state in which the deployed script handed over the
  # entire backlog. It must now change nothing at all.
  Set-Row -TurnMinutesAgo 0
  $rowsA = Rows
  Check 'A writing a turn does not release the gate' {
    $t = Row $rowsA '910'
    ($null -ne $t) -and ($t.holds_today_gate -eq $true) -and
    ("$($t.today_release_reason)" -eq 'holding:no_declaration') -and
    ($t.eligible -eq $true) -and ([int]$t.order -eq 1) -and (DeferredHeld $rowsA)
  }

  # --- B: A NAMED DECLARATION RELEASES -------------------------------------------------------
  # The other half, and the reason this is not a revert to the workability gate: the row is
  # STILL `in-progress` and still unbounded, exactly as in arm A. The only difference is that
  # the run has affirmatively said what it examined. Also pins that the release lives in the
  # GATE, not in Test-Workable: 910 stays eligible AND first, so the agent never abandons its
  # own top-priority row.
  #
  # The turn is 20 minutes old rather than seconds old, ON PURPOSE. It keeps this arm outside
  # the narrow recency window mutant M1 restores, so M1 is killed by arm A alone -- arm A is the
  # one making the claim about writing, and an arm should fail only for its own reason.
  Set-Row -TurnMinutesAgo 20 -DeclMinutesAgo 0
  $rowsB = Rows
  Check 'B a named declaration releases Deferred' {
    $t = Row $rowsB '910'
    ($null -ne $t) -and ($t.holds_today_gate -eq $false) -and
    ("$($t.today_release_reason)" -eq 'declared_exhausted') -and
    ($t.eligible -eq $true) -and ([int]$t.order -eq 1) -and (DeferredOpen $rowsB)
  }

  # --- C: AN EXPIRED DECLARATION GATES AGAIN -------------------------------------------------
  # "Exhausted for THIS RUN" has to expire, or the first declaration ever made would open the
  # backlog forever. The turn is older than the declaration, so `superseded` cannot fire and
  # this arm can only be about the clock.
  Set-Row -TurnMinutesAgo 90 -DeclMinutesAgo 60
  $rowsC = Rows
  Check 'C an expired declaration gates again' {
    $t = Row $rowsC '910'
    ($null -ne $t) -and ($t.holds_today_gate -eq $true) -and
    ("$($t.today_release_reason)" -eq 'holding:exhaustion_expired') -and (DeferredHeld $rowsC)
  }

  # --- D: EDITING `## Today` REVOKES IT ------------------------------------------------------
  # The part of the release signal the agent does NOT author. "I examined everything Today
  # holds" is a claim about the board; the human revokes it by editing the board, without
  # knowing this file exists. Run with a long TTL so this arm cannot pass for arm C's reason.
  $rowsD = @()
  try {
    [IO.File]::WriteAllText($box.board,
      $boardText.Replace('| 910 |  | standing today task | - | 2026-08-31 |  |',
        "| 910 |  | standing today task | - | 2026-08-31 |  |`r`n| 914 |  | a row Shiv just added | - | 2026-09-01 |  |"), $utf8)
    Set-Row -TurnMinutesAgo 90 -DeclMinutesAgo 60
    $rowsD = Rows @('-ExhaustionTtlMinutes', '120')
  }
  finally { [IO.File]::WriteAllText($box.board, $boardText, $utf8) }
  Check 'D editing the Today section revokes the declaration' {
    $t = Row $rowsD '910'
    ($null -ne $t) -and ($t.holds_today_gate -eq $true) -and
    ("$($t.today_release_reason)" -eq 'holding:exhaustion_stale_board') -and (DeferredHeld $rowsD)
  }

  # --- E: A LATER TURN REFUTES IT ------------------------------------------------------------
  # What makes the declaration awkward to make falsely: declare the row exhausted and then keep
  # writing work into it, and your own record contradicts you. Turn is AFTER the declaration.
  Set-Row -TurnMinutesAgo 50 -DeclMinutesAgo 60
  $rowsE = Rows @('-ExhaustionTtlMinutes', '120')
  Check 'E a turn written after the declaration refutes it' {
    $t = Row $rowsE '910'
    ($null -ne $t) -and ($t.holds_today_gate -eq $true) -and
    ("$($t.today_release_reason)" -eq 'holding:exhaustion_superseded') -and (DeferredHeld $rowsE)
  }

  # --- F: A DECLARATION THAT NAMES NOTHING IS REFUSED ----------------------------------------
  # "Exhausted" is a claim about a set. A claim naming no set asserts nothing, and would be a
  # shrug carrying the authority of a decision. Asserted on the WRITE path (the command fails
  # and records nothing) so it cannot pass for a gate-reader's reason.
  Set-Row -TurnMinutesAgo 0
  $fOk = Oa-Ok @('mark', '-Id', '910', '-Exhausted', ' , ; ')
  Check 'F a declaration naming nothing is refused' { (-not $fOk) -and (-not (HasDeclaration)) }

  # --- G: A DECLARATION CANNOT RIDE ON A TURN ------------------------------------------------
  # The structural half of the #310 fix. The act that RELEASES the gate must not be able to
  # travel inside the act that WRITES a turn, or writing releases by accident again -- just with
  # an extra argument. Two deliberate calls, or nothing.
  Set-Row -TurnMinutesAgo 0
  $gOk = Oa-Ok @('mark', '-Id', '910', '-Status', 'in-progress', '-Exhausted', 'gh:197')
  Check 'G a declaration cannot ride along on a turn' { (-not $gOk) -and (-not (HasDeclaration)) }

  # --- H: YOU CANNOT DECLARE A ROW THIS RUN HAS NOT WORKED -----------------------------------
  # Writing a turn is now NECESSARY BUT NOT SUFFICIENT -- the exact inversion of the defect,
  # where it was sufficient. Both halves of the one precondition are exercised: a row with no
  # recorded turn at all (the state a `seed` leaves behind, which is what survives of the old
  # "seed is not a turn" arm), and a row whose last turn is far older than this run.
  Set-Row -TurnMinutesAgo -1
  $hNever = Oa-Ok @('mark', '-Id', '910', '-Exhausted', 'gh:197,gh:179')
  $hNeverRecorded = HasDeclaration
  Set-Row -TurnMinutesAgo 600
  $hStale = Oa-Ok @('mark', '-Id', '910', '-Exhausted', 'gh:197,gh:179')
  Check 'H a row this run has not worked cannot be declared exhausted' {
    (-not $hNever) -and (-not $hNeverRecorded) -and (-not $hStale) -and (-not (HasDeclaration))
  }

  # --- I: A LIVE REPLY RECLAIMS EXCLUSIVITY --------------------------------------------------
  # Keeps the fix from trading one silent failure for another: a standing declaration must never
  # mute a Today task the user has just replied to. Dropping the user's own input is strictly
  # worse than making them wait. `mark` stamped the turn terminator, so prose below it is theirs.
  $rowsI = @()
  try {
    [IO.File]::WriteAllText($p910, ($quiet910 + "`n`n## 2026-08-31`n`n<!-- from: me -->`nactually do this one first`n"), $utf8)
    Set-Row -TurnMinutesAgo 90 -DeclMinutesAgo 60
    $rowsI = Rows @('-ExhaustionTtlMinutes', '120')
  }
  finally { [IO.File]::WriteAllText($p910, $quiet910, $utf8) }
  Check 'I a live reply reclaims Today exclusivity' {
    $t = Row $rowsI '910'
    ($null -ne $t) -and ($t.reopened -eq $true) -and ($t.eligible -eq $true) -and
    ($t.holds_today_gate -eq $true) -and
    ("$($t.today_release_reason)" -eq 'holding:reopened') -and (DeferredHeld $rowsI)
  }

  # --- J: THE STRICT ROLLBACK HOLDS EVERYTHING -----------------------------------------------
  # The escape hatch is real, not decorative: one flag restores the original workability gate, so
  # this whole design is revertible without a redeploy. Set up with a declaration that WOULD
  # release, so the arm can only pass because the flag was honoured.
  Set-Row -TurnMinutesAgo 1 -DeclMinutesAgo 0
  $rowsJ = Rows @('-TodayGateStrict')
  Check 'J the strict rollback flag holds the gate regardless' {
    $t = Row $rowsJ '910'
    ($null -ne $t) -and ($t.holds_today_gate -eq $true) -and
    ("$($t.today_release_reason)" -eq 'holding:strict') -and (DeferredHeld $rowsJ)
  }

  # --- K: A WEDGED RUN RELEASES (BACKSTOP) ---------------------------------------------------
  # The #223 clause that was never implemented -- "assuming there is still plenty of time before
  # the next scheduled automation" -- as a backstop rather than as the rule. Keyed to STALENESS,
  # never recency: it fires because nobody has written here for hours, and any turn RESETS it.
  # There is therefore no path from typing to a release, which is what arm A depends on.
  Set-Row -TurnMinutesAgo 420
  $rowsK = Rows
  Check 'K a wedged run releases via the staleness backstop' {
    $t = Row $rowsK '910'
    ($null -ne $t) -and ($t.holds_today_gate -eq $false) -and
    ("$($t.today_release_reason)" -eq 'stale_turn_backstop') -and (DeferredOpen $rowsK)
  }

  # --- L: A TERMINAL TODAY ROW DOES NOT HOLD -------------------------------------------------
  # The original #223 release, still intact underneath all of the above: a Today row that is
  # actually finished stops being exclusive without anyone having to declare anything.
  Set-Row -TurnMinutesAgo 0 -Status 'done'
  $rowsL = Rows
  Check 'L a terminal Today row does not hold the gate' {
    $t = Row $rowsL '910'
    ($null -ne $t) -and ($t.holds_today_gate -eq $false) -and
    ("$($t.today_release_reason)" -eq 'not_workable') -and (DeferredOpen $rowsL)
  }

  Remove-Item $box.root -Recurse -Force -ErrorAction SilentlyContinue
  return $r
}

# --- the mutants ---------------------------------------------------------------------------
# Each is a literal patch of the real oa-state.ps1. `Count` is asserted, so a mutant whose
# target text has drifted fails loudly instead of silently becoming a no-op that "nothing kills".
$Mutants = [ordered]@{
  'M1  recency release restored (#310)' = @{
    kills = 'A'
    edits = @(
      @{ find  = '  $claim = Test-ExhaustionClaim $row.exhaustion $row $todayHash'
         with  = '  if ($row.last_turn_at) { $rt = [datetime]::MinValue; if ([datetime]::TryParse("$($row.last_turn_at)", [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::None, [ref]$rt)) { if (((Get-Date) - $rt).TotalMinutes -lt 5) { return [pscustomobject]@{ holds = $false; reason = ''served'' } } } }' + "`r`n" + '  $claim = Test-ExhaustionClaim $row.exhaustion $row $todayHash'
         count = 1 })
  }
  'M2  declaration release deleted' = @{
    kills = 'B'
    edits = @(
      @{ find = "  if (`$claim -eq 'declared_exhausted') {"; with = '  if ($false) {'; count = 1 })
  }
  'M3  TTL check deleted' = @{
    kills = 'C'
    edits = @(
      @{ find = "  if (((Get-Date) - `$at).TotalMinutes -ge `$ExhaustionTtlMinutes) { return 'holding:exhaustion_expired' }"
         with = '  # mutant: TTL check removed'; count = 1 })
  }
  'M4  board-hash check deleted' = @{
    kills = 'D'
    edits = @(
      @{ find = "  if (`"`$(`$ex.today_hash)`" -ne `$todayHash) { return 'holding:exhaustion_stale_board' }"
         with = '  # mutant: board-hash check removed'; count = 1 })
  }
  'M5  supersede check deleted' = @{
    kills = 'E'
    edits = @(
      @{ find = "      if (`$lt -gt `$at) { return 'holding:exhaustion_superseded' }"
         with = '      # mutant: supersede check removed'; count = 1 })
  }
  'M6  name-what-you-examined guard deleted' = @{
    kills = 'F'
    edits = @(
      @{ find = '  if ($examined.Count -eq 0) {'; with = '  if ($false) {'; count = 2 })
  }
  'M7  separate-call guard deleted' = @{
    kills = 'G'
    edits = @(
      @{ find = '  if ($Status -or $Version -gt 0 -or $PlanId -or $Poll -or $PollDone -or $PollClear -or'
         with = '  if ($false -and ($Status -or $Version -gt 0 -or $PlanId -or $Poll -or $PollDone -or $PollClear -or'
         count = 1 }
      @{ find = '      $Recheck -or $RecheckKind -or $RecheckDone -or $RecheckClear) {'
         with = '      $Recheck -or $RecheckKind -or $RecheckDone -or $RecheckClear)) {'
         count = 1 })
  }
  'M8  worked-it-first precondition deleted' = @{
    kills = 'H'
    edits = @(
      @{ find = '  if (-not $hasTurn -or ((Get-Date) - $lt).TotalMinutes -ge $ExhaustionTtlMinutes) {'
         with = '  if ($false) {'; count = 1 })
  }
  'M9  reopened branch deleted' = @{
    kills = 'I'
    edits = @(
      @{ find = "  if (`$row.reopened) {`r`n    return [pscustomobject]@{ holds = `$true; reason = 'holding:reopened' }`r`n  }"
         with = '  # mutant: reopened branch removed'; count = 1 })
  }
  'M10 strict rollback flag ignored' = @{
    kills = 'J'
    edits = @(
      @{ find = '  if ($script:TodayGateIsStrict) {'; with = '  if ($false) {'; count = 1 })
  }
  'M11 staleness backstop disabled' = @{
    kills = 'K'
    edits = @(
      @{ find = '      if (((Get-Date) - $t).TotalHours -ge $TodayGateBackstopHours) {'
         with  = '      if (((Get-Date) - $t).TotalHours -ge 999999) {'; count = 1 })
  }
  'M12 workability check deleted' = @{
    kills = 'L'
    edits = @(
      @{ find = '  if (-not (Test-Workable $row)) {'; with = '  if ($false) {'; count = 1 })
  }
}

function Test-MutantTargets {
  # Do the mutants still have something to bite? Pure string matching against a file already in
  # memory: no subprocesses, so this is free and runs on EVERY invocation.
  #
  # IT DID NOT USE TO. The count assertion lived only inside New-Mutant, which is reached only
  # under -Matrix -- so a default run printed "12 passed, 0 failed" while every mutant had
  # silently become a no-op, because someone had reformatted a line in oa-state.ps1 that a
  # mutant matches verbatim. The arms would still pass, since they test the REAL script and it
  # still works; what rots is the proof that the arms are load-bearing at all, which is this
  # file's entire stated value.
  #
  # That is the failure class of "an assertion whose domain is narrower than its report implies",
  # and it is nastier than a vacuous pass because it has NO TELL: every fixture is non-empty,
  # every number is correct, the exit code is right, and the summary line implies a check that
  # was never run. Reporting it up front, unconditionally, is the only thing that closes it --
  # a drift check that is itself opt-in has exactly the same defect one level up.
  # Sets $script:MutantTargetsOk rather than RETURNING a verdict, deliberately. A PowerShell
  # function emits its bare strings and its return value into the same stream, so
  # `$ok = Test-MutantTargets` would swallow every diagnostic line into the variable and leave
  # the caller holding an array that is truthy no matter what the check found. Caught here by
  # reading the output instead of trusting exit code 0 -- which is the same lesson this whole
  # file is about.
  param()
  $script:MutantTargetsOk = $true
  $text = [IO.File]::ReadAllText($ScriptPath)
  $drifted = @()
  foreach ($mName in $Mutants.Keys) {
    foreach ($e in $Mutants[$mName].edits) {
      $n = ([regex]::Matches($text, [regex]::Escape($e.find))).Count
      if ($n -ne $e.count) { $drifted += "$mName -- expected $($e.count) occurrence(s) of its target, found $n" }
    }
  }
  if ($drifted.Count -gt 0) {
    $script:MutantTargetsOk = $false
    "MUTANT TARGETS HAVE DRIFTED - the arms below prove nothing about these mutants:"
    foreach ($d in $drifted) { "  $d" }
    "Re-point each mutant at the current source, or the bijection is unverifiable."
    ""
    return
  }
  "  targets OK  $($Mutants.Count) mutants still match the source"
  ""
}

function New-Mutant {
  param([string]$Name, $Spec)
  $text = [IO.File]::ReadAllText($ScriptPath)
  foreach ($e in $Spec.edits) {
    # Re-asserted here as well as in the pre-flight: this is the site that would silently produce
    # an identical-to-original "mutant" and report it unkilled, so it must not depend on a caller
    # having run the check first.
    $n = ([regex]::Matches($text, [regex]::Escape($e.find))).Count
    if ($n -ne $e.count) {
      throw "mutant '$Name': expected $($e.count) occurrence(s) of its target, found $n -- the source has drifted and this mutant would be a silent no-op"
    }
    $text = $text.Replace($e.find, $e.with)
  }
  $out = Join-Path ([IO.Path]::GetTempPath()) ("oa-mutant-" + [guid]::NewGuid().ToString('N').Substring(0, 8) + '.ps1')
  # WITH a BOM: oa-state.ps1 has one, and stripping it would make PowerShell 5.1 decode the file
  # as the ANSI codepage -- the mutant would then differ from the original in a second, unrelated
  # way and the matrix would be measuring the wrong thing.
  [IO.File]::WriteAllText($out, $text, (New-Object Text.UTF8Encoding($true)))
  return $out
}

# --- run -----------------------------------------------------------------------------------
# The pre-flight runs FIRST and unconditionally, so its verdict is visible next to the arm
# results rather than buried behind a flag nobody passes.
#
# Skipped only under -ExpectPreFix, where the script under test is a DIFFERENT (older) build by
# construction and its targets are expected not to match -- reporting drift there would be a
# guaranteed false alarm on every run, which is how a check gets ignored.
$script:MutantTargetsOk = $true
if (-not $ExpectPreFix) { Test-MutantTargets }

$results = Invoke-Arms $ScriptPath
$pass = 0; $fail = 0
foreach ($k in $results.Keys) {
  if ($results[$k]) { "  PASS  $k"; $pass++ } else { "  FAIL  $k"; $fail++ }
}
""
"$pass passed, $fail failed  (script: $ScriptPath)"

if ($ExpectPreFix) {
  if ($fail -eq 0) { "MUTCHECK FAILED: pre-fix script passed everything - the fix guards nothing."; exit 1 }
  "MUTCHECK OK: pre-fix script fails $fail arm(s), as required."
  exit 0
}

if ($fail -gt 0) { exit 1 }
# Drifted targets are a FAILURE, not a warning. Green arms plus dead mutants is precisely the
# state this file exists to make impossible.
if (-not $script:MutantTargetsOk) { exit 1 }

if (-not $Matrix) { exit 0 }

# --- the bijection, asserted rather than claimed --------------------------------------------
""
"ARM x MUTANT MATRIX  ('x' = arm fails, i.e. it kills that mutant)"
""
$armKeys = @($results.Keys)
$armLetters = @($armKeys | ForEach-Object { $_.Substring(0, 1) })
("  {0,-42}  {1}" -f 'mutant', ($armLetters -join ' '))
("  {0,-42}  {1}" -f ('-' * 42), (($armLetters | ForEach-Object { '-' }) -join ' '))

$bijectionOk = $true
foreach ($mName in $Mutants.Keys) {
  $spec = $Mutants[$mName]
  $mPath = New-Mutant $mName $spec
  try { $mRes = Invoke-Arms $mPath } finally { Remove-Item $mPath -Force -ErrorAction SilentlyContinue }
  $cells = @()
  $killers = @()
  for ($i = 0; $i -lt $armKeys.Count; $i++) {
    $k = $armKeys[$i]
    $failed = -not $mRes[$k]
    $cells += $(if ($failed) { 'x' } else { '.' })
    if ($failed) { $killers += $armLetters[$i] }
  }
  $verdict = ''
  if ($killers.Count -eq 0) { $verdict = '  <-- KILLED BY NOTHING'; $bijectionOk = $false }
  elseif ($killers.Count -gt 1) { $verdict = "  <-- KILLED BY $($killers.Count): $($killers -join ',')"; $bijectionOk = $false }
  elseif ($killers[0] -ne $spec.kills) { $verdict = "  <-- expected $($spec.kills), killed by $($killers[0])"; $bijectionOk = $false }
  ("  {0,-42}  {1}{2}" -f $mName, ($cells -join ' '), $verdict)
}
""
if (-not $bijectionOk) {
  "MATRIX FAILED: the arm/mutant mapping is not a strict bijection."
  exit 1
}
"MATRIX OK: $($Mutants.Count) mutants, $($armKeys.Count) arms, each mutant killed by exactly one arm."
exit 0
