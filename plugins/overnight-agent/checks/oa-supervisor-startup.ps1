<#
.SYNOPSIS
  Shared startup, lock-ownership and stop helpers for the optional overnight-agent
  reliability supervisor tray (GH #695). Dot-sourced by install-oa-supervisor.ps1
  and oa-supervisor-tray.ps1 so both agree on the single startup route and the
  single way to identify and stop the running tray.

.DESCRIPTION
  ONE STARTUP ROUTE: a per-user value under
    HKCU:\Software\Microsoft\Windows\CurrentVersion\Run
  named 'Overnight Agent supervisor'. It needs no elevation, is visible (and can be
  disabled) in Task Manager > Startup apps, and only runs once the user is signed
  in. Nothing here writes a Scheduled Task, a Startup-folder shim, or a service.

  ONE ACTIVE SUPERVISOR: the tray holds an exclusive file lock for as long as it
  runs. Stopping it always verifies PID + process start time + command line before
  touching the process, so a stale or foreign lock record is never force-stopped
  blindly.
#>

$script:OaRunKeyPath   = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$script:OaRunValueName = 'Overnight Agent supervisor'

function Get-OaHome {
  if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA is required for the supervisor home' }
  return (Join-Path $env:LOCALAPPDATA 'overnight-agent')
}

function Get-OaSupervisorFiles {
  $oaHome = Get-OaHome
  [ordered]@{
    home        = $oaHome
    lock        = (Join-Path $oaHome 'supervisor-tray.lock')
    heartbeat   = (Join-Path $oaHome 'supervisor-tray-heartbeat.json')
    stopRequest = (Join-Path $oaHome 'supervisor-tray-stop.json')
    tray        = (Join-Path $oaHome 'oa-supervisor-tray.ps1')
    consumer    = (Join-Path $oaHome 'consumer-reliability-supervisor.mjs')
    browserConsumer = (Join-Path $oaHome 'consumer-browser-watchdog.mjs')
    browserState    = (Join-Path $oaHome 'browser-checks-state.json')
    updateConsumer  = (Join-Path $oaHome 'consumer-update-check.mjs')
    updateState     = (Join-Path $oaHome 'update-check-state.json')
    capabilities    = (Join-Path $oaHome 'capabilities.json')
  }
}

function Get-OaCriticalStatus {
  param([string]$Path = (Get-OaSupervisorFiles).capabilities)
  if (-not (Test-Path -LiteralPath $Path)) { return [ordered]@{ down = $false; headline = '' } }
  try {
    $record = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    if ($record.schema -ne 'oa-capabilities/1') { throw "unrecognized capabilities schema: $($record.schema)" }
    $down = @($record.tools.PSObject.Properties | Where-Object { $_.Value.status -eq 'down' })
    if (-not $down.Count) { return [ordered]@{ down = $false; headline = '' } }
    $first = $down[0]
    return [ordered]@{
      down = $true
      headline = "$([char]0x26D4) CRITICAL TOOL DOWN: $($first.Name). $($first.Value.error). Since $($first.Value.firstSeenAt)."
    }
  } catch {
    return [ordered]@{ down = $true; headline = "Critical tool status unreadable: $_" }
  }
}

# Pure: one update-check result line -> what the tray shows (GH #701). A 'not-due'
# run carries the last recorded result, so the menu keeps showing it.
function ConvertFrom-OaUpdateResult {
  param($Result)
  $status = [string]$Result.status
  $last = $Result.last
  $effective = if ($status -in @('not-due', 'busy') -and $last -and $last.lastResult) { [string]$last.lastResult } else { $status }
  $summary = switch ($status) {
    'disabled'     { 'off (Enabled = off)' }
    'policy-error' { "settings refused: $($Result.error)" }
    'busy'         { 'another update check holds the update-check lock' }
    'not-due'      { if ($last -and $last.summary) { [string]$last.summary } else { 'waiting for the next check' } }
    default {
      if ($Result.outcome -and $Result.outcome.summary) { [string]$Result.outcome.summary } else { $status }
    }
  }
  $checked = $null
  if ($last -and $last.lastCheckedAt) {
    $checked = try { ([datetime]::Parse([string]$last.lastCheckedAt, $null,
      [System.Globalization.DateTimeStyles]::RoundtripKind)).ToLocalTime().ToString('yyyy-MM-dd HH:mm') } catch { $null }
  }
  [ordered]@{
    state = $effective.ToUpperInvariant()
    summary = $summary
    updateAvailable = ($effective -eq 'update-available')
    installedVersion = $(if ($last) { [string]$last.installedVersion } else { $null })
    availableVersion = $(if ($last) { [string]$last.availableVersion } else { $null })
    lastChecked = $checked
    error = $(if ($status -in @('failed', 'apply-failed', 'policy-error')) { [string]$Result.error } else { $null })
    settingsPath = $(if ($Result.policy) { [string]$Result.policy.settingsPath } else { $null })
  }
}

# Pure: one browser-workload result line -> what the tray shows. Kept free of UI
# and process state so the tray tests can drive it directly.
function ConvertFrom-OaBrowserResult {
  param($Result)
  $summary = switch ([string]$Result.status) {
    'disabled'     { if ($Result.policy -and $Result.policy.source -eq 'defaults') { 'off (default)' } else { 'off (Enabled = off)' } }
    'no-opt-ins'   { 'enabled, but no Observe/Thaw/Auto-launch opted in - nothing runs' }
    'policy-error' { "settings refused: $($Result.error)" }
    'busy'         { 'another browser check holds the browser-check lock' }
    default {
      if ($Result.outcome) { "$($Result.outcome.mode) - $($Result.outcome.summary)" } else { [string]$Result.status }
    }
  }
  $recent = @()
  foreach ($entry in @($Result.recent)) {
    if (-not $entry) { continue }
    $when = try { ([datetime]::Parse([string]$entry.at, $null,
      [System.Globalization.DateTimeStyles]::RoundtripKind)).ToLocalTime().ToString('MM-dd HH:mm') } catch { '?' }
    $recent += "$when $($entry.mode): $($entry.summary)"
  }
  [ordered]@{
    state = ([string]$Result.status).ToUpperInvariant()
    summary = $summary
    error = $(if ($Result.status -in @('failed', 'policy-error')) { [string]$Result.error } else { $null })
    recent = $recent
    settingsPath = $(if ($Result.policy) { [string]$Result.policy.settingsPath } else { $null })
  }
}

function Get-OaWindowsPowerShell {
  $candidate = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  if (Test-Path $candidate) { return $candidate }
  return 'powershell.exe'
}

# The exact command stored in the Run value. Pure, so tests can assert it without
# touching the registry.
function Get-OaTrayCommandLine {
  param(
    [Parameter(Mandatory)][string]$TrayPath,
    [int]$IntervalMinutes = 15,
    [switch]$NoAct,
    [string]$PowerShellPath = (Get-OaWindowsPowerShell)
  )
  $line = "`"$PowerShellPath`" -NoProfile -NonInteractive -STA -ExecutionPolicy Bypass " +
          "-WindowStyle Hidden -File `"$TrayPath`" -IntervalMinutes $IntervalMinutes"
  if ($NoAct) { $line += ' -NoAct' }
  return $line
}

function Get-OaTrayStartup {
  # KeyPath/ValueName are overridable ONLY so tests can point at an isolated
  # registry key; every real caller uses the fixed HKCU Run route.
  param([string]$KeyPath = $script:OaRunKeyPath, [string]$ValueName = $script:OaRunValueName)
  $value = $null
  try {
    $item = Get-ItemProperty -Path $KeyPath -Name $ValueName -ErrorAction Stop
    $value = [string]$item.$ValueName
  } catch { }
  [ordered]@{ enabled = [bool]$value; command = $value; route = "HKCU Run: $ValueName" }
}

function Enable-OaTrayStartup {
  param(
    [Parameter(Mandatory)][string]$CommandLine,
    [string]$KeyPath = $script:OaRunKeyPath,
    [string]$ValueName = $script:OaRunValueName
  )
  if (-not (Test-Path $KeyPath)) { New-Item -Path $KeyPath -Force | Out-Null }
  New-ItemProperty -Path $KeyPath -Name $ValueName -Value $CommandLine `
    -PropertyType String -Force | Out-Null
}

function Disable-OaTrayStartup {
  param([string]$KeyPath = $script:OaRunKeyPath, [string]$ValueName = $script:OaRunValueName)
  Remove-ItemProperty -Path $KeyPath -Name $ValueName -ErrorAction SilentlyContinue
}

function Read-OaLockRecord {
  param([string]$LockPath = (Get-OaSupervisorFiles).lock)
  if (-not (Test-Path -LiteralPath $LockPath)) { return $null }
  try {
    $stream = [IO.File]::Open($LockPath, [IO.FileMode]::Open, [IO.FileAccess]::Read,
      [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete)
    try { $raw = (New-Object IO.StreamReader($stream)).ReadToEnd() } finally { $stream.Dispose() }
    if (-not $raw.Trim()) { return $null }
    return ($raw | ConvertFrom-Json)
  } catch { return $null }
}

# Is the lock still held? The owner opens it with FileShare.Read, so asking for
# write access fails while it is alive and succeeds once its handle is closed.
function Test-OaLockHeld {
  param([string]$LockPath = (Get-OaSupervisorFiles).lock)
  if (-not (Test-Path -LiteralPath $LockPath)) { return $false }
  try {
    $probe = [IO.File]::Open($LockPath, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::Read)
    $probe.Dispose()
    return $false
  } catch [IO.IOException] { return $true }
}

# Pure identity check, so it can be tested without real processes.
function Test-OaOwnerIdentity {
  param($Record, $ProcessInfo)
  if (-not $Record -or -not $Record.pid -or -not $Record.startedUtc -or -not $ProcessInfo) { return $false }
  if ([int]$Record.pid -ne [int]$ProcessInfo.ProcessId) { return $false }
  if ($ProcessInfo.Name -notin @('powershell.exe', 'pwsh.exe')) { return $false }
  $cmd = [string]$ProcessInfo.CommandLine
  if (-not $cmd -or ($cmd -notmatch 'oa-supervisor-tray\.ps1')) { return $false }
  try {
    $started = [datetime]::Parse([string]$Record.startedUtc, $null,
      [System.Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
  } catch { return $false }
  return ([math]::Abs(($ProcessInfo.CreationDate.ToUniversalTime() - $started).TotalMinutes) -le 2)
}

function Get-OaSupervisorOwner {
  $files = Get-OaSupervisorFiles
  if (-not (Test-OaLockHeld $files.lock)) { return $null }
  $record = Read-OaLockRecord $files.lock
  $info = $null
  if ($record -and $record.pid) {
    $info = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$record.pid)" -ErrorAction SilentlyContinue
  }
  [ordered]@{
    pid      = $(if ($record) { [int]$record.pid } else { 0 })
    verified = (Test-OaOwnerIdentity $record $info)
    record   = $record
  }
}

# Stops the one verified tray owner: a graceful stop request first (so the
# notification icon is removed cleanly and any in-flight check can finish), then a
# bounded wait, then a verified force.
function Stop-OaSupervisorOwner {
  param([int]$GraceSeconds = 10)
  $files = Get-OaSupervisorFiles
  $owner = Get-OaSupervisorOwner
  if (-not $owner) { return 'none' }
  if (-not $owner.verified) {
    throw "Refusing to stop unverified supervisor lock owner PID $($owner.pid) ($($files.lock))."
  }
  @{ pid = $owner.pid; requestedUtc = (Get-Date).ToUniversalTime().ToString('o') } |
    ConvertTo-Json | Set-Content -LiteralPath $files.stopRequest -Encoding utf8
  $deadline = (Get-Date).AddSeconds($GraceSeconds)
  while ((Get-Date) -lt $deadline -and (Test-OaLockHeld $files.lock)) { Start-Sleep -Milliseconds 250 }
  Remove-Item -LiteralPath $files.stopRequest -Force -ErrorAction SilentlyContinue
  if (-not (Test-OaLockHeld $files.lock)) { return 'stopped-gracefully' }
  $again = Get-OaSupervisorOwner
  if (-not $again) { return 'stopped-gracefully' }
  if (-not $again.verified -or $again.pid -ne $owner.pid) {
    throw "Supervisor lock owner changed while stopping (PID $($again.pid)); refusing to force."
  }
  Stop-Process -Id $again.pid -Force -ErrorAction Stop
  $deadline = (Get-Date).AddSeconds(5)
  while ((Get-Date) -lt $deadline -and (Test-OaLockHeld $files.lock)) { Start-Sleep -Milliseconds 200 }
  if (Test-OaLockHeld $files.lock) { throw "Supervisor PID $($again.pid) did not release the lock." }
  Remove-Item -LiteralPath $files.lock -Force -ErrorAction SilentlyContinue
  return 'stopped-forcefully'
}
