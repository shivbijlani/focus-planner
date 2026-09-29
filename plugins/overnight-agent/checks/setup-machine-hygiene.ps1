<#
.SYNOPSIS
  Opt-in Windows first-run hygiene: Widgets, Dev Drive trust, and cache-only Defender exclusions.
.DESCRIPTION
  Reports every state before offering individual changes. -WhatIf only reports.
  Elevated choices are applied together in one UAC prompt. Never excludes code or OA home.
#>
[CmdletBinding()]
param(
    [switch]$WhatIf,
    [string]$SettingsPath,
    [string]$LogPath = (Join-Path $env:TEMP 'overnight-agent-machine-hygiene.log'),
    [switch]$ApplyElevated,
    [string]$SelectionsBase64
)

$ErrorActionPreference = 'Stop'
if ($WhatIf -and $ApplyElevated) { throw '-WhatIf cannot be combined with -ApplyElevated.' }
$localRoot = [IO.Path]::GetFullPath($env:LOCALAPPDATA).TrimEnd('\', '/')
$allowed = @(
    (Join-Path $localRoot 'npm-cache'),
    (Join-Path $localRoot 'uv\cache'),
    (Join-Path $localRoot 'overnight-agent\task-chats')
)

function Assert-SafeExclusion([string]$Path) {
    $full = [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
    if ($full -cnotin $allowed) { throw "Refusing non-cache exclusion: $Path" }
    # A cache symlink/junction could point at executable code outside this allow-list.
    $cursor = $full
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw "Refusing reparse-point exclusion: $cursor"
            }
        }
        if ($cursor -eq $localRoot) { break }
        $parent = [IO.Path]::GetDirectoryName($cursor)
        if ($parent -eq $cursor) { break }
        $cursor = $parent
    }
}

function Log([string]$Message) {
    $line = "$(Get-Date -Format o) $Message"
    Write-Host $Message
    if (-not $WhatIf) { Add-Content -LiteralPath $LogPath -Value $line }
}

function Test-DevDriveOutput([string]$Output) {
    return $Output -match '(?i)\b(?:trusted|untrusted) developer volume|\bis a developer volume'
}

if ($ApplyElevated) {
    if (-not $LogPath) { throw 'Elevated run requires a log path.' }
    if (-not $SelectionsBase64) { throw 'Elevated run requires approved selections.' }
    $selection = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($SelectionsBase64)) | ConvertFrom-Json
    $TrustDrive = [string]$selection.TrustDrive
    $ExcludePaths = @($selection.ExcludePaths)
    foreach ($path in $ExcludePaths) { Assert-SafeExclusion $path }
    if ($TrustDrive -and $TrustDrive -notmatch '^[A-Za-z]:$') { throw 'Invalid Dev Drive letter.' }
    if ($TrustDrive) {
        $query = & fsutil devdrv query "$TrustDrive\" 2>&1
        if ($LASTEXITCODE -ne 0 -or -not (Test-DevDriveOutput ($query -join ' '))) {
            throw "Drive $TrustDrive is not a confirmed Dev Drive: $query"
        }
        Log "Trusting Dev Drive $TrustDrive"
        & fsutil devdrv trust "$TrustDrive\"
        if ($LASTEXITCODE -ne 0) { throw "fsutil devdrv trust failed for $TrustDrive" }
        $after = & fsutil devdrv query "$TrustDrive\" 2>&1
        if ($LASTEXITCODE -ne 0 -or ($after -join ' ') -notmatch '(?i)\btrusted developer volume') {
            throw "Dev Drive trust could not be verified for ${TrustDrive}: $after"
        }
        Log "Dev Drive $TrustDrive trust verified."
        Log 'A remount or reboot may be needed before Defender performance mode fully applies.'
    }
    foreach ($path in $ExcludePaths) {
        Log "Adding Defender exclusion: $path"
        Add-MpPreference -ExclusionPath $path -ErrorAction Stop
        Log "Defender exclusion added: $path"
    }
    if ($ExcludePaths.Count) {
        $after = @( (Get-MpPreference -ErrorAction Stop).ExclusionPath )
        foreach ($path in $ExcludePaths) {
            if ($after -notcontains $path) { throw "Defender exclusion could not be verified: $path" }
        }
        Log 'Selected Defender exclusions verified.'
    }
    exit 0
}

Log 'Machine hygiene state (no automatic changes):'
$widgetsAvailable = [bool](Get-Command Get-AppxPackage -ErrorAction SilentlyContinue)
if ($widgetsAvailable) {
    try {
        $widgets = @(Get-AppxPackage -Name 'MicrosoftWindows.Client.WebExperience' -ErrorAction Stop)
        Log "Widgets: $(if ($widgets.Count) { 'installed' } else { 'not installed' })"
    } catch { $widgetsAvailable = $false; Log "Widgets: unavailable ($($_.Exception.Message))" }
} else { Log 'Widgets: unavailable (Appx command missing)' }

$drive = $null
try {
    . (Join-Path $PSScriptRoot 'browser-slot-table.ps1')
    if (-not $SettingsPath) { $SettingsPath = Resolve-OaSettingsPath }
    $line = Get-Content -LiteralPath $SettingsPath | Where-Object { $_ -match '^\|\s*Dev drive \(repos\)\s*\|' } | Select-Object -First 1
    if (-not $line -or $line -notmatch '^\|[^|]*\|\s*`?([A-Za-z]:)\\') {
        throw "Dev drive (repos) is missing or not an absolute drive path in $SettingsPath"
    }
    $drive = $Matches[1]
} catch { Log "Dev Drive: unavailable ($($_.Exception.Message))" }

$devDrive = $false
$trusted = $false
if ($drive) {
    if (Get-Command fsutil -ErrorAction SilentlyContinue) {
        $query = & fsutil devdrv query "$drive\" 2>&1
        if ($LASTEXITCODE -eq 0 -and (Test-DevDriveOutput ($query -join ' '))) {
            $devDrive = $true
            $trusted = ($query -join ' ') -match '(?i)\btrusted developer volume'
            Log "Dev Drive ${drive} yes; trust: $(if ($trusted) { 'trusted' } else { 'not trusted' })"
        } else {
            Log "Dev Drive ${drive} not confirmed as Dev Drive. See https://learn.microsoft.com/windows/dev-drive/"
        }
    } else { Log "Dev Drive ${drive} unavailable (fsutil missing)" }
}

$mpAvailable = [bool](Get-Command Get-MpPreference -ErrorAction SilentlyContinue)
if ($mpAvailable) {
    try {
        $pref = Get-MpPreference -ErrorAction Stop
        $excluded = @($pref.ExclusionPath)
    } catch { $mpAvailable = $false; Log "Defender preferences: unavailable ($($_.Exception.Message))" }
}
foreach ($path in $allowed) {
    try {
        Assert-SafeExclusion $path
        $state = if (-not $mpAvailable) { 'unavailable (Defender command missing)' }
                 elseif ($excluded -contains $path) { 'excluded' } else { 'not excluded' }
        Log "Defender $path`: $state"
    } catch { Log "Defender $path`: unsafe ($($_.Exception.Message))" }
}
if ($WhatIf) { Log 'WhatIf: no prompts, writes, or changes.'; return }

if ($widgetsAvailable -and $widgets.Count) {
    Log 'Widgets removal is per-user; undo by installing Windows Web Experience Pack from Microsoft Store.'
    if ((Read-Host 'Remove Windows Widgets for this user? [y/N]') -eq 'y') {
        $widgets | Remove-AppxPackage -ErrorAction Stop
        Log 'Removed Windows Widgets.'
    }
}

$trustChoice = $null
if ($devDrive -and -not $trusted -and (Read-Host "Trust Dev Drive $drive (one UAC prompt with selected exclusions)? [y/N]") -eq 'y') {
    $trustChoice = $drive
}
$excludeChoices = @()
if ($mpAvailable) {
    foreach ($path in $allowed) {
        try { Assert-SafeExclusion $path }
        catch { continue }
        if ($excluded -notcontains $path -and (Read-Host "Exclude regenerable/non-code folder $path from Defender? [y/N]") -eq 'y') {
            $excludeChoices += $path
        }
    }
}
if ($trustChoice -or $excludeChoices.Count) {
    $hostExe = (Get-Process -Id $PID).Path
    $json = @{ TrustDrive = $trustChoice; ExcludePaths = @($excludeChoices) } | ConvertTo-Json -Compress
    $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
    $args = @('-NoProfile', '-File', "`"$PSCommandPath`"", '-ApplyElevated', '-LogPath', "`"$LogPath`"", '-SelectionsBase64', $encoded)
    Log 'Requesting one UAC prompt for the selected elevated actions.'
    $process = Start-Process -FilePath $hostExe -Verb RunAs -ArgumentList $args -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw "Elevated machine hygiene failed (exit $($process.ExitCode)); see $LogPath" }
}
Log 'Machine hygiene finished.'
