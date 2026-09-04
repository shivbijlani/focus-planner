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
    COUNTS      anything unreadable or unexpected               (#462: unknown must not free a slot)

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
$journalParked = @'
# Task {ID}: fixture

## 2026-09-04

## 🌙 Overnight Agent
<!-- from: overnight-agent -->

**Status:** In progress - fixture.

**Needs from you:** please confirm the approach before I continue.

<!-- /overnight-agent turn-end -->
'@

$journalAnswered = $journalParked + "`r`n`r`nyes go ahead, that sounds right`r`n"

function Add-Task {
  param($World, [string]$Id, [string]$Status = 'in-progress', [switch]$NoSession,
    [string]$Journal = $journalParked, $Poll = $null, [switch]$NoJournal)
  $st = [ordered]@{ id = $Id; status = $Status; version = 1 }
  if (-not $NoSession) {
    $st.session = [ordered]@{
      session_id = "S-$Id"; kind = 'code'; project = 'p'
      workspace = "V:\wt\$Id"; workspace_type = 'worktree'
      created_at = '2026-09-04T06:00:00-07:00'; last_woken_at = ''
      state = 'live'; prior_session_id = ''; replaced_at = ''
    }
  }
  if ($Poll) { $st.poll = $Poll }
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

function Measure-InFlight([string]$Script, $World) {
  $out = & powershell -NoProfile -ExecutionPolicy Bypass -File $Script session -InFlight `
    -StateDir $World.State -JournalDir $World.Journal 2>$null
  try { return [int](($out | ConvertFrom-Json).in_flight) } catch { return -1 }
}

$expected = [ordered]@{ A = 1; B = 0; C = 1; D = 1; E = 0; F = 1; G = 0 }
$why = [ordered]@{
  A = 'an ordinary workable task holds a slot'
  B = 'parked on a reply with no timer holds nothing (#487)'
  C = 'a trailing user reply un-parks and reclaims the slot'
  D = 'a due poll is real work and holds the slot'
  E = 'a terminal task holding a live session is a leak'
  F = 'unknown COUNTS -- it must never free a slot'
  G = 'no session, nothing to count'
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
  @{ n = 'terminal arm removed'; guards = 'E'
    find = '  if ($script:ClosedStatus -contains $status) { return $false }'
    repl = '  if ($false) { return $false }' }
  @{ n = 'awaiting_reply skip removed (the #487 bug, restored)'; guards = 'B'
    find = '    if ($awaiting) { return $false }'
    repl = '    if ($false -and $awaiting) { return $false }' }
  @{ n = 'trailing-user term dropped from the awaiting expression'; guards = 'C'
    find = '    $awaiting = [bool]($facts.HasAgentBlock -and $facts.HasBlockingAsk -and -not $facts.HasTrailingUser)'
    repl = '    $awaiting = [bool]($facts.HasAgentBlock -and $facts.HasBlockingAsk)' }
  @{ n = 'due-timer override removed'; guards = 'D'
    find = '    if ((Test-PollDue $poll) -or (Test-PollDue $recheck)) { return $true }'
    repl = '    if ($false) { return $true }' }
  @{ n = 'unknown journal FREES a slot instead of holding it (#462 inverted)'; guards = 'F'
    find = '    if (-not (Test-Path $jp)) { return $true }   # cannot read -> count it'
    repl = '    if (-not (Test-Path $jp)) { return $false }' }
)

Write-Host ''
Write-Host '== mutations (each killed by exactly one arm) =='
foreach ($m in $mutations) {
  if ($src.IndexOf($m.find) -lt 0) {
    Check "$($m.n): anchor present in source" $false "not found: $($m.find)"
    continue
  }
  $mutPath = Join-Path $root ("oa-state-mut-" + $m.guards + ".ps1")
  [IO.File]::WriteAllText($mutPath, $src.Replace($m.find, $m.repl), (New-Object Text.UTF8Encoding($false)))

  $moved = @()
  foreach ($k in $worlds.Keys) {
    $got = Measure-InFlight $mutPath $worlds[$k]
    if ($got -lt 0) { Check "$($m.n): mutant runs on world $k" $false 'unparseable output'; continue }
    if ($got -ne $base[$k]) { $moved += $k }
  }
  Check "$($m.n) -> world $($m.guards) moves (arm is load-bearing)" ($moved -contains $m.guards) "moved: $($moved -join ',')"
  $extra = @($moved | Where-Object { $_ -ne $m.guards })
  Check "$($m.n): changes nothing else" ($extra.Count -eq 0) "also moved: $($extra -join ',')"
}

Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue
Write-Host ''
Write-Host "$pass passed, $fail failed"
exit $(if ($fail) { 1 } else { 0 })
