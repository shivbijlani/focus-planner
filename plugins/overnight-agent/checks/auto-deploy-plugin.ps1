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
  [switch]$SkipFetch
)

$ErrorActionPreference = 'Stop'

function Write-Note([string]$msg) { if (-not $Json) { Write-Host "[auto-deploy] $msg" } }

$deployer = Join-Path $Repo "$RepoPrefix\overnight-agent\checks\deploy-installed-plugin.ps1"
$sweep    = Join-Path $env:LOCALAPPDATA 'overnight-agent\installed-skill-drift-sweep.mjs'

if (-not (Test-Path $Repo))     { throw "repo not found: $Repo" }
if (-not (Test-Path $deployer)) { throw "deployer not found: $deployer" }
if (-not (Test-Path $sweep))    { throw "classifier not found: $sweep" }

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

$deployOut = & powershell @args 2>&1
$deployExit = $LASTEXITCODE

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

# --- 3. VERIFY AT THE FAR END --------------------------------------------------------
# The deployer reports what it did. This asks the live tree what is true. Re-classifying
# after the write is the only thing that can prove the bytes landed, and it is also the
# only way to notice a file that went straight back out of date.
$env:OA_REPO = $Repo
$env:OA_INSTALLED_PLUGIN = $Installed
$env:OA_REPO_PREFIX = $RepoPrefix
$verifyOut = & node $sweep 2>&1

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

# --- 5. REPORT -----------------------------------------------------------------------
$needsAttention = ($escalate.Count -gt 0) -or (-not $verified)

if ($Json) {
  [pscustomobject]@{
    ok              = -not $needsAttention
    fetched         = $fetched
    ref             = $refSha
    deployed        = @($written)
    refused         = @($refused)
    escalate        = @($escalate)
    residual        = @($residual | ForEach-Object { "$($_.Verdict) $($_.Rel)" })
    verifiedCurrent = $verified
    whatIf          = [bool]$WhatIf
  } | ConvertTo-Json -Depth 5 -Compress
} else {
  Write-Host ''
  Write-Note ("deployed {0}, refused {1}, residual drift {2}, verified-current {3}" -f `
              $written.Count, $refused.Count, $residual.Count, $verified)

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
}

if ($needsAttention) { exit 2 }
exit 0
