# launch-signed-in-browser.ps1
# Launch a signed-in browser on a CDP debug port for a Playwright MCP slot to ATTACH to.
#
# WHY THIS (not a fresh profile): the MCP cdp slots only ATTACH to a browser something
# else launched -- they never launch one themselves, so they can never open an
# un-signed-in profile. This script is the "something else".
#
# THE STALE HEADER THIS REPLACES (GH #180)
# ----------------------------------------
# The previous version of this file advertised "chrome-cdp = 9222, edge-cdp = 9223"
# and defaulted -Browser edge to port 9223. Measured 2026-08-31: 9222 is a RETIRED
# slot (chrome-cdp-1, in `disabledMcpServers` since 2026-08-21) and 9223 has never
# been a slot in ANY generation of the table. The file had zero references to the
# three ports that are actually live. Ports are no longer named in this file at all:
# they come from the `## Browser slots` table in `user-settings.md`.
#
# TWO MODES
# ---------
#   -Slot <name|account|profile|port>   PREFERRED. Reads port + dedicated profile
#                                       dir from the slot table. This is the mode
#                                       that matches what the MCP will attach to.
#   -Browser chrome|edge -Port <n>      Legacy: put YOUR REAL daily profile on a
#                                       debug port. -Port is now REQUIRED, because
#                                       the old defaults pointed at ports that were
#                                       either retired or fictional.
#
# THE GUARD THAT MATTERS
# ----------------------
# In legacy mode this script REFUSES to bind a port the slot table has assigned to
# a slot, unless the profile it is about to open is that slot's profile. Binding
# 9228 to your default Edge profile would put the PRIMARY identity on the port every
# consumer believes is `bijlanis` -- the wrong-account failure that settings rule 1
# calls "worse than failing", arrived at from the other direction.
#
# THE v136+ GOTCHA WE WORK AROUND: Chromium ignores --remote-debugging-port only when
# --user-data-dir is OMITTED. Passing --user-data-dir explicitly (even your real path)
# lets the debug port bind.
#
# IMPORTANT for legacy mode: your normal browser must be FULLY CLOSED first, otherwise
# it just hands the command off to the running instance and the port never binds. The
# script detects that and says so.
#
# EXIT: 0 the port is serving. 1 it is not (or the request was refused). 2 the slot
# table could not be read.

param(
  [string]$Slot,
  [ValidateSet('chrome', 'edge')]
  [string]$Browser = 'edge',
  [int]$Port,
  [string]$UserDataDir,
  [string]$ProfileDirectory = 'Default',
  [string]$SettingsPath,
  [switch]$List,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

# --- locate the ONE slot-table parser --------------------------------------
# A search for the shared parser, not a second copy of it.
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
  Write-Host 'launch-signed-in-browser: browser-slot-table.ps1 not found. Refusing to guess a port.' -ForegroundColor Red
  exit 2
}
. $slotLib

try {
  $allSlots = @(Get-BrowserSlotTable -SettingsPath $SettingsPath)
}
catch {
  Write-Host 'launch-signed-in-browser: could not read the browser slot table.' -ForegroundColor Red
  Write-Host "  $($_.Exception.Message)" -ForegroundColor Red
  exit 2
}

Write-Host "slot table: $($allSlots[0].Source)" -ForegroundColor DarkGray

if ($List) {
  $allSlots | Format-Table Slot, Alias, Port, ProfileDir, Account, Shortcut -AutoSize
  exit 0
}

$targetSlot = $null
if ($Slot) {
  try { $targetSlot = @(Select-BrowserSlot -Slots $allSlots -Name $Slot)[0] }
  catch {
    Write-Host "launch-signed-in-browser: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
  }
  $Port = $targetSlot.Port
  $UserDataDir = $targetSlot.ProfilePath
  if ("$($targetSlot.Slot) $($targetSlot.ProfileDir)" -match '(?i)chrome') { $Browser = 'chrome' } else { $Browser = 'edge' }
}

if ($Browser -eq 'chrome') {
  $candidates = @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe")
  $procName = 'chrome'
  $realProfile = "$env:LOCALAPPDATA\Google\Chrome\User Data"
}
else {
  $candidates = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe")
  $procName = 'msedge'
  $realProfile = "$env:LOCALAPPDATA\Microsoft\Edge\User Data"
}
$exe = $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
if (-not $exe) { throw "Browser not found. Tried: $($candidates -join '; ')" }

if (-not $UserDataDir) { $UserDataDir = $realProfile }

# No fabricated default port. The old one (9223) was not a slot in any generation,
# so "it launched fine" and "an MCP can attach" were unrelated facts.
if (-not $Port) {
  Write-Host 'launch-signed-in-browser: no port given.' -ForegroundColor Red
  Write-Host '  Use -Slot <name> to take the port and profile from the slot table (preferred):' -ForegroundColor DarkGray
  foreach ($s in $allSlots) {
    Write-Host ("    -Slot {0}   -> port {1}, profile {2}, account {3}" -f $s.Slot, $s.Port, $s.ProfileDir, $s.Account) -ForegroundColor DarkGray
  }
  Write-Host '  ...or pass -Port explicitly for a real-profile launch.' -ForegroundColor DarkGray
  exit 1
}

# --- the wrong-identity guard ----------------------------------------------
# If this port belongs to a slot, the profile being opened must be that slot's
# profile. Otherwise the port would advertise one account and serve another.
$owner = @($allSlots | Where-Object { $_.Port -eq $Port })[0]
if ($owner) {
  $wanted = $owner.ProfilePath
  $sameProfile = $false
  if ($wanted -and $UserDataDir) {
    $sameProfile = ([IO.Path]::GetFullPath($UserDataDir).TrimEnd('\', '/') -ieq
                    [IO.Path]::GetFullPath($wanted).TrimEnd('\', '/'))
  }
  if (-not $sameProfile) {
    Write-Host "launch-signed-in-browser: REFUSED." -ForegroundColor Red
    Write-Host "  Port $Port belongs to slot '$($owner.Slot)' (account: $($owner.Account))." -ForegroundColor Red
    Write-Host "  That slot's profile : $wanted" -ForegroundColor Red
    Write-Host "  You asked to open   : $UserDataDir" -ForegroundColor Red
    Write-Host "  Binding a slot's port to a different profile puts the wrong account behind it," -ForegroundColor Red
    Write-Host "  which is worse than failing. Use -Slot $($owner.Slot), or pick a free port." -ForegroundColor Red
    exit 1
  }
}

# Already serving the debug port? Reuse it -- never kill the user's window.
$inUse = $null
if (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue) {
  $inUse = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
}
if ($inUse) {
  Write-Host "Port $Port already serving a browser (PID $($inUse.OwningProcess -join ',')). Reusing it; nothing to do." -ForegroundColor Yellow
  exit 0
}

# Real-profile mode only: an already-running browser swallows the launch, so the
# debug port never binds. A dedicated slot profile does not have this problem.
if (-not $targetSlot) {
  $running = Get-Process $procName -ErrorAction SilentlyContinue
  if ($running) {
    Write-Host "$Browser is already running but NOT on debug port $Port." -ForegroundColor Red
    Write-Host "Fully close $Browser (all windows) and re-run, or the debug port won't bind." -ForegroundColor Red
    exit 1
  }
}

$argList = @(
  "--remote-debugging-port=$Port",
  "--user-data-dir=`"$UserDataDir`"",
  '--no-first-run',
  '--no-default-browser-check',
  'about:blank'
)
if (-not $targetSlot) { $argList += "--profile-directory=$ProfileDirectory" }

if ($DryRun) {
  Write-Host "WOULD LAUNCH on port $Port" -ForegroundColor Cyan
  Write-Host "  $exe $($argList -join ' ')" -ForegroundColor DarkGray
  exit 0
}

Write-Host "Launching $Browser on debug port $Port" -ForegroundColor Cyan
Write-Host "  user-data-dir : $UserDataDir"
if ($targetSlot) { Write-Host "  slot          : $($targetSlot.Slot) (account: $($targetSlot.Account))" }
Start-Process -FilePath $exe -ArgumentList $argList | Out-Null

Start-Sleep -Seconds 5
$ok = $false
for ($i = 0; $i -lt 6; $i++) {
  try {
    $c = New-Object Net.Sockets.TcpClient
    $ok = $c.ConnectAsync('127.0.0.1', $Port).Wait(500)
    $c.Close()
  }
  catch { $ok = $false }
  if ($ok) { break }
  Start-Sleep -Seconds 2
}

if ($ok) {
  Write-Host "OK - debug endpoint live at http://localhost:$Port  (MCP slot can now attach)" -ForegroundColor Green
  exit 0
}
Write-Host "WARNING - port $Port did not come up." -ForegroundColor Red
exit 1
