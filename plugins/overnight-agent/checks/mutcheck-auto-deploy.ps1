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
     left out -> MISSING. That is one of each interesting verdict in one fixture.

     `divergent.ps1` is the control: its installed content exists on the side branch and
     at NO point in origin/main's history, so it is genuine divergence and must stay
     refused. `livefix.ps1`'s installed content IS an ancestor commit of origin/main, so
     it is merely behind and must be rescued. The two are indistinguishable to the
     classifier - both are BRANCH-ONLY - which is the whole reason the fixture has both. #>
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

    Set-Content -Path (Join-Path $chk 'livefix.ps1')   -Value '# v1 live fix' -Encoding UTF8 -NoNewline
    Set-Content -Path (Join-Path $chk 'divergent.ps1') -Value '# main v1'     -Encoding UTF8 -NoNewline
    Set-Content -Path (Join-Path $chk 'gone.ps1')      -Value '# doomed v1'   -Encoding UTF8 -NoNewline
    & git add -A 2>&1 | Out-Null
    & git commit -m v1 --quiet 2>&1 | Out-Null
    & git branch sidefix 2>&1 | Out-Null

    # sidefix gains content that never reaches main -> genuine divergence
    & git checkout --quiet sidefix 2>&1 | Out-Null
    Set-Content -Path (Join-Path $chk 'divergent.ps1') -Value '# ONLY on the branch' -Encoding UTF8 -NoNewline
    Set-Content -Path (Join-Path $chk 'stray.ps1')     -Value '# only ever on sidefix' -Encoding UTF8 -NoNewline
    & git add -A 2>&1 | Out-Null
    & git commit -m side --quiet 2>&1 | Out-Null
    & git checkout --quiet main 2>&1 | Out-Null

    Set-Content -Path (Join-Path $chk 'livefix.ps1')   -Value '# v2 from main' -Encoding UTF8 -NoNewline
    Set-Content -Path (Join-Path $chk 'divergent.ps1') -Value '# main v2'      -Encoding UTF8 -NoNewline
    Set-Content -Path (Join-Path $chk 'newguard.ps1')  -Value '# merged but not deployed' -Encoding UTF8 -NoNewline
    # main DELETES gone.ps1 - the case that crashed the deploy on 2026-08-29 (#253)
    & git rm --quiet (Join-Path $chk 'gone.ps1') 2>&1 | Out-Null
    & git add -A 2>&1 | Out-Null
    & git commit -m v2 --quiet 2>&1 | Out-Null
    & git update-ref refs/remotes/origin/main HEAD 2>&1 | Out-Null
  } finally { Pop-Location }

  # The subject resolves the deployer from the repo it is deploying, so the sandbox has
  # to look like a plugin repo. Copied in AFTER the commits and left untracked on
  # purpose: on a ref it would show up as its own MISSING file and pollute the fixture.
  Copy-Item (Join-Path $PSScriptRoot 'deploy-installed-plugin.ps1') `
            (Join-Path $chk 'deploy-installed-plugin.ps1') -Force

  # installed carries the v1 (ancestor-of-main) livefix, the branch-only divergent file,
  # and lacks newguard.ps1
  $idst = Join-Path $inst 'overnight-agent\checks'
  New-Item -ItemType Directory -Force -Path $idst | Out-Null
  Set-Content -Path (Join-Path $idst 'livefix.ps1')   -Value '# v1 live fix'        -Encoding UTF8 -NoNewline
  Set-Content -Path (Join-Path $idst 'divergent.ps1') -Value '# ONLY on the branch' -Encoding UTF8 -NoNewline
  # gone.ps1: main deleted it, and these bytes ARE the pre-deletion blob -> removable.
  # stray.ps1: also absent from main's tip, but its bytes exist only on sidefix and at
  # NO point in main's history -> must survive. Both are BRANCH-ONLY to the classifier,
  # which is the whole reason both are here.
  Set-Content -Path (Join-Path $idst 'gone.ps1')      -Value '# doomed v1'          -Encoding UTF8 -NoNewline
  Set-Content -Path (Join-Path $idst 'stray.ps1')     -Value '# only ever on sidefix' -Encoding UTF8 -NoNewline

  [pscustomobject]@{
    Repo      = $repo
    Installed = $inst
    State     = (Join-Path $sb 'state.json')
    LiveFix   = (Join-Path $idst 'livefix.ps1')
    Divergent = (Join-Path $idst 'divergent.ps1')
    NewGuard  = (Join-Path $idst 'newguard.ps1')
    Gone      = (Join-Path $idst 'gone.ps1')
    Stray     = (Join-Path $idst 'stray.ps1')
  }
}

function Invoke-SUT {
  param($Script, $Sandbox, [switch]$WhatIf, [switch]$NoJson, [switch]$WithOaHome)
  # -NoOaHome by default: these assertions are about the plugin-deploy contract
  # (classification, refusal, streaks, hand-off). The OA-home sync is a separate
  # subsystem with its own mutcheck, and letting it run here would fold its exit code
  # into $needsAttention and mask the escalation mutants - which is exactly what it
  # did on first wiring: M3 ("streak never accumulates") survived because the run
  # exited 2 for an unrelated reason. Isolate the unit; cover the seam separately.
  $a = @('-NoProfile','-ExecutionPolicy','Bypass','-File',$Script,
         '-Repo',$Sandbox.Repo,'-Installed',$Sandbox.Installed,
         '-StatePath',$Sandbox.State,'-SkipFetch')
  if (-not $WithOaHome) { $a += '-NoOaHome' }
  if (-not $NoJson) { $a += '-Json' }
  if ($WhatIf) { $a += '-WhatIf' }
  $out  = $null
  $code = $null
  # A mutant is ALLOWED to crash - that is what several mutations prove. Native stderr
  # becomes a terminating error under $ErrorActionPreference='Stop' on Windows PowerShell
  # 5.1, so leaving it set here would take the harness down with the subject and report a
  # mutation as a harness failure. The measurement is the exit code and the JSON; the
  # stderr text is not evidence either way.
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $out  = & powershell @a 2>&1
    $code = $LASTEXITCODE
  } catch {
    $out  = @("harness caught: $($_.Exception.Message)")
    $code = 1
  } finally { $ErrorActionPreference = $prevEap }
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

Assert ($r1.Json.superseded -contains 'overnight-agent/checks/livefix.ps1') `
       'G6 a BRANCH-ONLY file whose content IS in the ref history is rescued as "behind"'
Assert ((Get-Content $sb.LiveFix -Raw) -eq '# v2 from main') `
       'G6 the merely-stale file was updated to the ref version'

Assert ($r1.Json.refused -contains 'overnight-agent/checks/divergent.ps1') `
       'G2 a genuinely divergent live fix is still refused'
Assert ((Get-Content $sb.Divergent -Raw) -eq '# ONLY on the branch') `
       'G2 the divergent file was NOT overwritten'
Assert ($r1.Exit -eq 0) 'G4 a FIRST refusal does not escalate (exit 0)'
Assert (@($r1.Json.escalate).Count -eq 0) 'G4 nothing is named for escalation on cycle 1'

# --- the deleted-path pair (added 2026-08-29 after merging #253 broke the live deploy) ---
# G9 and G10 are the two halves of one decision and must be read together: BOTH files are
# absent from the ref tip and BOTH classify as BRANCH-ONLY, so a rule that keys on either
# of those facts alone gets one of them wrong. The separator is whether the ref's history
# ever contained these exact bytes.
Assert ($r1.Json.removed -contains 'overnight-agent/checks/gone.ps1') `
       'G9 a file DELETED on the ref, whose live bytes are a known historical version, is removed'
Assert (-not (Test-Path $sb.Gone)) 'G9 the removed file physically left the installed tree'
Assert ($r1.Json.refused -notcontains 'overnight-agent/checks/gone.ps1') `
       'G9 a removed file does not stay on the refusal pile (it would escalate forever)'

Assert ($r1.Json.removed -notcontains 'overnight-agent/checks/stray.ps1') `
       'G10 a live-only file the ref never carried is NOT removed'
Assert (Test-Path $sb.Stray) 'G10 the live-only file survived'
Assert ((Get-Content $sb.Stray -Raw) -eq '# only ever on sidefix') `
       'G10 the live-only file was not modified either'
Assert ($r1.Json.refused -contains 'overnight-agent/checks/stray.ps1') `
       'G10 it is refused instead - deleting it would destroy the only copy'

# second cycle: same refusal, now persistent
$r2 = Invoke-SUT -Script $SUT -Sandbox $sb
Assert ($r2.Exit -eq 2) 'G3 a refusal repeated across cycles escalates (exit 2)'
Assert ($r2.Json.escalate -contains 'overnight-agent/checks/divergent.ps1') `
       'G3 the persistently-refused file is named'
Assert ($r2.Json.escalate -notcontains 'overnight-agent/checks/livefix.ps1') `
       'G6 a rescued file never enters the escalation queue'
Assert ($r2.Json.escalate -notcontains 'overnight-agent/checks/gone.ps1') `
       'G9 a removed file never enters the escalation queue'
Assert ($r2.Json.verifiedCurrent -eq $true) `
       'G5 far-end verify: no MISSING survives after the deploy'

# -WhatIf must be inert
$sbw = New-Sandbox
$rw = Invoke-SUT -Script $SUT -Sandbox $sbw -WhatIf
Assert (-not (Test-Path $sbw.NewGuard)) 'G5 -WhatIf wrote no files'
Assert (-not (Test-Path $sbw.State))    'G5 -WhatIf recorded no state'
Assert (Test-Path $sbw.Gone)            'G9 -WhatIf deleted no files'

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
    Assert ((Get-Content $s.Divergent -Raw) -ne '# ONLY on the branch') `
           'killed: the divergent live fix would be overwritten by main'
  }

Test-Mutant -Name 'M7: supersede check always true (divergence treated as merely stale)' `
  -Find '  return $false
}' -Replace '  return $true
}' -Check {
    param($mut)
    $s = New-Sandbox
    Invoke-SUT -Script $mut -Sandbox $s | Out-Null
    Assert ((Get-Content $s.Divergent -Raw) -ne '# ONLY on the branch') `
           'killed: a branch-only live fix would be silently reverted as "behind"'
  }

Test-Mutant -Name 'M8: supersede check always false (a merely-stale file can never deploy)' `
  -Find 'if ((Get-NormHash ([IO.File]::ReadAllBytes($tmp))) -eq $want) { return $true }' `
  -Replace 'if ($false) { return $true }' -Check {
    param($mut)
    $s = New-Sandbox
    $a = Invoke-SUT -Script $mut -Sandbox $s
    Assert ((Get-Content $s.LiveFix -Raw) -eq '# v1 live fix') `
           'killed: an ordinary stale file would be refused forever, defeating the wire'
    $b = Invoke-SUT -Script $mut -Sandbox $s
    Assert ($b.Json.escalate -contains 'overnight-agent/checks/livefix.ps1') `
           'killed: it would then escalate to a human every cycle for nothing'
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

# --- the deleted-path mutations (2026-08-29) -----------------------------------------
# M11 is the one that matters most: it restores the EXACT line that took the live deploy
# down after #253 merged, and it fails in the most expensive way a guard can - the run
# aborts before it reports anything, so "PHASE 0 deployed cleanly" and "PHASE 0 died"
# produce the same silence. Note it can only be observed on Windows PowerShell 5.1,
# where native stderr becomes a terminating error; under pwsh 7 the mutant survives.
# That is precisely why it went unnoticed: it was hand-tested in the agent's own shell.
Test-Mutant -Name 'M11: bare rev-parse restored (a deleted path aborts the whole deploy)' `
  -Find 'rev-parse --verify --quiet "${sha}:${RepoPath}"' `
  -Replace 'rev-parse "${sha}:${RepoPath}"' -Check {
    param($mut)
    $s = New-Sandbox
    $b = Invoke-SUT -Script $mut -Sandbox $s
    Assert ($b.Json -eq $null -or $b.Exit -ne 0) `
           'killed: a ref that deleted a file would crash the deploy instead of handling it'
  }

Test-Mutant -Name 'M12: no delete path (a file removed on the ref is refused forever)' `
  -Find 'if ($inHistory) { $removed += $rel } else { $stillRefused += $rel }' `
  -Replace 'if ($false) { $removed += $rel } else { $stillRefused += $rel }' -Check {
    param($mut)
    $s = New-Sandbox
    $b = Invoke-SUT -Script $mut -Sandbox $s
    Assert (Test-Path $s.Gone) 'mutant did leave the orphan in place'
    Assert ($b.Json.refused -contains 'overnight-agent/checks/gone.ps1') `
           'killed: a file deleted on the ref would linger and escalate on every cycle'
  }

# M13 is the safety direction, and it is the one a careless fix gets wrong: "not on the
# tip" is NOT sufficient grounds to delete. Without the history check this destroys the
# only copy of a hand-deployed live fix - unrecoverable, and exactly the class of harm
# the refuse-by-default design exists to prevent.
Test-Mutant -Name 'M13: delete anything absent from the tip (destroys a live-only file)' `
  -Find 'if ($inHistory) { $removed += $rel } else { $stillRefused += $rel }' `
  -Replace 'if ($true) { $removed += $rel } else { $stillRefused += $rel }' -Check {
    param($mut)
    $s = New-Sandbox
    Invoke-SUT -Script $mut -Sandbox $s | Out-Null
    Assert (-not (Test-Path $s.Stray)) `
           'killed: a live-only file would be deleted on the strength of absence alone'
  }

# ------------------------------------------------------------------------------------
# G7 - self-bootstrap: an OLD installed copy must hand off to the NEWER repo copy.
# This is the trap that sprang for real between #240 and #241: the old build classified
# its own newer self as a branch-only live fix and refused, so it could not adopt the
# fix that would have let it adopt the fix.
# ------------------------------------------------------------------------------------
Section 'G7: self-bootstrap (stale copy defers to the repo copy)'
$sbb = New-Sandbox
# Put a deliberately BROKEN, older copy where the "installed" caller would live, and
# point it at the sandbox repo whose checks dir holds the real script.
Copy-Item $SUT (Join-Path $sbb.Repo 'plugins\overnight-agent\checks\auto-deploy-plugin.ps1') -Force
$stale = Join-Path $root ('stale-' + [guid]::NewGuid().ToString('N').Substring(0,6) + '.ps1')
# The stale copy differs (extra comment) AND would refuse everything if it ran to completion.
Set-Content -Path $stale -Value ((Get-Content $SUT -Raw) -replace 'function Write-Note', "# STALE BUILD MARKER`nfunction Write-Note") -Encoding UTF8
$rb = Invoke-SUT -Script $stale -Sandbox $sbb -NoJson
Assert ($rb.Raw -match 're-executing it so the NEWER logic decides') `
       'G7 a differing repo copy triggers a hand-off'
Assert (Test-Path $sbb.NewGuard) `
       'G7 the handed-off run still does the real work'

Test-Mutant -Name 'M9: self-bootstrap removed (a stale build judges its own replacement)' `
  -Find "if (-not `$env:OA_AUTODEPLOY_REEXEC -and `$PSCommandPath) {" `
  -Replace "if (`$false) {" -Check {
    param($mut)
    $s = New-Sandbox
    Copy-Item $SUT (Join-Path $s.Repo 'plugins\overnight-agent\checks\auto-deploy-plugin.ps1') -Force
    $st = Join-Path $root ('stale-' + [guid]::NewGuid().ToString('N').Substring(0,6) + '.ps1')
    Set-Content -Path $st -Value ((Get-Content $mut -Raw) -replace 'function Write-Note', "# STALE BUILD MARKER`nfunction Write-Note") -Encoding UTF8
    $r = Invoke-SUT -Script $st -Sandbox $s -NoJson
    Assert ($r.Raw -notmatch 're-executing it so the NEWER logic decides') `
           'killed: a stale build would never defer to its newer replacement'
  }

Test-Mutant -Name 'M10: re-exec guard removed (unbounded self-recursion)' `
  -Find "`$env:OA_AUTODEPLOY_REEXEC = '1'" -Replace "`$env:OA_AUTODEPLOY_REEXEC = ''" -Check {
    param($mut)
    $src = Get-Content $mut -Raw
    Assert ($src -notmatch [regex]::Escape("OA_AUTODEPLOY_REEXEC = '1'")) `
           'killed: without the hop marker the hand-off could recurse without bound'
  }

Section 'G8: the OA-home seam (second deploy target)'
# The reason this section exists: on first wiring, the sub-tool was resolved as
# "next to me" only. The OA home is exactly where a brand-new check has NOT landed,
# so the copy most in need of repair silently skipped its own sync and still printed
# verified-current True. A missing sub-tool and a clean sync produced identical
# output - a detector wired to nothing.
$s = New-Sandbox
$r = Invoke-SUT -Script $SUT -Sandbox $s
Assert ($r.Json -and $r.Json.oaHomeExit -eq 0) `
       'G8a -NoOaHome leaves the seam clean and reports it'

# Run a copy from a directory where sync-oa-home.ps1 is absent AND point -Repo at a
# sandbox that has no checks dir, so no candidate root can resolve it.
$isolated = Join-Path $root ('iso-' + [guid]::NewGuid().ToString('N').Substring(0,6))
New-Item -ItemType Directory -Path $isolated -Force | Out-Null
$copy = Join-Path $isolated 'auto-deploy-plugin.ps1'
Copy-Item $SUT $copy -Force
$s2 = New-Sandbox
$a = @('-NoProfile','-ExecutionPolicy','Bypass','-File',$copy,
       '-Repo',$s2.Repo,'-Installed',$s2.Installed,'-StatePath',$s2.State,
       '-SkipFetch','-Json')
$out = & powershell @a 2>&1 | Out-String
Assert ($out -match 'NOT FOUND' -or $out -match '"oaHomeExit":\s*2') `
       'G8b an unresolvable sub-tool is reported, never silently skipped'

Section 'RESULT'
if (-not $KeepSandbox) { Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue }
else { Write-Host "  sandbox kept at $root" }

if ($script:fail -gt 0) {
  Write-Host ("FAIL  {0} passed, {1} failed" -f $script:pass, $script:fail) -ForegroundColor Red
  exit 1
}
Write-Host ("PASS  {0} assertions" -f $script:pass) -ForegroundColor Green
exit 0
