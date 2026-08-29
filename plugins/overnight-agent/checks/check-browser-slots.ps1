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

.PARAMETER Json
  Emit a JSON array instead of the human-readable table.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File check-browser-slots.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File check-browser-slots.ps1 -Json
#>
[CmdletBinding()]
param(
    [switch]$Json
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
        mcp            = $slot.Mcp
        state          = 'down'
        reported       = $null
        installed      = $null
        loaded_dll     = $null
        pages          = $null
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

$results | Format-Table port, mcp, state, reported, installed, pages, healthy -AutoSize

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
