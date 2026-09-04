<#
  mutcheck-consent-authorship.ps1 -- mutation check for the consent-authorship boundary (#227).

  THE BUG THIS GUARDS
  -------------------
  Approval for an irreversible action was inferred from prose in a file the agent writes.
  `Test-TrailingHasUser` treats text with NO provenance marker as the human -- correct for
  reopen detection (losing a user's message is worse than an extra look) and exactly wrong as
  a consent boundary, because it attributes ANY unmarked text below the turn-end stamp to the
  human. Sibling skills, a crash mid-write, or a refactor that drops a marker all produce text
  that would then read as "Shiv said approve".

  WHAT IS ASSERTED
  ----------------
  Two verdicts on the SAME fixtures, which is the whole point of the fix:

    reopened   -- fail OPEN  : unmarked prose counts as the human   (unchanged by #227)
    consent_ok -- fail CLOSED: unmarked prose does NOT count        (added by #227)

  A case where those two disagree is the fix doing its job. If a mutation makes them agree
  everywhere, the boundary has collapsed back into the reopen reader and a case here fails.

  #465 ADDS A THIRD QUESTION, asked of the same fixtures: has the affirmative been SPENT?
  Attribution ("is this his?") and consumption ("has it been served?") are independent, and the
  gate needs both. An approval the agent already replied to must stop authorising, but only THIS
  agent's reply spends it, and only when it sits BELOW the approval. Cases 961-965 pin each of
  those discriminations, and `reason` is asserted there because a spent approval and one that was
  never given are both `consent_ok: false` -- without the reason, a mutation that loses his
  approval entirely passes as if it had correctly reported it as served.

  Runs the REAL oa-state.ps1 against an isolated synthetic journal folder (-JournalDir /
  -StateDir), so live state and live journals are never touched.

  Mutations run BY DEFAULT, because run-sweeps.ps1 invokes these with no arguments beyond
  -ScriptPath; a mutcheck that only ran its baseline unless asked would report a comfortable
  green every night while proving nothing.

    powershell -File mutcheck-consent-authorship.ps1 -ScriptPath <path-to-oa-state.ps1>
    powershell -File mutcheck-consent-authorship.ps1 -BaselineOnly     # skip the mutants
#>
[CmdletBinding()]
param(
  [string]$ScriptPath,
  [switch]$BaselineOnly
)

$ErrorActionPreference = 'Stop'

# Default to the installed skill's oa-state.ps1 when run by hand; run-sweeps.ps1 passes
# -ScriptPath explicitly so the nightly sweep guards the PRODUCTION copy, not the repo's.
if (-not $ScriptPath) {
  $candidates = @(
    (Join-Path $PSScriptRoot '..\skills\overnight-agent\oa-state.ps1'),
    (Join-Path $env:LOCALAPPDATA 'overnight-agent\oa-state.ps1'),
    "$env:USERPROFILE\.copilot\installed-plugins\focus-planner\overnight-agent\skills\overnight-agent\oa-state.ps1"
  )
  foreach ($c in $candidates) { if (Test-Path $c) { $ScriptPath = (Resolve-Path $c).Path; break } }
}
if (-not $ScriptPath -or -not (Test-Path $ScriptPath)) { throw "oa-state.ps1 not found (pass -ScriptPath)" }

$AgentBlock = @'
# Task {ID}: synthetic

Some user notes at the top.

---
<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->

## Overnight Agent

**Status:** Proposed - plan v1 - 2026-08-29

<!-- from: overnight-agent -->
The agent's last turn. Awaiting a decision.

**Needs from you:** approve to send the email.
'@

function New-Journal {
  param([string]$Dir, [string]$Id, [string[]]$Entries)
  $sb = [System.Text.StringBuilder]::new()
  [void]$sb.AppendLine(($AgentBlock -replace '\{ID\}', $Id))
  foreach ($e in $Entries) {
    [void]$sb.AppendLine()
    [void]$sb.AppendLine($e)
  }
  [System.IO.File]::WriteAllText((Join-Path $Dir "task-$Id.md"), $sb.ToString(), [System.Text.UTF8Encoding]::new($false))
}

# --- fixtures ---------------------------------------------------------------------------
$humanApprove   = "## 2026-08-29`n`n<!-- from: me -->`napprove"
$humanChat      = "## 2026-08-29`n`n<!-- from: me -->`nWhat is the status here?"
$unmarkedApprove = "## 2026-08-29`n`napproved, go ahead"          # THE #227 CASE
$siblingApprove = "## 2026-08-29`n`n<!-- from: dance-church -->`nApproved the class booking."
$agentApprove   = "## 2026-08-29`n`n<!-- from: overnight-agent -->`nYou said approve, so I shipped it."

# A single heading block holding BOTH authors: the human asks, and a SIBLING SKILL appends an
# affirmative under the same heading. Per-entry attribution ("does this ## block contain a
# human marker?") would let the sibling's "Approved" inherit the human's provenance. Positional
# attribution must not. A sibling marker is used rather than the agent's own because an
# `overnight-agent` marker also moves the turn-end boundary, which would mask the effect.
$mixedSiblingAffirm = @'
## 2026-08-29

<!-- from: me -->
What do you think?

<!-- from: dance-church -->
Approved the class booking.
'@

# The agent answering inline under the user's heading. Here the agent's own marker legitimately
# moves the turn boundary (the user HAS been answered), so this asserts the pair: not reopened,
# and the agent's own "approve" is still not consent.
$mixedAgentAffirm = @'
## 2026-08-29

<!-- from: me -->
What do you think?

<!-- from: overnight-agent -->
I would approve this myself, but that is not my call.
'@

# The mirror image: a machine turn first, then the genuine human approval below it. Finding a
# non-human affirmative first must NOT short-circuit the scan.
$machineThenHuman = @'
## 2026-08-29

<!-- from: dance-church -->
Approved the class booking.

<!-- from: me -->
yes, ship it
'@

# Word-boundary guards: these contain the LETTERS of an affirmative but not the word.
$humanNoGo      = "## 2026-08-29`n`n<!-- from: me -->`nI am going to think about it. Undo it for now."
$humanNegative  = "## 2026-08-29`n`n<!-- from: me -->`nPlease hold off, do not send that yet."

# THE #272 CASE -- the gate failing OPEN, measured live on #442 (2026-08-30).
# The human asks a QUESTION, then an agent turn is appended under its own `## ` heading with no
# provenance marker. Marker-to-marker ownership hands that turn to the human, so the agent's own
# affirmatives are read back as the user's approval. A `## ` heading must end ownership.
$trappedAgentTurn = @'
## 2026-08-29

<!-- from: me -->
should watchdog agent be doing reaps?

## Overnight Agent

**Status:** In progress

Short answer: yes, I approve this approach and it is approved on my side.
'@

# The other half of #272, and the one that makes it a discrimination rather than a blanket "no".
# The human's approval sits in HIS OWN segment, above the heading -- the real shape of #443, where
# Shiv genuinely typed `approve`. Clamping at the heading must not touch this: a fix that closes
# the false positive by also closing the true positive has broken the gate, not repaired it.
#
# #465 RECLASSIFIED THIS CASE, and the distinction is the point. Attribution is unchanged: the
# `approve` is still found and still attributed to Shiv. What changed is that the agent has
# REPLIED beneath it, so the approval has been served and must not authorise a second action.
# The verdict is therefore `human-affirmative-already-answered` -- consent_ok false, but with the
# phrase and author still reported, so "he approved and I acted on it" stays distinguishable from
# "he never approved". Asserting the REASON here is what keeps this case guarding #272: a
# mutation that swallows his segment entirely also fails, because it reports nothing at all.
$humanApproveThenAgentTurn = @'
## 2026-08-29

<!-- from: me -->
approve

## Overnight Agent

**Status:** Done

Your approve is drained; nothing here needs a decision.
'@

# #465's PARITY CONTROL, and the measurement that motivated the whole change. Byte-identical to
# the fixture above except for the turn-end stamp the agent writes about its OWN turn. Before
# #465 these two returned opposite verdicts -- `human-authored-affirmative` without the stamp,
# `no-trailing-content` with it -- which means a marker the agent forgot decided whether a
# week-old approval could authorise an irreversible action, and forgetting it failed OPEN.
#
# They must now agree on consent_ok. They legitimately differ on `reason`: with the stamp the
# trailing window has moved past the approval entirely, so there is nothing left to report.
$humanApproveThenAgentTurnStamped = $humanApproveThenAgentTurn + "`n`n<!-- /overnight-agent turn-end -->"

# #465 NARROWNESS, and the case that stops the fix becoming a blanket "any text below spends it".
# A sibling skill appends its own turn below Shiv's approval. The overnight agent has NOT answered
# him, so his approval is still live. Consuming here would be a false NEGATIVE in the gate -- he
# approves, a scheduled sibling posts, and his approval silently evaporates.
#
# It doubles as #272's surviving narrowness guard: there is still a `## ` heading below his
# segment, so a clamp that swallows the human's own text still fails this case.
$humanApproveThenSiblingTurn = @'
## 2026-08-29

<!-- from: me -->
approve

## 2026-08-30

<!-- from: dance-church -->
Added 3 classes to the calendar.
'@

# #465: spending must not deadlock the gate closed. He approves, the agent replies, he approves
# AGAIN. The second affirmative has nothing beneath it and is live. A fix that returns on the
# first spent affirmative instead of continuing the scan would make re-approval impossible --
# the task could never be authorised again, which is a fail-closed hang rather than a guard.
$humanApproveSpentThenReapproved = @'
## 2026-08-29

<!-- from: me -->
approve

## Overnight Agent

**Status:** Done

Handled.

## 2026-08-31

<!-- from: me -->
yes go ahead
'@

# #465 x #320: an agent turn heading QUOTED INSIDE A FENCE is an example, not a turn. If agent-turn
# detection reads raw text instead of the mask, then pasting a turn heading into a message -- which
# is what every postmortem in this repo does -- silently spends the approval sitting above it.
$humanApproveThenFencedHeading = @'
## 2026-08-29

<!-- from: me -->
approve

```
## Overnight Agent
```
'@

# #465 ORDERING. The agent replied to an earlier message, and he approved AFTER that reply. Nothing
# has answered the approval, so it is live. It pins the comparison as positional: a mutation that
# spends an affirmative whenever an agent turn exists anywhere in the region kills real approvals,
# and only a case with an agent turn sitting ABOVE the human's word can tell that apart.
#
# The agent's turn here is deliberately UNSTAMPED, and the shape is deliberately
# [human] -> [agent] -> [human]. Both are load-bearing, and an earlier draft of this fixture was
# inert because neither was: an `<!-- from: overnight-agent -->` marker is what Get-AgentEndIndex
# anchors the turn boundary on, and a managed heading with no unmanaged heading above it is
# stepped over by the boundary walk -- either way the agent turn ends up ABOVE the trailing region
# instead of inside it, so there is nothing for a position mutation to get wrong. Opening with the
# user's own dated heading is what holds the boundary open above all three entries.
$agentTurnThenHumanApprove = @'
## 2026-08-28

<!-- from: me -->
should the watchdog agent be doing reaps?

## Overnight Agent

**Status:** In progress

Answered above; no decision needed from you yet.

## 2026-08-29

<!-- from: me -->
approve
'@

# --- #320 / #325: a fenced code block is QUOTED TEXT, not markup -------------------------
# These four are one experiment with its own control, in BOTH directions. They are what make
# the fence-masking load-bearing rather than incidental: each pair changes exactly one thing.
#
# SECURITY HALF (#320). An agent postmortem about attribution -- the thing this repo writes
# constantly -- quoting a journal example inside a fence. No human speaks anywhere in the
# file. Before the fence mask this returned `human-authored-affirmative`: the agent authored
# its own approval, which is the one outcome #227 exists to prevent.
$fencedHumanMarker = @'
## 2026-08-29 - notes on how attribution works

A journal entry looks like this:

```
## 2026-08-29

<!-- from: me -->

yes
```

That marker is what makes a reply count as human.
'@

# CONTROL for the above. Byte-identical except the marker INSIDE the fence names an agent.
# Its job is to prove the fence is what neutralises the marker: if this case and the one
# above ever disagree, the reader is parsing fenced content as live markup again.
$fencedAgentMarker = $fencedHumanMarker -replace '<!-- from: me -->', '<!-- from: dance-church -->'

# FALSE-NEGATIVE HALF (#325), and the reason this is not merely a security fix. A GENUINE
# human approval that also pastes a fenced example -- quoting the docs while asking a
# question, in one message, which is how people actually type. The fenced
# `<!-- from: overnight-agent -->` used to be read as the agent's newest marker, dragging the
# turn boundary BELOW the human's reply: the region collapsed and the verdict was
# `no-trailing-content`. Shiv's approval did not merely fail to count -- the reader concluded
# nobody had spoken at all, which is indistinguishable from him staying silent.
$humanApproveWithFence = @'
## 2026-08-29

<!-- from: me -->
yes go ahead. quick question though, is this the bit you meant?

```
<!-- from: overnight-agent -->
some quoted turn
```
'@

# CONTROL for the above: the same approval with the fence removed. It isolates the fence as
# the single cause, so a mutation cannot pass by breaking approvals generally.
$humanApproveNoFence = "## 2026-08-29`n`n<!-- from: me -->`nyes go ahead. quick question though, is this the bit you meant?"

# The MID-LINE case, which is what the line-start anchor actually defends. This is #320's own
# fixture, and it is a different shape from the fenced ones above: the marker is embedded in a
# running sentence, not at column 0. 28 such strings exist in the live corpus (e.g.
# task-267.md:17 explains `appendJournalMessage` by quoting a marker inline). They are inert
# ONLY because of the `^` in ProvenanceRe -- so without this case, that character is unpinned
# and can be deleted by a passing regex tweak with every guard still green.
$midLineQuotedMarker = @'
## 2026-08-29 - notes on how attribution works

Explaining how attribution works: a reply carries `<!-- from: me -->` above it, and that
is what makes it count. yes, that is the whole mechanism.
'@

# The OFFSET case. A fence, and then a GENUINE human approval below it. The mask must be the
# same length as the text it masks, because every caller locates markers on the mask and then
# substrings the ORIGINAL. A mask that deletes fenced spans instead of blanking them shifts
# every offset after the first fence, so this approval gets sliced at the wrong boundary and
# is lost -- silently, and only in files that contain a fence.
$fenceThenHumanApprove = @'
## 2026-08-29

<!-- from: overnight-agent -->
For reference, the shape of a turn is:

```
<!-- from: someone -->
body text
```

## 2026-08-29

<!-- from: me -->
approve
'@

# THE MIRROR OF M7, and #320's second success criterion. The anchor must reject a marker
# quoted mid-line WITHOUT rejecting a genuine one that happens to be indented -- otherwise
# the obvious "fix" for M7 is to over-anchor to hard column 0, which silently discards real
# approvals. Nothing modelled that: every other fixture puts its marker at column 0, so
# tightening `^[ \t]*` to `^` broke no case and would ship green.
$indentedHumanApprove = "## 2026-08-29`n`n   <!-- from: me -->`napprove"

# #320's fourth criterion: assert that an UNKNOWN marker value fails closed. `agent` is real
# -- it occurs at task-385.md:64 in the live corpus and was modelled nowhere. It is safe today
# only because anything that is not `me` is non-human, which is a property worth pinning
# rather than rediscovering.
$unknownAuthorApprove = "## 2026-08-29`n`n<!-- from: agent -->`napprove"

# id -> expectations. `reopened` is asserted alongside `consent_ok` so a mutation that
# collapses one into the other is caught rather than silently passing.
#
# `reason` is OPTIONAL and asserted only where it carries information consent_ok cannot. #465's
# cases need it: a spent approval and a never-given one are both `consent_ok: false`, so without
# the reason a mutation that loses Shiv's approval entirely is indistinguishable from one that
# correctly reports it as served.
$cases = [ordered]@{
  '940' = @{ entries = @();                  consent = $false; reopened = $false; why = 'nothing below the block -> no consent, quiet' }
  '941' = @{ entries = @($humanApprove);     consent = $true;  reopened = $true;  why = 'human-marked "approve" -> CONSENT' }
  '942' = @{ entries = @($unmarkedApprove);  consent = $false; reopened = $true;  why = '#227: unmarked "approved" -> reopen YES, consent NO' }
  '943' = @{ entries = @($siblingApprove);   consent = $false; reopened = $false; why = 'sibling skill wrote "Approved" -> NOT consent' }
  '944' = @{ entries = @($agentApprove);     consent = $false; reopened = $false; why = 'the agent wrote "approve" -> NOT consent (self-authored)' }
  '945' = @{ entries = @($humanChat);        consent = $false; reopened = $true;  why = 'human spoke but did not approve -> reopen, no consent' }
  '946' = @{ entries = @($mixedSiblingAffirm); consent = $false; reopened = $true;  why = 'sibling affirmative under the human heading -> reopen YES, consent NO' }
  '947' = @{ entries = @($machineThenHuman); consent = $true;  reopened = $true;  why = 'machine affirmative first, human approval after -> CONSENT' }
  '948' = @{ entries = @($humanNoGo);        consent = $false; reopened = $true;  why = 'word boundary: "going"/"Undo it" are not affirmatives' }
  '949' = @{ entries = @($humanNegative);    consent = $false; reopened = $true;  why = 'explicit refusal -> no consent' }
  '950' = @{ entries = @($mixedAgentAffirm); consent = $false; reopened = $false; why = 'agent answered inline; its own "approve" is not consent' }
  '951' = @{ entries = @($trappedAgentTurn); consent = $false; reopened = $true;  why = '#272: unmarked agent turn under its own heading -> NOT the human''s approval' }
  '952' = @{ entries = @($humanApproveThenAgentTurn); consent = $false; reopened = $true; reason = 'human-affirmative-already-answered'; why = '#465: his approval is FOUND, and already served by the turn below -> SPENT' }
  '953' = @{ entries = @($fencedHumanMarker);     consent = $false; reopened = $true;  why = '#320: a `me` marker inside a FENCE is quoted text -> NOT consent' }
  '954' = @{ entries = @($fencedAgentMarker);     consent = $false; reopened = $true;  why = '#320 control: same fence, agent marker -> NOT consent either' }
  '955' = @{ entries = @($humanApproveWithFence); consent = $true;  reopened = $true;  why = '#325: a real approval is not erased by a fence pasted under it' }
  '956' = @{ entries = @($humanApproveNoFence);   consent = $true;  reopened = $true;  why = '#325 control: the same approval without a fence -> CONSENT' }
  '957' = @{ entries = @($midLineQuotedMarker);   consent = $false; reopened = $true;  why = '#320: a marker quoted MID-LINE in prose attributes nothing' }
  '958' = @{ entries = @($fenceThenHumanApprove); consent = $true;  reopened = $true;  why = '#320: an approval BELOW a fence survives (mask preserves offsets)' }
  '959' = @{ entries = @($indentedHumanApprove);  consent = $true;  reopened = $true;  why = '#320 crit2: a GENUINE marker that is indented is still honoured' }
  '960' = @{ entries = @($unknownAuthorApprove);  consent = $false; reopened = $false; why = '#320 crit4: an unknown marker value (`agent`) fails closed' }
  '961' = @{ entries = @($humanApproveThenAgentTurnStamped); consent = $false; reopened = $false; why = '#465 PARITY: same journal + turn-end stamp -> same consent verdict as 952' }
  '962' = @{ entries = @($humanApproveThenSiblingTurn);      consent = $true;  reopened = $true;  reason = 'human-authored-affirmative'; why = '#465 narrowness: a SIBLING turn below does not spend his approval' }
  '963' = @{ entries = @($humanApproveSpentThenReapproved);  consent = $true;  reopened = $true;  reason = 'human-authored-affirmative'; why = '#465: spent, then re-approved -> the NEWER approval is live' }
  '964' = @{ entries = @($humanApproveThenFencedHeading);    consent = $true;  reopened = $true;  reason = 'human-authored-affirmative'; why = '#465 x #320: a turn heading inside a FENCE cannot spend an approval' }
  '965' = @{ entries = @($agentTurnThenHumanApprove);        consent = $true;  reopened = $true;  reason = 'human-authored-affirmative'; why = '#465 ordering: an agent turn ABOVE his approval does not spend it' }
}

function Invoke-Scan([string]$Script) {
  $root = Join-Path $env:TEMP ("oa-consent-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
  $jdir = Join-Path $root 'journal'
  $sdir = Join-Path $root 'state'
  New-Item -ItemType Directory -Path $jdir -Force | Out-Null
  New-Item -ItemType Directory -Path $sdir -Force | Out-Null
  try {
    foreach ($id in $cases.Keys) { New-Journal -Dir $jdir -Id $id -Entries $cases[$id].entries }
    & powershell -NoProfile -ExecutionPolicy Bypass -File $Script seed -JournalDir $jdir -StateDir $sdir | Out-Null
    $raw = & powershell -NoProfile -ExecutionPolicy Bypass -File $Script scan -JournalDir $jdir -StateDir $sdir
    $rows = ($raw -join "`n") | ConvertFrom-Json
    $byId = @{}
    foreach ($r in $rows) { $byId["$($r.id)"] = $r }
    return $byId
  }
  finally { Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue }
}

function Test-Cases($byId, [string]$Label) {
  $pass = 0; $fail = 0
  Write-Host ""
  Write-Host "=== $Label ==="
  Write-Host ("{0,-5} {1,-9} {2,-9} {3,-9} {4,-9} {5}" -f 'case', 'consent', 'actual', 'reopen', 'actual', 'why')
  foreach ($id in $cases.Keys) {
    $row = $byId[$id]
    $ac = [bool]$row.consent_ok
    $ar = [bool]$row.reopened
    $ec = [bool]$cases[$id].consent
    $er = [bool]$cases[$id].reopened
    $ok = ($ac -eq $ec) -and ($ar -eq $er)
    # Asserted only where declared -- see the note on $cases. A reason mismatch is a real
    # failure, not a warning: for #465's cases it is the ONLY signal that distinguishes
    # "his approval was found and spent" from "his approval was lost".
    $why = $cases[$id].why
    if ($cases[$id].reason) {
      $areason = "$($row.consent_reason)"
      if ($areason -ne $cases[$id].reason) {
        $ok = $false
        $why = "$why  [reason: expected $($cases[$id].reason), got $areason]"
      }
    }
    if ($ok) { $pass++ } else { $fail++ }
    Write-Host ("{0,-5} {1,-9} {2,-9} {3,-9} {4,-9} {5}  [{6}]" -f $id, $ec, $ac, $er, $ar, $why, $(if ($ok) { 'PASS' } else { 'FAIL' }))
  }
  Write-Host "passed $pass / $($pass + $fail)"
  return $fail
}

# --- baseline ----------------------------------------------------------------------------
$fail = Test-Cases (Invoke-Scan $ScriptPath) 'BASELINE (real oa-state.ps1)'
if ($fail -gt 0) { Write-Host ""; Write-Host "BASELINE FAILED"; exit 1 }

if ($BaselineOnly) { exit 0 }
# --- mutations ---------------------------------------------------------------------------
# Each mutation removes ONE load-bearing property. A mutation that no case detects is a guard
# that is not doing work -- the check fails, rather than reporting a comfortable green.
$src = [IO.File]::ReadAllText($ScriptPath, (New-Object Text.UTF8Encoding($false)))

$mutations = @(
  @{
    name  = 'M1: consent falls back to the reopen reader (the original #227 bug)'
    apply = { param($s) $s -replace [regex]::Escape('return [bool](Get-ConsentFacts $trailing).consent_ok'), 'return (Test-TrailingHasUser $trailing)' }
    hook  = 'Consent         = (Get-ConsentFacts $trailing)'
    swap  = 'Consent         = ([pscustomobject]@{ consent_ok = (Test-TrailingHasUser $trailing); reason = "mutated"; human_segments = 0; affirmative_phrase = $null; affirmative_author = $null; affirmative_unattributed = $false; affirmative_answered = $false })'
  },
  @{
    name  = 'M2: unmarked text is attributed to the human (fail OPEN instead of closed)'
    apply = { param($s) $s -replace [regex]::Escape("Author = 'unknown'; Text = `$region"), "Author = `$script:HumanAuthor; Text = `$region" }
  },
  @{
    name  = 'M3: any author satisfies consent (drops the human requirement)'
    apply = { param($s) $s -replace [regex]::Escape('if ($seg.Author -eq $script:HumanAuthor) {'), 'if ($true) {' }
  },
  @{
    name  = 'M4: consent inherits provenance from the region (human spoke somewhere -> any affirmative counts)'
    apply = { param($s) $s -replace [regex]::Escape('if ($seg.Author -eq $script:HumanAuthor) {'), 'if ($result.human_segments -gt 0) {' }
  },
  @{
    name  = 'M5: #272 -- ownership runs to the next MARKER again, so an unmarked agent turn is inherited by the human'
    apply = { param($s) $s -replace [regex]::Escape('if ($h.Index -ge $start -and $h.Index -lt $end) { $cut = $h.Index; break }'), 'if ($false) { $cut = $h.Index; break }' }
  },
  @{
    name  = 'M6: #272 -- the heading clamp swallows the human''s own segment too (over-correction)'
    apply = { param($s) $s -replace [regex]::Escape('if ($h.Index -ge $start -and $h.Index -lt $end) { $cut = $h.Index; break }'), 'if ($h.Index -lt $end) { $cut = $start; break }' }
  },
  @{
    # The arm #320's body originally asked for. It is kept because it is genuinely
    # load-bearing -- but note it is NOT sufficient on its own, which is why M8/M9 exist:
    # the anchor only defends the mid-line case, and real journals quote markers in FENCES,
    # where the marker sits at column 0 and the anchor matches it happily.
    name  = 'M7: #320 -- the line-start anchor is removed, so a marker quoted MID-LINE attributes'
    apply = { param($s) $s -replace [regex]::Escape("`$script:ProvenanceRe  = '(?m)^[ \t]*<!--[ \t]*from:"), "`$script:ProvenanceRe  = '(?m)[ \t]*<!--[ \t]*from:" }
  },
  @{
    # The security half. Neutering the mask makes fenced content live markup again, so the
    # agent's own postmortem (case 953) grants it consent.
    name  = 'M8: #320 -- fenced code is treated as markup again (the agent can approve itself)'
    apply = { param($s) $s -replace [regex]::Escape('function Get-FenceMaskedText([string]$text) {'), 'function Get-FenceMaskedText([string]$text) { return $text' }
  },
  @{
    # The false-negative half, and the one that proves the mask must preserve LENGTH. Masking
    # by deleting fenced spans would shift every offset after the fence; callers substring the
    # ORIGINAL text, so segment boundaries would slide and case 955's approval would be cut
    # apart. This mutation drops the newline-preserving/length-preserving property.
    name  = 'M9: #320 -- the mask stops preserving length, so offsets slide off the real text'
    apply = { param($s) $s -replace [regex]::Escape('[void]$sb.Append('' '', $line.Length)'), '[void]$sb.Append('''')' }
  },
  @{
    # M7's mirror, and the reason M7 alone is not enough. The cheapest way to make M7's
    # mid-line case fail is to anchor harder -- drop the optional indent and demand column 0.
    # That kills M7 while silently discarding every genuine approval written with leading
    # whitespace, which is a false NEGATIVE in the consent gate: Shiv approves and nothing
    # happens. Only case 959 distinguishes the two, so without it the over-anchored build is
    # indistinguishable from the correct one.
    name  = 'M10: #320 crit2 -- the anchor is over-tightened to column 0, so an indented genuine marker is ignored'
    apply = { param($s) $s -replace [regex]::Escape("`$script:ProvenanceRe  = '(?m)^[ \t]*<!--[ \t]*from:"), "`$script:ProvenanceRe  = '(?m)^<!--[ \t]*from:" }
  },
  @{
    # #465's core arm: consumption removed entirely, which is the pre-#465 behaviour. A week-old
    # approval the agent already answered goes back to authorising irreversible actions.
    name  = 'M11: #465 -- an affirmative is never spent, so a served approval authorises forever'
    apply = { param($s) $s -replace [regex]::Escape('$served = @($agentTurnAt | Where-Object { $_ -gt $at }).Count -gt 0'), '$served = $false' }
  },
  @{
    # The over-correction, and the mirror of M11. Spending on ANY agent turn regardless of where
    # it sits kills approvals the agent has not answered -- he approves below a turn and the gate
    # discards it. Only a case with the agent ABOVE the human (965) can see the difference.
    name  = 'M12: #465 -- position is ignored, so an agent turn ABOVE the approval also spends it'
    apply = { param($s) $s -replace [regex]::Escape('Where-Object { $_ -gt $at }'), 'Where-Object { $true }' }
  },
  @{
    # Widening consumption to any machine author. A sibling skill posting on its own schedule
    # would then silently evaporate a live approval -- a false negative that looks exactly like
    # Shiv never answering.
    name  = 'M13: #465 -- ANY author''s turn spends the approval, not just this agent''s'
    apply = { param($s) $s -replace [regex]::Escape('if ($m.Groups[1].Value.Trim() -eq $script:SelfAuthor) { $agentTurnAt += $m.Index }'), 'if ($true) { $agentTurnAt += $m.Index }' }
  },
  @{
    # Detecting only the provenance marker and not the managed heading. This is the arm that
    # matters most in practice: 164 of 244 live journals carry NO provenance marker, so a
    # marker-only rule spends nothing on exactly the journals #465 was filed about.
    name  = 'M14: #465 -- only a provenance marker counts, so an UNSTAMPED agent turn spends nothing'
    apply = { param($s) $s -replace [regex]::Escape("foreach (`$m in [regex]::Matches(`$scan, '(?m)^[ \t]*##[^\r\n]*Overnight Agent')) {"), "foreach (`$m in @()) {" }
  },
  @{
    # Agent-turn detection reading raw text instead of the fence mask. A postmortem that quotes
    # a turn heading inside a fence would then spend the approval sitting above it.
    name  = 'M15: #465 x #320 -- agent turns are located on raw text, so a FENCED heading spends an approval'
    apply = { param($s) $s -replace [regex]::Escape('$scan = Get-FenceMaskedText $trailing
  $agentTurnAt = @()'), '$scan = $trailing
  $agentTurnAt = @()' }
  },
  @{
    # Returning on the first spent affirmative instead of continuing the scan. Re-approval after
    # the agent has replied becomes impossible: the gate hangs closed forever, which is a
    # different bug from the one #465 fixes and would be invisible without case 963.
    name  = 'M16: #465 -- the scan stops at the first spent affirmative, so re-approving never works'
    apply = { param($s) $s -replace [regex]::Escape('        continue
      }
      $result.consent_ok = $true'), '        return [pscustomobject]$result
      }
      $result.consent_ok = $true' }
  }
)

$mutDir = Join-Path $env:TEMP ("oa-consent-mut-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $mutDir -Force | Out-Null
$killed = 0; $survived = 0
try {
  foreach ($m in $mutations) {
    $mutated = & $m.apply $src
    if ($m.hook) { $mutated = $mutated.Replace($m.hook, $m.swap) }
    if ($mutated -eq $src) {
      Write-Host ""
      Write-Host "!! $($m.name): mutation did not apply (anchor text moved) -- treating as SURVIVED"
      $survived++
      continue
    }
    $path = Join-Path $mutDir ("oa-state-" + [guid]::NewGuid().ToString('N').Substring(0, 6) + '.ps1')
    [IO.File]::WriteAllText($path, $mutated, (New-Object Text.UTF8Encoding($false)))
    $f = 0
    try { $f = Test-Cases (Invoke-Scan $path) $m.name }
    catch { $f = 1; Write-Host "  (mutant threw: $($_.Exception.Message))" }
    if ($f -gt 0) { $killed++; Write-Host "  -> KILLED" } else { $survived++; Write-Host "  -> SURVIVED (guard is not load-bearing)" }
  }
}
finally { Remove-Item -Recurse -Force $mutDir -ErrorAction SilentlyContinue }

Write-Host ""
Write-Host "mutations killed $killed / $($killed + $survived)"
if ($survived -gt 0) { exit 1 }
exit 0
