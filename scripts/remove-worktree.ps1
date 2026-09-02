<#
  remove-worktree.ps1 -- the safe replacement for `git worktree remove --force`.

  `git worktree remove --force` deletes THROUGH a directory junction (GH #321), so
  removing a worktree that junctions the main checkout's node_modules empties that
  shared install for the main checkout and every other worktree at once -- and
  exits 0 while doing it.

  This wrapper unlinks first, refuses to run git if any link survives, and
  re-measures every junction target afterwards. Use it instead of the raw command:

      pwsh -NoProfile -File scripts/remove-worktree.ps1 -Path <worktree> -DryRun
      pwsh -NoProfile -File scripts/remove-worktree.ps1 -Path <worktree>

  EXIT: 0 removed with nothing shared damaged. 1 refused, failed, or damage found.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory, Position = 0)][string]$Path,
    [switch]$DryRun,
    [int]$MaxDepth = 4
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'worktree-safety.ps1')

$result = Remove-WorktreeSafely -WorktreePath $Path -DryRun:$DryRun -MaxDepth $MaxDepth

foreach ($m in $result.Messages) { Write-Host "  $m" -ForegroundColor DarkGray }

if ($result.Links.Count -eq 0) {
    Write-Host 'no directory links found in this worktree' -ForegroundColor DarkGray
}
foreach ($t in $result.Targets) {
    $after = if ($null -eq $t.After) { '(not measured)' } else { "$($t.After)($($t.AfterCount))" }
    Write-Host ("  {0} -> {1}  before={2}({3}) after={4}" -f $t.Link, $t.Target, $t.Before, $t.BeforeCount, $after)
}

if ($result.DryRun) {
    Write-Host 'DRY RUN: nothing was unlinked and git was not invoked.' -ForegroundColor Yellow
    exit 0
}

if ($result.Ok) {
    Write-Host 'worktree removed; every junction target still intact.' -ForegroundColor Green
    exit 0
}

Write-Host 'REFUSED or DAMAGED -- see messages above.' -ForegroundColor Red
exit 1
