<#
.SYNOPSIS
  Compare a candidate e2e report against a baseline: fail if anything that passed on the
  baseline does not pass on the candidate.

.DESCRIPTION
  The rule (plugins/overnight-agent/tests/e2e/README.md): run the SAME scenarios on the baseline
  (main) and the candidate (your branch). The candidate must pass every scenario the baseline
  passes. Outcomes per scenario are pass | flaky | fail | invalid-seed | seeded.

    baseline pass   -> candidate must be pass or flaky      (flaky is reported, not failed)
    baseline flaky  -> candidate must be pass or flaky
    baseline fail   -> not gating (the baseline itself does not pass it); reported
    invariants      -> must be pass on the candidate, always (safety, never waived)
    candidate invalid-seed -> fail: the candidate's own code no longer means what the seed says

  Exit 0 = no regression, 1 = regression, 2 = the reports are not comparable.

.EXAMPLE
  pwsh -File compare.ps1 -Baseline main\report.json -Candidate branch\report.json
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$Baseline,
  [Parameter(Mandatory)][string]$Candidate,
  [switch]$Json
)
$ErrorActionPreference = 'Stop'
function Read-Report([string]$p) {
  if (Test-Path -LiteralPath $p -PathType Container) { $p = Join-Path $p 'report.json' }
  $r = Get-Content -LiteralPath $p -Raw | ConvertFrom-Json -Depth 30
  if ($r.schema -ne 'oa-e2e-report/1') { throw "not an e2e report: $p" }
  return $r
}
$b = Read-Report $Baseline
$c = Read-Report $Candidate
if ($b.seedOnly -or $c.seedOnly) { Write-Host 'seed-only reports cannot be compared'; exit 2 }

$ok = @('pass', 'flaky')
$rows = @()
$names = @($b.outcomes.PSObject.Properties.Name) + @($c.outcomes.PSObject.Properties.Name) | Select-Object -Unique
foreach ($n in $names) {
  $bo = if ($b.outcomes.PSObject.Properties[$n]) { $b.outcomes.$n } else { 'absent' }
  $co = if ($c.outcomes.PSObject.Properties[$n]) { $c.outcomes.$n } else { 'absent' }
  $verdict = 'ok'
  if ($n -eq 'invariants') { if ($co -ne 'pass') { $verdict = 'REGRESSION' } }
  elseif ($co -eq 'invalid-seed') { $verdict = 'REGRESSION' }
  elseif ($bo -in $ok -and $co -notin $ok) { $verdict = 'REGRESSION' }
  elseif ($bo -notin $ok -and $bo -ne 'absent') { $verdict = 'not gating (baseline does not pass)' }
  elseif ($bo -eq 'absent') { $verdict = 'new (no baseline)' }
  if ($co -eq 'flaky' -and $verdict -eq 'ok') { $verdict = 'ok (flaky on candidate)' }
  $rows += [pscustomobject]@{ scenario = $n; baseline = $bo; candidate = $co; verdict = $verdict }
}
$regressions = @($rows | Where-Object verdict -eq 'REGRESSION')
if ($Json) {
  [ordered]@{ baseline = $b.ref; candidate = $c.ref; regressions = $regressions.Count; rows = $rows } | ConvertTo-Json -Depth 6
} else {
  Write-Host "baseline : $($b.label) $($b.ref.ref) @ $($b.ref.sha)"
  Write-Host "candidate: $($c.label) $($c.ref.ref) @ $($c.ref.sha)"
  $rows | Format-Table -AutoSize | Out-String -Width 200 | Write-Host
  Write-Host $(if ($regressions.Count) { "REGRESSION: $($regressions.Count) scenario(s) pass on baseline but not on candidate" } else { 'no regression' })
}
if ($regressions.Count) { exit 1 }
exit 0
