<#
  mutcheck-browser-watchdog.ps1 -- proves the hourly supervisor decides on the
  CDP WORK verdict, acts on `stuck`, and re-checks before it says "recovered"
  (GH #197).

  THE INVARIANT
    A slot whose port accepts TCP but whose renderer cannot complete work must
    be (a) classified unhealthy, (b) acted on, and (c) reported honestly - both
    in the body and in the exit code.

  WHY THAT IS THE RIGHT INVARIANT
    Measured end to end on the live machine, 2026-09-01:

      17:18-17:20 PT  the hourly watchdog workflow ran -> `completed`, exit 0,
                      printing "All 3 automation slots are up."
      17:58    PT  check-browser-slots.ps1 -> all three `stuck`,
                      `healthy: false`, exit 2.

    Nothing happened in between. The supervisor's whole health test was a 1s TCP
    connect, and its only action branch was DOWN, so a wedged slot was reported
    healthy AND was unreachable by any recovery path. Re-run against the same
    three slots while writing this change, the old script printed "All 3
    automation slots are up" and exited 0; the new one classified all three
    stuck, thawed them, re-probed, and handed back three working slots.

  THE MUTANTS
    M1  health is decided by liveness again ("the port answers, so it is fine").
        This is literally the defect the issue was filed about.
    M2  `stuck` is never collected, so it is never acted on - the DOWN-only
        watchdog, restated. The slot is detected and then ignored.
    M3  the confirming re-probe reuses the PRE-repair data instead of asking
        again, so the run's verdict is about the past, not the present.
    M4  the -Json path exits 0 unconditionally: the verdict is reached, printed
        correctly in the body, and thrown away at the process boundary. This is
        the exact bug #347 fixed in the sibling tool, so it is a proven-real
        failure mode for this file shape rather than a hypothetical one.

    Each must be CAUGHT. C1 is the control - a cosmetic edit to a message - and
    must SHIP GREEN, so "every edit breaks it" cannot masquerade as coverage.

  NEVER TOUCHES LIVE STATE
    Both tools the watchdog shells out to are injected as fixtures via
    -CheckerPath / -EnsurePath. No real browser is contacted, no port is opened,
    and the user's slot table is never read.

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
$ScriptPath = [IO.Path]::GetFullPath($ScriptPath)
if (-not (Test-Path $ScriptPath)) { throw "browser-watchdog.ps1 not found at $ScriptPath" }

$script:Pass = 0
$script:Fail = 0
function Assert($name, $cond, $detail) {
  if ($cond) { $script:Pass++; Write-Host ("  ok    {0}" -f $name) -ForegroundColor Green }
  else { $script:Fail++; Write-Host ("  FAIL  {0}  {1}" -f $name, $detail) -ForegroundColor Red }
}

$utf8NoBom = New-Object Text.UTF8Encoding($false)
$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("mutwd-" + [guid]::NewGuid().ToString('N').Substring(0, 10))
New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null

# ---------------------------------------------------------------------------
# FIXTURE CHECKER - stands in for check-browser-slots.ps1.
#
# It models the ONE behaviour that matters: a `stuck` slot answers everything
# except a timer-backed evaluate, and `-Repair` is what (sometimes) clears it.
# Mode is read from a state file so a -Repair call can change what the NEXT
# call reports -- which is how a real thaw behaves, and what makes the
# confirming re-probe observable.
# ---------------------------------------------------------------------------
$fixtureChecker = @'
param([switch]$Json, [switch]$Repair, [string]$SettingsPath, [switch]$NoProbe,
      [int]$ProbeTimeoutSec = 6, [int]$MaxProbeTargets = 6, [string[]]$SlotSpec)
$stateFile = $env:MUTWD_STATE
$mode = (Get-Content -LiteralPath $stateFile -Raw).Trim()
Add-Content -LiteralPath $env:MUTWD_CALLS -Value ("check:{0}:{1}" -f $mode, [bool]$Repair)

if ($Repair -and $mode -eq 'stuck-recoverable') {
  Set-Content -LiteralPath $stateFile -Value 'healthy-after-repair' -NoNewline
  $mode = 'healthy-after-repair'
  $rep = 1
} else { $rep = 0 }

switch ($mode) {
  'healthy'              { $state='up';    $healthy=$true;  $detail='ok' }
  'healthy-after-repair' { $state='up';    $healthy=$true;  $detail='ok (thawed)' }
  'stuck-recoverable'    { $state='stuck'; $healthy=$false; $detail='STUCK: frozen lifecycle state' }
  'stuck-permanent'      { $state='stuck'; $healthy=$false; $detail='STUCK: frozen lifecycle state' }
  'down'                 { $state='down';  $healthy=$false; $detail='no CDP listener' }
  default                { $state='down';  $healthy=$false; $detail='no CDP listener' }
}
$row = [ordered]@{
  port=9999; mcp='fixture-slot'; account='fixture'; profile_dir='x'; state=$state
  reported='1'; installed='1'; loaded_dll='x'; pages=1; probed=1
  wedged=$(if($state -eq 'stuck'){1}else{0}); wedged_targets=@(); repaired=$rep
  healthy=$healthy; detail=$detail; shortcut='fixture'
}
@([pscustomobject]$row) | ConvertTo-Json -Depth 4
if ($state -ne 'down' -and -not $healthy) { exit 2 }
exit 0
'@

# FIXTURE LAUNCHER - stands in for ensure-mcp-browsers.ps1. Flips the slot to
# healthy, which is what a successful launch means.
$fixtureEnsure = @'
param([string]$Slot='all', [switch]$List, [switch]$DryRun, [switch]$Quiet, [string]$SettingsPath)
Add-Content -LiteralPath $env:MUTWD_CALLS -Value ("ensure:{0}" -f $Slot)
Set-Content -LiteralPath $env:MUTWD_STATE -Value 'healthy' -NoNewline
exit 0
'@

$checkerPath = Join-Path $tempRoot 'fixture-check.ps1'
$ensurePath = Join-Path $tempRoot 'fixture-ensure.ps1'
[IO.File]::WriteAllText($checkerPath, $fixtureChecker, $utf8NoBom)
[IO.File]::WriteAllText($ensurePath, $fixtureEnsure, $utf8NoBom)

$original = [IO.File]::ReadAllText($ScriptPath)

function Invoke-Watchdog {
  <# Run a given variant of the watchdog against the fixtures and return its
     stdout, exit code and the call log. Exit code is captured deliberately:
     the sibling tool shipped for months with a correct body and a lying exit
     code, and a suite that reads only the payload cannot see that (#347). #>
  param([string]$Variant, [string]$Mode, [string[]]$ExtraArgs = @())

  $stateFile = Join-Path $tempRoot ("state-" + [guid]::NewGuid().ToString('N').Substring(0, 6) + '.txt')
  $callFile = Join-Path $tempRoot ("calls-" + [guid]::NewGuid().ToString('N').Substring(0, 6) + '.txt')
  Set-Content -LiteralPath $stateFile -Value $Mode -NoNewline
  Set-Content -LiteralPath $callFile -Value '' -NoNewline

  $env:MUTWD_STATE = $stateFile
  $env:MUTWD_CALLS = $callFile

  $outFile = Join-Path $tempRoot ("out-" + [guid]::NewGuid().ToString('N').Substring(0, 6) + '.txt')
  $args = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $Variant,
    '-CheckerPath', $checkerPath, '-EnsurePath', $ensurePath) + $ExtraArgs
  $p = Start-Process -FilePath (Get-Process -Id $PID).Path -ArgumentList $args `
    -NoNewWindow -PassThru -RedirectStandardOutput $outFile -Wait
  [pscustomobject]@{
    ExitCode = $p.ExitCode
    Stdout   = (Get-Content -LiteralPath $outFile -Raw -ErrorAction SilentlyContinue)
    Calls    = (Get-Content -LiteralPath $callFile -Raw -ErrorAction SilentlyContinue)
    Final    = (Get-Content -LiteralPath $stateFile -Raw -ErrorAction SilentlyContinue)
  }
}

function New-Variant {
  param([string]$Name, [string]$Find, [string]$Replace)
  $text = $original
  if (-not $text.Contains($Find)) { throw "mutant $Name : anchor not found -- the suite is stale relative to the script: $Find" }
  $text = $text.Replace($Find, $Replace)
  $path = Join-Path $tempRoot "$Name.ps1"
  [IO.File]::WriteAllText($path, $text, $utf8NoBom)
  return $path
}

Write-Host ''
Write-Host 'mutcheck-browser-watchdog -- the supervisor must act on health, not liveness (GH #197)' -ForegroundColor Cyan
Write-Host ''

# ===========================================================================
# BASELINE ARMS - the real script must get all of these right.
# ===========================================================================
Write-Host 'baseline (unmutated script)' -ForegroundColor White

$a = Invoke-Watchdog -Variant $ScriptPath -Mode 'healthy'
Assert 'A  healthy slot -> exit 0' ($a.ExitCode -eq 0) "got exit=$($a.ExitCode)"
Assert 'A  healthy slot is not needlessly repaired' ($a.Calls -notmatch 'check:healthy:True') 'repaired a healthy slot'

$b = Invoke-Watchdog -Variant $ScriptPath -Mode 'stuck-permanent'
Assert 'B  unrecoverable stuck -> exit 2 (escalates)' ($b.ExitCode -eq 2) "got exit=$($b.ExitCode) -- a wedged slot was reported as fine"
Assert 'B  stuck slot IS acted on (repair attempted)' ($b.Calls -match 'check:stuck-permanent:True') 'never attempted the thaw -- DOWN-only watchdog'

$bj = Invoke-Watchdog -Variant $ScriptPath -Mode 'stuck-permanent' -ExtraArgs @('-Json')
Assert 'B2 -Json unrecoverable stuck -> exit 2' ($bj.ExitCode -eq 2) "got exit=$($bj.ExitCode) -- body and exit code disagree (cf. #347)"
Assert 'B2 -Json body reports healthy:false' ($bj.Stdout -match '"healthy"\s*:\s*false') 'JSON body claimed health'

$c = Invoke-Watchdog -Variant $ScriptPath -Mode 'stuck-recoverable'
Assert 'C  recoverable stuck -> thawed and exit 0' ($c.ExitCode -eq 0) "got exit=$($c.ExitCode)"
Assert 'C  recovery is CONFIRMED by a fresh probe' (@([regex]::Matches($c.Calls, 'check:')).Count -ge 3) "only $(@([regex]::Matches($c.Calls,'check:')).Count) checker call(s) -- no confirming re-probe"

$d = Invoke-Watchdog -Variant $ScriptPath -Mode 'down'
Assert 'D  down slot -> launcher invoked' ($d.Calls -match 'ensure:') 'never called ensure-mcp-browsers.ps1'
Assert 'D  down slot -> exit 0 once up' ($d.ExitCode -eq 0) "got exit=$($d.ExitCode)"

$r = Invoke-Watchdog -Variant $ScriptPath -Mode 'stuck-recoverable' -ExtraArgs @('-ReportOnly')
Assert 'E  -ReportOnly changes nothing' ($r.Calls -notmatch ':True') 'ReportOnly attempted a repair'
Assert 'E  -ReportOnly still reports the problem (exit 2)' ($r.ExitCode -eq 2) "got exit=$($r.ExitCode)"

# STATIC: the recovery ladder must stop at the non-destructive rung. A window
# holds the user's signed-in state; App-Bound Encryption means a botched
# restart is only recoverable by hand.
Assert 'F  never kills a browser process' `
  ($original -notmatch 'Stop-Process' -and $original -notmatch 'taskkill') `
  'the supervisor contains a process kill -- destructive recovery must be opt-in and evidenced'

# ===========================================================================
# MUTANTS - each must be caught.
# ===========================================================================
Write-Host ''
Write-Host 'mutants (each must be CAUGHT)' -ForegroundColor White

# M1: back to liveness. "The port answers, so the slot is fine" -- the exact
# rule the old watchdog used, and the reason it exited 0 over three dead slots.
$m1 = New-Variant -Name 'M1' `
  -Find  '$unhealthy = @($rows | Where-Object { -not $_.healthy -and -not ($_.state_after -eq ''down'' -and ($NoLaunch -or $ReportOnly)) })' `
  -Replace '$unhealthy = @($rows | Where-Object { $_.state_after -eq ''down'' })'
$r1 = Invoke-Watchdog -Variant $m1 -Mode 'stuck-permanent'
Assert 'M1 liveness-only verdict is CAUGHT' ($r1.ExitCode -ne 2) `
  'M1 still exited 2 -- arm B does not actually depend on the health verdict'

# M2: detect, then ignore. The DOWN-only watchdog restated.
$m2 = New-Variant -Name 'M2' `
  -Find  '$stuck = @($before | Where-Object { $_.state -ne ''down'' -and -not $_.healthy })' `
  -Replace '$stuck = @()'
$r2 = Invoke-Watchdog -Variant $m2 -Mode 'stuck-recoverable'
Assert 'M2 stuck-never-actioned is CAUGHT' ($r2.ExitCode -ne 0) `
  'M2 still exited 0 -- a recoverable slot passed without being repaired'

# M3: answer from stale data. The re-probe is what turns "we tried" into
# "it works now"; without it the verdict describes the past.
$m3 = New-Variant -Name 'M3' `
  -Find  '  $confirm = Get-SlotVerdict' `
  -Replace '  $confirm = $before'
$r3 = Invoke-Watchdog -Variant $m3 -Mode 'stuck-recoverable'
Assert 'M3 missing confirming re-probe is CAUGHT' ($r3.ExitCode -ne 0) `
  'M3 still exited 0 -- arm C passes without a fresh probe'

# M4: the #347 failure, one file over. Body correct, exit code discarded.
$m4 = New-Variant -Name 'M4' `
  -Find  "  } | ConvertTo-Json -Depth 5`r`n  exit `$exitCode" `
  -Replace "  } | ConvertTo-Json -Depth 5`r`n  exit 0"
$r4 = Invoke-Watchdog -Variant $m4 -Mode 'stuck-permanent' -ExtraArgs @('-Json')
Assert 'M4 -Json discarding the verdict is CAUGHT' ($r4.ExitCode -ne 2) `
  'M4 still exited 2 -- the -Json exit code is not actually asserted'

# C1: control. A cosmetic message change must NOT break the suite, otherwise
# "the mutants all failed" would prove only that the file is fragile.
$c1 = New-Variant -Name 'C1' `
  -Find  'PHASE 1  assessing slot health' `
  -Replace 'PHASE 1  checking slot health'
$rc1 = Invoke-Watchdog -Variant $c1 -Mode 'stuck-recoverable'
Assert 'C1 control (cosmetic edit) still passes' ($rc1.ExitCode -eq 0) `
  "control failed (exit=$($rc1.ExitCode)) -- the suite is testing wording, not behaviour"

Write-Host ''
Write-Host ("{0} passed, {1} failed" -f $script:Pass, $script:Fail) -ForegroundColor $(if ($script:Fail) { 'Red' } else { 'Green' })

if (-not $KeepTemp) { Remove-Item $tempRoot -Recurse -Force -ErrorAction SilentlyContinue }
if ($script:Fail -gt 0) { exit 1 }
exit 0
