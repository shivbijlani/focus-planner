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

.PARAMETER Json
  Emit a JSON array instead of the human-readable table.

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
#>
[CmdletBinding()]
param(
    [switch]$Json,
    [switch]$NoProbe,
    [int]$ProbeTimeoutSec = 6,
    [int]$MaxProbeTargets = 6,
    [switch]$Repair,
    [string[]]$SlotSpec
)

$ErrorActionPreference = 'Stop'

$slots = @(
    @{ Port = 9222; Mcp = 'chrome-cdp-1';       Shortcut = 'MCP Chrome 1 (CDP 9222)' }
    @{ Port = 9225; Mcp = 'edge-cdp-1';         Shortcut = 'MCP Edge 1 (CDP 9225)' }
    @{ Port = 9226; Mcp = 'edge-cdp-2';         Shortcut = 'MCP Edge 2 (CDP 9226)' }
    @{ Port = 9227; Mcp = 'edge-cdp-3';         Shortcut = 'MCP Edge 3 (CDP 9227)' }
    @{ Port = 9228; Mcp = 'edge-cdp-bijlanis';  Shortcut = 'MCP Edge bijlanis (CDP 9228)' }
    @{ Port = 9229; Mcp = 'edge-cdp-kiley';     Shortcut = 'MCP Edge kiley (CDP 9229)' }
)

if ($SlotSpec) {
    $slots = @(foreach ($spec in $SlotSpec) {
        $parts = $spec -split ':', 2
        @{
            Port     = [int]$parts[0]
            Mcp      = if ($parts.Count -gt 1 -and $parts[1]) { $parts[1] } else { "slot-$($parts[0])" }
            Shortcut = "MCP slot (CDP $($parts[0]))"
        }
    })
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
        mcp            = $slot.Mcp
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
        detail         = 'no CDP listener - open the desktop shortcut if this slot is needed'
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

if ($Json) {
    $results | ConvertTo-Json -Depth 4
    exit 0
}

$results | Format-Table port, mcp, state, reported, installed, pages, probed, wedged, healthy -AutoSize

$bad = @($results | Where-Object { $_.state -ne 'down' -and -not $_.healthy })
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
