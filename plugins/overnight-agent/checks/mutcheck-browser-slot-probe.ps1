<#
  mutcheck-browser-slot-probe.ps1 -- proves the CDP work probe in
  check-browser-slots.ps1 is load-bearing (GH #197).

  THE INVARIANT
    A slot that answers every HTTP probe but whose EXISTING pages cannot
    complete a timer-backed evaluate must be classified `stuck`, not healthy,
    and must drive a non-zero exit.

  WHY THAT IS THE RIGHT INVARIANT
    TCP-accept is liveness, not health. So is HTTP 200 from /json/version and
    a populated /json/list -- all three are served by the BROWSER process,
    while the thing that actually wedges is a RENDERER whose task queue is
    frozen. Measured live on 2026-09-01: three slots reported `healthy: true`
    by the pre-#197 checker while every Playwright operation against them
    timed out, which is what blocked the deadline-bearing lookup on planner
    task #451. The only signal that separates the two is whether a renderer
    can still COMPLETE work, so the probe asks it to.

  WHY THE PROBE MUST AWAIT A TIMER
    In the frozen lifecycle state, synchronous JS still evaluates. So a probe
    that evaluates `1+1` returns promptly and proves nothing. Timers and rAF
    are precisely what stops firing, so the probe awaits a promise resolved by
    setTimeout. M3 exists to prove that distinction is real, not stylistic.

  WHY THE PROBE MUST TARGET EXISTING PAGES
    A freshly created target is NEVER frozen -- the frozen lifecycle only
    affects already-open, occluded tabs. So a probe that opens its own tab
    reports every wedged slot as healthy. This is the subtle way to get the
    fix wrong while appearing to implement it, which is why M2 exists: the
    fixture answers on fresh targets and stays silent on pre-existing ones,
    exactly as real Chrome does.

  THE MUTANTS
    M1  the probe result is forced to `ok` (the probe is present but toothless).
    M2  the probe runs against a NEW target instead of the existing pages.
    M3  the probe evaluates synchronous JS instead of awaiting a timer.
    M4  the `stuck` verdict is downgraded back to healthy (classification hole).
    M5  the -Json path exits 0 unconditionally (the verdict is reached, correctly
        reported in the body, and then thrown away at the process boundary).

    M1-M4 must FAIL by misreporting the wedged fixture as healthy, proving the
    real script's verdict comes from that specific behaviour rather than from
    something incidental. M5 is different in kind and is listed separately below.

    C1 is the control: a cosmetic edit to a detail string. It must SHIP GREEN.
    Without it, "every mutation breaks the check" would be indistinguishable
    from "the check is load-bearing", and the suite would prove nothing.

  THE HALF OF THE INVARIANT THIS SUITE USED TO SKIP (added 2026-09-01)
    The invariant above has always said "and must drive a non-zero exit", but
    `Invoke-Checker` read only the JSON body and never the exit code. So the
    suite asserted one half of its own contract.

    Measured live that day, with all three of the user's real slots wedged:
    the human path exited 2 and `-Json` exited 0, from identical data, while
    the JSON body it printed carried `"state": "stuck"` for every slot. The
    mode an automated caller uses was the mode that lied.

    B2 and A2 assert the exit code directly. M5 restores the old behaviour and
    must be caught -- and it is caught ONLY by B2, since it leaves the body
    correct. That asymmetry is the evidence that the two halves are genuinely
    independent, and that reading the payload alone can never cover this class.

  NEVER TOUCHES LIVE STATE
    Every probe runs against a Node fixture CDP server on an ephemeral port.
    The user's real browsers are never contacted -- -SlotSpec is a real
    parameter of the script under test.

  USAGE
    powershell -NoProfile -ExecutionPolicy Bypass -File mutcheck-browser-slot-probe.ps1
#>
[CmdletBinding()]
param(
  [string]$ScriptPath,
  [switch]$KeepTemp
)

$ErrorActionPreference = 'Stop'

if (-not $ScriptPath) { $ScriptPath = Join-Path $PSScriptRoot 'check-browser-slots.ps1' }
$ScriptPath = [IO.Path]::GetFullPath($ScriptPath)
if (-not (Test-Path $ScriptPath)) { throw "check-browser-slots.ps1 not found at $ScriptPath" }

$Fixture = Join-Path $PSScriptRoot 'fixture-cdp-slot.mjs'
if (-not (Test-Path $Fixture)) { throw "fixture-cdp-slot.mjs not found at $Fixture" }

$NodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $NodeExe) { throw 'node is required to run this check (it hosts the fixture CDP server).' }

$script:Pass = 0
$script:Fail = 0
function Assert($name, $cond, $detail) {
  if ($cond) { $script:Pass++; Write-Host ("  ok    {0}" -f $name) -ForegroundColor Green }
  else       { $script:Fail++; Write-Host ("  FAIL  {0}  {1}" -f $name, $detail) -ForegroundColor Red }
}

$utf8NoBom = New-Object Text.UTF8Encoding($false)
$tempRoot  = Join-Path ([IO.Path]::GetTempPath()) ("mutslot-" + [guid]::NewGuid().ToString('N').Substring(0, 10))
New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null

function Get-FreePort {
  $l = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  $l.Start(); $p = $l.LocalEndpoint.Port; $l.Stop(); return $p
}

function Start-Fixture {
  param([string]$Mode)
  $port = Get-FreePort
  $p = Start-Process -FilePath $NodeExe -ArgumentList @($Fixture, $port, $Mode) `
        -PassThru -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $tempRoot "fx-$port.out") `
        -RedirectStandardError  (Join-Path $tempRoot "fx-$port.err")
  # Wait for the HTTP surface to answer before handing the port out.
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 150
    try {
      Invoke-WebRequest -Uri "http://127.0.0.1:$port/json/version" -TimeoutSec 2 -UseBasicParsing | Out-Null
      return [pscustomobject]@{ Port = $port; Proc = $p }
    } catch { }
  }
  throw "fixture ($Mode) never came up on port $port"
}

function Stop-Fixture { param($fx) if ($fx -and $fx.Proc -and -not $fx.Proc.HasExited) { Stop-Process -Id $fx.Proc.Id -Force -ErrorAction SilentlyContinue } }

# Run a candidate script against a fixture port and return the parsed slot row.
#
# The EXIT CODE is captured alongside the body. It was not, before -- and that
# omission is exactly why the suite could state "and must drive a non-zero exit"
# in its own invariant while `-Json` exited 0 on a slot it had just called
# `stuck`. A suite that reads only the half of the contract that happens to be
# in the payload cannot see a defect in the other half.
function Invoke-Checker {
  param([string]$Path, [int]$Port, [int]$TimeoutSec = 4)
  $out = & powershell -NoProfile -ExecutionPolicy Bypass -File $Path `
            -Json -ProbeTimeoutSec $TimeoutSec -SlotSpec "${Port}:fixture" 2>&1 | Out-String
  $code = $LASTEXITCODE
  $rows = $null
  try { $rows = $out | ConvertFrom-Json } catch {
    return [pscustomobject]@{ parsed = $false; raw = $out; healthy = $null; state = $null; exit = $code }
  }
  $row = @($rows) | Select-Object -First 1
  return [pscustomobject]@{ parsed = $true; raw = $out; healthy = $row.healthy; state = $row.state; detail = $row.detail; exit = $code }
}

# Write a mutated copy of the script under test.
function New-Mutant {
  param([string]$Name, [scriptblock]$Transform)
  $src = [IO.File]::ReadAllText($ScriptPath)
  $mutated = & $Transform $src
  if ($mutated -eq $src) { throw "mutant '$Name' changed nothing -- its pattern no longer matches the source." }
  $path = Join-Path $tempRoot "$Name.ps1"
  [IO.File]::WriteAllText($path, $mutated, $utf8NoBom)
  return $path
}

Write-Host ''
Write-Host 'mutcheck-browser-slot-probe -- CDP work probe (GH #197)' -ForegroundColor Cyan
Write-Host ''

$healthyFx = $null
$wedgedFx  = $null
try {
  $healthyFx = Start-Fixture -Mode 'healthy'
  $wedgedFx  = Start-Fixture -Mode 'wedged'

  # ---- baselines ---------------------------------------------------------
  Write-Host 'baseline' -ForegroundColor DarkCyan
  $bh = Invoke-Checker -Path $ScriptPath -Port $healthyFx.Port
  Assert 'A  healthy slot reports healthy' ($bh.parsed -and $bh.healthy -eq $true -and $bh.state -eq 'up') "got state=$($bh.state) healthy=$($bh.healthy)`n$($bh.raw)"
  Assert 'A2 healthy slot exits 0 in -Json mode' ($bh.exit -eq 0) "got exit=$($bh.exit)"

  $bw = Invoke-Checker -Path $ScriptPath -Port $wedgedFx.Port
  Assert 'B  wedged slot reports stuck (THE INVARIANT)' ($bw.parsed -and $bw.healthy -eq $false -and $bw.state -eq 'stuck') "got state=$($bw.state) healthy=$($bw.healthy)`n$($bw.raw)"
  Assert 'B2 wedged slot drives exit 2 in -Json mode (the other half of the invariant)' ($bw.exit -eq 2) "got exit=$($bw.exit) -- the body said stuck but the process said ok"

  # The probe must be bounded: a never-answering renderer cannot hang the run.
  $sw = [Diagnostics.Stopwatch]::StartNew()
  Invoke-Checker -Path $ScriptPath -Port $wedgedFx.Port -TimeoutSec 3 | Out-Null
  $sw.Stop()
  Assert 'C  probe is bounded (<40s against a silent renderer)' ($sw.Elapsed.TotalSeconds -lt 40) "took $([math]::Round($sw.Elapsed.TotalSeconds,1))s"

  # ---- mutants -----------------------------------------------------------
  Write-Host ''
  Write-Host 'mutants (each must be caught by B)' -ForegroundColor DarkCyan

  $m1 = New-Mutant 'M1-toothless-probe' {
    param($s)
    $s -replace '(?m)^\s*\$live\s*=\s*Test-CdpTargetLive.*$', '        $live = [pscustomobject]@{ ok = $true; reason = ''ok'' }'
  }
  $r1 = Invoke-Checker -Path $m1 -Port $wedgedFx.Port
  Assert 'M1 toothless probe misreports wedged as healthy' ($r1.parsed -and $r1.healthy -eq $true) "mutant was not caught: state=$($r1.state) healthy=$($r1.healthy)"

  $m2 = New-Mutant 'M2-fresh-target' {
    param($s)
    # Probe a brand-new target instead of the slot's existing pages. This is
    # the plausible-looking implementation that silently detects nothing.
    $s -replace '(?m)^(\s*)foreach \(\$t in \(\$pageTargets \| Select-Object -First \$MaxProbeTargets\)\) \{',
      ('$1$fresh = (Invoke-WebRequest -Uri "http://127.0.0.1:$port/json/new?about:blank" -Method Put -TimeoutSec 5 -UseBasicParsing).Content | ConvertFrom-Json' + "`n" +
       '$1foreach ($t in @($fresh)) {')
  }
  $r2 = Invoke-Checker -Path $m2 -Port $wedgedFx.Port
  Assert 'M2 fresh-target probe misreports wedged as healthy' ($r2.parsed -and $r2.healthy -eq $true) "mutant was not caught: state=$($r2.state) healthy=$($r2.healthy)"

  $m3 = New-Mutant 'M3-sync-expression' {
    param($s)
    # The naive implementation: evaluate synchronous JS and call it a health
    # check. Both halves have to change -- dropping only the expression leaves
    # `awaitPromise: true` on the wire, and the renderer still withholds the
    # reply, so the mutant would survive for a reason unrelated to its point.
    # (It did exactly that on first run, which is how we learned that the
    # awaitPromise flag, not the expression text, is what carries detection.)
    $t = $s -replace [regex]::Escape("new Promise(function(r){setTimeout(function(){r('oa-live')},120)})"), '1+1'
    $t -replace [regex]::Escape('-AwaitPromise -TimeoutSec $TimeoutSec'), '-TimeoutSec $TimeoutSec'
  }
  $r3 = Invoke-Checker -Path $m3 -Port $wedgedFx.Port
  Assert 'M3 synchronous probe misreports wedged as healthy' ($r3.parsed -and $r3.healthy -eq $true) "mutant was not caught: state=$($r3.state) healthy=$($r3.healthy)"

  $m4 = New-Mutant 'M4-no-stuck-verdict' {
    param($s)
    # Neutralise the whole verdict, not just the state line -- leaving the
    # `healthy = $false` behind would make the mutant die for the wrong reason.
    $s -replace "(?m)^\s*\`$row\.state\s*=\s*'stuck'\s*\r?\n\s*\`$row\.healthy\s*=\s*\`$false\s*$", '        $row.healthy = $true'
  }
  $r4 = Invoke-Checker -Path $m4 -Port $wedgedFx.Port
  Assert 'M4 dropped stuck verdict misreports wedged as healthy' ($r4.parsed -and $r4.healthy -eq $true) "mutant was not caught: state=$($r4.state) healthy=$($r4.healthy)"

  # M5 is the defect that was LIVE on main until 2026-09-01, and it is the
  # reason B2 exists. It restores the unconditional `exit 0` on the -Json path.
  #
  # Note what it does NOT change: the JSON body still says stuck/unhealthy, so
  # arm B passes on this mutant. Only the process exit is wrong. That is the
  # whole point -- a caller that trusts the exit code (a watchdog, a CI gate)
  # is told "all healthy" while the payload it did not parse says otherwise.
  # If B2 were removed, this mutant would survive, which is precisely how the
  # real bug survived every previous green run of this suite.
  $m5 = New-Mutant 'M5-json-always-exit-0' {
    param($s)
    # Line-ending agnostic on purpose: this repo is edited from Windows and CI
    # runs on Linux, and a mutant that silently stops matching would be reported
    # by New-Mutant as "changed nothing" rather than as a passing arm.
    $s -replace ([regex]::Escape('if ($bad.Count -gt 0) { exit 2 }') + '\r?\n'), ''
  }
  $r5 = Invoke-Checker -Path $m5 -Port $wedgedFx.Port
  Assert 'M5 -Json exit-0 mutant is caught by the exit code, not the body' `
    ($r5.parsed -and $r5.healthy -eq $false -and $r5.exit -eq 0) `
    "mutant was not caught: exit=$($r5.exit) healthy=$($r5.healthy) (expected exit=0 healthy=False)"

  # ---- control -----------------------------------------------------------
  Write-Host ''
  Write-Host 'control (must survive -- proves the suite is not just "any edit breaks it")' -ForegroundColor DarkCyan
  $c1 = New-Mutant 'C1-cosmetic' {
    param($s)
    $s -replace [regex]::Escape('the page is in the frozen'), 'the renderer is in the frozen'
  }
  $rc = Invoke-Checker -Path $c1 -Port $wedgedFx.Port
  Assert 'C1 cosmetic edit still detects the wedged slot' ($rc.parsed -and $rc.healthy -eq $false -and $rc.state -eq 'stuck') "control was wrongly killed: state=$($rc.state)"

} finally {
  Stop-Fixture $healthyFx
  Stop-Fixture $wedgedFx
  if (-not $KeepTemp) { Remove-Item -Recurse -Force $tempRoot -ErrorAction SilentlyContinue }
  else { Write-Host "temp kept at $tempRoot" -ForegroundColor DarkGray }
}

Write-Host ''
Write-Host ("{0} passed, {1} failed" -f $script:Pass, $script:Fail) -ForegroundColor $(if ($script:Fail) { 'Red' } else { 'Green' })
if ($script:Fail) { exit 1 }
exit 0
