<#
.SYNOPSIS
  Shared startup, migration and ownership helpers for the optional reliability
  supervisor tray app (GH #689). Dot-sourced by install-oa-supervisor.ps1 and
  oa-supervisor-tray.ps1 so both use the same single startup route.

.DESCRIPTION
  ONE STARTUP ROUTE: a per-user value under
    HKCU\Software\Microsoft\Windows\CurrentVersion\Run
  named 'Overnight Agent supervisor'. It needs no elevation, is visible (and can be
  disabled) in Task Manager > Startup apps, and runs only after the user signs in.
  Nothing here registers a Scheduled Task, writes a Startup-folder shim or creates a
  service; the older reliability and browser-watchdog routes are only DETECTED and REMOVED.

  ONE ACTIVE SUPERVISOR: the tray and the retired legacy daemon both take the same
  exclusive file lock (supervisor-daemon.lock). Stopping an owner always verifies
  PID + creation time + command line before touching the process.
#>

$script:OaRunKeyPath    = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$script:OaRunValueName  = 'Overnight Agent supervisor'
$script:OaLegacyTask    = 'Overnight Agent supervisor'
$script:OaLegacyShimName = 'Overnight Agent supervisor.cmd'
$script:OaLegacyBrowserTask = 'Copilot browser watchdog'
$script:OaLegacyBrowserShimName = 'CopilotBrowserWatchdog.vbs'

function Get-OaHome {
  if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA is required for the supervisor home' }
  return (Join-Path $env:LOCALAPPDATA 'overnight-agent')
}

function Get-OaSupervisorFiles {
  $oaHome = Get-OaHome
  [ordered]@{
    home        = $oaHome
    lock        = (Join-Path $oaHome 'supervisor-daemon.lock')
    heartbeat   = (Join-Path $oaHome 'supervisor-daemon-heartbeat.json')
    trayState   = (Join-Path $oaHome 'supervisor-tray.json')
    stopRequest = (Join-Path $oaHome 'supervisor-tray-stop.json')
    tray        = (Join-Path $oaHome 'oa-supervisor-tray.ps1')
  }
}

function Get-OaLegacyShimPath {
  return (Join-Path ([Environment]::GetFolderPath('Startup')) $script:OaLegacyShimName)
}

function Get-OaWindowsPowerShell {
  return (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe')
}

# The exact command stored in the Run value. Pure, so tests can assert it.
function Get-OaTrayCommandLine {
  param([Parameter(Mandatory)][string]$TrayPath, [int]$IntervalMinutes = 15, [switch]$NoAct,
        [string]$PowerShellPath = (Get-OaWindowsPowerShell))
  $line = "`"$PowerShellPath`" -NoProfile -NonInteractive -STA -ExecutionPolicy Bypass " +
          "-WindowStyle Hidden -File `"$TrayPath`" -IntervalMinutes $IntervalMinutes"
  if ($NoAct) { $line += ' -NoAct' }
  return $line
}

function Get-OaTrayStartup {
  $value = $null
  try {
    $item = Get-ItemProperty -Path $script:OaRunKeyPath -Name $script:OaRunValueName -ErrorAction Stop
    $value = [string]$item.$($script:OaRunValueName)
  } catch { }
  [ordered]@{ enabled = [bool]$value; command = $value; route = "HKCU Run: $($script:OaRunValueName)" }
}

function Enable-OaTrayStartup {
  param([Parameter(Mandatory)][string]$CommandLine)
  if (-not (Test-Path $script:OaRunKeyPath)) { New-Item -Path $script:OaRunKeyPath -Force | Out-Null }
  New-ItemProperty -Path $script:OaRunKeyPath -Name $script:OaRunValueName -Value $CommandLine `
    -PropertyType String -Force | Out-Null
}

function Disable-OaTrayStartup {
  Remove-ItemProperty -Path $script:OaRunKeyPath -Name $script:OaRunValueName -ErrorAction SilentlyContinue
}

function Get-OaLegacyInstall {
  $taskInstalled = $false
  $browserTaskInstalled = $false
  $taskError = $null
  if (Get-Command Get-ScheduledTask -ErrorAction SilentlyContinue) {
    try {
      $tasks = @(Get-ScheduledTask -ErrorAction Stop)
      foreach ($name in @($script:OaLegacyTask, $script:OaLegacyBrowserTask)) {
        $matches = @($tasks | Where-Object TaskName -eq $name)
        if (@($matches | Where-Object TaskPath -ne '\').Count) {
          throw "Task '$name' also exists outside the root task folder; refusing to remove it by name."
        }
        if ($name -eq $script:OaLegacyTask) { $taskInstalled = $matches.Count -gt 0 }
        else { $browserTaskInstalled = $matches.Count -gt 0 }
      }
    } catch { $taskError = "$_" }
  }
  $shim = Get-OaLegacyShimPath
  $browserShim = Join-Path ([Environment]::GetFolderPath('Startup')) $script:OaLegacyBrowserShimName
  [ordered]@{
    taskName      = $script:OaLegacyTask
    taskInstalled = $taskInstalled
    taskError     = $taskError
    shimPath      = $shim
    shimInstalled = [bool](Test-Path -LiteralPath $shim)
    browserTaskName = $script:OaLegacyBrowserTask
    browserTaskInstalled = $browserTaskInstalled
    browserShimPath = $browserShim
    browserShimInstalled = [bool](Test-Path -LiteralPath $browserShim)
  }
}

# Removes both legacy routes. Throws if a legacy task exists and cannot be removed
# (e.g. it was registered elevated), so callers never add the tray route next to it.
function Remove-OaLegacyInstall {
  $legacy = Get-OaLegacyInstall
  if ($legacy.taskError) { throw "Cannot inspect legacy Scheduled Tasks: $($legacy.taskError)" }
  $removed = @()
  foreach ($name in @($script:OaLegacyTask, $script:OaLegacyBrowserTask)) {
    if (($name -eq $script:OaLegacyTask -and -not $legacy.taskInstalled) -or
        ($name -eq $script:OaLegacyBrowserTask -and -not $legacy.browserTaskInstalled)) { continue }
    try {
      Unregister-ScheduledTask -TaskName $name -TaskPath '\' -Confirm:$false -ErrorAction Stop
      $removed += "scheduled task '$name'"
    } catch {
      throw ("Legacy scheduled task '$name' could not be removed ($($_.Exception.Message.Trim())). " +
             'Remove it from an elevated prompt with: install-oa-supervisor.ps1 -Disable, then enable again.')
    }
  }
  foreach ($shim in @($legacy.shimPath, $legacy.browserShimPath)) {
    if (-not (Test-Path -LiteralPath $shim)) { continue }
    Remove-Item -LiteralPath $shim -Force -ErrorAction Stop
    $removed += "Startup shim $shim"
  }
  return , $removed
}

function Test-OaLegacyBrowserProcessRunning {
  if (-not (Get-Command Get-CimInstance -ErrorAction SilentlyContinue)) {
    throw 'Cannot verify whether a legacy browser check is still running (Get-CimInstance unavailable).'
  }
  $browser = Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" -ErrorAction Stop |
    Where-Object { $_.Name -in @('powershell.exe', 'pwsh.exe') -and
      $_.CommandLine -match '(?i)(?:^|[\\/ "])browser-watchdog\.ps1(?:[" ]|$)' } |
    Select-Object -First 1
  return [bool]$browser
}

function Read-OaLockRecord {
  param([string]$LockPath = (Get-OaSupervisorFiles).lock)
  if (-not (Test-Path -LiteralPath $LockPath)) { return $null }
  try {
    $stream = [IO.File]::Open($LockPath, [IO.FileMode]::Open, [IO.FileAccess]::Read,
      [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete)
    try {
      $reader = New-Object IO.StreamReader($stream)
      $raw = $reader.ReadToEnd()
    } finally { $stream.Dispose() }
    if (-not $raw.Trim()) { return $null }
    return ($raw | ConvertFrom-Json)
  } catch { return $null }
}

# Is the lock still held? The owner opens it with FileShare.Read, so asking for write
# access fails while it is alive and succeeds once its handle is closed.
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
  if ($ProcessInfo.Name -notin @('powershell.exe', 'pwsh.exe')) { return $false }
  $cmd = [string]$ProcessInfo.CommandLine
  if (-not $cmd -or ($cmd -notmatch 'oa-supervisor-(tray|daemon)\.ps1')) { return $false }
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
    kind     = $(if ($record -and $record.kind) { [string]$record.kind } else { 'legacy-daemon' })
    verified = (Test-OaOwnerIdentity $record $info)
    record   = $record
  }
}

# Stops the one verified supervisor owner: tray gets a graceful stop request first
# (so its notification icon is removed), then a bounded wait, then a verified force.
function Stop-OaSupervisorOwner {
  param([int]$GraceSeconds = 10)
  $files = Get-OaSupervisorFiles
  $owner = Get-OaSupervisorOwner
  if (-not $owner) { return 'none' }
  if (-not $owner.verified) {
    throw "Refusing to stop unverified supervisor lock owner PID $($owner.pid) ($($files.lock))."
  }
  if ($owner.kind -eq 'tray') {
    @{ pid = $owner.pid; requestedUtc = (Get-Date).ToUniversalTime().ToString('o') } |
      ConvertTo-Json | Set-Content -LiteralPath $files.stopRequest -Encoding utf8
    $deadline = (Get-Date).AddSeconds($GraceSeconds)
    while ((Get-Date) -lt $deadline -and (Test-OaLockHeld $files.lock)) { Start-Sleep -Milliseconds 250 }
    Remove-Item -LiteralPath $files.stopRequest -Force -ErrorAction SilentlyContinue
    if (-not (Test-OaLockHeld $files.lock)) { return 'stopped-gracefully' }
  }
  $again = Get-OaSupervisorOwner
  if (-not $again) { return 'stopped-gracefully' }
  if (-not $again.verified -or $again.pid -ne $owner.pid) {
    throw "Supervisor lock owner changed while stopping (PID $($again.pid)); refusing to force."
  }
  if ($again.kind -eq 'tray') {
    try {
      $beat = Get-Content -LiteralPath $files.heartbeat -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    } catch { throw "Cannot verify that tray child checks have finished; refusing to force stop: $_" }
    if ([int]$beat.pid -ne $again.pid -or $beat.evaluating -or $beat.browserEvaluating) {
      throw "Tray is still running a check (or heartbeat identity changed): pid=$($beat.pid)/$($again.pid), reliability=$($beat.evaluating), browser=$($beat.browserEvaluating); refusing to orphan a child process."
    }
    $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $($again.pid)" -ErrorAction Stop)
    if ($children.Count) { throw "Tray still owns $($children.Count) child process(es); refusing to orphan them." }
  }
  Stop-Process -Id $again.pid -Force -ErrorAction Stop
  $deadline = (Get-Date).AddSeconds(5)
  while ((Get-Date) -lt $deadline -and (Test-OaLockHeld $files.lock)) { Start-Sleep -Milliseconds 200 }
  if (Test-OaLockHeld $files.lock) { throw "Supervisor PID $($again.pid) did not release the lock." }
  Remove-Item -LiteralPath $files.lock -Force -ErrorAction SilentlyContinue
  return 'stopped-forcefully'
}
