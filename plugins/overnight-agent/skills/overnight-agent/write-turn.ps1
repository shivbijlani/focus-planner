<#
  write-turn.ps1 -- the sanctioned way to write an Overnight Agent turn into a journal.

  WHY THIS EXISTS
  ---------------
  Shiv, 2026-08-27 on task #448:
    "is there a way to fix this in a way [that is] programmatic forward - that way things
     are codified a bit, instead of being written up in a skill?"

  `user-settings.md` opens with a 70-line banner titled "STOP -- how you WRITE a journal
  turn". It documents four ways a turn gets silently corrupted on the way to disk. Every
  one of them was found only AFTER it had destroyed real content, and three of the four
  are still only prose plus an after-the-fact detector -- nothing PREVENTS them.

  This script is the prevention. Same pattern as `run-telegram-mirror.ps1`, which was
  written because "a prose warning in this file was not enough" after the same mistake
  was made three times in one day. A rule you can still break is a rule that will be
  broken; a rule the tool refuses to let you break is finished.

  THE FOUR GUARDS, and what each one already cost
  ----------------------------------------------
  G1 lost-interpolation -- markdown built in a PowerShell DOUBLE-quoted string. `$150` is
     not a variable, so it expands to nothing and `~$150-275` lands as `~\-275`. Values
     are DELETED and the surrounding prose still reads confidently.
     Cost: 12 journals; #247 (investment research with no numbers) and #377 (a shortlist
     Shiv was asked to pick from, every price missing) are unrecoverable.

  G2 doubled apostrophe -- markdown built in a PowerShell SINGLE-quoted string. `''` is
     the escape for one `'`, so re-quoted text lands as `don''t`. Text gets LONGER and
     leaves no tombstone, which is why G1's detector structurally cannot see it.
     Cost: 50 occurrences across #207, #252, #297, #371, #392, #397.

  G3 Telegram heading anchor -- the bridge anchors on /^##\s*<moon>/, so the moon must
     follow `##` IMMEDIATELY. A date-first heading is not an anchor, the parser anchors
     earlier, and the turn is cut at its own heading.
     Cost: 5,405 of 10,557 characters dropped from the #448 turn at 17:00 on 2026-08-26,
     and again at 12:10 the same day. Twice in one day, both times after it was written
     down.

  G4 stray provenance marker -- a bare `<!-- from: overnight-agent -->` with no `## `
     heading above it inside the block is not a chat entry, it is a stray stamp. The
     bridge breaks the block there and discards the `Needs from you:` / `Your call:`
     underneath, disabling the digest's own safety net.
     Cost: 26 journals left with an inert fallback; #308's ask was invisible on every
     surface at once from 2026-08-10.

  DESIGN NOTES
  ------------
  * APPEND ONLY. It never rewrites or deletes existing content, so it physically cannot
    eat one of Shiv's replies. Replacing the managed block is the genuinely dangerous
    operation -- journals are a bottom-appended chat, so his newest message lives below
    the agent block, and a naive "replace from sentinel to EOF" would delete it. That is
    deliberately not built here.
  * The body must come from a FILE, authored with a file tool. That is the point: if the
    turn never passes through a PowerShell string, G1 and G2 cannot happen at all. The
    guards are the backstop for when it does.
  * The moon is built from its codepoint rather than pasted literally. This file is read
    by Windows PowerShell 5.1, which mis-decodes non-BMP literals in a UTF-8 file without
    a BOM -- the same class of encoding bug that made a sweep report a false zero on
    2026-08-25.

  THE POINTER GUARDS (G9-G11), and why they are scoped rather than global
  ----------------------------------------------------------------------
  G1-G8 all ask "did this text survive the trip to disk?". G9-G11 ask a different question,
  added for #425: once a task HAS a catch-up doc, is this turn still trying to be the doc?

  Measured on the live journals 2026-09-03: `task-468.md` carries 28 agent turns averaging
  5,305 chars (largest 9,094); `task-451.md` 23 averaging 4,354. Corpus-wide, 395 journals
  and 5.36 MB. Journals sit on the per-run read path, which is why #291 exists and why
  `oa-state.ps1 extract` has to cap a read at ~24 KB. That caps the symptom; this is the
  cause.

  ARMED ONLY BY #423's `<!-- doc-meta ... -->` STAMP, read from the TARGET journal. A task
  with no doc is untouched -- byte for byte the same behaviour as before. This is the same
  opt-in #424 used on the Telegram half, and it is deliberate: a silent global change to how
  every turn is written is exactly the kind of edit that gets discovered by its damage.

  Three guards rather than one, because they fail differently and a single "too long" verdict
  would hide two of them:

  G9  size ceiling -- the wall of detail this issue exists to remove.
  G10 the pointer must POINT. A short turn that never names the doc is strictly worse than
      the long turn it replaced: the narrative is gone from the journal AND unreachable from
      it. This is the failure mode most worth guarding, because it reads perfectly.
  G11 the ask must still be IN THE JOURNAL. The Telegram digest lifts asks out of the newest
      agent turn (`extractAskEntry` in digest.js). Moving the ask into the doc blinds the
      approval queue -- `user-settings.md` records that happening at scale already: 148 open
      asks, 17 shown, 131 unnamed. The ask is duplicated, never moved.

  WHY G11 REFUSES WHERE A5 ONLY WARNS. A5 (below) is advisory precisely because informational
  turns legitimately ask for nothing. That reasoning does not survive #424: a doc-bound task's
  Telegram topic now posts NOTHING per turn, so a doc-bound turn carrying no readable ask
  reaches no surface at all. Same text, different blast radius. `-DisableGuard G11` is the
  hatch for a genuinely informational turn.

  Usage:
    write-turn.ps1 -Id 448 -BodyFile turn.md            # validate, back up, append
    write-turn.ps1 -Id 448 -BodyFile turn.md -Validate  # validate only, write nothing
    write-turn.ps1 -BodyFile turn.md -Validate          # lint any turn text

  Exit codes: 0 ok - 2 guard violation (nothing written) - 3 bad arguments.
#>
[CmdletBinding()]
param(
  [string]$Id,
  [Parameter(Mandatory = $true)][string]$BodyFile,
  [string]$JournalDir = 'C:\Users\shiv\OneDrive\Apps\Focus Planner\journal',
  [switch]$Validate,
  [switch]$Json,
  # Test hooks: named guards to disable, so a mutation check can prove each one is
  # load-bearing rather than decorative. Never pass this in production.
  [string[]]$DisableGuard = @()
)

$ErrorActionPreference = 'Stop'

$MOON = [char]::ConvertFromUtf32(0x1F319)

# --- #425 pointer-turn thresholds ----------------------------------------------------
# REFUSE at 1500, NUDGE at 800. Both numbers are measured rather than chosen.
#
# The refusal has to sit ABOVE the shape the issue asks for, or the guard refuses its own
# target and gets switched off. The first real pointer turn -- task 468, 2026-09-03 -- is
# 902 chars, of which roughly 250 are structure that is not prose and cannot be shortened:
# the moon heading, the provenance marker, a Google Docs URL (a bare docId is 44 chars
# before the /edit), and the turn-end stamp. A hard 800 would have refused it.
#
# 1500 still refuses everything this issue is about: the mean agent turn on task 468 is
# 5,305 chars and on 451 is 4,354, and 21 of 28 turns on 468 individually exceed Telegram's
# own 4,096-char message limit. The gap between 902 and 1500 is headroom for a longer URL
# or status line, not licence for a narrative.
#
# The nudge is where the issue's own target lives, so the author is aimed at 800 by the
# tool while the refusal stays where it cannot produce a false positive.
$POINTER_CEILING = 1500
$POINTER_NUDGE   = 800

# #423's binding stamp. Kept character-for-character in step with `$script:DocMetaRe` in
# oa-state.ps1 -- this guard's entire job is to predict what that reader will conclude, and
# a stricter or looser pattern here would arm the guard on a task the rest of the system
# considers unbound (or vice versa).
$DocMetaRe = '<!--\s*doc-meta\s+docId=(?<id>[A-Za-z0-9_\-]+)(?:\s+docUrl=(?<url>\S+))?\s*-->'

# Where this script keeps its backups and where `oa-state.ps1` keeps its state. Overridable
# ONLY so G12 can be proven hermetically: its recency evidence lives in both places, and a
# guard whose evidence can only be produced by writing into the real OA home is a guard that
# cannot be tested in CI - which is how it ends up unverified (#461's lesson, applied here
# before it bites rather than after).
$OA_HOME = if ($env:WRITE_TURN_OA_HOME) { $env:WRITE_TURN_OA_HOME } else { Join-Path $env:LOCALAPPDATA 'overnight-agent' }

# --- #473 one-turn-per-wake ------------------------------------------------------------
# A managed agent turn heading. Deliberately the SAME shape oa-state.ps1's ManagedHeadingRe
# matches and the Telegram bridge anchors on, so all three agree on what a turn is; a looser
# pattern here would let a heading that nothing else considers a turn spend the wake.
$script:ManagedTurnRe = '^[ \t]*##[^\r\n]*(' + [regex]::Escape($MOON) + '|Overnight Agent)'

# How long a written turn owns its wake. Sized against the schedule, not against a run: the
# agent wakes every 30 minutes, so a window at or below 30 would let two CONSECUTIVE wakes
# each add a turn to a thread he has not replied to, which is the stacking #425 exists to
# remove. 45 covers the cadence with margin while staying far short of the next night, so a
# genuinely new day is never blocked. A reply from him clears it immediately at any age.
$WAKE_WINDOW_MIN = [int]($env:WRITE_TURN_WAKE_WINDOW_MIN | ForEach-Object { if ($_) { $_ } else { 45 } })

function Get-FenceMaskedText([string]$text) {
  # Blank out fenced regions, preserving line count and line endings, so a `doc-meta` shown
  # INSIDE a fenced example is not read as this task's real binding.
  #
  # This is #320's rule and oa-state.ps1's `Get-DocMetaFromJournal` already applies it for
  # exactly this reason. It matters more than it looks: the turn that DOCUMENTS this feature
  # necessarily quotes the stamp format, and a journal whose only `doc-meta` is such a
  # quotation would otherwise arm all three guards on a task that has no doc at all.
  if (-not $text) { return '' }
  $lines = $text -split "(`r?`n)"
  $fence = $false
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match "^`r?`n$") { continue }
    if ($lines[$i] -match '^[ \t]*```') { $fence = -not $fence; $lines[$i] = ' ' * $lines[$i].Length; continue }
    if ($fence) { $lines[$i] = ' ' * $lines[$i].Length }
  }
  return ($lines -join '')
}

function Get-JournalDocMeta([string]$path) {
  # READ ONLY, and read from the JOURNAL -- never from state, never written back. #423 owns
  # the binding; #424 was explicit that a second store of "which doc does this task have" is
  # the thing not to build, and the same applies here.
  if (-not $path -or -not (Test-Path -LiteralPath $path)) { return $null }
  $content = [IO.File]::ReadAllText((Resolve-Path -LiteralPath $path))
  $m = [regex]::Match((Get-FenceMaskedText $content), $DocMetaRe)
  if (-not $m.Success) { return $null }
  [pscustomobject]@{
    doc_id  = $m.Groups['id'].Value
    doc_url = if ($m.Groups['url'].Success) { $m.Groups['url'].Value } else { '' }
  }
}

function Get-WakeTurnFinding([string]$journalPath, [string]$taskId, [int]$WindowMin) {
  # G12 -- ONE TURN PER WAKE (GH #473). The only guard here that is a property of the
  # DESTINATION rather than of the text, which is why it cannot live in Test-TurnBody.
  #
  # THE DEFECT. Task #466 received two `## <moon>` turns four minutes apart, both describing
  # the same merged PR and DISAGREEING - one claimed five fixes, one implied six, and one
  # carried a wrong timestamp. Both were written by the agent: the task sub-session reported,
  # and the run session recorded the outcome, because SKILL.md PHASE 1 step 6 assigns the
  # second job while the gh-issue-work contract assigns the first. #404 moved WORK into
  # per-task sessions and never assigned TURN AUTHORSHIP to exactly one side.
  #
  # Every existing guard passed, and necessarily so: G1-G11 are all properties of one turn in
  # isolation, and this script is append-only by design, so it cannot notice it is the second
  # writer. The failure therefore scales with CORRECTNESS - it fires precisely when both
  # halves do their job.
  #
  # THE RULE, and both halves are load-bearing:
  #   structure : the newest managed turn has NO human content after it, so another turn
  #               would stack on top of an unanswered one. Alone this is too strict - the
  #               agent legitimately writes on consecutive nights while Shiv says nothing.
  #   recency   : that turn was written inside the wake window. Alone this is too strict the
  #               other way - it would refuse a turn that ANSWERS a reply he just made.
  # A human reply un-spends the token, and so does time. That is #465's spent-affirmative
  # shape: spentness is derived, not asserted, and it is released by evidence.
  #
  # RECENCY SURVIVES A FORGOTTEN `mark`, which is the whole lesson of #465. `last_turn_at` is
  # stamped by `oa-state.ps1 mark`, so a run that writes a turn and never marks would leave it
  # stale and the second turn would sail through - fail OPEN, on the exact stamp the writer
  # might skip. So the backup this script writes on EVERY append is consulted too, and the
  # newer of the two wins. A backup cannot be forgotten without also not writing the turn.
  if (-not $journalPath -or -not (Test-Path -LiteralPath $journalPath)) { return $null }
  $content = [IO.File]::ReadAllText((Resolve-Path -LiteralPath $journalPath))
  $scan = Get-FenceMaskedText $content

  $sentinel = $scan.LastIndexOf('OVERNIGHT-AGENT do not edit')
  if ($sentinel -lt 0) { return $null }
  $managed = $scan.Substring($sentinel)
  $offset = $sentinel

  # Newest managed turn heading, and newest human marker, in the managed region.
  $lastTurn = -1
  foreach ($m in [regex]::Matches($managed, '(?m)^[ \t]*##[ \t][^\r\n]*')) {
    if ($m.Value -match $script:ManagedTurnRe) { $lastTurn = $m.Index }
  }
  if ($lastTurn -lt 0) { return $null }

  $lastHuman = -1
  foreach ($m in [regex]::Matches($managed, '(?m)^[ \t]*<!--[ \t]*from:[ \t]*me[ \t]*-->[ \t]*$')) {
    $lastHuman = $m.Index
  }
  # He has spoken since the last turn -> the wake is answered and a reply is welcome.
  if ($lastHuman -gt $lastTurn) { return $null }

  # --- is the existing turn THIS wake's? -------------------------------------------------
  # The precise token first. `session.last_woken_at` is stamped when this task's session is
  # woken for a run, so a turn written at or after it belongs to THIS wake and a turn written
  # before it belongs to a previous one. That is the per-wake token #473 asked for, and it
  # needs no window at all.
  #
  # WHY THE WINDOW ALONE WAS WRONG, measured on live data within an hour of shipping it: the
  # agent wakes every 30 minutes, so ANY window wide enough to span one wake's two writers is
  # also wide enough to swallow the next legitimate wake. A 45-minute window refused this very
  # task's next turn at 41 minutes - a real new wake with real new work, blocked. Comparing
  # against the wake boundary makes the two cases distinguishable instead of trading one
  # false positive for the other.
  #
  # The window survives as a FALLBACK for a task whose state has no wake stamp yet (a fresh
  # install, or the state loss #423 exists to survive), where the boundary is unknown and
  # something is better than nothing.
  $written = $null
  $wokenAt = $null
  $statePath = Join-Path $OA_HOME "state\task-$taskId.json"
  if (Test-Path -LiteralPath $statePath) {
    try {
      $st = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
      if ($st.PSObject.Properties['last_turn_at'] -and $st.last_turn_at) {
        $written = [datetime]::Parse("$($st.last_turn_at)", [Globalization.CultureInfo]::InvariantCulture)
      }
      if ($st.PSObject.Properties['session'] -and $st.session -and
          $st.session.PSObject.Properties['last_woken_at'] -and $st.session.last_woken_at) {
        $wokenAt = [datetime]::Parse("$($st.session.last_woken_at)", [Globalization.CultureInfo]::InvariantCulture)
      }
    }
    catch { $written = $null; $wokenAt = $null }
  }
  # The backup trail, which this script writes itself: task-<id>.bak-yyyyMMdd-HHmm.md.
  # Consulted because `last_turn_at` is stamped by `oa-state.ps1 mark`, so keying only on it
  # would fail OPEN on exactly the stamp a writer might skip (#465). A backup cannot be
  # forgotten without also not writing the turn. Minute-resolution, so it is floored to the
  # minute on both sides of any comparison below.
  $bakDir = $OA_HOME
  if (Test-Path -LiteralPath $bakDir) {
    foreach ($f in Get-ChildItem -LiteralPath $bakDir -Filter "task-$taskId.bak-*.md" -ErrorAction SilentlyContinue) {
      $m = [regex]::Match($f.Name, 'bak-(\d{8})-(\d{4})\.md$')
      if (-not $m.Success) { continue }
      try {
        $t = [datetime]::ParseExact($m.Groups[1].Value + $m.Groups[2].Value, 'yyyyMMddHHmm', [Globalization.CultureInfo]::InvariantCulture)
        if ($null -eq $written -or $t -gt $written) { $written = $t }
      }
      catch { continue }
    }
  }
  if ($null -eq $written) { return $null }

  $ageMin = ((Get-Date) - $written).TotalMinutes
  if ($null -ne $wokenAt) {
    # Backup stamps are minute-resolution, so compare on whole minutes or a turn written in
    # the same minute the session woke reads as older than the wake and slips through.
    $w = $written.AddSeconds(-$written.Second).AddMilliseconds(-$written.Millisecond)
    $k = $wokenAt.AddSeconds(-$wokenAt.Second).AddMilliseconds(-$wokenAt.Millisecond)
    if ($w -lt $k) { return $null }   # the turn predates this wake - a new turn is the first
    $why = 'a turn for THIS wake already exists'
  }
  else {
    if ($ageMin -ge $WindowMin) { return $null }
    $why = 'a turn was written {0:N0} min ago and this task has no wake stamp to compare against' -f $ageMin
  }

  $line = ($content.Substring(0, [Math]::Min($content.Length, $offset + $lastTurn)) -split "`r?`n").Count
  $head = (($managed.Substring($lastTurn) -split "`r?`n")[0]).Trim()
  New-Finding 'G12' $line $head (
    ('{0} ({1:N0} min ago, nothing from him since). ' -f $why, $ageMin) +
    'The task sub-session owns the turn; the run session must not also write one (#473). ' +
    'If you are deliberately replacing a turn you just wrote, pass -DisableGuard G12.')
}

function New-Finding([string]$guard, [int]$line, [string]$snippet, [string]$why) {
  [pscustomobject]@{ guard = $guard; line = $line; snippet = $snippet; why = $why }
}

<#
  Strip inline code spans before testing for the two QUOTATION classes (G1, G2).

  This is not a convenience -- it is the discriminator that makes the guards usable, and
  it is copied deliberately from `lib-lost-interpolation.mjs`, which established it
  against the live corpus rather than by argument. Its reasoning applies verbatim here:
  "Real damage sits in prose and table cells, never inside backticks", and "a detector
  that flags its own postmortem is a detector that gets switched off."

  Proven the first time this script was run for real: the #448 turn ANNOUNCING these
  guards was refused by them, because it necessarily quotes `~\-275` and `don''t` as
  examples of what they catch. A tool that cannot write the document explaining itself
  would simply be bypassed.

  ⚠️ KNOWN BLIND SPOT, stated rather than hidden. The interpolation defect does damage
  text inside code spans too -- #249 carried `.1338/kWh` where `$0.1338/kWh` was meant.
  Code spans use no markdown escaping, so no `\` tombstone is left and the deletion is
  perfectly silent; nothing can see it from the text alone. The nightly
  `lost-interpolation-sweep` carries the same limitation and documents the recovery
  route: the task's own deliverable file, which is written by a different code path and
  survives intact.
#>
function Remove-CodeSpans([string]$line) {
  return ($line -replace '`[^`]*`', ' ')
}

<#
  A5 (ADVISORY, never blocking) -- can the digest actually READ an ask out of this turn?

  The four guards above all ask "did this text survive the trip to disk?". None of them
  asks the question that actually decides whether Shiv ever SEES the turn's request:
  does it carry an ask in one of the dialects `lib-live-ask.mjs` understands?

  Added 2026-08-27, immediately after the run that fixed a marker bug in that very library
  nearly shipped its own turn with the ask lines formatted `*Reply:* **`merge 198`**`.
  `liveAsk`'s dialects are `Needs from you:` -> ``Reply `x` `` -> `Next:` -> `Your call:`;
  `Reply:*` matches none of them, because the colon defeats `Reply\s+`. That turn would
  have gone to disk fully guard-clean and carrying NO parseable ask -- reproducing the
  exact defect the run had just fixed, inside the fix's own turn. It was caught only by
  running `liveAsk` against the draft by hand.

  DELIBERATELY A WARNING, NOT A GUARD. Informational turns legitimately ask for nothing,
  so refusing them would be wrong. It also must not change what this script DOES: 90
  minutes before this was written, a safety writer made stricter silently broke an
  invariant three other components depended on. So this only ever prints, and never
  touches the exit code or the bytes written.
#>
function Test-TurnAsk([string]$Body) {
  $lines = $Body -split "`r?`n"
  foreach ($l in $lines) {
    if ($l -match '^\s*\*{0,2}Needs from you\b[^:]*:\*{0,2}\s*\S') { return $true }
    if ($l -match '^\s*\*{0,2}Next:\*{0,2}\s*\S')                  { return $true }
    if ($l -match '^\s*\*{0,2}Your call:\*{0,2}\s*\S')             { return $true }
    if ($l -match '(?:^|\s)Reply\s+`[^`]+`')                       { return $true }
  }
  return $false
}

function Test-TurnBody {
  param([string]$Body, [string[]]$Disabled = @(), $Doc = $null)

  $findings = @()
  $lines = $Body -split "`r?`n"
  $on = { param($g) return ($Disabled -notcontains $g) }

  # A fenced block is a verbatim quotation of something else -- sample markdown, a
  # transcript, a command. None of the four guards applies to its contents, and G3 in
  # particular would fire on any fenced example of a bad heading.
  $inFence = New-Object bool[] $lines.Count
  $fence = $false
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match '^[ \t]*```') { $fence = -not $fence; $inFence[$i] = $true; continue }
    $inFence[$i] = $fence
  }

  # --- G1: lost-interpolation tombstones ------------------------------------------
  # An eaten `$nnn` leaves the escape that preceded it stranded against the surviving
  # half of the range: `~$150-275` -> `~\-275`. Also `\-520` (eaten low end), and bold
  # values that leave no backslash at all -- `****` and `~**,035**`.
  if (& $on 'G1') {
    for ($i = 0; $i -lt $lines.Count; $i++) {
      if ($inFence[$i]) { continue }
      $l = Remove-CodeSpans $lines[$i]
      foreach ($pat in @('~\\-\d', '(?<![\\`])\\-\d{2,}', '\*\*\*\*', '~\*\*,\d')) {
        if ($l -match $pat) {
          $findings += New-Finding 'G1' ($i + 1) $lines[$i].Trim() `
            'looks like a value was eaten by PowerShell string interpolation (a `$` expanded to nothing)'
          break
        }
      }
    }
  }

  # --- G2: doubled apostrophe -----------------------------------------------------
  # `letter''letter` is never valid markdown -- emphasis uses * or _ -- so flagging it
  # mechanically is safe.
  if (& $on 'G2') {
    for ($i = 0; $i -lt $lines.Count; $i++) {
      if ($inFence[$i]) { continue }
      if ((Remove-CodeSpans $lines[$i]) -match "[A-Za-z]''[A-Za-z]") {
        $findings += New-Finding 'G2' ($i + 1) $lines[$i].Trim() `
          "a doubled apostrophe (don''t) -- PowerShell single-quote escaping survived into the text"
      }
    }
  }

  # --- G3: Telegram heading anchor ------------------------------------------------
  # Every H2 in an agent turn must be moon-first, or the bridge anchors earlier and
  # truncates the turn at this heading.
  if (& $on 'G3') {
    for ($i = 0; $i -lt $lines.Count; $i++) {
      if ($inFence[$i]) { continue }
      $l = $lines[$i]
      if ($l -match '^[ \t]*##[ \t]+\S' -and $l -notmatch '^[ \t]*###') {
        $after = ($l -replace '^[ \t]*##[ \t]+', '')
        if (-not $after.StartsWith($MOON)) {
          $findings += New-Finding 'G3' ($i + 1) $l.Trim() `
            "an H2 in an agent turn must start with the moon immediately after '##', or the Telegram bridge truncates the turn here"
        }
      }
    }
  }

  # --- G4: stray provenance marker ------------------------------------------------
  # A provenance stamp is only a chat entry when an H2 heading precedes it. A bare one
  # severs the block and hides the ask underneath.
  if (& $on 'G4') {
    $seenHeading = $false
    for ($i = 0; $i -lt $lines.Count; $i++) {
      if ($inFence[$i]) { continue }
      $l = $lines[$i]
      if ($l -match '^[ \t]*##[ \t]+\S' -and $l -notmatch '^[ \t]*###') { $seenHeading = $true; continue }
      if ($l -match '^[ \t]*<!--[ \t]*from:[ \t]*overnight-agent[ \t]*-->' -and -not $seenHeading) {
        $findings += New-Finding 'G4' ($i + 1) $l.Trim() `
          'a provenance stamp with no "## " heading above it severs the agent block and hides the ask below it'
      }
    }
  }

  # --- G5: the turn must be anchorable at all -------------------------------------
  # G3 validates every H2 that IS present, but never required one. A body with no
  # moon-anchored H2 is not a turn the bridge can see: `latestAgentTurn()` anchors on
  # /^##\s*<moon>/, so the text is folded into the PREVIOUS turn instead of starting a
  # new one. The previous turn's hash changes, the bridge reposts it, and the new turn
  # has no heading of its own on any surface.
  #
  # Found 2026-08-27 by hitting it: a turn was written body-first (Status/Context/prose,
  # no heading), every one of G1-G4 read clean, and it went to disk unanchorable. This is
  # the same cost G3 exists to prevent -- G3 just could not see the case where the anchor
  # is missing rather than malformed. Same shape as the two library bugs recorded this
  # week: a guard on the malformed case is not a guard on the absent case.
  #
  # A refusal rather than an advisory, deliberately: unlike "this turn carries no ask"
  # (which informational turns do legitimately), there is no legitimate agent turn
  # without a heading -- the bridge structurally requires one. `-DisableGuard G5` remains
  # the escape hatch for linting a fragment.
  if (& $on 'G5') {
    $anchored = $false
    for ($i = 0; $i -lt $lines.Count; $i++) {
      if ($inFence[$i]) { continue }
      $l = $lines[$i]
      if ($l -match '^[ \t]*##[ \t]+\S' -and $l -notmatch '^[ \t]*###') {
        $after = ($l -replace '^[ \t]*##[ \t]+', '')
        if ($after.StartsWith($MOON)) { $anchored = $true; break }
      }
    }
    if (-not $anchored) {
      $findings += New-Finding 'G5' 1 (($lines | Where-Object { $_.Trim() } | Select-Object -First 1)) `
        "this turn has no '## <moon> ...' heading, so the Telegram bridge cannot anchor it -- it would be folded into the previous turn instead of starting a new one"
    }
  }

  # --- G7: the turn must stamp its own provenance ---------------------------------
  # A `## <moon> ...` heading with no `<!-- from: overnight-agent -->` beneath it is what
  # broke the CONSENT gate (#272). `Get-AuthorSegments` attributes text positionally, so a
  # turn that inserts no marker of its own is inherited by whoever spoke last -- and when
  # that is the user, the agent's own prose is read back as the user's approval.
  #
  # Measured live 2026-08-30 on #442: the reader treated 15,473 chars as human-authored;
  # Shiv's share was one question, and the other 15,400 chars were an unmarked agent turn
  # containing `approve`, `approved` and `yes` x2. `consent_ok` came back TRUE. Across all
  # 238 journals, 114 newest turns carried no marker and 5 were in that trapped shape.
  #
  # This is G4's exact inverse: G4 catches a marker with no heading above it, G7 catches a
  # heading with no marker below it. Both sever attribution; only this one fails OPEN.
  #
  # A refusal, not an injection: the marker is the evidence the gate rests on, and silently
  # manufacturing evidence is the wrong instinct for a safety guard even when the guess would
  # be right. `Add-TurnTerminator` cannot repair this after the fact either (it declines to
  # stamp once the boundary sits below the turn), so the only place it can be fixed is here,
  # before the write.
  if (& $on 'G7') {
    for ($i = 0; $i -lt $lines.Count; $i++) {
      if ($inFence[$i]) { continue }
      $l = $lines[$i]
      if ($l -notmatch '^[ \t]*##[ \t]+\S' -or $l -match '^[ \t]*###') { continue }
      if (-not (($l -replace '^[ \t]*##[ \t]+', '').StartsWith($MOON))) { continue }

      # Scan forward for this heading's marker, stopping at the next H2 -- a marker that
      # belongs to a LATER heading must not satisfy this one.
      $stamped = $false
      for ($k = $i + 1; $k -lt $lines.Count; $k++) {
        if ($inFence[$k]) { continue }
        $n = $lines[$k]
        if ($n -match '^[ \t]*##[ \t]+\S' -and $n -notmatch '^[ \t]*###') { break }
        if ($n -match '^[ \t]*<!--[ \t]*from:[ \t]*overnight-agent[ \t]*-->') { $stamped = $true; break }
      }
      if (-not $stamped) {
        $findings += New-Finding 'G7' ($i + 1) $l.Trim() `
          'this turn has no "<!-- from: overnight-agent -->" under its heading, so the consent reader attributes it to whoever spoke last -- the agent''s own words can then be read back as the user''s approval (#272)'
      }
    }
  }

  # --- G8: a provenance marker inside a fenced block ------------------------------
  # THE WRITER AND THE READER DISAGREE ABOUT WHETHER A FENCE IS MARKUP, AND THE READER
  # WINS. Every guard above skips `$inFence` lines, because to a writer a fenced block is
  # a sample, not markup. `oa-state.ps1`'s consent reader has no fence concept at all:
  #
  #   $script:ProvenanceRe = '(?m)^[ \t]*<!--[ \t]*from:[ \t]*([^>\r\n]*?)[ \t]*-->'
  #
  # Inside a fence the sample sits at column 0, so `^` matches it and it is read as a LIVE
  # attribution. The anchor is present and correct; it is simply not a fence check.
  #
  # Measured 2026-09-01 against the DEPLOYED reader, no regex modified. An agent postmortem
  # about attribution, containing a fenced ```markdown block whose body is the marker and
  # the word `yes`, with NO human speaking anywhere in the journal:
  #
  #   A: fenced `<!-- from: me -->`      + yes  -> consent_ok=TRUE   human-authored-affirmative
  #   B: fenced `<!-- from: some-agent -->` + yes -> consent_ok=false  (control)
  #
  # B is the half that proves it: flipping only the marker INSIDE the fence flips the
  # verdict, so the fence is being parsed as live markup rather than quoted text.
  #
  # WHY THIS IS A WRITER GUARD. The durable fix is in the reader -- it should strip fences
  # before segmenting authorship, the way `parseJournalChat` already strips HTML comments
  # (tracked as #320). But the reader is the component that decides whether the agent may
  # take irreversible actions, and editing it unreviewed is a worse risk than this one.
  # The agent controls the ONLY path that arms this: writing such a fence into a journal.
  # Closing that path here needs no change to the gate, and cannot weaken it -- a guard
  # that only ever refuses can make consent stricter, never looser.
  #
  # This is deliberately the #317 shape: fix the writer, leave the fail-closed reader alone.
  #
  # Live corpus at the time of writing: 389 journals, ZERO fenced provenance markers -- so
  # nothing has been mis-approved. It has not fired only because no agent has yet written
  # this shape into a journal, and writing up #320 is precisely that act.
  # `docs/spec/Data-Formats.md:89` already contains the shape verbatim, inert only because a
  # spec file is not a journal; an agent quoting that spec into a postmortem arms it.
  #
  # Escape hatch is `-DisableGuard G8`, but prefer rewriting the sample: inline code
  # (`` `<!-- from: me -->` ``) is not at column 0 after the backtick, so it stays inert and
  # still reads correctly to a human.
  if (& $on 'G8') {
    for ($i = 0; $i -lt $lines.Count; $i++) {
      if (-not $inFence[$i]) { continue }
      # Match the READER's pattern exactly -- this guard's whole job is to predict it.
      if ($lines[$i] -match '^[ \t]*<!--[ \t]*from:[ \t]*[^>\r\n]*?[ \t]*-->') {
        $findings += New-Finding 'G8' ($i + 1) $lines[$i].Trim() `
          'a provenance marker at the start of a fenced line is read as a LIVE attribution by the consent gate (it has no fence concept), so this sample can forge human consent for the text after it (#320) -- use inline code instead of a fenced block'
      }
    }
  }

  # --- G9/G10/G11: the pointer guards (#425) --------------------------------------
  # All three are armed ONLY by a doc-meta stamp on the target journal. `$Doc` is null for
  # a task with no catch-up doc and for `-Validate` with no `-Id`, and every one of these
  # is skipped -- so this cannot become a silent global change to how turns are written.
  if ($Doc) {
    $len = $Body.Trim().Length

    # G9 -- the wall of detail itself.
    if (& $on 'G9') {
      if ($len -gt $POINTER_CEILING) {
        $findings += New-Finding 'G9' 1 "$len chars" (
          "this task has a catch-up doc, so a turn is a POINTER, not the story: $len chars is over the " +
          "$POINTER_CEILING ceiling (aim for ~$POINTER_NUDGE). Move the narrative, tables and evidence into " +
          'the doc and amend it in place; leave behind the status, the doc link, a sentence or two, and the ask')
      }
    }

    # G10 -- A POINTER THAT DOES NOT POINT.
    # A short turn that never names the doc is strictly WORSE than the long turn it replaced:
    # the detail has left the journal and there is nothing in the journal that leads to it.
    # It also reads perfectly, which is why it needs a machine to catch it.
    #
    # The docId is the token, not the URL: every legitimate link to the doc contains it
    # (a Google Docs URL is .../document/d/<docId>/edit), so this accepts a bare id, a raw
    # URL and a markdown link, and rejects only a turn that mentions no route to the doc at
    # all. Matched against the RAW body -- a link inside a fenced block is still a link a
    # reader can follow, and this guard is about reachability, not about markup.
    if (& $on 'G10') {
      $names = $false
      if ($Doc.doc_id -and $Body.Contains($Doc.doc_id)) { $names = $true }
      if (-not $names -and $Doc.doc_url -and $Body.Contains($Doc.doc_url)) { $names = $true }
      if (-not $names) {
        $findings += New-Finding 'G10' 1 ("docId=" + $Doc.doc_id) (
          'this turn is a pointer with nothing to point at -- it never links the catch-up doc it is ' +
          'summarising, so the detail has left the journal and cannot be reached from it. Include the doc ' +
          'URL (or its id) in the turn')
      }
    }

    # G11 -- the ask stays in the JOURNAL, duplicated rather than moved.
    # `extractAskEntry` (digest.js) reads the ask out of the NEWEST agent turn, so an ask
    # that lives only in the doc is invisible to the approval digest. Since #424 a doc-bound
    # task's Telegram topic also posts nothing per turn, so there is no second surface left
    # to carry it: the ask would reach nobody.
    #
    # Dialects deliberately identical to Test-TurnAsk (A5) -- one definition of "an ask the
    # digest can read", so a turn cannot be advisory-clean and guard-dirty at once.
    if (& $on 'G11') {
      if (-not (Test-TurnAsk -Body $Body)) {
        $findings += New-Finding 'G11' 1 '(no ask marker)' (
          'this task has a catch-up doc, and a doc-bound task posts nothing per turn to Telegram (#424) -- ' +
          'so an ask that is not in this turn reaches no surface at all. Keep the ask in the journal ' +
          '(duplicate it into the doc, never move it): "**Needs from you:** ...", "Reply `word`", ' +
          '"**Next:** ..." or "**Your call:** ...". Use -DisableGuard G11 for a genuinely informational turn')
      }
    }
  }

  return $findings
}

# --- entry point -------------------------------------------------------------------
if (-not (Test-Path -LiteralPath $BodyFile)) {
  Write-Error "body file not found: $BodyFile"; exit 3
}
$body = [IO.File]::ReadAllText((Resolve-Path -LiteralPath $BodyFile))
if ($body.Trim().Length -eq 0) { Write-Error 'body file is empty'; exit 3 }

# Resolve the target journal HERE rather than after validation, because the pointer guards
# (#425) are a property of the destination, not of the text: whether a turn may be a
# summary depends on whether the task it is being written to has somewhere to summarise
# INTO. `-Validate` with an `-Id` therefore gets the same verdict as the real write, which
# is the only way a validate step is worth running.
#
# No `-Id` (linting a fragment) or a journal that does not exist yet -> $doc stays null and
# G9-G11 are inert, exactly like a task with no doc.
$journal = if ($Id) { Join-Path $JournalDir "task-$Id.md" } else { $null }
$doc = if ($journal) { Get-JournalDocMeta $journal } else { $null }

# HOST-DEPENDENT COUNT (found 2026-08-27, by hitting it)
# --------------------------------------------------------
# `Test-TurnBody` returns 0, 1 or many findings. Under Windows PowerShell 5.1 a SINGLE
# returned object is a scalar, and a scalar PSCustomObject has no `.Count` -- it evaluates
# to $null, so `$findings.Count -gt 0` is FALSE and the refusal below is skipped entirely.
# pwsh 7 added `.Count` to every object, so it refuses correctly there.
#
# Every invocation in SKILL.md and user-settings.md is `powershell` (5.1). Net effect: a
# body with EXACTLY ONE guard violation printed "clean", exited 0, and was WRITTEN -- and
# one violation is the common case. All four guards were unenforced in production for it,
# while reading green anywhere the checks run under 7. Same 5.1-vs-7 split already recorded
# for `Get-Content -Raw` on a journal (HAZARD 4); it applies to the safety tool itself.
#
# `@(...)` forces an array on both hosts, so `.Count` is 0/1/n everywhere.
$findings = @(Test-TurnBody -Body $body -Disabled $DisableGuard -Doc $doc)

# G12 is appended here rather than inside Test-TurnBody because it is the one guard that is a
# property of the DESTINATION, not of the text: the same body is fine on a fresh wake and a
# duplicate on a spent one. `-Validate` sees it too, so a validate step gives the same verdict
# as the real write - which is the only thing that makes validating worth doing.
if ($Id -and ($DisableGuard -notcontains 'G12')) {
  $wake = Get-WakeTurnFinding $journal $Id $WAKE_WINDOW_MIN
  if ($wake) { $findings = @($findings) + @($wake) }
}
$findings = @($findings)
$hasAsk = Test-TurnAsk -Body $body

if ($Json) {
  [pscustomobject]@{
    ok       = ($findings.Count -eq 0)
    findings = @($findings)
    hasAsk   = $hasAsk
    id       = $Id
    docBound = [bool]$doc
    docId    = if ($doc) { $doc.doc_id } else { '' }
    length   = $body.Trim().Length
  } | ConvertTo-Json -Depth 5
} else {
  if ($findings.Count -gt 0) {
    Write-Host "[write-turn] REFUSED - $($findings.Count) guard violation(s); nothing written." -ForegroundColor Red
    foreach ($f in $findings) {
      Write-Host ("  {0} line {1}: {2}" -f $f.guard, $f.line, $f.why)
      Write-Host ("      | {0}" -f $f.snippet)
    }
  }
  # Advisory only. Printed even on refusal, because a turn being rewritten to clear a
  # guard is exactly when its ask line is most likely to be reformatted by accident.
  if (-not $hasAsk) {
    Write-Host '[write-turn] NOTE - this turn carries no ask the digest can read.' -ForegroundColor Yellow
    Write-Host '      Fine for an informational turn. If it is meant to ask for something,'
    Write-Host '      use one of: "**Needs from you:** ...", "Reply `word`", "**Next:** ...",'
    Write-Host '      or "**Your call:** ...". A bare "*Reply:* **`word`**" is NOT read as an ask.'
  }
  # The #425 target, as a nudge rather than a refusal. G9's ceiling is where a turn stops
  # being defensible; this is where it stops being a pointer. Keeping them apart is what
  # lets the ceiling be loose enough never to refuse a legitimate turn while the author is
  # still aimed at the number the issue actually asked for.
  if ($doc -and $findings.Count -eq 0 -and $body.Trim().Length -gt $POINTER_NUDGE) {
    Write-Host ("[write-turn] NOTE - {0} chars; this task has a catch-up doc, so aim under ~{1}." -f $body.Trim().Length, $POINTER_NUDGE) -ForegroundColor Yellow
    Write-Host '      The narrative belongs in the doc (amended in place). The turn keeps the status,'
    Write-Host '      the doc link, a sentence or two, and the ask.'
  }
}

if ($findings.Count -gt 0) { exit 2 }

if ($Validate) {
  if (-not $Json) { Write-Host '[write-turn] clean (validate only - nothing written).' -ForegroundColor Green }
  exit 0
}

if (-not $Id) { Write-Error '-Id is required unless -Validate is set'; exit 3 }

if (-not (Test-Path -LiteralPath $journal)) { Write-Error "journal not found: $journal"; exit 3 }

# Back up before touching it. Cheap, and every repair this codebase has made started
# from one of these.
#
# The directory is created rather than assumed. `-ErrorActionPreference Stop` turns a missing
# backup dir into a THROWN write -- so on a machine where %LOCALAPPDATA%\overnight-agent does
# not exist yet (a fresh install, or the state loss #423 exists to survive) the turn is not
# merely un-backed-up, it is never written at all.
$stamp  = Get-Date -Format 'yyyyMMdd-HHmm'
$bakDir = $OA_HOME
New-Item -ItemType Directory -Path $bakDir -Force | Out-Null
Copy-Item -LiteralPath $journal -Destination (Join-Path $bakDir "task-$Id.bak-$stamp.md") -Force

$existing = [IO.File]::ReadAllText($journal)
# Match the file's own newline style: these journals round-trip through OneDrive and the
# planner web app, so a mixed-ending file is routine and CRLF is common.
$nl  = if ($existing -match "`r`n") { "`r`n" } else { "`n" }
$sep = if ($existing.EndsWith("`n")) { $nl } else { $nl + $nl }

# G6 missing sentinel -- the Telegram bridge gates EVERY task on
# `hasAgentBlock()`, which is a literal search for the sentinel line below
# (`journal.js`). No sentinel means the bridge skips the task outright: no
# topic, no post, no digest entry. The turn is written perfectly to disk and
# is simply never delivered to the surface Shiv actually reads.
#
# This script had no concept of the sentinel, so a journal whose FIRST turn it
# wrote was born invisible. Found 2026-08-30 on #451 ("Report hit and run") --
# a red Today task carrying a statutory 4-day filing deadline, whose packet had
# been written and had reached nobody. A sweep of all 239 journals found 7 in
# this shape.
#
# Append-only, like the rest of this script: when the marker is absent we emit
# it immediately above the new turn, which opens the managed block here and
# leaves every byte above untouched.
$sentinelLine = '<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->'
$prefix = ''
if ($existing -notmatch [regex]::Escape('<!-- OVERNIGHT-AGENT do not edit this line')) {
  $prefix = '---' + $nl + $sentinelLine + $nl + $nl
  if (-not $Json) {
    Write-Host '[write-turn] journal had no OVERNIGHT-AGENT sentinel - adding it (the Telegram bridge skips tasks without one).' -ForegroundColor Yellow
  }
}

$out = $existing + $sep + $prefix + ($body.TrimEnd() -replace "`r?`n", $nl) + $nl

[IO.File]::WriteAllText($journal, $out, (New-Object Text.UTF8Encoding($false)))
if (-not $Json) {
  Write-Host "[write-turn] appended $($body.Trim().Length) chars to task-$Id.md (backup: task-$Id.bak-$stamp.md)" -ForegroundColor Green
}
exit 0
