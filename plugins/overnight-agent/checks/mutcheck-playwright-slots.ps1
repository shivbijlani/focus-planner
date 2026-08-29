<#
  mutcheck-playwright-slots.ps1 -- proves the Node-parse gate in
  fix-playwright-npx-slots.ps1 is load-bearing.

  THE INVARIANT
    After the script patches mcp-config.json, the file must be parseable by the REAL
    consumer -- Node's JSON.parse -- and not merely by PowerShell's ConvertFrom-Json.
    If the write ever produces bytes Node rejects, the script must ROLL BACK and fail.

  WHY THAT IS THE RIGHT INVARIANT
    ConvertFrom-Json is TOLERANT: it strips a leading UTF-8 BOM during decoding and
    parses happily. Node's JSON.parse is STRICT: it throws on the same bytes. That
    split is the entire defect in GH #212 -- `Set-Content -Encoding UTF8` prepended a
    BOM under Windows PowerShell 5.1, every validation the script performed was written
    in PowerShell, and so the script reported complete success on a config the MCP
    client could not load. The failure surfaced hours later, on an unattended run, as
    "every MCP server failed to start" -- including `email`, which is what PHASE 0
    reads instructions from.

  WHY A NODE PARSE RATHER THAN A BOM BYTE-CHECK
    The first fix for #212 checked the three UTF-8 BOM bytes by hand. That is a
    hardcoded signature for ONE known corruption. It still passes on a UTF-16 BOM, on
    trailing garbage, and on any other byte damage a later edit introduces -- and it
    encodes the assumption that the only thing that can ever go wrong is the thing that
    already went wrong. Asking the actual parser asserts the capability at the far end
    instead of pattern-matching the artefact, which is the general form of the fix.

    M3 below exists specifically to prove that distinction is real and not stylistic:
    it feeds a corruption the byte-check cannot see and the Node gate catches.

  THE MUTANTS
    M1  writer emits a UTF-8 BOM (reproduces the original #212 defect).
    M2  writer emits UTF-16    (a corruption the old BOM byte-check would MISS).
    M3  the Node gate is deleted, with the M1 writer still in place.

    M1 and M2 must FAIL-AND-ROLL-BACK. M3 must SHIP GREEN -- that is what proves the
    gate, and not something else in the script, is doing the work. A mutant that dies
    for an unrelated reason proves nothing, so M3 is the load-bearing assertion.

  NEVER TOUCHES LIVE STATE
    Every fixture lives in a fresh temp dir. The real mcp-config.json is never read or
    written; -ConfigPath is a real parameter of the script under test.

  USAGE
    powershell -NoProfile -ExecutionPolicy Bypass -File mutcheck-playwright-slots.ps1
#>
[CmdletBinding()]
param(
  [string]$ScriptPath
)

$ErrorActionPreference = 'Stop'

if (-not $ScriptPath) {
  $ScriptPath = Join-Path $PSScriptRoot 'fix-playwright-npx-slots.ps1'
}
$ScriptPath = [IO.Path]::GetFullPath($ScriptPath)
if (-not (Test-Path $ScriptPath)) { throw "fix-playwright-npx-slots.ps1 not found at $ScriptPath" }

$NodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $NodeExe) { throw 'node is required to run this check (it is the strict parser under test).' }

$script:Pass = 0
$script:Fail = 0
function Assert($name, $cond, $detail) {
  if ($cond) { $script:Pass++; Write-Host ("  ok    {0}" -f $name) -ForegroundColor Green }
  else       { $script:Fail++; Write-Host ("  FAIL  {0}  {1}" -f $name, $detail) -ForegroundColor Red }
}

$utf8NoBom = New-Object Text.UTF8Encoding($false)

# ---------------------------------------------------------------------------
# A fixture tree: a config with one npx playwright slot, plus a stand-in cli.js.
# ---------------------------------------------------------------------------
function New-Fixture {
  param([switch]$WithBom)
  $dir = Join-Path ([IO.Path]::GetTempPath()) ("mutpw-" + [guid]::NewGuid().ToString('N').Substring(0,10))
  New-Item -ItemType Directory -Force -Path $dir | Out-Null

  $cli = Join-Path $dir 'cli.js'
  [IO.File]::WriteAllText($cli, "// stand-in for @playwright/mcp cli.js`n", $utf8NoBom)

  $cfgObj = [pscustomobject]@{
    mcpServers = [pscustomobject]@{
      'edge-cdp-1' = [pscustomobject]@{
        command = 'npx'
        args    = @('-y', '@playwright/mcp@latest', '--cdp-endpoint', 'http://localhost:9225')
      }
      'telegram' = [pscustomobject]@{
        command = 'C:\some\telegram.exe'
        args    = @()
      }
    }
  }
  $cfgPath = Join-Path $dir 'mcp-config.json'
  $enc = New-Object Text.UTF8Encoding([bool]$WithBom)
  [IO.File]::WriteAllText($cfgPath, ($cfgObj | ConvertTo-Json -Depth 20), $enc)

  [pscustomobject]@{ Dir = $dir; Cfg = $cfgPath; Cli = $cli }
}

function Test-NodeParses($path) {
  $probe = Join-Path ([IO.Path]::GetTempPath()) ("p-" + [guid]::NewGuid().ToString('N') + ".js")
  [IO.File]::WriteAllText($probe, "try{JSON.parse(require('fs').readFileSync(process.argv[2],'utf8'));process.exit(0)}catch(e){process.exit(1)}", $utf8NoBom)
  try { & $NodeExe $probe $path 2>&1 | Out-Null; return ($LASTEXITCODE -eq 0) }
  finally { Remove-Item $probe -Force -ErrorAction SilentlyContinue }
}

function Test-HasBom($path) {
  $b = [IO.File]::ReadAllBytes($path)
  return ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF)
}

function Test-StillOnNpx($path) {
  # Read tolerantly on purpose: we want to inspect content even when the bytes are
  # corrupt, which is exactly the state a failed mutant leaves behind.
  $txt = [IO.File]::ReadAllText($path)
  return ($txt -match '"npx"')
}

# Run the script (or a mutant source) against a fixture. Returns exit code.
function Invoke-Target {
  param([string]$Source, [pscustomobject]$Fx)
  $tmpScript = Join-Path $Fx.Dir 'target.ps1'
  [IO.File]::WriteAllText($tmpScript, $Source, $utf8NoBom)
  $psExe = (Get-Command powershell -ErrorAction SilentlyContinue).Source
  if (-not $psExe) { $psExe = (Get-Command pwsh).Source }
  & $psExe -NoProfile -ExecutionPolicy Bypass -File $tmpScript `
      -ConfigPath $Fx.Cfg -Cli $Fx.Cli -NodeExe $NodeExe -SkipVerify *> (Join-Path $Fx.Dir 'out.txt')
  return $LASTEXITCODE
}

$orig = [IO.File]::ReadAllText($ScriptPath, $utf8NoBom)

Write-Host "`nmutcheck-playwright-slots -- Node-parse gate" -ForegroundColor Cyan
Write-Host "target: $ScriptPath`n" -ForegroundColor DarkGray

# ---------------------------------------------------------------------------
# BASELINE: the real script on a clean fixture must succeed and leave Node-parseable
# bytes with the npx slot repointed.
# ---------------------------------------------------------------------------
Write-Host "baseline (unmutated script, clean config)" -ForegroundColor Cyan
$fx = New-Fixture
try {
  $code = Invoke-Target -Source $orig -Fx $fx
  Assert 'baseline exits 0'                   ($code -eq 0)                      "exit=$code"
  Assert 'baseline output parses under Node'  (Test-NodeParses $fx.Cfg)          'Node rejected the patched config'
  Assert 'baseline output has no BOM'         (-not (Test-HasBom $fx.Cfg))       'a BOM was introduced'
  Assert 'baseline repointed the npx slot'    (-not (Test-StillOnNpx $fx.Cfg))   'slot still on npx'
} finally { Remove-Item $fx.Dir -Recurse -Force -ErrorAction SilentlyContinue }

# ---------------------------------------------------------------------------
# Criterion 4: a source file that HAD a BOM keeps it (we preserve, not assume).
# ---------------------------------------------------------------------------
Write-Host "`nbyte-prefix preservation (source had a BOM)" -ForegroundColor Cyan
$fxb = New-Fixture -WithBom
try {
  $code = Invoke-Target -Source $orig -Fx $fxb
  Assert 'BOM-source run does not crash'   ($code -eq 0 -or $code -eq 1)  "exit=$code"
  Assert 'BOM-source keeps its BOM'        (Test-HasBom $fxb.Cfg)         'the BOM was stripped; the script assumed instead of preserving'
} finally { Remove-Item $fxb.Dir -Recurse -Force -ErrorAction SilentlyContinue }

# ---------------------------------------------------------------------------
# M1: writer emits a UTF-8 BOM -- the original #212 defect.
# ---------------------------------------------------------------------------
Write-Host "`nM1: writer emits a UTF-8 BOM (the original defect)" -ForegroundColor Cyan
$m1 = $orig -replace [regex]::Escape('(New-Object Text.UTF8Encoding($srcHadBom))'), '(New-Object Text.UTF8Encoding($true))'
$m1Applied = ($m1 -ne $orig)
Assert 'M1 mutation applied' $m1Applied 'the writer line did not match -- update this mutcheck'
if ($m1Applied) {
  $fx1 = New-Fixture
  try {
    $code = Invoke-Target -Source $m1 -Fx $fx1
    Assert 'M1 is rejected (non-zero exit)'      ($code -ne 0)                  "the BOM writer shipped green (exit=$code)"
    Assert 'M1 rolled the config back'           (Test-StillOnNpx $fx1.Cfg)     'config was left patched despite the failure'
    Assert 'M1 left Node-parseable bytes'        (Test-NodeParses $fx1.Cfg)     'rollback did not restore a parseable file'
  } finally { Remove-Item $fx1.Dir -Recurse -Force -ErrorAction SilentlyContinue }
}

# ---------------------------------------------------------------------------
# M2: writer emits UTF-16. The OLD byte-check looked only for EF BB BF, so it would
# have shipped this green. The Node gate must catch it.
# ---------------------------------------------------------------------------
Write-Host "`nM2: writer emits UTF-16 (invisible to a UTF-8-BOM byte-check)" -ForegroundColor Cyan
$m2 = $orig -replace [regex]::Escape('(New-Object Text.UTF8Encoding($srcHadBom))'), '(New-Object Text.UnicodeEncoding($false,$true))'
$m2Applied = ($m2 -ne $orig)
Assert 'M2 mutation applied' $m2Applied 'the writer line did not match -- update this mutcheck'
if ($m2Applied) {
  $fx2 = New-Fixture
  try {
    $code = Invoke-Target -Source $m2 -Fx $fx2
    Assert 'M2 is rejected (non-zero exit)'  ($code -ne 0)               "UTF-16 config shipped green (exit=$code)"
    Assert 'M2 rolled the config back'       (Test-StillOnNpx $fx2.Cfg)  'config left corrupt after failure'
  } finally { Remove-Item $fx2.Dir -Recurse -Force -ErrorAction SilentlyContinue }
}

# ---------------------------------------------------------------------------
# M3: THE LOAD-BEARING ONE. Delete the Node gate, keep the M1 BOM writer.
# If the run still ships green, the gate was the only thing catching it.
# ---------------------------------------------------------------------------
Write-Host "`nM3: Node gate removed + BOM writer (proves the gate is load-bearing)" -ForegroundColor Cyan
$m3 = $m1 -replace '(?s)\r?\n\s*if \(-not \$parseOk\) \{.*?\r?\n\s*\}', "`n"
$m3Applied = ($m3 -ne $m1)
Assert 'M3 mutation applied' $m3Applied 'the gate block did not match -- update this mutcheck'
if ($m3Applied) {
  $fx3 = New-Fixture
  try {
    $code = Invoke-Target -Source $m3 -Fx $fx3
    $shippedGreen = ($code -eq 0)
    $bomPresent   = Test-HasBom $fx3.Cfg
    Assert 'M3 ships green without the gate'      $shippedGreen  "expected exit 0, got $code -- something ELSE is failing, so M1 does not prove the gate"
    Assert 'M3 leaves a BOM-corrupted config'     $bomPresent    'no BOM produced, so M1/M3 are not exercising the defect'
    Assert 'M3 config is REJECTED by Node'        (-not (Test-NodeParses $fx3.Cfg)) 'Node accepted it, so the corruption is not real'
  } finally { Remove-Item $fx3.Dir -Recurse -Force -ErrorAction SilentlyContinue }
}

Write-Host ""
Write-Host ("mutcheck-playwright-slots: {0} passed, {1} failed" -f $script:Pass, $script:Fail) -ForegroundColor $(if ($script:Fail) { 'Red' } else { 'Green' })
if ($script:Fail -gt 0) { exit 1 }
exit 0
