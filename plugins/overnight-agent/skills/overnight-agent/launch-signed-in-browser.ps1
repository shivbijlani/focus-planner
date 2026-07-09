# Launch your REAL, signed-in browser on a CDP debug port for the overnight-agent
# MCP browser slots to ATTACH to (chrome-cdp = 9222, edge-cdp = 9223).
#
# WHY THIS (not a fresh profile): the MCP cdp slots only ATTACH to a browser you
# launch here -- they never launch one themselves, so they can never open an
# un-signed-in profile. We point them at your REAL profile (the one that already
# has LastPass + all your logins), so nothing needs reinstalling.
#
# THE v149 GOTCHA WE WORKED AROUND: Chromium v136+ ignores --remote-debugging-port
# only when --user-data-dir is OMITTED. By passing --user-data-dir explicitly (even
# to your real path) the debug port is allowed. Verified working on Chrome 149.
#
# IMPORTANT: your normal Chrome must be FULLY CLOSED before running this, otherwise
# Chrome just hands the command off to the already-running instance and the debug
# port never binds. The script detects that and tells you.
#
# ONE-TIME PER SESSION (only if locked): after launch, unlock LastPass (master
# password; tick "remember"). Your site logins (Google, Prime, etc.) are already
# in this profile.
#
# USAGE:
#   .\launch-signed-in-browser.ps1            # Chrome real profile, port 9222 (default)
#   .\launch-signed-in-browser.ps1 -Browser edge

param(
  [ValidateSet('chrome','edge')]
  [string]$Browser = 'chrome',
  [int]$Port,
  [string]$UserDataDir,
  [string]$ProfileDirectory = 'Default'
)

$ErrorActionPreference = 'Stop'

if ($Browser -eq 'chrome') {
  $exe = "C:\Program Files\Google\Chrome\Application\chrome.exe"
  $procName = 'chrome'
  if (-not $Port) { $Port = 9222 }
  if (-not $UserDataDir) { $UserDataDir = "$env:LOCALAPPDATA\Google\Chrome\User Data" }
} else {
  $exe = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
  $procName = 'msedge'
  if (-not $Port) { $Port = 9223 }
  if (-not $UserDataDir) { $UserDataDir = "$env:LOCALAPPDATA\Microsoft\Edge\User Data" }
}

if (-not (Test-Path $exe)) { throw "Browser not found: $exe" }

# Already serving the debug port? Reuse it.
$inUse = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($inUse) {
  Write-Host "Port $Port already serving a browser (PID $($inUse.OwningProcess)). Reusing it; nothing to do." -ForegroundColor Yellow
  return
}

# Is this browser already running WITHOUT the debug port? If so, a new launch will
# just hand off to it and the port won't bind -- the user must fully close it first.
$running = Get-Process $procName -ErrorAction SilentlyContinue
if ($running) {
  Write-Host "$Browser is already running but NOT on debug port $Port." -ForegroundColor Red
  Write-Host "Fully close $Browser (all windows) and re-run this script, or the debug port won't bind." -ForegroundColor Red
  return
}

Write-Host "Launching $Browser (real profile) on debug port $Port" -ForegroundColor Cyan
Write-Host "  user-data-dir : $UserDataDir"
Write-Host "  profile       : $ProfileDirectory"
Start-Process -FilePath $exe -ArgumentList @(
  "--remote-debugging-port=$Port",
  "--user-data-dir=$UserDataDir",
  "--profile-directory=$ProfileDirectory",
  "about:blank"
)

Start-Sleep -Seconds 5
$ok = (Test-NetConnection -ComputerName localhost -Port $Port -WarningAction SilentlyContinue).TcpTestSucceeded
if ($ok) {
  Write-Host "OK - debug endpoint live at http://localhost:$Port  (MCP slot can now attach)" -ForegroundColor Green
} else {
  Write-Host "WARNING - port $Port did not come up. Make sure $Browser was fully closed first." -ForegroundColor Red
}
