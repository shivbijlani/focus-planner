<#
  browser-watchdog-shim.ps1 -- the content that REPLACES the old
  `%OneDrive%\skills\browser-watchdog\watchdog.ps1`.

  WHY A SHIM RATHER THAN A DELETION
  ---------------------------------
  The old watchdog lived in OneDrive, outside this repository. That is the whole
  reason it could carry the GH #197 bug for as long as it did: no CI ran against
  it, no test covered it, and the `auto-deploy-plugin.ps1` / `sync-oa-home.ps1`
  pipeline that guarantees "merged means running" for everything else in this
  stack could not see it at all.

  The real watchdog now lives in the repo and deploys to the flat OA home. But
  the OneDrive skill (`SKILL.md`, `provision.ps1`, `detect-account.ps1`) still
  names `watchdog.ps1`, and Shiv may invoke the skill directly. Deleting the file
  would break those callers; leaving the old one in place would keep serving the
  bug. So it becomes a shim: no logic of its own, nothing that can drift.

  If the deployed watchdog is missing, this REFUSES rather than silently falling
  back to the TCP-accept test. A quiet fallback to the buggy behaviour is exactly
  how "green but not running" happens, and a refusal is visible.

  This file is versioned HERE so the shim is not itself an un-tracked script.
#>
[CmdletBinding()]
param(
    [switch]$WhatIf,
    [switch]$Quiet,
    [switch]$Json
)

$deployed = Join-Path $env:LOCALAPPDATA 'overnight-agent\browser-watchdog.ps1'
if (-not (Test-Path -LiteralPath $deployed)) {
    Write-Host 'browser-watchdog: the deployed watchdog is missing.' -ForegroundColor Red
    Write-Host "  expected: $deployed" -ForegroundColor Red
    Write-Host '  This shim will NOT fall back to the old TCP-accept probe: that probe' -ForegroundColor Red
    Write-Host '  reports a wedged slot as healthy, which is the bug it was replaced for (GH #197).' -ForegroundColor Red
    Write-Host '  Fix: run auto-deploy-plugin.ps1, or sync-oa-home.ps1 -Restore -Confirm.' -ForegroundColor Yellow
    exit 2
}

$argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $deployed)
if ($WhatIf) { $argList += '-WhatIf' }
if ($Quiet) { $argList += '-Quiet' }
if ($Json) { $argList += '-Json' }

& powershell @argList
exit $LASTEXITCODE
