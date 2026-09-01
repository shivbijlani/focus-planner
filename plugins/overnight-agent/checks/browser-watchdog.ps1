<#
.SYNOPSIS
  Keep the Edge CDP automation slots HEALTHY -- not merely listening -- and
  recover a wedged one on a graduated, evidenced ladder. GH #197.

.DESCRIPTION
  WHAT WAS WRONG (measured, not assumed)
  --------------------------------------
  The previous watchdog (`browser-watchdog/watchdog.ps1`, which lived in
  OneDrive outside this repo and therefore outside CI and outside the deploy
  pipeline) decided a slot was alive with a bare 1-second TCP connect. If the
  socket accepted, the slot was declared `already-up` and reused untouched.

  Measured 2026-09-01 against three fixture CDP servers, running that exact
  deployed file with -WhatIf so nothing real was launched:

      fixture   deployed watchdog     truth (check-browser-slots.ps1)
      healthy   already-up            up      healthy
      wedged    already-up   <-- BUG  stuck   NOT healthy
      down      would-launch          down    NOT healthy

  Both controls were classified correctly, so the result is conclusive rather
  than incidental: the watchdog could not distinguish a slot that WORKS from one
  that merely ANSWERS. Accepting a socket is liveness. It is not health.

  Worse, the probe that CAN tell them apart already existed and was already
  mutation-proven (`check-browser-slots.ps1`, GH #329, mutcheck 8/8). The
  watchdog simply never consulted it, and the one tool that could see the
  failure is read-only by contract, so nothing anywhere could un-wedge a slot.

  WHAT THIS DOES INSTEAD
  ----------------------
  Health, then a ladder, cheapest rung first, with evidence at every step:

      probe -> healthy   leave completely alone (unchanged behaviour)
      probe -> down      launch (unchanged behaviour)
      probe -> stuck     CONFIRM, then recover:
                           1. thaw the frozen page in place  (nothing closed)
                           2. close just the wedged TARGET    (a tab, not the window)
                           3. restart the process             (same profile dir)
                         re-probe after every rung; stop at the first that works
      probe -> unknown   report, act on nothing

  ONE PROBE, NOT A SECOND COPY
  ----------------------------
  The health verdict is obtained by invoking `check-browser-slots.ps1 -Json`.
  That is deliberate. A second probe implementation would be a second thing to
  keep true, and this codebase has already paid for exactly that mistake with
  the slot table (#180: three scripts, three hardcoded lists, all drifted). The
  probe's subtleties -- that it must await a TIMER because sync JS still runs in
  a frozen renderer, and that it must target EXISTING pages because a fresh one
  is never frozen -- are load-bearing and proven by mutcheck-browser-slot-probe.
  Re-deriving them here would mean re-deriving the bugs.

  THE SLOT LIST IS NOT IN THIS FILE EITHER (GH #180)
  --------------------------------------------------
  The old watchdog carried its own `config.json` with a hardcoded slot list --
  a third copy of the table that `user-settings.md` declares the source of
  truth. It happened to agree on the day it was written, which is precisely why
  the drift would have been silent. Slots come from `browser-slot-table.ps1`,
  the one parser, or from an explicit -SlotSpec override.

  WHY A KILL IS THE LAST RUNG AND NEVER THE FIRST
  -----------------------------------------------
  These are the user's signed-in windows. Under Chromium App-Bound Encryption a
  damaged profile starts LOGGED OUT, and only a human can sign it back in. So a
  wrong kill costs a manual re-login, and the recovery is built to refuse rather
  than risk one:

    * no rung before the last one closes anything but a single frozen tab;
    * the restart reuses the SAME --user-data-dir, so the sign-in survives;
    * the profile dir is never deleted, moved, cloned or recreated here;
    * before killing, the process must be positively identified as belonging to
      THIS slot's profile dir. If it cannot be, the run refuses and escalates.

  RECOVERY NEVER FIRES ON ONE BAD PROBE
  -------------------------------------
  A single failed probe is a slow moment, not a verdict. Every rung requires a
  CONFIRMATION probe after a settle delay, so two independent observations agree
  before anything is touched. The destructive rung additionally requires the
  slot to have been stuck on -RestartAfterRuns consecutive WATCHDOG RUNS, which
  is tracked in a state file -- a much higher bar, because that rung is the one
  that can cost a re-login.

  ...AND NEVER ON A SLOT SOMEBODY IS DRIVING
  ------------------------------------------
  Age and "the port is open" are both unsound proxies for ownership; #178 paid
  for that lesson in the reaper. If a live MCP client is attached to the slot,
  recovery is REFUSED and escalated, because a slot that looks wedged from
  outside may be one an active run is mid-operation on. The veto fails SAFE, in
  one direction only: if ownership cannot be determined, the slot is spared.
  Missing evidence can spare a slot; it can never justify killing one.

  ORPHANED MCP SERVERS ARE REAPED, NOT REIMPLEMENTED (GH #177/#178)
  -----------------------------------------------------------------
  Restarting a browser strands the MCP servers that were attached to it. The
  collector for that already exists, with an ownership veto this file has no
  business duplicating, so after a restart this invokes `reap-stale-mcp.ps1`.

.PARAMETER WhatIf
  Decide and report; perform nothing. Actions are prefixed `would-`. This is the
  seam the mutation check drives, so a mutant's DECISION can be asserted without
  any browser being launched or killed.

.PARAMETER Json
  Emit the per-slot verdict as JSON instead of a table.

.PARAMETER SlotSpec
  Override the slot table with 'port:name' entries. Exists so tests can point at
  fixture CDP servers instead of the user's real browsers. Launching is refused
  under -SlotSpec: a fixture has no profile, and inventing one would be the
  wrong-profile bug (#180) with extra steps.

.PARAMETER RestartAfterRuns
  Consecutive stuck WATCHDOG RUNS required before the process-restart rung is
  allowed. Default 2. Set 1 only in tests.

.PARAMETER NoRecover
  Probe and report only. Restores pre-#197 non-intervention while keeping the
  honest verdict.

.NOTES
  Exit codes: 0 = every slot healthy (possibly after recovery).
              1 = a slot is down and could not be brought up.
              2 = attention needed -- a slot is stuck and recovery failed or was
                  refused. That is a question for a human, not a silent retry.
#>
[CmdletBinding()]
param(
    [switch]$WhatIf,
    [switch]$Quiet,
    [switch]$Json,
    [string]$SettingsPath,
    [string[]]$SlotSpec,
    [int]$ProbeTimeoutSec = 6,
    [int]$ProbeBudgetSec = 90,
    [int]$ConfirmDelaySec = 3,
    [int]$RestartAfterRuns = 2,
    # How long an owning session may be SILENT before its attached MCP client
    # stops vetoing recovery. Mirrors the reaper's -OwnerIdleMinutes (GH #200):
    # presence is not liveness, and a wedged host is resident forever. 0 restores
    # pure presence-based ownership.
    [int]$OwnerIdleMinutes = 60,
    [string[]]$OwnerNames = @('copilot.exe'),
    [switch]$NoRecover,
    [switch]$NoReap,
    [string]$StatePath,
    [string]$CheckerPath
)

$ErrorActionPreference = 'Stop'

function Note($msg, $color = 'Gray') { if (-not $Quiet -and -not $Json) { Write-Host $msg -ForegroundColor $color } }

# ---------------------------------------------------------------------------
# Locate the sibling scripts. SEARCH, never assume adjacency: this file is
# deployed to BOTH the flat OA home and the nested installed-plugins tree, and
# those two locations do not hold the same file set. Assuming a sibling is what
# made PR #303 green and still broken (#305).
# ---------------------------------------------------------------------------
function Find-OaScript {
    param([string]$Name)
    $cands = @(
        [IO.Path]::Combine($PSScriptRoot, $Name)
        [IO.Path]::Combine($PSScriptRoot, '..', 'checks', $Name)
        [IO.Path]::Combine($PSScriptRoot, '..', 'skills', 'overnight-agent', $Name)
        [IO.Path]::Combine($PSScriptRoot, '..', '..', 'checks', $Name)
        $(if ($env:LOCALAPPDATA) { [IO.Path]::Combine($env:LOCALAPPDATA, 'overnight-agent', $Name) })
        $(if ($env:USERPROFILE) { [IO.Path]::Combine($env:USERPROFILE, '.copilot', 'installed-plugins', 'focus-planner', 'overnight-agent', 'checks', $Name) })
        $(if ($env:USERPROFILE) { [IO.Path]::Combine($env:USERPROFILE, '.copilot', 'installed-plugins', 'focus-planner', 'overnight-agent', 'skills', 'overnight-agent', $Name) })
    )
    foreach ($c in $cands) {
        if ($c -and (Test-Path -LiteralPath $c -PathType Leaf)) { return (Resolve-Path -LiteralPath $c).Path }
    }
    return $null
}

$checker = if ($CheckerPath) { $CheckerPath } else { Find-OaScript 'check-browser-slots.ps1' }
if (-not $checker -or -not (Test-Path -LiteralPath $checker -PathType Leaf)) {
    Write-Host 'browser-watchdog: check-browser-slots.ps1 not found -- that script IS the health probe.' -ForegroundColor Red
    Write-Host 'Refusing to fall back to a TCP-accept test, which is the bug this file exists to fix (GH #197).' -ForegroundColor Red
    exit 2
}

if (-not $StatePath) {
    $stateDir = if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'overnight-agent' } else { $env:TEMP }
    $StatePath = Join-Path $stateDir 'browser-watchdog-state.json'
}

# ---------------------------------------------------------------------------
# Slots. From the one parser, or from an explicit override -- never a baked-in
# list. A silent fallback to a stale table is how #180's drift stayed invisible.
# ---------------------------------------------------------------------------
$slots = @()
if ($SlotSpec) {
    $slots = @(foreach ($spec in $SlotSpec) {
            $parts = $spec -split ':', 2
            [pscustomobject]@{
                Slot        = $(if ($parts.Count -gt 1 -and $parts[1]) { $parts[1] } else { "slot-$($parts[0])" })
                Port        = [int]$parts[0]
                ProfileDir  = $null
                ProfilePath = $null
                Shortcut    = "MCP slot (CDP $($parts[0]))"
                Account     = '(-SlotSpec)'
                Source      = '-SlotSpec override'
            }
        })
}
else {
    $lib = Find-OaScript 'browser-slot-table.ps1'
    if (-not $lib) {
        Write-Host 'browser-watchdog: browser-slot-table.ps1 not found; cannot determine which slots exist.' -ForegroundColor Red
        Write-Host 'Will not guess a slot list. Run sync-checks.ps1 -Restore -Confirm.' -ForegroundColor Red
        exit 2
    }
    . $lib
    try { $slots = @(Get-BrowserSlotTable -SettingsPath $SettingsPath) }
    catch {
        Write-Host "browser-watchdog: could not read the browser slot table. $($_.Exception.Message)" -ForegroundColor Red
        exit 2
    }
}

# ---------------------------------------------------------------------------
# The bounded health probe.
#
# check-browser-slots.ps1 already bounds its own per-target CDP work, but this
# file must not take that on trust: the whole point of GH #197's second
# criterion is that the watchdog cannot be hung by the thing it is inspecting.
# So the child process gets a hard wall-clock budget and is killed if it
# overruns, and an overrun is reported as `unknown` -- never as healthy.
# ---------------------------------------------------------------------------
function Get-SlotHealth {
    param([int]$Port, [string]$Name, [switch]$Repair)

    $outFile = [IO.Path]::GetTempFileName()
    $errFile = [IO.Path]::GetTempFileName()
    try {
        $argList = @(
            '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $checker,
            '-Json', '-ProbeTimeoutSec', $ProbeTimeoutSec,
            '-SlotSpec', "${Port}:$Name"
        )
        if ($Repair) { $argList += '-Repair' }

        $p = Start-Process -FilePath 'powershell' -ArgumentList $argList -PassThru -WindowStyle Hidden `
            -RedirectStandardOutput $outFile -RedirectStandardError $errFile
        if (-not $p.WaitForExit($ProbeBudgetSec * 1000)) {
            try { $p.Kill() } catch { }
            return [pscustomobject]@{ state = 'unknown'; healthy = $false; detail = "health probe exceeded ${ProbeBudgetSec}s budget and was killed"; raw = $null }
        }

        $text = [IO.File]::ReadAllText($outFile)
        # The checker emits a JSON ARRAY for several slots but a bare OBJECT for
        # one, and this always asks about one. So take whichever of `[` or `{`
        # opens first -- never just `[`, which matches a bracket inside a detail
        # string and slices the payload in half.
        $iArr = $text.IndexOf('[')
        $iObj = $text.IndexOf('{')
        $i = if ($iArr -ge 0 -and ($iObj -lt 0 -or $iArr -lt $iObj)) { $iArr } elseif ($iObj -ge 0) { $iObj } else { -1 }
        if ($i -lt 0) {
            return [pscustomobject]@{ state = 'unknown'; healthy = $false; detail = 'health probe returned no JSON'; raw = $null }
        }
        $rows = @($text.Substring($i) | ConvertFrom-Json)
        if ($rows.Count -lt 1) {
            return [pscustomobject]@{ state = 'unknown'; healthy = $false; detail = 'health probe returned an empty verdict'; raw = $null }
        }
        $r = $rows[0]
        return [pscustomobject]@{ state = $r.state; healthy = [bool]$r.healthy; detail = $r.detail; raw = $r }
    }
    catch {
        return [pscustomobject]@{ state = 'unknown'; healthy = $false; detail = "health probe failed: $($_.Exception.Message)"; raw = $null }
    }
    finally {
        Remove-Item $outFile, $errFile -Force -ErrorAction SilentlyContinue
    }
}

# ---------------------------------------------------------------------------
# Ownership veto. Recovery never fires on a slot ANOTHER run is driving.
#
# The operative word in that criterion is ANOTHER. A first cut of this vetoed on
# the mere PRESENCE of an attached MCP client, and measured against the live box
# it refused all three slots -- because a watchdog invoked by an agent run always
# sees that run's own MCP clients. A veto that never releases makes the whole
# recovery ladder unreachable: the guard against over-collection becomes a
# guarantee of under-collection, which is exactly the failure GH #200 had to fix
# in the reaper after the same mistake there.
#
# It is also wrong on the merits. The slot Shiv was using when it wedged is the
# one HIS run is attached to. Refusing to fix precisely that slot inverts the
# feature.
#
# So the question is not "is anything attached?" but "is a DIFFERENT, LIVE run
# attached?". Three ways a client stops counting:
#   * its owning session is this very run (an ancestor of this process) -- then
#     the caller is asking for its own slot back;
#   * its owning session is gone -- an orphan cannot be mid-operation;
#   * its owning session has been silent past -OwnerIdleMinutes -- the same
#     activity signal the reaper uses, because a wedged host is resident forever
#     while doing nothing.
#
# FAILS SAFE, ONE WAY ONLY: any client whose owner cannot be ATTRIBUTED at all
# vetoes. Missing evidence can spare a slot; it can never justify recovering one.
# ---------------------------------------------------------------------------
function Get-SelfAncestorPidSet {
    $set = @{}
    try {
        $cur = $PID
        for ($i = 0; $i -lt 12 -and $cur; $i++) {
            $set[[int]$cur] = $true
            $p = Get-CimInstance Win32_Process -Filter "ProcessId=$cur" -ErrorAction Stop
            if (-not $p -or -not $p.ParentProcessId) { break }
            $cur = [int]$p.ParentProcessId
        }
    }
    catch { }
    return $set
}

function Get-OwnerIdleMinutes {
    param([int]$OwnerPid)
    # The session appends to ~\.copilot\logs\process-<epoch>-<pid>.log while it
    # works. No log => cannot determine => caller treats it as active.
    try {
        $logDir = Join-Path $env:USERPROFILE '.copilot\logs'
        if (-not (Test-Path -LiteralPath $logDir)) { return $null }
        $log = Get-ChildItem $logDir -Filter "process-*-$OwnerPid.log" -File -ErrorAction Stop |
            Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if (-not $log) { return $null }
        return [int]((Get-Date) - $log.LastWriteTime).TotalMinutes
    }
    catch { return $null }
}

function Test-SlotInUse {
    param([int]$Port)
    try {
        $clients = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop |
                Where-Object {
                    $_.CommandLine -and
                    $_.CommandLine -match '(cdp-endpoint|cdpEndpoint|connect-over-cdp)' -and
                    $_.CommandLine -match "[:/]$Port(\b|/)"
                })
        if ($clients.Count -eq 0) { return $false }

        $self = Get-SelfAncestorPidSet
        foreach ($c in $clients) {
            # Walk up to the owning session host.
            $owner = $null
            $cur = [int]$c.ParentProcessId
            for ($i = 0; $i -lt 8 -and $cur; $i++) {
                $p = Get-CimInstance Win32_Process -Filter "ProcessId=$cur" -ErrorAction SilentlyContinue
                if (-not $p) { break }
                if ($p.Name -in $OwnerNames) { $owner = $p; break }
                $cur = [int]$p.ParentProcessId
            }

            if (-not $owner) {
                # Orphan, or unattributable. An orphan cannot be mid-operation,
                # but we cannot tell the two apart, so we spare the slot.
                return $true
            }
            if ($self.ContainsKey([int]$owner.ProcessId)) { continue }  # this run's own slot

            if ($OwnerIdleMinutes -gt 0) {
                $idle = Get-OwnerIdleMinutes -OwnerPid ([int]$owner.ProcessId)
                if ($null -ne $idle -and $idle -ge $OwnerIdleMinutes) { continue }  # wedged/silent owner
            }
            return $true   # a different, live run is driving this slot
        }
        return $false
    }
    catch {
        return $true
    }
}

# Identify the browser process serving this slot, and prove it belongs to the
# expected profile dir. Returning $null means "not positively identified", which
# the caller must treat as a refusal, never as permission.
function Get-SlotProcess {
    param([int]$Port, [string]$ProfilePath)
    try {
        $procs = @(Get-CimInstance Win32_Process -Filter "Name='msedge.exe' OR Name='chrome.exe'" -ErrorAction Stop |
                Where-Object { $_.CommandLine -match "remote-debugging-port=$Port(\b|\s|`")" })
        if ($procs.Count -ne 1) { return $null }
        $proc = $procs[0]
        if ($ProfilePath) {
            $needle = [regex]::Escape($ProfilePath.TrimEnd('\', '/'))
            if ($proc.CommandLine -notmatch "user-data-dir=`"?$needle") { return $null }
        }
        return $proc
    }
    catch { return $null }
}

# ---------------------------------------------------------------------------
# Legacy slot-list drift guard (GH #180 criterion 1).
#
# The old watchdog carried its own `config.json` slot array. That file cannot
# simply be deleted: `provision.ps1` and `detect-account.ps1` -- both of which
# also live outside this repo -- still read it, and rewriting two more
# un-versioned scripts to fix a versioning problem is not a fix.
#
# So the watchdog stops READING it, and starts CHECKING it. The two copies agree
# today, which is exactly what makes the drift dangerous rather than obvious:
# nothing in any pipeline would notice them diverging, and a recovery routine
# acting on a stale slot list could restart the WRONG profile -- the
# wrong-identity hazard #180 calls "worse than failing".
#
# This turns a silent second source of truth into a loud one.
# ---------------------------------------------------------------------------
function Test-LegacySlotDrift {
    param([object[]]$Slots)

    $legacy = $null
    foreach ($v in @($env:OneDrive, $env:OneDriveConsumer, $env:OneDriveCommercial)) {
        if (-not $v) { continue }
        $c = Join-Path $v 'skills\browser-watchdog\config.json'
        if (Test-Path -LiteralPath $c -PathType Leaf) { $legacy = $c; break }
    }
    if (-not $legacy) { return @() }

    try { $cfg = Get-Content $legacy -Raw | ConvertFrom-Json } catch { return @("legacy $legacy could not be parsed: $($_.Exception.Message)") }
    if (-not $cfg.slots) { return @() }

    $drift = @()
    $tableByPort = @{}
    foreach ($s in $Slots) { $tableByPort[[int]$s.Port] = $s }

    foreach ($ls in $cfg.slots) {
        $lp = [int]$ls.port
        if (-not $tableByPort.ContainsKey($lp)) {
            $drift += "legacy config.json still lists port $lp ($($ls.mcp)/$($ls.profile)), which is not in the user-settings.md table"
            continue
        }
        $t = $tableByPort[$lp]
        if ($ls.profile -and $t.ProfileDir -and $ls.profile -ne $t.ProfileDir) {
            $drift += "port $lp maps to profile '$($ls.profile)' in legacy config.json but '$($t.ProfileDir)' in user-settings.md -- a recovery could restart the wrong identity"
        }
    }
    foreach ($p in $tableByPort.Keys) {
        if (-not (@($cfg.slots | ForEach-Object { [int]$_.port }) -contains $p)) {
            $drift += "user-settings.md defines port $p but legacy config.json does not; the provision phase would not create it"
        }
    }
    return $drift
}

# Is the destructive rung SAFE to take? Extracted so that -WhatIf predicts what
# would really happen rather than assuming success -- which also makes the guard
# testable without any process ever being killed.
#
# Both answers are refusals unless proven otherwise. A restart is permitted only
# when the profile dir is on disk (so it can be reused, so the sign-in survives)
# AND exactly one browser process is positively matched to BOTH this port and
# that profile dir. Anything else means we cannot say which window we would be
# killing, and killing the wrong signed-in window costs a manual re-login.
function Test-RestartSafe {
    param([object]$Slot)
    if (-not $Slot.ProfilePath -or -not (Test-Path -LiteralPath $Slot.ProfilePath)) {
        return [pscustomobject]@{
            ok     = $false
            reason = 'profile dir is not on disk, so a restart could not reuse it and the sign-in would be lost. Refusing.'
            proc   = $null
        }
    }
    $proc = Get-SlotProcess -Port ([int]$Slot.Port) -ProfilePath $Slot.ProfilePath
    if (-not $proc) {
        return [pscustomobject]@{
            ok     = $false
            reason = 'could not positively identify one browser process owning this port AND this profile dir. Refusing to kill a process that might be another slot or another window.'
            proc   = $null
        }
    }
    return [pscustomobject]@{ ok = $true; reason = 'ok'; proc = $proc }
}

function Close-WedgedTarget {
    param([int]$Port, [string]$TargetId)
    try {
        Invoke-WebRequest -Uri "http://127.0.0.1:$Port/json/close/$TargetId" -TimeoutSec 5 -UseBasicParsing | Out-Null
        return $true
    }
    catch { return $false }
}

# --- state: consecutive stuck runs, per slot -------------------------------
$state = @{}
if (Test-Path -LiteralPath $StatePath) {
    try {
        $loaded = Get-Content $StatePath -Raw | ConvertFrom-Json
        foreach ($p in $loaded.PSObject.Properties) { $state[$p.Name] = [int]$p.Value }
    }
    catch { $state = @{} }
}

$results = @()
$escalations = @()

if (-not $SlotSpec -and -not $SettingsPath) {
    foreach ($d in (Test-LegacySlotDrift -Slots $slots)) {
        Note "SLOT TABLE DRIFT: $d" 'Red'
        $escalations += "slot table drift: $d"
    }
}

foreach ($s in $slots) {
    $name = $s.Slot
    $port = [int]$s.Port
    $row = [ordered]@{
        slot = $name; port = $port; account = $s.Account; profile_dir = $s.ProfileDir
        verdict = 'unknown'; action = 'none'; recovered = $false
        stuck_runs = 0; detail = ''; shortcut = $s.Shortcut
    }

    $h = Get-SlotHealth -Port $port -Name $name
    $row.verdict = $h.state
    $row.detail = $h.detail

    # ---- healthy: leave completely alone -----------------------------------
    if ($h.healthy) {
        $row.action = 'already-up'
        $state.Remove($name) | Out-Null
        Note "[$name :$port] healthy - reusing untouched." 'Green'
        $results += [pscustomobject]$row
        continue
    }

    # ---- unknown: report, touch nothing ------------------------------------
    if ($h.state -eq 'unknown') {
        $row.action = 'probe-failed'
        Note "[$name :$port] health UNKNOWN - $($h.detail). Taking no action." 'Yellow'
        $escalations += "[$name :$port] health could not be determined: $($h.detail)"
        $results += [pscustomobject]$row
        continue
    }

    # ---- down: launch (the one thing the old watchdog did right) -----------
    if ($h.state -eq 'down') {
        $state.Remove($name) | Out-Null
        if ($SlotSpec) {
            $row.action = 'refused-no-profile'
            $row.detail = 'slot supplied by -SlotSpec has no profile dir; refusing to invent one (GH #180)'
            Note "[$name :$port] DOWN, but -SlotSpec carries no profile - refusing to launch." 'Yellow'
        }
        elseif ($WhatIf) {
            $row.action = 'would-launch'
            Note "[$name :$port] DOWN - would launch (WhatIf)." 'Cyan'
        }
        elseif (-not $s.ProfilePath -or -not (Test-Path -LiteralPath $s.ProfilePath)) {
            $row.action = 'MISSING-PROFILE'
            $row.detail = "profile missing: $($s.ProfilePath) - run the provision phase"
            Note "[$name :$port] profile missing: $($s.ProfilePath)" 'Red'
            $escalations += "[$name :$port] profile dir missing ($($s.ProfilePath)); cannot launch."
        }
        else {
            $exe = @(
                "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
                "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
            ) | Where-Object { Test-Path $_ } | Select-Object -First 1
            if (-not $exe) {
                $row.action = 'MISSING-BROWSER'
                $escalations += "[$name :$port] msedge.exe not found; cannot launch."
            }
            else {
                Note "[$name :$port] DOWN - launching." 'Cyan'
                Start-Process -FilePath $exe -ArgumentList @(
                    "--user-data-dir=`"$($s.ProfilePath)`"", "--remote-debugging-port=$port",
                    '--no-first-run', '--no-default-browser-check', 'about:blank'
                ) -WorkingDirectory (Split-Path $exe) | Out-Null
                $row.action = 'launched'
                # Confirm it actually came up healthy before handing it back.
                for ($i = 0; $i -lt 8; $i++) {
                    Start-Sleep -Seconds 2
                    $re = Get-SlotHealth -Port $port -Name $name
                    if ($re.healthy) { $row.recovered = $true; break }
                }
                if (-not $row.recovered) { $escalations += "[$name :$port] launched but did not come up healthy." }
            }
        }
        $results += [pscustomobject]$row
        continue
    }

    # ======================================================================
    # stuck: the case the old watchdog could not even see.
    # ======================================================================
    $streak = 1 + $(if ($state.ContainsKey($name)) { [int]$state[$name] } else { 0 })
    $state[$name] = $streak
    $row.stuck_runs = $streak

    if ($NoRecover) {
        $row.action = 'stuck-no-recover'
        Note "[$name :$port] STUCK (run $streak) - recovery disabled." 'Yellow'
        $escalations += "[$name :$port] stuck; recovery disabled by -NoRecover."
        $results += [pscustomobject]$row
        continue
    }

    # -- CONFIRM. One failed probe is a slow moment, not a verdict. ----------
    Start-Sleep -Seconds $ConfirmDelaySec
    $confirm = Get-SlotHealth -Port $port -Name $name
    if ($confirm.healthy) {
        $row.verdict = 'transient'
        $row.action = 'no-action-transient'
        $row.detail = 'first probe failed, confirmation probe passed - not treated as stuck'
        $state.Remove($name) | Out-Null
        Note "[$name :$port] first probe failed, confirm passed - transient, leaving alone." 'Green'
        $results += [pscustomobject]$row
        continue
    }

    # -- OWNERSHIP VETO -----------------------------------------------------
    if (Test-SlotInUse -Port $port) {
        $row.action = 'refused-in-use'
        $row.detail = 'a live MCP client is attached to this slot; refusing to recover a slot another run is driving'
        Note "[$name :$port] STUCK but IN USE - refusing to recover." 'Yellow'
        $escalations += "[$name :$port] stuck, but a live MCP client is attached. Refused to recover; a run may be mid-operation."
        $results += [pscustomobject]$row
        continue
    }

    if ($WhatIf) {
        if ($streak -ge $RestartAfterRuns) {
            $safe = Test-RestartSafe -Slot $s
            if ($safe.ok) {
                $row.action = 'would-restart'
            }
            else {
                $row.action = 'refused-unsafe-restart'
                $row.detail = $safe.reason
            }
        }
        else {
            $row.action = 'would-thaw'
        }
        Note "[$name :$port] STUCK (run $streak) - $($row.action) (WhatIf)." 'Cyan'
        $results += [pscustomobject]$row
        continue
    }

    # -- RUNG 1: thaw in place. Nothing is closed; the sign-in cannot move. --
    Note "[$name :$port] STUCK (run $streak) - rung 1: thawing frozen page(s) in place." 'Cyan'
    $afterThaw = Get-SlotHealth -Port $port -Name $name -Repair
    if ($afterThaw.healthy) {
        $row.action = 'recovered-thaw'; $row.recovered = $true; $row.verdict = 'stuck'
        $row.detail = 'thawed the frozen page in place; re-probed healthy. Nothing was closed.'
        $state.Remove($name) | Out-Null
        Note "[$name :$port] RECOVERED by thaw - re-probed healthy." 'Green'
        $results += [pscustomobject]$row
        continue
    }

    # -- RUNG 2: close the wedged TARGET. A tab, not the window. -------------
    $closed = 0
    $wedgedTargets = @()
    if ($afterThaw.raw -and $afterThaw.raw.wedged_targets) { $wedgedTargets = @($afterThaw.raw.wedged_targets) }
    elseif ($h.raw -and $h.raw.wedged_targets) { $wedgedTargets = @($h.raw.wedged_targets) }

    if ($wedgedTargets.Count -gt 0) {
        Note "[$name :$port] rung 2: closing $($wedgedTargets.Count) wedged target(s)." 'Cyan'
        foreach ($t in $wedgedTargets) { if ($t.id -and (Close-WedgedTarget -Port $port -TargetId $t.id)) { $closed++ } }
        if ($closed -gt 0) {
            Start-Sleep -Seconds 2
            $afterClose = Get-SlotHealth -Port $port -Name $name
            if ($afterClose.healthy) {
                $row.action = 'recovered-close-target'; $row.recovered = $true
                $row.detail = "closed $closed wedged tab(s); re-probed healthy. The window and the sign-in were untouched."
                $state.Remove($name) | Out-Null
                Note "[$name :$port] RECOVERED by closing $closed wedged tab(s)." 'Green'
                $results += [pscustomobject]$row
                continue
            }
        }
    }

    # -- RUNG 3: restart the process. The only rung that can cost a re-login,
    #    so it carries every guard: a run-streak, a positive identification of
    #    the process against THIS slot's profile dir, and an existing profile.
    if ($streak -lt $RestartAfterRuns) {
        $row.action = 'stuck-awaiting-confirmation'
        $row.detail = "still stuck after thaw and closing $closed tab(s). Restart needs $RestartAfterRuns consecutive stuck runs; this is run $streak."
        Note "[$name :$port] still stuck; holding restart until run $RestartAfterRuns." 'Yellow'
        $escalations += "[$name :$port] stuck and the cheap repairs did not work. Holding the process restart until run $RestartAfterRuns of $RestartAfterRuns."
        $results += [pscustomobject]$row
        continue
    }

    $safe = Test-RestartSafe -Slot $s
    if (-not $safe.ok) {
        $row.action = 'refused-unsafe-restart'
        $row.detail = $safe.reason
        Note "[$name :$port] REFUSING restart - $($safe.reason)" 'Red'
        $escalations += "[$name :$port] stuck, but a restart was refused as unsafe: $($safe.reason)"
        $results += [pscustomobject]$row
        continue
    }
    $proc = $safe.proc

    Note "[$name :$port] rung 3: restarting pid $($proc.ProcessId) (same profile dir, sign-in preserved)." 'Cyan'
    try { Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop } catch {
        $row.action = 'restart-failed'
        $row.detail = "could not stop pid $($proc.ProcessId): $($_.Exception.Message)"
        $escalations += "[$name :$port] stuck and the browser process could not be stopped: $($_.Exception.Message)"
        $results += [pscustomobject]$row
        continue
    }
    Start-Sleep -Seconds 3

    $exe = @(
        "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
        "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
    ) | Where-Object { Test-Path $_ } | Select-Object -First 1
    Start-Process -FilePath $exe -ArgumentList @(
        "--user-data-dir=`"$($s.ProfilePath)`"", "--remote-debugging-port=$port",
        '--no-first-run', '--no-default-browser-check', 'about:blank'
    ) -WorkingDirectory (Split-Path $exe) | Out-Null

    for ($i = 0; $i -lt 8; $i++) {
        Start-Sleep -Seconds 2
        $re = Get-SlotHealth -Port $port -Name $name
        if ($re.healthy) { $row.recovered = $true; break }
    }

    if ($row.recovered) {
        $row.action = 'recovered-restart'
        $row.detail = 'restarted the browser on the same profile dir; re-probed healthy. Sign-in preserved.'
        $state.Remove($name) | Out-Null
        Note "[$name :$port] RECOVERED by restart - re-probed healthy." 'Green'

        # Restarting strands the MCP servers that were attached to the old
        # process. The collector for that already exists; call it, do not
        # reimplement its ownership veto here (GH #177/#178).
        if (-not $NoReap) {
            $reaper = Find-OaScript 'reap-stale-mcp.ps1'
            if ($reaper) {
                Note "[$name :$port] reaping MCP servers stranded by the restart." 'DarkGray'
                try { & powershell -NoProfile -ExecutionPolicy Bypass -File $reaper -Confirm 2>&1 | Out-Null } catch { }
            }
        }
    }
    else {
        $row.action = 'UNRECOVERED'
        $row.detail = 'restarted the browser but it did not come back healthy.'
        $escalations += "[$name :$port] stuck, and a full restart did NOT bring it back. This needs a human."
    }

    $results += [pscustomobject]$row
}

# --- persist the streaks ---------------------------------------------------
try {
    $dir = Split-Path -Parent $StatePath
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    ($state | ConvertTo-Json -Depth 3) | Set-Content -LiteralPath $StatePath -Encoding UTF8
}
catch { }

# --- report ----------------------------------------------------------------
if ($Json) {
    $results | ConvertTo-Json -Depth 5
}
else {
    $results | Format-Table slot, port, account, verdict, action, recovered, stuck_runs -AutoSize | Out-String | Write-Host
    if ($slots.Count -gt 0 -and $slots[0].Source) { Note "slot table: $($slots[0].Source)" 'DarkGray' }
}

# --- escalate rather than retry silently (GH #197 criterion 9) -------------
if ($escalations.Count -gt 0 -and -not $Json) {
    Write-Host ''
    Write-Host '=== NEEDS SHIV =======================================================' -ForegroundColor Yellow
    foreach ($e in $escalations) { Write-Host "  $e" -ForegroundColor Yellow }
    Write-Host '  A stuck slot that cannot be recovered is a question, not a retry.' -ForegroundColor DarkGray
    Write-Host '======================================================================' -ForegroundColor Yellow
}

$stuckBad = @($results | Where-Object { $_.verdict -in @('stuck', 'unknown') -and -not $_.recovered })
$downBad = @($results | Where-Object { $_.verdict -eq 'down' -and -not $_.recovered -and $_.action -notin @('would-launch', 'refused-no-profile') })

if ($stuckBad.Count -gt 0) { exit 2 }
if ($downBad.Count -gt 0) { exit 1 }
exit 0
