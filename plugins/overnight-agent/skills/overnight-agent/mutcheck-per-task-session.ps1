<#
  mutcheck-per-task-session.ps1 -- mutation check for #404: a per-task session, in its own
  workspace, persisted across runs, and paced by the #391 concurrency setting.

  Builds a synthetic planner journal folder, runs the REAL oa-state.ps1 against it with an
  isolated -JournalDir / -StateDir / -PlannerBoard / -SnoozeStore / -UserSettings (so the live
  planner and the user's real settings are never touched), and asserts the verdicts.

  Run it against BOTH the pre-fix and post-fix scripts. The change is only load-bearing if the
  pre-fix script FAILS these arms:

    powershell -File mutcheck-per-task-session.ps1 -ScriptPath <path-to-oa-state.ps1> [-ExpectPreFix]

  WHY A VERDICT RATHER THAN A FIELD. Storing a session id would satisfy the acceptance criteria
  as written and still leave the decision -- create, reuse, or replace? -- in the agent's head,
  which is where it was when the run session did all the work itself. So the arms assert the
  VERDICT and the REFUSALS, not the presence of a field: B/C say a stored id is read back and
  turns into `reuse`, and D says a second session cannot be bound over a live one at all.

  Arms, and the distinct mutant each one kills:

    A  unbound -> verdict `create`     (kills: feature absent entirely)
    B  bind persists across processes  (kills: an in-memory binding -- which is exactly what the
                                        run session had, and why every night was a cold start)
    C  live binding -> verdict `reuse` (kills: a stored id that nothing interprets, leaving the
                                        create-or-reuse call to the agent)
    D  conflicting bind THROWS         (kills: "reuse the persisted session" as an intention. A
                                        silent overwrite creates the second session anyway and
                                        leaks the first, with nothing recording it existed (#345))
    E  -Force overrides D              (kills: an unescapable binding)
    F  -SessionDead -> `replace`       (kills: a dead session being retried forever, or being
                                        silently treated as absent -- which loses the continuity)
    G  replace emits a continuation    (kills: a replacement kickoff that does not say it is one.
                                        Asserted to name BOTH the task and the prior session id)
    H  replacement records prior id    (kills: a replacement indistinguishable from a first-ever
                                        session once it is bound)
    I  code bind needs a project       (kills: THE FIELD DEFECT. Every session API defaults the
                                        project to the CALLER's, so omitting it silently creates
                                        the "per-task" session inside the run session's project)
    J  code bind refuses run workspace (kills: the same defect one level down -- a session that
                                        shares the run session's workspace, which is the exact
                                        isolation failure #404 exists to prevent)
    J- normalisation is load-bearing   (kills: an ordinal string compare, which a trailing slash
                                        or a forward slash walks straight past)
    K  code cannot use a folder ws     (kills: a code task bound to a shared folder)
    L  no settings file -> 1           (kills: a reader that yields 0/unlimited when unconfigured)
    M  malformed value -> 1            (kills: a reader that widens on a typo. The failure of a
                                        pacing control must narrow a run, never widen it)
    N  settings row IS read            (kills: a hard-coded 1, which would make L and M pass
                                        while the user's setting did nothing)
    O  bind past capacity THROWS       (kills: a concurrency setting that is reported but not
                                        enforced -- #391 documented, #404 unimplemented, again)
    P  -Force admits the collect wave  (kills: a cap with no sanctioned exception, contradicting
                                        Prioritisation.md 4.1)
    Q  scan carries the verdict        (kills: the binding living on a SECOND worklist the run
                                        has to remember to consult -- #423's lesson)
    R  scan does not bind              (kills: a read command that writes; scan runs first in
                                        every phase)
    S  release frees capacity          (kills: a binding that is never retired, so the run
                                        permanently believes it is at capacity)
    T  release names the SAFE teardown (kills: emitting `git worktree remove --force`, which
                                        deletes THROUGH a node_modules junction (#321))
    U  a replacement is not a new item (kills: charging a replacement against the cap, which
                                        would strand a task whose session died at capacity 1)
    V  timestamps survive a round-trip (kills: the ConvertFrom-Json re-typing that rewrites an
                                        ISO stamp in the host's local format on every save)

  D, I and J are the arms that matter. Every other arm asserts that the mechanism works; those
  three assert that the three ways of bypassing it are refused -- and all three bypasses are
  SILENT, produce a plausible-looking session, and are only noticed later as a leaked host, a
  deadlocked pair of sessions, or a night of work that happened in the wrong place.
#>
[CmdletBinding()]
param(
  [string]$ScriptPath,
  [switch]$ExpectPreFix
)

$ErrorActionPreference = 'Stop'

if (-not $ScriptPath) { $ScriptPath = Join-Path $PSScriptRoot 'oa-state.ps1' }
if (-not (Test-Path $ScriptPath)) { throw "oa-state.ps1 not found at $ScriptPath" }

# Resolve the PowerShell host rather than hard-coding `powershell`: this guard runs on the Linux
# CI runner as well as the nightly laptop, and everything it touches is plain text in a temp dir.
$script:PsExe = if ($PSVersionTable.PSEdition -eq 'Core') { (Get-Process -Id $PID).Path } else { 'powershell' }
if (-not $script:PsExe) { $script:PsExe = 'pwsh' }

$Journal = @'
# Task {ID}: synthetic

User notes at the top.

---
<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->

## Overnight Agent

<!-- from: overnight-agent -->

**Status:** In-progress - plan v1 - 2026-09-03

**Needs from you:** none
'@

# --- isolated sandbox ---------------------------------------------------------------
$root = Join-Path ([IO.Path]::GetTempPath()) ("oa-session-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
$jdir = Join-Path $root 'journal'
$sdir = Join-Path $root 'state'
New-Item -ItemType Directory -Path $jdir -Force | Out-Null
New-Item -ItemType Directory -Path $sdir -Force | Out-Null

$board = Join-Path $root 'planner.md'
$store = Join-Path $root 'snooze.json'
$utf8 = New-Object Text.UTF8Encoding($false)

$ids = 801, 802, 803, 804, 805, 806, 807, 808, 809, 810, 812
foreach ($id in $ids) {
  [IO.File]::WriteAllText((Join-Path $jdir "task-$id.md"), $Journal.Replace('{ID}', "$id"), $utf8)
}

$boardText = "## Today`n`n| ID | Task |`n|---|---|`n"
foreach ($id in $ids) { $boardText += "| $id | synthetic |`n" }
[IO.File]::WriteAllText($board, $boardText, $utf8)
[IO.File]::WriteAllText($store, '{}', $utf8)

# Three settings files, because the concurrency arms need to distinguish "absent" from "malformed"
# from "actually configured" -- and a single file could not tell L, M and N apart.
$noSettings = Join-Path $root 'settings-absent.md'          # deliberately never created
$badSettings = Join-Path $root 'settings-bad.md'
$twoSettings = Join-Path $root 'settings-two.md'
[IO.File]::WriteAllText($badSettings, "## Overnight Agent behaviour`n`n| Setting | Value |`n|---|---|`n| Overnight Agent concurrency | plenty |`n", $utf8)
[IO.File]::WriteAllText($twoSettings, "## Overnight Agent behaviour`n`n| Setting | Value |`n|---|---|`n| Overnight Agent concurrency | 2 |`n", $utf8)

# The run session's own workspace -- the thing a per-task session must never be given.
$runWs = Join-Path $root 'run-session-workspace'
New-Item -ItemType Directory -Path $runWs -Force | Out-Null

function Invoke-Oa {
  param([string[]]$OaArgs, [string]$Settings = $noSettings)
  $all = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $ScriptPath) + $OaArgs +
  @('-JournalDir', $jdir, '-StateDir', $sdir, '-PlannerBoard', $board, '-SnoozeStore', $store,
    '-UserSettings', $Settings, '-RunWorkspace', $runWs)
  # Must not throw: -ExpectPreFix runs this against a build that REJECTS the new parameters, and a
  # hard failure there has to surface as a failed arm rather than a crashed harness -- otherwise
  # "pre-fix fails" is indistinguishable from "the harness is broken".
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  # -Width is not cosmetic on the JSON-bearing calls: the default wraps captured output at the
  # host's render width, which splits a long JSON line and defeats ConvertFrom-Json.
  try { $out = & $script:PsExe @all 2>&1 | Out-String -Width 4096 }
  catch { $out = '' }
  finally {
    $script:LastOaExit = $LASTEXITCODE
    $ErrorActionPreference = $prev
    $global:LASTEXITCODE = 0
  }
  return $out
}

function Invoke-OaJson {
  param([string[]]$OaArgs, [string]$Settings = $noSettings)
  $text = Invoke-Oa -OaArgs $OaArgs -Settings $Settings
  $start = $text.IndexOf('{')
  if ($start -lt 0) { return $null }
  try { return $text.Substring($start) | ConvertFrom-Json } catch { return $null }
}

function Get-Row([string]$id) {
  $json = Invoke-Oa @('scan')
  $start = $json.IndexOf('[')
  if ($start -lt 0) { return $null }
  try { $rows = $json.Substring($start) | ConvertFrom-Json } catch { return $null }
  return $rows | Where-Object { "$($_.id)" -eq $id }
}

function New-Bind {
  # A well-formed code bind for task $id, in its own worktree. Every arm that is not ABOUT the
  # workspace guard goes through this, so a change to the guard cannot quietly break the rest.
  param([string]$Id, [string]$SessionId, [string]$Settings = $noSettings, [switch]$WithForce)
  $a = @('session', '-Id', $Id, '-SessionId', $SessionId, '-SessionKind', 'code',
    '-SessionProject', 'focus-planner',
    '-SessionWorkspace', (Join-Path $root "wt-$Id"), '-WorkspaceType', 'worktree')
  if ($WithForce) { $a += '-Force' }
  return (Invoke-OaJson -OaArgs $a -Settings $Settings)
}

$results = [ordered]@{}
function Check([string]$name, [scriptblock]$body) {
  try { $results[$name] = [bool](& $body) }
  catch { $results[$name] = $false; Write-Verbose "$name threw: $($_.Exception.Message)" }
}

[void](Invoke-Oa @('seed'))

# --- A/B/C: the binding exists, persists, and is INTERPRETED ---------------------------
$a = Invoke-OaJson @('session', '-Id', '801')
Check 'A unbound task -> verdict create' { "$($a.verdict)" -eq 'create' -and $a.bound -eq $false }

$b = New-Bind -Id '801' -SessionId 'SESS_801'
Check 'A- bind reports the id back' { $b.bound -eq $true -and "$($b.session_id)" -eq 'SESS_801' }

# B is the acceptance criterion "written when a session is created and read on the NEXT run". The
# read below is a separate PROCESS, which is what "next run" actually means here -- an in-memory
# binding passes every other arm in this file and fails only this one.
$b2 = Invoke-OaJson @('session', '-Id', '801')
Check 'B binding survives into a new process' { "$($b2.session_id)" -eq 'SESS_801' }
Check 'B- and it is stored under the task id' {
  $raw = Get-Content (Join-Path $sdir 'task-801.json') -Raw | ConvertFrom-Json
  "$($raw.session.session_id)" -eq 'SESS_801'
}
Check 'C live binding -> verdict reuse' { "$($b2.verdict)" -eq 'reuse' -and "$($b2.state)" -eq 'live' }

# C-workspace: the verdict must verify that the workspace still HOLDS a checkout (#452).
#
# Measured 2026-09-03: task #466 was torn down with the sanctioned `remove-worktree.ps1`, which
# deletes the workspace and knows nothing about bindings. The binding went on reporting
# `bound: true, verdict: reuse, state: live` at a directory that was empty and deregistered from
# `git worktree list` -- so the next run was told to reuse a workspace with no repository in it.
# Nothing checked, so `reuse` looked authoritative. That is the #261/#346 shape on the binding.
#
# `replace`, never `create`: this task HAS prior work, and `create` cold-starts it, discarding the
# continuity the binding exists to provide.
#
# Note the two directory states below are NOT interchangeable, and that distinction is the arm's
# real content. A workspace that EXISTS and is EMPTY is the torn-down signature. A workspace that
# does not exist AT ALL is a session that has been bound but has not materialised its checkout yet
# -- which `Test-SamePath` in the subject already calls out as "exactly when a bind is being
# validated" -- and calling that dead would refuse to reuse a perfectly healthy young session.
$wsTorn = Join-Path $root 'wt-802'
New-Item -ItemType Directory -Path $wsTorn -Force | Out-Null
# -WithForce because task 801 above already holds a live session and the default concurrency is 1.
# Without it the bind is refused for CAPACITY, task 802 stays unbound, and the arm would then read
# `create` for a reason that has nothing to do with the workspace -- passing arm C-w while proving
# nothing about it.
$null = New-Bind -Id '802' -SessionId 'SESS_802' -WithForce
$tornVerdict = Invoke-OaJson @('session', '-Id', '802')
Check 'C-w a torn-down workspace is not reused' { "$($tornVerdict.verdict)" -ne 'reuse' }
Check 'C-w- and it is replace, so prior work is not cold-started' { "$($tornVerdict.verdict)" -eq 'replace' }

# The same binding, once the workspace holds a checkout again. A worktree's `.git` is a FILE
# (`gitdir: ...`), not a directory, so a guard testing for a container would report every healthy
# worktree as dead -- which is worse than the bug, since it discards live sessions.
Set-Content -Path (Join-Path $wsTorn '.git') -Value 'gitdir: /repo/.git/worktrees/wt-802' -Encoding utf8
Check 'C-w-- a workspace holding a checkout is reused again' {
  "$((Invoke-OaJson @('session', '-Id', '802')).verdict)" -eq 'reuse'
}

# C-t: teardown must SAY the workspace is gone (#452, the half the verdict cannot cover).
#
# Measured 2026-09-04 against a REAL worktree removed with the sanctioned remove-worktree.ps1: a
# clean teardown leaves NO directory at all. #466's survived only because a live session's cwd
# blocked the final delete, which is what produced the empty-directory signature C-w tests. The
# verdict cannot judge the clean case -- an absent path is equally a workspace that was never
# materialised, and treating absence as death would discard live young sessions.
#
# So the fact travels from the side that holds it: the remover knows it removed the workspace.
$wsClean = Join-Path $root 'wt-812'
$null = New-Bind -Id '812' -SessionId 'SESS_812' -WithForce
Check 'C-t before teardown a bound task reads reuse' {
  "$((Invoke-OaJson @('session', '-Id', '812')).verdict)" -eq 'reuse'
}
$gone = Invoke-OaJson @('session', '-WorkspaceGone', $wsClean)
Check 'C-t- the removal marks exactly that task' {
  [int]$gone.marked_dead -eq 1 -and ($gone.tasks -contains '812')
}
$after812 = Invoke-OaJson @('session', '-Id', '812')
# `replace`, not `create`: releasing would leave the task unbound and cold-start it, discarding
# the continuity the binding exists to provide. Dead carries the continuation.
Check 'C-t-- and the verdict becomes replace, carrying continuity' {
  "$($after812.verdict)" -eq 'replace' -and "$($after812.state)" -eq 'dead'
}
Check 'C-t--- the continuation is emitted, so the next session is not cold-started' {
  "$($after812.kickoff_continuation)" -match 'continues work on planner task'
}
# EXACT path only. A prefix match would let tearing down a parent directory silently kill every
# binding beneath it -- one command, every task on the machine unbound.
$parentGone = Invoke-OaJson @('session', '-WorkspaceGone', $root)
Check 'C-t---- a PARENT path does not cascade to bindings beneath it' {
  [int]$parentGone.marked_dead -eq 0
}

# --- D/E: the refusal that makes reuse a rule ------------------------------------------
#
# ASSERTED ON BEHAVIOUR AND A SPACE-FREE TOKEN, never on a phrase: with `pwsh -File` the CHILD
# formats its error at ITS OWN terminal width and writes the formatted text to stderr, so a phrase
# in the middle of a long sentence wraps on a narrow host and the match misses. That difference is
# invisible locally and red on the Linux runner.
$d = Invoke-Oa @('session', '-Id', '801', '-SessionId', 'SESS_OTHER', '-SessionKind', 'code',
  '-SessionProject', 'focus-planner', '-SessionWorkspace', (Join-Path $root 'wt-other'),
  '-WorkspaceType', 'worktree')
$dExit = $script:LastOaExit
Check 'D conflicting bind over a LIVE session THROWS' { $dExit -ne 0 -and $d -match 'session_bind_conflict' }
Check 'D- and the binding is unchanged' { "$((Invoke-OaJson @('session','-Id','801')).session_id)" -eq 'SESS_801' }

$e = New-Bind -Id '801' -SessionId 'SESS_FORCED' -WithForce
Check 'E -Force overrides the refusal' { "$($e.session_id)" -eq 'SESS_FORCED' }

# --- F/G/H: a session that cannot be woken is REPLACED, and says so --------------------
[void](New-Bind -Id '802' -SessionId 'SESS_802' -WithForce)
[void](Invoke-Oa @('session', '-Id', '802', '-SessionDead'))
$f = Invoke-OaJson @('session', '-Id', '802')
Check 'F dead session -> verdict replace' { "$($f.verdict)" -eq 'replace' -and "$($f.state)" -eq 'dead' }

# G asserts the CONTENT, not merely the presence, of the continuation. The acceptance criterion is
# that the replacement's kickoff names the task and the prior session id; a non-empty string that
# says neither satisfies a presence check and none of the criterion.
Check 'G replace emits a kickoff continuation' {
  $k = "$($f.kickoff_continuation)"
  $k -and $k -match '802' -and $k -match 'SESS_802'
}
Check 'G- a live binding emits none' {
  $null -eq (Invoke-OaJson @('session', '-Id', '801')).kickoff_continuation
}

$h = New-Bind -Id '802' -SessionId 'SESS_802B' -WithForce
Check 'H replacement records the prior session id' {
  "$($h.session_id)" -eq 'SESS_802B' -and "$($h.prior_session_id)" -eq 'SESS_802'
}
Check 'H- and it is live again' { "$((Invoke-OaJson @('session','-Id','802')).verdict)" -eq 'reuse' }

# --- I/J/K: the workspace guards -- the defect measured while delegating THIS issue ----
$i = Invoke-Oa @('session', '-Id', '803', '-SessionId', 'SESS_803', '-SessionKind', 'code',
  '-SessionWorkspace', (Join-Path $root 'wt-803'), '-WorkspaceType', 'worktree', '-Force')
Check 'I code bind without a project is REFUSED' { $script:LastOaExit -ne 0 -and $i -match 'session_project_required' }

$j = Invoke-Oa @('session', '-Id', '803', '-SessionId', 'SESS_803', '-SessionKind', 'code',
  '-SessionProject', 'focus-planner', '-SessionWorkspace', $runWs, '-WorkspaceType', 'worktree', '-Force')
Check 'J code bind on the RUN session workspace is REFUSED' { $script:LastOaExit -ne 0 -and $j -match 'session_workspace_inherited' }

# J- proves the path normalisation is load-bearing. A plain ordinal compare passes J and walks
# straight past this, which is the same workspace with a trailing separator and forward slashes --
# and the shape a path actually arrives in when it has been round-tripped through a config file.
$jAlt = ($runWs -replace '\\', '/') + '/'
$j2 = Invoke-Oa @('session', '-Id', '803', '-SessionId', 'SESS_803', '-SessionKind', 'code',
  '-SessionProject', 'focus-planner', '-SessionWorkspace', $jAlt, '-WorkspaceType', 'worktree', '-Force')
Check 'J- the same path spelled differently is still REFUSED' { $script:LastOaExit -ne 0 -and $j2 -match 'session_workspace_inherited' }

$k = Invoke-Oa @('session', '-Id', '803', '-SessionId', 'SESS_803', '-SessionKind', 'code',
  '-SessionProject', 'focus-planner', '-SessionWorkspace', (Join-Path $root 'wt-803'),
  '-WorkspaceType', 'folder', '-Force')
Check 'K code bind with a folder workspace is REFUSED' { $script:LastOaExit -ne 0 -and $k -match 'session_workspace_type' }

Check 'K- nothing was bound by any refusal' { (Invoke-OaJson @('session', '-Id', '803')).bound -eq $false }

# A non-code task still gets its own session, and is not held to the worktree rules.
$folder = Invoke-OaJson @('session', '-Id', '804', '-SessionId', 'SESS_804', '-SessionKind', 'folder', '-Force')
Check 'K-- a folder task still gets a session' { "$($folder.session_id)" -eq 'SESS_804' -and "$($folder.kind)" -eq 'folder' }

# --- L/M/N: the concurrency setting (#391), and its fail-safe direction ----------------
$l = Invoke-OaJson -OaArgs @('session', '-InFlight') -Settings $noSettings
Check 'L absent settings file -> concurrency 1' { $l.concurrency -eq 1 }

$m = Invoke-OaJson -OaArgs @('session', '-InFlight') -Settings $badSettings
Check 'M malformed value -> concurrency 1, not unlimited' { $m.concurrency -eq 1 }

# N is what stops L and M being satisfied by a hard-coded 1.
$n = Invoke-OaJson -OaArgs @('session', '-InFlight') -Settings $twoSettings
Check 'N the settings row is actually read' { $n.concurrency -eq 2 }

Check 'N- in_flight counts live sessions' { $l.in_flight -ge 3 }

# --- O/P/U: the cap is ENFORCED, with exactly one sanctioned exception -----------------
# Release everything first, so the arms below control the in-flight count exactly.
foreach ($id in $ids) { [void](Invoke-Oa @('session', '-Id', "$id", '-SessionRelease')) }
$zero = Invoke-OaJson @('session', '-InFlight')
Check 'S release frees capacity' { $zero.in_flight -eq 0 -and $zero.at_capacity -eq $false }

[void](New-Bind -Id '805' -SessionId 'SESS_805')
$o = Invoke-Oa @('session', '-Id', '806', '-SessionId', 'SESS_806', '-SessionKind', 'folder')
Check 'O bind past concurrency 1 is REFUSED' { $script:LastOaExit -ne 0 -and $o -match 'session_at_capacity' }

$p = Invoke-OaJson @('session', '-Id', '806', '-SessionId', 'SESS_806', '-SessionKind', 'folder', '-Force')
Check 'P -Force admits the collect-wave exception' { "$($p.session_id)" -eq 'SESS_806' }

# At concurrency 2 the same bind that O refused must succeed, which is the consequence of N rather
# than just its signal: a setting that is read but not USED would pass N and fail here.
[void](Invoke-Oa @('session', '-Id', '806', '-SessionRelease'))
$n2 = Invoke-OaJson -OaArgs @('session', '-Id', '806', '-SessionId', 'SESS_806', '-SessionKind', 'folder') -Settings $twoSettings
Check 'N-- concurrency 2 admits the second item' { "$($n2.session_id)" -eq 'SESS_806' }
[void](Invoke-Oa @('session', '-Id', '806', '-SessionRelease'))

# U: a task whose session died must be able to get a replacement even at capacity 1 -- a
# replacement continues an item already in flight, it does not add one. Charging it against the
# cap would strand exactly the task that most needs the run's attention.
[void](Invoke-Oa @('session', '-Id', '805', '-SessionDead'))
[void](New-Bind -Id '807' -SessionId 'SESS_807')          # 807 now holds the single slot
$u = Invoke-OaJson @('session', '-Id', '805', '-SessionId', 'SESS_805B')
Check 'U a replacement is not charged against the cap' { "$($u.session_id)" -eq 'SESS_805B' -and "$($u.prior_session_id)" -eq 'SESS_805' }

# --- Q/R: one worklist, and it stays read-only ------------------------------------------
$r807 = Get-Row '807'
Check 'Q scan carries the session verdict' {
  "$($r807.session_id)" -eq 'SESS_807' -and "$($r807.session_verdict)" -eq 'reuse' -and "$($r807.session_state)" -eq 'live'
}
$r808 = Get-Row '808'
Check 'Q- an unbound row reads create' { "$($r808.session_verdict)" -eq 'create' -and $null -eq $r808.session_id }

# R uses a state file that EXISTS and merely lacks the binding -- the shape that actually reaches
# a write path. (An earlier version of this arm in the sibling doc-binding guard deleted the file
# instead, and a write-on-scan mutant passed it trivially because the write was guarded on a
# non-null state object.)
Check 'R scan did not bind anything' {
  $p808 = Join-Path $sdir 'task-808.json'
  (Test-Path $p808) -and -not ([IO.File]::ReadAllText($p808) -match '"session"\s*:\s*\{')
}

# --- T: cleanup is NAMED, and it is the safe one (#321) ---------------------------------
$t = Invoke-OaJson @('session', '-Id', '807')
Check 'T teardown names remove-worktree.ps1' { "$($t.teardown_command)" -match 'remove-worktree\.ps1' }
Check 'T- and never the raw force removal' { "$($t.teardown_command)" -notmatch 'worktree\s+remove' }

# --- V: an ISO timestamp survives being read back and re-saved --------------------------
# ConvertFrom-Json re-types an ISO-8601 string as a [datetime], so a naive re-save writes it back
# in the HOST's local format -- and every subsequent save corrupts it further. The arm re-saves
# twice, because a single round-trip can survive by accident.
#
# ASSERTED AGAINST THE STATE FILE, not against the command's parsed output, and the distinction is
# the whole point: this harness ALSO calls ConvertFrom-Json, so `$v.created_at` is a [datetime]
# here no matter what the tool stored, and stringifying it would test the harness rather than the
# feature. The bytes on disk are the thing that has to survive to the next run.
[void](Invoke-Oa @('session', '-Id', '807', '-SessionWoken'))
[void](Invoke-Oa @('session', '-Id', '807', '-SessionWoken'))
$storedPath = Join-Path $sdir 'task-807.json'
# Tolerant read: -ExpectPreFix runs this whole file against a build with no `session` command at
# all, so nothing was ever bound and the file does not exist. That must surface as two failed arms,
# not as a crashed harness.
$stored = if (Test-Path $storedPath) { [IO.File]::ReadAllText($storedPath) } else { '' }
Check 'V created_at survives two round-trips as ISO' {
  $stored -match '"created_at"\s*:\s*"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}'
}
Check 'V- last_woken_at is stamped, and ISO' {
  $stored -match '"last_woken_at"\s*:\s*"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}'
}

# --- report ---------------------------------------------------------------------------
$pass = 0; $fail = 0
foreach ($key in $results.Keys) {
  if ($results[$key]) { "  PASS  $key"; $pass++ } else { "  FAIL  $key"; $fail++ }
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
