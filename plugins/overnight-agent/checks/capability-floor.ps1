<#
  capability-floor.ps1 -- keep a known-good copy of every guarded file, and put it back
  automatically when a plugin reinstall reverts it.

  WHY THIS EXISTS (measured 2026-08-28)
  -------------------------------------
  The plugin reinstalled itself at 2026-08-27 21:06 (focus-planner/overnight-agent v1.3.1).
  That overwrote the hand-deployed oa-state.ps1 with origin/main's copy -- no UTF-8 decoder,
  no `resnapshot` -- because the fix is still in the OPEN PR #198. Measured harm on the very
  next scan: 207 of 239 journals flipped to `changed`, and `reopened` read 0 while 16 tasks
  had trailing user content. The agent was structurally blind to user replies for a full run.

  installed-capability-sweep.mjs now DETECTS that. This script is the other half -- the thing
  that actually puts the bytes back. Without it the documented recovery is a three-step manual
  procedure (copy from a worktree, resnapshot, re-verify) that an UNATTENDED overnight run has
  to remember to perform correctly at 3 AM with nobody watching. That is the step that never
  happens; it is the same gap deploy-installed-plugin.ps1 was written to close in the forward
  direction, and the same reason run-sweeps.ps1 and run-telegram-mirror.ps1 exist as wrappers.

  WHY A FILE VAULT AND NOT A GIT REF
  ----------------------------------
  Restoring "from the branch that has the fix" requires naming a ref, and naming a ref is
  exactly what makes installed-skill-drift-sweep blind here: after a revert the installed bytes
  MATCH origin/main, so provenance looks perfect while capability is broken. A ref-named
  restore also dies the moment the worktree is pruned or the branch is renamed. The floor is a
  content vault keyed by nothing but the file's own path, so it stays correct through merges,
  renames, rebases and pruned worktrees. Same principle as the sweep's g1: assert capability,
  never provenance.

  THE SELF-MAINTAINING PROPERTY
  -----------------------------
  `ensure` refreshes the floor on every GREEN run and restores from it on a RED one. So a
  legitimate forward improvement to a guarded file is adopted as the new floor on the next run,
  and only a genuine REGRESSION is ever rolled back. The floor cannot go stale while the tree
  is healthy, and restore is never a no-op that silently reverts good work -- it runs only when
  the capability sweep is already red.

  GUARDS (each must be load-bearing; see mutcheck-capability-floor.ps1)
    g1 never snapshot a RED tree. Freezing a regression as the floor would turn the safety net
       into the delivery mechanism for the very failure it guards -- every later `restore` would
       faithfully reinstall the bug, and the sweep would stay red with a tool reporting success.
       This is the single most important property in the file.
    g2 verify AFTER restoring, by re-running the sweep. A restore that silently did not work is
       worse than no restore, because the run then proceeds believing it is healthy -- the
       "verify the artefact at the far end, not the return code" lesson.
    g3 back up before overwriting. The reverted file is evidence and is the negative fixture the
       mutation check needs; overwriting it without a copy destroys both.
    g4 byte-exact restore. Confirm the written file hashes to the floor's recorded hash. A
       partial or failed copy must fail loudly rather than count as a repair.
    g5 an absent or empty floor must FAIL a restore, never silently "restore nothing" and exit
       0. Same decay mode as the sweep's own g3: a check that degrades to asserting nothing
       while still reporting success.

  Usage:
    capability-floor.ps1 status      # what the floor holds vs what is installed
    capability-floor.ps1 snapshot    # refresh the floor (refuses on a red tree)
    capability-floor.ps1 restore     # put the floor back (refuses on a green tree)
    capability-floor.ps1 ensure      # green -> snapshot, red -> restore + resnapshot + verify

  Exit codes: 0 = healthy (or repaired and verified). 1 = a problem a human must look at.
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet('status', 'snapshot', 'restore', 'ensure')]
  [string]$Command = 'status',

  [string]$FloorDir = (Join-Path $env:LOCALAPPDATA 'overnight-agent\capability-floor'),
  [string]$Sweep    = (Join-Path $env:LOCALAPPDATA 'overnight-agent\installed-capability-sweep.mjs'),
  [string]$OaState  = (Join-Path $env:USERPROFILE '.copilot\installed-plugins\focus-planner\overnight-agent\skills\overnight-agent\oa-state.ps1'),
  [string]$BackupRoot = (Join-Path $env:LOCALAPPDATA 'overnight-agent\backups'),
  [switch]$SkipResnapshot
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $Sweep)) { throw "capability sweep not found: $Sweep" }

$ManifestPath = Join-Path $FloorDir 'floor.json'

# --- delegate the guarded-file list to the sweep; never keep a second copy ------------------
# A hand-maintained list here would drift from the sweep's manifest the moment a capability is
# added, and it would drift SILENTLY -- restoring a stale set while reporting success.
function Get-SweepState {
  $raw = & node $Sweep --json 2>&1
  $code = $LASTEXITCODE
  $text = ($raw | Out-String)
  try {
    $json = $text | ConvertFrom-Json
  } catch {
    throw "capability sweep did not return JSON (exit $code). Output:`n$text"
  }
  [pscustomobject]@{
    Green        = ($json.findings -eq 0)
    Findings     = [int]$json.findings
    Count        = [int]$json.count
    Capabilities = $json.capabilities
  }
}

# Distinct files behind the capability rows (several capabilities share oa-state.ps1).
function Get-GuardedFiles($state) {
  $state.Capabilities | Select-Object -ExpandProperty file -Unique
}

function Get-FloorSlot([string]$file) {
  # Key by a flattened absolute path so two guarded files can never collide in the vault.
  $safe = ($file -replace '^[A-Za-z]:', '' ) -replace '[\\/]', '_'
  Join-Path $FloorDir ($safe.TrimStart('_'))
}

function Read-Manifest {
  if (-not (Test-Path $ManifestPath)) { return $null }
  try { return (Get-Content $ManifestPath -Raw | ConvertFrom-Json) } catch { return $null }
}

function Write-Manifest($entries) {
  if (-not (Test-Path $FloorDir)) { New-Item -ItemType Directory -Force -Path $FloorDir | Out-Null }
  $doc = [pscustomobject]@{
    takenUtc = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    files    = $entries
  }
  # Write UTF-8 with NO BOM. `Set-Content -Encoding UTF8` prepends a BOM under
  # Windows PowerShell 5.1 -- which is what `powershell.exe` resolves to, and what
  # run-sweeps.ps1 invokes this script with -- and Node's JSON.parse REJECTS a
  # leading BOM while PowerShell's ConvertFrom-Json silently strips it. So the
  # manifest parsed green in every check written here and was unreadable to the
  # strict parser. GH #212 (same defect, first found in fix-playwright-npx-slots.ps1).
  #
  # The old comment here read "ASCII-safe: these are paths and hex hashes, never
  # journal prose" -- that reasoning is what hid the bug. The BOM is prepended by
  # the ENCODER regardless of how ASCII the content is; it is a property of the
  # write, not of the payload.
  $json = $doc | ConvertTo-Json -Depth 6
  [IO.File]::WriteAllText($ManifestPath, $json, (New-Object Text.UTF8Encoding($false)))
}

function Invoke-Snapshot {
  $state = Get-SweepState

  # g1: never freeze a regression as the floor.
  if (-not $state.Green) {
    Write-Host "[floor] REFUSING to snapshot: the capability sweep reports $($state.Findings) finding(s)."
    Write-Host "[floor] Snapshotting now would make the regression the thing every later restore puts back."
    return 1
  }

  $entries = @()
  foreach ($file in Get-GuardedFiles $state) {
    if (-not (Test-Path $file)) {
      # A green sweep cannot have a missing guarded file (its g2 makes that a finding), so this
      # is an internal inconsistency, not a routine case.
      Write-Host "[floor] REFUSING: sweep is green but guarded file is absent: $file"
      return 1
    }
    $slot = Get-FloorSlot $file
    $parent = Split-Path $slot -Parent
    if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    Copy-Item $file $slot -Force
    $entries += [pscustomobject]@{
      file = $file
      slot = $slot
      sha256 = (Get-FileHash $file -Algorithm SHA256).Hash
      bytes = (Get-Item $file).Length
    }
  }

  Write-Manifest $entries
  Write-Host "[floor] snapshot OK - $($entries.Count) guarded file(s) recorded from a green tree."
  foreach ($e in $entries) { Write-Host ("           {0}  {1} bytes" -f (Split-Path $e.file -Leaf), $e.bytes) }
  return 0
}

function Invoke-Restore {
  $state = Get-SweepState

  if ($state.Green) {
    Write-Host '[floor] nothing to restore: the capability sweep is green.'
    return 0
  }

  Write-Host "[floor] capability sweep reports $($state.Findings) finding(s) - attempting restore."

  $manifest = Read-Manifest
  # g5: an absent/empty floor must fail, never "restore nothing" and report success.
  if ($null -eq $manifest -or $null -eq $manifest.files -or @($manifest.files).Count -eq 0) {
    Write-Host '[floor] FAILED: no usable floor to restore from (never snapshotted, or the manifest is empty).'
    Write-Host "[floor] Expected manifest: $ManifestPath"
    return 1
  }

  $stamp = (Get-Date -Format 'yyyyMMdd-HHmmss')
  $backupDir = Join-Path $BackupRoot "capability-restore-$stamp"
  $restored = 0
  $touchedOaState = $false

  foreach ($e in @($manifest.files)) {
    if (-not (Test-Path $e.slot)) {
      Write-Host "[floor] FAILED: floor slot missing for $($e.file)"
      return 1
    }

    $liveHash = if (Test-Path $e.file) { (Get-FileHash $e.file -Algorithm SHA256).Hash } else { '' }
    if ($liveHash -eq $e.sha256) { continue }   # already matches the floor

    # g3: keep what we are about to overwrite. It is evidence, and the mutation check uses the
    # reverted file as its negative fixture.
    if (-not (Test-Path $backupDir)) { New-Item -ItemType Directory -Force -Path $backupDir | Out-Null }
    if (Test-Path $e.file) { Copy-Item $e.file (Join-Path $backupDir (Split-Path $e.file -Leaf)) -Force }

    $parent = Split-Path $e.file -Parent
    if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    Copy-Item $e.slot $e.file -Force

    # g4: byte-exact or it did not happen.
    $now = (Get-FileHash $e.file -Algorithm SHA256).Hash
    if ($now -ne $e.sha256) {
      Write-Host "[floor] FAILED: restored $($e.file) but its hash does not match the floor."
      Write-Host "[floor]         want $($e.sha256)"
      Write-Host "[floor]         got  $now"
      return 1
    }

    Write-Host ("[floor] restored {0}" -f $e.file)
    $restored++
    if ($e.file -eq $OaState) { $touchedOaState = $true }
  }

  if ($restored -eq 0) {
    # The sweep is red but every guarded file already matches the floor, so the floor itself is
    # not the remedy. Say so plainly instead of exiting 0 on an unrepaired tree.
    Write-Host '[floor] FAILED: sweep is red but every guarded file already matches the floor.'
    Write-Host '[floor]         The floor cannot repair this - a human needs to look.'
    return 1
  }

  Write-Host "[floor] backups: $backupDir"

  # A decoder/hash change invalidates every stored journal snapshot, so re-baseline. resnapshot
  # deliberately skips any journal with trailing user content, so an unanswered reply is never
  # baselined away.
  if ($touchedOaState -and -not $SkipResnapshot) {
    if (Test-Path $OaState) {
      Write-Host '[floor] oa-state.ps1 changed - running resnapshot to re-baseline journal hashes.'
      $out = & powershell -NoProfile -ExecutionPolicy Bypass -File $OaState resnapshot 2>&1
      Write-Host (($out | Out-String).TrimEnd())
    }
  }

  # g2: verify at the far end. "Copied the file" and "the agent can do the job" are different
  # claims, and only the second one matters.
  $after = Get-SweepState
  if (-not $after.Green) {
    Write-Host "[floor] FAILED: restore completed but the sweep still reports $($after.Findings) finding(s)."
    return 1
  }

  Write-Host "[floor] restore VERIFIED - $($restored) file(s) put back, sweep is green."
  return 0
}

function Invoke-Status {
  $state = Get-SweepState
  $manifest = Read-Manifest

  Write-Host "[floor] vault      : $FloorDir"
  Write-Host "[floor] sweep      : $(if ($state.Green) { 'GREEN' } else { "RED ($($state.Findings) finding(s))" })"
  if ($null -eq $manifest) {
    Write-Host '[floor] floor      : EMPTY - never snapshotted. A restore would fail (g5).'
    return 1
  }
  Write-Host "[floor] floor taken: $($manifest.takenUtc)"
  foreach ($e in @($manifest.files)) {
    $live = if (Test-Path $e.file) { (Get-FileHash $e.file -Algorithm SHA256).Hash } else { 'ABSENT' }
    $verdict = if ($live -eq $e.sha256) { 'MATCHES' } elseif ($live -eq 'ABSENT') { 'ABSENT ' } else { 'DRIFTED' }
    Write-Host ("           {0}  {1}" -f $verdict, $e.file)
  }
  return 0
}

switch ($Command) {
  'status'   { exit (Invoke-Status) }
  'snapshot' { exit (Invoke-Snapshot) }
  'restore'  { exit (Invoke-Restore) }
  'ensure'   {
    $state = Get-SweepState
    if ($state.Green) { exit (Invoke-Snapshot) } else { exit (Invoke-Restore) }
  }
}
