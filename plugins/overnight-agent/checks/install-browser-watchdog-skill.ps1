<#
.SYNOPSIS
  Retired compatibility entry point. Browser supervision belongs to the optional
  Overnight Agent tray; this script never installs a separate watchdog or skill shim.
#>
[CmdletBinding()]
param(
  [string]$SkillPath,
  [switch]$Revert,
  [switch]$WhatIf,
  [switch]$Quiet
)

Write-Host 'The per-watchdog installer is retired; nothing changed.'
Write-Host 'Use install-oa-supervisor.ps1 for status, -Enable to opt into the unified tray, or -Disable to stop it.'
Write-Host 'Remove any separate browser-watchdog / Focus Planner watchdog chat automation through Copilot automation settings.'
if ($Revert) {
  Write-Error 'Restoring an independent watchdog installation is no longer supported.'
  exit 1
}
