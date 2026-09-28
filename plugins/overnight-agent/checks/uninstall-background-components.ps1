<#
.SYNOPSIS
  Inventory, back up, and remove this plugin's legacy OS-level supervisors.

.DESCRIPTION
  Scope is deliberately fixed to the two task names, two Startup shims, and two
  script command lines owned by this plugin. Processes are stopped only by PID after
  their command line positively identifies the owned script.
#>
[CmdletBinding(SupportsShouldProcess)]
param(
  [string]$BackupDirectory,
  [string]$StartupDirectory = [Environment]::GetFolderPath('Startup'),
  [switch]$Json
)

$ErrorActionPreference = 'Stop'

if (-not $BackupDirectory) {
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $BackupDirectory = Join-Path $env:LOCALAPPDATA "overnight-agent\backups\background-uninstall-$stamp"
}
if (-not $WhatIfPreference -and -not (Test-Path -LiteralPath $BackupDirectory)) {
  New-Item -ItemType Directory -Path $BackupDirectory -Force | Out-Null
}

$ownedTaskNames = @('Overnight Agent supervisor', 'Copilot browser watchdog')
$ownedShimNames = @('Overnight Agent supervisor.cmd', 'CopilotBrowserWatchdog.vbs')
$ownedScriptPattern = '(?i)(?:^|\s)-File\s+(?:"[^"]*\\|[^\s"]*\\)?(?:oa-supervisor-daemon|browser-watchdog)\.ps1"?(?:\s|$)'

$report = [ordered]@{
  backupDirectory = [IO.Path]::GetFullPath($BackupDirectory)
  tasks = @()
  startupShims = @()
  processes = @()
}

foreach ($taskName in $ownedTaskNames) {
  $task = $null
  if (Get-Command Get-ScheduledTask -ErrorAction SilentlyContinue) {
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  }
  if (-not $task) { continue }

  $xmlPath = Join-Path $BackupDirectory (($taskName -replace '[^A-Za-z0-9.-]', '-') + '.xml')
  if (-not $WhatIfPreference -and (Get-Command Export-ScheduledTask -ErrorAction SilentlyContinue)) {
    Export-ScheduledTask -TaskName $taskName | Set-Content -LiteralPath $xmlPath -Encoding utf8
  }
  $removed = $false
  if ($PSCmdlet.ShouldProcess("scheduled task '$taskName'", 'Unregister')) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    $removed = $true
  }
  $report.tasks += [pscustomobject]@{ name = $taskName; backup = $xmlPath; removed = $removed }
}

foreach ($shimName in $ownedShimNames) {
  $path = Join-Path $StartupDirectory $shimName
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { continue }

  $backup = Join-Path $BackupDirectory $shimName
  if (-not $WhatIfPreference) { Copy-Item -LiteralPath $path -Destination $backup -Force }
  $removed = $false
  if ($PSCmdlet.ShouldProcess($path, 'Remove Startup shim')) {
    Remove-Item -LiteralPath $path -Force
    $removed = $true
  }
  $report.startupShims += [pscustomobject]@{ path = $path; backup = $backup; removed = $removed }
}

if (Get-Command Get-CimInstance -ErrorAction SilentlyContinue) {
  $processes = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -match $ownedScriptPattern })
  foreach ($process in $processes) {
    $stopped = $false
    if ($PSCmdlet.ShouldProcess("PID $($process.ProcessId): $($process.CommandLine)", 'Stop owned daemon')) {
      Stop-Process -Id ([int]$process.ProcessId) -Force
      $stopped = $true
    }
    $report.processes += [pscustomobject]@{
      pid = [int]$process.ProcessId
      commandLine = [string]$process.CommandLine
      stopped = $stopped
    }
  }
}

if (-not $WhatIfPreference) {
  $evidence = Join-Path $BackupDirectory 'uninstall-report.json'
  $report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $evidence -Encoding utf8
}

if ($Json) {
  $report | ConvertTo-Json -Depth 6
} else {
  Write-Host "[background-uninstall] backup: $BackupDirectory"
  Write-Host "[background-uninstall] tasks: $($report.tasks.Count); Startup shims: $($report.startupShims.Count); processes: $($report.processes.Count)"
}
