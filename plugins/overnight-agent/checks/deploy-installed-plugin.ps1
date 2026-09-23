<#
  deploy-installed-plugin.ps1 — write a git ref's plugin files into installed-plugins.

  WHY THIS EXISTS
  ---------------
  Merging does not deploy. Nothing copies `main` into
  `~\.copilot\installed-plugins\focus-planner`, so the running agent and the repo drift
  in BOTH directions, silently:

    FORWARD  a fix is committed, PR'd, CI-green, merged -- and never runs. PR #151
             ("reap stale MCP servers before PHASE 0") merged as 3be794c, +271/-1.
             Measured 2026-08-26: the installed tree had no reap-stale-mcp.ps1 and the
             installed SKILL.md had zero occurrences of "reap-stale-mcp". Every line was
             merged and dead for days.
    BACKWARD a hand-deployed fix exists on no merged ref, so a plugin reinstall reverts
             it with nothing to notice. The installed oa-state.ps1 has been in this state.

  `installed-skill-drift-sweep.mjs` DETECTS both. This script is the other half -- the
  thing that actually moves bytes -- exactly as `sync-checks.ps1` is the other half of
  `repo-drift-sweep.mjs`. Without it every finding ends in "somebody should hand-copy
  some files", which is precisely the step that never happens.

  THE SAFETY PROPERTY THAT MAKES THIS MORE THAN A COPY
  ---------------------------------------------------
  A naive copy of `main` over the installed tree would REVERT any live hand-deployed fix
  that has not merged yet -- causing the BACKWARD failure above while appearing to fix
  things. So this script classifies every file first and refuses that case by default:

    MISSING      on the ref, absent installed        -> deploy (nothing can be lost)
    UNVERSIONED  installed content on no ref at all  -> deploy, after backup (-Confirm)
    BRANCH-ONLY  live bytes match a side ref, not $Ref. Split by ancestry (#575):
                 provably an older commit of $Ref -> BEHIND, deployed (it advances)
                 anything else                    -> REFUSED unless -Force
    MAIN         already identical                   -> skip

  Classification is delegated to installed-skill-drift-sweep.mjs rather than
  reimplemented, so the two halves cannot disagree. sync-checks.ps1 makes the same
  choice for the same reason ("deriving it here would duplicate the logic in a second
  place, which is the same drift problem one level up").

  Dry-run is the default. This overwrites the agent's own instructions, so seeing what
  it would do must never be the same action as doing it.

  Usage:
    deploy-installed-plugin.ps1                    # dry run against origin/main
    deploy-installed-plugin.ps1 -Confirm           # deploy MISSING + UNVERSIONED
    deploy-installed-plugin.ps1 -Confirm -Force    # also overwrite BRANCH-ONLY files
    deploy-installed-plugin.ps1 -Ref origin/some-branch -Confirm
#>
[CmdletBinding()]
param(
  [switch]$Confirm,
  [switch]$Force,
  [string]$Ref = 'origin/main',
  [string]$Repo = 'V:\repos\focus-planner',
  [string]$Installed = "$env:USERPROFILE\.copilot\installed-plugins\focus-planner",
  [string]$RepoPrefix = 'plugins',
  [string]$ClassifierPath,
  # #575. The ancestry helper that tells a file that is merely BEHIND from one that is
  # genuinely AHEAD. Overridable only so the mutation check can point it at a stub.
  [string]$HistoryHelperPath,
  # #575. Suppress the ancestry split and refuse every BRANCH-ONLY file, as this script
  # did before that issue.
  #
  # THIS EXISTS FOR ONE CALLER, and not as a general escape hatch. `auto-deploy-plugin.ps1`
  # runs a SECOND phase that re-examines the refusal pile, rescues the merely-stale files
  # itself, and reports them as `superseded` in its JSON. That two-phase contract is
  # covered by ~95 mutation arms. Splitting them here as well would empty the pile the
  # rescue phase reads, so the rescue would report nothing while the files silently
  # deployed a step earlier -- the same outcome, described wrongly, which is precisely the
  # defect class #575 is about.
  #
  # The standalone path is the one #575 measured: a human or a sub-session running this
  # script directly gets no rescue phase, obeys a refusal that asserts the opposite of the
  # truth, and stops. That path is what the split fixes.
  [switch]$NoAncestry,
  # Where replaced files are backed up. Overridable so this script can run on a host with
  # no %LOCALAPPDATA% (the Linux CI runner), where the default would be a null path.
  [string]$BackupRoot
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $Repo))      { throw "repo not found: $Repo" }
if (-not (Test-Path $Installed)) { throw "installed plugin not found: $Installed" }

$sweep = if ($ClassifierPath) { $ClassifierPath } elseif ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'overnight-agent\installed-skill-drift-sweep.mjs' } else { '' }
if (-not $sweep -or -not (Test-Path $sweep)) { throw "classifier not found: $sweep" }

# Where a replaced file is copied before it is overwritten. Overridable so the mutation
# check can run on a host that has no %LOCALAPPDATA% -- `Join-Path` with a null root is a
# binding error, so this line alone made the whole script unrunnable on the Linux CI
# runner (the same host split #632 and #635 record).
$backupRoot = if ($BackupRoot) { $BackupRoot }
              elseif ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA ('overnight-agent\backups\deploy-' + (Get-Date -Format 'yyyyMMdd-HHmmss')) }
              else { Join-Path ([IO.Path]::GetTempPath()) ('oa-deploy-backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss')) }

Write-Host "[deploy] ref       = $Ref"
Write-Host "[deploy] repo      = $Repo"
Write-Host "[deploy] installed = $Installed"
if (-not $Confirm) { Write-Host '[deploy] DRY RUN - pass -Confirm to actually write.' }

# --- classify (delegated, never reimplemented) --------------------------------------
$env:OA_REPO = $Repo
$env:OA_INSTALLED_PLUGIN = $Installed
$env:OA_REPO_PREFIX = $RepoPrefix
$out = & node $sweep 2>&1

$plan = @()
foreach ($line in $out) {
  $m = [regex]::Match([string]$line, '^\s{2}(MAIN|BRANCH-ONLY|UNVERSIONED|MISSING)\s+(\S+)\s+\[')
  if ($m.Success) {
    $plan += [pscustomobject]@{ Verdict = $m.Groups[1].Value; Rel = $m.Groups[2].Value }
  }
}

if (-not $plan.Count) {
  Write-Host '[deploy] classifier produced no verdicts - refusing to guess.'
  $out | ForEach-Object { Write-Host "    $_" }
  exit 1
}

# --- #575: is a BRANCH-ONLY file AHEAD of the ref, or merely BEHIND it? --------------
#
# `BRANCH-ONLY` means "the installed bytes match some ref that is not $Ref". That is a
# DISJUNCTION covering two opposite situations, and this script used to read it as one
# fact and print the more alarming reading:
#
#   genuinely AHEAD   someone hand-patched the installed tree and pushed it to a side
#                     branch. Deploying WOULD revert it. Refusing is right.
#   genuinely BEHIND  a PR merged; the installed tree still holds the pre-merge content,
#                     which is still reachable from the (undeleted) source branch.
#                     Deploying is the entire point. Refusing is wrong -- and the message
#                     "deploying would REVERT it" asserts the exact opposite of the truth.
#
# Case 2 is the common one and gets MORE likely with every healthy merge: every merged
# but undeleted branch is a standing reservoir of superseded blobs (41 of 229 local
# branches, measured in #575).
#
# WHY THIS MATTERS MORE THAN A WORDING FIX. The refusal is the safety mechanism a reader
# is supposed to obey, and obeying it is what blocks the deploy. A sub-session hit it on
# two consecutive wakes and correctly declined to -Force past a message saying data loss
# was the alternative; it only got past by diffing both sides by hand. A guard that lies
# about which way the danger points teaches its readers to ignore it.
#
# The fix is not new logic: `auto-deploy-plugin.ps1` already resolves exactly this with
# `ref-history-index.mjs`, and this script simply did not consult it. Sharing the helper
# rather than re-deriving ancestry keeps the two deploy paths from forming two opinions
# about what BRANCH-ONLY means.
#
# FAILS CLOSED. If the helper is missing, unrunnable, or returns something unparseable,
# every BRANCH-ONLY file stays refused exactly as before. A blind run must not start
# overwriting files it cannot classify.
function Get-BehindSet {
  param([string[]]$Rels)

  $result = @{}
  if (-not $Rels -or $Rels.Count -eq 0) { return $result }

  # An EXPLICIT override that does not exist is an error, not an invitation to search.
  # Silently falling back would make `-HistoryHelperPath` untestable and, worse, would
  # mean a caller who pointed at a specific helper got a different one without being told.
  # Only the DEFAULT path is allowed to fall back to the repo-local copy.
  $helper = $null
  if ($HistoryHelperPath) {
    if (Test-Path -LiteralPath $HistoryHelperPath) { $helper = $HistoryHelperPath }
    else {
      Write-Host ("[deploy] NOTE - ancestry helper not found at {0}; BRANCH-ONLY stays refused (see #575)." -f $HistoryHelperPath)
      return $result
    }
  }
  else {
    foreach ($c in @((Join-Path $env:LOCALAPPDATA 'overnight-agent\ref-history-index.mjs'),
                     (Join-Path $PSScriptRoot 'ref-history-index.mjs'))) {
      if (Test-Path -LiteralPath $c) { $helper = $c; break }
    }
    if (-not $helper) {
      Write-Host '[deploy] NOTE - ancestry helper not found; BRANCH-ONLY stays refused (see #575).'
      return $result
    }
  }

  $rows = @()
  foreach ($rel in $Rels) {
    $instFile = Join-Path $Installed ($rel -replace '/', '\')
    if (Test-Path -LiteralPath $instFile) {
      $rows += [pscustomobject]@{ repoPath = "$RepoPrefix/$rel"; installedFile = $instFile }
    }
  }
  if ($rows.Count -eq 0) { return $result }

  try {
    $payload = [pscustomobject]@{ paths = $rows } | ConvertTo-Json -Depth 4 -Compress
    $env:OA_REPO = $Repo
    $env:OA_REF = $Ref
    $env:OA_HISTORY_SCOPE = "$RepoPrefix/overnight-agent"
    $raw = $payload | & node $helper 2>&1
    if ($LASTEXITCODE -ne 0) { throw "helper exited $LASTEXITCODE" }
    $history = (@($raw) | Out-String) | ConvertFrom-Json
  }
  catch {
    Write-Host ("[deploy] NOTE - ancestry check unavailable ({0}); BRANCH-ONLY stays refused." -f $_.Exception.Message)
    return $result
  }

  foreach ($rel in $Rels) {
    $repoPath = "$RepoPrefix/$rel"
    # BEHIND requires BOTH: the ref still carries this path (so deploying means replacing
    # rather than resurrecting), AND the live bytes are a known historical version of it
    # (so they are provably not an uncommitted live fix). Anything else stays refused.
    $inHistory = ($history.matches.PSObject.Properties.Name -contains $repoPath) -and [bool]$history.matches.$repoPath
    $onTip = ($history.onTip.PSObject.Properties.Name -contains $repoPath) -and [bool]$history.onTip.$repoPath
    if ($inHistory -and $onTip) { $result[$rel] = $true }
  }
  return $result
}

$branchOnly = @($plan | Where-Object { $_.Verdict -eq 'BRANCH-ONLY' } | ForEach-Object { $_.Rel })
$behind = if ($NoAncestry) { @{} } else { Get-BehindSet -Rels $branchOnly }

# --- decide -------------------------------------------------------------------------
$deployed = 0; $skipped = 0; $refused = 0; $failed = 0

foreach ($row in $plan) {
  $dst = Join-Path $Installed ($row.Rel -replace '/', '\')
  $repoPath = "$RepoPrefix/$($row.Rel)"

  # NOTE: deliberately if/elseif, not switch. In PowerShell `continue` inside a switch
  # block continues the SWITCH, not the enclosing foreach, so a MAIN file fell through
  # to the write path and was counted as "to write". Caught by the first dry run
  # reporting 9 to write when only 1 file was eligible.
  if ($row.Verdict -eq 'MAIN') {
    $skipped++
    continue
  }
  elseif ($row.Verdict -eq 'BRANCH-ONLY' -and $behind.ContainsKey($row.Rel)) {
    # #575: provably an older commit of $Ref, not a live fix. Deploying ADVANCES it.
    Write-Host ("  BEHIND   {0}" -f $row.Rel)
  }
  elseif ($row.Verdict -eq 'BRANCH-ONLY' -and -not $Force) {
    Write-Host ("  REFUSE   {0}" -f $row.Rel)
    # The claim is now the narrow one the evidence supports. The old wording asserted
    # "deploying would REVERT it", which on a normal merge is exactly backwards (#575).
    Write-Host  "           live bytes match a ref other than $Ref and are NOT a known older commit of it"
    Write-Host  "           -- may be a hand-deployed live fix. Use -Force to override."
    $refused++
    continue
  }
  elseif ($row.Verdict -eq 'BRANCH-ONLY') { Write-Host ("  FORCED   {0}" -f $row.Rel) }
  elseif ($row.Verdict -eq 'UNVERSIONED') { Write-Host ("  REPLACE  {0}" -f $row.Rel) }
  elseif ($row.Verdict -eq 'MISSING')     { Write-Host ("  ADD      {0}" -f $row.Rel) }
  else {
    Write-Host ("  UNKNOWN verdict '{0}' for {1} - skipping rather than guessing." -f $row.Verdict, $row.Rel)
    $skipped++
    continue
  }

  if (-not $Confirm) { $deployed++; continue }

  # Materialise the ref's bytes exactly. `git show > file` in PowerShell re-encodes, so
  # go through git's own output stream with no shell redirection in between.
  $parent = Split-Path $dst -Parent
  if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }

  if (Test-Path $dst) {
    $bk = Join-Path $backupRoot ($row.Rel -replace '/', '\')
    $bkParent = Split-Path $bk -Parent
    if (-not (Test-Path $bkParent)) { New-Item -ItemType Directory -Force -Path $bkParent | Out-Null }
    Copy-Item $dst $bk -Force
  }

  $tmp = [System.IO.Path]::GetTempFileName()
  try {
    & cmd /c "cd /d `"$Repo`" && git cat-file blob $Ref`:$repoPath > `"$tmp`"" 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $tmp)) { throw "git cat-file failed for $repoPath" }
    Copy-Item $tmp $dst -Force
    $deployed++
  } catch {
    Write-Host ("           FAILED: {0}" -f $_.Exception.Message)
    $failed++
  } finally {
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
  }
}

Write-Host ''
Write-Host ("[deploy] {0} to write, {1} already current, {2} refused, {3} failed." -f $deployed, $skipped, $refused, $failed)
if ($Confirm -and $deployed -gt 0) { Write-Host "[deploy] backups: $backupRoot" }
if (-not $Confirm -and $deployed -gt 0) { Write-Host '[deploy] Nothing was written. Re-run with -Confirm.' }

if ($failed -gt 0) { exit 1 }
exit 0
