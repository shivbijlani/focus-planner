<#
  Shared, fail-closed reader for OS-level/background watchdog settings.

  These are intentionally separate switches. Enabling one route must never silently
  enable another route as a fallback. Missing files, missing rows, and invalid values
  all resolve to OFF.
#>

function Resolve-OaBackgroundSettingsPath {
  [CmdletBinding()]
  param([string]$SettingsPath)

  if ($SettingsPath) {
    if (Test-Path -LiteralPath $SettingsPath -PathType Leaf) {
      return (Resolve-Path -LiteralPath $SettingsPath).Path
    }
    return $null
  }

  $candidates = New-Object System.Collections.Generic.List[string]
  if ($env:OVERNIGHT_AGENT_SETTINGS) { [void]$candidates.Add($env:OVERNIGHT_AGENT_SETTINGS) }
  try { [void]$candidates.Add((Join-Path (Get-Location).Path 'user-settings.md')) } catch { }
  foreach ($root in @($env:OneDrive, $env:OneDriveConsumer, $env:OneDriveCommercial)) {
    if ($root) { [void]$candidates.Add((Join-Path $root 'Apps\Focus Planner\user-settings.md')) }
  }
  if ($env:LOCALAPPDATA) {
    [void]$candidates.Add((Join-Path $env:LOCALAPPDATA 'overnight-agent\user-settings.md'))
  }

  foreach ($candidate in $candidates) {
    if (-not $candidate -or -not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
    $dir = Split-Path -Parent $candidate
    if ($dir -and (Test-Path -LiteralPath (Join-Path $dir 'SKILL.md') -PathType Leaf)) { continue }
    return (Resolve-Path -LiteralPath $candidate).Path
  }
  return $null
}

function Get-OaBackgroundSettings {
  [CmdletBinding()]
  param([string]$SettingsPath)

  $result = [ordered]@{
    SettingsPath                     = $null
    SupervisorScheduledTask          = $false
    SupervisorStartupDaemon          = $false
    BrowserWatchdogBackgroundProcess = $false
    Errors                           = @()
  }

  $resolved = Resolve-OaBackgroundSettingsPath -SettingsPath $SettingsPath
  if (-not $resolved) {
    $result.Errors = @('settings file missing; every background route defaults to off')
    return [pscustomobject]$result
  }
  $result.SettingsPath = $resolved

  try {
    $text = [IO.File]::ReadAllText($resolved, [Text.Encoding]::UTF8)
  } catch {
    $result.Errors = @("settings file unreadable; every background route defaults to off: $($_.Exception.Message)")
    return [pscustomobject]$result
  }

  $rows = [ordered]@{
    'OA supervisor scheduled task'       = 'SupervisorScheduledTask'
    'OA supervisor Startup daemon'       = 'SupervisorStartupDaemon'
    'Browser watchdog background process' = 'BrowserWatchdogBackgroundProcess'
  }
  $seen = @{}
  foreach ($line in ($text -split "`r?`n")) {
    if ($line -notmatch '^\s*\|\s*(?<name>[^|]+?)\s*\|\s*(?<value>[^|]+?)\s*\|') { continue }
    $name = ($Matches.name -replace '`|\*|_', '').Trim()
    if (-not $rows.Contains($name)) { continue }
    $property = $rows[$name]
    $value = (($Matches.value -replace '`|\*|_', '').Trim() -split '\s+')[0].ToLowerInvariant()
    $seen[$name] = $true
    if ($value -eq 'on') {
      $result[$property] = $true
    } elseif ($value -ne 'off') {
      $result.Errors += "'$name' has invalid value '$value'; defaulted to off"
    }
  }

  foreach ($name in $rows.Keys) {
    if (-not $seen.ContainsKey($name)) {
      $result.Errors += "'$name' is missing; defaulted to off"
    }
  }
  return [pscustomobject]$result
}

