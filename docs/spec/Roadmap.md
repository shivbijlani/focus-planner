# Roadmap

This page records **known gaps and forward direction** from the **200 open issues** captured in `spec-facts.json`. The system described in the other pages is not finished: each entry below is a defect or missing capability, and the intended fix where the issue states one. Entries with a `priority:` label come first, ordered by band. Unprioritised issues follow, grouped by theme. Read this beside [Behaviour](Behaviour), [Reliability](Reliability), [Prioritisation](Prioritisation) and the relevant `Domain-*` page.

Three themes run through the whole list:

- **Unattended dispatch is the weakest area.** The critical band is almost entirely about runs that plan but never dispatch, or dispatch work that should have been refused.
- **Guards that read agent-authored signals keep failing the same way.** Several issues describe a gate that reads text the agent wrote about itself (#560, #618, #626, #520).
- **The product is converging on one storage source and one shared core.** The convergence issues (#793, #800, #751 to #755) describe work that is deliberately not yet started.

A caveat applies to all of it: a shipped pull request does not close its issue here, because the owner closes an issue only after reading the catch-up doc (#630). Some entries may therefore already be fixed in code; #790 is one.

## Critical

8 open issues carry `priority: critical`.

| Issue | Labels | Gap and intended direction |
| --- | --- | --- |
| #758 | bug, overnight-agent | The critical-tool check raised a false Google outage and emailed the owner. The settings reader takes the whole cell and the probe treats a text reply as failure. Fix: read the tool name from the cell only, and treat a reply as proof of life. |
| #747 | bug, overnight-agent | The Google Workspace MCP server fails to connect in every Copilot session: the server speaks only protocol version 2026-07-28 while the host requests 2025-11-25. Every doc and Google channel is dark until the versions meet. |
| #736 | bug, overnight-agent | Task sessions never launch a closed browser slot, so every browser task stopped when all three automation browsers were down. Fix direction is tracked with #738. |
| #734 | bug, overnight-agent | A task the user had paused was dispatched, and the coordinator then pushed the session twice to override its refusal. A user pause must be unconditionally honoured. |
| #716 | bug, overnight-agent | Make direct dispatch the only path and remove the drain extension, which never loads in scheduled runs. |
| #713 | bug, overnight-agent | The dispatch extension misses the host's 30-second ready window in scheduled sessions, so runs plan but never dispatch. Resolved by the direct-dispatch decision in #716. |
| #711 | bug, overnight-agent | `scan` takes 224 s and emits 507 KB, so the coordinator abandons it and the run does no task work. Fix: bound `scan` time and output size. |
| #501 | bug, reliability | A task the agent marked done acquires the semantics of a task the user closed, so three unanswered user messages became invisible and the Today gate released. Only the user may close a task; `status_by` provenance is the intended carrier (#571). |

## High

35 open issues carry `priority: high`.

### Dispatch, pacing and coordinator discipline

| Issue | Labels | Gap and intended direction |
| --- | --- | --- |
| #744 | bug, overnight-agent | The agent starts one task per run and stops; removing the drain extension also removed "keep going until five minutes before the next run". |
| #781 | bug, overnight-agent | Runs quit early instead of refilling: 13 eligible tasks waited while the coordinator ended 17 to 19 minutes before its cutoff. |
| #780 | bug, overnight-agent | A long-running task still busy from the previous run is re-sent every run and takes the only slot, starving 13 eligible tasks. |
| #750 | bug, overnight-agent | The coordinator dispatched until its cutoff, then kept working 17 more minutes and delayed the next run. |
| #771 | bug, overnight-agent | The coordinator ignores its cutoff and one-send rule, which exist only as prose. A guard hook was proposed, then dropped by #785. |
| #785 | bug, overnight-agent | Remove the coordinator guard extension: it needs an interactive permission prompt, never loads in scheduled runs and nags every other session. |
| #739 | bug, overnight-agent | New tasks ask for approval of reversible, already-allowed work because PHASE 2 always proposes and waits. |
| #783 | bug, overnight-agent | An explicit instruction ("use X to generate a report") came back as a gated plan waiting on approval. Explicit instructions must execute. |
| #728 | bug, overnight-agent | A dead task session still reads `reuse`, and its failed send uses up the run's only dispatch slot. |
| #727 | bug, overnight-agent | A task session loaded the coordinator skill from its brief, risking recursive dispatch. |
| #717 | bug, overnight-agent | A code task whose worktree was deleted still reads `reuse`, so the run wakes a session that has no checkout. |
| #718 | bug, overnight-agent | Non-code tasks have no creatable home: the app cannot create a projectless chat, so a travel task ran in a code worktree. |
| #562 | bug, reliability | Session replacement can go backwards: a task was rebound to a session its own successor had already replaced. |
| #589 | bug, reliability | `in_flight` reports 3 against a concurrency ceiling of 1, and `scan` emits no per-row capacity field, so the membership is unobservable. |
| #627 | bug, reliability | `eligible` binds selection but not work: no admissions for a six-hour window while three journals gained turns, two on rows `scan` marks ineligible. |

### Critical-tool preflight

| Issue | Labels | Gap and intended direction |
| --- | --- | --- |
| #748 | enhancement, overnight-agent | Fail loudly when a critical tool is down: a user-defined list (default email and google-workspace), a probe at run start, one push alert, and a red tray. |
| #764 | bug, overnight-agent | The cold-start MCP probe times out at 45 s under load and a timeout is treated as an outage. |
| #768 | bug, overnight-agent | The check measures machine load, not tool health. Fix: probe through the coordinator's own connected tools instead of cold-starting servers. |
| #784 | bug, overnight-agent | The inbox check still cold-starts MCP servers and reported the inbox NOT CHECKED: the #768 defect in a second script. |

### Prioritisation and liveness

| Issue | Labels | Gap and intended direction |
| --- | --- | --- |
| #560 | bug, reliability | `awaiting_reply` was recovered by regex from the agent's own closing line. The intended fix, a declared ask, is the forward mechanism; the issue stays open until the regex fallback is retired. |
| #618 | bug, reliability | A declared ask is never validated against its own turn: a turn can declare `offer` while asking a question nobody can guess, and no reader waits (25 of 254 rows). |
| #564 | bug, reliability | A satisfied timer does not park its task. Fix: make "parked until T" the single primitive for clock, third-party and human waits. |
| #605 | bug, reliability | A due poll never fires on a Deferred row: the timer override is granted, then the Today gate discards it. |
| #579 | bug, reliability | The spec claims a missing concurrency row reports settings-malformed; the code reports the default, and the documented settings table does not exist in the live `user-settings.md`. |
| #561 | enhancement, reliability | Scheduling decisions are unauditable: `scan` is not replayable and no run records why a row was picked or skipped. |
| #565 | enhancement, reliability | No spec-conformance forensics: 50+ sweeps each detect a known defect shape, and nothing checks whether the system matches the spec. |
| #583 | bug, reliability | Six of twelve scheduled run slots recorded zero turns, so "fired and did nothing" is indistinguishable from "never fired". |

### Supervision, encoding and consent surface

| Issue | Labels | Gap and intended direction |
| --- | --- | --- |
| #643 | bug, reliability | The supervisor restarts all GHCP sessions to clean up one finished run, interrupting unrelated active work. |
| #638 | bug, reliability | A 5 h 49 min host-sleep outage left no record: the heartbeat stores only the last check time, so a blind window reads as healthy. |
| #720 | bug, overnight-agent | Tray quiet-window evidence is always incomplete on a box with 500+ sessions, so only the hard-deadline restart can fire. |
| #732 | bug, overnight-agent | An automation browser slot can spin at about two cores with a dead CDP port after its task ends, and nothing notices. |
| #738 | bug, overnight-agent | Decision: let each Playwright MCP launch its own profile, give each task its own window, and replace the slot lifecycle. |
| #549 | bug, reliability, overnight-agent | `Get-Content -Raw` silently double-encodes UTF-8, corrupting catch-up docs: a third corruption class that is still unguarded. |
| #547 | bug, overnight-agent | A `folder` session's workspace is the planner data folder, so Playwright MCP wrote 760 KB of debris beside the board. |
| #817 | none | The Telegram bridge folds any group member's message as `from: me`, so anyone added to the group could approve. Fix: enforce sender id; the bridge slice is #832. |

## Medium

12 open issues carry `priority: medium`.

| Issue | Labels | Gap and intended direction |
| --- | --- | --- |
| #778 | bug, overnight-agent | Parallel PHASE 0 steps collide on the state lock and fail with `state_lock_timeout`, needing model retries. |
| #761 | bug, overnight-agent | Session replacement churn: a healthy task was replaced twice in 84 minutes (frequency, not direction). |
| #745 | enhancement, overnight-agent | Scope tool servers per session: a lean coordinator, with browsers and other tools only in task sessions that need them. |
| #733 | enhancement, overnight-agent | First-run setup should offer to remove Widgets and tune Defender for the dev drive. |
| #729 | bug, overnight-agent | The non-code project setting fails every bind when the cell carries the template's note, and the error blames the arguments. |
| #724 | bug, overnight-agent | `sync-oa-home` reports verified-current while the tray keeps running stale deployed files. |
| #719 | bug, overnight-agent | The tray update check can never find an update: the marketplace browse output has no version field. Related: #710, #707. |
| #702 | overnight-agent | Default the coordinator and every task session it starts to the Auto model. |
| #571 | bug, reliability | `status_by` carries no close provenance (`agent` on 249 of 250 rows while `user_completed` is true on 54), so the #501 conformance check cannot be evaluated. |
| #563 | bug | The task menu shows "AI-assisted: Off" and "Persistent session: Off" for behaviour that is always on; the persistent-session toggle should be removed. |
| #519 | bug, reliability | PHASE 0 syncs two deploy targets but not the checkout PHASE 3 executes from, so the live bridge ran five commits behind while reporting verified-current. |
| #496 | bug | Per-task session titles lose the planner task id, so worked tasks look undiscoverable. |

## Low

| Issue | Labels | Gap and intended direction |
| --- | --- | --- |
| #772 | bug, overnight-agent | A manual critical-tool check writes a fake run into the run ledger. |
| #743 | bug, overnight-agent | The browser shortcuts installer still names shortcuts by debug port; name them by account. |
| #646 | enhancement | Journal UX: a button that lets the agent compress a long journal into one pinned part and one current response. |
| #645 | enhancement | Journal UX: a button to insert a todo without typing `- [ ]` by hand. |

## Unprioritised issues, by theme

None of the issues below carries a `priority:` label, so no order is implied within a theme.

### Native catch-up Docs (item 7)

The Docs feature is specified in [Domain-docs](Domain-docs) and built in stages. Phase 0 is the spec itself; the publisher and app halves follow.

| Issue | Gap and intended direction |
| --- | --- |
| #838 | Phase 0: behaviour spec, data formats and JSON schemas. Spec only, no code. |
| #852 | Stage S1, publisher half: the `fp-docs` CLI with publish, lint and status. |
| #845 | Stage S1, app half: library, reader and the 📄 trio against sample docs. |
| #854 | Stage S2: span comments, `review.json` merge and `fp-docs` comments. |

### Google-Doc catch-up channel and its Telegram notice

| Issue | Gap and intended direction |
| --- | --- |
| #763 | Catch-up doc creation duplicates documents when creation succeeds but binding fails. |
| #832 | Telegram bridge: fold only the owner's messages and stamp them `via:telegram`. This is the bridge slice of #817; the consent-reader half is separate. |
| #628 | The collapse fixes cannot reach 208 of 229 bound topics: a message whose id was never recorded is unreachable forever. |
| #620 | A doc-bound topic settles on two messages, not one. |
| #598 | Binding a task creates a doc channel nobody polls: comment observation is per-selection, so a parked task's comments reach nothing. |
| #594 | No sweep reads a catch-up doc's body, so a figure in the primary surface can go stale unflagged. |
| #593 | `scan` publishes `doc_new_comments` without the freshness of the read behind it, so never-observed and observed-empty look the same. |
| #588 | Telegram posts the doc link when the doc is bound, not when it is written, so most links pointed at placeholders. |
| #570 | google-workspace probes AVAILABLE but is exposed to no agent session, so the comment channel is unreadable where PHASE 0.7 runs. |
| #625 | `find_and_replace_doc` escapes a real newline into a literal `\n`, reports success, and the damage only matches back out with a real newline. |
| #612 | A cold google-workspace server reports a healthy doc as unreadable, and a short retry cannot cross it. |
| #610 | `observe-bound-docs` prints the same FAIL line for a transient failure and a broken page. |
| #609 | `observe-bound-docs` declares FAIL with no retry. |
| #515 | Resolving a blocking ask strands its Telegram notice: the message keeps the last ask and its id is forgotten. |
| #494 | `oa-state doc`: `journal_stamp_id` is always null, so a journal stamped with a different doc is indistinguishable from one that agrees. |
| #483 | Link mode never tidies the turn messages posted before binding. |
| #502 | Doc comments read as empty: `-Observe` returns 0 for the MCP's own output shape. |
| #492 | An agent-authored doc asserted a number its own table contradicted and every guard passed: shape is checked, internal consistency is not. |
| #499 | `doc-claim-consistency-sweep` flags append-only journal history it can never fix. |
| #459 | `run-capabilities.json` does not declare the Google Workspace server, so the primary channel has no health probe. |
| #468 | A capability probe spawns a fresh server, so it cannot see the session's own dead connection: green probe, dead doc channel. |
| #442 | Design a way to approve in a Google Doc comment: attribution must be positive, not inferred from the absence of an agent marker. |
| #441 | Catch-up doc creation should be a plugin skill that encodes the owner's doc preferences. |
| #436 | `oa-state doc`: `journal_stamped` is always false on a resolve. |
| #433 | The 800-character nudge fires on every real doc-bound turn so far; measure the distribution before re-tuning. |

### Dispatch, consent, turns and prioritisation semantics

| Issue | Gap and intended direction |
| --- | --- |
| #851 | Gated dispatch is enforced when a session is granted for dispatch, but not at the create and send tools. |
| #847 | Absent bound sessions silently starve every eligible task: repeated unknown-status results with zero sends. |
| #825 | `write-turn` should refuse an agent turn into a user-closed task. |
| #816 | The coordinator can write a turn on a snoozed task; the rule is prose only and should be enforced in `write-turn`. |
| #804 | The e2e sandbox baseline on main: invariant i3 always fails and the coordinator sometimes works an approved task itself. |
| #641 | Journal entries an agent writes through the UI composer are stamped `from: me`, so agent prose reads as the owner's words. |
| #607 | A session that correctly does nothing is recorded as unwakeable. |
| #600 | A forgotten `mark` makes the turn boundary end-of-file, so a raw reply below it is never seen. |
| #569 | A user message above the sentinel is invisible to `reopened`: `scan` and `extract` disagree on the same file. |
| #556 | A reused task id makes a live task read `user_completed: true`, arming permanent reply suppression. |
| #545 | `scan` emits the raw `unanswered_user` while every gate uses the closed-filtered one. |
| #543 | `last_turn_at` is stamped by any status-only `mark`, deferring the stale-turn backstop. |
| #541 | A blocked task holds the only capacity slot. |
| #540 | A user pausing a sub-session is invisible to PHASE 1, which wakes it straight back up. |
| #534 | `scan` is journal-driven, so a board row with no journal file is invisible to the run. |
| #532 | `last_woken_at` is maintained only by prose, so G12 refuses every author after a reused binding. |
| #527 | No deterministic "blocked on human" flag or last-evaluated timestamp: 164 of 244 tasks are parked on the owner and nothing says which. |
| #526 | Design a deterministic "blocked on human" flag and last-evaluated timestamp readable by the planner UI. |
| #522 | Observing a doc-bound task's comments erases it from the capacity count. |
| #516 | Exhaustion has one word for two states: "queue drained" and "clock ran out" both release the Today gate. |
| #514 | G12 trusts a field the agent writes: stamping `last_woken_at` retroactively bypasses the one-turn-per-wake guard. |
| #506 | Changing a poll or recheck cadence resets `next_due` to now, so "run less often" makes a task run sooner. |
| #500 | A doc-bound task waiting on comments holds the only capacity slot. |
| #487 | A task parked awaiting a reply holds a capacity slot forever, causing dispatch deadlock. |
| #477 | G12 enforces one turn per wake but not which author. |
| #476 | Zero writers, one journal: nothing detects a sub-session that writes nothing. |
| #473 | Two writers, one journal: the run session and the sub-session each append a turn for the same wake. |
| #626 | A stated finding and its own contradiction have equal standing in prose, so a correct answer was lost twice in one wake. |
| #520 | A guard that cannot run returns the same value as a guard with nothing to do. Three instances share the shape. |
| #518 | Turns can ask for an approval word the gate has already granted. |
| #513 | An ask can instruct an `agent-gate.md` edit that cannot work, because the floor is unscopable. |
| #511 | `merge <n>` is command-shaped but the number is never checked: one approval authorises any PR. |
| #491 | Turns can advertise a reply word the consent reader rejects. |
| #465 | Consent is replayable: an affirmative is never spent. |
| #457 | A session asserted a false negative about its own past actions after an id rollover, and nothing could contradict it. |
| #471 | The run summary asserts repository state it never queried. |

### Deploy propagation, sweeps and issue-tracking hygiene

| Issue | Gap and intended direction |
| --- | --- |
| #814 | `backfill-turn-end.ps1` cannot run: its dot-source cut point no longer exists in `oa-state.ps1`. |
| #808 | `oa-state` shifts doc-comment `observed_at` by the UTC offset on non-UTC hosts, which UTC-only CI cannot see. |
| #786 | The critical-tool preflight crashes under load: it spawns a 6,500-line script with a 60 s timeout to read one setting. |
| #850 | Critical preflight records email absent without discovering deferred connected tools. |
| #684 | `issue-shipped.mjs` reported five shipped issues as unworked, and guard G15 is silent on that error. |
| #681 | A Node reader of the state store that forgets the UTF-8 BOM reports a confident zero over an empty set. |
| #668 | auto-deploy reports "DEPLOY NOT VERIFIED" when the deploy is verified, because a dirty third checkout is surfaced through the deploy channel. |
| #639 | `issue-shipped.mjs` reports historical mentions as shipped work. |
| #635 | Triage should consult the shipped check before recommending work, not after. |
| #632 | `shipped-but-open-sweep` is inert in its suite because the wrapper's working directory is not a git checkout. |
| #630 | OPEN spans shipped-awaiting-review and filed-and-unworked, and the tracker renders them identically. |
| #622 | The telegram-bridge checkout is on no deploy manifest, so merged bridge code can stay inert while both deploy checks report clean. |
| #617 | Deploy backups are never pruned: 898 directories in 13 days. |
| #613 | PHASE 3 dies with an unwrapped error when the box is at its commit limit. |
| #602 | `mutcheck-journal-encoding` fails two of three arms on main: the guard validates call shape, not the encoding argument. |
| #575 | `deploy-installed-plugin` REFUSE is ancestry-blind: a just-merged file reads as a live fix that deploying would revert. |
| #568 | `check-agent-inbox.ps1`: the 42 s probe budget is too short for MCP cold start, producing false NOT CHECKED. |
| #567 | A working-directory-relative settings candidate lets the bundled template override the real `user-settings.md`. |
| #558 | Retire the board-repair tooling: it reports phantom damage on a board the reader parses correctly. |
| #557 | `write-turn.ps1` prints a bare backup filename, so the rollback artifact looks missing. |
| #554 | `collect-google-tasks.ps1` calls a tool that does not exist and has never succeeded. |
| #551 | `split-user-settings.ps1` backs up on every write and never prunes. |
| #533 | A budget expiry in the last auto-deploy phase leaves the two targets on different refs without saying so. |
| #524 | PHASE 2's Google Tasks collect reads a truncated page as the whole backlog. |
| #505 | Run-session issue comments are unmarked, so every later pass duplicates instead of editing. |
| #495 | Brief assembly reads "no open PR" as "unstarted", though "shipped, awaiting review" looks identical. |
| #485 | Sweeps measure a working checkout that nothing pulls, so a stale tree yields a confident, wrong verdict. |
| #462 | The issue-body and issue-comment write guards ship with caller-facing traps that fail toward the outcome they prevent. |
| #461 | `ps1-encoding-sweep` resolves its root to the main checkout, so a worktree run scans a different tree and reports clean. |
| #456 | `gh issue edit --body` is an unguarded overwrite and issue bodies carry no authorship. |
| #453 | Agentic issue comments carry no provenance marker, so "edit the agentic comment in place" can overwrite a human comment. |
| #428 | A merged PR auto-closes its issue via a closing keyword, skipping the review step the operating contract requires. |
| #454 | `agent-lore.md` is write-only: 903 KB, 160 headings, zero readers. |

### Tray supervisor rollout

The supervisor is moving from OS-scheduled dispatch to one optional tray app, in atomic steps. See [Reliability](Reliability).

| Issue | Gap and intended direction |
| --- | --- |
| #689 | Purpose: one optional tray app for the project's local reliability checks, running only while the user is signed in. |
| #695 | Step A: add the optional tray app for reliability supervision. |
| #696 | Step B: make `user-settings.md` the canonical supervisor policy source. |
| #698 | Step C: make the tray the sole resident dispatcher for browser-watchdog checks. |
| #697 | Step D: remove obsolete supervisor dispatch paths and finalize tray documentation. |
| #690 | Default watchdog background components off and add a safe uninstall. |
| #699 | Add an LLM-assisted GHCP watchdog through the tray; deterministic enforcement stays in the supervisor. |
| #701 | Tray workload: plugin update check (hourly for maintainers, daily by default). |
| #707 | Keep the marketplace catalog version in sync with the plugin version so update checks can see updates. |
| #710 | The tray update check always reports version-unknown. |
| #648 | Supervisor: a preventive GHCP restart window with a configurable quiet-time start and hard deadline. |
| #694 | Add a chat-first onboarding installer; installation currently demands too much prior knowledge. |

### Convergence: one product, two deployments

The owner decision is one storage source and a shared core consumed by both deployments. Implementation is intentionally staged and mostly unstarted. See [Domain-storage](Domain-storage) and [Domain-planner-shared-core](Domain-planner-shared-core).

| Issue | Gap and intended direction |
| --- | --- |
| #755 | Convergence roadmap: map remaining shared-product work to incremental, non-duplicative slices. Start with the host and profile seam. |
| #793 | Keep exactly one storage source and remove the multi-source combined board. |
| #752 | Stage the single-source transition without deleting or rerouting planner data. |
| #800 | Deployment profile, host provider seam and storage provider registry. |
| #751 | Add a default-preserving deployment profile and host-provider seam. |
| #753 | Unify provider registration without changing existing storage behaviour. |
| #754 | Add an opt-in Node journal-write CLI with parity to the existing write guards. |
| #656 | Preserve markdown journals with a parsed message model and safe merge. |
| #836 | Add cross-platform Planner agent tools backed by the same mutation core as the UI. |
| #650 | Pilot: prove shared package consumption through the shared sort. |
| #672 | Shared sorting: add an explicit opt-in alias capability without positional-argument drift. |
| #673 | Shared sorting: gate flag profiles with packed-package compatibility and rollback checks. |
| #798 | Folder-sync mirror replay can overwrite newer source content with a stale mirror copy. |
| #789 | OneDrive sync re-checks about 1,200 files every cycle, mostly agent browser logs in the planner folder. |
| #538 | The agent must not create side-project working files inside the planner data folder. |
| #651 | Feature concept: local-first sync engine with a conflict-resolution UI. |
| #652 | Feature concept: per-device agent and session linking with binding-time fingerprints. Specified in [Domain-agent-metadata](Domain-agent-metadata). |
| #653 | Feature concept: optional Azure DevOps saved-query integration, read-only. |
| #654 | Feature concept: PR lifecycle and PR description automation skills. |
| #655 | Feature concept: a watchdog and reliability supervisor for unattended automation. |

### Planner app UI, data integrity and security

| Issue | Gap and intended direction |
| --- | --- |
| #790 | `server.js` path guard allowed a sibling-prefix escape such as `../planner-config.json`. The guard now compares relative paths and the server tests pin sibling-prefix, absolute and encoded traversal refusals; the issue stays open until the owner reviews the fix. |
| #857 | The journal sidebar makes task journals and descriptive reports look like duplicates. |
| #826 | The Playwright app smoke gate is flaky on main (journal reload persistence, settings timing). |
| #640 | The task actions sheet renders below the fold on a narrow viewport, hiding Create Journal. |
| #587 | The row kebab and its action sheet are both named "Task actions" and never say which task they act on. |
| #577 | Tasks created in the Pacific evening are stamped with tomorrow's UTC date and show an age of `-1d`. |
| #528 | Adding a task can reuse a live task's id and silently destroy its row. |

### Session, workspace and runtime hygiene

| Issue | Gap and intended direction |
| --- | --- |
| #539 | `create_issue` gates on the calling project's GitHub link and ignores the explicit repository, so folder-only workspaces lose an explicit request. |
| #481 | Session state is never pruned: 4,109 directories and 2.6 GB since April, with stale locks in the path two liveness sweeps read. |
| #480 | A wedged copilot process leaks a session lock, so an abandoned session reads alive forever. |
| #452 | Worktree teardown does not release the session binding, so the task stays `reuse` pointing at a deleted workspace. |
