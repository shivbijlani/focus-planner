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

  The age gate is the important one. The default of 45 minutes is deliberately longer than the
  30-minute schedule interval, so servers belonging to the run that is executing this script are
  never candidates, and neither are those of the run immediately before it.

.PARAMETER MinAgeMinutes
  Minimum process age, in minutes, before a matching process is considered stale. Default 45.

  This is the only thing protecting the *currently executing* run's own MCP servers: they are
  siblings of this script (both hang off the same copilot.exe), not descendants of it, so the
  ancestor/descendant pass cannot single them out. Keep this comfortably above the schedule
  interval. Passing a value below it (e.g. -MinAgeMinutes 1) will reap the live run's servers.

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
    [int] $MinAgeMinutes = 45,
    [string[]] $ProcessNames = @('node.exe', 'uv.exe', 'python.exe'),
    [string[]] $Patterns = @(
        '@playwright[\\/]mcp',
        '@marlinjai[\\/]email-mcp',
        'better-telegram-mcp',
        'workspace-mcp'
    ),
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

$cutoff    = (Get-Date).AddMinutes(-$MinAgeMinutes)
$protected = Get-ProtectedPidSet
$combined  = ($Patterns -join '|')

$nameFilter = ($ProcessNames | ForEach-Object { "Name='$($_ -replace "'", "''")'" }) -join ' OR '
$candidates = @(Get-CimInstance Win32_Process -Filter $nameFilter -ErrorAction SilentlyContinue)

$scanned = $candidates.Count
$matched = 0
$stale   = 0
$killed  = 0
$failed  = 0
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
    freedMB = [math]::Round($freedKB / 1KB)
    dryRun  = [bool]$DryRun
    minAgeMinutes = $MinAgeMinutes
    details = $details
} | ConvertTo-Json -Depth 4 -Compress
