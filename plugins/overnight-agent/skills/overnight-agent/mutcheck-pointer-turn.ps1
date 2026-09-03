<#
  mutcheck-pointer-turn.ps1 -- mutation check for #425: once a task has a catch-up doc, a
  journal turn becomes a POINTER to it rather than a second copy of the story.

  This is the journal half of #424. Both are armed by the same trigger -- #423's
  `<!-- doc-meta ... -->` stamp -- and both are opt-in PER TASK for the same reason: a
  silent global change to how every turn is written is discovered by its damage.

  Everything here is behavioural. It runs the REAL write-turn.ps1 as a child process
  against synthetic journals in a temp dir, the REAL oa-state.ps1 with isolated
  -JournalDir/-StateDir, and the REAL journal.js/digest.js under node. It never reads or
  writes the live planner folder. It cannot be fooled by source text that merely mentions
  the fix.

  ARMS, and the distinct mutant each one kills:

    A  short pointer passes EVERY guard   (kills: a ceiling so tight it refuses the shape
                                           the issue asks for. This is acceptance 1)
    B  5,305-char narrative REFUSED (G9)  (kills: no ceiling -- the feature absent. 5,305 is
                                           the measured mean agent turn on task 468)
    C  same narrative on a DOC-LESS task
       is ACCEPTED                        (kills: a silent global change. The opt-in is the
                                           whole safety story of this issue)
    D  turn that never names the doc
       REFUSED (G10)                      (kills: A POINTER THAT DOES NOT POINT -- the
                                           narrative has left the journal and nothing in the
                                           journal leads to it. It reads perfectly, which is
                                           why only a machine catches it)
    E  a doc-meta inside a FENCE does not
       win over the real binding          (kills: a fence-blind binding read. #320's rule.
                                           The very turn that documents this feature quotes
                                           the stamp format, and if that quotation wins, the
                                           turn is measured against the wrong document)
    F  turn with the ask stripped
       REFUSED (G11)                      (kills: the ask MOVED into the doc rather than
                                           duplicated -- 148 open asks, 17 shown, 131
                                           unnamed, already on record in user-settings.md)
    G  the digest can still READ the ask
       out of the shortened turn          (kills: a turn shape the Telegram approval digest
                                           cannot parse. This is acceptance 2, proven by
                                           running the real digest, not by argument)
    H  scan says NOT reopened, then
       REOPENED after a reply underneath  (kills: a pointer shape that breaks the boundary
                                           reader. This is acceptance 3. BOTH halves are
                                           required -- an arm that only asserts `reopened`
                                           is true would pass against a reader that is
                                           stuck on true)
    I  the LIVE 901-char pointer turn
       passes                             (kills: a ceiling tuned to the issue's ~800 target
                                           rather than to reality. The first real pointer
                                           turn -- task 468, 2026-09-03 -- is 901 chars,
                                           ~250 of them structure that cannot be shortened)

  D, F and C are the three that matter. Every other arm asserts that the feature works; those
  three assert the three ways a plausible "just write less" implementation is WORSE than doing
  nothing -- detail unreachable, ask invisible, and every task silently changed at once.

  ARMS G AND H PASS AGAINST THE PRE-FIX SCRIPT, AND THAT IS THE POINT. They are the two
  acceptance criteria a shortening change silently breaks, so they are written as REGRESSION
  arms: the pointer shape must not cost the digest its ask or the boundary reader its reopen.
  Each carries its own negative control -- G re-runs the same digest over an ask-stripped body
  and requires null, H requires `reopened` to be FALSE before the reply and TRUE after -- so
  neither can pass against a component that is stuck answering one way.

  Measured against `origin/main`'s write-turn.ps1 (`-Target <pre-fix copy>`): 6 of the 7 guard
  arms fail, G and H pass. Post-fix: 12/12, with all five mutants isolated.

  THE MUTATION MATRIX runs all seven guard arms under each mutant and asserts the set of
  newly-failing arms is EXACTLY the expected one. An arm that fails under two mutants is not
  isolating anything; an arm that fails under none is not load-bearing. Two mutants use the
  script's own `-DisableGuard` hook; two are generated source mutants, because the fence mask
  and the opt-in have no hook and are the two behaviours most likely to be quietly wrong.

  Usage: pwsh -File mutcheck-pointer-turn.ps1 [-Target <write-turn.ps1>] [-Oa <oa-state.ps1>]
  Exit:  0 all arms hold and every mutant is killed by exactly one arm - 1 otherwise.
#>
[CmdletBinding()]
param(
  [string]$Target,
  [string]$Oa
)

$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path

# Resolve by SEARCH, not by "beside me" alone (#251) -- a copy of this script in the flat OA
# home would otherwise throw and be skipped by whichever sweep invoked it, and a guard that is
# absent looks identical to a guard that is passing.
#
# Forward slashes throughout: this runs on the Linux CI runner as well as the laptop, and a
# `..\..` literal is not a path separator there -- it is part of the filename. That is the
# same "runs green where the drift cannot happen" trap the browser-slot table fell into.
function Resolve-First([string[]]$candidates, [string]$what) {
  foreach ($c in $candidates) { if ($c -and (Test-Path $c)) { return (Resolve-Path $c).Path } }
  throw ("$what not found. Tried:`n  " + (($candidates | Where-Object { $_ }) -join "`n  "))
}

$oaHome = if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'overnight-agent' } else { $null }

$Target = Resolve-First @(
  $Target,
  (Join-Path $here 'write-turn.ps1'),
  (Join-Path $here '../../skills/overnight-agent/write-turn.ps1'),
  $(if ($oaHome) { Join-Path $oaHome 'write-turn.ps1' })
) 'write-turn.ps1'

$Oa = Resolve-First @(
  $Oa,
  (Join-Path $here 'oa-state.ps1'),
  (Join-Path $here '../../skills/overnight-agent/oa-state.ps1'),
  $(if ($oaHome) { Join-Path $oaHome 'oa-state.ps1' })
) 'oa-state.ps1'

# The bridge sources are the acceptance-2 surface. Resolved from the repo, because the point of
# arm G is to run the SHIPPING digest rather than a restatement of it.
$repo = Resolve-Path (Join-Path $here '../../../..')
$journalJs = Join-Path $repo 'packages/telegram-bridge/src/journal.js'
$digestJs = Join-Path $repo 'packages/telegram-bridge/src/digest.js'

Write-Host "target:  $Target"
Write-Host "oa:      $Oa"

# Launch the host that actually exists. The other guards in this folder assume Windows
# PowerShell because they are run by hand on the one laptop -- which is exactly the property
# CI exists to remove.
$PsExe = if ($PSVersionTable.PSEdition -eq 'Core') { (Get-Process -Id $PID).Path } else { 'powershell' }
if (-not $PsExe) { $PsExe = 'pwsh' }

$MOON = [char]::ConvertFromUtf32(0x1F319)
$DOC = 'DOC425aaaaBBBBccccDDDDeeeeFFFFgggg1234'
$DOCURL = "https://docs.google.com/document/d/$DOC/edit"
$utf8 = New-Object Text.UTF8Encoding($false)

$root = Join-Path ([IO.Path]::GetTempPath()) ("oa425-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
$jdir = Join-Path $root 'journal'
$sdir = Join-Path $root 'state'
New-Item -ItemType Directory -Path $jdir -Force | Out-Null
New-Item -ItemType Directory -Path $sdir -Force | Out-Null
$board = Join-Path $root 'planner.md'
$store = Join-Path $root 'snooze.json'

# write-turn.ps1 backs a journal up under %LOCALAPPDATA% before appending, and arms G/H perform
# a REAL write. Point that at the temp root for the duration: the check must not deposit
# backups in the user's profile, and on the Linux runner LOCALAPPDATA is not set at all.
$env:LOCALAPPDATA = $root
New-Item -ItemType Directory -Path (Join-Path $root 'overnight-agent') -Force | Out-Null

# --- journal fixtures ----------------------------------------------------------------
# Single-quoted here-strings throughout: this file is a mutation check FOR the guards that
# catch PowerShell interpolation damage, so it must not be a source of it.
$JournalBound = @'
# Task {ID}: synthetic
<!-- tg-meta chatId=-100123 threadId=7 -->
<!-- doc-meta docId={DOC} docUrl={DOCURL} -->

The user's own notes.

---
<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->

## Overnight Agent

<!-- from: overnight-agent -->

**Status:** In-progress - 2026-09-03

**Needs from you:** nothing blocking

<!-- /overnight-agent turn-end -->
'@

# The same journal with NO binding. Arm C's control: the ONLY difference is the stamp.
$JournalUnbound = $JournalBound -replace '(?m)^<!-- doc-meta.*$\r?\n', ''

# A journal whose FIRST doc-meta sits inside a fenced example -- the shape a turn documenting
# this feature necessarily has -- with the REAL binding below it.
#
# THIS FIXTURE WAS RETARGETED, and the reason is worth keeping. It first held ONLY a fenced
# stamp, and arm E asserted the task came back unbound. That arm was degenerate in exactly the
# way #431 warned about: a script that failed to read doc-meta AT ALL would also have passed
# it, and so would any mutant that merely broke the binding. It also could not be isolated --
# "unbound" is the same observable as arm C's, so a mutant that forced every task bound killed
# both arms and proved neither.
#
# Now the fenced stamp names a DIFFERENT document than the real one, so the arm asserts which
# binding was chosen rather than that none was. Fence mask working -> the real docId; fence
# mask removed -> the quoted one, and the pointer linking the real doc is refused by G10.
$JournalFenced = $JournalBound.Replace(
  '<!-- doc-meta docId={DOC} docUrl={DOCURL} -->',
  "The stamp looks like this:`n`n" + '```markdown' + "`n" + '<!-- doc-meta docId=QUOTEDnotREAL -->' + "`n" + '```' +
  "`n`n" + '<!-- doc-meta docId={DOC} docUrl={DOCURL} -->')

function Write-Journal([string]$id, [string]$template) {
  $text = $template.Replace('{ID}', $id).Replace('{DOCURL}', $DOCURL).Replace('{DOC}', $DOC)
  [IO.File]::WriteAllText((Join-Path $jdir "task-$id.md"), $text, $utf8)
}

Write-Journal '801' $JournalBound     # doc-bound
Write-Journal '802' $JournalUnbound   # no doc
Write-Journal '803' $JournalFenced    # doc-meta only inside a fence
Write-Journal '804' $JournalBound     # doc-bound, used for the real write in arms G/H

$boardText = "## Today`n`n| ID | Task |`n|---|---|`n"
foreach ($id in 801, 802, 803, 804) { $boardText += "| $id | synthetic |`n" }
[IO.File]::WriteAllText($board, $boardText, $utf8)
[IO.File]::WriteAllText($store, '{}', $utf8)

# --- turn bodies ----------------------------------------------------------------------
$Pointer = @'
## {MOON} Overnight Agent - packet drafted, doc amended

<!-- from: overnight-agent -->

**Status:** In-progress - 2026-09-03
[Catch-up doc]({DOCURL}) - current state, amended tonight. **Comment there.**

Drafted the packet and folded tonight's findings into the doc rather than restating them here.

**Needs from you:** approve the packet, or say what to change.

<!-- /overnight-agent turn-end -->
'@

# Arm D: identical, minus any route to the doc.
$NoLink = $Pointer -replace '(?m)^\[Catch-up doc\].*$\r?\n', ''
# Arm F: identical, with the ask moved into the doc instead of duplicated.
$NoAsk = $Pointer -replace '(?m)^\*\*Needs from you.*$\r?\n', ''

# Arm B: the status quo, at its measured size. 5,305 chars is the MEAN agent turn on
# task-468.md (28 turns, largest 9,094) -- the number this issue was filed over. Padded to
# exactly that, so the arm proves the guard refuses REALITY rather than a convenient strawman.
$fillerUnit = 'Detail that belongs in the doc, restated in the journal on every single wake. '
$narrativeTarget = 5305
$stub = $Pointer.Replace('{MOON}', $MOON).Replace('{DOCURL}', $DOCURL)
$need = $narrativeTarget - $stub.Trim().Length
$filler = $fillerUnit * [Math]::Max(1, [int][Math]::Floor($need / $fillerUnit.Length))
$filler += ('.' * [Math]::Max(0, $need - $filler.Length))
$Narrative = $Pointer.Replace('Drafted the packet and folded', ($filler + "`n`nDrafted the packet and folded"))

function New-Body([string]$name, [string]$text) {
  $p = Join-Path $root "$name.md"
  [IO.File]::WriteAllText($p, $text.Replace('{MOON}', $MOON).Replace('{DOCURL}', $DOCURL).Replace('{DOC}', $DOC), $utf8)
  return $p
}

$bPointer = New-Body 'pointer' $Pointer
$bNoLink = New-Body 'nolink' $NoLink
$bNoAsk = New-Body 'noask' $NoAsk
$bNarrative = New-Body 'narrative' $Narrative

# Arm I: the FIRST REAL pointer turn, task 468 on 2026-09-03, reproduced at its true length.
# Padded to exactly 901 chars so this arm measures the live shape rather than a convenient one.
$live = ($Pointer.Replace('{MOON}', $MOON).Replace('{DOCURL}', $DOCURL)).TrimEnd()
$tail = "`n`n<!-- /overnight-agent turn-end -->"
$stem = $live.Substring(0, $live.Length - $tail.Length)
$pad = 901 - $live.Length
if ($pad -gt 0) { $stem += (' ' + ('x' * ($pad - 1))) }
$bLive = New-Body 'live901' ($stem + $tail)
$liveLen = ([IO.File]::ReadAllText($bLive)).Trim().Length

$script:LastExit = 0
function Invoke-WriteTurn {
  param([string]$Id, [string]$BodyFile, [string[]]$Extra = @(), [string]$Script)
  if (-not $Script) { $Script = $Target }
  $all = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $Script,
    '-Id', $Id, '-BodyFile', $BodyFile, '-JournalDir', $jdir, '-Json') + $Extra
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { $out = & $PsExe @all 2>&1 | Out-String -Width 4096 }
  catch { $out = '' }
  finally { $script:LastExit = $LASTEXITCODE; $ErrorActionPreference = $prev; $global:LASTEXITCODE = 0 }
  $start = $out.IndexOf('{')
  if ($start -lt 0) { return $null }
  try { return $out.Substring($start) | ConvertFrom-Json } catch { return $null }
}

# Guards named in the verdict, as a sorted comma list -- compared as a whole so an arm cannot
# pass on a refusal that fired for an unrelated reason.
function Guards($r) {
  if (-not $r) { return '<no-json>' }
  if ($r.ok) { return '' }
  return ((@($r.findings) | ForEach-Object { $_.guard } | Sort-Object -Unique) -join ',')
}

function Invoke-Oa([string[]]$OaArgs) {
  $all = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $Oa) + $OaArgs +
  @('-JournalDir', $jdir, '-StateDir', $sdir, '-PlannerBoard', $board, '-SnoozeStore', $store)
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { $out = & $PsExe @all 2>&1 | Out-String -Width 8192 }
  catch { $out = '' }
  finally { $ErrorActionPreference = $prev; $global:LASTEXITCODE = 0 }
  return $out
}

function Get-Row([string]$id) {
  $json = Invoke-Oa @('scan')
  $start = $json.IndexOf('[')
  if ($start -lt 0) { return $null }
  try { $rows = $json.Substring($start) | ConvertFrom-Json } catch { return $null }
  return $rows | Where-Object { "$($_.id)" -eq $id }
}

# --- the seven guard arms -------------------------------------------------------------
# One function, so the mutation matrix runs the IDENTICAL arms against every mutant. A matrix
# that re-states its arms is a matrix that can drift away from the baseline it compares to.
function Invoke-GuardArms {
  param([string]$Script = $Target, [string[]]$Extra = @())
  $r = [ordered]@{}
  $a = Invoke-WriteTurn -Id 801 -BodyFile $bPointer -Extra (@('-Validate') + $Extra) -Script $Script
  $r['A short pointer passes every guard'] = ($a -and $a.ok -eq $true -and $a.docBound -eq $true -and $a.length -lt 800)
  $b = Invoke-WriteTurn -Id 801 -BodyFile $bNarrative -Extra (@('-Validate') + $Extra) -Script $Script
  $r['B narrative refused by G9'] = ((Guards $b) -eq 'G9')
  $c = Invoke-WriteTurn -Id 802 -BodyFile $bNarrative -Extra (@('-Validate') + $Extra) -Script $Script
  $r['C doc-less task unaffected'] = ($c -and $c.ok -eq $true -and $c.docBound -eq $false)
  $d = Invoke-WriteTurn -Id 801 -BodyFile $bNoLink -Extra (@('-Validate') + $Extra) -Script $Script
  $r['D pointer with no doc link refused by G10'] = ((Guards $d) -eq 'G10')
  $e = Invoke-WriteTurn -Id 803 -BodyFile $bPointer -Extra (@('-Validate') + $Extra) -Script $Script
  $r['E fenced doc-meta does not win over the real one'] = ($e -and $e.ok -eq $true -and "$($e.docId)" -eq $DOC)
  $f = Invoke-WriteTurn -Id 801 -BodyFile $bNoAsk -Extra (@('-Validate') + $Extra) -Script $Script
  $r['F ask stripped refused by G11'] = ((Guards $f) -eq 'G11')
  $i = Invoke-WriteTurn -Id 801 -BodyFile $bLive -Extra (@('-Validate') + $Extra) -Script $Script
  $r['I live 901-char pointer turn passes'] = ($i -and $i.ok -eq $true)
  return $r
}

$results = [ordered]@{}
$base = Invoke-GuardArms
foreach ($k in $base.Keys) { $results[$k] = $base[$k] }

Write-Host ''
Write-Host ("narrative body: {0} chars (measured mean agent turn on task-468.md: 5,305)" -f (([IO.File]::ReadAllText($bNarrative)).Trim().Length))
Write-Host ("live body:      {0} chars" -f $liveLen)

# --- arm G: acceptance 2, against the REAL digest -------------------------------------
# The shortened turn is WRITTEN for real (no -Validate), then read back the way the bridge
# reads it: latestAgentTurn() to isolate the newest turn, extractAskEntry() to lift the ask.
# Reasoning about this is worthless -- it is exactly the step a plausible implementation
# breaks without noticing.
$w = Invoke-WriteTurn -Id 804 -BodyFile $bPointer
$results['G- the pointer turn was actually written'] = ($w -and $w.ok -eq $true -and $script:LastExit -eq 0)

$probe = Join-Path $root 'probe.mjs'
$probeSrc = @'
import { readFileSync } from 'node:fs'
import { latestAgentTurn } from '{JOURNAL}'
import { extractAskEntry } from '{DIGEST}'
const content = readFileSync(process.argv[2], 'utf8')
const turn = latestAgentTurn(content)
const entry = extractAskEntry(turn)
// The negative control lives here too: the same pipeline over the ask-stripped body must
// come back null. Without it, arm G would pass against a digest that reports an ask for
// anything at all.
const stripped = readFileSync(process.argv[3], 'utf8')
const strippedEntry = extractAskEntry(stripped)
console.log(JSON.stringify({
  turnChars: turn ? turn.length : 0,
  ask: entry ? entry.text : null,
  source: entry ? entry.source : null,
  strippedAsk: strippedEntry ? strippedEntry.text : null
}))
'@
$toUrl = { param($p) ([Uri](Resolve-Path $p).Path).AbsoluteUri }
[IO.File]::WriteAllText($probe,
  $probeSrc.Replace('{JOURNAL}', (& $toUrl $journalJs)).Replace('{DIGEST}', (& $toUrl $digestJs)), $utf8)

$probeOut = ''
try { $probeOut = & node $probe (Join-Path $jdir 'task-804.md') $bNoAsk 2>&1 | Out-String }
catch { $probeOut = '' }
$global:LASTEXITCODE = 0
$pj = $null
$ps = $probeOut.IndexOf('{')
if ($ps -ge 0) { try { $pj = $probeOut.Substring($ps) | ConvertFrom-Json } catch { $pj = $null } }

# A missing node or missing bridge source FAILS rather than skips. A skipped arm that prints
# green is the failure mode this whole folder exists to prevent.
$results['G digest reads the ask out of the shortened turn'] =
  ($null -ne $pj -and $pj.ask -and "$($pj.ask)" -match 'approve' -and "$($pj.source)" -eq 'needs')
$results['G- and reads NO ask once it is moved to the doc'] = ($null -ne $pj -and $null -eq $pj.strippedAsk)

# --- arm H: acceptance 3, against the REAL oa-state.ps1 -------------------------------
[void](Invoke-Oa @('seed'))
[void](Invoke-Oa @('mark', '-Id', '804'))
$rowQuiet = Get-Row '804'
$results['H quiet after the shortened turn (control)'] = ($null -ne $rowQuiet -and [bool]$rowQuiet.reopened -eq $false)

# Raw text typed at the bottom -- no `## <date>` heading, no `<!-- from: me -->`. That is what
# a reply typed into the file actually looks like, and the shape #272/#448 kept swallowing.
$p804 = Join-Path $jdir 'task-804.md'
[IO.File]::WriteAllText($p804, ([IO.File]::ReadAllText($p804).TrimEnd() + "`n`nlooks good, ship it`n"), $utf8)
$rowReopened = Get-Row '804'
$results['H reopened by a reply typed under the shortened turn'] = ($null -ne $rowReopened -and [bool]$rowReopened.reopened -eq $true)

# --- the mutation matrix ---------------------------------------------------------------
# Each mutant must break EXACTLY its own arm. Two use the script's own -DisableGuard hook;
# two are generated source mutants, for the behaviours that have no hook. Built here, run
# after the arm report.
function New-Mutant([string]$name, [string]$find, [string]$replace) {
  # Returns $null when the anchor is absent, rather than throwing. A throw here would abort
  # the run BEFORE the arm report, making "the target fails the arms" indistinguishable from
  # "the harness broke" -- the same ambiguity Invoke-Oa guards against in mutcheck-doc-binding.
  # An absent anchor is still a failure; it is simply reported as an unkilled mutant below.
  $src = [IO.File]::ReadAllText($Target)
  if ($src -notmatch [regex]::Escape($find)) { return $null }
  $p = Join-Path $root "mutant-$name.ps1"
  [IO.File]::WriteAllText($p, $src.Replace($find, $replace), $utf8)
  return $p
}

# Fence mask -> identity: a doc-meta quoted inside a fenced example becomes a real binding.
$mFence = New-Mutant 'fence' 'if ($fence) { $lines[$i] = '' '' * $lines[$i].Length }' '# mutated: fence mask removed'
# Opt-in removed: every task is treated as doc-bound.
$mOptIn = New-Mutant 'optin' '$doc = if ($journal) { Get-JournalDocMeta $journal } else { $null }' `
  '$doc = if ($journal) { Get-JournalDocMeta $journal } else { $null }
if (-not $doc) { $doc = [pscustomobject]@{ doc_id = ''MUTANT''; doc_url = '''' } }'

$mutants = @(
  @{ name = 'disable G9 (no size ceiling)'; extra = @('-DisableGuard', 'G9'); script = $Target; kills = 'B narrative refused by G9' },
  @{ name = 'disable G10 (pointer need not point)'; extra = @('-DisableGuard', 'G10'); script = $Target; kills = 'D pointer with no doc link refused by G10' },
  @{ name = 'disable G11 (ask may move to the doc)'; extra = @('-DisableGuard', 'G11'); script = $Target; kills = 'F ask stripped refused by G11' },
  @{ name = 'fence mask removed'; extra = @(); script = $mFence; kills = 'E fenced doc-meta does not win over the real one' },
  @{ name = 'opt-in removed (all tasks doc-bound)'; extra = @(); script = $mOptIn; kills = 'C doc-less task unaffected' }
)

# --- report ----------------------------------------------------------------------------
Write-Host ''
$pass = 0; $fail = 0
foreach ($k in $results.Keys) {
  if ($results[$k]) { Write-Host "  PASS  $k"; $pass++ } else { Write-Host "  FAIL  $k"; $fail++ }
}
Write-Host ''
Write-Host "$pass passed, $fail failed"

# The matrix asks "is each arm isolating its own guarantee?", which is only a meaningful
# question once every arm holds. Running it against a target that already fails would report
# a wall of NOT ISOLATED lines and bury the actual finding.
$matrixOk = $true
if ($fail -gt 0) {
  Write-Host ''
  Write-Host 'mutation matrix skipped: arms must all hold before isolation means anything.'
} else {
  Write-Host ''
  Write-Host 'mutation matrix (each mutant must break exactly one arm):'
  foreach ($m in $mutants) {
    if (-not $m.script) {
      $matrixOk = $false
      Write-Host ("  {0,-38} NOT BUILT -- source anchor missing; this guarantee is untested" -f $m.name)
      continue
    }
    $after = Invoke-GuardArms -Script $m.script -Extra $m.extra
    $broke = @()
    foreach ($k in $base.Keys) { if ($base[$k] -and -not $after[$k]) { $broke += $k } }
    $ok = ($broke.Count -eq 1 -and $broke[0] -eq $m.kills)
    if (-not $ok) { $matrixOk = $false }
    $verdict = if ($ok) { 'KILLED by' } else { 'NOT ISOLATED --' }
    Write-Host ("  {0,-38} {1} [{2}]" -f $m.name, $verdict, ($broke -join ' | '))
  }
}

Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue

if ($fail -gt 0) { Write-Host ''; Write-Host "MUTCHECK FAILED: $fail arm(s) do not hold (target: $Target)"; exit 1 }
if (-not $matrixOk) { Write-Host ''; Write-Host 'MUTCHECK FAILED: a mutant was not isolated to exactly one arm.'; exit 1 }
Write-Host ''
Write-Host 'MUTCHECK OK: every arm holds and every mutant is killed by exactly one arm.'
exit 0
