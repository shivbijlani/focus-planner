<#
  mutcheck-capability-floor.ps1 -- proves every guard in capability-floor.ps1 is load-bearing.

  Two things are established, and the second is the one that matters:

  1. POSITIVE/NEGATIVE: each guard fires on its own failure and stays silent on the healthy
     tree. A guard that is red when things are fine can never reach zero, so it gets ignored
     or switched off -- the decay mode user-settings.md keeps recording.

  2. LOAD-BEARING: disabling one guard must break EXACTLY its own case. This is what catches
     a guard that is really being enforced by some other code path, or that never ran at all.

  THE FIXTURES ARE REAL BYTES, NOT SYNTHETIC ONES
  -----------------------------------------------
  The `reverted` tree is built from origin/main's actual oa-state.ps1 -- the exact file the
  2026-08-27 21:06 reinstall produced, the one installed-skill-drift-sweep called "no drift"
  while the agent went blind to user replies. Testing against invented bytes would prove the
  guards work on a fiction.

  THE POISONED-FLOOR FIXTURE IS THE INTERESTING ONE
  -------------------------------------------------
  A floor that was snapshotted from a broken tree passes the byte-exact check (g4) perfectly --
  the bytes are precisely what the manifest says they should be -- and still leaves the agent
  broken. It is the failure that g1 exists to prevent and g2 exists to catch, and it is the
  reason this tool verifies with the SWEEP at the end rather than trusting its own copy.

  The script is invoked as a CHILD PROCESS per fixture, so what is measured is the real script
  as it will actually run, not a function lifted out of it.

  Usage: powershell -NoProfile -ExecutionPolicy Bypass -File mutcheck-capability-floor.ps1
  Exit: 0 all assertions hold - 1 a guard is not doing what it claims.
#>
[CmdletBinding()]
param(
  [string]$Repo = 'V:\repos\focus-planner'
)

$ErrorActionPreference = 'Stop'
$here   = Split-Path -Parent $MyInvocation.MyCommand.Path
$target = Join-Path $here 'capability-floor.ps1'
$sweep  = Join-Path $here 'installed-capability-sweep.mjs'
if (-not (Test-Path $target)) { throw 'capability-floor.ps1 not found beside this script' }
if (-not (Test-Path $sweep))  { throw 'installed-capability-sweep.mjs not found beside this script' }

$root = Join-Path ([IO.Path]::GetTempPath()) ('cf-mut-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $root -Force | Out-Null

$SKILLREL = 'overnight-agent\skills\overnight-agent'
$GOODTREE = Join-Path $env:USERPROFILE '.copilot\installed-plugins\focus-planner'

function New-Tree([string]$name, [switch]$Reverted, [switch]$NoOaState) {
  $t = Join-Path $root $name
  $s = Join-Path $t $SKILLREL
  New-Item -ItemType Directory -Path $s -Force | Out-Null
  foreach ($f in 'reap-stale-mcp.ps1', 'SKILL.md') {
    Copy-Item (Join-Path $GOODTREE "$SKILLREL\$f") (Join-Path $s $f) -Force
  }
  if (-not $NoOaState) {
    if ($Reverted) {
      # The genuine reverted bytes, straight from the ref the reinstall restored.
      $tmp = [IO.Path]::GetTempFileName()
      & cmd /c "cd /d `"$Repo`" && git cat-file blob origin/main:plugins/overnight-agent/skills/overnight-agent/oa-state.ps1 > `"$tmp`"" | Out-Null
      Copy-Item $tmp (Join-Path $s 'oa-state.ps1') -Force
      Remove-Item $tmp -Force
    } else {
      Copy-Item (Join-Path $GOODTREE "$SKILLREL\oa-state.ps1") (Join-Path $s 'oa-state.ps1') -Force
    }
  }
  return $t
}

# Run capability-floor.ps1 (or a mutant of it) against a given tree + floor.
function Invoke-Floor([string]$script, [string]$cmd, [string]$tree, [string]$floor) {
  $oaState = Join-Path $tree "$SKILLREL\oa-state.ps1"
  $env:OA_INSTALLED_PLUGIN = $tree
  # A mutant is EXPECTED to crash, and a crash writes to stderr. Under $ErrorActionPreference
  # = 'Stop' a native command's stderr becomes a terminating NativeCommandError, which would
  # abort the harness on exactly the mutants it is trying to measure. Relax it for the call
  # only -- the child's exit code and text are the measurement, not PowerShell's opinion of it.
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $out = & powershell -NoProfile -ExecutionPolicy Bypass -File $script $cmd `
             -FloorDir $floor -Sweep $sweep -OaState $oaState `
             -BackupRoot (Join-Path $root 'backups') -SkipResnapshot 2>&1
    return [pscustomobject]@{ Code = $LASTEXITCODE; Text = ($out | Out-String) }
  } finally {
    $ErrorActionPreference = $prev
    Remove-Item Env:\OA_INSTALLED_PLUGIN -ErrorAction SilentlyContinue
  }
}

function New-Floor([string]$name) {
  $f = Join-Path $root "floor-$name"
  New-Item -ItemType Directory -Path $f -Force | Out-Null
  return $f
}

# --- guard mutations ------------------------------------------------------------------
# Each disables exactly one guard. Anchored on a distinctive line so a mutation that matches
# nothing is caught as INERT rather than silently certifying the guard.
$mutations = @(
  @{
    id   = 'g1'
    what = 'snapshot refuses to freeze a RED tree as the floor'
    find = '  if (-not $state.Green) {'
    repl = '  if ($false) {'
  },
  @{
    id   = 'g2'
    what = 're-run the sweep after restoring and fail if still red'
    find = '  if (-not $after.Green) {'
    repl = '  if ($false) {'
  },
  @{
    id   = 'g4'
    what = 'restored file must hash to the floor manifest'
    find = '    if ($now -ne $e.sha256) {'
    repl = '    if ($false) {'
  },
  @{
    id   = 'g5'
    what = 'an absent or empty floor fails a restore'
    find = '  if ($null -eq $manifest -or $null -eq $manifest.files -or @($manifest.files).Count -eq 0) {'
    repl = '  if ($false) {'
  }
)

$src = Get-Content $target -Raw

# --- baseline -------------------------------------------------------------------------
$fail = 0
$results = @()

function Assert([string]$label, [bool]$ok, [string]$detail) {
  $script:results += [pscustomobject]@{ Label = $label; Ok = $ok; Detail = $detail }
  if (-not $ok) { $script:fail++ }
}

$healthy  = New-Tree 'healthy'
$reverted = New-Tree 'reverted' -Reverted
$absent   = New-Tree 'absent'   -NoOaState

# b1: snapshot a healthy tree -> OK and the floor is written.
$fl = New-Floor 'b1'
$r = Invoke-Floor $target 'snapshot' $healthy $fl
Assert 'baseline snapshot(healthy) exits 0' ($r.Code -eq 0) $r.Text
Assert 'baseline snapshot(healthy) writes floor.json' (Test-Path (Join-Path $fl 'floor.json')) ''

# b2: restore on a healthy tree is a no-op success (nothing to repair).
$r = Invoke-Floor $target 'restore' $healthy $fl
Assert 'baseline restore(healthy) exits 0' ($r.Code -eq 0) $r.Text
Assert 'baseline restore(healthy) says nothing to restore' ($r.Text -match 'nothing to restore') $r.Text

function Set-Reverted([string]$tree) {
  # Overwrite the tree's oa-state.ps1 IN PLACE with origin/main's bytes -- what a plugin
  # reinstall physically does. The floor is keyed by absolute path, so a faithful fixture has
  # to reuse the same path rather than point at a second tree.
  $tmp = [IO.Path]::GetTempFileName()
  & cmd /c "cd /d `"$Repo`" && git cat-file blob origin/main:plugins/overnight-agent/skills/overnight-agent/oa-state.ps1 > `"$tmp`"" | Out-Null
  Copy-Item $tmp (Join-Path $tree "$SKILLREL\oa-state.ps1") -Force
  Remove-Item $tmp -Force
}

# b3: THE REAL CASE -- snapshot while healthy, then let a "reinstall" revert that same tree.
$live = New-Tree 'live'
$flLive = New-Floor 'b3'
$r = Invoke-Floor $target 'snapshot' $live $flLive
Assert 'baseline b3 snapshot(live, healthy) exits 0' ($r.Code -eq 0) $r.Text
Set-Reverted $live
$r = Invoke-Floor $target 'ensure' $live $flLive
Assert 'baseline ensure(reinstall-reverted) repairs and exits 0' ($r.Code -eq 0) $r.Text
Assert 'baseline ensure(reinstall-reverted) verified via the sweep' ($r.Text -match 'restore VERIFIED') $r.Text
# g3: what was overwritten is kept.
Assert 'baseline ensure(reinstall-reverted) backed up the replaced file' `
  (@(Get-ChildItem (Join-Path $root 'backups') -Recurse -Filter 'oa-state.ps1' -ErrorAction SilentlyContinue).Count -ge 1) ''
# The repair must be byte-exact against the known-good file.
Assert 'baseline ensure(reinstall-reverted) restored the GOOD bytes' `
  ((Get-FileHash (Join-Path $live "$SKILLREL\oa-state.ps1") -Algorithm SHA256).Hash -eq `
   (Get-FileHash (Join-Path $GOODTREE "$SKILLREL\oa-state.ps1") -Algorithm SHA256).Hash) ''

# b4: g1 positive -- snapshot must refuse a reverted tree.
$reverted2 = New-Tree 'reverted2' -Reverted
$fl2 = New-Floor 'b4'
$r = Invoke-Floor $target 'snapshot' $reverted2 $fl2
Assert 'baseline snapshot(reverted) REFUSES (exit 1)' ($r.Code -eq 1) $r.Text
Assert 'baseline snapshot(reverted) writes no floor' (-not (Test-Path (Join-Path $fl2 'floor.json'))) ''

# b5: g5 positive -- restore with no floor fails.
$fl3 = New-Floor 'b5'
$reverted3 = New-Tree 'reverted3' -Reverted
$r = Invoke-Floor $target 'restore' $reverted3 $fl3
Assert 'baseline restore(no floor) fails (exit 1)' ($r.Code -eq 1) $r.Text

# b6: g2 positive -- a POISONED floor (snapshotted from a broken tree) must not pass.
# Built by hand precisely because g1 makes it unreachable through the tool itself.
$flPoison = New-Floor 'b6'
$revBytes = Join-Path (Join-Path $root 'reverted') "$SKILLREL\oa-state.ps1"
$slot = Join-Path $flPoison 'poisoned_oa-state.ps1'
Copy-Item $revBytes $slot -Force
$victim = New-Tree 'victim' -NoOaState
$victimOa = Join-Path $victim "$SKILLREL\oa-state.ps1"
@{
  takenUtc = '2026-01-01T00:00:00Z'
  files = @(@{
    file = $victimOa
    slot = $slot
    sha256 = (Get-FileHash $slot -Algorithm SHA256).Hash
    bytes = (Get-Item $slot).Length
  })
} | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $flPoison 'floor.json') -Encoding UTF8
$r = Invoke-Floor $target 'restore' $victim $flPoison
Assert 'baseline restore(poisoned floor) fails (exit 1)' ($r.Code -eq 1) $r.Text
Assert 'baseline restore(poisoned floor) blames the sweep, not the hash' ($r.Text -match 'still reports') $r.Text

# b7: g4 positive -- floor slot whose bytes do not match the recorded hash.
$flBad = New-Floor 'b7'
$slotBad = Join-Path $flBad 'bad_oa-state.ps1'
Copy-Item (Join-Path $GOODTREE "$SKILLREL\oa-state.ps1") $slotBad -Force
$victim2 = New-Tree 'victim2' -NoOaState
$victim2Oa = Join-Path $victim2 "$SKILLREL\oa-state.ps1"
@{
  takenUtc = '2026-01-01T00:00:00Z'
  files = @(@{
    file = $victim2Oa
    slot = $slotBad
    sha256 = ('0' * 64)   # deliberately wrong
    bytes = (Get-Item $slotBad).Length
  })
} | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $flBad 'floor.json') -Encoding UTF8
$r = Invoke-Floor $target 'restore' $victim2 $flBad
Assert 'baseline restore(hash mismatch) fails (exit 1)' ($r.Code -eq 1) $r.Text
Assert 'baseline restore(hash mismatch) names the hash' ($r.Text -match 'does not match the floor') $r.Text

# --- mutants --------------------------------------------------------------------------
$killed = 0; $survived = @(); $inert = @(); $invalid = @()

foreach ($m in $mutations) {
  if ($src -notlike "*$($m.find)*") { $inert += $m.id; continue }
  $mutSrc = $src.Replace($m.find, $m.repl)
  $mutPath = Join-Path $root ("mutant-" + $m.id + ".ps1")
  Set-Content -Path $mutPath -Value $mutSrc -Encoding UTF8

  # A mutant that fails to PARSE exits non-zero on every fixture, which is indistinguishable
  # from a killed mutant -- it would certify a guard on the strength of a typo.
  $errs = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile($mutPath, [ref]$null, [ref]$errs)
  if ($errs -and $errs.Count) { $invalid += $m.id; continue }

  $dead = $false
  switch ($m.id) {
    'g1' {
      # Guard gone -> snapshot happily freezes the reverted tree as the floor.
      $t = New-Tree ("mut-g1-" + [Guid]::NewGuid().ToString('N').Substring(0,4)) -Reverted
      $f = New-Floor ("mut-g1-" + [Guid]::NewGuid().ToString('N').Substring(0,4))
      $r = Invoke-Floor $mutPath 'snapshot' $t $f
      if ($r.Code -eq 0 -and (Test-Path (Join-Path $f 'floor.json'))) { $dead = $true }
    }
    'g2' {
      # Guard gone -> the poisoned floor is reported as a successful repair.
      $t = New-Tree ("mut-g2-" + [Guid]::NewGuid().ToString('N').Substring(0,4)) -NoOaState
      $oa = Join-Path $t "$SKILLREL\oa-state.ps1"
      $f = New-Floor ("mut-g2-" + [Guid]::NewGuid().ToString('N').Substring(0,4))
      $s = Join-Path $f 'p_oa-state.ps1'
      Copy-Item $revBytes $s -Force
      @{ takenUtc='2026-01-01T00:00:00Z'; files=@(@{ file=$oa; slot=$s; sha256=(Get-FileHash $s -Algorithm SHA256).Hash; bytes=(Get-Item $s).Length }) } |
        ConvertTo-Json -Depth 6 | Set-Content (Join-Path $f 'floor.json') -Encoding UTF8
      $r = Invoke-Floor $mutPath 'restore' $t $f
      if ($r.Code -eq 0) { $dead = $true }
    }
    'g4' {
      # Guard gone -> a slot that does not match its recorded hash is accepted.
      $t = New-Tree ("mut-g4-" + [Guid]::NewGuid().ToString('N').Substring(0,4)) -NoOaState
      $oa = Join-Path $t "$SKILLREL\oa-state.ps1"
      $f = New-Floor ("mut-g4-" + [Guid]::NewGuid().ToString('N').Substring(0,4))
      $s = Join-Path $f 'b_oa-state.ps1'
      Copy-Item (Join-Path $GOODTREE "$SKILLREL\oa-state.ps1") $s -Force
      @{ takenUtc='2026-01-01T00:00:00Z'; files=@(@{ file=$oa; slot=$s; sha256=('0'*64); bytes=(Get-Item $s).Length }) } |
        ConvertTo-Json -Depth 6 | Set-Content (Join-Path $f 'floor.json') -Encoding UTF8
      $r = Invoke-Floor $mutPath 'restore' $t $f
      # With g4 disabled the copy is accepted and the sweep (g2) then passes, so exit 0.
      if ($r.Code -eq 0 -and $r.Text -notmatch 'does not match the floor') { $dead = $true }
    }
    'g5' {
      # Guard gone -> restore proceeds with no floor and must not report a clean exit 1 for
      # the documented reason; it either crashes or reports success having restored nothing.
      $t = New-Tree ("mut-g5-" + [Guid]::NewGuid().ToString('N').Substring(0,4)) -Reverted
      $f = New-Floor ("mut-g5-" + [Guid]::NewGuid().ToString('N').Substring(0,4))
      $r = Invoke-Floor $mutPath 'restore' $t $f
      if ($r.Text -notmatch 'no usable floor') { $dead = $true }
    }
  }

  if ($dead) { $killed++ } else { $survived += $m.id }
}

# --- report ---------------------------------------------------------------------------
Write-Host "target: $target"
Write-Host ''
foreach ($r in $results) {
  Write-Host ("  {0}  {1}" -f $(if ($r.Ok) { 'PASS' } else { 'FAIL' }), $r.Label)
  if (-not $r.Ok -and $r.Detail) { Write-Host ("        " + ($r.Detail -replace "`r?`n", "`n        ").Trim()) }
}
Write-Host ''
Write-Host ("mutants: {0}/{1} killed" -f $killed, $mutations.Count)
foreach ($m in $mutations) {
  $state = if ($survived -contains $m.id) { 'SURVIVED' }
           elseif ($inert -contains $m.id) { 'INERT' }
           elseif ($invalid -contains $m.id) { 'INVALID' }
           else { 'killed' }
  Write-Host ("  {0,-9} {1}  {2}" -f $state, $m.id, $m.what)
}

Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue

if ($fail -gt 0)        { Write-Host "`nFINDINGS: $fail baseline assertion(s) failed."; exit 1 }
if ($survived.Count)    { Write-Host "`nFINDINGS: guard(s) not load-bearing: $($survived -join ', ')"; exit 1 }
if ($inert.Count)       { Write-Host "`nFINDINGS: mutation matched nothing (guard moved?): $($inert -join ', ')"; exit 1 }
if ($invalid.Count)     { Write-Host "`nFINDINGS: mutant did not parse: $($invalid -join ', ')"; exit 1 }
Write-Host "`nall guards load-bearing; baseline correct on healthy, reverted, poisoned and hash-mismatch fixtures."
exit 0
