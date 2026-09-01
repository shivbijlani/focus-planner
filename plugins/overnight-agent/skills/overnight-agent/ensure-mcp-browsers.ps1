# ensure-mcp-browsers.ps1
# Launch a CDP browser slot ON DEMAND so the Playwright MCP can attach to it.
# Each slot uses its OWN --user-data-dir, so it binds its debug port even when
# your normal Chrome/Edge is open (no "hand-off" problem).
#
# THE SLOT LIST IS NOT IN THIS FILE (GH #180).
# ---------------------------------------------
# It is read from the `## Browser slots` table in `user-settings.md`, which
# declares itself the source of truth. Two things were wrong before that wiring
# existed, and both are the reason #180 was filed:
#
#   1. THE LAUNCHER COULD NOT LAUNCH ONE OF THE LIVE SLOTS. This file had ZERO
#      references to port 9229 or to that slot's profile dir. So when that
#      browser was closed -- the normal state for a slot nobody has opened today
#      -- nothing could open it, and the run just failed. From the request that
#      became #180: "most times we try to use the browser mcp, but it's closed so
#      we don't think to launch it on demand... We just fail."
#
#   2. IT COULD LAUNCH THE WRONG IDENTITY. Its slot list pointed port 9228 at the
#      profile directory from the PREVIOUS generation of the table, not the one
#      the table now assigns. BOTH directories exist on disk, so that launch would
#      have SUCCEEDED and bound 9228 to the wrong profile -- silently, because a
#      bound port looks healthy. Settings rule 1: "Never substitute a different
#      account's profile for the requested one -- a fallback from one identity to
#      another produces actions taken as the wrong identity, which is worse than
#      failing."
#
# There is deliberately no hardcoded fallback list. If the table cannot be read,
# this script refuses to launch anything rather than guessing which account a
# port carries.
#
# USAGE:
#   .\ensure-mcp-browsers.ps1                        # start every slot whose port is down
#   .\ensure-mcp-browsers.ps1 -Slot edge-cdp-2       # one slot, by name
#   .\ensure-mcp-browsers.ps1 -Slot marketing        # ...or by account
#   .\ensure-mcp-browsers.ps1 -Slot edge-work        # ...or by profile dir
#   .\ensure-mcp-browsers.ps1 -Slot 9229             # ...or by port
#   .\ensure-mcp-browsers.ps1 -List                  # show the table, launch nothing
#   .\ensure-mcp-browsers.ps1 -DryRun                # print the exact command lines only
#   .\ensure-mcp-browsers.ps1 -Quiet                 # minimal output
#
# An unmatched -Slot is an ERROR, never a near-miss: handing back "whatever was
# closest" is precisely the wrong-identity failure above.
#
# NOTE: a freshly-created profile is NOT auto-signed-in. The ONE-TIME setup per
# profile (unlock the password manager + sign into the sites) must be done by the
# user inside that window. After that, cookies persist for every later launch.
#
# EXIT: 0 every requested slot is listening. 1 a slot could not be started (the
# caller should set `blocked` with that one ask). 2 the slot table is unreadable.

param(
  [string]$Slot = 'all',
  [switch]$List,
  [switch]$DryRun,
  [switch]$Quiet,
  [string]$SettingsPath
)

$ErrorActionPreference = 'Stop'

function Write-Note($msg, $color = 'Gray') { if (-not $Quiet) { Write-Host $msg -ForegroundColor $color } }

# --- locate the ONE slot-table parser --------------------------------------
# A search for the shared parser, not a second copy of it. This script installs
# into the NESTED skill dir while the parser ships with checks/, and the two
# install locations do not hold the same files.
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
  Write-Host 'ensure-mcp-browsers: browser-slot-table.ps1 not found. Refusing to guess a slot list.' -ForegroundColor Red
  exit 2
}
. $slotLib

try {
  $all = @(Get-BrowserSlotTable -SettingsPath $SettingsPath)
}
catch {
  Write-Host 'ensure-mcp-browsers: could not read the browser slot table.' -ForegroundColor Red
  Write-Host "  $($_.Exception.Message)" -ForegroundColor Red
  Write-Host '  Refusing to launch a browser without knowing which account its port carries.' -ForegroundColor Red
  exit 2
}

Write-Note "slot table: $($all[0].Source)" 'DarkGray'

if ($List) {
  $all | Format-Table Slot, Alias, Port, ProfileDir, Account, Shortcut -AutoSize
  exit 0
}

try {
  $slots = @(Select-BrowserSlot -Slots $all -Name $Slot)
}
catch {
  Write-Host "ensure-mcp-browsers: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}

# --- which browser binary does a slot want? --------------------------------
# Derived from the slot/profile name rather than a parallel table, so adding a
# row to user-settings.md is still the only edit needed.
function Resolve-BrowserExe {
  param([object]$SlotRow)

  $isChrome = ("$($SlotRow.Slot) $($SlotRow.ProfileDir)" -match '(?i)chrome')
  $candidates = if ($isChrome) {
    @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
      "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe")
  }
  else {
    @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
      "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe")
  }
  foreach ($c in $candidates) { if ($c -and (Test-Path -LiteralPath $c)) { return $c } }
  return $null
}

function Test-PortListening {
  param([int]$Port)
  # Get-NetTCPConnection is Windows-only; fall back to a plain TCP probe so this
  # script is still honest on a box without the NetTCPIP module.
  if (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue) {
    return [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
  }
  try {
    $c = New-Object Net.Sockets.TcpClient
    $ok = $c.ConnectAsync('127.0.0.1', $Port).Wait(400)
    $c.Close()
    return $ok
  }
  catch { return $false }
}

$launched = @()
$failed = @()

foreach ($s in $slots) {
  if (Test-PortListening -Port $s.Port) {
    Write-Note "[$($s.Slot)] port $($s.Port) already live - reusing (account: $($s.Account))." 'Yellow'
    continue
  }

  $exe = Resolve-BrowserExe -SlotRow $s
  if (-not $exe) {
    Write-Note "[$($s.Slot)] browser binary not found on this machine." 'Red'
    $failed += $s
    continue
  }

  if (-not $s.ProfilePath) {
    Write-Note "[$($s.Slot)] no profile path could be resolved from the table - refusing to launch." 'Red'
    $failed += $s
    continue
  }

  # A missing profile dir is not a reason to substitute another one. Launching
  # creates it, which is how first-time setup happens -- but say so loudly,
  # because a brand-new profile binds the port while signed into nothing.
  if (-not (Test-Path -LiteralPath $s.ProfilePath)) {
    Write-Note "[$($s.Slot)] NOTE: profile dir does not exist yet ($($s.ProfilePath))." 'Yellow'
    Write-Note "[$($s.Slot)] It will be created EMPTY and signed into nothing - $($s.Account) needs a one-time sign-in by the user." 'Yellow'
  }

  $argList = @(
    "--user-data-dir=`"$($s.ProfilePath)`"",
    "--remote-debugging-port=$($s.Port)",
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank'
  )

  if ($DryRun) {
    Write-Host "[$($s.Slot)] WOULD LAUNCH (account: $($s.Account), profile: $($s.ProfileDir))" -ForegroundColor Cyan
    Write-Host "    $exe $($argList -join ' ')" -ForegroundColor DarkGray
    continue
  }

  Write-Note "[$($s.Slot)] launching $($s.Account) on debug port $($s.Port) (profile: $($s.ProfileDir))" 'Cyan'
  Start-Process -FilePath $exe -ArgumentList $argList | Out-Null
  $launched += $s
}

if ($DryRun) { exit 0 }

# Confirm the ports came up -- only for the slots we actually tried to start.
if ($launched.Count -gt 0) { Start-Sleep -Seconds 4 }
foreach ($s in $launched) {
  $up = $false
  for ($i = 0; $i -lt 6; $i++) {
    if (Test-PortListening -Port $s.Port) { $up = $true; break }
    Start-Sleep -Seconds 2
  }
  if ($up) {
    Write-Note "[$($s.Slot)] OK - http://localhost:$($s.Port) attachable." 'Green'
  }
  else {
    Write-Note "[$($s.Slot)] FAILED - port $($s.Port) did not come up. Open '$($s.Shortcut)' by hand." 'Red'
    $failed += $s
  }
}

if ($failed.Count -gt 0) {
  Write-Note "" 'Gray'
  Write-Note "$($failed.Count) slot(s) could not be started. Set 'blocked' with that one ask rather than using a different account's slot." 'Red'
  exit 1
}
exit 0
