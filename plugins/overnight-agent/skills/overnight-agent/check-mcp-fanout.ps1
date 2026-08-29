<#
  check-mcp-fanout.ps1 -- measure MCP process fan-out and assert the success criteria of
  the "MCP servers fan out ~6 processes per slot" issue (shivbijlani/focus-planner#177).

  WHY THIS EXISTS
  ---------------
  #177 is well documented -- root cause, measured numbers, ranked fix options, six success
  criteria -- and none of it is *checkable*. Criterion 6 says so explicitly:

      "A regression test or a check script asserts criteria 1 and 3 so this cannot
       silently return."

  Nothing asserted them, so the only evidence the problem exists is a number somebody typed
  into an issue on one day. That is the same shape as every defect this plugin has been
  bitten by: a condition described in prose, detectable only by whoever happens to look.

  It is also the shape of the defect found on 2026-08-27, where two sweeps had been
  reporting a real fault for several runs as an abstract hygiene note ("the script lacks a
  UTF-8 decoder") and nothing moved -- until it was re-expressed as its measured effect
  ("19 false alarms, 6 of your messages dropped"). The lesson recorded from that run was:
  report the measured effect, not the defect. This script exists so #177's effect can be
  measured on demand, by anyone, in one command.

  WHAT IT DOES *NOT* DO
  ---------------------
  It never kills anything. `reap-stale-mcp.ps1` is the tool that kills; this one only
  counts, so it is safe to run at any point in a session -- including while another agent
  is mid-task. It deliberately shares that script's -ProcessNames / -Patterns matching so
  the two can never disagree about what counts as "an MCP process".

  THE TWO CRITERIA IT ASSERTS
  ---------------------------
  C1  A single idle session holds <= 15 MCP-related processes and <= 1.2 GB.
      Baseline recorded in #177: 36 processes / 2,444 MB, seven minutes into one session.

  C3  When a session exits, zero MCP processes attributable to it survive more than 60 s.
      Measured here as: no *orphaned* generation -- a cohort of MCP processes whose owning
      Copilot CLI session is no longer alive -- older than -OrphanGraceSeconds.

  Criterion 3 cannot be observed directly from inside a live session (the exit has not
  happened yet), so the honest proxy is survivorship: if a previous session's servers are
  still running now, that session demonstrably failed to tear them down. That is the same
  evidence the reaper acts on, expressed as a pass/fail rather than as a kill count.

  ATTRIBUTION
  -----------
  Processes are grouped by their nearest *non-MCP* ancestor, which is the session that
  spawned them. This is what makes "36 processes" decomposable into "which session is
  responsible", and it is what turns a raw count into the per-slot fan-out figure (~6 per
  browser slot) that #177's fix option 1 is meant to reduce.

.PARAMETER MaxProcesses
  Criterion 1's process ceiling for the current session. Default 15 (from #177).

.PARAMETER MaxMemoryMB
  Criterion 1's memory ceiling in MB for the current session. Default 1229 (1.2 GB).

.PARAMETER OrphanGraceSeconds
  Criterion 3's grace period. An orphaned generation older than this fails the check.
  Default 60 (from #177).

.PARAMETER ProcessNames
  Image names eligible to be pattern-matched. Kept identical to reap-stale-mcp.ps1 --
  a python/uv-hosted server is invisible to a node-only scan.

.PARAMETER Patterns
  Command-line patterns that identify a known MCP server. Kept identical to
  reap-stale-mcp.ps1 so the counter and the reaper always agree.

.PARAMETER Json
  Emit a single JSON line instead of the human-readable report.

.OUTPUTS
  Human report (default) or one JSON line with:
    { pass, criteria, totals, current, orphans, slots, servers, generations }

  Exit code: 0 = all asserted criteria pass, 2 = at least one fails.
  A failure is a real finding, not an error -- the script itself exits non-zero only for
  that reason, never for an internal fault, so exit 2 is unambiguous.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File check-mcp-fanout.ps1

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File check-mcp-fanout.ps1 -Json
#>
[CmdletBinding()]
param(
    [int] $MaxProcesses = 15,
    [int] $MaxMemoryMB = 1229,
    [int] $OrphanGraceSeconds = 60,
    [string[]] $ProcessNames = @('node.exe', 'uv.exe', 'uvx.exe', 'python.exe', 'better-telegram-mcp.exe'),
    [string[]] $Patterns = @(
        '@playwright[\\/]mcp',
        '@marlinjai[\\/]email-mcp',
        'better-telegram-mcp',
        'workspace-mcp'
    ),
    [switch] $Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function ConvertTo-ProcessStartTime {
    # Win32_Process.CreationDate is a DateTime via Get-CimInstance but a DMTF string
    # ("20260822033051.000000-420") via the older WMI paths. Handle both. Returning $null
    # means "age unknown", and every caller treats unknown age as "cannot fail a criterion",
    # so a parse failure can never manufacture a finding.
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

# ---------------------------------------------------------------------------
# Snapshot every process once. Two passes over one snapshot, so the parent map
# and the MCP set are guaranteed to describe the same instant.
# ---------------------------------------------------------------------------
$all = @{}
foreach ($p in @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name, CommandLine, WorkingSetSize, CreationDate -ErrorAction SilentlyContinue)) {
    $all[[int]$p.ProcessId] = $p
}

$nameSet = @{}
foreach ($n in $ProcessNames) { $nameSet[$n.ToLowerInvariant()] = $true }

function Test-IsMcpProcess {
    param($Proc)

    if ($null -eq $Proc) { return $false }
    $name = [string]$Proc.Name
    if (-not $nameSet.ContainsKey($name.ToLowerInvariant())) { return $false }

    $cmd = [string]$Proc.CommandLine
    if ([string]::IsNullOrWhiteSpace($cmd)) { return $false }

    foreach ($pat in $Patterns) {
        if ($cmd -match $pat) { return $true }
    }
    return $false
}

$mcp = @{}
foreach ($id in $all.Keys) {
    if (Test-IsMcpProcess -Proc $all[$id]) { $mcp[$id] = $all[$id] }
}

# ---------------------------------------------------------------------------
# Attribution: walk up to the nearest ancestor that is NOT part of an MCP server
# tree. That ancestor is the session which spawned the tree, and grouping by it is
# what decomposes a flat "36 processes" into per-session responsibility.
#
# The walk must use a WIDER test than the counting test above. A slot's real chain is
#     node.exe[server] -> cmd.exe[shim] -> copilot.exe[session]
# and cmd.exe is deliberately absent from -ProcessNames, because a shim is not itself
# a server and must not inflate the count. But if the walk stops at that shim, every
# server becomes its own "session", each shim looks like a live owner, and BOTH
# criteria below pass unconditionally -- a checker that cannot fail. So membership of
# the tree is decided on the command line alone, independent of image name.
# ---------------------------------------------------------------------------
function Test-IsMcpTreeMember {
    param($Proc)

    if ($null -eq $Proc) { return $false }
    $cmd = [string]$Proc.CommandLine
    if ([string]::IsNullOrWhiteSpace($cmd)) { return $false }

    foreach ($pat in $Patterns) {
        if ($cmd -match $pat) { return $true }
    }
    return $false
}

function Get-OwningSessionPid {
    # Returns @{ owner; resolved }. resolved = $false means the chain broke on a parent
    # that no longer exists -- the spawning session is gone and this tree is orphaned.
    # Distinguishing that from "found a real owner" is what makes criterion 3 able to fail.
    param([int] $ProcessId)

    $seen = @{}
    $cur = $ProcessId

    while ($true) {
        if ($seen.ContainsKey($cur)) { break }   # cycle guard; PIDs can be recycled
        $seen[$cur] = $true

        $proc = $all[$cur]
        if ($null -eq $proc) { break }

        $parentId = [int]$proc.ParentProcessId
        if ($parentId -le 0) { break }

        if (-not $all.ContainsKey($parentId)) {
            return @{ owner = $cur; resolved = $false }   # parent exited -> orphaned tree
        }

        if (-not (Test-IsMcpTreeMember -Proc $all[$parentId])) {
            return @{ owner = $parentId; resolved = $true }
        }

        $cur = $parentId
    }

    return @{ owner = $cur; resolved = $false }
}

function Get-CurrentSessionPid {
    # This script runs in a shell spawned BY the session, not inside the MCP tree, so the
    # walk above does not apply. Find the nearest copilot.exe ancestor; fall back to the
    # immediate parent when this is run outside a Copilot session (e.g. by hand).
    $seen = @{}
    $cur = $PID
    while ($all.ContainsKey($cur) -and -not $seen.ContainsKey($cur)) {
        $seen[$cur] = $true
        $parentId = [int]$all[$cur].ParentProcessId
        if ($parentId -le 0 -or -not $all.ContainsKey($parentId)) { break }
        if ([string]$all[$parentId].Name -match '^copilot\.exe$') { return $parentId }
        $cur = $parentId
    }
    if ($all.ContainsKey($PID)) { return [int]$all[$PID].ParentProcessId }
    return $PID
}

$now = Get-Date
$myOwner = Get-CurrentSessionPid

$rows = @()
foreach ($id in $mcp.Keys) {
    $p = $mcp[$id]
    $start = ConvertTo-ProcessStartTime -Value $p.CreationDate
    $ageSec = if ($null -eq $start) { $null } else { [int]($now - $start).TotalSeconds }

    $cmd = [string]$p.CommandLine
    $own = Get-OwningSessionPid -ProcessId $id

    # Browser slots are identified by their debug port, which is the unit #177's fix
    # option 1 acts on ("6 processes per slot"). Everything else groups by server name.
    $slot = $null
    if ($cmd -match '--cdp-endpoint\s+\S*?:(\d{2,5})') { $slot = "cdp:$($Matches[1])" }
    elseif ($cmd -match '--port[= ](\d{2,5})')          { $slot = "port:$($Matches[1])" }

    $server = 'other'
    foreach ($pat in $Patterns) {
        if ($cmd -match $pat) { $server = ($pat -replace '\[\\\\/\]', '/' -replace '\\', ''); break }
    }

    $rows += [pscustomobject]@{
        pid      = $id
        name     = [string]$p.Name
        owner    = [int]$own.owner
        resolved = [bool]$own.resolved
        mb       = [int]([double]$p.WorkingSetSize / 1MB)
        ageSec   = $ageSec
        slot     = $slot
        server   = $server
    }
}

# ---------------------------------------------------------------------------
# Generations -- one per owning session.
# ---------------------------------------------------------------------------
$generations = @()
foreach ($g in ($rows | Group-Object owner)) {
    $ownerPid = [int]$g.Name
    # A generation is live only if its owner was actually resolved to a real, still-running
    # non-MCP ancestor. An unresolved walk means the spawning session is gone, even though
    # the pid it reports (the tree's own top process) is trivially still alive.
    $resolved = [bool](@($g.Group | Where-Object { $_.resolved }).Count -gt 0)
    $ownerAlive = $resolved -and $all.ContainsKey($ownerPid)

    $mb = 0
    foreach ($r in $g.Group) { $mb += $r.mb }

    $ages = @($g.Group | Where-Object { $null -ne $_.ageSec } | ForEach-Object { $_.ageSec })
    $oldest = if ($ages.Count -gt 0) { ($ages | Measure-Object -Maximum).Maximum } else { $null }

    $generations += [pscustomobject]@{
        owner       = $ownerPid
        ownerName   = if ($ownerAlive) { [string]$all[$ownerPid].Name } else { '(gone)' }
        ownerAlive  = $ownerAlive
        isCurrent   = ($ownerPid -eq $myOwner)
        processes   = $g.Group.Count
        mb          = $mb
        oldestSec   = $oldest
    }
}

# ---------------------------------------------------------------------------
# Criterion 1 -- "a single idle session holds <= 15 procs and <= 1.2 GB".
# Asserted against the LARGEST live session, not this one. Running the check from a
# tool-spawned shell can leave the current session holding zero servers, and asserting
# on that would pass vacuously -- the exact failure this script exists to prevent.
# ---------------------------------------------------------------------------
$live = @($generations | Where-Object { $_.ownerAlive })
$worst = $live | Sort-Object -Property processes -Descending | Select-Object -First 1

$myGen = $generations | Where-Object { $_.isCurrent } | Select-Object -First 1
$myCount = if ($myGen) { $myGen.processes } else { 0 }
$myMB = if ($myGen) { $myGen.mb } else { 0 }

$worstCount = if ($worst) { $worst.processes } else { 0 }
$worstMB = if ($worst) { $worst.mb } else { 0 }

$c1Pass = ($worstCount -le $MaxProcesses) -and ($worstMB -le $MaxMemoryMB)

# ---------------------------------------------------------------------------
# Criterion 3 -- survivorship. A generation whose owning session is gone, and which is
# older than the grace period, proves that session did not tear its servers down.
# An unknown age never fails the criterion (see ConvertTo-ProcessStartTime).
# ---------------------------------------------------------------------------
$orphans = @($generations | Where-Object {
    -not $_.ownerAlive -and $null -ne $_.oldestSec -and $_.oldestSec -gt $OrphanGraceSeconds
})

$c3Pass = ($orphans.Count -eq 0)

$totalProcs = $rows.Count
$totalMB = 0
foreach ($r in $rows) { $totalMB += $r.mb }

$slots = @()
foreach ($g in ($rows | Where-Object { $null -ne $_.slot } | Group-Object slot)) {
    $slots += [pscustomobject]@{ slot = $g.Name; processes = $g.Group.Count }
}

$servers = @()
foreach ($g in ($rows | Group-Object server)) {
    $mb = 0
    foreach ($r in $g.Group) { $mb += $r.mb }
    $servers += [pscustomobject]@{ server = $g.Name; processes = $g.Group.Count; mb = $mb }
}

$pass = $c1Pass -and $c3Pass

if ($Json) {
    [pscustomobject]@{
        pass        = $pass
        criteria    = @(
            [pscustomobject]@{ id = 'C1'; pass = $c1Pass; measured = "$worstCount procs / $worstMB MB (largest live session)"; limit = "$MaxProcesses procs / $MaxMemoryMB MB" }
            [pscustomobject]@{ id = 'C3'; pass = $c3Pass; measured = "$($orphans.Count) orphaned generation(s)"; limit = "0 beyond ${OrphanGraceSeconds}s" }
        )
        totals      = [pscustomobject]@{ processes = $totalProcs; mb = $totalMB }
        worst       = [pscustomobject]@{ owner = $(if ($worst) { $worst.owner } else { 0 }); processes = $worstCount; mb = $worstMB }
        current     = [pscustomobject]@{ owner = $myOwner; processes = $myCount; mb = $myMB }
        orphans     = $orphans
        slots       = $slots
        servers     = $servers
        generations = $generations
    } | ConvertTo-Json -Depth 6 -Compress
}
else {
    Write-Output "MCP fan-out check  (issue #177 criteria 1 and 3)"
    Write-Output ""
    Write-Output ("  total MCP processes  : {0}  ({1} MB) across {2} generation(s), {3} live" -f $totalProcs, $totalMB, $generations.Count, $live.Count)
    Write-Output ("  largest live session : pid {0} -- {1} procs / {2} MB   <-- criterion 1 is asserted on this" -f $(if ($worst) { $worst.owner } else { 'n/a' }), $worstCount, $worstMB)
    Write-Output ("  this session         : pid {0} -- {1} procs / {2} MB" -f $myOwner, $myCount, $myMB)
    Write-Output ""

    if ($slots.Count -gt 0) {
        Write-Output "  per-slot fan-out (the term fix option 1 reduces):"
        foreach ($s in ($slots | Sort-Object slot)) {
            Write-Output ("    {0,-12} {1} process(es)" -f $s.slot, $s.processes)
        }
        Write-Output ""
    }

    if ($servers.Count -gt 0) {
        Write-Output "  per-server:"
        foreach ($s in ($servers | Sort-Object -Property processes -Descending)) {
            Write-Output ("    {0,-28} {1,3} process(es)  {2,5} MB" -f $s.server, $s.processes, $s.mb)
        }
        Write-Output ""
    }

    $c1Label = if ($c1Pass) { 'PASS' } else { 'FAIL' }
    $c3Label = if ($c3Pass) { 'PASS' } else { 'FAIL' }
    Write-Output ("  [{0}] C1  a single session holds <= {1} procs and <= {2} MB   (worst live: {3} / {4})" -f $c1Label, $MaxProcesses, $MaxMemoryMB, $worstCount, $worstMB)
    Write-Output ("  [{0}] C3  no orphaned generation older than {1}s              (found {2})" -f $c3Label, $OrphanGraceSeconds, $orphans.Count)

    if ($orphans.Count -gt 0) {
        Write-Output ""
        Write-Output "  orphaned generations -- their session exited without tearing these down:"
        foreach ($o in ($orphans | Sort-Object -Property oldestSec -Descending)) {
            Write-Output ("    owner pid {0,-7} {1,3} process(es)  {2,5} MB  oldest {3}s" -f $o.owner, $o.processes, $o.mb, $o.oldestSec)
        }
        Write-Output ""
        Write-Output "  (reap-stale-mcp.ps1 is the tool that clears these; this script never kills anything.)"
    }

    Write-Output ""
    if ($pass) { Write-Output "RESULT: pass" } else { Write-Output "RESULT: FAIL -- see the failing criteria above" }
}

if (-not $pass) { exit 2 }
exit 0
