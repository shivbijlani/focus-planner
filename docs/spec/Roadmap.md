# Roadmap

This page records the known gaps and forward direction from the 200 open issues. Nothing here is built; each row is a defect or missing capability, and the issue text carries the intended fix. Issues with a `priority:` label are grouped by that label; the rest are grouped by their remaining labels, then by theme. Read it with [Behaviour](Behaviour), [Reliability](Reliability), [Prioritisation](Prioritisation) and the relevant `Domain-*` page.

Shipped mechanisms are described on those pages as the contract; an issue listed here means the described behaviour is incomplete, or a failure class is still live.

## Priority: critical

8 open issues carry `priority: critical`.

| Issue | Labels | Title |
| --- | --- | --- |
| #501 | bug, reliability | Agent-declared done confers user-closed semantics: a Today row swallowed 3 user messages and released the Today gate |
| #711 | bug, overnight-agent | scan takes 224 s and emits 507 KB, so the coordinator abandons it and the run does no task work |
| #713 | bug, overnight-agent | Dispatch extension misses the host's 30 s ready window in scheduled sessions, so runs plan but never dispatch |
| #716 | bug, overnight-agent | Make direct dispatch the only path and remove the drain extension that never loads in scheduled runs |
| #734 | bug, overnight-agent | A user-paused task was dispatched, then the coordinator pushed the task session twice to override its refusal |
| #736 | bug, overnight-agent | Task sessions never launch a closed browser slot; every browser task has been blocked since noon |
| #747 | bug, overnight-agent | Google Workspace tools fail in every session: the server only speaks MCP 2026-07-28 and the Copilot host requests 2025-11-25 |
| #758 | bug, overnight-agent | Critical-tool check raised a false Google outage and emailed Shiv: the settings reader takes the whole cell, and the probe treats a text reply as failure |

## Priority: high

35 open issues carry `priority: high`.

| Issue | Labels | Title |
| --- | --- | --- |
| #547 | bug, overnight-agent | A `folder` session's workspace IS the planner data folder, so Playwright MCP wrote 760 KB of debris into OneDrive beside planner.md (4 of 4 folder sessions affected; happened 4.2h after #538 filed the prose rule) |
| #549 | bug, reliability, overnight-agent | Get-Content -Raw silently double-encodes UTF-8, corrupting catch-up docs - a third corruption class, currently unguarded |
| #560 | bug, reliability | awaiting_reply is recovered by regex from the agent's own prose: declare the ask instead of inferring it |
| #561 | enhancement, reliability | Scheduling decisions are unauditable: scan is not replayable and no run records why a row was picked or skipped |
| #562 | bug, reliability | Session replacement can go backwards: task #471 rebound to a session its own successor had already replaced (3 sessions in 13h) |
| #564 | bug, reliability | A satisfied timer does not park its task: make 'parked until T' the single primitive for clock, third-party and human waits |
| #565 | enhancement, reliability | No spec-conformance forensics: 50+ sweeps detect known defect shapes, nothing checks whether the system matches the spec |
| #579 | bug, reliability | Prioritisation.md 6 claims a missing concurrency row reports settings-malformed; the code reports 'default', and the documented '## Overnight Agent behaviour' table does not exist in user-settings.md |
| #583 | bug, reliability | 6 of 12 scheduled overnight-agent run slots recorded zero turns in a 6h window (3 most recent consecutive), so 'fired and did nothing' is indistinguishable from 'never fired' |
| #589 | bug, reliability | in_flight reports 3 against a concurrency ceiling of 1, and scan emits no per-row capacity field so the membership of that 3 is unobservable |
| #605 | bug, reliability | A due poll never fires on a Deferred row: Test-Workable grants the timer override, then the Today gate discards it (measured: a closed issue due_poll=true, eligible=false) |
| #618 | bug, reliability | A declared ask is never validated against its own turn: a closed issue asks two questions it cannot guess, declares them an 'offer', and no reader waits (25 of 254 rows have an open ask nobody awaits) |
| #627 | bug, reliability | `eligible` binds selection but not work: admits stayed 0 for a 6h window while 3 journals gained turns, 2 on rows scan marks ineligible |
| #638 | bug, reliability | A 5h49m host-sleep outage silenced every scheduled unit and left zero record: the supervisor heartbeat stores only lastCheckUtc, so a blind window reads as healthy 20s later |
| #643 | bug, reliability | Supervisor restarts all GHCP sessions to clean up one finished run, interrupting unrelated active work |
| #717 | bug, overnight-agent | A code task whose worktree was deleted still reads reuse, so the run wakes a session that has no checkout |
| #718 | bug, overnight-agent | Non-code tasks have no creatable home: the app cannot make a projectless chat, so a run put a travel task in a code worktree |
| #720 | bug, overnight-agent | Tray quiet-window evidence is always incomplete on a box with 500+ sessions, so only the hard-deadline restart can fire |
| #727 | bug, overnight-agent | A task session loaded the coordinator skill from its brief, which risks recursive dispatch |
| #728 | bug, overnight-agent | A dead task session still reads reuse, and its failed send uses up the run's only dispatch slot |
| #732 | bug, overnight-agent | An automation browser slot can spin at about 2 cores with a dead CDP port after its task ends, and nothing notices |
| #738 | bug, overnight-agent | Browsers: let each Playwright MCP launch its own profile (tested), give each task its own window, and replace the slot lifecycle |
| #739 | bug, overnight-agent | New tasks ask for approval of reversible, already-allowed work: PHASE 2 always proposes and waits |
| #744 | bug, overnight-agent | The agent starts one task per run and stops: removing the drain extension also removed 'keep going until 5 minutes before the next run' |
| #748 | enhancement, overnight-agent | Fail loudly when a critical tool is down: a user-defined list (default email and google-workspace), a probe at run start, one push alert, and a red tray |
| #750 | bug, overnight-agent | Coordinator runs past the next slot: it dispatched until its cutoff, then kept working 17 more minutes and delayed the next run |
| #764 | bug, overnight-agent | Critical-tool probe marks healthy tools down under load: a cold-start MCP probe times out at 45 s, and a timeout is treated as an outage |
| #768 | bug, overnight-agent | Critical-tool check measures machine load, not tool health: probe through the coordinator's connected tools instead of cold-starting servers |
| #771 | bug, overnight-agent | Coordinator ignores its cutoff and one-send rule (prose drift): waited on a task and nudged it until 07:12; enforce with a guard hook |
| #780 | bug, overnight-agent | One task per run: a long-running task still busy from the previous run is re-sent every run and takes the only slot, starving 13 eligible tasks |
| #781 | bug, overnight-agent | Runs quit early instead of refilling: 13 eligible tasks wait while the coordinator ends 17-19 minutes before its cutoff |
| #783 | bug, overnight-agent | An explicit instruction is turned into a proposal: 'use X to generate a report' came back as a gated plan with an added email step, waiting on approve |
| #784 | bug, overnight-agent | Inbox check still cold-starts MCP servers: email, Telegram and Google 'timed out' and the run reported the inbox NOT CHECKED (the #768 defect in a second script) |
| #785 | bug, overnight-agent | Remove the coordinator guard extension: it needs an interactive permission prompt, so it never loads in scheduled runs and nags every other session |
| #817 | — | Telegram bridge folds ANY group member's message as `from: me`: anyone added to the group could approve (enforce sender id) |

## Priority: medium

12 open issues carry `priority: medium`.

| Issue | Labels | Title |
| --- | --- | --- |
| #496 | bug | Per-task session titles lose the planner task id, so worked tasks look undiscoverable |
| #519 | bug, reliability | PHASE 0 syncs two deploy targets but not the checkout PHASE 3 executes from: verified-current True while the live bridge was 5 commits behind and missing the fix that merged that night |
| #563 | bug | Task menu reports 'AI-assisted: Off' and 'Persistent session: Off' for behaviour that is always on; cut the persistent-session toggle |
| #571 | bug, reliability | status_by carries no close-provenance: it is 'agent' on 249 of 250 rows while user_completed is true on 54, so #501's stated conformance check is unevaluatable |
| #702 | overnight-agent | Default the Overnight Agent and every task session it starts to the Auto model |
| #719 | bug, overnight-agent | Tray update check can never find an update: marketplace browse --json has no version field |
| #724 | bug, overnight-agent | sync-oa-home reports verified-current while the tray keeps running stale deployed files |
| #729 | bug, overnight-agent | Non-code task project setting fails every bind when the cell carries the template's note, and the error blames the arguments |
| #733 | enhancement, overnight-agent | First-run setup: offer to remove Widgets and tune Defender for the dev drive, so new users don't get a sluggish PC |
| #745 | enhancement, overnight-agent | Scope tool servers per session: a lean coordinator, with browsers and other tools only in task sessions that need them |
| #761 | bug, overnight-agent | Session replacement churn: a healthy task was replaced twice in 84 minutes (frequency, not direction) |
| #778 | bug, overnight-agent | Parallel PHASE 0 steps collide on the state lock: capability and decision records fail with state_lock_timeout and need model retries |

## Priority: low

4 open issues carry `priority: low`.

| Issue | Labels | Title |
| --- | --- | --- |
| #645 | enhancement | Journal UX: a button to insert a todo, so adding one does not require typing `- [ ]` by hand |
| #646 | enhancement | Journal UX: a user-triggered compression button that rewrites a long journal into one pinned part and one current response |
| #743 | bug, overnight-agent | Browser shortcuts installer still uses 'MCP Edge … (CDP 922x)' names; name them by account |
| #772 | bug, overnight-agent | A manual critical-tool check writes a fake run into the run ledger |

## Unprioritised defects in the overnight agent and reliability

13 open issues.

| Issue | Labels | Title |
| --- | --- | --- |
| #436 | reliability | oa-state doc: journal_stamped is always false on a resolve, so a durable binding and an at-risk one look identical |
| #452 | bug, reliability | Worktree teardown doesn't release the session binding — task stays `bound: reuse, live` pointing at a deleted workspace |
| #453 | bug, reliability, overnight-agent | Agentic issue comments carry no provenance marker, so "edit the one agentic comment in place" can overwrite a human comment |
| #454 | bug, reliability, overnight-agent | agent-lore.md is write-only: 903 KB, 160 headings, zero readers - and 'grep for the heading you need' can only retrieve what a run already knows |
| #457 | bug, reliability | A session asserted a false negative about its own past actions after an ID rollover, and nothing could contradict it |
| #461 | bug, reliability, overnight-agent | ps1-encoding-sweep resolves its root to the main checkout, so running it from a worktree scans a different tree and reports clean |
| #532 | reliability | last_woken_at is maintained only by prose, so any wake reusing a live binding leaves it stale: G12 refuses EVERY author, and session -InFlight frees an occupied slot |
| #533 | reliability | auto-deploy: a budget expiry in the LAST phase leaves the two deploy targets on different refs, and the exit-before-report path never says so |
| #610 | bug, reliability, overnight-agent | observe-bound-docs: a transient failure and a broken page print the identical FAIL line |
| #612 | bug, overnight-agent | A cold google-workspace MCP server reports a healthy doc as unreadable (and #610's 1500ms retry cannot cross it) |
| #648 | enhancement, reliability | Supervisor: preventive GHCP restart window with configurable quiet-time start A and hard deadline B |
| #789 | bug, reliability | OneDrive sync re-checks ~1,200 files every cycle, mostly agent .playwright-mcp logs in the planner folder |
| #851 | overnight-agent | Gated dispatch is enforced at `session -ForDispatch` but not at create_session/send_session_message |

## Unprioritised bugs and enhancements

17 open issues.

| Issue | Labels | Title |
| --- | --- | --- |
| #502 | bug | Doc comments read as empty: -Observe returns 0 for the MCP's own output shape |
| #528 | bug | Adding a task can reuse a live task's ID and silently destroy that task's row |
| #557 | bug | write-turn.ps1 prints a bare backup filename, so the rollback artifact looks missing when you need it |
| #602 | bug | mutcheck-journal-encoding fails 2/3 on main: the journal encoding guard validates the call shape, not the encoding argument, so an ANSI decode inside Read-JournalText survives |
| #625 | bug | find_and_replace_doc escapes a real newline into a literal `\n` in doc prose, reports `Replaced 1`, and the damage only matches back out with a real newline (fourth corruption class, unguarded) |
| #626 | bug | A stated finding and its own contradiction have equal standing in prose: the correct answer was transmitted and lost twice in one wake (6 instances, 2 shapes) |
| #628 | bug | The collapse fixes cannot reach 208 of 229 bound topics: a message whose id was never recorded is unreachable forever, and no sweep measures the outcome Shiv actually looks at |
| #650 | enhancement | Pilot: prove shared package consumption (A → B) via taskSort.js |
| #651 | enhancement | Feature concept: local-first sync engine with conflict resolution UI |
| #652 | enhancement | Feature concept: robust per-device agent/session linking with binding-time fingerprints |
| #653 | enhancement | Feature concept: optional Azure DevOps saved-query integration (read-only) |
| #654 | enhancement | Feature concept: PR lifecycle + PR description automation skills (video poster + mermaid diagrams) |
| #655 | enhancement | Feature concept: overnight-agent watchdog / reliability supervisor for unattended automation |
| #656 | enhancement | Convergence: preserve markdown journals with a parsed message model and safe merge |
| #681 | bug | A Node reader of the state store that forgets the UTF-8 BOM reports a confident zero over an empty set |
| #684 | bug | issue-shipped.mjs reported five shipped issues as unworked in one session, and G15 is silent on exactly that error |
| #790 | bug | server.js path guard allows sibling-prefix escape (e.g. ../planner-config.json) |

## Unlabelled issues

111 open issues.

| Issue | Labels | Title |
| --- | --- | --- |
| #441 | — | Catch-up doc creation should be a plugin skill encoding Shiv's doc preferences (no-context reader, no correction narration, collapsible sections, every ID a titled link) |
| #442 | — | Design a way to approve in a Google Doc comment: attribution must be positive, not inferred from the absence of an agent marker |
| #456 | — | gh issue edit --body is an unguarded overwrite, and issue bodies carry no authorship - so "was my work overwritten?" cannot be answered either way |
| #459 | — | run-capabilities.json does not declare the Google Workspace server, so the catch-up doc channel - the primary one - has no health probe |
| #462 | — | Both new write-guards ship with caller-facing traps that fail toward the outcome they prevent: undefaulted writeFile, and a verdict object that duck-types into a duplicate post |
| #465 | — | Consent is replayable: an affirmative is never spent, and whether it is depends on a marker the agent writes about itself |
| #468 | — | A capability probe spawns a fresh server, so it cannot see the session's own dead connection - green probe, dead doc channel (measured) |
| #471 | — | The run summary asserts repository state it never queried: two false claims in one run, both caught only by a sub-session |
| #473 | — | Two writers, one journal: the run session and the task sub-session each append a turn for the same wake, and their doc edits race |
| #476 | — | Zero writers, one journal: the #473 fix assigns sole authorship to the sub-session but nothing detects when it writes nothing - two PRs merged, no turn, no doc |
| #477 | — | G12 enforces one turn per wake but not WHICH author: the run session wrote first and the guard then locked out the owner |
| #480 | — | A wedged copilot.exe leaks a session lock, so an abandoned session reads alive forever - the liveness signal two sweeps depend on |
| #481 | — | session-state is never pruned: 4,109 directories / 2.6 GB since April, and 488 stale locks sit in the path two liveness sweeps read |
| #483 | — | Link mode never tidies the turn messages posted before binding: the collapse only runs on the turn path it replaced |
| #485 | — | Sweeps measure the working checkout, which nothing pulls - so a stale tree yields a confident, wrong verdict (measured: FLAGGED 9 commits when the truth was 0) |
| #487 | — | A task parked awaiting a reply holds a capacity slot forever: in_flight counts sessions that cannot be worked, so admits stays 0 and dispatch deadlocks |
| #491 | — | Turns can advertise a reply word the consent reader rejects: the vocab guard pins SKILL.md, not the asks we actually send |
| #492 | — | An agent-authored doc asserted a number its own table contradicted, and every guard passed: shape is checked, internal consistency is not |
| #494 | — | oa-state doc: journal_stamp_id is always null, so a journal stamped with a DIFFERENT doc than state is indistinguishable from one that agrees |
| #495 | — | Brief assembly reads 'no open PR' as 'unstarted', but the operating contract makes 'shipped, awaiting review' look identical: 5 of 6 issues briefed wrong in one wake |
| #499 | — | doc-claim-consistency-sweep flags append-only journal history it can never fix - first run pins a permanent finding |
| #500 | — | A doc-bound task waiting on doc comments holds the only capacity slot: a closed issue makes its ask dismissive by design, so it reads as workable |
| #505 | — | Run-session issue comments are unmarked, so every later pass duplicates instead of editing (and stamping the stranded one makes it worse) |
| #506 | — | Changing a poll/recheck cadence resets next_due to now, so 'run less often' makes a blocked task run sooner and eat the only slot |
| #511 | — | `merge ‹n›` is command-shaped but the number is never checked: one approval authorises any PR, and `merge 70 and 72` silently drops 72 |
| #513 | — | An ask can instruct a gate edit that cannot work: the floor is unscopable, so no allow rule can ever create an exception |
| #514 | — | G12 trusts a field the agent writes: stamping last_woken_at retroactively bypasses the one-turn-per-wake guard |
| #515 | — | Resolving a blocking ask strands its Telegram notice: the message keeps the last ask forever and its id is forgotten |
| #516 | — | Exhaustion has one word for two states: "queue drained" and "clock ran out" both release the Today gate, but only one is a fact about the row |
| #518 | — | Turns can ask for an approval word the gate has already granted: a valid, well-formed, unnecessary ask that #491 cannot catch |
| #520 | — | A guard that cannot run returns the same value as a guard with nothing to do: three instances of one shape (a closed issue, #502, DISMISSIVE_ASK_RE) |
| #522 | — | Observing a doc-bound task's comments erases it from the capacity count: the run dispatches an item and admits stays 1, so #500's fix opens the over-dispatch direction it warns about |
| #524 | — | PHASE 2's Google Tasks collect reads a truncated page as the whole backlog: 9 open vs the true 35, and the under-read is indistinguishable from a burn-down |
| #526 | — | Deterministic "blocked on human" flag + last-evaluated timestamp, readable by the planner UI |
| #527 | — | No deterministic "blocked on human" flag or last-evaluated timestamp: 164 of 244 tasks are parked on Shiv and nothing tells him which |
| #534 | — | oa-state scan is journal-driven, so a board row with no journal file is invisible to the entire run - Today row 1 (#473) was silently unworkable |
| #538 | — | Agent must not create side-project working files inside the Focus Planner data folder |
| #539 | — | create_issue gates on the CALLING project's GitHub link and ignores repo_full_name, so folder/local-only workspaces silently lose an explicit 'file an issue' instruction |
| #540 | — | A user pausing a sub-session is invisible to PHASE 1: session -Id returns reuse/live and the next run wakes it straight back up (measured on #468) |
| #541 | — | A `blocked` task holds the only capacity slot: Test-SessionHoldsCapacity excludes done/skip but not blocked, so recording a user pause costs the run its dispatch slot (measured: 6 eligible, admits 0) |
| #543 | — | last_turn_at is stamped by any status-only mark, so "a turn was written here" is satisfiable without writing one - it defers the stale-turn backstop and passes -Exhausted's "must follow real work" check |
| #545 | — | scan emits the raw unanswered_user while every gate uses the closed-filtered one, so 3 closed tasks raise an ask no run is permitted to clear |
| #551 | — | split-user-settings.ps1 backs up on every write and never prunes: 26 files / 5.8 MB in 14 days, in the OneDrive-synced planner folder |
| #554 | — | collect-google-tasks.ps1 calls a tool that does not exist - the collector has never once succeeded |
| #556 | — | A reused task ID makes a LIVE task read `user_completed: true`, arming permanent reply-suppression (measured on a closed issue, a hit-and-run report) |
| #558 | — | Retire repair-board-307: it reports phantom damage on a board the reader parses correctly |
| #567 | — | oa-state.ps1: CWD-relative settings candidate lets the bundled template override real user-settings.md |
| #568 | — | check-agent-inbox.ps1: 42s probe budget too short for MCP cold start, producing false NOT CHECKED |
| #569 | — | A user message above the sentinel is invisible to `reopened`: scan and extract disagree on the same file, and the a closed issue Today row sat `not_workable` with a same-day request in it |
| #570 | — | google-workspace probes AVAILABLE but is exposed to no agent session: the doc-comment channel is unreadable from where PHASE 0.7 runs (3 of Shiv's comments sat unread) |
| #575 | — | deploy-installed-plugin REFUSE is ancestry-blind: a just-merged file reads as a "live fix" that deploying "would REVERT", and the message asserts the opposite of the truth |
| #577 | — | Tasks created in the Pacific evening are stamped with tomorrow's UTC date and render an age of `-1d` |
| #587 | — | Row kebab and its action sheet are both named just "Task actions" - a Delete/Complete menu that never says which task it will act on |
| #588 | — | Telegram posts the catch-up doc link when the doc is bound, not when it is written, so 4 of 5 links in one run pointed at unwritten placeholders |
| #593 | — | scan publishes doc_new_comments without the freshness of the read behind it, so a channel never observed and a channel observed-and-empty are the same `0` on the worklist |
| #594 | — | No sweep reads a catch-up doc's body, so a figure in the primary surface can go stale unflagged (measured: 5 stale coverage figures in the #468 doc, understating the rollout by 13 and overstating the remainder 2x) |
| #598 | — | Binding a task creates a doc channel nobody polls: PHASE 0.7 reads per-selection, so a parked task's comments reach nothing (UNREAD 0 -› 5 in 90 min, measured) |
| #600 | — | A forgotten `mark` makes the turn boundary EOF, so a raw reply below it is never seen (measured: reopened=false, trailing empty) |
| #607 | — | A session that correctly does nothing is recorded as unwakeable: task a closed issue burned 3 sessions, and both replacements cite a could not be woken that the event log disproves (3.4s and 9s wake latency) |
| #609 | — | observe-bound-docs declares FAIL with no retry, so a transient fetch and a broken document print the identical line (measured: 14 OK / 1 FAIL, and the FAIL was transient) |
| #613 | — | PHASE 3 dies with an unwrapped "One or more errors occurred." when the box is at its commit limit: the token fetch Add-Type fails, is retryable, and the message names nothing |
| #617 | — | Deploy backups are never pruned: 898 directories in 13 days (~69/day) under %LOCALAPPDATA%\overnight-agent\backups |
| #620 | — | A doc-bound topic settles on TWO messages, not one: the a closed issue notice exception now fires in 59 of 76 bound topics |
| #622 | — | The telegram-bridge checkout is on no deploy manifest: merged bridge code can stay inert while both deploy checks report clean |
| #630 | — | `OPEN` spans shipped-awaiting-review and filed-and-unworked, and the tracker renders them identically: 96 of 168 open issues are already shipped, and three run sessions recommended shipped work twelve times |
| #632 | — | shipped-but-open-sweep is inert in the suite that runs it: the wrapper's planner cwd is not a git checkout, so it classifies 0 of 169 issues and still reports `ok, findings 0` |
| #635 | — | Triage consults the shipped check before recommending work, not after |
| #639 | — | issue-shipped.mjs reports historical mentions as shipped work, failing in the dangerous direction |
| #640 | — | Task actions sheet renders below the fold on a narrow viewport: Create Journal sits 226px off-screen and is the only way to start a new task's journal |
| #641 | — | Journal entries written by an agent through the UI composer are stamped '‹!-- from: me --›', so agent prose is indistinguishable from Shiv's own words in the consent channel |
| #668 | — | auto-deploy reports "DEPLOY NOT VERIFIED" when the deploy is verified: a dirty third checkout is surfaced through the deployment channel |
| #672 | — | Shared sorting: add an explicit opt-in alias capability without positional-argument drift |
| #673 | — | Shared sorting: gate flag profiles with packed-package compatibility and rollback checks |
| #689 | — | Make overnight reliability supervisor an optional tray app |
| #690 | — | Default watchdog background components off and add safe uninstall |
| #694 | — | Add chat-first Focus Planner onboarding installer |
| #695 | — | Add optional tray app for overnight-agent reliability supervision |
| #696 | — | Make user-settings.md the canonical supervisor policy source |
| #697 | — | Remove obsolete supervisor dispatch paths and finalize tray documentation |
| #698 | — | Move browser-watchdog resident checks into the optional tray app |
| #699 | — | Add GHCP LLM watchdog integration through the tray supervisor |
| #701 | — | Tray workload: plugin update check (hourly maintainer, daily default) |
| #707 | — | Keep marketplace.json overnight-agent version in sync with plugin.json so tray update checks can see updates |
| #710 | — | Tray update check always reports version-unknown: CLI marketplace browse omits plugin versions |
| #751 | — | Convergence: add a default-preserving deployment profile and host-provider seam |
| #752 | — | Convergence: stage the single-source transition without deleting or rerouting planner data |
| #753 | — | Convergence: unify provider registration without changing existing storage behavior |
| #754 | — | Convergence: add an opt-in Node journal-write CLI with existing guard parity |
| #755 | — | Convergence roadmap: map remaining shared-product work to incremental, non-duplicative slices |
| #763 | — | Catch-up doc creation duplicates documents when creation succeeds but binding fails |
| #786 | — | Critical-tool preflight crashes under load and blocks every dispatch: it spawns a 6,500-line PowerShell script with a 60 s timeout just to read one settings row |
| #793 | — | Keep exactly one storage source (remove multi-source combined board) |
| #798 | — | Folder-sync mirror replay can overwrite newer source content with a stale mirror copy (pre-existing) |
| #800 | — | Deployment profile, host provider seam and storage provider registry |
| #804 | — | e2e sandbox baseline on main: i3 always fails (PHASE 0 hygiene denied) and coordinator sometimes works an approved task itself (b5) |
| #808 | — | oa-state shifts doc-comment observed_at by the UTC offset on non-UTC hosts (CI blind: runners are UTC) |
| #814 | — | backfill-turn-end.ps1 cannot run: its dot-source cut point (^switch ($Command)) no longer exists in oa-state.ps1 |
| #816 | — | Coordinator can write a turn on a snoozed task (rule is prose-only); enforce in write-turn |
| #825 | — | write-turn: refuse an agent turn into a user-closed task (e1 is prose-only) |
| #826 | — | App smoke (Playwright) gate is flaky on main (journal reload persistence, settings timing) |
| #832 | — | Telegram bridge: fold only the owner's messages and stamp them via:telegram (#817, bridge slice) |
| #836 | — | Add cross-platform Planner agent tools backed by the same mutation core as the UI |
| #838 | — | Docs app (item 7) Phase 0: behaviour spec, data formats and JSON schemas |
| #845 | — | Docs app (item 7) S1: library + reader + 📄 trio against sample docs (app side) |
| #847 | — | Absent bound sessions silently starve every eligible task: repeated session_status_unknown with zero sends |
| #850 | — | Critical preflight records email absent without discovering deferred connected tools |
| #852 | — | Docs (item 7) S1: fp-docs publisher CLI (publish/lint/status) |
| #854 | — | Docs (item 7) S2: span comments, review.json merge, fp-docs comments |
| #857 | — | Journal sidebar makes task journals and descriptive reports look like duplicate journals |
| #867 | — | Docs renderer: soft-wrapped lines split blocks; emphasis across wraps renders literally |
| #868 | — | Docs app: remote revisions create sync-conflict copies and the open doc doesn't refresh |

## Reading the gaps

The dominant themes across the open set:

- **The agent authoring the signal its own gate reads.** Many defects are variants of one failure class: a state the agent can write about itself acquires the authority of a user action. [Prioritisation](Prioritisation) states the rule and the shipped closures; open issues here are further instances.
- **Unattended liveness.** Hung runs, stuck browser slots, orphaned processes and deploy drift are covered by the mechanisms in [Reliability](Reliability); the rows above are the residual holes.
- **Comment and consent channels.** Issues about Google Doc comment attribution and consent mean comments cannot yet be trusted as instructions without author provenance; see [Domain-docs](Domain-docs).
- **Tool-surface and resource cost.** Issues on advertised tool schemas, process fan-out and browser-slot configuration are direction, not shipped behaviour.
