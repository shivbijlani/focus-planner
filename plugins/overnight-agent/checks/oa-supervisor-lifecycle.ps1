# GH #648. This file is dot-sourced; all effects live behind small OS adapters.
function ConvertFrom-SupervisorJson([string]$Text) {
  $options = @{}
  if ((Get-Command ConvertFrom-Json).Parameters.ContainsKey('DateKind')) { $options.DateKind = 'String' }
  return ($Text | ConvertFrom-Json @options)
}

function ConvertTo-SupervisorMap($Value) {
  if ($null -eq $Value) { return $null }
  if ($Value -is [pscustomobject]) {
    $map = @{}
    foreach ($p in $Value.PSObject.Properties) { $map[$p.Name] = ConvertTo-SupervisorMap $p.Value }
    return $map
  }
  if ($Value -is [array]) { return ,@($Value | ForEach-Object { ConvertTo-SupervisorMap $_ }) }
  return $Value
}

function ConvertTo-SupervisorUtc($Value) {
  if ($Value -is [datetime]) { return $Value.ToUniversalTime() }
  return [datetime]::Parse($Value, [cultureinfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
}

function Get-RestartConfig {
  if ($RestartCooldownMinutes -lt 0) { throw 'RestartCooldownMinutes must be non-negative (fault-only spacing)' }
  $config = ConvertTo-SupervisorMap (ConvertFrom-SupervisorJson ([IO.File]::ReadAllText((Join-Path $PSScriptRoot 'supervisor-defaults.json'))))
  $override = Join-Path $OaHome 'supervisor-config.json'
  if (Test-Path $override) {
    $extra = ConvertTo-SupervisorMap (ConvertFrom-SupervisorJson ([IO.File]::ReadAllText($override)))
    if ($extra -isnot [hashtable]) { throw 'supervisor-config.json must be an object' }
    foreach ($key in $extra.Keys) {
      if (-not $config.ContainsKey($key)) { throw "unknown supervisor config key: $key" }
      $config[$key] = $extra[$key]
    }
  }
  foreach ($key in @('preventiveStartHours','preventiveDeadlineHours','pollSeconds','quietSeconds','evidenceMaxAgeSeconds','retryInitialSeconds','retryMaxSeconds','readinessTimeoutSeconds')) {
    if ($config[$key] -isnot [ValueType] -or $config[$key] -is [bool] -or [double]::IsNaN([double]$config[$key]) -or [double]::IsInfinity([double]$config[$key]) -or $config[$key] -lt 0) {
      throw "invalid numeric config: $key"
    }
  }
  if ($config.preventiveStartHours -ge $config.preventiveDeadlineHours) { throw 'require 0 <= preventiveStartHours < preventiveDeadlineHours' }
  foreach ($key in @('pollSeconds','quietSeconds','evidenceMaxAgeSeconds','retryInitialSeconds','readinessTimeoutSeconds')) {
    if ($config[$key] -lt 1) { throw "$key must be at least 1 second" }
  }
  if ($config.quietSeconds -gt $config.evidenceMaxAgeSeconds -or $config.retryMaxSeconds -lt $config.retryInitialSeconds) { throw 'invalid quiet/freshness or retry bounds' }
  if (-not $config.appExe) { $config.appExe = Join-Path $env:LOCALAPPDATA 'Programs\GitHub Copilot\github.exe' }
  if (-not [IO.Path]::IsPathRooted($config.appExe)) { throw 'appExe must be an absolute executable path' }
  $config.appExe = [IO.Path]::GetFullPath($config.appExe)
  return $config
}

function Get-RestartDecision($Config, $Cycle, $Activity, [datetime]$Now, $QuietSince, [bool]$Fault = $false) {
  $age = ($Now - (ConvertTo-SupervisorUtc $Cycle.startedUtc)).TotalHours
  if ($age -lt 0) { return 'clock-regressed' }
  if ($age -ge $Config.preventiveDeadlineHours) { return 'deadline-forced' }
  if ($age -lt $Config.preventiveStartHours -and -not $Fault) { return 'before-window' }
  if ($Activity.state -ne 'IDLE') { return 'wait-activity' }
  if (($Now - (ConvertTo-SupervisorUtc $Activity.measuredUtc)).TotalSeconds -gt $Config.evidenceMaxAgeSeconds) { return 'wait-stale-evidence' }
  if (-not $QuietSince -or ($Now - (ConvertTo-SupervisorUtc $QuietSince)).TotalSeconds -lt $Config.quietSeconds) { return 'measuring-quiet' }
  if ($Fault) { return 'fault-quiet' }
  return 'preventive-quiet'
}

function Write-RestartState($State) {
  $tmp = "$StatePath.$PID.tmp"
  try {
    $bytes = [Text.Encoding]::UTF8.GetBytes(($State | ConvertTo-Json -Depth 20))
    $stream = [IO.File]::Open($tmp, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
    if (Test-Path $StatePath) { [IO.File]::Replace($tmp, $StatePath, "$StatePath.previous") }
    else { [IO.File]::Move($tmp, $StatePath) }
  } finally {
    if (Test-Path $tmp) { Remove-Item -LiteralPath $tmp -Force }
    if (Test-Path "$StatePath.previous") { Remove-Item -LiteralPath "$StatePath.previous" -Force }
  }
}

function Get-SupervisorProcesses {
  return @(Get-CimInstance Win32_Process -ErrorAction Stop | ForEach-Object {
    @{
      id = [int]$_.ProcessId; parentId = [int]$_.ParentProcessId
      path = $_.ExecutablePath; name = $_.Name; sessionId = [int]$_.SessionId
      startedUtc = $(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { $null })
    }
  })
}

function Get-TargetApp($Processes, $Config) {
  $sessionId = (Get-Process -Id $PID -ErrorAction Stop).SessionId
  if (@($Processes | Where-Object { $_.name -ieq 'github.exe' -and $_.sessionId -eq $sessionId -and -not $_.path }).Count) {
    throw 'GUI process path unavailable; app absence is not proven'
  }
  $matches = @($Processes | Where-Object { $_.path -and $_.path -ieq $Config.appExe -and $_.sessionId -eq $sessionId })
  if ($matches.Count -gt 1) { throw 'multiple matching app instances; refusing ambiguous ownership' }
  if ($matches.Count -eq 0) { return $null }
  $app = $matches[0]
  if (-not $app.startedUtc) { throw 'app creation time unavailable' }
  $app.identity = "$($app.path.ToLowerInvariant())|$($app.id)|$($app.startedUtc)"
  return $app
}

function Get-OwnedProcesses($Processes, $App) {
  if (-not $App) { return @() }
  $owned = @($App)
  $ids = @($App.id)
  do {
    $added = @($Processes | Where-Object {
      $candidate = $_
      if ($candidate.id -in $ids -or $candidate.parentId -notin $ids -or -not $candidate.path -or -not $candidate.startedUtc) { return $false }
      $parent = $owned | Where-Object { $_.id -eq $candidate.parentId } | Select-Object -First 1
      return (ConvertTo-SupervisorUtc $candidate.startedUtc) -ge (ConvertTo-SupervisorUtc $parent.startedUtc)
    })
    $owned += $added
    $ids += @($added | ForEach-Object { $_.id })
  } while ($added.Count)
  if ($PID -in $ids) { throw 'supervisor is inside target tree; restart requires an external dispatcher' }
  return $owned
}

function Get-SupervisorActivity($Processes, $Owned, $Config) {
  $inputPath = Join-Path $OaHome ("activity-$PID.json")
  try {
    @{
      dbPath = $Db; sessionRoot = (Join-Path $env:USERPROFILE '.copilot\session-state')
      workflowName = $WorkflowName
      processes = @($Processes); ownedIds = @($Owned | ForEach-Object { $_.id })
      now = [long]((Get-Date).ToUniversalTime() - [datetime]'1970-01-01').TotalMilliseconds
      maxAgeSeconds = $Config.evidenceMaxAgeSeconds
    } | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $inputPath -Encoding UTF8
    $raw = & node --disable-warning=ExperimentalWarning (Join-Path $PSScriptRoot 'supervisor-activity.mjs') $inputPath 2>&1
    if ($LASTEXITCODE -ne 0) { throw "activity probe failed: $raw" }
    return ConvertTo-SupervisorMap (ConvertFrom-SupervisorJson ($raw -join "`n"))
  } catch {
    return @{ state = 'UNKNOWN'; measuredUtc = (Get-Date).ToUniversalTime().ToString('o'); sessions = @(); unknown = @("$_"); scheduledRuns = @() }
  } finally { if (Test-Path $inputPath) { Remove-Item -LiteralPath $inputPath -Force } }
}

function Test-AppReady($App) {
  if (-not $App) { return $false }
  $native = Get-Process -Id $App.id -ErrorAction SilentlyContinue
  if (-not $native) { return $false }
  try {
    return $native.Path -ieq $App.path -and $native.StartTime.ToUniversalTime() -eq (ConvertTo-SupervisorUtc $App.startedUtc) -and
      $native.MainWindowHandle -ne 0 -and $native.Responding
  } finally { $native.Dispose() }
}

function Stop-OwnedProcess($Target) {
  $native = Get-Process -Id $Target.id -ErrorAction SilentlyContinue
  if (-not $native) { return $false }
  try {
    # Hold the process handle until after termination: Windows cannot recycle its PID
    # while this handle is open. A PID-only recheck does not provide that property.
    $handle = $native.Handle
    if (-not $handle -or $native.Path -ine $Target.path -or $native.StartTime.ToUniversalTime() -ne (ConvertTo-SupervisorUtc $Target.startedUtc)) {
      throw "process identity changed: $($Target.id)"
    }
    Stop-Process -Id $Target.id -Force -ErrorAction Stop
    if (-not $native.WaitForExit(5000)) { throw "process did not exit: $($Target.id)" }
    return $true
  } finally { $native.Dispose() }
}

function Get-ObservedQuietSince($Prior, $Activity, [datetime]$Now) {
  $since = if ($Prior) { ConvertTo-SupervisorUtc $Prior } else { $Now }
  foreach ($session in $Activity.sessions) {
    if ($session.lastEventUtc) {
      $last = ConvertTo-SupervisorUtc $session.lastEventUtc
      if ($last -gt $since) { $since = $last }
    }
  }
  return $since.ToString('o')
}

function New-RestartCycle($App) {
  return @{ identity = $App.identity; startedUtc = $App.startedUtc; app = $App }
}

function Get-RetryTargets($Targets, $Processes) {
  $remaining = @()
  foreach ($target in $Targets) {
    $current = @($Processes | Where-Object { $_.id -eq $target.id })
    if (-not $current.Count) { continue }
    if ($current.Count -ne 1 -or -not $current[0].path -or -not $current[0].startedUtc) { throw "retry target identity unavailable: $($target.id)" }
    # A recycled PID proves the old incarnation is gone, not that its new owner
    # belongs to us. Skip it without obstructing recovery of the app.
    if ($current[0].path -ieq $target.path -and (ConvertTo-SupervisorUtc $current[0].startedUtc) -eq (ConvertTo-SupervisorUtc $target.startedUtc)) { $remaining += $target }
  }
  return $remaining
}

function Get-NextSupervisorCheck($Config, $State, [datetime]$Now) {
  $next = $Now.AddSeconds($Config.pollSeconds)
  if ($State.cycle) {
    foreach ($hours in @($Config.preventiveStartHours, $Config.preventiveDeadlineHours)) {
      $at = (ConvertTo-SupervisorUtc $State.cycle.startedUtc).AddHours($hours)
      if ($at -gt $Now -and $at -lt $next) { $next = $at }
    }
  }
  if ($State.quietSince) {
    $at = (ConvertTo-SupervisorUtc $State.quietSince).AddSeconds($Config.quietSeconds)
    if ($at -gt $Now -and $at -lt $next) { $next = $at }
  }
  if ($State.attempt -and $State.attempt.retryUtc) {
    $at = ConvertTo-SupervisorUtc $State.attempt.retryUtc
    if ($at -gt $Now -and $at -lt $next) { $next = $at }
  }
  return $next.ToString('o')
}

function Invoke-RestartTick {
  $config = Get-RestartConfig
  $state = @{ version = 1; cycle = $null; attempt = $null; quietSince = $null; lastSampleUtc = $null }
  if (Test-Path $StatePath) {
    $saved = ConvertTo-SupervisorMap (ConvertFrom-SupervisorJson ([IO.File]::ReadAllText($StatePath)))
    if ($saved -isnot [hashtable]) { throw 'invalid supervisor state object' }
    # The old incident cooldown is not a maintenance cycle. First upgrade anchors to
    # the actual running process, never to installation time.
    if ($saved.version) {
      if ($saved.version -ne 1) { throw 'unsupported supervisor state version' }
      foreach ($key in @('cycle','attempt','quietSince','lastSampleUtc')) {
        if (-not $saved.ContainsKey($key)) { throw "incomplete supervisor state: $key" }
      }
      if ($saved.cycle) {
        if (-not $saved.cycle.identity -or -not $saved.cycle.startedUtc -or -not $saved.cycle.app) { throw 'invalid persisted cycle identity' }
        $null = ConvertTo-SupervisorUtc $saved.cycle.startedUtc
      }
      if ($saved.attempt) {
        if (-not $saved.attempt.id -or $saved.attempt.count -lt 1 -or -not $saved.attempt.startedUtc -or -not $saved.attempt.retryUtc) { throw 'invalid persisted attempt' }
        $null = ConvertTo-SupervisorUtc $saved.attempt.startedUtc
        $null = ConvertTo-SupervisorUtc $saved.attempt.retryUtc
      }
      $state = $saved
    }
  }
  $now = (Get-Date).ToUniversalTime()
  $processes = @(Get-SupervisorProcesses)
  $app = Get-TargetApp $processes $config
  $owned = @(Get-OwnedProcesses $processes $app)
  $activity = Get-SupervisorActivity $processes $owned $config
  $ready = Test-AppReady $app
  $result = @{
    state = 'HEALTHY'; action = 'none'; acted = $false; noAct = [bool]$NoAct
    activity = $activity; thresholds = $config; app = $app; readiness = $ready
    reason = 'observing'; killed = @(); launched = $false; affectedSessions = @()
    automationRecovery = @{ state = 'not-observed'; runs = @(); work = @() }
  }
  # A crash after launch but before recording its PID is recovered from exact executable
  # identity plus a creation time newer than the durable launch intent.
  if ($state.attempt -and $app -and $app.identity -ne $state.attempt.oldIdentity) {
    if ((ConvertTo-SupervisorUtc $app.startedUtc) -lt (ConvertTo-SupervisorUtc $state.attempt.startedUtc)) { throw 'unexpected app identity during recovery' }
    if ($ready) {
      $state.cycle = New-RestartCycle $app
      $state.lastRecoveryUtc = $app.startedUtc
      $state.attempt = $null
      $state.quietSince = $null
      $result.reason = 'restart-verified'
    } else { $result.reason = 'awaiting-readiness' }
  } elseif (-not $state.attempt -and $app -and (-not $state.cycle -or $state.cycle.identity -ne $app.identity)) {
    if ($ready -or -not $state.cycle) {
      $state.cycle = New-RestartCycle $app
      $state.quietSince = $null
      $result.reason = 'app-start-observed'
    } else { $result.reason = 'unverified-app-start' }
  }
  if ($state.lastRecoveryUtc) {
    $since = ConvertTo-SupervisorUtc $state.lastRecoveryUtc
    $runs = @($activity.scheduledRuns | Where-Object { (ConvertTo-SupervisorUtc $_.started_at) -ge $since })
    $work = @($activity.sessions | Where-Object { $_.lastEventUtc -and (ConvertTo-SupervisorUtc $_.lastEventUtc) -ge $since -and $_.state -eq 'BUSY' })
    $result.automationRecovery = @{
      state = $(if ($runs.Count) { 'schedule-observed' } elseif ($work.Count) { 'work-observed' } else { 'not-observed' })
      runs = $runs; work = $work
    }
  }
  $fault = $false
  $verdict = Get-SupervisorVerdict -NewestRun $activity.newestRun -Now $now -StuckMinutes $StuckMinutes -DeadMinutes $DeadMinutes -AppRunning ([bool]$app)
  $result.state = $verdict.state
  $sample = if ($ResourceFactsJson) { ConvertFrom-SupervisorJson ([IO.File]::ReadAllText($ResourceFactsJson)) } else { Get-ResourceSample }
  $resource = Get-ResourceVerdict $sample
  $result.resource = $resource
  if ($verdict.state -eq 'HEALTHY' -and $resource.state -ne 'HEALTHY') { $result.state = $resource.state }
  $faultAction = Get-SupervisorAction -State $result.state -FlaggedOrphans 0 -HasHungAlive $false -AppRunning ([bool]$app)
  $fault = $faultAction -eq 'restart'
  # The old incident cooldown was not global spacing. Keep a fault-only floor;
  # A supplies preventive spacing and B always overrides this fault throttle.
  if ($state.cycle -and ($now - (ConvertTo-SupervisorUtc $state.cycle.startedUtc)).TotalMinutes -lt $RestartCooldownMinutes) { $fault = $false }
  $now = (Get-Date).ToUniversalTime()
  if ($activity.state -ne 'IDLE' -or -not $ready -or -not $state.lastSampleUtc -or
      ($now - (ConvertTo-SupervisorUtc $state.lastSampleUtc)).TotalSeconds -gt ($config.pollSeconds + $config.evidenceMaxAgeSeconds)) {
    $state.quietSince = $null
  }
  if ($activity.state -eq 'IDLE' -and $ready) { $state.quietSince = Get-ObservedQuietSince $state.quietSince $activity $now }
  $state.lastSampleUtc = $now.ToString('o')
  $decision = if ($state.cycle) { Get-RestartDecision $config $state.cycle $activity $now $state.quietSince $fault } else { 'unverified-app-start' }
  if ($state.attempt) {
    $result.reason = 'retry-backoff'
    if ($now -ge (ConvertTo-SupervisorUtc $state.attempt.retryUtc)) { $decision = 'retry' } else { $decision = 'retry-backoff' }
  }
  if (-not $app -and -not $state.attempt) { $decision = 'app-down' }
  $result.decision = $decision
  $requested = $decision -in @('deadline-forced','preventive-quiet','fault-quiet','retry','app-down')
  if ($requested -and -not $NoAct) {
    # Immediate recheck, but no admission hold: best-effort before B, not a race-free promise.
    $freshProcesses = @(Get-SupervisorProcesses)
    $freshApp = Get-TargetApp $freshProcesses $config
    if (($app -and (-not $freshApp -or $app.identity -ne $freshApp.identity)) -or (-not $app -and $freshApp)) {
      $result.reason = 'app-changed-before-action'
      $state.quietSince = $null
    } else {
      $freshOwned = @(Get-OwnedProcesses $freshProcesses $freshApp)
      $freshActivity = Get-SupervisorActivity $freshProcesses $freshOwned $config
      $actionNow = (Get-Date).ToUniversalTime()
      $forced = $state.cycle -and ($actionNow - (ConvertTo-SupervisorUtc $state.cycle.startedUtc)).TotalHours -ge $config.preventiveDeadlineHours
      if ($freshActivity.state -eq 'IDLE' -and $state.quietSince) { $state.quietSince = Get-ObservedQuietSince $state.quietSince $freshActivity $actionNow }
      $retryTargets = @(Get-RetryTargets $state.attempt.targets $freshProcesses)
      $hasTargets = $app -or $retryTargets.Count -gt 0
      $quietMeasured = $state.quietSince -and ($actionNow - (ConvertTo-SupervisorUtc $state.quietSince)).TotalSeconds -ge $config.quietSeconds
      if ($hasTargets -and -not $forced -and ($freshActivity.state -ne 'IDLE' -or ($app -and -not $ready) -or -not $quietMeasured)) {
        $result.reason = 'activity-changed-before-action'
        $state.quietSince = $null
      } else {
        $result.activity = $freshActivity
        $result.action = $(if ($app) { 'restart' } else { 'launch' })
        $result.reason = $(if ($forced) { 'deadline-forced' } else { $decision })
        $count = if ($state.attempt) { [int]$state.attempt.count + 1 } else { 1 }
        $oldIdentity = if ($state.attempt) { $state.attempt.oldIdentity } elseif ($app) { $app.identity } else { $null }
        $targets = if ($state.attempt) { $retryTargets } else { $freshOwned }
        $targetIds = @($targets | ForEach-Object { $_.id })
        $result.affectedSessions = @($freshActivity.sessions | Where-Object { $_.ownerId -in $targetIds })
        $delay = [math]::Min($config.retryMaxSeconds, $config.retryInitialSeconds * [math]::Pow(2, [math]::Min(20, $count - 1)))
        $state.attempt = @{
          id = [guid]::NewGuid().ToString('N'); oldIdentity = $oldIdentity; targets = $targets
          startedUtc = $(if ($state.attempt) { $state.attempt.startedUtc } else { $actionNow.ToString('o') })
          retryUtc = $actionNow.AddSeconds($delay).ToString('o'); count = $count; phase = 'prepared'
          reason = $result.reason; activity = $freshActivity.state; affectedSessions = $result.affectedSessions
        }
        Write-RestartState $state
        try {
          if (-not (Test-Path -LiteralPath $config.appExe -PathType Leaf)) { throw 'configured app executable not found' }
          # Never kill a newly launched, unready replacement. Leave it running for diagnosis
          # and probe readiness again with backoff instead of a repeated kill loop.
          if ($app -and $app.identity -ne $oldIdentity) { throw 'replacement app is not ready; no repeat termination' }
          foreach ($target in $targets) {
            if (Stop-OwnedProcess $target) { $result.killed += $target }
          }
          $state.attempt.phase = 'launching'
          Write-RestartState $state
          $replacement = Start-Process -FilePath $config.appExe -PassThru -ErrorAction Stop
          $result.launched = $true
          $state.attempt.launchedPid = $replacement.Id
          $replacement.Dispose()
          $state.attempt.phase = 'awaiting-readiness'
          Write-RestartState $state
          $until = (Get-Date).ToUniversalTime().AddSeconds($config.readinessTimeoutSeconds)
          do {
            $newApp = Get-TargetApp @(Get-SupervisorProcesses) $config
            if ($newApp -and $newApp.identity -ne $oldIdentity -and (Test-AppReady $newApp)) {
              $state.cycle = New-RestartCycle $newApp
              $state.lastRecoveryUtc = $newApp.startedUtc
              $state.attempt = $null
              $state.quietSince = $null
              $result.acted = $true
              $result.readiness = $true
              $result.app = $newApp
              break
            }
            Start-Sleep -Milliseconds 250
          } while ((Get-Date).ToUniversalTime() -lt $until)
          if (-not $result.acted) { throw 'launch observed but app readiness not verified' }
        } catch {
          $result.error = "$_"
          $result.readiness = $false
          if ($state.attempt) { $state.attempt.error = "$_" }
        }
      }
    }
  } elseif ($requested) { $result.reason = 'detect-only' }
  # Row repair is allowed only on globally idle evidence. Silence during a running
  # tool must not let the old sweep clear that workflow's executing slot (#643).
  if ($verdict.state -eq 'STUCK' -and $activity.state -eq 'IDLE' -and -not $requested -and -not $NoAct) {
    $sweep = Join-Path $PSScriptRoot 'stuck-run-sweep.mjs'
    $out = & node --disable-warning=ExperimentalWarning $sweep --repair 2>&1
    $result.sweep = $out -join "`n"
    if ($LASTEXITCODE -notin @(0,1)) { $result.sweepError = "sweep exited $LASTEXITCODE" }
  }
  if (-not $NoAct) { Write-RestartState $state }
  $result.cycle = $state.cycle
  $result.attempt = $state.attempt
  $result.nextCheckUtc = Get-NextSupervisorCheck $config $state ((Get-Date).ToUniversalTime())
  return $result
}
