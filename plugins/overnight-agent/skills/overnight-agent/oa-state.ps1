<#
.SYNOPSIS
  Skill-owned memory for the Overnight Agent. Tracks, per task, what the agent has
  already processed in each journal — so a user message appended at the BOTTOM of a
  journal (the natural way the Focus Planner app journals) reliably reopens the task.

.WHY
  The journal .md is the only thing the user touches; it stays pure prose. NO machine
  metadata lives in it. All structured state lives HERE, in the skill's own working dir
  ($env:LOCALAPPDATA\overnight-agent\state), which is local and never OneDrive-synced
  (so it can't hit the planner's sync-conflict bug). The user never sees or edits any of it.

.MODEL
  "Has the USER changed this journal since I last wrote to it?"  ==  reopen.
  We answer it by hashing the journal and remembering the hash the agent left behind:
    - reopened = current-file-hash != processed_file_hash   (the user/app edited it)
    - on first sight of a journal (no state yet), reopened = there is user prose AFTER
      the agent's last block (catches already-reopened tasks like #293 on the first run).
  The agent calls `mark` after it writes its turn, which re-snapshots the hash.

  "The user" means the human, `<!-- from: me -->`, and nothing else. These journals are
  shared: sibling skills (dance-church, instagram-publisher-monitor, kranbox-backup, ...)
  append their own turns with their own `<!-- from: ... -->` stamps. Those are machine
  turns. Counting one as user prose pins the task at `reopened` permanently -- there is no
  human message to answer, and the sibling skill re-appends on its own schedule.

.COMMANDS
  seed   [-Force]                Initialise state for every journal (one-time / migration).
  scan                          Emit the per-run worklist as JSON (what changed / reopened /
                                due_poll).
  get    -Id <id>               Print one task's state JSON.
  consent -Id <id>              Print the CONSENT verdict for one task's journal as it stands
                                now: has the HUMAN provably authorized something? Fail-CLOSED
                                (see .CONSENT below). Ask this before any irreversible action.
  mark   -Id <id> [-Status s] [-Version n] [-PlanId p]
                                Record that the agent has processed the journal as it now
                                stands (re-snapshots processed_file_hash + updates fields).
         [-Poll <cadence>]      Register/update a recurring poll on the task so `scan` surfaces
                                it on a timer even when the journal is untouched. Cadence is one
                                of: hourly | daily | weekly | <N>h | <N>d | <N>m. A freshly
                                registered poll is due immediately (next scan reports due_poll).
         [-PollDone]            Record that the poll just ran: stamp last_polled = now and push
                                next_due forward by the cadence interval.
         [-PollClear]           Remove the poll from the task.
         [-Recheck <cadence>]   Register/update a recurring recheck of a BLOCKED task's
                                prerequisite, so `scan` surfaces it on a timer (due_recheck).
                                Same cadence grammar as -Poll. Freshly armed = due immediately.
         [-RecheckKind <kind>]  Free-text note of WHAT to recheck (e.g. 'oauth', 'ci', 'date',
                                'browser-slot'). Echoed back by scan so a run can pick only the
                                checks it can actually perform. Optional.
         [-RecheckDone]         Record that the recheck just ran: stamp last_rechecked = now and
                                push next_due forward by the cadence interval.
         [-RecheckClear]        Remove the recheck from the task (e.g. once it is unblocked).
  resnapshot                    One-time migration after a change to how journals are decoded
                                or hashed: re-baseline processed_file_hash for tasks with
                                nothing pending. SKIPS any journal with trailing user content,
                                so a real unanswered reply is never baselined away. Never
                                writes to a journal.

.POLLING (why this exists)
  `scan` only flags journals the USER has touched, so a purely time-triggered job (e.g. #400's
  daily "check the video-backup folder and upload any drops") is invisible to it — if the user
  never replies, the agent never gets reminded and the poll silently stops. A poll lives in the
  skill's own state (never in the journal), so the agent can register it once, then every run:
  read `scan`, act on any row with `due_poll: true`, and `mark -PollDone` to re-arm it. The user
  sees nothing about it.

.RECHECKING BLOCKED TASKS (#395 / #400)
  A `blocked` task has the same invisibility problem, for a worse reason: it is waiting on a
  PREREQUISITE, not on the user, so nothing about it will ever change the journal. It therefore
  never appears in a worklist again and parks indefinitely — which is exactly how tasks sat for
  40-59 days. `-Recheck` arms the same timer machinery against the blocker, so `scan` re-surfaces
  the task when its prerequisite is worth re-testing.

  Only blockers with a MACHINE-CHECKABLE prerequisite should be armed (an OAuth token that may
  have been renewed, a CI result that may have gone green, a browser slot that may now be signed
  in, a date that may have arrived). A blocker that needs a human decision must stay a question in
  **Needs from you** — re-asking it on a timer is noise, not progress.

  A due recheck grants NO new permission: it is a read-only look at whether the blocker is gone.
  Acting on the result still obeys the reversibility gate.

.CONSENT (#227 -- why this is NOT the same read as `reopened`)
  Approval for an irreversible action must not be inferable from text the agent can write.
  The journal is a MULTI-WRITER surface: this agent, sibling skills, and the Telegram bridge
  all append to it, and the bridge stamps `<!-- from: me -->` on the human's behalf. So the
  reopen reader's `no marker -> treat as the human` default -- which is CORRECT for reopen,
  because losing a user's message is worse than an extra look -- is exactly wrong as a consent
  boundary: it attributes ANY unmarked prose below the turn-end stamp to the human.

  Hence two readers with opposite defaults:

    reopened   (Test-TrailingHasUser)     FAIL OPEN   unmarked prose counts AS the human
    consent_ok (Test-TrailingHasConsent)  FAIL CLOSED unmarked prose is NOT the human

  Consent requires an affirmative phrase inside a segment POSITIVELY attributed to the human.
  Attribution is positional -- a marker owns the text following it -- so agent text under a
  user's heading cannot inherit the user's provenance. A writer that forgets its marker fails
  closed, which is the guarantee a stamping convention cannot give.

  This is a floor, not the whole story: the marker is still written by software. Carrying
  consent on an identity the agent cannot forge (e.g. the Telegram `from_user` id captured at
  fold time) is the follow-up; this makes the reader stop treating absence as permission.

.SNOOZE PRECEDENCE
  Snooze is the user's explicit "not until <date>", so it outranks both timers: a snoozed task
  reports `due_poll: false` and `due_recheck: false` regardless of how overdue the timer is. The
  timer itself is left untouched and simply fires again once the snooze lapses — snoozing does not
  silently disarm a poll.

.EXAMPLES
  pwsh oa-state.ps1 seed
  pwsh oa-state.ps1 scan
  pwsh oa-state.ps1 get  -Id 293
  pwsh oa-state.ps1 consent -Id 276                    # may I take the irreversible step on #276?
  pwsh oa-state.ps1 mark -Id 305 -Status proposed -Version 1 -PlanId t305-v1
  pwsh oa-state.ps1 mark -Id 400 -Poll daily          # arm a daily poll on #400
  pwsh oa-state.ps1 mark -Id 400 -PollDone            # after running it this run
  pwsh oa-state.ps1 mark -Id 400 -PollClear           # stop polling #400
  pwsh oa-state.ps1 mark -Id 357 -Status blocked -Recheck 12h -RecheckKind ci
  pwsh oa-state.ps1 mark -Id 357 -RecheckDone         # still blocked; re-arm the timer
  pwsh oa-state.ps1 mark -Id 357 -RecheckClear        # prerequisite cleared
#>

[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet('seed', 'scan', 'get', 'mark', 'resnapshot', 'consent')]
  [string]$Command = 'scan',

  [string]$Id,
  [string]$Status,
  [int]$Version,
  [string]$PlanId,
  [switch]$Force,

  # Polling (time-triggered worklist). See .POLLING in the header.
  [string]$Poll,
  [switch]$PollDone,
  [switch]$PollClear,

  # Blocked-task rechecks (time-triggered re-test of a blocker). See .RECHECKING in the header.
  [string]$Recheck,
  [string]$RecheckKind,
  [switch]$RecheckDone,
  [switch]$RecheckClear,

  # Overridable so the skill stays shareable; defaults match user-settings.md.
  [string]$JournalDir = "$env:USERPROFILE\OneDrive\Apps\Focus Planner\journal",
  [string]$StateDir = "$env:LOCALAPPDATA\overnight-agent\state",
  # The board, so `scan` can tell the agent which tasks are currently snoozed
  # (<!-- snooze:YYYY-MM-DD --> markers, from the #353 snooze feature). Sits next to the
  # journal dir by default; override to match a non-standard planner layout.
  [string]$PlannerBoard = "$env:USERPROFILE\OneDrive\Apps\Focus Planner\planner.md",
  # Structured snooze store, written by the Planner web app and read-only here (#391).
  # Preferred over the in-markdown markers above; see Get-SnoozeMap.
  [string]$SnoozeStore = "$env:USERPROFILE\OneDrive\Apps\Focus Planner\snooze.json"
)

$ErrorActionPreference = 'Stop'

function Ensure-StateDir {
  if (-not (Test-Path $StateDir)) { New-Item -ItemType Directory -Path $StateDir -Force | Out-Null }
}

function Get-Sha256([string]$text) {
  # Normalise newlines so OneDrive CRLF/LF churn never looks like a user edit.
  $norm = ($text -replace "`r`n", "`n")
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($norm)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { ($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') }) -join '' }
  finally { $sha.Dispose() }
}

# A journal turn is stamped with a provenance marker, `<!-- from: <author> -->`. Exactly ONE
# author is the human -- `me`. Every other author is a machine: this agent
# (`overnight-agent`) and the sibling skills that also append turns to these same journals
# (`dance-church`, `instagram-publisher-monitor`, `kranbox-backup`, ...).
#
# Markers are matched at the START OF A LINE, because journals legitimately *discuss* these
# markers in prose; a quoted marker must not be mistaken for a real turn boundary.
$script:HumanAuthor   = 'me'
$script:SelfAuthor    = 'overnight-agent'
$script:ProvenanceRe  = '(?m)^[ \t]*<!--[ \t]*from:[ \t]*([^>\r\n]*?)[ \t]*-->'
$script:LegacyStateRe = '(?m)^[ \t]*<!--[ \t]*oa-state'

# --- Consent (#227) --------------------------------------------------------------------
# The affirmative vocabulary SKILL.md tells the agent to read as approval. Kept here, next
# to the provenance markers, because consent is (phrase AND author) and the two halves must
# not drift apart in different files.
#
# Word-bounded on both sides so `go` does not fire inside `going` and `do it` does not fire
# inside `redo it`. Phrase precision is deliberately NOT the subject of #227 -- authorship is
# -- so this list mirrors SKILL.md rather than trying to improve on it.
$script:ConsentAffirmRe = '(?i)(?<![\w-])(approved?|approve it|yes|yep|yeah|go ahead|go for it|go|lgtm|ship it|do it|vibe it|send it|make it so|proceed)(?![\w-])'

# --- The turn terminator ---------------------------------------------------------------
# An HTML comment (invisible when the journal renders) that marks the exact END of this
# agent's turn. `mark` writes it; `Get-AgentEndIndex` trusts it.
#
# WHY IT EXISTS. Without it the end of the agent's turn is found by scanning FORWARD for
# the next `## ` heading, and when the agent's turn is the newest -- the normal state --
# there is no such heading, so the boundary falls to EOF and the WHOLE FILE counts as the
# agent's turn. A reply typed at the bottom with no `## <date>` heading therefore lands
# INSIDE the agent's own turn and is never seen.
#
# That is the dangerous direction. A false "reopened" costs one needless look; a false
# "already answered" silently swallows the user's message with no trace anywhere. It is
# not hypothetical: task #426580 sat for a day with two unanswered questions
# ("were you able to ... create the event in Google calendar?") appended exactly this way,
# and 216 of 239 live journals were in the same shape.
#
# The boundary is genuinely ambiguous from CONTENT alone -- an agent turn may legitimately
# end in a plain prose paragraph, which is indistinguishable from a short human reply. So
# the fix is not a cleverer heuristic; it is to stop guessing and write the boundary down
# at the moment the agent already knows it.
$script:TurnEndMarker = '<!-- /overnight-agent turn-end -->'
$script:TurnEndRe     = '(?m)^[ \t]*<!--[ \t]*/overnight-agent[ \t]+turn-end[ \t]*-->[ \t]*\r?$'

# `### Run log` is SKILL.md's managed heading for this agent's execution record. Only this
# agent writes it, so it is a reliable machine-turn marker even in the many historical
# journals where the agent replied without stamping a `<!-- from: overnight-agent -->`
# provenance marker at all.
#
# The trailing `\r?` is load-bearing: these journals round-trip through OneDrive and the
# planner web app, so CRLF is common. `$` in .NET multiline mode matches before the `\n`,
# which leaves the `\r` unconsumed -- and `[ \t]` does not match `\r`. Without it the
# heading is simply never found on a CRLF file and the whole recovery silently no-ops.
$script:RunLogRe = '(?m)^[ \t]*###[ \t]+Run log[ \t]*\r?$'

# The shape of a run-log body: the heading itself, blank lines, the bold date line
# (`**2026-08-26 (overnight):**`), list items, and indented wrapped continuations.
# Anything else in that region is prose this agent did not write.
$script:RunLogBodyLineRe = '^(?:[ \t\r]*$|[ \t]*###[ \t]+Run log[ \t\r]*$|[ \t]*\*\*.*$|[ \t]*[-*+][ \t].*$|[ \t]*\d+\.[ \t].*$|[ \t]+\S.*$)'

# `## <moon> Overnight Agent` is SKILL.md's managed heading for one of THIS agent's turns.
# Only this agent writes it, so it can never be a user turn -- which makes it a boundary the
# walk in Get-AgentEndIndex must step OVER rather than stop at.
#
# WARNING: match the ASCII phrase, NOT the moon glyph. These journals are UTF-8 with NO BOM,
# Windows PowerShell's default decoding for a BOM-less file is the ANSI codepage -- so the
# same heading arrives as `## <moon> Overnight Agent` in one invocation and as the Latin-1
# mojibake `## AdYS Overnight Agent` in another. A glyph-based pattern therefore matches or
# silently fails depending on how the file happened to be decoded, which is the worst kind of
# bug: it no-ops with exit code 0 and the guard it protects reads clean. `Overnight Agent` is
# pure ASCII, so it is byte-identical under both decodings and cannot drift.
#
# The dated heading the planner app writes above a user reply (`## 2026-08-27`) never
# contains this phrase, so the discrimination stays exact.
$script:ManagedHeadingRe = '^##[^\r\n]*Overnight Agent'

function Get-LastIndexOfPattern([string]$content, [string]$pattern) {
  $idx = -1
  foreach ($m in [regex]::Matches($content, $pattern)) { $idx = $m.Index }
  return $idx
}

function Test-IsRunLogBodyOnly([string]$region) {
  # Is this region nothing but the agent's own run-log entry? Used as a GUARD, so it must
  # answer "no" whenever it is unsure: a false "no" costs one needless look at a settled
  # task, a false "yes" silently swallows the user's message.
  foreach ($line in ($region -split "`r?`n")) {
    if ($line -notmatch $script:RunLogBodyLineRe) { return $false }
  }
  return $true
}

function Get-AgentEndIndex([string]$content) {
  # End offset of THIS agent's last turn: the latest of its own provenance marker, the legacy
  # managed `<!-- oa-state ... -->` block, or the OVERNIGHT-AGENT sentinel. The turn runs
  # until the next `## ` section heading (the following entry) or EOF.
  #
  # NOTE the boundary is deliberately *this agent's* turn, not the last machine turn of any
  # kind. If it were the latter, a sequence of [user reply] -> [sibling skill turn] would put
  # the user's unanswered message ABOVE the boundary and silently swallow it.
  $sentinelMarker = $content.LastIndexOf('OVERNIGHT-AGENT do not edit')
  $selfMarker = -1
  foreach ($m in [regex]::Matches($content, $script:ProvenanceRe)) {
    if ($m.Groups[1].Value.Trim() -eq $script:SelfAuthor) { $selfMarker = $m.Index }
  }

  $markers = @(
    $selfMarker,
    (Get-LastIndexOfPattern $content $script:LegacyStateRe),
    $sentinelMarker
  )
  $agentMarker = ($markers | Measure-Object -Maximum).Maximum
  if ($agentMarker -lt 0) { return -1 }

  # --- The written-down boundary ----------------------------------------------------------
  # If this agent has stamped a turn-end terminator at or after its last anchor, that is
  # where its turn ended. It was written by `mark` at the moment the agent knew the answer,
  # so it needs no inference and cannot be fooled by a turn that happens to end in prose.
  #
  # Taking the LAST such marker is deliberate: a journal accumulates turns, and only the
  # newest terminator describes the current boundary.
  #
  # It is a starting point rather than the final answer, because the agent can append a
  # NEWER turn below it (see the managed-heading walk); a terminator with one of this
  # agent's own turn headings underneath it is simply stale.
  $turnEnd = -1
  foreach ($m in [regex]::Matches($content, $script:TurnEndRe)) {
    if ($m.Index -ge $agentMarker) { $turnEnd = $m.Index + $m.Length }
  }
  if ($turnEnd -ge 0) {
    # Consume the newline that ends the marker line so the trailing region starts clean.
    if ($turnEnd -lt $content.Length -and $content[$turnEnd] -eq "`r") { $turnEnd++ }
    if ($turnEnd -lt $content.Length -and $content[$turnEnd] -eq "`n") { $turnEnd++ }
  }

  # --- Walk past MANAGED headings ---------------------------------------------------------
  # An H2 heading only ends the agent's turn if a *human* could have written it. Two shapes
  # are managed by this agent and must be stepped over instead:
  #
  #   1. `## <moon> Overnight Agent` -- SKILL.md's turn heading. When the agent writes another
  #      turn it opens one of these, so the previous turn's anchor is followed by a heading
  #      that is the agent's OWN newer turn. Stopping there puts that whole turn in the
  #      "trailing" region, where the no-marker branch of Test-TrailingHasUser reads it as
  #      user prose and pins the task at reopened with no message in it to answer.
  #   2. The first H2 after the sentinel, which is that same managed heading in older
  #      journals written before the <moon> convention existed.
  #
  # Anything else -- notably `## 2026-08-27`, the dated heading the planner app writes above
  # a user reply -- is a genuine boundary and stops the walk, so a real reply still reopens.
  #
  # Matching with `(?m)^` rather than IndexOf("`n## ") is load-bearing: after a terminator the
  # search resumes exactly at the start of a line, and a heading sitting flush at that offset
  # has no preceding newline inside the search region for IndexOf to find.
  $from = if ($turnEnd -ge 0) { $turnEnd } else { $agentMarker }
  $boundary = -1
  $sawManaged = $false
  $isFirstHeading = $true
  foreach ($h in [regex]::Matches($content, '(?m)^##[ \t][^\r\n]*')) {
    if ($h.Index -lt $from) { continue }
    $managed = $h.Value -match $script:ManagedHeadingRe
    # Older journals opened the managed block with a heading that predates the naming
    # convention. Only the FIRST heading after the sentinel gets that benefit of the doubt --
    # consuming the allowance here, rather than on the first *unmanaged* heading, is what
    # stops it being spent on the user's `## <date>` reply further down.
    if (-not $managed -and $isFirstHeading -and $turnEnd -lt 0 -and
        $agentMarker -eq $sentinelMarker -and $h.Index -gt $agentMarker) {
      $managed = $true
    }
    $isFirstHeading = $false
    if (-not $managed) { $boundary = $h.Index; break }
    $sawManaged = $true
  }

  if ($boundary -lt 0) {
    # Nothing human below: either the agent's newest managed turn runs to EOF, or the
    # written-down boundary is still the last word.
    if ($sawManaged) { return $content.Length }
    if ($turnEnd -ge 0) { return $turnEnd }
    return $content.Length
  }
  # A terminator with no newer managed turn under it stands: everything below it belongs to
  # whoever wrote it next. (When there IS a newer managed turn, that terminator is stale and
  # the heading boundary below wins instead.)
  if (-not $sawManaged -and $turnEnd -ge 0) { return $turnEnd }
  $end = $boundary

  # --- Unstamped run-log recovery -------------------------------------------------------
  # Most historical journals contain NO `<!-- from: overnight-agent -->` marker: the agent
  # answered the user by appending a `### Run log` under their `## <date>` entry. The
  # boundary above then lands on that user heading, so the agent's own reply sits in the
  # "trailing" region and is mistaken for unanswered user prose -- pinning the journal at
  # HasTrailingUser=true forever. It reads as quiet only while the file is byte-identical to
  # the last snapshot, so any in-place edit by a sibling sweep (a dead-link rewrite, an
  # apostrophe repair) flips `changed` and the task false-reopens with a message that was
  # answered weeks ago.
  #
  # So: if this agent's `### Run log` appears AFTER the boundary, its reply is the newest
  # turn and the boundary belongs after it. Guarded by Test-IsRunLogBodyOnly, which refuses
  # to advance over anything that is not run-log shaped -- so raw user text appended below a
  # run log still reopens the task.
  $runLog = Get-LastIndexOfPattern $content $script:RunLogRe
  if ($runLog -ge $end) {
    $afterRunLog = $content.IndexOf("`n## ", $runLog)
    $regionEnd = if ($afterRunLog -lt 0) { $content.Length } else { $afterRunLog + 1 }
    $region = $content.Substring($runLog, $regionEnd - $runLog)
    if (Test-IsRunLogBodyOnly $region) { return $regionEnd }
  }

  return $end
}

function Test-TrailingHasUser([string]$trailing) {
  # Is there HUMAN content below this agent's last turn? Only the human reopens a task.
  #
  # The trailing region is a chat thread and may mix authors, because sibling skills append
  # their own turns here too. Split it into `## ` entries and judge each one by its marker:
  #   - `<!-- from: me -->`  -> the human spoke. Reopen.
  #   - any other marker     -> a sibling skill's turn. NOT a reopen: there is no message for
  #                             this agent to answer, and that skill re-appends on its own
  #                             schedule, so treating it as user prose pins the task at
  #                             `reopened` forever.
  #   - no marker at all     -> genuinely ambiguous (older journals, hand edits). Treat as the
  #                             human, which is the conservative direction: a false reopen
  #                             costs a look, a missed one loses the user's message.
  if ($trailing.Trim().Length -eq 0) { return $false }

  # Entry boundaries are H2 headings; text before the first heading belongs to the region as-is.
  $entries = [regex]::Split($trailing, '(?m)(?=^## )') | Where-Object { $_.Trim().Length -gt 0 }
  foreach ($entry in $entries) {
    $marks = [regex]::Matches($entry, $script:ProvenanceRe)
    if ($marks.Count -eq 0) { return $true }
    foreach ($m in $marks) {
      if ($m.Groups[1].Value.Trim() -eq $script:HumanAuthor) { return $true }
    }
  }
  return $false
}

# --- Consent authorship (#227) ---------------------------------------------------------
# TWO DIFFERENT QUESTIONS, TWO OPPOSITE DEFAULTS. This is the whole point of #227.
#
#   "Did the user speak?"      -> Test-TrailingHasUser. Unmarked prose counts AS the human.
#                                 FAIL OPEN, because the cost of being wrong is an extra look,
#                                 and the cost of the other error is losing the user's message.
#
#   "Did the human authorize   -> Test-TrailingHasConsent (below). Unmarked prose counts as
#    this irreversible act?"      NOT the human. FAIL CLOSED, because the cost of being wrong
#                                 is an action nobody sanctioned.
#
# Re-using the reopen reader for consent is the P9 violation: `<!-- from: me -->` is written by
# software the agent runs (the Telegram bridge folds phone replies under that marker), and the
# `no marker -> human` default means ANY unmarked text below the turn-end stamp is attributed to
# the human. A crash mid-write, a new sibling skill, or a refactor of write-turn.ps1 that drops
# its stamp all produce text this reader would otherwise read as consent.
#
# The boundary is enforced HERE, in the reader, not by asking every writer to remember to stamp
# itself. A writer that forgets its marker fails closed (its text is `unknown`, which is not the
# human), which is the requirement a convention cannot give.

function Get-AuthorSegments([string]$region) {
  # Split a region into (author, text) segments by provenance marker.
  #
  # Attribution is POSITIONAL, not per-entry: a marker owns the text that FOLLOWS it, up to the
  # next marker. Text before the first marker has no attribution and is reported as 'unknown'.
  #
  # Positional beats per-`## ` entry here because a single heading block can legitimately hold
  # two authors (the agent answering inline under a user's heading). Judging the whole block by
  # "does it contain a human marker anywhere" would let agent-authored text inherit the human's
  # provenance, which is precisely the hole being closed.
  if ($null -eq $region) { return @() }
  $segments = @()
  $marks = [regex]::Matches($region, $script:ProvenanceRe)
  if ($marks.Count -eq 0) {
    if ($region.Trim().Length -gt 0) {
      $segments += [pscustomobject]@{ Author = 'unknown'; Text = $region }
    }
    return $segments
  }

  $preamble = $region.Substring(0, $marks[0].Index)
  if ($preamble.Trim().Length -gt 0) {
    $segments += [pscustomobject]@{ Author = 'unknown'; Text = $preamble }
  }
  for ($i = 0; $i -lt $marks.Count; $i++) {
    $start = $marks[$i].Index + $marks[$i].Length
    $end = if ($i + 1 -lt $marks.Count) { $marks[$i + 1].Index } else { $region.Length }
    $text = $region.Substring($start, $end - $start)
    $segments += [pscustomobject]@{ Author = $marks[$i].Groups[1].Value.Trim(); Text = $text }
  }
  return $segments
}

function Get-ConsentFacts([string]$trailing) {
  # Verdict on whether the trailing region carries HUMAN consent, plus the evidence for it.
  #
  # `consent_ok` is true only when an affirmative phrase sits inside a segment positively
  # attributed to the human. Everything else -- unmarked prose, a sibling skill's turn, the
  # agent's own text, an empty region -- is NOT consent.
  #
  # `affirmative_unattributed` is the smoking gun the issue is about: an approval word that
  # exists but cannot be attributed to the human. It is surfaced rather than silently dropped
  # so a run can tell "nobody approved" apart from "something approved and it wasn't provably
  # you" -- the second is worth reporting, the first is just a quiet task.
  $result = [ordered]@{
    consent_ok               = $false
    human_segments           = 0
    affirmative_phrase       = $null
    affirmative_author       = $null
    affirmative_unattributed = $false
    reason                   = 'no-trailing-content'
  }
  if ([string]::IsNullOrWhiteSpace($trailing)) { return [pscustomobject]$result }

  $segments = @(Get-AuthorSegments $trailing)
  $result.human_segments = @($segments | Where-Object { $_.Author -eq $script:HumanAuthor }).Count

  foreach ($seg in $segments) {
    $m = [regex]::Match($seg.Text, $script:ConsentAffirmRe)
    if (-not $m.Success) { continue }
    if ($seg.Author -eq $script:HumanAuthor) {
      $result.consent_ok = $true
      $result.affirmative_phrase = $m.Value
      $result.affirmative_author = $seg.Author
      $result.reason = 'human-authored-affirmative'
      return [pscustomobject]$result
    }
    # Remember the first non-human affirmative, but keep scanning: a later segment may be the
    # genuine human approval, and finding one must win over having seen a machine one first.
    if (-not $result.affirmative_unattributed) {
      $result.affirmative_unattributed = $true
      $result.affirmative_phrase = $m.Value
      $result.affirmative_author = $seg.Author
    }
  }

  $result.reason = if ($result.affirmative_unattributed) {
    'affirmative-not-attributable-to-human'
  }
  elseif ($result.human_segments -gt 0) { 'human-spoke-but-no-affirmative' }
  else { 'no-human-authored-content' }
  return [pscustomobject]$result
}

function Test-TrailingHasConsent([string]$trailing) {
  return [bool](Get-ConsentFacts $trailing).consent_ok
}

function Parse-LegacyOaState([string]$content) {
  # Read the LAST in-journal oa-state JSON, if any, to bootstrap status on migration.
  $m = [regex]::Matches($content, 'oa-state\s*\r?\n\s*(\{.*?\})\s*\r?\n\s*-->', 'Singleline')
  if ($m.Count -eq 0) { return $null }
  try { return ($m[$m.Count - 1].Groups[1].Value | ConvertFrom-Json) } catch { return $null }
}

function Read-JournalText([string]$path) {
  # ALWAYS decode journals as UTF-8, explicitly. Never `Get-Content -Raw`.
  #
  # These journals are UTF-8 with NO BOM, and the default decoder is host-dependent: Windows
  # PowerShell 5.1 falls back to the ANSI codepage, PowerShell 7 defaults to UTF-8. So the
  # SAME journal read by `Get-Content -Raw` yields different strings depending on which host
  # is running -- an em-dash arrives as one character under pwsh and as three under
  # powershell.exe.
  #
  # Two concrete harms, both observed live:
  #   1. CORRUPTION. Add-TurnTerminator does a read-modify-write. Under 5.1 it read mojibake
  #      and wrote it back as UTF-8, making the damage permanent. task-448.md lost 593 lines
  #      of correct text this way (1,487 sequences, damaged twice) before this was found.
  #   2. PHANTOM CHANGES. The processed_file_hash is computed from this string, so a journal
  #      hashed under one host and re-hashed under the other looks edited when nothing
  #      touched it -- which reads as the user having replied.
  #
  # Encoding is part of the read, not an ambient setting to inherit.
  if (-not (Test-Path $path)) { return '' }
  return [IO.File]::ReadAllText($path, (New-Object Text.UTF8Encoding($false)))
}

function Get-JournalFacts([string]$path) {
  $content = Read-JournalText $path
  if ($null -eq $content) { $content = '' }
  $id = [System.IO.Path]::GetFileNameWithoutExtension($path) -replace '^task-', ''
  $agentEnd = Get-AgentEndIndex $content
  $hasAgentBlock = $agentEnd -ge 0
  if ($agentEnd -lt 0) { $agentEnd = 0 }
  $agentLeft = $content.Substring(0, [Math]::Min($agentEnd, $content.Length))
  $trailing = if ($agentEnd -lt $content.Length) { $content.Substring($agentEnd) } else { '' }
  [pscustomobject]@{
    Id              = $id
    Path            = $path
    HasAgentBlock   = $hasAgentBlock
    FullHash        = Get-Sha256 $content
    AgentLeftHash   = Get-Sha256 $agentLeft     # file as the agent last left it (no trailing user prose)
    HasTrailingUser = (Test-TrailingHasUser $trailing)
    Consent         = (Get-ConsentFacts $trailing)   # #227: fail-CLOSED authorship verdict
    Trailing        = $trailing
    Legacy          = Parse-LegacyOaState $content
  }
}

function State-Path([string]$id) { Join-Path $StateDir "task-$id.json" }

function Read-State([string]$id) {
  $p = State-Path $id
  if (Test-Path $p) { return (Get-Content -Raw $p | ConvertFrom-Json) }
  return $null
}

function Write-State($obj) {
  Ensure-StateDir
  ($obj | ConvertTo-Json -Depth 6) | Set-Content -Path (State-Path $obj.id) -Encoding UTF8
}

function Now-Iso { (Get-Date).ToString('yyyy-MM-ddTHH:mm:ssK') }

function Set-Member($obj, [string]$name, $value) {
  # PSCustomObjects from ConvertFrom-Json can't take a new property via `$o.x = ...`; add it.
  if ($obj.PSObject.Properties[$name]) { $obj.$name = $value }
  else { $obj | Add-Member -NotePropertyName $name -NotePropertyValue $value }
}

function Parse-PollMinutes([string]$spec) {
  # Cadence -> interval in minutes. Accepts hourly|daily|weekly|<N>h|<N>d|<N>m (case-insensitive).
  switch -regex ($spec.Trim().ToLower()) {
    '^hourly$' { return 60 }
    '^daily$' { return 1440 }
    '^weekly$' { return 10080 }
    '^(\d+)\s*h$' { return [int]$Matches[1] * 60 }
    '^(\d+)\s*d$' { return [int]$Matches[1] * 1440 }
    '^(\d+)\s*m$' { return [int]$Matches[1] }
    default { throw "invalid cadence '$spec' (use hourly|daily|weekly|<N>h|<N>d|<N>m)" }
  }
}

function New-PollObject([string]$cadence, [int]$minutes, [string]$lastPolled, [datetime]$nextDue) {
  [pscustomobject]@{
    cadence          = $cadence
    interval_minutes = $minutes
    last_polled      = $lastPolled
    next_due         = $nextDue.ToString('yyyy-MM-ddTHH:mm:ssK')
  }
}

function New-RecheckObject([string]$cadence, [int]$minutes, [string]$kind, [string]$lastRechecked, [datetime]$nextDue) {
  # Same timer shape as a poll (so Test-PollDue serves both), plus `kind` so a run can select
  # only the rechecks it is actually able to perform this pass.
  [pscustomobject]@{
    cadence          = $cadence
    interval_minutes = $minutes
    kind             = $kind
    last_rechecked   = $lastRechecked
    next_due         = $nextDue.ToString('yyyy-MM-ddTHH:mm:ssK')
  }
}

function Test-PollDue($poll) {
  # A poll with no next_due (freshly armed / malformed) is treated as due now.
  if (-not $poll) { return $false }
  if (-not $poll.next_due) { return $true }
  try { return ([datetime]::Parse($poll.next_due) -le (Get-Date)) }
  catch { return $true }
}

function Cmd-Seed {
  Ensure-StateDir
  $journals = Get-ChildItem $JournalDir -Filter 'task-*.md' -File | Where-Object { $_.BaseName -match '^task-\d+$' }
  $n = 0
  foreach ($f in $journals) {
    $facts = Get-JournalFacts $f.FullName
    if ((Read-State $facts.Id) -and -not $Force) { continue }
    $legacy = $facts.Legacy
    # Snapshot the hash of the file AS THE AGENT LAST LEFT IT (excludes any trailing user
    # prose). For a reopened task like #293 this differs from the current full hash, so the
    # very next `scan` correctly reports it reopened. Settled tasks have no trailing prose,
    # so AgentLeftHash == FullHash and they read as quiet.
    $state = [pscustomobject]@{
      id                  = $facts.Id
      status              = if ($legacy) { "$($legacy.status)" } elseif ($facts.HasAgentBlock) { 'unknown' } else { 'none' }
      version             = if ($legacy -and $legacy.version) { [int]$legacy.version } else { 0 }
      plan_id             = if ($legacy) { "$($legacy.plan_id)" } else { '' }
      processed_file_hash = $facts.AgentLeftHash
      has_agent_block     = $facts.HasAgentBlock
      seeded              = $true
      updated             = Now-Iso
    }
    Write-State $state
    $n++
  }
  Write-Output "seeded $n task state file(s) into $StateDir"
}

function Test-SnoozeActive {
  # A task counts as snoozed while its date is today or later, so the agent holds off
  # *through* the snooze date and only re-engages the day after. Errs toward respecting
  # the user's snooze rather than acting a day early. Returns the date, or $null.
  param([string]$Raw)
  if (-not $Raw) { return $null }
  $d = [datetime]::MinValue
  $ok = [datetime]::TryParseExact(
    $Raw.Trim(), 'yyyy-MM-dd',
    [System.Globalization.CultureInfo]::InvariantCulture,
    [System.Globalization.DateTimeStyles]::None, [ref]$d)
  if ($ok -and $d.Date -ge (Get-Date).Date) { return $Raw.Trim() }
  return $null
}

function Get-SnoozeFromStore {
  # snooze.json — the structured store the Planner web app owns (#391). Agent is READ-ONLY.
  # Shape: a flat map of task id -> ISO date, optionally wrapped:
  #   { "270": "2026-08-15" }              or   { "tasks":  { "270": "2026-08-15" } }
  #   { "snoozed": { "270": "..." } }      or   { "270": { "until": "2026-08-15" } }
  # Preferred over the in-markdown markers because it is typed, tiny, and does not ride on
  # planner.md — the most sync-conflicted, human-edited file in the folder. Parsing prose is
  # also where the markers bite: a task whose *title* contains "snooze:" (e.g. #391 itself)
  # will fool any regex that isn't strict about the <!-- --> wrapper.
  $map = @{}
  if (-not (Test-Path $SnoozeStore)) { return $null }   # $null = "no store", so fall back
  try {
    # Decode explicitly as UTF-8, for the same reason journals are (see Read-JournalText):
    # `Get-Content -Raw` takes its decoder from the host, so a snooze store holding any
    # non-ASCII character reads differently under powershell 5.1 and pwsh 7. This also keeps
    # the `oa-state/no-bare-raw-journal-read` capability honest rather than merely quiet.
    $raw = [IO.File]::ReadAllText($SnoozeStore, (New-Object Text.UTF8Encoding($false)))
    if ([string]::IsNullOrWhiteSpace($raw)) { return $map }
    $json = $raw | ConvertFrom-Json -ErrorAction Stop
  } catch {
    # A malformed store must never take the whole scan down, and must never be read as
    # "nothing is snoozed" — that would silently un-snooze every task. Fall back instead.
    Write-Warning "oa-state: could not parse $SnoozeStore ($($_.Exception.Message)); falling back to planner.md markers"
    return $null
  }
  foreach ($wrapper in 'tasks', 'snoozed') {
    if ($json.PSObject.Properties.Name -contains $wrapper -and $json.$wrapper) { $json = $json.$wrapper; break }
  }
  foreach ($prop in $json.PSObject.Properties) {
    if ($prop.Name -notmatch '^\d+$') { continue }        # ignore metadata keys like "version"
    $val = $prop.Value
    if ($val -isnot [string]) { $val = $val.until }        # tolerate { "until": "..." } objects
    $active = Test-SnoozeActive ([string]$val)
    if ($active) { $map[$prop.Name] = $active }
  }
  return $map
}

function Get-SnoozeFromBoard {
  # Legacy path: `<!-- snooze:YYYY-MM-DD -->` HTML comments stamped onto planner.md rows by
  # the #353 feature. Kept as a migration fallback so nothing breaks the day snooze.json
  # lands and old markers keep working until the web app switches over.
  $map = @{}
  if (-not (Test-Path $PlannerBoard)) { return $map }
  foreach ($line in (Get-Content -Path $PlannerBoard)) {
    # Board rows look like: | 327 | 🟡 | Task… | P1 | 2026-07-20 | 353 | <!-- snooze:2026-08-18 -->
    if ($line -notmatch '^\s*\|\s*(\d+)\s*\|') { continue }
    $tid = $Matches[1]
    # The <!-- --> wrapper is REQUIRED. Without it a task titled "snooze: …" matches its own
    # title and hides itself from the board — the concrete failure mode behind #391.
    if ($line -match '<!--\s*snooze:(\d{4}-\d{2}-\d{2})\s*-->') {
      $active = Test-SnoozeActive $Matches[1]
      if ($active) { $map[$tid] = $active }
    }
  }
  return $map
}

function Get-SnoozeMap {
  # Build id -> snooze-until (yyyy-MM-dd) for tasks that are CURRENTLY snoozed.
  # Order: snooze.json (structured, web-app-owned) wins; planner.md markers fill the gaps.
  # The union is deliberate — during migration some tasks live in one store and some in the
  # other, and dropping either would silently un-snooze tasks the user asked to hide.
  $board = Get-SnoozeFromBoard
  $store = Get-SnoozeFromStore
  if ($null -eq $store) { return $board }   # no store yet, or unreadable → legacy behaviour
  $merged = @{}
  foreach ($k in $board.Keys) { $merged[$k] = $board[$k] }
  foreach ($k in $store.Keys) { $merged[$k] = $store[$k] }   # store wins on conflict
  return $merged
}

function Cmd-Scan {
  $snooze = Get-SnoozeMap
  $journals = Get-ChildItem $JournalDir -Filter 'task-*.md' -File | Where-Object { $_.BaseName -match '^task-\d+$' } | Sort-Object Name
  $rows = foreach ($f in $journals) {
    $facts = Get-JournalFacts $f.FullName
    $st = Read-State $facts.Id
    $poll = $null
    $recheck = $null
    if ($st) {
      $changed = ($facts.FullHash -ne $st.processed_file_hash)
      $reopened = $changed -and $facts.HasTrailingUser
      $status = "$($st.status)"
      if ($st.PSObject.Properties['poll']) { $poll = $st.poll }
      if ($st.PSObject.Properties['recheck']) { $recheck = $st.recheck }
    }
    else {
      # No memory yet: a task is "reopened/active" only if the user has left prose below the
      # agent's last block; otherwise it's genuinely new (no agent block) -> propose.
      $changed = $true
      $reopened = $facts.HasTrailingUser
      $status = if ($facts.HasAgentBlock) { 'unknown' } else { 'none' }
    }
    $snoozeUntil = if ($snooze.ContainsKey($facts.Id)) { $snooze[$facts.Id] } else { $null }
    # Snooze is the user's explicit "not until <date>", so it outranks both timers. Suppress the
    # DUE verdict only -- the timer object itself is left armed, so it fires again on its own once
    # the snooze lapses rather than being silently disarmed by it.
    $isSnoozed = [bool]$snoozeUntil
    [pscustomobject]@{
      id            = $facts.Id
      status        = $status
      changed       = $changed
      reopened      = $reopened
      has_agent_block = $facts.HasAgentBlock
      tracked       = [bool]$st
      snoozed       = $isSnoozed
      snooze_until  = $snoozeUntil
      due_poll      = [bool]((Test-PollDue $poll) -and -not $isSnoozed)
      poll_cadence  = if ($poll) { "$($poll.cadence)" } else { $null }
      due_recheck   = [bool]((Test-PollDue $recheck) -and -not $isSnoozed)
      recheck_cadence = if ($recheck) { "$($recheck.cadence)" } else { $null }
      recheck_kind  = if ($recheck) { "$($recheck.kind)" } else { $null }
      # #227: does the trailing region carry consent the HUMAN provably authored? Distinct from
      # `reopened`, which counts unmarked prose as the user on purpose. Never infer approval for
      # an irreversible action from `reopened` -- read this instead.
      consent_ok    = [bool]$facts.Consent.consent_ok
      consent_reason = "$($facts.Consent.reason)"
    }
  }
  $rows | ConvertTo-Json -Depth 4
}

function Cmd-Get {
  if (-not $Id) { throw 'get requires -Id' }
  $st = Read-State $Id
  if (-not $st) { Write-Output "{}"; return }
  $st | ConvertTo-Json -Depth 6
}

function Cmd-Consent {
  # #227: the consent channel, read fail-CLOSED. Ask this BEFORE any irreversible action.
  #
  # Deliberately a separate command rather than a field on `get`: consent is a property of the
  # journal as it stands RIGHT NOW, not of the stored state. Reading it from state would let a
  # stale `status: approved` -- which the agent itself wrote -- stand in for the user's word,
  # which is the same self-authored-consent hole one level up.
  if (-not $Id) { throw 'consent requires -Id' }
  $path = Join-Path $JournalDir "task-$Id.md"
  if (-not (Test-Path $path)) {
    [pscustomobject]@{
      id = $Id; consent_ok = $false; reason = 'journal-not-found'; path = $path
    } | ConvertTo-Json -Depth 4
    return
  }
  $facts = Get-JournalFacts $path
  $c = $facts.Consent
  [pscustomobject]@{
    id                       = $facts.Id
    consent_ok               = [bool]$c.consent_ok
    reason                   = "$($c.reason)"
    human_segments           = [int]$c.human_segments
    affirmative_phrase       = $c.affirmative_phrase
    affirmative_author       = $c.affirmative_author
    affirmative_unattributed = [bool]$c.affirmative_unattributed
    # `reopened` uses the opposite default on purpose; both are reported so the difference is
    # visible at the call site instead of being a footnote in a comment.
    trailing_has_user        = [bool]$facts.HasTrailingUser
    path                     = $facts.Path
  } | ConvertTo-Json -Depth 4
}

function Add-TurnTerminator([string]$path) {
  # Stamp the end of this agent's turn, so a reply typed below it can never be absorbed
  # into the turn (see $script:TurnEndMarker for why).
  #
  # APPEND-ONLY, deliberately. The terminator is written only when the agent's turn already
  # runs to EOF -- the exact shape that is blind today. When there IS trailing content below
  # the turn, the `## ` heading already provides a working boundary and we do not need a
  # marker, so we do not reach into the middle of the user's file to insert one. A journal in
  # that state heals itself the next time the agent appends a turn, because that turn lands
  # at EOF and this runs again.
  #
  # Returns $true if the file was modified.
  #
  # The read MUST be Read-JournalText, not `Get-Content -Raw`. This is a read-modify-write on
  # one of the user's files, so a wrong decode here does not merely misread -- it re-encodes
  # the misreading and writes it back, destroying the original characters. See the note on
  # Read-JournalText for the 593 lines this cost before it was pinned.
  $content = Read-JournalText $path
  if ($null -eq $content) { $content = '' }
  if ($content.Length -eq 0) { return $false }

  $agentEnd = Get-AgentEndIndex $content
  if ($agentEnd -lt 0) { return $false }          # no agent block yet -- nothing to terminate
  if ($agentEnd -lt $content.Length) { return $false }  # boundary already exists below the turn

  # Already terminated? Then Get-AgentEndIndex returned the marker's end, which is only equal
  # to the file length when the marker is the last thing in the file -- nothing to do.
  if ([regex]::IsMatch($content, $script:TurnEndRe)) {
    $last = $null
    foreach ($m in [regex]::Matches($content, $script:TurnEndRe)) { $last = $m }
    if ($null -ne $last -and $content.Substring($last.Index).Trim() -eq $script:TurnEndMarker) { return $false }
  }

  $nl = if ($content.Contains("`r`n")) { "`r`n" } else { "`n" }
  $out = $content.TrimEnd() + $nl + $nl + $script:TurnEndMarker + $nl
  [IO.File]::WriteAllText($path, $out, (New-Object Text.UTF8Encoding($false)))
  return $true
}

function Cmd-Resnapshot {
  # One-time migration: re-record processed_file_hash for tasks that have NOTHING pending.
  #
  # Why this is needed. The hash is computed from the decoded journal text, so any change to
  # HOW the journal is decoded changes every hash at once -- even though not one byte on disk
  # moved. Pinning the decoder to UTF-8 (see Read-JournalText) is exactly such a change: the
  # first scan afterwards reports every non-ASCII journal as `changed`, and each one that has
  # trailing prose then reports `reopened`. That is a queue flood of phantom replies.
  #
  # The guard is the whole point: a journal with trailing USER content is SKIPPED. Those are
  # the ones that might hold a real unanswered message, and re-snapshotting one would mark it
  # answered -- silently, with no trace. Quiet journals are safe to re-baseline because there
  # is nothing under the agent's turn to lose.
  #
  # Idempotent, and it never writes to a journal -- only to the state store.
  $journals = Get-ChildItem $JournalDir -Filter 'task-*.md' -File |
    Where-Object { $_.BaseName -match '^task-\d+$' } | Sort-Object Name
  $updated = 0; $skipped = 0; $untracked = 0
  foreach ($f in $journals) {
    $facts = Get-JournalFacts $f.FullName
    $st = Read-State $facts.Id
    if (-not $st) { $untracked++; continue }
    if ($facts.FullHash -eq $st.processed_file_hash) { continue }
    if ($facts.HasTrailingUser) {
      # Something is below the agent's turn. Leave it visible rather than baselining over it.
      $skipped++
      continue
    }
    $st.processed_file_hash = $facts.FullHash
    $st.has_agent_block = $facts.HasAgentBlock
    $st.updated = Now-Iso
    Write-State $st
    $updated++
  }
  [pscustomobject]@{
    rebaselined       = $updated
    left_for_review   = $skipped
    untracked         = $untracked
  } | ConvertTo-Json -Depth 4
}

function Cmd-Mark {
  if (-not $Id) { throw 'mark requires -Id' }
  $path = Join-Path $JournalDir "task-$Id.md"
  if (-not (Test-Path $path)) { throw "no journal at $path" }
  # Stamp the turn boundary BEFORE snapshotting, so the hash recorded below describes the
  # file as it now stands on disk. Doing it after would record a hash the file no longer has
  # and every subsequent scan would report a phantom change.
  [void](Add-TurnTerminator $path)
  $facts = Get-JournalFacts $path
  $st = Read-State $Id
  if (-not $st) {
    $st = [pscustomobject]@{ id = $Id; status = 'unknown'; version = 0; plan_id = ''; processed_file_hash = ''; has_agent_block = $true; seeded = $false; updated = $null }
  }
  if ($Status) { $st.status = $Status }
  if ($Version -gt 0) { $st.version = $Version }
  if ($PlanId) { $st.plan_id = $PlanId }

  # --- Polling -------------------------------------------------------------------
  $existingPoll = if ($st.PSObject.Properties['poll']) { $st.poll } else { $null }
  if ($PollClear) {
    Set-Member $st 'poll' $null
  }
  elseif ($Poll) {
    # (Re)arm: due immediately so the very next scan picks it up.
    $mins = Parse-PollMinutes $Poll
    Set-Member $st 'poll' (New-PollObject $Poll.Trim().ToLower() $mins '' (Get-Date))
  }
  elseif ($PollDone) {
    if (-not $existingPoll) { throw "task $Id has no poll to mark done (arm one with -Poll first)" }
    $mins = [int]$existingPoll.interval_minutes
    Set-Member $st 'poll' (New-PollObject "$($existingPoll.cadence)" $mins (Now-Iso) (Get-Date).AddMinutes($mins))
  }

  # --- Blocked-task rechecks (#395) ----------------------------------------------
  # Same timer machinery as a poll, aimed at the BLOCKER rather than at recurring work, so a
  # blocked task re-enters the worklist on a cadence instead of parking forever.
  $existingRecheck = if ($st.PSObject.Properties['recheck']) { $st.recheck } else { $null }
  if ($RecheckClear) {
    Set-Member $st 'recheck' $null
  }
  elseif ($Recheck) {
    # (Re)arm: due immediately so the very next scan picks it up.
    $rmins = Parse-PollMinutes $Recheck
    $kind = if ($RecheckKind) { $RecheckKind.Trim() } elseif ($existingRecheck) { "$($existingRecheck.kind)" } else { '' }
    Set-Member $st 'recheck' (New-RecheckObject $Recheck.Trim().ToLower() $rmins $kind '' (Get-Date))
  }
  elseif ($RecheckDone) {
    if (-not $existingRecheck) { throw "task $Id has no recheck to mark done (arm one with -Recheck first)" }
    $rmins = [int]$existingRecheck.interval_minutes
    $kind = if ($RecheckKind) { $RecheckKind.Trim() } else { "$($existingRecheck.kind)" }
    Set-Member $st 'recheck' (New-RecheckObject "$($existingRecheck.cadence)" $rmins $kind (Now-Iso) (Get-Date).AddMinutes($rmins))
  }
  elseif ($RecheckKind -and $existingRecheck) {
    # Retag an armed recheck without disturbing its timer.
    Set-Member $st 'recheck' (New-RecheckObject "$($existingRecheck.cadence)" ([int]$existingRecheck.interval_minutes) $RecheckKind.Trim() "$($existingRecheck.last_rechecked)" ([datetime]::Parse($existingRecheck.next_due)))
  }

  # Re-snapshot: the agent has now processed the journal as it currently stands.
  $st.processed_file_hash = $facts.FullHash
  $st.has_agent_block = $facts.HasAgentBlock
  $st.updated = Now-Iso
  Write-State $st
  $st | ConvertTo-Json -Depth 6
}

switch ($Command) {
  'seed' { Cmd-Seed }
  'scan' { Cmd-Scan }
  'get' { Cmd-Get }
  'mark' { Cmd-Mark }
  'resnapshot' { Cmd-Resnapshot }
  'consent' { Cmd-Consent }
}
