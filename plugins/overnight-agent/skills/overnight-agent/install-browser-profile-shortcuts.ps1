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

  THIS SCRIPT DOES NOT TOUCH ANY EXISTING SHORTCUT ON ITS OWN. Pass -RemoveOld
  to also delete the retired CDP-labelled shortcuts (`MCP Edge * (CDP *).lnk`
  and any `Edge bijlanis.lnk`-style duplicate) from the target folder; without
  it, this script only ever ADDS the new shortcuts, so it is safe to preview
  with -WhatIf before removing anything.

.PARAMETER SettingsPath
  Override the resolved user-settings.md (for the mutation check's fixtures).

.PARAMETER DesktopPath
  Where to create the shortcuts. Defaults to the current user's Desktop.

.PARAMETER RemoveOld
  Also delete shortcuts matching `MCP Edge*(CDP*).lnk` / `MCP Chrome*(CDP*).lnk`
  and any `Edge *.lnk` duplicate that does not match a current slot's shortcut
  name, from -DesktopPath.

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

$created = @()
foreach ($slot in $slots) {
    if (-not $slot.ProfilePath) {
        Write-Host "install-browser-profile-shortcuts: [$($slot.Slot)] no profile path resolved from the table - skipping." -ForegroundColor Yellow
        continue
    }
    $name = if ($slot.Shortcut) { $slot.Shortcut } else { "Browser – $($slot.Account)" }
    if ($name -notmatch '\.lnk$') { $name = "$name.lnk" }
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
    $currentNames = @($slots | ForEach-Object { if ($_.Shortcut) { $_.Shortcut } else { "Browser – $($_.Account)" } } |
        ForEach-Object { if ($_ -notmatch '\.lnk$') { "$_.lnk" } else { $_ } })
    $retired = @(Get-ChildItem -LiteralPath $DesktopPath -Filter '*.lnk' -ErrorAction SilentlyContinue |
        Where-Object {
            ($_.Name -match '^MCP (Edge|Chrome).*\(CDP \d+\)\.lnk$') -or
            ($_.Name -match '^Edge .*\.lnk$' -and $_.Name -notin $currentNames)
        })
    foreach ($r in $retired) {
        if ($PSCmdlet.ShouldProcess($r.FullName, 'remove retired CDP-labelled shortcut')) {
            Remove-Item -LiteralPath $r.FullName -Force
            Write-Host "removed retired shortcut: $($r.Name)" -ForegroundColor DarkYellow
        }
    }
}

Write-Host "`nDone. $($created.Count) shortcut(s) created in $DesktopPath." -ForegroundColor Green
Write-Host 'Each opens with NO debug port. Sign in once inside the window; close it when done so tasks can use that profile.' -ForegroundColor DarkGray
