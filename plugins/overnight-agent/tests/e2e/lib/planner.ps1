# Builds the synthetic planner folder, settings and gate for a sandbox. Dot-source after
# lib\sandbox.ps1 and lib\scenarios.ps1.

function New-SandboxSettingsText($L, [string]$ProjectId, [int]$Concurrency) {
  @"
# Overnight Agent - user settings (SANDBOX)

Synthetic settings for an end-to-end sandbox run. Every path
points inside the sandbox; nothing here names a real account.

## Settings

| Setting | Value |
| --- | --- |
| User | ``Sam Sandbox`` (``oa-sandbox`` on GitHub) |
| Timezone | ``America/Los_Angeles`` |
| Planner board | ``$($L.Planner)\planner.md`` |
| Completed board | ``$($L.Planner)\planner-completed.md`` |
| Journals folder | ``$($L.Journal)\`` |
| Agent state store | ``$($L.StateDir)\`` (per-task JSON; local). Managed via ``oa-state.ps1``. |
| Dev drive (repos) | ``$($L.Repos)\`` |
| Non-code task project | ``$ProjectId`` - local folder project rooted at ``$($L.TaskChats)`` |
| GitHub owner | ``github.com/oa-sandbox`` |
| Agent email account | ``agent@sandbox.invalid`` |
| Critical tools | ``sandbox-app`` - the sandbox's stand-in for the app host; probe it with its ``ping`` tool. |
| Authorized sender addresses | ``sam@sandbox.invalid`` |
| Auto-send (email) allow-list | ``sam@sandbox.invalid`` |

## Telegram (optional - mirror journals to a Telegram forum group)

| Setting | Value |
| --- | --- |
| Enabled | ``off`` |

## Overnight Agent behaviour

| Setting | Value |
| --- | --- |
| Today gate backstop | ``6h`` |
| Today gate strict | ``off`` |
| Overnight Agent concurrency | ``$Concurrency`` |
| Overnight Agent start buffer | ``5m`` |
| Overnight Agent model | ``auto`` |

## Preferences

- **Inbox check:** ``off`` - there is no agent inbox in this environment.
- **Code tasks open a draft PR:** ``on``.
- **Default planning scope:** every task in ``## Today`` (expand to ``## Deferred`` as capacity allows).
- **Email replies / sends:** ``allowed`` to anyone on the Auto-send allow-list above.
- **Email format:** ``html``.
- **Secrets:** never stored in this file.
"@
}

function New-SandboxGateText {
  @'
# Agent gate

<!-- planner-agent-gate v1 - you own this file. The overnight agent reads it and never writes it. -->

## Do not gate these (reversible)

- Research, comparisons and drafts written into the task's own journal or a file beside it
- Emailing myself

## Always ask (safety floor)

- Send-to-many (group/channel, manager, mass email)
- Starting a fresh conversation with someone in chat/email
'@
}

function Format-BoardRow($s, [string]$Added, [switch]$Deferred) {
  $icon = $script:Icon[$s.Urgency]
  if ($Deferred) { return "| $($s.Id) | $icon | $($s.Title) | $($s.Priority) | $Added |  |  |" }
  return "| $($s.Id) | $icon | $($s.Title) | $($s.Priority) | $Added |  |"
}

# Seeds the planner for the chosen scenarios and returns the seeding context (dates, project id,
# pre-existing sessions) the precheck and the stub app host need.
function New-SandboxPlanner($L, [hashtable]$Env, $Scenarios, [int]$Concurrency = 3) {
  $now = Get-Date
  $ctx = @{
    L = $L; Env = $Env
    Today = $now.ToString('yyyy-MM-dd'); Yesterday = $now.AddDays(-1).ToString('yyyy-MM-dd')
    TwoDaysAgo = $now.AddDays(-2).ToString('yyyy-MM-dd'); FutureWake = $now.AddDays(30).ToString('yyyy-MM-dd')
    ProjectId = [guid]::NewGuid().ToString()
    Snooze = @{}
    PreexistingSessions = New-Object Collections.ArrayList
    ScanRows = @()
  }
  $added = $now.AddDays(-5).ToString('yyyy-MM-dd')
  $t = $script:Icon.target
  $items = @(foreach ($s in $Scenarios) { $s; if ($s.PSObject.Properties['Companions']) { $s.Companions } })
  $today = @($items | Where-Object Board -eq 'today' | Sort-Object @{ Expression = { if ($_.Id -eq '9407') { 1 } else { 0 } } }, Id)
  $deferred = @($items | Where-Object Board -eq 'deferred')
  $completed = @($items | Where-Object Board -eq 'completed')
  $board = New-Object Text.StringBuilder
  [void]$board.Append("# Focus Plan`n`n## Today`n`n| ID | $t | Task | Work Priority | Added | Linked ID |`n|----|----|------|------|------|------|`n")
  foreach ($s in $today) { [void]$board.Append((Format-BoardRow $s $added) + "`n") }
  [void]$board.Append("`n## Deferred`n`n| ID | $t | Task | Work Priority | Added | Wake | Linked ID |`n|----|----|------|------|------|------|------|`n")
  foreach ($s in $deferred) { [void]$board.Append((Format-BoardRow $s $added -Deferred) + "`n") }
  [void]$board.Append("`n## Priorities`n`n")
  Write-Utf8 (Join-Path $L.Planner 'planner.md') $board.ToString()
  $done = New-Object Text.StringBuilder
  [void]$done.Append("# Completed`n`n## Week of $($now.AddDays(-7).ToString('yyyy-MM-dd'))`n`n| ID | $t | Task | Work Priority | Added | Completed |`n|----|----|------|------|------|------|`n")
  foreach ($s in $completed) { [void]$done.Append("| $($s.Id) | $($script:Icon[$s.Urgency]) | $($s.Title) | $($s.Priority) | $added | $($ctx.Yesterday) |`n") }
  Write-Utf8 (Join-Path $L.Planner 'planner-completed.md') $done.ToString()
  Write-Utf8 (Join-Path $L.Planner 'agent-gate.md') (New-SandboxGateText)
  Write-Utf8 $L.Settings (New-SandboxSettingsText $L $ctx.ProjectId $Concurrency)
  foreach ($s in $Scenarios) { & $s.Seed $ctx $s }
  $snooze = [ordered]@{}; foreach ($k in $ctx.Snooze.Keys) { $snooze[$k] = $ctx.Snooze[$k] }
  Write-Utf8 (Join-Path $L.Planner 'snooze.json') ($snooze | ConvertTo-Json)
  return $ctx
}

# Runs every chosen scenario's precheck against the seeded sandbox, using the code under test.
function Invoke-Prechecks($ctx, $Scenarios) {
  $scanFile = Join-Path $ctx.L.Tmp 'precheck-scan.json'
  Invoke-SandboxState $ctx.L $ctx.Env @('scan', '-ScanOutFile', $scanFile) -Raw | Out-Null
  $rows = @((Read-Utf8 $scanFile) | ConvertFrom-Json -Depth 30)
  if ($rows.Count -eq 1 -and $rows[0].PSObject.Properties['rows']) { $rows = @($rows[0].rows) }
  $ctx.ScanRows = $rows
  $out = @()
  foreach ($s in $Scenarios) {
    $row = @($rows | Where-Object { "$($_.id)" -eq $s.Id })[0]
    if (-not $row) { $out += New-Check "$($s.Letter).seed0" "$($s.Name): task $($s.Id) is on the scan" $false; continue }
    foreach ($c in @(& $s.Precheck $ctx $row)) { $out += $c }
  }
  Remove-Item -LiteralPath $scanFile -Force -ErrorAction SilentlyContinue
  return $out
}
