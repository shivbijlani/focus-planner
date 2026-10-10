# Roadmap

This page records **known gaps and forward direction** from the **200 open issues** captured in `spec-facts.json`. Entries with a `priority:` label are grouped by that label first. Remaining issues are grouped by the exact non-priority labels present, and issues with no labels are grouped by recurring themes from their titles and bodies. Use this alongside [Behaviour](Behaviour), [Reliability](Reliability), [Prioritisation](Prioritisation), and the relevant `Domain-*` page.

## Critical

8 open issues carry `priority: critical`. Most of them stop the overnight agent from doing any task work at all, or let it act against the user's wishes.

> [!NOTE]
> **Technical detail: concrete reference.** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

| Issue | Other labels | Title | Gap / direction from issue text |
| --- | --- | --- | --- |
| #758 | bug, overnight-agent | False Google outage alert from the critical-tool check | The check read the whole settings cell and treated a text reply as a failure, so a working Google Workspace was declared down and the user was emailed. The probe should parse the setting properly and accept a normal reply as healthy. |
| #747 | bug, overnight-agent | Google Workspace tools fail in every session | The server only speaks a newer protocol version than the host requests, so 19 of 19 recent sessions failed to connect. The server and host need to agree on a protocol version, with a visible failure if they do not. |
| #736 | bug, overnight-agent | Task sessions never launch a closed browser slot | All three automation browsers were down and nothing started them, so every browser task blocked. Sessions should launch a closed profile on demand. |
| #734 | bug, overnight-agent | Paused task was dispatched and pushed twice | The coordinator sent work to a task the user had paused, then pushed the session again to override its refusal. A paused task must never be dispatched, and the rule should be enforced in code rather than prose. |
| #716 | bug, overnight-agent | Make direct dispatch the only path | The helper extension that provides drain tools never loads in scheduled runs. Remove it and make direct dispatch to task sessions the single path. |
| #713 | bug, overnight-agent | Dispatch extension misses the host's ready window | In scheduled sessions the dispatch tools were missing, so runs planned work and never sent it. Superseded in direction by dropping the extension entirely. |
| #711 | bug, overnight-agent | State scan is too slow and too large | The scan took minutes and emitted hundreds of kilobytes, so the coordinator gave up and did no work. The scan needs to be fast and compact enough to finish inside the run's patience window. |
| #501 | bug, reliability | Agent-declared done acts as user-closed | A task the agent marked done gained the semantics of one the user closed, so three user messages became invisible and the Today gate released. Only the user should be able to close a task. |

</details>

## High

35 open issues carry `priority: high`. They cluster around the overnight coordinator's dispatch loop, critical-tool probing, browser slots, and the spec-conformance measurements.

> [!NOTE]
> **Technical detail: concrete reference.** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

| Issue | Other labels | Title | Gap / direction from issue text |
| --- | --- | --- | --- |
| #785 | bug, overnight-agent | Remove the coordinator guard extension | It needs an interactive permission prompt, so it never loads in scheduled runs and enforces nothing. Remove it and enforce the rules in the scripts. |
| #784 | bug, overnight-agent | Inbox check still cold-starts tool servers | Email, Telegram and Google timed out and the inbox was reported as not checked. Probe through already-connected tools instead of spawning servers. |
| #783 | bug, overnight-agent | Explicit instruction turned into a proposal | A plain "use X to generate a report" came back as a gated plan awaiting approval. Explicit instructions from the user should be carried out, not re-proposed. |
| #781 | bug, overnight-agent | Runs quit early instead of refilling | Thirteen eligible tasks waited while the coordinator ended well before its cutoff. The refill loop should keep dispatching until the start cutoff. |
| #780 | bug, overnight-agent | One task per run | A long-running task from the previous run is re-sent every run and occupies the only slot, starving others. Busy tasks should not be re-sent. |
| #771 | bug, overnight-agent | Coordinator ignores cutoff and one-send rule | It waited on a task and nudged it past its end time, delaying the next run. Enforce the cutoff and one-send rule in code. |
| #768 | bug, overnight-agent | Critical-tool check measures machine load | Timeouts under load escalated to a false "down". Probe tool health through the coordinator's own connected tools. |
| #764 | bug, overnight-agent | Probe marks healthy tools down under load | A cold-start probe timing out at its budget was treated as failure. A timeout should read as slow, not down. |
| #750 | bug, overnight-agent | Coordinator runs past the next slot | After dispatching until cutoff it kept working and delayed the following run. It must end before the next slot. |
| #744 | bug, overnight-agent | One task per run and stop | Removing the drain extension also removed the "keep going until shortly before the next run" behaviour. Restore continuous pickup. |
| #739 | bug, overnight-agent | Approval asked for reversible, allowed work | New tasks always propose and wait, even when standing rules already allow the steps. Skip the approval gate when consent already exists. |
| #738 | bug, overnight-agent | Let each browser server launch its own profile | Switch from attach-only to launch-own-profile, give each task its own window, and replace the slot table. |
| #732 | bug, overnight-agent | Browser slot spins with a dead debug port | A browser kept using about two cores after its task ended and nothing noticed. Add detection and cleanup. |
| #728 | bug, overnight-agent | Dead session reads reuse and wastes the dispatch | A failed send to a dead bound session consumed the run's only dispatch. Detect dead sessions and fall through to the next task. |
| #727 | bug, overnight-agent | Task session loaded the coordinator skill | Loading it from the brief risks recursive dispatch. The brief must not trigger the coordinator skill. |
| #720 | bug, overnight-agent | Tray quiet-window evidence always incomplete | With hundreds of sessions the evidence never completes, so only the hard-deadline restart can fire. Make quiet detection scale. |
| #718 | bug, overnight-agent | Non-code tasks have no creatable home | The app cannot create a projectless chat, so a travel task landed in a code workspace. Provide a supported home for non-code tasks. |
| #717 | bug, overnight-agent | Deleted worktree still reads reuse | The run wakes a session whose checkout is gone. Binding verdicts must check the workspace exists. |
| #547 | bug, overnight-agent | Session in the data folder wrote debris there | A folder session's workspace is the planner data store, so browser tooling wrote hundreds of kilobytes of debris that syncs everywhere. Keep tool output out of the data folder. |
| #549 | bug, reliability, overnight-agent | Silent double encoding of UTF-8 | A raw file read corrupted a catch-up doc; it was caught on readback. Add a guard for this third corruption class. |
| #643 | bug, reliability | Supervisor restarts every session for one finished run | An unrelated active session was interrupted. Restart only what is stuck. |
| #638 | bug, reliability | Host sleep silenced every schedule with no record | The heartbeat stores too little to show a long outage. Record gaps so they are visible afterwards. |
| #627 | bug, reliability | Eligible binds selection but not work | Admits stayed zero for hours while journals gained turns. Tie eligibility to actual work. |
| #618 | bug, reliability | Declared ask never validated against its turn | A turn can declare an offer it cannot actually satisfy. Validate the declaration against the turn. |
| #605 | bug, reliability | Due poll never fires on a deferred row | The timer override is granted, then the Today gate discards it. Let a due poll actually run. |
| #589 | bug, reliability | In-flight count exceeds the ceiling | Three in flight against a limit of one, and scan gives no per-row capacity field. Expose capacity per row. |
| #583 | bug, reliability | Half of scheduled slots recorded zero turns | "Fired" does not mean "worked". Measure and surface runs that did nothing. |
| #579 | bug, reliability | Spec claims settings-malformed; code says default | The Prioritisation page describes behaviour and a settings table the code does not have. Align doc and code. |
| #564 | bug, reliability | Satisfied timer does not park its task | Make "parked until T" the single primitive for clock, third-party and human waits. |
| #562 | bug, reliability | Session replacement can go backwards | A task was rebound to a session its successor had already replaced, forming a cycle. Replacement must be monotonic. |
| #560 | bug, reliability | awaiting_reply recovered by regex from prose | Declare the ask explicitly instead of inferring it from the agent's closing line. |
| #748 | enhancement, overnight-agent | Fail loudly when a critical tool is down | A user-defined list of critical tools with sensible defaults, probed at run start. |
| #565 | enhancement, reliability | No spec-conformance forensics | Existing sweeps only detect known defect shapes. Add a check that the system matches the spec. |
| #561 | enhancement, reliability | Scheduling decisions are unauditable | Nothing records why a row was picked or skipped. Make scan replayable and log decisions. |
| #817 | none | Telegram bridge folds any member's message as the user's | Anyone added to the group could approve. Enforce the sender and stamp the source. |

</details>

## Medium

12 open issues carry `priority: medium`.

> [!NOTE]
> **Technical detail: concrete reference.** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

| Issue | Other labels | Title | Gap / direction from issue text |
| --- | --- | --- | --- |
| #778 | bug, overnight-agent | Parallel startup steps collide on the state lock | Concurrent records fail with lock timeouts. Serialise or retry. |
| #761 | bug, overnight-agent | Session replacement churn | A healthy task was replaced twice in under two hours. Reduce replacement frequency. |
| #729 | bug, overnight-agent | Non-code project setting fails every bind | The setting cell carries the template's note and the error blames the wrong argument. Parse the cell and fix the message. |
| #724 | bug, overnight-agent | Sync reports current while the tray runs stale files | Verification must cover what is actually running. |
| #719 | bug, overnight-agent | Tray update check can never find an update | The marketplace listing has no version field. Read the version another way. |
| #563 | bug | Task menu shows toggles that read Off | Two labels are untrue for always-on behaviour; remove the persistent-session control. |
| #496 | bug | Session titles lose the planner task id | Worked tasks look undiscoverable. Keep the task id in the title. |
| #571 | bug, reliability | status_by carries no close provenance | It says agent on nearly every row while the user completed many. Record true provenance. |
| #519 | bug, reliability | Deploy syncs two targets but not the executing checkout | Reports current while the bridge runs old code. Cover the third target. |
| #745 | enhancement, overnight-agent | Scope tool servers per session | A lean coordinator, with browsers only in task sessions that need them. |
| #733 | enhancement, overnight-agent | First-run setup for Widgets and Defender | Offer to remove Widgets and tune Defender so new users do not get a sluggish PC. |
| #702 | overnight-agent | Default to the Auto model | Use Auto for the coordinator and every task session. |

</details>

## Low

4 open issues carry `priority: low`.

> [!NOTE]
> **Technical detail: concrete reference.** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

| Issue | Other labels | Title | Gap / direction from issue text |
| --- | --- | --- | --- |
| #772 | bug, overnight-agent | Manual critical-tool check writes a fake run | The ledger gains a run for a chat session. Manual checks should not append runs. |
| #743 | bug, overnight-agent | Browser shortcuts named by debug port | Name shortcuts by account instead. |
| #646 | enhancement | Journal compression button | A user-triggered rewrite of a long journal into one pinned part and one current response. |
| #645 | enhancement | Journal insert-todo button | Adding a todo should not require typing the checkbox syntax by hand. |

</details>

## Labelled but unprioritised

32 open issues have labels, but none of those labels is a `priority:` band. The tables below keep the grouping faithful to the data instead of inventing a priority order.

### `reliability`

Three gaps where deploy and wake bookkeeping can drift from reality.

> [!NOTE]
> **Technical detail: concrete reference.** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

| Issue | Other labels | Title | Gap / direction from issue text |
| --- | --- | --- | --- |
| #533 | none | Deploy budget expiry leaves targets on different versions | Expiry in the last phase splits the two targets. Make the pair consistent or report it. |
| #532 | none | Last-woken stamp maintained only by prose | Reused bindings leave it stale and the one-turn guard refuses every author. Stamp it in code. |
| #436 | none | Doc state always reports not stamped on resolve | A durable and an at-risk binding look identical. Report the real stamp. |

</details>

### `bug`

> [!NOTE]
> **Technical detail: concrete reference.** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

| Issue | Other labels | Title | Gap / direction from issue text |
| --- | --- | --- | --- |
| #790 | none | Local server path guard allows sibling-prefix escape | A prefix check lets a sibling folder name through. Resolve and compare with a path separator. |
| #684 | none | Shipped-check reported five shipped issues as unworked | The turn guard is silent on exactly that error. Make it refuse. |
| #681 | none | Node reader forgets the UTF-8 byte-order mark | It reports a confident zero over an empty set. Strip the mark. |
| #628 | none | Collapse fixes cannot reach most bound topics | A message whose id was never recorded is unreachable. Record or recover ids. |
| #626 | none | A finding and its contradiction have equal standing | The correct answer was sent and lost twice. Validate stated findings. |
| #625 | none | Doc find-and-replace escapes newlines | A real newline becomes literal characters while the tool reports success. Detect and fix. |
| #602 | none | Journal encoding mutation check fails on main | The guard validates call shape, not the encoding argument. |
| #557 | none | Turn writer prints a bare backup filename | The rollback artifact looks missing. Print the full path. |
| #528 | none | Adding a task can reuse a live task's id | The existing row is silently destroyed. Allocate unused ids and warn. |
| #502 | none | Doc comments read as empty | Observe returns zero for the server's own output shape. Accept that shape. |

</details>

### `bug + overnight-agent`

> [!NOTE]
> **Technical detail: concrete reference.** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

| Issue | Other labels | Title | Gap / direction from issue text |
| --- | --- | --- | --- |
| #612 | bug, overnight-agent | Cold doc server reports a healthy doc as unreadable | The earlier short retry cannot cross the cold start. Lengthen or warm the retry. |

</details>

### `bug + reliability + overnight-agent`

> [!NOTE]
> **Technical detail: concrete reference.** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

| Issue | Other labels | Title | Gap / direction from issue text |
| --- | --- | --- | --- |
| #610 | bug, reliability, overnight-agent | Transient failure and broken page print the same FAIL | Polling once hides the difference. Retry and classify. |
| #461 | bug, reliability, overnight-agent | Encoding sweep resolves a hardcoded root | Run from a worktree it scans a different tree. Use the invoking tree. |
| #454 | bug, reliability, overnight-agent | Lore file is write-only | A very large file with no readers. Make it retrievable. |
| #453 | bug, reliability, overnight-agent | Agent issue comments carry no provenance marker | Editing the agent comment in place can overwrite a human one. Mark them. |
| #428 | bug, reliability, overnight-agent | Merged PR auto-closes its issue | The review step the contract requires is skipped. Avoid closing keywords. |

</details>

### `bug + reliability`

> [!NOTE]
> **Technical detail: concrete reference.** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

| Issue | Other labels | Title | Gap / direction from issue text |
| --- | --- | --- | --- |
| #789 | bug, reliability | Cloud sync rechecks about 1,200 files each cycle | Mostly agent browser logs in the planner folder. Exclude them. |
| #457 | bug, reliability | Session asserted a false negative about its past actions | An id rollover left nothing to contradict it. Keep history across ids. |
| #452 | bug, reliability | Worktree teardown keeps the session binding | The task stays bound to a deleted workspace. Release on teardown. |

</details>

### `enhancement`

Seven feature concepts borrowed from a sibling implementation, plus a shared-package pilot.

> [!NOTE]
> **Technical detail: concrete reference.** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

| Issue | Other labels | Title | Gap / direction from issue text |
| --- | --- | --- | --- |
| #656 | none | Parsed journal message model with safe merge | Move from raw markdown sentinels to a structured model while preserving markdown. |
| #655 | none | Watchdog supervisor concept | Bring a reliability supervisor for unattended automation across. |
| #654 | none | PR lifecycle and description skills | Automate PR hygiene with poster and diagram skills. |
| #653 | none | Optional read-only work-tracker queries | An opt-in saved-query integration. |
| #652 | none | Per-device session linking with fingerprints | Robust agent and session links per device. |
| #651 | none | Local-first sync engine with conflict UI | An outbox and merge UI in front of storage. |
| #650 | none | Pilot shared package consumption | Prove sharing sorting code between two sibling repos. |

</details>

### `enhancement + reliability`

> [!NOTE]
> **Technical detail: concrete reference.** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

| Issue | Other labels | Title | Gap / direction from issue text |
| --- | --- | --- | --- |
| #648 | enhancement, reliability | Preventive restart window | A quiet-time start and a hard deadline for restarting the app. |

</details>

### `overnight-agent`

> [!NOTE]
> **Technical detail: concrete reference.** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

| Issue | Other labels | Title | Gap / direction from issue text |
| --- | --- | --- | --- |
| #851 | overnight-agent | Gated dispatch not enforced at send time | The floor applies only at the dispatch stamp. Enforce it when sending too. |
| #433 | overnight-agent | Nudge threshold fires on every doc-bound turn | Measure the distribution before re-tuning. |

</details>

## Unlabelled issues, grouped by theme

109 open issues have no labels at all in `spec-facts.json`. Because the data offers no explicit priority for them, the groups below follow the recurring topics visible in their titles and bodies. See [Reliability](Reliability) for the failure model behind most groups.

### Docs, catch-up documents, and Telegram notices

> [!NOTE]
> **Technical detail: concrete reference.** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

| Issue | Other labels | Title | Gap / direction from issue text |
| --- | --- | --- | --- |
| #854 | none | Docs comments stage | Span comments, review merge and the comments command, following the Docs spec. |
| #852 | none | Docs publisher command | Publish, lint and status, following the spec. |
| #845 | none | Docs app library and reader | Build the reader against sample documents first. |
| #838 | none | Docs behaviour spec | Spec only: behaviour, formats and schemas. No code. |
| #832 | none | Telegram bridge folds only the owner | Owner-only folding with a source stamp. |
| #763 | none | Doc creation duplicates on bind failure | Retry after a failed bind makes duplicates. Make creation idempotent. |
| #620 | none | Doc-bound topic settles on two messages | The user expects one message per task. |
| #613 | none | Mirror dies with an unwrapped error | A commit-limit failure names nothing actionable. Wrap it. |
| #609 | none | Bound-doc observer fails on first try | No retry, so transient and broken look the same. |
| #598 | none | Doc channel nobody polls | Reads happen per selected task, so parked tasks are ignored. |
| #594 | none | No sweep reads doc bodies | A stale figure in the primary surface goes unflagged. |
| #593 | none | Scan omits freshness of comment reads | Never-observed and observed-empty look identical. |
| #588 | none | Link posted at bind time, not write time | Most links pointed at placeholder docs. |
| #570 | none | Doc tool probes available but unreachable from sessions | The comment channel is unreadable where the work happens. |
| #515 | none | Resolving an ask strands its notice | The message keeps the last ask forever. |
| #492 | none | Doc asserted a number its table contradicted | Check internal consistency of agent-written docs. |
| #483 | none | Link mode never tidies earlier turn messages | Collapse only runs on the replaced path. |
| #468 | none | Probe cannot see a dead session connection | Green probe, dead channel. Check the live connection. |
| #459 | none | Capabilities file omits the doc server | The primary channel has no startup probe. |
| #442 | none | Approve from a doc comment | Attribution must be positive, not inferred. |
| #441 | none | Doc creation as a plugin skill | Encode the user's doc preferences. |

</details>

### Dispatch, consent, and capacity semantics

> [!NOTE]
> **Technical detail: concrete reference.** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

| Issue | Other labels | Title | Gap / direction from issue text |
| --- | --- | --- | --- |
| #847 | none | Absent bound sessions starve every task | Zero sends from repeated unknown status. Fall back to a fresh session. |
| #825 | none | Turn into a user-closed task not refused | Rule is prose only. Enforce in the turn writer. |
| #816 | none | Turn on a snoozed task not refused | Same, for snoozed tasks. |
| #804 | none | Sandbox baseline fails hygiene and works approved task | The coordinator sometimes does the work itself. |
| #607 | none | Correctly idle session recorded as dead | Three sessions burned. Treat a no-op wake as alive. |
| #600 | none | Forgotten mark makes a reply invisible | Missing terminator hides later replies. |
| #569 | none | User message above the sentinel is invisible | Scan and extract disagree. |
| #545 | none | Raw unanswered count disagrees with gates | Closed tasks raise an ask nobody acts on. |
| #543 | none | Status-only mark stamps last turn | Satisfiable without writing a turn. |
| #541 | none | Blocked task holds the only slot | Exclude blocked from capacity. |
| #540 | none | Paused sub-session invisible to dispatch | The next run wakes it anyway. |
| #534 | none | Row without journal invisible to the run | Scan is journal-driven. |
| #527 | none | No blocked-on-human flag or evaluated time | Most tasks wait on the user and nothing says when last checked. |
| #526 | none | Blocked-on-human flag readable by UI | Design together before implementing. |
| #522 | none | Observing doc comments erases capacity count | A live session is not counted. |
| #520 | none | Guard that cannot run looks like nothing to do | One recurring shape. Return distinct states. |
| #518 | none | Turns ask for an already-granted approval | Valid but unnecessary asks. |
| #516 | none | One word for drained and clock-ran-out | Only one should release the gate. |
| #514 | none | One-turn guard trusts an agent-written field | Stamping it bypasses the guard. |
| #513 | none | Ask instructs an impossible gate edit | The floor cannot be scoped by allow rules. |
| #511 | none | Merge approval does not check the number | One approval authorises any PR. |
| #506 | none | Cadence change resets due to now | Running less often makes it run sooner. |
| #500 | none | Doc-waiting task holds the only slot | Dismissive by design, yet blocks dispatch. |
| #491 | none | Turns advertise a reply word the reader rejects | Check advertised words against accepted ones. |
| #487 | none | Parked task holds a slot forever | Counts sessions that cannot be worked. |
| #477 | none | One-turn guard ignores which author | The run wrote first and locked out the owner. |
| #476 | none | Zero writers, one journal | Nothing detects a sub-session that writes nothing. |
| #473 | none | Two writers, one journal | Run and sub-session each append for one wake. |
| #471 | none | Run summary asserts unqueried state | Two false claims caught only later. |
| #465 | none | Consent is replayable | An approval is never spent. |

</details>

### Critical-tool probes, settings, and collectors

> [!NOTE]
> **Technical detail: concrete reference.** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

| Issue | Other labels | Title | Gap / direction from issue text |
| --- | --- | --- | --- |
| #850 | none | Preflight marks email absent without discovery | Try deferred tool discovery and a real call first. |
| #786 | none | Preflight crashes under load and blocks dispatch | It spawns a very large script with a short timeout. |
| #568 | none | Inbox probe budget too short | Healthy inbox reported not checked. |
| #567 | none | Working-directory settings candidate wins | The bundled template can override real settings. |
| #554 | none | Google Tasks collector calls a missing tool | It has never succeeded. |
| #524 | none | Collector reads a truncated page as everything | Nine open versus thirty-five real. |
| #814 | none | Backfill script cannot run | Its cut point no longer exists. |
| #808 | none | Doc-comment time shifted by UTC offset | CI runners are UTC so they cannot see it. |
| #539 | none | Issue creation gates on the wrong project link | Folder-only workspaces silently fail. |

</details>

### Deploy propagation, tray supervisor, and checkout drift

> [!NOTE]
> **Technical detail: concrete reference.** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

| Issue | Other labels | Title | Gap / direction from issue text |
| --- | --- | --- | --- |
| #710 | none | Update check always version-unknown | The CLI listing omits versions. |
| #707 | none | Catalog version out of sync with plugin | Keep both versions equal. |
| #701 | none | Tray plugin update workload | Hourly for maintainers, daily by default. |
| #699 | none | LLM watchdog through the tray | Diagnose; leave enforcement to the supervisor. |
| #698 | none | Browser watchdog checks in the tray | Make the tray the sole dispatcher. |
| #697 | none | Remove obsolete supervisor paths | Final cleanup and docs. |
| #696 | none | Settings file as supervisor policy source | One canonical policy section. |
| #695 | none | Optional tray app | First step: a single out-of-process app. |
| #694 | none | Chat-first onboarding installer | Less prior knowledge needed. |
| #690 | none | Watchdog components default off | Safe uninstall. |
| #689 | none | Supervisor as optional tray app | Off until enabled. |
| #668 | none | Deploy not verified false alarm | A dirty third checkout trips it. |
| #622 | none | Bridge checkout on no deploy manifest | Merged code can stay inert. |
| #617 | none | Deploy backups never pruned | Hundreds in under two weeks. |
| #575 | none | Deploy refusal ignores ancestry | Just-merged file reads as live fix. |
| #551 | none | Settings backups never pruned | Synced folder grows. |
| #485 | none | Sweeps read a checkout nothing pulls | Stale tree, confident verdict. |

</details>

### Shared-product convergence and storage

> [!NOTE]
> **Technical detail: concrete reference.** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

| Issue | Other labels | Title | Gap / direction from issue text |
| --- | --- | --- | --- |
| #836 | none | Cross-platform agent tools on the UI mutation core | Manage the data folder without a browser. |
| #800 | none | Deployment profile and provider registry | Host seam and registry. |
| #798 | none | Mirror replay can overwrite newer content | Pre-existing stale overwrite. |
| #793 | none | Keep exactly one storage source | Remove the combined board. |
| #755 | none | Convergence roadmap | Map remaining work to slices. |
| #754 | none | Node journal-write CLI | Guard parity. |
| #753 | none | Unify provider registration | Without changing behaviour. |
| #752 | none | Stage single-source transition | No deleting or rerouting data. |
| #751 | none | Default-preserving profile seam | Host provider boundary. |
| #673 | none | Shared sorting compatibility gates | Packed-package and rollback checks. |
| #672 | none | Shared sorting opt-in alias | Without positional drift. |

</details>

### Planner app UI and data integrity

> [!NOTE]
> **Technical detail: concrete reference.** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

| Issue | Other labels | Title | Gap / direction from issue text |
| --- | --- | --- | --- |
| #857 | none | Journal sidebar looks duplicated | Distinguish journal from supporting report and keep both. |
| #826 | none | Smoke gate flaky on main | Journal reload and settings timing. |
| #641 | none | Agent entries stamped as the user | UI composer marks agent prose as me. |
| #640 | none | Actions sheet below the fold | Create Journal off screen on narrow views. |
| #587 | none | Row menu never says which task | Name the task. |
| #577 | none | Evening tasks dated tomorrow | UTC date, negative age. |
| #558 | none | Retire board-repair tool | Reports phantom damage. |
| #556 | none | Reused id reads user-completed | Arms permanent reply suppression. |

</details>

### Issue tracking and write guards

> [!NOTE]
> **Technical detail: concrete reference.** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

| Issue | Other labels | Title | Gap / direction from issue text |
| --- | --- | --- | --- |
| #639 | none | Shipped check counts historical mentions | Fails in the dangerous direction. |
| #635 | none | Triage should check shipped first | Before recommending work. |
| #632 | none | Shipped sweep inert | Wrapper cwd is not a checkout. |
| #630 | none | Open spans shipped and unworked | Render them differently. |
| #505 | none | Run issue comments unmarked | Later passes duplicate. |
| #499 | none | Claim sweep pins unfixable finding | Immutable history. |
| #495 | none | No open PR read as unstarted | Shipped awaiting review looks identical. |
| #494 | none | Journal stamp id always null | Differing docs indistinguishable. |
| #462 | none | Write guards have caller traps | Fail toward the prevented outcome. |
| #456 | none | Issue body edit is unguarded overwrite | Bodies carry no authorship. |

</details>

### Session and workspace hygiene

> [!NOTE]
> **Technical detail: concrete reference.** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

| Issue | Other labels | Title | Gap / direction from issue text |
| --- | --- | --- | --- |
| #538 | none | Agent writes side-project files in the data folder | Not scratch space. |
| #481 | none | Session state never pruned | Thousands of directories and stale locks. |
| #480 | none | Wedged process leaks a session lock | Abandoned session reads alive. |

</details>
