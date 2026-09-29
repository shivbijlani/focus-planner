<#
  mutcheck-session-bind-backwards.ps1 -- mutation check for #562: a per-task session binding may
  only ever move FORWARD.

  THE MEASURED DEFECT. Planner task #471, 2026-09-06. Three sessions existed, and each one's own
  kickoff prompt named the session it replaced, so the true lineage is not in doubt:

      b94abe44-33d1-4f0e-916a-38144c1b45f7   created 2026-09-05T20:41:43Z   (first)
      42d1a304-1b05-42c0-9ebb-eb35d94bed70   created 2026-09-06T04:36:24Z   replaces b94abe44
      9294bd58-cd07-4491-aa1c-778e95578b8b   created 2026-09-06T09:13:51Z   replaces 42d1a304

  The persisted binding then read `session_id: 42d1a304`, `prior_session_id: 9294bd58` -- the
  SUCCESSOR filed as the ancestor's predecessor, written at 09:22:05Z, nine minutes after the
  successor already existed. That is a cycle rather than a chain: the newest session is orphaned
  while still charged against capacity (#345), the continuity record points forwards in time, and
  the next `replace` verdict can flip the binding straight back again.

  WHY A SINGLE `prior_session_id` CANNOT FIX IT. One slot remembers one step. After 1 -> 2 -> 3 it
  holds only 2, so a bind back onto 1 is indistinguishable from an ordinary replacement, and a
  bind back onto 2 is refused only by luck of which step happens to be remembered. Arm C is the
  arm that pins this: it goes backwards TWO steps, which the single-slot shape cannot see at all.

  THE RULE UNDER TEST, stated once: a session id that appears anywhere in the task's retired
  lineage can never become that task's binding again. Arms:

    A  the forward chain 1 -> 2 -> 3 still binds, and the lineage accumulates
    B  rebinding the immediate ancestor is refused as `session_bind_backwards` (#471's exact case)
    C  rebinding the GRAND-ancestor is refused too   (kills a one-step-only check)
    D  -Force does NOT override the refusal          (kills an escape hatch back into the cycle)
    E  a genuinely new 4th session still binds       (kills "refuse everything", which would pass
                                                      A-D while breaking replacement entirely)
    F  a pre-#562 record (single `prior_session_id`, no array) still refuses
                                                     (kills a fix that only protects state written
                                                      after it shipped -- i.e. exactly none of the
                                                      tasks that already have a cycle)
    G  mutant: deleting the guard makes B allowed    (proves the arms are load-bearing)

  Read-only with respect to the real world: builds a throwaway state/journal dir under TEMP and
  drives the REAL oa-state.ps1 through its own -StateDir/-JournalDir. Never reads or writes the
  live store under %LOCALAPPDATA%\overnight-agent\state.

    pwsh -File mutcheck-session-bind-backwards.ps1
    pwsh -File mutcheck-session-bind-backwards.ps1 -ScriptPath <p>   # test another build
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

$utf8 = New-Object Text.UTF8Encoding($false)
$src = [IO.File]::ReadAllText($ScriptPath, $utf8)
$root = Join-Path ([IO.Path]::GetTempPath()) ('mutcheck-bindback-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$pass = 0; $fail = 0

# Resolve the PowerShell host rather than hard-coding `powershell`: this guard runs on the CI
# runner as well as the nightly laptop.
$psExe = if ($PSVersionTable.PSEdition -eq 'Core') { (Get-Process -Id $PID).Path } else { 'powershell' }
if (-not $psExe) { $psExe = 'pwsh' }

function Check([string]$label, [bool]$cond, [string]$detail) {
  if ($cond) { $script:pass++; Write-Host "  PASS  $label" }
  else { $script:fail++; Write-Host "  FAIL  $label$(if ($detail) { " -- $detail" })" }
}

# #471's real session ids, used verbatim. The arms are about ORDER, so the values only have to be
# distinct -- but keeping the measured ones means a failure here reads against the issue directly.
$S1 = 'b94abe44-33d1-4f0e-916a-38144c1b45f7'
$S2 = '42d1a304-1b05-42c0-9ebb-eb35d94bed70'
$S3 = '9294bd58-cd07-4491-aa1c-778e95578b8b'
$S4 = '0f4c1d2e-7a55-4b31-9c60-1e8a2f3b4c5d'   # a session this task has never used
$TaskId = '471'

# --- fixture world -----------------------------------------------------------------------
function New-World([string]$Name) {
  $w = Join-Path $root $Name
  $sd = Join-Path $w 'state'; $jd = Join-Path $w 'journal'
  New-Item -ItemType Directory -Force -Path $sd, $jd | Out-Null
  [IO.File]::WriteAllText((Join-Path $jd "task-$TaskId.md"),
    "# Task $TaskId`: fixture`r`n`r`nUser notes.`r`n", $utf8)
  $board = Join-Path $w 'planner.md'
  [IO.File]::WriteAllText($board,
    "## Today`r`n`r`n| ID | Task |`r`n|---|---|`r`n| $TaskId | fixture |`r`n", $utf8)
  [IO.File]::WriteAllText((Join-Path $w 'snooze.json'), '{}', $utf8)
  # Capacity is not what these arms are about, so it is set wide enough that a concurrency
  # refusal can never be mistaken for the lineage refusal under test.
  [IO.File]::WriteAllText((Join-Path $w 'settings.md'),
    "| Setting | Value |`r`n|---|---|`r`n| Overnight Agent concurrency | 5 |`r`n", $utf8)
  $runWs = Join-Path $w 'run-session-workspace'
  New-Item -ItemType Directory -Force -Path $runWs | Out-Null
  return [pscustomobject]@{
    Root = $w; State = $sd; Journal = $jd; Board = $board
    Store = (Join-Path $w 'snooze.json'); Settings = (Join-Path $w 'settings.md'); RunWs = $runWs
  }
}

function Invoke-Oa([string]$Script, $World, [string[]]$OaArgs) {
  $all = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $Script) + $OaArgs +
  @('-JournalDir', $World.Journal, '-StateDir', $World.State, '-PlannerBoard', $World.Board,
    '-SnoozeStore', $World.Store, '-PlannerCompleted', (Join-Path $World.Root 'absent.md'),
    '-UserSettings', $World.Settings, '-RunWorkspace', $World.RunWs)
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  # -Width is not cosmetic on the JSON-bearing calls: the default wraps captured output at the
  # host's render width, which splits a long JSON line and defeats ConvertFrom-Json.
  try { $out = & $psExe @all 2>&1 | Out-String -Width 4096 }
  catch { $out = "$_" }
  finally { $ErrorActionPreference = $prev; $global:LASTEXITCODE = 0 }
  return "$out"
}

function Invoke-Bind([string]$Script, $World, [string]$SessionId, [switch]$WithForce) {
  # The workspace is MATERIALISED, because a real one is: `create_session` makes the worktree and
  # only then is the binding written. Since #717 the verdict derives "gone" from the filesystem,
  # so a fixture naming a path it never creates would describe a torn-down worktree on every arm.
  $ws = Join-Path $World.Root ('wt-' + $SessionId.Substring(0, 8))
  New-Item -ItemType Directory -Force -Path $ws | Out-Null
  # A worktree's `.git` is a FILE (`gitdir: ...`), which is what the checkout test looks for.
  [IO.File]::WriteAllText((Join-Path $ws '.git'), 'gitdir: /repo/.git/worktrees/x', $utf8)
  $a = @('session', '-Id', $TaskId, '-SessionId', $SessionId, '-SessionKind', 'code',
    '-SessionProject', 'focus-planner', '-SessionWorkspace', $ws, '-WorkspaceType', 'worktree')
  if ($WithForce) { $a += '-Force' }
  return (Invoke-Oa $Script $World $a)
}

function Get-Bound([string]$Script, $World) {
  # Read the PERSISTED record, not the bind call's own echo: the defect was what ended up on
  # disk, and a guard that refuses loudly while still writing the binding would pass a
  # stdout-only probe.
  $p = Join-Path $World.State "task-$TaskId.json"
  if (-not (Test-Path $p)) { return $null }
  try { return (Get-Content -Raw $p | ConvertFrom-Json).session } catch { return $null }
}

function New-Chain([string]$Script, [string]$Name) {
  # Builds #471's exact shape: S1 replaced by S2 replaced by S3, each replacement going through
  # the sanctioned path (-SessionDead first), which is what records the continuity.
  $w = New-World $Name
  [void](Invoke-Oa $Script $w @('seed'))
  foreach ($s in @($S1, $S2, $S3)) {
    [void](Invoke-Bind $Script $w $s)
    [void](Invoke-Oa $Script $w @('session', '-Id', $TaskId, '-SessionDead'))
  }
  return $w
}

Write-Host "oa-state.ps1: $ScriptPath"
Write-Host ''

# --- A: the forward chain is unaffected ---------------------------------------------------
$wA = New-Chain $ScriptPath 'A'
$sessA = Get-Bound $ScriptPath $wA
Check 'A: the forward chain 1 -> 2 -> 3 binds, ending on the newest session' `
  ($null -ne $sessA -and "$($sessA.session_id)" -eq $S3) "bound to $($sessA.session_id)"
$lineageA = @()
if ($sessA -and $sessA.PSObject.Properties['prior_session_ids']) {
  $lineageA = @($sessA.prior_session_ids | ForEach-Object { "$_" })
}
Check 'A: the WHOLE lineage is retained, not just the last step' `
  ($lineageA -contains $S1 -and $lineageA -contains $S2) "lineage: $($lineageA -join ',')"

# --- B: #471's exact backwards rebind ------------------------------------------------------
$wB = New-Chain $ScriptPath 'B'
$outB = Invoke-Bind $ScriptPath $wB $S2
$sessB = Get-Bound $ScriptPath $wB
Check 'B: rebinding the immediate ancestor is refused by name (session_bind_backwards)' `
  ($outB -match 'session_bind_backwards') "output: $($outB.Trim() -replace '\s+', ' ')"
Check 'B: and the binding is LEFT on the newest session, not rewritten' `
  ($null -ne $sessB -and "$($sessB.session_id)" -eq $S3) "bound to $($sessB.session_id)"
# The cycle, stated as the thing that must not be on disk: #471 recorded the successor as the
# ancestor's prior. If that pair ever appears again the defect is back, whatever else passed.
Check 'B: the successor is never recorded as the ancestor predecessor (no cycle)' `
  (-not ($null -ne $sessB -and "$($sessB.session_id)" -eq $S2 -and "$($sessB.prior_session_id)" -eq $S3)) `
  "session_id=$($sessB.session_id) prior=$($sessB.prior_session_id)"

# --- C: two steps back, which one slot cannot see -----------------------------------------
$wC = New-Chain $ScriptPath 'C'
$outC = Invoke-Bind $ScriptPath $wC $S1
$sessC = Get-Bound $ScriptPath $wC
Check 'C: rebinding the GRAND-ancestor is refused too (not just the last step)' `
  ($outC -match 'session_bind_backwards') "output: $($outC.Trim() -replace '\s+', ' ')"
Check 'C: and that binding is left on the newest session' `
  ($null -ne $sessC -and "$($sessC.session_id)" -eq $S3) "bound to $($sessC.session_id)"

# --- D: -Force is not a way back into the cycle -------------------------------------------
$wD = New-Chain $ScriptPath 'D'
$outD = Invoke-Bind $ScriptPath $wD $S2 -WithForce
$sessD = Get-Bound $ScriptPath $wD
Check 'D: -Force does NOT override the refusal' `
  ($outD -match 'session_bind_backwards') "output: $($outD.Trim() -replace '\s+', ' ')"
Check 'D: and -Force leaves the binding on the newest session' `
  ($null -ne $sessD -and "$($sessD.session_id)" -eq $S3) "bound to $($sessD.session_id)"

# --- E: forward motion still works --------------------------------------------------------
# Without this arm, "refuse every replacement" would satisfy A-D while destroying the feature.
$wE = New-Chain $ScriptPath 'E'
$outE = Invoke-Bind $ScriptPath $wE $S4
$sessE = Get-Bound $ScriptPath $wE
Check 'E: a session this task has never used still binds' `
  ($outE -notmatch 'session_bind_backwards' -and $null -ne $sessE -and "$($sessE.session_id)" -eq $S4) `
  "bound to $($sessE.session_id)"
Check 'E: and the replaced session joins the lineage' `
  ($null -ne $sessE -and "$($sessE.prior_session_id)" -eq $S3) "prior=$($sessE.prior_session_id)"

# --- F: a record written BEFORE this fix ---------------------------------------------------
# The tasks that already have a cycle are precisely the ones whose state carries no lineage array.
# A fix that reads only the new field would leave every one of them unprotected.
$wF = New-World 'F'
[void](Invoke-Oa $ScriptPath $wF @('seed'))
$legacyWs = Join-Path $wF.Root 'wt-legacy'
New-Item -ItemType Directory -Force -Path $legacyWs | Out-Null
[IO.File]::WriteAllText((Join-Path $legacyWs '.git'), 'gitdir: /repo/.git/worktrees/x', $utf8)
$legacy = [ordered]@{
  id = $TaskId; status = 'in-progress'; status_by = 'agent'; version = 1
  plan_id = "t$TaskId-v1"; processed_file_hash = ''; has_agent_block = $true
  seeded = $false; updated = '2026-09-06T02:22:05-07:00'
  session = [ordered]@{
    session_id = $S3; kind = 'code'; project = 'focus-planner'
    workspace = $legacyWs; workspace_type = 'worktree'
    created_at = '2026-09-06T02:13:51-07:00'; last_woken_at = ''
    state = 'dead'
    # The pre-#562 shape exactly: ONE predecessor slot and no array at all.
    prior_session_id = $S2
    replaced_at = '2026-09-06T02:13:51-07:00'
  }
}
[IO.File]::WriteAllText((Join-Path $wF.State "task-$TaskId.json"),
  ($legacy | ConvertTo-Json -Depth 8), $utf8)
$outF = Invoke-Bind $ScriptPath $wF $S2
$sessF = Get-Bound $ScriptPath $wF
Check 'F: a pre-fix record (single prior_session_id, no array) is still protected' `
  ($outF -match 'session_bind_backwards') "output: $($outF.Trim() -replace '\s+', ' ')"
Check 'F: and that legacy binding is not rewritten backwards' `
  ($null -ne $sessF -and "$($sessF.session_id)" -eq $S3) "bound to $($sessF.session_id)"

# --- G: the mutant ------------------------------------------------------------------------
# Delete the monotonicity check and arm B must flip from refused to allowed. Without this, the
# arms above would still pass against a build whose guard never fires, because a bind that is
# refused for some OTHER reason looks identical from outside.
$mutFind = '    if ($sess -and "$($sess.session_id)" -ne $SessionId -and $lineage -contains $SessionId) {'
$mutRepl = '    if ($false) {'
if ($src.IndexOf($mutFind) -lt 0) {
  Check 'G: mutation anchor present in source' $false "not found: $mutFind"
}
else {
  $mutPath = Join-Path $root 'oa-state-mut-nobackguard.ps1'
  [IO.File]::WriteAllText($mutPath, $src.Replace($mutFind, $mutRepl), $utf8)
  $wG = New-Chain $mutPath 'G'
  $outG = Invoke-Bind $mutPath $wG $S2
  $sessG = Get-Bound $mutPath $wG
  Check 'G: removing the guard lets the backwards rebind through (arm B is load-bearing)' `
    ($outG -notmatch 'session_bind_backwards') "output: $($outG.Trim() -replace '\s+', ' ')"
  # ...and the mutant reproduces #471's recorded state EXACTLY -- the ancestor bound, with its own
  # successor filed as its predecessor. This is the arm that ties the fixture to the measurement.
  Check 'G: and the mutant reproduces #471 exactly (42d1a304 bound, prior 9294bd58)' `
    ($null -ne $sessG -and "$($sessG.session_id)" -eq $S2 -and "$($sessG.prior_session_id)" -eq $S3) `
    "session_id=$($sessG.session_id) prior=$($sessG.prior_session_id)"
}

Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue
Write-Host ''
Write-Host "$pass passed, $fail failed"
exit $(if ($fail) { 1 } else { 0 })
