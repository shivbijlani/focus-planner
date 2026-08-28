<#
  mutcheck-unstamped-runlog.ps1 -- mutation check for the unstamped-run-log false-reopen fix.

  The fix adds `### Run log` as an agent-turn boundary marker, so a journal where the agent
  answered WITHOUT stamping `<!-- from: overnight-agent -->` stops reading as unanswered user
  prose. That recovery is deliberately wrapped in a guard (`Test-IsRunLogBodyOnly`) which
  refuses to advance the boundary over anything that is not run-log shaped.

  The guard is the risky half. Without it, raw user text appended below a run log -- which
  SKILL.md explicitly allows ("a new `## <date>` entry or raw text at the bottom") -- would be
  swallowed into the agent's own turn and the user's message lost. A lost message is strictly
  worse than a needless look, so the guard must be proven load-bearing rather than assumed.

  This script MUTATES a copy of the real oa-state.ps1 -- it neuters the guard by making
  Test-IsRunLogBodyOnly always return $true -- and asserts that exactly the guard's own
  negative case breaks and nothing else does. A mutation that changes nothing would mean the
  guard is decoration; a mutation that breaks everything would mean the case set is not
  discriminating.

    powershell -File mutcheck-unstamped-runlog.ps1 -ScriptPath <path-to-oa-state.ps1>
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$ScriptPath
)

$ErrorActionPreference = 'Stop'

$AgentBlock = @'
# Task {ID}: synthetic

Some user notes at the top.

---
<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->

## Overnight Agent

**Status:** Done - plan v1 - 2026-08-26

### Proposed plan (v1)
1. Do the thing.

**Needs from you:** none
'@

function New-Journal {
  param([string]$Dir, [string]$Id, [string[]]$Entries)
  $sb = [System.Text.StringBuilder]::new()
  [void]$sb.AppendLine(($AgentBlock -replace '\{ID\}', $Id))
  foreach ($e in $Entries) {
    [void]$sb.AppendLine()
    [void]$sb.AppendLine($e)
  }
  [System.IO.File]::WriteAllText((Join-Path $Dir "task-$Id.md"), $sb.ToString(), [System.Text.UTF8Encoding]::new($false))
}

# The historical shape: an unmarked user entry answered by an unstamped run log.
$answered = @'
## 2026-07-27

He accidentally purchased from orbit, so we are just going to use that

### Run log
**2026-07-27 (overnight):**
- Got it, closing this out.
- Result: done. No further action.
- Next: complete.
'@

$unanswered = @'
## 2026-07-27

He accidentally purchased from orbit, so we are just going to use that
'@

# The guard's reason for existing: raw user text with no heading of its own, below a run log.
$rawBelowRunLog = @'
## 2026-07-27

Earlier question?

### Run log
**2026-07-27 (overnight):**
- Answered it.
- Next: complete.

Actually wait, one more thing - can you also check the deductible?
'@

$userTurn  = "## 2026-08-26`n`n<!-- from: me -->`nHey, one more thing?"
$sibTurn   = "## 2026-08-26`n`n<!-- from: dance-church -->`nRan the loop - nothing to change."

# id -> @{ entries; expect; guarded; why }
#   guarded = this case is the one the guard protects; neutering the guard must break it.
$cases = [ordered]@{
  '911' = @{ entries = @($answered);              expect = $false; guarded = $false; why = 'unstamped run log answered the user -> quiet' }
  '912' = @{ entries = @($unanswered);            expect = $true;  guarded = $false; why = 'unanswered unmarked user message -> reopen' }
  '913' = @{ entries = @($rawBelowRunLog);        expect = $true;  guarded = $true;  why = 'GUARD: raw user text below a run log -> reopen' }
  '914' = @{ entries = @($answered, $userTurn);   expect = $true;  guarded = $false; why = 'new user reply after an answered turn -> reopen' }
  '915' = @{ entries = @($answered, $sibTurn);    expect = $false; guarded = $false; why = 'sibling turn after an answered turn -> quiet' }
  '916' = @{ entries = @($userTurn);              expect = $true;  guarded = $false; why = 'plain marked user reply -> reopen' }
  '917' = @{ entries = @($sibTurn);               expect = $false; guarded = $false; why = 'sibling turn alone -> quiet' }
  '918' = @{ entries = @();                       expect = $false; guarded = $false; why = 'nothing below the block -> quiet' }
}

function Invoke-Cases {
  param([string]$Script)
  $root = Join-Path $env:TEMP ("oa-mut-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
  $jdir = Join-Path $root 'journal'; $sdir = Join-Path $root 'state'
  New-Item -ItemType Directory -Path $jdir, $sdir -Force | Out-Null
  try {
    foreach ($id in $cases.Keys) { New-Journal -Dir $jdir -Id $id -Entries $cases[$id].entries }
    & powershell -NoProfile -ExecutionPolicy Bypass -File $Script seed -JournalDir $jdir -StateDir $sdir | Out-Null
    $raw = & powershell -NoProfile -ExecutionPolicy Bypass -File $Script scan -JournalDir $jdir -StateDir $sdir
    $rows = ($raw -join "`n") | ConvertFrom-Json
    $out = @{}
    foreach ($r in $rows) { $out["$($r.id)"] = [bool]$r.reopened }
    return $out
  }
  finally { Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue }
}

Write-Host "script under test: $ScriptPath`n"

# --- 1. Baseline: the real script must get every case right ---------------------------
$base = Invoke-Cases -Script $ScriptPath
$baseFail = @()
Write-Host ("{0,-5} {1,-7} {2,-7} {3}" -f 'case', 'expect', 'actual', 'why')
foreach ($id in $cases.Keys) {
  $ok = ($base[$id] -eq $cases[$id].expect)
  if (-not $ok) { $baseFail += $id }
  Write-Host ("{0,-5} {1,-7} {2,-7} {3}  [{4}]" -f $id, $cases[$id].expect, $base[$id], $cases[$id].why, $(if ($ok) { 'PASS' } else { 'FAIL' }))
}
Write-Host ''
if ($baseFail.Count) {
  Write-Host "BASELINE FAILED on: $($baseFail -join ', ')"
  exit 1
}
Write-Host "baseline: $($cases.Count)/$($cases.Count) correct"

# --- 2. Mutant: neuter the guard, keep the recovery -----------------------------------
$src = Get-Content -Raw $ScriptPath
$mutant = [regex]::Replace(
  $src,
  '(function Test-IsRunLogBodyOnly\(\[string\]\$region\) \{)',
  "`$1`n  return `$true   # MUTANT: guard neutered"
)
if ($mutant -eq $src) {
  Write-Host "`nMUTATION FAILED TO APPLY - Test-IsRunLogBodyOnly not found. The check proved nothing."
  exit 1
}
$mutPath = Join-Path $env:TEMP ("oa-state-mutant-" + [guid]::NewGuid().ToString('N').Substring(0, 8) + ".ps1")
[System.IO.File]::WriteAllText($mutPath, $mutant, [System.Text.UTF8Encoding]::new($false))

try {
  $mut = Invoke-Cases -Script $mutPath
  $broke = @(); $survived = @()
  foreach ($id in $cases.Keys) {
    if ($mut[$id] -ne $cases[$id].expect) { $broke += $id } else { $survived += $id }
  }
  $expectedBreaks = @($cases.Keys | Where-Object { $cases[$_].guarded })

  Write-Host ''
  Write-Host "mutant (Test-IsRunLogBodyOnly always true):"
  Write-Host "  cases broken   : $(if ($broke.Count) { $broke -join ', ' } else { '(none)' })"
  Write-Host "  expected breaks: $($expectedBreaks -join ', ')"

  $unexpected = @($broke | Where-Object { $_ -notin $expectedBreaks })
  $missed     = @($expectedBreaks | Where-Object { $_ -notin $broke })

  Write-Host ''
  if ($missed.Count) {
    Write-Host "VERDICT: the guard is NOT load-bearing - neutering it changed nothing for: $($missed -join ', ')"
    Write-Host "         Either the guard is decoration, or the case does not exercise it."
    exit 1
  }
  if ($unexpected.Count) {
    Write-Host "VERDICT: the mutation broke cases it should not have: $($unexpected -join ', ')"
    Write-Host "         The guard is doing more than the one job it is documented to do."
    exit 1
  }
  Write-Host "VERDICT: guard is load-bearing - neutering it breaks exactly its own negative case"
  Write-Host "         ($($expectedBreaks -join ', ')) and leaves the other $($survived.Count) correct."
  Write-Host "         So raw user text below a run log is protected by real logic, not by luck."
  exit 0
}
finally { Remove-Item -Force $mutPath -ErrorAction SilentlyContinue }
