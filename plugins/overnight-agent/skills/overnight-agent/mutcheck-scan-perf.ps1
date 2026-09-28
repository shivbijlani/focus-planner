<#
  mutcheck-scan-perf.ps1 -- performance guard for `oa-state.ps1 scan` (GH #711).

  WHY A PERF TEST IS A CORRECTNESS TEST HERE.
  -------------------------------------------
  `scan` is the first step of PHASE 1 and PHASE 2. A run that cannot read its worklist does no
  task work at all -- so "scan is slow" and "scan is broken" have the SAME observable outcome,
  and only one of them looks like a failure. Measured live 2026-09-28 on the 274-row corpus:
  224 s and 507 KB of JSON, against a coordinator whose tool calls wait 30-120 s. It abandoned
  the scan twice and finished the run having dispatched nothing, while the automation reported
  success.

  WHAT THIS GUARD ASSERTS, on a synthetic corpus the size of the real one:
    1. `scan -Compact` completes inside the budget.
    2. `-Compact` is materially smaller than the full worklist, and still carries every row a
       run must act on (eligible / gate-holding / unanswered / due / journal-less).
    3. `-Compact` and `-OutFile` do not change what is COMPUTED: the full array written by
       `-OutFile` is byte-identical to the array printed by a plain `scan`.
    4. The budget is being bought by the memoisation, not by a fast machine. A COPY of
       oa-state.ps1 with the memo table disabled is timed the same way and must be measurably
       slower -- otherwise this guard would keep passing after the optimisation was deleted,
       which is the only way a perf test can be worse than none.

  The fixture is generated into a temp dir and the live planner folder and state store are
  never touched.

    pwsh -File mutcheck-scan-perf.ps1 [-ScriptPath <oa-state.ps1>] [-Journals 300]
         [-BudgetSeconds 30] [-SkipMutant]
#>
[CmdletBinding()]
param(
  [string]$ScriptPath,
  [int]$Journals = 300,
  # The issue's target, applied to a corpus the size of the one that produced the 224 s
  # measurement. It is wall-clock on whatever host runs it, which is the number that actually
  # decides whether a run gets its worklist.
  [double]$BudgetSeconds = 30,
  # How much slower the un-memoised copy must be before arm 4 accepts that the memoisation is
  # load-bearing. Deliberately modest: the point is to catch the optimisation being DELETED, not
  # to pin a speedup ratio that varies with the host.
  [double]$MutantMinRatio = 1.2,
  [switch]$SkipMutant
)

$ErrorActionPreference = 'Stop'

if (-not $ScriptPath) { $ScriptPath = Join-Path $PSScriptRoot 'oa-state.ps1' }
if (-not (Test-Path $ScriptPath)) { throw "oa-state.ps1 not found at $ScriptPath" }

# Launch the host that actually EXISTS here -- `powershell` is Windows-only and this runs on the
# Linux runner too. Same idiom as oa-state.Tests.ps1.
$PsExe = if ($PSVersionTable.PSEdition -eq 'Core') { (Get-Process -Id $PID).Path } else { 'powershell' }
if (-not $PsExe) { $PsExe = 'pwsh' }

$root = Join-Path ([IO.Path]::GetTempPath()) ("oa-scanperf-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
$jdir = Join-Path $root 'journal'
$sdir = Join-Path $root 'state'
New-Item -ItemType Directory -Path $jdir -Force | Out-Null
New-Item -ItemType Directory -Path $sdir -Force | Out-Null
$board = Join-Path $root 'planner.md'

# A synthetic journal is only a useful fixture if it exercises the READERS that cost the time:
# fenced blocks (the fence mask), provenance markers and `## <date>` headings (the turn-boundary
# and author scans), a `### Run log` (the unstamped-run-log recovery), a `Needs from you:` line
# and an `oa-ask` stamp (the ask readers). A corpus of plain prose would run fast and prove
# nothing.
function New-SyntheticJournal([int]$id, [int]$turns) {
  $sb = [Text.StringBuilder]::new()
  [void]$sb.AppendLine("# Task ${id}: synthetic perf fixture")
  [void]$sb.AppendLine()
  [void]$sb.AppendLine('<!-- from: me -->')
  [void]$sb.AppendLine('Original framing of the task, written by the user, with no date heading above it.')
  [void]$sb.AppendLine()
  for ($d = 1; $d -le 3; $d++) {
    [void]$sb.AppendLine(('## 2026-08-{0:d2}' -f $d))
    [void]$sb.AppendLine()
    [void]$sb.AppendLine('<!-- from: me -->')
    [void]$sb.AppendLine('A note in my own space, above the sentinel, with an example:')
    [void]$sb.AppendLine('```markdown')
    [void]$sb.AppendLine('<!-- from: me -->')
    [void]$sb.AppendLine('this marker is quoted, not real')
    [void]$sb.AppendLine('```')
    [void]$sb.AppendLine()
  }
  [void]$sb.AppendLine('---')
  [void]$sb.AppendLine('<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->')
  [void]$sb.AppendLine()
  for ($t = 1; $t -le $turns; $t++) {
    [void]$sb.AppendLine('## 🌙 Overnight Agent')
    [void]$sb.AppendLine()
    [void]$sb.AppendLine("**Status:** In progress - plan v$t - 2026-09-0$([Math]::Min(9, $t))")
    [void]$sb.AppendLine()
    [void]$sb.AppendLine('<!-- from: overnight-agent -->')
    for ($p = 0; $p -lt 12; $p++) {
      [void]$sb.AppendLine("- Turn $t paragraph ${p}: ordinary prose describing what was done, long enough that the file reaches a realistic size and the line scanners have real work to do.")
    }
    [void]$sb.AppendLine()
    [void]$sb.AppendLine('```powershell')
    [void]$sb.AppendLine('# a fenced example, so the fence mask has something to mask')
    [void]$sb.AppendLine('Get-ChildItem | Where-Object { $_.Length -gt 0 }')
    [void]$sb.AppendLine('```')
    [void]$sb.AppendLine()
    [void]$sb.AppendLine('### Run log')
    [void]$sb.AppendLine("**2026-09-0$([Math]::Min(9, $t)) (overnight):**")
    [void]$sb.AppendLine('- Did the thing.')
    [void]$sb.AppendLine('- Next: continue.')
    [void]$sb.AppendLine()
    [void]$sb.AppendLine('<!-- oa-ask: none -->')
    [void]$sb.AppendLine('**Needs from you:** none')
    [void]$sb.AppendLine()
    [void]$sb.AppendLine('<!-- /overnight-agent turn-end -->')
    [void]$sb.AppendLine()
  }
  # Every third task ends with a genuine user reply below the stamp, so a realistic slice of the
  # corpus is `reopened` / `unanswered_user` and the compact projection has rows to keep.
  if ($id % 3 -eq 0) {
    [void]$sb.AppendLine('## 2026-09-27')
    [void]$sb.AppendLine()
    [void]$sb.AppendLine('<!-- from: me -->')
    [void]$sb.AppendLine('One more thing - can you also check X?')
    [void]$sb.AppendLine()
  }
  [IO.File]::WriteAllText((Join-Path $jdir "task-$id.md"), $sb.ToString(), [Text.UTF8Encoding]::new($false))
}

function Measure-Scan([string]$script, [string[]]$extra) {
  $args = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $script, 'scan',
            '-JournalDir', $jdir, '-StateDir', $sdir, '-PlannerBoard', $board,
            '-PlannerCompleted', (Join-Path $root 'planner-completed.md'),
            '-SnoozeStore', (Join-Path $root 'snooze.json'),
            '-GatePath', (Join-Path $root 'agent-gate.md'),
            '-UserSettings', (Join-Path $root 'user-settings.md')) + $extra
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $out = (& $PsExe @args) -join "`n"
  $sw.Stop()
  if ($LASTEXITCODE -ne 0) { throw "scan failed (exit $LASTEXITCODE): $out" }
  return [pscustomobject]@{ Seconds = $sw.Elapsed.TotalSeconds; Text = $out }
}

$pass = 0; $fail = 0
function Assert([bool]$ok, [string]$what) {
  if ($ok) { $script:pass++; Write-Host "  PASS  $what" }
  else { $script:fail++; Write-Host "  FAIL  $what" }
}

try {
  Write-Host "mutcheck-scan-perf (#711) -- $Journals journals, budget ${BudgetSeconds}s"

  $rows = @('| ID | 🎯 | Task | Work Priority | Added | Linked ID |', '| --- | --- | --- | --- | --- | --- |')
  for ($i = 1; $i -le $Journals; $i++) {
    New-SyntheticJournal -id $i -turns 4
    if ($i -le 40) { $rows += "| $i | 🟡 | Synthetic task $i | P1 | 2026-09-01 | |" }
  }
  $boardText = @('# Planner', '', '## Today') + $rows[0..1] + $rows[2..([Math]::Min(6, $rows.Count - 1))] +
               @('', '## Deferred') + $rows[0..1] + $rows[7..($rows.Count - 1)]
  [IO.File]::WriteAllText($board, ($boardText -join "`n"), [Text.UTF8Encoding]::new($false))
  $bytes = (Get-ChildItem $jdir -Filter 'task-*.md' | Measure-Object Length -Sum).Sum
  Write-Host ("  fixture: {0} journals, {1:N1} MB" -f $Journals, ($bytes / 1MB))

  & $PsExe -NoProfile -ExecutionPolicy Bypass -File $ScriptPath seed -JournalDir $jdir -StateDir $sdir | Out-Null

  # --- arm 1: the budget ------------------------------------------------------------------
  $compact = Measure-Scan $ScriptPath @('-Compact')
  Write-Host ("  compact scan: {0:N1}s, {1:N0} bytes" -f $compact.Seconds, $compact.Text.Length)
  Assert ($compact.Seconds -le $BudgetSeconds) ("scan -Compact completes in {0:N1}s (budget {1}s)" -f $compact.Seconds, $BudgetSeconds)

  # --- arm 2: the compact projection ------------------------------------------------------
  $full = Measure-Scan $ScriptPath @()
  Write-Host ("  full scan:    {0:N1}s, {1:N0} bytes" -f $full.Seconds, $full.Text.Length)
  $parsed = $compact.Text | ConvertFrom-Json
  $fullRows = $full.Text | ConvertFrom-Json
  Assert ($compact.Text.Length -lt ($full.Text.Length / 2)) 'compact output is less than half the full worklist'
  Assert ($parsed.summary.rows_total -eq @($fullRows).Count) 'compact summary reports the full row count'
  Assert ($parsed.summary.rows_returned + $parsed.summary.rows_omitted -eq $parsed.summary.rows_total) 'returned + omitted accounts for every row'

  $keptIds = @{}
  foreach ($r in $parsed.rows) { $keptIds["$($r.id)"] = $true }
  $missed = @($fullRows | Where-Object {
      ($_.eligible -or $_.holds_today_gate -or $_.reopened_closed -or $_.unanswered_user -or
       $_.due_poll -or $_.due_recheck -or (-not $_.has_journal)) -and -not $keptIds["$($_.id)"]
    })
  Assert ($missed.Count -eq 0) "compact keeps every row a run must act on (missed $($missed.Count))"
  Assert (@($parsed.rows).Count -gt 0) 'compact returned at least one actionable row'

  # --- arm 3: the projection does not change what is computed -----------------------------
  $outFile = Join-Path $root 'worklist.json'
  $viaFile = Measure-Scan $ScriptPath @('-ScanOutFile', $outFile)
  $written = [IO.File]::ReadAllText($outFile)
  # Compared with newlines normalised: stdout arrives as an array of lines this harness joins
  # with `\n`, while the file holds ConvertTo-Json's own CRLF. The assertion is about the JSON
  # being the same worklist, not about which host wrote the line endings.
  $norm = { param($s) ($s -replace "`r`n", "`n").Trim() }
  Assert ((& $norm $written) -eq (& $norm $full.Text)) '-ScanOutFile writes the same worklist a plain scan prints'
  $fileSummary = $viaFile.Text | ConvertFrom-Json
  Assert ($fileSummary.rows_total -eq @($fullRows).Count) '-ScanOutFile prints a summary instead of the worklist'
  Assert ($viaFile.Text.Length -lt 2000) '-ScanOutFile stdout is small enough for one tool result'

  # --- arm 4: the budget is bought by the memoisation -------------------------------------
  if ($SkipMutant) { Write-Host '  (mutant arm skipped)' }
  else {
    $mutantPath = Join-Path $root 'oa-state-mutant.ps1'
    $src = [IO.File]::ReadAllText($ScriptPath)
    $find = '  if ($t.TryGetValue($key, [ref]$hit)) { return $hit }'
    if (-not $src.Contains($find)) { throw 'mutant anchor not found: Get-Memoised no longer looks up its cache (#711)' }
    [IO.File]::WriteAllText($mutantPath, $src.Replace($find, '  if ($false) { return $hit }'), [Text.UTF8Encoding]::new($false))
    $mutant = Measure-Scan $mutantPath @('-Compact')
    $ratio = if ($compact.Seconds -gt 0) { $mutant.Seconds / $compact.Seconds } else { 0 }
    Write-Host ("  un-memoised:  {0:N1}s ({1:N2}x)" -f $mutant.Seconds, $ratio)
    Assert ($ratio -ge $MutantMinRatio) ("removing the memo table makes scan at least {0}x slower (measured {1:N2}x)" -f $MutantMinRatio, $ratio)
  }

  Write-Host ''
  Write-Host "passed $pass / $($pass + $fail)"
  if ($fail -gt 0) { exit 1 }
  exit 0
}
finally {
  Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue
}
