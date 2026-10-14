<#
.SYNOPSIS
  Rewrites each Playwright MCP server in mcp-config.json from attach-only
  (`--cdp-endpoint http://localhost:922x`) to launch-its-own-profile
  (`--browser msedge --user-data-dir <profile dir>`). GH #738.

.DESCRIPTION
  DECISION (tested before any code change, session 905cc615, 2026-09-28):
  each browser MCP server should launch its OWN profile directly instead of
  attaching to a debug port someone else had to keep alive. Proven end to end
  with the real MCP CLI (`node cli.js --browser msedge --user-data-dir <dir>`):
  existing sign-ins were retained, a second launch of the SAME profile failed
  with "profile is already in use" (not a crash, not a silent wrong-account
  attach), and every close left zero leftover Edge processes for that profile.

  THIS IS THE ONE PATH. There is deliberately no fallback to `--cdp-endpoint`:
  a server this script cannot confidently rewrite is left untouched and named
  as a warning, never patched halfway or defaulted to attach mode.

  WHAT IT DOES
    1. Reads the `## Browser slots` table (browser-slot-table.ps1) -- the one
       source of truth for slot name -> profile directory -> account.
    2. For every mcpServers entry whose NAME matches a slot in that table AND
       whose args reference `@playwright/mcp` or a `cli.js` for it, replaces
       any `--cdp-endpoint <url>` (and any `--browser`/`--user-data-dir` pair
       already there, so this is idempotent on a second run) with
       `--browser <chrome|edge> --user-data-dir <profile dir>`. The browser is
       chosen by the same "name or profile dir contains 'chrome'" heuristic the
       other slot tools already use -- Edge otherwise.
    3. A server whose name is NOT in the slot table is left completely alone
       (it might not even be a browser server).
    4. A slot in the table with no profile path resolvable is a WARNING, not a
       crash: that server is left untouched and named in the summary.

  SAFETY (same pattern as fix-playwright-npx-slots.ps1): backs up the config,
  writes UTF-8 preserving the source's BOM state, and validates the result with
  a REAL Node `JSON.parse` (not just PowerShell's tolerant ConvertFrom-Json)
  before accepting the change. Any failure rolls back to the backup.

.PARAMETER ConfigPath
  The mcp-config.json to patch. Defaults to the current user's Copilot CLI config.

.PARAMETER SettingsPath
  Override the resolved user-settings.md (for the mutation check's fixtures).

.PARAMETER NodeExe
  Path to node.exe, used only for the strict JSON.parse validation gate.

.PARAMETER WhatIf
  Show what would change without writing anything.
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$ConfigPath = "$env:USERPROFILE\.copilot\mcp-config.json",
    [string]$SettingsPath,
    [string]$NodeExe = "C:\Program Files\nodejs\node.exe",
    [string]$LibPath
)

$ErrorActionPreference = 'Stop'

function Fail($msg) { Write-Host "FAILED: $msg" -ForegroundColor Red; exit 1 }

if (-not (Test-Path -LiteralPath $ConfigPath)) { Fail "config not found: $ConfigPath" }
if (-not (Test-Path -LiteralPath $NodeExe)) { Fail "node.exe not found: $NodeExe (needed for the strict JSON validation gate)" }

# --- locate the ONE slot-table parser --------------------------------------
# -LibPath is an explicit override (used by the mutation check, so a script
# copied into an isolated temp dir never falls through to a stale deployed
# copy at %LOCALAPPDATA%\overnight-agent).
$slotLib = $null
if ($LibPath) {
    if (-not (Test-Path -LiteralPath $LibPath -PathType Leaf)) { Fail "-LibPath does not exist: $LibPath" }
    $slotLib = (Resolve-Path -LiteralPath $LibPath).Path
}
else {
    foreach ($cand in @(
            ([IO.Path]::Combine($PSScriptRoot, 'browser-slot-table.ps1'))
            ([IO.Path]::Combine($PSScriptRoot, '..', 'skills', 'overnight-agent', 'browser-slot-table.ps1'))
            $(if ($env:LOCALAPPDATA) { [IO.Path]::Combine($env:LOCALAPPDATA, 'overnight-agent', 'browser-slot-table.ps1') })
        )) {
        if ($cand -and (Test-Path -LiteralPath $cand -PathType Leaf)) { $slotLib = (Resolve-Path -LiteralPath $cand).Path; break }
    }
}
if (-not $slotLib) { Fail 'browser-slot-table.ps1 not found. Refusing to guess a slot list.' }
. $slotLib

try {
    $slots = @(Get-BrowserSlotTable -SettingsPath $SettingsPath)
}
catch {
    Fail "could not read the browser slot table: $($_.Exception.Message)"
}

function Resolve-SlotBrowser {
    param([object]$Slot)
    if ("$($Slot.Slot) $($Slot.ProfileDir)" -match '(?i)chrome') { return 'chrome' }
    return 'msedge'
}

$raw = Get-Content -LiteralPath $ConfigPath -Raw
$json = $raw | ConvertFrom-Json

$srcBytes = [IO.File]::ReadAllBytes($ConfigPath)
$srcHadBom = ($srcBytes.Length -ge 3 -and $srcBytes[0] -eq 0xEF -and $srcBytes[1] -eq 0xBB -and $srcBytes[2] -eq 0xBF)

$slotByName = @{}
foreach ($s in $slots) { $slotByName[$s.Slot] = $s }

$targets = @()
$skippedNoProfile = @()
foreach ($name in $json.mcpServers.PSObject.Properties.Name) {
    if (-not $slotByName.ContainsKey($name)) { continue }
    $server = $json.mcpServers.$name
    $argsText = ($server.args -join ' ')
    $isPlaywright = ($argsText -match '@playwright/mcp') -or ($argsText -match '(?i)playwright[\\/].*cli\.js')
    if (-not $isPlaywright) { continue }

    $slot = $slotByName[$name]
    if (-not $slot.ProfilePath) { $skippedNoProfile += $name; continue }
    $targets += $name
}

if ($targets.Count -eq 0) {
    Write-Host 'Nothing to do - no Playwright MCP server matches a slot with a profile path.' -ForegroundColor Green
    if ($skippedNoProfile.Count -gt 0) {
        Write-Host "Skipped (slot has no resolvable profile path): $($skippedNoProfile -join ', ')" -ForegroundColor Yellow
    }
    exit 0
}

Write-Host "Slots to switch to profile-launch mode ($($targets.Count)):" -ForegroundColor Cyan
foreach ($t in $targets) {
    $s = $slotByName[$t]
    Write-Host ("  {0,-20} -> --browser {1} --user-data-dir {2}" -f $t, (Resolve-SlotBrowser $s), $s.ProfilePath)
}
if ($skippedNoProfile.Count -gt 0) {
    Write-Host "Skipped (slot has no resolvable profile path): $($skippedNoProfile -join ', ')" -ForegroundColor Yellow
}

if ($PSCmdlet.ShouldProcess($ConfigPath, "switch $($targets.Count) Playwright MCP server(s) to launch-own-profile")) {

    $backup = "$ConfigPath.backup-playwright-profiles-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    Copy-Item $ConfigPath $backup
    Write-Host "`nBackup: $backup" -ForegroundColor DarkGray

    foreach ($t in $targets) {
        $slot = $slotByName[$t]
        $browser = Resolve-SlotBrowser $slot
        $old = @($json.mcpServers.$t.args)
        $kept = New-Object System.Collections.Generic.List[string]
        $skipNext = 0
        foreach ($a in $old) {
            if ($skipNext -gt 0) { $skipNext--; continue }
            # Strip any existing --cdp-endpoint/--browser/--user-data-dir pair
            # (and their values) so re-running this script is idempotent and
            # never leaves a stale, contradicting flag behind.
            if ($a -in @('--cdp-endpoint', '--browser', '--user-data-dir')) { $skipNext = 1; continue }
            [void]$kept.Add($a)
        }
        [void]$kept.Add('--browser'); [void]$kept.Add($browser)
        [void]$kept.Add('--user-data-dir'); [void]$kept.Add($slot.ProfilePath)
        $json.mcpServers.$t.args = @($kept)
    }

    $out = $json | ConvertTo-Json -Depth 20
    [IO.File]::WriteAllText($ConfigPath, $out, (New-Object Text.UTF8Encoding($srcHadBom)))

    # --- validate with the REAL consumer, not with PowerShell -------------------
    # ConvertFrom-Json is TOLERANT (strips a leading BOM and parses happily);
    # Node's JSON.parse -- what the MCP client actually uses -- is STRICT. See
    # fix-playwright-npx-slots.ps1 / GH #212 for the defect this gate closes.
    $probe = @'
try {
  const fs = require('fs');
  JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  console.log('PARSE_OK');
} catch (e) {
  console.log('PARSE_FAIL ' + e.message);
  process.exit(1);
}
'@
    $probeFile = Join-Path ([IO.Path]::GetTempPath()) "mcp-config-parse-$([guid]::NewGuid().ToString('N')).js"
    [IO.File]::WriteAllText($probeFile, $probe, (New-Object Text.UTF8Encoding($false)))
    try {
        $parseOut = & $NodeExe $probeFile $ConfigPath 2>&1
        $parseOk = ($LASTEXITCODE -eq 0) -and (($parseOut -join ' ') -match 'PARSE_OK')
    } finally {
        Remove-Item $probeFile -Force -ErrorAction SilentlyContinue
    }
    if (-not $parseOk) {
        Copy-Item $backup $ConfigPath -Force
        Fail "config is not parseable by Node (the real MCP consumer): $($parseOut -join ' ') - rolled back."
    }

    try { $null = Get-Content $ConfigPath -Raw | ConvertFrom-Json }
    catch { Copy-Item $backup $ConfigPath -Force; Fail 'config became invalid JSON - rolled back.' }

    # No --cdp-endpoint may survive on a switched server -- ONE path, no fallback.
    $reread = Get-Content $ConfigPath -Raw | ConvertFrom-Json
    $stillCdp = @($targets | Where-Object { ($reread.mcpServers.$_.args -join ' ') -match '--cdp-endpoint' })
    if ($stillCdp.Count -gt 0) {
        Copy-Item $backup $ConfigPath -Force
        Fail "server(s) still carry --cdp-endpoint after the switch: $($stillCdp -join ', ') - rolled back."
    }

    Write-Host "`nDone. $($targets.Count) server(s) switched to launch-own-profile." -ForegroundColor Green
    Write-Host 'Takes effect on the next Copilot CLI restart.' -ForegroundColor Yellow
    Write-Host "Roll back any time:  Copy-Item '$backup' '$ConfigPath' -Force" -ForegroundColor DarkGray
}
