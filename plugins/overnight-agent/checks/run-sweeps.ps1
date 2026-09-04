<#
  run-sweeps.ps1 — the ONLY sanctioned way to run the sweep suite.

  WHY THIS EXISTS
  ---------------
  6 of the 19 sweeps import the telegram-bridge source and therefore need
  BRIDGE_SRC; all of them need PLANNER_PATH. Nothing set those for you, so every
  run had to remember two environment variables by hand. When they were missing
  the sweep did not degrade -- it died on the first import:

      Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'undefined'

  and exited 1 having measured NOTHING. That is the dangerous part, because a
  sweep that finds problems ALSO exits 1. So "exit 1" was ambiguous, and a run
  that skimmed exit codes could record "19 sweeps, all clean" when six of them
  never actually ran -- including drift-sweep, the primary status-drift detector.

  This is the same failure class run-telegram-mirror.ps1 exists to prevent for
  PHASE 3: a prose warning in user-settings.md is not enough, so the wrapper
  makes the flag impossible to omit.

  WHAT IT GUARANTEES
  ------------------
  1. PLANNER_PATH and BRIDGE_SRC are always exported explicitly.
  2. BRIDGE_SRC is derived from the SAME bridge pin run-telegram-mirror.ps1
     uses, so rolling the pin back moves both in lockstep (one source of truth).
  3. Preflight fails loudly if the planner folder or the pinned bridge src is
     missing -- before any sweep runs.
  4. CRASH and FINDINGS are reported as different things:
       OK       exit 0
       FINDINGS exit != 0, real stdout, empty stderr   <- normal, it found stuff
       CRASH    exit != 0, empty stdout, stderr set    <- the sweep did not run
     The script's own exit code is non-zero ONLY for CRASH.
  5. Any *-sweep/audit/integrity/gaps .mjs -- OR any digest-* .mjs -- in the
     folder that is not in the known list is reported as UNREGISTERED, so a
     newly added sweep cannot be silently skipped. The digest-* prefix is in
     the rule because digest-invisible.mjs, which user-settings.md mandates
     "near the end of every run", matched NONE of the suffixes and so was
     both unregistered AND invisible to the guard that exists to catch that.

  Usage:
    powershell -NoProfile -ExecutionPolicy Bypass -File run-sweeps.ps1
                  [-IncludeMutchecks] [-Only a,b] [-Json] [-OutDir <path>]
#>
[CmdletBinding()]
param(
  [switch]$IncludeMutchecks,
  [string[]]$Only,
  [switch]$Json,
  [string]$OutDir
)

$ErrorActionPreference = 'Stop'

$OA          = Join-Path $env:LOCALAPPDATA 'overnight-agent'
$PlannerPath = 'C:\Users\shiv\OneDrive\Apps\Focus Planner'
$MirrorPs1   = Join-Path $OA 'run-telegram-mirror.ps1'

# The plugin the CLI actually loads. PowerShell mutation checks that take a -ScriptPath are
# pointed here on purpose: `installed-plugins` is written by hand, so it is the only copy whose
# behaviour is production behaviour. Guarding the repo copy would guard something nothing runs.
$InstalledOaState = Join-Path $env:USERPROFILE '.copilot\installed-plugins\focus-planner\overnight-agent\skills\overnight-agent\oa-state.ps1'

# --- Resolve the bridge pin from run-telegram-mirror.ps1 (single source of truth) ---
# That wrapper holds the pinned worktree; deriving from it means a rollback of the
# pin automatically applies here too, instead of drifting into a second copy.
$BridgeJs = $null
if (Test-Path $MirrorPs1) {
  $m = Select-String -Path $MirrorPs1 -Pattern "^\s*\`$Bridge\s*=\s*'([^']+)'" | Select-Object -First 1
  if ($m) { $BridgeJs = $m.Matches[0].Groups[1].Value }
}
if (-not $BridgeJs) {
  $BridgeJs = 'V:\repos\focus-planner.worktrees\oa-block-stray-marker\packages\telegram-bridge\bin\telegram-bridge.js'
  Write-Warning "Could not read the bridge pin from run-telegram-mirror.ps1; using the built-in default."
}

# bin\telegram-bridge.js -> ..\src
$BridgeSrcDir = Join-Path (Split-Path (Split-Path $BridgeJs -Parent) -Parent) 'src'

# --- Preflight: fail loudly BEFORE running anything ---------------------------------
if (-not (Test-Path $PlannerPath)) { throw "Planner folder not found: $PlannerPath" }
if (-not (Test-Path $BridgeSrcDir)) {
  throw "Pinned bridge src not found: $BridgeSrcDir`n" +
        "This is what makes 6 sweeps die with ERR_MODULE_NOT_FOUND. Fix the pin in run-telegram-mirror.ps1."
}

$BridgeSrcUrl = ([uri](Resolve-Path $BridgeSrcDir).Path).AbsoluteUri

$env:PLANNER_PATH = $PlannerPath
$env:BRIDGE_SRC   = $BridgeSrcUrl

# --- OA_TODAY: export it, for the same reason BRIDGE_SRC is exported -----------------
# self-answerable-sweep.mjs and declared-unblocked-sweep.mjs both do
#   const TODAY = process.env.OA_TODAY || '2026-08-25';
# and NOTHING was setting OA_TODAY, so both ran pinned to a frozen 2026-08-25 date.
#
# That is not cosmetic. Those sweeps skip a task whose journal was last written "today"
# so a fresh turn is never mistaken for rot. With TODAY frozen in the past the guard
# INVERTS: journals written today have their date filtered out by the `d <= TODAY`
# clause, so they are no longer recognised as fresh and CAN be flagged as rot, while
# journals written on the frozen date are skipped forever. Reported ages drift low by
# one day per day elapsed, too.
#
# Same failure shape as the BRIDGE_SRC bug this wrapper already exists to prevent: a
# variable every run was expected to remember, that nothing actually set.
$env:OA_TODAY = (Get-Date).ToString('yyyy-MM-dd')

# --- Capability floor: REPAIR the running agent before measuring it ------------------
# installed-capability-sweep (below) DETECTS a reverted plugin. Detection alone left the
# recovery as a three-step manual procedure -- copy the file from a worktree, resnapshot,
# re-verify -- that an UNATTENDED 3 AM run has to remember to perform correctly. That is
# precisely the step that never happens, which is why run-sweeps.ps1 and
# run-telegram-mirror.ps1 exist at all: a prose instruction in user-settings.md is not a
# mechanism.
#
# Ordering matters and is deliberate: this runs BEFORE the suite, so the sweeps measure a
# repaired agent rather than faithfully reporting a broken one. On a green tree it simply
# refreshes the floor, so a legitimate forward improvement becomes the new known-good and
# the floor can never go stale while things are healthy.
#
# Why this file is NOT in the plugin: a plugin reinstall is the failure being repaired, so
# the repair tool must live somewhere the reinstall cannot touch. %LOCALAPPDATA% is that
# place. A copy inside installed-plugins would be reverted by the very event it exists for.
#
# Never fatal. A repair tool that can abort the run is a bigger hazard than the fault it
# fixes, so a failure here is reported and the suite continues -- the capability sweep will
# then report the unrepaired state through the normal FINDINGS path.
$FloorPs1 = Join-Path $OA 'capability-floor.ps1'
if (Test-Path $FloorPs1) {
  try {
    $floorOut = & powershell -NoProfile -ExecutionPolicy Bypass -File $FloorPs1 ensure 2>&1
    $floorCode = $LASTEXITCODE
    if ($floorCode -ne 0) {
      Write-Host '[sweeps] capability-floor: COULD NOT REPAIR - see installed-capability-sweep below.'
      ($floorOut | Out-String).TrimEnd() -split "`r?`n" | ForEach-Object { Write-Host "           $_" }
    } else {
      $line = (($floorOut | Out-String) -split "`r?`n" | Where-Object { $_ -match 'snapshot OK|restore VERIFIED|nothing to restore' } | Select-Object -First 1)
      if ($line) { Write-Host "[sweeps] capability-floor: $($line.Trim())" }
    }
  } catch {
    Write-Host "[sweeps] capability-floor: errored ($($_.Exception.Message)) - continuing."
  }
}

# --- The suite ----------------------------------------------------------------------
# needsBridge is documentation, not control flow: BRIDGE_SRC is always exported.
$Suite = @(
  @{ n = 'drift-sweep';              bridge = $true  }
  @{ n = 'status-sync-audit';        bridge = $false }
  @{ n = 'self-answerable-sweep';    bridge = $false }
  @{ n = 'reversible-gate-sweep';    bridge = $false }
  # Companion to the line above, added 2026-08-26 after #357 (52d, the oldest ask on the
  # board) proved reversible-gate-sweep is structurally blind to gates written into the
  # DELIVERABLE the ask points at rather than into the ask itself.
  @{ n = 'deliverable-gate-sweep';   bridge = $false }
  # Third member of the same family, added 2026-09-01. The two above catch an ask that
  # should never have been made (the work needed no approval). This one catches the
  # opposite: approval genuinely IS needed, and the ask names a reply word that
  # `oa-state.ps1 consent` cannot recognise as approval — so Shiv can type exactly what he
  # was told to type and the run still reads "no affirmative" and refuses to act.
  # Measured on the live board the day it was written: 7 deadlocked tasks, incl. #463,
  # which had re-issued `repair board` verbatim for eight consecutive nights while two
  # destroyed wake dates (one due that Thursday) sat unrepaired behind it.
  @{ n = 'dead-ask-word-sweep';      bridge = $false }
  # The first detector that leaves the filesystem (added 2026-08-26 12:30). Every other
  # sweep reads only journals/board/state, so an ask naming a PR was never checked against
  # whether that PR is still open, still exists, or is still MERGEABLE. It calls `gh`, so it
  # is the slowest entry here (GitHub computes mergeability lazily and it polls for it).
  @{ n = 'pr-ask-liveness-sweep';    bridge = $false }
  @{ n = 'undelivered-plan-sweep';   bridge = $false }
  # Companion to the line above, and deliberately NOT folded into it. That sweep skips any
  # journal written today, which is right for every other delivery question but makes a
  # promise due THIS run ("nothing to start - I'll get on with it") undetectable on the only
  # run that could have kept it. This one is self-contained within a single turn, so it needs
  # no grace period. Found on #460, 2026-08-26.
  @{ n = 'self-promise-sweep';       bridge = $false }
  @{ n = 'declared-unblocked-sweep'; bridge = $false }
  @{ n = 'blocked-readonly-sweep';   bridge = $false }
  @{ n = 'inprogress-stall-sweep';   bridge = $false }
  @{ n = 'armed-trigger-sweep';      bridge = $false }
  @{ n = 'board-gaps';               bridge = $true  }
  @{ n = 'turn-truncation-sweep';    bridge = $true  }
  @{ n = 'hidden-turn-sweep';        bridge = $true  }
  @{ n = 'closed-task-posts';        bridge = $true  }
  # 2026-08-27 12:15 PT - this sweep's FLAGGED line could never reach zero. It flagged
  # DISABLED unconditionally, so "Google token check (folder-bind test)" - a placeholder
  # created 2026-07-03 (prompt: "placeholder - will configure after verifying workspace
  # binding"), disabled, ZERO runs, never executed - sat under FLAGGED in 17 of 17
  # archived sweep runs. That is the desensitising half of the 11:40 learning: this is
  # the SAME detector whose flagged line was read and skipped 16 runs running while the
  # hourly Browser watchdog was dead for 11 hours. A permanently-red line teaches every
  # future run to skim it. Fixed with an acknowledged-inert baseline (the
  # shadow-journal-sweep / lost-interpolation-sweep precedent): suppression needs all of
  # enabled=0 AND zero runs ever AND a fingerprint in workflow-health-baseline.json, and
  # it re-arms if the workflow is enabled, ever runs, or is renamed/re-prompted/
  # re-scheduled. The 54-day "Google Workspace token check" bug this sweep exists for
  # cannot re-hide: it had runs > 0, which defeats suppression on its own. Both
  # directions proven by workflow-health-sweep.test.mjs (14/14), all four guards
  # mutation-proven load-bearing.
  @{ n = 'workflow-health-sweep';    bridge = $false }
  # The RECOVERY half of the line above, added 2026-08-27. workflow-health-sweep
  # correctly flagged "Browser watchdog [OVERDUE] ... last=running" in 16 CONSECUTIVE
  # runs (07:52 -> 11:38 PT) and not one acted on it, while the hourly watchdog stayed
  # dead for 11 hours. Root cause: its 07:43 run finished its work, then the process
  # died during shutdown without writing a terminal status, orphaning the row at
  # status='running' - and the app refuses to start a workflow it believes is running,
  # so ONE orphaned row permanently disables that workflow for scheduler AND manual
  # triggers (verified: run_workflow returned "already running"). Detection alone was
  # demonstrably not enough, so this one REPAIRS: it only ever touches a run whose
  # owning OS process is provably dead (via the session's inuse.<pid>.lock) and older
  # than a 20m grace window, reads the terminal status out of the session's own event
  # log rather than guessing, and backs up every row before writing. Arms proven in
  # both directions by stuck-run-sweep.test.mjs (26/26).
  @{ n = 'stuck-run-sweep';          bridge = $false; args = @('--repair') }
  # The SUPERVISOR half of the two lines above (GH #261, added 2026-09-03). Both of
  # those repair a stuck run from INSIDE a run, so neither can fire when no run is
  # happening -- which is the state #261 actually produces. The out-of-band daemons
  # exist for exactly that and both are running (measured: oa-supervisor-daemon pid
  # 18196, browser-watchdog pid 4144, dispatched by Explorer from the Startup folder
  # because registering a scheduled task is denied without elevation on this box).
  #
  # What was missing is a READER. The supervisor writes a heartbeat every 15 min and
  # the watchdog logs hourly; a repo-wide grep found ZERO consumers of either, and
  # oa-supervisor-daemon.ps1 says in its own header that if it dies "it stays dead
  # until next logon". So supervision could lapse silently and #261 would come back
  # with no signal at all. This is that reader, and it is deliberately dispatched
  # from a run: the daemons watch the app, a run watches the daemons, which is two
  # dispatch domains watching each other rather than the circular self-heal of #243.
  # 4 arms, each mutation-proven load-bearing by mutcheck-supervisor-liveness.ps1,
  # plus two must-stay-green fixtures so it cannot become the permanently red line
  # that the workflow-health-sweep note above is a warning about.
  @{ n = 'supervisor-liveness-sweep'; bridge = $false; ext = '.ps1' }
  @{ n = 'recurring-liveness-sweep'; bridge = $false }
  @{ n = 'stale-trigger-sweep';      bridge = $false }
  @{ n = 'parked-age';               bridge = $false }
  @{ n = 'urgency-staleness';        bridge = $false }
  @{ n = 'body-header-drift';        bridge = $false }
  @{ n = 'terminal-header-drift';    bridge = $false }
  # Looks BACKWARDS from the block into the pre-sentinel history -- the one direction
  # every other detector misses. Added 2026-08-26 after #293 sat blocked two months on
  # an ask whose both halves were already answered above the sentinel.
  @{ n = 'regressive-ask-sweep';     bridge = $false }
  # The ONLY detector that looks at what is MISSING. Every other one reads what is on the
  # page: is the current ask stale, self-answerable, gated, contradicted by history? An ask
  # that simply STOPS BEING CARRIED leaves no text behind to inspect, so all of them read
  # clean by construction -- including regressive-ask-sweep, whose three arms each need the
  # ask to still be present in order to fire. Added 2026-08-27 after `merge 201` was
  # surfaced at 07:50, was absent from the 08:00 turn, and was restored by hand at 08:30
  # with "regressive-ask-sweep read clean, so it did not catch a drop between two agent
  # turns". First live run: 5 targets with no live ask anywhere, oldest 36 days (#109).
  # Guards mutation-proven (newest-turn scope, same-number supersession, stack
  # consolidation) -- each killed real false positives on its first run: 13 -> 5.
  @{ n = 'dropped-ask-sweep';        bridge = $false }
  # Follows the dependency SIDEWAYS across a task link. Every other detector reads a
  # single journal, so a task whose blocker lives in ANOTHER file is invisible to all of
  # them. Added 2026-08-26 after #249 sat blocked 18 days on "execute #393's export",
  # which #393 had finished the very next day.
  @{ n = 'cross-task-dependency-sweep'; bridge = $false }
  # The only check on the WRITE PATH. Every other detector asks whether the agent's
  # REASONING was wrong; this one asks whether the text on disk is what the agent
  # actually wrote. A run that writes markdown through a PowerShell double-quoted
  # string has `$150` expanded to the EMPTY STRING - no error, no warning - leaving
  # the markdown-escape backslash behind as a tombstone (`~\-275`). Added 2026-08-26
  # after finding 12 files whose prices had been silently deleted, including #377,
  # where the offer price was missing from a message Shiv was asked to approve.
  @{ n = 'lost-interpolation-sweep';    bridge = $false }
  # The SAME root cause as lost-interpolation-sweep -- markdown built inside a
  # PowerShell string -- but failing in the OPPOSITE direction, which is why that
  # sweep structurally cannot see it. Interpolation DELETES a value and leaves a
  # tombstone (`~\-275`); single-quote escaping DUPLICATES an apostrophe and leaves
  # none, so the text is longer, not shorter, and reads as clean. Added 2026-08-26
  # after lost-interpolation-sweep read 0 while 50 occurrences across 6 journals
  # (don''t, that''s, I''ll, NOAA''s) sat on disk. Proven load-bearing against
  # synthetic fixtures: fires below the sentinel, ignores Shiv's own prose above it.
  # Unlike its sibling this class is fully recoverable -- nothing was ever lost.
  @{ n = 'doubled-apostrophe-sweep';    bridge = $false }
  # The third member of the "a turn was written wrong and nothing noticed" family, and the
  # only one whose failure reaches the CONSENT gate rather than the text. An agent turn
  # appended with no `<!-- from: overnight-agent -->` stamp inserts no attribution boundary,
  # so `oa-state.ps1` hands it to whoever spoke last -- and when that is Shiv, the agent's
  # own `approve`/`yes` is read back as HIS approval for an irreversible action. Measured
  # live 2026-08-30 on #442: 15,400 chars of agent prose inside a 15,473-char region the
  # reader called human-authored, verdict `consent_ok: true`. Added with #272's other two
  # halves (write-turn.ps1 G7 refuses new ones; oa-state.ps1 now ends ownership at a `## `
  # heading). This sweep owns the BACKLOG: the ones already on disk, which neither of those
  # can reach. Exits 1 only on the trapped subset -- an unstamped turn sitting below a user
  # reply -- and reports the wider unstamped population as context, because reporting only
  # the dangerous five would hide the population they are drawn from.
  @{ n = 'unstamped-turn-sweep';        bridge = $false }
  # The SAME write-path defect, everywhere lost-interpolation-sweep cannot look.
  # That sweep reads exactly one directory - <planner>\journal, non-recursively - so
  # every deliverable the agent writes into a PROJECT folder has never been checked
  # by anything. Added 2026-08-26 08:35 PT to close a gap the 08:00 run measured and
  # left open: a BY-HAND re-run over ~835 files found two victims it structurally
  # could not see - `user-settings.md` itself (the file that records the rules), and
  # a 116 KB career doc written as a raw JSON string on ONE line. A hand re-run that
  # nobody scheduled is not a check. Adds an `undecoded-json` arm for the second.
  @{ n = 'unsupervised-md-sweep';       bridge = $false }
  @{ n = 'board-integrity';          bridge = $false }
  # Added 2026-08-26 13:30 PT. Five sweeps (self-answerable, reversible-gate,
  # undelivered-plan, declared-unblocked, terminal-header-drift) gate on
  # `if (!active.has(id)) continue`, so a journal with no planner.md row is
  # invisible to all of them. #280 - the clock-0 fix - sat 22 days with a live
  # non-terminal plan while reversible-gate-sweep, the detector built for exactly
  # that defect, reported 0. This is the complement of that gate: it looks only at
  # journals on NEITHER board and reports the ones still carrying a live ask that
  # were never deliberately deleted (no tombstone in a board sidecar). 30 orphans
  # -> 27 retired on purpose -> 2 findings, which are the same two #445 found by
  # hand (#228, #233). Exits 1 on findings.
  @{ n = 'orphan-liveness-sweep';    bridge = $false }
  # external-artifact-sweep (added 2026-08-26 13:30 PT run) — the agent's own side-effects
  # outside the planner (calendar events, PRs, issues) are indexed nowhere, so a later task
  # can ask Shiv for something an earlier task already established. #228 sat two months on
  # "confirm destination" while #310's calendar event named Dubai with a ticketed date.
  # cross-task-dependency-sweep read 0 and was RIGHT to: that link was never in a journal.
  # Three gates keep it from crying wolf (entity rarity, ask kind, existing citation); all
  # three are mutation-proven load-bearing by mutcheck-external-artifact.mjs. Exits 1 on
  # findings. Reads 0 against the live corpus because the 13:30 run repaired #228 by hand.
  @{ n = 'external-artifact-sweep';  bridge = $false }
  # owned-target-gate-sweep (added 2026-08-26 14:30 PT run) — a NEW DIMENSION of the
  # reversible-gate defect class. reversible-gate-sweep's verb list only covers verbs that
  # CREATE an artifact (draft/write up/research/scaffold/...). It has no verb for MODIFYING
  # one that already exists, so #403 sat 26 days gating "fold this into user-settings.md" -
  # the agent's own config file, which it rewrites and backs up every single run. The plan
  # even self-certified "No purchases or irreversible actions involved" and gated it anyway.
  # A naive modify-verb scan is 12.5% precise (8 hits, 1 defect); the discriminator that makes
  # it shippable is WHAT is being modified - an artifact the AGENT owns, vs Shiv's own
  # documents or an external system. Like orphan-liveness-sweep, it deliberately does NOT
  # require a board row. Guards are mutation-proven load-bearing by
  # mutcheck-owned-target-gate.mjs, which also DELETED a dead EXTERNAL guard that would have
  # suppressed real defects. Exits 1 on findings; reads 0 now that #403 is closed.
  @{ n = 'owned-target-gate-sweep';  bridge = $false }
  # self-attested-gate-sweep (added 2026-08-27 05:xx PT run) — the FOURTH dimension of the
  # reversible-gate defect class, and the one that caught the other three going green on a
  # live instance. On 2026-08-27 #448 gated `deploy it` — "copy the fixed script into the
  # plugin … it is a file copy with a backup, and I measured that it changes no current
  # verdict" — and reversible-gate, owned-target-gate and deliverable-gate ALL read 0. Proven
  # structural, not a timing artifact: re-run with OA_TODAY advanced a day to defeat their
  # "written today is not rot" skip, both verb-based arms still read 0.
  # ROOT CAUSE: those arms decide reversibility from the VERB, and both carry `deploy` on a
  # hard IRREVERSIBLE list. But `deploy`/`apply`/`install`/`enable` are ambiguous by nature —
  # "deploy to production" is irreversible, "deploy = copy a file into a local folder, backup
  # taken" is not — and no verb list can separate them, because the distinction lives in the
  # OBJECT, not the verb.
  # DISCRIMINATOR: don't judge the verb; use the agent's OWN ATTESTATION. When the ask itself
  # certifies the action is backed-up / undoable / measured-to-change-nothing, gating it is a
  # defect by its own account. Suppression is applied to the reply TOKEN, never the prose —
  # #448's ask ends "that is why the ask is 'deploy', not 'merge'", and a whole-ask keyword
  # scan would have silenced it on the word "merge". It also resolves CARRIED-FORWARD asks
  # (a re-stated "the `X` decision above still stands" whose justification is several turns
  # up) by walking back past the intermediate pointers — without that, every ask that waits
  # more than one night is invisible to attestation checking.
  # Deliberately does NOT skip journals written today: that skip is what hid #448 all night.
  # 14 assertions, all guards mutation-proven load-bearing by mutcheck-self-attested-gate.mjs.
  # Exits 1 on findings; first live run read 3 (#222, #280, #448), all hand-verified.
  @{ n = 'self-attested-gate-sweep'; bridge = $false }
  # Guards the reopen detector itself: a SIBLING SKILL's journal turn (dance-church,
  # instagram-publisher-monitor, kranbox-backup, ...) must never read as a USER reopen.
  # Journals are shared, and oa-state.ps1 originally treated any non-overnight-agent
  # provenance marker as unanswered user prose -- an UNCLEARABLE `reopened: true`, because
  # SKILL.md forbids skipping a reopened task even when it is done/skip, and the sibling
  # skill re-appends on its own schedule. Live instance was #254 (Dance Church, done).
  # BEHAVIOURAL, not textual: it runs the installed oa-state.ps1 against a synthetic journal
  # folder (isolated -JournalDir/-StateDir), so it cannot be fooled by source that merely
  # mentions the fix. Fixed 2026-08-26 (PR #191); reads 0.
  @{ n = 'sibling-skill-reopen-sweep'; bridge = $false }
  # unstamped-runlog-reopen-sweep (added 2026-08-26 17:xx PT run) — the SECOND half of the
  # false-reopen story, and the bigger one. #191 taught oa-state.ps1 that a sibling skill's
  # STAMPED turn is not a user reopen. This covers the journals with no stamp at all: the
  # agent historically answered by appending a bare `### Run log` under the user's
  # `## <date>` entry, so the turn boundary landed on the user's heading and the agent's own
  # reply was read as unanswered user prose — pinning HasTrailingUser true forever.
  # Such a journal reads quiet only while byte-identical to its snapshot, so any in-place
  # repair by a sibling sweep (dead-link rewrite, apostrophe repair) flips `changed` and
  # false-reopens it. Live instance: #367, done since 2026-07-27, reopened this run because
  # the dead-link sweep rewrote two links at 16:53. That is the "executing in tasks that are
  # already closed" symptom from #400.
  # BEHAVIOURAL like its sibling above, and its negative case is the important one: raw user
  # text below a run log must still reopen. Fixed 2026-08-26 (PR #192); reads 0.
  @{ n = 'unstamped-runlog-reopen-sweep'; bridge = $false }
  # dead-deliverable-sweep (added 2026-08-26 20:xx PT run) — the FIRST detector to leave
  # the prose and ask the FILESYSTEM whether the artifact a journal points at is there.
  # Every other sweep reasons about the text; none of them clicks the link. So a
  # deliverable could be written, linked, and later moved or deleted, and the journal
  # kept asserting it forever. Found 5 live losses from one 2026-08-06 folder cleanup,
  # incl. task-258's "full 456 KB history preserved verbatim ... nothing was lost" —
  # pointing at an archive that is not on disk, in a folder that is empty.
  # The discriminator is TENSE: a naive "referenced file is missing" scan is 40 hits at
  # ~20% precision, because most misses are correct ("Deliverables if approved: X" for a
  # plan that has not run). Requiring a positive CLAIM verb takes it to 0 false positives.
  # 5 gates (placeholder / claim / acknowledged / quoted-illustration / link-label), all
  # mutation-proven load-bearing by mutcheck-dead-deliverable.mjs, which deletes each gate
  # from a copy of the real source and asserts it breaks EXACTLY its own negative case.
  # Exits 1 on findings; reads 0 after this run's repairs.
  @{ n = 'dead-deliverable-sweep';   bridge = $false }
  @{ n = 'terminal-next-ask';        bridge = $true  }
  # Mandated by user-settings.md ("Run digest-invisible.mjs and board-gaps.mjs near
  # the end of every run ... plus digest-live.mjs for slot positions"). Both are
  # argument-free and exit 0, so they report as OK and only add signal.
  @{ n = 'digest-invisible';         bridge = $true  }
  @{ n = 'digest-live';              bridge = $true  }
  # basename-collision-sweep (added 2026-08-29, #251) - the SOURCE-layer detector for a
  # defect that the deploy layer can only ever report as a symptom. sync-oa-home.ps1
  # deploys into a flat directory, so it indexes by basename and REFUSES when one name
  # resolves to two repo paths. That refusal is correct and it is also permanent: a
  # collision cannot resolve itself, so those files freeze in the OA home and a merged
  # fix can never reach the copy that runs. Measured 2026-08-29: mutcheck-turn-ask.ps1
  # and mutcheck-write-turn.ps1 were both refused on EVERY run - two guards, silently
  # unupdatable, still reporting green against whichever version happened to be live.
  # Deliberately NOT solved by escalating sync-oa-home's exit code: an unresolvable
  # condition that escalates every cycle pins the code at 2 forever and trains the
  # reader to ignore it. Here it is a repo defect with a real fix, so it belongs here.
  # 3 guards, mutation-proven by mutcheck-basename-collision.mjs. Exits 1 on findings.
  @{ n = 'basename-collision-sweep'; bridge = $false }
  # repo-drift-sweep (added 2026-08-26 18:xx PT) — the check that keeps the other
  # 37 checks alive. Measured this run: of the 73 files making up this suite, **70
  # existed in exactly one place** — %LOCALAPPDATA%\overnight-agent on one laptop.
  # No git history, no backup, not in OneDrive. That included every detector, all 6
  # shared libs, all 19 mutation checks, and BOTH safety wrappers: this file (which
  # exists because six sweeps once silently measured nothing) and
  # run-telegram-mirror.ps1 (which exists because forgetting it floods Shiv's
  # Telegram irreversibly, and cannot be undone).
  # Copying them into the repo fixes that once; it does not keep it fixed, because
  # new sweeps get written into LOCALAPPDATA most nights. So this asks nightly:
  # is every file the LIVE registry depends on present in git and identical?
  # It derives the corpus from $Suite above plus a transitive import walk, so a lib
  # can never be left behind, and it resolves "versioned" against ALL git refs —
  # a file in an open PR is backed up, and calling it lost would be crying wolf.
  # 3 gates mutation-proven load-bearing by mutcheck-repo-drift.mjs (19/19), which
  # runs the real sweep as a child process against synthetic worlds and asserts
  # each guard breaks EXACTLY its own case. Reads 0 once the archive is in place.
  @{ n = 'repo-drift-sweep';         bridge = $false }
  # installed-skill-drift-sweep (added 2026-08-26 18:40 PT) — the COMPLEMENT of the line
  # above, and the gap it left. repo-drift-sweep asks whether every DETECTOR is in git; it
  # walks this registry, which lives in %LOCALAPPDATA%. Nothing ever looked at
  # ~\.copilot\installed-plugins\focus-planner — the plugin the CLI actually loads. So the
  # live SKILL.md and the live oa-state.ps1 were guarded by nothing.
  # Measured this run: the installed oa-state.ps1 was byte-identical to 90716eb, the #191
  # sibling-skill fix, which is NOT an ancestor of origin/main, while origin/main still had
  # the 217-line Aug-3 version with no reopen fixes at all. Two silent failure directions:
  #   FORWARD  — a fix green in git, red in production, because deploying it is a manual copy
  #              nobody scheduled. unstamped-runlog-reopen-sweep probes the INSTALLED script
  #              and was red for 8 straight runs against a branch that was green throughout;
  #              the run that shipped it recorded "turns green when 192 lands", which is
  #              false — merging never writes to installed-plugins.
  #   BACKWARD — a plugin reinstall overwrites the hand-deployed file with main's copy and
  #              REVERTS the fixes, with nothing to notice.
  # Verdicts: MAIN (fine) / BRANCH-ONLY (backed up but a reinstall reverts it) / UNVERSIONED
  # (recoverable from no ref). 2 guards mutation-proven load-bearing by
  # mutcheck-installed-skill-drift.mjs (6/6 baseline); main-first precedence is asserted by a
  # baseline case rather than a mutant, because it is matcher logic and neutering it broke 3
  # of 6 cases. Exits 1 on findings; reads 3 today (SKILL.md + the two files PR #192 carries).
  @{ n = 'installed-skill-drift-sweep'; bridge = $false }
  # installed-capability-sweep (added 2026-08-28 01:45 PT) — closes the BACKWARD direction the
  # comment 6 lines above names but that installed-skill-drift-sweep structurally cannot see.
  # MEASURED TONIGHT, not hypothesised: the plugin was reinstalled at 2026-08-27 21:06
  # (focus-planner/overnight-agent v1.3.1). That overwrote the hand-deployed oa-state.ps1 with
  # origin/main's copy — no UTF-8 decoder, no resnapshot, because the fix is in the still-OPEN
  # PR #198. Harm on the next scan: 207 of 239 journals flipped to `changed`, and `reopened`
  # read 0 while 16 tasks had trailing user content. The agent was blind to user replies.
  # installed-skill-drift-sweep reported "no drift" on those exact bytes, and that is not a bug
  # in it: its health criterion is "installed == origin/main" -> verdict MAIN -> fine. When the
  # required fix is NOT YET ON MAIN, reverting *to* main is a regression that scores as perfect
  # health. Provenance was perfect while capability was broken.
  # So the two are complements and both must run:
  #   installed-skill-drift-sweep : can we NAME the bytes we are running?
  #   installed-capability-sweep  : can the bytes we are running DO the job?
  # 3 guards, all mutation-proven load-bearing by mutcheck-installed-capability.mjs (3/3),
  # and each kill lands on the right fixture — notably g1 (ref-independence): adding a
  # "matches origin/main -> OK" bypass makes it miss the reverted build, which is precisely
  # how the drift sweep is blind. Reads 0 on a healthy tree.
  @{ n = 'installed-capability-sweep'; bridge = $false }
  # version-bump-sweep (added 2026-08-31) — the THIRD member of the "is the running
  # copy current?" family above, and the only one that reads the mechanism the CLI
  # itself uses. The two sweeps above compare CONTENT; the plugin updater compares
  # plugin.json's VERSION. So a merge can be fully deployed and content-verified --
  # auto-deploy-plugin.ps1 truthfully printing `verified-current True` -- while a
  # version-keyed updater sees an unchanged version and correctly does nothing. The
  # blind mechanism is the one that reports success, which is why this needed Shiv
  # to notice it by eye on #448 rather than any check catching it.
  # Not hypothetical, and it recurred on the very next merge after being discussed:
  # ba598a6 (#282) bumped to 1.5.0, then 4f68818 (#283) shipped a change to
  # oa-state.ps1 -- the engine that decides task eligibility -- with no bump.
  # Finds the last bump by comparing the PARSED version against the first parent's,
  # not by "last commit that touched plugin.json": #279/#280 both touched that file,
  # and a commit editing `description` is not a release. Exits 1 when it cannot
  # locate the repo, rather than passing, per the BRIDGE_SRC lesson. 7 fixtures,
  # 5 mutations, every guard load-bearing (mutcheck-version-bump.mjs).
  @{ n = 'version-bump-sweep';       bridge = $false }
  # journal-encoding-invariant (added 2026-08-27 12:50 PT) — the COMPLEMENT of the line
  # above. installed-skill-drift-sweep asks "does the live file differ from a git ref?",
  # which is a PROXY for danger, and measured this run it is the wrong way round:
  # origin/main has NO journal write path at all (its only write targets the state JSON),
  # so reverting to main degrades hash stability, not data. Drift therefore fires on a
  # SAFE state and would stay silent on a dangerous one.
  # The actual defect is the ASYMMETRIC ENCODING PAIR — an ANSI read combined with a
  # UTF-8 write in the same read-modify-write. Measured on this box (ACP 1252):
  #     read ANSI -> write ANSI    lossless (cp1252 is a byte-bijection)
  #     read ANSI -> write UTF-8   DESTROYS every non-ASCII character
  # which is why the bug hid for so long: half the round-trips are harmless. It is the
  # pair that cost 593 lines of task-448.md on 2026-08-27, and the shape a PARTIAL hand
  # copy into installed-plugins reproduces — a journal write path present WITHOUT
  # Read-JournalText. Nothing else asserts that invariant; the lost-interpolation and
  # doubled-apostrophe sweeps read journals AFTER the fact and are forensics, not
  # prevention.
  # BEHAVIOURAL first: runs the INSTALLED oa-state.ps1 `mark` against an isolated
  # synthetic journal (own -JournalDir/-StateDir, live state untouched) and asserts the
  # bytes above the turn-end marker survive EXACTLY — a prefix comparison, so there is no
  # magic size threshold to tune. 3 mutants killed by 3 DIFFERENT arms
  # (mutcheck-journal-encoding.mjs), so no guard is redundant; M2 reproduces the real
  # regression and names the 6 destroyed glyph classes. Exits 1 on findings; reads 0 today.
  @{ n = 'journal-encoding-invariant'; bridge = $false }
  # raw-append-reopen-sweep (added 2026-08-27 01:xx PT run) — the THIRD false-reopen defect,
  # and the only one that loses data. #191 and #192 both fix false POSITIVES (a settled task
  # reads reopened). This is a false NEGATIVE: a reply the user types at the bottom of a
  # journal with no `## <date>` heading and no `<!-- from: me -->` marker is absorbed into the
  # agent's own turn and never seen. SKILL.md explicitly promises that shape reopens a task.
  # Mechanism: Get-AgentEndIndex searches FORWARD from the agent's last anchor for the next
  # `## ` heading; when the agent's turn is the newest (the normal case) there is none, so it
  # returns $content.Length and the whole file counts as the agent's turn.
  # NOT fixed by #191/#192 — measured 2026-08-27, both behave identically on the fixtures, and
  # the fixture stamps the agent turn precisely so their boundary bugs cannot colour the
  # verdict. Exposure 216 of 239 journals, confirmed two independent ways (this port, and a
  # batched behavioural scan of all 239 with raw text appended: 23 detected either way).
  # BEHAVIOURAL like its two siblings. Its GUARD cases are the load-bearing half: the app and
  # the Telegram fold-back both write a `## <date>` heading, and those paths (921/922) must
  # keep working while 923 is fixed. Reads 1 finding until the boundary is fixed.
  @{ n = 'raw-append-reopen-sweep'; bridge = $false }
  # swallowed-message-sweep (added 2026-08-27 03:xx PT run) — the INCIDENCE half of the
  # sweep above. raw-append-reopen-sweep measures EXPOSURE (216 of 239 journals COULD swallow
  # a reply) and BEHAVIOUR (does the installed script handle each shape). Neither ever reads
  # the bottom of a real journal, so neither can find a victim. On 2026-08-27 01:50 a run
  # quoted the exposure audit as evidence that "no message of yours has ever been lost to
  # it" — false when written: #426580 had held two of Shiv's questions at EOF for nine hours.
  # user-settings.md now carries the rule ("an exposure count is not an incidence count").
  # That incidence pass was then done BY HAND, once; this is it automated, so it runs nightly
  # until PR #198's turn-end stamp merges AND is deployed to the installed plugin.
  # Two arms: a CERTAIN one (a `<!-- from: me -->` block sitting inside the agent's turn
  # region — authoritative, no heuristics) and a PROBABLE one (trailing prose with no agent
  # house style). Reduces 239 journals to ~5 candidates; the hand pass reduced them to 19.
  # Its GUARD fixtures are the load-bearing half — 937/938 stop it reporting the agent's own
  # turn body, which would flag most of the corpus. Reads 5 today, all settled "Done by me"
  # completion notes, i.e. no live victim.
  @{ n = 'swallowed-message-sweep'; bridge = $false }
  # shadow-journal-sweep (added 2026-08-27 04:xx PT run) — the same defect class as
  # raw-append-reopen-sweep, one level OUT. That one is about the boundary being wrong INSIDE
  # a file; this one is about the SET OF FILES being read being wrong. Every reader here —
  # oa-state.ps1 scan, all 42 sweeps, the Telegram bridge — filters the journal folder on
  # /^task-\d+\.md$/, which is correct for finding journals and silently doubles as the
  # definition of "content that exists". Found live: 3 journal-shaped files nobody opens —
  # two OneDrive sync-conflict forks (#249, #292) and task-328-shiv-devbox.md, a forked #328
  # journal misnamed like a deliverable. The last held a COMPLETE 2026-06-27 plan ending in
  # three direct questions to Shiv that were never surfaced anywhere. Nothing live was lost
  # only because that wedding has passed and he closed #328 himself on 2026-08-25.
  # Two arms on deliberately different evidence: the managed sentinel (proof the file was
  # managed AS a journal) and the OneDrive `-DESKTOP-*`/`-LAPTOP-*` conflict suffix (catches
  # the pre-sentinel #292 fork the first arm cannot see). H1 shape is deliberately NOT used —
  # measured at a 60% false-positive rate on this corpus. Ranks hits by lines that exist ONLY
  # in the shadow file, which is the only number that can represent real loss. The GUARD
  # fixtures are load-bearing: this folder holds ~130 deliverables and a constant stream of
  # write-turn `.bak-` backups, and flagging those would make it noise. Reads 3 today.
  @{ n = 'shadow-journal-sweep'; bridge = $false }
  # telegram-ask-truncation-sweep (added 2026-08-28 03:xx PT) — the delivery half of every ask.
  # 41 sweeps verify that an ask EXISTS, is current, and is not gated; none checked that it
  # ARRIVES on the only surface Shiv reads. Why it is not cosmetic: the approval digest is OFF
  # (task #441), and that digest was the only surface showing an ask outside its own topic. With
  # it off, an undelivered ask is visible NOWHERE — the agent waiting on an answer to a question
  # that was never asked.
  # REWRITTEN 2026-08-29 — it was grading a code path that no longer exists. It hand-copied the
  # bridge's old truncate-a-prefix budget loop, which PR #211 DELETED in favour of splitting a long
  # turn across up to 3 messages while carrying the ask onto the final part. The copy went stale and
  # the sweep reported a FALSE POSITIVE (#435, "ASK SILENTLY DROPPED") — telling the next run to
  # "shorten the turn to ~3,400 chars", i.e. to write worse journals to satisfy a solved problem.
  # A detector wrong in the direction of "do less work" is worse than one that is silent.
  # The cap, the budget and the split now live ONLY in bridge.js, reached through
  # checks/lib/telegram-delivery.mjs. Reads 0 undelivered / 13 split today.
  @{ n = 'telegram-ask-truncation-sweep'; bridge = $true }
  # truncated-ask-liveness (added 2026-08-28 04:30 PT) — the TRIAGE half of the sweep above.
  # That sweep flags every undelivered ask; deciding which ones MATTER was being done by eye, and
  # got it wrong twice in a row in opposite directions. 2026-08-27 23:15 dismissed 15 victims as
  # "closed/orphaned" when 10 were live. 2026-08-28 03:23 dismissed the last 5 because their ask
  # "starts with nothing" — but #232 read "one word on Kiley's copy", #431 read "nothing to read
  # the doc. One word only if you want the POC", and #450 named `rate tien`. Three real one-word
  # decisions Shiv had never been shown, all classified benign by a heuristic. The working
  # discriminator is neither the first word of the ask nor board membership: it is whether the ask
  # NAMES A CHOICE. This is a classifier, not a filter — it never suppresses a finding from the
  # sweep above, it only says which victims to look at first and prints the ask text.
  # REWRITTEN 2026-08-29 — the classifier was sound, its POPULATION came from the same deleted
  # truncation model. It read `ok` because it never called the splitter, so it could not have
  # noticed a regression OR a repair. Reads 0 today, which is now an honest zero.
  @{ n = 'truncated-ask-liveness'; bridge = $true }
  # truncation-openboard-scope (added 2026-08-28 04:55 PT) — the CONTENT half of the two above.
  # Both of those ask "does the ASK arrive?" and go green when it does. That is not the same
  # question as "did Shiv receive an actionable message". #272 proved the gap: its ask line survived
  # and read "the approval gate below — which to merge / build next" while the gate it pointed at
  # sat in the 67% that was cut away. So this scopes to the population that can actually be harmed —
  # rows on planner.md, COMPUTED from the board every run, never quoted from prose.
  # REWRITTEN 2026-08-29 — same stale model, and it too was GREEN FOR THE WRONG REASON: it never
  # called the splitter, so it would have kept reading `ok` if splitting regressed to truncation,
  # the exact failure it exists to catch. Loss is now TOKENS PRESENT IN THE TURN BUT ABSENT FROM
  # WHAT THE BRIDGE ACTUALLY POSTS. Comparing tokens rather than lengths is required: a split
  # delivery is legitimately shorter than its source (headers and part counters cost room) while
  # losing nothing, so the old length test would now flag every long turn.
  # Both sides go through the same md→HTML→text pipeline, because comparing raw markdown against
  # delivered HTML makes the FORMATTER look like data loss — `[x](./y.md)` renders as bare `x` for
  # every reader — which produced 41 bogus findings on a first run of this rewrite.
  # Reads 6 split / 0 losing content today.
  @{ n = 'truncation-openboard-scope'; bridge = $true }
  # external-surface-sweep (added 2026-08-28 09:xx PT) — a WHOLE DIMENSION every other detector
  # here is blind to. All 50 sweeps below read journals and the two boards. `oa-state.ps1 scan`
  # hashes journals too. So when a task's ask points Shiv at a surface OUTSIDE that set, his reply
  # lands somewhere nothing looks, and the board reports perfect health while the task is answered.
  # #459 proved it: he left two comments on a Google Doc on 2026-08-27 and no run noticed for a
  # DAY, against 239 journals reading 0 reopened / 0 changed / 0 approved. The 08:45 run read them
  # by hand and wrote "I have not fixed the watching part"; this is that sentence turned into a
  # mechanism, per the standing #423 lesson that a promise recorded in prose is not a mechanism.
  # It found a SECOND live instance on its first run: #446, where six comments from 2026-08-27 had
  # gone equally unseen.
  # Distinct from external-artifact-sweep, which asks "is this task asking for a fact ANOTHER TASK
  # already established?" — journals only, subject is the agent's own past side-effects. This asks
  # "is Shiv's ANSWER going to land where I never look?" and emits a poll worklist.
  # Four gates keep it narrow (non-terminal + live ask, non-dismissive, an action that leaves a
  # TRACE on a NAMED surface, and a resolvable identifier); "read the doc" is excluded by design.
  # SELF-CLEARING, which is the property user-settings.md faults the #198 probe for lacking:
  # record-surface-poll.ps1 stamps a poll, the row goes quiet for OA_SURFACE_MAX_AGE_HOURS (6),
  # and a newer ask re-arms it because a stamp predating the ask never counts as covering it.
  # 17 assertions, all 4 guards mutation-proven load-bearing by mutcheck-external-surface.mjs
  # (auto-globbed by -IncludeMutchecks). Exits 1 on findings.
  @{ n = 'external-surface-sweep'; bridge = $false }
  # postmortem-reviewer (added 2026-08-29, task #425) — Dream mode's learning loop:
  # read COMPLETED-task postmortems, notice work likely to repeat, and DRAFT a skill
  # refinement, a helper script, or a new skill. It writes nothing; every output is a
  # proposal for a human.
  # ⚠️ IT IS OFF BY DEFAULT AND REGISTERED ANYWAY. Unset, it prints one line and exits
  # 0. `OA_DREAM_POSTMORTEM=on` enables it. Registered-and-disabled is deliberate: the
  # UNREGISTERED guard above exists so a new .mjs cannot be silently skipped, and a
  # detector that is both disabled AND unregistered is one nobody will ever switch on.
  # WHY THE GATES ARE THE FEATURE — measured, not assumed. Against the live corpus of
  # 52 completed journals this accepted **1,417** candidates on its first run, proposing
  # `extract-script -> there.mjs`, `still.mjs` and `real.mjs`. Two calibrations fixed it:
  #   - entity rarity (>4 journals = ambient vocabulary, the same cap
  #     external-artifact-sweep already established here)      1,417 -> 195
  #   - route A requires evidence SHIV wrote, in >= 2 separate tasks; the agent's own
  #     procedure text may not vouch for recurrence (#227, relocated)  195 -> 1
  # The surviving candidate is a real one: `checklist`, from four travel tasks, evidenced
  # by his own note that a missing pre-departure checklist left the cards at home.
  # 6 gates, all mutation-proven load-bearing by mutcheck-postmortem.mjs (20 assertions,
  # 6 mutations, each killed and each breaking EXACTLY its own case).
  @{ n = 'postmortem-reviewer'; bridge = $false }
  # ps1-encoding-sweep (added 2026-08-30, after the write-turn fixture incident) — a BOM-less
  # .ps1 containing non-ASCII is silently mangled by PowerShell 5.1 BEFORE the script runs,
  # because 5.1 decodes a BOM-less file as the ANSI codepage while pwsh 7 decodes it as UTF-8.
  # This is HAZARD 4 aimed one layer down: at the SCRIPT FILE, where there is no decoder to
  # pin — only the BOM.
  # WHY IT IS A SWEEP AND NOT A PARAGRAPH: on 2026-08-30 it manufactured a FALSE TEST FAILURE.
  # A new mutation check built its fixtures from a here-string containing a moon glyph; under
  # 5.1 the fixtures arrived corrupted, tripped write-turn.ps1's own heading guard, and the
  # check reported `got 0`. It read exactly like "the fix does not work" — the fix was fine and
  # the fixtures were destroyed on the way in. The postmortem closed with "this is unaudited
  # across the repo ... worth a sweep", and unaudited findings are how this file's defects live
  # for weeks. First run: 14 of 40 .ps1 files affected, all COMMENT-ONLY — i.e. nothing was
  # broken YET, which is exactly when it is cheap to fix.
  # Severity is a decision, not a label: LOAD-BEARING (non-ASCII inside a literal on a line that
  # also compares/matches — the class that silently breaks guards) > LITERAL (mojibake output) >
  # COMMENT-ONLY (latent trap). 11 assertions, 5 mutations, each killed by a DIFFERENT assertion
  # (mutcheck-ps1-encoding.mjs, auto-globbed by -IncludeMutchecks). Exits 1 on findings.
  @{ n = 'ps1-encoding-sweep'; bridge = $false }
# GH #293, added 2026-08-31. The alternative to #262's every-run rewriter: assert the size
# of everything on the per-run read path and FAIL LOUDLY, rather than silently repairing a
# OneDrive-synced file on a timer. Most of that rewriter's 492 lines are guards that exist
# because it WRITES; this reads only, and mutcheck proves the read-only property rather
# than assuming it. It also enforces the file-layout contract (#292): writer='agent' plus
# readPath='every-run' is refused outright, because that combination is the defect class
# itself -- it produced #262 on user-settings.md and #291 on the journals.
# Known breaches are baselined (read-path-baseline.json) so the check does not go
# permanently red and get skimmed, which is the workflow-health-sweep lesson above; GROWTH
# past tolerance still fails, and growth is the live signal. 17 assertions, 6 mutations,
# all killed (mutcheck-read-path-budget.mjs, auto-globbed by -IncludeMutchecks).
@{ n = 'read-path-budget-sweep'; bridge = $false }
# GH #421, added 2026-09-03. Shiv's instruction on #468 was that the catch-up doc's
# COMMENTS become "the primary communication mechanism". Every primitive for that shipped
# -- #422 attribution, #423 the durable binding plus a two-phase watermark, #424 the quiet
# Telegram topic, #425 the pointer turn -- and each got a guard for ITSELF. None of them
# asserts that a RUN ever calls one. Measured on the live state store the day after the
# binding shipped, the only doc-bound task read `doc.observed_at ""`: `-Observe` had never
# been called even once, so a comment on that doc reached nothing and `scan` reported
# doc_new_comments 0 either way -- unreachable and empty are the same bytes. That is #346's
# defect (a mandated check that silently does not run, whose skip is success-shaped) in a
# third surface. This sweep is what makes the skip visible; it stays quiet on the healthy
# read-then-write loop, so it can actually reach zero. 29 assertions, 5 mutations, each
# killed by exactly one arm (mutcheck-catchup-doc.mjs, auto-globbed by -IncludeMutchecks).
@{ n = 'catchup-doc-sweep'; bridge = $false }
# GH #476, added 2026-09-04. #473 named exactly one author for a wake -- the bound task
# sub-session -- and #474/#475 enforced it with write-turn.ps1 G12. That closed the "at most
# one turn per wake" half and made the other half worse: the sole author became a single
# point of failure with NO detector. Measured live the same night on task #466: woken
# 05:36:53, host spawned 05:44:44, host gone by ~06:07, and the output was nothing anywhere
# -- no branch, no PR, journal frozen at the PREVIOUS wake's turn, no doc amendment. `scan`
# still reported an ordinary `in-progress` row; the only reason it was noticed is that the
# run session happened to poll process CPU by hand. Every guard in write-turn.ps1 is a
# property of a turn BEING WRITTEN, so not one of them can fire when nothing is written.
# That is #346's shape ("nothing to report" and "never reported" are the same bytes) on the
# authorship surface. This sweep supplies the missing third fact -- the wake is OVER --
# from the session host's own `inuse.<pid>.lock`, the signal stuck-run-sweep verified live
# on 2026-08-27, which has the property that a live session (INCLUDING the one running this
# sweep) can never be mistaken for a closed one. So it stays quiet on the healthy in-flight
# path and can actually reach zero. 61 assertions, 12 mutations, each killed by exactly the
# arms it declares (mutcheck-zero-writer.mjs, auto-globbed by -IncludeMutchecks).
@{ n = 'zero-writer-sweep'; bridge = $false }
)

if ($IncludeMutchecks) {
  # BOTH extensions. This glob was '.mjs'-only until 2026-08-27, which silently skipped every
  # PowerShell mutation check on the machine -- 4 of them, including mutcheck-write-turn.ps1,
  # the one guarding write-turn.ps1, the mandated journal writer. They were never "failing":
  # they were never RUN, so -IncludeMutchecks reported a clean sweep of a suite it could not
  # see. Same defect class as the six sweeps that died on an unset BRIDGE_SRC (2026-08-25
  # 22:45) -- a roster that reports "all clean" while structurally blind to part of itself.
  foreach ($ext in @('.mjs', '.ps1')) {
    Get-ChildItem $OA -Filter "mutcheck-*$ext" -File |
      Sort-Object Name | ForEach-Object {
        $Suite += @{ n = [IO.Path]::GetFileNameWithoutExtension($_.Name); bridge = $false; mut = $true; ext = $ext }
      }
  }
}

# Deliberately NOT part of the standing suite. digest-audit hardcodes its imports
# against the oa-digest-154 rollback worktree instead of honouring BRIDGE_SRC, so it
# is a manual one-off audit tool, not a sweep. Listed here so it stops reporting as
# UNREGISTERED noise while still being a conscious exclusion rather than an oversight.
# The remaining digest-* harnesses are per-question diagnostic tools, not standing
# health checks: digest-demoted lists the (expected, fallback-rescued) #162 class and
# would print ~39 lines of noise every run; digest-why and digest-replay both answer
# "why is THIS task absent?" and are only meaningful with a task id argument.
#
# rule-coverage is excluded for a DIFFERENT and more important reason: its number is
# not trustworthy, and a number that is not trustworthy must never sit in a roster that
# reports "all clean". It asks how many of the ~159 written rules in user-settings.md
# have executable enforcement, by keyword-matching each rule against the scripts. Its
# first cut read 157/157 = 100% COVERED -- a false green, because the corpus included
# COMMENTS and these sweeps restate their own rule in long comment headers, so every
# rule matched its own quotation. Stripping comments moved it only to 99%, which is
# still far too generous: one rare word appearing anywhere in 107 files counts as
# coverage. The finding it produced is real and is recorded in the run learnings; the
# metric is not. Kept as a one-off diagnostic, run by hand, never as a gate.
$Excluded = @('digest-audit', 'digest-demoted', 'digest-why', 'digest-replay', 'rule-coverage')

# Capture the FULL roster before any -Only filtering. The unregistered check must
# compare against every sweep this script knows about, not just the ones being run,
# or a filtered run reports the whole suite as unregistered.
$KnownNames = @($Suite | ForEach-Object { $_.n }) + $Excluded

if ($Only) {
  # PowerShell's -File passes arguments as plain strings, so `-Only a,b` arrives as a
  # SINGLE element "a,b" rather than an array. Every script here is invoked via -File
  # (per user-settings.md), so split on commas to make the documented usage work under
  # both -File and direct invocation.
  $wanted = @($Only | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
  $sel = @()
  foreach ($o in $wanted) {
    $hit = $Suite | Where-Object { $_.n -eq $o }
    if ($hit) { $sel += $hit }
    elseif (Test-Path (Join-Path $OA "$o.mjs")) {
      # ad-hoc: run a sweep that is not in the standing suite (used for negative tests)
      $sel += @{ n = $o; bridge = $false; adhoc = $true }
    }
    elseif (Test-Path (Join-Path $OA "$o.ps1")) {
      # Same, for a PowerShell check. Without this arm, -Only could not reach a .ps1 at all.
      $sel += @{ n = $o; bridge = $false; adhoc = $true; ext = '.ps1' }
    } else {
      throw "-Only '$o' matches no sweep in the suite and no $o.mjs or $o.ps1 in $OA"
    }
  }
  $Suite = $sel
}

# A selection that resolves to nothing must never look like a clean run.
if (-not $Suite -or @($Suite).Count -eq 0) { throw 'No sweeps selected to run.' }

if (-not $OutDir) { $OutDir = Join-Path $OA ('sweep-runs\' + (Get-Date -Format 'yyyyMMdd-HHmmss')) }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

# Retention. The Overnight Agent workflow runs every 30 minutes, so an un-pruned
# per-run directory is a slow disk leak of the same family as the stale-MCP leak
# (#349). Keep the most recent 20 runs and drop the rest.
$runsRoot = Join-Path $OA 'sweep-runs'
if (Test-Path $runsRoot) {
  Get-ChildItem $runsRoot -Directory -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending | Select-Object -Skip 20 |
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
}

# --- Run ----------------------------------------------------------------------------
$results = @()
foreach ($s in $Suite) {
  # A suite entry is node-run .mjs unless it declares its own extension. Mutation checks may
  # be PowerShell; resolving the extension here is what lets them run at all.
  $ext = if ($s.ContainsKey('ext') -and $s.ext) { $s.ext } else { '.mjs' }
  $path = Join-Path $OA "$($s.n)$ext"
  if (-not (Test-Path $path)) {
    $results += [pscustomobject]@{ name = $s.n; state = 'MISSING'; exit = $null; stdout = 0; stderr = 0; file = $null }
    continue
  }
  $soF = Join-Path $OutDir "$($s.n).out.txt"
  $seF = Join-Path $OutDir "$($s.n).err.txt"
  # Per-sweep arguments. Only stuck-run-sweep uses this today (it needs --repair);
  # kept generic so the next sweep that needs a flag does not re-touch the runner.
  if ($ext -eq '.ps1') {
    $exe = 'powershell'
    $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $path)
    # Two of these declare a MANDATORY -ScriptPath and simply refuse to start without it.
    # Point them at the plugin the CLI actually loads, so they guard PRODUCTION rather than
    # a copy in the repo -- the installed file is hand-deployed and is what really runs.
    # Read with an explicit UTF-8 decoder, never Get-Content -Raw (HAZARD 4).
    $src = [IO.File]::ReadAllText($path, (New-Object Text.UTF8Encoding($false)))
    if ($src -match '\$ScriptPath') { $argList += @('-ScriptPath', $InstalledOaState) }
  }
  else {
    $exe = 'node'
    $argList = @($path)
  }
  if ($s.ContainsKey('args') -and $s.args) { $argList += @($s.args) }
  $p = Start-Process -FilePath $exe -ArgumentList $argList -NoNewWindow -Wait -PassThru `
                     -RedirectStandardOutput $soF -RedirectStandardError $seF
  $so = if (Test-Path $soF) { (Get-Content $soF -Raw) } else { '' }
  $se = if (Test-Path $seF) { (Get-Content $seF -Raw) } else { '' }
  if ($null -eq $so) { $so = '' }
  if ($null -eq $se) { $se = '' }

  # Classify. A sweep that produced no stdout but wrote to stderr never ran.
  $state = if ($p.ExitCode -eq 0) { 'OK' }
           elseif ($se.Trim().Length -gt 0 -and $so.Trim().Length -eq 0) { 'CRASH' }
           elseif ($se.Trim().Length -gt 0) { 'CRASH' }
           else { 'FINDINGS' }

  $results += [pscustomobject]@{
    name = $s.n; state = $state; exit = $p.ExitCode
    stdout = $so.Trim().Length; stderr = $se.Trim().Length; file = $soF
  }
}

# --- Unregistered sweeps (so a new one can never be silently skipped) ---------------
$unregistered = Get-ChildItem $OA -Filter '*.mjs' -File |
  Where-Object { ($_.BaseName -match '(sweep|audit|integrity|gaps)$' -or $_.BaseName -match '^digest-') -and $KnownNames -notcontains $_.BaseName } |
  ForEach-Object { $_.BaseName }

$crashed = @($results | Where-Object state -in 'CRASH','MISSING')

if ($Json) {
  [pscustomobject]@{
    plannerPath = $PlannerPath; bridgeSrc = $BridgeSrcUrl; outDir = $OutDir
    results = $results; unregistered = $unregistered; crashed = $crashed.Count
  } | ConvertTo-Json -Depth 5
} else {
  Write-Host "[sweeps] planner = $PlannerPath"
  Write-Host "[sweeps] bridge  = $BridgeSrcUrl"
  Write-Host "[sweeps] out     = $OutDir"
  Write-Host ''
  foreach ($r in $results) {
    $tag = switch ($r.state) { 'OK' { '  ok      ' } 'FINDINGS' { '  FINDINGS' } 'CRASH' { '! CRASH  ' } default { '? MISSING' } }
    Write-Host ("{0} {1,-28} exit={2,-4} out={3,-6} err={4}" -f $tag, $r.name, $r.exit, $r.stdout, $r.stderr)
  }
  Write-Host ''
  Write-Host ("[sweeps] {0} run - ok {1}, findings {2}, CRASHED {3}" -f `
    $results.Count,
    @($results | Where-Object state -eq 'OK').Count,
    @($results | Where-Object state -eq 'FINDINGS').Count,
    $crashed.Count)
  if ($unregistered) { Write-Warning "UNREGISTERED sweeps (add to `$Suite): $($unregistered -join ', ')" }
  if ($crashed.Count) { Write-Warning "These sweeps did NOT run: $(($crashed | ForEach-Object name) -join ', ')" }
}

exit ($(if ($crashed.Count) { 1 } else { 0 }))
