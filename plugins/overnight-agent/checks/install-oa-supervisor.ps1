<#
.SYNOPSIS
  Registers (or removes) the OS-level Windows Scheduled Task that runs oa-supervisor.ps1.

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
  How often the supervisor runs. Default 15 - fast enough that the worst case exposure
  is a quarter hour rather than the 3.8 days the worst recorded stall actually ran.

.PARAMETER Uninstall
  Remove the scheduled task and exit.
#>
[CmdletBinding()]
param(
  [int]$IntervalMinutes = 15,
  [string]$TaskName = 'Overnight Agent supervisor',
  [switch]$Uninstall,
  [switch]$NoAlert
)

$ErrorActionPreference = 'Stop'

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
  $lock = Join-Path (Join-Path $env:LOCALAPPDATA 'overnight-agent') 'supervisor-daemon.lock'
  if (Test-Path $lock) {
    try {
      $p = (Get-Content $lock -Raw | ConvertFrom-Json).pid
      if ($p -and (Get-Process -Id $p -ErrorAction SilentlyContinue)) {
        Stop-Process -Id $p -Force
        Write-Host "[oa-supervisor] stopped running daemon (pid $p)."
      }
    } catch { }
    Remove-Item $lock -Force -ErrorAction SilentlyContinue
  }
  Write-Host "[oa-supervisor] uninstall complete."
  return
}

# Prefer the deployed copy in the OA home: the scheduled task must keep working when
# a worktree is deleted, so it must not point into one.
$oaHome     = Join-Path $env:LOCALAPPDATA 'overnight-agent'
$deployed   = Join-Path $oaHome 'oa-supervisor.ps1'
$repoCopy   = Join-Path $PSScriptRoot 'oa-supervisor.ps1'
if (-not (Test-Path $deployed)) {
  if (-not (Test-Path $oaHome)) { New-Item -ItemType Directory -Path $oaHome -Force | Out-Null }
  Copy-Item $repoCopy $deployed -Force
  Write-Host "[oa-supervisor] seeded $deployed from the repo copy."
}
# stuck-run-sweep.mjs is resolved by the supervisor from the OA home too; sync-oa-home.ps1
# keeps both current on every run, so nothing here needs to pin a repo path.

$psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$argLine = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$deployed`""
if ($NoAlert) { $argLine += ' -NoAlert' }

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
              -ExecutionTimeLimit (New-TimeSpan -Minutes 10) `
              -MultipleInstances IgnoreNew `
              -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 5)

$desc = "GH #226: out-of-band supervisor for the Overnight Agent. Runs every $IntervalMinutes min, " +
        "dispatched by the OS rather than by an agent run, so it can observe the agent NOT running. " +
        "Read-only against the app database; alerts Telegram. Remove with: " +
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
  $daemonSrc  = Join-Path $PSScriptRoot 'oa-supervisor-daemon.ps1'
  $daemonDst  = Join-Path $oaHome 'oa-supervisor-daemon.ps1'
  if (Test-Path $daemonSrc) { Copy-Item $daemonSrc $daemonDst -Force }

  $startup = [Environment]::GetFolderPath('Startup')
  $shim    = Join-Path $startup 'Overnight Agent supervisor.cmd'
@"
@echo off
rem GH #226 - out-of-band supervisor for the Overnight Agent.
rem Launched by Explorer at logon, so it is dispatched by the OS rather than by the
rem agent or the app scheduler. Remove this file to uninstall.
start "" /min "$psExe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "$daemonDst" -IntervalMinutes $IntervalMinutes
"@ | Set-Content -Path $shim -Encoding ascii

  Write-Host "[oa-supervisor] installed Startup shim: $shim"
  Write-Host "[oa-supervisor] starting the daemon now so supervision does not wait for a reboot..."
  Start-Process -FilePath $psExe `
    -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-WindowStyle','Hidden',
                    '-File', $daemonDst, '-IntervalMinutes', $IntervalMinutes) `
    -WindowStyle Hidden | Out-Null
  Start-Sleep -Seconds 3
  Write-Host "[oa-supervisor] UNDO: delete `"$shim`" and stop the oa-supervisor-daemon powershell process."
  Write-Host "[oa-supervisor] UPGRADE (recommended, one elevated command):"
  Write-Host "               powershell -NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
  Write-Host "               run from an ADMIN prompt - it will register the real scheduled task instead."
  return
}

$t = Get-ScheduledTask -TaskName $TaskName
Write-Host "[oa-supervisor] registered '$TaskName' (state=$($t.State), every $IntervalMinutes min, logon type $logonType)."
if ($logonType -eq 'Interactive') {
  Write-Host "[oa-supervisor] NOTE: not elevated, so the task runs only while $env:USERNAME is logged on."
  Write-Host "[oa-supervisor]       Re-run this installer from an elevated prompt to upgrade it to S4U (runs logged-off too, no stored password)."
}
Write-Host "[oa-supervisor] runs: $psExe $argLine"
Write-Host "[oa-supervisor] UNDO:  powershell -NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Uninstall"
