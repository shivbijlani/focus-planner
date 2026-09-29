<#
.SYNOPSIS
  browser-watchdog.ps1 - read-only status wrapper around check-browser-slots.ps1
  for the tray's browser-check workload.

.DESCRIPTION
  GH #698 shipped an hourly supervisor that could LAUNCH a down slot and THAW a
  stuck one, because the slots it supervised were CDP debug ports someone else
  had to keep alive. GH #738 removed that whole lifecycle: each Playwright MCP
  server now launches its OWN profile directly (`--browser msedge
  --user-data-dir <dir>`) and closes with the session that opened it. There is
  nothing left to launch on this slot's behalf and nothing frozen to thaw --
  the browser IS the MCP server's own process for the length of one session.

  What is still useful to surface is a read-only answer to "which profiles
  exist, and is one of them already open right now" -- check-browser-slots.ps1
  answers exactly that from the profile directory on disk (a `SingletonLock`
  file), never from a port. This script is a thin, JSON-friendly wrapper around
  it so the tray's browser-check workload has one thing to run on its schedule.

  IT NEVER LAUNCHES, CLOSES, RESTARTS OR REPAIRS A BROWSER. There is no LAUNCH
  phase and no REPAIR/THAW phase left in this file -- see GH #738's removal of
  ensure-mcp-browsers.ps1 and the launch/thaw phases this file used to have.

.PARAMETER Json
  Emit a machine-readable report instead of the human table.

.PARAMETER CheckerPath
  Override the path to check-browser-slots.ps1. Exists so the mutation check
  can inject a fixture tool.

.PARAMETER SettingsPath
  Passed through to check-browser-slots.ps1 so a fixture slot table can be used.

.PARAMETER ToolTimeoutSec
  Wall-clock cap for the child tool invocation, so a wedged tool cannot wedge
  the tray that calls this on a schedule.

.NOTES
  Exit codes:
    0  the slot table was read and every slot was reported on healthy. A
       profile being in use is normal, not a failure.
    2  the check itself surfaced a problem (e.g. the slot table could not be
       read) -- escalate.
    3  the assessment itself could not be performed (tool missing, timed out,
       or emitted no parseable JSON). Not 0: a supervisor that cannot answer
       its own question is not "ok".
#>
[CmdletBinding()]
param(
  [switch]$Json,
  [switch]$Quiet,
  [string]$CheckerPath,
  [string]$SettingsPath,
  [int]$ToolTimeoutSec = 60
)

$ErrorActionPreference = 'Stop'

function Note {
  param([string]$Message, [string]$Color = 'Gray')
  if (-not $Quiet -and -not $Json) { Write-Host $Message -ForegroundColor $Color }
}

# --- locate the tool ---------------------------------------------------------
# A SEARCH, not an assumption about layout. This script is deployed into the
# flat OA home (%LOCALAPPDATA%\overnight-agent) as well as living in the repo,
# and those two trees do not hold the same file set.
function Resolve-Tool {
  param([string]$Name, [string]$Override)
  if ($Override) {
    if (-not (Test-Path -LiteralPath $Override -PathType Leaf)) { return $null }
    return (Resolve-Path -LiteralPath $Override).Path
  }
  $candidates = @(
    ([IO.Path]::Combine($PSScriptRoot, $Name))
    ([IO.Path]::Combine($PSScriptRoot, '..', 'skills', 'overnight-agent', $Name))
    ([IO.Path]::Combine($PSScriptRoot, '..', 'checks', $Name))
    $(if ($env:LOCALAPPDATA) { [IO.Path]::Combine($env:LOCALAPPDATA, 'overnight-agent', $Name) })
    $(if ($env:USERPROFILE) { [IO.Path]::Combine($env:USERPROFILE, '.copilot', 'installed-plugins', 'focus-planner', 'overnight-agent', 'checks', $Name) })
  )
  foreach ($c in $candidates) {
    if ($c -and (Test-Path -LiteralPath $c -PathType Leaf)) { return (Resolve-Path -LiteralPath $c).Path }
  }
  return $null
}

$checker = Resolve-Tool -Name 'check-browser-slots.ps1' -Override $CheckerPath

if (-not $checker) {
  $msg = 'browser-watchdog: check-browser-slots.ps1 not found - cannot assess slot status.'
  if ($Json) { [pscustomobject]@{ error = $msg; healthy = $false } | ConvertTo-Json -Depth 4 }
  else { Write-Host $msg -ForegroundColor Red }
  exit 3
}

# --- run the tool as a child process ----------------------------------------
# So (a) its exit code is unambiguous, and (b) a tool that hangs is killed by
# OUR clock rather than hanging whatever runs this on a schedule.
function Invoke-Tool {
  param([string]$Path, [string[]]$Arguments = @())

  $psExe = (Get-Process -Id $PID).Path
  if (-not $psExe) { $psExe = 'powershell.exe' }

  $outFile = [IO.Path]::GetTempFileName()
  $errFile = [IO.Path]::GetTempFileName()
  try {
    $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $Path) + $Arguments
    $p = Start-Process -FilePath $psExe -ArgumentList $argList -NoNewWindow -PassThru `
                       -RedirectStandardOutput $outFile -RedirectStandardError $errFile
    # Windows PowerShell 5.1 reports ExitCode as $null for a Start-Process
    # -PassThru child unless its handle is opened before it exits. The tray
    # runs this under 5.1, so without this a successful run reads as failed.
    $null = $p.Handle
    if (-not $p.WaitForExit($ToolTimeoutSec * 1000)) {
      try { $p.Kill() } catch { }
      return [pscustomobject]@{ ExitCode = 124; Stdout = ''; Stderr = "timed out after ${ToolTimeoutSec}s"; TimedOut = $true }
    }
    return [pscustomobject]@{
      ExitCode = $p.ExitCode
      Stdout   = (Get-Content -LiteralPath $outFile -Raw -ErrorAction SilentlyContinue)
      Stderr   = (Get-Content -LiteralPath $errFile -Raw -ErrorAction SilentlyContinue)
      TimedOut = $false
    }
  }
  finally {
    Remove-Item $outFile, $errFile -Force -ErrorAction SilentlyContinue
  }
}

$toolArgs = @('-Json')
if ($SettingsPath) { $toolArgs += @('-SettingsPath', $SettingsPath) }

Note 'assessing browser profile status (read-only - which profiles exist, which are in use)...' 'Cyan'
$r = Invoke-Tool -Path $checker -Arguments $toolArgs

if ($r.TimedOut) {
  $msg = "browser-watchdog: check-browser-slots.ps1 timed out after ${ToolTimeoutSec}s."
  if ($Json) { [pscustomobject]@{ error = $msg; healthy = $false } | ConvertTo-Json -Depth 4 }
  else { Write-Host $msg -ForegroundColor Red }
  exit 3
}

$text = $r.Stdout
# Anchor on whichever bracket comes FIRST -- with exactly one slot the checker
# may (despite its own best efforts) still emit a bare object rather than a
# one-element array, so this tolerates both instead of assuming `[`.
$iArr = if ($text) { $text.IndexOf('[') } else { -1 }
$iObj = if ($text) { $text.IndexOf('{') } else { -1 }
$start = if ($iArr -ge 0 -and ($iObj -lt 0 -or $iArr -lt $iObj)) { $iArr }
         elseif ($iObj -ge 0) { $iObj }
         else { -1 }
$rows = $null
if ($start -ge 0) {
  try {
    # Materialize the pipeline result into a variable FIRST, then wrap with
    # @() -- wrapping the pipe expression directly (`@(x | ConvertFrom-Json)`)
    # can leave a one-element JSON array double-wrapped in Windows PowerShell,
    # so `$rows[0]` becomes the array's enumerator instead of the real object.
    $parsed = $text.Substring($start) | ConvertFrom-Json
    $rows = @($parsed)
  } catch { $rows = $null }
}

if ($null -eq $rows) {
  $msg = 'browser-watchdog: could not obtain a status report (tool exited without parseable JSON).'
  $detail = ($r.Stderr, $r.Stdout | Where-Object { $_ } | Select-Object -First 1)
  if ($Json) { [pscustomobject]@{ error = $msg; detail = $detail; healthy = $false } | ConvertTo-Json -Depth 4 }
  else { Write-Host $msg -ForegroundColor Red; if ($detail) { Write-Host "  $detail" -ForegroundColor DarkGray } }
  exit 3
}

if ($Json) {
  $unhealthyCount = @($rows | Where-Object { -not $_.healthy }).Count
  [pscustomobject]@{
    generated = (Get-Date).ToString('o')
    slots     = $rows
    unhealthy = $unhealthyCount
    healthy   = ($unhealthyCount -eq 0)
  } | ConvertTo-Json -Depth 5
  exit $(if ($unhealthyCount -gt 0) { 2 } else { 0 })
}

if (-not $Quiet) {
  foreach ($row in $rows) {
    $tag = if ($row.state -eq 'in-use') { 'Yellow' } elseif ($row.state -eq 'available') { 'Green' } else { 'DarkGray' }
    Note ("  [{0}] {1} - {2}" -f $row.slot, $row.state.ToUpper(), $row.detail) $tag
  }
  Write-Host ''
  $rows | Format-Table slot, account, profile_dir, state -AutoSize | Out-String | Write-Host
}

Note 'Read-only check complete. Nothing was launched, closed or thawed.' 'Green'
exit 0
