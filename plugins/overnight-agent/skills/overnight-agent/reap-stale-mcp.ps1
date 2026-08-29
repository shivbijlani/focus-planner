<#
.SYNOPSIS
  Reap stale MCP stdio server processes left behind by finished Copilot sessions, and collect
  session hosts that were never spoken to.

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
    3. NO LIVE OWNING SESSION remains in its ancestor chain -- see Test-HasLiveOwner. This is the
       real protection: age says "old", it does not say "abandoned". An owner counts as live only
       while it is ACTIVE; one that is resident but silent past -OwnerIdleMinutes does not veto.
    3b. ...OR its owner is live but has moved on to a NEWER session -- see Test-IsSupersededCohort.
       A copilot.exe host is pooled and reused, so one live host can hold several runs' worth of
       servers; only the newest start-time cohort is in use. Without this, ownership spares the
       rest forever (measured: 17 servers / 1164 MB, +436 MB per run, `killed 0`).
    4. It has been running longer than -MinAgeMinutes (default 20) -- a secondary floor, not the
       safety mechanism.
    5. It is not in the current tool-shell's own ancestor/descendant tree (Get-ProtectedPidSet).

  PRESENCE IS NOT LIVENESS -- THE VETO NEEDED A SECOND HALF (GH #200, criterion 5).
  The ownership veto in (3) fixed the reaper killing servers a live run still needed. But it asked
  only "does the owner process still exist?", and a WEDGED session exists forever while doing
  nothing. Its servers were therefore permanently unreapable: the guard against over-collection had
  become a guarantee of under-collection, which is the same leak in the opposite direction.

  The signal that separates the two is activity, and the session already emits it -- it appends to
  ~\.copilot\logs\process-<epoch>-<pid>.log while it works. Measured on 2026-08-28:

      copilot.exe 6236  age 165 min, last wrote   3 min ago  <- 11 MCP children, working
      copilot.exe 11664 age 307 min, last wrote 307 min ago  <- wedged, silent since start
      copilot.exe 12848 age 305 min, last wrote 305 min ago  <- wedged, silent since start

  Idle time separates working from wedged cleanly and does NOT track run length, so a long run is
  never mistaken for a stuck one. Verified end to end against the live box: at the shipped default
  behaviour is byte-identical to before (19 spared, 0 reaped); forcing -OwnerIdleMinutes 1 makes the
  same 19 servers / 1403 MB collectable and attributes them to reapedWedgedOwner, so the check is a
  decision rather than a constant. -OwnerIdleMinutes 0 restores pure presence-based ownership.

  The failure direction is one-way on purpose: an owner whose activity cannot be determined still
  vetoes. Missing evidence can only spare a server, never kill one.

  THE PREMISE THIS FILE USED TO STATE IS FALSE, AND IT COST WEEKS (GH #178).
  Every version of this docstring before 2026-08-28 asserted that "one copilot.exe hosts many
  successive runs, so protecting its whole descendant tree would protect every run's servers and
  make this script a permanent no-op". That sentence rules the correct fix out, so ownership was
  never attempted and the age gate stayed as the only guard. It had never been measured. It is
  wrong: EACH SESSION HAS ITS OWN copilot.exe, with its MCP servers as direct children --

      copilot.exe 12708 (21:42) -> 4 MCP children
      copilot.exe  6236 (19:54) -> 3 MCP children

  One Get-CimInstance settled it. So "orphan" has an exact meaning (no live owner remains), and
  the ownership veto is both possible and cheap. Measured the same night, dry-run, veto off vs on:
  age-only would have killed 9 servers / 621 MB, all aged 24 min, ALL of them in use by live
  sessions -- including the session doing the measuring. A slot dying mid-run leaves no log trace,
  which is why this was never attributed to the reaper.

  Do not restore the old reasoning. If a future change needs the age gate to be load-bearing
  again, measure the premise first.

  ...AND THE COLLECTOR COULD NOT SEE THE HOST ITSELF (GH #237).
  Everything above is about MCP *servers*. Nothing collected a leaked *session host*. A
  `copilot.exe --server --stdio` whose client goes away before it is ever driven waits for
  requests forever, and it is invisible to the scan by construction -- it is not in
  -ProcessNames, and -Patterns matches MCP command lines, which a host does not have. So no rule
  here could ever reach it and a device restart was the only remedy, which is exactly the
  "we keep having to reap processes, and restart the device" complaint this script answers.

  Measured live on 2026-08-29, and still resident 8 hours after they were first reported:

      copilot.exe 11664  age 484 min  111 MB  log 392 bytes  last line "waiting for requests"
      copilot.exe 12848  age 483 min  124 MB  log 392 bytes  last line "waiting for requests"

  The rate is low; the RETENTION is unbounded, which is what makes it a leak. Collected by a
  separate pass (see Test-IsStillbornHost) keyed on "never served a request" rather than on age,
  because a host waiting on the user is indistinguishable from one waiting on a dead client by
  age alone -- reaping hosts on age would reintroduce the very defect #178 removed.

  ...AND THE CORRECTION ITSELF WAS HALF-WRONG, WHICH IS WHY THE LEAK SURVIVED IT (GH #177).
  "Each session has its own copilot.exe" was measured on a host that happened to be serving one
  session, and generalised. Re-measured 2026-08-28 23:15 on the SAME host named above:

      copilot.exe 6236 -> 24 MCP children in 4 start-time cohorts, 1704 MB, 1 live tool-shell
        21:33   5 servers  292 MB     22:12   6 servers  436 MB
        22:36   6 servers  436 MB     23:10   6 servers  439 MB  <- the only live one

  Both statements are half true, and the missing distinction is CONCURRENT vs SUCCESSIVE:
  github.exe keeps a POOL of `copilot.exe --server --stdio` hosts; two sessions running at the
  same time land on DIFFERENT hosts (which is what the #178 measurement saw), but a session that
  starts later REUSES a free one (which is what the retracted sentence half-saw). So a busy host
  accumulates one full set of MCP servers per run and sheds none of them.

  The consequence is that ownership -- the fix above -- could not collect the dominant leak on
  this box, because the owner is genuinely active on behalf of its NEWEST cohort and therefore
  vetoes every older one forever. The reaper reported `killed 0, sparedLiveOwner 29` while 17
  servers / 1164 MB sat unreachable and grew by ~436 MB per run. Perfect health, nothing
  collected -- the same "provenance, not capability" trap this project has hit before.

  Hence the cohort rule (Test-IsSupersededCohort): under one host, only the newest start-time
  cohort is in use. Verified on the live box with the age floor dropped to 1 minute, so only the
  rule could decide: the 10 servers of the live cohort were SPARED and the 29 belonging to three
  finished runs were collected; `-NoCohortVeto` reproduced the old `killed 0 / spared 29` exactly.

  THE REUSABLE LESSON, AND IT IS THE SAME ONE AGAIN.
  A premise that rules a fix out must be measured -- but so must the REPLACEMENT premise. This
  one was measured once, on an unrepresentative sample, written down as settled fact, and then
  inherited by the very guard it was used to justify. Measure the correction too.

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

  This is a SECONDARY FLOOR, not the protection. The ownership veto (Test-HasLiveOwner) is what
  keeps a concurrent session's servers alive, at any age. Before that veto existed this gate was
  the only guard, and it was structurally too small: it sits below the real runtime of at least
  one scheduled workflow, so overlapping runs killed each other's tools (GH #200).

  Size it against how old the current run's servers are when this script executes -- which, when the
  script is run first as intended, is 0-2 minutes -- NOT against the schedule interval. Do not raise
  it above the interval "to be safe": that is what caused the leak documented above. Passing a very
  low value (e.g. -MinAgeMinutes 1) still cannot reap a live run's servers while the veto is on,
  because their owner is alive; with -IgnoreOwnership it can, so pair that flag with a sane age.

.PARAMETER ProcessNames
  Image names to scan. Defaults to node.exe (npx-launched servers) plus uv.exe / python.exe
  (uvx-launched servers). A name alone never justifies a kill -- the command line must still match
  -Patterns -- so this list only widens what is *eligible* to be pattern-matched.

.PARAMETER Patterns
  Regex fragments matched against each candidate process's command line. Defaults cover the MCP
  servers this project launches via npx and uvx. The uvx servers are matched on the same names,
  because uv puts the entry point in the child's own command line, e.g.
  `...\python.exe "...\Scripts\better-telegram-mcp.exe"`.

.PARAMETER OwnerIdleMinutes
  How long an owning session may be silent before it stops counting as live (default 240).
  Set 0 to disable the activity check and revert to pure presence-based ownership.

.PARAMETER CohortGapMinutes
  Minimum gap, in minutes, between two MCP spawn times for them to count as different sessions
  (default 15). Servers under one live host are grouped into start-time cohorts; every cohort
  except the newest is treated as a finished run's leftovers. Set 0, or pass -NoCohortVeto, to
  disable and keep pure per-host ownership.

.PARAMETER NoCohortVeto
  Disable the cohort rule only, keeping the ownership veto. -IgnoreOwnership disables both.

.PARAMETER SessionLogDir
  Where session logs live (default ~\.copilot\logs). Overridable so the wedged-owner behaviour
  is testable without a real profile.

.PARAMETER HostNames
  Image names that count as a SESSION HOST rather than an MCP server (default copilot.exe).
  Collected by a separate pass with its own rules -- see GH #237 and Test-IsStillbornHost.

.PARAMETER HostCommandPatterns
  Fragments that must ALL appear in a host's command line before it is even considered
  (default --server, --stdio). An interactive foreground copilot.exe carries neither.

.PARAMETER HostMinAgeMinutes
  Minimum age before a never-served host is collectable (default 20).

.PARAMETER NoHostReap
  Skip the stillborn-host pass entirely, keeping MCP reaping unchanged.

.PARAMETER DryRun
  Report what would be killed without killing anything.

.OUTPUTS
  A single JSON line:
  { scanned, matched, stale, killed, failed, sparedLiveOwner, reapedWedgedOwner,
    reapedSupersededCohort, hostsScanned, hostsSparedServed, hostsStillborn, hostsKilled,
    hostsFailed, hostsFreedMB, hostMinAgeMinutes, hostReap, freedMB, dryRun, minAgeMinutes,
    ownerIdleMinutes, ownershipVeto, cohortVeto, cohortGapMinutes, details }

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
    # How long an owning session may be SILENT before it stops counting as live. GH #200 (5).
    #
    # The ownership veto asks "is the owner process still resident?". That is necessary but not
    # sufficient: a wedged session is resident forever while doing nothing, so its servers become
    # permanently unreapable and the veto turns into the leak it was meant to prevent. Liveness
    # therefore needs an ACTIVITY signal, not just a presence one -- and the session already emits
    # one, because it appends to ~\.copilot\logs\process-<epoch>-<pid>.log while it works.
    #
    # Measured on this box: a session 165 minutes into real work had written to its log 3 minutes
    # ago, while two wedged hosts had not written for 306 minutes -- i.e. idle time separates
    # working from wedged cleanly, and it does NOT track run length. The default is deliberately
    # far above any observed working gap (the longest recorded run is ~139 min, and even that logs
    # continuously) so no busy session can be caught; it exists to collect hosts that have been
    # silent for hours. Set 0 to disable and restore pure presence-based ownership.
    [int] $OwnerIdleMinutes = 240,
    # How far apart two MCP spawn times must be before they count as DIFFERENT sessions. GH #177.
    #
    # A copilot.exe host is pooled and reused by successive runs, so one live host accumulates a
    # fresh cohort of servers per run (measured: 4 cohorts / 24 servers / 1704 MB under a single
    # host). Ownership alone cannot separate them -- the host is genuinely active, serving the
    # NEWEST cohort, so it vetoes every older one forever. Cohorts are recovered from start-time
    # clustering: servers of one session are spawned within seconds of each other, while a new
    # session arrives a run-interval later. Observed gaps between cohorts were 39 / 24 / 34 min;
    # gaps WITHIN a cohort were <= 5 s, and a mid-session MCP restart landed 4 min after its own
    # cohort. The default sits above any observed intra-session respawn and far below the
    # smallest observed inter-cohort gap, so a restart joins its live cohort instead of orphaning
    # it. Set 0 (or -NoCohortVeto) to disable.
    [int] $CohortGapMinutes = 15,
    # Where session logs live. Overridable so the behaviour is testable without a real profile.
    [string] $SessionLogDir = (Join-Path $env:USERPROFILE '.copilot\logs'),
    # --- Stillborn session hosts (GH #237) -------------------------------------------------
    # Image names that count as a SESSION HOST, as opposed to an MCP server. These are collected
    # by a separate pass with its own rules; they are deliberately NOT added to -ProcessNames,
    # because the -Patterns match is on MCP command lines and would never apply to a host, and
    # matching a host on age alone would reintroduce the age-only defect GH #178 removed.
    [string[]] $HostNames = @('copilot.exe'),
    # A host only qualifies when its command line shows it is a stdio server -- i.e. something
    # else was supposed to drive it. ALL of these must be present. An interactive foreground
    # copilot.exe has no --server/--stdio and is therefore never even considered.
    [string[]] $HostCommandPatterns = @('--server', '--stdio'),
    # Minimum age before a never-served host is collectable. Separate from -MinAgeMinutes so the
    # two floors can move independently; a host legitimately spends its first seconds waiting to
    # be driven, so this must be comfortably above normal client-attach latency.
    [int] $HostMinAgeMinutes = 20,
    # Escape hatch: skip the stillborn-host pass entirely, keeping MCP reaping.
    [switch] $NoHostReap,
    # Escape hatch for the cohort rule alone, so it can be switched off without also giving up the
    # ownership veto (-IgnoreOwnership turns off both).
    [switch] $NoCohortVeto,
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
    # copilot.exe / github.exe are the *session host* boundary. Stopping here keeps this pass scoped
    # to the current tool-shell subtree; without a stop-list the walk can reach services.exe or the
    # System process on some hosts, and the descendant pass below would then mark every process on
    # the box as protected, making the reaper a no-op.
    #
    # NOTE: this pass is NOT what protects the current run's own MCP servers. They are siblings of
    # this script rather than descendants of it, so it cannot single them out. They are protected by
    # the ownership veto (Test-HasLiveOwner), which spares any candidate whose owning session is
    # still alive -- this run's owner included. See the header for why the old "one copilot.exe
    # hosts every run" claim was false and what it cost.
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

function Get-SessionActivityMap {
    <#
      pid -> last write time of that session's log, for every process-<epoch>-<pid>.log present.

      This is the activity signal behind the wedged-owner check (GH #200, criterion 5). A session
      appends to its log while it works, so the file's mtime answers "is this host doing anything?"
      -- which process presence alone cannot.

      Deliberately fail-safe: any error here yields an EMPTY map, and an owner missing from the map
      is treated as active by Test-HasLiveOwner. So a log that is absent, renamed, locked or on a
      host that names them differently can only ever SPARE a server, never cause a kill.
    #>
    param([string] $LogDir)

    $map = @{}
    if ([string]::IsNullOrWhiteSpace($LogDir)) { return $map }
    if (-not (Test-Path -LiteralPath $LogDir)) { return $map }

    try {
        Get-ChildItem -LiteralPath $LogDir -Filter 'process-*.log' -File -ErrorAction Stop |
            ForEach-Object {
                # process-<epoch>-<pid>.log -- the trailing group is the owning process id.
                if ($_.Name -match '-(\d+)\.log$') {
                    $logPid = [int]$Matches[1]
                    # Keep the most recent write when a pid has been reused across sessions.
                    if (-not $map.ContainsKey($logPid) -or $map[$logPid] -lt $_.LastWriteTime) {
                        $map[$logPid] = $_.LastWriteTime
                    }
                }
            }
    }
    catch { return @{} }

    return $map
}

function Read-SessionLogText {
    <#
      Read a session log that its OWNING PROCESS STILL HAS OPEN FOR WRITING.

      THE SHARE MODE IS THE WHOLE FUNCTION, AND GETTING IT WRONG IS SILENT (GH #237).
      Every live copilot.exe holds its own log open with write access. [IO.File]::ReadAllText
      opens with FileShare.Read, which does not permit a concurrent writer, so it throws
      "because it is being used by another process" on EVERY log that matters. Measured on this
      box, against both a stillborn host and a busy one:

          ReadAllText  -> FAIL (sharing violation)   on pid 11664 AND pid 9956
          FileShare.ReadWrite -> OK (392 chars)      on pid 11664
          FileShare.ReadWrite -> OK (11576 chars)    on pid 9956

      Combined with the fail-safe rule below -- unreadable evidence means SPARE -- a reader that
      gets this wrong does not error out. It returns $null for every host, every host is spared,
      and the collector becomes a permanent no-op that reports a healthy `0`. That is the
      "structurally blind detector" failure this project has hit repeatedly, so the share mode is
      asserted by mutcheck-reaper-stillborn.ps1 rather than left to a comment.

      Returns $null on ANY failure (missing, locked beyond reading, unreadable, bad encoding).
      Callers must treat $null as "no evidence" and spare.
    #>
    param([string] $Path)

    if ([string]::IsNullOrWhiteSpace($Path)) { return $null }
    if (-not (Test-Path -LiteralPath $Path)) { return $null }

    $fs = $null
    $sr = $null
    try {
        # FileShare.ReadWrite is load-bearing -- see above. Do not "tidy" this to ReadAllText.
        $fs = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
        $sr = New-Object IO.StreamReader($fs, (New-Object Text.UTF8Encoding($false)))
        return $sr.ReadToEnd()
    }
    catch { return $null }
    finally {
        if ($sr) { $sr.Dispose() }
        elseif ($fs) { $fs.Dispose() }
    }
}

function Test-IsStillbornHost {
    <#
      Is this session host one that came up, announced readiness, and was NEVER SPOKEN TO?

      WHY THIS EXISTS (GH #237)
        reap-stale-mcp collects leaked MCP *servers*. Nothing collected a leaked *session host*.
        A `copilot.exe --server --stdio` whose client dies before it is ever driven sits in
        "waiting for requests" forever. It is invisible to the scan above by construction: the
        scan matches -ProcessNames (node/uv/python) and -Patterns against MCP command lines, and
        a copilot.exe matches neither. So nothing on the box could ever collect it and a device
        restart was the only remedy -- precisely the "we keep having to reap processes, and
        restart the device" complaint this script exists to answer.

        Measured live, and still resident 8 hours later when this fix was written:
            pid 11664  age 484 min  111 MB  log 392 bytes, 5 lines
            pid 12848  age 483 min  124 MB  log 392 bytes, 5 lines
        Both logs end at "Server started, waiting for requests" and stop.

      THE DISCRIMINATOR IS "NEVER SERVED", NOT "OLD" (criterion 3)
        This is the hard constraint: a host waiting on SHIV looks identical from the outside to
        one waiting on a dead client. Age cannot separate them, and reaping on age would
        reintroduce the exact defect GH #178 removed. What separates them is that a host which
        has been spoken to at all keeps writing to its log. A connected-but-idle interactive
        session is therefore NOT stillborn -- measured on the live host serving this very run,
        whose log had already moved past the banner (11,576 chars) before any user message:

            2026-08-29T08:31:42Z [INFO] --- Start of group: configured settings: ---

        So the test is: the readiness banner is still the LAST thing the host ever logged.
        "Last line", not "contains" -- a busy host's log contains the banner too, which is why
        an any-line match is a mutant this rule must survive.

      FAILURE DIRECTION IS ONE-WAY, DELIBERATELY
        No log, unreadable log, empty log, or a log whose last line is anything else -> SPARE.
        Missing evidence can only ever spare a host, never kill one. A truncated or rotated log
        is the one way this could read "stillborn" wrongly, which is what $HasLiveChildren is
        for: a host with MCP servers under it has demonstrably been driven, whatever its log
        says, so it is spared on a second, independent signal.
    #>
    param(
        [AllowNull()] [string] $LogText,
        [string] $ReadyMarker = 'Server started, waiting for requests',
        [bool] $HasLiveChildren = $false
    )

    # No readable evidence -> never a candidate. See FAILURE DIRECTION above.
    if ([string]::IsNullOrWhiteSpace($LogText)) { return $false }

    # Independent of the log entirely: a host with MCP servers under it has been driven. This
    # covers the one case the log signal can get wrong (truncation/rotation).
    if ($HasLiveChildren) { return $false }

    $lines = @($LogText -split "`r?`n" | Where-Object { $_ -match '\S' })
    if ($lines.Count -eq 0) { return $false }

    # LAST line, not any line -- a host that served requests logged past its own banner.
    return ($lines[$lines.Count - 1] -match [regex]::Escape($ReadyMarker))
}

function Get-ProcessTable {
    # One WMI pass, reused by both the protected-set walk and the ownership check, so the two
    # can never disagree about what was running at this instant.
    param([hashtable] $ActivityMap = @{})

    $table = @{}
    Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name, CreationDate |
        ForEach-Object {
            $procId = [int]$_.ProcessId
            # Set on every node (null when unknown) so Set-StrictMode never trips on the lookup.
            $activity = $null
            if ($ActivityMap.ContainsKey($procId)) { $activity = $ActivityMap[$procId] }
            $table[$procId] = [pscustomobject]@{
                Pid          = $procId
                Parent       = [int]$_.ParentProcessId
                Name         = [string]$_.Name
                Started      = ConvertTo-ProcessStartTime $_.CreationDate
                LastActivity = $activity
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

      PRESENCE IS NOT LIVENESS (GH #200, criterion 5)
        "Owner process exists" and "owner session is doing something" are different claims, and
        only the second one justifies keeping a server alive. A wedged host -- resident, idle for
        hours, heartbeat only -- satisfies the first forever, which makes its servers permanently
        unreapable and turns the veto into the leak it was introduced to stop. Criterion 5 of
        #200 names this case explicitly.

        So a matching owner must ALSO be active: its session log must have been written within
        $OwnerIdleMinutes. Direction of failure is deliberate and one-way -- an owner whose
        activity is UNKNOWN (no log, unreadable dir, $OwnerIdleMinutes 0) still vetoes. Missing
        evidence can therefore only spare a server, never kill one, which is the property that
        makes this safe to ship to an unattended job.
    #>
    param(
        [hashtable] $Table,
        [int] $StartPid,
        [datetime] $ChildStarted,
        [string[]] $OwnerNames,
        [int] $OwnerIdleMinutes = 0,
        [datetime] $Now = (Get-Date)
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

        if ($ownerSet.Contains($node.Name.ToLowerInvariant())) {
            # Owner found. It only vetoes if the session is still ACTIVE -- see PRESENCE IS NOT
            # LIVENESS above. Unknown activity keeps the veto, so this can only remove protection
            # from a host that is provably silent.
            if ($OwnerIdleMinutes -gt 0 -and $node.LastActivity -is [datetime]) {
                if (($Now - $node.LastActivity).TotalMinutes -gt $OwnerIdleMinutes) { return $false }
            }
            return $true
        }

        if ($node.Parent -le 0 -or $node.Parent -eq $cur) { break }
        $childAt = $node.Started
        $cur     = $node.Parent
    }

    return $false
}

function Resolve-OwnerPid {
    <#
      Which session process owns this MCP server? Returns the owner's PID, or 0 when the chain is
      orphaned. Deliberately a SEPARATE, self-contained walk rather than a refactor of
      Test-HasLiveOwner: that function is extracted by name and evaluated standalone by
      mutcheck-reaper-ownership.ps1, so making it call a helper would silently break the check
      that proves the veto is load-bearing.

      Liveness is NOT decided here -- Test-HasLiveOwner still owns that question. This only
      answers "whose tree is it in", which is what lets servers be grouped per host so successive
      runs sharing one pooled host can be told apart. GH #177.
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
        if (-not $seen.Add($cur)) { break }
        if (-not $Table.ContainsKey($cur)) { return 0 }

        $node = $Table[$cur]

        # Same PID-reuse guard as Test-HasLiveOwner: a "parent" that started after its child is
        # not the real parent, so the chain is gone rather than owned.
        if ($node.Started -and $childAt -and $node.Started -gt $childAt) { return 0 }

        if ($ownerSet.Contains($node.Name.ToLowerInvariant())) { return $cur }

        if ($node.Parent -le 0 -or $node.Parent -eq $cur) { break }
        $childAt = $node.Started
        $cur     = $node.Parent
    }

    return 0
}

function Test-IsSupersededCohort {
    <#
      Is this server part of a cohort that a LATER session has already replaced?

      WHY THIS EXISTS (GH #177)
        The ownership veto assumes "one live host == one live session". That is false for a
        POOLED host. Measured on this box: github.exe keeps a pool of `copilot.exe --server
        --stdio` hosts; concurrent sessions land on DIFFERENT hosts, but SUCCESSIVE sessions
        REUSE one. So a busy host accumulates a full set of MCP servers per run and never sheds
        the old ones -- they are children of a process that is genuinely active, so the veto
        spares them forever:

            copilot.exe 6236, 4 cohorts, 24 MCP children, 1704 MB, 1 live tool-shell
              21:33  5 servers   292 MB   <- finished run
              22:12  6 servers   436 MB   <- finished run
              22:36  6 servers   436 MB   <- finished run
              23:10  6 servers   439 MB   <- the live session
            reaper verdict that night: killed 0, sparedLiveOwner 29.

        17 servers / 1164 MB were unreachable by every existing rule, growing ~436 MB per run.
        The reaper reported perfect health while collecting nothing -- the same "provenance, not
        capability" failure this project has hit before.

      THE SIGNAL
        Session start is observable in the spawn times. A session's servers appear within seconds
        of each other; the next session appears a run-interval later. So cluster the start times
        of everything under one owner, separating clusters at gaps greater than $GapMinutes, and
        keep only the NEWEST cluster. Anything older belonged to a run that has ended.

      WHY CLUSTERING, NOT "IS ANYTHING NEWER THAN ME"
        A naive "a newer sibling exists" test would orphan a live session the moment one of its
        own servers restarted. Measured: a mid-session email-mcp respawn arrived 4 minutes after
        its cohort. Clustering absorbs that restart into the live cohort; the simpler test would
        have killed the session's other five servers out from under it.

      FAILURE DIRECTION IS ONE-WAY
        With a single cohort no member can be older than that cohort's own first spawn, so the
        comparison below returns $false and a host serving one session is never affected. The
        newest cohort is never superseded, for the same reason. A gap of 0 disables the rule.
        Missing or unusable evidence can therefore only spare a server, never kill one.

      EVERY BEHAVIOURAL LINE HERE IS LOAD-BEARING, BY MEASUREMENT
        An earlier draft also carried explicit "fewer than two siblings" and "no cut was made"
        early-returns. mutcheck-reaper-cohort.ps1 deleted each of them and NOTHING FAILED: the
        final comparison already covers both cases. They were removed rather than kept as
        reassurance, because a guard whose mutant survives is not protecting anything -- it only
        makes the real logic harder to find.

        The empty-input guard below is the one deliberate exception, and it is recorded rather
        than hidden: its mutant SURVIVES too, because with no siblings $newestCohortStart is
        $null and PowerShell evaluates `$Started -lt $null` as $false. So the guard changes no
        behaviour today -- it exists to state the intent explicitly instead of resting on a
        surprising null-comparison rule that a later edit could silently invert.
    #>
    param(
        [datetime] $Started,
        [datetime[]] $SiblingStarts,
        [int] $GapMinutes
    )

    if ($GapMinutes -le 0) { return $false }
    # Intent-documentation, not a behavioural guard -- see the note above.
    if (-not $SiblingStarts -or $SiblingStarts.Count -eq 0) { return $false }

    $sorted = @($SiblingStarts | Sort-Object)

    # Walk the sorted starts and cut a new cohort wherever the gap exceeds the threshold. What
    # survives is the first spawn of the NEWEST cohort; everything strictly older than it belongs
    # to a run that has ended. With one cohort no cut is made, so this stays at $sorted[0] and
    # nothing can be older than it.
    $newestCohortStart = $sorted[0]
    for ($i = 1; $i -lt $sorted.Count; $i++) {
        if (($sorted[$i] - $sorted[$i - 1]).TotalMinutes -gt $GapMinutes) {
            $newestCohortStart = $sorted[$i]
        }
    }

    return ($Started -lt $newestCohortStart)
}

$cutoff       = (Get-Date).AddMinutes(-$MinAgeMinutes)
$protected    = Get-ProtectedPidSet
$activityMap  = Get-SessionActivityMap -LogDir $SessionLogDir
$procTable    = Get-ProcessTable -ActivityMap $activityMap
$combined     = ($Patterns -join '|')

$nameFilter = ($ProcessNames | ForEach-Object { "Name='$($_ -replace "'", "''")'" }) -join ' OR '
$candidates = @(Get-CimInstance Win32_Process -Filter $nameFilter -ErrorAction SilentlyContinue)

$scanned = $candidates.Count
$matched = 0
$stale   = 0
$killed  = 0
$failed  = 0
$ownedLive = 0
$wedgedOwner = 0
$staleCohort = 0
$freedKB = 0
$details = New-Object System.Collections.ArrayList

# PRE-PASS: group every matching server's spawn time by the session host that owns it. The cohort
# rule needs to see a candidate's SIBLINGS, which the per-candidate loop below cannot -- it visits
# one process at a time. Built once here rather than re-walked per candidate. GH #177.
$cohortStarts = @{}
$cohortVetoOn = (-not $IgnoreOwnership) -and (-not $NoCohortVeto) -and ($CohortGapMinutes -gt 0)
if ($cohortVetoOn) {
    foreach ($p in $candidates) {
        $cmd = $p.CommandLine
        if ([string]::IsNullOrWhiteSpace($cmd)) { continue }
        if ($cmd -notmatch $combined) { continue }
        $st = ConvertTo-ProcessStartTime $p.CreationDate
        if (-not $st) { continue }
        $ownerPid = Resolve-OwnerPid -Table $procTable -StartPid ([int]$p.ProcessId) -ChildStarted $st -OwnerNames $OwnerNames
        if ($ownerPid -le 0) { continue }
        if (-not $cohortStarts.ContainsKey($ownerPid)) { $cohortStarts[$ownerPid] = New-Object System.Collections.ArrayList }
        [void]$cohortStarts[$ownerPid].Add($st)
    }
}

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
        $now = Get-Date
        if (Test-HasLiveOwner -Table $procTable -StartPid $procId -ChildStarted $started -OwnerNames $OwnerNames -OwnerIdleMinutes $OwnerIdleMinutes -Now $now) {

            # The owner is live -- but "live host" is not "live session" once a host is POOLED and
            # reused by successive runs. Ask the second question before sparing: is this server part
            # of a cohort that a LATER session has already replaced? Only the newest cohort under a
            # host is in use; older ones are a finished run's leftovers that ownership alone can
            # never collect. GH #177.
            $superseded = $false
            if ($cohortVetoOn) {
                $ownerPid = Resolve-OwnerPid -Table $procTable -StartPid $procId -ChildStarted $started -OwnerNames $OwnerNames
                if ($ownerPid -gt 0 -and $cohortStarts.ContainsKey($ownerPid)) {
                    $superseded = Test-IsSupersededCohort -Started $started -SiblingStarts ([datetime[]]$cohortStarts[$ownerPid].ToArray()) -GapMinutes $CohortGapMinutes
                }
            }

            if (-not $superseded) {
                $ownedLive++
                [void]$details.Add([ordered]@{
                    pid    = $procId
                    ageMin = [math]::Round(((Get-Date) - $started).TotalMinutes)
                    mb     = [math]::Round(($p.WorkingSetSize / 1KB) / 1KB)
                    action = 'spared-live-owner'
                })
                continue
            }

            $staleCohort++
        }
        else {
            # Reapable. Was it the wedged-owner rule that decided that? Re-ask with the activity
            # check switched off: if presence alone WOULD have spared it, the owner is resident but
            # silent -- exactly GH #200 criterion 5. Counted separately so the case is observable in
            # the JSON rather than hiding inside the ordinary orphan count.
            if ($OwnerIdleMinutes -gt 0 -and
                (Test-HasLiveOwner -Table $procTable -StartPid $procId -ChildStarted $started -OwnerNames $OwnerNames -OwnerIdleMinutes 0 -Now $now)) {
                $wedgedOwner++
            }
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

$hostsScanned      = 0
$hostsStillborn    = 0
$hostsKilled       = 0
$hostsSparedServed = 0
$hostsFailed       = 0
$hostFreedKB       = 0

# ---------------------------------------------------------------------------------------------
# STILLBORN SESSION HOSTS (GH #237)
#
# A separate pass, on purpose. The loop above is "an MCP server whose session has gone"; this is
# "a session host that never had a client". They share no rule: ownership, cohorts and -Patterns
# are all meaningless for a host, and a host is nobody's child in the sense the veto understands.
# Folding it into the loop above would have required weakening exactly the guards that make that
# loop safe -- which is why the issue says, explicitly, do not just add copilot.exe to
# -ProcessNames.
#
# Every guard here can only PREVENT a kill. A host is collected only when ALL hold:
#   1. its image name is in -HostNames;
#   2. its command line contains every -HostCommandPatterns fragment (a stdio server);
#   3. it is not in this run's own protected tree (never kill ourselves or our host);
#   4. its start time is known and older than -HostMinAgeMinutes;
#   5. its log is present and readable (unreadable -> spare);
#   6. it has no live child processes other than the console host; and
#   7. the readiness banner is still the LAST line it ever logged (Test-IsStillbornHost).
# ---------------------------------------------------------------------------------------------
if (-not $NoHostReap) {
    $hostCutoff = (Get-Date).AddMinutes(-$HostMinAgeMinutes)

    # Children of each pid, from the SAME WMI snapshot the rest of the script used, so this pass
    # can never disagree with the ownership walk about what was running at this instant.
    $childCount = @{}
    foreach ($node in $procTable.Values) {
        $parentPid = $node.Parent
        if ($parentPid -le 0) { continue }
        # conhost.exe is attached by Windows to any console process and says nothing about
        # whether the host was ever driven -- both stillborn hosts measured had exactly one.
        if ($node.Name -and $node.Name.ToLowerInvariant() -eq 'conhost.exe') { continue }
        if (-not $childCount.ContainsKey($parentPid)) { $childCount[$parentPid] = 0 }
        $childCount[$parentPid]++
    }

    # pid -> log path, from the same directory listing convention Get-SessionActivityMap uses.
    $logPathByPid = @{}
    if (-not [string]::IsNullOrWhiteSpace($SessionLogDir) -and (Test-Path -LiteralPath $SessionLogDir)) {
        try {
            Get-ChildItem -LiteralPath $SessionLogDir -Filter 'process-*.log' -File -ErrorAction Stop |
                ForEach-Object {
                    if ($_.Name -match '-(\d+)\.log$') {
                        $logPid = [int]$Matches[1]
                        if (-not $logPathByPid.ContainsKey($logPid) -or
                            $logPathByPid[$logPid].Written -lt $_.LastWriteTime) {
                            $logPathByPid[$logPid] = [pscustomobject]@{
                                Path    = $_.FullName
                                Written = $_.LastWriteTime
                            }
                        }
                    }
                }
        }
        catch { $logPathByPid = @{} }   # unreadable log dir -> no evidence -> spare everything
    }

    $hostFilter = ($HostNames | ForEach-Object { "Name='$($_ -replace "'", "''")'" }) -join ' OR '
    $hostProcs  = @(Get-CimInstance Win32_Process -Filter $hostFilter -ErrorAction SilentlyContinue)

    foreach ($h in $hostProcs) {
        $hostsScanned++

        $hcmd = $h.CommandLine
        if ([string]::IsNullOrWhiteSpace($hcmd)) { continue }

        # (2) EVERY fragment must be present -- a stdio server, not an interactive session.
        $isStdioServer = $true
        foreach ($frag in $HostCommandPatterns) {
            if ($hcmd -notmatch [regex]::Escape($frag)) { $isStdioServer = $false; break }
        }
        if (-not $isStdioServer) { continue }

        $hostPid = [int]$h.ProcessId

        # (3) never collect the host this run is executing inside.
        if ($protected.Contains($hostPid)) { continue }

        # (4) unknown age is never a candidate, same rule as the MCP loop.
        $hStarted = ConvertTo-ProcessStartTime $h.CreationDate
        if (-not $hStarted) { continue }
        if ($hStarted -gt $hostCutoff) { continue }

        # (5) read the log through a share-tolerant reader -- see Read-SessionLogText.
        $logText = $null
        if ($logPathByPid.ContainsKey($hostPid)) {
            $logText = Read-SessionLogText -Path $logPathByPid[$hostPid].Path
        }

        # (6) MCP servers (or anything else) under this host prove it was driven.
        $hasKids = $childCount.ContainsKey($hostPid) -and $childCount[$hostPid] -gt 0

        # (7) the readiness banner is still the last thing it logged.
        if (-not (Test-IsStillbornHost -LogText $logText -HasLiveChildren $hasKids)) {
            # Counted only once a process got far enough to be a real stdio-server candidate, so
            # this means "hosts checked and found in use", not "every process scanned".
            $hostsSparedServed++
            continue
        }

        $hostsStillborn++
        $hAgeMin = [math]::Round(((Get-Date) - $hStarted).TotalMinutes)
        $hKB     = [int]($h.WorkingSetSize / 1KB)

        if ($DryRun) {
            $hostsKilled++
            $hostFreedKB += $hKB
            [void]$details.Add([ordered]@{ pid = $hostPid; ageMin = $hAgeMin; mb = [math]::Round($hKB / 1KB); action = 'would-kill-stillborn-host' })
            continue
        }

        try {
            Stop-Process -Id $hostPid -Force -ErrorAction Stop
            $hostsKilled++
            $hostFreedKB += $hKB
            [void]$details.Add([ordered]@{ pid = $hostPid; ageMin = $hAgeMin; mb = [math]::Round($hKB / 1KB); action = 'killed-stillborn-host' })
        }
        catch {
            $hostsFailed++
            [void]$details.Add([ordered]@{ pid = $hostPid; ageMin = $hAgeMin; mb = [math]::Round($hKB / 1KB); action = 'failed-stillborn-host'; error = $_.Exception.Message })
        }
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
    # Of the reaped servers, how many belonged to a host that was still RESIDENT but silent for
    # longer than -OwnerIdleMinutes. Before GH #200 these were immortal: presence alone vetoed
    # them forever, so a wedged session's servers accumulated with nothing able to collect them.
    reapedWedgedOwner = $wedgedOwner
    # Of the reaped servers, how many belonged to a host that IS live and active but had already
    # moved on to a newer session. These are invisible to every other rule here: the owner is
    # genuinely working, so the ownership veto spares them, and the wedged-owner check never fires
    # because the host is not silent. Measured on this box before the fix: 17 servers / 1164 MB
    # under one host, growing by a full ~436 MB set every run. GH #177.
    reapedSupersededCohort = $staleCohort
    # --- stillborn session hosts (GH #237). Additive: every field above keeps its meaning, so
    # existing consumers that read `killed`/`freedMB` are unaffected by this pass.
    # How many host processes were looked at at all.
    hostsScanned = $hostsScanned
    # Stdio-server hosts that were checked and found to be IN USE -- they had served a request,
    # had children, or their log could not be read. A high number here next to hostsKilled 0 is
    # the healthy steady state, and it is reported so "collected nothing" can be told apart from
    # "could not see anything", which is the failure mode this pass is most likely to regress to.
    hostsSparedServed = $hostsSparedServed
    # Hosts that came up, announced readiness and were never spoken to. Before GH #237 these were
    # immortal: no rule in this script could see a copilot.exe, so a device restart was the only
    # way they were ever collected. Measured live: 2 hosts / 235 MB, still resident after 8 hours.
    hostsStillborn = $hostsStillborn
    hostsKilled = $hostsKilled
    hostsFailed = $hostsFailed
    hostsFreedMB = [math]::Round($hostFreedKB / 1KB)
    hostMinAgeMinutes = $HostMinAgeMinutes
    hostReap = (-not [bool]$NoHostReap)
    freedMB = [math]::Round($freedKB / 1KB)
    dryRun  = [bool]$DryRun
    minAgeMinutes = $MinAgeMinutes
    ownerIdleMinutes = $OwnerIdleMinutes
    ownershipVeto = (-not [bool]$IgnoreOwnership)
    cohortVeto = [bool]$cohortVetoOn
    cohortGapMinutes = $CohortGapMinutes
    details = $details
} | ConvertTo-Json -Depth 4 -Compress
