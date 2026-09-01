<#
  mutcheck-consent-vocab-drift.ps1 -- drift guard between the approval vocabulary SKILL.md
  ADVERTISES and the vocabulary the reader ACCEPTS (#301, #297).

  THE FAILURE MODE THIS GUARDS
  ----------------------------
  #301 happened because the word the agent told the user to reply (`merge <n>`) was not a word
  `$script:ConsentAffirmRe` in oa-state.ps1 accepted. The operative instruction and the machine
  reader had drifted apart, and nothing noticed -- the reply just read as "no affirmative" and was
  silently dropped. A comment saying "keep these in sync" is exactly the fix that does not work;
  this is a mechanical check instead.

  WHAT IS ASSERTED
  ----------------
  Every approval phrase SKILL.md advertises (the backticked phrases inside its
  `<!-- CONSENT-VOCAB:BEGIN -->`..`<!-- CONSENT-VOCAB:END -->` block) MUST be accepted verbatim by
  the reader's regex, extracted live from oa-state.ps1. i.e. advertised is a subset of accepted.
  The reader may accept MORE than it advertises (safe); it may never advertise a word it rejects.

  Baseline: no drift, the block is non-empty, and it advertises at least one command-shaped
  `merge <number>` phrase (so the #301 fix cannot be silently dropped from the ask).

  Then two mutation arms prove the check is load-bearing -- one per drift direction:
    D_readerDrops        the reader loses the `merge <n>` token but SKILL.md still advertises
                         `merge 300`         -> the check MUST flag `merge 300`.
    D_skillOverAdvertises SKILL.md advertises `merge it later`, which the reader rejects
                         -> the check MUST flag `merge it later`.
  If either arm produces NO drift, the check is not actually checking and this fails.

  Reads only; touches no live state.

    powershell -File mutcheck-consent-vocab-drift.ps1 [-ScriptPath <oa-state.ps1>] [-SkillPath <SKILL.md>]
    powershell -File mutcheck-consent-vocab-drift.ps1 -BaselineOnly
#>
[CmdletBinding()]
param(
  [string]$ScriptPath,
  [string]$SkillPath,
  [switch]$BaselineOnly
)

$ErrorActionPreference = 'Stop'

if (-not $ScriptPath) {
  $candidates = @(
    (Join-Path $PSScriptRoot '..\skills\overnight-agent\oa-state.ps1'),
    (Join-Path $env:LOCALAPPDATA 'overnight-agent\oa-state.ps1'),
    "$env:USERPROFILE\.copilot\installed-plugins\focus-planner\overnight-agent\skills\overnight-agent\oa-state.ps1"
  )
  # This check needs the PAIR -- oa-state.ps1 AND the SKILL.md beside it -- so auto-resolution must
  # probe for a directory carrying BOTH, not just the first oa-state.ps1 it finds. The flat OA home
  # ($env:LOCALAPPDATA\overnight-agent) deploys oa-state.ps1 WITHOUT SKILL.md, so matching on the
  # script alone resolves there and then throws on the missing SKILL.md -- short-circuiting past the
  # installed-plugins copy that has both. Probing for the pair encodes the real requirement (a
  # directory with both halves) instead of the order the deploy layouts happen to appear in today.
  # (Surfaced by the #305 read-path audit; same failure class as #301 -- a guard drifting from the
  # layout it runs in, invisible from the code and only seen when run where it actually runs.)
  foreach ($c in $candidates) {
    if ((Test-Path $c) -and (Test-Path (Join-Path (Split-Path $c) 'SKILL.md'))) { $ScriptPath = (Resolve-Path $c).Path; break }
  }
  # Fallback: any oa-state.ps1 that exists, so an explicit -SkillPath can still drive the check.
  if (-not $ScriptPath) {
    foreach ($c in $candidates) { if (Test-Path $c) { $ScriptPath = (Resolve-Path $c).Path; break } }
  }
}
if (-not $ScriptPath -or -not (Test-Path $ScriptPath)) { throw "oa-state.ps1 not found (pass -ScriptPath)" }
if (-not $SkillPath) { $SkillPath = Join-Path (Split-Path $ScriptPath) 'SKILL.md' }
if (-not (Test-Path $SkillPath)) { throw "SKILL.md not found beside $ScriptPath (pass -SkillPath)" }

function Read-Utf8([string]$p) { [IO.File]::ReadAllText($p, (New-Object Text.UTF8Encoding($false))) }

# --- extract the accepted vocabulary FROM THE READER ------------------------------------
# The pattern is a plain .NET regex literal; read it back exactly as the reader uses it. Pulling
# the substring between the first and last quote on the assignment line avoids any quote-escaping
# guesswork and stays correct even if the alternation is reordered or extended.
function Get-AcceptedRegex([string]$src) {
  $line = ($src -split "`n") | Where-Object { $_ -match '\$script:ConsentAffirmRe\s*=' } | Select-Object -First 1
  if (-not $line) { throw 'could not find $script:ConsentAffirmRe in oa-state.ps1' }
  $first = $line.IndexOf("'"); $last = $line.LastIndexOf("'")
  if ($first -lt 0 -or $last -le $first) { throw 'could not extract the regex literal' }
  return $line.Substring($first + 1, $last - $first - 1)
}

# --- extract the advertised vocabulary FROM SKILL.md ------------------------------------
function Get-AdvertisedPhrases([string]$skill) {
  $m = [regex]::Match($skill, '<!--\s*CONSENT-VOCAB:BEGIN\s*-->(.*?)<!--\s*CONSENT-VOCAB:END\s*-->', 'Singleline')
  if (-not $m.Success) { throw 'CONSENT-VOCAB block not found in SKILL.md' }
  $block = $m.Groups[1].Value
  return @([regex]::Matches($block, '`([^`]+)`') | ForEach-Object { $_.Groups[1].Value.Trim() })
}

# The check itself: which advertised phrases would the reader REJECT?
function Find-Drift([string]$re, [string[]]$phrases) {
  $rejected = @()
  foreach ($p in $phrases) { if (-not [regex]::IsMatch($p, $re)) { $rejected += $p } }
  return $rejected
}

$src = Read-Utf8 $ScriptPath
$skill = Read-Utf8 $SkillPath
$acceptedRe = Get-AcceptedRegex $src
$advertised = Get-AdvertisedPhrases $skill

Write-Host "=== BASELINE (advertised subset of accepted) ==="
Write-Host ("reader regex : {0}" -f $acceptedRe)
Write-Host ("advertised   : {0}" -f ($advertised -join ' | '))

$problems = 0

if ($advertised.Count -eq 0) { Write-Host "  FAIL: CONSENT-VOCAB block advertises nothing"; $problems++ }

$mergeForms = @($advertised | Where-Object { $_ -match '^merge\s+#?\d+$' })
if ($mergeForms.Count -eq 0) {
  Write-Host "  FAIL: the block advertises no command-shaped 'merge <number>' phrase (the #301 fix is missing)"
  $problems++
} else {
  Write-Host ("  ok: command-shaped merge advertised -> {0}" -f ($mergeForms -join ', '))
}

$baseDrift = Find-Drift $acceptedRe $advertised
if ($baseDrift.Count -gt 0) {
  Write-Host ("  FAIL: reader REJECTS advertised phrase(s): {0}" -f ($baseDrift -join ', '))
  $problems++
} else {
  Write-Host "  ok: every advertised phrase is accepted by the reader"
}

if ($problems -gt 0) { Write-Host ""; Write-Host "BASELINE FAILED"; exit 1 }
Write-Host "baseline OK"

if ($BaselineOnly) { exit 0 }

# --- mutations: prove the drift check actually catches drift -----------------------------
$killed = 0; $survived = 0

Write-Host ""
Write-Host "=== D_readerDrops: reader loses the merge token, SKILL.md still advertises merge 300 ==="
$mutRe = $acceptedRe -replace [regex]::Escape('|merge[ \t]+#?\d+'), ''
if ($mutRe -eq $acceptedRe) {
  Write-Host "  !! mutation did not apply (anchor moved) -- SURVIVED"; $survived++
} else {
  $drift = Find-Drift $mutRe $advertised
  if ($drift -contains 'merge 300') { Write-Host ("  -> KILLED (flagged: {0})" -f ($drift -join ', ')); $killed++ }
  else { Write-Host "  -> SURVIVED (check did not notice the reader dropped merge support)"; $survived++ }
}

Write-Host ""
Write-Host "=== D_skillOverAdvertises: SKILL.md advertises 'merge it later', which the reader rejects ==="
$badAdvertised = @($advertised + 'merge it later')
$drift2 = Find-Drift $acceptedRe $badAdvertised
if ($drift2 -contains 'merge it later') { Write-Host ("  -> KILLED (flagged: {0})" -f ($drift2 -join ', ')); $killed++ }
else { Write-Host "  -> SURVIVED (check did not notice an over-advertised phrase)"; $survived++ }

Write-Host ""
Write-Host "drift-arms killed $killed / $($killed + $survived)"
if ($survived -gt 0) { exit 1 }
exit 0
