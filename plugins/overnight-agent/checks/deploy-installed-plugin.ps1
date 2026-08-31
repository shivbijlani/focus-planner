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
    BRANCH-ONLY  live fix exists only on a side ref  -> REFUSED unless -Force
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
  [string]$RepoPrefix = 'plugins'
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $Repo))      { throw "repo not found: $Repo" }
if (-not (Test-Path $Installed)) { throw "installed plugin not found: $Installed" }

$sweep = Join-Path $env:LOCALAPPDATA 'overnight-agent\installed-skill-drift-sweep.mjs'
if (-not (Test-Path $sweep)) { throw "classifier not found: $sweep" }

$backupRoot = Join-Path $env:LOCALAPPDATA ('overnight-agent\backups\deploy-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))

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
  elseif ($row.Verdict -eq 'BRANCH-ONLY' -and -not $Force) {
    Write-Host ("  REFUSE   {0}" -f $row.Rel)
    Write-Host  "           live fix is not on $Ref - deploying would REVERT it. Use -Force to override."
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
    $want = [int](& git -C $Repo cat-file -s "$Ref`:$repoPath")
    $got = (Get-Item $tmp).Length
    if ($got -ne $want) { throw "size mismatch for $repoPath (blob $want, wrote $got)" }
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
