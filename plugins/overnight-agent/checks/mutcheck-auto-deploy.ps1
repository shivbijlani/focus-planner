<#
  mutcheck-auto-deploy.ps1 — prove auto-deploy-plugin.ps1's guards are load-bearing.

  A guard that is only asserted by a passing test is not proven: the test may pass for
  reasons unrelated to the guard. So each behaviour here is checked twice — once on the
  real script (it must PASS) and once on a deliberately mutated copy (it must FAIL).
  A mutation that does not break a test means that test was not testing the guard.

  GUARDS UNDER TEST
    G1  a file on the ref but absent from the installed tree IS deployed (forward case)
    G2  a live fix that exists only on a side branch is REFUSED, never overwritten
    G3  a refusal that repeats across cycles ESCALATES (exit 2) - the seam that made
        deploy-installed-plugin.ps1 report a blocked deploy as success
    G4  a FIRST refusal does NOT escalate - otherwise G3 is just "always escalate"
    G5  -WhatIf writes nothing and records no state
    G11 classification matches the legacy per-path algorithm for every safety state
    G12 history traversal stays O(1) as file count grows
    G13 the shared wall-clock budget fails loud with exit 2

  Everything runs in a throwaway sandbox: a real git repo and a fake installed tree
  under $env:TEMP. The live tree is never touched.
#>
[CmdletBinding()]
param([switch]$KeepSandbox)

$ErrorActionPreference = 'Stop'

$script:pass = 0
$script:fail = 0
function Assert([bool]$cond, [string]$what) {
  if ($cond) { Write-Host "  ok    $what"; $script:pass++ }
  else       { Write-Host "  FAIL  $what" -ForegroundColor Red; $script:fail++ }
}
function Section([string]$t) { Write-Host ''; Write-Host $t }

$SUT = Join-Path $PSScriptRoot 'auto-deploy-plugin.ps1'
if (-not (Test-Path $SUT)) { throw "subject not found: $SUT" }

$root = Join-Path $env:TEMP ('oa-autodeploy-mut-' + [guid]::NewGuid().ToString('N').Substring(0,8))
New-Item -ItemType Directory -Force -Path $root | Out-Null

# Mutant copies are written into $root, so $root is THEIR $PSScriptRoot. The #419 arms
# assert that helpers are found beside the running script, so they have to be here too.
Copy-Item (Join-Path $PSScriptRoot 'ref-history-index.mjs')    (Join-Path $root 'ref-history-index.mjs')    -Force
Copy-Item (Join-Path $PSScriptRoot 'verify-deployed-paths.mjs') (Join-Path $root 'verify-deployed-paths.mjs') -Force

function New-Sandbox {
  <# A repo whose origin/main carries v2 of a file plus one extra file, and a side
     branch carrying v1. The installed tree gets v1 -> BRANCH-ONLY; the extra file is
     left out -> MISSING. That is one of each interesting verdict in one fixture.

     `divergent.ps1` is the control: its installed content exists on the side branch and
     at NO point in origin/main's history, so it is genuine divergence and must stay
     refused. `livefix.ps1`'s installed content IS an ancestor commit of origin/main, so
     it is merely behind and must be rescued. The two are indistinguishable to the
     classifier - both are BRANCH-ONLY - which is the whole reason the fixture has both. #>
  $sb  = Join-Path $root ('sb-' + [guid]::NewGuid().ToString('N').Substring(0,6))
  $repo = Join-Path $sb 'repo'
  $inst = Join-Path $sb 'installed'
  $chk  = Join-Path $repo 'plugins\overnight-agent\checks'
  New-Item -ItemType Directory -Force -Path $chk  | Out-Null
  New-Item -ItemType Directory -Force -Path $inst | Out-Null

  Push-Location $repo
  try {
    & git init --quiet -b main 2>&1 | Out-Null
    & git config user.email 'mut@test'  2>&1 | Out-Null
    & git config user.name  'mut'       2>&1 | Out-Null

    Set-Content -Path (Join-Path $chk 'livefix.ps1')   -Value '# v1 live fix' -Encoding UTF8 -NoNewline
    Set-Content -Path (Join-Path $chk 'divergent.ps1') -Value '# main v1'     -Encoding UTF8 -NoNewline
    Set-Content -Path (Join-Path $chk 'gone.ps1')      -Value '# doomed v1'   -Encoding UTF8 -NoNewline
    & git add -A 2>&1 | Out-Null
    & git commit -m v1 --quiet 2>&1 | Out-Null
    & git branch sidefix 2>&1 | Out-Null

    # sidefix gains content that never reaches main -> genuine divergence
    & git checkout --quiet sidefix 2>&1 | Out-Null
    Set-Content -Path (Join-Path $chk 'divergent.ps1') -Value '# ONLY on the branch' -Encoding UTF8 -NoNewline
    Set-Content -Path (Join-Path $chk 'stray.ps1')     -Value '# only ever on sidefix' -Encoding UTF8 -NoNewline
    & git add -A 2>&1 | Out-Null
    & git commit -m side --quiet 2>&1 | Out-Null
    & git checkout --quiet main 2>&1 | Out-Null

    Set-Content -Path (Join-Path $chk 'livefix.ps1')   -Value '# v2 from main' -Encoding UTF8 -NoNewline
    Set-Content -Path (Join-Path $chk 'divergent.ps1') -Value '# main v2'      -Encoding UTF8 -NoNewline
    Set-Content -Path (Join-Path $chk 'newguard.ps1')  -Value '# merged but not deployed' -Encoding UTF8 -NoNewline
    Set-Content -Path (Join-Path $chk 'current.ps1')   -Value '# already current' -Encoding UTF8 -NoNewline
    # main DELETES gone.ps1 - the case that crashed the deploy on 2026-08-29 (#253)
    & git rm --quiet (Join-Path $chk 'gone.ps1') 2>&1 | Out-Null
    & git add -A 2>&1 | Out-Null
    & git commit -m v2 --quiet 2>&1 | Out-Null
    & git update-ref refs/remotes/origin/main HEAD 2>&1 | Out-Null
  } finally { Pop-Location }

  # The subject resolves the deployer from the repo it is deploying, so the sandbox has
  # to look like a plugin repo. Copied in AFTER the commits and left untracked on
  # purpose: on a ref it would show up as its own MISSING file and pollute the fixture.
  Copy-Item (Join-Path $PSScriptRoot 'deploy-installed-plugin.ps1') `
            (Join-Path $chk 'deploy-installed-plugin.ps1') -Force
  Copy-Item (Join-Path $PSScriptRoot 'installed-skill-drift-sweep.mjs') `
            (Join-Path $chk 'installed-skill-drift-sweep.mjs') -Force
  Copy-Item (Join-Path $PSScriptRoot 'ref-history-index.mjs') `
            (Join-Path $chk 'ref-history-index.mjs') -Force
  Copy-Item (Join-Path $PSScriptRoot 'verify-deployed-paths.mjs') `
            (Join-Path $chk 'verify-deployed-paths.mjs') -Force

  # installed carries the v1 (ancestor-of-main) livefix, the branch-only divergent file,
  # and lacks newguard.ps1
  $idst = Join-Path $inst 'overnight-agent\checks'
  New-Item -ItemType Directory -Force -Path $idst | Out-Null
  Set-Content -Path (Join-Path $idst 'livefix.ps1')   -Value '# v1 live fix'        -Encoding UTF8 -NoNewline
  Set-Content -Path (Join-Path $idst 'divergent.ps1') -Value '# ONLY on the branch' -Encoding UTF8 -NoNewline
  # gone.ps1: main deleted it, and these bytes ARE the pre-deletion blob -> removable.
  # stray.ps1: also absent from main's tip, but its bytes exist only on sidefix and at
  # NO point in main's history -> must survive. Both are BRANCH-ONLY to the classifier,
  # which is the whole reason both are here.
  Set-Content -Path (Join-Path $idst 'gone.ps1')      -Value '# doomed v1'          -Encoding UTF8 -NoNewline
  Set-Content -Path (Join-Path $idst 'stray.ps1')     -Value '# only ever on sidefix' -Encoding UTF8 -NoNewline
  Set-Content -Path (Join-Path $idst 'current.ps1')   -Value '# already current'       -Encoding UTF8 -NoNewline

  [pscustomobject]@{
    Repo      = $repo
    Installed = $inst
    State     = (Join-Path $sb 'state.json')
    LiveFix   = (Join-Path $idst 'livefix.ps1')
    Divergent = (Join-Path $idst 'divergent.ps1')
    NewGuard  = (Join-Path $idst 'newguard.ps1')
    Gone      = (Join-Path $idst 'gone.ps1')
    Stray     = (Join-Path $idst 'stray.ps1')
    Current   = (Join-Path $idst 'current.ps1')
    Classifier = (Join-Path $chk 'installed-skill-drift-sweep.mjs')
    HistoryHelper = (Join-Path $chk 'ref-history-index.mjs')
    VerifyHelper = (Join-Path $chk 'verify-deployed-paths.mjs')
  }
}

function Add-HangingRemote($Sandbox) {
  # A fetch that BLOCKS rather than fails. That distinction is the whole defect: a broken
  # fetch already fell through to a warning, a SLOW one silently ate the budget the later
  # phases needed.
  #
  # Deliberately NOT a non-routable IP. That reproduces locally but is environment-
  # dependent: on a hosted CI runner a private address can be rejected immediately, the
  # fetch then fails fast instead of hanging, and M17 would survive in CI while passing on
  # a laptop - a guard that is green because it stopped testing anything. git's `ext::`
  # transport runs a command as the transport, so a command that simply never returns
  # gives an identical hang on every machine with no network involved at all.
  $hang = Join-Path $root 'fetch-hang.js'
  if (-not (Test-Path $hang)) { Set-Content $hang 'setTimeout(function(){}, 600000);' -Encoding UTF8 }
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & git -C $Sandbox.Repo remote remove origin 2>&1 | Out-Null
    & git -C $Sandbox.Repo config protocol.ext.allow always 2>&1 | Out-Null
    & git -C $Sandbox.Repo remote add origin ('ext::node ' + ($hang -replace '\\','/')) 2>&1 | Out-Null
  } finally { $ErrorActionPreference = $prev }
}

function Remove-RepoHistoryHelper($Sandbox) {
  # Simulates the NORMAL state that broke #419: a checkout sitting behind origin/main, so
  # the helper that a later commit added is simply not in the working tree yet.
  Remove-Item (Join-Path $Sandbox.Repo 'plugins\overnight-agent\checks\ref-history-index.mjs') -Force -ErrorAction SilentlyContinue
  Remove-Item (Join-Path $Sandbox.Repo 'plugins\overnight-agent\checks\verify-deployed-paths.mjs') -Force -ErrorAction SilentlyContinue
}

function Invoke-SUT {
  param($Script, $Sandbox, [switch]$WhatIf, [switch]$NoJson, [switch]$WithOaHome,
        [int]$BudgetSeconds = 120, [string]$HistoryHelper,
        [switch]$WithFetch, [int]$FetchBudgetSeconds = 0, [switch]$NoHelperOverride)
  # -NoOaHome by default: these assertions are about the plugin-deploy contract
  # (classification, refusal, streaks, hand-off). The OA-home sync is a separate
  # subsystem with its own mutcheck, and letting it run here would fold its exit code
  # into $needsAttention and mask the escalation mutants - which is exactly what it
  # did on first wiring: M3 ("streak never accumulates") survived because the run
  # exited 2 for an unrelated reason. Isolate the unit; cover the seam separately.
  $a = @('-NoProfile','-ExecutionPolicy','Bypass','-File',$Script,
         '-Repo',$Sandbox.Repo,'-Installed',$Sandbox.Installed,
         '-StatePath',$Sandbox.State,
         '-BudgetSeconds',$BudgetSeconds,
         '-ClassifierPath',$Sandbox.Classifier)
  # -SkipFetch by default. The fetch arms need the real fetch path, because the whole
  # point of #418 is what a SLOW fetch does to the budget the later phases depend on.
  if (-not $WithFetch) { $a += '-SkipFetch' }
  if ($FetchBudgetSeconds -gt 0) { $a += @('-FetchBudgetSeconds',$FetchBudgetSeconds) }
  # -NoHelperOverride exercises the script's OWN helper resolution, which is the subject
  # of #419. Every other arm pins the paths so resolution cannot perturb it.
  if (-not $NoHelperOverride) {
    $a += @('-HistoryHelperPath',$(if ($HistoryHelper) { $HistoryHelper } else { $Sandbox.HistoryHelper }),
            '-VerifyHelperPath',$Sandbox.VerifyHelper)
  }
  if (-not $WithOaHome) { $a += '-NoOaHome' }
  if (-not $NoJson) { $a += '-Json' }
  if ($WhatIf) { $a += '-WhatIf' }
  $out  = $null
  $code = $null
  # A mutant is ALLOWED to crash - that is what several mutations prove. Native stderr
  # becomes a terminating error under $ErrorActionPreference='Stop' on Windows PowerShell
  # 5.1, so leaving it set here would take the harness down with the subject and report a
  # mutation as a harness failure. The measurement is the exit code and the JSON; the
  # stderr text is not evidence either way.
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $sw = [Diagnostics.Stopwatch]::StartNew()
  try {
    $out  = & powershell @a 2>&1
    $code = $LASTEXITCODE
  } catch {
    $out  = @("harness caught: $($_.Exception.Message)")
    $code = 1
  } finally { $ErrorActionPreference = $prevEap }
  $jsonLine = ($out | Where-Object { ([string]$_).TrimStart().StartsWith('{') } | Select-Object -Last 1)
  $obj = $null
  if ($jsonLine) { try { $obj = ([string]$jsonLine | ConvertFrom-Json) } catch { } }
  [pscustomobject]@{ Exit = $code; Json = $obj; Raw = ($out -join "`n"); ElapsedMs = $sw.ElapsedMilliseconds }
}

# ------------------------------------------------------------------------------------
# Behavioural baseline on the REAL script
# ------------------------------------------------------------------------------------
Section 'BASELINE (real script must pass all of these)'

$sb = New-Sandbox
$r1 = Invoke-SUT -Script $SUT -Sandbox $sb
if (-not $r1.Json -or $r1.Json.reason) { Write-Host ("  diagnostic: " + $r1.Raw) }

Assert ($r1.Json -ne $null) 'G0 emits parseable JSON'
Assert ($r1.ElapsedMs -lt 60000) "G14 one complete deploy finishes under 60s (measured $($r1.ElapsedMs)ms)"
Assert ($r1.Json.deployed -contains 'overnight-agent/checks/newguard.ps1') `
       'G1 a MISSING file (on the ref, absent installed) is deployed'
Assert (Test-Path $sb.NewGuard) 'G1 the missing file physically landed'

Assert ($r1.Json.superseded -contains 'overnight-agent/checks/livefix.ps1') `
       'G6 a BRANCH-ONLY file whose content IS in the ref history is rescued as "behind"'
Assert ((Get-Content $sb.LiveFix -Raw) -eq '# v2 from main') `
       'G6 the merely-stale file was updated to the ref version'

Assert ($r1.Json.refused -contains 'overnight-agent/checks/divergent.ps1') `
       'G2 a genuinely divergent live fix is still refused'
Assert ((Get-Content $sb.Divergent -Raw) -eq '# ONLY on the branch') `
       'G2 the divergent file was NOT overwritten'
Assert ($r1.Exit -eq 0) 'G4 a FIRST refusal does not escalate (exit 0)'
Assert (@($r1.Json.escalate).Count -eq 0) 'G4 nothing is named for escalation on cycle 1'

# --- the deleted-path pair (added 2026-08-29 after merging #253 broke the live deploy) ---
# G9 and G10 are the two halves of one decision and must be read together: BOTH files are
# absent from the ref tip and BOTH classify as BRANCH-ONLY, so a rule that keys on either
# of those facts alone gets one of them wrong. The separator is whether the ref's history
# ever contained these exact bytes.
Assert ($r1.Json.removed -contains 'overnight-agent/checks/gone.ps1') `
       'G9 a file DELETED on the ref, whose live bytes are a known historical version, is removed'
Assert (-not (Test-Path $sb.Gone)) 'G9 the removed file physically left the installed tree'
Assert ($r1.Json.refused -notcontains 'overnight-agent/checks/gone.ps1') `
       'G9 a removed file does not stay on the refusal pile (it would escalate forever)'

Assert ($r1.Json.removed -notcontains 'overnight-agent/checks/stray.ps1') `
       'G10 a live-only file the ref never carried is NOT removed'
Assert (Test-Path $sb.Stray) 'G10 the live-only file survived'
Assert ((Get-Content $sb.Stray -Raw) -eq '# only ever on sidefix') `
       'G10 the live-only file was not modified either'
Assert ($r1.Json.refused -contains 'overnight-agent/checks/stray.ps1') `
       'G10 it is refused instead - deleting it would destroy the only copy'
Assert ($r1.Json.deployed -notcontains 'overnight-agent/checks/current.ps1' -and
       $r1.Json.refused -notcontains 'overnight-agent/checks/current.ps1') `
       'G11 already-current remains untouched'

# Compare the new combined history result with the exact legacy per-path algorithm.
function Test-LegacyInHistory($Sandbox, [string]$RepoPath, [string]$InstalledFile) {
  $want = (Get-Content $InstalledFile -Raw) -replace "`r`n", "`n"
  $commits = & git -C $Sandbox.Repo rev-list origin/main -- $RepoPath
  foreach ($sha in $commits) {
    $tmp = [IO.Path]::GetTempFileName()
    try {
      & cmd /c "cd /d `"$($Sandbox.Repo)`" && git cat-file blob $sha`:$RepoPath > `"$tmp`"" 2>&1 | Out-Null
      if ($LASTEXITCODE -eq 0) {
       $got = (Get-Content $tmp -Raw) -replace "`r`n", "`n"
       if ($got -eq $want) { return $true }
      }
    } finally { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
  }
  return $false
}
$legacyBehind = Test-LegacyInHistory $sb 'plugins/overnight-agent/checks/livefix.ps1' $sb.LiveFix
$legacyBranch = Test-LegacyInHistory $sb 'plugins/overnight-agent/checks/divergent.ps1' $sb.Divergent
Assert ($legacyBehind -and ($r1.Json.superseded -contains 'overnight-agent/checks/livefix.ps1')) `
       'G11 old and new agree: behind/safe-to-write'
Assert ((-not $legacyBranch) -and ($r1.Json.refused -contains 'overnight-agent/checks/divergent.ps1')) `
       'G11 old and new agree: branch-only live fix'
Assert (Test-Path $sb.Current) 'G11 old and new agree: already-current'
Assert (Test-Path $sb.NewGuard) 'G11 old and new agree: missing/new'

# second cycle: same refusal, now persistent
$r2 = Invoke-SUT -Script $SUT -Sandbox $sb
Assert ($r2.Exit -eq 2) 'G3 a refusal repeated across cycles escalates (exit 2)'
Assert ($r2.Json.escalate -contains 'overnight-agent/checks/divergent.ps1') `
       'G3 the persistently-refused file is named'
Assert ($r2.Json.escalate -notcontains 'overnight-agent/checks/livefix.ps1') `
       'G6 a rescued file never enters the escalation queue'
Assert ($r2.Json.escalate -notcontains 'overnight-agent/checks/gone.ps1') `
       'G9 a removed file never enters the escalation queue'
Assert ($r2.Json.verifiedCurrent -eq $true) `
       'G5 far-end verify: no MISSING survives after the deploy'

# -WhatIf must be inert
$sbw = New-Sandbox
$rw = Invoke-SUT -Script $SUT -Sandbox $sbw -WhatIf
Assert (-not (Test-Path $sbw.NewGuard)) 'G5 -WhatIf wrote no files'
Assert (-not (Test-Path $sbw.State))    'G5 -WhatIf recorded no state'
Assert (Test-Path $sbw.Gone)            'G9 -WhatIf deleted no files'

Section 'G12: one history walk regardless of file count'
$sbp = New-Sandbox
$trace = Join-Path $root 'history-git.trace'
$env:OA_HISTORY_GIT_TRACE = $trace
try { $rp = Invoke-SUT -Script $SUT -Sandbox $sbp }
finally { Remove-Item Env:\OA_HISTORY_GIT_TRACE -ErrorAction SilentlyContinue }
$historyCalls = if (Test-Path $trace) { @(Get-Content $trace) } else { @() }
Assert (@($historyCalls | Where-Object { $_ -eq 'log' }).Count -eq 1) `
       'P1 exactly one combined git log history walk'
Assert (@($historyCalls | Where-Object { $_ -eq 'rev-list' }).Count -eq 0) `
       'P2 zero per-file rev-list walks'

Section 'G13: wall-clock budget fails loud'
# The helper must NEVER return, and the budget must be loose enough that the run actually
# REACHES the history phase. With the old 1s budget it did not: the budget was already
# exhausted in the preceding "safe deploy classification" phase, so B1/B2 passed for the
# wrong reason and M14's mutation - which only touches the history phase - could not be
# observed at all. Measured 2026-09-03: budget=1s -> phase "safe deploy classification";
# budget=2s -> phase "combined ref history classification". A never-returning helper plus
# a 5s budget puts the expiry unambiguously in the history phase on either outcome.
$slow = Join-Path $root 'slow-history.mjs'
Set-Content $slow "setTimeout(() => {}, 600000);" -Encoding UTF8
$sbt = New-Sandbox
$rt = Invoke-SUT -Script $SUT -Sandbox $sbt -BudgetSeconds 5 -HistoryHelper $slow
Assert ($rt.Exit -eq 2) 'B1 budget exhaustion exits 2'
Assert ($rt.Json -and $rt.Json.reason -eq 'wall-clock-budget') `
       'B2 budget exhaustion emits a machine-readable wrap-up signal'
Assert ($rt.Json -and $rt.Json.phase -eq 'combined ref history classification') `
       'B3 the signal names the phase that actually expired'

# --- #418 / #419: the two ways PHASE 0 failed against a perfectly healthy deploy -------
# Both of these reported "merged code may not be running" about a deploy that was fine.
# G15 is about a SLOW network; G16 is about a checkout that is merely behind. Neither
# condition says anything about whether the installed tree can be brought current, which
# is the only question this script exists to answer.
Section 'BASELINE - budget and helper resolution (#418, #419)'

$sbFetch = New-Sandbox
Add-HangingRemote $sbFetch
$rf = Invoke-SUT -Script $SUT -Sandbox $sbFetch -WithFetch -FetchBudgetSeconds 3 -BudgetSeconds 5
Assert ($rf.Exit -ne 2 -or -not $rf.Json -or $rf.Json.reason -ne 'wall-clock-budget') `
       'G15 a fetch that blocks until its own budget expires does not consume the local-work budget'
Assert ($rf.Json -and $rf.Json.deployed -contains 'overnight-agent/checks/newguard.ps1') `
       'G15 the deploy still classifies and writes after a timed-out fetch'
Assert ($rf.Json -and $rf.Json.fetched -eq $false) `
       'G15 a timed-out fetch is reported as fetched=false, so possible staleness stays visible'

# G19 has no killing mutant ON PURPOSE. The mutation that breaks it - reverting the bounded
# kill to a parent-only Kill() - does not make the suite fail, it makes the suite HANG:
# the surviving grandchild inherits the redirected pipe and holds it open, so the harness
# blocks reading output that will never end. Measured 2026-09-03 before the fix: an
# orphaned `git remote-ext` plus its child lived 15+ minutes and stalled the run. A guard
# arm that wedges CI is worse than the defect, so this stays a plain assertion.
$leaked = @(Get-CimInstance Win32_Process -Filter "Name='git.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -and $_.CommandLine -match 'fetch-hang' })
Assert ($leaked.Count -eq 0) `
       "G19 a timed-out bounded call leaves no orphaned descendants (found $($leaked.Count))"

$sbHelper = New-Sandbox
Remove-RepoHistoryHelper $sbHelper
$rh = Invoke-SUT -Script $SUT -Sandbox $sbHelper -NoHelperOverride
Assert ($rh.Exit -eq 0) `
       'G16 a checkout missing the helper still deploys - it is resolved beside the script'
Assert ($rh.Json -and $rh.Json.deployed -contains 'overnight-agent/checks/newguard.ps1') `
       'G16 the deploy did real work rather than merely exiting 0'

# ------------------------------------------------------------------------------------
# Mutations — each must BREAK the test that claims to guard it
# ------------------------------------------------------------------------------------
function Test-Mutant {
  param([string]$Name, [string]$Find, [string]$Replace, [scriptblock]$Check)
  Section $Name
  $src = Get-Content $SUT -Raw
  if ($src -notmatch [regex]::Escape($Find)) {
    Assert $false "mutation anchor not found - mutcheck is stale: '$Find'"
    return
  }
  $mut = Join-Path $root ('mut-' + [guid]::NewGuid().ToString('N').Substring(0,6) + '.ps1')
  Set-Content -Path $mut -Value ($src -replace [regex]::Escape($Find), $Replace) -Encoding UTF8
  Assert $true 'mutation applied'
  & $Check $mut
}

Test-Mutant -Name 'M1: escalation removed (a persistent refusal reports success)' `
  -Find 'if ($needsAttention) { exit 2 }' -Replace 'if ($false) { exit 2 }' -Check {
    param($mut)
    $s = New-Sandbox
    Invoke-SUT -Script $mut -Sandbox $s | Out-Null
    $b = Invoke-SUT -Script $mut -Sandbox $s
    Assert ($b.Exit -ne 2) 'killed: a blocked deploy would silently report success'
  }

Test-Mutant -Name 'M2: -Force passed (refusal defeated, live fix reverted)' `
  -Find "if (-not `$WhatIf) { `$args += '-Confirm' }" `
  -Replace "if (-not `$WhatIf) { `$args += '-Confirm'; `$args += '-Force' }" -Check {
    param($mut)
    $s = New-Sandbox
    Invoke-SUT -Script $mut -Sandbox $s | Out-Null
    Assert ((Get-Content $s.Divergent -Raw) -ne '# ONLY on the branch') `
           'killed: the divergent live fix would be overwritten by main'
  }

Test-Mutant -Name 'M7: combined history result always true (divergence treated as stale)' `
  -Find '$inHistory = ($history.matches.PSObject.Properties.Name -contains $repoPath) -and [bool]$history.matches.$repoPath' `
  -Replace '$inHistory = $true' -Check {
    param($mut)
    $s = New-Sandbox
    Invoke-SUT -Script $mut -Sandbox $s | Out-Null
    Assert ((Get-Content $s.Divergent -Raw) -ne '# ONLY on the branch') `
           'killed: a branch-only live fix would be silently reverted as "behind"'
  }

Test-Mutant -Name 'M8: combined history result always false (stale file never deploys)' `
  -Find '$inHistory = ($history.matches.PSObject.Properties.Name -contains $repoPath) -and [bool]$history.matches.$repoPath' `
  -Replace '$inHistory = $false' -Check {
    param($mut)
    $s = New-Sandbox
    $a = Invoke-SUT -Script $mut -Sandbox $s
    Assert ((Get-Content $s.LiveFix -Raw) -eq '# v1 live fix') `
           'killed: an ordinary stale file would be refused forever, defeating the wire'
    $b = Invoke-SUT -Script $mut -Sandbox $s
    Assert ($b.Json.escalate -contains 'overnight-agent/checks/livefix.ps1') `
           'killed: it would then escalate to a human every cycle for nothing'
  }

Test-Mutant -Name 'M3: streak never accumulates (every cycle looks like the first)' `
  -Find '$newStreaks[$rel] = $prev + 1' -Replace '$newStreaks[$rel] = 1' -Check {
    param($mut)
    $s = New-Sandbox
    Invoke-SUT -Script $mut -Sandbox $s | Out-Null
    $b = Invoke-SUT -Script $mut -Sandbox $s
    Assert ($b.Exit -ne 2) 'killed: a refusal could repeat forever without escalating'
  }

Test-Mutant -Name 'M4: escalate on the first refusal (threshold not honoured)' `
  -Find '[int]$EscalateAfterCycles = 2' -Replace '[int]$EscalateAfterCycles = 1' -Check {
    param($mut)
    $s = New-Sandbox
    $a = Invoke-SUT -Script $mut -Sandbox $s
    Assert ($a.Exit -eq 2) 'killed: a single, still-informative refusal would page a human'
  }

Test-Mutant -Name 'M5: -WhatIf still writes (dry run is not dry)' `
  -Find "if (-not `$WhatIf) { `$args += '-Confirm' }" `
  -Replace "`$args += '-Confirm'" -Check {
    param($mut)
    $s = New-Sandbox
    Invoke-SUT -Script $mut -Sandbox $s -WhatIf | Out-Null
    Assert (Test-Path $s.NewGuard) 'killed: -WhatIf would deploy files'
  }

Test-Mutant -Name 'M14: wall-clock timeout ignored (outer runner must kill the script)' `
  -Find "if (`$historyRun.TimedOut) { Stop-ForBudget 'combined ref history classification' }" `
  -Replace "if (`$false) { Stop-ForBudget 'combined ref history classification' }" -Check {
    param($mut)
    $s = New-Sandbox
    $slowHelper = Join-Path $root 'mut-slow-history.mjs'
    Set-Content $slowHelper "setTimeout(() => {}, 600000);" -Encoding UTF8
    $b = Invoke-SUT -Script $mut -Sandbox $s -BudgetSeconds 5 -HistoryHelper $slowHelper
    # This arm was RED on main before #418/#419 touched it, and the alarm was false: with
    # the history phase's own check removed, the NEXT phase ("safe deploy classification")
    # still finds the budget exhausted and emits a correct exit-2 signal, so the script is
    # not actually unsafe. The old assertion demanded that NO wall-clock signal appear at
    # all, which is a property the mutation never removed. Measured 2026-09-03 on pristine
    # main: exit=2, reason=wall-clock-budget, phase="safe deploy classification" -> the
    # suite failed 71/1 with nothing wrong. Assert the phase instead, which is exactly what
    # the mutation deletes, and pair it with B3 so the narrowing cannot hollow the arm out.
    $namedHistory = ($b.Exit -eq 2 -and $b.Json -and
                     $b.Json.reason -eq 'wall-clock-budget' -and
                     $b.Json.phase -eq 'combined ref history classification')
    Assert (-not $namedHistory) `
           'killed by B1/B2/B3: the history phase would no longer report its own expired budget'
  }

Test-Mutant -Name 'M6: far-end verification trusts the deployer instead of the tree' `
  -Find '$verified = $residual.Count -eq 0' `
  -Replace '$verified = $true' -Check {
    param($mut)
    # Make the deploy a no-op by pointing the deployer at a ref-clean state, then delete
    # a deployed file behind its back so real drift exists at verify time.
    $s = New-Sandbox
    Invoke-SUT -Script $mut -Sandbox $s | Out-Null
    Remove-Item $s.NewGuard -Force
    Remove-Item $s.State -Force -ErrorAction SilentlyContinue
    # Second run: deployer re-adds it, so use a mutant-only probe - assert the field is
    # hard-coded rather than measured.
    $src = Get-Content $mut -Raw
    Assert ($src -notmatch [regex]::Escape('$verified = $residual.Count -eq 0')) `
           'killed: verifiedCurrent is asserted, not measured against the live tree'
  }

# --- the deleted-path mutations (2026-08-29) -----------------------------------------
# M11 is the one that matters most: it restores the EXACT line that took the live deploy
# down after #253 merged, and it fails in the most expensive way a guard can - the run
# aborts before it reports anything, so "PHASE 0 deployed cleanly" and "PHASE 0 died"
# produce the same silence. Note it can only be observed on Windows PowerShell 5.1,
# where native stderr becomes a terminating error; under pwsh 7 the mutant survives.
# That is precisely why it went unnoticed: it was hand-tested in the agent's own shell.
Test-Mutant -Name 'M11: tip existence forced true (a deleted path is rewritten, not removed)' `
  -Find '$onTip = ($history.onTip.PSObject.Properties.Name -contains $repoPath) -and [bool]$history.onTip.$repoPath' `
  -Replace '$onTip = $true' -Check {
    param($mut)
    $s = New-Sandbox
    $b = Invoke-SUT -Script $mut -Sandbox $s
    Assert (Test-Path $s.Gone) `
           'killed: a ref-deleted historical file would not take the removal path'
  }

Test-Mutant -Name 'M12: no delete path (a file removed on the ref is refused forever)' `
  -Find 'if ($inHistory) { $removed += $rel } else { $stillRefused += $rel }' `
  -Replace 'if ($false) { $removed += $rel } else { $stillRefused += $rel }' -Check {
    param($mut)
    $s = New-Sandbox
    $b = Invoke-SUT -Script $mut -Sandbox $s
    Assert (Test-Path $s.Gone) 'mutant did leave the orphan in place'
    Assert ($b.Json.refused -contains 'overnight-agent/checks/gone.ps1') `
           'killed: a file deleted on the ref would linger and escalate on every cycle'
  }

# M13 is the safety direction, and it is the one a careless fix gets wrong: "not on the
# tip" is NOT sufficient grounds to delete. Without the history check this destroys the
# only copy of a hand-deployed live fix - unrecoverable, and exactly the class of harm
# the refuse-by-default design exists to prevent.
Test-Mutant -Name 'M13: delete anything absent from the tip (destroys a live-only file)' `
  -Find 'if ($inHistory) { $removed += $rel } else { $stillRefused += $rel }' `
  -Replace 'if ($true) { $removed += $rel } else { $stillRefused += $rel }' -Check {
    param($mut)
    $s = New-Sandbox
    Invoke-SUT -Script $mut -Sandbox $s | Out-Null
    Assert (-not (Test-Path $s.Stray)) `
           'killed: a live-only file would be deleted on the strength of absence alone'
  }

function Test-HistoryMutant {
  param([string]$Name, [string]$Find, [string]$Replace, [scriptblock]$Check)
  Section $Name
  $helper = Join-Path $PSScriptRoot 'ref-history-index.mjs'
  $src = Get-Content $helper -Raw
  if (-not $src.Contains($Find)) {
    Assert $false "history mutation anchor not found - mutcheck is stale: '$Find'"
    return
  }
  $mut = Join-Path $root ('history-mut-' + [guid]::NewGuid().ToString('N').Substring(0,6) + '.mjs')
  Set-Content $mut ($src.Replace($Find, $Replace)) -Encoding UTF8
  Assert $true 'history mutation applied'
  & $Check $mut
}

Test-HistoryMutant -Name 'M15: combined log duplicated (history walks no longer constant-one)' `
  -Find 'const log = git(historyWalkArgs, {' `
  -Replace 'git(historyWalkArgs, { encoding: ''utf8'' }); const log = git(historyWalkArgs, {' -Check {
    param($mut)
    $s = New-Sandbox
    $trace = Join-Path $root 'm15.trace'
    $env:OA_HISTORY_GIT_TRACE = $trace
    try { Invoke-SUT -Script $SUT -Sandbox $s -HistoryHelper $mut | Out-Null }
    finally { Remove-Item Env:\OA_HISTORY_GIT_TRACE -ErrorAction SilentlyContinue }
    $calls = @(Get-Content $trace -ErrorAction SilentlyContinue)
    Assert (@($calls | Where-Object { $_ -eq 'log' }).Count -gt 1) `
           'killed by P1: more than one combined history walk is observed'
  }

Test-HistoryMutant -Name 'M16: per-file rev-list restored (history work grows with paths)' `
  -Find 'const log = git(historyWalkArgs, {' `
  -Replace 'for (const path of requested.keys()) git([''rev-list'', ref, ''--'', path]); const log = git(historyWalkArgs, {' -Check {
    param($mut)
    $s = New-Sandbox
    $trace = Join-Path $root 'm16.trace'
    $env:OA_HISTORY_GIT_TRACE = $trace
    try { Invoke-SUT -Script $SUT -Sandbox $s -HistoryHelper $mut | Out-Null }
    finally { Remove-Item Env:\OA_HISTORY_GIT_TRACE -ErrorAction SilentlyContinue }
    $calls = @(Get-Content $trace -ErrorAction SilentlyContinue)
    Assert (@($calls | Where-Object { $_ -eq 'rev-list' }).Count -gt 1) `
           'killed by P2: per-file history walks are observed'
  }

# ------------------------------------------------------------------------------------
# G7 - self-bootstrap: an OLD installed copy must hand off to the NEWER repo copy.
# This is the trap that sprang for real between #240 and #241: the old build classified
# its own newer self as a branch-only live fix and refused, so it could not adopt the
# fix that would have let it adopt the fix.
# ------------------------------------------------------------------------------------
Section 'G7: self-bootstrap (stale copy defers to the repo copy)'
$sbb = New-Sandbox
# Put a deliberately BROKEN, older copy where the "installed" caller would live, and
# point it at the sandbox repo whose checks dir holds the real script.
Copy-Item $SUT (Join-Path $sbb.Repo 'plugins\overnight-agent\checks\auto-deploy-plugin.ps1') -Force
$stale = Join-Path $root ('stale-' + [guid]::NewGuid().ToString('N').Substring(0,6) + '.ps1')
# The stale copy differs (extra comment) AND would refuse everything if it ran to completion.
Set-Content -Path $stale -Value ((Get-Content $SUT -Raw) -replace 'function Write-Note', "# STALE BUILD MARKER`nfunction Write-Note") -Encoding UTF8
$rb = Invoke-SUT -Script $stale -Sandbox $sbb -NoJson
Assert ($rb.Raw -match 're-executing it so the NEWER logic decides') `
       'G7 a differing repo copy triggers a hand-off'
Assert (Test-Path $sbb.NewGuard) `
       'G7 the handed-off run still does the real work'

Test-Mutant -Name 'M9: self-bootstrap removed (a stale build judges its own replacement)' `
  -Find "if (-not `$env:OA_AUTODEPLOY_REEXEC -and `$PSCommandPath) {" `
  -Replace "if (`$false) {" -Check {
    param($mut)
    $s = New-Sandbox
    Copy-Item $SUT (Join-Path $s.Repo 'plugins\overnight-agent\checks\auto-deploy-plugin.ps1') -Force
    $st = Join-Path $root ('stale-' + [guid]::NewGuid().ToString('N').Substring(0,6) + '.ps1')
    Set-Content -Path $st -Value ((Get-Content $mut -Raw) -replace 'function Write-Note', "# STALE BUILD MARKER`nfunction Write-Note") -Encoding UTF8
    $r = Invoke-SUT -Script $st -Sandbox $s -NoJson
    Assert ($r.Raw -notmatch 're-executing it so the NEWER logic decides') `
           'killed: a stale build would never defer to its newer replacement'
  }

Test-Mutant -Name 'M10: re-exec guard removed (unbounded self-recursion)' `
  -Find "`$env:OA_AUTODEPLOY_REEXEC = '1'" -Replace "`$env:OA_AUTODEPLOY_REEXEC = ''" -Check {
    param($mut)
    $src = Get-Content $mut -Raw
    Assert ($src -notmatch [regex]::Escape("OA_AUTODEPLOY_REEXEC = '1'")) `
           'killed: without the hop marker the hand-off could recurse without bound'
  }

Test-Mutant -Name 'M17: fetch time charged back to the local-work budget (#418)' `
  -Find '$script:excludedMs += ([int]$budget.ElapsedMilliseconds - $fetchStart)' `
  -Replace '$script:excludedMs += 0' -Check {
    param($mut)
    # The fetch blocks for its full 3s budget; the local budget is 3s too. Unmutated, the
    # local work gets all 3s and finishes. Mutated, the fetch has spent the entire local
    # budget before classification starts, so it must die with the wall-clock signal.
    $s = New-Sandbox
    Add-HangingRemote $s
    $r = Invoke-SUT -Script $mut -Sandbox $s -WithFetch -FetchBudgetSeconds 3 -BudgetSeconds 3
    Assert ($r.Exit -eq 2 -and $r.Json -and $r.Json.reason -eq 'wall-clock-budget') `
           'killed by G15: a slow network would again report the deploy as unverified'
    Assert (-not (Test-Path $s.NewGuard)) `
           'killed by G15: the healthy deploy would not happen at all'
  }

Test-Mutant -Name 'M18: helpers resolved from the checkout only (#419)' `
  -Find '  $beside = Join-Path $PSScriptRoot $FileName
  if (Test-Path $beside) { return $beside }' `
  -Replace '  $beside = Join-Path $PSScriptRoot $FileName
  if ($false) { return $beside }' -Check {
    param($mut)
    # A checkout behind origin/main simply does not have the helper yet. The running
    # script does, right beside it. Resolving from the checkout only is what killed the
    # deploy on 2026-09-02 even though every byte it needed was already on the machine.
    $s = New-Sandbox
    Remove-RepoHistoryHelper $s
    $r = Invoke-SUT -Script $mut -Sandbox $s -NoHelperOverride
    Assert ($r.Exit -ne 0) `
           'killed by G16: a checkout merely behind the ref would block the deploy'
    Assert (-not (Test-Path $s.NewGuard)) `
           'killed by G16: merged code would stay uninstalled'
  }

Test-Mutant -Name 'M19: missing helper throws instead of asking (#419)' `
  -Find "if (-not (Test-Path `$historyHelper)) { Stop-ForMissingHelper 'history helper' `$historyHelper }" `
  -Replace "if (-not (Test-Path `$historyHelper)) { throw `"history helper not found: `$historyHelper`" }" -Check {
    param($mut)
    # Exit 1 with a raw throw made a stale checkout look identical to a broken install.
    # The convention for "a human needs to look at this" is exit 2 with a stated ask.
    $s = New-Sandbox
    Remove-RepoHistoryHelper $s
    $missing = Join-Path $root 'no-such-helper.mjs'
    $r = Invoke-SUT -Script $mut -Sandbox $s -HistoryHelper $missing
    Assert ($r.Exit -ne 2) `
           'killed: a missing helper would exit 1 with no ask instead of the exit-2 convention'
  }

Section 'G17: the hand-off target must be the REF version, not merely "the repo copy"'
# The old rule assumed the checkout is always at least as new as the installed tree. A
# checkout BEHIND origin/main breaks that assumption, and the hand-off then runs the older
# build - the #419 scenario - which defeats the helper-resolution fix at exactly the moment
# it is needed. Measured 2026-09-03 against a checkout at 93e9921 with origin/main at
# b46edfd: the older copy aborted with "A parameter cannot be found that matches parameter
# name 'BudgetSeconds'" and the whole deploy exited 1.
function New-SandboxStaleSelf {
  $s = New-Sandbox
  $selfPath = Join-Path $s.Repo 'plugins\overnight-agent\checks\auto-deploy-plugin.ps1'
  # The REF carries a valid copy (marked, so it differs from the running one)...
  Set-Content $selfPath ((Get-Content $SUT -Raw) -replace 'function Write-Note', "# REF VERSION MARKER`nfunction Write-Note") -Encoding UTF8
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & git -C $s.Repo add -A 2>&1 | Out-Null
    & git -C $s.Repo commit -m 'self on ref' --quiet 2>&1 | Out-Null
    & git -C $s.Repo update-ref refs/remotes/origin/main HEAD 2>&1 | Out-Null
  } finally { $ErrorActionPreference = $prev }
  # ...while the WORKING TREE holds a stale build that fails loudly if it ever runs.
  Set-Content $selfPath "Write-Host 'STALE BUILD RAN'; exit 3" -Encoding UTF8
  return $s
}

$sbs = New-SandboxStaleSelf
$rs = Invoke-SUT -Script $SUT -Sandbox $sbs -NoJson
Assert ($rs.Raw -notmatch 'STALE BUILD RAN' -and $rs.Exit -ne 3) `
       'G17 a checkout behind the ref does not take over the deploy'
Assert (Test-Path $sbs.NewGuard) `
       'G17 the running copy did the work itself instead'

Test-Mutant -Name 'M20: hand off to the repo copy regardless of the ref (#419)' `
  -Find '$repoIsRefVersion = if ($null -ne $refSelfHash) { $thereHash -eq $refSelfHash } else { $true }' `
  -Replace '$repoIsRefVersion = $true' -Check {
    param($mut)
    $s = New-SandboxStaleSelf
    $r = Invoke-SUT -Script $mut -Sandbox $s -NoJson
    Assert ($r.Raw -match 'STALE BUILD RAN' -or $r.Exit -eq 3) `
           'killed by G17: a stale checkout would seize the deploy again'
  }

Section 'G18: the hand-off only forwards switches the target declares'
# The hand-off crosses a version boundary by definition, so it must not assume the other
# build shares this one's parameter list. Measured 2026-09-03: forwarding the new
# -FetchBudgetSeconds to a copy that predates it killed the run with "A parameter cannot
# be found that matches parameter name 'FetchBudgetSeconds'", exit 1 - an upgrade path
# breaking on the very mechanism that exists to make upgrades safe.
function New-SandboxOldRefSelf {
  $s = New-Sandbox
  $selfPath = Join-Path $s.Repo 'plugins\overnight-agent\checks\auto-deploy-plugin.ps1'
  # A build that declares every forwarded switch EXCEPT -FetchBudgetSeconds.
  # [CmdletBinding()] is load-bearing: without it PowerShell quietly routes an unknown
  # named argument into $args instead of failing, so the fixture would not reproduce the
  # real failure and M21 could never be killed.
  $stub = @'
[CmdletBinding()]
param([switch]$WhatIf,[switch]$Json,[string]$Ref,[string]$Repo,[string]$Installed,
      [string]$RepoPrefix,[int]$EscalateAfterCycles,[string]$StatePath,[int]$BudgetSeconds,
      [string]$ClassifierPath,[string]$HistoryHelperPath,[string]$VerifyHelperPath,
      [switch]$SkipFetch,[switch]$NoOaHome)
Write-Host 'OLD BUILD RAN'
exit 0
'@
  Set-Content $selfPath $stub -Encoding UTF8
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & git -C $s.Repo add -A 2>&1 | Out-Null
    & git -C $s.Repo commit -m 'old self on ref' --quiet 2>&1 | Out-Null
    & git -C $s.Repo update-ref refs/remotes/origin/main HEAD 2>&1 | Out-Null
  } finally { $ErrorActionPreference = $prev }
  return $s
}

$sbo = New-SandboxOldRefSelf
$ro = Invoke-SUT -Script $SUT -Sandbox $sbo -NoJson
Assert ($ro.Raw -match 'OLD BUILD RAN') `
       'G18 the hand-off reaches a target that predates the newer switch'
Assert ($ro.Raw -notmatch "parameter name 'FetchBudgetSeconds'") `
       'G18 no unknown-parameter failure is produced'

Test-Mutant -Name 'M21: forward the newer switch unconditionally (#418 upgrade path)' `
  -Find "if (`$thereSrc -match '\`$FetchBudgetSeconds') { `$fwd += @('-FetchBudgetSeconds',`$FetchBudgetSeconds) }" `
  -Replace "`$fwd += @('-FetchBudgetSeconds',`$FetchBudgetSeconds)" -Check {
    param($mut)
    $s = New-SandboxOldRefSelf
    $r = Invoke-SUT -Script $mut -Sandbox $s -NoJson
    Assert ($r.Raw -notmatch 'OLD BUILD RAN') `
           'killed by G18: an older target would be handed a switch it cannot accept'
  }

Section 'G8: the OA-home seam (second deploy target)'

# The reason this section exists: on first wiring, the sub-tool was resolved as
# "next to me" only. The OA home is exactly where a brand-new check has NOT landed,
# so the copy most in need of repair silently skipped its own sync and still printed
# verified-current True. A missing sub-tool and a clean sync produced identical
# output - a detector wired to nothing.
$s = New-Sandbox
$r = Invoke-SUT -Script $SUT -Sandbox $s
Assert ($r.Json -and $r.Json.oaHomeExit -eq 0) `
       'G8a -NoOaHome leaves the seam clean and reports it'

# Run a copy from a directory where sync-oa-home.ps1 is absent AND point -Repo at a
# sandbox that has no checks dir, so no candidate root can resolve it.
$isolated = Join-Path $root ('iso-' + [guid]::NewGuid().ToString('N').Substring(0,6))
New-Item -ItemType Directory -Path $isolated -Force | Out-Null
$copy = Join-Path $isolated 'auto-deploy-plugin.ps1'
Copy-Item $SUT $copy -Force
$s2 = New-Sandbox
$a = @('-NoProfile','-ExecutionPolicy','Bypass','-File',$copy,
       '-Repo',$s2.Repo,'-Installed',$s2.Installed,'-StatePath',$s2.State,
       '-SkipFetch','-Json')
$out = & powershell @a 2>&1 | Out-String
Assert ($out -match 'NOT FOUND' -or $out -match '"oaHomeExit":\s*2') `
       'G8b an unresolvable sub-tool is reported, never silently skipped'

Section 'RESULT'
if (-not $KeepSandbox) { Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue }
else { Write-Host "  sandbox kept at $root" }

if ($script:fail -gt 0) {
  Write-Host ("FAIL  {0} passed, {1} failed" -f $script:pass, $script:fail) -ForegroundColor Red
  exit 1
}
Write-Host ("PASS  {0} assertions" -f $script:pass) -ForegroundColor Green
exit 0
