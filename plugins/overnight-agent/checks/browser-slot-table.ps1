<#
  browser-slot-table.ps1 -- the ONE parser for the browser slot table.

  WHY THIS EXISTS
  ---------------
  GH #180 moved the browser slot definitions into `user-settings.md`, under a
  `## Browser slots` heading that declares itself "the source of truth -- SKILL.md
  and the scripts must read THIS, not restate it".

  The table moved. The scripts did not. Measured 2026-08-31, by counting port
  references in each helper:

    script                        9222 9225 9226 9227 9228 9229  bijlanis kiley
    ensure-mcp-browsers.ps1          2    2    2    2    2    0         0     0
    launch-signed-in-browser.ps1     3    0    0    0    0    0         0     0
    check-browser-slots.ps1          1    1    1    1    1    1         -     -

  So every script was still encoding the retired five-slot generation, and:

    * ensure-mcp-browsers.ps1 had ZERO references to 9229 / `edge-kiley`, so the
      one slot most likely to be closed could not be opened on demand at all --
      which is the exact failure #180 was filed to end.
    * ensure-mcp-browsers.ps1 mapped port 9228 to profile `edge-alt`, while the
      table maps 9228 to `edge-bijlanis`. Both directories exist on disk, so that
      launch would have SUCCEEDED against the wrong profile. Rule 1 of the settings
      section: "Never substitute a different account's profile for the requested
      one -- ... which is worse than failing."
    * check-browser-slots.ps1 hardcoded all six ports, including three retired
      ones, and contained zero occurrences of the string `user-settings`.

  THE POINT OF THIS FILE
  ----------------------
  Fixing three hardcoded lists by hand would reproduce the bug with newer numbers.
  The table has ONE home, so it gets ONE reader. Every consumer dot-sources this.

  FAIL LOUDLY, NEVER FALL BACK
  ----------------------------
  There is deliberately no baked-in slot list here. A silent fallback is precisely
  how the current drift stayed invisible for a week: the scripts kept working, on
  the wrong data, and nothing had a reason to complain. If the table cannot be
  found or parsed, every function in this file THROWS with the path it tried.

  TWO INSTALL LOCATIONS, DIFFERENT FILE SETS
  ------------------------------------------
  Consumers run from two places that do NOT hold the same files:

    nested  ~\.copilot\installed-plugins\focus-planner\overnight-agent\skills\overnight-agent\
            has SKILL.md + user-settings.md + ensure-mcp-browsers.ps1
    flat    %LOCALAPPDATA%\overnight-agent\
            has check-browser-slots.ps1 + oa-state.ps1, and NO user-settings.md

  So this file must never assume a sibling `user-settings.md`. That assumption is
  what made PR #303 green and still broken (#305). Resolution is by search order,
  exactly as SKILL.md documents it, and the winning path is reported on every
  record as `Source` so a caller can print where its data came from.

  USAGE
    . "$PSScriptRoot\browser-slot-table.ps1"
    $slots = Get-BrowserSlotTable
    $slots | Format-Table Slot, Port, ProfileDir, Account, Shortcut
#>

# Deliberately NO `Set-StrictMode` here. This file is dot-sourced into its
# consumers, and Set-StrictMode leaks into the caller's scope -- it would
# retroactively change the error semantics of three scripts that were written
# without it (e.g. `$version.Browser` on a CDP response that omits the field
# would start throwing). A library must not tighten its caller's rules.

# ---------------------------------------------------------------------------
# Settings-file resolution -- the order SKILL.md documents, in one place.
#
# Shiv's OneDrive path is NOT hardcoded: it is composed from %OneDrive% (then the
# Consumer/Commercial variants) so this works on any machine and any account.
# ---------------------------------------------------------------------------
function Get-OaSettingsPathCandidate {
    [CmdletBinding()]
    param([string]$ProjectFolder)

    $out = New-Object System.Collections.Generic.List[string]
    function Add-Candidate([string]$p) {
        if ($p -and -not [string]::IsNullOrWhiteSpace($p)) { [void]$out.Add($p) }
    }

    # 1. Explicit override.
    Add-Candidate $env:OVERNIGHT_AGENT_SETTINGS

    # 2. The project folder the agent is running in.
    if (-not $ProjectFolder) { $ProjectFolder = $env:PLANNER_PATH }
    if ($ProjectFolder) { Add-Candidate (Join-Path $ProjectFolder 'user-settings.md') }
    try { Add-Candidate (Join-Path (Get-Location).Path 'user-settings.md') } catch { }

    # 3. The canonical cloud-synced home, under whichever OneDrive var is set.
    foreach ($v in @($env:OneDrive, $env:OneDriveConsumer, $env:OneDriveCommercial)) {
        if ($v) { Add-Candidate (Join-Path $v 'Apps\Focus Planner\user-settings.md') }
    }

    # 4. Non-cloud fallback (the flat OA home).
    if ($env:LOCALAPPDATA) {
        Add-Candidate (Join-Path $env:LOCALAPPDATA 'overnight-agent\user-settings.md')
    }

    # Deliberately NOT included: the template shipped next to the skill. SKILL.md
    # marks it "template only" and it carries no `## Browser slots` section at all
    # (measured: 7 `<placeholder>` tokens, 0 slot headings), so trusting it would
    # mean launching browsers from placeholders.
    return $out.ToArray()
}

function Resolve-OaSettingsPath {
    [CmdletBinding()]
    param(
        [string]$ProjectFolder,
        [switch]$Quiet
    )

    $tried = Get-OaSettingsPathCandidate -ProjectFolder $ProjectFolder
    $skippedTemplate = @()

    foreach ($c in $tried) {
        if (-not (Test-Path -LiteralPath $c -PathType Leaf)) { continue }

        # THE TEMPLATE TRAP (found 2026-08-31 by running this from the real install
        # location rather than from the repo -- the #305 lesson, paid again).
        #
        # A `user-settings.md` sitting next to a `SKILL.md` is the template shipped
        # WITH the skill, which SKILL.md itself marks "template only": it carries
        # `<placeholder>` values and no `## Browser slots` section at all. When a
        # consumer runs with its cwd set to the installed skill folder -- which is
        # exactly what happens for `ensure-mcp-browsers.ps1`, since that folder IS
        # its home -- the cwd candidate resolves to that template, and the run dies
        # on a file that was never anybody's settings.
        #
        # `next to a SKILL.md` is the definition of the template, not a heuristic,
        # so that is the test. An EXPLICIT -ProjectFolder or OVERNIGHT_AGENT_SETTINGS
        # still wins: if someone names a path outright, honour it.
        if ($c -ne $env:OVERNIGHT_AGENT_SETTINGS) {
            $dir = Split-Path -Parent $c
            if ($dir -and (Test-Path -LiteralPath (Join-Path $dir 'SKILL.md') -PathType Leaf)) {
                $skippedTemplate += $c
                continue
            }
        }

        return (Resolve-Path -LiteralPath $c).Path
    }

    if ($Quiet) { return $null }

    $msg = "Could not find user-settings.md. Tried, in order:`n  " + ($tried -join "`n  ")
    if ($skippedTemplate.Count -gt 0) {
        $msg += ("`nSkipped as the skill's shipped TEMPLATE (a user-settings.md next to a SKILL.md):`n  " +
                 ($skippedTemplate -join "`n  "))
    }
    $msg += "`nSet OVERNIGHT_AGENT_SETTINGS to point at the real one."
    throw $msg
}

# ---------------------------------------------------------------------------
# Markdown helpers. Small and boring on purpose -- this parses ONE known table.
# Namespaced (`Oa`) because they are dot-sourced into other scripts' scopes.
# ---------------------------------------------------------------------------
function Split-OaMarkdownRow {
    param([string]$Line)
    $t = $Line.Trim()
    $t = $t -replace '^\|', '' -replace '\|\s*$', ''
    return @($t -split '\|' | ForEach-Object { $_.Trim() })
}

function ConvertTo-OaPlainCell {
    param([string]$Cell)
    if ($null -eq $Cell) { return '' }
    $t = $Cell -replace '`', ''            # code spans
    $t = $t -replace '\*\*|\*|__', ''      # emphasis
    return ($t -replace '\s+', ' ').Trim()
}

function Test-OaMarkdownSeparatorRow {
    param([string]$Line)
    # | --- | :--: | ---: |
    return ($Line -match '^\s*\|?[\s:|-]+\|[\s:|-]*$' -and $Line -match '-')
}

# ---------------------------------------------------------------------------
# THE PARSER
# ---------------------------------------------------------------------------
function Get-BrowserSlotTable {
    [CmdletBinding()]
    param(
        [string]$SettingsPath,
        [string]$ProjectFolder,
        [string]$SectionHeading = 'Browser slots'
    )

    if (-not $SettingsPath) { $SettingsPath = Resolve-OaSettingsPath -ProjectFolder $ProjectFolder }
    if (-not (Test-Path -LiteralPath $SettingsPath -PathType Leaf)) {
        throw "Browser slot table: settings file not found: $SettingsPath"
    }

    $text  = [IO.File]::ReadAllText($SettingsPath, [Text.Encoding]::UTF8)
    $lines = $text -split "`r?`n"

    # Locate the section. Matched on the heading PREFIX so the human-facing
    # parenthetical ("(the source of truth ...)") can be reworded freely.
    $start = -1
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match ('^##\s+' + [regex]::Escape($SectionHeading) + '\b')) { $start = $i; break }
    }
    if ($start -lt 0) {
        throw ("Browser slot table: no '## $SectionHeading' heading in $SettingsPath. " +
               'The scripts read that section as the source of truth; refusing to guess a slot list.')
    }

    # The section runs to the next H2 (or EOF).
    $end = $lines.Count
    for ($i = $start + 1; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match '^##\s+') { $end = $i; break }
    }

    # First table in the section whose header names both a slot and a port.
    $hdrIdx = -1
    for ($i = $start + 1; $i -lt $end - 1; $i++) {
        if ($lines[$i] -notmatch '^\s*\|') { continue }
        if (-not (Test-OaMarkdownSeparatorRow $lines[$i + 1])) { continue }
        $cells = @(Split-OaMarkdownRow $lines[$i] | ForEach-Object { (ConvertTo-OaPlainCell $_).ToLowerInvariant() })
        if (($cells -join '|') -match 'slot' -and ($cells -join '|') -match 'port') { $hdrIdx = $i; break }
    }
    if ($hdrIdx -lt 0) {
        throw ("Browser slot table: found '## $SectionHeading' in $SettingsPath but no table with " +
               "'Slot' and 'Port' columns under it. Refusing to guess a slot list.")
    }

    $rawHeader = @(Split-OaMarkdownRow $lines[$hdrIdx])
    $header    = @($rawHeader | ForEach-Object { (ConvertTo-OaPlainCell $_).ToLowerInvariant() })

    function Get-ColumnIndex([string[]]$H, [string[]]$Needles) {
        for ($c = 0; $c -lt $H.Count; $c++) {
            foreach ($n in $Needles) { if ($H[$c] -like "*$n*") { return $c } }
        }
        return -1
    }

    $iSlot     = Get-ColumnIndex $header @('slot')
    $iPort     = Get-ColumnIndex $header @('port')
    $iProfile  = Get-ColumnIndex $header @('profile')
    $iAccount  = Get-ColumnIndex $header @('account')
    $iShortcut = Get-ColumnIndex $header @('shortcut')

    if ($iSlot -lt 0 -or $iPort -lt 0) {
        throw "Browser slot table: header row in $SettingsPath is missing a Slot or Port column."
    }
    if ($iProfile -lt 0) {
        throw ("Browser slot table: header row in $SettingsPath has no Profile column. " +
               'The profile dir is the identity of the slot; refusing to launch without it.')
    }

    # The profile base directory is itself table-driven: it is stated in the
    # Profile column header, e.g. "Profile dir (`%LOCALAPPDATA%\playwright-mcp\`)".
    $base = $null
    if ($rawHeader[$iProfile] -match '(%[^%]+%[^\s`|)]*)') {
        $base = [Environment]::ExpandEnvironmentVariables($Matches[1]).TrimEnd('\', '/')
    }
    if (-not $base -and $env:LOCALAPPDATA) { $base = Join-Path $env:LOCALAPPDATA 'playwright-mcp' }

    $slots = New-Object System.Collections.Generic.List[object]

    for ($i = $hdrIdx + 2; $i -lt $end; $i++) {
        $line = $lines[$i]
        if ($line -notmatch '^\s*\|') { break }          # table ends at the first non-row
        if (Test-OaMarkdownSeparatorRow $line) { continue }

        $raw = @(Split-OaMarkdownRow $line)
        if ($raw.Count -le [Math]::Max($iSlot, $iPort)) { continue }

        $slotRaw = $raw[$iSlot]
        if ([string]::IsNullOrWhiteSpace((ConvertTo-OaPlainCell $slotRaw))) { continue }

        # Slot name: prefer the code-spanned token, so "`edge-cdp-1` (regular)"
        # yields the slot AND keeps "regular" as a friendly alias.
        $slot = $null; $alias = $null
        if ($slotRaw -match '`([^`]+)`') { $slot = $Matches[1].Trim() }
        else { $slot = (ConvertTo-OaPlainCell $slotRaw) -replace '\s*\(.*$', '' }
        if ($slotRaw -match '\(([^)]+)\)') { $alias = $Matches[1].Trim() }

        $portCell = ConvertTo-OaPlainCell $raw[$iPort]
        if ($portCell -notmatch '(\d{2,5})') {
            throw "Browser slot table: slot '$slot' in $SettingsPath has no numeric port (cell: '$portCell')."
        }
        $port = [int]$Matches[1]
        if ($port -lt 1 -or $port -gt 65535) {
            throw "Browser slot table: slot '$slot' has out-of-range port $port in $SettingsPath."
        }

        $profileDir = ConvertTo-OaPlainCell $raw[$iProfile]
        if (-not $profileDir) {
            throw "Browser slot table: slot '$slot' in $SettingsPath has an empty profile dir."
        }

        # A cell may give a bare name ("edge1") or a full/expandable path.
        if ($profileDir -match '[\\/]' -or $profileDir -match '%') {
            $profilePath = [Environment]::ExpandEnvironmentVariables($profileDir)
        }
        elseif ($base) { $profilePath = Join-Path $base $profileDir }
        else { $profilePath = $null }

        $account = if ($iAccount -ge 0 -and $raw.Count -gt $iAccount) { ConvertTo-OaPlainCell $raw[$iAccount] } else { '' }

        $shortcut = ''
        if ($iShortcut -ge 0 -and $raw.Count -gt $iShortcut) { $shortcut = ConvertTo-OaPlainCell $raw[$iShortcut] }
        if (-not $shortcut) { $shortcut = $slot }

        $slots.Add([pscustomobject]@{
            Slot        = $slot
            Alias       = $alias
            Port        = $port
            ProfileDir  = $profileDir
            ProfilePath = $profilePath
            Account     = $account
            Shortcut    = $shortcut
            Source      = $SettingsPath
        })
    }

    if ($slots.Count -eq 0) {
        throw ("Browser slot table: the '## $SectionHeading' table in $SettingsPath has no rows. " +
               'Refusing to fall back to a hardcoded slot list.')
    }

    # Integrity: two slots on one port, or two slots on one profile dir, means the
    # table cannot say which identity a port carries. That ambiguity is the whole
    # bug class here, so it is a hard error rather than a warning.
    $dupPort = @($slots | Group-Object Port | Where-Object { $_.Count -gt 1 })
    if ($dupPort.Count -gt 0) {
        throw ("Browser slot table: duplicate port(s) in $SettingsPath -- " +
               (($dupPort | ForEach-Object { $_.Name }) -join ', '))
    }
    $dupSlot = @($slots | Group-Object Slot | Where-Object { $_.Count -gt 1 })
    if ($dupSlot.Count -gt 0) {
        throw ("Browser slot table: duplicate slot name(s) in $SettingsPath -- " +
               (($dupSlot | ForEach-Object { $_.Name }) -join ', '))
    }
    $dupProfile = @($slots | Group-Object ProfileDir | Where-Object { $_.Count -gt 1 })
    if ($dupProfile.Count -gt 0) {
        throw ("Browser slot table: two slots share profile dir(s) in $SettingsPath -- " +
               (($dupProfile | ForEach-Object { $_.Name }) -join ', ') +
               '. A profile dir IS the identity; sharing one makes the account ambiguous.')
    }

    return $slots.ToArray()
}

# ---------------------------------------------------------------------------
# Selection. Resolve the PROFILE, not the slot name (settings rule 1), and never
# return a near-miss: an unmatched request throws rather than handing back
# whatever was first in the table.
# ---------------------------------------------------------------------------
function Select-BrowserSlot {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [object[]]$Slots,
        [string]$Name
    )

    if (-not $Name -or $Name -eq 'all') { return $Slots }

    $n = $Name.Trim()
    $hit = @($Slots | Where-Object {
        $_.Slot -eq $n -or
        $_.ProfileDir -eq $n -or
        $_.Alias -eq $n -or
        $_.Account -eq $n -or
        ($_.Port -as [string]) -eq $n
    })
    if ($hit.Count -eq 1) { return $hit }
    if ($hit.Count -gt 1) {
        throw ("'$Name' matches more than one slot (" + (($hit | ForEach-Object { $_.Slot }) -join ', ') +
               '). Name the slot exactly.')
    }

    throw ("No slot matches '$Name'. Known slots: " +
           (($Slots | ForEach-Object { "$($_.Slot) (port $($_.Port), profile $($_.ProfileDir), account $($_.Account))" }) -join '; ') +
           ". Never substitute a different account's profile for the requested one.")
}
