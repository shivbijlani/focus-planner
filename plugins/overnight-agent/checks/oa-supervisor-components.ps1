# Fixed, reviewed components: adding a component never adds another startup route.
function Get-OaSupervisorComponents {
  param([string]$OaHome, [int]$IntervalMinutes = 15, [switch]$NoAct)
  @(
    [ordered]@{
      name = 'oa-supervisor'; label = 'Overnight Agent'; script = (Join-Path $OaHome 'oa-supervisor.ps1')
      arguments = @($(if ($NoAct) { '-NoAct' })); intervalMinutes = $IntervalMinutes
    }
    [ordered]@{
      name = 'browser-watchdog'; label = 'Browser watchdog'; script = (Join-Path $OaHome 'browser-watchdog.ps1')
      arguments = @('-Json') + @($(if ($NoAct) { '-ReportOnly' })); intervalMinutes = 60
    }
  )
}

function New-OaComponentState {
  param([bool]$Enabled = $true)
  [ordered]@{
    state = $(if ($Enabled) { 'STARTING' } else { 'OFF' }); enabled = $Enabled; paused = $false
    recent = @(); error = $null; lastEvaluationUtc = $null; lastExitCode = $null
    nextEvaluationAt = (Get-Date).ToUniversalTime(); overdue = $null
    process = $null; startedUtc = $null; stdout = $null; stderr = $null
  }
}

function Stop-OaComponentProcess {
  param([Diagnostics.Process]$Process)
  if (-not $Process -or $Process.HasExited) { return }
  $rootStart = $Process.StartTime.ToUniversalTime()
  $rows = @(Get-CimInstance Win32_Process -ErrorAction Stop)
  $root = $rows | Where-Object { $_.ProcessId -eq $Process.Id } | Select-Object -First 1
  if (-not $root) { return }
  if ([math]::Abs(($root.CreationDate.ToUniversalTime() - $rootStart).TotalMilliseconds) -gt 10) {
    throw "Child PID $($Process.Id) changed identity; refusing to stop it."
  }
  $owned = @($root)
  for ($index = 0; $index -lt $owned.Count; $index++) {
    $parent = $owned[$index]
    # Keep launched desktop apps and browser windows alive, including their descendants.
    $owned += @($rows | Where-Object {
      $_.ParentProcessId -eq $parent.ProcessId -and $_.CreationDate -ge $parent.CreationDate -and
      $_.Name -in @('powershell.exe', 'pwsh.exe', 'node.exe') -and
      $_.ProcessId -notin @($owned.ProcessId)
    })
  }
  # Stop the parent first so it cannot create more workers during cancellation.
  foreach ($row in $owned) {
    $current = Get-CimInstance Win32_Process -Filter "ProcessId = $($row.ProcessId)" -ErrorAction Stop
    if (-not $current) { continue }
    if ($current.CreationDate -ne $row.CreationDate -or $current.ExecutablePath -ne $row.ExecutablePath -or
        $current.CommandLine -ne $row.CommandLine) {
      throw "Child PID $($row.ProcessId) changed identity; refusing to stop it."
    }
    $target = Get-Process -Id $row.ProcessId -ErrorAction SilentlyContinue
    if ($target -and -not $target.HasExited) {
      if ([math]::Abs(($target.StartTime.ToUniversalTime() - $row.CreationDate.ToUniversalTime()).TotalMilliseconds) -gt 10) {
        throw "Child PID $($row.ProcessId) changed before cancellation."
      }
      $target.Kill()
      if (-not $target.WaitForExit(5000)) { throw "Child PID $($row.ProcessId) did not exit." }
    }
  }
}

function Remove-OaComponentOutput {
  param($State)
  foreach ($path in @($State.stdout, $State.stderr)) {
    if ($path) { Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue }
  }
}
