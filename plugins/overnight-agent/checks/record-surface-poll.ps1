# record-surface-poll.ps1 — stamp an off-journal surface as polled, so
# external-surface-sweep.mjs can go quiet for its freshness window.
#
# WHY THIS EXISTS
# ---------------
# The sweep's whole value is that it SELF-CLEARS. user-settings.md records the counter-example at
# length: the #198 `reopened` probe "does NOT self-clear, so its 6 are a floor, not a worklist",
# and acting on that list as given would have stacked five unwanted turns. A detector that cannot
# be satisfied gets skimmed, and then it is decoration.
#
# So: after a run actually polls a surface (list_document_comments, gh pr view, ...), it stamps it
# here. The sweep then reports `fresh` until OA_SURFACE_MAX_AGE_HOURS elapses, or until a NEWER
# ask is written — a stamp taken before the current ask never counts as covering it.
#
#   record-surface-poll.ps1 -Id 446 -Kind gdoc -Surface 1aZ6iz...
#   record-surface-poll.ps1 -FromWorklist          # stamp every row in the current worklist
#   record-surface-poll.ps1 -List                  # show what is recorded
[CmdletBinding(DefaultParameterSetName = 'One')]
param(
  [Parameter(ParameterSetName = 'One', Mandatory = $true)][string]$Id,
  [Parameter(ParameterSetName = 'One', Mandatory = $true)][string]$Kind,
  [Parameter(ParameterSetName = 'One', Mandatory = $true)][string]$Surface,
  [Parameter(ParameterSetName = 'One')][string]$Note = '',
  [Parameter(ParameterSetName = 'All', Mandatory = $true)][switch]$FromWorklist,
  [Parameter(ParameterSetName = 'List', Mandatory = $true)][switch]$List
)

$ErrorActionPreference = 'Stop'
$root = if ($env:OA_SURFACE_STATE) { Split-Path -Parent $env:OA_SURFACE_STATE } else { $PSScriptRoot }
$statePath = if ($env:OA_SURFACE_STATE) { $env:OA_SURFACE_STATE } else { Join-Path $root 'external-surface-polls.json' }
$worklistPath = if ($env:OA_SURFACE_WORKLIST) { $env:OA_SURFACE_WORKLIST } else { Join-Path $root 'external-surface-worklist.json' }

# Read as an ordered hashtable so keys added here survive a round-trip unchanged; PSCustomObject
# would force a property-add dance and silently reorder.
$state = [ordered]@{}
if (Test-Path -LiteralPath $statePath) {
  $raw = [IO.File]::ReadAllText($statePath, (New-Object Text.UTF8Encoding($false)))
  if ($raw.Trim()) {
    $obj = $raw | ConvertFrom-Json
    foreach ($p in $obj.PSObject.Properties) { $state[$p.Name] = $p.Value }
  }
}

function Save-State {
  $json = ($state | ConvertTo-Json -Depth 6)
  [IO.File]::WriteAllText($statePath, $json, (New-Object Text.UTF8Encoding($false)))
}

if ($List) {
  if (-not $state.Count) { Write-Output 'no surface polls recorded'; exit 0 }
  foreach ($k in $state.Keys) { Write-Output ("{0,-70} {1}" -f $k, $state[$k].at) }
  exit 0
}

$stamp = (Get-Date).ToUniversalTime().ToString('o')
$targets = @()

if ($FromWorklist) {
  if (-not (Test-Path -LiteralPath $worklistPath)) {
    Write-Error "no worklist at $worklistPath - run external-surface-sweep.mjs first"; exit 1
  }
  $wl = [IO.File]::ReadAllText($worklistPath, (New-Object Text.UTF8Encoding($false))) | ConvertFrom-Json
  foreach ($r in $wl.rows) { $targets += [pscustomobject]@{ Id = $r.id; Kind = $r.kind; Surface = $r.surface } }
} else {
  $targets += [pscustomobject]@{ Id = $Id; Kind = $Kind; Surface = $Surface }
}

if (-not $targets.Count) { Write-Output 'nothing to stamp'; exit 0 }

foreach ($t in $targets) {
  $key = "$($t.Id):$($t.Kind):$($t.Surface)"
  $state[$key] = [ordered]@{ at = $stamp; note = $Note }
  Write-Output "stamped $key"
}
Save-State
Write-Output "wrote $statePath ($($state.Count) surfaces tracked)"
