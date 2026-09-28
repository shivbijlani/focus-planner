<#
.SYNOPSIS
  Opt-in installer for the optional Overnight Agent reliability supervisor tray app
  (GH #689). Default: report status and change NOTHING.

.DESCRIPTION
  The supervisor is OFF by default. Installing or updating the plugin never registers
  or starts it; only an explicit user action does:

    install-oa-supervisor.ps1              # status only - registers/starts nothing
    install-oa-supervisor.ps1 -Enable      # opt in: deploy, migrate, register, start
    install-oa-supervisor.ps1 -Disable     # opt out: stop, unregister, remove legacy
    install-oa-supervisor.ps1 -Uninstall   # same as -Disable

  ONE STARTUP ROUTE: a per-user value 'Overnight Agent supervisor' under
  HKCU\Software\Microsoft\Windows\CurrentVersion\Run that launches
  %LOCALAPPDATA%\overnight-agent\oa-supervisor-tray.ps1 at sign-in. No Scheduled Task,
  no Startup-folder shim, no service. The tray's "Start with Windows" item toggles the
  same value.

  LIMITATION: a Run entry starts only after the user signs in, and the tray exits when
  they sign out. Nothing is supervised while logged out. (The desktop app being
  supervised also only runs in a signed-in session.)

  MIGRATION: -Enable and -Disable remove legacy 'Overnight Agent supervisor' and
  'Copilot browser watchdog' Scheduled Tasks, and their corresponding Startup shims,
  and stop a verified running legacy daemon or tray (PID + start time + command line).
  If a legacy task cannot be removed (for example it was registered from an elevated
  prompt), -Enable stops BEFORE registering the tray so two supervisors never coexist;
  re-run -Disable from an elevated prompt, then -Enable. Independently, the deployed
  oa-supervisor-daemon.ps1 is now an inert stub, so a leftover legacy entry cannot
  launch a second supervisor.

.PARAMETER IntervalMinutes
  Maximum minutes between evaluations (default 15); the tray also wakes at the M/N
  boundaries and cooldown expiry.

.PARAMETER NoAct
  Enable a DETECT-ONLY tray (classifies and logs, never restarts or launches).

.PARAMETER NoStart
  With -Enable: register the startup entry but do not start the tray now.
#>
[CmdletBinding(DefaultParameterSetName = 'Status')]
param(
  [Parameter(ParameterSetName = 'Enable', Mandatory)][switch]$Enable,
  [Parameter(ParameterSetName = 'Disable', Mandatory)][Alias('Uninstall')][switch]$Disable,
  [Parameter(ParameterSetName = 'Enable')][int]$IntervalMinutes = 15,
  [Parameter(ParameterSetName = 'Enable')][switch]$NoAct,
  [Parameter(ParameterSetName = 'Enable')][switch]$NoStart,
  [switch]$Json
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'oa-supervisor-startup.ps1')

$DeployedFiles = @(
  'oa-supervisor-tray.ps1', 'oa-supervisor-startup.ps1', 'oa-supervisor.ps1', 'oa-supervisor-daemon.ps1',
  'reliability-supervisor.mjs', 'windows-app-actuator.mjs', 'session-terminal-evidence.mjs',
  'consumer-reliability-supervisor.mjs', 'browser-watchdog.ps1', 'check-browser-slots.ps1',
  'browser-slot-table.ps1', 'ensure-mcp-browsers.ps1'
)

function Get-DeploySource([string]$Name) {
  $local = Join-Path $PSScriptRoot $Name
  if (Test-Path -LiteralPath $local) { return $local }
  if ($Name -eq 'ensure-mcp-browsers.ps1') {
    $skill = Join-Path $PSScriptRoot '..\skills\overnight-agent\ensure-mcp-browsers.ps1'
    if (Test-Path -LiteralPath $skill) { return $skill }
  }
  throw "required tray file missing: $Name"
}

function Get-SupervisorStatus {
  $startup = Get-OaTrayStartup
  $legacy = Get-OaLegacyInstall
  $owner = Get-OaSupervisorOwner
  [ordered]@{
    enabled    = $startup.enabled
    route      = $startup.route
    command    = $startup.command
    running    = [bool]$owner
    owner      = $(if ($owner) { [ordered]@{ pid = $owner.pid; kind = $owner.kind; verified = $owner.verified } })
    legacy     = $legacy
    limitation = 'Runs only while you are signed in to Windows; nothing is supervised while logged out.'
  }
}

function Write-Status($Status) {
  if ($Json) { $Status | ConvertTo-Json -Depth 5; return }
  Write-Host "[oa-supervisor] startup at sign-in: $(if ($Status.enabled) { 'ENABLED' } else { 'off (default)' }) ($($Status.route))"
  if ($Status.running) {
    Write-Host "[oa-supervisor] running: $($Status.owner.kind) PID $($Status.owner.pid)$(if (-not $Status.owner.verified) { ' (UNVERIFIED)' })"
  } else { Write-Host '[oa-supervisor] running: no' }
  if ($Status.legacy.taskInstalled) { Write-Host "[oa-supervisor] LEGACY scheduled task present: '$($Status.legacy.taskName)' (remove with -Disable)" }
  if ($Status.legacy.shimInstalled) { Write-Host "[oa-supervisor] LEGACY Startup shim present: $($Status.legacy.shimPath) (remove with -Disable)" }
  if ($Status.legacy.browserTaskInstalled) { Write-Host "[oa-supervisor] LEGACY browser task present: '$($Status.legacy.browserTaskName)' (remove with -Disable)" }
  if ($Status.legacy.browserShimInstalled) { Write-Host "[oa-supervisor] LEGACY browser shim present: $($Status.legacy.browserShimPath) (remove with -Disable)" }
  if ($Status.legacy.taskError) { Write-Host "[oa-supervisor] ERROR inspecting legacy tasks: $($Status.legacy.taskError)" }
  Write-Host "[oa-supervisor] $($Status.limitation)"
}

if ($PSCmdlet.ParameterSetName -eq 'Status') {
  Write-Status (Get-SupervisorStatus)
  if (-not $Json) {
    Write-Host '[oa-supervisor] nothing changed. Opt in with: -Enable   Opt out with: -Disable'
  }
  return
}

if ($Disable) {
  Disable-OaTrayStartup
  Write-Host '[oa-supervisor] removed startup entry (if present).'
  $stopped = Stop-OaSupervisorOwner
  if ($stopped -ne 'none') { Write-Host "[oa-supervisor] running supervisor $stopped." }
  $removed = Remove-OaLegacyInstall
  foreach ($r in $removed) { Write-Host "[oa-supervisor] removed legacy $r." }
  $files = Get-OaSupervisorFiles
  if (Test-Path $files.trayState) {
    $state = Get-Content -LiteralPath $files.trayState -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    $state | Add-Member -MemberType NoteProperty -Name browserEnabled -Value $false -Force
    $state | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $files.trayState -Encoding utf8
  }
  Write-Host '[oa-supervisor] disabled. Policy, state and audit files are kept in %LOCALAPPDATA%\overnight-agent.'
  if ($Json) { Get-SupervisorStatus | ConvertTo-Json -Depth 5 }
  return
}

# ----------------------------------------------------------------------------- -Enable
$nodeMajor = & node -p "process.versions.node.split('.')[0]"
if ($LASTEXITCODE -ne 0 -or -not $nodeMajor -or [int]$nodeMajor -lt 24) {
  throw 'Reliability supervisor requires Node.js 24+ for enterprise-parity SQLite session evidence.'
}
foreach ($name in $DeployedFiles) {
  [void](Get-DeploySource $name)
}

# Migrate first: if a legacy route cannot be removed, stop before adding the tray route.
$removed = Remove-OaLegacyInstall
foreach ($r in $removed) { Write-Host "[oa-supervisor] migrated: removed legacy $r." }
$stopped = Stop-OaSupervisorOwner
if ($stopped -ne 'none') { Write-Host "[oa-supervisor] previous supervisor $stopped." }

# Deploy to the flat home so the startup entry never points into a worktree.
$files = Get-OaSupervisorFiles
if (-not (Test-Path $files.home)) { New-Item -ItemType Directory -Path $files.home -Force | Out-Null }
foreach ($name in $DeployedFiles) {
  Copy-Item (Get-DeploySource $name) (Join-Path $files.home $name) -Force
}
Write-Host "[oa-supervisor] deployed supervisor files to $($files.home)."

$command = Get-OaTrayCommandLine -TrayPath $files.tray -IntervalMinutes $IntervalMinutes -NoAct:$NoAct
Enable-OaTrayStartup $command
Write-Host "[oa-supervisor] startup entry registered: HKCU Run 'Overnight Agent supervisor'."

if (-not $NoStart) {
  $argList = @('-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
               '-File', "`"$($files.tray)`"", '-IntervalMinutes', $IntervalMinutes)
  if ($NoAct) { $argList += '-NoAct' }
  Start-Process -FilePath (Get-OaWindowsPowerShell) -ArgumentList $argList -WindowStyle Hidden | Out-Null
  $deadline = (Get-Date).AddSeconds(15)
  while ((Get-Date) -lt $deadline -and -not (Test-OaLockHeld $files.lock)) { Start-Sleep -Milliseconds 250 }
  if (Test-OaLockHeld $files.lock) { Write-Host '[oa-supervisor] tray started; look for the shield icon in the notification area.' }
  else { Write-Host '[oa-supervisor] WARNING: tray did not take the supervisor lock within 15s.' }
}
Write-Host '[oa-supervisor] NOTE: supervises only while you are signed in to Windows.'
Write-Host "[oa-supervisor] UNDO: powershell -NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Disable"
if ($Json) { Get-SupervisorStatus | ConvertTo-Json -Depth 5 }
