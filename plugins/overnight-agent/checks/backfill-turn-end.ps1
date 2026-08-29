<#
  backfill-turn-end.ps1 -- close the live turn-end-stamp gap across the journal corpus.

  WHY THIS EXISTS
  ---------------
  `oa-state.ps1` decides "has the user replied since my last turn?" by finding where the
  agent's turn ended. When the agent's turn is the newest thing in the file -- the normal
  shape -- there is no `## ` heading below it, so the boundary falls to EOF and THE WHOLE FILE
  counts as the agent's turn. A reply typed at the bottom with no `## <date>` heading lands
  inside the agent's own turn and is never seen.

  The durable fix is the explicit `<!-- /overnight-agent turn-end -->` stamp that `mark`
  writes. But that only protects a journal AFTER the agent next marks it, and most journals
  are quiet -- they are not marked again for weeks. So the corpus stays exposed indefinitely.

  Measured 2026-08-29 before this script existed: **157 of 238 live journals** were in exactly
  that shape. Every one of them would have silently swallowed the next raw reply. Nothing was
  lost yet (a separate audit found zero unanswered user messages sitting in them), so this is
  a prospective hole, not a past incident -- which is precisely when it is cheap to close.

  WHY IT DRIVES `mark` INSTEAD OF WRITING THE STAMP ITSELF
  -------------------------------------------------------
  `oa-state.ps1 mark -Id <id>` (with no -Status) already does exactly the right thing: it
  stamps the boundary via the append-only `Add-TurnTerminator`, re-snapshots the hash so the
  edit does not read as a change, and preserves status. Writing a second path that edits the
  user's journals would double the surface that can corrupt them -- and journal writes have
  destroyed real content twice before (encoding round-trips, see Read-JournalText). So this
  script decides WHICH journals to touch and delegates the touching.

  SAFETY
  ------
    - Refuses to touch a journal that already has a boundary below the turn, or is already
      stamped. `Add-TurnTerminator` is append-only and enforces this independently.
    - Skips anything that is not `task-<digits>.md`: deliverables (`task-213-paint-plan.md`)
      and OneDrive sync-conflict copies (`task-328-shiv-devbox.md`) are not tasks, and
      marking one would invent state for an id that does not exist.
    - Backs the whole journal folder up first, so the run is reversible in one copy.
    - `-WhatIf` reports the plan and writes nothing.

  Exit codes: 0 = nothing to do or all backfilled; 1 = one or more marks failed.
#>
[CmdletBinding()]
param(
  [string]$JournalDir = (Join-Path $env:OneDrive 'Apps\Focus Planner\journal'),
  [string]$OaState    = (Join-Path $env:LOCALAPPDATA '..\..\.copilot\installed-plugins\focus-planner\overnight-agent\skills\overnight-agent\oa-state.ps1'),
  [string]$BackupRoot = (Join-Path $env:LOCALAPPDATA 'overnight-agent\backups'),
  [switch]$WhatIf
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $JournalDir)) { throw "journal dir not found: $JournalDir" }
$OaState = (Resolve-Path $OaState).Path

# Reuse the shipped boundary logic rather than re-implementing it. A second implementation
# would drift from the one `scan` actually uses, and then this script would confidently
# "fix" the wrong set of files.
$lib = Join-Path $env:TEMP "oa-lib-backfill-$PID.ps1"
$enc = New-Object Text.UTF8Encoding($false)
$src = [IO.File]::ReadAllText($OaState, $enc) -split "`r?`n"
$cut = ($src | Select-String -Pattern '^switch \(\$Command\)' | Select-Object -First 1).LineNumber
if (-not $cut) { throw "could not locate the command dispatch in $OaState" }
[IO.File]::WriteAllText($lib, (($src[0..($cut - 2)]) -join "`r`n"), $enc)
try {
  . $lib -Command get 2>$null
} finally {
  Remove-Item $lib -Force -ErrorAction SilentlyContinue
}

function Test-AlreadyStamped([string]$content) {
  if (-not [regex]::IsMatch($content, $script:TurnEndRe)) { return $false }
  $last = $null
  foreach ($m in [regex]::Matches($content, $script:TurnEndRe)) { $last = $m }
  return ($null -ne $last -and $content.Substring($last.Index).Trim() -eq $script:TurnEndMarker)
}

$blind = @()
foreach ($f in (Get-ChildItem $JournalDir -Filter 'task-*.md')) {
  if ($f.BaseName -notmatch '^task-(\d+)$') { continue }
  $id = $Matches[1]
  $content = Read-JournalText $f.FullName
  if ($null -eq $content -or $content.Length -eq 0) { continue }
  $agentEnd = Get-AgentEndIndex $content
  if ($agentEnd -lt 0) { continue }                # no agent block -- nothing to terminate
  if ($agentEnd -lt $content.Length) { continue }  # a `## ` boundary already sits below the turn
  if (Test-AlreadyStamped $content) { continue }
  $blind += $id
}

Write-Output "[backfill] journal dir = $JournalDir"
Write-Output "[backfill] exposed journals (turn runs to EOF, no stamp) = $($blind.Count)"

if ($blind.Count -eq 0) { Write-Output '[backfill] nothing to do.'; exit 0 }
if ($WhatIf) {
  Write-Output "[backfill] -WhatIf: would mark $($blind.Count) -> $($blind -join ', ')"
  exit 0
}

$stamp  = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = Join-Path $BackupRoot "journal-$stamp"
New-Item -ItemType Directory -Path $backup -Force | Out-Null
Copy-Item (Join-Path $JournalDir '*.md') $backup
Write-Output "[backfill] backup -> $backup ($((Get-ChildItem $backup -Filter '*.md').Count) files)"

$ok = 0; $failed = @()
foreach ($id in $blind) {
  try {
    & powershell -NoProfile -ExecutionPolicy Bypass -File $OaState mark -Id $id *> $null
    if ($LASTEXITCODE -ne 0) { throw "oa-state mark exited $LASTEXITCODE" }
    $ok++
  } catch {
    $failed += "$id ($($_.Exception.Message))"
  }
}

Write-Output "[backfill] marked $ok, failed $($failed.Count)"
foreach ($x in $failed) { Write-Output "  FAILED $x" }
if ($failed.Count) { exit 1 }
exit 0
