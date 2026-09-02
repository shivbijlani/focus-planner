<#
  worktree-safety.ps1 -- make `git worktree remove` safe on Windows, where a
  worktree may contain a DIRECTORY JUNCTION into shared state.

  WHAT THIS EXISTS TO STOP (GH #321)
  ----------------------------------
  The documented way to keep a throwaway worktree fast was to junction the main
  checkout's node_modules into it:

      cmd /c "mklink /J node_modules V:\repos\<repo>\node_modules"

  `git worktree remove --force` then deletes THROUGH that junction. Measured in an
  isolated sandbox on 2026-09-02 (PowerShell 7.6.5, git for Windows):

      shared node_modules top-level entries: before=4 after=0
      git exit code: 0

  Note the exit code. Removal SUCCEEDS. The shared install is emptied for the main
  checkout and for every other worktree at once, and nothing says so. The damage
  surfaces minutes later, somewhere else, as a missing binary or a partial test run
  -- which reads like a broken change rather than a missing toolchain.

  A MEASURED CORRECTION TO THE ORIGINAL REPORT
  --------------------------------------------
  #321 assumed `Remove-Item -Recurse` carries the same delete-through hazard. It
  does not, on either host present on the box. Same sandbox, same junction shape,
  3 entries in the target each time:

      [IO.Directory]::Delete($p,$false)        linkRemoved=True  targetEntries=3  SAFE
      [IO.Directory]::Delete($p,$true)         linkRemoved=True  targetEntries=3  SAFE
      Remove-Item -Recurse -Force  (pwsh 7.6.5) linkRemoved=True targetEntries=3  SAFE
      Remove-Item -Recurse -Force  (powershell 5.1) linkRemoved=True targetEntries=3 SAFE
      cmd /c rmdir                             linkRemoved=True  targetEntries=3  SAFE

  So the hazard is specific to git's own removal code, not to PowerShell's. That
  matters: "use rmdir instead of Remove-Item" is not the fix, and a guard built on
  that belief would protect nothing. The fix is to UNLINK BEFORE GIT RUNS.

  THE GUARDS (each is pinned by a named arm in scripts/mutcheck-worktree-safety.ps1)
    G1  the unlink pass runs BEFORE `git worktree remove` is invoked
    G2  links are identified by their REPARSE POINT attribute, never by name
    G3  the scan records a link and does NOT descend through it
    G4  if any link survives the unlink pass, git is NOT invoked at all
    G5  every recorded target is re-measured after removal; Populated -> Empty is
        a reported FAILURE, not a silent success
    G6  an existing-but-EMPTY node_modules is distinguished from a missing one
    G7  the main checkout is refused; only a linked worktree can be removed

  Dot-source it; nothing runs at load.

      . ./scripts/worktree-safety.ps1
      Remove-WorktreeSafely -WorktreePath V:\repos\copilot-worktrees\foo\bar
#>

Set-StrictMode -Version Latest

function Get-LinkInfo {
    <#
      .SYNOPSIS
        Describe a path as a link or a real directory.

      .DESCRIPTION
        GUARD G2. Identity comes from the filesystem's ReparsePoint attribute (and,
        as a cross-platform fallback, PowerShell's LinkType), never from the
        directory's NAME. A junction called `.pnpm-store` is exactly as destructive
        as one called `node_modules`, and a name-based check would walk straight
        past it.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    if (-not $item) { return $null }

    $isLink = (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq [IO.FileAttributes]::ReparsePoint)

    $linkType = $null
    if ($item.PSObject.Properties['LinkType']) { $linkType = $item.LinkType }
    if (-not $isLink -and $linkType) { $isLink = $true }

    $target = $null
    if ($isLink -and $item.PSObject.Properties['Target']) {
        $t = $item.Target
        if ($t) { $target = @($t)[0] }
    }

    [pscustomobject]@{
        Path        = $item.FullName
        IsLink      = [bool]$isLink
        IsDirectory = [bool]$item.PSIsContainer
        LinkType    = $linkType
        Target      = $target
    }
}

function Get-NodeModulesState {
    <#
      .SYNOPSIS
        Classify a node_modules directory as Missing, Empty or Populated.

      .DESCRIPTION
        GUARD G6, and the whole of #321's third success criterion. `Test-Path` is
        TRUE for the wreckage this bug leaves behind: the directory still exists,
        it is simply empty. Collapsing Empty into Populated is what let the failure
        travel to another session before anyone saw it.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        return [pscustomobject]@{ Path = $Path; State = 'Missing'; Count = 0 }
    }
    $count = 0
    try { $count = @(Get-ChildItem -LiteralPath $Path -Force -ErrorAction Stop).Count } catch { $count = -1 }
    $state = if ($count -gt 0) { 'Populated' } else { 'Empty' }
    [pscustomobject]@{ Path = $Path; State = $state; Count = $count }
}

function Test-SharedNodeModules {
    <#
      .SYNOPSIS
        Preflight: report an empty-but-present node_modules explicitly.

      .DESCRIPTION
        Turns a silent, delayed, misattributed failure into an immediate one. Ok is
        FALSE only for the Empty state -- the exact wreckage #321 describes. Missing
        is not an error here: `npm ci` has simply not run yet, and npm says so
        clearly on its own.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$RepoPath)

    $nm = Join-Path $RepoPath 'node_modules'
    $s = Get-NodeModulesState -Path $nm
    $ok = ($s.State -ne 'Empty')
    $message = switch ($s.State) {
        'Populated' { "node_modules present with $($s.Count) top-level entries." }
        'Missing'   { "node_modules is absent -- run 'npm ci' in $RepoPath." }
        default     {
            "node_modules EXISTS BUT IS EMPTY at $nm. This is the GH #321 signature: " +
            "something deleted through a junction into this directory. Nothing here is " +
            "broken by your change -- run 'npm ci' in $RepoPath to restore it."
        }
    }
    [pscustomobject]@{ Ok = $ok; State = $s.State; Count = $s.Count; Path = $nm; Message = $message }
}

function Find-WorktreeLinks {
    <#
      .SYNOPSIS
        List every directory link inside a worktree.

      .DESCRIPTION
        GUARD G3. A discovered link is RECORDED AND NOT DESCENDED INTO. Descending
        would enumerate the shared tree on the far side, and -- far worse -- would
        surface links belonging to the shared install as if they were the worktree's
        own, so the unlink pass would start deleting inside shared state. The scan
        that protects the target must not itself reach into it.

        Real `node_modules` directories are not descended either: nothing findable
        is in there and they hold tens of thousands of entries.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$WorktreePath,
        [int]$MaxDepth = 4
    )

    if (-not (Test-Path -LiteralPath $WorktreePath)) { return @() }
    $root = (Resolve-Path -LiteralPath $WorktreePath).Path

    $found = New-Object System.Collections.Generic.List[object]
    $queue = New-Object System.Collections.Generic.Queue[object]
    $queue.Enqueue([pscustomobject]@{ Path = $root; Depth = 0 })

    while ($queue.Count -gt 0) {
        $node = $queue.Dequeue()
        $kids = @()
        try { $kids = @(Get-ChildItem -LiteralPath $node.Path -Directory -Force -ErrorAction Stop) }
        catch { continue }

        foreach ($d in $kids) {
            $info = Get-LinkInfo -Path $d.FullName
            if ($info -and $info.IsLink) {
                [void]$found.Add($info)
                continue
            }
            if ($d.Name -eq '.git' -or $d.Name -eq 'node_modules') { continue }
            if (($node.Depth + 1) -lt $MaxDepth) {
                $queue.Enqueue([pscustomobject]@{ Path = $d.FullName; Depth = $node.Depth + 1 })
            }
        }
    }
    return @($found.ToArray())
}

function Remove-DirectoryLink {
    <#
      .SYNOPSIS
        Unlink a directory link without touching what it points at.

      .DESCRIPTION
        Non-recursive delete removes the reparse point only. Every PowerShell delete
        form measured on this box is equally safe (see the header), but the
        narrowest operation is still the right one: it CANNOT recurse, so it cannot
        become unsafe on a host where the others might.

        Refuses a real directory outright. This function is the one thing in the
        file allowed to delete, so it must be impossible to aim at real content.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Path)

    $info = Get-LinkInfo -Path $Path
    if (-not $info) { return $false }
    if (-not $info.IsLink) {
        throw "Refusing to unlink '$Path': it is a real directory, not a link."
    }
    [IO.Directory]::Delete($info.Path, $false)
    return (-not (Test-Path -LiteralPath $info.Path))
}

function Test-LinkedWorktree {
    <#
      .SYNOPSIS
        Is this path a LINKED worktree (as opposed to the main checkout)?

      .DESCRIPTION
        GUARD G7. In the main checkout `--absolute-git-dir` and `--git-common-dir`
        resolve to the same directory; in a linked worktree the former is
        `<common>/worktrees/<name>`. Comparing them is the canonical test, and it is
        what stops this helper being aimed at the very checkout whose node_modules
        everything else is sharing.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        return [pscustomobject]@{ IsWorktree = $false; IsLinked = $false; Reason = "path does not exist: $Path" }
    }
    $gitDir = (& git -C $Path rev-parse --absolute-git-dir 2>$null)
    if ($LASTEXITCODE -ne 0 -or -not $gitDir) {
        return [pscustomobject]@{ IsWorktree = $false; IsLinked = $false; Reason = "not a git working tree: $Path" }
    }
    $commonDir = (& git -C $Path rev-parse --path-format=absolute --git-common-dir 2>$null)
    if ($LASTEXITCODE -ne 0 -or -not $commonDir) {
        return [pscustomobject]@{ IsWorktree = $true; IsLinked = $false; Reason = 'could not resolve --git-common-dir' }
    }
    $norm = { param($p) ($p -replace '/', [IO.Path]::DirectorySeparatorChar).TrimEnd([IO.Path]::DirectorySeparatorChar) }
    $a = (& $norm $gitDir); $b = (& $norm $commonDir)
    $linked = -not ($a -ieq $b)
    [pscustomobject]@{
        IsWorktree = $true
        IsLinked   = $linked
        GitDir     = $a
        CommonDir  = $b
        Reason     = $(if ($linked) { 'linked worktree' } else { 'this is the MAIN checkout, not a linked worktree' })
    }
}

function Get-MainCheckoutRoot {
    <#
      .SYNOPSIS
        Working-tree root of the main checkout, given a --git-common-dir.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$CommonDir)

    if (-not $CommonDir) { return $null }
    $c = ($CommonDir -replace '/', [IO.Path]::DirectorySeparatorChar).TrimEnd([IO.Path]::DirectorySeparatorChar)
    if ((Split-Path -Leaf $c) -eq '.git') { $c = Split-Path -Parent $c }
    if ($c -and (Test-Path -LiteralPath $c)) { return $c }
    return $null
}

function Remove-WorktreeSafely {
    <#
      .SYNOPSIS
        Unlink first, then `git worktree remove --force`, then prove nothing shared
        was emptied.

      .OUTPUTS
        An object with Ok, Links, Targets, Removed and Messages. Ok is FALSE if any
        recorded target went from Populated to Empty -- the failure #321 says is
        currently silent.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$WorktreePath,
        [switch]$DryRun,
        [int]$MaxDepth = 4
    )

    $messages = New-Object System.Collections.Generic.List[string]
    function Note($m) { [void]$messages.Add($m); Write-Verbose $m }

    if (-not (Test-Path -LiteralPath $WorktreePath)) {
        return [pscustomobject]@{
            Ok = $false; Links = @(); Targets = @(); Removed = $false; DryRun = [bool]$DryRun
            Messages = @("worktree path does not exist: $WorktreePath")
        }
    }
    $wt = (Resolve-Path -LiteralPath $WorktreePath).Path

    # ---- GUARD G7 ---------------------------------------------------------
    $kind = Test-LinkedWorktree -Path $wt
    if (-not $kind.IsWorktree -or -not $kind.IsLinked) {
        return [pscustomobject]@{
            Ok = $false; Links = @(); Targets = @(); Removed = $false; DryRun = [bool]$DryRun
            Messages = @("refusing to remove '$wt': $($kind.Reason)")
        }
    }

    # ---- discover, and snapshot each target BEFORE anything is touched ----
    $links = @(Find-WorktreeLinks -WorktreePath $wt -MaxDepth $MaxDepth)
    Note ("found {0} directory link(s) in {1}" -f $links.Count, $wt)

    $targets = New-Object System.Collections.Generic.List[object]
    foreach ($l in $links) {
        $before = if ($l.Target) { Get-NodeModulesState -Path $l.Target } else { $null }
        [void]$targets.Add([pscustomobject]@{
            Link = $l.Path; Target = $l.Target; LinkType = $l.LinkType
            Before = $(if ($before) { $before.State } else { 'Unknown' })
            BeforeCount = $(if ($before) { $before.Count } else { -1 })
            After = $null; AfterCount = -1
        })
        Note ("  link {0} -> {1} [{2}]" -f $l.Path, $l.Target, $l.LinkType)
    }

    if ($DryRun) {
        Note 'dry run: nothing unlinked, git not invoked'
        return [pscustomobject]@{
            Ok = $true; Links = $links; Targets = @($targets.ToArray()); Removed = $false
            DryRun = $true; Messages = @($messages.ToArray())
        }
    }

    # ---- GUARD G1: unlink BEFORE git ever sees the worktree ---------------
    # Deepest path first. Unlinking an outer link before an inner one orphans the
    # inner path -- it stops resolving, so it is silently skipped and survives into
    # the git call. Ordering is not cosmetic here; it decides whether the unlink
    # pass is complete, and G4 below is what notices when it is not.
    $ordered = @($links | Sort-Object -Property @{ Expression = { $_.Path.Length } } -Descending)
    foreach ($l in $ordered) {
        try {
            [void](Remove-DirectoryLink -Path $l.Path)
            Note ("unlinked {0}" -f $l.Path)
        }
        catch { Note ("FAILED to unlink {0}: {1}" -f $l.Path, $_.Exception.Message) }
    }

    # ---- GUARD G4: a surviving link means git must NOT run ----------------
    $stillLinked = @(Find-WorktreeLinks -WorktreePath $wt -MaxDepth $MaxDepth)
    if ($stillLinked.Count -gt 0) {
        Note ("ABORTING: {0} link(s) still present after the unlink pass; git worktree remove was NOT invoked" -f $stillLinked.Count)
        foreach ($s in $stillLinked) { Note ("  still linked: {0}" -f $s.Path) }
        return [pscustomobject]@{
            Ok = $false; Links = $links; Targets = @($targets.ToArray()); Removed = $false
            DryRun = $false; Messages = @($messages.ToArray())
        }
    }

    # ---- now the destructive command is safe to run -----------------------
    # Run from the MAIN checkout, never from inside the worktree being removed.
    # Measured 2026-09-02: `git -C <wt> worktree remove --force <wt>` exits 255
    # with "failed to delete ...: Permission denied" -- git cannot delete the
    # directory it is running in -- yet it has ALREADY deregistered the worktree,
    # so the caller is left with an orphaned directory and a failure code. From the
    # main root the same command exits 0 and the directory is gone.
    $runFrom = Get-MainCheckoutRoot -CommonDir $kind.CommonDir
    if (-not $runFrom) { $runFrom = Split-Path -Parent $wt }
    $gitOut = (& git -C $runFrom worktree remove --force $wt 2>&1) -join "`n"
    $gitOk = ($LASTEXITCODE -eq 0)
    Note ("git -C {0} worktree remove --force -> exit {1} {2}" -f $runFrom, $(if ($gitOk) { 0 } else { 'nonzero' }), $gitOut)

    # git deregisters before it deletes, so a leftover directory here is debris
    # from a partial removal, not a live worktree. Every link was unlinked and
    # re-verified above (G1/G4), so there is nothing left to delete through.
    if ($gitOk -and (Test-Path -LiteralPath $wt)) {
        Remove-Item -LiteralPath $wt -Recurse -Force -ErrorAction SilentlyContinue
        Note ("cleared leftover worktree directory: gone={0}" -f (-not (Test-Path -LiteralPath $wt)))
    }

    # ---- GUARD G5: prove no shared target was emptied ---------------------
    $damaged = 0
    foreach ($t in $targets) {
        if (-not $t.Target) { continue }
        $after = Get-NodeModulesState -Path $t.Target
        $t.After = $after.State
        $t.AfterCount = $after.Count
        if ($t.Before -eq 'Populated' -and $after.State -ne 'Populated') {
            $damaged++
            Note ("DAMAGE: junction target '{0}' went {1}({2}) -> {3}({4})" -f $t.Target, $t.Before, $t.BeforeCount, $after.State, $after.Count)
        }
    }

    [pscustomobject]@{
        Ok       = ($gitOk -and $damaged -eq 0)
        Links    = $links
        Targets  = @($targets.ToArray())
        Removed  = $gitOk
        DryRun   = $false
        Damaged  = $damaged
        Messages = @($messages.ToArray())
    }
}
