<#
.SYNOPSIS
  Deterministic tests for the reliability supervisor tray's startup/lock helpers
  and the install-oa-reliability-tray.ps1 opt-in flow (GH #695).

.DESCRIPTION
  Runs entirely against isolated state: a temp directory standing in for
  %LOCALAPPDATA%, and (for the Enable/Disable end-to-end case) a throwaway HKCU
  registry key instead of the real Run value, so this never touches a real
  machine's startup configuration or the real supervisor lock.

  Exit 0 = all assertions passed. Non-zero = at least one failed; failures are
  printed to stderr.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$failures = New-Object System.Collections.Generic.List[string]

function Assert-Equal($Actual, $Expected, [string]$Message) {
  if ("$Actual" -ne "$Expected") {
    $failures.Add("FAIL: $Message (expected [$Expected], got [$Actual])")
  } else {
    Write-Host "ok - $Message"
  }
}

function Assert-True($Condition, [string]$Message) {
  if (-not $Condition) { $failures.Add("FAIL: $Message") } else { Write-Host "ok - $Message" }
}

$checksDir = $PSScriptRoot
$root = New-Item -ItemType Directory -Path (Join-Path ([IO.Path]::GetTempPath()) "oa-reliability-tray-test-$([Guid]::NewGuid().ToString('N').Substring(0,8))") -Force
$originalLocalAppData = $env:LOCALAPPDATA
$testKey = 'HKCU:\Software\FocusPlannerReliabilityTrayTest'
try {
  $env:LOCALAPPDATA = $root.FullName
  . (Join-Path $checksDir 'oa-supervisor-startup.ps1')

  # ---- Get-OaSupervisorFiles: paths are derived from LOCALAPPDATA, not hardcoded ----
  $files = Get-OaSupervisorFiles
  Assert-Equal $files.home (Join-Path $root.FullName 'overnight-agent') 'home resolves under LOCALAPPDATA'
  Assert-True ($files.lock -like '*supervisor-tray.lock') 'lock path is the tray-specific lock file'
  Assert-True ($files.consumer -like '*consumer-reliability-supervisor.mjs') 'consumer path points at the checker'

  # ---- Get-OaTrayCommandLine: pure, exact command line stored in the Run value ----
  $cmd = Get-OaTrayCommandLine -TrayPath 'C:\fake\oa-supervisor-tray.ps1' -IntervalMinutes 15 -PowerShellPath 'C:\fake\powershell.exe'
  Assert-True ($cmd -like '*"C:\fake\powershell.exe"*') 'command line quotes the PowerShell executable'
  Assert-True ($cmd -like '*-File "C:\fake\oa-supervisor-tray.ps1"*') 'command line points at the tray script'
  Assert-True ($cmd -like '*-IntervalMinutes 15*') 'command line carries the interval'
  Assert-True ($cmd -notlike '*-NoAct*') 'command line omits -NoAct by default'
  $cmdNoAct = Get-OaTrayCommandLine -TrayPath 'C:\fake\oa-supervisor-tray.ps1' -NoAct -PowerShellPath 'C:\fake\powershell.exe'
  Assert-True ($cmdNoAct -like '*-NoAct*') 'command line carries -NoAct when requested'

  # ---- Test-OaOwnerIdentity: pure identity check, no live process required ----
  $now = (Get-Date).ToUniversalTime()
  $record = @{ pid = 4242; startedUtc = $now.ToString('o') }
  $matchingProcess = [pscustomobject]@{ ProcessId = 4242; Name = 'powershell.exe'
    CommandLine = 'powershell -File oa-supervisor-tray.ps1 -IntervalMinutes 15'; CreationDate = $now }
  Assert-True (Test-OaOwnerIdentity $record $matchingProcess) 'matching pid+time+cmdline verifies as owner'

  $wrongPid = [pscustomobject]@{ ProcessId = 9999; Name = 'powershell.exe'
    CommandLine = 'powershell -File oa-supervisor-tray.ps1'; CreationDate = $now }
  Assert-True (-not (Test-OaOwnerIdentity $record $wrongPid)) 'mismatched pid is rejected'

  $wrongScript = [pscustomobject]@{ ProcessId = 4242; Name = 'powershell.exe'
    CommandLine = 'powershell -File some-other-script.ps1'; CreationDate = $now }
  Assert-True (-not (Test-OaOwnerIdentity $record $wrongScript)) 'a command line not naming the tray is rejected'

  $wrongTime = [pscustomobject]@{ ProcessId = 4242; Name = 'powershell.exe'
    CommandLine = 'powershell -File oa-supervisor-tray.ps1'; CreationDate = $now.AddMinutes(10) }
  Assert-True (-not (Test-OaOwnerIdentity $record $wrongTime)) 'a PID reused by a newer process is rejected'

  Assert-True (-not (Test-OaOwnerIdentity $null $matchingProcess)) 'a missing lock record verifies as false'

  # ---- Get-OaTrayStartup / Enable / Disable against an isolated registry key ----
  Remove-Item -Path $testKey -Recurse -Force -ErrorAction SilentlyContinue
  try {
    $before = Get-OaTrayStartup -KeyPath $testKey -ValueName 'Test entry'
    Assert-True (-not $before.enabled) 'fresh test key starts disabled'

    Enable-OaTrayStartup -CommandLine 'C:\fake\powershell.exe -File tray.ps1' -KeyPath $testKey -ValueName 'Test entry'
    $after = Get-OaTrayStartup -KeyPath $testKey -ValueName 'Test entry'
    Assert-True $after.enabled 'Enable-OaTrayStartup registers the value'
    Assert-Equal $after.command 'C:\fake\powershell.exe -File tray.ps1' 'registered command line matches'

    Disable-OaTrayStartup -KeyPath $testKey -ValueName 'Test entry'
    $removed = Get-OaTrayStartup -KeyPath $testKey -ValueName 'Test entry'
    Assert-True (-not $removed.enabled) 'Disable-OaTrayStartup removes the value'
  } finally {
    Remove-Item -Path $testKey -Recurse -Force -ErrorAction SilentlyContinue
  }

  # ---- Lock ownership: no lock file => no owner, never throws ----
  Assert-True (-not (Test-OaLockHeld $files.lock)) 'no lock file means the lock is not held'
  Assert-True (-not (Get-OaSupervisorOwner)) 'no lock file means there is no owner'
  Assert-Equal (Stop-OaSupervisorOwner) 'none' 'stopping with no owner is a safe no-op'

  # ---- End-to-end: install-oa-reliability-tray.ps1 -Enable / -Disable, fully isolated ----
  $installer = Join-Path $checksDir 'install-oa-reliability-tray.ps1'
  $psExe = (Get-Process -Id $PID).Path
  $enableJson = & $psExe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $installer `
    -Enable -NoStart -Json -TestKeyPath $testKey -TestValueName 'Test entry' 2>&1 | Out-String
  $enableResult = $enableJson | ConvertFrom-Json
  Assert-True $enableResult.enabled '-Enable registers the isolated startup value'
  Assert-True (-not $enableResult.started) '-Enable -NoStart does not launch the tray'
  Assert-True (Test-Path (Join-Path $files.home 'oa-supervisor-tray.ps1')) '-Enable deploys the tray script to the OA home'
  Assert-True (Test-Path (Join-Path $files.home 'reliability-supervisor.mjs')) '-Enable deploys the reliability engine'
  Assert-True (Test-Path (Join-Path $files.home 'consumer-reliability-supervisor.mjs')) '-Enable deploys the consumer wrapper'
  Assert-True (Test-Path (Join-Path $files.home 'oa-user-settings.mjs')) '-Enable deploys the user-settings policy reader'
  foreach ($browserFile in 'consumer-browser-watchdog.mjs', 'browser-watchdog.ps1', 'check-browser-slots.ps1',
      'browser-slot-table.ps1') {
    Assert-True (Test-Path (Join-Path $files.home $browserFile)) "-Enable deploys the reused browser tool $browserFile"
  }
  $routeFiles = @(Get-ChildItem -LiteralPath $files.home -File | Where-Object { $_.Extension -in '.vbs', '.cmd', '.bat', '.lnk', '.xml' })
  Assert-Equal $routeFiles.Count 0 '-Enable deploys no VBS/CMD/shortcut/task-XML startup route'
  $registered = Get-OaTrayStartup -KeyPath $testKey -ValueName 'Test entry'
  Assert-True ($registered.command -like '*oa-supervisor-tray.ps1*' -and $registered.command -notmatch 'browser') 'the single Run entry launches the tray only - no browser-specific route'
  Assert-True (Test-Path (Join-Path $files.home 'consumer-update-check.mjs')) '-Enable deploys the update-check workload'
  Assert-True ($registered.command -notmatch 'update') 'the single Run entry adds no update-specific route'

  $disableJson = & $psExe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $installer `
    -Disable -Json -TestKeyPath $testKey -TestValueName 'Test entry' 2>&1 | Out-String
  $disableResult = $disableJson | ConvertFrom-Json
  Assert-True (-not $disableResult.enabled) '-Disable removes the isolated startup value'

  $statusJson = & $psExe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $installer `
    -Json -TestKeyPath $testKey -TestValueName 'Test entry' 2>&1 | Out-String
  $statusResult = $statusJson | ConvertFrom-Json
  Assert-True (-not $statusResult.enabled) 'default (status-only) invocation reports disabled and changes nothing'

  # ---- ConvertFrom-OaBrowserResult: pure view of a browser-workload result ----
  $offDefault = ConvertFrom-OaBrowserResult ([pscustomobject]@{ status = 'disabled'; policy = [pscustomobject]@{ source = 'defaults' } })
  Assert-Equal $offDefault.state 'DISABLED' 'browser workload with no section reads DISABLED'
  Assert-Equal $offDefault.summary 'off (default)' 'browser status says off (default) when nothing is declared'
  $noOptIns = ConvertFrom-OaBrowserResult ([pscustomobject]@{ status = 'no-opt-ins'; policy = [pscustomobject]@{ source = 'user-settings' } })
  Assert-True ($noOptIns.summary -like '*nothing runs*') 'Enabled without an opt-in is shown as running nothing'
  $refused = ConvertFrom-OaBrowserResult ([pscustomobject]@{ status = 'policy-error'; error = "'Observe' must be 'on' or 'off'" })
  Assert-True ($refused.error -like '*Observe*') 'a refused browser row surfaces its error'
  $ran = ConvertFrom-OaBrowserResult ([pscustomobject]@{ status = 'attention'
    policy = [pscustomobject]@{ source = 'user-settings'; settingsPath = 'C:\u.md' }
    outcome = [pscustomobject]@{ mode = 'observe'; summary = 'attention: 1/2 slot(s) healthy' }
    recent = @([pscustomobject]@{ at = '2026-09-28T08:00:00.000Z'; mode = 'observe'; summary = 'attention: 1/2 slot(s) healthy' }) })
  Assert-Equal $ran.summary 'observe - attention: 1/2 slot(s) healthy' 'a dispatched run shows its mode and outcome'
  Assert-Equal @($ran.recent).Count 1 'recent outcomes are carried to the tray'
  Assert-True ($ran.recent[0] -like '*observe: attention*') 'a recent outcome line names its mode and result'
  Assert-Equal $ran.settingsPath 'C:\u.md' 'the tray learns which settings file to open'

  # ---- ConvertFrom-OaUpdateResult: pure view of an update-check result (GH #701) ----
  $available = ConvertFrom-OaUpdateResult ([pscustomobject]@{ status = 'update-available'
    policy = [pscustomobject]@{ source = 'defaults'; settingsPath = 'C:\u.md' }
    outcome = [pscustomobject]@{ summary = 'update available: 1.53.0 -> 1.54.0 (Auto apply is off)' }
    last = [pscustomobject]@{ lastResult = 'update-available'; lastCheckedAt = '2026-09-28T08:00:00.000Z'
      installedVersion = '1.53.0'; availableVersion = '1.54.0' } })
  Assert-Equal $available.state 'UPDATE-AVAILABLE' 'an available update reads UPDATE-AVAILABLE'
  Assert-True $available.updateAvailable 'the tray is told an update is available'
  Assert-True ($available.summary -like '*1.53.0 -> 1.54.0*Auto apply is off*') 'the menu shows both versions and that nothing was applied'
  Assert-Equal $available.availableVersion '1.54.0' 'the available version is carried to the tray'
  Assert-True ([bool]$available.lastChecked) 'the last-checked time is carried to the tray'
  $notDue = ConvertFrom-OaUpdateResult ([pscustomobject]@{ status = 'not-due'
    last = [pscustomobject]@{ lastResult = 'up-to-date'; summary = 'up to date (1.53.0)'; installedVersion = '1.53.0' } })
  Assert-Equal $notDue.state 'UP-TO-DATE' 'a not-due run keeps showing the last recorded result'
  Assert-Equal $notDue.summary 'up to date (1.53.0)' 'a not-due run keeps the last summary'
  Assert-True (-not $notDue.updateAvailable) 'up to date is not an available update'
  $updRefused = ConvertFrom-OaUpdateResult ([pscustomobject]@{ status = 'policy-error'; error = "'Check interval' must be 'hourly'" })
  Assert-True ($updRefused.error -like '*Check interval*') 'a refused update row surfaces its error'
  Assert-Equal (ConvertFrom-OaUpdateResult ([pscustomobject]@{ status = 'disabled' })).summary 'off (Enabled = off)' 'Enabled = off reads as off'

  # Every headless tray below runs the update workload against a FAKE Copilot CLI
  # that records each call, so no test ever reaches the real marketplace.
  $fakeCli = Join-Path $root.FullName 'fake-copilot.mjs'
  $fakeCalls = Join-Path $root.FullName 'fake-copilot-calls.txt'
  [IO.File]::WriteAllText($fakeCli, @'
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2).join(' ');
appendFileSync(process.env.OA_FAKE_COPILOT_CALLS, args + '\n');
const out = value => console.log(JSON.stringify(value));
if (args === 'plugin marketplace list --json') out([{ name: 'copilot-plugins' }, { name: 'focus-planner' }]);
else if (args === 'plugin list --json') out([{ name: 'overnight-agent', marketplace: 'focus-planner', version: '1.53.0' }]);
else if (args === 'plugin marketplace update focus-planner') out({});
else if (args === 'plugin marketplace browse focus-planner --json') out([{ name: 'overnight-agent', version: '1.54.0' }]);
else if (args === 'plugin install overnight-agent@focus-planner') out({});
else { console.error('unexpected: ' + args); process.exit(9); }
'@)
  $originalCli = $env:OA_COPILOT_CLI
  $originalCalls = $env:OA_FAKE_COPILOT_CALLS
  $env:OA_COPILOT_CLI = $fakeCli
  $env:OA_FAKE_COPILOT_CALLS = $fakeCalls

  # ---- Headless tray: browser checks are OFF by default and pause is not persisted ----
  function Invoke-HeadlessTray([string[]]$SettingsLines, [scriptblock]$Done) {
    $settingsPath = Join-Path $root.FullName 'user-settings.md'
    Set-Content -LiteralPath $settingsPath -Encoding utf8 -Value $SettingsLines
    $originalSettings = $env:OVERNIGHT_AGENT_SETTINGS
    $env:OVERNIGHT_AGENT_SETTINGS = $settingsPath
    try {
      Remove-Item -LiteralPath $files.heartbeat -Force -ErrorAction SilentlyContinue
      $trayProcess = Start-Process -FilePath $psExe -PassThru -WindowStyle Hidden -ArgumentList @(
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
        (Join-Path $checksDir 'oa-supervisor-tray.ps1'), '-NoTrayIcon', '-NoAct')
      $null = $trayProcess.Handle
      $heartbeat = $null
      $deadline = (Get-Date).AddSeconds(90)
      while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 500
        try { $heartbeat = Get-Content -LiteralPath $files.heartbeat -Raw -ErrorAction Stop | ConvertFrom-Json } catch { continue }
        if ($heartbeat.browser -and (& $Done $heartbeat)) { break }
      }
      @{ pid = $trayProcess.Id; requestedUtc = (Get-Date).ToUniversalTime().ToString('o') } |
        ConvertTo-Json | Set-Content -LiteralPath $files.stopRequest -Encoding utf8
      $exited = $trayProcess.WaitForExit(30000)
      if (-not $exited) { Stop-Process -Id $trayProcess.Id -Force -ErrorAction SilentlyContinue }
      Assert-True $exited 'headless tray exits on a stop request'
      return $heartbeat
    } finally {
      if ($null -eq $originalSettings) { Remove-Item Env:\OVERNIGHT_AGENT_SETTINGS -ErrorAction SilentlyContinue }
      else { $env:OVERNIGHT_AGENT_SETTINGS = $originalSettings }
    }
  }
  $reliabilityOff = @('# settings', '', '## Tray reliability supervision', '', '| Setting | Value |',
    '| --- | --- |', '| Enabled | `off` |', '')

  $heartbeat = Invoke-HeadlessTray $reliabilityOff { param($h) $h.browser.state -eq 'DISABLED' -and -not $h.browser.running }
  Assert-True ($heartbeat -and $heartbeat.browser) 'the tray heartbeat carries a separate browser section'
  Assert-Equal $heartbeat.browser.state 'DISABLED' 'headless tray: browser checks are off by default'
  Assert-Equal $heartbeat.browser.paused $false 'a fresh tray starts with browser checks unpaused (pause is not persisted)'
  Assert-True (-not (Test-Path $files.browserState)) 'no browser state is written while browser checks are off'
  Assert-True (-not (Test-Path (Join-Path $files.home 'browser-checks.lock'))) 'no browser lock is taken while browser checks are off'

  # Opted in to Observe, but the settings file has no `## Browser slots` table, so
  # the reused tools refuse to guess a slot list: the tray dispatches, records an
  # ATTENTION outcome in its own state file, and no browser port is ever contacted.
  $observeOn = $reliabilityOff + @('## Tray browser checks', '', '| Setting | Value |', '| --- | --- |',
    '| Enabled | `on` |', '| Observe | `on` |', '')
  $heartbeat = Invoke-HeadlessTray $observeOn { param($h) $h.browser.lastCheckUtc -and -not $h.browser.running }
  Assert-Equal $heartbeat.browser.state 'ATTENTION' 'an opted-in check with no slot table is dispatched and needs attention'
  $recorded = Get-Content -LiteralPath $files.browserState -Raw | ConvertFrom-Json
  Assert-Equal @($recorded.recent)[-1].mode 'observe' 'the -NoAct tray runs the opted-in check as observe-only'
  Assert-True (@($heartbeat.browser.recent).Count -ge 1) 'the tray shows the recent browser outcome'
  Assert-True (Test-Path $files.browserState) 'the browser workload records outcomes in its own state file'
  Assert-True (-not (Test-Path (Join-Path $files.home 'reliability-supervisor-state.json')) -or
    ((Get-Content -LiteralPath (Join-Path $files.home 'reliability-supervisor-state.json') -Raw) -notmatch 'browser')) 'browser outcomes never land in reliability state'

  # ---- Headless tray: update checks are ON by default, daily, and report-only ----
  $updateDone = { param($h) $h.update -and $h.update.lastCheckUtc -and -not $h.update.running }
  function Reset-UpdateFixture {
    Start-Sleep -Milliseconds 500
    Remove-Item -LiteralPath $files.updateState, $fakeCalls -Force -ErrorAction SilentlyContinue
    Set-Content -LiteralPath $fakeCalls -Value '' -NoNewline
  }
  function Get-FakeCalls { @((Get-Content -LiteralPath $fakeCalls -ErrorAction SilentlyContinue) | Where-Object { $_ }) }

  Reset-UpdateFixture
  $heartbeat = Invoke-HeadlessTray $reliabilityOff $updateDone
  Assert-True ($heartbeat -and $heartbeat.update) 'the tray heartbeat carries a separate update section'
  Assert-Equal $heartbeat.update.state 'UPDATE-AVAILABLE' 'headless tray: update checks run by default and report an available update'
  Assert-True $heartbeat.update.updateAvailable 'the tray flags update available'
  Assert-Equal $heartbeat.update.paused $false 'a fresh tray starts with update checks unpaused (pause is not persisted)'
  $calls = Get-FakeCalls
  Assert-True ($calls -contains 'plugin marketplace list --json') 'the tray verifies the marketplace is registered'
  Assert-True ($calls -contains 'plugin list --json') 'the tray verifies the plugin is installed'
  Assert-True (-not ($calls | Where-Object { $_ -like 'plugin install*' })) 'with Auto apply off (default) nothing is installed'
  Assert-True (-not ($calls | Where-Object { $_ -notlike 'plugin *' })) 'every CLI call is a copilot plugin subcommand - never git'
  $updState = Get-Content -LiteralPath $files.updateState -Raw | ConvertFrom-Json
  Assert-Equal $updState.availableVersion '1.54.0' 'the update workload records the available version in its own state file'
  Assert-True ([bool]$updState.lastCheckedAt) 'the update workload records lastCheckedAt'
  $browserStateText = if (Test-Path $files.browserState) { Get-Content -LiteralPath $files.browserState -Raw } else { '' }
  Assert-True ($browserStateText -notmatch 'availableVersion') 'update results never land in browser state'
  Assert-True (-not (Test-Path (Join-Path $files.home 'update-check.lock'))) 'the update lock is released after the check'

  # A tray restart inside the interval adds no check: the workload is idempotent.
  Set-Content -LiteralPath $fakeCalls -Value '' -NoNewline
  $heartbeat = Invoke-HeadlessTray $reliabilityOff $updateDone
  Assert-Equal @(Get-FakeCalls).Count 0 'a restarted tray inside the daily interval runs no CLI at all'
  Assert-Equal $heartbeat.update.state 'UPDATE-AVAILABLE' 'the restarted tray still shows the recorded result'

  # Auto apply = on, but the tray runs -NoAct, which can only remove apply.
  Reset-UpdateFixture
  $autoApply = $reliabilityOff + @('## Tray update checks', '', '| Setting | Value |', '| --- | --- |',
    '| Check interval | `hourly` |', '| Auto apply | `on` |', '')
  $heartbeat = Invoke-HeadlessTray $autoApply $updateDone
  Assert-Equal $heartbeat.update.state 'UPDATE-AVAILABLE' 'a -NoAct tray only reports even with Auto apply on'
  Assert-True (-not (Get-FakeCalls | Where-Object { $_ -like 'plugin install*' })) '-NoAct never installs'

  # Enabled = off: no CLI, no state.
  Reset-UpdateFixture
  $updatesOff = $reliabilityOff + @('## Tray update checks', '', '| Setting | Value |', '| --- | --- |',
    '| Enabled | `off` |', '')
  $heartbeat = Invoke-HeadlessTray $updatesOff $updateDone
  Assert-Equal $heartbeat.update.state 'DISABLED' 'Enabled = off turns the update workload off'
  Assert-Equal @(Get-FakeCalls).Count 0 'a disabled update workload runs no CLI'
  Assert-True (-not (Test-Path $files.updateState)) 'a disabled update workload writes no state'
} finally {
  if ($null -eq $originalCli) { Remove-Item Env:\OA_COPILOT_CLI -ErrorAction SilentlyContinue } else { $env:OA_COPILOT_CLI = $originalCli }
  if ($null -eq $originalCalls) { Remove-Item Env:\OA_FAKE_COPILOT_CALLS -ErrorAction SilentlyContinue } else { $env:OA_FAKE_COPILOT_CALLS = $originalCalls }
  Remove-Item -Path $testKey -Recurse -Force -ErrorAction SilentlyContinue
  $env:LOCALAPPDATA = $originalLocalAppData
  Remove-Item -LiteralPath $root.FullName -Recurse -Force -ErrorAction SilentlyContinue
}

if ($failures.Count) {
  $failures | ForEach-Object { Write-Error $_ }
  exit 1
}
Write-Host 'All assertions passed.'
exit 0
