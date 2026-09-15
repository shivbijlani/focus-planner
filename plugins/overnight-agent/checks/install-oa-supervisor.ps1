<#
.SYNOPSIS
  Deploys the supervisor and registers a resident Windows Scheduled Task.
.DESCRIPTION
  The task keeps the daemon alive; the daemon obeys each tick's nextCheckUtc.
  A 15-minute one-shot task cannot honor the preventive deadline. If registration
  fails, a Startup shim launches the same daemon with the same detect-only setting.
  Configuration overrides in supervisor-config.json are never copied or overwritten.
.PARAMETER IntervalMinutes
  Task relaunch safety-net interval, not supervisor polling. Default 15 minutes.
.PARAMETER DeployOnly
  Copy runtime files only; no task, Startup, or process operations. Useful for fixtures.
.PARAMETER Uninstall
  Remove task and Startup registration and request cooperative daemon shutdown.
  Legacy daemons without cooperative shutdown require a separately verified stop.
#>
[CmdletBinding()]
param(
  [ValidateRange(1, 1440)][int]$IntervalMinutes = 15,
  [string]$TaskName = 'Overnight Agent supervisor',
  [switch]$Uninstall,
  [switch]$NoAct,
  [switch]$DeployOnly,
  [string]$StartupDirectory = ([Environment]::GetFolderPath('Startup')),
  [string]$OaHome = (Join-Path $env:LOCALAPPDATA 'overnight-agent')
)

$ErrorActionPreference = 'Stop'
$stopPath = Join-Path $OaHome 'supervisor-daemon.stop'
if ($Uninstall) {
  New-Item -ItemType Directory -Path $OaHome -Force | Out-Null
  [IO.File]::WriteAllText($stopPath, [DateTimeOffset]::UtcNow.ToString('o'))
  $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($existing) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }
  $shim = Join-Path $StartupDirectory 'Overnight Agent supervisor.cmd'
  if (Test-Path -LiteralPath $shim) { Remove-Item -LiteralPath $shim -Force }
  Write-Host '[oa-supervisor] registrations removed; cooperative shutdown requested.'
  Write-Host '[oa-supervisor] legacy daemons may remain: verify executable, command line and creation time before any manual stop. No process was killed.'
  return
}

# Validate the full closure before copying anything. Never seed a user override.
$runtimeFiles = @(
  'oa-supervisor.ps1',
  'oa-supervisor-lifecycle.ps1',
  'oa-supervisor-daemon.ps1',
  'supervisor-activity.mjs',
  'supervisor-defaults.json',
  'stuck-run-sweep.mjs'
)
foreach ($name in $runtimeFiles) {
  if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot $name))) {
    throw "Missing supervisor runtime dependency: $name"
  }
}
New-Item -ItemType Directory -Path $OaHome -Force | Out-Null
$deploymentLock = $null
try {
  if (-not $DeployOnly) {
    # Reconfigure modern daemons cooperatively, including transitions to -NoAct.
    # A legacy PID-file daemon cannot acknowledge this protocol. Refuse migration
    # rather than killing a PID from an untrusted/stale file or starting alongside it.
    [IO.File]::WriteAllText($stopPath, [DateTimeOffset]::UtcNow.ToString('o'))
    $until = [DateTimeOffset]::UtcNow.AddSeconds(60)
    do {
      try {
        $deploymentLock = [IO.File]::Open((Join-Path $OaHome 'supervisor-daemon.lock'),
          [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
      } catch [IO.IOException] {
        if ([DateTimeOffset]::UtcNow -ge $until) { throw 'Daemon did not acknowledge shutdown; deployment refused. No process was killed.' }
        Start-Sleep -Milliseconds 500
      }
    } while (-not $deploymentLock)
    $daemonPath = Join-Path $OaHome 'oa-supervisor-daemon.ps1'
    do {
      $legacy = @(Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe' OR Name = 'pwsh.exe'" |
        Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and
          $_.CommandLine.IndexOf($daemonPath, [StringComparison]::OrdinalIgnoreCase) -ge 0 })
      if (-not $legacy.Count) { break }
      # A modern daemon can have released its handle but not exited its process yet.
      if ([DateTimeOffset]::UtcNow -ge $until) { break }
      Start-Sleep -Milliseconds 500
    } while ($true)
    if ($legacy.Count) {
      throw 'A daemon process remains without the exclusive lock. Verify its executable, command line and creation time for manual migration; deployment refused, no process killed.'
    }
  }
  foreach ($name in $runtimeFiles) {
    $source = Join-Path $PSScriptRoot $name
    $destination = Join-Path $OaHome $name
    if ([IO.Path]::GetFullPath($source) -ne [IO.Path]::GetFullPath($destination)) {
      Copy-Item -LiteralPath $source -Destination $destination -Force
    }
  }
} finally {
  if ($deploymentLock) { $deploymentLock.Dispose() }
}
Write-Host "[oa-supervisor] deployed $($runtimeFiles.Count) runtime files to $OaHome; overrides preserved."
if ($DeployOnly) { return }
Remove-Item -LiteralPath $stopPath -Force -ErrorAction SilentlyContinue

$daemon = Join-Path $OaHome 'oa-supervisor-daemon.ps1'
$psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$argLine = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$daemon`" -OaHome `"$OaHome`""
if ($NoAct) { $argLine += ' -NoAct' }

$registered = $false
try {
  $action = New-ScheduledTaskAction -Execute $psExe -Argument $argLine
  $atLogon = New-ScheduledTaskTrigger -AtLogOn
  $startNow = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) `
    -RepetitionDuration ([TimeSpan]::FromDays(3650))
  # The target is an interactive desktop GUI. S4U runs in a different logon session
  # where exact session-scoped identity would falsely classify the app as absent.
  $logonType = 'Interactive'
  $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType $logonType -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
  Register-ScheduledTask -TaskName $TaskName -Action $action `
    -Trigger @($atLogon, $startNow) -Principal $principal -Settings $settings `
    -Description 'Resident out-of-band supervisor; tick-controlled preventive deadline, bounded recovery, no workflow toggles.' `
    -Force | Out-Null
  $registered = $true
} catch {
  Write-Host "[oa-supervisor] task registration failed: $($_.Exception.Message.Trim())"
}

if ($registered) {
  Start-ScheduledTask -TaskName $TaskName
  Write-Host "[oa-supervisor] registered resident task '$TaskName' ($logonType); failed daemons restart after one minute."
} else {
  $shim = Join-Path $StartupDirectory 'Overnight Agent supervisor.cmd'
  # Escape percent signs for cmd.exe; keep task and fallback arguments identical.
  $cmdLine = ("start `"`" /min `"$psExe`" $argLine") -replace '%', '%%'
  "@echo off`r`nrem Out-of-band supervisor; Startup fallback has no crash-restart guarantee.`r`n$cmdLine" |
    Set-Content -LiteralPath $shim -Encoding ascii
  Start-Process -FilePath $psExe -ArgumentList $argLine -WindowStyle Hidden | Out-Null
  Write-Host "[oa-supervisor] installed Startup fallback: $shim"
  Write-Host '[oa-supervisor] fallback cannot restart a dead daemon; rerun elevated for Task Scheduler.'
}
Write-Host '[oa-supervisor] existing daemons are never killed during install. Legacy PID-file daemons require a verified manual migration; updated code takes effect on their next launch.'
Write-Host "[oa-supervisor] runs: $psExe $argLine"
Write-Host "[oa-supervisor] undo: powershell -File `"$PSCommandPath`" -Uninstall"
