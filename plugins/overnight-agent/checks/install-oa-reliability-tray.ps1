<#
.SYNOPSIS
  Opt-in installer for the optional overnight-agent reliability supervisor tray
  app (GH #695). Default: report status and change NOTHING.

.DESCRIPTION
  This is a SEPARATE, additional supervision route from install-oa-supervisor.ps1
  (GH #226's Scheduled Task, which detects a stuck/dead Overnight Agent run). This
  installer owns only the M=3h/N=4h preventive-restart tray (GH #689/#695) and does
  not touch, migrate, or remove that existing Scheduled Task/Startup-shim route,
  the browser watchdog, or any shared settings file.

  The tray is OFF by default. Installing or updating the plugin never registers
  or starts it; only an explicit user action does:

    install-oa-reliability-tray.ps1              # status only - registers/starts nothing
    install-oa-reliability-tray.ps1 -Enable      # opt in: deploy, register, start
    install-oa-reliability-tray.ps1 -Disable     # opt out: stop, unregister

  ONE STARTUP ROUTE: a per-user value 'Overnight Agent supervisor' under
  HKCU\Software\Microsoft\Windows\CurrentVersion\Run that launches
  %LOCALAPPDATA%\overnight-agent\oa-supervisor-tray.ps1 at sign-in. No Scheduled
  Task, Startup-folder shim, or service is installed by this script. The tray's
  own "Start with Windows" menu item toggles the same value.

  LIMITATION: a Run entry starts only after the user signs in, and the tray exits
  when they sign out. Nothing is supervised while logged out; the desktop app
  being supervised also only runs in a signed-in session.

.PARAMETER IntervalMinutes
  Maximum minutes between evaluations (default 15); the tray also wakes at the
  M/N boundaries and cooldown expiry reported by the checker.

.PARAMETER NoAct
  Enable a DETECT-ONLY tray (classifies and logs, never restarts or launches).

.PARAMETER NoStart
  With -Enable: register the startup entry but do not start the tray now.
#>
[CmdletBinding(DefaultParameterSetName = 'Status')]
param(
  [Parameter(ParameterSetName = 'Enable', Mandatory)][switch]$Enable,
  [Parameter(ParameterSetName = 'Disable', Mandatory)][Alias('Uninstall')][switch]$Disable,
  [Parameter(ParameterSetName = 'Enable')][ValidateRange(1, 1440)][int]$IntervalMinutes = 15,
  [Parameter(ParameterSetName = 'Enable')][switch]$NoAct,
  [Parameter(ParameterSetName = 'Enable')][switch]$NoStart,
  [switch]$Json,
  # Test-only isolation: point Enable/Disable/status at a throwaway registry key
  # instead of the real HKCU Run value. Never set by a real caller.
  [string]$TestKeyPath,
  [string]$TestValueName
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'oa-supervisor-startup.ps1')

# Fixed, reviewed set: adding a file here never adds another startup route. Only
# the files this tray actually needs to run standalone from its deployed home.
$script:DeployedFiles = @(
  'oa-supervisor-tray.ps1', 'oa-supervisor-startup.ps1',
  'reliability-supervisor.mjs', 'windows-app-actuator.mjs',
  'session-terminal-evidence.mjs', 'consumer-reliability-supervisor.mjs',
  'oa-user-settings.mjs'
)

function Get-ReliabilityTrayStatus {
  $startup = if ($TestKeyPath) { Get-OaTrayStartup -KeyPath $TestKeyPath -ValueName $TestValueName } else { Get-OaTrayStartup }
  $owner = Get-OaSupervisorOwner
  [ordered]@{
    enabled = $startup.enabled
    route = $startup.route
    command = $startup.command
    running = [bool]$owner
    owner = $(if ($owner) { [ordered]@{ pid = $owner.pid; verified = $owner.verified } })
    limitation = 'Runs only while you are signed in to Windows; nothing is supervised while logged out.'
  }
}

function Write-ReliabilityTrayStatus($Status) {
  if ($Json) { $Status | ConvertTo-Json -Depth 5; return }
  Write-Host "[oa-reliability-tray] startup at sign-in: $(if ($Status.enabled) { 'ENABLED' } else { 'off (default)' }) ($($Status.route))"
  if ($Status.running) {
    Write-Host "[oa-reliability-tray] running: PID $($Status.owner.pid)$(if (-not $Status.owner.verified) { ' (UNVERIFIED)' })"
  } else {
    Write-Host '[oa-reliability-tray] running: no'
  }
  Write-Host "[oa-reliability-tray] $($Status.limitation)"
}

function Copy-ReliabilityTrayFiles {
  $files = Get-OaSupervisorFiles
  if (-not (Test-Path $files.home)) { New-Item -ItemType Directory -Path $files.home -Force | Out-Null }
  foreach ($name in $script:DeployedFiles) {
    $source = Join-Path $PSScriptRoot $name
    if (-not (Test-Path -LiteralPath $source)) { throw "Required tray file missing from plugin: $source" }
    $destination = Join-Path $files.home $name
    # Skip identical bytes so re-running -Enable is a no-op deploy, not churn.
    $needsCopy = $true
    if (Test-Path -LiteralPath $destination) {
      $sourceHash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
      $destinationHash = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash
      $needsCopy = $sourceHash -ne $destinationHash
    }
    if ($needsCopy) { Copy-Item -LiteralPath $source -Destination $destination -Force }
  }
}

if ($Enable) {
  Copy-ReliabilityTrayFiles
  $files = Get-OaSupervisorFiles
  $commandLine = Get-OaTrayCommandLine -TrayPath $files.tray -IntervalMinutes $IntervalMinutes -NoAct:$NoAct
  if ($TestKeyPath) { Enable-OaTrayStartup -CommandLine $commandLine -KeyPath $TestKeyPath -ValueName $TestValueName }
  else { Enable-OaTrayStartup -CommandLine $commandLine }
  $started = $false
  if (-not $NoStart) {
    $psExe = Get-OaWindowsPowerShell
    $argumentList = @('-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass',
      '-WindowStyle', 'Hidden', '-File', $files.tray, '-IntervalMinutes', $IntervalMinutes)
    if ($NoAct) { $argumentList += '-NoAct' }
    Start-Process -FilePath $psExe -ArgumentList $argumentList -WindowStyle Hidden | Out-Null
    $started = $true
  }
  $status = Get-ReliabilityTrayStatus
  if ($Json) { ($status + @{ started = $started }) | ConvertTo-Json -Depth 5 }
  else {
    Write-ReliabilityTrayStatus $status
    Write-Host "[oa-reliability-tray] enabled.$(if ($started) { ' Tray started now.' } else { ' Tray will start at next sign-in (-NoStart).' })"
  }
  return
}

if ($Disable) {
  $stopResult = Stop-OaSupervisorOwner
  if ($TestKeyPath) { Disable-OaTrayStartup -KeyPath $TestKeyPath -ValueName $TestValueName }
  else { Disable-OaTrayStartup }
  $status = Get-ReliabilityTrayStatus
  if ($Json) { ($status + @{ stopped = $stopResult }) | ConvertTo-Json -Depth 5 }
  else {
    Write-ReliabilityTrayStatus $status
    Write-Host "[oa-reliability-tray] disabled (stop result: $stopResult)."
  }
  return
}

Write-ReliabilityTrayStatus (Get-ReliabilityTrayStatus)
