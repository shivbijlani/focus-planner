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
       oa-state.ps1 is instrumented to COUNT fence-mask computations, and a second copy has the
       memo lookup disabled too; the un-memoised copy must do at least twice the work. Counting
       rather than timing is deliberate: the first version of this arm timed the two copies,
       which held at 4.6x on a laptop and collapsed to 1.15x on a CI runner where the whole scan
       takes 4 s -- i.e. it measured the runner. Without arm 4 in some form this guard would keep
       passing after the optimisation was deleted, which is the only way a perf test can be worse
       than none.

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
  [switch]$SkipMutant
)

$ErrorActionPreference = 'Stop'

if (-not $ScriptPath) { $ScriptPath = Join-Path $PSScriptRoot 'oa-state.ps1' }
if (-not (Test-Path $ScriptPath)) { throw "oa-state target not found at $ScriptPath" }
. (Join-Path (Split-Path -Parent $ScriptPath) 'oa-state-target.ps1')
$script:OaCmd = Get-OaStateCommand $ScriptPath
$script:IsNodeTarget = Test-OaStateNodeTarget $ScriptPath

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
  $cmd = Get-OaStateCommand $script
  $args = $cmd.Prefix + @('scan',
            '-JournalDir', $jdir, '-StateDir', $sdir, '-PlannerBoard', $board,
            '-PlannerCompleted', (Join-Path $root 'planner-completed.md'),
            '-SnoozeStore', (Join-Path $root 'snooze.json'),
            '-GatePath', (Join-Path $root 'agent-gate.md'),
            '-UserSettings', (Join-Path $root 'user-settings.md')) + $extra
  $out = (& $cmd.Exe @args) -join "`n"
  $sw.Stop()
  if ($LASTEXITCODE -ne 0) { throw "scan failed (exit $LASTEXITCODE): $out" }
  return [pscustomobject]@{ Seconds = $sw.Elapsed.TotalSeconds; Text = $out }
}

function Measure-MaskCalls([string]$script) {
  # Runs an instrumented copy and returns how many times it had to compute a fence mask.
  $cmd = Get-OaStateCommand $script
  $out = & $cmd.Exe @($cmd.Prefix + @('scan', '-Compact',
    '-JournalDir', $jdir, '-StateDir', $sdir, '-PlannerBoard', $board,
    '-PlannerCompleted', (Join-Path $root 'planner-completed.md'),
    '-SnoozeStore', (Join-Path $root 'snooze.json'),
    '-GatePath', (Join-Path $root 'agent-gate.md'),
    '-UserSettings', (Join-Path $root 'user-settings.md'))) 2>&1
  $line = @($out | Where-Object { "$_" -match '^MASKCORE=(\d+)$' }) | Select-Object -First 1
  if (-not $line) { throw 'instrumented scan did not report MASKCORE' }
  return [int]([regex]::Match("$line", '^MASKCORE=(\d+)$').Groups[1].Value)
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

  & $script:OaCmd.Exe @($script:OaCmd.Prefix + @('seed', '-JournalDir', $jdir, '-StateDir', $sdir)) | Out-Null

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
  #
  # DETERMINISTIC, not a stopwatch ratio. The first version of this arm timed a copy with the
  # memo disabled and required it to be N times slower -- which held on a laptop (4.6x) and
  # collapsed to 1.15x on a CI runner where the whole scan takes 4 s, i.e. it measured the
  # runner more than the code. So it counts the thing that actually changed instead: how many
  # times the fence masker has to do its work. With the memo, the same journal text is masked
  # once; without it, every reader re-masks it. A count cannot flake.
  if ($SkipMutant -or $script:IsNodeTarget) { Write-Host '  (mutant arm skipped for this target)' }
  else {
    $src = [IO.File]::ReadAllText($ScriptPath)
    $lookup = '  if ($t.TryGetValue($key, [ref]$hit)) { return $hit }'
    $coreDecl = 'function Get-FenceMaskedTextCore([string]$text) {'
    $emitAt = '  if ($Compact) { (New-CompactScan $rows $seconds) | ConvertTo-Json -Depth 8; return }'
    foreach ($anchor in @($lookup, $coreDecl, $emitAt)) {
      if (-not $src.Contains($anchor)) { throw "instrumentation anchor not found, the memo path has moved (#711): $anchor" }
    }
    $instrumented = $src.Replace($coreDecl, $coreDecl + "`n  `$script:MaskCoreCalls++").
                         Replace($emitAt, '  if ($Compact) { [Console]::Error.WriteLine("MASKCORE=" + $script:MaskCoreCalls); ' +
                                          '(New-CompactScan $rows $seconds) | ConvertTo-Json -Depth 8; return }')

    $memoPath = Join-Path $root 'oa-state-counted.ps1'
    $mutantPath = Join-Path $root 'oa-state-mutant.ps1'
    [IO.File]::WriteAllText($memoPath, $instrumented, [Text.UTF8Encoding]::new($true))
    [IO.File]::WriteAllText($mutantPath, $instrumented.Replace($lookup, '  if ($false) { return $hit }'), [Text.UTF8Encoding]::new($true))

    $withMemo = Measure-MaskCalls $memoPath
    $without = Measure-MaskCalls $mutantPath
    Write-Host ("  fence-mask recomputations: memoised {0}, un-memoised {1}" -f $withMemo, $without)
    Assert ($withMemo -gt 0) 'the instrumented copy actually reached the fence masker'
    Assert ($without -ge ($withMemo * 2)) ("removing the memo at least doubles fence-mask work ({0} -> {1})" -f $withMemo, $without)
    # Per journal rather than in total, so the assertion means the same thing at any fixture
    # size. The floor is not 1: a journal legitimately yields several DISTINCT strings to mask
    # (the whole file, the agent-left region, the newest turn, the above-sentinel region), and
    # the memo's job is to mask each of those once rather than once per reader. Measured on this
    # fixture: ~3 per journal memoised against ~9 un-memoised.
    Assert ($withMemo -le ($Journals * 4)) ("each journal is masked a bounded number of times ({0:N2} per journal)" -f ($withMemo / $Journals))
  }

  Write-Host ''
  Write-Host "passed $pass / $($pass + $fail)"
  if ($fail -gt 0) { exit 1 }
  exit 0
}
finally {
  Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue
}
