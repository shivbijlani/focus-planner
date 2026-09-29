[CmdletBinding()]
param([string]$ScriptPath = (Join-Path $PSScriptRoot 'setup-machine-hygiene.ps1'))
$ErrorActionPreference = 'Stop'
$source = [IO.File]::ReadAllText($ScriptPath)

function Assert([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
    Write-Host "ok: $Message"
}

# Keep the static gate independent of the script's own validation: a mutant that
# adds a plugin/OA-home entry to its allow-list must fail before it can ship.
function Test-AllowList([string]$Text) {
    $block = [regex]::Match($Text, '(?s)\$allowed = @\((.*?)\r?\n\)')
    if (-not $block.Success) { return $false }
    $entries = @([regex]::Matches($block.Groups[1].Value, 'Join-Path \$localRoot ''([^'']+)''') |
        ForEach-Object { $_.Groups[1].Value })
    $expected = @('npm-cache', 'uv\cache', 'overnight-agent\task-chats')
    return (($entries -join '|') -ceq ($expected -join '|') -and
        $Text.Contains('Assert-SafeExclusion $path') -and
        $Text.Contains('[IO.FileAttributes]::ReparsePoint'))
}
Assert (Test-AllowList $source) 'only three fixed non-code exclusions and reparse guard'
$mutant = $source.Replace("(Join-Path `$localRoot 'npm-cache')", "(Join-Path `$localRoot 'overnight-agent\plugin')")
Assert ($mutant -ne $source -and -not (Test-AllowList $mutant)) 'plugin-path mutant rejected'
$mutant = $source.Replace('Assert-SafeExclusion $path', '# removed safety guard')
Assert ($mutant -ne $source -and -not (Test-AllowList $mutant)) 'validation-removal mutant rejected'

$fixture = Join-Path ([IO.Path]::GetTempPath()) ("hygiene-test-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixture | Out-Null
$oldLocal = $env:LOCALAPPDATA
try {
    $env:LOCALAPPDATA = $fixture
    $settings = Join-Path $fixture 'user-settings.md'
    Set-Content -LiteralPath $settings -Value '| Dev drive (repos) | `V:\repos\` |'
    $log = Join-Path $fixture 'should-not-exist.log'
    function Get-AppxPackage { param($Name) [pscustomobject]@{ Name = $Name } }
    function Remove-AppxPackage { throw 'WhatIf attempted Widgets removal' }
    function Get-MpPreference { [pscustomobject]@{ ExclusionPath = @() } }
    function Add-MpPreference { throw 'WhatIf attempted Defender change' }
    function fsutil {
        $global:LASTEXITCODE = 0
        'This is an untrusted developer volume'
    }
    $output = & $ScriptPath -SettingsPath $settings -LogPath $log -WhatIf 6>&1 | Out-String
    Assert ($output -match 'Widgets: installed') 'WhatIf reports Widgets'
    Assert ($output -match 'Dev Drive V: yes; trust: not trusted') 'WhatIf reports untrusted Dev Drive'
    foreach ($name in @('npm-cache', 'uv\cache', 'overnight-agent\task-chats')) {
        Assert ($output.Contains("$name`: not excluded")) "WhatIf reports $name"
    }
    Assert (-not (Test-Path $log)) 'WhatIf writes no log'
    Assert ($output -match 'WhatIf: no prompts, writes, or changes') 'WhatIf returns without changes'

    function Get-AppxPackage { param($Name) }
    function Get-MpPreference {
        [pscustomobject]@{ ExclusionPath = @(
            (Join-Path $fixture 'npm-cache'),
            (Join-Path $fixture 'uv\cache'),
            (Join-Path $fixture 'overnight-agent\task-chats')
        ) }
    }
    function fsutil {
        $global:LASTEXITCODE = 1
        'This is not a developer volume'
    }
    $output = & $ScriptPath -SettingsPath $settings -LogPath $log -WhatIf 6>&1 | Out-String
    Assert ($output -match 'Widgets: not installed') 'WhatIf reports absent Widgets'
    Assert ($output -match 'not confirmed as Dev Drive.*learn.microsoft.com/windows/dev-drive') 'WhatIf reports non-Dev Drive and guide'
    Assert (([regex]::Matches($output, ': excluded')).Count -eq 3) 'WhatIf reports existing exclusions'
    Assert (-not (Test-Path $log)) 'second WhatIf also writes nothing'
} finally {
    $env:LOCALAPPDATA = $oldLocal
    Remove-Item -LiteralPath $fixture -Recurse -Force
}
Write-Host 'PASS: machine hygiene guard and WhatIf fixtures'
exit 0
