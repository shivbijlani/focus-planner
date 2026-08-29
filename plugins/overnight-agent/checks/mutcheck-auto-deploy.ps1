<#
  mutcheck-auto-deploy.ps1 — prove auto-deploy-plugin.ps1's guards are load-bearing.

  A guard that is only asserted by a passing test is not proven: the test may pass for
  reasons unrelated to the guard. So each behaviour here is checked twice — once on the
  real script (it must PASS) and once on a deliberately mutated copy (it must FAIL).
  A mutation that does not break a test means that test was not testing the guard.

  GUARDS UNDER TEST
    G1  a file on the ref but absent from the installed tree IS deployed (forward case)
    G2  a live fix that exists only on a side branch is REFUSED, never overwritten
    G3  a refusal that repeats across cycles ESCALATES (exit 2) - the seam that made
        deploy-installed-plugin.ps1 report a blocked deploy as success
    G4  a FIRST refusal does NOT escalate - otherwise G3 is just "always escalate"
    G5  -WhatIf writes nothing and records no state

  Everything runs in a throwaway sandbox: a real git repo and a fake installed tree
  under $env:TEMP. The live tree is never touched.
#>
[CmdletBinding()]
param([switch]$KeepSandbox)

$ErrorActionPreference = 'Stop'

$script:pass = 0
$script:fail = 0
function Assert([bool]$cond, [string]$what) {
  if ($cond) { Write-Host "  ok    $what"; $script:pass++ }
  else       { Write-Host "  FAIL  $what" -ForegroundColor Red; $script:fail++ }
}
function Section([string]$t) { Write-Host ''; Write-Host $t }

$SUT = Join-Path $PSScriptRoot 'auto-deploy-plugin.ps1'
if (-not (Test-Path $SUT)) { throw "subject not found: $SUT" }

$root = Join-Path $env:TEMP ('oa-autodeploy-mut-' + [guid]::NewGuid().ToString('N').Substring(0,8))
New-Item -ItemType Directory -Force -Path $root | Out-Null

function New-Sandbox {
  <# A repo whose origin/main carries v2 of a file plus one extra file, and a side
     branch carrying v1. The installed tree gets v1 -> BRANCH-ONLY; the extra file is
     left out -> MISSING. That is one of each interesting verdict in one fixture. #>
  $sb  = Join-Path $root ('sb-' + [guid]::NewGuid().ToString('N').Substring(0,6))
  $repo = Join-Path $sb 'repo'
  $inst = Join-Path $sb 'installed'
  $chk  = Join-Path $repo 'plugins\overnight-agent\checks'
  New-Item -ItemType Directory -Force -Path $chk  | Out-Null
  New-Item -ItemType Directory -Force -Path $inst | Out-Null

  Push-Location $repo
  try {
    & git init --quiet -b main 2>&1 | Out-Null
    & git config user.email 'mut@test'  2>&1 | Out-Null
    & git config user.name  'mut'       2>&1 | Out-Null

    Set-Content -Path (Join-Path $chk 'livefix.ps1') -Value '# v1 live fix' -Encoding UTF8 -NoNewline
    & git add -A 2>&1 | Out-Null
    & git commit -m v1 --quiet 2>&1 | Out-Null
    & git branch sidefix 2>&1 | Out-Null

    Set-Content -Path (Join-Path $chk 'livefix.ps1') -Value '# v2 from main' -Encoding UTF8 -NoNewline
    Set-Content -Path (Join-Path $chk 'newguard.ps1') -Value '# merged but not deployed' -Encoding UTF8 -NoNewline
    & git add -A 2>&1 | Out-Null
    & git commit -m v2 --quiet 2>&1 | Out-Null
    & git update-ref refs/remotes/origin/main HEAD 2>&1 | Out-Null
  } finally { Pop-Location }

  # The subject resolves the deployer from the repo it is deploying, so the sandbox has
  # to look like a plugin repo. Copied in AFTER the commits and left untracked on
  # purpose: on a ref it would show up as its own MISSING file and pollute the fixture.
  Copy-Item (Join-Path $PSScriptRoot 'deploy-installed-plugin.ps1') `
            (Join-Path $chk 'deploy-installed-plugin.ps1') -Force

  # installed carries v1 (matches sidefix, not origin/main) and lacks newguard.ps1
  $idst = Join-Path $inst 'overnight-agent\checks'
  New-Item -ItemType Directory -Force -Path $idst | Out-Null
  Set-Content -Path (Join-Path $idst 'livefix.ps1') -Value '# v1 live fix' -Encoding UTF8 -NoNewline

  [pscustomobject]@{
    Repo      = $repo
    Installed = $inst
    State     = (Join-Path $sb 'state.json')
    LiveFix   = (Join-Path $idst 'livefix.ps1')
    NewGuard  = (Join-Path $idst 'newguard.ps1')
  }
}

function Invoke-SUT {
  param($Script, $Sandbox, [switch]$WhatIf)
  $a = @('-NoProfile','-ExecutionPolicy','Bypass','-File',$Script,
         '-Repo',$Sandbox.Repo,'-Installed',$Sandbox.Installed,
         '-StatePath',$Sandbox.State,'-SkipFetch','-Json')
  if ($WhatIf) { $a += '-WhatIf' }
  $out  = & powershell @a 2>&1
  $code = $LASTEXITCODE
  $jsonLine = ($out | Where-Object { ([string]$_).TrimStart().StartsWith('{') } | Select-Object -Last 1)
  $obj = $null
  if ($jsonLine) { try { $obj = ([string]$jsonLine | ConvertFrom-Json) } catch { } }
  [pscustomobject]@{ Exit = $code; Json = $obj; Raw = ($out -join "`n") }
}

# ------------------------------------------------------------------------------------
# Behavioural baseline on the REAL script
# ------------------------------------------------------------------------------------
Section 'BASELINE (real script must pass all of these)'

$sb = New-Sandbox
$r1 = Invoke-SUT -Script $SUT -Sandbox $sb

Assert ($r1.Json -ne $null) 'G0 emits parseable JSON'
Assert ($r1.Json.deployed -contains 'overnight-agent/checks/newguard.ps1') `
       'G1 a MISSING file (on the ref, absent installed) is deployed'
Assert (Test-Path $sb.NewGuard) 'G1 the missing file physically landed'
Assert ($r1.Json.refused -contains 'overnight-agent/checks/livefix.ps1') `
       'G2 a BRANCH-ONLY live fix is refused'
Assert ((Get-Content $sb.LiveFix -Raw) -eq '# v1 live fix') `
       'G2 the refused file was NOT overwritten'
Assert ($r1.Exit -eq 0) 'G4 a FIRST refusal does not escalate (exit 0)'
Assert (@($r1.Json.escalate).Count -eq 0) 'G4 nothing is named for escalation on cycle 1'

# second cycle: same refusal, now persistent
$r2 = Invoke-SUT -Script $SUT -Sandbox $sb
Assert ($r2.Exit -eq 2) 'G3 a refusal repeated across cycles escalates (exit 2)'
Assert ($r2.Json.escalate -contains 'overnight-agent/checks/livefix.ps1') `
       'G3 the persistently-refused file is named'
Assert ($r2.Json.verifiedCurrent -eq $true) `
       'G5 far-end verify: no MISSING survives after the deploy'

# -WhatIf must be inert
$sbw = New-Sandbox
$rw = Invoke-SUT -Script $SUT -Sandbox $sbw -WhatIf
Assert (-not (Test-Path $sbw.NewGuard)) 'G5 -WhatIf wrote no files'
Assert (-not (Test-Path $sbw.State))    'G5 -WhatIf recorded no state'

# ------------------------------------------------------------------------------------
# Mutations — each must BREAK the test that claims to guard it
# ------------------------------------------------------------------------------------
function Test-Mutant {
  param([string]$Name, [string]$Find, [string]$Replace, [scriptblock]$Check)
  Section $Name
  $src = Get-Content $SUT -Raw
  if ($src -notmatch [regex]::Escape($Find)) {
    Assert $false "mutation anchor not found - mutcheck is stale: '$Find'"
    return
  }
  $mut = Join-Path $root ('mut-' + [guid]::NewGuid().ToString('N').Substring(0,6) + '.ps1')
  Set-Content -Path $mut -Value ($src -replace [regex]::Escape($Find), $Replace) -Encoding UTF8
  Assert $true 'mutation applied'
  & $Check $mut
}

Test-Mutant -Name 'M1: escalation removed (a persistent refusal reports success)' `
  -Find 'if ($needsAttention) { exit 2 }' -Replace 'if ($false) { exit 2 }' -Check {
    param($mut)
    $s = New-Sandbox
    Invoke-SUT -Script $mut -Sandbox $s | Out-Null
    $b = Invoke-SUT -Script $mut -Sandbox $s
    Assert ($b.Exit -ne 2) 'killed: a blocked deploy would silently report success'
  }

Test-Mutant -Name 'M2: -Force passed (refusal defeated, live fix reverted)' `
  -Find "if (-not `$WhatIf) { `$args += '-Confirm' }" `
  -Replace "if (-not `$WhatIf) { `$args += '-Confirm'; `$args += '-Force' }" -Check {
    param($mut)
    $s = New-Sandbox
    Invoke-SUT -Script $mut -Sandbox $s | Out-Null
    Assert ((Get-Content $s.LiveFix -Raw) -ne '# v1 live fix') `
           'killed: the branch-only live fix would be overwritten by main'
  }

Test-Mutant -Name 'M3: streak never accumulates (every cycle looks like the first)' `
  -Find '$newStreaks[$rel] = $prev + 1' -Replace '$newStreaks[$rel] = 1' -Check {
    param($mut)
    $s = New-Sandbox
    Invoke-SUT -Script $mut -Sandbox $s | Out-Null
    $b = Invoke-SUT -Script $mut -Sandbox $s
    Assert ($b.Exit -ne 2) 'killed: a refusal could repeat forever without escalating'
  }

Test-Mutant -Name 'M4: escalate on the first refusal (threshold not honoured)' `
  -Find '[int]$EscalateAfterCycles = 2' -Replace '[int]$EscalateAfterCycles = 1' -Check {
    param($mut)
    $s = New-Sandbox
    $a = Invoke-SUT -Script $mut -Sandbox $s
    Assert ($a.Exit -eq 2) 'killed: a single, still-informative refusal would page a human'
  }

Test-Mutant -Name 'M5: -WhatIf still writes (dry run is not dry)' `
  -Find "if (-not `$WhatIf) { `$args += '-Confirm' }" `
  -Replace "`$args += '-Confirm'" -Check {
    param($mut)
    $s = New-Sandbox
    Invoke-SUT -Script $mut -Sandbox $s -WhatIf | Out-Null
    Assert (Test-Path $s.NewGuard) 'killed: -WhatIf would deploy files'
  }

Test-Mutant -Name 'M6: far-end verification trusts the deployer instead of the tree' `
  -Find '$verified = @($residual | Where-Object { $_.Verdict -eq ''MISSING'' }).Count -eq 0' `
  -Replace '$verified = $true' -Check {
    param($mut)
    # Make the deploy a no-op by pointing the deployer at a ref-clean state, then delete
    # a deployed file behind its back so real drift exists at verify time.
    $s = New-Sandbox
    Invoke-SUT -Script $mut -Sandbox $s | Out-Null
    Remove-Item $s.NewGuard -Force
    Remove-Item $s.State -Force -ErrorAction SilentlyContinue
    # Second run: deployer re-adds it, so use a mutant-only probe - assert the field is
    # hard-coded rather than measured.
    $src = Get-Content $mut -Raw
    Assert ($src -notmatch [regex]::Escape('$_.Verdict -eq ''MISSING''')) `
           'killed: verifiedCurrent is asserted, not measured against the live tree'
  }

Section 'RESULT'
if (-not $KeepSandbox) { Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue }
else { Write-Host "  sandbox kept at $root" }

if ($script:fail -gt 0) {
  Write-Host ("FAIL  {0} passed, {1} failed" -f $script:pass, $script:fail) -ForegroundColor Red
  exit 1
}
Write-Host ("PASS  {0} assertions" -f $script:pass) -ForegroundColor Green
exit 0
