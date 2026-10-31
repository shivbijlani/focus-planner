# Roadmap

This page records known gaps and direction from the **200 open issues** in the project's tracker. Issues carrying a `priority:` label are grouped by that label first; every other issue is grouped by the recurring theme in its title and body. The system described in the other pages is **not finished**: each row below is something broken, missing or deliberately deferred. Read this beside [Behaviour](Behaviour), [Reliability](Reliability), [Prioritisation](Prioritisation) and the relevant `Domain-*` page.

## What the backlog says about direction

Five themes dominate.

1. **The coordinator must stay thin and enforceable.** The recurring failure is a rule that lives only in prose the agent is asked to follow (one send per run, a cutoff time, no turn on a snoozed or closed task, no gate edits) and is then broken. The intended fix is always the same: move the rule into a deterministic guard (`write-turn`, `session -ForDispatch`, a hook or the `scan` output) so it cannot be argued with. See [Prioritisation](Prioritisation).
2. **A signal must not be authored by the thing it gates.** Consent that is never spent, a `last_woken_at` stamp the agent writes, a "done" the agent declares that reads as the user's close, a doc comment whose author is not recorded. See [Prioritisation](Prioritisation) and [Domain-overnight-agent](Domain-overnight-agent).
3. **Unattended machinery needs health it can measure.** Tool probes that cold-start servers and measure load instead of health, supervisors that restart unrelated work, sweeps that measure a stale checkout. See [Reliability](Reliability).
4. **Docs are the primary agent-to-user surface and are young.** Observation, attribution, encoding and renderer edge cases are still open. See [Domain-docs](Domain-docs), [Domain-docs-core](Domain-docs-core) and [Domain-docs-publisher](Domain-docs-publisher).
5. **One product, several hosts.** Convergence work (shared packages, a deployment profile, one storage source, opt-in local-first sync) is planned in slices. See [Domain-planner-shared-core](Domain-planner-shared-core), [Domain-planner-tools](Domain-planner-tools) and [Domain-storage](Domain-storage).

## Critical

Eight issues carry `priority: critical`.

| Issue | Gap |
| --- | --- |
| #501 | An agent-declared "done" confers user-closed semantics: a Today row swallowed three user messages and released the Today gate. |
| #711 | `scan` takes 224 s and emits 507 KB, so the coordinator abandons it and the run does no task work. |
| #713 | The dispatch extension misses the host's 30 s ready window in scheduled sessions, so runs plan but never dispatch. |
| #716 | Make direct dispatch the only path and remove the drain extension that never loads in scheduled runs. |
| #734 | A user-paused task was dispatched, and the coordinator pushed the task session twice to override its refusal. |
| #736 | Task sessions never launch a closed browser slot, so every browser task was blocked. |
| #747 | Google Workspace tools fail in every session: the server speaks only the newer MCP protocol revision and the Copilot host requests an older one. |
| #758 | The critical-tool check raised a false Google outage and emailed the owner: the settings reader takes the whole cell and the probe treats a text reply as failure. |

## High

Thirty-five issues carry `priority: high`.

| Issue | Gap |
| --- | --- |
| #547 | A `folder` session's workspace is the planner data folder, so browser tooling wrote debris into the synced folder beside the board. |
| #549 | Reading files with the PowerShell raw-read default silently double-encodes UTF-8 and corrupts catch-up docs; a third corruption class is unguarded. |
| #560 | `awaiting_reply` is recovered by regex from the agent's prose; the intended fix is to declare the ask (see [Prioritisation](Prioritisation)). |
| #561 | Scheduling decisions are unauditable: `scan` is not replayable and no run records why a row was picked or skipped. |
| #562 | Session replacement can go backwards: a task was rebound to a session its own successor had already replaced. |
| #564 | A satisfied timer does not park its task; "parked until T" should be the single primitive for clock, third-party and human waits. |
| #565 | No spec-conformance forensics: many sweeps detect known defect shapes, nothing checks whether the system matches the spec. |
| #579 | A Prioritisation claim about a missing concurrency row disagrees with the code, which reports the default. |
| #583 | Six of twelve scheduled run slots recorded zero turns, so "fired and did nothing" is indistinguishable from healthy. |
| #589 | `in_flight` reports three against a ceiling of one and `scan` emits no per-row capacity field, so the membership is unobservable. |
| #605 | A due poll never fires on a Deferred row: the timer override is granted, then the Today gate discards it. |
| #618 | A declared ask is never validated against its own turn: two unguessable questions were declared an offer and no reader waited. |
| #627 | `eligible` binds selection but not work: journals gained turns on rows `scan` marked ineligible. |
| #638 | A host-sleep outage silenced every scheduled unit and left no record: the supervisor heartbeat stores only the last check time. |
| #643 | The supervisor restarts all Copilot sessions to clean up one finished run, interrupting unrelated work. |
| #717 | A code task whose worktree was deleted still reads `reuse`, so the run wakes a session with no checkout. |
| #718 | Non-code tasks have no creatable home: the app cannot make a projectless chat, so a travel task was put in a code worktree. |
| #720 | Tray quiet-window evidence is always incomplete on a box with 500+ sessions, so only the hard-deadline restart can fire. |
| #727 | A task session loaded the coordinator skill from its brief, risking recursive dispatch. |
| #728 | A dead task session still reads `reuse`, and its failed send uses the run's only dispatch slot. |
| #732 | An automation browser slot can spin at about two cores with a dead debugging port after its task ends, and nothing notices. |
| #738 | Browsers: let each Playwright server launch its own profile, give each task its own window, and replace the slot lifecycle. |
| #739 | New tasks ask approval for reversible, already-allowed work: PHASE 2 always proposes and waits. |
| #744 | The agent starts one task per run and stops: removing the drain extension removed "keep going until five minutes before the next run". |
| #748 | Fail loudly when a critical tool is down: a user-defined list, a probe at run start, one push alert, and a red tray state. |
| #750 | The coordinator runs past the next slot, dispatching until its cutoff and then working 17 more minutes. |
| #764 | The critical-tool probe marks healthy tools down under load: a cold-start probe times out and a timeout is treated as an outage. |
| #768 | The critical-tool check measures machine load, not tool health; probe through the coordinator's connected tools instead of cold-starting servers. |
| #771 | The coordinator ignores its cutoff and one-send rule (prose drift); enforce with a guard. |
| #780 | One task per run: a long-running task still busy from the previous run is re-sent every run and takes the only slot, starving eligible tasks. |
| #781 | Runs quit early instead of refilling: eligible tasks wait while the coordinator ends 17–19 minutes before its cutoff. |
| #783 | An explicit instruction is turned into a proposal: a direct request came back as a gated plan with an added step. |
| #784 | The inbox check still cold-starts MCP servers, so email, Telegram and Google "time out" and the inbox reads NOT CHECKED. |
| #785 | Remove the coordinator guard extension: it needs an interactive permission prompt, so it never loads in scheduled runs. |
| #817 | The Telegram bridge folds any group member's message as the owner's; enforce the sender id so nobody else added to the group can approve. |

## Medium

| Issue | Gap |
| --- | --- |
| #496 | Per-task session titles lose the planner task id, so worked tasks look undiscoverable. |
| #519 | PHASE 0 syncs two deploy targets but not the checkout PHASE 3 executes from, so "verified current" can be false. |
| #563 | The task menu reports "AI-assisted: Off" and "Persistent session: Off" for behaviour that is always on; cut the toggle. |
| #571 | `status_by` carries no close provenance: it says "agent" on nearly every row while `user_completed` is true on many. |
| #702 | Default the overnight agent and every task session it starts to the Auto model. |
| #719 | The tray update check can never find an update: marketplace browse has no version field. |
| #724 | `sync-oa-home` reports verified-current while the tray keeps running stale deployed files. |
| #729 | The non-code project setting fails every bind when the cell carries the template's note, and the error blames the arguments. |
| #733 | First-run setup should offer to remove Widgets and tune Defender for the dev drive. |
| #745 | Scope tool servers per session: a lean coordinator, with browsers and other tools only in task sessions that need them. |
| #761 | Session replacement churn: a healthy task was replaced twice in 84 minutes. |
| #778 | Parallel PHASE 0 steps collide on the state lock and need model retries. |

## Low

| Issue | Gap |
| --- | --- |
| #645 | Journal UX: a button to insert a todo without typing `- [ ]`. |
| #646 | Journal UX: a user-triggered compression that rewrites a long journal into one pinned part and one current response. |
| #743 | Browser shortcuts still use slot-style names; name them by account. |
| #772 | A manual critical-tool check writes a fake run into the run ledger. |

## Unprioritised, by theme

These issues have no `priority:` label. Their order within a theme is by number, not importance.

### Consent, gates and declared signals

| Issue | Gap |
| --- | --- |
| #465 | Consent is replayable: an affirmative is never spent, and whether it is depends on a marker the agent writes about itself. |
| #491 | Turns can advertise a reply word the consent reader rejects; the vocabulary guard pins the skill text, not the asks actually sent. |
| #511 | `merge <n>` is command-shaped but the number is never checked: one approval authorises any PR. |
| #513 | An ask can instruct a gate edit that cannot work: the floor is unscopable, so no allow rule can create an exception. |
| #514 | The one-turn-per-wake guard trusts a field the agent writes; stamping `last_woken_at` retroactively bypasses it. |
| #516 | Exhaustion has one word for two states ("queue drained" and "clock ran out") but only one is a fact about the row. |
| #518 | Turns can ask for an approval word the gate has already granted. |
| #520 | A guard that cannot run returns the same value as a guard with nothing to do; three instances of one shape. |
| #816 | The coordinator can write a turn on a snoozed task (rule is prose-only); enforce in `write-turn`. |
| #825 | `write-turn` should refuse an agent turn into a user-closed task. |
| #851 | Gated dispatch is enforced at `session -ForDispatch` but not at create-session or send-message. |

### Capacity, parking and wake bookkeeping

| Issue | Gap |
| --- | --- |
| #436 | `journal_stamped` is always false on a resolve, so a durable binding and an at-risk one look identical. |
| #487 | A task parked awaiting a reply holds a capacity slot forever, so dispatch deadlocks. |
| #494 | `journal_stamp_id` is always null, so a journal stamped with a different doc than state is indistinguishable from one that agrees. |
| #500 | A doc-bound task waiting on doc comments holds the only capacity slot. |
| #506 | Changing a poll or recheck cadence resets `next_due` to now, so "run less often" makes a blocked task run sooner. |
| #522 | Observing a doc-bound task's comments erases it from the capacity count. |
| #526 | A deterministic "blocked on human" flag and last-evaluated timestamp, readable by the planner UI. |
| #527 | No deterministic "blocked on human" flag: most tasks are parked on the owner and nothing says which. |
| #532 | `last_woken_at` is maintained only by prose, so a wake reusing a live binding leaves it stale. |
| #534 | `scan` is journal-driven, so a board row with no journal file is invisible to the whole run. |
| #540 | A user pausing a sub-session is invisible to PHASE 1: the next run wakes it straight back up. |
| #541 | A `blocked` task holds the only capacity slot because the capacity test excludes done and skip but not blocked. |
| #543 | `last_turn_at` is stamped by any status-only mark, so "a turn was written" is satisfiable without writing one. |
| #545 | `scan` emits the raw `unanswered_user` while every gate uses the closed-filtered one. |
| #556 | A reused task id makes a live task read `user_completed: true`, arming permanent reply suppression. |
| #569 | A user message above the sentinel is invisible to `reopened`: `scan` and extract disagree on the same file. |
| #600 | A forgotten `mark` makes the turn boundary end-of-file, so a raw reply below it is never seen. |
| #607 | A session that correctly does nothing is recorded as unwakeable. |
| #847 | Absent bound sessions silently starve every eligible task. |

### Journal writers and session lifecycle

| Issue | Gap |
| --- | --- |
| #452 | Worktree teardown does not release the session binding, so the task stays `reuse` pointing at a deleted workspace. |
| #454 | `agent-lore.md` is write-only: large, many headings, zero readers. |
| #457 | A session asserted a false negative about its own past actions after an id rollover and nothing could contradict it. |
| #462 | Both new write guards ship with caller-facing traps that fail toward the outcome they prevent. |
| #473 | Two writers, one journal: the run session and the task sub-session each append a turn for the same wake. |
| #476 | Zero writers, one journal: nothing detects when the sole-author sub-session writes nothing. |
| #477 | The one-turn guard enforces one turn per wake but not which author. |
| #480 | A wedged process leaks a session lock, so an abandoned session reads alive forever. |
| #481 | Session state is never pruned: thousands of directories and many stale locks sit in the path two liveness sweeps read. |
| #538 | The agent must not create side-project working files inside the planner data folder. |

### Docs, comments and Google Workspace

| Issue | Gap |
| --- | --- |
| #441 | Catch-up doc creation should be a plugin skill encoding the owner's doc preferences. |
| #442 | Design a way to approve in a Google Doc comment with positive attribution. |
| #459 | The run capabilities record does not declare the Google Workspace server, so the primary doc channel has no health probe. |
| #468 | A capability probe spawns a fresh server, so it cannot see the session's own dead connection. |
| #492 | An agent-authored doc asserted a number its own table contradicted and every guard passed. |
| #499 | The doc-claim consistency sweep flags append-only history it can never fix. |
| #502 | Doc comments read as empty: the observe command returns zero for the MCP server's own output shape. |
| #570 | The Google Workspace server probes AVAILABLE but is exposed to no agent session. |
| #593 | `scan` publishes new-comment counts without the freshness of the read behind them. |
| #594 | No sweep reads a catch-up doc's body, so a stale figure goes unflagged. |
| #598 | Binding a task creates a doc channel nobody polls. |
| #609 | `observe-bound-docs` declares failure with no retry, so a transient fetch and a broken document look identical. |
| #610 | A transient failure and a broken page print the identical FAIL line. |
| #612 | A cold Google Workspace server reports a healthy doc as unreadable. |
| #625 | `find_and_replace_doc` escapes a real newline into a literal backslash-n and reports success. |
| #626 | A stated finding and its own contradiction have equal standing in prose. |
| #763 | Catch-up doc creation duplicates documents when creation succeeds but binding fails. |
| #786 | The critical-tool preflight crashes under load and blocks every dispatch. |
| #838 | Docs app Phase 0: behaviour spec, data formats and JSON schemas. |
| #845 | Docs app S1: library, reader and the 📄 trio against sample docs. |
| #850 | The critical preflight records email absent without discovering deferred connected tools. |
| #852 | Docs S1: the `fp-docs` publisher command (publish, lint, status). |
| #854 | Docs S2: span comments, review merge and `fp-docs comments`. |
| #867 | Docs renderer: soft-wrapped lines split blocks and emphasis across wraps renders literally. |
| #868 | Docs app: remote revisions create sync-conflict copies and the open doc does not refresh. |

### Telegram

| Issue | Gap |
| --- | --- |
| #483 | Link mode never tidies the turn messages posted before binding. |
| #515 | Resolving a blocking ask strands its Telegram notice. |
| #588 | Telegram posts the doc link when the doc is bound, not when it is written. |
| #620 | A doc-bound topic settles on two messages, not one. |
| #628 | The collapse fixes cannot reach most bound topics because a message id was never recorded. |
| #832 | Telegram bridge: fold only the owner's messages and stamp them as from Telegram (the bridge slice of #817). |

### Provenance and GitHub issue hygiene

| Issue | Gap |
| --- | --- |
| #453 | Agentic issue comments carry no provenance marker, so "edit the one agentic comment in place" can overwrite a human comment. |
| #456 | `gh issue edit --body` is an unguarded overwrite and issue bodies carry no authorship. |
| #471 | The run summary asserts repository state it never queried. |
| #495 | Brief assembly reads "no open PR" as "unstarted", so shipped work is briefed as unstarted. |
| #505 | Run-session issue comments are unmarked, so every pass duplicates instead of editing. |
| #539 | `create_issue` gates on the calling project's GitHub link and ignores the explicit repository. |
| #630 | `OPEN` spans shipped-awaiting-review and filed-and-unworked, and the tracker renders them identically. |
| #632 | The shipped-but-open sweep is inert in the suite that runs it. |
| #635 | Triage should consult the shipped check before recommending work, not after. |
| #639 | The shipped check reports historical mentions as shipped work. |
| #684 | The shipped check reported five shipped issues as unworked and the guard is silent on that error. |

### Deploy, sweeps and tooling defects

| Issue | Gap |
| --- | --- |
| #461 | The encoding sweep resolves its root to the main checkout, so running it from a worktree reports clean. |
| #485 | Sweeps measure the working checkout, which nothing pulls, so a stale tree yields a confident wrong verdict. |
| #524 | PHASE 2's Google Tasks collect reads a truncated page as the whole backlog. |
| #533 | A budget expiry in the last phase leaves the two deploy targets on different refs. |
| #551 | The user-settings split backs up on every write and never prunes. |
| #554 | The Google Tasks collector calls a tool that does not exist. |
| #557 | `write-turn` prints a bare backup filename, so the rollback artifact looks missing. |
| #558 | Retire the board repair script: it reports phantom damage on a board the reader parses correctly. |
| #567 | A working-directory-relative settings candidate lets the bundled template override the real user settings. |
| #568 | The inbox probe budget is too short for MCP cold start, producing false NOT CHECKED. |
| #575 | The deploy REFUSE check is ancestry-blind: a just-merged file reads as a live fix. |
| #602 | The journal encoding mutation check fails on main: the guard validates call shape, not the encoding argument. |
| #613 | PHASE 3 dies with an unwrapped error when the box is at its commit limit. |
| #617 | Deploy backups are never pruned. |
| #622 | The telegram-bridge checkout is on no deploy manifest, so merged bridge code can stay inert. |
| #668 | Auto-deploy reports "DEPLOY NOT VERIFIED" when the deploy is verified. |
| #681 | A Node reader of the state store that forgets the UTF-8 BOM reports a confident zero over an empty set. |
| #789 | OneDrive sync re-checks about 1,200 files every cycle, mostly agent logs in the planner folder. |
| #804 | The end-to-end sandbox baseline on main has a failing hygiene scenario and a coordinator that sometimes works an approved task itself. |
| #808 | The state tool shifts doc-comment `observed_at` by the UTC offset on non-UTC hosts. |
| #814 | The turn-end backfill script cannot run: its dot-source cut point no longer exists. |
| #826 | The app smoke gate is flaky on main. |

### Supervisor, tray and onboarding

| Issue | Gap |
| --- | --- |
| #648 | Supervisor: a preventive restart window with a configurable quiet-time start and hard deadline. |
| #655 | Feature concept: a watchdog and reliability supervisor for unattended automation. |
| #689 | Make the reliability supervisor an optional tray app. |
| #690 | Default the watchdog background components off and add a safe uninstall. |
| #694 | Add a chat-first onboarding installer. |
| #695 | Add an optional tray app for supervision. |
| #696 | Make `user-settings.md` the canonical supervisor policy source. |
| #697 | Remove obsolete supervisor dispatch paths and finalise tray documentation. |
| #698 | Move browser-watchdog resident checks into the tray app. |
| #699 | Add LLM-watchdog integration through the tray supervisor. |
| #701 | Tray workload: plugin update check. |
| #707 | Keep the marketplace manifest version in sync with the plugin manifest so update checks can see updates. |
| #710 | The tray update check always reports version-unknown. |

### Planner app UI and data integrity

| Issue | Gap |
| --- | --- |
| #528 | Adding a task can reuse a live task's id and silently destroy that task's row. |
| #577 | Tasks created in the Pacific evening are stamped with tomorrow's UTC date and render an age of `-1d`. |
| #587 | The row kebab and its action sheet are both named "Task actions" without saying which task. |
| #640 | The task actions sheet renders below the fold on a narrow viewport. |
| #641 | Journal entries an agent writes through the UI composer are stamped as the owner's own. |
| #656 | Convergence: preserve markdown journals with a parsed message model and safe merge. |
| #790 | The server's path guard allows a sibling-prefix escape. |
| #857 | The journal sidebar makes task journals and descriptive reports look like duplicates. |

### Convergence, sync and storage

| Issue | Gap |
| --- | --- |
| #650 | Pilot: prove shared package consumption via the shared sort module. |
| #651 | Feature concept: a local-first sync engine with a conflict resolution UI. |
| #652 | Feature concept: robust per-device agent and session linking with binding-time fingerprints (see [Domain-agent-metadata](Domain-agent-metadata)). |
| #653 | Feature concept: optional read-only Azure DevOps saved-query integration. |
| #654 | Feature concept: PR lifecycle and description automation skills. |
| #672 | Shared sorting: an explicit opt-in alias capability. |
| #673 | Shared sorting: gate flag profiles with packed-package compatibility and rollback checks. |
| #751 | Convergence: a default-preserving deployment profile and host-provider seam. |
| #752 | Convergence: stage the single-source transition without deleting or rerouting planner data. |
| #753 | Convergence: unify provider registration without changing storage behaviour. |
| #754 | Convergence: an opt-in Node journal-write command with guard parity. |
| #755 | Convergence roadmap: map remaining shared-product work to incremental slices. |
| #793 | Keep exactly one storage source and remove the multi-source combined board. |
| #798 | Folder-sync mirror replay can overwrite newer source content with a stale mirror copy. |
| #800 | Deployment profile, host provider seam and storage provider registry. |
| #836 | Agent tools over the shared mutation core (shipped as [Domain-planner-tools](Domain-planner-tools); the issue stays open for the wider plan). |

## Reading the list

Issues describing mechanisms that now exist in the code are specified on their domain pages and in [Reliability](Reliability) as built; their rows here record the residual defect, not an absent feature. Where an issue names an intended fix, the row's wording states it.
