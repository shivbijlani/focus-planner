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
  param([string]$Body, [string[]]$Disabled = @())

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

  return $findings
}

# --- entry point -------------------------------------------------------------------
if (-not (Test-Path -LiteralPath $BodyFile)) {
  Write-Error "body file not found: $BodyFile"; exit 3
}
$body = [IO.File]::ReadAllText((Resolve-Path -LiteralPath $BodyFile))
if ($body.Trim().Length -eq 0) { Write-Error 'body file is empty'; exit 3 }

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
$findings = @(Test-TurnBody -Body $body -Disabled $DisableGuard)
$hasAsk = Test-TurnAsk -Body $body

if ($Json) {
  [pscustomobject]@{
    ok       = ($findings.Count -eq 0)
    findings = @($findings)
    hasAsk   = $hasAsk
    id       = $Id
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
}

if ($findings.Count -gt 0) { exit 2 }

if ($Validate) {
  if (-not $Json) { Write-Host '[write-turn] clean (validate only - nothing written).' -ForegroundColor Green }
  exit 0
}

if (-not $Id) { Write-Error '-Id is required unless -Validate is set'; exit 3 }

$journal = Join-Path $JournalDir "task-$Id.md"
if (-not (Test-Path -LiteralPath $journal)) { Write-Error "journal not found: $journal"; exit 3 }

# Back up before touching it. Cheap, and every repair this codebase has made started
# from one of these.
$stamp  = Get-Date -Format 'yyyyMMdd-HHmm'
$bakDir = Join-Path $env:LOCALAPPDATA 'overnight-agent'
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
