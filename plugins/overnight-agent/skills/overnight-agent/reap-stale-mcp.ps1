<#
.SYNOPSIS
  Reap stale MCP stdio server processes left behind by finished Copilot sessions.

.DESCRIPTION
  Every scheduled Copilot run (the Overnight Agent workflow fires every 30 minutes) starts a
  fresh set of stdio MCP servers -- one node process per `npx`-launched server, plus the
  `npx-cli.js` launcher that wraps it. When the session ends those child processes are not
  always reaped, so they accumulate: roughly six per run, each holding ~75-150 MB.

  Left alone this is not cosmetic. Observed on 2026-08-22: 82 orphaned node processes were
  holding ~7 GB, the box was down to 3.2 GB free, and the email MCP died with
  "FATAL ERROR: Zone Allocation failed - process out of memory" during PHASE 0. The agent's
  inbox check silently failed, which means emailed instructions can be dropped without anyone
  noticing. Reaping first makes PHASE 0 reliable again.

  Not every MCP server is a node process. The servers launched through `uvx` (better-telegram-mcp,
  workspace-mcp) run as `uv.exe` plus two `python.exe` children, and they leak on exactly the same
  per-run cadence -- 6 processes a run, ~250 MB. Measured on 2026-08-22: nine intact generations
  (ages 5/35/62/96/125/155/185/214/245 min) were still resident, 48 processes holding ~2.9 GB, none
  of which a node-only scan can see. So the scan is over -ProcessNames, not one hardcoded name.

  Safety model -- this only ever kills a process that satisfies ALL of:
    1. Its image name is in -ProcessNames (node.exe / uv.exe / python.exe by default).
    2. Its command line matches a known MCP server pattern (-Patterns).
    3. It has been running longer than -MinAgeMinutes (default 45).
    4. It is not in the current tool-shell's own ancestor/descendant tree. The upward walk stops at
       the session host (copilot.exe / github.exe) -- see Get-ProtectedPidSet. It must not climb
       past it: one copilot.exe hosts many successive runs, so protecting its whole descendant tree
       would protect every run's servers and make this script a permanent no-op.

  The age gate is the important one, and it must be sized against *when this script runs*, not
  against the schedule interval.

  The original default of 45 minutes was chosen to be longer than the 30-minute schedule so that
  neither the current run's servers nor "those of the run immediately before it" were candidates.
  Sparing the previous run was a mistake: that run has already finished, so its servers are exactly
  the garbage this script exists to collect. Holding them for an extra full cycle is the leak.

  Measured on 2026-08-22 at a 30-minute cadence (task #349). Three intact generations were resident,
  18 processes / ~1.4 GB each:

      age  6 min : 18 procs, 1435 MB   <- current run
      age  7 min : 18 procs, 1449 MB   <- current run
      age 37 min : 18 procs, 1411 MB   <- previous run, already finished, spared by the 45 gate

  Under the 45-minute gate the 37-minute generation survived the whole run and was only collected by
  the *next* one, so the steady state carried a permanent extra generation -- ~1.4 GB of a 16 GB box
  wasted around the clock, on top of the ~4.4 GB held by the always-on CDP browser profiles. That is
  the "performance degradation" reported at the 30-minute cadence.

  The correct anchor is this script's own position in the run. SKILL.md mandates that it runs FIRST,
  before PHASE 0, at which point the current run's MCP servers are 0-2 minutes old. A 20-minute gate
  therefore leaves a ~10x safety margin over the thing it must protect, while still collecting the
  previous run's orphans. Verified the same day with -DryRun -MinAgeMinutes 20: stale 18, freed
  1410 MB -- exactly the 37-minute generation, with the 6/7-minute current-run processes untouched.

.PARAMETER MinAgeMinutes
  Minimum process age, in minutes, before a matching process is considered stale. Default 20.

  This is the only thing protecting the *currently executing* run's own MCP servers: they are
  siblings of this script (both hang off the same copilot.exe), not descendants of it, so the
  ancestor/descendant pass cannot single them out.

  Size it against how old the current run's servers are when this script executes -- which, when the
  script is run first as intended, is 0-2 minutes -- NOT against the schedule interval. Do not raise
  it above the interval "to be safe": that is what caused the leak documented above. Passing a very
  low value (e.g. -MinAgeMinutes 1) will reap the live run's servers; if you ever invoke this script
  mid-run rather than at the start, raise it to comfortably exceed the elapsed run time instead.

.PARAMETER ProcessNames
  Image names to scan. Defaults to node.exe (npx-launched servers) plus uv.exe / python.exe
  (uvx-launched servers). A name alone never justifies a kill -- the command line must still match
  -Patterns -- so this list only widens what is *eligible* to be pattern-matched.

.PARAMETER Patterns
  Regex fragments matched against each candidate process's command line. Defaults cover the MCP
  servers this project launches via npx and uvx. The uvx servers are matched on the same names,
  because uv puts the entry point in the child's own command line, e.g.
  `...\python.exe "...\Scripts\better-telegram-mcp.exe"`.

.PARAMETER DryRun
  Report what would be killed without killing anything.

.OUTPUTS
  A single JSON line: { scanned, matched, stale, killed, failed, freedMB, dryRun, details }

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File reap-stale-mcp.ps1 -DryRun

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File reap-stale-mcp.ps1
#>
[CmdletBinding()]
param(
    [int] $MinAgeMinutes = 20,
    [string[]] $ProcessNames = @('node.exe', 'uv.exe', 'python.exe'),
    [string[]] $Patterns = @(
        '@playwright[\\/]mcp',
        '@marlinjai[\\/]email-mcp',
        'better-telegram-mcp',
        'workspace-mcp'
    ),
    # A candidate whose owning session process is STILL ALIVE is never reaped, at any age.
    # These are the process names that count as "a session that owns MCP servers". GH #178.
    [string[]] $OwnerNames = @('copilot.exe'),
    # Escape hatch: fall back to the old age-only behaviour. Exists so the ownership veto can
    # be switched off in one flag if it ever mis-protects, rather than by editing the script
    # under pressure. It is NOT the default, because age-only is the defect.
    [switch] $IgnoreOwnership,
    [switch] $DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function ConvertTo-ProcessStartTime {
    # Win32_Process.CreationDate comes back as a real DateTime from Get-CimInstance but as a DMTF
    # string ("20260822033051.000000-420") from the older Get-WmiObject / raw WMI paths. Handle
    # both, and return $null when the value cannot be interpreted -- callers treat an unknown age
    # as "not a candidate", so a parse failure can never cause a kill.
    param($Value)

    if ($null -eq $Value) { return $null }
    if ($Value -is [datetime]) { return $Value }

    $text = [string]$Value
    if ([string]::IsNullOrWhiteSpace($text)) { return $null }

    try { return [Management.ManagementDateTimeConverter]::ToDateTime($text) } catch { }

    $parsed = [datetime]::MinValue
    if ([datetime]::TryParse($text, [ref]$parsed)) { return $parsed }

    return $null
}

function Get-ProtectedPidSet {
    # Everything in this process's ancestor chain, plus their descendants. Killing any of these
    # would take down the run that is currently executing, so they are always off limits.
    $procs = @{}
    $names = @{}
    Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name | ForEach-Object {
        $procs[[int]$_.ProcessId] = [int]$_.ParentProcessId
        $names[[int]$_.ProcessId] = [string]$_.Name
    }

    $protected = [System.Collections.Generic.HashSet[int]]::new()

    # Walk up from ourselves, stopping at OS/service boundaries. Without this stop-list the walk
    # can reach services.exe or the System process on some hosts; the descendant pass below would
    # then mark literally every process on the box as protected and the reaper would be a no-op.
    #
    # copilot.exe / github.exe are the *session host* boundary and are the important entries here.
    # A single long-lived copilot.exe hosts many successive agent runs, and every run's MCP servers
    # are spawned as its descendants (copilot.exe -> cmd.exe -> npx node -> cmd.exe -> node MCP).
    # Measured on 2026-08-22: the 03:30 run's 8 servers and the 04:03 run's servers shared one
    # copilot.exe (PID 12940), which itself hangs off a single github.exe shared by *every* Copilot
    # session on the box. Climbing above copilot.exe therefore marks all 20 matched MCP processes
    # protected, so `matched: 20` collapsed to `stale: 0` at every age gate -- the reaper could
    # never fire. Stopping here leaves only the current tool-shell subtree protected; the current
    # run's own servers stay safe via -MinAgeMinutes, which is what that gate is for.
    $stopAt = @('services.exe', 'wininit.exe', 'winlogon.exe', 'svchost.exe', 'system', 'smss.exe', 'csrss.exe', 'explorer.exe', 'copilot.exe', 'github.exe')

    $ancestors = [System.Collections.Generic.HashSet[int]]::new()
    $cursor = $PID
    $guard = 0
    while ($cursor -and $procs.ContainsKey($cursor) -and $guard -lt 64) {
        $name = if ($names.ContainsKey($cursor)) { $names[$cursor] } else { '' }
        if ($guard -gt 0 -and $stopAt -contains $name.ToLowerInvariant()) { break }
        [void]$ancestors.Add($cursor)
        [void]$protected.Add($cursor)
        $cursor = $procs[$cursor]
        $guard++
    }

    # Walk down from every ancestor to cover sibling MCP servers of this run.
    $childrenOf = @{}
    foreach ($kv in $procs.GetEnumerator()) {
        $parent = $kv.Value
        if (-not $childrenOf.ContainsKey($parent)) { $childrenOf[$parent] = New-Object System.Collections.ArrayList }
        [void]$childrenOf[$parent].Add($kv.Key)
    }

    $queue = New-Object System.Collections.Queue
    foreach ($a in $ancestors) { $queue.Enqueue($a) }
    $visited = [System.Collections.Generic.HashSet[int]]::new()
    while ($queue.Count -gt 0) {
        $cur = $queue.Dequeue()
        if (-not $visited.Add($cur)) { continue }
        [void]$protected.Add($cur)
        if ($childrenOf.ContainsKey($cur)) {
            foreach ($c in $childrenOf[$cur]) { $queue.Enqueue($c) }
        }
    }

    return $protected
}

function Get-ProcessTable {
    # One WMI pass, reused by both the protected-set walk and the ownership check, so the two
    # can never disagree about what was running at this instant.
    $table = @{}
    Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name, CreationDate |
        ForEach-Object {
            $table[[int]$_.ProcessId] = [pscustomobject]@{
                Pid     = [int]$_.ProcessId
                Parent  = [int]$_.ParentProcessId
                Name    = [string]$_.Name
                Started = ConvertTo-ProcessStartTime $_.CreationDate
            }
        }
    return $table
}

function Test-HasLiveOwner {
    <#
      Is this MCP server still owned by a session that is RUNNING?

      WHY THIS EXISTS (GH #178)
        The reaper's only protection used to be an age gate, and the protected set covered just
        THIS process's ancestors and descendants. A *sibling* Copilot session's servers are in
        neither -- so once they aged past the cutoff they were killed while that session was
        still working. The Overnight Agent is scheduled every 30 minutes and a run regularly
        takes longer than that, so runs overlap by design and this fired routinely. The symptom
        is invisible: a slot dying mid-run leaves no trace in the logs, so it was never pinned
        on the reaper.

      WHY OWNERSHIP IS KNOWABLE
        It was previously assumed that "all runs share one copilot.exe", which would make an
        owner check equivalent to protecting everything. That is false, and measuring it is what
        unblocked this: each session has its OWN copilot.exe, and its MCP servers are children
        of it. Two live sessions on this box at the time of writing:
            copilot.exe 12708 (21:42) -> 4 MCP children
            copilot.exe  6236 (19:54) -> 3 MCP children
        So "orphan" has an exact meaning: no live owner remains in the ancestor chain.

      PID REUSE IS HANDLED, AND IT MATTERS
        Windows does not re-parent orphans -- a dead parent's PID stays recorded on the child and
        may later be handed to an unrelated process. Trusting the PID alone would therefore let a
        recycled PID resurrect a dead owner and protect a genuine orphan forever. A parent only
        counts if it started NO LATER than its child; otherwise the real parent is gone and the
        chain is treated as orphaned.
    #>
    param(
        [hashtable] $Table,
        [int] $StartPid,
        [datetime] $ChildStarted,
        [string[]] $OwnerNames
    )

    $ownerSet = [System.Collections.Generic.HashSet[string]]::new(
        [string[]]($OwnerNames | ForEach-Object { $_.ToLowerInvariant() })
    )

    $seen    = [System.Collections.Generic.HashSet[int]]::new()
    $cur     = $StartPid
    $childAt = $ChildStarted
    $guard   = 0

    while ($cur -gt 0 -and $guard -lt 64) {
        $guard++
        if (-not $seen.Add($cur)) { break }          # cycle -> stop
        if (-not $Table.ContainsKey($cur)) { return $false }   # parent gone -> orphan

        $node = $Table[$cur]

        # PID reuse: a "parent" that started after its child is not the real parent.
        if ($node.Started -and $childAt -and $node.Started -gt $childAt) { return $false }

        if ($ownerSet.Contains($node.Name.ToLowerInvariant())) { return $true }  # live owner

        if ($node.Parent -le 0 -or $node.Parent -eq $cur) { break }
        $childAt = $node.Started
        $cur     = $node.Parent
    }

    return $false
}

$cutoff    = (Get-Date).AddMinutes(-$MinAgeMinutes)
$protected = Get-ProtectedPidSet
$procTable = Get-ProcessTable
$combined  = ($Patterns -join '|')

$nameFilter = ($ProcessNames | ForEach-Object { "Name='$($_ -replace "'", "''")'" }) -join ' OR '
$candidates = @(Get-CimInstance Win32_Process -Filter $nameFilter -ErrorAction SilentlyContinue)

$scanned = $candidates.Count
$matched = 0
$stale   = 0
$killed  = 0
$failed  = 0
$ownedLive = 0
$freedKB = 0
$details = New-Object System.Collections.ArrayList

foreach ($p in $candidates) {
    $cmd = $p.CommandLine
    if ([string]::IsNullOrWhiteSpace($cmd)) { continue }
    if ($cmd -notmatch $combined) { continue }
    $matched++

    $procId = [int]$p.ProcessId
    if ($protected.Contains($procId)) { continue }

    $started = ConvertTo-ProcessStartTime $p.CreationDate
    if (-not $started) { continue }   # unknown age -> never a candidate
    if ($started -gt $cutoff) { continue }

    # OWNERSHIP VETO (GH #178). Age says "old"; it does not say "abandoned". A sibling run that
    # has been working for 40 minutes has 40-minute-old servers and needs every one of them.
    # Only reap when no live owning session remains. This can only ever PREVENT a kill, never
    # cause one, which is the property that makes it safe to ship to an unattended job.
    if (-not $IgnoreOwnership) {
        if (Test-HasLiveOwner -Table $procTable -StartPid $procId -ChildStarted $started -OwnerNames $OwnerNames) {
            $ownedLive++
            [void]$details.Add([ordered]@{
                pid    = $procId
                ageMin = [math]::Round(((Get-Date) - $started).TotalMinutes)
                mb     = [math]::Round(($p.WorkingSetSize / 1KB) / 1KB)
                action = 'spared-live-owner'
            })
            continue
        }
    }

    $stale++

    $ageMin = [math]::Round(((Get-Date) - $started).TotalMinutes)
    $wsKB   = [int]($p.WorkingSetSize / 1KB)

    if ($DryRun) {
        $killed++
        $freedKB += $wsKB
        [void]$details.Add([ordered]@{ pid = $procId; ageMin = $ageMin; mb = [math]::Round($wsKB / 1KB); action = 'would-kill' })
        continue
    }

    try {
        Stop-Process -Id $procId -Force -ErrorAction Stop
        $killed++
        $freedKB += $wsKB
        [void]$details.Add([ordered]@{ pid = $procId; ageMin = $ageMin; mb = [math]::Round($wsKB / 1KB); action = 'killed' })
    }
    catch {
        $failed++
        [void]$details.Add([ordered]@{ pid = $procId; ageMin = $ageMin; mb = [math]::Round($wsKB / 1KB); action = 'failed'; error = $_.Exception.Message })
    }
}

[ordered]@{
    scanned = $scanned
    matched = $matched
    stale   = $stale
    killed  = $killed
    failed  = $failed
    # How many aged-out servers were spared because their session is still running. A non-zero
    # value here is a kill the old age-only reaper would have made -- i.e. a live run whose
    # tools it would have taken away mid-task. Reported so the saving is observable rather
    # than asserted. GH #178.
    sparedLiveOwner = $ownedLive
    freedMB = [math]::Round($freedKB / 1KB)
    dryRun  = [bool]$DryRun
    minAgeMinutes = $MinAgeMinutes
    ownershipVeto = (-not [bool]$IgnoreOwnership)
    details = $details
} | ConvertTo-Json -Depth 4 -Compress
