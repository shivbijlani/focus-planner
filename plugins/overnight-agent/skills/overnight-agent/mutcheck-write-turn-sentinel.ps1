<#
  mutcheck-write-turn-sentinel.ps1 -- proves write-turn.ps1's sentinel guard (G6) is
  load-bearing, on both LF and CRLF, and that it is idempotent.

  WHY THIS EXISTS
  ---------------
  The Telegram bridge gates EVERY task on `hasAgentBlock()`, which is a literal search
  for the `<!-- OVERNIGHT-AGENT ... -->` sentinel line (`packages/telegram-bridge/src/
  journal.js`). A journal without that line is skipped outright: no topic, no post, no
  digest entry. The turn is written correctly to disk and delivered to nobody.

  `write-turn.ps1` -- the ONLY sanctioned way to write a turn -- had no concept of the
  sentinel, so any journal whose first turn it wrote was born invisible to the surface
  Shiv actually reads.

  Found 2026-08-30 on #451 "Report hit and run": a red Today task carrying a statutory
  4-day filing deadline. Its packet was written, validated, marked, and reached nobody.
  A sweep of all 239 journals found 7 in this shape.

  This failure is INVISIBLE from inside the agent: `oa-state.ps1 scan` reported
  `has_agent_block: true` for #451 the whole time, because it detects the block by a
  different rule than the bridge does. Two components disagreeing about what "has a
  block" means is exactly the kind of defect prose cannot hold, which is why it is
  asserted here instead of documented.

  WHAT IS ASSERTED
  ----------------
  1. POSITIVE  - a journal with no sentinel gains exactly one, and the bridge's own
                 detection rule then matches.
  2. IDEMPOTENT- a second turn does not add a second sentinel.
  3. PRESERVING- a journal that already has a sentinel keeps exactly one, in place.
  4. APPEND-ONLY - every byte of the original file survives. This script must never be
                 able to eat one of Shiv's replies.
  5. LOAD-BEARING - with the guard disabled, assertion 1 FAILS and nothing else changes.
                 Without this arm, a guard enforced by some other code path (or one that
                 never runs) is indistinguishable from a working one.

  Usage: powershell -NoProfile -ExecutionPolicy Bypass -File mutcheck-write-turn-sentinel.ps1
  Exit:  0 all assertions hold - 1 the guard is not doing what it claims.
#>
[CmdletBinding()]
param([string]$Target)

$ErrorActionPreference = 'Stop'

# Resolve write-turn.ps1 by SEARCH and PRINT what was measured (#251): a guard that is
# absent and a guard that is passing look identical from the outside.
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$candidates = @(
  $Target,
  (Join-Path $here 'write-turn.ps1'),
  (Join-Path $here '..\skills\overnight-agent\write-turn.ps1'),
  (Join-Path $env:LOCALAPPDATA 'overnight-agent\write-turn.ps1')
) | Where-Object { $_ }

$writeTurn = $null
foreach ($c in $candidates) { if (Test-Path -LiteralPath $c) { $writeTurn = (Resolve-Path $c).Path; break } }
if (-not $writeTurn) { Write-Host 'FAIL - write-turn.ps1 not found' -ForegroundColor Red; exit 1 }
Write-Host "[mutcheck-sentinel] target = $writeTurn"

$SENTINEL = '<!-- OVERNIGHT-AGENT do not edit this line'
$tmp = Join-Path $env:TEMP ("oa-sentinel-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null

$body = @'
## 🌙 Overnight Agent — fixture turn

<!-- from: overnight-agent -->

**Status:** In-progress · 2026-01-01

**Needs from you:** nothing.
'@
$bodyFile = Join-Path $tmp 'body.md'
[IO.File]::WriteAllText($bodyFile, $body, (New-Object Text.UTF8Encoding($false)))

function New-Journal([string]$dir, [string]$id, [string]$nl, [bool]$withSentinel) {
  $lines = @("# Task ${id}: fixture", '', '## 2026-01-01', '', 'User note that must survive.', '')
  if ($withSentinel) {
    $lines += @('---', '<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->', '')
  }
  $lines += @('## 🌙 Overnight Agent — earlier turn', '', '<!-- from: overnight-agent -->', '', 'Earlier body.', '')
  $text = ($lines -join $nl)
  [IO.File]::WriteAllText((Join-Path $dir "task-$id.md"), $text, (New-Object Text.UTF8Encoding($false)))
  return $text
}

function Invoke-WriteTurn([string]$ScriptPath, [string]$dir, [string]$id) {
  & powershell -NoProfile -ExecutionPolicy Bypass -File $ScriptPath -Id $id -BodyFile $bodyFile -JournalDir $dir *>&1 | Out-Null
  return $LASTEXITCODE
}

function Count-Sentinel([string]$text) {
  ([regex]::Matches($text, [regex]::Escape($SENTINEL))).Count
}

# ---------------------------------------------------------------- run one scenario
function Test-Scenario([string]$ScriptPath, [string]$nl, [bool]$withSentinel, [switch]$Twice) {
  $dir = Join-Path $tmp ([guid]::NewGuid().ToString('N').Substring(0, 6))
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
  $id = '999'
  $orig = New-Journal $dir $id $nl $withSentinel
  $null = Invoke-WriteTurn $ScriptPath $dir $id
  if ($Twice) { $null = Invoke-WriteTurn $ScriptPath $dir $id }
  $after = [IO.File]::ReadAllText((Join-Path $dir "task-$id.md"), (New-Object Text.UTF8Encoding($false)))
  return [pscustomobject]@{
    Count     = Count-Sentinel $after
    Preserved = $after.StartsWith($orig)
    HasBlock  = $after.Contains($SENTINEL)
  }
}

$failures = @()
function Assert([bool]$cond, [string]$msg) {
  if ($cond) { Write-Host "  ok   $msg" -ForegroundColor Green }
  else { Write-Host "  FAIL $msg" -ForegroundColor Red; $script:failures += $msg }
}

Write-Host ''
Write-Host 'BASELINE (guard present)'
foreach ($nl in @("`n", "`r`n")) {
  $label = if ($nl -eq "`n") { 'LF' } else { 'CRLF' }

  $r = Test-Scenario $writeTurn $nl $false
  Assert ($r.Count -eq 1)   "[$label] no-sentinel journal gains exactly one sentinel (got $($r.Count))"
  Assert ($r.HasBlock)      "[$label] the bridge's detection rule now matches"
  Assert ($r.Preserved)     "[$label] append-only: every original byte survives"

  $r2 = Test-Scenario $writeTurn $nl $false -Twice
  Assert ($r2.Count -eq 1)  "[$label] idempotent: a second turn adds no second sentinel (got $($r2.Count))"

  $r3 = Test-Scenario $writeTurn $nl $true
  Assert ($r3.Count -eq 1)  "[$label] existing sentinel is preserved, not duplicated (got $($r3.Count))"
  Assert ($r3.Preserved)    "[$label] append-only holds on an already-blocked journal"
}

# ---------------------------------------------------------------- mutation
# Disable ONLY the insertion, by making the "is it missing?" test always answer "no".
# The mutant must break the positive case and nothing else.
Write-Host ''
Write-Host 'MUTATION (guard disabled)'
$src = [IO.File]::ReadAllText($writeTurn, (New-Object Text.UTF8Encoding($false)))
$needle = "if (`$existing -notmatch [regex]::Escape('<!-- OVERNIGHT-AGENT do not edit this line')) {"
if (-not $src.Contains($needle)) {
  Write-Host '  FAIL - could not locate the guard to mutate; the check is stale.' -ForegroundColor Red
  $failures += 'mutation site not found'
} else {
  $mutant = Join-Path $tmp 'write-turn.mutant.ps1'
  [IO.File]::WriteAllText($mutant, $src.Replace($needle, 'if ($false) {'), (New-Object Text.UTF8Encoding($false)))

  $m1 = Test-Scenario $mutant "`n" $false
  Assert ($m1.Count -eq 0)  "mutant: no-sentinel journal stays invisible (this is the bug; got $($m1.Count))"

  $m2 = Test-Scenario $mutant "`n" $true
  Assert ($m2.Count -eq 1)  "mutant: no collateral - an already-blocked journal is unaffected"
  Assert ($m2.Preserved)    "mutant: no collateral - append-only still holds"
}

Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ''
if ($failures.Count -eq 0) {
  Write-Host 'PASS - sentinel guard is present, idempotent, append-only and load-bearing (LF + CRLF).' -ForegroundColor Green
  exit 0
}
Write-Host 'FAIL' -ForegroundColor Red
$failures | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
exit 1
