# ensure-mcp-browsers.ps1
# Make sure the overnight-agent's CDP browser slots are running so the Playwright
# MCP can attach. Each slot uses its OWN --user-data-dir, so it binds its debug
# port even when your normal Chrome/Edge is open (no "hand-off" problem).
#
# Slots (name -> port -> dedicated profile dir):
#   MCP Chrome 1        9222  %LOCALAPPDATA%\playwright-mcp\chrome1       (primary account + password manager)
#   MCP Edge 1          9225  %LOCALAPPDATA%\playwright-mcp\edge1         (primary account + password manager)
#   MCP Edge 2          9226  %LOCALAPPDATA%\playwright-mcp\edge2         (clone of edge1)
#   MCP Edge 3          9227  %LOCALAPPDATA%\playwright-mcp\edge3         (clone of edge1)
#   MCP Edge alt        9228  %LOCALAPPDATA%\playwright-mcp\edge-alt      (alternate account)
#
# USAGE:
#   .\ensure-mcp-browsers.ps1                 # start every slot whose port is down
#   .\ensure-mcp-browsers.ps1 -Slot edge1     # only that slot (chrome1 | edge1 | edge-alt)
#   .\ensure-mcp-browsers.ps1 -Quiet          # minimal output (for Startup/scheduled use)
#
# NOTE: a freshly-cloned profile is NOT auto-signed-in. The ONE-TIME setup per
# profile (unlock your password manager + sign into Google/sites) must still be done by you
# inside that window. After that, cookies persist for every later launch.

param(
  [ValidateSet('chrome1','edge1','edge2','edge3','edge-alt','all')]
  [string]$Slot = 'all',
  [switch]$Quiet
)

$ErrorActionPreference = 'Stop'

$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$edge   = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
$base   = "$env:LOCALAPPDATA\playwright-mcp"

$slots = @(
  [pscustomobject]@{ Key='chrome1';       Exe=$chrome; Port=9222; Dir="$base\chrome1" }
  [pscustomobject]@{ Key='edge1';         Exe=$edge;   Port=9225; Dir="$base\edge1" }
  [pscustomobject]@{ Key='edge2';         Exe=$edge;   Port=9226; Dir="$base\edge2" }
  [pscustomobject]@{ Key='edge3';         Exe=$edge;   Port=9227; Dir="$base\edge3" }
  [pscustomobject]@{ Key='edge-alt';      Exe=$edge;   Port=9228; Dir="$base\edge-alt" }
)

if ($Slot -ne 'all') { $slots = $slots | Where-Object { $_.Key -eq $Slot } }

function Write-Note($msg, $color = 'Gray') { if (-not $Quiet) { Write-Host $msg -ForegroundColor $color } }

foreach ($s in $slots) {
  $listening = Get-NetTCPConnection -LocalPort $s.Port -State Listen -ErrorAction SilentlyContinue
  if ($listening) {
    Write-Note "[$($s.Key)] port $($s.Port) already live (PID $($listening.OwningProcess -join ',')) - reusing." 'Yellow'
    continue
  }
  if (-not (Test-Path $s.Exe)) { Write-Note "[$($s.Key)] browser not found: $($s.Exe)" 'Red'; continue }

  Write-Note "[$($s.Key)] launching on debug port $($s.Port)" 'Cyan'
  $argList = @(
    "--user-data-dir=`"$($s.Dir)`"",
    "--remote-debugging-port=$($s.Port)",
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank"
  )
  Start-Process -FilePath $s.Exe -ArgumentList $argList | Out-Null
}

# Confirm ports came up (only for the slots we just tried to start).
Start-Sleep -Seconds 4
foreach ($s in $slots) {
  $up = $false
  for ($i = 0; $i -lt 6; $i++) {
    if (Get-NetTCPConnection -LocalPort $s.Port -State Listen -ErrorAction SilentlyContinue) { $up = $true; break }
    Start-Sleep -Seconds 2
  }
  if ($up) { Write-Note "[$($s.Key)] OK - http://localhost:$($s.Port) attachable." 'Green' }
  else     { Write-Note "[$($s.Key)] WARNING - port $($s.Port) did not come up." 'Red' }
}
