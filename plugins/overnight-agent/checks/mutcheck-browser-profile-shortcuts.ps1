[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$installer = Join-Path $PSScriptRoot '..\skills\overnight-agent\install-browser-profile-shortcuts.ps1'
$root = Join-Path ([IO.Path]::GetTempPath()) ("oa-shortcuts-" + [guid]::NewGuid().ToString('N'))
$desktop = Join-Path $root 'Desktop'
$settings = Join-Path $root 'user-settings.md'
$savedLocalAppData = $env:LOCALAPPDATA
$pass = 0
$fail = 0

function Assert([string]$Name, [bool]$Condition, [string]$Detail) {
    if ($Condition) {
        $script:pass++
        Write-Host "  ok    $Name" -ForegroundColor Green
    }
    else {
        $script:fail++
        Write-Host "  FAIL  $Name  $Detail" -ForegroundColor Red
    }
}

function Add-TestShortcut {
    param([string]$Name, [string]$Arguments)
    $shortcut = $script:wshShell.CreateShortcut((Join-Path $script:desktop $Name))
    $shortcut.TargetPath = 'C:\Windows\System32\notepad.exe'
    $shortcut.Arguments = $Arguments
    $shortcut.Save()
}

try {
    New-Item -ItemType Directory -Force -Path $desktop | Out-Null
    $env:LOCALAPPDATA = Join-Path $root 'LocalAppData'
    $profiles = Join-Path $env:LOCALAPPDATA 'playwright-mcp'
    $edge1 = Join-Path $profiles 'edge1'
    $edge2 = Join-Path $profiles 'edge2'
    $edge3 = Join-Path $profiles 'edge3'

    $settingsText = @'
# Fixture settings

## Browser slots

| Slot | Profile dir (`%LOCALAPPDATA%\playwright-mcp\`) | Account | Desktop shortcut |
| --- | --- | --- | --- |
| `edge-primary` | `edge1` | Shiv (primary) | Old primary name |
| `edge-bijlanis` | `edge-bijlanis` | Shiv (bijlanis) | Edge bijlanis |
| `edge-kiley` | `kiley` | Kiley | MCP Edge 3 (CDP 9227) |
'@
    [IO.File]::WriteAllText($settings, $settingsText, (New-Object Text.UTF8Encoding($false)))

    $script:desktop = $desktop
    $script:wshShell = New-Object -ComObject WScript.Shell
    Add-TestShortcut 'MCP Edge 1 (CDP 9225).lnk' "--user-data-dir=`"$edge1`" --profile-directory=Default"
    Add-TestShortcut 'MCP Edge 2 (CDP 9226).lnk' "--user-data-dir=`"$edge2`" --profile-directory=Default"
    Add-TestShortcut 'MCP Edge 3 (CDP 9227).lnk' "--user-data-dir=`"$edge3`" --profile-directory=Default"
    Add-TestShortcut 'Edge bijlanis.lnk' "--user-data-dir=`"$edge1`" --profile-directory=Default"
    Add-TestShortcut 'Edge old-format.lnk' ''
    Add-TestShortcut 'Extra duplicate.lnk' "--user-data-dir=`"$edge1`" --profile-directory=Default"
    Add-TestShortcut 'Unrelated app.lnk' '--app=https://example.test'

    & $installer -SettingsPath $settings -DesktopPath $desktop -RemoveOld

    $expectedNames = @(
        'Browser - Shiv (primary).lnk',
        'Browser - Shiv (bijlanis).lnk',
        'Browser - Kiley.lnk'
    )
    foreach ($name in $expectedNames) {
        Assert "creates account-derived shortcut '$name'" (Test-Path -LiteralPath (Join-Path $desktop $name)) 'expected shortcut is missing'
    }

    foreach ($name in @(
        'MCP Edge 1 (CDP 9225).lnk',
        'MCP Edge 2 (CDP 9226).lnk',
        'MCP Edge 3 (CDP 9227).lnk',
        'Edge bijlanis.lnk',
        'Edge old-format.lnk',
        'Extra duplicate.lnk'
    )) {
        Assert "removes stale or duplicate '$name'" (-not (Test-Path -LiteralPath (Join-Path $desktop $name))) 'stale or duplicate shortcut remains'
    }

    foreach ($profile in @($edge2, $edge3)) {
        $nonLegacyName = if ($profile -eq $edge2) { 'Retired edge2.lnk' } else { 'Retired edge3.lnk' }
        Add-TestShortcut $nonLegacyName "--user-data-dir=`"$profile`" --profile-directory=Default"
    }
    & $installer -SettingsPath $settings -DesktopPath $desktop -RemoveOld
    foreach ($name in @('Retired edge2.lnk', 'Retired edge3.lnk')) {
        Assert "removes retired profile target '$name'" (-not (Test-Path -LiteralPath (Join-Path $desktop $name))) 'link to a profile outside the table remains'
    }

    Assert 'preserves unrelated shortcuts' (Test-Path -LiteralPath (Join-Path $desktop 'Unrelated app.lnk')) 'unrelated shortcut was removed'

    $expectedProfiles = @($edge1, (Join-Path $profiles 'edge-bijlanis'), (Join-Path $profiles 'kiley'))
    foreach ($index in 0..($expectedNames.Count - 1)) {
        $shortcut = $script:wshShell.CreateShortcut((Join-Path $desktop $expectedNames[$index]))
        Assert "shortcut '$($expectedNames[$index])' targets its table profile" `
            ($shortcut.Arguments -like "*--user-data-dir=`"$($expectedProfiles[$index])`"*") 'profile path does not match the table'
        Assert "shortcut '$($expectedNames[$index])' has no debug port" `
            ($shortcut.Arguments -notmatch '--remote-debugging-port') 'debug port argument was added'
    }

    Write-Host "`n$pass passed, $fail failed."
    if ($fail -gt 0) { exit 1 }
}
finally {
    $env:LOCALAPPDATA = $savedLocalAppData
    if ($script:wshShell) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($script:wshShell) }
    if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
}
