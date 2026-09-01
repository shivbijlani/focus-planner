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

  Read-only. Never kills or launches a browser -- the MCP slots are the user's
  windows and may hold in-flight state.

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

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File check-browser-slots.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File check-browser-slots.ps1 -Json

.NOTES
  Exit codes: 0 = every running slot is healthy. 2 = attention needed -- either a
  zombie slot, or the slot table could not be read (in which case the preflight
  cannot answer its own question, which is emphatically not "ok").
#>
[CmdletBinding()]
param(
    [switch]$Json,
    [string]$SettingsPath
)

$ErrorActionPreference = 'Stop'

# --- locate the ONE slot-table parser --------------------------------------
# This is a SEARCH for the shared parser, not a second copy of it. The two
# install locations hold different file sets, so the library cannot be assumed
# to sit next to whichever consumer is running.
$slotLib = $null
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

# --- read the table --------------------------------------------------------
# No baked-in fallback on purpose: a preflight that silently reverts to a stale
# list is how the drift this fixes stayed invisible.
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

    try {
        $targets = (Invoke-WebRequest -Uri "http://127.0.0.1:$port/json/list" `
            -TimeoutSec 5 -UseBasicParsing).Content | ConvertFrom-Json
        $row.pages = @($targets | Where-Object { $_.type -eq 'page' }).Count
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
    } else {
        $row.healthy = $true
        $row.detail  = 'ok'
    }

    [pscustomobject]$row
}

if ($Json) {
    $results | ConvertTo-Json -Depth 4
    exit 0
}

$results | Format-Table port, mcp, account, state, reported, installed, pages, healthy -AutoSize
Write-Host ("slot table: {0}" -f $slots[0].Source) -ForegroundColor DarkGray

$bad = @($results | Where-Object { $_.state -eq 'up' -and -not $_.healthy })
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
Write-Host 'All running slots are on the installed build.' -ForegroundColor Green
exit 0
