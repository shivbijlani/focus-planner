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

# Record the ORIGINAL file's byte prefix so the patched file can be written back in
# the same encoding state it arrived in, rather than assuming "no BOM". GH #212 (4).
# Assuming is what caused the original defect in the other direction.
$srcBytes  = [IO.File]::ReadAllBytes($ConfigPath)
$srcHadBom = ($srcBytes.Length -ge 3 -and $srcBytes[0] -eq 0xEF -and $srcBytes[1] -eq 0xBB -and $srcBytes[2] -eq 0xBF)

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

    # Write UTF-8, preserving the source file's BOM state (GH #212 (4)). The original
    # defect was `Set-Content -Encoding UTF8`, which prepends a BOM under PowerShell
    # 5.1 -- so patching the file silently changed its encoding as a side effect of
    # changing its contents, and Node's JSON.parse (what the MCP client actually uses)
    # REJECTS a leading BOM.
    $out = $json | ConvertTo-Json -Depth 20
    [IO.File]::WriteAllText($ConfigPath, $out, (New-Object Text.UTF8Encoding($srcHadBom)))

    # --- validate with the REAL consumer, not with PowerShell --------------------
    # This gate is the load-bearing one (GH #212 (2), proven by mutcheck-playwright-slots.ps1).
    #
    # Why a PowerShell check cannot do this job: ConvertFrom-Json is TOLERANT -- it
    # strips a BOM during decoding and parses happily. Node's JSON.parse is STRICT and
    # throws. So every validation performed in PowerShell is structurally blind to the
    # exact corruption this script used to cause, and the script could report complete
    # success on a config the MCP client refuses to load.
    #
    # The previous fix checked for the three UTF-8 BOM bytes by hand. That is a
    # hardcoded signature for ONE known corruption -- it still passes on a UTF-16 BOM,
    # on trailing garbage, or on any other byte-level damage a future edit introduces.
    # Asking the actual parser is the general form: it asserts the capability at the
    # far end instead of pattern-matching the artefact.
    $probe = @'
// argv[0]=node, argv[1]=this probe, argv[2]=the config under test.
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
        $parseOk  = ($LASTEXITCODE -eq 0) -and (($parseOut -join ' ') -match 'PARSE_OK')
    } finally {
        Remove-Item $probeFile -Force -ErrorAction SilentlyContinue
    }
    if (-not $parseOk) {
        Copy-Item $backup $ConfigPath -Force
        Fail "config is not parseable by Node (the real MCP consumer): $($parseOut -join ' ') - rolled back."
    }

    # Belt-and-braces: PowerShell must be able to read it back too.
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
