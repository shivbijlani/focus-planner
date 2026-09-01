<#
.SYNOPSIS
  Health-check the Playwright MCP CDP browser slots before a run uses them.

.DESCRIPTION
  Catches the "zombie slot" failure class found on 2026-08-24: a slot whose
  browser process is still answering CDP but has msedge.dll loaded from an
  OLD Edge version directory (because Edge auto-updated underneath it). Such a
  slot looks healthy -- the port is open, /json/version answers, existing tabs
  still render -- but EVERY new tab dies instantly with "Target crashed", so
  any automation that opens a page silently fails.

  Detection is a version comparison: the build the slot reports at
  /json/version vs the build of the installed msedge.exe on disk. A mismatch
  means the slot is pinned to a stale version dir and must be relaunched.

  ALSO catches the "wedged slot" failure class (GH #197), where a slot answers
  every HTTP probe -- port open, /json/version answers, /json/list returns
  pages -- while its EXISTING pages are in Chrome's frozen lifecycle state:
  sync JS still evaluates, but timers and rAF never fire, so any evaluate that
  awaits a promise never returns. Because the Playwright MCP attaches by
  enumerating every page in the profile, ONE frozen page times out the whole
  slot, and the slot is unusable while looking perfectly healthy here.

  Detection is a bounded CDP WORK probe: for each existing page target, run
  Runtime.evaluate on a promise that resolves from a timer, with a hard budget.
  A page that cannot resolve it is frozen, and the slot is reported 'stuck'.

  The probe deliberately runs against the slot's EXISTING pages rather than a
  freshly created one. A new target is never frozen -- the frozen lifecycle
  only affects already-open, occluded tabs -- so a fresh-tab probe reports
  every wedged slot as healthy. That false negative is the bug, not a detail.

  Read-only by default. Never kills or launches a browser -- the MCP slots are
  the user's windows and may hold in-flight state. -Repair opts in to the one
  cheap, non-destructive repair (Page.setWebLifecycleState -> 'active'), which
  thaws a frozen page in place without closing it or touching the process.

  THE SLOT LIST IS NOT IN THIS FILE (GH #180).
  It is read from the `## Browser slots` table in `user-settings.md`, which
  declares itself the source of truth. Before this change the list was hardcoded
  here -- all six ports, including the three (9222/9226/9227) retired when the
  table moved -- and this file contained zero occurrences of "user-settings".
  A preflight that reports on slots nobody uses trains the reader to ignore it.

  NOTE ON RESOLUTION: this script is installed into the FLAT OA home
  (`%LOCALAPPDATA%\overnight-agent\`), which has no `user-settings.md` and no
  `SKILL.md` beside it. So the settings file is resolved by search order, never
  assumed to be a sibling. Assuming a sibling is what made PR #303 green and
  still broken (#305).

.PARAMETER Json
  Emit a JSON array instead of the human-readable table.

.PARAMETER SettingsPath
  Override the resolved `user-settings.md`. Used by the mutation check so it can
  point at a fixture table without touching live state.

.PARAMETER NoProbe
  Skip the CDP work probe and report on the HTTP/version signals only. Restores
  the pre-#197 behaviour; useful when something else is already driving a slot.

.PARAMETER ProbeTimeoutSec
  Per-target budget for the work probe. Bounded so the probe can never hang the
  caller -- the whole point of GH #197's second success criterion.

.PARAMETER MaxProbeTargets
  Cap on how many page targets are probed per slot. The probe short-circuits on
  the first frozen page, so this only bounds the healthy case.

.PARAMETER Repair
  Opt in to thawing frozen pages via Page.setWebLifecycleState -> 'active',
  then re-probe and report the post-repair verdict. Off by default: recovery
  must be a deliberate, evidenced action, never a silent side effect.

.PARAMETER SlotSpec
  Override the slot table, as 'port:name' entries (e.g. '9225:edge-cdp-1').
  Exists so the mutation check can point the script at fixture CDP servers
  instead of the user's real browsers.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File check-browser-slots.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File check-browser-slots.ps1 -Json
  powershell -NoProfile -ExecutionPolicy Bypass -File check-browser-slots.ps1 -Repair

.NOTES
  Exit codes: 0 = every running slot is healthy. 2 = attention needed -- either a
  zombie slot, a wedged slot, or the slot table could not be read (in which case
  the preflight cannot answer its own question, which is emphatically not "ok").

  The exit code is IDENTICAL in -Json and human mode. It is derived from the same
  verdict, computed once before the output branch, because the output format is a
  question about presentation and the exit code is a question about the browsers.
  Pinned by arms B2/A2/M5 of mutcheck-browser-slot-probe.ps1.
#>
[CmdletBinding()]
param(
    [switch]$Json,
    [string]$SettingsPath,
    [switch]$NoProbe,
    [int]$ProbeTimeoutSec = 6,
    [int]$MaxProbeTargets = 6,
    [switch]$Repair,
    [string[]]$SlotSpec
)

$ErrorActionPreference = 'Stop'

# --- locate the ONE slot-table parser --------------------------------------
# This is a SEARCH for the shared parser, not a second copy of it. The two
# install locations hold different file sets, so the library cannot be assumed
# to sit next to whichever consumer is running.
#
# Skipped entirely under -SlotSpec: that switch supplies the slots directly, so
# the parser is never called, and requiring it would make an explicit override
# depend on machinery it does not use. (It also made the mutation check
# unrunnable, because a mutant copy lives in a temp dir with no library beside
# it -- the script exited 2 before emitting any JSON, and every arm read back an
# empty verdict, control included.)
$slotLib = $null
if (-not $SlotSpec) {
    foreach ($cand in @(
            ([IO.Path]::Combine($PSScriptRoot, 'browser-slot-table.ps1'))
            ([IO.Path]::Combine($PSScriptRoot, '..', '..', 'checks', 'browser-slot-table.ps1'))
            ([IO.Path]::Combine($PSScriptRoot, '..', 'checks', 'browser-slot-table.ps1'))
            $(if ($env:LOCALAPPDATA) { [IO.Path]::Combine($env:LOCALAPPDATA, 'overnight-agent', 'browser-slot-table.ps1') })
            $(if ($env:USERPROFILE) { [IO.Path]::Combine($env:USERPROFILE, '.copilot', 'installed-plugins', 'focus-planner', 'overnight-agent', 'checks', 'browser-slot-table.ps1') })
        )) {
        if ($cand -and (Test-Path -LiteralPath $cand -PathType Leaf)) {
            $slotLib = (Resolve-Path -LiteralPath $cand).Path
            break
        }
    }
    if (-not $slotLib) {
        Write-Host 'check-browser-slots: browser-slot-table.ps1 not found next to this script, in the OA home, or in installed-plugins.' -ForegroundColor Red
        Write-Host 'Cannot determine which slots exist, and will not guess. Run sync-checks.ps1 -Restore -Confirm.' -ForegroundColor Red
        exit 2
    }
    . $slotLib
}

# --- read the table --------------------------------------------------------
# No baked-in fallback on purpose: a preflight that silently reverts to a stale
# list is how the drift this fixes stayed invisible.
#
# -SlotSpec is the one exception, and it is an EXPLICIT caller override rather
# than a fallback: it must therefore bypass the settings read entirely. Reading
# the table first and overriding afterwards looks equivalent and is not -- the
# catch below exits 2, so a caller that supplied its own slots (the mutation
# check, pointing at fixture CDP servers) died on an unreadable live settings
# file it was never going to consult.
if ($SlotSpec) {
    $slots = @(foreach ($spec in $SlotSpec) {
        $parts = $spec -split ':', 2
        @{
            Port     = [int]$parts[0]
            Slot     = if ($parts.Count -gt 1 -and $parts[1]) { $parts[1] } else { "slot-$($parts[0])" }
            Shortcut = "MCP slot (CDP $($parts[0]))"
            Account  = '(-SlotSpec)'
            Source   = '-SlotSpec override'
        }
    })
}
else {
    try {
        $slots = @(Get-BrowserSlotTable -SettingsPath $SettingsPath)
    }
    catch {
        $msg = $_.Exception.Message
        if ($Json) {
            @([pscustomobject]@{
                    port = $null; mcp = $null; state = 'error'; healthy = $false
                    detail = "slot table unreadable: $msg"
                }) | ConvertTo-Json -Depth 4
        }
        else {
            Write-Host 'check-browser-slots: could not read the browser slot table.' -ForegroundColor Red
            Write-Host "  $msg" -ForegroundColor Red
            Write-Host '  The slot list lives in user-settings.md under "## Browser slots".' -ForegroundColor DarkGray
        }
        exit 2
    }
}

function Get-InstalledBuild {
    param([string]$Product)
    $candidates = if ($Product -eq 'chrome') {
        @(
            "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
            "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe"
        )
    } else {
        @(
            "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
            "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
        )
    }
    foreach ($c in $candidates) {
        if (Test-Path $c) { return (Get-Item $c).VersionInfo.ProductVersion }
    }
    return $null
}

$installed = @{
    edge   = Get-InstalledBuild -Product 'edge'
    chrome = Get-InstalledBuild -Product 'chrome'
}

# Map listening port -> the msedge.dll/chrome.dll version actually loaded in memory.
# This is the ground truth; /json/version is the cheap proxy for it.
$loadedByPort = @{}
try {
    $procs = Get-CimInstance Win32_Process -Filter "Name='msedge.exe' OR Name='chrome.exe'" |
        Where-Object { $_.CommandLine -match 'remote-debugging-port=(\d+)' }
    foreach ($cp in $procs) {
        if ($cp.CommandLine -notmatch 'remote-debugging-port=(\d+)') { continue }
        $port = [int]$Matches[1]
        if ($loadedByPort.ContainsKey($port)) { continue }
        $proc = Get-Process -Id $cp.ProcessId -ErrorAction SilentlyContinue
        if (-not $proc) { continue }
        $core = $proc.Modules |
            Where-Object { $_.ModuleName -in @('msedge.dll', 'chrome.dll') } |
            Select-Object -First 1
        if ($core) {
            $loadedByPort[$port] = [pscustomobject]@{
                Pid     = $cp.ProcessId
                Path    = $core.FileName
                Version = $core.FileVersionInfo.ProductVersion
            }
        }
    }
} catch {
    Write-Verbose "module walk unavailable: $($_.Exception.Message)"
}

# ---------------------------------------------------------------------------
# Bounded CDP work probe (GH #197).
#
# TCP-accept is liveness, not health. So is an HTTP 200 from /json/version --
# those are served by the browser process, not by the renderer whose task queue
# is actually frozen. The only signal that distinguishes a usable slot from a
# wedged one is whether a renderer can still COMPLETE work, so we ask it to.
#
# The probe awaits a promise resolved by a timer. That is deliberate: in the
# frozen lifecycle state sync JS still evaluates, so a plain `1+1` returns fine
# and proves nothing. Timers are precisely what stops firing.
# ---------------------------------------------------------------------------
function Invoke-CdpCommand {
    param(
        [string]$WsUrl,
        [string]$Method,
        [hashtable]$Params = @{},
        [int]$TimeoutSec = 6,
        [switch]$AwaitPromise,
        [string]$Expression
    )

    $result = [pscustomobject]@{ ok = $false; reason = 'unknown'; value = $null }
    $ws  = $null
    $cts = $null
    try {
        $ws  = New-Object System.Net.WebSockets.ClientWebSocket
        $cts = New-Object System.Threading.CancellationTokenSource
        $cts.CancelAfter([TimeSpan]::FromSeconds($TimeoutSec))

        $connect = $ws.ConnectAsync([Uri]$WsUrl, $cts.Token)
        try {
            if (-not $connect.Wait([TimeSpan]::FromSeconds($TimeoutSec))) {
                $result.reason = 'ws-connect-timeout'; return $result
            }
        } catch {
            $result.reason = 'ws-connect-failed'; return $result
        }
        if ($connect.IsFaulted) { $result.reason = 'ws-connect-failed'; return $result }

        $payload = @{ id = 1; method = $Method }
        if ($Expression) {
            $payload.params = @{
                expression     = $Expression
                returnByValue  = $true
                awaitPromise   = [bool]$AwaitPromise
            }
        } elseif ($Params.Count -gt 0) {
            $payload.params = $Params
        }
        $json  = $payload | ConvertTo-Json -Depth 6 -Compress
        $bytes = [Text.Encoding]::UTF8.GetBytes($json)
        $seg   = New-Object System.ArraySegment[byte] (,$bytes)

        $send = $ws.SendAsync($seg, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, $cts.Token)
        try {
            if (-not $send.Wait([TimeSpan]::FromSeconds($TimeoutSec))) {
                $result.reason = 'ws-send-timeout'; return $result
            }
        } catch {
            $result.reason = 'ws-send-timeout'; return $result
        }

        # Read until our id comes back, or the budget expires. CDP interleaves
        # unsolicited events, so a single receive is not enough.
        $deadline = (Get-Date).AddSeconds($TimeoutSec)
        $buffer   = New-Object byte[] 65536
        while ((Get-Date) -lt $deadline) {
            $remaining = [int][Math]::Ceiling(($deadline - (Get-Date)).TotalSeconds)
            if ($remaining -le 0) { break }

            $recvSeg = New-Object System.ArraySegment[byte] (,$buffer)
            $recv    = $ws.ReceiveAsync($recvSeg, $cts.Token)
            try {
                if (-not $recv.Wait([TimeSpan]::FromSeconds($remaining))) {
                    $result.reason = 'no-response'; return $result
                }
            } catch {
                # A cancelled/faulted receive is the frozen-renderer signature:
                # the socket is fine, the renderer just never answers.
                $result.reason = 'no-response'; return $result
            }
            if ($recv.IsFaulted) { $result.reason = 'no-response'; return $result }

            $text = [Text.Encoding]::UTF8.GetString($buffer, 0, $recv.Result.Count)
            if (-not $text) { continue }

            $msg = $null
            try { $msg = $text | ConvertFrom-Json } catch { continue }
            if ($null -eq $msg.id -or [int]$msg.id -ne 1) { continue }

            if ($msg.PSObject.Properties.Name -contains 'error' -and $msg.error) {
                $result.reason = 'cdp-error'; return $result
            }
            $result.ok     = $true
            $result.reason = 'ok'
            $result.value  = $msg.result
            return $result
        }
        $result.reason = 'no-response'
        return $result
    } catch {
        $result.reason = "probe-exception: $($_.Exception.Message)"
        return $result
    } finally {
        if ($ws) { try { $ws.Abort() } catch { }; try { $ws.Dispose() } catch { } }
        if ($cts) { try { $cts.Dispose() } catch { } }
    }
}

function Test-CdpTargetLive {
    param([string]$WsUrl, [int]$TimeoutSec = 6)
    # A timer-backed promise: frozen renderers never resolve this, live ones
    # resolve it in ~120ms.
    return Invoke-CdpCommand -WsUrl $WsUrl -Method 'Runtime.evaluate' `
        -Expression "new Promise(function(r){setTimeout(function(){r('oa-live')},120)})" `
        -AwaitPromise -TimeoutSec $TimeoutSec
}

function Invoke-CdpThaw {
    param([string]$WsUrl, [int]$TimeoutSec = 6)
    # The cheap repair: un-freeze the page in place. Far less invasive than
    # closing the tab or restarting the user's signed-in window.
    return Invoke-CdpCommand -WsUrl $WsUrl -Method 'Page.setWebLifecycleState' `
        -Params @{ state = 'active' } -TimeoutSec $TimeoutSec
}

$results = foreach ($slot in $slots) {
    $port = $slot.Port
    $row = [ordered]@{
        port           = $port
        mcp            = $slot.Slot
        account        = $slot.Account
        profile_dir    = $slot.ProfileDir
        state          = 'down'
        reported       = $null
        installed      = $null
        loaded_dll     = $null
        pages          = $null
        probed         = 0
        wedged         = 0
        wedged_targets = @()
        repaired       = 0
        healthy        = $false
        detail         = "no CDP listener - launch on demand with ensure-mcp-browsers.ps1 -Slot $($slot.Slot), or open '$($slot.Shortcut)'"
        shortcut       = $slot.Shortcut
    }

    $version = $null
    try {
        $version = (Invoke-WebRequest -Uri "http://127.0.0.1:$port/json/version" `
            -TimeoutSec 4 -UseBasicParsing).Content | ConvertFrom-Json
    } catch {
        [pscustomobject]$row
        continue
    }

    $browser = $version.Browser                       # e.g. "Edg/151.0.4129.93"
    $product = if ($browser -match '^Chrome/') { 'chrome' } else { 'edge' }
    $reportedBuild = if ($browser -match '([\d]+\.[\d]+\.[\d]+\.[\d]+)') { $Matches[1] } else { $null }
    $installedBuild = $installed[$product]

    $row.state     = 'up'
    $row.reported  = $reportedBuild
    $row.installed = $installedBuild
    if ($loadedByPort.ContainsKey($port)) { $row.loaded_dll = $loadedByPort[$port].Path }

    $pageTargets = @()
    try {
        $targets = (Invoke-WebRequest -Uri "http://127.0.0.1:$port/json/list" `
            -TimeoutSec 5 -UseBasicParsing).Content | ConvertFrom-Json
        $pageTargets = @($targets | Where-Object { $_.type -eq 'page' })
        $row.pages = $pageTargets.Count
    } catch {
        $row.pages = -1
    }

    if ($reportedBuild -and $installedBuild -and $reportedBuild -ne $installedBuild) {
        $row.healthy = $false
        $row.detail  = "ZOMBIE: running $reportedBuild but $product on disk is $installedBuild. " +
                       "The browser survived an auto-update and is pinned to a stale version dir, " +
                       "so every NEW tab will die with 'Target crashed' while old tabs keep working. " +
                       "Fix: close this window and reopen '$($slot.Shortcut)'. Sign-ins persist " +
                       "(the profile dir is unchanged)."
        [pscustomobject]$row
        continue
    }

    # ---- bounded CDP work probe (GH #197) --------------------------------
    # Everything above this line is answered by the browser process. A frozen
    # RENDERER passes all of it, which is why a slot can be reported healthy
    # while every real operation against it times out.
    if ($NoProbe -or $pageTargets.Count -eq 0) {
        $row.healthy = $true
        $row.detail  = if ($NoProbe) { 'ok (work probe skipped)' } else { 'ok (no pages to probe)' }
        [pscustomobject]$row
        continue
    }

    $wedged = @()
    foreach ($t in ($pageTargets | Select-Object -First $MaxProbeTargets)) {
        if (-not $t.webSocketDebuggerUrl) { continue }
        $row.probed++
        $live = Test-CdpTargetLive -WsUrl $t.webSocketDebuggerUrl -TimeoutSec $ProbeTimeoutSec
        if (-not $live.ok) {
            $wedged += [pscustomobject]@{
                id     = $t.id
                url    = $t.url
                title  = $t.title
                reason = $live.reason
            }
            break   # one frozen page is enough to sink the slot; stop paying for more
        }
    }

    if ($Repair -and $wedged.Count -gt 0) {
        $stillWedged = @()
        foreach ($w in $wedged) {
            $t = $pageTargets | Where-Object { $_.id -eq $w.id } | Select-Object -First 1
            if (-not $t) { $stillWedged += $w; continue }
            Invoke-CdpThaw -WsUrl $t.webSocketDebuggerUrl -TimeoutSec $ProbeTimeoutSec | Out-Null
            $recheck = Test-CdpTargetLive -WsUrl $t.webSocketDebuggerUrl -TimeoutSec $ProbeTimeoutSec
            if ($recheck.ok) { $row.repaired++ } else { $stillWedged += $w }
        }
        $wedged = $stillWedged
    }

    $row.wedged         = $wedged.Count
    $row.wedged_targets = @($wedged)

    if ($wedged.Count -gt 0) {
        $row.state   = 'stuck'
        $row.healthy = $false
        $first = $wedged[0]
        $row.detail  = "STUCK: the port answers and /json/list returns $($row.pages) page(s), but " +
                       "$($wedged.Count) of the $($row.probed) probed could not complete a timer-backed " +
                       "evaluate within ${ProbeTimeoutSec}s ($($first.reason)) -- the page is in the frozen " +
                       "lifecycle state. Because the Playwright MCP enumerates every page on attach, ONE " +
                       "frozen page makes the WHOLE slot unusable while every HTTP probe still says 'up'. " +
                       "First frozen target: $($first.id) <$($first.url)>. " +
                       "Fix: re-run with -Repair to thaw it in place, or close that tab. Raw-CDP tools that " +
                       "open their own fresh target (cdp-read.mjs / cdp-eval.mjs) keep working meanwhile."
    } else {
        $row.healthy = $true
        $row.detail  = if ($row.repaired -gt 0) {
            "ok (thawed $($row.repaired) frozen page(s), re-probed live)"
        } else {
            "ok (work probe passed on $($row.probed) page(s))"
        }
    }

    [pscustomobject]$row
}

# THE VERDICT IS COMPUTED ONCE, BEFORE THE OUTPUT-FORMAT BRANCH (GH #197).
#
# It used to be computed only on the human path, and `-Json` did an
# unconditional `exit 0`. So the two modes answered DIFFERENT questions from
# identical data: measured live on 2026-09-01 with all three of the user's
# slots wedged, the human path exited 2 and `-Json` exited 0 -- while its own
# JSON body carried `"state": "stuck", "healthy": false` for every slot.
#
# That is this issue's own failure class, one layer up: a check reporting
# health it has already disproven. And it lands in the mode that matters most,
# because `-Json` is what an automated caller uses -- a watchdog or CI step
# gating on the exit code was told "all healthy" while nothing could run.
# How a caller asks to be told must never change what it is told.
$bad = @($results | Where-Object { $_.state -ne 'down' -and -not $_.healthy })

if ($Json) {
    $results | ConvertTo-Json -Depth 4
    if ($bad.Count -gt 0) { exit 2 }
    exit 0
}

$results | Format-Table port, mcp, account, state, reported, installed, pages, probed, wedged, healthy -AutoSize
Write-Host ("slot table: {0}" -f $slots[0].Source) -ForegroundColor DarkGray

if ($bad.Count -gt 0) {
    Write-Host ''
    Write-Host "$($bad.Count) slot(s) need attention:" -ForegroundColor Yellow
    foreach ($b in $bad) {
        Write-Host "  [$($b.mcp) :$($b.port)] $($b.detail)" -ForegroundColor Yellow
        if ($b.loaded_dll) { Write-Host "      loaded: $($b.loaded_dll)" -ForegroundColor DarkGray }
    }
    exit 2
}

Write-Host ''
$repaired = @($results | Where-Object { $_.repaired -gt 0 })
if ($repaired.Count -gt 0) {
    Write-Host "Thawed frozen pages on $($repaired.Count) slot(s); all re-probed live." -ForegroundColor Green
}
Write-Host 'All running slots are on the installed build and can complete CDP work.' -ForegroundColor Green
exit 0
