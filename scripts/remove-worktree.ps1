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

# Tell the session store that this workspace is gone (GH #452).
#
# Two lifecycles that must agree were uncoupled: this script removes the workspace and knew
# nothing about bindings, so a torn-down worktree left its task reporting `verdict: reuse,
# state: live` at a path with no repository in it, and the next run was directed to resume there.
#
# #460 made the verdict verify its own workspace, which catches the case where the directory
# SURVIVES the teardown -- #466's did, because a live session's cwd blocked the final delete,
# leaving an empty directory. Measured 2026-09-04 against a real worktree, a CLEAN teardown leaves
# no directory at all, and the verdict cannot judge that: an absent path is equally a workspace
# that was never materialised, and treating absence as death would discard live young sessions.
#
# So the fact has to come from the side that holds it. This script knows the workspace is gone
# because it just removed it.
#
# It marks the binding DEAD rather than releasing it: `dead` yields `replace`, which carries the
# continuation telling the next session it is resuming work. Releasing would leave the task
# unbound and the verdict `create` -- a cold start that discards exactly the continuity the
# binding exists to provide.
#
# BEST EFFORT, ALWAYS. The worktree is already gone by this point; a state store that is missing,
# locked or on another machine must never turn a successful removal into a failure. It reports
# what it could not do instead of throwing.
function Release-SessionBinding {
    param([string]$RemovedPath)
    $oa = @(
        (Join-Path $env:LOCALAPPDATA 'overnight-agent\oa-state.ps1'),
        "$env:USERPROFILE\.copilot\installed-plugins\focus-planner\overnight-agent\skills\overnight-agent\oa-state.ps1",
        (Join-Path $PSScriptRoot '..\plugins\overnight-agent\skills\overnight-agent\oa-state.ps1')
    ) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1

    if (-not $oa) {
        Write-Host '  no oa-state.ps1 found; session binding NOT released (harmless unless this worktree was bound)' -ForegroundColor DarkGray
        return
    }
    try {
        $out = & pwsh -NoProfile -ExecutionPolicy Bypass -File $oa session -WorkspaceGone $RemovedPath 2>&1
        $json = ($out | Out-String | ConvertFrom-Json)
        if ([int]$json.marked_dead -gt 0) {
            Write-Host ("  session binding released for task(s) {0}; next verdict is 'replace', not 'reuse'" -f ($json.tasks -join ', ')) -ForegroundColor Green
        } else {
            Write-Host '  no task was bound to this workspace' -ForegroundColor DarkGray
        }
    } catch {
        Write-Host "  could not release the session binding ($($_.Exception.Message)); run: oa-state.ps1 session -WorkspaceGone `"$RemovedPath`"" -ForegroundColor Yellow
    }
}

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
    Release-SessionBinding -RemovedPath $Path
    exit 0
}

Write-Host 'REFUSED or DAMAGED -- see messages above.' -ForegroundColor Red
exit 1
