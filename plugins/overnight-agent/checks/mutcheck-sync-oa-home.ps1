<#
  mutcheck-sync-oa-home.ps1 - proves sync-oa-home.ps1's guards are load-bearing.

  A guard that is never observed failing is indistinguishable from a comment. Each
  mutant below deletes exactly ONE guard and must FLIP the case that guard protects.
  If a mutant still passes, that guard is decorative and the test is worthless.

  The two that matter most, and why:

    M2 (refusal)  A repair tool that blind-copies the ref over the live tree REVERTS
                  live fixes while reporting success. This is the single failure that
                  would make sync-oa-home.ps1 worse than doing nothing, so the refusal
                  of DIVERGENT content is the property the whole script exists to have.

    M1 (behind)   Without the historical-blob walk everything looks DIVERGENT, so the
                  tool refuses forever and the gap it was written to close stays open.
                  That is exactly how "differs from a git ref" failed in #196 - a
                  detector that can never say "safe" is a detector nobody can act on.

  Runs entirely in $env:TEMP against synthetic git repos. Touches no live state:
  -OaHome, -Repo, -StatePath and -SkipFetch are all real parameters.
#>
[CmdletBinding()]
param([switch]$KeepFixtures)

$ErrorActionPreference = 'Stop'
$script:pass = 0
$script:fail = 0

function Ok   { param([string]$n, [string]$m = '') $script:pass++; Write-Host ("  ok    {0} {1}" -f $n, $m) }
function Bad  { param([string]$n, [string]$m = '') $script:fail++; Write-Host ("  FAIL  {0} {1}" -f $n, $m) -ForegroundColor Red }
function Assert { param([bool]$c, [string]$n, [string]$m = '') if ($c) { Ok $n $m } else { Bad $n $m } }

$Script = Join-Path $PSScriptRoot 'sync-oa-home.ps1'
if (-not (Test-Path $Script)) { throw "subject not found: $Script" }

$root = Join-Path $env:TEMP ("mutcheck-sync-oa-home-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $root -Force | Out-Null

function New-Fixture {
  <#
    Builds a synthetic repo with a two-commit history for probe.ps1 (v1 -> v2),
    a second file for the ambiguity case, and an OA home seeded by the caller.
  #>
  param([string]$Name)
  $base = Join-Path $root $Name
  $repo = Join-Path $base 'repo'
  $home_ = Join-Path $base 'oahome'
  New-Item -ItemType Directory -Path (Join-Path $repo 'plugins\overnight-agent\checks') -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $repo 'plugins\overnight-agent\skills\overnight-agent') -Force | Out-Null
  New-Item -ItemType Directory -Path $home_ -Force | Out-Null

  Push-Location $repo
  try {
    & git init --quiet 2>&1 | Out-Null
    & git config user.email 'mutcheck@example.invalid' | Out-Null
    & git config user.name  'mutcheck' | Out-Null
    & git config core.autocrlf false | Out-Null

    $probe = 'plugins\overnight-agent\checks\probe.ps1'
    Set-Content -LiteralPath (Join-Path $repo $probe) -Value "# probe v1`nWrite-Output 'v1'" -NoNewline -Encoding utf8
    & git add -A 2>&1 | Out-Null
    & git commit --quiet -m 'v1' 2>&1 | Out-Null

    Set-Content -LiteralPath (Join-Path $repo $probe) -Value "# probe v2`nWrite-Output 'v2'" -NoNewline -Encoding utf8
    & git add -A 2>&1 | Out-Null
    & git commit --quiet -m 'v2' 2>&1 | Out-Null

    # main is the ref under test; create it explicitly so branch naming cannot vary.
    & git branch -f main HEAD 2>&1 | Out-Null
  } finally { Pop-Location }

  return [pscustomobject]@{ Base = $base; Repo = $repo; Home = $home_ }
}

function Add-AmbiguousName {
  param([string]$Repo, [string]$Name)
  Push-Location $Repo
  try {
    Set-Content -LiteralPath (Join-Path $Repo "plugins\overnight-agent\checks\$Name")                      -Value "# A" -NoNewline -Encoding utf8
    Set-Content -LiteralPath (Join-Path $Repo "plugins\overnight-agent\skills\overnight-agent\$Name")       -Value "# B" -NoNewline -Encoding utf8
    & git add -A 2>&1 | Out-Null
    & git commit --quiet -m 'ambiguous' 2>&1 | Out-Null
    & git branch -f main HEAD 2>&1 | Out-Null
  } finally { Pop-Location }
}

function Add-Roster {
  <#
    Gives the fixture a run-sweeps.ps1 carrying a `$Suite` literal, plus the files that
    literal implies. This is what the forward direction reads, so without it the
    required set is empty and no MISSING can exist.

      newsweep.mjs        rostered, imports ./lib-helper.mjs
      lib-helper.mjs      NOT rostered - only reachable through the import closure.
                          This is the postmortem-reviewer -> lib-postmortem shape: a
                          roster can never name it, and shipping the entry point alone
                          produces a file that dies on its first import.
      diagnostic-tool.mjs neither rostered nor imported - the over-deploy control. #>
  param([string]$Repo)
  $chk = Join-Path $Repo 'plugins\overnight-agent\checks'
  $roster = @"
# synthetic roster
`$Suite = @(
  @{ n = 'newsweep'; bridge = `$false }
)
"@
  Set-Content -LiteralPath (Join-Path $chk 'run-sweeps.ps1') -Value $roster -Encoding utf8
  Set-Content -LiteralPath (Join-Path $chk 'newsweep.mjs') -Value "import { helper } from './lib-helper.mjs';`nhelper();" -NoNewline -Encoding utf8
  Set-Content -LiteralPath (Join-Path $chk 'lib-helper.mjs') -Value "export function helper() { return 1; }" -NoNewline -Encoding utf8
  Set-Content -LiteralPath (Join-Path $chk 'diagnostic-tool.mjs') -Value "// one-off, not a standing check" -NoNewline -Encoding utf8
  Push-Location $Repo
  try {
    & git add -A 2>&1 | Out-Null
    & git commit --quiet -m 'roster' 2>&1 | Out-Null
    & git branch -f main HEAD 2>&1 | Out-Null
  } finally { Pop-Location }
}

function Add-Mutcheck {
  <#
    Adds a mutation check that NOTHING points at: it is absent from the `$Suite` roster
    (run-sweeps.ps1 finds mutchecks by GLOBBING THE FLAT HOME, so no roster ever names
    one) and it is imported by nobody (it is an entry point). Before rule 4 it was
    therefore required by nothing, and reached the machine only when a human copied it.

    Both extensions, because the runner globs both -- and the .ps1 half is the half that
    was silently skipped once already (2026-08-27, when the glob was '.mjs'-only). #>
  param([string]$Repo)
  $chk = Join-Path $Repo 'plugins\overnight-agent\checks'
  Set-Content -LiteralPath (Join-Path $chk 'mutcheck-probe.mjs') -Value "// proves probe.ps1's guard is load-bearing" -NoNewline -Encoding utf8
  Set-Content -LiteralPath (Join-Path $chk 'mutcheck-probe.ps1') -Value "# proves the other guard is load-bearing" -NoNewline -Encoding utf8
  Push-Location $Repo
  try {
    & git add -A 2>&1 | Out-Null
    & git commit --quiet -m 'mutchecks' 2>&1 | Out-Null
    & git branch -f main HEAD 2>&1 | Out-Null
  } finally { Pop-Location }
}

function Add-MutcheckSubject {
  <#
    A PowerShell mutation check plus the script it tests. `mutcheck-subject.ps1` names its
    subject the way every real one does -- `Join-Path $PSScriptRoot 'subject-tool.ps1'` --
    which is an edge NO other rule can see: the roster names only sweeps, the import
    closure walks `import` specifiers that exist only in .mjs, and $AlwaysRequired does
    not list it. Rule 4 delivers the guard and leaves the subject behind, and that is not
    a skip: the guard throws and exits 1 the first time the runner globs it.

    `unrelated-tool.ps1` is the narrowness control -- a .ps1 nobody references, which must
    stay out, so rule 5 cannot quietly become "deploy every .ps1 in the repo". #>
  param([string]$Repo)
  $chk = Join-Path $Repo 'plugins\overnight-agent\checks'
  $guard = @'
[CmdletBinding()]
param([string]$ScriptPath)
if (-not $ScriptPath) { $ScriptPath = Join-Path $PSScriptRoot 'subject-tool.ps1' }
if (-not (Test-Path $ScriptPath)) { throw "subject not found at $ScriptPath" }
'@
  Set-Content -LiteralPath (Join-Path $chk 'mutcheck-subject.ps1') -Value $guard -Encoding utf8
  Set-Content -LiteralPath (Join-Path $chk 'subject-tool.ps1') -Value "# the script under test" -NoNewline -Encoding utf8
  Set-Content -LiteralPath (Join-Path $chk 'unrelated-tool.ps1') -Value "# referenced by nobody" -NoNewline -Encoding utf8
  Push-Location $Repo
  try {
    & git add -A 2>&1 | Out-Null
    & git commit --quiet -m 'mutcheck subject' 2>&1 | Out-Null
    & git branch -f main HEAD 2>&1 | Out-Null
  } finally { Pop-Location }
}

function Add-DataDependentSweep {
  <#
    A rostered .mjs that cannot start without a sibling DATA file, referenced the way the
    real ones are -- `join(HERE, 'probe-manifest.json')`. That reference is invisible to
    every other rule: it is not an `import` specifier (rule 2 walks only those), the file
    is not a sweep (no roster names it), not an entry point (not in $AlwaysRequired) and
    not a `mutcheck-*` (rule 4's glob misses it). So it was required by nothing.

    `probe-unused.json` is the narrowness control -- a data file nobody references, which
    must stay out, so rule 6 cannot quietly become "deploy every .json in the repo". #>
  param([string]$Repo)
  $chk = Join-Path $Repo 'plugins\overnight-agent\checks'
  $roster = @"
# synthetic roster
`$Suite = @(
  @{ n = 'datasweep'; bridge = `$false }
)
"@
  Set-Content -LiteralPath (Join-Path $chk 'run-sweeps.ps1') -Value $roster -Encoding utf8
  $sweep = @'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const HERE = dirname(fileURLToPath(import.meta.url))
const MANIFEST = join(HERE, 'probe-manifest.json')
const rows = JSON.parse(readFileSync(MANIFEST, 'utf8'))
console.log(rows.length)
'@
  Set-Content -LiteralPath (Join-Path $chk 'datasweep.mjs') -Value $sweep -Encoding utf8
  Set-Content -LiteralPath (Join-Path $chk 'probe-manifest.json') -Value '[]' -NoNewline -Encoding utf8
  Set-Content -LiteralPath (Join-Path $chk 'probe-unused.json') -Value '{}' -NoNewline -Encoding utf8
  Push-Location $Repo
  try {
    & git add -A 2>&1 | Out-Null
    & git commit --quiet -m 'data-dependent sweep' 2>&1 | Out-Null
    & git branch -f main HEAD 2>&1 | Out-Null
  } finally { Pop-Location }
}

function Invoke-Subject {
  param([string]$ScriptPath, $Fx, [switch]$WhatIf)
  $args = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $ScriptPath,
            '-Ref', 'main', '-Repo', $Fx.Repo, '-OaHome', $Fx.Home,
            '-StatePath', (Join-Path $Fx.Base 'state.json'), '-SkipFetch', '-SkipBackup', '-Json')
  if ($WhatIf) { $args += '-WhatIf' }
  $out = & powershell @args 2>&1 | Out-String
  $json = $null
  # -Json prints the object after the human lines; take the last JSON object.
  $idx = $out.IndexOf('{')
  if ($idx -ge 0) { try { $json = $out.Substring($idx) | ConvertFrom-Json } catch { } }
  return [pscustomobject]@{ Raw = $out; Json = $json; Exit = $LASTEXITCODE }
}

function Get-Class {
  param($Result, [string]$File)
  if (-not $Result.Json) { return '<no-json>' }
  $e = $Result.Json.files | Where-Object { $_.file -eq $File }
  if (-not $e) { return '<absent>' }
  return $e.class
}

Write-Host ''
Write-Host '[baseline] the rule as shipped'

# --- T_BEHIND: live holds an older committed version -> deploy it -------------------
$fx = New-Fixture 'behind'
Set-Content -LiteralPath (Join-Path $fx.Home 'probe.ps1') -Value "# probe v1`nWrite-Output 'v1'" -NoNewline -Encoding utf8
$r = Invoke-Subject $Script $fx
Assert ((Get-Class $r 'probe.ps1') -eq 'BEHIND') 'T_BEHIND' 'older committed version is classified BEHIND'
$after = (Get-Content (Join-Path $fx.Home 'probe.ps1') -Raw)
Assert ($after -match 'v2') 'T_BEHIND_WRITE' 'and is actually updated to the ref'

# --- T_CURRENT: live already matches the ref -> nothing to do -----------------------
$fx = New-Fixture 'current'
Set-Content -LiteralPath (Join-Path $fx.Home 'probe.ps1') -Value "# probe v2`nWrite-Output 'v2'" -NoNewline -Encoding utf8
$r = Invoke-Subject $Script $fx
Assert ((Get-Class $r 'probe.ps1') -eq 'CURRENT') 'T_CURRENT' 'identical content is CURRENT'
Assert ($r.Json.deployed -eq 0) 'T_CURRENT_NOWRITE' 'and nothing is written'

# --- T_DIVERGENT: a live-only fix -> must be REFUSED, never reverted ----------------
$fx = New-Fixture 'divergent'
$liveFix = "# probe v2`nWrite-Output 'v2'`n# HOTFIX applied live, never committed"
Set-Content -LiteralPath (Join-Path $fx.Home 'probe.ps1') -Value $liveFix -NoNewline -Encoding utf8
$r = Invoke-Subject $Script $fx
Assert ((Get-Class $r 'probe.ps1') -eq 'DIVERGENT') 'T_DIVERGENT' 'live-only content is DIVERGENT'
$after = Get-Content (Join-Path $fx.Home 'probe.ps1') -Raw
Assert ($after -match 'HOTFIX') 'T_DIVERGENT_PRESERVED' 'and the live fix survives untouched'

# --- T_CRLF: same bytes, different newlines -> BEHIND, not a false DIVERGENT --------
$fx = New-Fixture 'crlf'
Set-Content -LiteralPath (Join-Path $fx.Home 'probe.ps1') -Value "# probe v1`r`nWrite-Output 'v1'" -NoNewline -Encoding utf8
$r = Invoke-Subject $Script $fx
Assert ((Get-Class $r 'probe.ps1') -eq 'BEHIND') 'T_CRLF' 'CRLF copy of an old version is still BEHIND'

# --- T_LOCALONLY: no counterpart in the repo -> ignored, not touched ----------------
$fx = New-Fixture 'localonly'
Set-Content -LiteralPath (Join-Path $fx.Home 'scratch-harness.mjs') -Value "// local only" -NoNewline -Encoding utf8
$r = Invoke-Subject $Script $fx
Assert ((Get-Class $r 'scratch-harness.mjs') -eq 'LOCAL-ONLY') 'T_LOCALONLY' 'a repo-less file is ignored'

# --- T_AMBIGUOUS: one basename, two repo paths -> refuse rather than guess ----------
$fx = New-Fixture 'ambiguous'
Add-AmbiguousName $fx.Repo 'dupe.ps1'
Set-Content -LiteralPath (Join-Path $fx.Home 'dupe.ps1') -Value "# something else" -NoNewline -Encoding utf8
$r = Invoke-Subject $Script $fx
Assert ((Get-Class $r 'dupe.ps1') -eq 'AMBIGUOUS') 'T_AMBIGUOUS' 'a duplicated basename is refused, not guessed'

# --- T_ESCALATE: the same refusal on a second cycle becomes an ask ------------------
$fx = New-Fixture 'escalate'
Set-Content -LiteralPath (Join-Path $fx.Home 'probe.ps1') -Value "# live only`n# nope" -NoNewline -Encoding utf8
$r1 = Invoke-Subject $Script $fx
$r2 = Invoke-Subject $Script $fx
Assert ($r1.Exit -eq 0) 'T_ESCALATE_1' 'first refusal is information (exit 0)'
Assert ($r2.Exit -eq 2) 'T_ESCALATE_2' 'the repeat is a decision nobody is making (exit 2)'

# --- T_WHATIF: reporting mode writes nothing ----------------------------------------
$fx = New-Fixture 'whatif'
Set-Content -LiteralPath (Join-Path $fx.Home 'probe.ps1') -Value "# probe v1`nWrite-Output 'v1'" -NoNewline -Encoding utf8
$r = Invoke-Subject $Script $fx -WhatIf
$after = Get-Content (Join-Path $fx.Home 'probe.ps1') -Raw
Assert ($after -match 'v1') 'T_WHATIF' '-WhatIf leaves the file alone'

# --- THE FORWARD DIRECTION (GH #254) -------------------------------------------------
# Everything above starts from a file that is already on the machine. These start from a
# file that is NOT - the case that was invisible by construction, because a classifier
# that enumerates the home can only ever classify what the home already contains.
$fxF = New-Fixture 'forward'
Add-Roster $fxF.Repo
$rF = Invoke-Subject $Script $fxF

Assert ((Get-Class $rF 'newsweep.mjs') -eq 'MISSING') 'T_MISSING' 'a rostered file absent from the home is MISSING'
Assert (Test-Path (Join-Path $fxF.Home 'newsweep.mjs')) 'T_MISSING_WRITE' 'and is actually deployed'

# The library no roster would name. Deploying the entry point without it turns a silent
# MISSING into a loud CRASH, which is not a fix.
Assert ((Get-Class $rF 'lib-helper.mjs') -eq 'MISSING') 'T_CLOSURE' 'an imported-but-unrostered dependency is pulled in'
Assert (Test-Path (Join-Path $fxF.Home 'lib-helper.mjs')) 'T_CLOSURE_WRITE' 'and is deployed alongside its importer'

# The other half of the rule. #254 is explicit that deploying everything is its own
# failure, so a repo file that is neither rostered nor reachable must stay put.
Assert (-not (Test-Path (Join-Path $fxF.Home 'diagnostic-tool.mjs'))) 'T_NO_OVERDEPLOY' 'an unrostered one-off is NOT deployed'
Assert ((Get-Class $rF 'diagnostic-tool.mjs') -eq '<absent>') 'T_NO_OVERDEPLOY_QUIET' 'and generates no noise'

# ENTRY: run-sweeps.ps1 is named directly, so it deploys even though nothing imports it.
Assert ((Get-Class $rF 'run-sweeps.ps1') -eq 'MISSING') 'T_ENTRY' 'a named entry point is required even when unreferenced'

# --- T_MUTCHECK: a guard the runner globs but no roster names (2026-08-30) -----------
# `run-sweeps.ps1 -IncludeMutchecks` discovers mutation checks by globbing the FLAT HOME.
# So the deployer and the runner have to agree on what belongs here, and until now they
# did not: the runner looked for `mutcheck-*`, the deployer required roster + closure +
# entry, and `mutcheck-*` is in none of those. The disagreement was silent in the
# safe-looking direction -- the suite reported clean over guards it could not see.
# Measured live the day this was written: 47 mutation checks on main, 36 on the machine,
# 11 that had never run once, including the #227 consent gate.
$fxM = New-Fixture 'forward-mutcheck'
Add-Roster $fxM.Repo
Add-Mutcheck $fxM.Repo
$rM = Invoke-Subject $Script $fxM

Assert ((Get-Class $rM 'mutcheck-probe.mjs') -eq 'MISSING') 'T_MUTCHECK_MJS' 'an unrostered .mjs mutation check is required'
Assert ((Get-Class $rM 'mutcheck-probe.ps1') -eq 'MISSING') 'T_MUTCHECK_PS1' 'and so is the .ps1 half the glob once skipped'
Assert (Test-Path (Join-Path $fxM.Home 'mutcheck-probe.mjs')) 'T_MUTCHECK_WRITE' 'and it is actually deployed where the runner globs'
Assert (Test-Path (Join-Path $fxM.Home 'mutcheck-probe.ps1')) 'T_MUTCHECK_WRITE_PS1' 'both extensions land'
# Narrowness: rule 4 must not become "deploy everything". The one-off is still excluded.
Assert (-not (Test-Path (Join-Path $fxM.Home 'diagnostic-tool.mjs'))) 'T_MUTCHECK_NARROW' 'rule 4 does not smuggle in unrostered one-offs'

# --- T_SUBJECT: rule 5 -- the guard arrives, so its subject must too (2026-08-30) ----
# Rule 4 above closed "the guard never arrives". It thereby created the opposite failure:
# a guard that arrives WITHOUT the script it tests. That does not degrade quietly -- the
# mutcheck throws and exits 1, so the suite reports a red guard for a healthy subject.
# Measured minutes after rule 4 deployed: 5 of the 48 guards in the live home were dead
# this way (4 needing oa-state.ps1, 1 needing sync-oa-home.ps1), including this tool's own
# guard, and `mutcheck-priority-order.ps1` failed the very first time the runner globbed it.
$fxS = New-Fixture 'forward-subject'
Add-Roster $fxS.Repo
Add-MutcheckSubject $fxS.Repo
$rS = Invoke-Subject $Script $fxS

Assert ((Get-Class $rS 'mutcheck-subject.ps1') -eq 'MISSING') 'T_SUBJECT_GUARD' 'the guard itself is required (rule 4)'
Assert ((Get-Class $rS 'subject-tool.ps1') -eq 'MISSING') 'T_SUBJECT' 'and the script it resolves via $PSScriptRoot comes with it'
Assert (Test-Path (Join-Path $fxS.Home 'subject-tool.ps1')) 'T_SUBJECT_WRITE' 'so the guard can actually execute where the runner globs it'
# Narrowness: rule 5 follows a reference, it does not sweep the repo for .ps1 files.
Assert (-not (Test-Path (Join-Path $fxS.Home 'unrelated-tool.ps1'))) 'T_SUBJECT_NARROW' 'an unreferenced .ps1 is still not deployed'

# --- T_DATA: rule 6 -- the sweep arrives, so the file it reads must too (2026-08-31) ---
# Rules 4 and 5 closed this shape for PowerShell guards. The .mjs half stayed open: a
# rostered sweep deploys, and the JSON it reads on line one does not, so it dies with
# ENOENT and exits 1 -- a red guard over a healthy subject. Measured hours after
# `read-path-budget-sweep` merged: 0 bytes of stdout, 728 of stderr, every single run,
# while this tool reported `verified-current True`.
$fxD = New-Fixture 'forward-data'
Add-DataDependentSweep $fxD.Repo
$rD = Invoke-Subject $Script $fxD

Assert ((Get-Class $rD 'datasweep.mjs') -eq 'MISSING') 'T_DATA_SWEEP' 'the rostered sweep itself is required (rule 1)'
Assert ((Get-Class $rD 'probe-manifest.json') -eq 'MISSING') 'T_DATA' 'and the data file it resolves via join(HERE, ...) comes with it'
Assert (Test-Path (Join-Path $fxD.Home 'probe-manifest.json')) 'T_DATA_WRITE' 'so the sweep can actually read it where the runner runs it'
# Narrowness: rule 6 follows a reference, it does not sweep the repo for .json files.
Assert (-not (Test-Path (Join-Path $fxD.Home 'probe-unused.json'))) 'T_DATA_NARROW' 'an unreferenced data file is still not deployed'

# Safety half of rule 6: a data file ALREADY in the home is never OVERWRITTEN. A data file
# can be locally mutated state (a baseline a sweep rewrites), so a basename match on the
# ref must never license a write.
#
# What it IS now: reported. "Never overwrite" and "never mention" are different promises,
# and only the first one is safe -- staying silent is what let the live
# read-path-manifest.json sit frozen at the commit that first delivered it while the tool
# printed `verified-current True` over it (see rule 6's receipt, and M14 below).
$fxD2 = New-Fixture 'forward-data-live'
Add-DataDependentSweep $fxD2.Repo
Set-Content -LiteralPath (Join-Path $fxD2.Home 'probe-manifest.json') -Value '["locally mutated"]' -NoNewline -Encoding utf8
$rD2 = Invoke-Subject $Script $fxD2
Assert ((Get-Class $rD2 'probe-manifest.json') -eq 'DATA-STALE') 'T_DATA_LIVE_REPORTED' 'a live data file that differs from the ref is reported'
Assert ((Get-Content -LiteralPath (Join-Path $fxD2.Home 'probe-manifest.json') -Raw) -eq '["locally mutated"]') 'T_DATA_LIVE_KEPT' 'and its local contents are never overwritten'
Assert ($rD2.Json.verifiedCurrent -eq $false) 'T_DATA_LIVE_NOT_CURRENT' 'and the tree is not claimed current while it differs'

# The other direction, so the report is a measurement and not a blanket accusation: a live
# data file that MATCHES the ref stays completely quiet.
$fxD3 = New-Fixture 'forward-data-live-current'
Add-DataDependentSweep $fxD3.Repo
Set-Content -LiteralPath (Join-Path $fxD3.Home 'probe-manifest.json') -Value '[]' -NoNewline -Encoding utf8
$rD3 = Invoke-Subject $Script $fxD3
Assert ((Get-Class $rD3 'probe-manifest.json') -eq '<absent>') 'T_DATA_LIVE_QUIET' 'a live data file identical to the ref is not classified at all'

# --- T_MISSING_AMBIGUOUS: required, but the basename maps to two repo paths ----------
# A flat home cannot say which path was meant. Same answer as for a live file: refuse.
$fxA = New-Fixture 'forward-ambiguous'
Add-Roster $fxA.Repo
Add-AmbiguousName $fxA.Repo 'newsweep.mjs'
$rA = Invoke-Subject $Script $fxA
Assert ((Get-Class $rA 'newsweep.mjs') -eq 'MISSING-AMBIGUOUS') 'T_MISSING_AMBIGUOUS' 'a required file with an ambiguous basename is refused'
Assert (-not (Test-Path (Join-Path $fxA.Home 'newsweep.mjs'))) 'T_MISSING_AMBIGUOUS_NOWRITE' 'and nothing is guessed onto the machine'

# --- T_FORWARD_VERIFIED: the claim that was true-but-wrong ---------------------------
# Before #254 a run with a merged-but-absent file printed `verified-current True`,
# because every file it looked at was fine. Under -WhatIf nothing is written, so the
# pending work must be what makes the claim false.
$fxV = New-Fixture 'forward-verified'
Add-Roster $fxV.Repo
$rV = Invoke-Subject $Script $fxV -WhatIf
Assert ($rV.Json.verifiedCurrent -eq $false) 'T_FORWARD_VERIFIED' 'verified-current is False while a required file is absent'
Assert (-not (Test-Path (Join-Path $fxV.Home 'newsweep.mjs'))) 'T_FORWARD_WHATIF' 'and -WhatIf still writes nothing'

Write-Host ''
Write-Host '[mutants] each must FLIP the case it protects'

function New-Mutant {
  param([string]$Name, [string]$Find, [string]$Replace)
  $src = [IO.File]::ReadAllText($Script, (New-Object Text.UTF8Encoding($false)))
  if ($src -notmatch [regex]::Escape($Find)) { throw "mutant $Name : anchor not found -> $Find" }
  $dst = Join-Path $root "mutant-$Name.ps1"
  [IO.File]::WriteAllText($dst, $src.Replace($Find, $Replace), (New-Object Text.UTF8Encoding($false)))
  return $dst
}

# M1 - delete the historical-blob walk. Everything becomes DIVERGENT, so the tool can
#      never say "safe" and the gap stays open forever. T_BEHIND must fail.
$m1 = New-Mutant 'M1' '  $match = $null
  $commits = Invoke-Git @(''rev-list'', $refSha, ''--'', $repoPath) -AllowFail' '  $match = $null
  $commits = @()'
$fx = New-Fixture 'm1'
Set-Content -LiteralPath (Join-Path $fx.Home 'probe.ps1') -Value "# probe v1`nWrite-Output 'v1'" -NoNewline -Encoding utf8
$r = Invoke-Subject $m1 $fx
Assert ((Get-Class $r 'probe.ps1') -ne 'BEHIND') 'M1' 'without the history walk, a safe file is no longer deployable'

# M2 - THE ONE THAT MATTERS. Treat DIVERGENT as deployable (a blind copy of the ref).
#      The live-only hotfix is silently reverted while the run reports success.
#      NOTE: these anchors are single-quoted here-strings on purpose. A double-quoted
#      string eats `$results` and mangles backtick escapes - the two hazards this repo
#      has already been bitten by, and they bit this file on the first attempt.
$m2find = @'
    $results += [pscustomobject]@{ file = $name; class = 'DIVERGENT'; repoPath = $repoPath; matchCommit = $null }
'@
$m2repl = @'
    $results += [pscustomobject]@{ file = $name; class = 'BEHIND'; repoPath = $repoPath; matchCommit = $refSha }
'@
$m2 = New-Mutant 'M2' $m2find.TrimEnd("`r","`n") $m2repl.TrimEnd("`r","`n")
$fx = New-Fixture 'm2'
Set-Content -LiteralPath (Join-Path $fx.Home 'probe.ps1') -Value $liveFix -NoNewline -Encoding utf8
$r = Invoke-Subject $m2 $fx
$after = Get-Content (Join-Path $fx.Home 'probe.ps1') -Raw
Assert ($after -notmatch 'HOTFIX') 'M2' 'without the refusal, a live fix IS reverted (this is the whole point)'

# M3 - remove newline normalisation. A CRLF copy of an old version now matches no
#      historical blob, so it is misread as a live fix and refused forever.
$m3find = @'
  return ($t -replace "`r`n", "`n").TrimEnd("`n")
'@
$m3repl = @'
  return $t
'@
$m3 = New-Mutant 'M3' $m3find.TrimEnd("`r","`n") $m3repl.TrimEnd("`r","`n")
$fx = New-Fixture 'm3'
Set-Content -LiteralPath (Join-Path $fx.Home 'probe.ps1') -Value "# probe v1`r`nWrite-Output 'v1'" -NoNewline -Encoding utf8
$r = Invoke-Subject $m3 $fx
Assert ((Get-Class $r 'probe.ps1') -ne 'BEHIND') 'M3' 'without normalisation, a CRLF copy is misclassified'

# M4 - drop the ambiguity guard and take the first path. The flat home would be
#      overwritten from whichever repo file happened to sort first.
$m4 = New-Mutant 'M4' '  if ($paths.Count -gt 1) {' '  if ($false) {'
$fx = New-Fixture 'm4'
Add-AmbiguousName $fx.Repo 'dupe.ps1'
Set-Content -LiteralPath (Join-Path $fx.Home 'dupe.ps1') -Value "# something else" -NoNewline -Encoding utf8
$r = Invoke-Subject $m4 $fx
Assert ((Get-Class $r 'dupe.ps1') -ne 'AMBIGUOUS') 'M4' 'without the guard, an ambiguous basename is acted on'

# --- mutants for the forward direction (GH #254) -------------------------------------

# M5 - blind the roster read. The required set collapses to the entry points, so a
#      merged-and-rostered sweep is invisible again: no MISSING, no refusal, no count.
#      This restores the exact bug - `verified-current True` over a guard that has never
#      executed once.
$m5find = @'
  $text = Get-RefText $Sha $RosterPath
  if (-not $text) { return @() }
'@
$m5repl = @'
  $text = Get-RefText $Sha $RosterPath
  return @()
'@
$m5 = New-Mutant 'M5' $m5find.TrimEnd("`r","`n") $m5repl.TrimEnd("`r","`n")
$fx = New-Fixture 'm5'
Add-Roster $fx.Repo
$r = Invoke-Subject $m5 $fx
Assert ((Get-Class $r 'newsweep.mjs') -ne 'MISSING') 'M5' 'without the roster, a merged sweep is invisible again'

# M6 - keep the roster, delete the import closure. The entry point still deploys, so the
#      run looks fixed, but its dependency does not - converting a silent MISSING into a
#      crash on first import. This is why the closure is not belt-and-braces.
$m6 = New-Mutant 'M6' '      [void]$required.Add($dep)' '      if ($false) { [void]$required.Add($dep) }'
$fx = New-Fixture 'm6'
Add-Roster $fx.Repo
$r = Invoke-Subject $m6 $fx
Assert ((Get-Class $r 'newsweep.mjs') -eq 'MISSING') 'M6_ENTRY_STILL_OK' 'the entry point still deploys (so this mutant is narrow)'
Assert (-not (Test-Path (Join-Path $fx.Home 'lib-helper.mjs'))) 'M6' 'without the closure, the importer ships without its library'

# M7 - drop the ambiguity refusal on the forward path only. The tool now guesses which
#      of two repo paths a required basename meant, and writes it.
$m7find = @'
    if ($paths.Count -gt 1) {
      # Same reasoning as AMBIGUOUS above: a flat home cannot say which path was meant.
'@
$m7repl = @'
    if ($false) {
'@
$m7 = New-Mutant 'M7' $m7find.TrimEnd("`r","`n") $m7repl.TrimEnd("`r","`n")
$fx = New-Fixture 'm7'
Add-Roster $fx.Repo
Add-AmbiguousName $fx.Repo 'newsweep.mjs'
$r = Invoke-Subject $m7 $fx
Assert ((Get-Class $r 'newsweep.mjs') -ne 'MISSING-AMBIGUOUS') 'M7' 'without the guard, an ambiguous required file is guessed at'

# M8 - restore the old verified-current arithmetic. Nothing was written under -WhatIf, so
#      residual is 0, so the line reads True while a required file is absent. Every
#      number in it is correct and the conclusion is wrong - #254 in one sentence.
$m8 = New-Mutant 'M8' '$pending = if ($WhatIf) { $toWrite.Count } else { 0 }' '$pending = 0'
$fx = New-Fixture 'm8'
Add-Roster $fx.Repo
$r = Invoke-Subject $m8 $fx -WhatIf
Assert ($r.Json.verifiedCurrent -ne $false) 'M8' 'without the pending term, a missing file still reports verified-current True'

# M9 - delete rule 4. The roster, the closure and the entry points all still work, so the
#      run looks completely healthy - and every `mutcheck-*` goes back to being required
#      by nothing. That is the state measured on 2026-08-30: 11 merged guards, none of
#      them ever executed, while this tool printed `verified-current True`. The mutant is
#      deliberately narrow: newsweep.mjs must STILL deploy, so a failure here can only
#      mean the mutcheck rule died, not that the forward direction did.
$m9find = @'
  foreach ($n in $byName.Keys) {
    if ($n -match '^mutcheck-.*\.(ps1|mjs)$') { [void]$required.Add($n) }
  }
'@
$m9repl = @'
  foreach ($n in $byName.Keys) {
    if ($false) { [void]$required.Add($n) }
  }
'@
$m9 = New-Mutant 'M9' $m9find.TrimEnd("`r","`n") $m9repl.TrimEnd("`r","`n")
$fx = New-Fixture 'm9'
Add-Roster $fx.Repo
Add-Mutcheck $fx.Repo
$r = Invoke-Subject $m9 $fx
Assert ((Get-Class $r 'newsweep.mjs') -eq 'MISSING') 'M9_ROSTER_STILL_OK' 'the rostered sweep still deploys (so this mutant is narrow)'
Assert ((Get-Class $r 'mutcheck-probe.mjs') -ne 'MISSING') 'M9' 'without rule 4, a merged mutation check is invisible again'
Assert (-not (Test-Path (Join-Path $fx.Home 'mutcheck-probe.ps1'))) 'M9_NOWRITE' 'and never reaches the home the runner globs'

# M10 - delete rule 5. Rule 4 still fires, so every guard still deploys and the run still
#       prints a healthy summary - but each PowerShell guard now lands without the script
#       it tests and dies with exit 1 on first execution. The mutant is deliberately
#       narrow: mutcheck-subject.ps1 must STILL deploy, so a failure here can only mean
#       the SUBJECTS rule died, not that rule 4 or the forward direction did.
$m10find = @'
      if ($dep -match '^mutcheck-') { continue }   # already covered by rule 4
      [void]$required.Add($dep)
'@
$m10repl = @'
      if ($dep -match '^mutcheck-') { continue }   # already covered by rule 4
      if ($false) { [void]$required.Add($dep) }
'@
$m10 = New-Mutant 'M10' $m10find.TrimEnd("`r","`n") $m10repl.TrimEnd("`r","`n")
$fx = New-Fixture 'm10'
Add-Roster $fx.Repo
Add-MutcheckSubject $fx.Repo
$r = Invoke-Subject $m10 $fx
Assert ((Get-Class $r 'mutcheck-subject.ps1') -eq 'MISSING') 'M10_GUARD_STILL_OK' 'the guard still deploys (so this mutant is narrow)'
Assert ((Get-Class $r 'subject-tool.ps1') -ne 'MISSING') 'M10' 'without rule 5 the subject is required by nothing'
Assert (-not (Test-Path (Join-Path $fx.Home 'subject-tool.ps1'))) 'M10_NOWRITE' 'so the deployed guard would throw on its first run'

# M11 - delete rule 6. Rules 1-5 all still fire, so the rostered sweep deploys and the run
#       prints a healthy summary - but the sweep lands without the manifest it reads on
#       line one and dies with ENOENT the first time the runner executes it. That is the
#       live state measured on 2026-08-31. Deliberately narrow: datasweep.mjs must STILL
#       deploy, so a failure here can only mean the DATA rule died.
$m11find = @'
    foreach ($dep in (Get-HereDataRefs $src)) {
      [void]$required.Add($dep)
      if ($dep -match '\.(mjs|js)$') { $queue.Enqueue($dep) }
    }
'@
$m11repl = @'
    foreach ($dep in (Get-HereDataRefs $src)) {
      if ($false) { [void]$required.Add($dep) }
    }
'@
$m11 = New-Mutant 'M11' $m11find.TrimEnd("`r","`n") $m11repl.TrimEnd("`r","`n")
$fx = New-Fixture 'm11'
Add-DataDependentSweep $fx.Repo
$r = Invoke-Subject $m11 $fx
Assert ((Get-Class $r 'datasweep.mjs') -eq 'MISSING') 'M11_SWEEP_STILL_OK' 'the rostered sweep still deploys (so this mutant is narrow)'
Assert ((Get-Class $r 'probe-manifest.json') -ne 'MISSING') 'M11' 'without rule 6 the data file is required by nothing'
Assert (-not (Test-Path (Join-Path $fx.Home 'probe-manifest.json'))) 'M11_NOWRITE' 'so the deployed sweep would throw ENOENT on its first run'

# M12 - keep rule 6 but drop its extension test, so a bare directory join would be
#       required as if it were a file. The rule must stay a reference-follower, not a
#       path-guesser; the real data file must still deploy either way.
$m12 = New-Mutant 'M12' "if (`$leaf -match '\.[A-Za-z0-9]{1,5}`$') { `$out += `$leaf }" "`$out += `$leaf"
$fx = New-Fixture 'm12'
Add-DataDependentSweep $fx.Repo
$r = Invoke-Subject $m12 $fx
Assert ((Get-Class $r 'probe-manifest.json') -eq 'MISSING') 'M12_STILL_OK' 'the real data file still deploys (so this mutant is narrow)'

# M13 - keep rule 6's reference-finding but delete the ref-side data index, so the
#       required name resolves to nothing and is dropped by the "not on the ref" guard.
#       This is the half that actually failed first time: the walk found the manifest and
#       the missing loop threw it away, because non-code files were never indexed at all.
$m13 = New-Mutant 'M13' '      if ($dataByName.ContainsKey($n)) {' '      if ($false) {'
$fx = New-Fixture 'm13'
Add-DataDependentSweep $fx.Repo
$r = Invoke-Subject $m13 $fx
Assert ((Get-Class $r 'datasweep.mjs') -eq 'MISSING') 'M13_SWEEP_STILL_OK' 'the rostered sweep still deploys (so this mutant is narrow)'
Assert ((Get-Class $r 'probe-manifest.json') -ne 'MISSING') 'M13' 'without the data index the required file is silently dropped'
Assert (-not (Test-Path (Join-Path $fx.Home 'probe-manifest.json'))) 'M13_NOWRITE' 'and never reaches the home'

# M14 - rule 6 delivers a data file once and then freezes it. Restore that by deleting the
#       DATA-STALE branch: a live data file that no longer matches the ref goes back to
#       being classified as nothing at all, and `verified-current True` is printed over it.
#
#       This is the 2026-09-01 defect exactly. Minutes after #336 merged, the live
#       read-path-manifest.json was still byte-identical to ad5e1d6 - the commit that
#       first DELIVERED it, five commits earlier - so the just-deployed code that reads
#       `idPattern` found no `idPattern` to read and silently reverted to the behaviour
#       the PR had fixed. Every check reported success. The subject must never be able to
#       call a stale required data file current again.
$m14find = '              $dataStale += [pscustomobject]@{ file = $n; class = ''DATA-STALE''; repoPath = $dPaths[0]; matchCommit = $null }'
$m14 = New-Mutant 'M14' $m14find '              $null = $null'
$fx = New-Fixture 'm14'
Add-DataDependentSweep $fx.Repo
# Deliver the data file first, then make the live copy stale, so the ONLY difference
# between the two runs is whether the stale copy is noticed.
$null = Invoke-Subject $Script $fx
Set-Content -LiteralPath (Join-Path $fx.Home 'probe-manifest.json') -Value '{"stale":true}' -Encoding utf8
$rReal = Invoke-Subject $Script $fx
Assert ((Get-Class $rReal 'probe-manifest.json') -eq 'DATA-STALE') 'M14_REAL' 'the real subject notices a stale required data file'
Assert ((Get-Content -LiteralPath (Join-Path $fx.Home 'probe-manifest.json') -Raw) -match 'stale') 'M14_NOWRITE' 'and still refuses to overwrite it (it may be local state)'
$rMut = Invoke-Subject $m14 $fx
Assert ((Get-Class $rMut 'probe-manifest.json') -ne 'DATA-STALE') 'M14' 'without the DATA-STALE branch a frozen data file is called current'

Write-Host ''
Write-Host ("[mutcheck-sync-oa-home] {0} passed, {1} failed" -f $script:pass, $script:fail)

if (-not $KeepFixtures) { Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue }
if ($script:fail -gt 0) { exit 1 }
exit 0
