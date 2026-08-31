<#
  mutcheck-split-settings.ps1 -- prove the guards in split-user-settings.ps1 are load-bearing.

  Every arm below re-introduces a hole that ACTUALLY EXISTED in this script while it was being
  written, and each must be caught by a DIFFERENT guard. An arm that no longer fails means the
  guard it targets has stopped doing anything, which is the failure mode this file exists to
  detect: a safety check that has quietly become decorative still reports success.

  Arms:
    m1  Test-Keep typed [string] again      -> preamble silently archived        (g1 preamble)
    m2  drop the already-trimmed skip       -> trim is not a fixed point         (g4)
    m3  g6 baseline ignores existing lore   -> false refusal on a clean re-run   (g6 baseline)
    m4  drop the Get-Span empty-range guard -> reassembly inflates               (g1 reassembly)
    m5  index built from this run's moves   -> index empties on re-run           (index source)
    m6  a non-ASCII literal in emitted text -> mojibake reaches disk             (g6)

  Run:  powershell -NoProfile -ExecutionPolicy Bypass -File mutcheck-split-settings.ps1
  Exit: 0 all mutations killed; 1 a mutation SURVIVED (a guard is not load-bearing).
#>

[CmdletBinding()]
param([switch] $Verbose2)

$ErrorActionPreference = 'Stop'
$enc    = New-Object Text.UTF8Encoding($false)
$script = Join-Path $PSScriptRoot 'split-user-settings.ps1'
if (-not (Test-Path $script)) { throw "not found: $script" }
$src = [IO.File]::ReadAllText($script, $enc)

function New-Fixture {
  param([switch] $HeadingFirst)
  $d = Join-Path ([IO.Path]::GetTempPath()) ("oa262mut-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
  New-Item -ItemType Directory -Path $d | Out-Null
  $nl = "`r`n"
  $lines = @()
  if (-not $HeadingFirst) {
    $lines += '# Overnight Agent - user settings'
    $lines += ''
    $lines += 'PREAMBLE-SENTINEL: this line proves the header survived.'
    $lines += ''
  }
  $lines += '## Settings'
  $lines += ''
  $lines += '| Setting | Value |'
  $lines += '| --- | --- |'
  $lines += '| Planner board | `C:\board\planner.md` |'
  $lines += ('| Fat row | ' + ('OPERATIVE-HEAD. ' + ('filler sentence to blow the budget. ' * 40) + 'TAIL-SENTINEL.') + ' |')
  $lines += ''
  $lines += '## Run learnings - 2026-01-01 (history)'
  $lines += ''
  # Exactly ONE character that encodes to the C3 A2 byte pair (U+00E2), placed in an ARCHIVED
  # section so it ends up in the lore file. Without it every fixture file is pure ASCII, the
  # mojibake baseline is 0 on both sides, and m3 cannot bite: dropping the lore file from g6's
  # baseline changes 0-vs-0 into 0-vs-0. Built from a code point, never a literal, because this
  # harness is itself run under Windows PowerShell 5.1 and would otherwise corrupt its own source.
  $lines += ('ARCHIVE-SENTINEL body text with ' + [string][char]0x00E2 + ' one non-ASCII byte pair.')
  $lines += ''
  $lines += '## Some standing rule that is not a setting'
  $lines += ''
  $lines += 'RULE-SENTINEL body text.'
  $lines += ''
  [IO.File]::WriteAllText((Join-Path $d 'user-settings.md'), ($lines -join $nl), $enc)
  return $d
}

function Invoke-Split {
  param([string] $ScriptPath, [string] $Dir)
  # A mutated script is EXPECTED to write to stderr. With $ErrorActionPreference='Stop', a native
  # command's stderr surfaces as a terminating NativeCommandError and kills the harness on the
  # first successfully-killed mutant -- i.e. the suite would abort precisely when it is working.
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $out = & powershell -NoProfile -ExecutionPolicy Bypass -File $ScriptPath -SettingsPath (Join-Path $Dir 'user-settings.md') -Json 2>&1
    $code = $LASTEXITCODE
  } finally { $ErrorActionPreference = $old }
  return [pscustomobject]@{ Exit = $code; Out = ($out | Out-String) }
}

# Facts a healthy run must produce. Returns a hashtable of observations that each arm inspects.
function Measure-Run {
  param([string] $ScriptPath, [switch] $HeadingFirst)
  $d = New-Fixture -HeadingFirst:$HeadingFirst
  $sp = Join-Path $d 'user-settings.md'
  $lp = Join-Path $d 'agent-lore.md'
  $r1 = Invoke-Split $ScriptPath $d
  $s1 = if (Test-Path $sp) { [IO.File]::ReadAllText($sp, $enc) } else { '' }
  $l1 = if (Test-Path $lp) { [IO.File]::ReadAllText($lp, $enc) } else { '' }
  $r2 = Invoke-Split $ScriptPath $d
  $s2 = if (Test-Path $sp) { [IO.File]::ReadAllText($sp, $enc) } else { '' }
  $l2 = if (Test-Path $lp) { [IO.File]::ReadAllText($lp, $enc) } else { '' }

  # Third run models the STEADY STATE, which is the only state this script really lives in: the
  # agent appends a new dated note to user-settings.md every run, so the next split has real work
  # to do against an ALREADY-POPULATED lore file. A harness that only ever tests "split once, then
  # re-run unchanged" never exercises that path -- and the no-op gate means run 2 writes nothing,
  # so any guard inside the write block is unreachable there.
  if (Test-Path $sp) {
    $nl = "`r`n"
    $add = @('', '## Run learnings - 2026-02-02 (appended after the split)', '',
             ('APPEND-SENTINEL with ' + [string][char]0x00E2 + ' another non-ASCII byte pair.'), '') -join $nl
    [IO.File]::WriteAllText($sp, ([IO.File]::ReadAllText($sp, $enc).TrimEnd() + $nl + $add), $enc)
  }
  $r3 = Invoke-Split $ScriptPath $d
  $s3 = if (Test-Path $sp) { [IO.File]::ReadAllText($sp, $enc) } else { '' }
  $l3 = if (Test-Path $lp) { [IO.File]::ReadAllText($lp, $enc) } else { '' }

  $pairs = 0
  foreach ($f in @('user-settings.md', 'agent-lore.md')) {
    $p = Join-Path $d $f
    if (Test-Path $p) {
      $b = [IO.File]::ReadAllBytes($p)
      for ($i = 0; $i -lt $b.Length - 1; $i++) { if ($b[$i] -eq 0xC3 -and ($b[$i+1] -eq 0xA2 -or $b[$i+1] -eq 0xB0)) { $pairs++ } }
    }
  }
  Remove-Item $d -Recurse -Force -EA SilentlyContinue
  return @{
    Exit1 = $r1.Exit; Exit2 = $r2.Exit; Exit3 = $r3.Exit
    Settings1 = $s1; Settings2 = $s2; Settings3 = $s3
    Lore1 = $l1; Lore2 = $l2; Lore3 = $l3
    Stable = ($s1 -eq $s2 -and $l1 -eq $l2)
    Pairs = $pairs
    Out1 = $r1.Out; Out2 = $r2.Out; Out3 = $r3.Out
  }
}

# ------------------------------------------------------------------ baseline --
Write-Host '[mutcheck] baseline (unmutated script)...'
$base = Measure-Run $script
$baseFails = @()
if ($base.Exit1 -ne 0)                                  { $baseFails += 'run1 did not exit 0' }
if ($base.Exit2 -ne 0)                                  { $baseFails += 'run2 did not exit 0' }
if (-not $base.Stable)                                  { $baseFails += 'not a fixed point' }
if ($base.Settings1 -notmatch 'PREAMBLE-SENTINEL')      { $baseFails += 'preamble lost' }
if ($base.Settings1 -notmatch 'OPERATIVE-HEAD')         { $baseFails += 'cell head lost' }
if ($base.Lore1     -notmatch 'TAIL-SENTINEL')          { $baseFails += 'cell tail not archived' }
if ($base.Lore1     -notmatch 'ARCHIVE-SENTINEL')       { $baseFails += 'history not archived' }
if ($base.Lore1     -notmatch 'RULE-SENTINEL')          { $baseFails += 'rule not archived' }
if ($base.Settings1 -notmatch 'Some standing rule')     { $baseFails += 'rule heading not indexed' }
if ($base.Settings2 -notmatch 'Some standing rule')     { $baseFails += 'index emptied on re-run' }
if ($base.Exit3 -ne 0)                                  { $baseFails += 'run3 (appended note) did not exit 0' }
if ($base.Lore3     -notmatch 'APPEND-SENTINEL')        { $baseFails += 'appended note not archived on run3' }
if ($base.Pairs -ne 2)                                  { $baseFails += "mojibake drift (expected 2, got $($base.Pairs))" }
$baseAssertions = 13
if ($baseFails.Count -gt 0) {
  Write-Host "[mutcheck] BASELINE FAILED: $($baseFails -join '; ')" -ForegroundColor Red
  Write-Host $base.Out1
  Write-Host $base.Out3
  exit 1
}
Write-Host "[mutcheck] baseline OK ($baseAssertions assertions)."

# ------------------------------------------------------------------- arms -----
$arms = @(
  @{ Name = 'm1 Test-Keep typed [string] (preamble archived)'
     From = 'function Test-Keep($Heading) {'
     To   = 'function Test-Keep([string]$Heading) {'
     Also = @{ From = 'if ([string]::IsNullOrWhiteSpace($Heading)) { return $true }   # preamble always stays'
               To   = 'if ($null -eq $Heading) { return $true }   # preamble always stays' }
     Check = { param($m) $m.Exit1 -eq 0 -and $m.Settings1 -match 'PREAMBLE-SENTINEL' } }

  @{ Name = 'm2 drop already-trimmed skip (trim not a fixed point)'
     From = "-not `$val.Contains(`$POINTER_TOKEN)) {"
     To   = "`$true) {"
     Check = { param($m) $m.Stable } }

  @{ Name = 'm3 g6 baseline ignores existing lore (false refusal)'
     From = '$srcPairs = (Count-MojibakePairs $bak) + $preLorePairs'
     To   = '$srcPairs = (Count-MojibakePairs $bak)'
     Check = { param($m) $m.Exit3 -eq 0 } }

  @{ Name = 'm4 drop Get-Span empty-range guard (reassembly inflates)'
     From = '  if ($End -lt $Start) { return @() }'
     To   = '  if ($false) { return @() }'
     HeadingFirst = $true
     Check = { param($m) $m.Exit1 -eq 0 } }

  @{ Name = 'm5 index built from this run''s moves (empties on re-run)'
     From = '$rules   = @($loreHeadings | Where-Object'
     To   = '$rules   = @(@($moved | ForEach-Object { $_.Heading }) | Where-Object'
     Also = @{ From = '$history = @($loreHeadings | Where-Object'
               To   = '$history = @(@($moved | ForEach-Object { $_.Heading }) | Where-Object' }
     Check = { param($m) $m.Settings2 -match 'Some standing rule' } }

  @{ Name = 'm6 non-ASCII literal in emitted text (mojibake reaches disk)'
     From = "`$idx.Add('## Operational notes live in ``agent-lore.md``')"
     To   = "`$idx.Add([string][char]0x00E2 + '## Operational notes live in ``agent-lore.md``')"
     Check = { param($m) $m.Exit1 -eq 0 -and $m.Pairs -eq 2 } }
)

$survived = @()
foreach ($a in $arms) {
  $mut = $src
  if (-not $mut.Contains($a.From)) {
    Write-Host "[mutcheck] ARM ANCHOR MISSING: $($a.Name) -- '$($a.From)'" -ForegroundColor Red
    $survived += "$($a.Name) (anchor missing)"
    continue
  }
  $mut = $mut.Replace($a.From, $a.To)
  if ($a.Also) {
    if (-not $mut.Contains($a.Also.From)) {
      Write-Host "[mutcheck] ARM ANCHOR MISSING (Also): $($a.Name)" -ForegroundColor Red
      $survived += "$($a.Name) (also-anchor missing)"
      continue
    }
    $mut = $mut.Replace($a.Also.From, $a.Also.To)
  }
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("split-mut-" + [Guid]::NewGuid().ToString('N').Substring(0, 8) + '.ps1')
  [IO.File]::WriteAllText($tmp, $mut, $enc)
  try {
    $m = Measure-Run $tmp -HeadingFirst:([bool]$a.HeadingFirst)
    $stillHealthy = & $a.Check $m
    if ($stillHealthy) {
      Write-Host "[mutcheck] SURVIVED: $($a.Name)" -ForegroundColor Red
      $survived += $a.Name
      if ($Verbose2) { Write-Host $m.Out1; Write-Host $m.Out2 }
    } else {
      Write-Host "[mutcheck] killed:   $($a.Name)" -ForegroundColor Green
    }
  } finally { Remove-Item $tmp -Force -EA SilentlyContinue }
}

Write-Host ''
if ($survived.Count -gt 0) {
  Write-Host "[mutcheck] FAIL - $($survived.Count) of $($arms.Count) mutations survived:" -ForegroundColor Red
  $survived | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
  exit 1
}
Write-Host "[mutcheck] PASS - all $($arms.Count) mutations killed; every guard is load-bearing." -ForegroundColor Green
exit 0
