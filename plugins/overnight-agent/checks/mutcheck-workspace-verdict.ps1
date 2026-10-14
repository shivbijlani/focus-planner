<#
  mutcheck-workspace-verdict.ps1 -- prove the session verdict verifies its workspace (GH #452).

  WHY THIS EXISTS
  ---------------
  The per-task session binding (#404) exists so the next run RESUMES a parked task instead of
  cold-starting it. Measured 2026-09-03, task #466's binding reported:

      bound: true, verdict: reuse, state: live
      workspace: ...\shivbijlani-fuzzy-pancake

  while that workspace was an EMPTY directory -- deregistered from `git worktree list`, no `.git`,
  no package.json. The verdict was directing the next run to reuse a workspace with no repository
  in it, and nothing checked.

  Two lifecycles that must agree were uncoupled: `remove-worktree.ps1` deletes the workspace and
  knows nothing about bindings; `oa-state.ps1 -SessionRelease` retires the binding and knew nothing
  about the workspace. Teardown-without-release is this bug (#452); release-without-teardown is
  #402.

  The repair (`-SessionDead`) existed and worked -- but only because a human noticed. This check
  pins the verdict answering the question itself, with nobody looking. Same principle as the #261
  liveness sweep.

  It runs the REAL oa-state.ps1 against an isolated -StateDir, so live state is never touched.

  ARMS
    A1  a live binding whose worktree workspace is GONE          -> verdict must be `replace`
    A2  ...and specifically NOT `create`, which would cold-start a task that has prior work
    A3  a live binding whose workspace still has a checkout      -> verdict stays `reuse`
    A4  an UNREADABLE/unknown situation is never called dead     -> fail-open, verdict `reuse`
    A5  a non-worktree (folder) workspace is not judged by `.git`
    A6  a worktree workspace that does not exist AT ALL, under a reachable root, is a torn-down
        one -> verdict `replace` (GH #717). `git worktree remove` leaves nothing behind, so the
        #452 signature (empty directory, no `.git`) is only half the shape.
    A7  `session` reports WHY: `workspace_missing: true` beside the verdict, so a run can see the
        fact and not just its consequence.

  MUTANTS (each must break exactly the arm named)
    B_neverVerify      drop the workspace check           -> A1
    C_verdictCreate    return `create` instead of replace -> A2
    D_requireGitDir    test `.git` as a container         -> A3   (a worktree's .git is a FILE)
    F_judgeFolders     apply the checkout test to folders -> A5
    G_unbornIsAlive    call a deleted workspace healthy   -> A6
    H_rootNotChecked   skip the reachable-root test       -> A4   (unreadable read as deleted)
    I_missingUnreported drop the surfaced fact            -> A7
#>
[CmdletBinding()]
param([string]$ScriptPath)

$ErrorActionPreference = 'Stop'

$Here = Split-Path -Parent $MyInvocation.MyCommand.Path

# The subject lives in a DIFFERENT place depending on which tree this runs from, and resolving it
# only one way is how a guard ships merged-but-not-running. In the repo it is a sibling directory
# away; in the OA home every check and skill is flattened into ONE directory, so the repo-relative
# path does not exist there and the check dies with exit 1 rather than skipping. Measured: this
# file passed in the repo and threw `subject not found` from the installed tree on its first
# deploy. Same candidate list as `mutcheck-consent-authorship.ps1`, so the two cannot drift.
if (-not $ScriptPath) {
  $candidates = @(
    (Join-Path $Here '..\skills\overnight-agent\oa-state.ps1'),
    (Join-Path $Here 'oa-state.ps1'),
    (Join-Path $env:LOCALAPPDATA 'overnight-agent\oa-state.ps1'),
    "$env:USERPROFILE\.copilot\installed-plugins\focus-planner\overnight-agent\skills\overnight-agent\oa-state.ps1"
  )
  foreach ($c in $candidates) { if (Test-Path $c) { $ScriptPath = (Resolve-Path $c).Path; break } }
}
$Subject = $ScriptPath
if (-not $Subject -or -not (Test-Path $Subject)) { throw "subject not found: $Subject" }
. (Join-Path (Split-Path -Parent $Subject) 'oa-state-target.ps1')
$script:TargetIsNode = Test-OaStateNodeTarget $Subject

$Tmp = Join-Path ([IO.Path]::GetTempPath()) ("mutcheck-wsverdict-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $Tmp -Force | Out-Null

function New-Subject {
  param([string]$Name, [string]$Find = $null, [string]$Replace = $null, [string]$JsFind = $null, [string]$JsReplace = $null)
  if (-not $Find) { return $Subject }
  $needle = if ($script:TargetIsNode) { $JsFind } else { $Find }
  $with = if ($script:TargetIsNode) { $JsReplace } else { $Replace }
  if (-not $needle) { throw "mutation $Name has no Node twin" }
  return New-OaStateMutant $Subject $Name $needle $with (Join-Path $Tmp 'mutants')
}

# Build one isolated state store holding a single task with a live binding at $Workspace.
function New-Store {
  param([string]$Name, [string]$Workspace, [string]$WsType = 'worktree')
  $dir = Join-Path $Tmp ("state-" + $Name)
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $dir 'journal') -Force | Out-Null
  $state = [ordered]@{
    id      = '999'
    status  = 'in-progress'
    version = 0
    session = [ordered]@{
      session_id     = 'aa358d1c-4c54-40cb-8809-619bd9bda3d7'
      kind           = 'code'
      project        = 'p'
      workspace      = $Workspace
      workspace_type = $WsType
      created_at     = '2026-09-03T12:00:00-07:00'
      last_woken_at  = ''
      state          = 'live'
      prior_session_id = ''
      replaced_at    = ''
    }
  }
  $state | ConvertTo-Json -Depth 8 | Set-Content -Path (Join-Path $dir 'task-999.json') -Encoding utf8
  return $dir
}

function Get-Verdict {
  param([string]$SubjectPath, [string]$StateDir)
  $cmd = Get-OaStateCommand $SubjectPath
  $out = & $cmd.Exe @($cmd.Prefix + @('session', '-Id', '999',
    '-StateDir', $StateDir, '-JournalDir', (Join-Path $StateDir 'journal'),
    '-SessionStateDir', (Join-Path $StateDir 'session-state'),
    '-UserSettings', (Join-Path $StateDir 'absent-settings.md'))) 2>&1
  $text = ($out | Out-String)
  try { return ((($text | ConvertFrom-Json)).verdict) } catch { return "UNPARSEABLE: $text" }
}

function Get-MissingFlag {
  param([string]$SubjectPath, [string]$StateDir)
  $cmd = Get-OaStateCommand $SubjectPath
  $out = & $cmd.Exe @($cmd.Prefix + @('session', '-Id', '999',
    '-StateDir', $StateDir, '-JournalDir', (Join-Path $StateDir 'journal'),
    '-SessionStateDir', (Join-Path $StateDir 'session-state'),
    '-UserSettings', (Join-Path $StateDir 'absent-settings.md'))) 2>&1
  $text = ($out | Out-String)
  try { return [string]((($text | ConvertFrom-Json)).workspace_missing) } catch { return "UNPARSEABLE" }
}

# --- workspaces -------------------------------------------------------------------------------
# GONE: the measured signature of a torn-down worktree -- the directory still exists (a live
# session's cwd kept it undeletable) and is empty, with no .git.
$wsGone = Join-Path $Tmp 'ws-gone'
New-Item -ItemType Directory -Path $wsGone -Force | Out-Null

# HEALTHY: a worktree's `.git` is a FILE containing `gitdir: ...`, not a directory. Getting that
# wrong is arm A3's mutant.
$wsOk = Join-Path $Tmp 'ws-ok'
New-Item -ItemType Directory -Path $wsOk -Force | Out-Null
Set-Content -Path (Join-Path $wsOk '.git') -Value 'gitdir: V:/repos/focus-planner/.git/worktrees/x' -Encoding utf8

# UNREADABLE: a path we cannot inspect. Never evidence the checkout is gone. Do not use an
# absent drive letter here: on some Windows hosts `Test-Path Z:\...` blocks on drive-provider
# discovery before the check reaches its own guard.
$wsWeird = 'NoSuchProvider::\never-created'

# DELETED OUTRIGHT: `git worktree remove` leaves nothing behind, so the path itself is gone while
# its containing root is perfectly reachable. This is the #717 shape, measured on tasks 329/466.
$wsDeleted = Join-Path $Tmp 'ws-deleted'

function Test-Verdicts {
  param([string]$SubjectPath)
  $f = @()
  $vGone  = Get-Verdict -SubjectPath $SubjectPath -StateDir (New-Store -Name ([guid]::NewGuid().ToString('N').Substring(0,6)) -Workspace $wsGone)
  $vOk    = Get-Verdict -SubjectPath $SubjectPath -StateDir (New-Store -Name ([guid]::NewGuid().ToString('N').Substring(0,6)) -Workspace $wsOk)
  $vWeird = Get-Verdict -SubjectPath $SubjectPath -StateDir (New-Store -Name ([guid]::NewGuid().ToString('N').Substring(0,6)) -Workspace $wsWeird)
  $vFold  = Get-Verdict -SubjectPath $SubjectPath -StateDir (New-Store -Name ([guid]::NewGuid().ToString('N').Substring(0,6)) -Workspace $wsGone -WsType 'folder')
  $vDel   = Get-Verdict -SubjectPath $SubjectPath -StateDir (New-Store -Name ([guid]::NewGuid().ToString('N').Substring(0,6)) -Workspace $wsDeleted)
  $mDel   = Get-MissingFlag -SubjectPath $SubjectPath -StateDir (New-Store -Name ([guid]::NewGuid().ToString('N').Substring(0,6)) -Workspace $wsDeleted)
  $mOk    = Get-MissingFlag -SubjectPath $SubjectPath -StateDir (New-Store -Name ([guid]::NewGuid().ToString('N').Substring(0,6)) -Workspace $wsOk)

  if ($vGone -ne 'replace' -and $vGone -ne 'create') { $f += "A1: an emptied worktree returned '$vGone'" }
  if ($vGone -eq 'create')  { $f += "A2: an emptied worktree returned 'create' -- prior work would be cold-started" }
  if ($vOk    -ne 'reuse')  { $f += "A3: a healthy worktree returned '$vOk'" }
  if ($vWeird -ne 'reuse')  { $f += "A4: an uninspectable path returned '$vWeird' -- absence of evidence treated as evidence" }
  if ($vFold  -ne 'reuse')  { $f += "A5: a folder workspace returned '$vFold' -- judged by a checkout it never has" }
  if ($vDel   -ne 'replace'){ $f += "A6: a DELETED worktree returned '$vDel' -- the run would wake a session with no checkout" }
  if ($mDel   -ne 'True')   { $f += "A7: a deleted worktree reported workspace_missing '$mDel'" }
  if ($mOk    -ne 'False')  { $f += "A7: a healthy worktree reported workspace_missing '$mOk'" }
  return $f
}

Write-Host ''
Write-Host 'mutcheck-workspace-verdict -- GH #452 the session verdict verifies its workspace'
Write-Host ''

$baseSubject = New-Subject -Name 'baseline'
$baseline = Test-Verdicts -SubjectPath $baseSubject
if ($baseline.Count) {
  foreach ($x in $baseline) { Write-Host "  FAIL  baseline  $x" -ForegroundColor Red }
} else {
  Write-Host '  [baseline] OK -- gone=>replace, deleted=>replace, healthy=>reuse, uninspectable=>reuse, folder=>reuse'
}

$mutants = @(
  @{
    Name='B_neverVerify'; Expect='A1'
    Find="  if (-not (Test-WorkspaceUsable `"`$(`$sess.workspace)`" `"`$(`$sess.workspace_type)`")) { return 'replace' }"
    Replace=''
    JsFind="export function getSessionVerdict(ctx, sess, row, journalFacts, sessionProcessDead = null) {`r`n  if (testUserPaused(row, journalFacts)) return 'paused';`r`n  if (!sess) return 'create';`r`n  if (psStr(get(sess, 'state')) === 'dead') return 'replace';`r`n  let processDead = sessionProcessDead;`r`n  if (processDead === null || processDead === undefined) processDead = testSessionProcessDead(ctx, psStr(get(sess, 'session_id')));`r`n  if (processDead) return 'replace';`r`n  if (!testWorkspaceUsable(psStr(get(sess, 'workspace')), psStr(get(sess, 'workspace_type')))) return 'replace';`r`n  return 'reuse';`r`n}"
    JsReplace="export function getSessionVerdict(ctx, sess, row, journalFacts, sessionProcessDead = null) {`r`n  if (testUserPaused(row, journalFacts)) return 'paused';`r`n  if (!sess) return 'create';`r`n  if (psStr(get(sess, 'state')) === 'dead') return 'replace';`r`n  let processDead = sessionProcessDead;`r`n  if (processDead === null || processDead === undefined) processDead = testSessionProcessDead(ctx, psStr(get(sess, 'session_id')));`r`n  if (processDead) return 'replace';`r`n  return 'reuse';`r`n}"
  }
  @{
    Name='C_verdictCreate'; Expect='A2'
    Find="  if (-not (Test-WorkspaceUsable `"`$(`$sess.workspace)`" `"`$(`$sess.workspace_type)`")) { return 'replace' }"
    Replace="  if (-not (Test-WorkspaceUsable `"`$(`$sess.workspace)`" `"`$(`$sess.workspace_type)`")) { return 'create' }"
    JsFind="export function getSessionVerdict(ctx, sess, row, journalFacts, sessionProcessDead = null) {`r`n  if (testUserPaused(row, journalFacts)) return 'paused';`r`n  if (!sess) return 'create';`r`n  if (psStr(get(sess, 'state')) === 'dead') return 'replace';`r`n  let processDead = sessionProcessDead;`r`n  if (processDead === null || processDead === undefined) processDead = testSessionProcessDead(ctx, psStr(get(sess, 'session_id')));`r`n  if (processDead) return 'replace';`r`n  if (!testWorkspaceUsable(psStr(get(sess, 'workspace')), psStr(get(sess, 'workspace_type')))) return 'replace';`r`n  return 'reuse';`r`n}"
    JsReplace="export function getSessionVerdict(ctx, sess, row, journalFacts, sessionProcessDead = null) {`r`n  if (testUserPaused(row, journalFacts)) return 'paused';`r`n  if (!sess) return 'create';`r`n  if (psStr(get(sess, 'state')) === 'dead') return 'replace';`r`n  let processDead = sessionProcessDead;`r`n  if (processDead === null || processDead === undefined) processDead = testSessionProcessDead(ctx, psStr(get(sess, 'session_id')));`r`n  if (processDead) return 'replace';`r`n  if (!testWorkspaceUsable(psStr(get(sess, 'workspace')), psStr(get(sess, 'workspace_type')))) return 'create';`r`n  return 'reuse';`r`n}"
  }
  @{
    Name='D_requireGitDir'; Expect='A3'
    Find="    if (Test-Path -LiteralPath (Join-Path `$path '.git')) { return `$true }"
    Replace="    if (Test-Path -LiteralPath (Join-Path `$path '.git') -PathType Container) { return `$true }"
    JsFind="export function testWorkspaceUsable(p, wsType) {`r`n  if (!p) return true;`r`n  if (wsType && wsType !== 'worktree') return true;`r`n  try {`r`n    if (!testPath(p)) return !testWorkspaceMissing(p, wsType);`r`n    if (testPath(joinPath(p, '.git'))) return true;`r`n    return false;`r`n  } catch {`r`n    return true;`r`n  }`r`n}"
    JsReplace="export function testWorkspaceUsable(p, wsType) {`r`n  if (!p) return true;`r`n  if (wsType && wsType !== 'worktree') return true;`r`n  try {`r`n    if (!testPath(p)) return !testWorkspaceMissing(p, wsType);`r`n    if (isDir(joinPath(p, '.git'))) return true;`r`n    return false;`r`n  } catch {`r`n    return true;`r`n  }`r`n}"
  }
  @{
    Name='F_judgeFolders'; Expect='A5'
    Find="  if (`$wsType -and `$wsType -ne 'worktree') { return `$true }"
    Replace=''
    JsFind="  if (wsType && wsType !== 'worktree') return true;"
    JsReplace=''
  }
  @{
    Name='G_unbornIsAlive'; Expect='A6'
    Find="    if (-not (Test-Path -LiteralPath `$path)) { return (-not (Test-WorkspaceMissing `$path `$wsType)) }"
    Replace="    if (-not (Test-Path -LiteralPath `$path)) { return `$true }"
    JsFind="export function testWorkspaceUsable(p, wsType) {`r`n  if (!p) return true;`r`n  if (wsType && wsType !== 'worktree') return true;`r`n  try {`r`n    if (!testPath(p)) return !testWorkspaceMissing(p, wsType);`r`n    if (testPath(joinPath(p, '.git'))) return true;`r`n    return false;`r`n  } catch {`r`n    return true;`r`n  }`r`n}"
    JsReplace="export function testWorkspaceUsable(p, wsType) {`r`n  if (!p) return true;`r`n  if (wsType && wsType !== 'worktree') return true;`r`n  try {`r`n    if (!testPath(p)) return true;`r`n    if (testPath(joinPath(p, '.git'))) return true;`r`n    return false;`r`n  } catch {`r`n    return true;`r`n  }`r`n}"
  }
  @{
    Name='H_rootNotChecked'; Expect='A4'
    Find="    if (-not `$root) { return `$false }`r`n    if (-not (Test-Path -LiteralPath `$root)) { return `$false }"
    Replace=''
    JsFind="    if (!root) return false;`r`n    if (!testPath(root)) return false;"
    JsReplace=''
  }
  @{
    Name='I_missingUnreported'; Expect='A7'
    Find="    workspace_missing = [bool](Test-WorkspaceMissing `"`$(`$sess.workspace)`" `"`$(`$sess.workspace_type)`")"
    Replace="    workspace_missing = `$false"
    JsFind="    workspace_missing: !!testWorkspaceMissing(psStr(get(sess, 'workspace')), psStr(get(sess, 'workspace_type'))),"
    JsReplace="    workspace_missing: false,"
  }
)

Write-Host ''
Write-Host 'MUTATION ARMS'
$survived = @()
foreach ($m in $mutants) {
  try {
    $p = New-Subject -Name $m.Name -Find $m.Find -Replace $m.Replace -JsFind $m.JsFind -JsReplace $m.JsReplace
  } catch {
    Write-Host ("  [ERROR  ] {0,-16} {1}" -f $m.Name, $_.Exception.Message) -ForegroundColor Red
    $survived += $m.Name
    continue
  }
  $fails = Test-Verdicts -SubjectPath $p
  $killed = @($fails | Where-Object { $_ -like "$($m.Expect)*" }).Count -gt 0
  if ($killed) {
    Write-Host ("  [KILLED ] {0,-16} expected {1}" -f $m.Name, $m.Expect)
  } else {
    Write-Host ("  [SURVIVED] {0,-16} expected {1} -- got: {2}" -f $m.Name, $m.Expect, ($fails -join '; ')) -ForegroundColor Red
    $survived += $m.Name
  }
}

Write-Host ''
if ($baseline.Count -or $survived.Count) {
  Write-Host "FAIL: $($baseline.Count) baseline failure(s), $($survived.Count) mutant(s) survived." -ForegroundColor Red
  exit 1
}
Write-Host "PASS: baseline clean and all $($mutants.Count) mutants killed." -ForegroundColor Green
exit 0
