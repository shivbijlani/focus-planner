<#
  mutcheck-deploy-ancestry.ps1 -- proves the BRANCH-ONLY split is load-bearing (GH #575).

  WHAT CHANGED AND WHY IT NEEDS ARMS

  `deploy-installed-plugin.ps1` refused every BRANCH-ONLY file with the sentence
  "deploying would REVERT it". On a normal merge that is exactly backwards: the installed
  copy is the PRE-merge content, the ref is newer, and deploying ADVANCES it. The verdict
  is a disjunction -- genuinely ahead, or merely behind -- and ancestry was never asked.

  This change makes the script write files it previously refused, so the arms are about
  the boundary, not the happy path:

    1. BEHIND deploys            a file provably an older commit of the ref advances
    2. AHEAD still refuses       live bytes that are NOT in the ref's history are a
                                 possible hand-deployed fix and must survive
    3. absent helper refuses     an ancestry check that cannot run must not start
                                 overwriting; it falls back to the old behaviour
    4. the message is true       the refusal no longer claims "would REVERT"

  Arm 2 is the one that matters. The old behaviour was wrong but SAFE; the new behaviour
  is right and writes more, so a mistake here destroys a live fix -- the outcome the
  original refusal existed to prevent. Arm 3 matters for the same reason: blind must mean
  refuse, never proceed.

  HERMETIC. A throwaway git repo with a real merged-but-undeleted branch (which is what
  manufactures BRANCH-ONLY in the wild), a fake installed tree, and a stub classifier. The
  REAL deploy script and the REAL ancestry helper are the subjects. No network, no live
  install tree touched.

  Usage: pwsh -File mutcheck-deploy-ancestry.ps1
  Exit 0 = every arm agreed. Exit 1 = the split is not bounded as claimed.
#>
[CmdletBinding()]
param([string]$ScriptPath)

$ErrorActionPreference = 'Stop'
if (-not $ScriptPath) { $ScriptPath = Join-Path $PSScriptRoot 'deploy-installed-plugin.ps1' }
if (-not (Test-Path $ScriptPath)) { throw "deploy-installed-plugin.ps1 not found at $ScriptPath" }
$helper = Join-Path $PSScriptRoot 'ref-history-index.mjs'
if (-not (Test-Path $helper)) { throw "ref-history-index.mjs not found at $helper" }

$script:PsExe = if ($PSVersionTable.PSEdition -eq 'Core') { (Get-Process -Id $PID).Path } else { 'powershell' }
$utf8 = New-Object Text.UTF8Encoding($false)

$root = Join-Path ([IO.Path]::GetTempPath()) ("oa-anc-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $root -Force | Out-Null

$script:pass = 0
$script:fail = 0
function Assert([bool]$ok, [string]$name, [string]$why, [string]$detail = '') {
  if ($ok) { Write-Host "  PASS  $name  -- $why"; $script:pass++ }
  else {
    Write-Host "  FAIL  $name  -- $why" -ForegroundColor Red
    if ($detail) { Write-Host ("        got: " + $detail) -ForegroundColor DarkGray }
    $script:fail++
  }
}

# --- the fixture repo ----------------------------------------------------------------
# Built to reproduce the real mechanism rather than to simulate its output: a feature
# branch is merged into main and NOT deleted, so its pre-merge blob stays reachable from
# a ref that is not main. That is precisely what makes a stale installed file read as
# BRANCH-ONLY (41 of 229 local branches, measured in #575).
$repo = Join-Path $root 'repo'
New-Item -ItemType Directory -Path $repo -Force | Out-Null
$rel = 'overnight-agent/checks/thing.mjs'
$repoPath = "plugins/$rel"
$abs = Join-Path $repo ($repoPath -replace '/', '\')
New-Item -ItemType Directory -Path (Split-Path -Parent $abs) -Force | Out-Null

& git -C $repo init --quiet -b main | Out-Null
& git -C $repo config user.email 'a@b.c' | Out-Null
& git -C $repo config user.name 'mutcheck' | Out-Null

$OLD = "// version one`nexport const x = 1`n"
$NEW = "// version two`nexport const x = 2`n"
[IO.File]::WriteAllText($abs, $OLD, $utf8)
& git -C $repo add -A | Out-Null
& git -C $repo commit --quiet -m 'v1' | Out-Null

& git -C $repo checkout --quiet -b feature | Out-Null
[IO.File]::WriteAllText($abs, $NEW, $utf8)
& git -C $repo add -A | Out-Null
& git -C $repo commit --quiet -m 'v2' | Out-Null
& git -C $repo checkout --quiet main | Out-Null
& git -C $repo merge --quiet --no-ff feature -m 'merge v2' | Out-Null
# The branch survives the merge -- that is the whole point.
$sha = (& git -C $repo rev-parse HEAD).Trim()
& git -C $repo update-ref refs/remotes/origin/main $sha | Out-Null

# --- the fake installed tree ---------------------------------------------------------
$installed = Join-Path $root 'installed'
$instFile = Join-Path $installed ($rel -replace '/', '\')
New-Item -ItemType Directory -Path (Split-Path -Parent $instFile) -Force | Out-Null

# A stub classifier: the real one is a separate, already-guarded component, and driving
# it here would test IT rather than the ancestry split this file is about.
$stub = Join-Path $root 'stub-classifier.mjs'
[IO.File]::WriteAllText($stub, @"
console.log('  BRANCH-ONLY  $rel  [stub]')
"@, $utf8)

function Deploy([string[]]$Extra) {
  # BackupRoot is explicit because $env:LOCALAPPDATA does not exist off Windows, and
  # `Join-Path` with a null root is a binding error -- which made every arm here fail
  # identically on the Linux runner while passing locally. Same host split as #632/#635.
  $argv = @($ScriptPath, '-Repo', $repo, '-Installed', $installed, '-ClassifierPath', $stub,
            '-HistoryHelperPath', $helper, '-BackupRoot', (Join-Path $root 'backups')) + $Extra
  $out = (& $script:PsExe -NoProfile -ExecutionPolicy Bypass -File @argv 2>&1 | Out-String)
  return $out.Trim()
}

Write-Host ''
Write-Host 'BEHIND -- a stale file must deploy, because deploying ADVANCES it'

# Installed bytes are v1: a real older commit of origin/main, still reachable from
# `feature`. The old code called this "a live fix that deploying would REVERT".
[IO.File]::WriteAllText($instFile, $OLD, $utf8)
$b = Deploy @()
Assert ($b -match '(?m)^\s*BEHIND\s') 'BEHIND' 'an older commit of the ref is classified BEHIND, not refused' $b
Assert ($b -notmatch 'would REVERT') 'MESSAGE' 'and the false "deploying would REVERT it" claim is gone' $b

$b2 = Deploy @('-Confirm')
$after = [IO.File]::ReadAllText($instFile, $utf8)
Assert ($after -eq $NEW) 'ADVANCES' 'with -Confirm the stale file is actually advanced to the ref content' $b2

Write-Host ''
Write-Host 'AHEAD -- a possible live fix must still survive'

# Bytes that exist on NO commit of the ref: the hand-deployed-fix case the original
# refusal exists for. This is the arm that must never regress.
$LIVE = "// hand patched on the box, never committed`nexport const x = 99`n"
[IO.File]::WriteAllText($instFile, $LIVE, $utf8)
$a = Deploy @('-Confirm')
$stillThere = [IO.File]::ReadAllText($instFile, $utf8)
Assert ($a -match '(?m)^\s*REFUSE\s') 'AHEAD' 'content not in the ref history is still REFUSED' $a
Assert ($stillThere -eq $LIVE) 'PRESERVED' 'and the live bytes are untouched on disk (the whole point of the guard)' ''
Assert ($a -match 'may be a hand-deployed live fix') 'HONEST' 'the refusal states the narrow claim the evidence supports' $a

Write-Host ''
Write-Host 'BLIND -- an ancestry check that cannot run must refuse, never proceed'

# Same BEHIND fixture as the first arm, but the helper is unreachable. If this deployed,
# the change would be trading a false refusal for a blind overwrite.
[IO.File]::WriteAllText($instFile, $OLD, $utf8)
$missingHelper = Join-Path $root 'no-such-helper.mjs'
$argv = @($ScriptPath, '-Repo', $repo, '-Installed', $installed, '-ClassifierPath', $stub,
          '-HistoryHelperPath', $missingHelper, '-BackupRoot', (Join-Path $root 'backups'), '-Confirm')
$blindOut = (& $script:PsExe -NoProfile -ExecutionPolicy Bypass -File @argv 2>&1 | Out-String).Trim()
$blindAfter = [IO.File]::ReadAllText($instFile, $utf8)
Assert ($blindOut -match '(?m)^\s*REFUSE\s') 'BLIND' 'without the helper the file stays refused (old behaviour)' $blindOut
Assert ($blindAfter -eq $OLD) 'BLIND2' 'and nothing was written while unable to classify' ''

# Pairs with BLIND: the SAME fixture deploys once the helper is available again, so BLIND
# cannot be passing because the fixture was simply never deployable.
$r = Deploy @('-Confirm')
Assert (([IO.File]::ReadAllText($instFile, $utf8)) -eq $NEW) 'BLIND3' 'restoring the helper restores the deploy (BLIND pairs)' $r

Write-Host ''
Write-Host 'FORCE -- the documented override still works'

[IO.File]::WriteAllText($instFile, $LIVE, $utf8)
$f = Deploy @('-Confirm', '-Force')
Assert (([IO.File]::ReadAllText($instFile, $utf8)) -eq $NEW) 'FORCE' '-Force still overrides a genuine AHEAD refusal' $f

Write-Host ''
Write-Host 'ONE OWNER -- -NoAncestry restores the pre-#575 refusal for auto-deploy'

# auto-deploy-plugin.ps1 runs a SECOND phase that rescues the merely-stale files itself
# and reports them as `superseded`. If this script also split them, that pile would be
# empty and the rescue would report nothing while the files had silently deployed a step
# earlier -- the same outcome described wrongly, which is the defect class #575 is about.
# So exactly one component owns the decision, and this arm pins which.
[IO.File]::WriteAllText($instFile, $OLD, $utf8)
$n = Deploy @('-Confirm', '-NoAncestry')
$nAfter = [IO.File]::ReadAllText($instFile, $utf8)
Assert ($n -match '(?m)^\s*REFUSE\s') 'ONEOWNER' '-NoAncestry refuses a BEHIND file, leaving it for the rescue phase' $n
Assert ($nAfter -eq $OLD) 'ONEOWNER2' 'and writes nothing, so the refusal pile reaches that phase intact' ''

Write-Host ''
if ($script:fail -gt 0) {
  Write-Host ("FAILED: {0} arm(s) disagreed, {1} passed. The ancestry split is not bounded as claimed." -f $script:fail, $script:pass) -ForegroundColor Red
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
  exit 1
}
Write-Host ("OK: {0} arms agreed. Behind advances, ahead survives, blind refuses." -f $script:pass) -ForegroundColor Green
Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
exit 0
