<#
.SYNOPSIS
  Registers (or removes) the OS-level Windows Scheduled Task that runs
  oa-supervisor-daemon.ps1, which calls oa-supervisor.ps1 at policy boundaries.

.DESCRIPTION
  This script is the actual fix for GH #226. `oa-supervisor.ps1` is only a checker;
  a checker dispatched from inside the failure domain is what we already had, and it
  is what left 18 stalls (314.8 h) to be ended by a human restarting the app.

  Windows Task Scheduler is a service of the operating system. It is not the app, it
  is not the app's scheduler, and it is not an agent run - so it keeps firing exactly
  when everything this repo controls has stopped. That property, and nothing about
  the checker's cleverness, is what makes supervision real.

  IDEMPOTENT: re-running updates the existing task rather than creating a second one.
  REVERSIBLE: `-Uninstall` removes it completely. That is the whole rollback.

.PARAMETER IntervalMinutes
  Maximum interval between checks. Default 15 minutes; the daemon also wakes
  at the 3h/4h policy boundaries and cooldown expiry.

.PARAMETER Uninstall
  Remove the scheduled task and exit.
#>
[CmdletBinding()]
param(
  [int]$IntervalMinutes = 15,
  [string]$TaskName = 'Overnight Agent supervisor',
  [switch]$Uninstall,
  # Install a DETECT-ONLY supervisor (classifies + logs, never restarts). Default is the
  # acting supervisor: on a genuine hang it silently restarts the app.
  [switch]$NoAct
)

$ErrorActionPreference = 'Stop'

function Stop-InstalledDaemon {
  $lock = Join-Path (Join-Path $env:LOCALAPPDATA 'overnight-agent') 'supervisor-daemon.lock'
  if (-not (Test-Path $lock)) { return }
  $record = Get-Content $lock -Raw | ConvertFrom-Json
  if (-not $record.pid -or -not $record.startedUtc) {
    throw "Cannot validate supervisor daemon ownership: $lock"
  }
  $daemonPath = Join-Path (Join-Path $env:LOCALAPPDATA 'overnight-agent') 'oa-supervisor-daemon.ps1'
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$record.pid)"
  if (-not $process) {
    Remove-Item $lock -Force
    return
  }
  $started = [datetime]::Parse($record.startedUtc, $null,
    [System.Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
  $native = Get-Process -Id $record.pid -ErrorAction Stop
  if ($process.Name -notin @('powershell.exe', 'pwsh.exe') -or
      -not $process.CommandLine -or
      $process.CommandLine.IndexOf($daemonPath, [StringComparison]::OrdinalIgnoreCase) -lt 0 -or
      [math]::Abs(($process.CreationDate.ToUniversalTime() - $started).TotalMinutes) -gt 2 -or
      [math]::Abs(($native.StartTime.ToUniversalTime() -
        $process.CreationDate.ToUniversalTime()).TotalSeconds) -gt 2) {
    throw "Refusing to stop unverified supervisor daemon PID $($record.pid)"
  }
  Stop-Process -InputObject $native -Force -ErrorAction Stop
  Write-Host "[oa-supervisor] stopped verified daemon PID $($record.pid)."
  Start-Sleep -Milliseconds 250
  if (Test-Path $lock) { Remove-Item $lock -Force }
}

if ($Uninstall) {
  $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($existing) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "[oa-supervisor] removed scheduled task '$TaskName'."
  } else {
    Write-Host "[oa-supervisor] no scheduled task named '$TaskName'."
  }
  # Remove the unelevated fallback too, otherwise "uninstall" silently leaves a
  # supervisor running and the rollback claim in the docs would be false.
  $shim = Join-Path ([Environment]::GetFolderPath('Startup')) 'Overnight Agent supervisor.cmd'
  if (Test-Path $shim) { Remove-Item $shim -Force; Write-Host "[oa-supervisor] removed Startup shim $shim." }
  Stop-InstalledDaemon
  Write-Host "[oa-supervisor] uninstall complete."
  return
}

$nodeMajor = & node -p "process.versions.node.split('.')[0]"
if ($LASTEXITCODE -ne 0 -or -not $nodeMajor -or [int]$nodeMajor -lt 24) {
  throw 'Reliability supervisor requires Node.js 24+ for enterprise-parity SQLite session evidence.'
}
Stop-InstalledDaemon

# Prefer the deployed copy in the OA home: the scheduled task must keep working when
# a worktree is deleted, so it must not point into one.
$oaHome     = Join-Path $env:LOCALAPPDATA 'overnight-agent'
$deployed   = Join-Path $oaHome 'oa-supervisor.ps1'
$repoCopy   = Join-Path $PSScriptRoot 'oa-supervisor.ps1'
if (-not (Test-Path $oaHome)) { New-Item -ItemType Directory -Path $oaHome -Force | Out-Null }
# Always REFRESH, not seed-if-absent: re-running the installer after a plugin update must
# pick up the new supervisor. (sync-oa-home also keeps this copy current on every run now
# that oa-supervisor.ps1 is in its required set - this covers a manual/one-off install.)
Copy-Item $repoCopy $deployed -Force
foreach ($name in @('reliability-supervisor.mjs', 'windows-app-actuator.mjs',
                   'session-terminal-evidence.mjs', 'consumer-reliability-supervisor.mjs',
                   'oa-supervisor-daemon.ps1')) {
  $source = Join-Path $PSScriptRoot $name
  if (-not (Test-Path $source)) { throw "required reliability module missing: $source" }
  Copy-Item $source (Join-Path $oaHome $name) -Force
}
Write-Host "[oa-supervisor] deployed $deployed from the repo copy."
# stuck-run-sweep.mjs is resolved by the supervisor from the OA home too; sync-oa-home.ps1
# keeps both current on every run, so nothing here needs to pin a repo path.

$psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$daemonDst = Join-Path $oaHome 'oa-supervisor-daemon.ps1'
$argLine = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$daemonDst`" -IntervalMinutes $IntervalMinutes"
if ($NoAct) { $argLine += ' -NoAct' }

$action = New-ScheduledTaskAction -Execute $psExe -Argument $argLine

# Two triggers on purpose:
#   * at logon, so a reboot cannot silently leave supervision off;
#   * a repeating trigger with an effectively unbounded duration.
# Both repeat, so whichever fires first the cadence is maintained.
$atLogon = New-ScheduledTaskTrigger -AtLogOn
$atLogon.Repetition = (New-ScheduledTaskTrigger -Once -At (Get-Date) `
                        -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) `
                        -RepetitionDuration ([TimeSpan]::FromDays(3650))).Repetition

$startNow = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
              -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) `
              -RepetitionDuration ([TimeSpan]::FromDays(3650))

# S4U => runs whether or not the user is logged on, with NO stored password. It needs
# elevation to register, so fall back to Interactive when not elevated rather than
# failing. The fallback is honest about its limit: Interactive only fires while the
# user is logged on. That is acceptable here because the app - and therefore the agent
# it supervises - also only runs in an interactive session, so the supervisor's
# coverage still strictly contains the thing it supervises.
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
           ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$logonType = if ($isAdmin) { 'S4U' } else { 'Interactive' }
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
               -LogonType $logonType -RunLevel Limited

$settings = New-ScheduledTaskSettingsSet `
              -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
              -StartWhenAvailable `
              -ExecutionTimeLimit ([TimeSpan]::Zero) `
              -MultipleInstances IgnoreNew `
              -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 5)

$desc = "GH #226: out-of-band supervisor for the Overnight Agent. Runs every $IntervalMinutes min, " +
        "or sooner at M/N boundaries; dispatched by the OS rather than an agent run. " +
        "Read-only classification against the app database; on a genuine hang it silently RESTARTS " +
        "the app (no Telegram). Remove with: " +
        "powershell -File `"$PSCommandPath`" -Uninstall"

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }

# Task Scheduler is the preferred dispatcher. On this machine registering one is denied
# without elevation, and the agent cannot elevate itself, so a failure here must NOT
# leave the system unsupervised - it falls back to the Startup-folder daemon, which is
# still outside the failure domain and can be installed unattended.
$registered = $false
try {
  Register-ScheduledTask -TaskName $TaskName -Action $action `
    -Trigger @($atLogon, $startNow) -Principal $principal -Settings $settings `
    -Description $desc | Out-Null
  $registered = $true
} catch {
  Write-Host "[oa-supervisor] Task Scheduler registration failed: $($_.Exception.Message.Trim())"
  Write-Host "[oa-supervisor] falling back to the unelevated Startup-folder daemon."
}

if (-not $registered) {
  $startup = [Environment]::GetFolderPath('Startup')
  $shim    = Join-Path $startup 'Overnight Agent supervisor.cmd'
  $fallbackNoAct = if ($NoAct) { ' -NoAct' } else { '' }
@"
@echo off
rem GH #226 - out-of-band supervisor for the Overnight Agent.
rem Launched by Explorer at logon, so it is dispatched by the OS rather than by the
rem agent or the app scheduler. Remove this file to uninstall.
start "" /min "$psExe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "$daemonDst" -IntervalMinutes $IntervalMinutes$fallbackNoAct
"@ | Set-Content -Path $shim -Encoding ascii

  Write-Host "[oa-supervisor] installed Startup shim: $shim"
  Write-Host "[oa-supervisor] starting the daemon now so supervision does not wait for a reboot..."
  $daemonArgs = @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-WindowStyle','Hidden',
                  '-File', $daemonDst, '-IntervalMinutes', $IntervalMinutes)
  if ($NoAct) { $daemonArgs += '-NoAct' }
  Start-Process -FilePath $psExe -ArgumentList $daemonArgs `
    -WindowStyle Hidden | Out-Null
  Start-Sleep -Seconds 3
  Write-Host "[oa-supervisor] UNDO: delete `"$shim`" and stop the oa-supervisor-daemon powershell process."
  Write-Host "[oa-supervisor] UPGRADE (recommended, one elevated command):"
  Write-Host "               powershell -NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
  Write-Host "               run from an ADMIN prompt - it will register the real scheduled task instead."
  return
}

$oldShim = Join-Path ([Environment]::GetFolderPath('Startup')) 'Overnight Agent supervisor.cmd'
if (Test-Path $oldShim) { Remove-Item $oldShim -Force }
$t = Get-ScheduledTask -TaskName $TaskName
Write-Host "[oa-supervisor] registered '$TaskName' (state=$($t.State), every $IntervalMinutes min, logon type $logonType)."
if ($logonType -eq 'Interactive') {
  Write-Host "[oa-supervisor] NOTE: not elevated, so the task runs only while $env:USERNAME is logged on."
  Write-Host "[oa-supervisor]       Re-run this installer from an elevated prompt to upgrade it to S4U (runs logged-off too, no stored password)."
}
Write-Host "[oa-supervisor] runs: $psExe $argLine"
Write-Host "[oa-supervisor] UNDO:  powershell -NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Uninstall"
