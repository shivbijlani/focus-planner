# Roadmap

This page records the **known gaps and forward direction** of the system, taken from the 200 open issues. The system described on the other pages is largely built; what follows is what is broken, missing, or planned. Issues are grouped by priority label, and unprioritised issues by theme. Read it with [Behaviour](Behaviour), [Reliability](Reliability) and [Prioritisation](Prioritisation).

Three tendencies run through the list. Most open work is on the **autonomous overnight agent**, because an unattended system fails in ways nobody is watching. Many items are the same failure shape — *a guard that cannot run looks the same as a guard with nothing to do*, or *a signal the agent writes about itself is trusted as if the user wrote it*. And a smaller strand is **convergence**: making one codebase serve a consumer build and an enterprise build.

## Critical (8)

These stop the agent from doing its job or let an agent action carry user authority.

- **#501** — A task the agent marked done acquires the semantics of a task the user closed, so a Today row swallowed three user messages and released the Today gate. Direction: separate agent-declared completion from user closure.
- **#758** — The critical-tool check raised a false Google outage and emailed the owner: the settings reader takes the whole table cell, and the probe treats a text reply as a failure.
- **#747** — Google Workspace tools fail in every session: the server speaks only the newest MCP protocol revision while the host requests an older one.
- **#736** — Task sessions never launch a closed browser slot, so every browser task has been blocked.
- **#734** — A user-paused task was dispatched, then the coordinator pushed the task session twice to override its refusal. The refusal must be obeyed, not worked around.
- **#716** — Make direct dispatch the only path and remove the drain extension, which never loads in scheduled runs.
- **#713** — The dispatch extension misses the host's 30-second ready window in scheduled sessions, so runs plan but never dispatch.
- **#711** — `scan` takes 224 seconds and emits 507 KB, so the coordinator abandons it and the run does no task work. Direction: bound the size and time of the worklist.

## High (35)

### Run loop: dispatch, pacing and the coordinator

- **#785** — Remove the coordinator guard extension: it needs an interactive permission prompt, so it never loads in scheduled runs and nags other sessions.
- **#781** — Runs quit early instead of refilling: eligible tasks wait while the coordinator ends well before its cutoff.
- **#780** — One task per run: a long-running task still busy from the previous run is re-sent every run and takes the only slot, starving eligible tasks.
- **#771** — The coordinator ignores its cutoff and one-send rule (prose drift); direction is mechanical enforcement.
- **#750** — The coordinator runs past the next slot, delaying the following run.
- **#744** — The agent starts one task per run and stops: removing the drain extension also removed "keep going until five minutes before the next run".
- **#728** — A dead task session still reads as reusable, and its failed send uses up the run's only dispatch slot.
- **#727** — A task session loaded the coordinator skill from its brief, risking recursive dispatch.
- **#717** — A code task whose worktree was deleted still reads as reusable, so the run wakes a session with no checkout.
- **#718** — Non-code tasks have no creatable home: the app cannot make a projectless chat, so a travel task landed in a code worktree.
- **#738** — Browsers: let each automation browser launch its own profile, give each task its own window, and replace the slot lifecycle.
- **#732** — An automation browser slot can spin at about two cores with a dead debug port after its task ends, and nothing notices.

### Consent, gating and prioritisation

- **#783** — An explicit instruction is turned into a proposal gated on approval.
- **#739** — New tasks ask for approval of reversible, already-allowed work because the proposal phase always proposes and waits.
- **#618** — A declared ask is never validated against its own turn: a turn can declare an offer while asking a question nobody awaits (25 of 254 rows).
- **#605** — A due poll never fires on a Deferred row: the workable check grants the timer override, then the Today gate discards it.
- **#589** — `in_flight` reports 3 against a ceiling of 1, and `scan` emits no per-row capacity field, so the membership is unobservable.
- **#579** — The documented settings table for concurrency does not exist in the live settings file, so concurrency, the gate backstop and strictness all run on silent defaults.
- **#564** — A satisfied timer does not park its task. Direction: make "parked until T" the single primitive for clock, third-party and human waits.
- **#560** — `awaiting_reply` is recovered from the agent's prose rather than declared; the declared ask is the shipped direction and this issue tracks its completion (see [Prioritisation](Prioritisation)).
- **#562** — Session replacement can go backwards: a task was rebound to a session its own successor had already replaced.
- **#627** — `eligible` binds selection but not work: admissions stayed zero for six hours while journals gained turns, two on rows marked ineligible.
- **#561** — Scheduling decisions are unauditable: `scan` is not replayable and no run records why a row was picked or skipped.
- **#565** — No spec-conformance forensics: dozens of sweeps detect known defect shapes, but nothing checks that the system matches the spec.

### Critical-tool health

- **#784** — The inbox check still cold-starts tool servers, so email, Telegram and Google "timed out" and the run reported the inbox not checked.
- **#768** — The critical-tool check measures machine load, not tool health; probe through the coordinator's connected tools instead.
- **#764** — A cold-start probe times out under load and a timeout is treated as an outage.
- **#748** — Fail loudly when a critical tool is down: a user-defined list, a probe at run start, one push alert, and a red state.

### Security, reliability and data integrity

- **#817** — The Telegram bridge folds any group member's message as the owner's, so anyone added to the group could approve. Direction: enforce the owner's sender id (bridge slice in #832).
- **#549** — A whole-file read silently double-encodes UTF-8 and corrupts catch-up docs — a third corruption class, still unguarded.
- **#547** — A `folder` session's workspace is the planner data folder, so browser automation wrote debris into OneDrive beside the board.
- **#643** — The supervisor restarts all sessions to clean up one finished run, interrupting unrelated active work.
- **#638** — A 5h49m host-sleep outage silenced every scheduled unit and left no record, because the heartbeat stores only the last check time.
- **#720** — Tray quiet-window evidence is always incomplete on a machine with hundreds of sessions, so only the hard-deadline restart can fire.
- **#583** — Half the scheduled run slots in a six-hour window recorded zero turns, so "fired and did nothing" is indistinguishable from "never fired".

## Medium (12)

- **#778** — Parallel start-of-run steps collide on the state lock and need model retries.
- **#761** — Session replacement churn: a healthy task was replaced twice in 84 minutes.
- **#745** — Scope tool servers per session: a lean coordinator, with browsers and other tools only in task sessions that need them.
- **#733** — First-run setup should offer to remove widgets and tune antivirus for the dev drive, so new users do not get a sluggish PC.
- **#729** — The non-code task project setting fails every bind when the cell carries the template's note, and the error blames the arguments.
- **#724** — The deploy sync reports verified-current while the tray keeps running stale deployed files.
- **#719** — The tray update check can never find an update: the marketplace listing has no version field.
- **#702** — Default the Overnight Agent and every task session it starts to the Auto model.
- **#571** — `status_by` carries no close provenance: it says "agent" on nearly every row while user completion is true on dozens, so #501's conformance check is unevaluable.
- **#563** — The task menu reports "AI-assisted: Off" and "Persistent session: Off" for behaviour that is always on; cut the toggle.
- **#519** — Start-of-run syncs two deploy targets but not the checkout the work executes from, so "verified-current" can be wrong.
- **#496** — Per-task session titles lose the planner task id, so worked tasks look undiscoverable.

## Low (4)

- **#772** — A manual critical-tool check writes a fake run into the run ledger.
- **#743** — The browser shortcuts installer still uses port-based names; name them by account.
- **#646** — Journal UX: a user-triggered compression button that rewrites a long journal into one pinned part and one current response.
- **#645** — Journal UX: a button to insert a todo without typing the checkbox syntax.

## Unprioritised: consent, asks and capacity

These are the gate-and-capacity semantics that [Prioritisation](Prioritisation) specifies; each is a divergence between the intended rule and the code.

- Consent: **#465** (consent is replayable because an affirmative is never spent), **#491** (turns can advertise a reply word the consent reader rejects), **#518** (turns ask for an approval already granted), **#511** (a `merge <n>` approval authorises any PR and silently drops a second number), **#513** (an ask can instruct a gate edit that cannot work), **#442** (design a way to approve in a Google Doc comment with positive attribution).
- Asks and exhaustion: **#516** (one word covers "queue drained" and "clock ran out"), **#515** (resolving an ask strands its Telegram notice), **#520** (a guard that cannot run returns the same value as one with nothing to do), **#545** (`scan` emits the unfiltered unanswered count while every gate uses the closed-filtered one), **#527** and **#526** (a deterministic "blocked on human" flag and last-evaluated timestamp readable by the UI).
- Capacity slots held by tasks that cannot be worked: **#487** (a task awaiting a reply holds a slot forever), **#500** (a doc-bound task waiting on comments), **#541** (a blocked task), **#522** (observing a doc-bound task erases it from the count), **#532** (`last_woken_at` is maintained only by prose).
- Pause, snooze and closure: **#540** (a user pause on a sub-session is invisible to the next run), **#556** (a reused task id makes a live task read user-completed), **#506** (changing a poll cadence resets `next_due` to now), **#543** (`last_turn_at` is stamped by any status-only mark), **#607** (a session that correctly does nothing is recorded as unwakeable), **#569** and **#600** (a user message above the turn sentinel, or a forgotten `mark`, is invisible to `reopened`), **#534** (a board row with no journal is invisible to the whole run).

## Unprioritised: write guards and journal integrity

- Authorship and one-writer rules: **#477** (one turn per wake is enforced but not by which author), **#514** (the guard trusts a field the agent writes), **#473** and **#476** (two writers or zero writers for one journal), **#641** (agent prose written through the UI composer is stamped as the owner's), **#825** and **#816** (refuse an agent turn into a user-closed or snoozed task), **#528** (adding a task can reuse a live task's id and destroy its row).
- Encoding and file mechanics: **#681** (a state-store reader that forgets the BOM reports a confident zero), **#602** (the journal-encoding mutation check fails because it validates call shape, not the encoding argument), **#462** (write-guard caller traps), **#557** (a bare backup filename hides the rollback artifact), **#551** (settings-split backups are never pruned), **#808** (doc-comment times shift by the UTC offset on non-UTC hosts), **#814** (the turn-end backfill cannot run because its cut point no longer exists).
- Truthfulness: **#471**, **#457**, **#626**, **#492** (agent output asserts facts it never checked or that its own table contradicts), **#620** and **#628** (bound Telegram topics settle on two messages and collapse fixes cannot reach most older topics), **#505**, **#453** and **#456** (issue comments and bodies carry no provenance marker, so edits can overwrite human content).

## Unprioritised: catch-up Docs

- Channel and observation: **#598** (binding creates a channel nobody polls), **#593** (`scan` publishes new-comment counts without the read's freshness), **#570** and **#459** (the Google Workspace server is exposed to no agent session and undeclared in capabilities), **#468** (a capability probe cannot see the session's own dead connection), **#502** (comments read as empty for the tool's own output shape), **#612**, **#610** and **#609** (a transient failure and a broken page print the same FAIL), **#594** and **#499** (no sweep reads a Doc body; the claim-consistency sweep pins a permanent finding).
- Creation and delivery: **#763** (creation duplicates documents when binding fails), **#625** (a find-and-replace escapes a real newline), **#588** (a Telegram link is posted when the Doc is bound, not when written), **#483** (link mode never tidies earlier turn messages), **#441** (document creation should be a skill encoding the owner's preferences), **#436** and **#494** (the journal's stamped-doc field cannot distinguish a durable binding from an at-risk one).
- App and publisher: **#868** (remote revisions create sync-conflict copies and the open Doc does not refresh), **#867** (soft-wrapped lines split blocks), **#857** (the sidebar makes reports look like duplicate journals), **#854** and **#852** (the publisher CLI and comment-merge slices), **#845** and **#838** (the app reader slice, and the behaviour spec with JSON schemas).

## Unprioritised: deploy, sweeps and the shipped check

- Deploy propagation ("merged is not running"): **#668**, **#622** (the bridge checkout is on no deploy manifest), **#617** (deploy backups are never pruned), **#575** (the refuse rule is ancestry-blind), **#533** (a budget expiry in the last phase leaves targets on different refs), **#485** (sweeps measure a checkout nothing pulls), **#613** (the final phase dies with an unwrapped error at the commit limit).
- Sweep correctness: **#461** (the encoding sweep resolves the main checkout from a worktree and reports clean), **#684**, **#639**, **#632**, **#630**, **#635**, **#495** (the shipped-versus-open classification: historical mentions read as shipped, the wrapper cannot see a checkout, open conflates shipped-awaiting-review with unworked, and briefs treat "no open PR" as unstarted), **#567** (a relative settings candidate lets the bundled template override the real file), **#558** (retire the board-repair script that reports phantom damage), **#554** (the Google Tasks collector calls a tool that does not exist), **#524** (a truncated page is read as the whole backlog), **#568** and **#786** (the inbox and critical-tool preflights have budgets or load that make them crash or report false negatives), **#850** (preflight records email absent without discovering deferred tools).

## Unprioritised: sessions, browsers and the runtime

- **#847** (absent bound sessions silently starve every eligible task), **#851** (gated dispatch is enforced when asked but not at session creation or send), **#481** (session state is never pruned and stale locks accumulate), **#480** (a wedged host leaks a session lock so an abandoned session reads alive), **#452** (worktree teardown does not release the binding), **#789** (the sync client re-checks about 1,200 automation log files every cycle), **#539** (issue creation ignores the explicit repository for folder-only workspaces), **#538** (side-project files must not be created in the data folder), **#454** (the lore file is write-only), **#804** (the end-to-end sandbox baseline has standing failures).

## Unprioritised: supervision, tray and installer

**#655**, **#689**, **#695**, **#696**, **#697**, **#698**, **#699**, **#701**, **#707**, **#710**, **#690**, **#648** and **#694** make supervision an optional tray application: policy sourced from the settings file, browser-watchdog and plugin-update checks and an LLM watchdog as separate opt-in workloads, a preventive restart window with a quiet-time start and hard deadline, safe uninstall, and a chat-first installer. The tray's update check is currently blind to versions (#710, #719).

## Unprioritised: app, storage and server

- Defects: **#640** (the task actions sheet renders below the fold on a narrow viewport, hiding Create Journal), **#587** (the row menu and its sheet are both named "Task actions" without naming the task), **#577** (evening tasks are stamped with tomorrow's UTC date and show an age of -1d), **#790** (the server's path guard allows a sibling-prefix escape), **#798** (a mirror replay can overwrite newer source content with a stale copy), **#826** (the smoke gate is flaky on `main`).
- Convergence toward one product with two deployments: **#793** (keep exactly one storage source), **#752** (stage the single-source transition without rerouting data), **#800** (deployment profile, host seam and provider registry), **#751** and **#753** (default-preserving profile and unified provider registration), **#754** (an opt-in Node journal-write command with guard parity), **#656** (preserve Markdown journals with a parsed message model and safe merge), **#650**, **#672**, **#673** (shared sorting package pilot, an explicit alias capability, gated flag profiles), and the index **#755**.

## Unprioritised: new capabilities

**#836** (cross-platform planner agent tools; shipped as [Domain-planner-tools](Domain-planner-tools), with the issue still open), **#652** (per-device agent and session linking; specified in [Domain-agent-metadata](Domain-agent-metadata)), **#651** (local-first sync engine with a conflict-resolution UI), **#653** (read-only Azure DevOps saved-query integration), and **#654** (pull-request lifecycle and description automation skills).
