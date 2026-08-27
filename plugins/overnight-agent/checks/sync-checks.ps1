<#
  sync-checks.ps1 — move the nightly check suite between the repo and the machine.

  WHY THIS EXISTS
  ---------------
  On 2026-08-26 a run measured what user-settings.md had only asserted: 70 of the
  73 files making up the nightly enforcement suite existed in exactly one place,
  `%LOCALAPPDATA%\overnight-agent`, on one laptop. No history, no backup, not even
  in OneDrive. `repo-drift-sweep.mjs` now detects divergence every night. This
  script is the other half — the thing that actually moves bytes, in either
  direction, so "detected drift" has a one-command answer instead of a manual
  file-by-file copy at the worst possible moment.

  TWO DIRECTIONS, DELIBERATELY NAMED
  ----------------------------------
    -Capture   machine -> repo.  The normal nightly case: the agent wrote or
               edited a sweep in LOCALAPPDATA and it needs to reach git.
    -Restore   repo -> machine.  Disaster recovery: a new laptop, a wiped
               profile, or a bad edit that needs reverting to the committed copy.

  Neither direction runs without an explicit switch, and both default to -WhatIf
  semantics unless -Confirm is passed. Restore in particular OVERWRITES live,
  currently-executing checks, so it must never be the thing that happens when
  someone runs the script to see what it does.

  Usage:
    sync-checks.ps1 -Capture                 # show what would be copied
    sync-checks.ps1 -Capture -Confirm        # actually copy machine -> repo
    sync-checks.ps1 -Restore -Confirm        # actually copy repo -> machine
#>
[CmdletBinding()]
param(
  [switch]$Capture,
  [switch]$Restore,
  [switch]$Confirm,
  [string]$ChecksRepo,
  [string]$OaHome
)

$ErrorActionPreference = 'Stop'

if ($Capture -and $Restore) { throw 'Pick one direction: -Capture or -Restore, not both.' }
if (-not $Capture -and -not $Restore) {
  throw 'No direction given. Use -Capture (machine -> repo) or -Restore (repo -> machine).'
}

if (-not $OaHome) { $OaHome = Join-Path $env:LOCALAPPDATA 'overnight-agent' }

if (-not $ChecksRepo) {
  $candidates = @(
    'V:\repos\focus-planner\plugins\overnight-agent\checks',
    'V:\repos\focus-planner.worktrees\oa-version-the-checks\plugins\overnight-agent\checks'
  )
  $ChecksRepo = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}

if (-not $ChecksRepo) { throw 'Could not locate the checks archive. Pass -ChecksRepo.' }
if (-not (Test-Path $OaHome)) { throw "OA home not found: $OaHome" }

# The corpus is whatever the archive holds. Deriving it from the registry here
# would duplicate repo-drift-sweep's logic in a second place, which is the same
# drift problem one level up.
$files = Get-ChildItem $ChecksRepo -File | Where-Object { $_.Extension -in '.mjs', '.ps1' }

if ($Restore) { $srcDir = $ChecksRepo; $dstDir = $OaHome;      $label = 'repo -> machine' }
else          { $srcDir = $OaHome;    $dstDir = $ChecksRepo;   $label = 'machine -> repo' }

Write-Host "[sync-checks] $label"
Write-Host "[sync-checks] src = $srcDir"
Write-Host "[sync-checks] dst = $dstDir"
if (-not $Confirm) { Write-Host '[sync-checks] DRY RUN - pass -Confirm to actually copy.' }

function Get-NormalizedHash([string]$path) {
  if (-not (Test-Path $path)) { return $null }
  $text = [IO.File]::ReadAllText($path)
  $norm = ($text -replace "`r`n", "`n").TrimEnd()
  $bytes = [Text.Encoding]::UTF8.GetBytes($norm)
  $sha = [Security.Cryptography.SHA256]::Create()
  return [Convert]::ToBase64String($sha.ComputeHash($bytes))
}

$changed = 0
$same = 0
$missing = 0

foreach ($f in $files) {
  $src = Join-Path $srcDir $f.Name
  $dst = Join-Path $dstDir $f.Name

  if (-not (Test-Path $src)) {
    Write-Host ("  MISSING-SRC  {0}" -f $f.Name)
    $missing++
    continue
  }

  $hs = Get-NormalizedHash $src
  $hd = Get-NormalizedHash $dst

  if ($hs -eq $hd) { $same++; continue }

  Write-Host ("  {0}  {1}" -f $(if ($hd) { 'UPDATE ' } else { 'NEW    ' }), $f.Name)
  $changed++

  if ($Confirm) {
    # Back up whatever is being overwritten, so an unattended restore is undoable.
    if ($hd) {
      $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
      Copy-Item $dst "$dst.pre-sync-$stamp" -Force
    }
    Copy-Item $src $dst -Force
  }
}

Write-Host ""
Write-Host ("[sync-checks] {0} to copy, {1} already identical, {2} missing at source." -f $changed, $same, $missing)
if ($changed -gt 0 -and -not $Confirm) {
  Write-Host '[sync-checks] Nothing was written. Re-run with -Confirm.'
  exit 1
}
exit 0
