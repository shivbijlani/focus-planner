<#
  auto-deploy-plugin.ps1 — close the loop from "merged" to "running". (GH #196)

  WHY THIS EXISTS
  ---------------
  Two of the three pieces already existed and neither one could finish the job alone:

    DETECT   installed-skill-drift-sweep.mjs  — runs nightly, reports the gap.
    DEPLOY   deploy-installed-plugin.ps1      — moves the bytes, safely, by hand.
    WIRE     (this script)                    — was missing.

  The loop from "merged" to "running" had a human step in the middle, and the human
  step is the one that gets skipped. Receipts:

    - PR #151 merged 21 Aug and was still not installed on 26 Aug. Five days. The
      SKILL.md the agent obeys every night was missing the whole PHASE 0 reaper
      section. Merged and dead.
    - 2026-08-28 23:40 PT: `mutcheck-reaper-cohort.ps1` was on origin/main and ABSENT
      from the installed tree — a reliability guard for the reaper that had merged and
      never run. Found by a nightly run and deployed BY HAND, which is the very step
      this script removes.

  THE BUG IN THE SEAM, AND IT IS THE WHOLE POINT
  ----------------------------------------------
  `deploy-installed-plugin.ps1` ends with:

      if ($failed -gt 0) { exit 1 }
      exit 0

  so a REFUSAL exits 0. Refusing is correct behaviour — it declines to revert a live
  fix that exists only on a branch — but it is reported as success. A blocked deploy
  therefore looks identical to a clean one, which is precisely how #151 sat unnoticed.
  Automating the deploy without fixing that seam would automate the silence too.

  So this script owns the three things the deploy tool deliberately does not:

    1. FETCH FIRST. `origin/main` is a local cache. Deploying it without fetching
       ships whatever main looked like the last time somebody fetched — the same
       "cached claim about a computation nobody re-ran" class as a stale `mergeable`
       badge or a stale CI tick. Nothing else in the chain does this.
    2. ESCALATE A PERSISTENT REFUSAL. A refusal on one cycle is information; the same
       refusal on the next cycle is a human decision that is not being made. Streaks
       are counted per file in state and surfaced as an ask once the threshold is hit.
    3. VERIFY AT THE FAR END. The deploy tool reports what it *did*. This re-runs the
       classifier against the LIVE tree afterwards and reports what is *true*. Those
       are different claims, and only the second one is evidence.

  SAFETY
  ------
  This never passes -Force. BRANCH-ONLY files — a live fix that exists on no merged
  ref — are always refused, never overwritten. That refusal is the property that keeps
  auto-deploy from being a blind `copy main over production`, which would revert live
  fixes while looking like a repair.

  EXIT CODES
    0  clean — nothing to do, or everything deployed and the live tree verified current
    1  hard failure — a write failed, or the classifier could not be run
    2  needs attention — a refusal has persisted, or drift survived the deploy

  Usage:
    auto-deploy-plugin.ps1                 # fetch, deploy the safe class, verify
    auto-deploy-plugin.ps1 -WhatIf         # report only; writes nothing, no state change
    auto-deploy-plugin.ps1 -Json           # machine-readable summary on stdout
#>
[CmdletBinding()]
param(
  [switch]$WhatIf,
  [switch]$Json,
  [string]$Ref = 'origin/main',
  [string]$Repo = 'V:\repos\focus-planner',
  [string]$Installed = "$env:USERPROFILE\.copilot\installed-plugins\focus-planner",
  [string]$RepoPrefix = 'plugins',
  [int]$EscalateAfterCycles = 2,
  [string]$StatePath = "$env:LOCALAPPDATA\overnight-agent\auto-deploy-state.json",
  [int]$BudgetSeconds = 55,
  [string]$ClassifierPath,
  [string]$HistoryHelperPath,
  [switch]$SkipFetch,
  [switch]$NoOaHome
)

$ErrorActionPreference = 'Stop'

function Write-Note([string]$msg) { if (-not $Json) { Write-Host "[auto-deploy] $msg" } }
function Get-NormHash([byte[]]$bytes) {
  # The classifier compares NORMALISED content (CRLF and LF are the same file), so this
  # has to normalise identically or a CRLF-stored blob could never match its LF twin.
  $text = (New-Object Text.UTF8Encoding($false)).GetString($bytes)
  $text = $text -replace "`r`n", "`n"
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($text))) }
  finally { $sha.Dispose() }
}

function ConvertTo-QuotedArg([string]$Value) {
  if ($null -eq $Value) { return '""' }
  $escaped = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
  $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
  return '"' + $escaped + '"'
}

function Stop-Bounded($Process) {
  try { $Process.Kill($true); return } catch { }
  try { $Process.Kill() } catch { }
}

function Invoke-Bounded {
  param([string]$FilePath, [string[]]$ArgumentList, [int]$BudgetMs, [string]$InputText = '')
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $FilePath
  $psi.Arguments = (($ArgumentList | ForEach-Object { ConvertTo-QuotedArg $_ }) -join ' ')
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $proc = [System.Diagnostics.Process]::Start($psi)
  $outTask = $proc.StandardOutput.ReadToEndAsync()
  $errTask = $proc.StandardError.ReadToEndAsync()
  if ($InputText) { $proc.StandardInput.Write($InputText) }
  $proc.StandardInput.Close()
  $timedOut = -not $proc.WaitForExit([Math]::Max(1, $BudgetMs))
  if ($timedOut) { Stop-Bounded $proc }
  try { [System.Threading.Tasks.Task]::WaitAll([System.Threading.Tasks.Task[]]@($outTask, $errTask), 2000) | Out-Null } catch { }
  $code = -1
  try { if ($proc.HasExited) { $code = $proc.ExitCode } } catch { }
  [pscustomobject]@{
    TimedOut = $timedOut
    ExitCode = $code
    StdOut = $(try { $outTask.Result } catch { '' })
    StdErr = $(try { $errTask.Result } catch { '' })
  }
}

$deployer = Join-Path $Repo "$RepoPrefix\overnight-agent\checks\deploy-installed-plugin.ps1"
$sweep    = if ($ClassifierPath) { $ClassifierPath } else { Join-Path $env:LOCALAPPDATA 'overnight-agent\installed-skill-drift-sweep.mjs' }
$historyHelper = if ($HistoryHelperPath) { $HistoryHelperPath } else { Join-Path $Repo "$RepoPrefix\overnight-agent\checks\ref-history-index.mjs" }

if (-not (Test-Path $Repo))     { throw "repo not found: $Repo" }
if (-not (Test-Path $deployer)) { throw "deployer not found: $deployer" }
if (-not (Test-Path $sweep))    { throw "classifier not found: $sweep" }
if (-not (Test-Path $historyHelper)) { throw "history helper not found: $historyHelper" }

$budget = [Diagnostics.Stopwatch]::StartNew()
function Get-RemainingMs {
  return [Math]::Max(0, ($BudgetSeconds * 1000) - [int]$budget.ElapsedMilliseconds)
}
function Stop-ForBudget([string]$Phase) {
  $msg = "DEPLOY NOT VERIFIED - wall-clock budget of ${BudgetSeconds}s exceeded during $Phase."
  if ($Json) {
    [pscustomobject]@{ ok=$false; reason='wall-clock-budget'; phase=$Phase; budgetSeconds=$BudgetSeconds } | ConvertTo-Json -Compress
  } else {
    Write-Host "[auto-deploy] $msg"
    Write-Host '[auto-deploy] ASK: surface this failed deploy in the run wrap-up; merged code may not be running.'
  }
  exit 2
}

# --- 0. SELF-BOOTSTRAP ----------------------------------------------------------------
# The running copy of this script decides whether the running copy gets updated. That is
# a loop with a trap in it, and the trap sprang on the very first upgrade: #240's build
# had no supersede check, so when #241 improved this file, the INSTALLED (old) build
# classified its own newer self as a branch-only live fix and refused. It could not
# adopt the fix that would have let it adopt the fix.
#
# The escalation path would eventually have surfaced that to a human, but with actively
# misleading advice ("merge the branch that carries it"), so leaving it to escalation is
# not good enough. The repo copy is authoritative and always at least as new as the
# installed one, so when they differ, hand the decision to the newer code and let IT
# judge. OA_AUTODEPLOY_REEXEC bounds this to a single hop.
if (-not $env:OA_AUTODEPLOY_REEXEC -and $PSCommandPath) {
  $selfRepo = Join-Path $Repo "$RepoPrefix\overnight-agent\checks\auto-deploy-plugin.ps1"
  if (Test-Path $selfRepo) {
    $here = (Resolve-Path $PSCommandPath).Path
    $there = (Resolve-Path $selfRepo).Path
    if ($here -ne $there -and
        (Get-NormHash ([IO.File]::ReadAllBytes($there))) -ne (Get-NormHash ([IO.File]::ReadAllBytes($here)))) {
      Write-Note 'repo copy of this script differs - re-executing it so the NEWER logic decides.'
      $fwd = @('-NoProfile','-ExecutionPolicy','Bypass','-File',$there,
               '-Ref',$Ref,'-Repo',$Repo,'-Installed',$Installed,'-RepoPrefix',$RepoPrefix,
               '-EscalateAfterCycles',$EscalateAfterCycles,'-StatePath',$StatePath,
               '-BudgetSeconds',$BudgetSeconds,'-ClassifierPath',$sweep,'-HistoryHelperPath',$historyHelper)
      if ($WhatIf)    { $fwd += '-WhatIf' }
      if ($Json)      { $fwd += '-Json' }
      if ($SkipFetch) { $fwd += '-SkipFetch' }
      $env:OA_AUTODEPLOY_REEXEC = '1'
      try {
        & powershell @fwd
        exit $LASTEXITCODE
      } finally { Remove-Item Env:\OA_AUTODEPLOY_REEXEC -ErrorAction SilentlyContinue }
    }
  }
}

# --- 1. FETCH ------------------------------------------------------------------------
# Without this the whole run is measured against a cached ref. A deploy that ships a
# stale main is indistinguishable from one that ships the current main, and both report
# success, so this cannot be left to the caller.
$fetched = $false
if (-not $SkipFetch) {
  & git -C $Repo fetch origin --quiet 2>&1 | Out-Null
  $fetched = ($LASTEXITCODE -eq 0)
  if (-not $fetched) { Write-Note "WARNING: git fetch failed - '$Ref' may be stale." }
}
$refSha = (& git -C $Repo rev-parse $Ref 2>&1)
if ($LASTEXITCODE -ne 0) { throw "cannot resolve ref '$Ref' in $Repo" }
$refSha = ([string]$refSha).Trim()

Write-Note "ref       = $Ref ($($refSha.Substring(0,12)))"
Write-Note "installed = $Installed"
if ($WhatIf) { Write-Note 'WHAT-IF - nothing will be written and no state will be recorded.' }

# --- 2. DEPLOY (safe class only; -Force is never passed) -----------------------------
$args = @('-NoProfile','-ExecutionPolicy','Bypass','-File',$deployer,
          '-Ref',$Ref,'-Repo',$Repo,'-Installed',$Installed,'-RepoPrefix',$RepoPrefix)
if (-not $WhatIf) { $args += '-Confirm' }

$deployRun = Invoke-Bounded -FilePath 'powershell' -ArgumentList $args -BudgetMs (Get-RemainingMs)
if ($deployRun.TimedOut) { Stop-ForBudget 'safe deploy classification' }
$deployOut = @($deployRun.StdOut, $deployRun.StdErr) -join "`n"
$deployOut = $deployOut -split '\r?\n'
$deployExit = $deployRun.ExitCode

$written = @()
$refused = @()
foreach ($line in $deployOut) {
  $s = [string]$line
  $m = [regex]::Match($s, '^\s{2}(ADD|REPLACE|FORCED)\s+(\S+)')
  if ($m.Success) { $written += $m.Groups[2].Value; continue }
  $r = [regex]::Match($s, '^\s{2}REFUSE\s+(\S+)')
  if ($r.Success) { $refused += $r.Groups[1].Value }
}

if (-not $Json) { $deployOut | ForEach-Object { Write-Host "  | $_" } }

if ($deployExit -ne 0) {
  Write-Note "FAILED - deployer exited $deployExit."
  if ($Json) { [pscustomobject]@{ ok=$false; reason='deployer-failed'; exit=$deployExit } | ConvertTo-Json -Compress }
  exit 1
}

# --- 2b. RESCUE THE MERELY-STALE FROM THE REFUSAL PILE --------------------------------
# The deployer refuses every BRANCH-ONLY file, which is right when the installed copy is
# a live fix and wrong when it is just an older commit of the ref. Both look identical to
# the classifier. Separate them by asking whether the ref's history already contains the
# installed content: if it does, the ref supersedes it and deploying loses nothing.
$superseded = @()
$removed = @()
$stillRefused = @()
$historyRows = @()
foreach ($rel in $refused) {
  $instFile = Join-Path $Installed ($rel -replace '/', '\')
  $repoPath = "$RepoPrefix/$rel"
  if (Test-Path $instFile) {
    $historyRows += [pscustomobject]@{ repoPath=$repoPath; installedFile=$instFile }
  }
}

$history = [pscustomobject]@{ matches=@{}; onTip=@{} }
if ($historyRows.Count -gt 0) {
  $historyInput = [pscustomobject]@{ paths=$historyRows } | ConvertTo-Json -Depth 4 -Compress
  $env:OA_REPO = $Repo
  $env:OA_REF = $Ref
  $env:OA_HISTORY_SCOPE = "$RepoPrefix/overnight-agent"
  $historyRun = Invoke-Bounded -FilePath 'node' -ArgumentList @($historyHelper) -BudgetMs (Get-RemainingMs) -InputText $historyInput
  if ($historyRun.TimedOut) { Stop-ForBudget 'combined ref history classification' }
  if ($historyRun.ExitCode -ne 0) { throw "history classifier failed: $($historyRun.StdErr)" }
  $history = $historyRun.StdOut | ConvertFrom-Json
}

foreach ($rel in $refused) {
  $repoPath = "$RepoPrefix/$rel"
  $inHistory = ($history.matches.PSObject.Properties.Name -contains $repoPath) -and [bool]$history.matches.$repoPath
  $onTip = ($history.onTip.PSObject.Properties.Name -contains $repoPath) -and [bool]$history.onTip.$repoPath
  if (-not $onTip) {
    # The ref does not have this path at all. Two sub-cases, and only one is safe:
    #   content IS in the ref's history -> the ref DELETED a file we still carry. The
    #     live bytes are a real historical version, so they are provably not a live fix.
    #     Remove it (after backup) - that is what "the ref supersedes it" means when the
    #     ref's decision was a deletion.
    #   content is NOT in the ref's history -> a live-only file that was hand-deployed
    #     and never committed. Refuse: deleting it would destroy the only copy.
    if ($inHistory) { $removed += $rel } else { $stillRefused += $rel }
  }
  elseif ($inHistory) { $superseded += $rel }
  else { $stillRefused += $rel }
}

if ($removed.Count -gt 0) {
  Write-Note ("{0} refused file(s) were DELETED on $Ref and the live bytes are a known historical version - removing." -f $removed.Count)
  $bkRoot = Join-Path $env:LOCALAPPDATA ('overnight-agent\backups\auto-deploy-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
  foreach ($rel in $removed) {
    Write-Note ("  REMOVE   {0}" -f $rel)
    if ($WhatIf) { continue }

    $dst = Join-Path $Installed ($rel -replace '/', '\')
    $bk  = Join-Path $bkRoot ($rel -replace '/', '\')
    $bkParent = Split-Path $bk -Parent
    try {
      if (-not (Test-Path $bkParent)) { New-Item -ItemType Directory -Force -Path $bkParent | Out-Null }
      if (Test-Path $dst) { Copy-Item $dst $bk -Force; Remove-Item $dst -Force }
    } catch {
      Write-Note ("  FAILED   {0}: {1}" -f $rel, $_.Exception.Message)
      $stillRefused += $rel
    }
  }
}

if ($superseded.Count -gt 0) {
  Write-Note ("{0} refused file(s) are provably older commits of $Ref, not live fixes - deploying." -f $superseded.Count)
  foreach ($rel in $superseded) {
    Write-Note ("  BEHIND   {0}" -f $rel)
    if ($WhatIf) { $written += $rel; continue }

    $dst = Join-Path $Installed ($rel -replace '/', '\')
    $repoPath = "$RepoPrefix/$rel"
    $bkRoot = Join-Path $env:LOCALAPPDATA ('overnight-agent\backups\auto-deploy-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
    $bk = Join-Path $bkRoot ($rel -replace '/', '\')
    $bkParent = Split-Path $bk -Parent
    if (-not (Test-Path $bkParent)) { New-Item -ItemType Directory -Force -Path $bkParent | Out-Null }
    if (Test-Path $dst) { Copy-Item $dst $bk -Force }

    $tmp = [IO.Path]::GetTempFileName()
    try {
      & cmd /c "cd /d `"$Repo`" && git cat-file blob $Ref`:$repoPath > `"$tmp`"" 2>&1 | Out-Null
      $want = [int](& git -C $Repo cat-file -s "$Ref`:$repoPath")
      if ((Get-Item $tmp).Length -ne $want) { throw "size mismatch for $repoPath" }
      Copy-Item $tmp $dst -Force
      $written += $rel
    } catch {
      Write-Note ("  FAILED   {0}: {1}" -f $rel, $_.Exception.Message)
      $stillRefused += $rel
    } finally { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
  }
}

# From here on, only genuine divergence counts as a refusal.
$refused = $stillRefused

# --- 3. VERIFY AT THE FAR END --------------------------------------------------------
# The deployer reports what it did. This asks the live tree what is true. Re-classifying
# after the write is the only thing that can prove the bytes landed, and it is also the
# only way to notice a file that went straight back out of date.
$env:OA_REPO = $Repo
$env:OA_INSTALLED_PLUGIN = $Installed
$env:OA_REPO_PREFIX = $RepoPrefix
$verifyRun = Invoke-Bounded -FilePath 'node' -ArgumentList @($sweep) -BudgetMs (Get-RemainingMs)
if ($verifyRun.TimedOut) { Stop-ForBudget 'far-end verification' }
$verifyOut = @($verifyRun.StdOut, $verifyRun.StdErr) -join "`n"
$verifyOut = $verifyOut -split '\r?\n'

$residual = @()
foreach ($line in $verifyOut) {
  $m = [regex]::Match([string]$line, '^\s{2}(BRANCH-ONLY|UNVERSIONED|MISSING)\s+(\S+)\s+\[')
  if ($m.Success) { $residual += [pscustomobject]@{ Verdict=$m.Groups[1].Value; Rel=$m.Groups[2].Value } }
}
$verified = @($residual | Where-Object { $_.Verdict -eq 'MISSING' }).Count -eq 0

# --- 4. ESCALATE A PERSISTENT REFUSAL ------------------------------------------------
# One refusal is information. The same refusal next cycle is a decision nobody is
# making - which is the failure mode #151 demonstrated over five days.
$state = @{ streaks = @{}; last_run = $null; last_ref = $null }
if (Test-Path $StatePath) {
  try {
    $raw = Get-Content $StatePath -Raw -ErrorAction Stop
    $parsed = $raw | ConvertFrom-Json -ErrorAction Stop
    $state.streaks = @{}
    if ($parsed.streaks) {
      foreach ($p in $parsed.streaks.PSObject.Properties) { $state.streaks[$p.Name] = [int]$p.Value }
    }
  } catch {
    Write-Note "state unreadable ($($_.Exception.Message)) - starting a fresh streak table."
  }
}

$newStreaks = @{}
foreach ($rel in $refused) {
  $prev = 0
  if ($state.streaks.ContainsKey($rel)) { $prev = [int]$state.streaks[$rel] }
  $newStreaks[$rel] = $prev + 1
}

$escalate = @()
foreach ($rel in $newStreaks.Keys) {
  if ($newStreaks[$rel] -ge $EscalateAfterCycles) { $escalate += $rel }
}

if (-not $WhatIf) {
  $dir = Split-Path $StatePath -Parent
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  ([pscustomobject]@{
    streaks  = $newStreaks
    last_run = (Get-Date).ToString('o')
    last_ref = $refSha
  } | ConvertTo-Json -Depth 5) | Set-Content -Path $StatePath -Encoding UTF8
}

# --- 4.5 THE SECOND DEPLOY TARGET ----------------------------------------------------
# `installed-plugins` is not the only place the running code lives, and it is not the
# copy most of user-settings.md actually invokes. Those rows name
# `%LOCALAPPDATA%\overnight-agent\<script>` verbatim - the flat OA home - so a file can
# be merged, deployed here, reported "verified-current True", and still not be what the
# next run executes.
#
# Measured 2026-08-29, seconds after this script reported a clean tree: the live
# `reap-stale-mcp.ps1` was 16,360 bytes (300 lines) behind main, missing #237's
# wedged-session-host collection - the fix for the standing "we keep having to restart
# the device" complaint. Merged, deployed, and not running.
#
# So this step is part of the same contract, not an extra: "merged means running" is
# false while any deploy target is unsynced. It is invoked here rather than added as a
# line in SKILL.md because this file's own history is that a separate instruction is
# the thing that gets skipped.
$oaHomeExit = 0
if (-not $NoOaHome) {
  # Resolve the sub-tool from several roots, not just "next to me". This script is
  # deliberately deployed to BOTH targets, so $PSScriptRoot is sometimes the flat OA
  # home - where a brand-new check has not landed yet, because the OA home only
  # updates files it already has and never gains new ones. Anchoring on $PSScriptRoot
  # alone therefore made the OA home the one place the sync could not run: the copy
  # most likely to be stale silently skipped its own repair and still reported
  # success. Caught by verifying the far end after the first deploy of this feature.
  $syncCandidates = @(
    (Join-Path $PSScriptRoot 'sync-oa-home.ps1'),
    (Join-Path $Repo 'plugins\overnight-agent\checks\sync-oa-home.ps1'),
    (Join-Path $Installed 'overnight-agent\checks\sync-oa-home.ps1')
  )
  $syncScript = $syncCandidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
  if ($syncScript) {
    Write-Host ''
    Write-Note "syncing the OA home (second deploy target) via $syncScript"
    try {
      $syncArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $syncScript,
                    '-Ref', $Ref, '-Repo', $Repo, '-SkipFetch')
      if ($WhatIf) { $syncArgs += '-WhatIf' }
      & powershell @syncArgs 2>&1 | ForEach-Object { Write-Host ("  | " + $_) }
      $oaHomeExit = $LASTEXITCODE
    } catch {
      # A failed sync must never abort the run - it degrades to "not synced", which is
      # the status quo it replaces, and is reported rather than thrown.
      Write-Host "  | sync-oa-home failed: $_"
      $oaHomeExit = 2
    }
  } else {
    # Never fail silently. A missing sub-tool and a clean sync produced the same
    # output before this branch existed, which is the "detector wired to nothing"
    # shape this repo keeps rediscovering.
    Write-Host ''
    Write-Note 'sync-oa-home.ps1 NOT FOUND in any known root - the OA home was NOT synced.'
    $oaHomeExit = 2
  }
}

# --- 5. REPORT -----------------------------------------------------------------------
$needsAttention = ($escalate.Count -gt 0) -or (-not $verified) -or ($oaHomeExit -ne 0)

if ($Json) {
  [pscustomobject]@{
    ok              = -not $needsAttention
    fetched         = $fetched
    ref             = $refSha
    deployed        = @($written)
    refused         = @($refused)
    superseded      = @($superseded)
    removed         = @($removed)
    escalate        = @($escalate)
    residual        = @($residual | ForEach-Object { "$($_.Verdict) $($_.Rel)" })
    verifiedCurrent = $verified
    oaHomeExit      = $oaHomeExit
    whatIf          = [bool]$WhatIf
  } | ConvertTo-Json -Depth 5 -Compress
} else {
  Write-Host ''
  Write-Note ("deployed {0}, removed {1}, refused {2}, residual drift {3}, verified-current {4}" -f `
              $written.Count, $removed.Count, $refused.Count, $residual.Count, $verified)

  if ($escalate.Count -gt 0) {
    Write-Host ''
    Write-Host '  NEEDS A HUMAN DECISION - these were refused on consecutive cycles:'
    foreach ($rel in $escalate) {
      Write-Host ("    {0}  (refused {1}x in a row)" -f $rel, $newStreaks[$rel])
    }
    Write-Host '    Each is a live fix that exists on no merged ref. Either merge the branch'
    Write-Host '    that carries it, or accept the revert by re-running the deployer -Force.'
  }
  if (-not $verified) {
    Write-Host ''
    Write-Host '  DRIFT SURVIVED THE DEPLOY - a file on the ref is still absent from the'
    Write-Host '  installed tree. This is the "merged but dead" case; investigate before'
    Write-Host '  trusting the running agent.'
  }
  if ($oaHomeExit -ne 0) {
    Write-Host ''
    Write-Host '  THE OA HOME IS NOT CLEAN - see the sync-oa-home lines above. The copies'
    Write-Host '  under %LOCALAPPDATA%\overnight-agent are what user-settings.md actually'
    Write-Host '  invokes, so a file left behind there is not running no matter what the'
    Write-Host '  installed tree says.'
  }
}

if ($needsAttention) { exit 2 }
exit 0
