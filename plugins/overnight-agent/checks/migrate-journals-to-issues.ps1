# Migrate planner task journals into their corresponding GitHub issue as comments.
# Idempotent: each comment carries <!-- migrated-from-task-<ID> --> and we skip if already present.
param([switch]$DryRun)

$ErrorActionPreference = 'Stop'
$repo     = 'shivbijlani/focus-planner'
$journal  = 'C:\Users\shiv\OneDrive\Apps\Focus Planner\journal'
$umbrella = 176
$MAX      = 60000   # GitHub hard limit is 65536; leave headroom for the header

# task -> primary issue (journal body goes here)
$primary = [ordered]@{
  '280' = 132; '281' = 132; '287' = 39;  '318' = 44;  '398' = 123
  '399' = 127; '404' = 137; '407' = 124; '412' = 139; '434' = 173
  '439' = 170; '441' = 173; '445' = 132; '400' = $umbrella
}
# task -> extra issues that just get a short cross-reference
$crossref = @{ '399' = @(128); '439' = @(171); '400' = @(132,133,137,172,174) }

function Get-IssueComments([int]$n) {
  try { (gh issue view $n --repo $repo --json comments --jq '.comments[].body' 2>$null) -join "`n" }
  catch { '' }
}

$results = @()
foreach ($task in $primary.Keys) {
  $issue  = [int]$primary[$task]
  $file   = Join-Path $journal "task-$task.md"
  if (-not (Test-Path $file)) { $results += [pscustomobject]@{task=$task;issue=$issue;action='NO JOURNAL';chunks=0}; continue }

  $marker   = "<!-- migrated-from-task-$task -->"
  $existing = Get-IssueComments $issue
  if ($existing -match [regex]::Escape($marker)) {
    $results += [pscustomobject]@{task=$task;issue=$issue;action='ALREADY MIGRATED';chunks=0}; continue
  }

  $body = Get-Content $file -Raw -Encoding UTF8
  # split into chunks on line boundaries
  $chunks = @(); $cur = New-Object System.Text.StringBuilder
  foreach ($line in ($body -split "`r?`n")) {
    if ($cur.Length + $line.Length + 1 -gt $MAX) { $chunks += $cur.ToString(); $cur = New-Object System.Text.StringBuilder }
    [void]$cur.AppendLine($line)
  }
  if ($cur.Length) { $chunks += $cur.ToString() }
  if ($chunks.Count -eq 0) { $chunks = @('_(empty journal)_') }

  $i = 0
  foreach ($chunk in $chunks) {
    $i++
    $part = if ($chunks.Count -gt 1) { " — part $i of $($chunks.Count)" } else { '' }
    $hdr  = @"
$marker
### 📓 Migrated journal — planner task #$task$part

_Archived from the Focus Planner board as part of the consolidation in #$umbrella. This is the task's
full journal, moved here so its design rationale survives the board task being folded in.
Source: ``journal/task-$task.md`` · migrated $(Get-Date -Format 'yyyy-MM-dd')._

---

"@
    $out = Join-Path $env:TEMP "mig-$task-$i.md"
    [System.IO.File]::WriteAllText($out, ($hdr + $chunk), (New-Object System.Text.UTF8Encoding($false)))
    if ($DryRun) { Write-Host "DRYRUN task $task -> #$issue part $i ($($chunk.Length) chars)" }
    else {
      gh issue comment $issue --repo $repo --body-file $out | Out-Null
      Start-Sleep -Milliseconds 900
    }
    Remove-Item $out -Force -ErrorAction SilentlyContinue
  }
  $results += [pscustomobject]@{task=$task;issue=$issue;action=$(if($DryRun){'DRYRUN'}else{'MIGRATED'});chunks=$chunks.Count}
}

# cross-reference comments
foreach ($task in $crossref.Keys) {
  foreach ($issue in $crossref[$task]) {
    $marker = "<!-- xref-task-$task -->"
    $existing = Get-IssueComments $issue
    if ($existing -match [regex]::Escape($marker)) { continue }
    $where = $primary[$task]
    $txt = @"
$marker
📓 Planner task **#$task** also covered this issue. Its full journal was migrated to **#$where** as part
of the consolidation in #$umbrella — see there for the history rather than duplicating it.
"@
    $out = Join-Path $env:TEMP "xref-$task-$issue.md"
    [System.IO.File]::WriteAllText($out, $txt, (New-Object System.Text.UTF8Encoding($false)))
    if ($DryRun) { Write-Host "DRYRUN xref task $task -> #$issue" }
    else { gh issue comment $issue --repo $repo --body-file $out | Out-Null; Start-Sleep -Milliseconds 900 }
    Remove-Item $out -Force -ErrorAction SilentlyContinue
  }
}

$results | Format-Table -AutoSize
