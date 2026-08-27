<#
  mutcheck-journal-decode.ps1 -- mutation check for the UTF-8 journal-decode fix.

  THE INVARIANT
    The hash oa-state.ps1 records for a journal must depend ONLY on the journal's bytes --
    never on which PowerShell host ran the script.

  WHY THAT IS THE RIGHT INVARIANT
    The journals are UTF-8 with NO BOM. `Get-Content -Raw` decodes such a file using the ANSI
    codepage under Windows PowerShell 5.1 and as UTF-8 under PowerShell 7. `Get-Sha256` then
    re-encodes that decoded STRING as UTF-8, so a mis-decode changes the hash. Since
    `processed_file_hash` is what `scan` compares against to answer "has the user replied?",
    a decoder change silently re-hashes every journal: every task reads as `changed`, and any
    task with trailing prose false-reopens.

    That is not hypothetical. Measured on the live board, 2026-08-27: swapping the running
    script for `origin/main`'s copy turned 0 changed / 0 reopened into 239 changed /
    24 reopened, across 239 journals of which 362-of-366 files contain non-ASCII.

  WHY A HOST COMPARISON RATHER THAN AN EXPECTED HASH
    Asserting one hard-coded hash would pass the pre-fix script whenever the check happened to
    run under pwsh 7, because there `Get-Content -Raw` is already UTF-8. The defect is
    *host-dependence*, so the check runs the SAME script under BOTH hosts and compares. That is
    exactly the failure HAZARD 4 in user-settings.md describes.

  THE NEGATIVE CONTROL IS THE POINT
    An ASCII-only fixture MUST agree across hosts for both the pre-fix and post-fix script.
    Without it, "the hashes differ" could just mean "the two runs differ for any reason", and
    the check would pass for the wrong reason. The pre-fix script has to be stable on ASCII and
    unstable on non-ASCII, or this check is not measuring the decoder.

    This is the gap the existing suite could not cover: `oa-state.Tests.ps1` contains ZERO
    non-ASCII characters -- its fixtures use `## Overnight Agent` with no emoji -- so it scores
    14/14 against BOTH the pre-fix and post-fix scripts and is blind to this defect.

  USAGE
    powershell -File mutcheck-journal-decode.ps1 -ScriptPath <path-to-oa-state.ps1>
    powershell -File mutcheck-journal-decode.ps1 -ScriptPath <pre-fix-copy> -ExpectPreFix

    -ExpectPreFix inverts the assertion: the non-ASCII fixtures MUST disagree across hosts and
    the ASCII fixture MUST agree. It is how the fix is proven load-bearing rather than merely
    restating behaviour the script already had.

  Never touches live state: journals and state both live in a fresh temp dir.
#>
[CmdletBinding()]
param(
  [string]$ScriptPath,
  [switch]$ExpectPreFix
)

$ErrorActionPreference = 'Stop'

if (-not $ScriptPath) {
  $ScriptPath = Join-Path $PSScriptRoot '..\skills\overnight-agent\oa-state.ps1'
}
$ScriptPath = [IO.Path]::GetFullPath($ScriptPath)
if (-not (Test-Path $ScriptPath)) { throw "oa-state.ps1 not found at $ScriptPath" }

# Both hosts must exist or the invariant is untestable. Say so loudly rather than passing
# vacuously -- a check that cannot fail is not a check.
$hosts = @{}
foreach ($h in @('powershell', 'pwsh')) {
  $cmd = Get-Command $h -ErrorAction SilentlyContinue
  if ($cmd) { $hosts[$h] = $cmd.Source }
}
if ($hosts.Count -lt 2) {
  Write-Host "SKIP-UNSOUND: need both Windows PowerShell 5.1 and pwsh 7 to compare decoders; found: $($hosts.Keys -join ', ')"
  exit 2
}

# --- fixtures -------------------------------------------------------------------------------
# Written as UTF-8 with NO BOM, which is exactly what the Focus Planner app produces and what
# makes `Get-Content -Raw` host-dependent. A BOM would make 5.1 decode correctly and hide it.
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

$Body = @'
# Task {ID}: {TITLE}

User notes at the top.

---
<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->

{HEADING}

**Status:** In-progress - plan v1 - 2026-08-27

<!-- from: overnight-agent -->
The agent's last turn. {PROSE}
'@

# id -> @{ Title; Heading; Prose; NonAscii }
# 801 is the negative control: pure ASCII, must be host-stable for BOTH scripts.
$fixtures = [ordered]@{
  '801' = @{ Title = 'ascii control'; Heading = '## Overnight Agent';   Prose = 'Plain ASCII only.';              NonAscii = $false }
  '802' = @{ Title = 'moon heading';  Heading = "## $([char]0xD83C)$([char]0xDF19) Overnight Agent"; Prose = 'Plain ASCII body.'; NonAscii = $true }
  '803' = @{ Title = 'em dash prose'; Heading = '## Overnight Agent';   Prose = "Result $([char]0x2014) shipped."; NonAscii = $true }
}

$root = Join-Path ([IO.Path]::GetTempPath()) ("oa-decode-" + [Guid]::NewGuid().ToString('n').Substring(0, 8))
$journalDir = Join-Path $root 'journal'
New-Item -ItemType Directory -Path $journalDir -Force | Out-Null

foreach ($id in $fixtures.Keys) {
  $f = $fixtures[$id]
  $text = $Body.Replace('{ID}', $id).Replace('{TITLE}', $f.Title).Replace('{HEADING}', $f.Heading).Replace('{PROSE}', $f.Prose)
  $path = Join-Path $journalDir "task-$id.md"
  [IO.File]::WriteAllText($path, $text, $Utf8NoBom)

  # Guard the fixture itself: a fixture that is not what it claims to be silently voids the
  # whole check (an ASCII "non-ASCII" fixture would make the pre-fix script look fixed).
  $bytes = [IO.File]::ReadAllBytes($path)
  $hasHighByte = @($bytes | Where-Object { $_ -gt 127 }).Count -gt 0
  if ($hasHighByte -ne $f.NonAscii) {
    throw "fixture task-$id.md: expected NonAscii=$($f.NonAscii) but high bytes present=$hasHighByte"
  }
  if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
    throw "fixture task-$id.md was written WITH a BOM; the check would be vacuous"
  }
}

# --- run the same script under each host ----------------------------------------------------
function Get-HashesForHost([string]$hostExe, [string]$script, [string]$journals, [string]$stateDir) {
  New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
  & $hostExe -NoProfile -ExecutionPolicy Bypass -File $script seed -JournalDir $journals -StateDir $stateDir *> $null
  $result = @{}
  foreach ($sf in Get-ChildItem $stateDir -Filter 'task-*.json') {
    $obj = [IO.File]::ReadAllText($sf.FullName, $Utf8NoBom) | ConvertFrom-Json
    $result[[string]$obj.id] = [string]$obj.processed_file_hash
  }
  return $result
}

$byHost = @{}
foreach ($h in @('powershell', 'pwsh')) {
  $byHost[$h] = Get-HashesForHost $hosts[$h] $ScriptPath $journalDir (Join-Path $root "state-$h")
}

# --- assert ---------------------------------------------------------------------------------
$rows = @()
$pass = 0
foreach ($id in $fixtures.Keys) {
  $f = $fixtures[$id]
  $a = $byHost['powershell'][$id]
  $b = $byHost['pwsh'][$id]

  if (-not $a -or -not $b) {
    $rows += [pscustomobject]@{ case = $id; expect = 'hash'; actual = 'MISSING'; why = 'no state written by one host'; ok = $false }
    continue
  }

  $agree = ($a -eq $b)
  # Post-fix: every fixture agrees. Pre-fix: ASCII agrees, non-ASCII must NOT.
  $want = if ($ExpectPreFix -and $f.NonAscii) { $false } else { $true }
  $ok = ($agree -eq $want)
  if ($ok) { $pass++ }

  $why = if ($f.NonAscii) { "non-ASCII ($($f.Title)) -> hash must be host-independent" }
         else { "ASCII control ($($f.Title)) -> hash must match on both hosts" }
  if ($ExpectPreFix -and $f.NonAscii) { $why = "non-ASCII ($($f.Title)) -> pre-fix MUST diverge (proves fix is load-bearing)" }

  $rows += [pscustomobject]@{
    case   = $id
    expect = $(if ($want) { 'agree' } else { 'diverge' })
    actual = $(if ($agree) { 'agree' } else { 'diverge' })
    why    = $why
    ok     = $ok
  }
}

$mode = if ($ExpectPreFix) { 'PRE-FIX (expect divergence on non-ASCII)' } else { 'POST-FIX (expect host-independence)' }
Write-Host "script : $ScriptPath"
Write-Host "mode   : $mode"
Write-Host ""
Write-Host ("{0,-6}{1,-10}{2,-10}{3}" -f 'case', 'expect', 'actual', 'why')
foreach ($r in $rows) {
  Write-Host ("{0,-6}{1,-10}{2,-10}{3}  [{4}]" -f $r.case, $r.expect, $r.actual, $r.why, $(if ($r.ok) { 'PASS' } else { 'FAIL' }))
}
Write-Host ""
Write-Host "passed $pass / $($rows.Count)"

try { Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue } catch { }

if ($pass -eq $rows.Count) { exit 0 } else { exit 1 }
