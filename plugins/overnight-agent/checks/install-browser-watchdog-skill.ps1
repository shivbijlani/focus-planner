<#
.SYNOPSIS
  install-browser-watchdog-skill.ps1 - point the hourly `browser-watchdog` skill
  at the repo-hosted, deployed supervisor (GH #197).

.DESCRIPTION
  WHY THIS FILE EXISTS
  --------------------
  The thing that actually runs hourly is a Copilot workflow whose entire prompt
  is `/browser-watchdog`. That skill lives OUTSIDE this repository, at
  `~\.copilot\skills\browser-watchdog\` (with `~\.agents\skills\browser-watchdog`
  and `~\OneDrive\skills\browser-watchdog` being the same folder - the first two
  are junctions). So it is covered by no CI, no tests and no deploy pipeline,
  which is exactly how it kept a TCP-accept health check months after a real CDP
  work probe had shipped in `check-browser-slots.ps1`.

  An earlier attempt to repo-host the watchdog stalled unmerged (`440314e`), and
  the unversioned copy carried on running. So the fix has two halves:

    1. the LOGIC moves into the repo (`browser-watchdog.ps1`), where it is
       guarded by `mutcheck-browser-watchdog.ps1` and carried to the machine by
       `sync-oa-home.ps1` like every other standing check; and
    2. the skill's own `watchdog.ps1` becomes a thin SHIM that calls it - which
       is what this script installs, idempotently and reversibly.

  WHY A SHIM RATHER THAN A COPY
  -----------------------------
  A copy would drift, and drift in this exact file is the defect. A shim has no
  logic to drift: it resolves the deployed supervisor and execs it.

  WHY THE SHIM STILL FALLS BACK
  -----------------------------
  If the repo-hosted supervisor is absent (a machine that has not synced yet),
  the shim runs the PRESERVED original so that DOWN slots still get launched -
  losing that would be a real regression - but it exits non-zero and says why.
  A missing deploy must be visible, never a silent downgrade to the behaviour
  this change exists to remove.

.PARAMETER SkillPath
  Override the skill directory. Defaults to a search of the known locations.

.PARAMETER Revert
  Restore the preserved original `watchdog.ps1` and remove the shim.

.PARAMETER WhatIf
  Report what would change; write nothing.

.NOTES
  Exit codes: 0 installed/already-current, 1 could not install, 2 skill not found.
#>
[CmdletBinding()]
param(
  [string]$SkillPath,
  [switch]$Revert,
  [switch]$WhatIf,
  [switch]$Quiet
)

$ErrorActionPreference = 'Stop'
function Note { param([string]$m, [string]$c = 'Gray') if (-not $Quiet) { Write-Host $m -ForegroundColor $c } }

# --- find the skill ----------------------------------------------------------
# The three known locations resolve to ONE folder on this machine (two are
# junctions). Resolve and de-duplicate rather than writing three times, so a
# future split into real copies is visible instead of silently half-applied.
$candidates = @(
  $SkillPath
  $(if ($env:USERPROFILE) { Join-Path $env:USERPROFILE '.copilot\skills\browser-watchdog' })
  $(if ($env:USERPROFILE) { Join-Path $env:USERPROFILE '.agents\skills\browser-watchdog' })
  $(if ($env:USERPROFILE) { Join-Path $env:USERPROFILE 'OneDrive\skills\browser-watchdog' })
) | Where-Object { $_ }

$targets = New-Object System.Collections.Generic.List[string]
foreach ($c in $candidates) {
  if (-not (Test-Path -LiteralPath $c)) { continue }
  $item = Get-Item -LiteralPath $c -Force
  # ResolveLinkTarget is PS 6+. The hourly job may run under Windows PowerShell
  # 5.1, where .Target on a junction is the string path -- so try both rather
  # than assuming the host.
  $full = $null
  try {
    if ($item.PSObject.Methods.Name -contains 'ResolveLinkTarget') {
      $r = $item.ResolveLinkTarget($true)
      if ($r) { $full = $r.FullName }
    }
  }
  catch { $full = $null }
  if (-not $full -and $item.Target) { $full = @($item.Target)[0] }
  if (-not $full) { $full = (Resolve-Path -LiteralPath $c).Path }
  if (-not $targets.Contains($full)) { [void]$targets.Add($full) }
}

if ($targets.Count -eq 0) {
  Note 'install-browser-watchdog-skill: browser-watchdog skill folder not found.' 'Red'
  exit 2
}

$SHIM_MARK = '# REPO-HOSTED-WATCHDOG-SHIM v1 (GH #197)'

$shim = @"
$SHIM_MARK
<#
  watchdog.ps1 - SHIM. The real supervisor is repo-hosted and deployed.

  This file used to contain the health check itself, and that check was a 1s TCP
  connect: if the port accepted, the slot was declared 'already-up' and left
  alone. Measured 2026-09-01, this script printed "All 3 automation slots are up"
  and exited 0 while all three slots were in the frozen lifecycle state and
  every Playwright operation against them timed out.

  The logic now lives in browser-watchdog.ps1 in the focus-planner repo, where it
  is covered by mutcheck-browser-watchdog.ps1 and deployed by sync-oa-home.ps1.
  Re-install this shim with install-browser-watchdog-skill.ps1.
#>
[CmdletBinding()]
param(
  [switch]`$WhatIf,
  [switch]`$Quiet,
  [switch]`$Json,
  [Parameter(ValueFromRemainingArguments = `$true)] `$Rest
)

`$ErrorActionPreference = 'Stop'

`$candidates = @(@(
  `$(if (`$env:LOCALAPPDATA) { Join-Path `$env:LOCALAPPDATA 'overnight-agent\browser-watchdog.ps1' })
  `$(if (`$env:USERPROFILE) { Join-Path `$env:USERPROFILE '.copilot\installed-plugins\focus-planner\overnight-agent\checks\browser-watchdog.ps1' })
) | Where-Object { `$_ -and (Test-Path -LiteralPath `$_ -PathType Leaf) })

`$forward = @()
if (`$WhatIf) { `$forward += '-ReportOnly' }
if (`$Quiet)  { `$forward += '-Quiet' }
if (`$Json)   { `$forward += '-Json' }
if (`$Rest)   { `$forward += `$Rest }

if (`$candidates.Count -gt 0) {
  & `$candidates[0] @forward
  exit `$LASTEXITCODE
}

# The deploy has not reached this machine. Keep the DOWN branch working, but say
# loudly that the health check is NOT running -- a silent downgrade to the old
# behaviour is the thing this change exists to prevent.
Write-Host 'browser-watchdog: repo-hosted supervisor NOT FOUND - health checking is DISABLED.' -ForegroundColor Red
Write-Host '  Run: powershell -NoProfile -File "%LOCALAPPDATA%\overnight-agent\sync-oa-home.ps1"' -ForegroundColor Yellow
`$legacy = Join-Path `$PSScriptRoot 'watchdog.legacy.ps1'
if (Test-Path -LiteralPath `$legacy) {
  Write-Host '  Falling back to the legacy TCP-only watchdog so DOWN slots still launch.' -ForegroundColor Yellow
  & `$legacy -WhatIf:`$WhatIf -Quiet:`$Quiet | Out-Host
}
exit 3
"@

$changed = 0
foreach ($dir in $targets) {
  $live   = Join-Path $dir 'watchdog.ps1'
  $legacy = Join-Path $dir 'watchdog.legacy.ps1'

  if ($Revert) {
    if (Test-Path -LiteralPath $legacy) {
      if ($WhatIf) { Note "WOULD revert $live from $legacy" 'Cyan' }
      else { Copy-Item -LiteralPath $legacy -Destination $live -Force; Note "reverted $live" 'Yellow' }
      $changed++
    }
    else { Note "no preserved original beside $live - nothing to revert" 'Yellow' }
    continue
  }

  $current = if (Test-Path -LiteralPath $live) { Get-Content -LiteralPath $live -Raw } else { '' }
  # Compare the FULL text, not just the marker. Marker-only matching means a
  # corrected shim silently never lands on a machine that has an older one --
  # the same "already deployed, actually stale" trap this whole change is about.
  if ($current -eq $shim) { Note "already current: $live" 'DarkGray'; continue }

  # Preserve the original ONCE. Re-running must never overwrite the real
  # original with a shim, which would make -Revert restore the wrong thing.
  if ($current -and -not (Test-Path -LiteralPath $legacy)) {
    if ($WhatIf) { Note "WOULD preserve original -> $legacy" 'Cyan' }
    else { Copy-Item -LiteralPath $live -Destination $legacy -Force; Note "preserved original -> $legacy" 'DarkGray' }
  }

  if ($WhatIf) { Note "WOULD install shim -> $live" 'Cyan' }
  else {
    [IO.File]::WriteAllText($live, $shim, (New-Object Text.UTF8Encoding($false)))
    Note "installed shim -> $live" 'Green'
  }
  $changed++
}

Note ''
Note ("browser-watchdog skill: {0} location(s), {1} changed." -f $targets.Count, $changed) 'Green'
exit 0
