<#
  mutcheck-parked-capacity.ps1 -- proves every arm of Test-SessionHoldsCapacity is load-bearing.

  WHY THIS FILE EXISTS (GH #487)
  ------------------------------
  `Get-LiveSessionCount` counted every task whose session state was `live`, with no test of
  whether that task could actually be worked. Measured on the live store 2026-09-04 07:45 PT:

      concurrency 1 (default) | in_flight 2 | at_capacity true | admits 0
        #466  live session, being worked
        #468  live session, NEVER WOKEN (last_woken_at ""), awaiting_reply TRUE

  A task parked on a human reply held the only capacity slot, so the run could dispatch
  nothing, and nothing self-heals -- `admits` stays 0 until the user happens to reply.
  SKILL.md PHASE 1 step 6 forbids releasing the binding while a task is `in-progress`, so the
  contract holds the slot open and the accounting counted it.

  It is the Today-gate bug one level down. There, one unanswered row froze the whole Deferred
  backlog; the fix was `Test-Workable`, which treats `awaiting_reply` as a waiting state. The
  capacity accounting never got the same treatment, and the two readers disagreed -- the very
  signal that says "this task cannot be worked" was the one leaving its session holding the slot.

  WHAT MUST NOT REGRESS, AND WHY EACH ARM IS HERE
  ----------------------------------------------
  The dangerous direction is NOT under-counting a parked task; it is OVER-releasing capacity so
  two sessions race one workspace, which is the isolation failure #404 exists to prevent. So the
  overrides matter as much as the skip:

    COUNTS      an ordinary workable task                       (the whole point of a limit)
    SKIPS       awaiting_reply with no due timer                (#487, the bug)
    COUNTS      awaiting_reply + a trailing user reply          (#223 rule 4: a reply un-parks)
    COUNTS      awaiting_reply + a due poll                     (read-only work needs no reply)
    SKIPS       a terminal task holding a live session          (pure leak)
    SKIPS       a `blocked` or `proposed` task                  (#541, the bug: waiting on a human)
    COUNTS      `blocked` + a due RECHECK                       (the one blocked row that IS workable)
    SKIPS       `blocked` + a due POLL                          (a poll never unblocks the status gate)
    COUNTS      anything unreadable or unexpected               (#462: unknown must not free a slot)

  THE THIRD INSTANCE (GH #541), AND WHY THE GUARD PINS AN INVARIANT INSTEAD
  ------------------------------------------------------------------------
  Same defect, third surface. Measured 2026-09-05 18:22 PT: Shiv paused task #468, the run
  recorded it as `mark -Id 468 -Status blocked -StatusBy user`, and immediately

      scan -> 249 rows, 6 ELIGIBLE   |   session -InFlight -> in_flight 1, admits 0

  -- one user pause froze the entire board. Three instances of one shape argue for pinning the
  RULE rather than the instance, so the arms below assert the agreement itself: every status
  `Test-Workable` calls unworkable must be uncounted here, unless a due timer overrides it, and
  the timer must override in exactly the cases Test-Workable overrides it (recheck on `blocked`,
  and nothing else). Worlds P/Q/S/T are the negative half of that; R is the positive half.

  Read-only: builds throwaway state/journal dirs under TEMP and drives the REAL script through
  its own -StateDir/-JournalDir parameters. Never touches the live store.
#>
[CmdletBinding()]
param(
  # Resolved in the BODY, not here: under `powershell -File` the param-default expression is
  # evaluated before $PSScriptRoot is populated, so a Join-Path default throws on an empty path.
  [string]$ScriptPath
)

$ErrorActionPreference = 'Stop'
if (-not $ScriptPath) {
  $here = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
  $ScriptPath = Join-Path $here 'oa-state.ps1'
}
if (-not (Test-Path $ScriptPath)) { Write-Host "FAIL cannot find oa-state.ps1 at $ScriptPath"; exit 2 }

$src = [IO.File]::ReadAllText($ScriptPath, (New-Object Text.UTF8Encoding($false)))
$root = Join-Path $env:TEMP ('mutcheck-cap-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$pass = 0; $fail = 0

function Check([string]$label, [bool]$cond, [string]$detail) {
  if ($cond) { $script:pass++; Write-Host "  PASS  $label" }
  else { $script:fail++; Write-Host "  FAIL  $label$(if ($detail) { " -- $detail" })" }
}

# --- fixture world -----------------------------------------------------------------------
function New-World([string]$name) {
  $w = Join-Path $root $name
  $sd = Join-Path $w 'state'; $jd = Join-Path $w 'journal'
  New-Item -ItemType Directory -Force -Path $sd, $jd | Out-Null
  return [pscustomobject]@{ State = $sd; Journal = $jd }
}

# A journal whose newest agent turn carries an open ask and has NO trailing user prose is what
# the scan row calls `awaiting_reply`. Written to match that expression, not a paraphrase of it.
# The agent-block heading carries U+1F319 in real journals, and Get-JournalFacts keys on it.
# Built from its code point rather than typed literally so this file stays pure ASCII: a
# BOM-less .ps1 containing non-ASCII is mangled by PowerShell 5.1 before it runs, which
# `ps1-encoding-sweep` refuses (and it caught this file). Every sibling mutcheck here is
# BOM-less, so matching that convention is what keeps the guard honest.
$moon = [char]::ConvertFromUtf32(0x1F319)

$journalParked = @"
# Task {ID}: fixture

## 2026-09-04

## $moon Overnight Agent
<!-- from: overnight-agent -->

**Status:** In progress - fixture.

**Needs from you:** please confirm the approach before I continue.

<!-- /overnight-agent turn-end -->
"@

$journalAnswered = $journalParked + "`r`n`r`nyes go ahead, that sounds right`r`n"

function Add-Task {
  param($World, [string]$Id, [string]$Status = 'in-progress', [switch]$NoSession,
    [string]$Journal = $journalParked, $Poll = $null, [switch]$NoJournal, $Doc = $null, [string]$Woken = '',
    $Recheck = $null)
  $st = [ordered]@{ id = $Id; status = $Status; version = 1 }
  if (-not $NoSession) {
    $st.session = [ordered]@{
      session_id = "S-$Id"; kind = 'code'; project = 'p'
      workspace = "V:\wt\$Id"; workspace_type = 'worktree'
      created_at = '2026-09-04T06:00:00-07:00'; last_woken_at = $Woken
      state = 'live'; prior_session_id = ''; replaced_at = ''
    }
  }
  if ($Poll) { $st.poll = $Poll }
  if ($Recheck) { $st.recheck = $Recheck }
  if ($Doc) { $st.doc = $Doc }
  ($st | ConvertTo-Json -Depth 8) | Set-Content (Join-Path $World.State "task-$Id.json") -Encoding UTF8
  if (-not $NoJournal) {
    $Journal.Replace('{ID}', $Id) | Set-Content (Join-Path $World.Journal "task-$Id.md") -Encoding UTF8
  }
}

$duePoll = [ordered]@{ cadence = '2h'; interval_minutes = 120
  last_polled = (Get-Date).AddHours(-3).ToString('yyyy-MM-ddTHH:mm:sszzz')
  next_due = (Get-Date).AddHours(-1).ToString('yyyy-MM-ddTHH:mm:sszzz')
}

# Each world isolates ONE arm, so a count of 1 vs 0 is unambiguous about which arm moved.
$worlds = [ordered]@{}
# A -- an ordinary workable task. The limit must still work; this is the control.
$worlds.A = New-World 'A'; Add-Task $worlds.A '901' -Journal "# Task 901`r`n`r`n- notes`r`n"
# B -- THE BUG. Parked on a reply, no timer. Must not hold a slot.
$worlds.B = New-World 'B'; Add-Task $worlds.B '902'
# C -- parked, but the user replied. A reply un-parks (#223 rule 4), so it holds a slot again.
$worlds.C = New-World 'C'; Add-Task $worlds.C '903' -Journal $journalAnswered
# D -- parked, but a poll is due. Read-only work needs no reply, so it is real work in flight.
$worlds.D = New-World 'D'; Add-Task $worlds.D '904' -Poll $duePoll
# E -- terminal task still holding a live session. Pure leak; must not hold a slot. Its journal
# is deliberately NOT the parked one: with a parked journal the awaiting arm excludes it too, so
# the terminal arm reads as load-bearing when it is masked. Mutation caught exactly that.
$worlds.E = New-World 'E'; Add-Task $worlds.E '905' -Status 'done' -Journal "# Task 905`r`n`r`n- done`r`n"
# F -- live session, journal missing. Unknown must COUNT, never free a slot (#462).
$worlds.F = New-World 'F'; Add-Task $worlds.F '906' -NoJournal
# G -- no session at all. Baseline: nothing to count, under every mutation.
$worlds.G = New-World 'G'; Add-Task $worlds.G '907' -NoSession

# --- GH #500: the DOC surface of the same defect -------------------------------------------
# These use the #425 POINTER journal, whose ask is dismissive by construction. That is the whole
# point: `awaiting_reply` is correctly FALSE for it (arms L1/L2/Q/R of mutcheck-awaiting-reply
# pin that, and the Today gate depends on it), so none of the arms above can park these. If a
# doc world ever parks because of the awaiting arm instead, the fixture has stopped testing #500.
$journalPointer = @"
# Task {ID}: fixture

## 2026-09-04

## $moon Overnight Agent
<!-- from: overnight-agent -->

**Status:** In progress - fixture.

Catch-up doc: https://docs.google.com/document/d/DOC_FIXTURE/edit

**Needs from you:** nothing blocking - read and comment.

<!-- /overnight-agent turn-end -->
"@

function New-Doc([int]$Pending, $ObservedAt) {
  $ids = @(); for ($i = 0; $i -lt $Pending; $i++) { $ids += "CID$i" }
  return [ordered]@{
    doc_id = 'DOC_FIXTURE'; doc_url = 'https://docs.google.com/document/d/DOC_FIXTURE/edit'
    bound_at = '2026-09-04T06:00:00-07:00'; seen_ids = @('OLD1'); pending_ids = $ids
    observed_at = $ObservedAt
  }
}
$freshObs = (Get-Date).AddMinutes(-10).ToString('yyyy-MM-ddTHH:mm:sszzz')
$staleObs = (Get-Date).AddHours(-30).ToString('yyyy-MM-ddTHH:mm:sszzz')
$freshWake = (Get-Date).AddMinutes(-2).ToString('yyyy-MM-ddTHH:mm:sszzz')
$staleWake = (Get-Date).AddHours(-6).ToString('yyyy-MM-ddTHH:mm:sszzz')

# H -- THE BUG (#500). Doc-bound, channel read 10 min ago, zero new comments, pointer ask. It
# cannot progress without a human and nothing else parks it, so it must hold NO slot.
$worlds.H = New-World 'H'
Add-Task $worlds.H '908' -Journal $journalPointer -Doc (New-Doc 0 $freshObs)
# I -- same row, but he HAS commented. A pending comment is the doc-surface analogue of
# `reopened`: real work is waiting, so it holds a slot.
$worlds.I = New-World 'I'
Add-Task $worlds.I '909' -Journal $journalPointer -Doc (New-Doc 2 $freshObs)
# J -- THE TRAP. Doc-bound, zero pending -- but last observed 30h ago. Zero here may mean "the
# channel is dead" rather than "he said nothing", and those are byte-identical (#346). Must NOT
# park: fail toward working the task, never toward silence nobody confirmed.
$worlds.J = New-World 'J'
Add-Task $worlds.J '910' -Journal $journalPointer -Doc (New-Doc 0 $staleObs)
# K -- never observed at all (empty observed_at), which is what a task reports before its first
# -Observe. Same reasoning as J, reached by the other route.
$worlds.K = New-World 'K'
Add-Task $worlds.K '911' -Journal $journalPointer -Doc (New-Doc 0 '')
# L -- doc-bound, silent, freshly observed AND a due poll. The timer outranks the doc park for
# the same reason it outranks the awaiting park: read-only recurring work needs no reply.
$worlds.L = New-World 'L'
Add-Task $worlds.L '912' -Journal $journalPointer -Doc (New-Doc 0 $freshObs) -Poll $duePoll
# M -- NOT doc-bound, pointer journal. Proves the doc arm keys on the binding rather than on the
# journal shape; without this a mutation deleting the doc_id test could survive.
$worlds.M = New-World 'M'
Add-Task $worlds.M '913' -Journal $journalPointer

# N -- THE BUG (#522). Identical to H in every doc respect, but its session was woken 2 minutes
# ago: a run dispatched it and it is being worked RIGHT NOW. H and N are indistinguishable to the
# doc terms alone, which is the whole defect -- so N must hold a slot where H does not.
$worlds.N = New-World 'N'
Add-Task $worlds.N '914' -Journal $journalPointer -Doc (New-Doc 0 $freshObs) -Woken $freshWake
# O -- the same row with a wake 6 hours old. A stale wake is not evidence anyone is working, so
# this must still park. Without O, a mutation widening the window to "ever woken" survives.
$worlds.O = New-World 'O'
Add-Task $worlds.O '915' -Journal $journalPointer -Doc (New-Doc 0 $freshObs) -Woken $staleWake

# --- GH #541: the STATUS surface -- a task waiting on a human -------------------------------
# Every journal below is the PLAIN one, deliberately: with the parked journal the awaiting arm
# (#487) excludes these too, so the status arm would read as load-bearing while masked. That is
# the same trap world E's comment records, and mutation testing caught it there.
$dueRecheck = [ordered]@{ cadence = '1d'; interval_minutes = 1440
  last_checked = (Get-Date).AddDays(-2).ToString('yyyy-MM-ddTHH:mm:sszzz')
  next_due = (Get-Date).AddHours(-2).ToString('yyyy-MM-ddTHH:mm:sszzz')
}
function New-PlainJournal([string]$Id) { "# Task $Id`r`n`r`n- notes`r`n" }

# P -- THE BUG (#541). Shiv paused it, so the run recorded `status: blocked`. It provably cannot
# progress without him (`Test-Workable` already says `eligible: false`), so it must hold no slot.
# This is the fixture that kills a revert to the `ClosedStatus`-only gate.
$worlds.P = New-World 'P'; Add-Task $worlds.P '916' -Status 'blocked' -Journal (New-PlainJournal '916')
# Q -- the other waiting status. `proposed` is a plan awaiting his approval: same reasoning, and
# without this arm the fix could be narrowed to the single instance and still look guarded.
$worlds.Q = New-World 'Q'; Add-Task $worlds.Q '917' -Status 'proposed' -Journal (New-PlainJournal '917')
# R -- blocked WITH a due recheck. `-Recheck` exists only for a blocked task's blocker, so this is
# the one blocked row Test-Workable calls workable -- and uncounting it would widen dispatch
# (#522's direction). The status arm must not swallow it.
$worlds.R = New-World 'R'
Add-Task $worlds.R '918' -Status 'blocked' -Journal (New-PlainJournal '918') -Recheck $dueRecheck
# S -- blocked with a due POLL and no recheck. Test-Workable yields only the awaiting-reply park
# to `due_poll`, never the status gate, so this stays unworkable and must stay uncounted. Without
# S, widening the override to any due timer survives.
$worlds.S = New-World 'S'
Add-Task $worlds.S '919' -Status 'blocked' -Journal (New-PlainJournal '919') -Poll $duePoll
# T -- `proposed` with a due recheck. The override is keyed on `blocked` for the same reason
# Test-Workable keys it there; dropping that term would let a recheck reanimate any waiting
# status. Nothing else in this file would notice.
$worlds.T = New-World 'T'
Add-Task $worlds.T '920' -Status 'proposed' -Journal (New-PlainJournal '920') -Recheck $dueRecheck

function Measure-InFlight([string]$Script, $World) {
  $out = & powershell -NoProfile -ExecutionPolicy Bypass -File $Script session -InFlight `
    -StateDir $World.State -JournalDir $World.Journal 2>$null
  try { return [int](($out | ConvertFrom-Json).in_flight) } catch { return -1 }
}

$expected = [ordered]@{ A = 1; B = 0; C = 1; D = 1; E = 0; F = 1; G = 0; H = 0; I = 1; J = 1; K = 1; L = 1; M = 1; N = 1; O = 0
  P = 0; Q = 0; R = 1; S = 0; T = 0
}
$why = [ordered]@{
  A = 'an ordinary workable task holds a slot'
  B = 'parked on a reply with no timer holds nothing (#487)'
  C = 'a trailing user reply un-parks and reclaims the slot'
  D = 'a due poll is real work and holds the slot'
  E = 'a terminal task holding a live session is a leak'
  F = 'unknown COUNTS -- it must never free a slot'
  G = 'no session, nothing to count'
  H = 'doc-bound, freshly observed, ZERO comments: cannot progress, holds nothing (#500)'
  I = 'a pending doc comment is real waiting work and holds the slot'
  J = 'zero comments on a STALE observation is not evidence of silence -- must not park'
  K = 'never observed: zero is absence of a reading, not absence of comments'
  L = 'a due poll outranks the doc park, as it outranks the awaiting park'
  M = 'not doc-bound: the pointer journal alone must not park anything'
  N = 'a session woken minutes ago is being worked NOW and holds the slot (#522)'
  O = 'a wake 6h old is not evidence anyone is working: still parks'
  P = 'a task the user PAUSED cannot progress alone and holds no slot (#541)'
  Q = 'a plan awaiting approval is the same waiting state and holds no slot'
  R = 'blocked + a due RECHECK is the one workable blocked row: it holds a slot'
  S = 'a due POLL never unblocks the status gate, so this still parks'
  T = 'the recheck override is keyed on `blocked`: a proposed row still parks'
}

Write-Host '== baseline (real script, unmutated) =='
$base = [ordered]@{}
foreach ($k in $worlds.Keys) {
  $base[$k] = Measure-InFlight $ScriptPath $worlds[$k]
  Check "$k in_flight=$($expected[$k]): $($why[$k])" ($base[$k] -eq $expected[$k]) "got $($base[$k])"
}

# --- mutations ---------------------------------------------------------------------------
# Each replaces exactly one line of the predicate.
$mutations = @(
  @{ n = 'status gate removed entirely'; guards = 'E,P,Q,S,T'
    find = '  if ($script:NonWorkableStatus -contains $status) { return $false }'
    repl = '  if ($false) { return $false }' }
  # --- GH #541 ---------------------------------------------------------------------------
  # The revert. This is the pre-fix line, verbatim: terminal work excluded, the two waiting
  # statuses counted. If this mutant survives, the fix is not guarded.
  @{ n = 'status gate narrowed back to ClosedStatus (the #541 bug, restored)'; guards = 'P,Q,S,T'
    find = '  if ($script:NonWorkableStatus -contains $status) { return $false }'
    repl = '  if ($script:ClosedStatus -contains $status) { return $false }' }
  @{ n = 'the blocked-recheck override removed'; guards = 'R'
    find = '  if ($status -eq ''blocked'' -and (Test-PollDue $recheck)) { return $true }'
    repl = '  if ($false) { return $true }' }
  @{ n = 'the override accepts a due POLL as well, which Test-Workable does not'; guards = 'S'
    find = '  if ($status -eq ''blocked'' -and (Test-PollDue $recheck)) { return $true }'
    repl = '  if (($status -eq ''blocked'') -and ((Test-PollDue $recheck) -or (Test-PollDue $poll))) { return $true }' }
  @{ n = 'the override drops its `blocked` term, so a recheck reanimates any waiting status'; guards = 'T'
    find = '  if ($status -eq ''blocked'' -and (Test-PollDue $recheck)) { return $true }'
    repl = '  if (Test-PollDue $recheck) { return $true }' }
  @{ n = 'awaiting_reply skip removed (the #487 bug, restored)'; guards = 'B'
    find = '    if ($awaiting) { return $false }'
    repl = '    if ($false -and $awaiting) { return $false }' }
  @{ n = 'trailing-user term dropped from the awaiting expression'; guards = 'C'
    find = '    $awaiting = [bool]($facts.HasAgentBlock -and $facts.HasBlockingAsk -and -not $facts.HasTrailingUser)'
    repl = '    $awaiting = [bool]($facts.HasAgentBlock -and $facts.HasBlockingAsk)' }
  @{ n = 'due-timer override removed'; guards = 'D,L'
    find = '    if ((Test-PollDue $poll) -or (Test-PollDue $recheck)) { return $true }'
    repl = '    if ($false) { return $true }' }
  @{ n = 'unknown journal FREES a slot instead of holding it (#462 inverted)'; guards = 'F'
    find = '    if (-not (Test-Path $jp)) { return $true }   # cannot read -> count it'
    repl = '    if (-not (Test-Path $jp)) { return $false }' }
  # --- GH #500 ---------------------------------------------------------------------------
  @{ n = 'doc park removed (the #500 bug, restored)'; guards = 'H,O'
    find = '      if ($pending -eq 0 -and $observedFresh -and -not $wokenRecently) { return $false }'
    repl = '      if ($false) { return $false }' }
  @{ n = 'doc park ignores the freshness of the observation'; guards = 'J,K'
    find = '      if ($pending -eq 0 -and $observedFresh -and -not $wokenRecently) { return $false }'
    repl = '      if ($pending -eq 0 -and -not $wokenRecently) { return $false }' }
  @{ n = 'doc park ignores pending comments'; guards = 'I'
    find = '      if ($pending -eq 0 -and $observedFresh -and -not $wokenRecently) { return $false }'
    repl = '      if ($observedFresh -and -not $wokenRecently) { return $false }' }
  # NOT MUTATED: the `$doc -and "$($doc.doc_id)"` binding test. Removing it moves NOTHING, because
  # an unbound task has no observed_at, so the freshness term already refuses to park it -- world M
  # proves the behaviour, and the missing mutant proves the test is redundant rather than
  # load-bearing. It stays in the source as an explicit statement of intent (this arm is about the
  # doc surface) and for the cost of reading one property, but claiming a mutation kills it would
  # be exactly the decoration-pretending-to-be-a-safeguard this harness already caught once, in
  # the comment above about the deleted "a reply outranks the park" branch.
  # --- GH #522 ---------------------------------------------------------------------------
  @{ n = 'doc park ignores whether a session is actively working it (the #522 bug, restored)'; guards = 'N'
    find = '      if ($pending -eq 0 -and $observedFresh -and -not $wokenRecently) { return $false }'
    repl = '      if ($pending -eq 0 -and $observedFresh) { return $false }' }
  @{ n = 'any wake ever counts as active, however old'; guards = 'O'
    find = '          $wokenRecently = ((Get-Date) - $woke).TotalMinutes -lt $script:ActiveWakeMinutes'
    repl = '          $wokenRecently = $true' }
  @{ n = 'a missing wake stamp reads as ACTIVE, re-opening #487 through the doc branch'; guards = 'H'
    find = '      $wokenRecently = $false'
    repl = '      $wokenRecently = $true' }
)

Write-Host ''
Write-Host '== mutations (each killed by exactly one arm) =='
foreach ($m in $mutations) {
  if ($src.IndexOf($m.find) -lt 0) {
    Check "$($m.n): anchor present in source" $false "not found: $($m.find)"
    continue
  }
  # `guards` may name SEVERAL worlds (comma-separated): one narrowing can be load-bearing for
  # more than one fixture, and collapsing that to a single world would either under-assert the
  # mutation or force two near-identical mutants. Both halves still hold -- every named world must
  # move, and nothing unnamed may.
  $mutPath = Join-Path $root ("oa-state-mut-" + ($m.guards -replace ',', '-') + ".ps1")
  [IO.File]::WriteAllText($mutPath, $src.Replace($m.find, $m.repl), (New-Object Text.UTF8Encoding($false)))

  $want = @($m.guards -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
  $moved = @()
  foreach ($k in $worlds.Keys) {
    $got = Measure-InFlight $mutPath $worlds[$k]
    if ($got -lt 0) { Check "$($m.n): mutant runs on world $k" $false 'unparseable output'; continue }
    if ($got -ne $base[$k]) { $moved += $k }
  }
  $missing = @($want | Where-Object { $moved -notcontains $_ })
  Check "$($m.n) -> world $($m.guards) moves (arm is load-bearing)" ($missing.Count -eq 0) "moved: $($moved -join ',')"
  $extra = @($moved | Where-Object { $want -notcontains $_ })
  Check "$($m.n): changes nothing else" ($extra.Count -eq 0) "also moved: $($extra -join ',')"
}

Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue
Write-Host ''
Write-Host "$pass passed, $fail failed"
exit $(if ($fail) { 1 } else { 0 })
