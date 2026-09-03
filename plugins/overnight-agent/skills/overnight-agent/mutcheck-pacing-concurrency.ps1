<#
  mutcheck-pacing-concurrency.ps1 -- mutation check for how the `Overnight Agent concurrency`
  tunable (#391) is READ.

  WHAT THIS GUARDS, AND WHY IT IS NOT ALREADY COVERED

  #404 shipped the concurrency limit's ENFORCEMENT -- capacity refusal, release, the in-flight
  view -- and `mutcheck-per-task-session.ps1` guards that. Its arms L/M/N establish that an
  absent file yields 1, a malformed value yields 1, and a well-formed row is read at all.

  This file guards the RESOLUTION itself: the exact boundary between a value that parses and one
  that does not, the precedence of an explicit argument over the file, and whether a fallback is
  VISIBLE. Those are separable concerns, and the gap between them is where the bug below lived.

  THE BUG THIS WAS WRITTEN FOR (arm G, mutant M2) -- measured, not hypothetical

  The parse was a LEADING-integer match, so that a friendly `2 tasks` would work. But this
  settings file's cells are prose, and prose in this file characteristically opens with a date.
  Measured against the real build:

      | Overnight Agent concurrency | 2026-09-02: set to 1 by Shiv |   ->  concurrency 2026
      | Overnight Agent concurrency | 10 items                     |   ->  concurrency 10

  A note saying it was set to 1 therefore set it to 2026. That is unbounded in every practical
  sense, on the one control whose job is to stop a run over-committing -- and it is a WIDENING,
  which the surrounding comment promised was impossible ("a typo can narrow a run; it can never
  widen one"). The failure has no tell: a run that widened itself by a typo looks exactly like a
  run configured that way on purpose, and the only symptom is a half-finished item some other
  night.

  Anchoring the parse costs the `2 tasks` leniency. That trade is only safe because of arm D:
  a cell that does not parse now reports `concurrency_source: settings-malformed` instead of
  silently becoming 1. Narrowing a run the user can SEE was narrowed is recoverable; widening one
  nobody can see is not. The two arms are a pair and neither is sufficient alone.

  HOW TO READ THE RESULT

    powershell -File mutcheck-pacing-concurrency.ps1                 # arms only (fast)
    powershell -File mutcheck-pacing-concurrency.ps1 -Matrix         # prove the bijection
    powershell -File mutcheck-pacing-concurrency.ps1 -ScriptPath <p> # test another build

  Each mutant restores one specific way to get this wrong and must be killed by EXACTLY ONE arm;
  `-Matrix` asserts that mechanically rather than taking this comment's word for it. An arm may
  kill more than one mutant (several distinct bugs can surface as the same wrong answer); a
  mutant killed by nothing is a dead arm and fails the run.

  The pre-flight runs unconditionally and checks every mutant's target still occurs in the source
  the expected number of times -- a reformatted line turns a mutant into a silent no-op, and green
  arms beside dead mutants is the exact state this file exists to make impossible.

  Pure text work: each arm writes a synthetic user-settings.md into a temp dir and runs the REAL
  script's `session -InFlight` against it with -UserSettings and an isolated -StateDir. The live
  planner folder is never read and no real state is written.
#>
[CmdletBinding()]
param(
  [string]$ScriptPath,
  [switch]$Matrix,
  # For running against a PRE-FIX build, where the arms are expected to fail. Skips the target
  # pre-flight, whose targets cannot match a build that does not have the fix yet.
  [switch]$ExpectPreFix
)

$ErrorActionPreference = 'Stop'

if (-not $ScriptPath) { $ScriptPath = Join-Path $PSScriptRoot 'oa-state.ps1' }
if (-not (Test-Path $ScriptPath)) { throw "oa-state.ps1 not found at $ScriptPath" }

$script:Root = Join-Path ([IO.Path]::GetTempPath()) ("oa-pace-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
$script:StateDir = Join-Path $script:Root 'state'
New-Item -ItemType Directory -Path $script:StateDir -Force | Out-Null

function New-Settings {
  # A synthetic user-settings.md carrying at most the one row under test.
  #
  # $Value is deliberately UNTYPED. A [string] parameter coerces $null to the empty string, so
  # "no row at all" and "a row with an empty cell" would collapse into a single case -- and those
  # are exactly the two cases arms A and E exist to tell apart. (Caught by the matrix, which
  # reported M8 killed by both A and E while they were secretly the same fixture.)
  param($Value)
  $sb = "## Overnight Agent behaviour`n`n| Setting | Value |`n| --- | --- |`n"
  $sb += "| Today gate backstop | ``6h`` |`n"
  if ($null -ne $Value) { $sb += "| Overnight Agent concurrency | $Value |`n" }
  $path = Join-Path $script:Root ("s-" + [guid]::NewGuid().ToString('N').Substring(0, 6) + '.md')
  [IO.File]::WriteAllText($path, $sb, [Text.UTF8Encoding]::new($false))
  return $path
}

function Get-Pacing {
  # Runs the script under test and returns its parsed `session -InFlight` JSON, or $null if it
  # failed. A crashed mutant counts as killed, which is correct: it also does not resolve the
  # setting.
  param([string]$Build, $Value, [string[]]$Extra = @())
  $settings = New-Settings $Value
  $a = @('session', '-InFlight', '-UserSettings', $settings, '-StateDir', $script:StateDir) + $Extra
  # $ErrorActionPreference is relaxed for the call itself. At 'Stop', a child process writing
  # ANYTHING to stderr raises a terminating NativeCommandError -- which is not a test result, it
  # is the harness crashing. That matters most under -ExpectPreFix, where the build under test
  # may reject the arguments noisily; the correct reading of that is "every arm fails".
  $out = $null
  try {
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { $out = & powershell -NoProfile -ExecutionPolicy Bypass -File $Build @a 2>$null }
    finally { $ErrorActionPreference = $old }
  }
  catch { return $null }
  if ($LASTEXITCODE -ne 0 -or -not $out) { return $null }
  try { return (($out -join "`n") | ConvertFrom-Json) } catch { return $null }
}

function Test-Value {
  param($p, [int]$Expected)
  if ($null -eq $p) { return $false }
  return ([int]$p.concurrency -eq $Expected)
}

function Test-Source {
  param($p, [string]$Expected)
  if ($null -eq $p) { return $false }
  return ("$($p.concurrency_source)" -eq $Expected)
}

function Invoke-Arms {
  param([string]$Build)
  $r = [ordered]@{}

  # A. THE DEFAULT HOLDS WHEN NOTHING SAYS OTHERWISE. No row at all -> 1, and the provenance says
  #    so. This keeps "1" meaning one item in flight on a machine never configured.
  $p = Get-Pacing $Build $null
  $r['A default-with-no-row'] = (Test-Value $p 1) -and (Test-Source $p 'default')

  # B. A WELL-FORMED ROW ACTUALLY APPLIES. The other half of a tunable: a setting that cannot
  #    change anything is not a setting.
  $r['B settings-row-applies'] = Test-Value (Get-Pacing $Build '3') 3

  # C. THE TEMPLATE'S OWN FORMATTING PARSES. user-settings.md writes values in backticks, so a
  #    user who copies the surrounding rows must not be punished for it. Asserted on the SOURCE,
  #    so it fails only when the cell stops parsing at all.
  $r['C backticked-value-parses'] = Test-Source (Get-Pacing $Build '`2`') 'settings'

  # D. A VALUE THAT DOES NOT PARSE IS VISIBLE. This is the arm that makes anchoring safe: `0` is
  #    refused AND reported as a typo, rather than silently becoming 1 and looking like consent.
  $p = Get-Pacing $Build '0'
  $r['D unparsable-value-is-visible'] = (Test-Value $p 1) -and (Test-Source $p 'settings-malformed')

  # E. AN EMPTY CELL IS NOT A TYPO. Deleting the value is how a user reverts to the default, so it
  #    must read as `default` and not be reported back at them as malformed.
  $r['E empty-cell-is-default'] = Test-Source (Get-Pacing $Build '') 'default'

  # F. A NON-NUMERIC VALUE NARROWS. Regression coverage for the direction that matters.
  $r['F word-value-narrows'] = Test-Value (Get-Pacing $Build 'many') 1

  # G. PROSE IN THE CELL MUST NEVER WIDEN THE RUN. Both measured cases, in one arm because a
  #    single mutant (the unanchored parse) causes both and the bijection must stay honest. The
  #    dated form is the one that actually occurred: a note saying "set to 1" read as 2026.
  $r['G prose-cell-does-not-widen'] =
    (Test-Value (Get-Pacing $Build '10 items') 1) -and
    (Test-Value (Get-Pacing $Build '2026-09-02: set to 1 by Shiv') 1)

  # H. AN EXPLICIT ARGUMENT OUTRANKS THE FILE. The documented precedence -- and untested before
  #    this file, so a build could ignore -Concurrency entirely and stay green.
  $r['H argument-outranks-settings'] = Test-Value (Get-Pacing $Build '3' @('-Concurrency', '5')) 5

  # I. A NONSENSE ARGUMENT NARROWS TOO. The sentinel guard: `-Concurrency 0` (and the internal -1
  #    "not specified" default) must land on 1, not on 0, or the run can start nothing at all.
  $r['I bogus-argument-narrows'] = Test-Value (Get-Pacing $Build $null @('-Concurrency', '0')) 1

  return $r
}

# --- mutants ---------------------------------------------------------------------------------
# Each restores exactly one real way to get this wrong. `count` is asserted before use.
$Mutants = [ordered]@{
  'M1 accept-zero-as-a-value' = @{
    kills = 'D'
    edits = @(@{
        find  = "if (`$n -ge 1) { `$value = `$n; `$source = 'settings' }"
        with  = "if (`$n -ge -99) { `$value = `$n; `$source = 'settings' }"
        count = 1
      })
  }
  # The one that actually happened. See the header.
  'M2 unanchored-leading-integer' = @{
    kills = 'G'
    edits = @(@{
        find  = "if (`$v -match '^\s*(\d+)\s*`$') {"
        with  = "if (`$v -match '^\s*(\d+)') {"
        count = 1
      })
  }
  'M3 backticks-not-stripped' = @{
    kills = 'C'
    edits = @(@{
        find  = "-replace '``', ''"
        with  = "-replace 'THIS_NEVER_MATCHES', ''"
        count = 1
      })
  }
  'M4 typo-reported-as-configured' = @{
    kills = 'D'
    edits = @(@{
        find  = "`$source = 'settings-malformed'"
        with  = "`$source = 'settings'"
        count = 1
      })
  }
  'M5 argument-ignored' = @{
    kills = 'H'
    edits = @(@{
        find  = "else { `$value = `$Concurrency; `$source = 'argument' }"
        with  = "else { `$source = 'argument' }"
        count = 1
      })
  }
  'M6 sentinel-unguarded' = @{
    kills = 'I'
    edits = @(@{
        find  = 'if ($value -lt 1) {'
        with  = 'if ($false) {'
        count = 1
      })
  }
  'M8 empty-cell-called-a-typo' = @{
    kills = 'E'
    edits = @(@{
        find  = "if (`$null -ne `$v -and `$v -ne '') {"
        with  = 'if ($null -ne $v) {'
        count = 1
      })
  }
  'M9 value-parsed-then-discarded' = @{
    kills = 'B'
    edits = @(@{
        find  = "if (`$n -ge 1) { `$value = `$n; `$source = 'settings' }"
        with  = "if (`$n -ge 1) { `$value = 1; `$source = 'settings' }"
        count = 1
      })
  }
}

function ConvertTo-Lf {
  param([string]$s)
  if ($null -eq $s) { return $s }
  return $s.Replace("`r`n", "`n")
}

function Get-NormalisedSource {
  # CRLF collapsed to LF so a mutant matches the same source in the CRLF repo checkout and in the
  # LF copies the deployer writes to installed-plugins / %LOCALAPPDATA%. Without this a mutant can
  # match in one tree and be a silent no-op in the other.
  param([string]$Path)
  return (ConvertTo-Lf ([IO.File]::ReadAllText($Path)))
}

function Test-MutantTargets {
  # Runs on EVERY invocation, not just under -Matrix. A mutant whose target has been reformatted
  # away is a no-op, and the arms would still pass -- what rots is the proof that the arms are
  # load-bearing, which is this file's entire stated value.
  $script:MutantTargetsOk = $true
  $text = Get-NormalisedSource $ScriptPath
  $drifted = @()
  foreach ($mName in $Mutants.Keys) {
    foreach ($e in $Mutants[$mName].edits) {
      $n = ([regex]::Matches($text, [regex]::Escape((ConvertTo-Lf $e.find)))).Count
      if ($n -ne $e.count) { $drifted += "$mName -- expected $($e.count) occurrence(s) of its target, found $n" }
    }
  }
  if ($drifted.Count -gt 0) {
    $script:MutantTargetsOk = $false
    'MUTANT TARGETS HAVE DRIFTED - the arms below prove nothing about these mutants:'
    foreach ($d in $drifted) { "  $d" }
    ''
    return
  }
  "  targets OK  $($Mutants.Count) mutants still match the source"
  ''
}

function New-Mutant {
  param([string]$Name, $Spec)
  $text = Get-NormalisedSource $ScriptPath
  foreach ($e in $Spec.edits) {
    $find = ConvertTo-Lf $e.find
    $n = ([regex]::Matches($text, [regex]::Escape($find))).Count
    if ($n -ne $e.count) {
      throw "mutant '$Name': expected $($e.count) occurrence(s), found $n -- silent no-op"
    }
    $text = $text.Replace($find, (ConvertTo-Lf $e.with))
  }
  $out = Join-Path ([IO.Path]::GetTempPath()) ("oa-pace-mutant-" + [guid]::NewGuid().ToString('N').Substring(0, 8) + '.ps1')
  # WITH a BOM, matching oa-state.ps1: stripping it makes PowerShell 5.1 decode the file as the
  # ANSI codepage, so the mutant would differ in a second, unrelated way.
  [IO.File]::WriteAllText($out, $text, (New-Object Text.UTF8Encoding($true)))
  return $out
}

try {
  $script:MutantTargetsOk = $true
  if (-not $ExpectPreFix) { Test-MutantTargets }

  $results = Invoke-Arms $ScriptPath
  $pass = 0; $fail = 0
  foreach ($k in $results.Keys) {
    if ($results[$k]) { "  PASS  $k"; $pass++ } else { "  FAIL  $k"; $fail++ }
  }
  ''
  "$pass passed, $fail failed  (script: $ScriptPath)"

  if ($ExpectPreFix) {
    if ($fail -eq 0) { 'MUTCHECK FAILED: pre-fix script passed everything - the fix guards nothing.'; exit 1 }
    "MUTCHECK OK: pre-fix script fails $fail arm(s), as required."
    exit 0
  }

  if ($fail -gt 0) { exit 1 }
  if (-not $script:MutantTargetsOk) { exit 1 }
  if (-not $Matrix) { exit 0 }

  ''
  "ARM x MUTANT MATRIX  ('x' = arm fails, i.e. it kills that mutant)"
  ''
  $armKeys = @($results.Keys)
  $armLetters = @($armKeys | ForEach-Object { $_.Substring(0, 1) })
  ('  {0,-34}  {1}' -f 'mutant', ($armLetters -join ' '))
  ('  {0,-34}  {1}' -f ('-' * 34), (($armLetters | ForEach-Object { '-' }) -join ' '))

  $bijectionOk = $true
  foreach ($mName in $Mutants.Keys) {
    $spec = $Mutants[$mName]
    $mPath = New-Mutant $mName $spec
    try { $mRes = Invoke-Arms $mPath } finally { Remove-Item $mPath -Force -ErrorAction SilentlyContinue }
    $cells = @(); $killers = @()
    for ($i = 0; $i -lt $armKeys.Count; $i++) {
      $failed = -not $mRes[$armKeys[$i]]
      $cells += $(if ($failed) { 'x' } else { '.' })
      if ($failed) { $killers += $armLetters[$i] }
    }
    $verdict = ''
    if ($killers.Count -eq 0) { $verdict = '  <-- KILLED BY NOTHING'; $bijectionOk = $false }
    elseif ($killers.Count -gt 1) { $verdict = "  <-- KILLED BY $($killers.Count): $($killers -join ',')"; $bijectionOk = $false }
    elseif ($killers[0] -ne $spec.kills) { $verdict = "  <-- expected $($spec.kills), killed by $($killers[0])"; $bijectionOk = $false }
    ('  {0,-34}  {1}{2}' -f $mName, ($cells -join ' '), $verdict)
  }
  ''
  if (-not $bijectionOk) { 'BIJECTION FAILED: a mutant is killed by nothing, or by more than one arm.'; exit 1 }
  'BIJECTION OK: every mutant is killed by exactly the arm that claims it.'
  exit 0
}
finally {
  Remove-Item -Recurse -Force $script:Root -ErrorAction SilentlyContinue
}
