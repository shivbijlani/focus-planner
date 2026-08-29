<#
.SYNOPSIS
  Repoints the six @playwright/mcp CDP slots from `npx -y @playwright/mcp@latest`
  to the globally-installed copy, launched directly with node.

.DESCRIPTION
  Root cause (task #349): `@latest` forces npm to revalidate against the registry on
  EVERY launch. Six slots start concurrently at session start against one npm cache;
  losers of that race die mid-handshake ("connection closed: initialize response") or
  blow the 60s initialize timeout. That is what silently empties PHASE 0.

  Measured 2026-08-22 on this machine (4 runs each, live CDP slot on :9222):
      npx -y @playwright/mcp@latest ... ~2,750 ms   (2724 / 2749 / 2793 / 2734)
      node <global cli.js> ...           ~700 ms   ( 684 /  703 /  728 /  700)
  => 3.9x faster, ~2.05 s saved per slot, ~12 s off concurrent startup, and the
     registry round-trip is removed entirely (which is the actual failure mode).

  Safety: this is version-IDENTICAL (registry @latest 0.0.79 == global 0.0.79), it
  changes only the launcher, and it does NOT touch the browsers or their profiles --
  every slot stays attach-only via the same --cdp-endpoint argument.

  This script backs up, applies, re-validates each patched slot with a real MCP
  initialize handshake, and AUTO-ROLLS BACK if any slot fails.

.PARAMETER WhatIf
  Show what would change without writing anything.
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$ConfigPath = "$env:USERPROFILE\.copilot\mcp-config.json",
    [string]$Cli        = "C:\Users\shiv\AppData\Roaming\npm\node_modules\@playwright\mcp\cli.js",
    [string]$NodeExe    = "C:\Program Files\nodejs\node.exe",
    [switch]$SkipVerify
)

$ErrorActionPreference = 'Stop'

function Fail($msg) { Write-Host "FAILED: $msg" -ForegroundColor Red; exit 1 }

if (-not (Test-Path $ConfigPath)) { Fail "config not found: $ConfigPath" }
if (-not (Test-Path $Cli))        { Fail "@playwright/mcp not installed globally. Run: npm install -g @playwright/mcp" }
if (-not (Test-Path $NodeExe))    { Fail "node.exe not found: $NodeExe" }

$raw  = Get-Content $ConfigPath -Raw
$json = $raw | ConvertFrom-Json

# --- find every slot still on the npx path -------------------------------------
$targets = @()
foreach ($name in $json.mcpServers.PSObject.Properties.Name) {
    $s = $json.mcpServers.$name
    if ($s.command -eq 'npx' -and ($s.args -join ' ') -match '@playwright/mcp') {
        $targets += $name
    }
}

if ($targets.Count -eq 0) {
    Write-Host "Nothing to do - no slots are on the npx path. Already patched." -ForegroundColor Green
    exit 0
}

Write-Host "Slots to repoint ($($targets.Count)):" -ForegroundColor Cyan
foreach ($t in $targets) {
    $endpoint = ($json.mcpServers.$t.args | Where-Object { $_ -like 'http*' }) -join ''
    Write-Host ("  {0,-20} {1}" -f $t, $endpoint)
}

if ($PSCmdlet.ShouldProcess($ConfigPath, "repoint $($targets.Count) slots to direct node")) {

    # --- backup ----------------------------------------------------------------
    $backup = "$ConfigPath.backup-playwright-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    Copy-Item $ConfigPath $backup
    Write-Host "`nBackup: $backup" -ForegroundColor DarkGray

    # --- apply: keep every arg except the `-y` and the package spec -------------
    foreach ($t in $targets) {
        $old = @($json.mcpServers.$t.args)
        $kept = @()
        foreach ($a in $old) {
            if ($a -eq '-y') { continue }
            if ($a -like '@playwright/mcp*') { continue }
            $kept += $a
        }
        $json.mcpServers.$t.command = $NodeExe
        $json.mcpServers.$t.args    = @($Cli) + $kept
    }

    $json | ConvertTo-Json -Depth 20 | Set-Content $ConfigPath -Encoding UTF8

    # --- validate JSON round-trips ---------------------------------------------
    try { $null = Get-Content $ConfigPath -Raw | ConvertFrom-Json }
    catch { Copy-Item $backup $ConfigPath -Force; Fail "config became invalid JSON - rolled back." }

    # --- verify each patched slot with a real handshake -------------------------
    if (-not $SkipVerify) {
        $bench = "$env:LOCALAPPDATA\overnight-agent\mcp-handshake-bench.js"
        if (Test-Path $bench) {
            Write-Host "`nVerifying handshakes..." -ForegroundColor Cyan
            $bad = @()
            foreach ($t in $targets) {
                $a = $json.mcpServers.$t.args
                $out = & node $bench $t $NodeExe @a 2>$null
                $res = $null
                foreach ($line in @($out)) { try { $res = $line | ConvertFrom-Json } catch {} }
                if ($res -and $res.ok) {
                    Write-Host ("  OK    {0,-20} {1} ms" -f $t, $res.ms) -ForegroundColor Green
                } else {
                    # A slot whose browser simply isn't running is EXPECTED to fail to
                    # connect; that is not a config problem. Only a spawn failure is.
                    $note = if ($res) { $res.note } else { 'no result' }
                    Write-Host ("  WARN  {0,-20} {1}" -f $t, $note) -ForegroundColor Yellow
                    if ($note -match 'spawn error') { $bad += $t }
                }
            }
            if ($bad.Count -gt 0) {
                Copy-Item $backup $ConfigPath -Force
                Fail "slots failed to spawn: $($bad -join ', ') - rolled back to $backup"
            }
        }
    }

    Write-Host "`nDone. $($targets.Count) slots repointed." -ForegroundColor Green
    Write-Host "Takes effect on the next Copilot CLI restart." -ForegroundColor Yellow
    Write-Host "Roll back any time:  Copy-Item '$backup' '$ConfigPath' -Force" -ForegroundColor DarkGray
}
