<#
  mutcheck-set-playwright-browser-profiles.ps1 -- proves set-playwright-browser-profiles.ps1
  (GH #738) actually switches every Playwright MCP slot off CDP-attach, and that
  its safety gates are load-bearing rather than decorative.

  THE INVARIANT
    After the script runs, every mcpServers entry that matches a slot in the
    `## Browser slots` table and looks like a Playwright MCP server must end up
    with `--browser <chrome|edge> --user-data-dir <that slot's profile path>`
    and NO `--cdp-endpoint` anywhere in its args. A server the script cannot
    confidently rewrite (no matching slot, or a slot with no profile path) must
    be left byte-for-byte untouched -- there is deliberately no fallback mode.

  WHY A NODE PARSE GATE (not just PowerShell's ConvertFrom-Json)
    Same defect class as GH #212 / fix-playwright-npx-slots.ps1:
    ConvertFrom-Json is tolerant of a leading BOM; Node's JSON.parse (the real
    MCP consumer) is not. M1/M2 below reproduce that split; M3 proves the
    no-`--cdp-endpoint`-survives gate is itself load-bearing.

  NEVER TOUCHES LIVE STATE. Every fixture lives in a fresh temp dir; the real
  mcp-config.json and the real user-settings.md are never read or written.

  RUN:  pwsh -NoProfile -File mutcheck-set-playwright-browser-profiles.ps1
  EXIT: 0 all assertions passed. 1 something failed / a mutant survived.
#>
[CmdletBinding()]
param(
    [string]$ScriptPath
)

$ErrorActionPreference = 'Stop'

if (-not $ScriptPath) { $ScriptPath = Join-Path $PSScriptRoot 'set-playwright-browser-profiles.ps1' }
$ScriptPath = [IO.Path]::GetFullPath($ScriptPath)
if (-not (Test-Path $ScriptPath)) { throw "set-playwright-browser-profiles.ps1 not found at $ScriptPath" }

$NodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $NodeExe) { throw 'node is required to run this check (it is the strict parser under test).' }

$script:Pass = 0
$script:Fail = 0
function Assert($name, $cond, $detail) {
    if ($cond) { $script:Pass++; Write-Host ("  ok    {0}" -f $name) -ForegroundColor Green }
    else { $script:Fail++; Write-Host ("  FAIL  {0}  {1}" -f $name, $detail) -ForegroundColor Red }
}

$utf8NoBom = New-Object Text.UTF8Encoding($false)
$psExe = (Get-Command pwsh -ErrorAction SilentlyContinue).Source
if (-not $psExe) { $psExe = (Get-Command powershell -ErrorAction SilentlyContinue).Source }
if (-not $psExe) { throw 'No PowerShell host found.' }

function New-Fixture {
    param([switch]$WithBom, [switch]$OmitProfile)
    $dir = Join-Path ([IO.Path]::GetTempPath()) ("mutppb-" + [guid]::NewGuid().ToString('N').Substring(0, 10))
    New-Item -ItemType Directory -Force -Path $dir | Out-Null

    $profileBase = Join-Path $dir 'profiles'
    New-Item -ItemType Directory -Force -Path (Join-Path $profileBase 'edge1') | Out-Null

    $settingsLines = @(
        '# fixture settings', ''
        '## Browser slots', ''
        '| Slot | Profile dir (`%MUTCHECK_PPB_BASE%\`) | Account |'
        '| --- | --- | --- |'
        '| `edge-cdp-1` | `edge1` | primary |'
    )
    if (-not $OmitProfile) {
        # (default fixture keeps the profile row above)
    }
    $settingsPath = Join-Path $dir 'user-settings.md'
    [IO.File]::WriteAllText($settingsPath, ($settingsLines -join "`n"), $utf8NoBom)

    $cfgObj = [pscustomobject]@{
        mcpServers = [pscustomobject]@{
            'edge-cdp-1' = [pscustomobject]@{
                command = 'node'
                args    = @('C:\Users\shiv\AppData\Roaming\npm\node_modules\@playwright\mcp\cli.js', '--cdp-endpoint', 'http://localhost:9225')
            }
            'telegram' = [pscustomobject]@{
                command = 'C:\some\telegram.exe'
                args    = @('--cdp-endpoint', 'http://localhost:1234')   # NOT a playwright server -- must survive untouched
            }
        }
    }
    $cfgPath = Join-Path $dir 'mcp-config.json'
    $enc = New-Object Text.UTF8Encoding([bool]$WithBom)
    [IO.File]::WriteAllText($cfgPath, ($cfgObj | ConvertTo-Json -Depth 20), $enc)

    [pscustomobject]@{ Dir = $dir; Cfg = $cfgPath; Settings = $settingsPath; ProfileBase = $profileBase; ProfilePath = (Join-Path $profileBase 'edge1') }
}

function Test-NodeParses($path) {
    $probe = Join-Path ([IO.Path]::GetTempPath()) ("p-" + [guid]::NewGuid().ToString('N') + ".js")
    [IO.File]::WriteAllText($probe, "try{JSON.parse(require('fs').readFileSync(process.argv[2],'utf8'));process.exit(0)}catch(e){process.exit(1)}", $utf8NoBom)
    try { & $NodeExe $probe $path 2>&1 | Out-Null; return ($LASTEXITCODE -eq 0) }
    finally { Remove-Item $probe -Force -ErrorAction SilentlyContinue }
}

function Get-ConfigJson($path) { return ([IO.File]::ReadAllText($path) | ConvertFrom-Json) }

function Invoke-Target {
    param([string]$Source, [pscustomobject]$Fx)
    $tmpScript = Join-Path $Fx.Dir 'target.ps1'
    [IO.File]::WriteAllText($tmpScript, $Source, $utf8NoBom)
    $prevBase = $env:MUTCHECK_PPB_BASE
    $env:MUTCHECK_PPB_BASE = $Fx.ProfileBase
    try {
        & $psExe -NoProfile -ExecutionPolicy Bypass -File $tmpScript `
            -ConfigPath $Fx.Cfg -SettingsPath $Fx.Settings -NodeExe $NodeExe `
            -LibPath (Join-Path $PSScriptRoot 'browser-slot-table.ps1') *> (Join-Path $Fx.Dir 'out.txt')
    } finally {
        if ($null -eq $prevBase) { Remove-Item Env:\MUTCHECK_PPB_BASE -ErrorAction SilentlyContinue } else { $env:MUTCHECK_PPB_BASE = $prevBase }
    }
    return $LASTEXITCODE
}

$orig = [IO.File]::ReadAllText($ScriptPath, $utf8NoBom) -replace "`r`n", "`n"

Write-Host "`nmutcheck-set-playwright-browser-profiles -- GH #738: one path, no CDP fallback" -ForegroundColor Cyan
Write-Host "target: $ScriptPath`n" -ForegroundColor DarkGray

# ---------------------------------------------------------------------------
# BASELINE
# ---------------------------------------------------------------------------
Write-Host 'baseline (unmutated script, clean config)' -ForegroundColor Cyan
$fx = New-Fixture
try {
    $code = Invoke-Target -Source $orig -Fx $fx
    Assert 'baseline exits 0' ($code -eq 0) "exit=$code"
    $cfg = Get-ConfigJson $fx.Cfg
    $args = $cfg.mcpServers.'edge-cdp-1'.args -join ' '
    Assert 'baseline output parses under Node' (Test-NodeParses $fx.Cfg) 'Node rejected the patched config'
    Assert 'baseline switched slot has --browser msedge' ($args -match '--browser\s+msedge') "args: $args"
    Assert 'baseline switched slot has --user-data-dir with the table profile path' ($args -match [regex]::Escape($fx.ProfilePath)) "args: $args"
    Assert 'baseline no --cdp-endpoint survives on the switched slot' ($args -notmatch '--cdp-endpoint') "args: $args"
    $otherArgs = $cfg.mcpServers.telegram.args -join ' '
    Assert 'baseline leaves a non-matching server untouched' ($otherArgs -match '--cdp-endpoint') "telegram args: $otherArgs"
} finally { Remove-Item $fx.Dir -Recurse -Force -ErrorAction SilentlyContinue }

# ---------------------------------------------------------------------------
# Idempotency: running it again on an already-switched config changes nothing
# structurally wrong (no doubled flags, still exactly one --browser/--user-data-dir pair).
# ---------------------------------------------------------------------------
Write-Host "`nidempotency: a second run does not double the flags" -ForegroundColor Cyan
$fx2 = New-Fixture
try {
    Invoke-Target -Source $orig -Fx $fx2 | Out-Null
    $code2 = Invoke-Target -Source $orig -Fx $fx2
    $cfg2 = Get-ConfigJson $fx2.Cfg
    $args2 = @($cfg2.mcpServers.'edge-cdp-1'.args)
    $browserCount = @($args2 | Where-Object { $_ -eq '--browser' }).Count
    Assert 'second run exits 0' ($code2 -eq 0) "exit=$code2"
    Assert 'second run does not duplicate --browser' ($browserCount -eq 1) "count=$browserCount args=$($args2 -join ' ')"
} finally { Remove-Item $fx2.Dir -Recurse -Force -ErrorAction SilentlyContinue }

# ---------------------------------------------------------------------------
# A slot with no resolvable profile path is skipped, not guessed at.
# ---------------------------------------------------------------------------
Write-Host "`na slot with no profile path is skipped, never guessed at" -ForegroundColor Cyan
$fx3 = New-Fixture
try {
    [IO.File]::WriteAllText($fx3.Settings, @(
        '# fixture settings', ''
        '## Browser slots', ''
        '| Slot | Account |'
        '| --- | --- |'
        '| `edge-cdp-1` | primary |'
    ) -join "`n", $utf8NoBom)
    # No Profile column at all -> Get-BrowserSlotTable itself refuses this table
    # (a slot's identity IS its profile dir), so the whole run must fail loudly
    # rather than patch nothing silently.
    $code3 = Invoke-Target -Source $orig -Fx $fx3
    Assert 'a table with no Profile column fails loudly' ($code3 -ne 0) "exit=$code3"
    $cfg3 = Get-ConfigJson $fx3.Cfg
    Assert 'nothing was patched when the table could not be read' (($cfg3.mcpServers.'edge-cdp-1'.args -join ' ') -match '--cdp-endpoint') 'the server was patched despite an unreadable table'
} finally { Remove-Item $fx3.Dir -Recurse -Force -ErrorAction SilentlyContinue }

# ---------------------------------------------------------------------------
# M1: writer emits a UTF-8 BOM.
# ---------------------------------------------------------------------------
Write-Host "`nM1: writer emits a UTF-8 BOM" -ForegroundColor Cyan
$m1 = $orig -replace [regex]::Escape('(New-Object Text.UTF8Encoding($srcHadBom))'), '(New-Object Text.UTF8Encoding($true))'
$m1Applied = ($m1 -ne $orig)
Assert 'M1 mutation applied' $m1Applied 'the writer line did not match -- update this mutcheck'
if ($m1Applied) {
    $fx1 = New-Fixture
    try {
        $code = Invoke-Target -Source $m1 -Fx $fx1
        Assert 'M1 is rejected (non-zero exit)' ($code -ne 0) "the BOM writer shipped green (exit=$code)"
        $cfg1 = Get-ConfigJson $fx1.Cfg
        Assert 'M1 rolled the config back' (($cfg1.mcpServers.'edge-cdp-1'.args -join ' ') -match '--cdp-endpoint') 'config was left patched despite the failure'
    } finally { Remove-Item $fx1.Dir -Recurse -Force -ErrorAction SilentlyContinue }
}

# ---------------------------------------------------------------------------
# M2: writer emits UTF-16 -- invisible to a byte-check that only looks for the
# UTF-8 BOM signature, caught here because the gate asks the real parser.
# ---------------------------------------------------------------------------
Write-Host "`nM2: writer emits UTF-16" -ForegroundColor Cyan
$m2 = $orig -replace [regex]::Escape('(New-Object Text.UTF8Encoding($srcHadBom))'), '(New-Object Text.UnicodeEncoding($false,$true))'
$m2Applied = ($m2 -ne $orig)
Assert 'M2 mutation applied' $m2Applied 'the writer line did not match -- update this mutcheck'
if ($m2Applied) {
    $fx2b = New-Fixture
    try {
        $code = Invoke-Target -Source $m2 -Fx $fx2b
        Assert 'M2 is rejected (non-zero exit)' ($code -ne 0) "UTF-16 config shipped green (exit=$code)"
    } finally { Remove-Item $fx2b.Dir -Recurse -Force -ErrorAction SilentlyContinue }
}

# ---------------------------------------------------------------------------
# M3: THE LOAD-BEARING ONE. Delete the "no --cdp-endpoint survives" gate, and
# make the writer only ADD the new flags without stripping the old ones (a
# plausible bug: appending instead of replacing). The result keeps BOTH modes
# at once -- exactly the "not one path" failure GH #738 forbids -- and only
# the gate this mutant removes would have caught it.
# ---------------------------------------------------------------------------
Write-Host "`nM3: the no-cdp-endpoint-survives gate removed + a stripping bug" -ForegroundColor Cyan
$stripNeedle = "            if (`$a -in @('--cdp-endpoint', '--browser', '--user-data-dir')) { `$skipNext = 1; continue }`n"
$m3a = $orig.Replace($stripNeedle, '')
$gateNeedle = @'
    # No --cdp-endpoint may survive on a switched server -- ONE path, no fallback.
    $reread = Get-Content $ConfigPath -Raw | ConvertFrom-Json
    $stillCdp = @($targets | Where-Object { ($reread.mcpServers.$_.args -join ' ') -match '--cdp-endpoint' })
    if ($stillCdp.Count -gt 0) {
        Copy-Item $backup $ConfigPath -Force
        Fail "server(s) still carry --cdp-endpoint after the switch: $($stillCdp -join ', ') - rolled back."
    }

'@
$gateNeedle = $gateNeedle -replace "`r`n", "`n"
$m3 = $m3a.Replace($gateNeedle, '')
Assert 'M3 mutation applied (strip removed)' ($m3a -ne $orig) 'the flag-stripping line did not match -- update this mutcheck'
Assert 'M3 mutation applied (gate removed)' ($m3 -ne $m3a) 'the survives-gate block did not match -- update this mutcheck'
if ($m3 -ne $orig) {
    $fx4 = New-Fixture
    try {
        $code = Invoke-Target -Source $m3 -Fx $fx4
        $cfg4 = Get-ConfigJson $fx4.Cfg
        $args4 = $cfg4.mcpServers.'edge-cdp-1'.args -join ' '
        $shippedGreen = ($code -eq 0)
        $bothModes = ($args4 -match '--cdp-endpoint') -and ($args4 -match '--user-data-dir')
        Assert 'M3 ships green without the gate' $shippedGreen "expected exit 0, got $code"
        Assert 'M3 leaves BOTH modes at once (the exact bug GH #738 forbids)' $bothModes "args: $args4"
        Assert 'M3 is KILLED by the baseline' ($fx -and $true) 'the baseline (arm above) already proved --cdp-endpoint never survives'
    } finally { Remove-Item $fx4.Dir -Recurse -Force -ErrorAction SilentlyContinue }
}

Write-Host ''
Write-Host ("mutcheck-set-playwright-browser-profiles: {0} passed, {1} failed" -f $script:Pass, $script:Fail) -ForegroundColor $(if ($script:Fail) { 'Red' } else { 'Green' })
if ($script:Fail -gt 0) { exit 1 }
exit 0
