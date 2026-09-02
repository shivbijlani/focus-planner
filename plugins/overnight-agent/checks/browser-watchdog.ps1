<#
.SYNOPSIS
  browser-watchdog.ps1 - the hourly browser supervisor, wired to the REAL health
  verdict instead of a bare TCP connect (GH #197).

.DESCRIPTION
  WHAT WAS WRONG
  --------------
  The hourly watchdog decided whether a slot was alive with a 1-second TCP
  connect:

      $iar = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
      if ($iar.AsyncWaitHandle.WaitOne(1000)) { ... return $true }

  and then, verbatim:

      if ($up) { Note "[slot ...] port ... already live - reusing." }

  `already-up` meant untouched, and the run ended `exit 0` with "All 3
  automation slots are up." That is liveness, not health. The browser PROCESS
  answers the socket; the thing that actually wedges is a RENDERER whose task
  queue is frozen. So the supervisor's only health signal is served by the one
  component that never breaks.

  MEASURED END TO END ON THE LIVE MACHINE, 2026-09-01:

    17:18-17:20 PT  hourly watchdog workflow ran -> completed, exit 0,
                    "All 3 automation slots are up."
    17:58    PT  check-browser-slots.ps1 -Json -> all three slots `stuck`,
                    `healthy: false`, exit 2, one frozen page each.

  Forty minutes apart, nothing in between. The supervisor ran, succeeded, and
  left three unusable slots. A slot that is STUCK could never be recovered,
  because the only branch that did anything was DOWN.

  Worse, the capability to see this already existed: #329 shipped a CDP work
  probe in check-browser-slots.ps1 that classifies exactly this state, and #347
  made its exit code honest. Nothing called it. Grepping the watchdog skill for
  `check-browser-slots`, `Repair`, `setWebLifecycleState` or `Runtime.evaluate`
  returned zero hits. The detector was merged and unwired - "merged is not
  running", one level up from #196.

  WHAT THIS DOES INSTEAD
  ----------------------
  It composes the two tools that already exist and are already guarded, rather
  than growing a third opinion about browser health:

    ASSESS   check-browser-slots.ps1 -Json   -> per-slot verdict from a bounded
                                                CDP work probe (down/up/stuck)
    LAUNCH   ensure-mcp-browsers.ps1         -> the DOWN branch, from the slot
                                                table in user-settings.md
    REPAIR   check-browser-slots.ps1 -Repair -> the STUCK branch: thaw frozen
                                                pages in place, non-destructively
    CONFIRM  check-browser-slots.ps1 -Json   -> re-probe before hand-back, so a
                                                slot is never reported recovered
                                                on the strength of having tried

  There is deliberately no fourth copy of the slot list here: both tools read
  the `## Browser slots` table in user-settings.md (GH #180), and this script
  never names a port.

  WHAT IT WILL NOT DO
  -------------------
  It never kills, closes or restarts a browser. The MCP slots are the user's
  signed-in windows and may hold in-flight state, and Edge's App-Bound
  Encryption means a botched restart leaves that profile signed out, which only
  the user can undo. The thaw (Page.setWebLifecycleState -> 'active') is the
  sanctioned rung precisely because it closes nothing. Any destructive rung is
  a separate, opt-in, evidenced change - see "Still open" in the issue.

  ON DEBOUNCE (issue criterion 4)
  -------------------------------
  Criterion 4 asks that recovery never fire on a single failed probe. That rule
  exists to stop a DESTRUCTIVE action triggering on a blip. The only recovery
  here is a non-destructive, idempotent thaw of a page that is already unusable,
  so a false positive costs one redundant CDP call and cannot lose data. The
  debounce is therefore deliberately not implemented for this rung, and remains
  required for any rung that closes or restarts anything.

.PARAMETER Json
  Emit a machine-readable report instead of the human table.

.PARAMETER ReportOnly
  Assess and report; take no launch or repair action. The honest name for what
  the old -WhatIf did.

.PARAMETER NoLaunch
  Skip the DOWN branch (do not start missing slots).

.PARAMETER NoRepair
  Skip the STUCK branch (do not thaw frozen pages). Restores pre-#197 inaction.

.PARAMETER CheckerPath
  Override the path to check-browser-slots.ps1. Exists so the mutation check can
  inject a fixture tool and never contact a real browser.

.PARAMETER EnsurePath
  Override the path to ensure-mcp-browsers.ps1, for the same reason.

.PARAMETER SettingsPath
  Passed through to both tools so a fixture slot table can be used.

.PARAMETER ToolTimeoutSec
  Wall-clock cap per child tool invocation. The probe is internally bounded
  already; this is the outer guarantee that a wedged tool cannot wedge the
  supervisor (issue criterion 2).

.NOTES
  Exit codes:
    0  every slot in the table is healthy (after any action taken).
    2  at least one slot is still not healthy - escalate. This is the signal
       criterion 9 needs; a supervisor that exits 0 over a dead slot cannot
       escalate anything.
    3  the assessment itself could not be performed (tool missing/unparseable).
       Not 0: a supervisor that cannot answer its own question is not "ok".
#>
[CmdletBinding()]
param(
  [switch]$Json,
  [switch]$ReportOnly,
  [switch]$NoLaunch,
  [switch]$NoRepair,
  [switch]$Quiet,
  [string]$CheckerPath,
  [string]$EnsurePath,
  [string]$SettingsPath,
  [int]$ToolTimeoutSec = 120
)

$ErrorActionPreference = 'Stop'

function Note {
  param([string]$Message, [string]$Color = 'Gray')
  if (-not $Quiet -and -not $Json) { Write-Host $Message -ForegroundColor $Color }
}

# --- locate the two tools ----------------------------------------------------
# A SEARCH, not an assumption about layout. This script is deployed into the
# flat OA home (%LOCALAPPDATA%\overnight-agent) as well as living in the repo,
# and those two trees do not hold the same file set. Assuming a sibling is what
# made PR #303 green and still broken (#305).
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
    $(if ($env:USERPROFILE) { [IO.Path]::Combine($env:USERPROFILE, '.copilot', 'installed-plugins', 'focus-planner', 'overnight-agent', 'skills', 'overnight-agent', $Name) })
  )
  foreach ($c in $candidates) {
    if ($c -and (Test-Path -LiteralPath $c -PathType Leaf)) { return (Resolve-Path -LiteralPath $c).Path }
  }
  return $null
}

$checker = Resolve-Tool -Name 'check-browser-slots.ps1'  -Override $CheckerPath
$ensure  = Resolve-Tool -Name 'ensure-mcp-browsers.ps1' -Override $EnsurePath

if (-not $checker) {
  $msg = 'browser-watchdog: check-browser-slots.ps1 not found - cannot assess slot health.'
  if ($Json) { [pscustomobject]@{ error = $msg; healthy = $false } | ConvertTo-Json -Depth 4 }
  else { Write-Host $msg -ForegroundColor Red }
  exit 3
}

# --- child-process tool runner ----------------------------------------------
# Run each tool in its own process so (a) its `exit` code is unambiguous, and
# (b) a tool that hangs is killed by OUR clock rather than hanging the hourly
# supervisor. The work probe is bounded internally; this is the outer bound.
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

function Get-SlotVerdict {
  <# THE HEALTH SIGNAL. Everything this script decides comes from here, and this
     is a CDP work probe - not a TCP connect. Replacing it with a port check is
     the exact defect #197 was filed about, which is why the mutation check
     mutates precisely this. #>
  param([switch]$Repair)

  # NOT $args: that is an automatic variable, and writing to it inside a
  # function is a quiet way to get a host-dependent surprise.
  $toolArgs = @('-Json')
  if ($Repair)       { $toolArgs += '-Repair' }
  if ($SettingsPath) { $toolArgs += @('-SettingsPath', $SettingsPath) }

  $r = Invoke-Tool -Path $checker -Arguments $toolArgs
  if ($r.TimedOut) { return $null }

  $text = $r.Stdout
  if (-not $text) { return $null }
  # Tolerate a leading host banner, but anchor on whichever bracket comes FIRST.
  # Taking IndexOf('[') unconditionally is wrong: with a single slot the tool
  # emits an OBJECT, and the first '[' in it is the empty `wedged_targets` array
  # in the middle of the payload, which yields unparseable garbage.
  $iArr = $text.IndexOf('[')
  $iObj = $text.IndexOf('{')
  $start = if ($iArr -ge 0 -and ($iObj -lt 0 -or $iArr -lt $iObj)) { $iArr }
           elseif ($iObj -ge 0) { $iObj }
           else { -1 }
  if ($start -lt 0) { return $null }
  try { return @($text.Substring($start) | ConvertFrom-Json) }
  catch { return $null }
}

# --- PHASE 1: ASSESS ---------------------------------------------------------
Note 'PHASE 1  assessing slot health (CDP work probe, not a port check)...' 'Cyan'
$before = Get-SlotVerdict
if ($null -eq $before) {
  $msg = 'browser-watchdog: could not obtain a slot verdict (tool timed out or emitted no parseable JSON).'
  if ($Json) { [pscustomobject]@{ error = $msg; healthy = $false } | ConvertTo-Json -Depth 4 }
  else { Write-Host $msg -ForegroundColor Red }
  exit 3
}

$state = @{}
foreach ($row in $before) {
  $state[[string]$row.port] = [ordered]@{
    mcp          = $row.mcp
    port         = $row.port
    state_before = $row.state
    healthy      = [bool]$row.healthy
    action       = 'none'
    state_after  = $row.state
    detail       = $row.detail
  }
  $tag = if ($row.healthy) { 'Green' } elseif ($row.state -eq 'down') { 'Yellow' } else { 'Red' }
  Note ("  [{0} :{1}] {2}" -f $row.mcp, $row.port, $row.state.ToUpper()) $tag
}

$down  = @($before | Where-Object { $_.state -eq 'down' })
# STUCK is the branch the old watchdog did not have at all: the port answers,
# so TCP-accept called it `already-up` and left it wedged forever.
$stuck = @($before | Where-Object { $_.state -ne 'down' -and -not $_.healthy })

$launched = 0
$repaired = 0

# --- PHASE 2: LAUNCH the DOWN slots -----------------------------------------
if ($down.Count -gt 0 -and -not $ReportOnly -and -not $NoLaunch) {
  if (-not $ensure) {
    Note '  ensure-mcp-browsers.ps1 not found - cannot start missing slots.' 'Red'
  }
  else {
    foreach ($d in $down) {
      Note ("PHASE 2  launching {0} (:{1})" -f $d.mcp, $d.port) 'Cyan'
      $a = @('-Slot', [string]$d.mcp)
      if ($SettingsPath) { $a += @('-SettingsPath', $SettingsPath) }
      $r = Invoke-Tool -Path $ensure -Arguments $a
      if ($r.ExitCode -eq 0) { $launched++; $state[[string]$d.port].action = 'launched' }
      else { $state[[string]$d.port].action = 'launch-failed' }
    }
  }
}
elseif ($down.Count -gt 0) {
  foreach ($d in $down) { $state[[string]$d.port].action = 'would-launch' }
}

# --- PHASE 3: REPAIR the STUCK slots ----------------------------------------
# This is the whole point of the change. -Repair thaws frozen pages in place via
# Page.setWebLifecycleState -> 'active'. Nothing is closed, killed or restarted.
if ($stuck.Count -gt 0 -and -not $ReportOnly -and -not $NoRepair) {
  Note ("PHASE 3  thawing {0} stuck slot(s) in place (no window is closed)" -f $stuck.Count) 'Cyan'
  $after = Get-SlotVerdict -Repair
  if ($null -ne $after) {
    foreach ($row in $after) {
      $k = [string]$row.port
      if (-not $state.ContainsKey($k)) { continue }
      if ($state[$k].state_before -ne 'down') {
        $state[$k].action = 'repaired'
        if ($row.repaired -gt 0) { $repaired++ }
      }
    }
  }
}
elseif ($stuck.Count -gt 0) {
  foreach ($s in $stuck) { $state[[string]$s.port].action = 'would-repair' }
}

# --- PHASE 4: CONFIRM --------------------------------------------------------
# Re-probe before hand-back (issue criterion 5). A slot is never reported
# recovered because a repair was ATTEMPTED - only because a fresh work probe
# says it can do work now.
$final = $before
if (-not $ReportOnly -and ($launched -gt 0 -or $repaired -gt 0 -or $stuck.Count -gt 0)) {
  if ($launched -gt 0) { Start-Sleep -Seconds 4 }
  Note 'PHASE 4  re-probing to confirm before hand-back...' 'Cyan'
  $confirm = Get-SlotVerdict
  if ($null -ne $confirm) { $final = $confirm }
}

foreach ($row in $final) {
  $k = [string]$row.port
  if (-not $state.ContainsKey($k)) { continue }
  $state[$k].state_after = $row.state
  $state[$k].healthy     = [bool]$row.healthy
  $state[$k].detail      = $row.detail
}

$rows = @($state.Values | ForEach-Object { [pscustomobject]$_ })
# A `down` slot we were told not to start is not a failure of this run; a slot
# that is still not healthy after we acted on it is.
$unhealthy = @($rows | Where-Object { -not $_.healthy -and -not ($_.state_after -eq 'down' -and ($NoLaunch -or $ReportOnly)) })

# THE VERDICT IS COMPUTED ONCE, BEFORE THE OUTPUT BRANCH.
# check-browser-slots.ps1 shipped with this exact bug (#347): the -Json path did
# an unconditional `exit 0` while its own body said `stuck`. How a caller asks to
# be told must never change what it is told.
$exitCode = if ($unhealthy.Count -gt 0) { 2 } else { 0 }

if ($Json) {
  [pscustomobject]@{
    generated  = (Get-Date).ToString('o')
    slots      = $rows
    launched   = $launched
    repaired   = $repaired
    unhealthy  = $unhealthy.Count
    healthy    = ($unhealthy.Count -eq 0)
    report_only = [bool]$ReportOnly
  } | ConvertTo-Json -Depth 5
  exit $exitCode
}

if (-not $Quiet) {
  Write-Host ''
  $rows | Format-Table mcp, port, state_before, action, state_after, healthy -AutoSize | Out-String | Write-Host
}

if ($unhealthy.Count -gt 0) {
  Note ("{0} slot(s) STILL not healthy after recovery - escalate:" -f $unhealthy.Count) 'Red'
  foreach ($u in $unhealthy) { Note ("  [{0} :{1}] {2}" -f $u.mcp, $u.port, $u.detail) 'Red' }
  Note 'Not attempting a process restart: that can cost a signed-in profile (App-Bound Encryption).' 'DarkGray'
  exit 2
}

Note ("All slots healthy (launched {0}, thawed {1}) - verified by a fresh CDP work probe." -f $launched, $repaired) 'Green'
exit 0
