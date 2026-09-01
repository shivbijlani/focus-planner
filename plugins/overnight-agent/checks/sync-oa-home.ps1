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
    MISSING      required by the roster (below) and on the ref, but NOT on the machine
                 at all - deploy it. See THE FORWARD DIRECTION.

  THE FORWARD DIRECTION - WHY A NEW FILE USED TO BE INVISIBLE (GH #254)
  ---------------------------------------------------------------------
  Everything above classifies files by enumerating the LIVE OA home. A file that
  exists on the ref and NOT on the machine is therefore never enumerated, never
  classified and never deployed. It is invisible by construction: no BEHIND, no
  refusal, no count - and the run still prints `verified-current True`, because every
  file it looked at was fine. Every number is correct and the conclusion is wrong.

  That is #196's own failure ("merged does not mean running") one step earlier in the
  pipeline, and it bites hardest on the class this repo keeps adding. `run-sweeps.ps1`
  executes from the flat OA home, so a newly merged sweep does not run until something
  copies it there - and that "something" was a human remembering.

  MEASURED 2026-08-29: `postmortem-reviewer.mjs` was merged to main, registered in the
  sweep roster, and absent from the machine. `run-sweeps.ps1` reported it `? MISSING`
  on every run - a guard that had never executed once - while this script reported
  `0 behind, 145 current, 0 refused` and `verified-current True`.

  WHICH REPO FILES BELONG IN THE FLAT HOME (the rule, in one place)
  ----------------------------------------------------------------
  `plugins/overnight-agent/` holds ~163 deployable files; the home holds a subset. So
  "just also walk the repo" is wrong in the other direction - it would push one-off
  harnesses and per-question diagnostic tools onto the machine as if they were standing
  checks. The required set is therefore derived, not globbed:

    1. ROSTER    - the `$Suite` literal in run-sweeps.ps1, READ FROM THE REF. That is
                   already the single source of truth for "these are the standing
                   checks", it is reviewed on the way in, and reading it from the ref
                   (not from disk) means a newly merged sweep counts even when the
                   local run-sweeps.ps1 is itself still behind.
    2. CLOSURE   - the transitive relative-import graph of each rostered .mjs. This is
                   NOT belt-and-braces: postmortem-reviewer.mjs imports
                   ./lib-postmortem.mjs, which no roster would ever name because it is
                   not a sweep. Deploying the entry point alone yields a file that
                   crashes on its first import - a MISSING that turns into a CRASH.
    3. ENTRY     - $AlwaysRequired below: the scripts user-settings.md invokes by
                   absolute path out of the flat home. They are normally present (so
                   the live walk covers them), but naming them makes the rule explicit
                   rather than a side effect of what happens to be on disk.
    4. MUTCHECKS - every `mutcheck-*.ps1|.mjs` on the ref. This is not belt-and-braces
                   either: `run-sweeps.ps1 -IncludeMutchecks` DISCOVERS mutation checks
                   by globbing THIS FLAT HOME, not the repo. So the runner can only ever
                   run the ones that happen to be here, and nothing put them here - they
                   are named by no roster (they are found by glob, by design) and reached
                   by no import edge (they are entry points). A merged guard therefore
                   arrived only when a human remembered to copy it.

                   MEASURED 2026-08-30, immediately after this rule was written: 47
                   mutation checks on main, 36 on the machine - 11 that had never run
                   once, including `mutcheck-consent-authorship.ps1` (the #227 gate that
                   SKILL.md calls "a guard, not a guideline") and
                   `mutcheck-write-turn-sentinel.ps1`, merged EARLIER THE SAME DAY as
                   PR #264. This is exactly #254's forward direction one category over:
                   #254 closed the hole for rostered sweeps and left it open for the
                   files the runner globs, which is the larger half.
    5. SUBJECTS  - the sibling script each required `mutcheck-*.ps1` resolves against
                   $PSScriptRoot (`Join-Path $PSScriptRoot 'oa-state.ps1'`). Rule 4 makes
                   the GUARD arrive; nothing made the thing it TESTS arrive with it, and a
                   guard whose subject is absent does not skip - it dies with exit 1.

                   This is rule 2 (CLOSURE) one language over. Closure walks relative
                   `import` specifiers, which only exist in .mjs; a PowerShell mutcheck
                   names its subject in a runtime Join-Path, so no import edge reaches it,
                   no roster names it (it is not a sweep), and $AlwaysRequired does not
                   list it. It was therefore required by nothing - the identical shape
                   rule 4 was written to close, arriving from the other side.

                   MEASURED 2026-08-30 19:20 PT, minutes after rule 4's own fix deployed:
                   48 mutation checks in the flat home, 5 of them dead on arrival -
                   mutcheck-blocked-recheck, -managed-heading, -priority-order and
                   -turn-terminator all need `oa-state.ps1`, and `mutcheck-sync-oa-home`
                   needs `sync-oa-home.ps1`. Neither subject was in the home. So THIS
                   tool's own guard could not execute here, and `mutcheck-priority-order`
                   - merged, deployed and verified the same hour - failed the first time
                   the runner globbed it. Rule 4 guaranteed delivery of the guards and
                   thereby created a new population of guards that cannot run.

    6. DATA      - the sibling DATA file a required .mjs reads at run time, e.g.
                   `join(HERE, 'read-path-manifest.json')`. Rule 5 one language over: a
                   `join(HERE, ...)` is not an `import` specifier, so the closure walk in
                   rule 2 cannot see it, and the target is not code, so no roster, entry
                   list or glob names it either. It was required by nothing.

                   A data file is NEVER overwritten -- it may be locally mutated state.
                   But it IS now reported when the live copy differs from the ref
                   (DATA-STALE), because "never overwrite" and "never mention" are
                   different promises and only the first one is safe.

                   MEASURED 2026-09-01, minutes after #336 merged and this tool printed
                   "0 behind, 186 current, verified-current True": the live
                   read-path-manifest.json was byte-identical to ad5e1d6, the commit
                   that first DELIVERED it, five commits earlier. Rule 6 hands a data
                   file over once and then freezes it forever. So #336's new
                   idPattern/strayPattern never arrived, the freshly-deployed code that
                   reads them found nothing to read, and the sweep silently reverted to
                   the behaviour the PR had just fixed -- while every check reported
                   success. #196's failure in its most deceptive form: not "the fix did
                   not deploy" but "the fix deployed and its configuration did not",
                   which no code-level comparison can see.

                   And, exactly as in rule 5, the failure is not a skip. `readFileSync`
                   throws ENOENT, so the sweep exits 1 having measured nothing - a RED
                   guard over a healthy subject, which reads as "the check is broken"
                   rather than "the check never arrived".

                   MEASURED 2026-08-31 18:59 PT, hours after `read-path-budget-sweep`
                   was merged and deployed by this very tool: it crashed on its first
                   and every subsequent run with
                   `ENOENT ... open '...\overnight-agent\read-path-manifest.json'`,
                   0 bytes of stdout, 728 of stderr. The sweep was current, the roster
                   named it, the deploy reported `verified-current True` - and the two
                   JSON files it cannot start without had never been copied. The one
                   comparable data file already in the home (lost-interpolation-
                   baseline.json) was there by hand, required by nothing, one `rm` from
                   the same fate.

  Anything else in the repo stays out, and any file already live keeps its existing
  classification - so legitimately local-only files and deliberately excluded
  diagnostics generate no new noise.

  WHY DEPLOYING A MISSING FILE CANNOT REVERT A LIVE FIX
  ----------------------------------------------------
  The refusal above exists because overwriting live bytes can destroy a fix that
  exists only on the machine. A MISSING file has no live bytes: there is nothing to
  overwrite and nothing to lose, so writing it is safe under the very same model. The
  one case that is still refused is an ambiguous basename - if two repo paths share a
  name, a flat home cannot say which one was meant, exactly as for a live file.

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
  [string]$RosterPath = 'plugins/overnight-agent/checks/run-sweeps.ps1',
  [switch]$NoForward,
  [switch]$SkipFetch,
  [switch]$SkipBackup
)

$ErrorActionPreference = 'Stop'

# ENTRY (rule 3 above): the scripts user-settings.md invokes by absolute path OUT OF THE
# FLAT HOME. Naming them makes "belongs in the home" explicit instead of inferring it
# from whatever happens to be on disk - so a wiped or fresh home is still restorable.
#
# ⚠️ This list is deliberately SHORT, and the discipline matters more than the entries.
# #254 warns that over-deploying is the failure on the other side, and the first draft of
# this list proved it: it also named `oa-state.ps1` and `sync-oa-home.ps1`, and the dry
# run duly reported both as MISSING. Neither belongs here. SKILL.md invokes oa-state.ps1
# as `<skill>\oa-state.ps1` out of installed-plugins, and auto-deploy resolves
# sync-oa-home.ps1 via $PSScriptRoot/repo/installed. The only thing that looked like
# evidence for oa-state.ps1 was a `.bak` file sitting in the home - an artefact, not an
# invocation. Adding them would have deployed two files nothing runs from here.
#
# Rule for editing this list: add a name only when user-settings.md (or another operative
# doc) invokes `%LOCALAPPDATA%\overnight-agent\<name>` as a COMMAND. Not because the file
# happens to be present, and not because it seems related.
$AlwaysRequired = @(
  'run-sweeps.ps1',
  'write-turn.ps1',
  'reap-stale-mcp.ps1',
  'auto-deploy-plugin.ps1',
  'deploy-installed-plugin.ps1',
  'check-browser-slots.ps1',
  # The health-aware watchdog (#197). SKILL.md invokes it as
  # `<oa-home>\browser-watchdog.ps1`, which is exactly the contract this list
  # exists to serve. It also REPLACES a script that lived in OneDrive, outside
  # this repo -- so it had no CI, no tests, and no deploy step, and a fix to it
  # could never be verified as running. Omitting this line would recreate that
  # hole with a newer file (#196, #254).
  'browser-watchdog.ps1',
  # The one entry here that is a LIBRARY rather than a command, and the reason it
  # earns a place: check-browser-slots.ps1 (above) dot-sources it, so a home that
  # has the command but not this file has a command that cannot run. The rule is
  # "restorable from a wiped home", and a listed command with a missing dependency
  # is not restorable. Added with #180, which moved the slot table into
  # user-settings.md and gave it a single reader.
  'browser-slot-table.ps1',
  # The #226 supervisor and its daemon are dispatched by the OS (a Windows scheduled task
  # or the Startup-folder shim) as `%LOCALAPPDATA%\overnight-agent\<name>` - the same
  # absolute-path-from-the-flat-home contract as the entries above. They are named by no
  # roster (not sweeps), reached by no import edge (.ps1), and the installer only SEEDS
  # them when absent - so without this line a merged supervisor fix lands in
  # installed-plugins and never reaches the copy the daemon actually runs. Classic
  # "merged isn't running" (cf. #196, #254).
  'oa-supervisor.ps1',
  'oa-supervisor-daemon.ps1'
)

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

function Get-RefText {
  # Read a path's content at the ref. Returns $null when the path is absent there.
  # --verify --quiet first: on a path that does not exist at that commit a bare
  # `git show` writes to stderr, and Windows PowerShell 5.1 turns native stderr into a
  # TERMINATING error under $ErrorActionPreference='Stop'. `2>$null` does NOT suppress
  # that on 5.1 (only on pwsh 7), which is exactly how the first-ever deletion took the
  # live deploy down on 2026-08-29. Probing first keeps that path unreachable.
  param([string]$Sha, [string]$RepoRelPath)
  $blob = & git -C $Repo rev-parse --verify --quiet "${Sha}:$RepoRelPath" 2>$null
  if ($LASTEXITCODE -ne 0 -or -not $blob) { return $null }
  return (& git -C $Repo cat-file blob ("$blob".Trim()) 2>$null | Out-String)
}

function Get-RosterNames {
  <# ROSTER (rule 1): parse the `$Suite = @( ... )` literal out of run-sweeps.ps1 AS IT
     EXISTS ON THE REF, and return the filenames it implies.

     Read from the ref rather than from disk on purpose: the roster is itself one of the
     files this script deploys, so reading the local copy would mean a newly merged sweep
     stays invisible until the run AFTER run-sweeps.ps1 catches up - a one-cycle blind
     spot in the exact tool meant to remove blind spots.

     Parsing rather than executing: run-sweeps.ps1 does real work at load (preflight,
     env, filesystem globs). Dot-sourcing it to read one array would run all of that.
     The literal is a stable, reviewed shape - `@{ n = '<name>'; ... }`, ext defaulting
     to .mjs exactly as the runner defaults it. #>
  param([string]$Sha)

  $text = Get-RefText $Sha $RosterPath
  if (-not $text) { return @() }

  $start = $text.IndexOf('$Suite = @(')
  if ($start -lt 0) { return @() }
  $segment = $text.Substring($start)

  $names = @()
  foreach ($m in [regex]::Matches($segment, "@\{\s*n\s*=\s*'([^']+)'(?<rest>[^}]*)\}")) {
    $ext = '.mjs'
    if ($m.Groups['rest'].Value -match "ext\s*=\s*'([^']+)'") { $ext = $Matches[1] }
    $names += ($m.Groups[1].Value + $ext)
  }
  return $names
}

function Get-RelativeImports {
  # CLOSURE (rule 2): relative import/require specifiers of one JS/MJS source. Static
  # text scan - these are ES modules with static imports, and a dependency that only
  # appears in a computed string is not something a deploy tool should guess at.
  param([string]$Text)
  if (-not $Text) { return @() }
  $out = @()
  foreach ($m in [regex]::Matches($Text, "(?:from\s*|import\s*\(\s*|require\s*\(\s*)['""](\.[^'""]+)['""]")) {
    $out += $m.Groups[1].Value
  }
  return $out
}

function Get-PsScriptRootRefs {
  # SUBJECTS (rule 5): the sibling scripts a PowerShell mutation check resolves against
  # $PSScriptRoot, e.g. `Join-Path $PSScriptRoot 'oa-state.ps1'`. This is the .ps1
  # analogue of Get-RelativeImports: same job (find the files this entry point cannot run
  # without), different language, and the reason rule 2 could never see it.
  #
  # Literal operand only, matching Get-RelativeImports' own stance that a dependency
  # appearing solely in a computed string is not something a deploy tool should guess at.
  param([string]$Text)
  if (-not $Text) { return @() }
  $out = @()
  foreach ($m in [regex]::Matches($Text, 'Join-Path\s+\$PSScriptRoot\s+([''"])([^''"]+)\1')) {
    $leaf = Split-Path $m.Groups[2].Value -Leaf
    if ($leaf -match '\.(ps1|mjs|js)$') { $out += $leaf }
  }
  return ($out | Sort-Object -Unique)
}

function Get-HereDataRefs {
  # DATA (rule 6): the sibling files a JS/MJS check resolves against its own directory at
  # run time, e.g. `join(HERE, 'read-path-manifest.json')`. This is Get-PsScriptRootRefs'
  # counterpart for the .mjs half of the suite, and it exists for the same reason: the
  # reference is a runtime path join, not an `import` specifier, so rule 2's closure walk
  # is structurally unable to see it, and a data file is named by no roster and matched by
  # no glob. A sweep deployed without it does not degrade - it throws ENOENT and exits 1.
  #
  # Literal operand only, matching the stance of both functions above: a path assembled at
  # run time is not something a deploy tool should guess at. An extension is required, so
  # a directory join (`join(HERE, 'sweep-runs')`) is not mistaken for a file.
  param([string]$Text)
  if (-not $Text) { return @() }
  $out = @()
  $re = '(?:^|[^\w.$])(?:path\.)?join\(\s*(?:HERE|__dirname)\s*,\s*([''"])([^''"]+)\1\s*\)'
  foreach ($m in [regex]::Matches($Text, $re)) {
    $leaf = Split-Path $m.Groups[2].Value -Leaf
    if ($leaf -match '\.[A-Za-z0-9]{1,5}$') { $out += $leaf }
  }
  return ($out | Sort-Object -Unique)
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
$dataByName = @{}
foreach ($p in $tracked) {
  $p = "$p".Trim()
  if (-not $p) { continue }
  $n = Split-Path $p -Leaf
  if ($p -notmatch '\.(ps1|mjs|js)$') {
    # DATA (rule 6): non-code files are indexed SEPARATELY and are only ever handled in
    # the MISSING direction below. They are deliberately kept out of $byName so they can
    # never be classified BEHIND or DIVERGENT -- a data file in the home may be locally
    # mutated state, and this tool must never overwrite that on a name match.
    if (-not $dataByName.ContainsKey($n)) { $dataByName[$n] = @() }
    $dataByName[$n] += $p
    continue
  }
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

# --- THE FORWARD DIRECTION: repo files that BELONG here but are absent (GH #254) -----
# Everything above enumerated the machine, so a merged-but-never-copied file could not
# appear in any bucket. Resolve the required set from the roster + import closure +
# entry points (see the header), then report anything required, present on the ref, and
# missing from disk. Deploying it cannot revert a live fix: there are no live bytes.
$missing         = @()
$missingRefused  = @()
$dataStale       = @()
$requiredCount   = 0

if (-not $NoForward) {
  $required = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  foreach ($n in (Get-RosterNames $refSha)) { [void]$required.Add($n) }
  foreach ($n in $AlwaysRequired)           { [void]$required.Add($n) }

  # MUTCHECKS (rule 4): `run-sweeps.ps1 -IncludeMutchecks` finds mutation checks by
  # globbing the flat home, so a guard that is not HERE cannot run, no matter that it is
  # merged, registered in a comment, or green in CI. They are named by no roster (found by
  # glob, deliberately) and reached by no import edge (they are entry points), so before
  # this they were required by nothing and arrived only if a human copied them.
  # Matching the runner's own discovery semantics -- `mutcheck-*` with either extension --
  # keeps the two in step, which is the property that failed here: the runner's rule and
  # the deployer's rule disagreed, and the disagreement was silent in the safe-looking
  # direction ("all clean" over a suite it could not see).
  foreach ($n in $byName.Keys) {
    if ($n -match '^mutcheck-.*\.(ps1|mjs)$') { [void]$required.Add($n) }
  }

  # SUBJECTS (rule 5): a `mutcheck-*.ps1` names the script it tests in a runtime
  # `Join-Path $PSScriptRoot '<subject>'`, which is an edge no other rule can see -- the
  # closure below walks `import` specifiers and those exist only in .mjs. Rule 4 therefore
  # delivers the guard while leaving its subject behind, and the failure is not a skip: the
  # guard throws and exits 1 the first time the runner globs it. Measured 2026-08-30, five
  # of the 48 guards in the home were dead this way, including this tool's own.
  #
  # Deliberately narrow: only `Join-Path $PSScriptRoot '<literal>'` counts. A computed path
  # is not resolved, because guessing one would deploy a file on a hunch -- and the whole
  # point of a derived required-set is that every entry has a reason.
  foreach ($n in @($required)) {
    if ($n -notmatch '^mutcheck-.*\.ps1$') { continue }
    if (-not $byName.ContainsKey($n)) { continue }
    $paths = $byName[$n]
    if ($paths.Count -ne 1) { continue }   # ambiguous: refused below, do not read a guess
    foreach ($dep in (Get-PsScriptRootRefs (Get-RefText $refSha $paths[0]))) {
      if ($dep -match '^mutcheck-') { continue }   # already covered by rule 4
      [void]$required.Add($dep)
    }
  }

  # Transitive closure over relative imports. A queue rather than recursion so a cyclic
  # import graph terminates instead of blowing the stack.
  $queue = New-Object 'System.Collections.Generic.Queue[string]'
  foreach ($n in $required) { if ($n -match '\.(mjs|js)$') { $queue.Enqueue($n) } }
  $walked = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  while ($queue.Count -gt 0) {
    $n = $queue.Dequeue()
    if (-not $walked.Add($n)) { continue }
    if (-not $byName.ContainsKey($n)) { continue }
    $paths = $byName[$n]
    if ($paths.Count -ne 1) { continue }   # ambiguous: refused below, do not walk a guess
    $src = Get-RefText $refSha $paths[0]
    foreach ($spec in (Get-RelativeImports $src)) {
      $dep = Split-Path $spec -Leaf
      if (-not $dep) { continue }
      [void]$required.Add($dep)
      if ($dep -match '\.(mjs|js)$') { $queue.Enqueue($dep) }
    }
    # DATA (rule 6): sibling files this module reads via `join(HERE, '<literal>')`. Walked
    # here, inside the closure, so a data file reached through an imported library counts
    # too -- the module that reads it is not always the one the roster names.
    foreach ($dep in (Get-HereDataRefs $src)) {
      [void]$required.Add($dep)
      if ($dep -match '\.(mjs|js)$') { $queue.Enqueue($dep) }
    }
  }

  $requiredCount = $required.Count
  $liveNames = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  foreach ($f in $live) { [void]$liveNames.Add($f.Name) }

  foreach ($n in ($required | Sort-Object)) {
    if ($liveNames.Contains($n)) { continue }        # already classified by the live walk
    if (-not $byName.ContainsKey($n)) {
      # DATA (rule 6): a required NON-code file, e.g. the manifest a sweep reads on its
      # first line. NEVER overwritten -- a data file in the home may be locally mutated
      # state, and a name match is not a licence to destroy it. But "never overwrite" and
      # "never mention" are different promises, and only the first one is safe.
      #
      # MEASURED 2026-09-01, minutes after #336 merged and this tool reported
      # "0 behind, 186 current, verified-current True": the live
      # read-path-manifest.json was byte-identical to ad5e1d6 -- the commit that first
      # DELIVERED it, five commits earlier. Rule 6 hands a data file over once and then
      # freezes it forever, so #336's `idPattern`/`strayPattern` never arrived and the
      # code that reads them ran inert, silently reverting to the old behaviour. The
      # sweep's own guard shipped, deployed, verified -- and did nothing.
      #
      # That is #196's failure in its most deceptive form: not "the fix did not deploy"
      # but "the fix deployed and its configuration did not", which no code-level check
      # can see. So a present-but-stale data file is now REPORTED and counted as a
      # refusal. It is still never written; a human decides, because only a human can
      # tell locally-mutated state from a stale copy.
      if ($dataByName.ContainsKey($n)) {
        $dPaths = $dataByName[$n]
        $dst = Join-Path $OaHome $n
        if (-not (Test-Path -LiteralPath $dst)) {
          if ($dPaths.Count -gt 1) {
            $missingRefused += [pscustomobject]@{ file = $n; class = 'MISSING-AMBIGUOUS'; repoPath = ($dPaths -join ' | '); matchCommit = $null }
          }
          else {
            $missing += [pscustomobject]@{ file = $n; class = 'MISSING'; repoPath = $dPaths[0]; matchCommit = $refSha }
          }
        }
        elseif ($dPaths.Count -eq 1) {
          $refRaw = Get-RefText $refSha $dPaths[0]
          if ($null -ne $refRaw) {
            $refNorm = ($refRaw -replace "`r`n", "`n").TrimEnd("`n")
            if ((Get-Sha256 (Get-NormalizedText $dst)) -ne (Get-Sha256 $refNorm)) {
              $dataStale += [pscustomobject]@{ file = $n; class = 'DATA-STALE'; repoPath = $dPaths[0]; matchCommit = $null }
            }
          }
        }
      }
      continue                                       # required but not on the ref: not ours to invent
    }
    $paths = $byName[$n]
    if ($paths.Count -gt 1) {
      # Same reasoning as AMBIGUOUS above: a flat home cannot say which path was meant.
      $missingRefused += [pscustomobject]@{ file = $n; class = 'MISSING-AMBIGUOUS'; repoPath = ($paths -join ' | '); matchCommit = $null }
      continue
    }
    $missing += [pscustomobject]@{ file = $n; class = 'MISSING'; repoPath = $paths[0]; matchCommit = $refSha }
  }
  $results += $missing
  $results += $missingRefused
  $results += $dataStale
}

$behind    = @($results | Where-Object { $_.class -eq 'BEHIND' })
$divergent = @($results | Where-Object { $_.class -eq 'DIVERGENT' })
$ambiguous = @($results | Where-Object { $_.class -eq 'AMBIGUOUS' })
$current   = @($results | Where-Object { $_.class -eq 'CURRENT' })
$localOnly = @($results | Where-Object { $_.class -eq 'LOCAL-ONLY' })

Write-Line ""
foreach ($r in $behind)         { Write-Line ("  BEHIND     {0}   (live == {1})" -f $r.file, $r.matchCommit.Substring(0,8)) }
foreach ($r in $missing)        { Write-Line ("  MISSING    {0}   required by the roster, absent from this machine" -f $r.file) }
foreach ($r in $divergent)      { Write-Line ("  REFUSE     {0}   live content is on no commit of {1} - may be a live fix" -f $r.file, $Ref) }
foreach ($r in $ambiguous)      { Write-Line ("  REFUSE     {0}   basename is ambiguous: {1}" -f $r.file, $r.repoPath) }
foreach ($r in $missingRefused) { Write-Line ("  REFUSE     {0}   required but basename is ambiguous: {1}" -f $r.file, $r.repoPath) }
foreach ($r in $dataStale)      { Write-Line ("  DATA-STALE {0}   live data file differs from {1} - NOT overwritten; a human must reconcile it" -f $r.file, $Ref) }
Write-Line ""
Write-Line ("[sync-oa-home] {0} behind, {1} missing, {2} current, {3} refused, {4} local-only. ({5} required)" -f `
            $behind.Count, $missing.Count, $current.Count,
            ($divergent.Count + $ambiguous.Count + $missingRefused.Count + $dataStale.Count), $localOnly.Count, $requiredCount)

# --- deploy the safe class ----------------------------------------------------------
# BEHIND (live bytes provably older) and MISSING (no live bytes at all) are both safe to
# write; DIVERGENT and either flavour of ambiguity are not, and never reach here.
$toWrite = @($behind) + @($missing)
$deployed = 0
$failed   = 0
$backupDir = $null

if ($toWrite.Count -gt 0 -and -not $WhatIf) {
  if (-not $SkipBackup -and $behind.Count -gt 0) {
    $backupDir = Join-Path $OaHome ("backups\oahome-sync-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
    New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
  }
  foreach ($r in $toWrite) {
    $dst = Join-Path $OaHome $r.file
    try {
      # Only an existing file needs backing up; a MISSING one has nothing to preserve.
      if ($backupDir -and (Test-Path $dst)) { Copy-Item $dst (Join-Path $backupDir $r.file) -Force }

      # ALWAYS take the bytes from the REF. Never from the working tree.
      #
      # This used to prefer `$Repo\<repoPath>` and fall back to the ref only when that path was
      # ABSENT -- i.e. it handled "the ref is ahead because a file is new" and missed "the ref is
      # ahead because a file CHANGED", which is the ordinary state of a checkout that nobody has
      # pulled. Every classification above is computed against the ref (Get-RefText), so reading
      # the checkout here was not a different SOURCE, it was a different ANSWER: the script
      # decided using the ref and then wrote something else.
      #
      # The two agree until the moment they matter. Measured live on 2026-09-01, seconds after a
      # merge: local `main` sat at 65e4f16 while `origin/main` was e956de3, so the just-merged
      # oa-state.ps1 was copied from the STALE checkout, `WROTE oa-state.ps1` was printed, and the
      # OA home file remained byte-identical to the old commit. Nothing pulls in this pipeline, so
      # that is not an unlucky window -- it is the default right after every merge, and the
      # oahome-sync backup folders show it repeating across 2026-08-30, 08-31 and 09-01.
      #
      # The residual-drift re-classification did report it honestly every time ("verified-current
      # False"), which is the only reason it was visible at all -- but nothing ever cleared it,
      # because each run re-did the identical stale copy.
      $tmp = [IO.Path]::GetTempFileName()
      try {
        & cmd /c "git -C `"$Repo`" show ${refSha}:$($r.repoPath) > `"$tmp`"" | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "git show ${refSha}:$($r.repoPath) failed (exit $LASTEXITCODE)" }
        Copy-Item $tmp $dst -Force
      }
      finally { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }

      # VERIFY, then report. The old line announced WROTE on the strength of Copy-Item not
      # throwing, and a copy of the wrong bytes does not throw -- which is how a stale deploy
      # reported success for three days. A write that cannot be confirmed is a FAILED write.
      $wroteNorm = Get-NormalizedText $dst
      $refNorm = ("$(Get-RefText $refSha $r.repoPath)" -replace "`r`n", "`n").TrimEnd("`n")
      if ((Get-Sha256 $wroteNorm) -ne (Get-Sha256 $refNorm)) {
        throw "post-write verify failed: $($r.file) does not match $Ref after writing"
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
#
# This walks $toWrite, so `verified-current` now covers the forward direction too. Before
# #254 it could only ever answer "is every file I LOOKED AT current?", and a merged file
# that never reached the machine was not looked at - which is how this line read True
# while a rostered guard had never executed once.
$residual = 0
if (-not $WhatIf) {
  foreach ($r in $toWrite) {
    $dst = Join-Path $OaHome $r.file
    if (-not (Test-Path $dst)) { $residual++; continue }
    $headRaw = Get-RefText $refSha $r.repoPath
    if ($null -eq $headRaw) { $residual++; continue }
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
elseif ($residual -gt 0 -or $escalate.Count -or $dataStale.Count) { $exit = 2 }

# Under -WhatIf nothing was written, so `residual` cannot speak. Pending work still means
# the tree is NOT current, and saying otherwise is the precise false claim #254 is about:
# `verified-current True` printed over a rostered guard that had never run. The exit code
# is deliberately left alone - -WhatIf is a report, not a verdict.
$pending = if ($WhatIf) { $toWrite.Count } else { 0 }
# A stale data file is never written, so `residual` (which only walks $toWrite) is
# structurally unable to see it. Without this term the line would keep printing True over
# exactly the drift that made #336's guard inert -- the same false claim, one file class
# over.
$verifiedCurrent = ($residual -eq 0 -and $pending -eq 0 -and $dataStale.Count -eq 0)

Write-Line ""
Write-Line ("[sync-oa-home] deployed {0}, refused {1}, residual drift {2}, verified-current {3}" -f `
            $deployed, ($divergent.Count + $ambiguous.Count + $missingRefused.Count + $dataStale.Count), $residual, $verifiedCurrent)
foreach ($r in $dataStale) { Write-Line "[sync-oa-home] NEEDS A HUMAN: $($r.file) is a required data file whose live copy differs from $Ref. It was NOT overwritten (it may be local state). Reconcile it by hand, then re-run." }
foreach ($e in $escalate) { Write-Line "[sync-oa-home] NEEDS A HUMAN: $e" }

if ($Json) {
  [pscustomobject]@{
    ref              = $Ref
    refSha           = $refSha
    oaHome           = $OaHome
    behind           = $behind.Count
    missing          = $missing.Count
    required         = $requiredCount
    current          = $current.Count
    refused          = ($divergent.Count + $ambiguous.Count + $missingRefused.Count + $dataStale.Count)
    dataStale        = $dataStale.Count
    localOnly        = $localOnly.Count
    deployed         = $deployed
    failed           = $failed
    residualDrift    = $residual
    pending          = $pending
    verifiedCurrent  = $verifiedCurrent
    escalate         = $escalate
    whatIf           = [bool]$WhatIf
    files            = $results
  } | ConvertTo-Json -Depth 5
}

exit $exit
