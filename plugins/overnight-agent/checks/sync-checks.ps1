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

# The corpus is the archive, PLUS -- when capturing -- everything the suite actually
# runs. Deriving it from the archive ALONE (the original behaviour) makes -Capture
# structurally incapable of ever adding a NEW check: a sweep written on the machine is
# not in the archive, so it is not in the list, so it is never copied -- and the run
# still prints "N already identical" and exits happy. That is the exact "existed on one
# machine only" failure this script was built to end, reintroduced inside the tool meant
# to fix it. Found 2026-08-27 while adding swallowed-message-sweep.mjs, which -Capture
# silently declined to notice.
#
# Reading the names out of run-sweeps.ps1 is not a second copy of repo-drift-sweep's
# logic: that sweep COMPARES contents, this only asks which files exist, and the
# registry is the one authoritative answer to "what runs tonight".
$names = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
foreach ($f in (Get-ChildItem $ChecksRepo -File | Where-Object { $_.Extension -in '.mjs', '.ps1' })) {
  [void]$names.Add($f.Name)
}
if ($Capture) {
  $runner = Join-Path $OaHome 'run-sweeps.ps1'
  if (Test-Path $runner) {
    foreach ($m in [regex]::Matches((Get-Content $runner -Raw), "n\s*=\s*'([^']+)'")) {
      [void]$names.Add($m.Groups[1].Value + '.mjs')
    }
  }
  foreach ($f in (Get-ChildItem $OaHome -File -Filter 'mutcheck-*')) {
    if ($f.Extension -in '.mjs', '.ps1') { [void]$names.Add($f.Name) }
  }

  # THE SECOND REGISTRY (added 2026-08-27).
  #
  # run-sweeps.ps1 answers "what runs tonight, unattended". user-settings.md is
  # the other roster -- the operating manual a future run reads and executes
  # from -- and it names runnable files that no sweep imports and no registry
  # lists. Measured 2026-08-27: 25 such files, every one of them untracked in
  # every git ref, including fix-playwright-npx-slots.ps1, the apply-script Shiv
  # is actively being asked to approve. If this laptop died, the approval he is
  # being asked for would have pointed at nothing.
  #
  # This is the same defect this script was built to end, for the third time and
  # one level up: (1) 70 files on one laptop; (2) -Capture enumerating the repo
  # side, so a NEW check was structurally uncapturable (fixed above, 2026-08-27);
  # (3) both halves then trusting a single registry while a second went unread.
  #
  # A name only counts if the file actually exists here, so the arm is grounded
  # in what is on disk rather than in prose.
  $settings = $env:OVERNIGHT_AGENT_SETTINGS
  if (-not $settings -and $env:PLANNER_PATH) { $settings = Join-Path $env:PLANNER_PATH 'user-settings.md' }
  if (-not $settings -and $env:OneDrive) { $settings = Join-Path $env:OneDrive 'Apps\Focus Planner\user-settings.md' }
  if ($settings -and (Test-Path $settings)) {
    $docHits = 0
    foreach ($m in [regex]::Matches((Get-Content $settings -Raw), '([A-Za-z0-9._-]+\.(?:mjs|ps1))')) {
      $n = $m.Groups[1].Value
      if ($n -like '*.bak*') { continue }
      if (Test-Path (Join-Path $OaHome $n)) { if ($names.Add($n)) { $docHits++ } }
    }
    Write-Host "[sync-checks] manual = $settings (+$docHits file(s) named there and nowhere else)"
  }
  else {
    Write-Host '[sync-checks] WARNING: user-settings.md not found - the manual arm is not running.'
  }
}
$files = $names | Sort-Object | ForEach-Object { [pscustomobject]@{ Name = $_ } }

# Skill-owned files have a different home: plugins/overnight-agent/skills/overnight-agent/,
# because the harness loads them from the skill folder. They are versioned there and
# guarded by installed-skill-drift-sweep. Copying them into checks/ as well would create
# a second copy of a file that already has one, which is how "which of these two is the
# real one?" starts -- the same question this whole exercise exists to make unaskable.
# repo-drift-sweep.mjs routes them the same way (SKILL_OWNED); this mirrors it.
$skillOwned = @('write-turn.ps1', 'mutcheck-write-turn.ps1', 'reap-stale-mcp.ps1', 'oa-state.ps1', 'oa-state.Tests.ps1')
$skipped = @($files | Where-Object { $skillOwned -contains $_.Name })
if ($skipped.Count -gt 0) {
  $files = @($files | Where-Object { $skillOwned -notcontains $_.Name })
  Write-Host ("[sync-checks] skipping {0} skill-owned file(s) (they live in skills/overnight-agent/): {1}" -f $skipped.Count, (($skipped | ForEach-Object { $_.Name }) -join ', '))
}

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
    #
    # ...but only when the destination is the MACHINE. On -Capture the destination
    # is the git worktree, where the backup is both redundant (git already holds
    # every prior version) and actively harmful: it drops untracked
    # `*.pre-sync-*` files into the repo, where the next `git add -A` commits
    # them. Found 2026-08-27, when the first manual-arm capture left two of them
    # next to the files it had just archived.
    if ($hd -and -not $Capture) {
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
