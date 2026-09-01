<#
  mutcheck-browser-watchdog.ps1 -- proves the recovery guards in
  browser-watchdog.ps1 are load-bearing (GH #197).

  THE INVARIANTS
    1. A slot that accepts TCP and answers HTTP but cannot complete CDP work is
       classified `stuck` and recovered -- never `already-up`.
    2. The verdict comes from the CDP WORK probe. A TCP-accept test must not be
       able to produce a healthy verdict.
    3. Recovery never fires on a SINGLE failed probe. A slot that fails once and
       passes the confirmation probe is left completely alone.
    4. Recovery never fires on a slot another run is actively driving.
    5. The process-restart rung refuses unless the browser process is positively
       matched to THIS slot's profile dir -- because killing the wrong signed-in
       window costs a manual re-login (App-Bound Encryption).
    6. A stuck slot that was not recovered drives a non-zero exit, so it becomes
       a question rather than a silent retry.

  WHY THESE AND NOT OTHERS
    Every one of them is a way to write this fix so it LOOKS implemented and is
    not. M2 in particular reproduces the exact shipped bug: measured 2026-09-01,
    the deployed watchdog reported the wedged fixture as `already-up`, byte
    identical to the healthy one, while `check-browser-slots.ps1` correctly said
    `stuck`. A "fix" that keeps a TCP fast path anywhere in the verdict would
    reintroduce that, and M2 is what makes it impossible to do quietly.

  THE MUTANTS -- all must FAIL (i.e. the guard must stop mattering)
    M1  the health verdict is forced healthy           -> wedged reported already-up
    M2  the verdict comes from a TCP-accept test       -> wedged reported already-up
    M3  the confirmation probe is removed              -> a one-off blip is "recovered"
    M4  the in-use veto always returns false           -> a slot in use is recovered
    M5  the restart-safety guard always returns ok     -> would kill an unidentified process
    M6  a stuck slot exits 0                           -> failure becomes invisible

    C1 is the CONTROL: a cosmetic edit to a message string. It must SHIP GREEN.
    Without it, "every mutation breaks the check" would be indistinguishable from
    "the check is load-bearing", and the suite would prove nothing.

  NEVER TOUCHES LIVE STATE
    Every arm runs against Node fixture CDP servers on ephemeral ports, with
    -WhatIf and a temp state file. No browser is ever launched or killed, and
    the user's real slots are never contacted. -WhatIf is a real parameter of the
    script under test and it evaluates the SAME safety guards as the live path,
    so the decision being asserted is the decision that would be taken.

  USAGE
    powershell -NoProfile -ExecutionPolicy Bypass -File mutcheck-browser-watchdog.ps1
#>
[CmdletBinding()]
param(
    [string]$ScriptPath,
    [switch]$KeepTemp
)

$ErrorActionPreference = 'Stop'

if (-not $ScriptPath) { $ScriptPath = Join-Path $PSScriptRoot 'browser-watchdog.ps1' }
if (-not (Test-Path $ScriptPath)) { throw "browser-watchdog.ps1 not found at $ScriptPath" }

$Fixture = Join-Path $PSScriptRoot 'fixture-cdp-slot.mjs'
if (-not (Test-Path $Fixture)) { throw "fixture-cdp-slot.mjs not found at $Fixture" }
$Checker = Join-Path $PSScriptRoot 'check-browser-slots.ps1'
if (-not (Test-Path $Checker)) { throw "check-browser-slots.ps1 not found at $Checker" }

$NodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $NodeExe) { throw 'node is required to run this check (it hosts the fixture CDP server).' }

$script:Pass = 0
$script:Fail = 0
function Assert($name, $cond, $detail) {
    if ($cond) { $script:Pass++; Write-Host ("  ok    {0}" -f $name) -ForegroundColor Green }
    else { $script:Fail++; Write-Host ("  FAIL  {0}" -f $name) -ForegroundColor Red; if ($detail) { Write-Host "        $detail" -ForegroundColor DarkGray } }
}

$temp = Join-Path $env:TEMP ("mutwd-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $temp -Force | Out-Null
$fixtures = @()
$decoys = @()

function Get-FreePort {
    $l = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $l.Start(); $p = $l.LocalEndpoint.Port; $l.Stop(); return $p
}

function Start-Fixture {
    param([string]$Mode)
    $port = Get-FreePort
    $p = Start-Process -FilePath $NodeExe -ArgumentList @($Fixture, $port, $Mode) -PassThru -WindowStyle Hidden
    for ($i = 0; $i -lt 60; $i++) {
        Start-Sleep -Milliseconds 100
        try { Invoke-WebRequest "http://127.0.0.1:$port/json/version" -TimeoutSec 2 -UseBasicParsing | Out-Null
            $fx = @{ Port = $port; Proc = $p; Mode = $Mode }; $script:fixtures += $fx; return $fx } catch { }
    }
    throw "fixture ($Mode) never came up on port $port"
}

# A stand-in for a live MCP client attached to a slot: a real process whose
# command line carries `--cdp-endpoint http://localhost:<port>`, which is how
# the Playwright MCP is launched. Used to exercise the ownership veto.
function Start-Decoy {
    param([int]$Port)
    $p = Start-Process -FilePath $NodeExe `
        -ArgumentList @('-e', 'setTimeout(function(){},600000)', '--', '--cdp-endpoint', "http://localhost:$Port") `
        -PassThru -WindowStyle Hidden
    $script:decoys += $p
    Start-Sleep -Milliseconds 700
    return $p
}

# Write a fixture user-settings.md so the REAL table-parsing path runs.
function New-SettingsFile {
    param([hashtable[]]$Slots, [string]$Name)
    $profRoot = Join-Path $temp "profiles-$Name"
    foreach ($s in $Slots) { New-Item -ItemType Directory -Path (Join-Path $profRoot $s.Name) -Force | Out-Null }
    $rows = ($Slots | ForEach-Object { "| ``$($_.Name)`` | $($_.Port) | ``$($_.Name)`` | fixture | fx $($_.Name) |" }) -join "`n"
    $path = Join-Path $temp "settings-$Name.md"
    @"
# fixture settings

## Browser slots (fixture)

| Slot | Port | Profile dir (``$profRoot\``) | Account | Desktop shortcut |
| --- | --- | --- | --- | --- |
$rows

## Next
"@ | Set-Content $path -Encoding UTF8
    return $path
}

# A `flaky` fixture is SINGLE USE: it swallows exactly one awaited evaluate and
# is healthy forever after. So every arm that needs one must get a FRESH one --
# reusing it silently turns the "one-off blip" case into a plain healthy slot.
# (The C1 control caught exactly that when this suite was first written, which
# is the whole reason a control arm exists.)
function New-FlakyCase {
    param([string]$Name)
    $fx = Start-Fixture -Mode 'flaky'
    $settings = New-SettingsFile -Slots @(@{ Name = 'fxflaky'; Port = $fx.Port }) -Name $Name
    return [pscustomobject]@{ Fixture = $fx; Settings = $settings }
}

# Run a candidate watchdog and return its parsed rows + exit code.
function Invoke-Watchdog {
    param([string]$Path, [string]$Settings, [string]$Tag, [int]$RestartAfterRuns = 2, [string]$StateSeed)

    $state = Join-Path $temp "state-$Tag-$([Guid]::NewGuid().ToString('N').Substring(0,6)).json"
    if ($StateSeed) { $StateSeed | Set-Content $state -Encoding UTF8 }

    $cmd = "& '$Path' -WhatIf -Json -SettingsPath '$Settings' -StatePath '$state' " +
           "-ProbeTimeoutSec 4 -ProbeBudgetSec 45 -ConfirmDelaySec 1 -RestartAfterRuns $RestartAfterRuns " +
           "-CheckerPath '$Checker'; exit `$LASTEXITCODE"
    $out = & powershell -NoProfile -ExecutionPolicy Bypass -Command $cmd 2>&1 | Out-String
    $code = $LASTEXITCODE

    $rows = @()
    $iArr = $out.IndexOf('['); $iObj = $out.IndexOf('{')
    $i = if ($iArr -ge 0 -and ($iObj -lt 0 -or $iArr -lt $iObj)) { $iArr } elseif ($iObj -ge 0) { $iObj } else { -1 }
    if ($i -ge 0) { try { $rows = @($out.Substring($i) | ConvertFrom-Json) } catch { } }
    return [pscustomobject]@{ Rows = $rows; Exit = $code; Raw = $out }
}

function Get-Row { param($Res, [string]$Slot) return ($Res.Rows | Where-Object { $_.slot -eq $Slot } | Select-Object -First 1) }

# Produce a mutant copy of the script with one property sabotaged.
function New-Mutant {
    param([string]$Id, [string]$Find, [string]$Replace)
    $text = [IO.File]::ReadAllText($ScriptPath)
    if ($text -notmatch [regex]::Escape($Find)) { throw "mutant ${Id}: target text not found -- the suite is measuring nothing. Looked for: $Find" }
    $path = Join-Path $temp "mutant-$Id.ps1"
    [IO.File]::WriteAllText($path, $text.Replace($Find, $Replace))
    return $path
}

try {
    Write-Host 'mutcheck-browser-watchdog -- GH #197 recovery guards' -ForegroundColor Cyan
    Write-Host ''

    $wedged = Start-Fixture -Mode 'wedged'
    $healthy = Start-Fixture -Mode 'healthy'

    $sWedged = New-SettingsFile -Slots @(@{ Name = 'fxwedged'; Port = $wedged.Port }) -Name 'wedged'
    $sHealthy = New-SettingsFile -Slots @(@{ Name = 'fxhealthy'; Port = $healthy.Port }) -Name 'healthy'

    # ---------------- baseline: the real script ----------------------------
    Write-Host 'baseline (the shipped script)' -ForegroundColor White
    $bWedged = Invoke-Watchdog -Path $ScriptPath -Settings $sWedged -Tag 'b1'
    $rw = Get-Row $bWedged 'fxwedged'
    Assert 'wedged slot is classified stuck' ($rw -and $rw.verdict -eq 'stuck') "verdict=$($rw.verdict) action=$($rw.action)"
    Assert 'wedged slot is scheduled for recovery, not left already-up' ($rw -and $rw.action -ne 'already-up' -and $rw.action -like 'would-*') "action=$($rw.action)"
    Assert 'unrecovered stuck slot exits non-zero' ($bWedged.Exit -ne 0) "exit=$($bWedged.Exit)"

    $bHealthy = Invoke-Watchdog -Path $ScriptPath -Settings $sHealthy -Tag 'b2'
    $rh = Get-Row $bHealthy 'fxhealthy'
    Assert 'healthy slot is left untouched (control)' ($rh -and $rh.action -eq 'already-up') "action=$($rh.action)"
    Assert 'all-healthy run exits 0 (control)' ($bHealthy.Exit -eq 0) "exit=$($bHealthy.Exit)"

    $flakyBase = New-FlakyCase -Name 'flaky-base'
    $bFlaky = Invoke-Watchdog -Path $ScriptPath -Settings $flakyBase.Settings -Tag 'b3'
    $rf = Get-Row $bFlaky 'fxflaky'
    Assert 'a one-off failed probe is NOT treated as stuck' ($rf -and $rf.action -eq 'no-action-transient') "action=$($rf.action) verdict=$($rf.verdict)"

    # restart rung: streak already at the threshold, but no real browser process
    # owns the fixture port, so the safety guard must refuse.
    $seed = (@{ fxwedged = 1 } | ConvertTo-Json)
    $bRestart = Invoke-Watchdog -Path $ScriptPath -Settings $sWedged -Tag 'b4' -RestartAfterRuns 2 -StateSeed $seed
    $rr = Get-Row $bRestart 'fxwedged'
    Assert 'restart is refused when the process cannot be identified' ($rr -and $rr.action -eq 'refused-unsafe-restart') "action=$($rr.action)"

    # ownership veto
    Start-Decoy -Port $wedged.Port | Out-Null
    $bInUse = Invoke-Watchdog -Path $ScriptPath -Settings $sWedged -Tag 'b5'
    $ru = Get-Row $bInUse 'fxwedged'
    Assert 'recovery is refused on a slot another run is driving' ($ru -and $ru.action -eq 'refused-in-use') "action=$($ru.action)"
    foreach ($d in $decoys) { if (-not $d.HasExited) { Stop-Process -Id $d.Id -Force -ErrorAction SilentlyContinue } }
    $decoys = @()
    Start-Sleep -Seconds 1

    Write-Host ''
    Write-Host 'mutants (each must FAIL, i.e. the guard must stop mattering)' -ForegroundColor White

    # ---------------- M1: health verdict forced healthy --------------------
    $m1 = New-Mutant -Id 'M1' `
        -Find '        $r = $rows[0]
        return [pscustomobject]@{ state = $r.state; healthy = [bool]$r.healthy; detail = $r.detail; raw = $r }' `
        -Replace '        $r = $rows[0]
        return [pscustomobject]@{ state = ''up''; healthy = $true; detail = $r.detail; raw = $r }'
    $x1 = Get-Row (Invoke-Watchdog -Path $m1 -Settings $sWedged -Tag 'm1') 'fxwedged'
    Assert 'M1 forcing the verdict healthy misreports the wedged slot' ($x1 -and $x1.action -eq 'already-up') "action=$($x1.action) (expected already-up under the mutant)"

    # ---------------- M2: verdict from a TCP-accept test -------------------
    # This is the shipped bug, reproduced exactly.
    $m2 = New-Mutant -Id 'M2' `
        -Find '    $outFile = [IO.Path]::GetTempFileName()' `
        -Replace '    $c = New-Object System.Net.Sockets.TcpClient
    try {
        $iar = $c.BeginConnect(''127.0.0.1'', $Port, $null, $null)
        if ($iar.AsyncWaitHandle.WaitOne(1000)) {
            try { $c.EndConnect($iar); return [pscustomobject]@{ state = ''up''; healthy = $true; detail = ''tcp''; raw = $null } } catch { }
        }
        return [pscustomobject]@{ state = ''down''; healthy = $false; detail = ''tcp''; raw = $null }
    } finally { $c.Close() }

    $outFile = [IO.Path]::GetTempFileName()'
    $x2 = Get-Row (Invoke-Watchdog -Path $m2 -Settings $sWedged -Tag 'm2') 'fxwedged'
    Assert 'M2 reverting to a TCP-accept probe misreports the wedged slot' ($x2 -and $x2.action -eq 'already-up') "action=$($x2.action) (expected already-up under the mutant)"

    # ---------------- M3: confirmation probe removed -----------------------
    $m3 = New-Mutant -Id 'M3' `
        -Find '    $confirm = Get-SlotHealth -Port $port -Name $name
    if ($confirm.healthy) {' `
        -Replace '    $confirm = [pscustomobject]@{ healthy = $false }
    if ($confirm.healthy) {'
    $flakyM3 = New-FlakyCase -Name 'flaky-m3'
    $x3 = Get-Row (Invoke-Watchdog -Path $m3 -Settings $flakyM3.Settings -Tag 'm3') 'fxflaky'
    Assert 'M3 removing the confirmation probe acts on a one-off blip' ($x3 -and $x3.action -ne 'no-action-transient') "action=$($x3.action) (expected a recovery action under the mutant)"

    # ---------------- M4: ownership veto's fail-safe direction -------------
    # The decoy has no `copilot.exe` owner, so its owner cannot be ATTRIBUTED.
    # That must veto: missing evidence can spare a slot, never recover one.
    Start-Decoy -Port $wedged.Port | Out-Null
    $m4 = New-Mutant -Id 'M4' `
        -Find '                # Orphan, or unattributable. An orphan cannot be mid-operation,
                # but we cannot tell the two apart, so we spare the slot.
                return $true' `
        -Replace '                # Orphan, or unattributable. An orphan cannot be mid-operation,
                # but we cannot tell the two apart, so we spare the slot.
                return $false'
    $x4 = Get-Row (Invoke-Watchdog -Path $m4 -Settings $sWedged -Tag 'm4') 'fxwedged'
    Assert 'M4 dropping the veto fail-safe recovers a slot with an unattributable owner' ($x4 -and $x4.action -ne 'refused-in-use') "action=$($x4.action) (expected recovery under the mutant)"
    foreach ($d in $decoys) { if (-not $d.HasExited) { Stop-Process -Id $d.Id -Force -ErrorAction SilentlyContinue } }
    $decoys = @()
    Start-Sleep -Seconds 1

    # ---------------- M5: restart-safety guard disabled --------------------
    $m5 = New-Mutant -Id 'M5' `
        -Find '    return [pscustomobject]@{ ok = $true; reason = ''ok''; proc = $proc }' `
        -Replace '    return [pscustomobject]@{ ok = $true; reason = ''ok''; proc = $proc }
    # (mutant tail)'
    # The real sabotage: make the guard return ok before either check runs.
    $m5text = [IO.File]::ReadAllText($m5)
    $m5text = $m5text.Replace(
        '    if (-not $Slot.ProfilePath -or -not (Test-Path -LiteralPath $Slot.ProfilePath)) {',
        '    return [pscustomobject]@{ ok = $true; reason = ''ok''; proc = $null }
    if (-not $Slot.ProfilePath -or -not (Test-Path -LiteralPath $Slot.ProfilePath)) {')
    [IO.File]::WriteAllText($m5, $m5text)
    $x5 = Get-Row (Invoke-Watchdog -Path $m5 -Settings $sWedged -Tag 'm5' -RestartAfterRuns 2 -StateSeed $seed) 'fxwedged'
    Assert 'M5 disabling the restart-safety guard would kill an unidentified process' ($x5 -and $x5.action -eq 'would-restart') "action=$($x5.action) (expected would-restart under the mutant)"

    # ---------------- M6: stuck slot exits 0 -------------------------------
    $m6 = New-Mutant -Id 'M6' -Find 'if ($stuckBad.Count -gt 0) { exit 2 }' -Replace 'if ($stuckBad.Count -gt 0) { exit 0 }'
    $r6 = Invoke-Watchdog -Path $m6 -Settings $sWedged -Tag 'm6'
    Assert 'M6 exiting 0 on a stuck slot hides the failure' ($r6.Exit -eq 0) "exit=$($r6.Exit) (expected 0 under the mutant)"

    # ---------------- C1: the control --------------------------------------
    # A cosmetic edit to a message string. Everything above must still hold.
    $c1 = New-Mutant -Id 'C1' -Find 'A stuck slot that cannot be recovered is a question, not a retry.' `
        -Replace 'A stuck slot that cannot be recovered needs a human, not another retry.'
    $c1Wedged = Invoke-Watchdog -Path $c1 -Settings $sWedged -Tag 'c1'
    $cw = Get-Row $c1Wedged 'fxwedged'
    $flakyC1 = New-FlakyCase -Name 'flaky-c1'
    $c1Flaky = Get-Row (Invoke-Watchdog -Path $c1 -Settings $flakyC1.Settings -Tag 'c1b') 'fxflaky'
    Assert 'C1 CONTROL: a cosmetic edit keeps every guard intact' `
    ($cw -and $cw.verdict -eq 'stuck' -and $cw.action -like 'would-*' -and $c1Wedged.Exit -ne 0 -and $c1Flaky -and $c1Flaky.action -eq 'no-action-transient') `
        "wedged action=$($cw.action) exit=$($c1Wedged.Exit) flaky action=$($c1Flaky.action)"

    Write-Host ''
    Write-Host ("{0} passed, {1} failed" -f $script:Pass, $script:Fail) -ForegroundColor $(if ($script:Fail) { 'Red' } else { 'Green' })
}
finally {
    foreach ($f in $fixtures) { if ($f.Proc -and -not $f.Proc.HasExited) { Stop-Process -Id $f.Proc.Id -Force -ErrorAction SilentlyContinue } }
    foreach ($d in $decoys) { if (-not $d.HasExited) { Stop-Process -Id $d.Id -Force -ErrorAction SilentlyContinue } }
    if ($KeepTemp) { Write-Host "temp kept: $temp" -ForegroundColor DarkGray }
    else { Remove-Item $temp -Recurse -Force -ErrorAction SilentlyContinue }
}

if ($script:Fail -gt 0) { exit 1 }
exit 0
