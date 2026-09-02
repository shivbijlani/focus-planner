<#
  mutcheck-worktree-safety.ps1 -- prove the guards in scripts/worktree-safety.ps1
  are load-bearing, by removing each one and showing the shared install dies.

  WHAT #321 ACTUALLY BROKE
  ------------------------
  The documented way to keep a throwaway worktree fast was to junction the main
  checkout's node_modules into it. `git worktree remove --force` deletes THROUGH
  that junction. Reproduced in an isolated sandbox on 2026-09-02:

      shared node_modules top-level entries: before=4 after=0
      git exit code: 0

  Exit code 0. The shared install is emptied for the main checkout and every other
  worktree at once, and nothing says so; the damage surfaces later, elsewhere, as a
  missing binary that reads like a broken change.

  WHY THE FIRST ARM IS A CONTROL, NOT A GUARD
  -------------------------------------------
  Arm A deliberately removes BOTH halves of the unlink defence and asserts the
  shared target is emptied. That arm exists because of the trap the browser-slots
  mutcheck header records: a harness whose fixtures cannot express the failure
  reports every mutant "killed" and measures nothing. Arm A proves this harness can
  still see the 2026-09-02 damage. If arm A ever goes green-by-passing, every other
  arm below is worthless.

  A MEASURED CORRECTION TO THE ORIGINAL REPORT
  --------------------------------------------
  #321 assumed `Remove-Item -Recurse` shares the delete-through hazard. Measured on
  the same box, same junction shape, 3 entries in the target every time:

      [IO.Directory]::Delete($p,$false)             SAFE
      [IO.Directory]::Delete($p,$true)              SAFE
      Remove-Item -Recurse -Force  (pwsh 7.6.5)     SAFE
      Remove-Item -Recurse -Force  (powershell 5.1) SAFE
      cmd /c rmdir                                  SAFE

  The hazard is git's own removal code, not PowerShell's. So there is deliberately
  NO mutant here for "used the wrong delete verb" -- it would assert a hazard that
  does not exist, and a check that pins a false belief is worse than no check.

  THE MUTANTS. Every one must be KILLED by its named arm.
    M1  the unlink pass is removed                 -> G1, killed by arm B
    M2  the "still linked -> do not run git" abort -> G4, killed by arm F
    M3  Remove-DirectoryLink silently does nothing -> G4, killed by arm E
    M4  links are detected by NAME, not attribute  -> G2, killed by arm G
    M5  the scan descends THROUGH a link           -> G3, killed by arm H
    M6  post-removal target verification removed   -> G5, killed by arm I
    M7  an EMPTY node_modules reads as Populated   -> G6, killed by arm J
    M8  the main-checkout refusal is removed       -> G7, killed by arm K

  NEVER TOUCHES LIVE STATE. Every arm builds its own git repo, its own fake
  "shared install" and its own junctions under a fresh temp directory, and deletes
  them afterwards. No path in this file refers to a real checkout, and the library
  under test is COPIED to temp before it is mutated -- the repo file is only read.

  RUN:  pwsh -NoProfile -File scripts/mutcheck-worktree-safety.ps1
  EXIT: 0 all assertions passed. 1 something failed / a mutant survived.
#>
[CmdletBinding()]
param([string]$LibPath)

$ErrorActionPreference = 'Stop'

if (-not $LibPath) { $LibPath = Join-Path $PSScriptRoot 'worktree-safety.ps1' }
if (-not (Test-Path -LiteralPath $LibPath)) { throw "worktree-safety.ps1 not found at $LibPath" }

$onWindows = ($null -eq $IsWindows) -or $IsWindows
if (-not $onWindows) {
    Write-Host 'mutcheck-worktree-safety: SKIPPED (directory junctions are a Windows filesystem feature)' -ForegroundColor Yellow
    exit 0
}
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'git is required to run this check' }

$utf8NoBom = New-Object Text.UTF8Encoding($false)
$libSrc = [IO.File]::ReadAllText($LibPath, $utf8NoBom)

$psExe = (Get-Command pwsh -ErrorAction SilentlyContinue).Source
if (-not $psExe) { $psExe = (Get-Command powershell -ErrorAction SilentlyContinue).Source }
if (-not $psExe) { throw 'No PowerShell host found to run the probes in.' }

$script:Pass = 0
$script:Fail = 0
function Assert($name, $cond, $detail) {
    if ($cond) { $script:Pass++; Write-Host ("  ok    {0}" -f $name) -ForegroundColor Green }
    else { $script:Fail++; Write-Host ("  FAIL  {0}  {1}" -f $name, $detail) -ForegroundColor Red }
}

$tmpRoot = Join-Path ([IO.Path]::GetTempPath()) ("mut321-" + [guid]::NewGuid().ToString('N').Substring(0, 10))
New-Item -ItemType Directory -Force -Path $tmpRoot | Out-Null

# ---------------------------------------------------------------------------
# MUTATION. Literal .Replace, not regex: the anchors are real PowerShell source
# full of $ and [ ]. Every mutation asserts that it actually applied -- an anchor
# that has drifted would otherwise produce a mutant identical to the original,
# which SURVIVES and reads as "the guard is fine".
# ---------------------------------------------------------------------------
$script:AnchorFailures = 0
function New-Mutant {
    param([Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][hashtable[]]$Edits)
    $src = $libSrc
    foreach ($e in $Edits) {
        $before = $src
        $src = $src.Replace($e.From, $e.To)
        if ($src -eq $before) {
            $script:AnchorFailures++
            Write-Host ("  ANCHOR MISS in mutant {0}: {1}" -f $Name, $e.From) -ForegroundColor Magenta
        }
    }
    $p = Join-Path $tmpRoot "lib-$Name.ps1"
    [IO.File]::WriteAllText($p, $src, $utf8NoBom)
    return $p
}

$M = @{
    # M1 -- G1: the unlink pass no longer unlinks anything.
    UnlinkPass = @{
        From = '[void](Remove-DirectoryLink -Path $l.Path)'
        To   = '$null = $l.Path'
    }
    # M2 -- G4: a surviving link no longer stops git.
    AbortOnSurvivor = @{
        From = 'if ($stillLinked.Count -gt 0) {'
        To   = 'if ($false) {'
    }
    # M3 -- the unlink primitive silently fails (a locked or in-use junction).
    UnlinkNoOp = @{
        From = '[IO.Directory]::Delete($info.Path, $false)'
        To   = '$null = $info.Path'
    }
    # M4 -- G2: identity by name instead of by reparse-point attribute.
    DetectByName = @{
        From = '$isLink = (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq [IO.FileAttributes]::ReparsePoint)'
        To   = '$isLink = ($item.Name -eq ''node_modules'')'
    }
    DetectByNameFallback = @{
        From = 'if (-not $isLink -and $linkType) { $isLink = $true }'
        To   = '# name-based only'
    }
    # M5 -- G3: the scan walks through a link into the shared tree.
    DescendThroughLink = @{
        From = @'
                [void]$found.Add($info)
                continue
            }
'@
        To   = @'
                [void]$found.Add($info)
            }
'@
    }
    # M6 -- G5: damage is no longer counted, so a destructive run reports success.
    VerifyTargets = @{
        From = 'if ($t.Before -eq ''Populated'' -and $after.State -ne ''Populated'') {'
        To   = 'if ($false) {'
    }
    # M7 -- G6: an existing-but-empty node_modules reads as healthy.
    EmptyIsPopulated = @{
        From = '$state = if ($count -gt 0) { ''Populated'' } else { ''Empty'' }'
        To   = '$state = ''Populated'''
    }
    # M8 -- G7: the main checkout is no longer refused.
    RefuseMainCheckout = @{
        From = 'if (-not $kind.IsWorktree -or -not $kind.IsLinked) {'
        To   = 'if ($false) {'
    }
}

# ---------------------------------------------------------------------------
# FIXTURE. A miniature of the real layout: a "main checkout" holding the shared
# install, a git repo, and a linked worktree that junctions into it.
#
#   <case>/main/node_modules/{vitest,vite,react,.bin}   the shared install
#   <case>/main/node_modules/.nested-link -> ../tools    a link the shared install OWNS
#   <case>/main/.pnpm-store/{s1,s2}                      shared state NOT called node_modules
#   <case>/main/.pnpm-store/.nested-link2 -> ../tools2   a link that shared state OWNS
#   <case>/repo                                          the main checkout (git)
#   <case>/wt/node_modules      -> main/node_modules
#   <case>/wt/.cache-link       -> main/.pnpm-store
#
# The two nested links are what arm H needs. `node_modules` is skipped by name as
# a cost guard (nothing findable lives in a real one), so the link that proves G3
# is load-bearing has to sit behind the junction that is NOT called node_modules.
# ---------------------------------------------------------------------------
$caseSeq = 0
function New-Case {
    param([switch]$NoLinks, [switch]$LinkOnMainCheckout, [switch]$RealNodeModules)

    $script:caseSeq++
    $case = Join-Path $tmpRoot ("case{0:d2}" -f $script:caseSeq)
    $main = Join-Path $case 'main'
    $shared = Join-Path $main 'node_modules'
    $store = Join-Path $main '.pnpm-store'
    $tools = Join-Path $main 'tools'
    $tools2 = Join-Path $main 'tools2'
    New-Item -ItemType Directory -Force -Path $shared, $store, $tools, $tools2 | Out-Null
    foreach ($p in 'vitest', 'vite', 'react', '.bin') {
        New-Item -ItemType Directory -Force -Path (Join-Path $shared $p) | Out-Null
    }
    foreach ($p in 's1', 's2') { New-Item -ItemType Directory -Force -Path (Join-Path $store $p) | Out-Null }
    New-Item -ItemType Directory -Force -Path (Join-Path $tools 'bin') | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $tools2 'bin') | Out-Null

    # Links the SHARED state owns. Nothing in a worktree teardown has any business
    # touching either of these; arm H is the reason they are here.
    $nested = Join-Path $shared '.nested-link'
    cmd /c "mklink /J `"$nested`" `"$tools`"" | Out-Null
    $nested2 = Join-Path $store '.nested-link2'
    cmd /c "mklink /J `"$nested2`" `"$tools2`"" | Out-Null

    $repo = Join-Path $case 'repo'
    New-Item -ItemType Directory -Force -Path $repo | Out-Null
    & git -C $repo init -q -b main 2>&1 | Out-Null
    & git -C $repo config user.email 'mutcheck@example.invalid' 2>&1 | Out-Null
    & git -C $repo config user.name 'mutcheck' 2>&1 | Out-Null
    & git -C $repo config commit.gpgsign false 2>&1 | Out-Null
    [IO.File]::WriteAllText((Join-Path $repo 'file.txt'), "hello`n", $utf8NoBom)
    & git -C $repo add -A 2>&1 | Out-Null
    & git -C $repo commit -qm init 2>&1 | Out-Null

    if ($LinkOnMainCheckout) {
        cmd /c "mklink /J `"$(Join-Path $repo 'shared-cache')`" `"$store`"" | Out-Null
    }

    $wt = Join-Path $case 'wt'
    & git -C $repo worktree add -q -b feat $wt 2>&1 | Out-Null

    if ($RealNodeModules) {
        $realNm = Join-Path $wt 'node_modules'
        New-Item -ItemType Directory -Force -Path (Join-Path $realNm 'own-pkg') | Out-Null
    }
    elseif (-not $NoLinks) {
        cmd /c "mklink /J `"$(Join-Path $wt 'node_modules')`" `"$shared`"" | Out-Null
        cmd /c "mklink /J `"$(Join-Path $wt '.cache-link')`" `"$store`"" | Out-Null
    }

    [pscustomobject]@{
        Case = $case; Main = $main; Repo = $repo; Worktree = $wt
        Shared = $shared; Store = $store; Tools = $tools; Nested = $nested; Nested2 = $nested2
        MainLink = (Join-Path $repo 'shared-cache')
    }
}

function Count-Entries {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return -1 }
    try { return @(Get-ChildItem -LiteralPath $Path -Force -ErrorAction Stop).Count } catch { return -2 }
}

# ---------------------------------------------------------------------------
# PROBE. Dot-source a (possibly mutated) library in a CHILD process and report
# what it returned as JSON. A child process keeps a mutant's functions out of
# this one, and exercises the library exactly as a real caller would.
# ---------------------------------------------------------------------------
$driver = Join-Path $tmpRoot 'probe.ps1'
[IO.File]::WriteAllText($driver, @'
param([string]$Lib, [string]$Mode, [string]$Path, [switch]$DryRun)
$ErrorActionPreference = 'Continue'
. $Lib
try {
    if ($Mode -eq 'health') {
        $h = Test-SharedNodeModules -RepoPath $Path
        [pscustomobject]@{ ok = $true; Health = $h } | ConvertTo-Json -Depth 6 -Compress
        return
    }
    $r = Remove-WorktreeSafely -WorktreePath $Path -DryRun:$DryRun
    [pscustomobject]@{
        ok       = $true
        Result   = $r.Ok
        Removed  = $r.Removed
        DryRun   = $r.DryRun
        LinkCount = @($r.Links).Count
        LinkPaths = @(@($r.Links) | ForEach-Object { $_.Path })
        Messages = @($r.Messages)
    } | ConvertTo-Json -Depth 8 -Compress
}
catch {
    [pscustomobject]@{ ok = $false; err = $_.Exception.Message } | ConvertTo-Json -Depth 3 -Compress
}
'@, $utf8NoBom)

function Invoke-Probe {
    param([string]$Lib, [string]$Mode = 'remove', [Parameter(Mandatory)][string]$Path, [switch]$DryRun)
    if (-not $Lib) { $Lib = $LibPath }
    $args = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $driver, '-Lib', $Lib, '-Mode', $Mode, '-Path', $Path)
    if ($DryRun) { $args += '-DryRun' }
    $raw = (& $psExe @args 2>&1) -join "`n"
    $json = ($raw -split "`n" | Where-Object { $_.TrimStart().StartsWith('{') } | Select-Object -Last 1)
    if (-not $json) { return [pscustomobject]@{ ok = $false; err = "no JSON from probe: $raw" } }
    try { return ($json | ConvertFrom-Json) } catch { return [pscustomobject]@{ ok = $false; err = "unparsable: $json" } }
}

Write-Host "mutcheck-worktree-safety  (lib: $LibPath)" -ForegroundColor Cyan

# ===========================================================================
# A -- CONTROL. With BOTH halves of the unlink defence removed, the helper must
# reproduce #321 exactly: shared target emptied. If this arm cannot see the
# damage, nothing below it means anything.
# ===========================================================================
Write-Host "`nA: control -- guards removed, the 2026-09-02 damage reappears" -ForegroundColor Cyan
$c = New-Case
$libA = New-Mutant -Name 'A-no-defence' -Edits @($M.UnlinkPass, $M.AbortOnSurvivor)
$before = Count-Entries $c.Shared
$rA = Invoke-Probe -Lib $libA -Path $c.Worktree
$after = Count-Entries $c.Shared
Assert 'A the fixture starts with a populated shared install' ($before -eq 5) "before=$before"
Assert 'A without the guards the shared target is EMPTIED' ($after -eq 0) "after=$after (harness cannot see the damage)"

# ===========================================================================
# B -- M1 killed. The unlink pass is load-bearing: with it gone, G4 sees the
# surviving link and REFUSES to hand the worktree to git.
# ===========================================================================
Write-Host "`nB: M1 (unlink pass removed) is killed" -ForegroundColor Cyan
$c = New-Case
$libB = New-Mutant -Name 'B-m1' -Edits @($M.UnlinkPass)
$rB = Invoke-Probe -Lib $libB -Path $c.Worktree
Assert 'B M1 is refused, not run'            ($rB.ok -and -not $rB.Result) "Result=$($rB.Result)"
Assert 'B M1 never invokes git'              (-not $rB.Removed) "Removed=$($rB.Removed)"
Assert 'B M1 says why it aborted'            ((@($rB.Messages) -join ' ') -match 'ABORTING') (@($rB.Messages) -join ' | ')
Assert 'B M1 leaves the shared target whole' ((Count-Entries $c.Shared) -eq 5) ("after=" + (Count-Entries $c.Shared))

# ===========================================================================
# C -- baseline. The unmutated helper removes a junctioned worktree and leaves
# every shared target exactly as it found it.
# ===========================================================================
Write-Host "`nC: baseline -- safe removal of a junctioned worktree" -ForegroundColor Cyan
$c = New-Case
$rC = Invoke-Probe -Path $c.Worktree
Assert 'C removal reports success'            ($rC.ok -and $rC.Result) "err=$($rC.err) Result=$($rC.Result)"
Assert 'C both junctions were found'          ($rC.LinkCount -eq 2) "LinkCount=$($rC.LinkCount)"
Assert 'C the worktree directory is gone'     (-not (Test-Path -LiteralPath $c.Worktree)) 'worktree directory survived'
Assert 'C shared node_modules intact'         ((Count-Entries $c.Shared) -eq 5) ("entries=" + (Count-Entries $c.Shared))
Assert 'C shared .pnpm-store intact'          ((Count-Entries $c.Store) -eq 3) ("entries=" + (Count-Entries $c.Store))
Assert 'C the shared install keeps its own link' (Test-Path -LiteralPath $c.Nested) 'nested link inside the shared install was destroyed'
Assert 'C shared state keeps its nested link' (Test-Path -LiteralPath $c.Nested2) 'nested link inside the shared store was destroyed'
$wtRows = @(& git -C $c.Repo worktree list) | Where-Object { $_ -match 'wt' }
Assert 'C git no longer lists the worktree'   ($wtRows.Count -eq 0) ("still listed: " + ($wtRows -join '; '))

# ===========================================================================
# D -- baseline, dry run. Reports what it would unlink and changes nothing.
# ===========================================================================
Write-Host "`nD: baseline -- -DryRun reports and changes nothing" -ForegroundColor Cyan
$c = New-Case
$rD = Invoke-Probe -Path $c.Worktree -DryRun
Assert 'D dry run succeeds'                  ($rD.ok -and $rD.Result) "err=$($rD.err)"
Assert 'D dry run finds both junctions'      ($rD.LinkCount -eq 2) "LinkCount=$($rD.LinkCount)"
Assert 'D dry run does not invoke git'       (-not $rD.Removed) "Removed=$($rD.Removed)"
Assert 'D dry run leaves the worktree'       (Test-Path -LiteralPath $c.Worktree) 'worktree removed during a dry run'
Assert 'D dry run leaves the junctions'      (Test-Path -LiteralPath (Join-Path $c.Worktree 'node_modules')) 'junction unlinked during a dry run'
Assert 'D dry run leaves the target whole'   ((Count-Entries $c.Shared) -eq 5) ("entries=" + (Count-Entries $c.Shared))

# ===========================================================================
# E -- M3 killed. An unlink that silently fails (a locked junction) must stop
# the run, not fall through into the destructive command.
# ===========================================================================
Write-Host "`nE: M3 (unlink silently does nothing) is killed by G4" -ForegroundColor Cyan
$c = New-Case
$libE = New-Mutant -Name 'E-m3' -Edits @($M.UnlinkNoOp)
$rE = Invoke-Probe -Lib $libE -Path $c.Worktree
Assert 'E a failed unlink aborts the run'   ($rE.ok -and -not $rE.Result) "Result=$($rE.Result)"
Assert 'E git is not invoked'               (-not $rE.Removed) "Removed=$($rE.Removed)"
Assert 'E the shared target is untouched'   ((Count-Entries $c.Shared) -eq 5) ("entries=" + (Count-Entries $c.Shared))

# ===========================================================================
# F -- M2 killed. Remove G4 as well and the same failed unlink becomes the bug.
# This is what makes G4 load-bearing rather than decorative.
# ===========================================================================
Write-Host "`nF: M2 (the still-linked abort) is killed" -ForegroundColor Cyan
$c = New-Case
$libF = New-Mutant -Name 'F-m2m3' -Edits @($M.UnlinkNoOp, $M.AbortOnSurvivor)
$rF = Invoke-Probe -Lib $libF -Path $c.Worktree
Assert 'F without G4 the shared target is emptied' ((Count-Entries $c.Shared) -eq 0) ("entries=" + (Count-Entries $c.Shared))
Assert 'F and G5 still reports the damage'         ($rF.ok -and -not $rF.Result) "Result=$($rF.Result) (damage reported as success)"

# ===========================================================================
# G -- M4 killed. A junction that is not called `node_modules` is exactly as
# destructive. Name-based detection walks straight past `.cache-link`.
# ===========================================================================
Write-Host "`nG: M4 (detect links by NAME) is killed" -ForegroundColor Cyan
$c = New-Case
$libG = New-Mutant -Name 'G-m4' -Edits @($M.DetectByName, $M.DetectByNameFallback)
$rG = Invoke-Probe -Lib $libG -Path $c.Worktree
Assert 'G name-based detection misses a link' ($rG.LinkCount -lt 2) "LinkCount=$($rG.LinkCount)"
Assert 'G the missed link''s target is emptied' ((Count-Entries $c.Store) -eq 0) ("entries=" + (Count-Entries $c.Store))

# ===========================================================================
# H -- M5 killed. Descending through a junction makes the teardown reach INSIDE
# shared state and unlink something that state owns. `wt/.cache-link` points at
# `main/.pnpm-store`, so `wt/.cache-link/.nested-link2` IS the store's own link:
# unlinking it destroys shared configuration that no worktree ever owned.
# ===========================================================================
Write-Host "`nH: M5 (scan descends through a link) is killed" -ForegroundColor Cyan
$c = New-Case
$libH = New-Mutant -Name 'H-m5' -Edits @($M.DescendThroughLink)
$rH = Invoke-Probe -Lib $libH -Path $c.Worktree
Assert 'H descending finds more than the two junctions' ($rH.LinkCount -gt 2) "LinkCount=$($rH.LinkCount)"
Assert 'H it reaches a path inside shared state'         ((@($rH.LinkPaths) -join ' ') -match 'cache-link.\.nested-link2') (@($rH.LinkPaths) -join ' | ')
Assert 'H it destroys a link shared state owns'          (-not (Test-Path -LiteralPath $c.Nested2)) 'nested link survived, so this arm proved nothing'

# ===========================================================================
# I -- M6 killed. #321's defining property is that the damage is SILENT. Arm F
# already showed the guarded helper reports it; strip the verification and the
# identical destructive run reports success.
# ===========================================================================
Write-Host "`nI: M6 (post-removal verification removed) is killed" -ForegroundColor Cyan
$c = New-Case
$libI = New-Mutant -Name 'I-m6' -Edits @($M.UnlinkNoOp, $M.AbortOnSurvivor, $M.VerifyTargets)
$rI = Invoke-Probe -Lib $libI -Path $c.Worktree
Assert 'I the run is still destructive'      ((Count-Entries $c.Shared) -eq 0) ("entries=" + (Count-Entries $c.Shared))
Assert 'I but now it reports SUCCESS'        ($rI.ok -and $rI.Result) "Result=$($rI.Result)"

# ===========================================================================
# J -- M7 killed. #321 success criterion 3: an empty-but-present node_modules
# must be reported explicitly, because Test-Path is TRUE for the wreckage.
# ===========================================================================
Write-Host "`nJ: M7 (empty node_modules reads as populated) is killed" -ForegroundColor Cyan
$c = New-Case
$healthy = Invoke-Probe -Mode 'health' -Path $c.Main
Assert 'J a populated install reports Populated' ($healthy.ok -and $healthy.Health.Ok -and $healthy.Health.State -eq 'Populated') "State=$($healthy.Health.State)"

Get-ChildItem -LiteralPath $c.Shared -Force | ForEach-Object {
    if ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) { [IO.Directory]::Delete($_.FullName, $false) }
    else { Remove-Item -LiteralPath $_.FullName -Recurse -Force }
}
$wrecked = Invoke-Probe -Mode 'health' -Path $c.Main
Assert 'J an emptied install is NOT reported Ok'  ($wrecked.ok -and -not $wrecked.Health.Ok) "Ok=$($wrecked.Health.Ok)"
Assert 'J it is named Empty, not Missing'         ($wrecked.Health.State -eq 'Empty') "State=$($wrecked.Health.State)"
Assert 'J the message names #321'                 ($wrecked.Health.Message -match '#321') "msg=$($wrecked.Health.Message)"

Remove-Item -LiteralPath $c.Shared -Recurse -Force -ErrorAction SilentlyContinue
$absent = Invoke-Probe -Mode 'health' -Path $c.Main
Assert 'J a MISSING install is not a failure'     ($absent.ok -and $absent.Health.Ok -and $absent.Health.State -eq 'Missing') "State=$($absent.Health.State) Ok=$($absent.Health.Ok)"

$libJ = New-Mutant -Name 'J-m7' -Edits @($M.EmptyIsPopulated)
$c2 = New-Case
Get-ChildItem -LiteralPath $c2.Shared -Force | ForEach-Object {
    if ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) { [IO.Directory]::Delete($_.FullName, $false) }
    else { Remove-Item -LiteralPath $_.FullName -Recurse -Force }
}
$mJ = Invoke-Probe -Lib $libJ -Mode 'health' -Path $c2.Main
Assert 'J M7 calls the wreckage healthy'          ($mJ.ok -and $mJ.Health.Ok) "Ok=$($mJ.Health.Ok) (mutant survived)"

# ===========================================================================
# K -- M8 killed. Aimed at the MAIN checkout, the helper must refuse before it
# unlinks anything. Without G7 it starts dismantling the main checkout's own
# links -- the one directory whose node_modules everything else shares.
# ===========================================================================
Write-Host "`nK: M8 (main-checkout refusal removed) is killed" -ForegroundColor Cyan
$c = New-Case -LinkOnMainCheckout
$rK = Invoke-Probe -Path $c.Repo
Assert 'K the main checkout is refused'        ($rK.ok -and -not $rK.Result) "Result=$($rK.Result)"
Assert 'K the refusal says which path'         ((@($rK.Messages) -join ' ') -match 'MAIN checkout') (@($rK.Messages) -join ' | ')
Assert 'K its own link is left alone'          (Test-Path -LiteralPath $c.MainLink) 'the main checkout link was removed'

$c2 = New-Case -LinkOnMainCheckout
$libK = New-Mutant -Name 'K-m8' -Edits @($M.RefuseMainCheckout)
$rK2 = Invoke-Probe -Lib $libK -Path $c2.Repo
Assert 'K M8 stops refusing'                   ((@($rK2.Messages) -join ' ') -notmatch 'MAIN checkout') (@($rK2.Messages) -join ' | ')
Assert 'K M8 dismantles the main checkout''s links' (-not (Test-Path -LiteralPath $c2.MainLink)) 'link survived, so this arm proved nothing'

# ===========================================================================
# L -- a worktree with a REAL node_modules is ordinary work. No link is
# reported, removal proceeds, and nothing outside the worktree is touched.
# ===========================================================================
Write-Host "`nL: a real (unlinked) node_modules is removed normally" -ForegroundColor Cyan
$c = New-Case -RealNodeModules
$rL = Invoke-Probe -Path $c.Worktree
Assert 'L no links are reported'          ($rL.LinkCount -eq 0) "LinkCount=$($rL.LinkCount)"
Assert 'L removal succeeds'               ($rL.ok -and $rL.Result -and $rL.Removed) "Result=$($rL.Result) Removed=$($rL.Removed)"
Assert 'L the worktree is gone'           (-not (Test-Path -LiteralPath $c.Worktree)) 'worktree survived'
Assert 'L the shared install is untouched' ((Count-Entries $c.Shared) -eq 5) ("entries=" + (Count-Entries $c.Shared))

# ---------------------------------------------------------------------------
Assert 'every mutation anchor still applies' ($script:AnchorFailures -eq 0) "$script:AnchorFailures anchor(s) no longer match the library"

Remove-Item -LiteralPath $tmpRoot -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ''
Write-Host ("mutcheck-worktree-safety: {0} passed, {1} failed" -f $script:Pass, $script:Fail) -ForegroundColor $(if ($script:Fail) { 'Red' } else { 'Green' })
if ($script:Fail -gt 0) { exit 1 }
exit 0
