<#
  mutcheck-reaper-cohort.ps1 -- proves the cohort rule in reap-stale-mcp.ps1 is load-bearing:
  that it collects a finished run's leftovers under a LIVE host, and that it cannot take a
  running session's servers away.

  THE INVARIANT
    Under one session host, only the NEWEST start-time cohort is in use:
      - older cohort, newer cohort exists  -> SUPERSEDED (a finished run's leftovers)
      - newest cohort                      -> SPARE      (the live session)
      - only one cohort                    -> SPARE      (nothing has replaced it)
    Neither age nor owner-liveness may override that in either direction.

  WHY OWNERSHIP ALONE WAS NOT ENOUGH (GH #177)
    The ownership veto (GH #178) assumes "one live host == one live session". That holds for
    CONCURRENT sessions -- they land on different hosts -- but not for SUCCESSIVE ones, because
    github.exe pools `copilot.exe --server --stdio` hosts and reuses them. A reused host is
    genuinely active on behalf of its newest session, so it vetoes every older cohort forever.

    Measured on this machine, one host:
        copilot.exe 6236 -- 4 cohorts, 24 MCP children, 1704 MB, 1 live tool-shell
          21:33   5 servers   292 MB   finished run
          22:12   6 servers   436 MB   finished run
          22:36   6 servers   436 MB   finished run
          23:10   6 servers   439 MB   the live session
        reaper verdict: killed 0, sparedLiveOwner 29.

    17 servers / 1164 MB were unreachable by every rule that existed, growing ~436 MB per run,
    while the reaper reported perfect health. That is the defect, not a simulation of it.

    Verified against the same live box after the fix, with the age floor dropped to 1 minute so
    the live cohort is age-eligible and only the rule can save it:
        spared ages: 10,10,10,10,10,10,10,10,10,10          <- the live cohort
        kill   ages: 107 x9, 68 x10, 44 x10                 <- the three finished runs
    and `-NoCohortVeto` reproduced the old `killed 0 / sparedLiveOwner 29` exactly.

  THE MUTANTS
    M1  cohort start never advances       -> T4old must flip (the leak returns: nothing collected)
    M2  supersede on ANY newer sibling    -> T3 must flip (a mid-session restart kills its own cohort)
    M3  boundary -lt becomes -le          -> T4new must flip (the live cohort's first server dies)
    M4  always return $true               -> the spare cases must flip (rule is total)
    M5  ignore GapMinutes <= 0            -> T6 must flip (the escape hatch stops disabling it)

    A mutant that changes nothing is a guard that is not doing work. THREE earlier candidates
    were dropped for exactly that reason, and the outcome is recorded here rather than buried:
      - an explicit "fewer than 2 siblings" return  -> survived; deleted from the script
      - an explicit "no cut was made" return        -> survived; deleted from the script
      - deleting the empty-input guard              -> survived; the GUARD was KEPT anyway
    The first two were dead code. The third is kept deliberately as intent-documentation: with
    no siblings the cohort start is $null and PowerShell already evaluates `$Started -lt $null`
    as $false, so the guard is a statement of intent over an implicit rule, not a behavioural
    protection. It is therefore NOT asserted as a mutant -- claiming it were load-bearing would
    be false.

  NEVER TOUCHES LIVE STATE
    No processes are started, inspected or killed. Every input is a synthetic datetime list.
#>
[CmdletBinding()]
param(
  [string]$ScriptPath
)

$ErrorActionPreference = 'Stop'

if (-not $ScriptPath) {
  $ScriptPath = Join-Path $PSScriptRoot '..\skills\overnight-agent\reap-stale-mcp.ps1'
  if (-not (Test-Path $ScriptPath)) { $ScriptPath = Join-Path $PSScriptRoot 'reap-stale-mcp.ps1' }
}
$ScriptPath = [IO.Path]::GetFullPath($ScriptPath)
if (-not (Test-Path $ScriptPath)) { throw "reap-stale-mcp.ps1 not found at $ScriptPath" }

# Explicit UTF-8 decode. A bare Get-Content -Raw is host-dependent on this project's files.
$src = [IO.File]::ReadAllText($ScriptPath, (New-Object Text.UTF8Encoding($false)))

# Brace-matched extraction, so a nested block inside the function cannot truncate it and leave
# us silently testing a fragment.
function Get-FunctionSource {
  param([string]$Text, [string]$Name)
  $start = $Text.IndexOf("function $Name")
  if ($start -lt 0) { throw "function $Name not found in $ScriptPath" }
  $open = $Text.IndexOf('{', $start)
  if ($open -lt 0) { throw "no opening brace for $Name" }
  $depth = 0
  for ($i = $open; $i -lt $Text.Length; $i++) {
    if ($Text[$i] -eq '{') { $depth++ }
    elseif ($Text[$i] -eq '}') {
      $depth--
      if ($depth -eq 0) { return $Text.Substring($start, $i - $start + 1) }
    }
  }
  throw "unbalanced braces extracting $Name"
}

$fnSrc = Get-FunctionSource -Text $src -Name 'Test-IsSupersededCohort'

$script:Pass = 0
$script:Fail = 0
function Assert($name, $cond, $detail) {
  if ($cond) { $script:Pass++; Write-Host ("  ok    {0}" -f $name) -ForegroundColor Green }
  else       { $script:Fail++; Write-Host ("  FAIL  {0}  {1}" -f $name, $detail) -ForegroundColor Red }
}

$t0 = Get-Date '2026-08-28T21:33:00'

# --- fixtures, taken from the real measurement above -----------------------
# T1 a single server under a host (nothing to compare against)
$fxLone = @([datetime[]]@($t0))

# T2 ONE cohort, six servers spawned within seconds -- a live session, no predecessor
$fxSingleCohort = [datetime[]]@(
  $t0, $t0.AddSeconds(1), $t0.AddSeconds(4), $t0.AddSeconds(5), $t0.AddSeconds(9), $t0.AddSeconds(11)
)

# T3 live cohort PLUS a mid-session MCP restart 4 minutes later. The restart must join the live
# cohort, not orphan the five servers it started with. This is the case a naive "is anything
# newer than me" test gets wrong, and it was observed live (an email-mcp respawn at +4 min).
$fxRestart = [datetime[]]@(
  $t0, $t0.AddSeconds(1), $t0.AddSeconds(4), $t0.AddSeconds(5), $t0.AddSeconds(9), $t0.AddMinutes(4)
)

# T4 two cohorts 39 minutes apart -- the real 21:33 -> 22:12 gap
$fxTwoCohorts = [datetime[]]@(
  $t0, $t0.AddSeconds(4), $t0.AddSeconds(12),
  $t0.AddMinutes(39), $t0.AddMinutes(39).AddSeconds(3), $t0.AddMinutes(39).AddSeconds(6)
)

# T5 the full four-cohort host: 21:33 / 22:12 / 22:36 / 23:10
$fxFour = [datetime[]]@(
  $t0, $t0.AddSeconds(12),
  $t0.AddMinutes(39), $t0.AddMinutes(39).AddSeconds(6),
  $t0.AddMinutes(63), $t0.AddMinutes(63).AddSeconds(5),
  $t0.AddMinutes(97), $t0.AddMinutes(97).AddSeconds(5)
)

function Invoke-Rule {
  param([scriptblock]$Fn, [datetime]$Started, [datetime[]]$Siblings, [int]$Gap = 15)
  . $Fn
  Test-IsSupersededCohort -Started $Started -SiblingStarts $Siblings -GapMinutes $Gap
}

function Test-Suite {
  param([string]$Src, [switch]$Baseline)
  $fn = [scriptblock]::Create($Src)
  [pscustomobject]@{
    # T0 no evidence at all -> must spare
    T0 = Invoke-Rule $fn $t0 ([datetime[]]@())
    # T1 lone server -> never superseded
    T1 = Invoke-Rule $fn $t0 $fxLone
    # T2 single cohort -> no member superseded (checked at both ends)
    T2a = Invoke-Rule $fn $t0 $fxSingleCohort
    T2b = Invoke-Rule $fn $t0.AddSeconds(11) $fxSingleCohort
    # T3 restart case -> the original servers must SURVIVE
    T3 = Invoke-Rule $fn $t0 $fxRestart
    # T4 two cohorts -> old superseded, new spared. T4new is the boundary: it is the newest
    # cohort's FIRST spawn, i.e. exactly equal to the cut point.
    T4old = Invoke-Rule $fn $t0 $fxTwoCohorts
    T4new = Invoke-Rule $fn $t0.AddMinutes(39) $fxTwoCohorts
    # T5 four cohorts -> only the newest spared
    T5c1 = Invoke-Rule $fn $t0 $fxFour
    T5c2 = Invoke-Rule $fn $t0.AddMinutes(39) $fxFour
    T5c3 = Invoke-Rule $fn $t0.AddMinutes(63) $fxFour
    T5c4 = Invoke-Rule $fn $t0.AddMinutes(97) $fxFour
    # T6 the escape hatch: gap 0 disables the rule entirely
    T6 = Invoke-Rule $fn $t0 $fxFour 0
  }
}

Write-Host "`nreap-stale-mcp.ps1 -- cohort rule (GH #177)" -ForegroundColor Cyan
Write-Host "  $ScriptPath`n"

Write-Host 'BASELINE: the shipped rule'
$base = Test-Suite -Src $fnSrc -Baseline
Assert 'T0 empty evidence spares'                      (-not $base.T0)   "got $($base.T0)"
Assert 'T1 lone server is never superseded'            (-not $base.T1)   "got $($base.T1)"
Assert 'T2 single cohort spared (first member)'        (-not $base.T2a)  "got $($base.T2a)"
Assert 'T2 single cohort spared (last member)'         (-not $base.T2b)  "got $($base.T2b)"
Assert 'T3 mid-session restart does not orphan cohort' (-not $base.T3)   "got $($base.T3)"
Assert 'T4 older cohort IS superseded'                 ($base.T4old)     "got $($base.T4old)"
Assert 'T4 newest cohort is spared (boundary)'         (-not $base.T4new) "got $($base.T4new)"
Assert 'T5 cohort 1 of 4 superseded'                   ($base.T5c1)      "got $($base.T5c1)"
Assert 'T5 cohort 2 of 4 superseded'                   ($base.T5c2)      "got $($base.T5c2)"
Assert 'T5 cohort 3 of 4 superseded'                   ($base.T5c3)      "got $($base.T5c3)"
Assert 'T5 newest of 4 spared'                         (-not $base.T5c4) "got $($base.T5c4)"
Assert 'T6 GapMinutes 0 disables the rule'             (-not $base.T6)   "got $($base.T6)"

# --- mutants ---------------------------------------------------------------
$mutants = @(
  @{ Name = 'M1: cohort start never advances (nothing is ever collected)'
     Apply = { param($s) $s -replace '\$newestCohortStart = \$sorted\[\$i\]', '$newestCohortStart = $sorted[0]' }
     Expect = 'T4OLD' }
  @{ Name = 'M2: any newer sibling supersedes (no clustering)'
     Apply = { param($s) $s -replace '\.TotalMinutes -gt \$GapMinutes', '.TotalMinutes -ge 0' }
     Expect = 'T3' }
  @{ Name = 'M3: boundary -lt becomes -le'
     Apply = { param($s) $s -replace 'return \(\$Started -lt \$newestCohortStart\)', 'return ($Started -le $newestCohortStart)' }
     Expect = 'T4NEW' }
  @{ Name = 'M4: always superseded'
     Apply = { param($s) $s -replace '(?s)(param\(\s*\[datetime\] \$Started,.*?\)\s*\n)', "`$1`n    return `$true`n" }
     Expect = 'TOTAL' }
  @{ Name = 'M5: GapMinutes <= 0 no longer disables'
     Apply = { param($s) $s -replace '(?m)^\s*if \(\$GapMinutes -le 0\) \{ return \$false \}\s*$', "`n" }
     Expect = 'T6' }
)

foreach ($m in $mutants) {
  Write-Host "`n$($m.Name)"
  $mutSrc = & $m.Apply $fnSrc
  if ($mutSrc -eq $fnSrc) {
    Assert "$($m.Name) mutation applied" $false 'pattern did not match -- the check is testing nothing'
    continue
  }
  Assert 'mutation applied' $true ''

  $r = $null
  try { $r = Test-Suite -Src $mutSrc } catch {
    # A mutant that cannot even run still counts as killed, but say so plainly.
    Assert 'mutant killed (threw)' $true ''
    continue
  }

  switch ($m.Expect) {
    'T0'     { Assert 'killed: empty evidence would supersede'          ($r.T0)  'T0 unchanged' }
    'T3'     { Assert 'killed: a restart would orphan its own cohort'   ($r.T3)  'T3 unchanged' }
    'T6'     { Assert 'killed: escape hatch would stop disabling'       ($r.T6)  'T6 unchanged' }
    'T4OLD'  { Assert 'killed: stale cohort would never be collected'   (-not $r.T4old) 'T4old unchanged -- the leak would persist' }
    'T4NEW'  { Assert 'killed: live cohort would lose its first server' ($r.T4new) 'T4new unchanged' }
    'TOTAL'  {
      Assert 'killed: single cohort would be superseded'  ($r.T2a) 'T2a unchanged'
      Assert 'killed: newest cohort would be superseded'  ($r.T4new) 'T4new unchanged'
      Assert 'killed: restart case would be superseded'   ($r.T3)  'T3 unchanged'
    }
  }
}

Write-Host ''
if ($script:Fail -gt 0) {
  Write-Host ("FAIL  {0} passed, {1} failed" -f $script:Pass, $script:Fail) -ForegroundColor Red
  exit 1
}
Write-Host ("PASS  {0} assertions" -f $script:Pass) -ForegroundColor Green
exit 0
