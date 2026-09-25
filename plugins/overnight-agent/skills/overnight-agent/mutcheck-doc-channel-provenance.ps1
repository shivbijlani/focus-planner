<#
  mutcheck-doc-channel-provenance.ps1 -- the read behind the number (GH #593)

  THE DEFECT. `scan` published `doc_new_comments` without the freshness of the read that
  produced it, so on the one worklist a run actually reads these were byte-identical:

      observed 30 seconds ago, genuinely empty   -> doc_new_comments: 0
      last observed 5 days ago, 3 comments since -> doc_new_comments: 0
      never observed in the task's life          -> doc_new_comments: 0

  The issue asks for exactly one guard, in its own words: assert that a never-observed and a
  freshly-observed EMPTY channel produce DIFFERENT scan rows, and make the arm to kill the one
  that collapses them back to a bare 0. That arm is here (COLLAPSE), along with the boundary
  cases that decide whether the new field can be trusted.

  WHY `unread` AND `stale` ARE SEPARATE WORDS. A channel never read has no evidence either
  way; a channel read four hours ago has evidence that has merely expired. They justify
  different actions, and collapsing them is how "never observed" hid inside a number that
  looked measured. An arm pins them apart.

  Hermetic: synthetic journals, state, board and snooze store under TEMP, driving the REAL
  oa-state.ps1 via -JournalDir/-StateDir/-PlannerBoard/-SnoozeStore. No live store, no Google,
  no network; runs under pwsh on Linux.

  Exit 0 = every arm agreed.
#>

[CmdletBinding()]
param([string]$ScriptPath)

$ErrorActionPreference = 'Stop'
# Resolved in the BODY: $PSScriptRoot is not bound while parameter defaults are evaluated.
if (-not $ScriptPath) { $ScriptPath = Join-Path $PSScriptRoot 'oa-state.ps1' }
if (-not (Test-Path $ScriptPath)) { throw "oa-state.ps1 not found at $ScriptPath" }

$script:PsExe = if ($PSVersionTable.PSEdition -eq 'Core') { (Get-Process -Id $PID).Path } else { 'powershell' }
$utf8 = New-Object Text.UTF8Encoding($false)
$MOON = [char]::ConvertFromUtf32(0x1F319)

$root = Join-Path ([IO.Path]::GetTempPath()) ("oa-593-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $root -Force | Out-Null

$script:pass = 0
$script:fail = 0
function Assert([bool]$ok, [string]$name, [string]$why, [string]$detail = '') {
  if ($ok) { Write-Host "  PASS  $name  -- $why"; $script:pass++ }
  else {
    Write-Host "  FAIL  $name  -- $why" -ForegroundColor Red
    if ($detail) { Write-Host ("        got: " + $detail) -ForegroundColor DarkGray }
    $script:fail++
  }
}

# ---- the sandbox -----------------------------------------------------------------------
# Four channels, differing ONLY in their observation stamp, so any difference in the rows is
# attributable to the stamp and to nothing else:
#   940 never observed   941 observed just now   942 observed long ago   943 not doc-bound
function New-Sandbox {
  $sx = Join-Path $root ([guid]::NewGuid().ToString('N').Substring(0, 6))
  $jdir = Join-Path $sx 'journal'; $sdir = Join-Path $sx 'state'
  New-Item -ItemType Directory -Path $jdir -Force | Out-Null
  New-Item -ItemType Directory -Path $sdir -Force | Out-Null
  $board = Join-Path $sx 'planner.md'; $store = Join-Path $sx 'snooze.json'

  foreach ($id in 940, 941, 942, 943) {
    $j = "# Task ${id}: synthetic`n`nnotes`n`n---`n" +
         "<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->`n`n" +
         "## $MOON Overnight Agent`n`n**Status:** In progress`n`n<!-- oa-ask: none -->`n"
    [IO.File]::WriteAllText((Join-Path $jdir "task-$id.md"), $j, $utf8)
  }

  $sb = New-Object Text.StringBuilder
  [void]$sb.AppendLine('## Today')
  [void]$sb.AppendLine('')
  [void]$sb.AppendLine('| ID | U | Task | Work Priority | Added | Linked ID |')
  [void]$sb.AppendLine('|---|---|------|---------------|-------|-----------|')
  foreach ($id in 940, 941, 942, 943) { [void]$sb.AppendLine("| $id |  | today $id | - | 2026-09-25 |  |") }
  [IO.File]::WriteAllText($board, $sb.ToString(), $utf8)
  [IO.File]::WriteAllText($store, '{}', $utf8)
  return [pscustomobject]@{ JDir = $jdir; SDir = $sdir; Board = $board; Store = $store }
}

function Invoke-Oa {
  param([string]$Subject, $Sx, [string[]]$OaArgs)
  return (& $script:PsExe -NoProfile -ExecutionPolicy Bypass -File $Subject @OaArgs `
      -JournalDir $Sx.JDir -StateDir $Sx.SDir -PlannerBoard $Sx.Board -SnoozeStore $Sx.Store 2>&1)
}

# The doc object is written STRAIGHT INTO STATE rather than produced by `doc -Observe`, because
# -Observe requires a Google dump and this harness must not touch the network. The shape is the
# one New-DocObject writes, and the arms below read it back through the real scan.
function Set-Channel {
  param($Sx, [string]$Id, [string]$ObservedAt, [int]$Pending = 0)
  $p = Join-Path $Sx.SDir "task-$Id.json"
  $st = Get-Content -LiteralPath $p -Raw | ConvertFrom-Json
  $pend = @(); for ($i = 0; $i -lt $Pending; $i++) { $pend += "cid-$Id-$i" }
  $doc = [pscustomobject]@{
    doc_id = "DOC$Id"; doc_url = "https://docs.google.com/document/d/DOC$Id/edit"
    bound_at = '2026-09-01T00:00:00-07:00'; seen_ids = @(); pending_ids = $pend
    observed_at = $ObservedAt
  }
  Add-Member -InputObject $st -NotePropertyName 'doc' -NotePropertyValue $doc -Force
  [IO.File]::WriteAllText($p, ($st | ConvertTo-Json -Depth 8), $utf8)
}

function Get-Rows {
  param([string]$Subject, $Sx)
  $text = (Invoke-Oa $Subject $Sx @('scan') | Out-String)
  try { return @($text | ConvertFrom-Json) } catch { return @() }
}
function Get-Row { param($rows, [string]$id) return ($rows | Where-Object { "$($_.id)" -eq $id } | Select-Object -First 1) }

function Build-Fixture {
  param([string]$Subject)
  $sx = New-Sandbox
  foreach ($id in 940, 941, 942, 943) { [void](Invoke-Oa $Subject $sx @('mark', '-Id', "$id", '-Status', 'in-progress')) }
  Set-Channel $sx '940' ''                                                      # never observed
  Set-Channel $sx '941' ([datetime]::Now.ToString('o'))                         # observed now
  Set-Channel $sx '942' ([datetime]::Now.AddDays(-5).ToString('o'))             # observed 5 days ago
  return $sx
}

Write-Host ''
Write-Host 'THE ISSUE''S OWN ARM -- never-observed and freshly-observed-empty must differ'

$sx = Build-Fixture $ScriptPath
$rows = Get-Rows $ScriptPath $sx
$never = Get-Row $rows '940'; $fresh = Get-Row $rows '941'; $stale = Get-Row $rows '942'; $unbound = Get-Row $rows '943'

Assert ($null -ne $never -and $null -ne $fresh) 'FIXTURE' 'the sandbox produced the rows under test' `
  "rows=$($rows.Count)"

# The bare number is IDENTICAL on all three. That is the defect restated as a control: if this
# ever stops being true the arms below would pass for the wrong reason.
Assert ("$($never.doc_new_comments)" -eq '0' -and "$($fresh.doc_new_comments)" -eq '0' -and "$($stale.doc_new_comments)" -eq '0') `
  'CONTROL' 'all three still report doc_new_comments 0, which is why the count alone cannot answer' `
  "never=$($never.doc_new_comments) fresh=$($fresh.doc_new_comments) stale=$($stale.doc_new_comments)"

Assert ("$($never.doc_channel)" -ne "$($fresh.doc_channel)") 'COLLAPSE' `
  'a never-observed channel and a freshly-observed empty one produce DIFFERENT rows' `
  "never=$($never.doc_channel) fresh=$($fresh.doc_channel)"

Write-Host ''
Write-Host 'THE VERDICTS -- each word means one thing'

Assert ("$($never.doc_channel)" -eq 'unread') 'UNREAD' 'never observed reads as unread' "got $($never.doc_channel)"
Assert ("$($fresh.doc_channel)" -eq 'fresh') 'FRESH' 'observed just now reads as fresh' "got $($fresh.doc_channel)"
Assert ("$($stale.doc_channel)" -eq 'stale') 'STALE' 'observed five days ago reads as stale' "got $($stale.doc_channel)"

# Not merely "both non-fresh". A channel never read has no evidence; one read four hours ago has
# evidence that expired. Collapsing them is how "never observed" hid inside a measured-looking 0.
Assert ("$($never.doc_channel)" -ne "$($stale.doc_channel)") 'UNREAD-NOT-STALE' `
  'never-read is distinguishable from read-and-expired, not merely from fresh' `
  "never=$($never.doc_channel) stale=$($stale.doc_channel)"

Assert ($null -eq $unbound.doc_channel) 'UNBOUND' 'a task with no channel reports no verdict rather than a false one' `
  "got $($unbound.doc_channel)"

Write-Host ''
Write-Host 'THE STAMP -- passed through, not re-derived'

Assert ([bool]"$($fresh.doc_observed_at)") 'STAMP-PRESENT' 'the row carries the observation timestamp itself' `
  "got '$($fresh.doc_observed_at)'"
Assert ($null -eq $never.doc_observed_at -or "$($never.doc_observed_at)" -eq '') 'STAMP-ABSENT' `
  'and reports nothing for a channel that was never read' "got '$($never.doc_observed_at)'"

# A field missing on some rows cannot be read as a verdict on any of them -- the rule this file
# already applies to has_journal. The #534 synthesised rows carry no doc fields at all.
$hasFields = @($rows | Where-Object { $_.PSObject.Properties['doc_channel'] }).Count
Assert ($hasFields -eq $rows.Count) 'EVERY-ROW' 'the field is present on every row, so absence is never the answer' `
  "$hasFields of $($rows.Count)"

Write-Host ''
Write-Host 'BOUNDARIES -- the cases that decide whether the verdict can be trusted'

$sx2 = Build-Fixture $ScriptPath
Set-Channel $sx2 '940' 'not-a-timestamp'
$r2 = Get-Rows $ScriptPath $sx2
# An unparseable stamp is NOT fresh. Reading it as current would manufacture exactly the false
# confidence this field exists to remove.
Assert ("$((Get-Row $r2 '940').doc_channel)" -eq 'unread') 'UNPARSEABLE' `
  'a stamp nobody can evaluate is not evidence of a read' "got $((Get-Row $r2 '940').doc_channel)"

$sx3 = Build-Fixture $ScriptPath
Set-Channel $sx3 '942' ([datetime]::Now.AddDays(-5).ToString('o')) -Pending 3
$r3 = Get-Rows $ScriptPath $sx3
$p = Get-Row $r3 '942'
# Pending comments and staleness are independent facts. A stale channel with 3 unacked comments
# must still report both -- the verdict describes the READ, not the contents.
Assert ("$($p.doc_new_comments)" -eq '3' -and "$($p.doc_channel)" -eq 'stale') 'INDEPENDENT' `
  'the verdict describes the read, and does not overwrite the count' `
  "new=$($p.doc_new_comments) channel=$($p.doc_channel)"

Write-Host ''
Write-Host 'THE THRESHOLD -- one definition, and it is the one three files already cite'

$src = [IO.File]::ReadAllText($ScriptPath)
Assert ($src -match '\$script:DocObservationFreshMinutes\s*=') 'DEFINED' `
  'oa-state.ps1 declares the constant catchup-doc-sweep, observe-bound-docs and run-sweeps name' ''

# Honouring the override is what lets an arm age a channel without waiting three hours, and it
# is also how the sweep is configured. If it stops being read, the two drift apart in silence.
$sx4 = Build-Fixture $ScriptPath
$old = $env:OA_DOC_FRESH_MINUTES
try {
  $env:OA_DOC_FRESH_MINUTES = '1'
  Set-Channel $sx4 '941' ([datetime]::Now.AddMinutes(-5).ToString('o'))
  $r4 = Get-Rows $ScriptPath $sx4
  Assert ("$((Get-Row $r4 '941').doc_channel)" -eq 'stale') 'THRESHOLD-BINDS' `
    'the freshness window is read from the constant rather than hardcoded at the use site' `
    "got $((Get-Row $r4 '941').doc_channel)"
}
finally { $env:OA_DOC_FRESH_MINUTES = $old }

Write-Host ''
if ($script:fail -gt 0) {
  Write-Host ("FAILED: {0} arm(s) disagreed, {1} passed." -f $script:fail, $script:pass) -ForegroundColor Red
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
  exit 1
}
Write-Host ("OK: {0} arms agreed. A count is published with the read that produced it." -f $script:pass) -ForegroundColor Green
Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
exit 0
