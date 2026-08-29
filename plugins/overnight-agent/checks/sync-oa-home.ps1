<#
  sync-oa-home.ps1 - close the loop from "merged" to "running" for the SECOND deploy
  target: the flat OA home at %LOCALAPPDATA%\overnight-agent. (follow-up to GH #196)

  WHY THIS EXISTS
  ---------------
  #196 established that merging does not deploy, and `auto-deploy-plugin.ps1` closed
  that loop for `~\.copilot\installed-plugins\focus-planner`. But that is not the only
  place the running code lives, and it is not the copy most rows actually invoke.

  `user-settings.md` names its operative commands as, verbatim:

      powershell ... -File "%LOCALAPPDATA%\overnight-agent\reap-stale-mcp.ps1"
      powershell ... -File "%LOCALAPPDATA%\overnight-agent\run-sweeps.ps1"
      powershell ... -File "%LOCALAPPDATA%\overnight-agent\auto-deploy-plugin.ps1"

  So the OA home is a real deploy target - and nothing kept it current. Auto-deploy
  wrote to `installed-plugins` and reported "verified-current True" while the copy the
  next run would actually execute stayed months behind.

  THE RECEIPT
  -----------
  Measured 2026-08-29, immediately after `auto-deploy-plugin.ps1` reported a clean tree:

    reap-stale-mcp.ps1            live 40,360 B   main 56,720 B   (-16,360, 300 lines)

  The missing 300 lines were #237's fix, merged the same night as #244: collect a
  wedged `copilot.exe` session host that was never spoken to. That is the exact defect
  behind Shiv's standing complaint - *"we keep having to reap processes, and restart
  the device"* - because a stillborn host is invisible to the process-level reap and a
  restart was the only cure. The fix was merged, deployed to `installed-plugins`, and
  still not running. Syncing the OA home and re-running it collected a stillborn host
  (pid 12112, 54 min, 187 MB) on the first pass, while correctly sparing the live one.

  Six other files were behind by the same mechanism.

  This is the same shape as #196 itself, one level down: DETECT already existed
  (`repo-drift-sweep.mjs` prints `MODIFIED ... repo ahead (undeployed)` every night),
  DEPLOY existed for the other target, and the WIRE between them was missing. A sweep
  that reports a gap forever is not a control.

  SAFETY - IDENTICAL MODEL TO auto-deploy-plugin.ps1
  --------------------------------------------------
  This never passes -Force and never blind-copies main over the live tree. A file is
  written only when the live bytes are provably an OLDER version of the ref - i.e. the
  live content equals the content that path had at some commit reachable from the ref.
  Anything else is REFUSED and surfaced, because a live-only fix must never be reverted
  by a repair tool. That refusal is the whole property; without it this becomes
  `copy main over production`, which reverts live fixes while looking like a repair.

  Classification per file:

    CURRENT      identical to the ref (after newline normalisation) - nothing to do.
    BEHIND       matches a historical blob of that path on the ref - safe, deploy it.
    DIVERGENT    matches no commit on the ref - REFUSE. May be a live fix.
    AMBIGUOUS    basename resolves to 2+ repo paths - REFUSE, cannot decide safely.
    LOCAL-ONLY   no counterpart in the repo - ignored (scratch//harness files live
                 here legitimately; they are repo-drift-sweep's business, not ours).

  WHY NEWLINE NORMALISATION, AND WHY IT IS NOT A LOOPHOLE
  ------------------------------------------------------
  The OA home is written by many different tools; some land CRLF. Comparing raw bytes
  would report every such file as DIVERGENT and refuse forever, which is the failure
  mode that made a plain "differs from a git ref" check useless in `#196`. Both sides
  are normalised to LF with trailing blank lines trimmed *for the comparison only*; the
  bytes written are the ref's, unmodified.

  EXIT CODES (same contract as auto-deploy-plugin.ps1)
    0  clean - nothing to do, or everything deployed and re-verified current
    1  hard failure - a write failed, or git could not be queried
    2  needs attention - a refusal has persisted across cycles, or drift survived

  Usage:
    sync-oa-home.ps1                 # fetch, deploy the safe class, verify
    sync-oa-home.ps1 -WhatIf         # report only; writes nothing, no state change
    sync-oa-home.ps1 -Json           # machine-readable summary on stdout
#>
[CmdletBinding()]
param(
  [switch]$WhatIf,
  [switch]$Json,
  [string]$Ref = 'origin/main',
  [string]$Repo = 'V:\repos\focus-planner',
  [string]$OaHome = "$env:LOCALAPPDATA\overnight-agent",
  [string]$RepoPrefix = 'plugins/overnight-agent',
  [int]$EscalateAfterCycles = 2,
  [string]$StatePath = "$env:LOCALAPPDATA\overnight-agent\sync-oa-home-state.json",
  [switch]$SkipFetch,
  [switch]$SkipBackup
)

$ErrorActionPreference = 'Stop'

# Subdirectories of the OA home that are data, not code. Never walked.
$SkipDirs = @('sweep-runs', 'state', 'node_modules', 'telegram-bridge', 'backups',
              'logs', 'secrets', 'runs', 'tmp')

function Write-Line { param([string]$m) if (-not $Json) { Write-Host $m } }

function Get-NormalizedText {
  param([string]$Path)
  # Explicit UTF-8 decode. A bare Get-Content -Raw is host-dependent (PS 5.1 decodes
  # as the ANSI codepage) and that asymmetry has destroyed journal text before.
  $t = [IO.File]::ReadAllText($Path, (New-Object Text.UTF8Encoding($false)))
  return ($t -replace "`r`n", "`n").TrimEnd("`n")
}

function Get-NormalizedTextFromBytes {
  param([byte[]]$Bytes)
  $t = [Text.Encoding]::UTF8.GetString($Bytes)
  return ($t -replace "`r`n", "`n").TrimEnd("`n")
}

function Get-Sha256 {
  param([string]$Text)
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    $h = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text))
    return (($h | ForEach-Object { $_.ToString('x2') }) -join '')
  } finally { $sha.Dispose() }
}

function Invoke-Git {
  param([string[]]$GitArgs, [switch]$AllowFail)
  $out = & git -C $Repo @GitArgs 2>&1
  if ($LASTEXITCODE -ne 0 -and -not $AllowFail) {
    throw "git $($GitArgs -join ' ') failed: $out"
  }
  return $out
}

# --- preconditions ------------------------------------------------------------------
if (-not (Test-Path $Repo))   { Write-Error "repo not found: $Repo";      exit 1 }
if (-not (Test-Path $OaHome)) { Write-Error "OA home not found: $OaHome"; exit 1 }

Write-Line "[sync-oa-home] ref     = $Ref"
Write-Line "[sync-oa-home] repo    = $Repo"
Write-Line "[sync-oa-home] oa home = $OaHome"

# 1. FETCH FIRST. origin/main is a local cache; deploying it unfetched ships whatever
#    main looked like the last time somebody fetched. Same stale-artefact class as a
#    stale CI tick. auto-deploy-plugin.ps1 does this for the same reason.
if (-not $SkipFetch) {
  try { Invoke-Git @('fetch', '--quiet', 'origin') | Out-Null }
  catch { Write-Line "[sync-oa-home] WARNING: fetch failed, using cached $Ref - $_" }
}

try { $refSha = (Invoke-Git @('rev-parse', $Ref)).Trim() }
catch { Write-Error "cannot resolve ref '$Ref': $_"; exit 1 }
Write-Line "[sync-oa-home] $Ref = $($refSha.Substring(0,12))"

# --- index the ref's files under the prefix, by basename ----------------------------
$tracked = Invoke-Git @('ls-tree', '-r', '--name-only', $refSha, "$RepoPrefix/")
$byName = @{}
foreach ($p in $tracked) {
  $p = "$p".Trim()
  if (-not $p) { continue }
  if ($p -notmatch '\.(ps1|mjs|js)$') { continue }
  $n = Split-Path $p -Leaf
  if (-not $byName.ContainsKey($n)) { $byName[$n] = @() }
  $byName[$n] += $p
}

# --- collect live OA-home scripts (top level only; subdirs are data or vendored) -----
$live = Get-ChildItem -Path (Join-Path $OaHome '*') -File |
        Where-Object { $_.Extension -in '.ps1', '.mjs', '.js' } |
        Sort-Object Name

$results = @()
foreach ($f in $live) {
  $name = $f.Name
  if (-not $byName.ContainsKey($name)) {
    $results += [pscustomobject]@{ file = $name; class = 'LOCAL-ONLY'; repoPath = $null; matchCommit = $null }
    continue
  }
  $paths = $byName[$name]
  if ($paths.Count -gt 1) {
    # Two repo files share a basename; a flat home cannot say which one this is.
    # Refusing is the only safe answer - guessing could overwrite with the wrong file.
    $results += [pscustomobject]@{ file = $name; class = 'AMBIGUOUS'; repoPath = ($paths -join ' | '); matchCommit = $null }
    continue
  }

  $repoPath = $paths[0]
  $liveNorm = Get-NormalizedText $f.FullName
  $liveHash = Get-Sha256 $liveNorm

  $headRaw = & git -C $Repo show "${refSha}:$repoPath" 2>$null | Out-String
  $headNorm = ($headRaw -replace "`r`n", "`n").TrimEnd("`n")
  $headHash = Get-Sha256 $headNorm

  if ($liveHash -eq $headHash) {
    $results += [pscustomobject]@{ file = $name; class = 'CURRENT'; repoPath = $repoPath; matchCommit = $refSha }
    continue
  }

  # BEHIND vs DIVERGENT. Walk the commits that touched this path on the ref and
  # compare blob-by-blob. If the live bytes are any historical version, the ref
  # supersedes them and deploying is safe. If they match none, this content was
  # never on the ref - it may be a live fix, so refuse.
  $match = $null
  $commits = Invoke-Git @('rev-list', $refSha, '--', $repoPath) -AllowFail
  foreach ($c in $commits) {
    $c = "$c".Trim()
    if (-not $c) { continue }
    # --verify --quiet, NOT a bare rev-parse: on a commit where this path does not exist
    # (any commit before it was added, or after it was deleted) a bare rev-parse writes
    # "fatal: path ... exists on disk, but not in <sha>" to stderr, and Windows
    # PowerShell 5.1 turns native stderr into a TERMINATING error under
    # $ErrorActionPreference='Stop'. `2>$null` does not suppress that on 5.1 - only on
    # pwsh 7 - so this aborts the whole sync on the host it actually runs on. Same defect
    # and same fix as auto-deploy-plugin.ps1's Test-IsSupersededByRef; it took the live
    # deploy down on 2026-08-29 the first time a merge deleted a file.
    $blob = & git -C $Repo rev-parse --verify --quiet "${c}:$repoPath" 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $blob) { continue }
    $blob = "$blob".Trim()
    $txt = & git -C $Repo cat-file blob $blob 2>$null | Out-String
    if ((Get-Sha256 (($txt -replace "`r`n", "`n").TrimEnd("`n"))) -eq $liveHash) { $match = $c; break }
  }

  if ($match) {
    $results += [pscustomobject]@{ file = $name; class = 'BEHIND'; repoPath = $repoPath; matchCommit = $match }
  } else {
    $results += [pscustomobject]@{ file = $name; class = 'DIVERGENT'; repoPath = $repoPath; matchCommit = $null }
  }
}

$behind    = @($results | Where-Object { $_.class -eq 'BEHIND' })
$divergent = @($results | Where-Object { $_.class -eq 'DIVERGENT' })
$ambiguous = @($results | Where-Object { $_.class -eq 'AMBIGUOUS' })
$current   = @($results | Where-Object { $_.class -eq 'CURRENT' })
$localOnly = @($results | Where-Object { $_.class -eq 'LOCAL-ONLY' })

Write-Line ""
foreach ($r in $behind)    { Write-Line ("  BEHIND     {0}   (live == {1})" -f $r.file, $r.matchCommit.Substring(0,8)) }
foreach ($r in $divergent) { Write-Line ("  REFUSE     {0}   live content is on no commit of {1} - may be a live fix" -f $r.file, $Ref) }
foreach ($r in $ambiguous) { Write-Line ("  REFUSE     {0}   basename is ambiguous: {1}" -f $r.file, $r.repoPath) }
Write-Line ""
Write-Line ("[sync-oa-home] {0} behind, {1} current, {2} refused, {3} local-only." -f `
            $behind.Count, $current.Count, ($divergent.Count + $ambiguous.Count), $localOnly.Count)

# --- deploy the safe class ----------------------------------------------------------
$deployed = 0
$failed   = 0
$backupDir = $null

if ($behind.Count -gt 0 -and -not $WhatIf) {
  if (-not $SkipBackup) {
    $backupDir = Join-Path $OaHome ("backups\oahome-sync-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
    New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
  }
  foreach ($r in $behind) {
    $dst = Join-Path $OaHome $r.file
    try {
      if ($backupDir) { Copy-Item $dst (Join-Path $backupDir $r.file) -Force }
      $src = Join-Path $Repo ($r.repoPath -replace '/', '\')
      if (-not (Test-Path $src)) {
        # The ref may be ahead of the working tree; take the bytes from the ref itself.
        $tmp = [IO.Path]::GetTempFileName()
        & cmd /c "git -C `"$Repo`" show ${refSha}:$($r.repoPath) > `"$tmp`"" | Out-Null
        Copy-Item $tmp $dst -Force
        Remove-Item $tmp -Force
      } else {
        Copy-Item $src $dst -Force
      }
      $deployed++
      Write-Line ("  WROTE      {0}" -f $r.file)
    } catch {
      $failed++
      Write-Line ("  FAILED     {0}   {1}" -f $r.file, $_)
    }
  }
  if ($backupDir) { Write-Line "[sync-oa-home] backups: $backupDir" }
}

# --- 3. VERIFY AT THE FAR END -------------------------------------------------------
# Report what is TRUE, not what the deployer DID. Those are different claims and only
# the second one is evidence. auto-deploy-plugin.ps1 exists partly because a refusal
# used to be indistinguishable from a clean run.
$residual = 0
if (-not $WhatIf) {
  foreach ($r in $behind) {
    $dst = Join-Path $OaHome $r.file
    if (-not (Test-Path $dst)) { $residual++; continue }
    $headRaw = & git -C $Repo show "${refSha}:$($r.repoPath)" 2>$null | Out-String
    $headNorm = ($headRaw -replace "`r`n", "`n").TrimEnd("`n")
    if ((Get-Sha256 (Get-NormalizedText $dst)) -ne (Get-Sha256 $headNorm)) { $residual++ }
  }
}

# --- 2. ESCALATE A PERSISTENT REFUSAL ------------------------------------------------
# One refusal is information. The same refusal next cycle is a decision nobody is
# making, so it becomes an ask instead of a log line.
#
# Only DIVERGENT escalates. An AMBIGUOUS basename is a structural naming collision, not
# a pending decision - it cannot resolve itself, so escalating it every cycle would pin
# the exit code at 2 forever and train the reader to ignore a code that is supposed to
# mean "a human is needed". That is the alarm-fatigue failure #196 hit from the other
# direction, where an ordinary stale file could never deploy and escalated forever.
# Ambiguity is still reported on every run, it just does not cry wolf.
$escalate = @()
if (-not $WhatIf) {
  $state = @{}
  if (Test-Path $StatePath) {
    try { (Get-Content $StatePath -Raw | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $state[$_.Name] = [int]$_.Value } } catch { $state = @{} }
  }
  $newState = @{}
  foreach ($r in $divergent) {
    $n = 1
    if ($state.ContainsKey($r.file)) { $n = [int]$state[$r.file] + 1 }
    $newState[$r.file] = $n
    if ($n -ge $EscalateAfterCycles) { $escalate += "$($r.file) (refused $n cycles)" }
  }
  try {
    $dir = Split-Path $StatePath -Parent
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    ($newState | ConvertTo-Json -Compress) | Set-Content -LiteralPath $StatePath -Encoding utf8
  } catch { Write-Line "[sync-oa-home] WARNING: could not persist state - $_" }
}

$exit = 0
if ($failed -gt 0)                          { $exit = 1 }
elseif ($residual -gt 0 -or $escalate.Count) { $exit = 2 }

Write-Line ""
Write-Line ("[sync-oa-home] deployed {0}, refused {1}, residual drift {2}, verified-current {3}" -f `
            $deployed, ($divergent.Count + $ambiguous.Count), $residual, ($residual -eq 0))
foreach ($e in $escalate) { Write-Line "[sync-oa-home] NEEDS A HUMAN: $e" }

if ($Json) {
  [pscustomobject]@{
    ref              = $Ref
    refSha           = $refSha
    oaHome           = $OaHome
    behind           = $behind.Count
    current          = $current.Count
    refused          = ($divergent.Count + $ambiguous.Count)
    localOnly        = $localOnly.Count
    deployed         = $deployed
    failed           = $failed
    residualDrift    = $residual
    verifiedCurrent  = ($residual -eq 0)
    escalate         = $escalate
    whatIf           = [bool]$WhatIf
    files            = $results
  } | ConvertTo-Json -Depth 5
}

exit $exit
