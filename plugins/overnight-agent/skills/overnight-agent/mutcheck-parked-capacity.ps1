<#
  #589 regression: task bindings/status/timers must not become a global admission gate.
  The clarified policy drains N-wide within each run, not a machine-global occupied-worker cap.
  Refill and dispatch behavior are tested in oa-dispatch.test.mjs; this compatibility guard
  proves the CLI limit reader never derives an occupancy value from retained task state.
#>
[CmdletBinding()]
param([string]$ScriptPath)
$ErrorActionPreference = 'Stop'
if (-not $ScriptPath) { $ScriptPath = Join-Path $PSScriptRoot 'oa-state.ps1' }
$psExe = if ($PSVersionTable.PSEdition -eq 'Core') { (Get-Process -Id $PID).Path } else { 'powershell' }
$root = Join-Path ([IO.Path]::GetTempPath()) ('per-run-limit-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root | Out-Null
try {
  $stateDir = Join-Path $root 'state'
  New-Item -ItemType Directory -Path $stateDir | Out-Null
  $id = 900
  foreach ($status in @('in-progress', 'approved', 'blocked', 'proposed', 'done', 'skip')) {
    $id++
    @{
      id = "$id"; status = $status
      session = @{ session_id = 'same-saved-conversation'; state = 'live'; last_woken_at = '2026-01-01T00:00:00Z' }
      poll = @{ next_due = '2026-01-01T00:00:00Z' }
      recheck = @{ next_due = '2026-01-01T00:00:00Z' }
    } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $stateDir "task-$id.json") -Encoding utf8
  }
  # An old experimental receipt store must not block this policy or be migrated/deleted.
  Set-Content -LiteralPath (Join-Path $stateDir 'capacity-generation.json') -Value '{invalid' -Encoding utf8
  Set-Content -LiteralPath (Join-Path $stateDir 'dispatch-old.json') -Value '{invalid' -Encoding utf8
  $before = @(Get-ChildItem $stateDir -File | Sort-Object Name | Get-FileHash | ForEach-Object Hash)
  $passed = 0
  foreach ($flag in @('-RunLimit', '-InFlight')) {
    $out = & $psExe -NoProfile -File $ScriptPath session $flag -StateDir $stateDir `
      -UserSettings (Join-Path $root 'absent-settings.md')
    if ($LASTEXITCODE -ne 0) { throw "$flag failed" }
    $value = $out | ConvertFrom-Json
    if ($value.scope -ne 'run_local_concurrency' -or $value.dispatch_limit -ne 1 -or
        $value.PSObject.Properties['in_flight'] -or $value.PSObject.Properties['at_capacity']) {
      throw "$flag reported the wrong policy"
    }
    $passed++; Write-Host "PASS $flag reports a per-run limit, not occupied workers"
  }
  $out = & $psExe -NoProfile -File $ScriptPath session -RunLimit -Concurrency 2 -StateDir $stateDir `
    -UserSettings (Join-Path $root 'absent-settings.md')
  if ($LASTEXITCODE -ne 0 -or ($out | ConvertFrom-Json).dispatch_limit -ne 2) { throw 'Explicit limit was not applied' }
  $passed++; Write-Host 'PASS explicit per-run limit is used'
  $after = @(Get-ChildItem $stateDir -File | Sort-Object Name | Get-FileHash | ForEach-Object Hash)
  if (($before -join ',') -ne ($after -join ',')) { throw 'The limit reader changed task/receipt state' }
  $passed++; Write-Host 'PASS all task and old receipt files remain unchanged'
  Write-Host "$passed passed, 0 failed"
}
finally { Remove-Item -LiteralPath $root -Recurse -Force }
