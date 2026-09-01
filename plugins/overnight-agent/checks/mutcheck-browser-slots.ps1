<#
  mutcheck-browser-slots.ps1 -- prove the browser slot table has exactly ONE reader,
  and that the guards in that reader are load-bearing.

  WHAT #180 ACTUALLY BROKE
  ------------------------
  The slot table moved into `user-settings.md` and was declared the source of truth.
  The three helper scripts did not move with it. Measured 2026-08-31 by counting port
  references:

    script                        9222 9225 9226 9227 9228 9229
    ensure-mcp-browsers.ps1          2    2    2    2    2    0
    launch-signed-in-browser.ps1     3    0    0    0    0    0
    check-browser-slots.ps1          1    1    1    1    1    1

  Two consequences, and this file exists to make both permanently detectable:

    * THE THIRD SLOT (port 9229) WAS UNLAUNCHABLE. The launcher had no idea it
      existed, so that profile being closed was an unrecoverable failure rather
      than "open it and carry on" -- the exact thing #180 was filed to end.
    * PORT 9228 POINTED AT THE WRONG PROFILE DIRECTORY. It named the profile from
      the pre-#180 generation, not the one the table assigns. Both directories
      exist on disk, so the launch would have SUCCEEDED against the wrong account
      -- which settings rule 1 calls worse than failing.

  FIXTURES ARE DELIBERATELY NOT THE REAL SLOT NAMES.
  Every fixture below uses neutral identities (`edge-cdp-second`, `edge-third`,
  `third-acct`, ...) that appear in no real configuration. That is a test
  property, not tidiness: if the fixtures reused the live names, a parser that
  had accidentally been keyed to one of those names would still pass every arm
  here. Neutral fixtures mean the arms can only pass by actually reading the
  table. It also keeps personal account names out of the repository, since the
  real ones belong in the user's own user-settings.md and nowhere else.

  THE FOUR REQUIRED FACTS (asserted directly, arms A-D)
    A  every slot in the table comes back, INCLUDING THE THIRD (port 9229)
    B  no retired port (9222 / 9226 / 9227) ever comes back
    C  port -> profile matches the table, not the pre-#180 mapping
    D  editing the TABLE changes behaviour with no script edited

  THE MUTANTS (arms M1-M5)
    M1  the "no section" throw is replaced by a baked-in legacy slot list
        -> the exact silent-fallback that let the drift stay invisible
    M2  Select-BrowserSlot returns the first slot instead of throwing on no match
        -> the wrong-identity substitution rule 1 forbids
    M3  the duplicate-port guard is deleted
        -> a table where one port claims two accounts parses "fine"
    M4  columns are resolved by fixed position instead of by header name
        -> a reordered table silently swaps port and profile
    M5  the shipped-template guard is deleted
        -> the installed skill folder's own placeholder user-settings.md wins

  Every mutant must be KILLED. A surviving mutant means the guard it targets has
  become decorative, which still reports success -- the failure mode this file
  exists to detect.

  ARMS E-H run the REAL consumer scripts and the REAL resolution order, because a
  parser that is right inside a test and wrong at the call site is the #305 lesson:
  a check that has never run where it will actually run is not a check yet. Arm H
  in particular exists because running ensure-mcp-browsers.ps1 from its true
  install directory (rather than from the repo) failed on the first try.

  NEVER TOUCHES LIVE STATE. Every fixture is a temp file; the real user-settings.md
  is only ever READ (arm G); no browser is launched or killed (`-DryRun` only).

  RUN:  pwsh -NoProfile -File mutcheck-browser-slots.ps1
  EXIT: 0 all assertions passed. 1 something failed / a mutant survived.
#>
[CmdletBinding()]
param(
    [string]$LibPath,
    [string]$CheckScript,
    [string]$EnsureScript
)

$ErrorActionPreference = 'Stop'

$onWindows = ($null -eq $IsWindows) -or $IsWindows

if (-not $LibPath) { $LibPath = Join-Path $PSScriptRoot 'browser-slot-table.ps1' }
if (-not $CheckScript) { $CheckScript = Join-Path $PSScriptRoot 'check-browser-slots.ps1' }
if (-not $EnsureScript) {
    foreach ($c in @(
            ([IO.Path]::Combine($PSScriptRoot, '..', 'skills', 'overnight-agent', 'ensure-mcp-browsers.ps1'))
            ([IO.Path]::Combine($PSScriptRoot, 'ensure-mcp-browsers.ps1'))
        )) {
        if (Test-Path -LiteralPath $c) { $EnsureScript = (Resolve-Path -LiteralPath $c).Path; break }
    }
}
if (-not (Test-Path -LiteralPath $LibPath)) { throw "browser-slot-table.ps1 not found at $LibPath" }

$utf8NoBom = New-Object Text.UTF8Encoding($false)
$libSrc = [IO.File]::ReadAllText($LibPath, $utf8NoBom)

$psExe = (Get-Command pwsh -ErrorAction SilentlyContinue).Source
if (-not $psExe) { $psExe = (Get-Command powershell -ErrorAction SilentlyContinue).Source }
if (-not $psExe) { throw 'No PowerShell host found to run the probes in.' }

$script:Pass = 0
$script:Fail = 0
function Assert($name, $cond, $detail) {
    if ($cond) { $script:Pass++; Write-Host ("  ok    {0}" -f $name) -ForegroundColor Green }
    else { $script:Fail++; Write-Host ("  FAIL  {0}  {1}" -f $name, $detail) -ForegroundColor Red }
}

$tmpRoot = Join-Path ([IO.Path]::GetTempPath()) ("mut180-" + [guid]::NewGuid().ToString('N').Substring(0, 10))
New-Item -ItemType Directory -Force -Path $tmpRoot | Out-Null

# ---------------------------------------------------------------------------
# Fixtures. `New-SettingsFixture` mirrors the SHAPE of the real table (same
# column headers, same code-span formatting) but with its own values, so an arm
# can prove "the table drives behaviour" without depending on the live file.
# ---------------------------------------------------------------------------
function New-SettingsFixture {
    param(
        [Parameter(Mandatory)] [string]$Name,
        [string[]]$Rows,
        [switch]$NoSection,
        [switch]$NoTable,
        [switch]$EmptyTable,
        [switch]$ReorderColumns
    )
    $p = Join-Path $tmpRoot "$Name.md"
    $L = New-Object System.Collections.Generic.List[string]
    [void]$L.Add('# Overnight Agent - user settings (fixture)')
    [void]$L.Add('')
    [void]$L.Add('## Settings')
    [void]$L.Add('')
    [void]$L.Add('| Setting | Value |')
    [void]$L.Add('| --- | --- |')
    [void]$L.Add('| Planner board | `C:\board\planner.md` |')
    [void]$L.Add('')

    if (-not $NoSection) {
        [void]$L.Add('## Browser slots (the source of truth - the scripts must read THIS)')
        [void]$L.Add('')
        if ($NoTable) {
            [void]$L.Add('Prose only. No table here on purpose.')
        }
        elseif ($ReorderColumns) {
            [void]$L.Add('| Account | Profile dir (`%LOCALAPPDATA%\playwright-mcp\`) | Slot | Port | Desktop shortcut |')
            [void]$L.Add('| --- | --- | --- | --- | --- |')
            foreach ($r in $Rows) { [void]$L.Add($r) }
        }
        else {
            [void]$L.Add('| Slot | Port | Profile dir (`%LOCALAPPDATA%\playwright-mcp\`) | Account | Desktop shortcut |')
            [void]$L.Add('| --- | --- | --- | --- | --- |')
            if (-not $EmptyTable) { foreach ($r in $Rows) { [void]$L.Add($r) } }
        }
        [void]$L.Add('')
        [void]$L.Add('**Retired - remove from mcp-config.json:** `edge-cdp-2` (9226) and `edge-cdp-3` (9227),')
        [void]$L.Add('and `chrome-cdp-1` (9222), disabled since 2026-08-21.')
        [void]$L.Add('')
    }
    [void]$L.Add('## Something after')
    [void]$L.Add('')
    [IO.File]::WriteAllText($p, ($L -join "`n"), $utf8NoBom)
    return $p
}

# The live shape: three identities, one slot each.
$liveRows = @(
    '| `edge-cdp-1` (regular) | 9225 | `edge1` | primary | MCP Edge 1 (CDP 9225) |'
    '| `edge-cdp-second` | 9228 | `edge-second` | second-acct | Second browser (CDP 9228) |'
    '| `edge-cdp-third` | 9229 | `edge-third` | third-acct | Third browser (CDP 9229) |'
)

$fxLive = New-SettingsFixture -Name 'live' -Rows $liveRows

# ---------------------------------------------------------------------------
# Probe: dot-source a (possibly mutated) library in a CHILD process and report
# what it returned as JSON. A child process keeps a mutant's functions from
# leaking into this one -- and means the mutant is exercised the same way a real
# consumer exercises the library.
# ---------------------------------------------------------------------------
$driver = Join-Path $tmpRoot 'probe.ps1'
[IO.File]::WriteAllText($driver, @'
param([string]$Lib, [string]$Settings, [string]$Mode = 'table', [string]$Name, [string]$ProjectFolder)
$ErrorActionPreference = 'Stop'
. $Lib
try {
    if ($Mode -eq 'resolve') {
        $p = Resolve-OaSettingsPath -ProjectFolder $ProjectFolder -Quiet
        [pscustomobject]@{ ok = $true; resolved = $p } | ConvertTo-Json -Depth 3 -Compress
        return
    }
    $all = @(Get-BrowserSlotTable -SettingsPath $Settings)
    $rows = if ($Mode -eq 'select') { @(Select-BrowserSlot -Slots $all -Name $Name) } else { $all }
    [pscustomobject]@{
        ok   = $true
        rows = @($rows | ForEach-Object {
            [pscustomobject]@{ Slot = $_.Slot; Port = $_.Port; ProfileDir = $_.ProfileDir; Account = $_.Account }
        })
    } | ConvertTo-Json -Depth 6 -Compress
}
catch {
    [pscustomobject]@{ ok = $false; err = $_.Exception.Message } | ConvertTo-Json -Depth 3 -Compress
}
'@, $utf8NoBom)

$probeSeq = 0
function Invoke-Probe {
    param(
        [string]$Source = $libSrc,
        [string]$Settings = '',
        [string]$Mode = 'table',
        [string]$Name,
        [string]$ProjectFolder,
        [string]$OverrideEnv
    )
    $script:probeSeq++
    $lib = Join-Path $tmpRoot ("lib-{0}.ps1" -f $script:probeSeq)
    [IO.File]::WriteAllText($lib, $Source, $utf8NoBom)
    $prev = $env:OVERNIGHT_AGENT_SETTINGS
    if ($PSBoundParameters.ContainsKey('OverrideEnv')) { $env:OVERNIGHT_AGENT_SETTINGS = $OverrideEnv }
    try {
        $out = & $psExe -NoProfile -File $driver -Lib $lib -Settings $Settings -Mode $Mode -Name $Name -ProjectFolder $ProjectFolder 2>&1
    }
    finally {
        if ($PSBoundParameters.ContainsKey('OverrideEnv')) { $env:OVERNIGHT_AGENT_SETTINGS = $prev }
    }
    $text = ($out | Out-String).Trim()
    try { return ($text | ConvertFrom-Json) }
    catch { return [pscustomobject]@{ ok = $false; err = "probe produced non-JSON: $text" } }
}

function Get-PortList($result) {
    if (-not $result.ok) { return @() }
    return @($result.rows | ForEach-Object { [int]$_.Port })
}
function Get-ProfileForPort($result, [int]$Port) {
    if (-not $result.ok) { return $null }
    return @($result.rows | Where-Object { [int]$_.Port -eq $Port } | ForEach-Object { $_.ProfileDir })[0]
}

Write-Host "`nmutcheck-browser-slots -- one table, one reader (GH #180)" -ForegroundColor Cyan
Write-Host "library : $LibPath" -ForegroundColor DarkGray
Write-Host "host    : $psExe`n" -ForegroundColor DarkGray

# ===========================================================================
# ARM A -- every slot in the table comes back, INCLUDING the third (port 9229).
# The pre-#180 launcher had zero references to 9229; that is the headline bug.
# ===========================================================================
Write-Host 'A: every slot is returned (including the third, port 9229)' -ForegroundColor Cyan
$a = Invoke-Probe -Settings $fxLive
Assert 'A parses the table'            ($a.ok)                                     $a.err
$ports = Get-PortList $a
Assert 'A returns exactly 3 slots'     ($ports.Count -eq 3)                        "got $($ports -join ',')"
Assert 'A includes 9225 (regular)'     ($ports -contains 9225)                     "got $($ports -join ',')"
Assert 'A includes 9228 (the second slot)'    ($ports -contains 9228)                     "got $($ports -join ',')"
Assert 'A includes 9229 (the third slot)'       ($ports -contains 9229)                     'the third slot is missing -- the exact #180 defect'
$third = @($a.rows | Where-Object { [int]$_.Port -eq 9229 })[0]
Assert 'A the third slot maps to its own profile' ($third -and $third.ProfileDir -eq 'edge-third') "got '$($third.ProfileDir)'"
Assert 'A the third slot carries its own account'       ($third -and $third.Account -eq 'third-acct')        "got '$($third.Account)'"

# ===========================================================================
# ARM B -- retired ports never come back. They are named in the section's PROSE
# (as the fixture reproduces), so a sloppy parser that scanned the whole section
# for numbers would pick them up. Parsing the TABLE is what excludes them.
# ===========================================================================
Write-Host "`nB: retired ports are never returned" -ForegroundColor Cyan
foreach ($retired in 9222, 9226, 9227) {
    Assert "B excludes $retired" (-not ($ports -contains $retired)) "retired port $retired came back"
}

# ===========================================================================
# ARM C -- port -> profile matches the table, not the pre-#180 mapping.
# The old launcher mapped 9228 -> edge-alt. edge-alt EXISTS on disk, so that
# launch would have succeeded as the wrong account.
# ===========================================================================
Write-Host "`nC: port -> profile matches the table, not the old mapping" -ForegroundColor Cyan
Assert 'C 9225 -> edge1'          ((Get-ProfileForPort $a 9225) -eq 'edge1')          "got '$(Get-ProfileForPort $a 9225)'"
Assert 'C 9228 -> edge-second'  ((Get-ProfileForPort $a 9228) -eq 'edge-second')  "got '$(Get-ProfileForPort $a 9228)' -- the old code said edge-alt"
Assert 'C 9229 -> edge-third'     ((Get-ProfileForPort $a 9229) -eq 'edge-third')     "got '$(Get-ProfileForPort $a 9229)'"
Assert 'C no slot maps to edge-alt' (-not (@($a.rows | ForEach-Object { $_.ProfileDir }) -contains 'edge-alt')) 'edge-alt is still reachable'

# ===========================================================================
# ARM D -- a TABLE edit changes behaviour with NO script edited. This is the
# whole point of #180: adding a profile must be a one-row edit.
# ===========================================================================
Write-Host "`nD: editing the table changes behaviour, with no script edited" -ForegroundColor Cyan
$fxFour = New-SettingsFixture -Name 'four' -Rows ($liveRows + '| `edge-cdp-newco` | 9231 | `edge-newco` | newco | MCP Edge newco (CDP 9231) |')
$d = Invoke-Probe -Settings $fxFour
$dPorts = Get-PortList $d
Assert 'D the new row is picked up'   ($dPorts -contains 9231)                 "got $($dPorts -join ',')"
Assert 'D count grew to 4'            ($dPorts.Count -eq 4)                    "got $($dPorts.Count)"
Assert 'D new slot keeps its profile' ((Get-ProfileForPort $d 9231) -eq 'edge-newco') "got '$(Get-ProfileForPort $d 9231)'"

$fxTwo = New-SettingsFixture -Name 'two' -Rows $liveRows[0..1]
$d2 = Invoke-Probe -Settings $fxTwo
$d2Ports = Get-PortList $d2
Assert 'D removing a row removes the slot' (-not ($d2Ports -contains 9229))    "9229 survived its own deletion"

# A reordered table must still map correctly: columns are found by NAME.
$fxReorder = New-SettingsFixture -Name 'reorder' -ReorderColumns -Rows @(
    '| primary | `edge1` | `edge-cdp-1` | 9225 | MCP Edge 1 |'
    '| second-acct | `edge-second` | `edge-cdp-second` | 9228 | Second browser |'
    '| third-acct | `edge-third` | `edge-cdp-third` | 9229 | Third browser |'
)
$dr = Invoke-Probe -Settings $fxReorder
Assert 'D reordered columns still parse'   ($dr.ok)                                    $dr.err
Assert 'D reordered 9228 -> edge-second' ((Get-ProfileForPort $dr 9228) -eq 'edge-second') "got '$(Get-ProfileForPort $dr 9228)'"

# ===========================================================================
# BASELINE FOR THE MUTANTS -- the unmutated library must FAIL LOUDLY on each
# malformed table. If it did not, the mutants below would prove nothing.
# ===========================================================================
Write-Host "`nbaseline: the real parser fails loudly rather than guessing" -ForegroundColor Cyan
$fxNoSection = New-SettingsFixture -Name 'nosection' -NoSection
$fxNoTable = New-SettingsFixture -Name 'notable' -NoTable
$fxEmpty = New-SettingsFixture -Name 'emptytable' -EmptyTable
$fxDupPort = New-SettingsFixture -Name 'dupport' -Rows @(
    '| `edge-cdp-second` | 9228 | `edge-second` | second-acct | s1 |'
    '| `edge-cdp-third` | 9228 | `edge-third` | third-acct | s2 |'
)
$fxDupProfile = New-SettingsFixture -Name 'dupprofile' -Rows @(
    '| `edge-cdp-second` | 9228 | `edge-shared` | second-acct | s1 |'
    '| `edge-cdp-third` | 9229 | `edge-shared` | third-acct | s2 |'
)

$bNoSection = Invoke-Probe -Settings $fxNoSection
$bNoTable = Invoke-Probe -Settings $fxNoTable
$bEmpty = Invoke-Probe -Settings $fxEmpty
$bDupPort = Invoke-Probe -Settings $fxDupPort
$bDupProfile = Invoke-Probe -Settings $fxDupProfile
$bMissing = Invoke-Probe -Settings (Join-Path $tmpRoot 'does-not-exist.md')

Assert 'baseline throws with no section'       (-not $bNoSection.ok)   'returned a slot list from a file with no Browser slots section'
Assert 'baseline throws with no table'         (-not $bNoTable.ok)     'returned a slot list from prose'
Assert 'baseline throws on an empty table'     (-not $bEmpty.ok)       'returned rows from a table with none'
Assert 'baseline throws on duplicate ports'    (-not $bDupPort.ok)     'accepted one port claiming two accounts'
Assert 'baseline throws on a shared profile'   (-not $bDupProfile.ok)  'accepted two slots sharing one identity'
Assert 'baseline throws on a missing file'     (-not $bMissing.ok)     'invented a slot list with no settings file'
Assert 'baseline error names the section'      ($bNoSection.err -match 'Browser slots') "unhelpful error: $($bNoSection.err)"

# Selection must refuse a near-miss rather than substitute.
$selBad = Invoke-Probe -Settings $fxLive -Mode 'select' -Name 'edge-alt'
Assert 'baseline refuses an unknown slot name' (-not $selBad.ok)       'edge-alt resolved to something'
Assert 'baseline refusal explains itself'      ($selBad.err -match 'substitute') "unhelpful error: $($selBad.err)"
$selOk = Invoke-Probe -Settings $fxLive -Mode 'select' -Name 'third-acct'
Assert 'baseline resolves a slot by account'   ($selOk.ok -and @(Get-PortList $selOk) -contains 9229) "got $($selOk.err)"

# ===========================================================================
# M1 -- THE LOAD-BEARING MUTANT. Replace the "no section" throw with a baked-in
# legacy slot list: exactly the silent fallback that let the drift stay invisible
# for a week while every script kept reporting success.
# ===========================================================================
Write-Host "`nM1: silent fallback to a baked-in legacy slot list" -ForegroundColor Cyan
$m1Needle = @'
        throw ("Browser slot table: no '## $SectionHeading' heading in $SettingsPath. " +
               'The scripts read that section as the source of truth; refusing to guess a slot list.')
'@ -replace "`r`n", "`n"
$m1Repl = @'
        return @(
            [pscustomobject]@{ Slot='chrome-cdp-1'; Alias=$null; Port=9222; ProfileDir='chrome1'; ProfilePath=$null; Account='primary'; Shortcut='x'; Source=$SettingsPath }
            [pscustomobject]@{ Slot='edge-cdp-1'; Alias=$null; Port=9225; ProfileDir='edge1'; ProfilePath=$null; Account='primary'; Shortcut='x'; Source=$SettingsPath }
            [pscustomobject]@{ Slot='edge-cdp-2'; Alias=$null; Port=9226; ProfileDir='edge2'; ProfilePath=$null; Account='primary'; Shortcut='x'; Source=$SettingsPath }
            [pscustomobject]@{ Slot='edge-cdp-3'; Alias=$null; Port=9227; ProfileDir='edge3'; ProfilePath=$null; Account='primary'; Shortcut='x'; Source=$SettingsPath }
            [pscustomobject]@{ Slot='edge-cdp-alt'; Alias=$null; Port=9228; ProfileDir='edge-alt'; ProfilePath=$null; Account='alternate'; Shortcut='x'; Source=$SettingsPath }
        )
'@ -replace "`r`n", "`n"
$libN = $libSrc -replace "`r`n", "`n"
$m1Src = $libN.Replace($m1Needle, $m1Repl)
Assert 'M1 mutation applied' ($m1Src -ne $libN) 'the no-section throw did not match -- update this mutcheck'
if ($m1Src -ne $libN) {
    $m1 = Invoke-Probe -Source $m1Src -Settings $fxNoSection
    $m1Ports = Get-PortList $m1
    Assert 'M1 survives only because the guard was removed' ($m1.ok) 'M1 died for an unrelated reason, so the baseline proves nothing'
    Assert 'M1 resurrects retired ports'   (($m1Ports -contains 9222) -and ($m1Ports -contains 9226)) "got $($m1Ports -join ',')"
    Assert 'M1 restores the 9228 -> edge-alt mis-mapping' ((Get-ProfileForPort $m1 9228) -eq 'edge-alt') 'the mutant did not reproduce the wrong-identity mapping'
    Assert 'M1 is KILLED by the baseline'  (-not $bNoSection.ok) 'the real parser also fell back -- the guard is not load-bearing'
}

# ===========================================================================
# M2 -- Select-BrowserSlot "helpfully" returns the first slot on no match.
# That is the wrong-identity substitution settings rule 1 forbids: asking for
# the second identity and being handed the first.
# ===========================================================================
Write-Host "`nM2: unknown slot silently resolves to the first slot" -ForegroundColor Cyan
$m2Needle = @'
    throw ("No slot matches '$Name'. Known slots: " +
'@ -replace "`r`n", "`n"
$m2Repl = @'
    return @($Slots[0])
    throw ("No slot matches '$Name'. Known slots: " +
'@ -replace "`r`n", "`n"
$m2Src = $libN.Replace($m2Needle, $m2Repl)
Assert 'M2 mutation applied' ($m2Src -ne $libN) 'the no-match throw did not match -- update this mutcheck'
if ($m2Src -ne $libN) {
    $m2 = Invoke-Probe -Source $m2Src -Settings $fxLive -Mode 'select' -Name 'edge-alt'
    Assert 'M2 survives only because the guard was removed' ($m2.ok) 'M2 died for an unrelated reason'
    Assert 'M2 hands back the WRONG account' ($m2.ok -and @($m2.rows)[0].Account -eq 'primary') "got '$(@($m2.rows)[0].Account)'"
    Assert 'M2 is KILLED by the baseline'    (-not $selBad.ok) 'the real Select-BrowserSlot also substituted'
}

# ===========================================================================
# M3 -- delete the duplicate-port guard. One port claiming two accounts means
# nothing can say which identity that port carries.
# ===========================================================================
Write-Host "`nM3: duplicate-port guard removed" -ForegroundColor Cyan
$m3Src = [regex]::Replace($libN,
    '(?s)\n    \$dupPort = @\(\$slots \| Group-Object Port.*?\n    \}\n', "`n")
Assert 'M3 mutation applied' ($m3Src -ne $libN) 'the duplicate-port guard did not match -- update this mutcheck'
if ($m3Src -ne $libN) {
    $m3 = Invoke-Probe -Source $m3Src -Settings $fxDupPort
    Assert 'M3 survives only because the guard was removed' ($m3.ok) "M3 died for an unrelated reason: $($m3.err)"
    Assert 'M3 is KILLED by the baseline'  (-not $bDupPort.ok) 'the real parser also accepted a duplicated port'
}

# ===========================================================================
# M4 -- resolve columns by fixed position instead of by header name. A table
# whose columns are reordered then silently swaps port and profile.
# ===========================================================================
Write-Host "`nM4: columns resolved by position, not by header name" -ForegroundColor Cyan
$m4Src = $libN.Replace(
    '    $iSlot     = Get-ColumnIndex $header @(''slot'')',
    '    $iSlot     = 0').Replace(
    '    $iPort     = Get-ColumnIndex $header @(''port'')',
    '    $iPort     = 1').Replace(
    '    $iProfile  = Get-ColumnIndex $header @(''profile'')',
    '    $iProfile  = 2')
Assert 'M4 mutation applied' ($m4Src -ne $libN) 'the column resolution did not match -- update this mutcheck'
if ($m4Src -ne $libN) {
    $m4 = Invoke-Probe -Source $m4Src -Settings $fxReorder
    $m4Wrong = (-not $m4.ok) -or ((Get-ProfileForPort $m4 9228) -ne 'edge-second')
    Assert 'M4 gets the reordered table wrong' $m4Wrong 'positional lookup happened to be right -- pick a harder fixture'
    Assert 'M4 is KILLED by the baseline'      ($dr.ok -and (Get-ProfileForPort $dr 9228) -eq 'edge-second') 'the real parser also mis-read the reordered table'
}

# ===========================================================================
# ARM H -- THE TEMPLATE TRAP. Found 2026-08-31 by running ensure-mcp-browsers.ps1
# from its REAL install location instead of from the repo (the #305 lesson).
#
# The installed skill folder ships its own `user-settings.md` TEMPLATE next to
# SKILL.md -- placeholders, no `## Browser slots` section. That folder is also
# the script's home, so when it runs with that cwd, the "project folder"
# candidate resolves to the template and the whole run dies on a file that was
# never anybody's settings. Resolution must skip a user-settings.md that sits
# next to a SKILL.md -- which is precisely SKILL.md's own definition of the
# template -- while still honouring an explicit override.
# ===========================================================================
Write-Host "`nH: the shipped template is never mistaken for real settings" -ForegroundColor Cyan
$skillDir = Join-Path $tmpRoot 'installed-skill'
New-Item -ItemType Directory -Force -Path $skillDir | Out-Null
[IO.File]::WriteAllText((Join-Path $skillDir 'SKILL.md'), "# Overnight Agent`n", $utf8NoBom)
[IO.File]::WriteAllText((Join-Path $skillDir 'user-settings.md'),
    "# template`n`n## Settings`n`n| Setting | Value |`n| --- | --- |`n| Planner board | ``<path>`` |`n", $utf8NoBom)
$templatePath = Join-Path $skillDir 'user-settings.md'

$plainDir = Join-Path $tmpRoot 'project-folder'
New-Item -ItemType Directory -Force -Path $plainDir | Out-Null
Copy-Item $fxLive (Join-Path $plainDir 'user-settings.md') -Force

$h1 = Invoke-Probe -Mode 'resolve' -ProjectFolder $skillDir -OverrideEnv ''
Assert 'H skips the template beside SKILL.md' ($h1.ok -and $h1.resolved -ne $templatePath) "resolved to '$($h1.resolved)'"

$h2 = Invoke-Probe -Mode 'resolve' -ProjectFolder $plainDir -OverrideEnv ''
Assert 'H still accepts a real project settings file' ($h2.ok -and $h2.resolved -eq (Join-Path $plainDir 'user-settings.md')) "resolved to '$($h2.resolved)'"

$h3 = Invoke-Probe -Mode 'resolve' -ProjectFolder $plainDir -OverrideEnv $templatePath
Assert 'H an explicit override still wins' ($h3.ok -and $h3.resolved -eq $templatePath) "resolved to '$($h3.resolved)'"

# ===========================================================================
# M5 -- remove the template guard. The consumer then resolves the placeholder
# template and dies, which is what actually happened on the live box.
# ===========================================================================
Write-Host "`nM5: template guard removed (reproduces the live failure)" -ForegroundColor Cyan
$m5Src = [regex]::Replace($libN,
    "(?s)\n        if \(\`$c -ne \`$env:OVERNIGHT_AGENT_SETTINGS\) \{.*?\n        \}\n", "`n")
Assert 'M5 mutation applied' ($m5Src -ne $libN) 'the template guard did not match -- update this mutcheck'
if ($m5Src -ne $libN) {
    $m5 = Invoke-Probe -Source $m5Src -Mode 'resolve' -ProjectFolder $skillDir -OverrideEnv ''
    Assert 'M5 resolves the shipped template' ($m5.ok -and $m5.resolved -eq $templatePath) "resolved to '$($m5.resolved)'"
    Assert 'M5 is KILLED by the baseline'      ($h1.resolved -ne $templatePath) 'the real resolver also picked the template'
}

# ===========================================================================
# ARM E -- the REAL check-browser-slots.ps1, run as a consumer. #305: a check
# that has never run where it will actually run is not a check yet.
# ===========================================================================
Write-Host "`nE: the real check-browser-slots.ps1 consumes the table" -ForegroundColor Cyan
if (Test-Path -LiteralPath $CheckScript) {
    # A settings file it cannot read must NOT report "ok".
    & $psExe -NoProfile -File $CheckScript -SettingsPath $fxNoSection *> (Join-Path $tmpRoot 'e1.txt')
    $e1 = $LASTEXITCODE
    Assert 'E unreadable table does not exit 0' ($e1 -ne 0) "exited $e1 -- a preflight that cannot answer reported success"
    Assert 'E unreadable table exits 2 (attention)' ($e1 -eq 2) "exited $e1"

    # A readable fixture must produce exactly the fixture's slots.
    $eJson = & $psExe -NoProfile -File $CheckScript -Json -SettingsPath $fxLive 2>$null
    $e2 = $LASTEXITCODE
    $rows = @()
    try { $rows = @(($eJson | Out-String) | ConvertFrom-Json) } catch { }
    $eports = @($rows | ForEach-Object { [int]$_.port })
    Assert 'E -Json still emits an array'   ($rows.Count -eq 3)                 "got $($rows.Count) row(s)"
    Assert 'E reports the third slot (9229)'         ($eports -contains 9229)            "got $($eports -join ',')"
    Assert 'E reports no retired port'      (-not (($eports -contains 9222) -or ($eports -contains 9226) -or ($eports -contains 9227))) "got $($eports -join ',')"
    Assert 'E carries the account through'  (@($rows | Where-Object { [int]$_.port -eq 9228 })[0].account -eq 'second-acct') 'account missing from JSON'
    Assert 'E exits 0 when nothing is up'   ($e2 -eq 0)                         "exited $e2"
}
else {
    Write-Host '  (skipped: check-browser-slots.ps1 not found)' -ForegroundColor DarkGray
}

# ===========================================================================
# ARM F -- the REAL ensure-mcp-browsers.ps1, in -DryRun. Windows-only: it needs
# a browser binary to name. It never launches anything here.
# ===========================================================================
Write-Host "`nF: the real ensure-mcp-browsers.ps1 launches the right profile" -ForegroundColor Cyan
if ($EnsureScript -and (Test-Path -LiteralPath $EnsureScript) -and $onWindows) {
    # Ports well outside the live range, so no live slot short-circuits as "already up".
    $fxDown = New-SettingsFixture -Name 'down' -Rows @(
        '| `edge-cdp-1` (regular) | 19225 | `edge1` | primary | s1 |'
        '| `edge-cdp-second` | 19228 | `edge-second` | second-acct | s2 |'
        '| `edge-cdp-third` | 19229 | `edge-third` | third-acct | s3 |'
    )
    $f1 = (& $psExe -NoProfile -File $EnsureScript -DryRun -SettingsPath $fxDown 2>&1 | Out-String)
    Assert 'F would launch the third slot'    ($f1 -match 'edge-cdp-third.*WOULD LAUNCH')    'the third slot is still unlaunchable'
    Assert 'F the third slot uses its own profile dir'   ($f1 -match 'playwright-mcp[\\/]edge-third')   'third slot launch does not name its profile dir'
    Assert 'F the second slot uses its own profile dir'    ($f1 -match 'playwright-mcp[\\/]edge-second') 'second slot launch does not name its profile dir'
    Assert 'F never launches edge-alt'        ($f1 -notmatch 'edge-alt')                     'the retired wrong-identity profile is still reachable'
    Assert 'F names the port from the table'  ($f1 -match 'remote-debugging-port=19229')     'port did not come from the table'

    # An unknown profile must be refused, not approximated.
    & $psExe -NoProfile -File $EnsureScript -DryRun -Slot 'edge-alt' -SettingsPath $fxDown *> (Join-Path $tmpRoot 'f2.txt')
    Assert 'F refuses an unknown slot' ($LASTEXITCODE -ne 0) 'edge-alt was accepted'

    # An unreadable table must launch nothing at all.
    $f3 = (& $psExe -NoProfile -File $EnsureScript -DryRun -SettingsPath $fxNoSection 2>&1 | Out-String)
    Assert 'F launches nothing without a table' ($LASTEXITCODE -eq 2 -and $f3 -notmatch 'WOULD LAUNCH') "exit=$LASTEXITCODE"
}
else {
    Write-Host '  (skipped: needs Windows + ensure-mcp-browsers.ps1)' -ForegroundColor DarkGray
}

# ===========================================================================
# ARM G -- the LIVE user-settings.md, read-only. This is the one arm that can
# catch the table and the code drifting apart again on the real machine. It is
# advisory off-Windows / when the file is absent (e.g. CI).
# ===========================================================================
Write-Host "`nG: the live user-settings.md (read-only)" -ForegroundColor Cyan
$livePath = $null
try {
    . $LibPath
    $livePath = Resolve-OaSettingsPath -Quiet
}
catch { $livePath = $null }

if ($livePath -and (Test-Path -LiteralPath $livePath)) {
    $g = Invoke-Probe -Settings $livePath
    Assert 'G the live table parses' ($g.ok) $g.err
    if ($g.ok) {
        $gp = Get-PortList $g
        Write-Host ("  live slots: " + (@($g.rows | ForEach-Object { "$($_.Port)->$($_.ProfileDir) ($($_.Account))" }) -join ', ')) -ForegroundColor DarkGray
        Assert 'G no retired port is live' (-not (($gp -contains 9222) -or ($gp -contains 9226) -or ($gp -contains 9227))) "got $($gp -join ',')"
        Assert 'G no slot maps to edge-alt' (-not (@($g.rows | ForEach-Object { $_.ProfileDir }) -contains 'edge-alt')) 'edge-alt is back in the live table'
    }
}
else {
    Write-Host '  (skipped: no live user-settings.md on this host)' -ForegroundColor DarkGray
}

# ===========================================================================
# ARM I -- the SHIPPED TEMPLATE's example table must itself be valid.
#
# The template is what a new user starts from, and #180's whole subject is a
# slot list that drifted out of step with its readers. An example that no longer
# parses is that same defect aimed at everyone who installs this next: they copy
# it, it is refused, and the refusal looks like their mistake. So the example is
# asserted against the real parser rather than eyeballed.
#
# Note this does NOT contradict arm H. H proves the template is never picked up
# as somebody's live settings (path-based: it sits next to SKILL.md). This proves
# that when a user COPIES it, what they copied works.
# ===========================================================================
Write-Host "`nI: the shipped template ships a working example" -ForegroundColor Cyan
$tmpl = $null
foreach ($c in @(
        ([IO.Path]::Combine($PSScriptRoot, '..', 'skills', 'overnight-agent', 'user-settings.md'))
        ([IO.Path]::Combine($PSScriptRoot, 'user-settings.md'))
    )) {
    if (Test-Path -LiteralPath $c) { $tmpl = (Resolve-Path -LiteralPath $c).Path; break }
}
if ($tmpl) {
    $iRes = Invoke-Probe -Settings $tmpl
    Assert 'I the template example parses' ($iRes.ok) $iRes.err
    if ($iRes.ok) {
        $iPorts = Get-PortList $iRes
        Assert 'I the example defines at least one slot' ($iPorts.Count -ge 1) 'no rows'
        Assert 'I every example slot has a profile dir' (@($iRes.rows | Where-Object { -not $_.ProfileDir }).Count -eq 0) 'a row has no profile dir'
    }
    # The template must stay free of real account names -- it ships to everyone.
    $tmplText = [IO.File]::ReadAllText($tmpl, $utf8NoBom)
    Assert 'I the template has a Browser slots section' ($tmplText -match '(?m)^##\s+Browser slots\b') 'a new user has no starting point for slots'
}
else {
    Write-Host '  (skipped: shipped template not found)' -ForegroundColor DarkGray
}

Remove-Item $tmpRoot -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ''
Write-Host ("mutcheck-browser-slots: {0} passed, {1} failed" -f $script:Pass, $script:Fail) -ForegroundColor $(if ($script:Fail) { 'Red' } else { 'Green' })
if ($script:Fail -gt 0) { exit 1 }
exit 0
