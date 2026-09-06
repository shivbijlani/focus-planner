<#
  mutcheck-session-pause.ps1 -- proves a user's pause is visible on the DISPATCH path.

  WHY THIS FILE EXISTS (GH #540)
  ------------------------------
  PHASE 1 dispatches a task to its bound sub-session on the strength of
  `oa-state.ps1 session -Id <ID>` alone. That command answered "does a live session exist?" and
  never "is that session allowed to work right now?" -- so a pause the user typed into the
  sub-session was invisible to the run that decides what to wake.

  Measured 2026-09-05 on task #468. Shiv wrote "we need to pause this work for now, i need to
  reboot" at 16:55 and again at 17:11 PT. Then:

      17:35  run 45dcd350  session -Id 468 -> verdict reuse, state live, released false
             -> dispatched a full wake brief; self-retracted at 17:41 only because the run
                happened to read the session's turn history out of band
      18:05  run 0aeff9aa  session -Id 468 -> verdict reuse
             -> dispatched again; the sub-session declined

  Every field those runs read was ACCURATE, which is what makes this a design defect rather than
  a bug in any one of them:

      state: live       a fact about the PROCESS, not about permission
      released: false   only flips when the AGENT tears the binding down
      last_woken_at     records when WE woke it, never what he said afterwards
      awaiting_reply    correctly false -- the agent's last turn asked for nothing, and
                        "nothing was asked" is independent of "the user said stop"

  The composite still read "ready for work", and on a */30 schedule it repeats until a human
  notices. That inverts the safety model used everywhere else in this codebase (#227, #272,
  #465): a human statement outranks agent-authored state and the system fails CLOSED without
  positive evidence. Here an explicit human instruction was not on the read path and the run
  failed OPEN.

  WHAT MUST NOT REGRESS, AND WHY EACH ARM IS HERE
  ----------------------------------------------
  The pause is ONE recorded fact -- `status: blocked` + `status_by: user` -- and every reader
  derives from it. There is deliberately no second `paused` flag to drift out of sync, because
  two readers of one condition disagreeing is the defect this repo has now recorded four times
  (#487, #500, #522, #541). So these arms pin the DERIVATION:

    reuse       an ordinary live session                      (the control)
    paused      user-paused with a live session               (#540, the bug)
    paused      user-paused with NO session                   (`create` is the same bug)
    paused      user-paused with a DEAD session               (`replace` hands over a brief)
    reuse       AGENT-declared blocked                        (a pause is the USER's act)
    reuse       resumed                                       (a reply un-pauses, #170 boundary)
    reuse       user-CLOSED done/skip                         (closed is a different set)
    replace     resumed with a dead session, continuation intact   (nothing is lost by ranking)

  ...and the STAMP, which is a timestamp for that same fact rather than an independent claim:

    preserved   re-marking an already-paused task             (#543: a re-stamp hides staleness)
    cleared     on resume                                     (a stale stamp is a false pause)

  Read-only: builds throwaway state/journal dirs under TEMP and drives the REAL script through
  its own -StateDir/-JournalDir parameters. Never touches the live store.

    powershell -File mutcheck-session-pause.ps1
    powershell -File mutcheck-session-pause.ps1 -ScriptPath <p>   # test another build
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
$root = Join-Path $env:TEMP ('mutcheck-pause-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$pass = 0; $fail = 0

# The agent-block heading carries U+1F319 in real journals and Get-JournalFacts keys on it. Built
# from its code point rather than typed literally so this file stays pure ASCII: a BOM-less .ps1
# containing non-ASCII is mangled by PowerShell 5.1 before it runs, which `ps1-encoding-sweep`
# refuses. Every sibling mutcheck here follows the same convention.
$moon = [char]::ConvertFromUtf32(0x1F319)

function Check([string]$label, [bool]$cond, [string]$detail) {
  if ($cond) { $script:pass++; Write-Host "  PASS  $label" }
  else { $script:fail++; Write-Host "  FAIL  $label$(if ($detail) { " -- $detail" })" }
}

# --- fixture world -----------------------------------------------------------------------
# State files are written DIRECTLY rather than driven through `mark`, so a verdict arm exercises
# exactly one input and one process launch. The two stamp arms below cannot do that -- they are
# about what `mark` writes -- so they drive the real command instead.
function New-World {
  param([string]$Name, [string]$Id, [string]$Status = 'in-progress', [string]$StatusBy = 'agent',
    [ValidateSet('live', 'dead', 'none')][string]$Session = 'live', [switch]$UserReplied)
  $w = Join-Path $root $Name
  $sd = Join-Path $w 'state'; $jd = Join-Path $w 'journal'
  New-Item -ItemType Directory -Force -Path $sd, $jd | Out-Null
  # A stamped agent turn, so `HasTrailingHuman` is FALSE by default -- which is the configuration
  # the bug was measured in. -UserReplied appends a MARKED user message below the turn-end stamp:
  # `HasTrailingHuman` is deliberately the strict reader (`<!-- from: me -->` required, see
  # Test-TrailingHasHuman), because a pause must not be cleared by ambiguous prose.
  $journal = "# Task $Id`: fixture`r`n`r`n## 2026-09-05`r`n`r`n## $moon Overnight Agent`r`n" +
  "<!-- from: overnight-agent -->`r`n`r`n**Status:** In progress - fixture.`r`n`r`n" +
  "<!-- /overnight-agent turn-end -->`r`n"
  if ($UserReplied) { $journal += "`r`n<!-- from: me -->`r`nok go ahead, please carry on`r`n" }
  $journal | Set-Content (Join-Path $jd "task-$Id.md") -Encoding UTF8
  # The FULL field set, not just the ones under test. `mark` assigns to `updated` (and friends)
  # directly, and assigning to a property a hand-built object does not carry THROWS -- the same
  # hazard `Cmd-Session`'s teardown path documents. A fixture missing them fails in a way that
  # looks like a product bug, so it is written complete.
  $st = [ordered]@{
    id = $Id; status = $Status; status_by = $StatusBy; version = 1
    plan_id = "t$Id-v1"; processed_file_hash = ''; has_agent_block = $true
    seeded = $false; updated = '2026-09-05T06:00:00-07:00'
  }
  if ($Session -ne 'none') {
    $st.session = [ordered]@{
      session_id = "S-$Id"; kind = 'folder'; project = 'p'
      workspace = ''; workspace_type = 'folder'
      created_at = '2026-09-05T06:00:00-07:00'; last_woken_at = '2026-09-05T16:08:50-07:00'
      state = $Session; prior_session_id = ''; replaced_at = ''
    }
  }
  ($st | ConvertTo-Json -Depth 8) | Set-Content (Join-Path $sd "task-$Id.json") -Encoding UTF8
  return [pscustomobject]@{ State = $sd; Journal = $jd; Id = $Id }
}

function Measure-Verdict([string]$Script, $World) {
  # A COMPOSITE signature, not just the verdict. A mutation that fixed the verdict string while
  # silently dropping `paused_by_user`, or that started handing out a kickoff brief for work the
  # user stopped, would be invisible to a verdict-only probe.
  $out = & powershell -NoProfile -ExecutionPolicy Bypass -File $Script session -Id $World.Id `
    -StateDir $World.State -JournalDir $World.Journal 2>$null
  try {
    $j = $out | ConvertFrom-Json
    $kick = if ("$($j.kickoff_continuation)") { 'kick' } else { 'nokick' }
    $at = if ("$($j.paused_at)") { 'at' } else { 'noat' }
    return "$($j.verdict)|paused=$([bool]$j.paused_by_user)|$kick|$at"
  }
  catch { return 'ERR' }
}

$worlds = [ordered]@{}
# A -- the control. An ordinary live session must still be reused, or the limit and the whole
# per-task-session contract (#404) stop working.
$worlds.A = New-World 'A' '701'
# B -- THE BUG (#540). He said stop; the session is still live. Must NOT read `reuse`.
$worlds.B = New-World 'B' '702' -Status 'blocked' -StatusBy 'user'
# C -- the AGENT declared blocked. A status alone is not a pause: the agent recording that it is
# stuck on something is not the user withdrawing permission, and conflating them would let the
# agent pause itself out of every dispatch. Keys the fix on `status_by`, not on `status`.
$worlds.C = New-World 'C' '703' -Status 'blocked' -StatusBy 'agent'
# D -- user-paused with NO session. `create` is the same defect wearing the one costume a
# `reuse`-only fix would not cover: starting a brand new session for the task he just stopped.
$worlds.D = New-World 'D' '704' -Status 'blocked' -StatusBy 'user' -Session 'none'
# E -- user-paused with a DEAD session. `replace` is worse than `reuse` here, because it emits a
# ready-to-paste kickoff brief for work that must not start. Hence `nokick` in the signature.
$worlds.E = New-World 'E' '705' -Status 'blocked' -StatusBy 'user' -Session 'dead'
# F -- resumed. The pause MUST be reversible by his say-so, or it becomes #170's defect (work the
# user can never restart). This is the arm that stops the fix being implemented as a closed set.
$worlds.F = New-World 'F' '706' -Status 'approved' -StatusBy 'user'
# G -- user-CLOSED. `done`/`skip` by the user is a different set with different semantics
# (Test-UserClosed). Conflating closed with paused would report every finished task as paused.
$worlds.G = New-World 'G' '707' -Status 'done' -StatusBy 'user'
# H -- `proposed` by the user. The other waiting status, so the fix cannot be narrowed to the one
# instance that was measured and still look guarded.
$worlds.H = New-World 'H' '708' -Status 'proposed' -StatusBy 'user'
# I -- resumed WITH a dead session: `replace` returns AND carries its continuation. This is the
# evidence for ranking `paused` above `replace` -- the verdict is recomputed from state every
# call, so nothing is lost by deferring it, and this arm is what proves that claim.
$worlds.I = New-World 'I' '709' -Status 'approved' -StatusBy 'user' -Session 'dead'
# J -- paused, and HE HAS REPLIED in the journal since. A reply IS the resume (#223 rule 4), and
# without this arm the two readers contradict each other: `Test-Workable` ranks `reopened` above
# its status gate, so the row reads `eligible: true` while the verdict still says `paused` -- a
# task the run may work and may not dispatch, with his reply unable to take effect. That is the
# same two-readers-disagree defect as #487/#500/#541, reintroduced by the fix for #540.
$worlds.J = New-World 'J' '711' -Status 'blocked' -StatusBy 'user' -UserReplied

$expected = [ordered]@{
  A = 'reuse|paused=False|nokick|noat'
  B = 'paused|paused=True|nokick|noat'
  C = 'reuse|paused=False|nokick|noat'
  D = 'paused|paused=True|nokick|noat'
  E = 'paused|paused=True|nokick|noat'
  F = 'reuse|paused=False|nokick|noat'
  G = 'reuse|paused=False|nokick|noat'
  H = 'paused|paused=True|nokick|noat'
  I = 'replace|paused=False|kick|noat'
  J = 'reuse|paused=False|nokick|noat'
}
$why = [ordered]@{
  A = 'an ordinary live session is still reused'
  B = 'user paused it, session live: NOT reuse (#540)'
  C = 'agent-declared blocked is not a pause -- a pause is the USER acting'
  D = 'user paused it, no session: NOT create'
  E = 'user paused it, session dead: NOT replace, and no kickoff brief'
  F = 'resumed: the pause is reversible by his say-so'
  G = 'user-CLOSED done is a different set, not a pause'
  H = 'proposed by the user is the other waiting status'
  I = 'resumed with a dead session: replace returns WITH its continuation'
  J = 'he replied in the journal: the reply IS the resume, so dispatch is allowed again'
}

Write-Host '== baseline (real script, unmutated) =='
$base = [ordered]@{}
foreach ($k in $worlds.Keys) {
  $base[$k] = Measure-Verdict $ScriptPath $worlds[$k]
  Check "$k -> $($expected[$k]): $($why[$k])" ($base[$k] -eq $expected[$k]) "got $($base[$k])"
}

# --- the stamp, which `mark` owns ---------------------------------------------------------
# Separate from the verdict arms because these assert what a SEQUENCE of marks writes, and that
# cannot be expressed as a single pre-built state file.
function Measure-Stamp([string]$Script, [string]$Mode) {
  $w = New-World ('stamp-' + $Mode + '-' + [guid]::NewGuid().ToString('N').Substring(0, 4)) '710'
  # Deliberately no nested helper functions here: a function defined inside a function resolves
  # its free variables dynamically, which made the splatted argument array bind to the wrong
  # scope and pushed the real script's output onto the error stream. Straight-line calls instead.
  $pauseArgs = @('mark', '-Id', '710', '-Status', 'blocked', '-StatusBy', 'user',
    '-StateDir', $w.State, '-JournalDir', $w.Journal)
  $resumeArgs = @('mark', '-Id', '710', '-Status', 'approved', '-StatusBy', 'user',
    '-StateDir', $w.State, '-JournalDir', $w.Journal)
  $peekArgs = @('session', '-Id', '710', '-StateDir', $w.State, '-JournalDir', $w.Journal)

  & powershell -NoProfile -ExecutionPolicy Bypass -File $Script @pauseArgs 2>&1 | Out-Null
  $out = & powershell -NoProfile -ExecutionPolicy Bypass -File $Script @peekArgs 2>&1
  $first = try { "$(($out | ConvertFrom-Json).paused_at)" } catch { '' }
  if (-not $first) { return 'NOSTAMP' }

  if ($Mode -eq 'preserve') {
    # Two seconds is enough: Now-Iso has second resolution, so a re-stamp provably moves the value.
    Start-Sleep -Seconds 2
    & powershell -NoProfile -ExecutionPolicy Bypass -File $Script @pauseArgs 2>&1 | Out-Null
    $out2 = & powershell -NoProfile -ExecutionPolicy Bypass -File $Script @peekArgs 2>&1
    $second = try { "$(($out2 | ConvertFrom-Json).paused_at)" } catch { 'ERR' }
    return $(if ($first -eq $second) { 'preserved' } else { 'restamped' })
  }
  # 'clear': he resumes, so a stamp left behind would report a pause that has ended.
  & powershell -NoProfile -ExecutionPolicy Bypass -File $Script @resumeArgs 2>&1 | Out-Null
  $out3 = & powershell -NoProfile -ExecutionPolicy Bypass -File $Script @peekArgs 2>&1
  $after = try { "$(($out3 | ConvertFrom-Json).paused_at)" } catch { 'ERR' }
  return $(if ($after) { 'kept' } else { 'cleared' })
}

Write-Host ''
Write-Host '== the paused_at stamp (mark) =='
$baseStamp = [ordered]@{
  preserve = (Measure-Stamp $ScriptPath 'preserve')
  clear    = (Measure-Stamp $ScriptPath 'clear')
}
Check 'J re-marking an already-paused task PRESERVES the original stamp (#543 shape)' `
  ($baseStamp.preserve -eq 'preserved') "got $($baseStamp.preserve)"
Check 'K resuming CLEARS the stamp, so a stale one cannot report an ended pause' `
  ($baseStamp.clear -eq 'cleared') "got $($baseStamp.clear)"

# --- the agent may not un-pause itself ----------------------------------------------------
# The arm that stops the whole fix being decorative. The standing procedure marks a status after
# writing a turn, so a session woken BY MISTAKE -- the exact failure #540 records -- would clear
# the pause as a side effect of reporting its own work, and the next run would then see `reuse`
# and dispatch it legitimately. One erroneous wake launders itself into a permanent resume.
function Measure-Refusal([string]$Build, [string]$Mode) {
  $w = New-World ('refuse-' + $Mode + '-' + [guid]::NewGuid().ToString('N').Substring(0, 4)) '712' `
    -Status 'blocked' -StatusBy 'user' -UserReplied:($Mode -eq 'replied')
  $markArgs = @('mark', '-Id', '712', '-Status', 'in-progress',
    '-StateDir', $w.State, '-JournalDir', $w.Journal)
  if ($Mode -eq 'byuser') { $markArgs += @('-StatusBy', 'user') }
  # EAP is relaxed for the call only. With -ErrorActionPreference Stop at script scope, `2>&1`
  # promotes the child's stderr to a TERMINATING error, so a refusal -- the thing under test --
  # would abort the harness instead of being measured.
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $out = & powershell -NoProfile -ExecutionPolicy Bypass -File $Build @markArgs 2>&1
  $code = $LASTEXITCODE
  $ErrorActionPreference = $prevEap
  $text = ($out | Out-String)
  # A refusal must be BOTH a non-zero exit and a nameable token. Exit code alone would be
  # satisfied by an unrelated crash, and #532's lesson is that a command which exits 0 having
  # ignored the caller is indistinguishable afterwards from one never made.
  if ($code -ne 0 -and $text -match 'task_paused_by_user') { return 'refused' }
  if ($code -eq 0) { return 'allowed' }
  return "other:$code"
}

Write-Host ''
Write-Host '== the agent may not un-pause itself =='
$baseRefusal = [ordered]@{
  agent   = (Measure-Refusal $ScriptPath 'agent')
  byuser  = (Measure-Refusal $ScriptPath 'byuser')
  replied = (Measure-Refusal $ScriptPath 'replied')
}
Check 'L an AGENT status change on a paused task is REFUSED, not silently applied' `
  ($baseRefusal.agent -eq 'refused') "got $($baseRefusal.agent)"
Check 'M -StatusBy user is allowed: a run may record HIS decision to resume' `
  ($baseRefusal.byuser -eq 'allowed') "got $($baseRefusal.byuser)"
Check 'N once he has replied the pause is over, so the agent may mark normally again' `
  ($baseRefusal.replied -eq 'allowed') "got $($baseRefusal.replied)"

# --- mutations ---------------------------------------------------------------------------
$mutations = @(
  @{ n = 'the pause check removed (the #540 bug, restored)'; guards = 'B,D,E,H'
    find = '  if (Test-UserPaused $row $journalFacts) { return ''paused'' }'
    repl = '  if ($false) { return ''paused'' }' }
  @{ n = 'the pause check ranked BELOW the create branch, so an unbound paused task reads create'; guards = 'D'
    find = '  if (Test-UserPaused $row $journalFacts) { return ''paused'' }'
    repl = '  if ($sess -and (Test-UserPaused $row $journalFacts)) { return ''paused'' }' }
  @{ n = 'the pause check ranked BELOW the dead branch, so a paused task gets a kickoff brief'; guards = 'E'
    find = '  if (Test-UserPaused $row $journalFacts) { return ''paused'' }'
    repl = '  if ((Test-UserPaused $row $journalFacts) -and "$($sess.state)" -ne ''dead'') { return ''paused'' }' }
  @{ n = 'the status_by term dropped, so the AGENT can pause the task against the user'; guards = 'C'
    find = '  if ("$($row.status_by)".ToLowerInvariant() -ne ''user'') { return $false }'
    repl = '  if ($false) { return $false }' }
  @{ n = 'closed statuses folded into the paused set, conflating finished with stopped'; guards = 'G'
    find = '$script:PausedStatus = @($script:NonWorkableStatus | Where-Object { $script:ClosedStatus -notcontains $_ })'
    repl = '$script:PausedStatus = @($script:NonWorkableStatus)' }
  @{ n = 'a reply no longer resumes, so his own message cannot un-pause the task'; guards = 'J'
    find = '  if ($journalFacts -and $journalFacts.HasTrailingHuman) { return $false }'
    repl = '  if ($false) { return $false }' }
)

Write-Host ''
Write-Host '== mutations (each killed by exactly the arms that claim it) =='
foreach ($m in $mutations) {
  if ($src.IndexOf($m.find) -lt 0) {
    Check "$($m.n): anchor present in source" $false "not found: $($m.find)"
    continue
  }
  $mutPath = Join-Path $root ("oa-state-mut-" + ($m.guards -replace ',', '-') + ".ps1")
  [IO.File]::WriteAllText($mutPath, $src.Replace($m.find, $m.repl), (New-Object Text.UTF8Encoding($false)))

  $want = @($m.guards -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
  $moved = @()
  foreach ($k in $worlds.Keys) {
    $got = Measure-Verdict $mutPath $worlds[$k]
    if ($got -eq 'ERR') { Check "$($m.n): mutant runs on world $k" $false 'unparseable output'; continue }
    if ($got -ne $base[$k]) { $moved += $k }
  }
  $missing = @($want | Where-Object { $moved -notcontains $_ })
  Check "$($m.n) -> world $($m.guards) moves (arm is load-bearing)" ($missing.Count -eq 0) "moved: $($moved -join ',')"
  $extra = @($moved | Where-Object { $want -notcontains $_ })
  Check "$($m.n): changes nothing else" ($extra.Count -eq 0) "also moved: $($extra -join ',')"
}

# The stamp mutants are driven separately, against the two sequence probes above.
$stampMutations = @(
  @{ n = 'paused_at re-stamped on every mark, so a week-old pause reports as minutes old'
    mode = 'preserve'; want = 'restamped'
    find = '    if ($nowPaused -and -not $wasPaused) { Set-Member $st ''paused_at'' (Now-Iso) }'
    repl = '    if ($nowPaused) { Set-Member $st ''paused_at'' (Now-Iso) }' }
  @{ n = 'paused_at never cleared, so a resumed task still reports when it was paused'
    mode = 'clear'; want = 'kept'
    find = '    elseif (-not $nowPaused) { Set-Member $st ''paused_at'' $null }'
    repl = '    elseif ($false) { Set-Member $st ''paused_at'' $null }' }
)
foreach ($m in $stampMutations) {
  if ($src.IndexOf($m.find) -lt 0) {
    Check "$($m.n): anchor present in source" $false "not found: $($m.find)"
    continue
  }
  $mutPath = Join-Path $root ("oa-state-mut-stamp-" + $m.mode + ".ps1")
  [IO.File]::WriteAllText($mutPath, $src.Replace($m.find, $m.repl), (New-Object Text.UTF8Encoding($false)))
  $got = Measure-Stamp $mutPath $m.mode
  Check "$($m.n) -> the $($m.mode) probe moves (arm is load-bearing)" ($got -eq $m.want) "got $got"
}

# The refusal mutant: without it, an erroneously-woken session erases the pause by reporting work.
$refusalMutation = @{
  n = 'the agent CAN un-pause itself, so a mistaken wake launders into a permanent resume'
  find = '    if ((Test-UserPaused $st $facts) -and "$StatusBy".ToLowerInvariant() -ne ''user'') {'
  repl = '    if ($false) {'
}
if ($src.IndexOf($refusalMutation.find) -lt 0) {
  Check "$($refusalMutation.n): anchor present in source" $false "not found: $($refusalMutation.find)"
}
else {
  $mutPath = Join-Path $root 'oa-state-mut-refusal.ps1'
  [IO.File]::WriteAllText($mutPath, $src.Replace($refusalMutation.find, $refusalMutation.repl), (New-Object Text.UTF8Encoding($false)))
  $gotA = Measure-Refusal $mutPath 'agent'
  Check "$($refusalMutation.n) -> the agent probe moves (arm is load-bearing)" ($gotA -eq 'allowed') "got $gotA"
  # ...and the legitimate paths must be untouched by that mutation, or the arm is really just
  # asserting that `mark` can fail, which any broken build satisfies.
  $gotB = Measure-Refusal $mutPath 'byuser'
  Check "$($refusalMutation.n): the -StatusBy user path is unaffected" ($gotB -eq 'allowed') "got $gotB"
}

Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue
Write-Host ''
Write-Host "$pass passed, $fail failed"
exit $(if ($fail) { 1 } else { 0 })
