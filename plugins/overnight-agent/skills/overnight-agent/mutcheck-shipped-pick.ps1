<#
  mutcheck-shipped-pick.ps1 -- proves write-turn.ps1's G15 is load-bearing (GH #635).

  WHAT IS UNDER TEST, AND WHY IT NEEDED A MUTATION CHECK RATHER THAN A UNIT TEST

  #630/#631 established that a shipped PR does not close its issue here, so `OPEN` spans
  "unworked" and "shipped, awaiting his review", and measured 98 of 169 open issues as
  already shipped. That knowledge sat in a sweep nothing consulted, and twelve
  recommendations of already-shipped work were made anyway across two days. G15 is the
  part that makes the knowledge REFUSE rather than merely report, at the one choke point
  a run cannot route around: the journal turn that carries the recommendation forward.

  A guard like that has two failure modes and they are not symmetric:

    too narrow  -> it passes the exact turn it exists to refuse, silently, reading green
    too wide    -> it refuses turns that merely REPORT shipped work, and gets switched off

  So every arm below is PAIRED: a baseline that must refuse, against a negative that must
  clear on an otherwise identical fixture. An arm that cannot fail proves nothing, and
  this suite has produced vacuous arms twice already (see mutcheck-shipped-but-open.mjs).

  HERMETIC. Every arm builds a throwaway git repo whose `origin/main` is written directly
  as a remote-tracking ref -- no network, no GitHub login, no real remote -- and points
  the classifier at it with SHIPPED_SWEEP_REPO. The REAL write-turn.ps1 is the subject;
  mutants are copies of it, so this cannot pass by testing a re-implementation of the
  logic (#463: "green where it was written, broken where it runs").

  Usage: pwsh -File mutcheck-shipped-pick.ps1 [-WriteTurnPath <write-turn.ps1>]
  Exit 0 = every arm agreed. Exit 1 = the guard is not doing what it claims.
#>
[CmdletBinding()]
param(
  [string]$WriteTurnPath,
  [string]$ResolverPath
)

$ErrorActionPreference = 'Stop'

if (-not $WriteTurnPath) { $WriteTurnPath = Join-Path $PSScriptRoot 'write-turn.ps1' }
if (-not $ResolverPath) { $ResolverPath = [IO.Path]::Combine($PSScriptRoot, '..', '..', 'checks', 'issue-shipped.mjs') }
if (-not (Test-Path $WriteTurnPath)) { throw "write-turn.ps1 not found at $WriteTurnPath" }
if (-not (Test-Path $ResolverPath)) { throw "issue-shipped.mjs not found at $ResolverPath" }

# Under pwsh this is pwsh itself, so the whole harness runs on Linux in CI. Under Windows
# PowerShell it is `powershell`, matching how the skill actually invokes these scripts.
$script:PsExe = if ($PSVersionTable.PSEdition -eq 'Core') { (Get-Process -Id $PID).Path } else { 'powershell' }
$utf8 = New-Object Text.UTF8Encoding($false)
$MOON = [char]::ConvertFromUtf32(0x1F319)

$root = Join-Path ([IO.Path]::GetTempPath()) ("oa-pick-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $root -Force | Out-Null

$script:pass = 0
$script:fail = 0
function Assert([bool]$ok, [string]$name, [string]$why) {
  if ($ok) { Write-Host "  PASS  $name  -- $why"; $script:pass++ }
  else { Write-Host "  FAIL  $name  -- $why" -ForegroundColor Red; $script:fail++ }
}

function New-Mutant {
  param([string]$Name, [string]$Source, [string]$Find, [string]$Replace)
  $src = [IO.File]::ReadAllText($Source, $utf8)
  if (-not $src.Contains($Find)) { throw "mutant $Name : anchor not found in $Source -> $Find" }
  $dst = Join-Path $root ("mutant-$Name-" + [IO.Path]::GetFileName($Source))
  [IO.File]::WriteAllText($dst, $src.Replace($Find, $Replace), $utf8)
  return $dst
}

# --- fixture repo ----------------------------------------------------------------------
# `origin/main` is written as a remote-tracking ref directly, so nothing here touches a
# network or a real remote. IMPL is a path inside REPO_PATHS, because the classifier only
# looks at `packages` and `plugins` -- a citation anywhere else is correctly invisible.
$IMPL = 'packages/telegram-bridge/src/bridge.js'
function New-FixtureRepo {
  param([hashtable]$Files)
  $dir = Join-Path $root ("repo-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
  & git -C $dir init --quiet -b work | Out-Null
  & git -C $dir config user.email 'a@b.c' | Out-Null
  & git -C $dir config user.name 'mutcheck' | Out-Null
  foreach ($rel in $Files.Keys) {
    $abs = Join-Path $dir $rel
    New-Item -ItemType Directory -Path (Split-Path -Parent $abs) -Force | Out-Null
    [IO.File]::WriteAllText($abs, $Files[$rel], $utf8)
  }
  & git -C $dir add -A | Out-Null
  & git -C $dir commit --quiet -m fixture | Out-Null
  $sha = (& git -C $dir rev-parse HEAD).Trim()
  & git -C $dir update-ref refs/remotes/origin/main $sha | Out-Null
  return $dir
}

function New-Body {
  param([string]$Name, [string]$Text)
  $p = Join-Path $root "$Name.md"
  [IO.File]::WriteAllText($p, $Text, $utf8)
  return $p
}

# Every invocation goes through a REAL process, exactly as the skill invokes it, and the
# resolver is passed explicitly so a mutant copy living in TEMP still finds it.
function Invoke-WriteTurn {
  param([string]$Subject, [string]$BodyFile, [string]$Repo, [string[]]$Extra = @())
  $prevRepo = $env:SHIPPED_SWEEP_REPO
  $prevRes = $env:WRITE_TURN_ISSUE_RESOLVER
  $env:SHIPPED_SWEEP_REPO = $Repo
  $env:WRITE_TURN_ISSUE_RESOLVER = (Resolve-Path $ResolverPath).Path
  try {
    $out = (& $script:PsExe -NoProfile -ExecutionPolicy Bypass -File $Subject `
        -BodyFile $BodyFile -Ask none -Validate @Extra 2>&1 | Out-String)
    return [pscustomobject]@{ out = $out; code = $LASTEXITCODE }
  }
  finally {
    $env:SHIPPED_SWEEP_REPO = $prevRepo
    $env:WRITE_TURN_ISSUE_RESOLVER = $prevRes
  }
}

# A turn body that is clean under every OTHER guard, so an arm can only fail because of
# G15. It carries an ask (`**Next:**`) so A5 stays quiet, a heading with the moon so G3/G7
# pass, and a provenance marker directly beneath it.
function Turn([string]$closing) {
  return @"
## $MOON Overnight Agent -- 2026-09-08 14:00 PT

<!-- from: overnight-agent -->

**Status:** in-progress.

$closing
"@
}

$CITED = @{ $IMPL = "// carry the ask in the pointer (GH #111)`nexport const x = 1`n" }
$UNCITED = @{ $IMPL = "// nothing named here`nexport const x = 1`n" }

Write-Host ''
Write-Host 'BASELINE -- the real write-turn.ps1, against the real defect'

$repoCited = New-FixtureRepo $CITED

# ------------------------------------------------------------------ B1 the measured shape
# "**Next:** work #588 next wake" is literally how the twelve bad picks travelled.
$bodyPropose = New-Body 'propose' (Turn '**Next:** work #111 next wake.')
$b1 = Invoke-WriteTurn $WriteTurnPath $bodyPropose $repoCited
Assert ($b1.code -eq 2 -and $b1.out -match 'G15') 'B1' 'a turn proposing an already-shipped issue is REFUSED'
Assert ($b1.out -match '#111') 'B1b' 'and the refusal names the issue, not just "a problem"'

# ------------------------------------------------------------- N1 the paired negative
# THE SAME BODY against a repo where nothing cites #111. If this fails, B1 was passing
# for a reason other than the citation.
$repoUncited = New-FixtureRepo $UNCITED
$n1 = Invoke-WriteTurn $WriteTurnPath $bodyPropose $repoUncited
Assert ($n1.code -eq 0 -and $n1.out -notmatch 'G15 line') 'N1' 'the identical turn clears when the issue is uncited (B1 pairs)'

Write-Host ''
Write-Host 'NARROWNESS -- it must refuse PROPOSALS, never REPORTS'

# ---------------------------------------------------------------------------- N2 report
# The turn that ANNOUNCES shipped work necessarily cites shipped issues. Refusing it would
# make the guard unusable, and it would be refusing the correct behaviour it wants.
$n2 = Invoke-WriteTurn $WriteTurnPath (New-Body 'report' (Turn '**Status:** shipped the fix for #111, merged. **Next:** amend the doc.')) $repoCited
Assert ($n2.code -eq 0) 'N2' 'a turn REPORTING shipped #111 is not refused (only proposals are)'

# ------------------------------------------------------------------------------- N3 PR
# "land PR #111" names a pull request. Every merged PR number is by construction cited in
# the source it merged, so failing to exclude these would refuse almost every real turn.
$n3 = Invoke-WriteTurn $WriteTurnPath (New-Body 'pr' (Turn '**Next:** land PR #111 once CI is green.')) $repoCited
Assert ($n3.code -eq 0) 'N3' 'a PR number on a Next line is not read as an issue pick'

# Paired with N3 so the exclusion cannot be silently swallowing everything.
$n3b = Invoke-WriteTurn $WriteTurnPath (New-Body 'prpair' (Turn '**Next:** pick up #111 after that.')) $repoCited
Assert ($n3b.code -eq 2 -and $n3b.out -match 'G15') 'N3b' 'but a bare issue pick on the same shape still refuses (N3 pairs)'

# ---------------------------------------------------------------------------- N4 fence
# A fenced block is a verbatim quotation -- including the quotation in THIS file's own
# postmortem. A guard that refuses the document explaining it gets switched off.
$fenced = Turn (@'
**Next:** amend the doc.

```
**Next:** work #111 next wake.
```
'@)
$n4 = Invoke-WriteTurn $WriteTurnPath (New-Body 'fenced' $fenced) $repoCited
Assert ($n4.code -eq 0) 'N4' 'the same proposal inside a fenced quotation is inert'

# ------------------------------------------------------------------------- N5 dialects
# The verb list is deliberately tight, but it must cover the forms actually used.
foreach ($d in @('**Next:** picking up #111.', '**Next up:** #111', 'I am working on #111 next.')) {
  $r = Invoke-WriteTurn $WriteTurnPath (New-Body ('dia' + [Math]::Abs($d.GetHashCode())) (Turn $d)) $repoCited
  Assert ($r.code -eq 2) 'N5' "refuses the proposal dialect: $d"
}

Write-Host ''
Write-Host 'BLINDNESS -- a guard that cannot see must not look like one that cleared the work'

# ------------------------------------------------------------------------- N6 not measured
# SHIPPED_SWEEP_REPO forced at a directory that is not a checkout. The turn must still be
# WRITABLE (refusing everything would wedge journalling entirely, which is strictly worse
# than the defect), but the run must be TOLD. Silence here would be the #632 failure --
# green because blind -- reappearing inside the guard built to answer it.
$notRepo = Join-Path $root 'not-a-repo'
New-Item -ItemType Directory -Path $notRepo -Force | Out-Null
$n6 = Invoke-WriteTurn $WriteTurnPath $bodyPropose $notRepo
Assert ($n6.code -eq 0) 'N6' 'unmeasurable -> fails OPEN, so journalling is never wedged'
Assert ($n6.out -match 'could not check the proposed issue') 'N6b' 'but it says so out loud, rather than passing silently'

Write-Host ''
Write-Host 'MUTANTS -- disable the guard, and the refusal must disappear'

# ------------------------------------------------------------------------------ M1 switch
# The documented escape hatch. Proves the B1 finding was G15's and nothing else's.
$m1 = Invoke-WriteTurn $WriteTurnPath $bodyPropose $repoCited @('-DisableGuard', 'G15')
Assert ($m1.code -eq 0) 'M1' '-DisableGuard G15 clears the refusal (so B1 was G15, not another guard)'

# ------------------------------------------------------------------------------- M2 dead
# The guard body made unreachable. If B1 still refused here, something else was producing
# the finding and G15 itself would be decorative -- the exact vacuity this file guards.
$m2src = New-Mutant 'M2' $WriteTurnPath "  if (& `$on 'G15') {" '  if ($false) {'
$m2 = Invoke-WriteTurn $m2src $bodyPropose $repoCited
Assert ($m2.code -eq 0) 'M2' 'guard made unreachable -> the refusal vanishes (it is load-bearing)'

# --------------------------------------------------------------------------- M3 unrolling
# The bug this guard actually shipped with, pinned. `Get-ProposedIssues` returns an array;
# PowerShell unrolls it on return, so a single result arrives as a scalar PSCustomObject
# whose `.Count` is EMPTY under Windows PowerShell 5.1 rather than 1 -- `-gt 0` is then
# false and the guard passes every turn SILENTLY. It cost a live green run here before it
# was caught, and it is the same host-dependent `.Count` trap write-turn.ps1's own entry
# point already documents for `$findings`.
#
# Removing the `@()` must therefore bring the DEFECT back, not keep the catch: this arm
# pairs against B1, which refuses the identical body with the `@()` in place. A mutant that
# still refused would mean the `@()` was decorative.
$m3src = New-Mutant 'M3' $WriteTurnPath `
  '$proposed = @(Get-ProposedIssues -Lines $lines -InFence $inFence)' `
  '$proposed = Get-ProposedIssues -Lines $lines -InFence $inFence'
$m3 = Invoke-WriteTurn $m3src $bodyPropose $repoCited
Assert ($m3.code -eq 0) 'M3' 'stripping the @() reintroduces the silent pass (so the @() is load-bearing, and B1 pairs)'

Write-Host ''
if ($script:fail -gt 0) {
  Write-Host ("FAILED: {0} arm(s) disagreed, {1} passed. G15 is not doing what it claims." -f $script:fail, $script:pass) -ForegroundColor Red
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
  exit 1
}
Write-Host ("OK: {0} arms agreed. Every baseline refuses and its paired negative clears." -f $script:pass) -ForegroundColor Green
Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
exit 0
