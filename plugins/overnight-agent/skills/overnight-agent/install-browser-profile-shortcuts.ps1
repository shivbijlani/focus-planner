<#
.SYNOPSIS
  Creates one desktop shortcut per browser profile slot (GH #738) — no CDP
  debug port, just a normal browser window for a one-time sign-in.

.DESCRIPTION
  GH #738 replaced attach-only Playwright MCP slots with each MCP server
  launching its own profile directly. That removes the reason the old
  shortcuts existed on a debug port at all (`MCP Edge N (CDP 922x)`): nothing
  attaches to these windows any more, so a debug port only adds attack surface
  for no benefit. The replacement is one **plain** shortcut per profile, named
  after the account, for the ONE thing a human still needs to do by hand: sign
  in, once, inside that profile.

  Each shortcut targets `msedge.exe` (or `chrome.exe` for a slot whose name or
  profile contains "chrome") with:

      --user-data-dir="<profile dir>" --profile-directory=Default

  and nothing else -- no `--remote-debugging-port`. A profile opened from its
  shortcut is a completely normal browser window, and it is UNAVAILABLE to
  Playwright MCP tasks until it is closed (same one-owner-at-a-time rule as a
  task launching it).

  THE SLOT LIST IS NOT IN THIS FILE. It is read from the `## Browser slots`
  table in user-settings.md, via browser-slot-table.ps1 -- the one parser for
  that table.

  Shortcut names are `Browser - <account label>` from the table's Account
  column. If Account is blank, the slot name is used as the label.

  THIS SCRIPT DOES NOT TOUCH ANY EXISTING SHORTCUT ON ITS OWN. Pass -RemoveOld
  to also delete the retired CDP-labelled shortcuts (`MCP Edge * (CDP *).lnk`
  and shortcuts that point to retired profiles or duplicate a current profile)
  from the target folder; without it, this script only ever ADDS the new
  shortcuts, so it is safe to preview with -WhatIf before removing anything.

.PARAMETER SettingsPath
  Override the resolved user-settings.md (for the mutation check's fixtures).

.PARAMETER DesktopPath
  Where to create the shortcuts. Defaults to the current user's Desktop.

.PARAMETER RemoveOld
  Also delete shortcuts matching `MCP Edge*(CDP*).lnk` / `MCP Chrome*(CDP*).lnk`
  and shortcuts that point to a profile no longer in the slot table or duplicate
  a current profile, from -DesktopPath.

.PARAMETER WhatIf
  Show what would be created/removed without writing anything.
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$SettingsPath,
    [string]$DesktopPath = [Environment]::GetFolderPath('Desktop'),
    [switch]$RemoveOld
)

$ErrorActionPreference = 'Stop'

$slotLib = $null
foreach ($cand in @(
        ([IO.Path]::Combine($PSScriptRoot, 'browser-slot-table.ps1'))
        ([IO.Path]::Combine($PSScriptRoot, '..', '..', 'checks', 'browser-slot-table.ps1'))
        ([IO.Path]::Combine($PSScriptRoot, '..', 'checks', 'browser-slot-table.ps1'))
        $(if ($env:LOCALAPPDATA) { [IO.Path]::Combine($env:LOCALAPPDATA, 'overnight-agent', 'browser-slot-table.ps1') })
    )) {
    if ($cand -and (Test-Path -LiteralPath $cand -PathType Leaf)) { $slotLib = (Resolve-Path -LiteralPath $cand).Path; break }
}
if (-not $slotLib) { throw 'browser-slot-table.ps1 not found. Refusing to guess a slot list.' }
. $slotLib

$slots = @(Get-BrowserSlotTable -SettingsPath $SettingsPath)

function Resolve-SlotBrowserExe {
    param([object]$Slot)
    $isChrome = ("$($Slot.Slot) $($Slot.ProfileDir)" -match '(?i)chrome')
    $candidates = if ($isChrome) {
        @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
          "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe")
    } else {
        @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
          "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe")
    }
    foreach ($c in $candidates) { if ($c -and (Test-Path -LiteralPath $c)) { return $c } }
    return $candidates[0]   # not installed here -- still write the shortcut; it just won't launch yet.
}

if (-not (Test-Path -LiteralPath $DesktopPath -PathType Container)) {
    New-Item -ItemType Directory -Force -Path $DesktopPath | Out-Null
}

$wshShell = New-Object -ComObject WScript.Shell

function Get-ShortcutName {
    param([object]$Slot)
    $label = if ([string]::IsNullOrWhiteSpace([string]$Slot.Account)) { $Slot.Slot } else { $Slot.Account.Trim() }
    $name = "Browser - $label"
    if ($name -notmatch '\.lnk$') { $name = "$name.lnk" }
    return $name
}

function Normalize-ProfilePath {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { return $null }
    $expanded = [Environment]::ExpandEnvironmentVariables($Path.Trim().Trim('"'))
    $fullPath = [IO.Path]::GetFullPath($expanded)
    $root = [IO.Path]::GetPathRoot($fullPath)
    if ($fullPath.Length -gt $root.Length) { $fullPath = $fullPath.TrimEnd([char[]]@('\', '/')) }
    return $fullPath
}

$currentShortcutByProfile = @{}
foreach ($slot in $slots) {
    if (-not $slot.ProfilePath) { continue }
    $profileKey = Normalize-ProfilePath -Path $slot.ProfilePath
    $currentShortcutByProfile[$profileKey] = Get-ShortcutName -Slot $slot
}

$created = @()
foreach ($slot in $slots) {
    if (-not $slot.ProfilePath) {
        Write-Host "install-browser-profile-shortcuts: [$($slot.Slot)] no profile path resolved from the table - skipping." -ForegroundColor Yellow
        continue
    }
    $name = Get-ShortcutName -Slot $slot
    $lnkPath = Join-Path $DesktopPath $name
    $exe = Resolve-SlotBrowserExe -Slot $slot

    if ($PSCmdlet.ShouldProcess($lnkPath, "create shortcut -> $exe --user-data-dir=`"$($slot.ProfilePath)`" --profile-directory=Default")) {
        $sc = $wshShell.CreateShortcut($lnkPath)
        $sc.TargetPath = $exe
        # No --remote-debugging-port: a plain, sign-in-only browser window. GH #738.
        $sc.Arguments = "--user-data-dir=`"$($slot.ProfilePath)`" --profile-directory=Default"
        $sc.Description = "Sign-in browser for the '$($slot.Slot)' profile (account: $($slot.Account))"
        $sc.WorkingDirectory = Split-Path -Parent $exe
        $sc.Save()
        $created += $lnkPath
        Write-Host "[$($slot.Slot)] created: $lnkPath" -ForegroundColor Green
    }
}

if ($RemoveOld) {
    $retired = @(Get-ChildItem -LiteralPath $DesktopPath -Filter '*.lnk' -ErrorAction SilentlyContinue |
        Where-Object {
            $legacyName = $_.Name -match '^(?:MCP (?:Edge|Chrome).*\(CDP \d+\)|Edge .*)\.lnk$'
            $shortcut = $wshShell.CreateShortcut($_.FullName)
            $profileMatch = [regex]::Match(
                $shortcut.Arguments,
                '(?i)(?:^|\s)--user-data-dir(?:=|\s+)(?:"([^"]+)"|(\S+))'
            )
            $profilePath = $null
            if ($profileMatch.Success) {
                $profilePath = Normalize-ProfilePath -Path $(if ($profileMatch.Groups[1].Success) {
                    $profileMatch.Groups[1].Value
                } else {
                    $profileMatch.Groups[2].Value
                })
            }
            $isCurrentProfile = $null -ne $profilePath -and $currentShortcutByProfile.ContainsKey($profilePath)
            $retiredProfile = $null -ne $profilePath -and -not $isCurrentProfile
            $duplicateProfile = $isCurrentProfile -and $_.Name -ine $currentShortcutByProfile[$profilePath]
            $legacyName -or $retiredProfile -or $duplicateProfile
        })
    foreach ($r in $retired) {
        if ($PSCmdlet.ShouldProcess($r.FullName, 'remove stale or duplicate browser shortcut')) {
            Remove-Item -LiteralPath $r.FullName -Force
            Write-Host "removed stale or duplicate shortcut: $($r.Name)" -ForegroundColor DarkYellow
        }
    }
}

Write-Host "`nDone. $($created.Count) shortcut(s) created in $DesktopPath." -ForegroundColor Green
Write-Host 'Each opens with NO debug port. Sign in once inside the window; close it when done so tasks can use that profile.' -ForegroundColor DarkGray
