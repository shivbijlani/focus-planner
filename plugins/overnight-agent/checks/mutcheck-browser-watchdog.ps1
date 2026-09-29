<#
  mutcheck-browser-watchdog.ps1 -- proves browser-watchdog.ps1's exit code is
  never decoupled from its own JSON verdict, and that it never invents a
  status when the underlying check could not run at all (GH #738 rewrite).

  BACKGROUND
    GH #738 removed browser-watchdog.ps1's LAUNCH and REPAIR/THAW phases
    entirely: each Playwright MCP slot now launches its own profile directly
    and there is nothing shared left to launch or thaw on its behalf. What
    remains is a thin, read-only wrapper around check-browser-slots.ps1. The
    two things worth pinning for a thin wrapper like this are exactly the two
    classes of bug that hit its CDP-era predecessor (GH #197 / #347): the exit
    code silently diverging from the printed verdict, and a tool failure being
    reported as a normal (healthy) result instead of "could not assess".

  THE INVARIANTS
    A  the `-Json` exit code is a DETERMINISTIC function of the JSON body's
       `unhealthy` count (0 -> exit 0, >0 -> exit 2) -- never independent of it.
    B  a checker that cannot be found, or that emits no parseable JSON, is
       reported as exit 3 ("could not assess") -- never as a normal 0/2 result.

  THE MUTANTS
    M1  the exit code is hardcoded to 0 regardless of `$unhealthyCount` -- the
        exact #347 shape (verdict computed correctly, then discarded at the
        process boundary).
    M2  a checker that emits unparseable output is treated as "0 slots,
        healthy" instead of "could not assess" (exit 3).

    Each must be CAUGHT. A control run (unmutated script) must ship both a
    healthy and an unhealthy fixture correctly, so "everything looks unhealthy"
    or "everything ships green" cannot masquerade as coverage.

  NEVER TOUCHES LIVE STATE. The checker is always a fixture injected via
  -CheckerPath. No real browser is contacted and the user's slot table is
  never read.

  USAGE
    powershell -NoProfile -ExecutionPolicy Bypass -File mutcheck-browser-watchdog.ps1
#>
[CmdletBinding()]
param(
    [string]$ScriptPath
)

$ErrorActionPreference = 'Stop'

if (-not $ScriptPath) { $ScriptPath = Join-Path $PSScriptRoot 'browser-watchdog.ps1' }
$ScriptPath = [IO.Path]::GetFullPath($ScriptPath)
if (-not (Test-Path $ScriptPath)) { throw "browser-watchdog.ps1 not found at $ScriptPath" }

$psExe = (Get-Command pwsh -ErrorAction SilentlyContinue).Source
if (-not $psExe) { $psExe = (Get-Command powershell -ErrorAction SilentlyContinue).Source }
if (-not $psExe) { throw 'No PowerShell host found.' }

$utf8NoBom = New-Object Text.UTF8Encoding($false)

$script:Pass = 0
$script:Fail = 0
function Assert($name, $cond, $detail) {
    if ($cond) { $script:Pass++; Write-Host ("  ok    {0}" -f $name) -ForegroundColor Green }
    else { $script:Fail++; Write-Host ("  FAIL  {0}  {1}" -f $name, $detail) -ForegroundColor Red }
}

$tmpRoot = Join-Path ([IO.Path]::GetTempPath()) ("mutbw-" + [guid]::NewGuid().ToString('N').Substring(0, 10))
New-Item -ItemType Directory -Force -Path $tmpRoot | Out-Null

function New-FixtureChecker {
    param([string]$Name, [int]$UnhealthyCount, [switch]$EmitGarbage)
    $path = Join-Path $tmpRoot "$Name.ps1"
    if ($EmitGarbage) {
        [IO.File]::WriteAllText($path, "param([switch]`$Json, [string]`$SettingsPath)`nWrite-Output 'not json at all'`nexit 0`n", $utf8NoBom)
        return $path
    }
    $rows = @()
    for ($i = 0; $i -lt 2; $i++) {
        $healthy = ($i -ge $UnhealthyCount)
        $rows += "[pscustomobject]@{ slot='slot-$i'; account='acct-$i'; profile_dir='dir-$i'; state='$( if ($healthy) { 'available' } else { 'error' } )'; healthy=`$$healthy; detail='fixture' }"
    }
    $body = "param([switch]`$Json, [string]`$SettingsPath)`nConvertTo-Json -InputObject @($($rows -join ', ')) -Depth 4`nexit 0`n"
    [IO.File]::WriteAllText($path, $body, $utf8NoBom)
    return $path
}

function Invoke-Watchdog {
    param([string]$Source, [string]$Checker)
    $tmpScript = Join-Path $tmpRoot ("target-" + [guid]::NewGuid().ToString('N').Substring(0, 8) + ".ps1")
    [IO.File]::WriteAllText($tmpScript, $Source, $utf8NoBom)
    $outFile = Join-Path $tmpRoot ("out-" + [guid]::NewGuid().ToString('N').Substring(0, 8) + ".json")
    & $psExe -NoProfile -ExecutionPolicy Bypass -File $tmpScript -Json -Quiet -CheckerPath $Checker *> $outFile
    $code = $LASTEXITCODE
    $text = (Get-Content -LiteralPath $outFile -Raw -ErrorAction SilentlyContinue)
    [pscustomobject]@{ Code = $code; Text = $text }
}

$orig = [IO.File]::ReadAllText($ScriptPath, $utf8NoBom) -replace "`r`n", "`n"

Write-Host "`nmutcheck-browser-watchdog -- exit code matches the verdict, a failed assessment is never a result" -ForegroundColor Cyan
Write-Host "target: $ScriptPath`n" -ForegroundColor DarkGray

# ---------------------------------------------------------------------------
# Baseline / control
# ---------------------------------------------------------------------------
Write-Host 'baseline: healthy and unhealthy fixtures are reported correctly' -ForegroundColor Cyan
$healthyChecker = New-FixtureChecker -Name 'healthy' -UnhealthyCount 0
$unhealthyChecker = New-FixtureChecker -Name 'unhealthy' -UnhealthyCount 1
$missingChecker = Join-Path $tmpRoot 'does-not-exist.ps1'

$rHealthy = Invoke-Watchdog -Source $orig -Checker $healthyChecker
$rUnhealthy = Invoke-Watchdog -Source $orig -Checker $unhealthyChecker
Assert 'baseline: all-healthy fixture exits 0' ($rHealthy.Code -eq 0) "exit=$($rHealthy.Code)"
Assert 'baseline: an unhealthy row makes it exit 2' ($rUnhealthy.Code -eq 2) "exit=$($rUnhealthy.Code)"
Assert 'baseline: a missing checker exits 3, not 0/2' ((Invoke-Watchdog -Source $orig -Checker $missingChecker).Code -eq 3) 'a missing tool must never look like a normal result'

Write-Host "`nC1 (control): a cosmetic message edit ships green" -ForegroundColor Cyan
$c1 = $orig.Replace("assessing browser profile status", "ASSESSING BROWSER PROFILE STATUS")
Assert 'C1 mutation applied' ($c1 -cne $orig) 'the message text did not match -- update this mutcheck'
if ($c1 -cne $orig) {
    $c1r = Invoke-Watchdog -Source $c1 -Checker $healthyChecker
    Assert 'C1 still exits 0 (a cosmetic edit is not a behaviour change)' ($c1r.Code -eq 0) "exit=$($c1r.Code)"
}

# ---------------------------------------------------------------------------
# M1: exit code hardcoded to 0 regardless of the unhealthy count (GH #347 shape).
# ---------------------------------------------------------------------------
Write-Host "`nM1: exit code hardcoded to 0 (the #347 shape)" -ForegroundColor Cyan
$m1 = $orig.Replace(
    'exit $(if ($unhealthyCount -gt 0) { 2 } else { 0 })',
    'exit 0')
Assert 'M1 mutation applied' ($m1 -ne $orig) 'the exit-code line did not match -- update this mutcheck'
if ($m1 -ne $orig) {
    $m1r = Invoke-Watchdog -Source $m1 -Checker $unhealthyChecker
    Assert 'M1 ships an unhealthy result as exit 0' ($m1r.Code -eq 0) "expected the mutant to ship green, got exit=$($m1r.Code)"
    Assert 'M1 is KILLED by the baseline' ($rUnhealthy.Code -eq 2) 'the real script also ignored the unhealthy count'
}

# ---------------------------------------------------------------------------
# M2: unparseable checker output is treated as "0 slots, healthy" (exit 0)
# instead of "could not assess" (exit 3).
# ---------------------------------------------------------------------------
Write-Host "`nM2: unparseable checker output is silently treated as healthy" -ForegroundColor Cyan
$m2 = $orig.Replace(
    'if ($null -eq $rows) {',
    'if ($false) {')
Assert 'M2 mutation applied' ($m2 -ne $orig) 'the null-rows guard did not match -- update this mutcheck'
if ($m2 -ne $orig) {
    $garbageChecker = New-FixtureChecker -Name 'garbage' -EmitGarbage
    $m2r = Invoke-Watchdog -Source $m2 -Checker $garbageChecker
    $baselineGarbage = Invoke-Watchdog -Source $orig -Checker $garbageChecker
    Assert 'M2 ships garbage output as a normal result, not exit 3' ($m2r.Code -ne 3) "expected the mutant to ship non-3, got exit=$($m2r.Code)"
    Assert 'M2 is KILLED by the baseline (garbage -> exit 3)' ($baselineGarbage.Code -eq 3) "baseline exited $($baselineGarbage.Code), expected 3"
}

Remove-Item $tmpRoot -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ''
Write-Host ("mutcheck-browser-watchdog: {0} passed, {1} failed" -f $script:Pass, $script:Fail) -ForegroundColor $(if ($script:Fail) { 'Red' } else { 'Green' })
if ($script:Fail -gt 0) { exit 1 }
exit 0
