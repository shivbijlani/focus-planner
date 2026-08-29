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

Write-Host ''
Write-Host ("[mutcheck-sync-oa-home] {0} passed, {1} failed" -f $script:pass, $script:fail)

if (-not $KeepFixtures) { Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue }
if ($script:fail -gt 0) { exit 1 }
exit 0
