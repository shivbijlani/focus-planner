<#
  mutcheck-deploy-verdict.ps1 -- proves the deploy verdict says which fact fired (GH #668).

  THE FALSE ALARM

  `auto-deploy-plugin.ps1` exits 2 when ANY of four independent facts needs a human:

      escalate      a live fix refused on consecutive cycles
      -not verified a file on the ref is still absent from the installed tree
      oaHomeExit    the OA home sync could not finish clean
      checkoutExit  the BRIDGE CHECKOUT is dirty or not on the ref

  Only the first three are about DEPLOYMENT. The fourth is about a third working tree that
  this script fast-forwards but does not deploy into. They shared one exit code and one
  sentence -- "merged code may not be running" -- so a dirty checkout was reported, live and
  to every coordinator for days, as a deployment failure while both copied targets read
  `verified-current True`, residual drift 0, `0 to write, 283 already current`.

  The code WAS installed and running. The only true fact was that another session had
  uncommitted supervisor work in the shared checkout, which the script rightly refused to
  fast-forward over.

  WHY THE QUIET DIRECTION IS THE DANGEROUS ONE, AND IS ARMED HARDEST

  This change makes an alarm quieter, so the risk is not the false positive it removes --
  it is silencing the real one. A deploy that genuinely did not land must still say so, in
  the same words, with the same exit code. Every arm below therefore comes in a pair: the
  benign case must NOT claim a deployment failure, and the genuine case must still claim it.

  An alarm that is wrong this reliably trains its readers to discount it, and it is the same
  sentence that has to be believed on the day the deploy really has failed. That is the
  whole argument for the change, and it is also the reason it must not go one step further.

  HERMETIC-ISH: drives the REAL script with -WhatIf, so nothing is written and no state is
  recorded. It reads the live machine (that is the subject), and mutates a copy in TEMP to
  force the failure branch rather than breaking a real deploy.

  Exit 0 = every arm agreed.
#>
[CmdletBinding()]
param([string]$ScriptPath)

$ErrorActionPreference = 'Stop'
if (-not $ScriptPath) { $ScriptPath = Join-Path $PSScriptRoot 'auto-deploy-plugin.ps1' }
if (-not (Test-Path $ScriptPath)) { throw "auto-deploy-plugin.ps1 not found at $ScriptPath" }

$script:PsExe = if ($PSVersionTable.PSEdition -eq 'Core') { (Get-Process -Id $PID).Path } else { 'powershell' }
$utf8 = New-Object Text.UTF8Encoding($false)
$root = Join-Path ([IO.Path]::GetTempPath()) ("oa-668-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $root -Force | Out-Null

$script:pass = 0
$script:fail = 0
function Assert([bool]$ok, [string]$name, [string]$why, [string]$detail = '') {
  if ($ok) { Write-Host "  PASS  $name  -- $why"; $script:pass++ }
  else {
    Write-Host "  FAIL  $name  -- $why" -ForegroundColor Red
    if ($detail) { Write-Host ("        got: " + $detail) -ForegroundColor DarkGray }
    $script:fail++
  }
}

$srcBytes = [IO.File]::ReadAllBytes($ScriptPath)
$src = [IO.File]::ReadAllText($ScriptPath)

# CAN THIS HOST RUN THE SUBJECT AT ALL?
#
# auto-deploy-plugin.ps1 deploys into a real OA home and a real installed-plugin tree, and
# its defaults are built from %USERPROFILE% and %LOCALAPPDATA%. Off Windows those are null,
# and `Join-Path` with a null root is a binding error, so the script dies before printing
# anything -- including the verdict these arms are about.
#
# The SHAPE arms below read the source and are host-independent, so they still run
# everywhere and are the ones that would catch the defect returning. The behavioural arms
# are declared SKIP with a printed reason rather than being faked or quietly passing: a
# skipped arm counted as a pass is the false green this suite exists to detect.
$script:CanRunSubject = ($env:OS -eq 'Windows_NT') -or ($PSVersionTable.Platform -eq 'Win32NT') -or ($null -eq $PSVersionTable.Platform)

Write-Host ''
Write-Host 'SHAPE -- the verdict must be a separate fact from "does a human need to look?"'

# Asserted against the SOURCE, not only behaviour: these two questions being one variable
# is the defect itself, so the separation has to be structural rather than incidental.
Assert ($src -match '\$deploymentOk\s*=') 'SPLIT' 'a deployment-only verdict exists, distinct from needsAttention' ''
Assert ($src -match '\$deploymentOk\s*=\s*\$verified\s*-and') 'SCOPE' 'and it is built from the copied targets' ''
Assert ($src -notmatch '\$deploymentOk\s*=[^\r\n]*checkoutExit') 'EXCLUDES' 'while deliberately EXCLUDING the bridge checkout, which it does not deploy into' ''
Assert ($src -match 'deploymentOk\s*=\s*\$deploymentOk') 'JSON' 'and it is exposed in the JSON a consumer can quote' ''

Write-Host ''
Write-Host 'BENIGN -- a dirty third checkout must not be called a deployment failure'

if (-not $script:CanRunSubject) {
  Write-Host '  SKIP  BENIGN / GENUINE  -- auto-deploy needs a real OA home and installed tree'
  Write-Host '        (%USERPROFILE% / %LOCALAPPDATA% are null off Windows, so the subject cannot start).'
  Write-Host '        The SHAPE arms above are host-independent and did run.'
  Write-Host ''
  if ($script:fail -gt 0) {
    Write-Host ("FAILED: {0} arm(s) disagreed, {1} passed." -f $script:fail, $script:pass) -ForegroundColor Red
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
    exit 1
  }
  Write-Host ("OK: {0} structural arm(s) agreed; behavioural arms skipped on this host." -f $script:pass) -ForegroundColor Green
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
  exit 0
}

function Run([string]$path) {
  # A GENEROUS BUDGET, on purpose. The default 60s is tuned for the nightly run, and on a
  # cold git object cache this machine legitimately exceeds it -- measured 32s, 35s and 62s
  # on consecutive runs of the same command. A budget expiry aborts BEFORE the verdict is
  # printed, so an arm that happened to race a slow run would report "never reached the
  # verdict" and prove nothing, at random. That is a flaky arm, which is worse than no arm:
  # it trains its reader to re-run until green.
  #
  # The budget is not what is under test here; the verdict wording is. So it is raised out
  # of the way rather than left to chance.
  $argv = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $path, '-WhatIf',
            '-BudgetSeconds', '600', '-FetchBudgetSeconds', '120')
  $so = Join-Path $root ('o-' + [guid]::NewGuid().ToString('N').Substring(0, 6) + '.txt')
  $se = "$so.err"
  $p = Start-Process -FilePath $script:PsExe -ArgumentList $argv -NoNewWindow -Wait -PassThru `
                     -RedirectStandardOutput $so -RedirectStandardError $se
  $out = ''
  foreach ($f in @($so, $se)) { if (Test-Path $f) { $out += (Get-Content $f -Raw -ErrorAction SilentlyContinue) } }
  return [pscustomobject]@{ out = "$out"; code = $p.ExitCode }
}
function D($r) {
  $o = ($r.out -replace '\s+', ' ')
  if ($o.Length -gt 260) { $o = $o.Substring(0, 260) + '...' }
  return "exit=$($r.code) :: $o"
}

$live = Run $ScriptPath
# The live machine may legitimately be mid-deploy or time-bounded out; only assert when the
# run actually reached the verdict. A harness that asserts on an unreached branch is the
# vacuous-arm failure this suite exists to avoid, so it says so instead of passing.
if ($live.out -match 'DEPLOYMENT OK') {
  Assert ($live.out -notmatch 'DEPLOYMENT NOT VERIFIED') 'BENIGN' 'a healthy deploy does not also print the failure sentence' (D $live)
  Assert ($live.out -match 'merged code IS installed') 'BENIGN2' 'and states plainly that the code is installed' (D $live)
  if ($live.code -ne 0) {
    Assert ($live.out -match 'ATTENTION is about the BRIDGE CHECKOUT') 'POINTS' 'exit 2 with a healthy deploy names the checkout as the reason' (D $live)
  }
}
else {
  Write-Host '  SKIP  BENIGN  -- this machine did not reach the verdict (budget or real drift); nothing to assert'
  Write-Host ('        ' + (D $live)) -ForegroundColor DarkGray
}

Write-Host ''
Write-Host 'GENUINE -- a real deploy failure must still say so, in the same words'

# THE ARM THAT MATTERS. This change makes an alarm quieter; the way it could do harm is by
# silencing the true one.
#
# Mutated IN PLACE rather than as a copy in TEMP, and restored in a `finally`. A copy
# cannot resolve its sibling helpers (deploy-installed-plugin.ps1, ref-history-index.mjs
# are found beside the script), so it dies before reaching the verdict and the arm proves
# nothing -- which is exactly the vacuous arm this suite exists to avoid. The restore is
# unconditional so an interrupted run cannot leave a forced failure on disk.
$forced = $src.Replace(
  '$deploymentOk = $verified -and ($oaHomeExit -eq 0) -and ($escalate.Count -eq 0)',
  '$deploymentOk = $false')
if ($forced -eq $src) { throw 'anchor not found: the deploymentOk assignment moved' }

$bad = $null
try {
  # The forced text is written with the SUBJECT'S OWN encoding, and the restore puts the
  # ORIGINAL BYTES back rather than re-encoding the string.
  #
  # Measured while building this: restoring via WriteAllText with a no-BOM encoder silently
  # stripped auto-deploy-plugin.ps1's UTF-8 BOM. That file is comment-only non-ASCII today,
  # so nothing broke -- but a BOM-less .ps1 containing non-ASCII is decoded as Windows-1252
  # by the PowerShell 5.1 engine BEFORE the script runs, which is the exact hazard
  # ps1-encoding-sweep exists to catch. It caught this. A test harness that corrupts its own
  # subject while "restoring" it is the defect wearing the harness's clothes.
  $enc = New-Object Text.UTF8Encoding($true)
  [IO.File]::WriteAllText($ScriptPath, $forced, $enc)
  $bad = Run $ScriptPath
}
finally {
  [IO.File]::WriteAllBytes($ScriptPath, $srcBytes)
}
# Prove the restore worked before trusting anything else -- a suite that leaves the subject
# mutated, or subtly re-encoded, is worse than one that fails. Compared as BYTES so an
# encoding change cannot pass as identical text.
$restoredBytes = [IO.File]::ReadAllBytes($ScriptPath)
$identical = ($restoredBytes.Length -eq $srcBytes.Length)
if ($identical) {
  for ($i = 0; $i -lt $srcBytes.Length; $i++) {
    if ($restoredBytes[$i] -ne $srcBytes[$i]) { $identical = $false; break }
  }
}
Assert $identical 'RESTORED' 'the subject is byte-identical after the forced-failure arm, BOM included' ''

if ($bad.out -match 'DEPLOYMENT') {
  Assert ($bad.out -match 'DEPLOYMENT NOT VERIFIED') 'GENUINE' 'a failed deployment still prints the original alarm' (D $bad)
  Assert ($bad.out -match 'merged code may not be running') 'WORDS' 'and keeps the exact sentence consumers watch for' (D $bad)
  Assert ($bad.code -ne 0) 'EXIT' 'and still exits non-zero' (D $bad)
}
else {
  Assert $false 'GENUINE' 'the forced-failure run never reached the verdict -- arm proved nothing' (D $bad)
}

Write-Host ''
if ($script:fail -gt 0) {
  Write-Host ("FAILED: {0} arm(s) disagreed, {1} passed." -f $script:fail, $script:pass) -ForegroundColor Red
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
  exit 1
}
Write-Host ("OK: {0} arms agreed. The benign case is quiet and the real alarm is unchanged." -f $script:pass) -ForegroundColor Green
Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
exit 0
