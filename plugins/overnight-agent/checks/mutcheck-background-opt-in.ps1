<#
  Proves the real background entry points fail closed and the uninstaller remains
  project-scoped. Mutants alter the shipped files, not a copied classifier.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$PsExe = (Get-Process -Id $PID).Path
$Root = Join-Path ([IO.Path]::GetTempPath()) ("mutcheck-background-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $Root -Force | Out-Null

$Checks = $PSScriptRoot
$SettingsHelper = Join-Path $Checks 'background-settings.ps1'
$Installer = Join-Path $Checks 'install-oa-supervisor.ps1'
$Daemon = Join-Path $Checks 'oa-supervisor-daemon.ps1'
$Browser = Join-Path $Checks 'browser-watchdog.ps1'
$Liveness = Join-Path $Checks 'supervisor-liveness-sweep.ps1'
$Uninstaller = Join-Path $Checks 'uninstall-background-components.ps1'

$script:passed = 0
$script:failed = 0
function Assert([string]$Name, [bool]$Condition, [string]$Detail) {
  if ($Condition) { $script:passed++; Write-Host "  PASS $Name" }
  else { $script:failed++; Write-Host "  FAIL $Name - $Detail" }
}

function Write-Settings([string]$Path, [string]$Task, [string]$DaemonValue, [string]$BrowserValue) {
  @(
    '# Fixture', '', '## Background and off-process components', '',
    '| Setting | Value |', '| --- | --- |',
    "| OA supervisor scheduled task | ``$Task`` |",
    "| OA supervisor Startup daemon | ``$DaemonValue`` |",
    "| Browser watchdog background process | ``$BrowserValue`` |"
  ) | Set-Content -LiteralPath $Path -Encoding utf8
}

function Copy-WithMutation([string]$Source, [string]$Destination, [string]$Find, [string]$Replace) {
  $text = [IO.File]::ReadAllText($Source, [Text.Encoding]::UTF8)
  if (-not $text.Contains($Find)) { throw "mutation anchor missing in $Source : $Find" }
  [IO.File]::WriteAllText($Destination, $text.Replace($Find, $Replace), (New-Object Text.UTF8Encoding($false)))
}

try {
  $off = Join-Path $Root 'off.md'
  $on = Join-Path $Root 'on.md'
  $invalid = Join-Path $Root 'invalid.md'
  Write-Settings $off off off off
  Write-Settings $on on on on
  Write-Settings $invalid maybe off off

  . $SettingsHelper
  $missingResult = Get-OaBackgroundSettings -SettingsPath (Join-Path $Root 'missing.md')
  $offResult = Get-OaBackgroundSettings -SettingsPath $off
  $onResult = Get-OaBackgroundSettings -SettingsPath $on
  $invalidResult = Get-OaBackgroundSettings -SettingsPath $invalid
  Assert 'missing settings default every route off' (-not $missingResult.SupervisorScheduledTask -and -not $missingResult.SupervisorStartupDaemon -and -not $missingResult.BrowserWatchdogBackgroundProcess) 'a missing file enabled a route'
  Assert 'explicit off keeps every route off' (-not $offResult.SupervisorScheduledTask -and -not $offResult.SupervisorStartupDaemon -and -not $offResult.BrowserWatchdogBackgroundProcess) 'off enabled a route'
  Assert 'each explicit on is honored' ($onResult.SupervisorScheduledTask -and $onResult.SupervisorStartupDaemon -and $onResult.BrowserWatchdogBackgroundProcess) 'an on row stayed disabled'
  Assert 'invalid values fail closed' (-not $invalidResult.SupervisorScheduledTask -and $invalidResult.Errors.Count -gt 0) 'invalid value did not fail closed'

  $plan = (& $PsExe -NoProfile -File $Installer -SettingsPath $on -Plan | Out-String) | ConvertFrom-Json
  Assert 'installer plan reads independent routes' ($plan.scheduledTask -and $plan.startupDaemon) 'installer did not consume shared settings'

  $daemonHome = Join-Path $Root 'daemon-home'
  $oldLocal = $env:LOCALAPPDATA
  $env:LOCALAPPDATA = $daemonHome
  & $PsExe -NoProfile -File $Daemon -SettingsPath $off -Once *> $null
  $env:LOCALAPPDATA = $oldLocal
  Assert 'disabled daemon creates no state' (-not (Test-Path -LiteralPath $daemonHome)) 'daemon created files while disabled'

  & $PsExe -NoProfile -File $Browser -SettingsPath $off -Json *> (Join-Path $Root 'browser.json')
  $browserCode = $LASTEXITCODE
  $browserResult = Get-Content (Join-Path $Root 'browser.json') -Raw | ConvertFrom-Json
  Assert 'disabled background browser exits cleanly before tools' ($browserCode -eq 0 -and $browserResult.disabled) "exit=$browserCode"

  $facts = Join-Path $Root 'facts.json'
  @{ collectedUtc='2026-09-27T00:00:00Z'; units=@(@{
      name='disabled'; issue='#690'; purpose='fixture'; expected=$false
      taskInstalled=$false; taskState=''; taskLastRunMin=$null; shimInstalled=$false
      shimPath=''; processAlive=$false; processPid=0; signalPath=''; signalAgeMin=$null; cadenceMin=15
    }) } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $facts -Encoding utf8
  $liveResult = (& $PsExe -NoProfile -File $Liveness -FactsJson $facts -Json | Out-String) | ConvertFrom-Json
  Assert 'disabled liveness is intentional' ($liveResult.findings -eq 0 -and $liveResult.units[0].verdict -eq 'DISABLED') 'disabled route became a finding'

  $fixtureStartup = Join-Path $Root 'Startup'
  $backup = Join-Path $Root 'backup'
  New-Item -ItemType Directory -Path $fixtureStartup -Force | Out-Null
  Set-Content (Join-Path $fixtureStartup 'Overnight Agent supervisor.cmd') 'owned'
  Set-Content (Join-Path $fixtureStartup 'CopilotBrowserWatchdog.vbs') 'owned'
  Set-Content (Join-Path $fixtureStartup 'Unrelated.cmd') 'keep'
  & $PsExe -NoProfile -File $Uninstaller -StartupDirectory $fixtureStartup -BackupDirectory $backup -Json *> $null
  Assert 'uninstaller removes exact owned shims' (-not (Test-Path (Join-Path $fixtureStartup 'Overnight Agent supervisor.cmd')) -and -not (Test-Path (Join-Path $fixtureStartup 'CopilotBrowserWatchdog.vbs'))) 'owned shim remained'
  Assert 'uninstaller preserves unrelated Startup files' (Test-Path (Join-Path $fixtureStartup 'Unrelated.cmd')) 'unrelated Startup file was removed'
  Assert 'uninstaller backs up every removed shim' ((Test-Path (Join-Path $backup 'Overnight Agent supervisor.cmd')) -and (Test-Path (Join-Path $backup 'CopilotBrowserWatchdog.vbs'))) 'backup missing'

  & $PsExe -NoProfile -File $Uninstaller -StartupDirectory $fixtureStartup -BackupDirectory (Join-Path $Root 'backup-second') -Json *> $null
  Assert 'uninstaller is idempotent' ($LASTEXITCODE -eq 0 -and (Test-Path (Join-Path $fixtureStartup 'Unrelated.cmd'))) 'second run failed or touched unrelated state'

  $mutantDir = Join-Path $Root 'mutants'
  New-Item -ItemType Directory -Path $mutantDir | Out-Null
  $mutantHelper = Join-Path $mutantDir 'background-settings.ps1'
  Copy-WithMutation $SettingsHelper $mutantHelper "    SupervisorScheduledTask          = `$false" "    SupervisorScheduledTask          = `$true"
  Remove-Item Function:Get-OaBackgroundSettings,Function:Resolve-OaBackgroundSettingsPath -ErrorAction SilentlyContinue
  . $mutantHelper
  $mutatedMissing = Get-OaBackgroundSettings -SettingsPath (Join-Path $Root 'still-missing.md')
  Assert 'mutation: missing-file default is load-bearing' ($mutatedMissing.SupervisorScheduledTask) 'default-off mutation did not change behavior'

  $mutantLiveness = Join-Path $mutantDir 'supervisor-liveness-sweep.ps1'
  Copy-WithMutation $Liveness $mutantLiveness "    return 'DISABLED'" "    return 'ABSENT'"
  Copy-Item $SettingsHelper (Join-Path $mutantDir 'background-settings.ps1') -Force
  $mutantResult = (& $PsExe -NoProfile -File $mutantLiveness -FactsJson $facts -Json | Out-String) | ConvertFrom-Json
  Assert 'mutation: disabled verdict is load-bearing' ($mutantResult.findings -eq 1 -and $mutantResult.units[0].verdict -eq 'ABSENT') 'disabled mutation survived'
}
finally {
  Remove-Item $Root -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "[mutcheck-background-opt-in] $script:passed passed, $script:failed failed"
exit $(if ($script:failed) { 1 } else { 0 })
