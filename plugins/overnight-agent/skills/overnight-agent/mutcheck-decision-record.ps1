<#
  mutcheck-decision-record.ps1 -- the per-run decision record (GH #561).

  WHAT IT GUARDS. A run's ordered worklist, each row's eligibility and the reason a
  higher-ranked row was skipped used to exist only in memory: answering "why did this run pick
  Deferred #362 while Today #245 sat there?" meant re-deriving the decision hours later, and only
  worked because the state happened not to have moved. `oa-state.ps1 decisions` appends one
  compact record per run to the EXISTING coordinator run ledger (#762) so that question is a
  grep. This asserts the four properties that make the record worth having:

    1. It is APPENDED, and it quotes the `scan -Compact` summary the run actually read.
    2. Every TODAY row is named with its deciding reason even when ineligible -- "nothing was
       eligible" with no cause is the failure the record exists to prevent.
    3. Reasons come from a CLOSED vocabulary and are one word. A free-text reason would be
       prose the run writes about itself, which is what this replaces.
    4. The file is BOUNDED: lines older than the retention window are dropped, across BOTH
       ledger line kinds, and a run-start line inside the window survives.

  Each arm is then re-run against a MUTATED copy of oa-state.ps1 which must fail it.

    pwsh -File mutcheck-decision-record.ps1 [-ScriptPath <oa-state.ps1>]
#>
[CmdletBinding()]
param([string]$ScriptPath)

$ErrorActionPreference = 'Stop'

if (-not $ScriptPath) { $ScriptPath = Join-Path $PSScriptRoot 'oa-state.ps1' }
if (-not (Test-Path $ScriptPath)) { throw "oa-state.ps1 not found at $ScriptPath" }

$PsExe = if ($PSVersionTable.PSEdition -eq 'Core') { (Get-Process -Id $PID).Path } else { 'powershell' }
if (-not $PsExe) { $PsExe = 'pwsh' }

$root = Join-Path ([IO.Path]::GetTempPath()) ("oa-decisions-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $root -Force | Out-Null

$pass = 0; $fail = 0
function Assert([bool]$ok, [string]$what) {
  if ($ok) { $script:pass++; Write-Host "  PASS  $what" }
  else { $script:fail++; Write-Host "  FAIL  $what" }
}

# The live 2026-09-04 case, as a fixture: Today #245 is ineligible because an agent-declared
# `done` made it not_workable, so the run reaches Deferred #362.
$scanPath = Join-Path $root 'scan.json'
$scan = [ordered]@{
  summary = [ordered]@{
    scan_seconds = 1.2; rows_total = 244; rows_eligible = 2; rows_returned = 4
    rows_omitted = 240; today_holding = 1
  }
  rows    = @(
    [ordered]@{ id = '245'; order = 2; section = 'today'; eligible = $false
      today_release_reason = 'not_workable:done_by_agent'; status = 'done' },
    [ordered]@{ id = '246'; order = 3; section = 'today'; eligible = $false; status = 'awaiting reply' },
    [ordered]@{ id = '362'; order = 68; section = 'deferred'; eligible = $true; status = 'in-progress' },
    [ordered]@{ id = '400'; order = 70; section = 'deferred'; eligible = $true; status = '' }
  )
}
[IO.File]::WriteAllText($scanPath, ($scan | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))

$outcomes = '[{"id":"362","outcome":"dispatched","at":"2026-09-29T11:09:00-07:00","sessionId":"s1"},' +
            '{"id":"400","outcome":"capacity"}]'

function Invoke-Decisions {
  param([string]$script, [string]$ledger, [string]$runId, [string]$now, [string]$outcomeJson = $outcomes,
        [int]$retainDays = 7)
  $stdout = & $PsExe -NoProfile -ExecutionPolicy Bypass -File $script decisions `
    -RunId $runId -ScanFile $scanPath -Outcomes $outcomeJson -RunLedger $ledger `
    -DecisionNow $now -RetainDays $retainDays -StateDir (Join-Path $root 'state') 2>&1
  return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Text = ($stdout -join "`n") }
}

# Every arm, as a function of the script under test, so the mutants run the SAME assertions.
function Test-Record {
  param([string]$script, [string]$tag)
  $ledger = Join-Path $root "$tag.jsonl"
  # A run START from the previous run, inside the window, plus a stale one outside it.
  $seed = @(
    (@{ startedAt = '2026-09-01T00:00:00Z'; trigger = 'schedule'; runId = 'old' } | ConvertTo-Json -Compress),
    (@{ startedAt = '2026-09-29T17:40:00Z'; trigger = 'schedule'; runId = 'run-1' } | ConvertTo-Json -Compress)
  )
  [IO.File]::WriteAllText($ledger, (($seed -join "`n") + "`n"), [Text.UTF8Encoding]::new($false))

  $result = Invoke-Decisions -script $script -ledger $ledger -runId 'run-1' -now '2026-09-29T11:10:00-07:00'
  if ($result.ExitCode -ne 0) { throw "decisions failed (exit $($result.ExitCode)): $($result.Text)" }

  $lines = @([IO.File]::ReadAllLines($ledger) | Where-Object { $_.Trim() })
  $decisionLines = @($lines | Where-Object { $_ -match '"kind":"decision"' })
  $raw = if ($decisionLines.Count) { $decisionLines[-1] } else { '' }
  $record = @($lines | ForEach-Object { $_ | ConvertFrom-Json } | Where-Object { $_.kind -eq 'decision' })[-1]
  $rowsById = @{}
  foreach ($r in $record.rows) { $rowsById["$($r.id)"] = $r }

  # 1 -- appended, and quoting the scan it read. Timestamps are asserted on the RAW line: a
  # record read back through ConvertFrom-Json arrives as [datetime], so comparing the parsed
  # value would assert the host's locale rather than what was written.
  $ok1 = ($record.runId -eq 'run-1') -and ($record.summary.rows_total -eq 244) -and
         ($record.summary.rows_eligible -eq 2) -and ($raw -match '"at":"2026-09-29T11:10')
  $ok1 = $ok1 -and (@($record.dispatched).Count -eq 1) -and ("$($record.dispatched[0].id)" -eq '362') -and
         ($raw -match '"dispatched":\[\{"id":"362","at":"2026-09-29T11:09')

  # 2 -- every Today row named, ineligible or not, with its deciding cause.
  $ok2 = $rowsById.ContainsKey('245') -and $rowsById.ContainsKey('246') -and
         ("$($rowsById['245'].reason)" -eq 'ineligible:not_workable:done_by_agent') -and
         ("$($rowsById['246'].reason)" -eq 'ineligible:awaiting_reply') -and
         ($rowsById['245'].eligible -eq $false)

  # 3 -- ordered, one-word reasons, and the dispatch/skip words recorded per row.
  $ok3 = (@($record.rows | ForEach-Object { [int]$_.order }) -join ',') -eq '2,3,68,70'
  $ok3 = $ok3 -and ("$($rowsById['362'].reason)" -eq 'dispatched') -and
         ("$($rowsById['400'].reason)" -eq 'capacity') -and
         (-not @($record.rows | Where-Object { "$($_.reason)" -match '\s' }))

  # 4 -- bounded: the stale line is gone, the in-window run start survives.
  $ok4 = (@($lines).Count -eq 2) -and
         (-not @($lines | Where-Object { $_ -match '"runId":"old"' })) -and
         (@($lines | Where-Object { $_ -match '"startedAt":"2026-09-29' }).Count -eq 1)

  # 5 -- the outcome vocabulary is closed.
  $bad = Invoke-Decisions -script $script -ledger (Join-Path $root "$tag-bad.jsonl") -runId 'run-2' `
    -now '2026-09-29T11:20:00-07:00' -outcomeJson '[{"id":"362","outcome":"he seemed busy"}]'
  $ok5 = ($bad.ExitCode -ne 0) -and ($bad.Text -match 'decisions_outcome_word')

  # 6 -- a full (non-compact) scan is refused rather than half-recorded.
  $arrayScan = Join-Path $root "$tag-array.json"
  [IO.File]::WriteAllText($arrayScan, '[{"id":"245","order":2,"section":"today","eligible":false}]',
    [Text.UTF8Encoding]::new($false))
  $refused = & $PsExe -NoProfile -ExecutionPolicy Bypass -File $script decisions -RunId 'run-3' `
    -ScanFile $arrayScan -RunLedger (Join-Path $root "$tag-array.jsonl") `
    -DecisionNow '2026-09-29T11:30:00-07:00' -StateDir (Join-Path $root 'state') 2>&1
  $ok6 = ($LASTEXITCODE -ne 0) -and (($refused -join "`n") -match 'decisions_requires_compact_scan')

  return [pscustomobject]@{
    Appended = $ok1; TodayNamed = $ok2; Reasons = $ok3; Bounded = $ok4
    ClosedVocabulary = $ok5; CompactRequired = $ok6
  }
}

try {
  Write-Host 'mutcheck-decision-record (#561)'
  $live = Test-Record -script $ScriptPath -tag 'live'
  Assert $live.Appended 'the record is appended to the run ledger and quotes the scan summary'
  Assert $live.TodayNamed 'every Today row is named with its deciding reason, eligible or not'
  Assert $live.Reasons 'rows are in scan order with one-word dispatch/skip reasons'
  Assert $live.Bounded 'the ledger is bounded: stale lines drop, in-window run starts survive'
  Assert $live.ClosedVocabulary 'a free-text outcome is refused'
  Assert $live.CompactRequired 'a full scan array is refused, not half-recorded'

  # --- mutants: each one deletes a property above, and must be killed -----------------------
  $src = [IO.File]::ReadAllText($ScriptPath)
  $mutations = @(
    @{ Name = 'today-rows'; Property = 'TodayNamed'
       Find = "if (-not (`$outcomes.ContainsKey(`$id) -or `$r.eligible -or `$section -eq 'today')) { continue }"
       Replace = "if (-not (`$outcomes.ContainsKey(`$id) -or `$r.eligible)) { continue }" },
    @{ Name = 'retention'; Property = 'Bounded'
       Find = '  if ($retainDays -le 0) { return }'
       Replace = '  if ($retainDays -ge 0) { return }' },
    @{ Name = 'vocabulary'; Property = 'ClosedVocabulary'
       Find = "    if (`$script:DecisionOutcomeWords -notcontains `$word) {"
       Replace = "    if (`$false) {" },
    @{ Name = 'ineligible-cause'; Property = 'TodayNamed'
       Find = "    if (-not `$cause) { `$cause = 'unknown' }"
       Replace = "    `$cause = 'unknown'" },
    @{ Name = 'compact-required'; Property = 'CompactRequired'
       Find = "  if (-not (`$scan.PSObject.Properties['summary'] -and `$scan.PSObject.Properties['rows'])) {"
       Replace = '  if ($false) {' },
    @{ Name = 'persistence'; Property = 'Appended'
       Find = '  [IO.File]::AppendAllText($RunLedger, "$line`n", (New-Object Text.UTF8Encoding($false)))'
       Replace = '' }
  )

  foreach ($m in $mutations) {
    if ($src.Split($m.Find).Count -ne 2) { throw "$($m.Name): mutation target not found (the code moved)" }
    $path = Join-Path $root "oa-state-$($m.Name).ps1"
    [IO.File]::WriteAllText($path, $src.Replace($m.Find, $m.Replace), [Text.UTF8Encoding]::new($true))
    $killed = $false
    try {
      $result = Test-Record -script $path -tag $m.Name
      $killed = -not $result.($m.Property)
    }
    catch { $killed = $true }
    Assert $killed "mutant '$($m.Name)' is killed by $($m.Property)"
  }

  Write-Host ''
  Write-Host "passed $pass / $($pass + $fail)"
  if ($fail -gt 0) { exit 1 }
  exit 0
}
finally {
  Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue
}
