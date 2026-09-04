<#
  mutcheck-doc-binding.ps1 -- mutation check for #423: a durable task -> catch-up-doc binding,
  with an exactly-once comment watermark, surfaced on the one worklist.

  Builds a synthetic planner journal folder, runs the REAL oa-state.ps1 against it with an
  isolated -JournalDir / -StateDir / -PlannerBoard / -SnoozeStore (so the live planner is never
  touched), and asserts the verdicts.

  Run it against BOTH the pre-fix and post-fix scripts. The change is only load-bearing if the
  pre-fix script FAILS these arms:

    powershell -File mutcheck-doc-binding.ps1 -ScriptPath <path-to-oa-state.ps1> [-ExpectPreFix]

  Arms, and the distinct mutant each one kills:

    A  bind returns bound+id        (kills: feature absent entirely)
    B  stamp written to journal     (kills: state-only binding -- durable until %LOCALAPPDATA%
                                     is lost, which is precisely when it is needed, because that
                                     folder is deliberately NOT synced)
    C  stamp sits beside tg-meta    (kills: a stamp appended at EOF, i.e. INSIDE the agent block,
                                     where the next turn's boundary reader has to cope with it)
    D  conflicting rebind THROWS    (kills: silent rebind -- the failure that strands every
                                     comment the user has already written on an orphan doc)
    E  -Force overrides D           (kills: an unescapable binding, which would make a genuinely
                                     deleted doc unrecoverable without hand-editing state)
    F  observe reports new ids      (kills: watermark absent)
    G  observe does NOT advance     (kills: single-phase read -- a crash between reading a
                                     comment and acting on it would drop the instruction
                                     silently, which is the #170 defect on a new surface)
    H  ack advances exactly once    (kills: re-reporting forever, so every run re-answers every
                                     comment ever written)
    I  only the NEW one is new      (kills: an ack that clears the whole set rather than the
                                     observed one, and an observe that reports everything)
    J  scan surfaces doc_new_comments (kills: the binding existing but living on a SECOND
                                     worklist the run has to remember to consult -- the issue is
                                     explicit that it must be one worklist, not two)
    K  state loss -> rebinds        (kills: the third acceptance criterion. This is the arm that
                                     fails on origin/main and on any state-only implementation)
    L  scan is READ-ONLY            (kills: `scan` healing state as a side effect. A read command
                                     that writes cannot be run twice safely, and scan runs first
                                     in every phase)
    M  fenced doc-meta ignored      (kills: a stamp quoted inside a fenced example in a turn
                                     being read as the task's real binding -- #320's rule, and
                                     this file's own turn bodies WILL quote the format)
    N  ack unions, never replaces   (kills: an -Ack after a partial/filtered observation
                                     UN-seeing comments that were already processed)
    O  seed-rebuilt state resolves  (kills: a heal that only works when the state FILE is absent.
                                     Losing %LOCALAPPDATA% is normally followed by `seed`, which
                                     rebuilds a doc-less state file for every journal -- so that,
                                     not "no file", is the shape the binding must survive)
    P  a clean ack sees nothing     (kills: an -Ack with no prior -Observe inventing a watermark
                                     entry, which would swallow the next real comment)
    Q  stamped journal reads TRUE   (kills: #436 -- reporting whether THIS call wrote the stamp
                                     instead of whether the journal carries one. False on every
                                     plain resolve, AND on a re-bind, because Add-DocMetaStamp
                                     returns $false when the journal is already stamped)
    R  unstamped journal reads FALSE (kills: a field hard-wired to $true. Q's partner: the pre-fix
                                     bug passes R alone and a always-true mutant passes Q alone,
                                     so only the two together assert the field DISCRIMINATES)
    S  wrong-doc stamp reads FALSE  (kills: asserting "a stamp exists" rather than "this doc's
                                     stamp exists". What a -Force rebind leaves behind: bound and
                                     stamped, but a state loss heals to the ABANDONED doc. The id
                                     is named so this is distinguishable from R, which it is not
                                     as a bare boolean, and the two need different repairs)

  D and K/O are the pair that matters. Every other arm asserts the happy path; those assert the
  two ways a binding stops being a binding -- one by being silently replaced, one by being
  silently forgotten -- and both manifest as a DUPLICATE DOCUMENT, which is invisible to the run
  that caused it and only ever noticed by the user whose comments went missing.

  A NOTE ON ARM L, because it was wrong first and the failure is instructive. It originally
  deleted the state file and asserted none reappeared. A scan-heals mutant PASSED that: the
  healing write was guarded by `$st` being non-null, and a deleted file yields null, so the
  mutated line never ran. The arm was green and killed nothing. `L--` now runs the same
  assertion against arm O's scenario -- a state file that exists and merely lacks the binding --
  which is both the realistic case and the one that actually reaches the write.
#>
[CmdletBinding()]
param(
  [string]$ScriptPath,
  [switch]$ExpectPreFix
)

$ErrorActionPreference = 'Stop'

if (-not $ScriptPath) { $ScriptPath = Join-Path $PSScriptRoot 'oa-state.ps1' }
if (-not (Test-Path $ScriptPath)) { throw "oa-state.ps1 not found at $ScriptPath" }

# Resolve the PowerShell host rather than hard-coding `powershell`. The other guards in this
# folder assume Windows PowerShell because they are run by hand on the one laptop -- which is
# exactly the property CI exists to remove, and the reason the browser-slot table was allowed to
# drift for a week. Everything this guard touches is plain text in a temp dir, so it runs on the
# Linux runner too, provided it launches the host that actually exists there.
$script:PsExe = if ($PSVersionTable.PSEdition -eq 'Core') { (Get-Process -Id $PID).Path } else { 'powershell' }
if (-not $script:PsExe) { $script:PsExe = 'pwsh' }

$Journal = @'
# Task {ID}: synthetic
<!-- tg-meta chatId=-100123 threadId=7 -->

User notes at the top.

---
<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->

## Overnight Agent

<!-- from: overnight-agent -->

**Status:** In-progress - plan v1 - 2026-09-03

**Needs from you:** none
'@

# A journal whose ONLY doc-meta sits inside a fenced example -- the shape a turn documenting the
# stamp format produces. It must not be read as this task's binding (arm M).
$FencedJournal = @'
# Task {ID}: synthetic

---
<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->

## Overnight Agent

<!-- from: overnight-agent -->

The stamp looks like this:

```
<!-- doc-meta docId=QUOTED_NOT_REAL -->
```

**Needs from you:** none
'@

# --- isolated sandbox ---------------------------------------------------------------
$root = Join-Path ([IO.Path]::GetTempPath()) ("oa-docbind-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
$jdir = Join-Path $root 'journal'
$sdir = Join-Path $root 'state'
New-Item -ItemType Directory -Path $jdir -Force | Out-Null
New-Item -ItemType Directory -Path $sdir -Force | Out-Null

$board = Join-Path $root 'planner.md'
$store = Join-Path $root 'snooze.json'
$utf8 = New-Object Text.UTF8Encoding($false)

foreach ($id in 701, 702, 703, 704, 705, 706, 708, 709, 711) {
  [IO.File]::WriteAllText((Join-Path $jdir "task-$id.md"), $Journal.Replace('{ID}', "$id"), $utf8)
}
[IO.File]::WriteAllText((Join-Path $jdir 'task-707.md'), $FencedJournal.Replace('{ID}', '707'), $utf8)
# 710 arrives ALREADY stamped for a doc it will NOT be bound to. That is exactly what a -Force
# rebind leaves behind: state moves to the new doc, the journal keeps naming the old one (arm S).
$stamped710 = $Journal.Replace('{ID}', '710').Replace(
  '<!-- tg-meta chatId=-100123 threadId=7 -->',
  "<!-- tg-meta chatId=-100123 threadId=7 -->`n<!-- doc-meta docId=DOC_WRONG -->")
[IO.File]::WriteAllText((Join-Path $jdir 'task-710.md'), $stamped710, $utf8)

$boardText = "## Today`n`n| ID | Task |`n|---|---|`n"
foreach ($id in 701, 702, 703, 704, 705, 706, 707, 708, 709, 710, 711) { $boardText += "| $id | synthetic |`n" }
[IO.File]::WriteAllText($board, $boardText, $utf8)
[IO.File]::WriteAllText($store, '{}', $utf8)

function Invoke-Oa {
  param([string[]]$OaArgs)
  $all = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $ScriptPath) + $OaArgs +
  @('-JournalDir', $jdir, '-StateDir', $sdir, '-PlannerBoard', $board, '-SnoozeStore', $store)
  # Must not throw: -ExpectPreFix runs this against a build that REJECTS the new parameters, and
  # a hard failure there has to surface as a failed arm rather than a crashed harness --
  # otherwise "pre-fix fails" is indistinguishable from "the harness is broken".
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  # -Width is not cosmetic for the JSON-bearing calls: the default wraps captured output at the
  # host's render width, which would split a long JSON line and defeat ConvertFrom-Json.
  #
  # It does NOT, however, control how a THROWN error looks. With `pwsh -File` the child formats
  # its own error at ITS terminal width and writes formatted text to stderr, so the parent only
  # ever sees the already-wrapped result. That is why the refusal arms below assert the EXIT CODE
  # and a space-free token, never a phrase -- see the note on arm D.
  try { $out = & $script:PsExe @all 2>&1 | Out-String -Width 4096 }
  catch { $out = '' }
  finally {
    $script:LastOaExit = $LASTEXITCODE
    $ErrorActionPreference = $prev
    $global:LASTEXITCODE = 0
  }
  return $out
}

function Invoke-OaJson {
  param([string[]]$OaArgs)
  $text = Invoke-Oa $OaArgs
  $start = $text.IndexOf('{')
  if ($start -lt 0) { return $null }
  try { return $text.Substring($start) | ConvertFrom-Json } catch { return $null }
}

function Get-Row([string]$id) {
  $json = Invoke-Oa @('scan')
  $start = $json.IndexOf('[')
  if ($start -lt 0) { return $null }
  try { $rows = $json.Substring($start) | ConvertFrom-Json } catch { return $null }
  return $rows | Where-Object { "$($_.id)" -eq $id }
}

function New-Dump {
  param([string[]]$Ids)
  $sb = New-Object Text.StringBuilder
  foreach ($i in $Ids) {
    [void]$sb.AppendLine("Comment ID: $i")
    [void]$sb.AppendLine('  Author: Shiv Bijlani')
    [void]$sb.AppendLine('  Created: 2026-09-03T10:00:00Z')
    [void]$sb.AppendLine("  Content: comment $i")
    [void]$sb.AppendLine('')
  }
  $p = Join-Path $root ("dump-" + [guid]::NewGuid().ToString('N').Substring(0, 6) + '.txt')
  [IO.File]::WriteAllText($p, $sb.ToString(), $utf8)
  return $p
}

function Get-JournalText([string]$id) {
  return [IO.File]::ReadAllText((Join-Path $jdir "task-$id.md"), $utf8)
}

$results = [ordered]@{}
function Check([string]$name, [scriptblock]$body) {
  try { $results[$name] = [bool](& $body) }
  catch { $results[$name] = $false; Write-Verbose "$name threw: $($_.Exception.Message)" }
}

[void](Invoke-Oa @('seed'))

# --- A/B/C: bind, and the stamp that makes it survive state loss ----------------------
$a = Invoke-OaJson @('doc', '-Id', '701', '-DocId', 'DOC_AAA', '-DocUrl', 'https://docs.google.com/document/d/DOC_AAA/edit')
Check 'A bind returns bound+id' { $a.bound -eq $true -and "$($a.doc_id)" -eq 'DOC_AAA' }

$j701 = Get-JournalText '701'
Check 'B stamp written to journal' { $j701 -match '<!--\s*doc-meta\s+docId=DOC_AAA' }
Check 'C stamp sits beside tg-meta' {
  # It must land in the HEAD of the file, above the managed sentinel -- not appended at EOF
  # inside the agent block.
  $iTg = $j701.IndexOf('tg-meta')
  $iDoc = $j701.IndexOf('doc-meta')
  $iSentinel = $j701.IndexOf('OVERNIGHT-AGENT do not edit')
  $iDoc -gt $iTg -and $iDoc -lt $iSentinel
}

# --- D/E: the refusal, and its escape hatch -------------------------------------------
#
# ARM D IS ASSERTED ON BEHAVIOUR, NOT ON THE MESSAGE, and the reason is worth keeping. Its first
# version matched the phrase `refusing to rebind` in captured output. That passed on Windows and
# FAILED on the Linux CI runner with byte-identical behaviour, because `pwsh -File` makes the
# CHILD render its own error at ITS terminal width -- so a phrase in the middle of a long
# sentence wraps on a narrow host and the match misses. The parent cannot unwrap it.
#
# So D now asserts the two things that are actually true of a refusal and cannot be reformatted:
# a NON-ZERO EXIT, and a token containing no spaces or hyphens for a wrap to break on. D- then
# asserts the consequence -- the binding did not move -- which is the property that matters.
$d = Invoke-Oa @('doc', '-Id', '701', '-DocId', 'DOC_BBB')
$dExit = $script:LastOaExit
Check 'D conflicting rebind THROWS' { $dExit -ne 0 -and $d -match 'doc_bind_conflict' }
Check 'D- and the binding is unchanged' { "$((Invoke-OaJson @('doc','-Id','701')).doc_id)" -eq 'DOC_AAA' }

$e = Invoke-OaJson @('doc', '-Id', '701', '-DocId', 'DOC_BBB', '-Force')
Check 'E -Force overrides the refusal' { "$($e.doc_id)" -eq 'DOC_BBB' }

# --- F/G/H/I: the watermark ------------------------------------------------------------
[void](Invoke-Oa @('doc', '-Id', '702', '-DocId', 'DOC_702'))
$dump12 = New-Dump @('C1', 'C2')

$f = Invoke-OaJson @('doc', '-Id', '702', '-Observe', $dump12)
Check 'F observe reports new ids' { $f.new_comments -eq 2 -and (@($f.new_comment_ids) -contains 'C1') }

# G: observing again, with nothing acknowledged, still reports the same two. If observing had
# advanced the watermark this would report 0 -- and a crash before the agent answered them would
# have dropped both instructions with no trace.
$g = Invoke-OaJson @('doc', '-Id', '702', '-Observe', $dump12)
Check 'G observe does NOT advance' { $g.new_comments -eq 2 }

[void](Invoke-Oa @('doc', '-Id', '702', '-Ack'))
$h = Invoke-OaJson @('doc', '-Id', '702', '-Observe', $dump12)
Check 'H ack advances (exactly once)' { $h.new_comments -eq 0 -and $h.seen_comments -eq 2 }

$dump123 = New-Dump @('C1', 'C2', 'C3')
$i = Invoke-OaJson @('doc', '-Id', '702', '-Observe', $dump123)
Check 'I only the NEW comment is new' { $i.new_comments -eq 1 -and "$(@($i.new_comment_ids) -join ',')" -eq 'C3' }

# --- J: it must appear on the ONE worklist ---------------------------------------------
$r702 = Get-Row '702'
Check 'J scan surfaces doc_new_comments' { $r702.doc_new_comments -eq 1 -and "$($r702.doc_id)" -eq 'DOC_702' }
Check 'J- scan surfaces doc_bound' { $r702.doc_bound -eq $true }

# --- N: ack unions rather than replacing ------------------------------------------------
# Observe a NARROWER dump (a filtered or partial read), then ack. The two ids already seen must
# survive: an ack that replaced the set with the observation would silently un-see them, and
# every previously-answered comment would come back as new on the following run.
$dumpNarrow = New-Dump @('C3')
[void](Invoke-OaJson @('doc', '-Id', '702', '-Observe', $dumpNarrow))
[void](Invoke-Oa @('doc', '-Id', '702', '-Ack'))
$n = Invoke-OaJson @('doc', '-Id', '702', '-Observe', $dump123)
Check 'N ack unions, never replaces' { $n.new_comments -eq 0 -and $n.seen_comments -eq 3 }

# --- P: an ack with NOTHING pending must not invent a phantom id ------------------------
# Found 2026-09-03 (GH #421), the first time the read loop was ever actually run: on a doc with
# no comments, `-Ack` wrote `seen_ids [null]` and the command then reported `seen_comments 1`.
#
# The mechanism is a PowerShell trap worth naming, because nothing about the source looks wrong:
# `@() + @() | Select-Object -Unique` emits NOTHING, so the receiving variable is $null, and
# `@($null)` is an array containing one null. An empty set silently became a set of size one.
#
# It matches no real comment, so it cannot suppress one -- but `seen_comments` is the number a
# human reads to check whether the agent has processed their comments, and "1 seen" on a document
# nobody has ever commented on is a false answer on the one surface #423 added for auditing this.
# On the channel Shiv was told is primary, a quietly wrong count is the whole failure mode.
#
# Asserted on the COUNT and on the stored array, because a filter applied only at the reporting
# edge would leave the phantom in state and pass a count-only check.
[void](Invoke-Oa @('doc', '-Id', '708', '-DocId', 'DOC_708'))
$emptyDump = Join-Path $root 'dump-empty.txt'
Set-Content -LiteralPath $emptyDump -Value 'No comments found in document DOC_708' -Encoding UTF8
[void](Invoke-OaJson @('doc', '-Id', '708', '-Observe', $emptyDump))
$p1 = Invoke-OaJson @('doc', '-Id', '708', '-Ack')
Check 'P clean ack sees nothing' { $p1.seen_comments -eq 0 -and $p1.new_comments -eq 0 }
Check 'P- and stores no phantom id' {
  $raw = Get-Content (Join-Path $sdir 'task-708.json') -Raw | ConvertFrom-Json
  @($raw.doc.seen_ids).Count -eq 0 -and @($raw.doc.pending_ids).Count -eq 0
}
# And the phantom must not have poisoned the watermark: a real comment arriving afterwards is
# still new. (If a null had been unioned in, this would still pass -- which is exactly why P- above
# asserts the stored array too, rather than trusting this one alone.)
$p2 = Invoke-OaJson @('doc', '-Id', '708', '-Observe', (New-Dump @('C9')))
Check 'P-- a later real comment is still new' { $p2.new_comments -eq 1 -and "$(@($p2.new_comment_ids) -join ',')" -eq 'C9' }

# --- K: the acceptance criterion that state alone cannot satisfy ------------------------
[void](Invoke-Oa @('doc', '-Id', '703', '-DocId', 'DOC_703'))
Remove-Item $sdir -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $sdir -Force | Out-Null

$k = Invoke-OaJson @('doc', '-Id', '703')
Check 'K state loss -> rebinds, not unbound' { $k.bound -eq $true -and "$($k.doc_id)" -eq 'DOC_703' }
Check 'K- and it reports it HEALED' { $k.healed -eq $true -and "$($k.source)" -eq 'journal' }
# The consequence, not just the signal: after healing, a conflicting bind is still refused. If
# the heal produced a read-only view that binding ignored, a lost state store would still allow a
# second doc to be created straight over the top of the first.
$k2 = Invoke-Oa @('doc', '-Id', '703', '-DocId', 'DOC_OTHER')
$k2Exit = $script:LastOaExit
Check 'K-- healed binding still refuses' { $k2Exit -ne 0 -and $k2 -match 'doc_bind_conflict' }
Check 'K--- and the healed binding held' { "$((Invoke-OaJson @('doc','-Id','703')).doc_id)" -eq 'DOC_703' }

# --- L: scan must not write --------------------------------------------------------------
# `scan` runs first in every phase and is documented as a read. Healing there would make the
# state store depend on how many times the worklist was consulted.
#
# The assertion is deliberately about the `doc` FIELD rather than the file's existence. An
# earlier version of this arm deleted the state file and asserted it stayed gone -- which a
# scan-heals mutant passed trivially, because the healing code was guarded by `$st` being
# non-null and a deleted file yields null. The arm looked green and killed nothing. So the
# scenario below is the one that actually exercises the write path: a state file that EXISTS
# and merely lacks the binding.
[void](Invoke-Oa @('doc', '-Id', '704', '-DocId', 'DOC_704'))
Remove-Item (Join-Path $sdir 'task-704.json') -Force -ErrorAction SilentlyContinue
$r704 = Get-Row '704'
Check 'L scan still REPORTS the doc' { "$($r704.doc_id)" -eq 'DOC_704' -and "$($r704.doc_source)" -eq 'journal' }
Check 'L- scan created no state file' { -not (Test-Path (Join-Path $sdir 'task-704.json')) }

# --- O: the REALISTIC state-loss path, and the strong form of L ---------------------------
# Losing %LOCALAPPDATA% is not usually followed by "no state file". It is followed by `seed`,
# which rebuilds a state file for every journal -- one with no `doc` field. That is the shape the
# binding has to survive, and it is the shape that exercises scan's write path.
[void](Invoke-Oa @('doc', '-Id', '705', '-DocId', 'DOC_705'))
Remove-Item (Join-Path $sdir 'task-705.json') -Force -ErrorAction SilentlyContinue
[void](Invoke-Oa @('seed'))
Check 'O- seed rebuilt a doc-less state file' {
  (Test-Path (Join-Path $sdir 'task-705.json')) -and
  -not ([IO.File]::ReadAllText((Join-Path $sdir 'task-705.json')) -match '"doc"\s*:\s*\{')
}
$r705 = Get-Row '705'
Check 'O seed-rebuilt state still resolves' { "$($r705.doc_id)" -eq 'DOC_705' -and "$($r705.doc_source)" -eq 'journal' }
# The strong form of L: scan has now run over a state file it COULD have healed. It must not have.
Check 'L-- scan did not heal into state' {
  -not ([IO.File]::ReadAllText((Join-Path $sdir 'task-705.json')) -match '"doc"\s*:\s*\{')
}
# ...and the explicit heal still works afterwards, so declining to heal in `scan` costs nothing.
$o = Invoke-OaJson @('doc', '-Id', '705')
Check 'O-- explicit heal still rebinds' { "$($o.doc_id)" -eq 'DOC_705' -and $o.healed -eq $true }

# --- M: a quoted stamp is not a binding ---------------------------------------------------
$m = Invoke-OaJson @('doc', '-Id', '707')
Check 'M fenced doc-meta is ignored' { $m.bound -eq $false }
$r707 = Get-Row '707'
Check 'M- scan agrees it is unbound' { $r707.doc_bound -eq $false -and $r707.doc_new_comments -eq 0 }

# --- Q/R/S: journal_stamped reports the JOURNAL'S STATE, not this call's side effect (#436) ---
#
# The field exists to answer exactly one question: if %LOCALAPPDATA% is lost tonight, does this
# binding come back? Before #436 it answered a different one -- "did THIS invocation write the
# stamp" -- which is false for almost every real call. So a durable binding and one that is about
# to strand every comment the user has written printed the identical `false`, and the only field
# that could have told them apart was the one lying. That is the #346 shape on a third surface:
# "could not tell" rendered as "not healthy", indistinguishably.
#
# Q AND R ARE A PAIR AND ONLY MEAN ANYTHING TOGETHER. Q alone is passed by a mutant that returns
# $true unconditionally; R alone is passed by the pre-fix bug itself, which returns $false
# unconditionally. The arms are load-bearing only because the same call must report OPPOSITE
# verdicts on the two journals.

# Q: bound AND stamped -- the healthy, overwhelmingly common case, and the one that was wrong.
[void](Invoke-Oa @('doc', '-Id', '706', '-DocId', 'DOC_706'))
$q = Invoke-OaJson @('doc', '-Id', '706')
Check 'Q plain resolve reports stamped' { $q.journal_stamped -eq $true }
Check 'Q- and names no mismatch' { $null -eq $q.journal_stamp_mismatch_id }
# The old field name is GONE, not merely shadowed. `journal_stamp_id` read as "the id in the
# journal stamp", so its null on a healthy task read as "there is no id" -- false, and filed twice
# as a defect (#494) by readers who consumed the field without its `journal_stamped` partner. A
# rename only helps if the misleading name cannot come back, and re-adding it alongside would
# restore the exact ambiguity this removed.
Check 'Q--- the misleading old field name is gone' {
  -not ($q.PSObject.Properties.Name -contains 'journal_stamp_id')
}
# The second half of the same bug, independent of the first: Add-DocMetaStamp returns $false when
# the journal is ALREADY stamped, so even the -DocId path reported `false` on the healthiest
# possible input. A fix that only handles the plain-resolve path leaves this one live.
$q2 = Invoke-OaJson @('doc', '-Id', '706', '-DocId', 'DOC_706')
Check 'Q-- re-bind still reports stamped' { $q2.journal_stamped -eq $true }

# R: bound in state, NOT stamped in the journal -- the genuinely at-risk binding the field exists
# to surface. State is the only copy, so losing it loses the doc and the next run creates a second.
[void](Invoke-Oa @('doc', '-Id', '709', '-DocId', 'DOC_709'))
$j709 = Get-JournalText '709'
[IO.File]::WriteAllText((Join-Path $jdir 'task-709.md'),
  ($j709 -replace '(?m)^<!--\s*doc-meta[^>]*-->\r?\n?', ''), $utf8)
$r = Invoke-OaJson @('doc', '-Id', '709')
Check 'R unstamped journal reports NOT stamped' { $r.journal_stamped -eq $false }
Check 'R- and the binding itself still resolves' { "$($r.doc_id)" -eq 'DOC_709' }

# S: stamped, but for a DIFFERENT doc -- what a -Force rebind leaves behind. Every other signal
# looks healthy: `bound` is true and a stamp is present. Yet a state loss heals to the ABANDONED
# document, which is the duplicate-doc failure arriving by the self-heal path that exists to
# prevent it. A bare boolean cannot separate this from R, and the two need different repairs
# (write a stamp vs. correct the one that is there), so the offending id is named.
$s = Invoke-OaJson @('doc', '-Id', '710', '-DocId', 'DOC_710', '-Force')
Check 'S mismatched stamp is NOT stamped' { $s.journal_stamped -eq $false }
Check 'S- and the wrong id is NAMED' { "$($s.journal_stamp_mismatch_id)" -eq 'DOC_WRONG' }

# T: a MALFORMED stamp -- `docId=` with no id, so the doc-meta regex does not match and
# Get-DocMetaFromJournal returns null, exactly as it does for a journal with no stamp at all.
#
# This arm pins that collapse as DELIBERATE rather than leaving it undiscovered. It is safe in a
# way the R-vs-S collapse would not be: an unparseable stamp and an absent one both mean the
# journal can heal state to nothing, and both are repaired identically by writing a correct stamp.
# The distinction that must never collapse is "heals to nothing" (R and T) versus "heals to the
# WRONG document" (S) -- so T is asserted to look like R, and to look nothing like S.
[void](Invoke-Oa @('doc', '-Id', '711', '-DocId', 'DOC_711'))
$j711 = Get-JournalText '711'
[IO.File]::WriteAllText((Join-Path $jdir 'task-711.md'),
  ($j711 -replace '(?m)^<!--\s*doc-meta[^>]*-->', '<!-- doc-meta docId= -->'), $utf8)
$t = Invoke-OaJson @('doc', '-Id', '711')
Check 'T malformed stamp reports NOT stamped' { $t.journal_stamped -eq $false }
Check 'T- and names no mismatch (it heals to NOTHING, not to a wrong doc)' {
  $null -eq $t.journal_stamp_mismatch_id
}
Check 'T-- and the binding itself still resolves' { "$($t.doc_id)" -eq 'DOC_711' }

# --- report ---------------------------------------------------------------------------
$pass = 0; $fail = 0
foreach ($k in $results.Keys) {
  if ($results[$k]) { "  PASS  $k"; $pass++ } else { "  FAIL  $k"; $fail++ }
}
""
"$pass passed, $fail failed  (script: $ScriptPath)"

Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue

if ($ExpectPreFix) {
  if ($fail -eq 0) { "MUTCHECK FAILED: pre-fix script passed everything - the fix guards nothing."; exit 1 }
  "MUTCHECK OK: pre-fix script fails $fail arm(s), as required."
  exit 0
}

if ($fail -gt 0) { exit 1 }
exit 0
