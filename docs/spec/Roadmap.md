# Roadmap

This page records **known gaps and forward direction** from the **200 open issues** captured in `spec-facts.json`. Entries with a `priority:` label are grouped by that label first. Remaining issues are grouped by the exact non-priority labels present, and issues with no labels are grouped by recurring themes from their titles and bodies. Use this alongside [Behaviour](Behaviour), [Reliability](Reliability), [Prioritisation](Prioritisation), and the relevant `Domain-*` page.

## Critical

9 open issues carry `priority: critical`. These are the explicitly triaged gaps in the snapshot.

> [!NOTE]
> **Technical detail: concrete reference.** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

| Issue | Other labels | Title | Gap / direction from issue text |
| --- | --- | --- | --- |
| #758 | bug, overnight-agent | Critical-tool check raised a false Google outage and emailed Shiv: the settings reader takes the whole cell, and the probe treats a text reply as failure | The new critical-tool check reported **`⛔ CRITICAL TOOL DOWN: google-workspace`** while Google Workspace was **working**, marked the run `degraded`, and **emailed Shiv a false outage alert**. Shiv was sent a correction by hand. There were two separate… |
| #747 | bug, overnight-agent | Google Workspace tools fail in every session: the server only speaks MCP 2026-07-28 and the Copilot host requests 2025-11-25 | The **google-workspace MCP server fails to connect in every Copilot session** on shiv-devbox. The last 40 session logs show **19 of 19 sessions that tried it failed**, with the same error each time: |
| #736 | bug, overnight-agent | Task sessions never launch a closed browser slot; every browser task has been blocked since noon | On 2026-09-28, since about 12:12 PT, **all three automation browser slots have been down**: ports 9225, 9228 and 9229 are not listening, and `check-browser-slots.ps1` reports `state: down` for each. Every task that needed a browser stopped without… |
| #734 | bug, overnight-agent | A user-paused task was dispatched, then the coordinator pushed the task session twice to override its refusal | The Overnight Agent run at 14:00 PT on 2026-09-28 dispatched the **"Plan my day"** task (planner task related issue), even though Shiv had paused it. Then it pushed the task session twice to override the pause. |
| #716 | bug, overnight-agent | Make direct dispatch the only path and remove the drain extension that never loads in scheduled runs | Overnight Agent hands approved work to per-task sessions through a helper extension (`extensions/task-dispatch`, which provides the `oa_drain*` tools and a pre-tool guard). **In scheduled runs that extension never loads.** The host gives it 30 s to… |
| #713 | bug, overnight-agent | Dispatch extension misses the host's 30 s ready window in scheduled sessions, so runs plan but never dispatch | In the scheduled coordinator sessions on 2026-09-28, the Overnight Agent's dispatch tools (`oa_drain_status`, `oa_drain`, `oa_drain_wait`) were missing. The run that followed the scan fix, at 05:06 PT, did all of its planning, then reported *"No task… |
| #711 | bug, overnight-agent | scan takes 224 s and emits 507 KB, so the coordinator abandons it and the run does no task work | The first Overnight Agent run after the reinstall, on 2026-09-28 at 02:32 PT (plugin v1.54.1), did **no task work**. It ended after its startup checks, because `oa-state.ps1 scan` never returned inside the run's patience window. The coordinator killed its… |
| #501 | bug, reliability | Agent-declared done confers user-closed semantics: a Today row swallowed 3 user messages and released the Today gate | A task the **agent** marked `done` acquires the semantics of a task the **user** closed. On planner task **related issue** — which is still row 1 of `## Today` in `planner.md` — that caused **three unanswered user messages to become permanently invisible**, and it… |
| #422 | bug, reliability, overnight-agent | Google Doc comments have no author attribution: the agent's own replies come back as Shiv, so comments cannot be an instruction or consent channel | **Prerequisite for related issue.** Priority: critical — this blocks making doc comments the primary channel at all. |

</details>

## High

38 open issues carry `priority: high`. These are the explicitly triaged gaps in the snapshot.

> [!NOTE]
> **Technical detail: concrete reference.** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

| Issue | Other labels | Title | Gap / direction from issue text |
| --- | --- | --- | --- |
| #817 | — | Telegram bridge folds ANY group member's message as `from: me`: anyone added to the group could approve (enforce sender id) | `packages/telegram-bridge/src/bridge.js` `syncDown()` folds every non-bot message in the task group into the task journal as a dated `<!-- from: me -->` entry. Its only sender filter is `if (msg.from && msg.from.is_bot) continue`. |
| #785 | bug, overnight-agent | Remove the coordinator guard extension: it needs an interactive permission prompt, so it never loads in scheduled runs and nags every other session | The coordinator guard extension from PR related issue (issue related issue) **never enforced anything in a scheduled run**, and it adds friction everywhere else: |
| #784 | bug, overnight-agent | Inbox check still cold-starts MCP servers: email, Telegram and Google 'timed out' and the run reported the inbox NOT CHECKED (the related issue defect in a second script) | `check-agent-inbox.ps1`, the PHASE 0 inbox gate, reported: |
| #783 | bug, overnight-agent | An explicit instruction is turned into a proposal: 'use X to generate a report' came back as a gated plan with an added email step, waiting on approve | > - TODO: Use the martin-kids-powerschool to generate a report |
| #781 | bug, overnight-agent | Runs quit early instead of refilling: 13 eligible tasks wait while the coordinator ends 17-19 minutes before its cutoff | The refill-until-cutoff loop (issue related issue, PR related issue) says: after dispatching up to the concurrency limit, poll the sent sessions about every 60 s with `get_sessions_status`, and when one goes idle, dispatch the next eligible task, **until the start cutoff**… |
| #780 | bug, overnight-agent | One task per run: a long-running task still busy from the previous run is re-sent every run and takes the only slot, starving 13 eligible tasks | *"Only one task? Why?"* Each run on 2026-09-29 afternoon dispatched exactly one task, even though 14 were eligible. |
| #771 | bug, overnight-agent | Coordinator ignores its cutoff and one-send rule (prose drift): waited on a task and nudged it until 07:12; enforce with a guard hook | The **06:30** coordinator run was supposed to stop starting work at 06:55 and **end** by 06:59. Instead it ran until **07:12**, so the 07:00 run started at 07:13. Its own events show what it was doing: |
| #768 | bug, overnight-agent | Critical-tool check measures machine load, not tool health: probe through the coordinator's connected tools instead of cold-starting servers | - 05:58: google-workspace probe → `slow` (timed out at 90 s). - 06:03: google-workspace probe → `slow` again → escalated to **`down`: "timed out on two consecutive runs"**. The run was marked `degraded`, and email was also `slow`. - 06:25, by hand: the… |
| #764 | bug, overnight-agent | Critical-tool probe marks healthy tools down under load: a cold-start MCP probe times out at 45 s, and a timeout is treated as an outage | The 04:00 run's critical-tool preflight marked **both** `email` and `google-workspace` **down**, with the same error for each: |
| #750 | bug, overnight-agent | Coordinator runs past the next slot: it dispatched until its cutoff, then kept working 17 more minutes and delayed the next run | The **22:30** coordinator run dispatched one task (task 484, concurrency 1) and polled `get_sessions_status` until its start cutoff (22:55). That part worked as designed. But the coordinator itself **kept working until 23:12**: inbox follow-ups, a… |
| #748 | enhancement, overnight-agent | Fail loudly when a critical tool is down: a user-defined list (default email and google-workspace), a probe at run start, one push alert, and a red tray | *"I want to fail loudly if the list of key extensions fail. You decide what failing loudly means, and the user can define the list of critical extensions, with smart defaults."* |
| #744 | bug, overnight-agent | The agent starts one task per run and stops: removing the drain extension also removed 'keep going until 5 minutes before the next run' | *"I thought the agent would keep picking tasks and executing until 5 minutes before the next run."* |
| #739 | bug, overnight-agent | New tasks ask for approval of reversible, already-allowed work: PHASE 2 always proposes and waits | New tasks come back asking him to "approve this plan", even when every step is reversible or already allowed by his standing rules. He asked (2026-09-28): *"task 500 why was I asked to approve, all the things asking for approval are within guardrails, it… |
| #738 | bug, overnight-agent | Browsers: let each Playwright MCP launch its own profile (tested), give each task its own window, and replace the slot lifecycle | Switch the three browser MCP servers from **attach-only** (`--cdp-endpoint http://localhost:922x`) to **launch-own-profile** (`--browser msedge --user-data-dir <profile dir>`). Each browser opens on first use and closes with the session that opened it.… |
| #732 | bug, overnight-agent | An automation browser slot can spin at about 2 cores with a dead CDP port after its task ends, and nothing notices | At 11:37 PT on 2026-09-28, the **Bijlanis** automation browser (`playwright-mcp\edge-bijlanis`, `--remote-debugging-port=9228`) was launched, most likely by the Emirates-trip task session, to check Hilton as Shiv's doc comment asked. By 12:10: |
| #728 | bug, overnight-agent | A dead task session still reads reuse, and its failed send uses up the run's only dispatch slot | The 10:00 PT scheduled run on 2026-09-28 picked "Emirates Nov trip" (a daily poll) as its one dispatch. It sent to the task's bound session, and the send failed: |
| #727 | bug, overnight-agent | A task session loaded the coordinator skill from its brief, which risks recursive dispatch |  |
| #720 | bug, overnight-agent | Tray quiet-window evidence is always incomplete on a box with 500+ sessions, so only the hard-deadline restart can fire | This was also observed in detect-only mode on 2026-09-28. The snapshot (`reliability-supervisor-snapshot.json`) reports: |
| #718 | bug, overnight-agent | Non-code tasks have no creatable home: the app cannot make a projectless chat, so a run put a travel task in a code worktree | This follows the change that makes non-code tasks run as chat sessions (PR related issue). SKILL.md now says a non-code task gets **"a global chat with no project and no folder workspace"**. The app's `create_session` tool can't do that. The 08:33 PT scheduled run… |
| #717 | bug, overnight-agent | A code task whose worktree was deleted still reads reuse, so the run wakes a session that has no checkout | `oa-state.ps1 session -Id N` returns **`reuse` / `live`** for a code task whose worktree **no longer exists on disk**. The coordinator then sends its work to a session whose checkout is gone. That wake fails, and the run spends its dispatch on it. |
| #643 | bug, reliability | Supervisor restarts all GHCP sessions to clean up one finished run, interrupting unrelated active work | <!-- from: overnight-agent --> |
| #638 | bug, reliability | A 5h49m host-sleep outage silenced every scheduled unit and left zero record: the supervisor heartbeat stores only lastCheckUtc, so a blind window reads as healthy 20s later | <!-- from: overnight-agent --> ## Summary |
| #627 | bug, reliability | `eligible` binds selection but not work: admits stayed 0 for a 6h window while 3 journals gained turns, 2 on rows scan marks ineligible | <!-- from: overnight-agent --> ## Measurement |
| #618 | bug, reliability | A declared ask is never validated against its own turn: related issue asks two questions it cannot guess, declares them an 'offer', and no reader waits (25 of 254 rows have an open ask nobody awaits) | <!-- from: overnight-agent --> |
| #605 | bug, reliability | A due poll never fires on a Deferred row: Test-Workable grants the timer override, then the Today gate discards it (measured: related issue due_poll=true, eligible=false) | Measured live on the board at 2026-09-07 18:15 PT by the spec-conformance forensics pass (related issue). |
| #589 | bug, reliability | in_flight reports 3 against a concurrency ceiling of 1, and scan emits no per-row capacity field so the membership of that 3 is unobservable | <!-- from: overnight-agent --> ## Measurement |
| #583 | bug, reliability | 6 of 12 scheduled overnight-agent run slots recorded zero turns in a 6h window (3 most recent consecutive), so 'fired and did nothing' is indistinguishable from 'never fired' | <!-- from: overnight-agent --> |
| #579 | bug, reliability | Prioritisation.md 6 claims a missing concurrency row reports settings-malformed; the code reports 'default', and the documented '## Overnight Agent behaviour' table does not exist in user-settings.md | <!-- from: overnight-agent --> ## Summary |
| #565 | enhancement, reliability | No spec-conformance forensics: 50+ sweeps detect known defect shapes, nothing checks whether the system matches the spec | There are **50+ sweeps** in ``, and every one of them detects a *previously diagnosed defect shape*. Each was written after a specific bug was found. There is nothing that asks the opposite question: |
| #564 | bug, reliability | A satisfied timer does not park its task: make 'parked until T' the single primitive for clock, third-party and human waits | A completed timer does **not** park its task until the next due date. `poll` and `recheck` can only *release* a park; neither can *create* one. So between polls, a recurring task falls through to the plain status gate and is workable again immediately. |
| #562 | bug, reliability | Session replacement can go backwards: task related issue rebound to a session its own successor had already replaced (3 sessions in 13h) | Per-task session replacement can go **backwards**, rebinding a task to a session that a *newer* session had already replaced. The result is a cycle: two sessions can each be recorded as the other's replacement, and each wake can flip the binding instead of… |
| #561 | enhancement, reliability | Scheduling decisions are unauditable: scan is not replayable and no run records why a row was picked or skipped | When a run picks a task, **nothing durable records why**. The ordered worklist, each row's eligibility, and the reason a higher-ranked row was skipped all exist only in memory during the run and are gone when it ends. `SKILL.md` asks the run to *"report… |
| #560 | bug, reliability | awaiting_reply is recovered by regex from the agent's own prose: declare the ask instead of inferring it | The Today→Deferred gate is driven by a fact that is **recovered by regex from the agent's own narrative closing line**, rather than declared. `oa-state.ps1` (lines 1364–1365): |
| #549 | bug, reliability, overnight-agent | Get-Content -Raw silently double-encodes UTF-8, corrupting catch-up docs - a third corruption class, currently unguarded | Found live **2026-09-05 23:20 PT** while task **related issue** created its first catch-up doc. Caught on readback and repaired before it reached Shiv, so this is a near-miss report, not an outage. |
| #547 | bug, overnight-agent | A `folder` session's workspace IS the planner data folder, so Playwright MCP wrote 760 KB of debris into OneDrive beside planner.md (4 of 4 folder sessions affected; happened 4.2h after related issue filed the prose rule) | `C:\Users\shiv\OneDrive\Apps\Focus Planner\` is the planner's own data store. On 2026-09-05 an agent session wrote **760 KB of Playwright MCP debris** into it as `.playwright-mcp\`, where it is now syncing to OneDrive and to every device, sitting beside… |
| #424 | enhancement, overnight-agent | Telegram: post the catch-up doc link once, then stay quiet - 21 of 28 turns on task 468 exceed the 4096-char message limit | **Child of related issue.** Priority: high. Depends on related issue (durable task→doc binding). |
| #423 | enhancement, reliability, overnight-agent | No durable task-to-doc binding: the catch-up doc is found by title search, so a rename silently creates a duplicate and new comments cannot be detected | **Prerequisite for related issue.** Priority: high. |
| #421 | enhancement, overnight-agent | One catch-up Google Doc per task: make the doc the agent's output surface and its comments the reply channel | **Priority: high.** Requested by Shiv on task related issue (2026-09-03, via the task journal). |

</details>

## Medium

12 open issues carry `priority: medium`. These are the explicitly triaged gaps in the snapshot.

> [!NOTE]
> **Technical detail: concrete reference.** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

| Issue | Other labels | Title | Gap / direction from issue text |
| --- | --- | --- | --- |
| #778 | bug, overnight-agent | Parallel PHASE 0 steps collide on the state lock: capability and decision records fail with state_lock_timeout and need model retries | The coordinator runs several PHASE 0 steps in parallel, and they compete for the single state lock in `oa-state.ps1`. At the same second (13:02:06) the 13:00 run started: |
| #761 | bug, overnight-agent | Session replacement churn: a healthy task was replaced twice in 84 minutes (frequency, not direction) | In a forensics comment on issue related issue, planner task **related issue** went through **two session replacements in 84 minutes**, both in the correct order. That is replacement *frequency*, a different defect from the *direction* bug fixed in PR related issue… |
| #745 | enhancement, overnight-agent | Scope tool servers per session: a lean coordinator, with browsers and other tools only in task sessions that need them | The coordinator (the scheduled Overnight Agent run) should start **lean**, with only the tool servers it uses. Each **task session** should get the tools its task needs, such as the browser profiles. Today every session starts all ~8 servers in… |
| #733 | enhancement, overnight-agent | First-run setup: offer to remove Widgets and tune Defender for the dev drive, so new users don't get a sluggish PC | On shiv-devbox (2026-09-28), two things ate CPU that a first-time user would hit the same way. Both were fixed by hand, and neither is part of setup today: |
| #729 | bug, overnight-agent | Non-code task project setting fails every bind when the cell carries the template's note, and the error blames the arguments | PR related issue (issue related issue) ships this template row in `user-settings.md`: |
| #724 | bug, overnight-agent | sync-oa-home reports verified-current while the tray keeps running stale deployed files | On 2026-09-28 I reinstalled the plugin after PR related issue merged (a fix to `windows-app-actuator.mjs`) and ran `checks\auto-deploy-plugin.ps1`, which includes `sync-oa-home.ps1`. Both reported clean: |
| #719 | bug, overnight-agent | Tray update check can never find an update: marketplace browse --json has no version field | I started the reliability tray on shiv-devbox at 08:45 PT on 2026-09-28, in detect-only mode. Its update-check workload immediately reported: |
| #702 | overnight-agent | Default the Overnight Agent and every task session it starts to the Auto model | Shiv wants **Auto** as the default model everywhere the Overnight Agent runs. That covers two things: |
| #571 | bug, reliability | status_by carries no close-provenance: it is 'agent' on 249 of 250 rows while user_completed is true on 54, so related issue's stated conformance check is unevaluatable | <!-- from: overnight-agent --> |
| #563 | bug | Task menu reports 'AI-assisted: Off' and 'Persistent session: Off' for behaviour that is always on; cut the persistent-session toggle | The task kebab menu shows two per-task toggles that both read **Off**: |
| #519 | bug, reliability | PHASE 0 syncs two deploy targets but not the checkout PHASE 3 executes from: verified-current True while the live bridge was 5 commits behind and missing the fix that merged that night | PHASE 0's `auto-deploy-plugin.ps1` closes "merged != running" for **two** targets — `installed-plugins` and the OA home — and reports `verified-current True`. It closes it for neither of them by updating a working tree: it fetches `origin/main` and reads… |
| #496 | bug | Per-task session titles lose the planner task id, so worked tasks look undiscoverable | Per-task session binding works, but the visible session title does not preserve the planner task id. A session is renamed to the latest GitHub issue or PR it handles, so searching sessions for the planner task number returns nothing and makes worked tasks… |

</details>

## Low

4 open issues carry `priority: low`. These are the explicitly triaged gaps in the snapshot.

| Issue | Other labels | Title | Gap / direction from issue text |
| --- | --- | --- | --- |
| #772 | bug, overnight-agent | A manual critical-tool check writes a fake run into the run ledger | A manual run of `check-critical-tools.mjs` from a non-coordinator session (the Task 480 forensics chat, 2026-09-29 05:58) appended a line to `run-ledger.jsonl` with that chat's session id as `runId`. That makes the ledger count a run that never happened,… |
| #743 | bug, overnight-agent | Browser shortcuts installer still uses 'MCP Edge … (CDP 922x)' names; name them by account | `install-browser-profile-shortcuts.ps1` (shipped in PR related issue) still creates the shortcuts with their old names: `MCP Edge 1 (CDP 9225)`, `MCP Edge bijlanis (CDP 9228)` and `MCP Edge kiley (CDP 9229)`. Those names mention a debug port that no longer exists,… |
| #646 | enhancement | Journal UX: a user-triggered compression button that rewrites a long journal into one pinned part and one current response | > *"New low pri : journal UX should have a button to allow compression. That means agent can rewrite it and overwrite a long journal dropping stuff to make it current and make it read like one pinned part and one response"* |
| #645 | enhancement | Journal UX: a button to insert a todo, so adding one does not require typing `- [ ]` by hand | > *"File a new low pri issue... Journal UX should have a button to insert todo."* |

## Labelled but unprioritised

31 open issues have labels, but none of those labels is a `priority:` band. The tables below keep the grouping faithful to the data instead of inventing a priority order.

### `bug`

> [!NOTE]
> **Technical detail: concrete reference.** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

| Issue | Title | Gap / direction from issue text |
| --- | --- | --- |
| #790 | server.js path guard allows sibling-prefix escape (e.g. ../planner-config.json) | The local API server (`server.js`) guards `/api/file`, `/api/todos` with: |
| #684 | issue-shipped.mjs reported five shipped issues as unworked in one session, and G15 is silent on exactly that error | <!-- from: overnight-agent --> ## Summary |
| #681 | A Node reader of the state store that forgets the UTF-8 BOM reports a confident zero over an empty set | <!-- from: overnight-agent --> ## Summary |
| #628 | The collapse fixes cannot reach 208 of 229 bound topics: a message whose id was never recorded is unreachable forever, and no sweep measures the outcome Shiv actually looks at | On 2026-09-08 Shiv wrote: |
| #626 | A stated finding and its own contradiction have equal standing in prose: the correct answer was transmitted and lost twice in one wake (6 instances, 2 shapes) | This is related issue in a different organ. There, a **declared ask** that nothing validates. Here, a **stated finding** that nothing validates. Both are declarations without a checker, and related issue already generalises the family: the failing case and the succeeding… |
| #625 | find_and_replace_doc escapes a real newline into a literal `\n` in doc prose, reports `Replaced 1`, and the damage only matches back out with a real newline (fourth corruption class, unguarded) | **(a) Write direction.** A real newline in the replacement text arrives in the document as the two literal characters `\` and `n`. A paragraph break cannot be inserted through this tool at all. |
| #602 | mutcheck-journal-encoding fails 2/3 on main: the journal encoding guard validates the call shape, not the encoding argument, so an ANSI decode inside Read-JournalText survives | `checks/mutcheck-journal-encoding.mjs` fails on `origin/main` at 2/3 mutants killed, exit 1, with arm M2 SURVIVED: |
| #557 | write-turn.ps1 prints a bare backup filename, so the rollback artifact looks missing when you need it | `write-turn.ps1` announces its backup as a bare filename with no directory: |
| #528 | Adding a task can reuse a live task's ID and silently destroy that task's row | Adding a task through the UI can be assigned an **ID that is already in use by a live task**, and the existing task's row is then **destroyed** — silently, with no warning, no dialog, and no error in the console. The row simply stops existing on the board. |
| #502 | Doc comments read as empty: -Observe returns 0 for the MCP's own output shape | `oa-state.ps1 doc -Id <ID> -Observe <file>` returns **zero comments** when handed the exact output the Google Workspace MCP produces. `-Observe` then reports `new_comments: 0` -- which is byte-identical to *"the user said nothing."* |

</details>

### `enhancement`

> [!NOTE]
> **Technical detail: concrete reference.** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

| Issue | Title | Gap / direction from issue text |
| --- | --- | --- |
| #656 | Convergence: preserve markdown journals with a parsed message model and safe merge | `focus-planner-ado-codeapp`, `journalDoc.js`. |
| #655 | Feature concept: overnight-agent watchdog / reliability supervisor for unattended automation | `focus-planner-ado-codeapp`, `plugin/overnight-agent/README.md` (the `overnight-agent-watchdog` skill + `watchdog.ps1`). |
| #654 | Feature concept: PR lifecycle + PR description automation skills (video poster + mermaid diagrams) | `focus-planner-ado-codeapp`, `plugin/pr-lifecycle/README.md`, `plugin/pr-desc-video/README.md`. |
| #653 | Feature concept: optional Azure DevOps saved-query integration (read-only) | `focus-planner-ado-codeapp`, `ado-config.js`, `ado-link-service.js`, `QuerySettings.jsx`, `useAdoEnabled.js`. |
| #652 | Feature concept: robust per-device agent/session linking with binding-time fingerprints | `focus-planner-ado-codeapp`, `docs/agent-task-metadata.md` (implementation contract for their issue related issue), `src/AgentSessionLinks.jsx`, `src/useAgentMetadata.js`, `src/storage/agent-metadata-reader.js`. |
| #651 | Feature concept: local-first sync engine with conflict resolution UI | `focus-planner-ado-codeapp` (enterprise), `engine.js`, `merge-text.js`, `SyncBanner.jsx`, `idb-store.js`. |
| #650 | Pilot: prove shared package consumption (A → B) via taskSort.js | We maintain two sibling implementations of the markdown-backed planner: - **Repo A** (this repo, `shivbijlani/focus-planner`) — consumer version, public, multi-backend storage (OneDrive/Google Drive/local folder), combined multi-source board, Telegram… |

</details>

### `bug + overnight-agent + reliability`

> [!NOTE]
> **Technical detail: concrete reference.** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

| Issue | Title | Gap / direction from issue text |
| --- | --- | --- |
| #610 | observe-bound-docs: a transient failure and a broken page print the identical FAIL line | `observe-bound-docs.mjs` polls each bound catch-up doc **once**. All three failure paths — fetch exit, observe exit, `observation !== 'read'` — increment `failed` and move on with no retry. |
| #461 | ps1-encoding-sweep resolves its root to the main checkout, so running it from a worktree scans a different tree and reports clean | `plugins/overnight-agent/checks/ps1-encoding-sweep.mjs` resolves the tree it scans from a **hardcoded path to the main checkout**, not from the tree it was invoked in: |
| #454 | agent-lore.md is write-only: 903 KB, 160 headings, zero readers - and 'grep for the heading you need' can only retrieve what a run already knows | `agent-lore.md` is where the Overnight Agent is instructed to record every hazard, postmortem and run learning. `SKILL.md` says so explicitly: |
| #453 | Agentic issue comments carry no provenance marker, so "edit the one agentic comment in place" can overwrite a human comment | The operating contract for GitHub issue work has two rules that both depend on telling an agent comment from a human one: |
| #428 | A merged PR auto-closes its issue via `Closes #N`, skipping the review step the operating contract requires | Found live tonight while shipping related issue. |

</details>

### `bug + reliability`

| Issue | Title | Gap / direction from issue text |
| --- | --- | --- |
| #789 | OneDrive sync re-checks ~1,200 files every cycle, mostly agent .playwright-mcp logs in the planner folder | In the live test on plannermd.com for related issue (2026-09-30), Shiv's browser tracked **1,212 files** for OneDrive (`mtime:onedrive:*` keys in the `folder-sync` IndexedDB meta store). Many aren't planner data. They include: |
| #457 | A session asserted a false negative about its own past actions after an ID rollover, and nothing could contradict it | A session asserted a confident, checkable **false negative about its own past actions** — *"I never edited related issue"* — after its surfaced session ID changed. Nothing in the system could have contradicted it. The correct attribution survived only because the… |
| #452 | Worktree teardown doesn't release the session binding — task stays `bound: reuse, live` pointing at a deleted workspace | Tearing down a per-task worktree with `remove-worktree.ps1` **does not release the task's session binding** (related issue). The result is a binding that reports `bound: true, verdict: reuse, state: live` while the workspace it names no longer contains a… |

### `reliability`

| Issue | Title | Gap / direction from issue text |
| --- | --- | --- |
| #533 | auto-deploy: a budget expiry in the LAST phase leaves the two deploy targets on different refs, and the exit-before-report path never says so | `auto-deploy-plugin.ps1` deploys **two** targets in sequence — the installed plugin tree, then the OA home under `%LOCALAPPDATA%\overnight-agent`. Both draw from **one cumulative wall-clock budget**. When that budget expires during the *second* target's… |
| #532 | last_woken_at is maintained only by prose, so any wake reusing a live binding leaves it stale: G12 refuses EVERY author, and session -InFlight frees an occupied slot | A **poll-driven wake never advances `session.last_woken_at`**, and `write-turn.ps1` **G12** keys "is there already a turn for THIS wake?" off that stamp. So on any task with a bound session and an armed poll, the stale stamp makes the *previous* wake's… |
| #436 | oa-state doc: journal_stamped is always false on a resolve, so a durable binding and an at-risk one look identical | `oa-state.ps1 doc -Id <ID>` reports **`journal_stamped: false` for every resolve-only call**, whether or not the journal actually carries its `<!-- doc-meta … -->` stamp. |

### `bug + overnight-agent`

| Issue | Title | Gap / direction from issue text |
| --- | --- | --- |
| #612 | A cold google-workspace MCP server reports a healthy doc as unreadable (and related issue's 1500ms retry cannot cross it) | A cold `google-workspace` MCP server exceeds the probe timeout, so a healthy document reports as unreadable — and the related issue retry is too short to cross it. |

### `enhancement + reliability`

| Issue | Title | Gap / direction from issue text |
| --- | --- | --- |
| #648 | Supervisor: preventive GHCP restart window with configurable quiet-time start A and hard deadline B | <!-- from: overnight-agent --> |

### `overnight-agent`

| Issue | Title | Gap / direction from issue text |
| --- | --- | --- |
| #433 | G9's 800-char nudge fires on every real doc-bound turn so far (901, 1082): measure the distribution before re-tuning | **Follow-up to related issue** (shipped `143af3f`). Not urgent — this is a "measure first, then tune" item, and it should **not** be acted on from the three data points that exist today. |

## Unlabelled issues, grouped by theme

106 open issues have no labels at all in `spec-facts.json`. Because the data offers no explicit priority for them, the groups below follow the recurring topics visible in their titles and first body paragraphs.

### Docs, comments, and Google Workspace channels

These issues describe the catch-up-doc path, doc comment observability, provenance, and the handoff between Telegram turns and Google Workspace.

> [!NOTE]
> **Technical detail: concrete reference.** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

| Issue | Title | Gap / direction from issue text |
| --- | --- |---|
| #763 | Catch-up doc creation duplicates documents when creation succeeds but binding fails | **Reproduced with isolated mocks on 2026-09-29; no production documents created. Automatic document creation exists, but retrying after a binding failure can create duplicates.** |
| #641 | Journal entries written by an agent through the UI composer are stamped '<!-- from: me -->', so agent prose is indistinguishable from Shiv's own words in the consent channel | Found by dogfooding through the Planner UI on task related issue (2026-09-09), while adding notes to newly created task 483. |
| #639 | issue-shipped.mjs reports historical mentions as shipped work, failing in the dangerous direction | `issue-shipped.mjs` (related issue) classifies an open issue as **already shipped** when its number appears in implementation source on `origin/main`. It cannot tell *"this code fixes #N"* from *"this code mentions #N as a historical note"*, and both are common… |
| #630 | `OPEN` spans shipped-awaiting-review and filed-and-unworked, and the tracker renders them identically: 96 of 168 open issues are already shipped, and three run sessions recommended shipped work twelve times | In this repo a shipped PR does not close its issue — Shiv closes it after reading the catch-up doc. That is a deliberate and good rule. Its consequence is that `OPEN` legitimately spans two states: |
| #620 | A doc-bound topic settles on TWO messages, not one: the related issue notice exception now fires in 59 of 76 bound topics | Shiv, on task related issue, describing what he actually sees: |
| #598 | Binding a task creates a doc channel nobody polls: PHASE 0.7 reads per-selection, so a parked task's comments reach nothing (UNREAD 0 -> 5 in 90 min, measured) | `doc -Observe` is called from **PHASE 0.7**, which is a per-task step that runs for the task a run is *working*. A run works one task. So a task's doc channel is read only when that task is selected for dispatch. |
| #594 | No sweep reads a catch-up doc's body, so a figure in the primary surface can go stale unflagged (measured: 5 stale coverage figures in the related issue doc, understating the rollout by 13 and overstating the remainder 2x) | `doc-claim-consistency-sweep.mjs` is the only thing that reads prose looking for claims that do not hold. Its corpus is local disk: |
| #593 | scan publishes doc_new_comments without the freshness of the read behind it, so a channel never observed and a channel observed-and-empty are the same `0` on the worklist | `scan` carries `doc_new_comments` but not the freshness of the read that produced it. On the one worklist a run actually reads, these three states are byte-identical: |
| #588 | Telegram posts the catch-up doc link when the doc is bound, not when it is written, so 4 of 5 links in one run pointed at unwritten placeholders | `ensure-catchup-doc` creates a doc with placeholder text and binds it; the doc's real content is written by the task's **first wake after binding**. But the Telegram bridge posts the doc link based on the *binding*, not on whether the doc has been… |
| #575 | deploy-installed-plugin REFUSE is ancestry-blind: a just-merged file reads as a "live fix" that deploying "would REVERT", and the message asserts the opposite of the truth | `deploy-installed-plugin.ps1` refuses to deploy a file when the installed bytes match *some git ref other than* `origin/main`, and prints: |
| #570 | google-workspace probes AVAILABLE but is exposed to no agent session: the doc-comment channel is unreadable from where PHASE 0.7 runs (3 of Shiv's comments sat unread) | `check-agent-inbox.ps1` reports `google-workspace` as **AVAILABLE** by spawning the server as a child process. But the run — and, since related issue, *every task sub-session* — calls that MCP through its **session toolset**, which is a different surface. Right now… |
| #526 | Deterministic "blocked on human" flag + last-evaluated timestamp, readable by the planner UI | > **Let's design this out together before implementing, unless it turns out to be straightforward.** > That is the explicit instruction on this one — the shape of the flag and its transport are the > decisions, and they are more consequential than the… |
| #505 | Run-session issue comments are unmarked, so every later pass duplicates instead of editing (and stamping the stranded one makes it worse) | <!-- from: overnight-agent --> |
| #500 | A doc-bound task waiting on doc comments holds the only capacity slot: related issue makes its ask dismissive by design, so it reads as workable | The 2026-09-04 14:31 PT run could dispatch **nothing**. Not because the board was empty — 12 rows were eligible — but because the single capacity slot was held by a task that cannot progress without a human. |
| #499 | doc-claim-consistency-sweep flags append-only journal history it can never fix - first run pins a permanent finding | `doc-claim-consistency-sweep` shipped and deployed tonight (2026-09-04). On its **first live run** it returned exactly one finding, and that finding is **unfixable by construction** — it sits in immutable, superseded journal history. Left as-is, this sweep… |
| #495 | Brief assembly reads 'no open PR' as 'unstarted', but the operating contract makes 'shipped, awaiting review' look identical: 5 of 6 issues briefed wrong in one wake | The run session assembles a sub-session brief by asking which issues are unstarted, and answers it with `gh pr list --state open`. Absence of an *open* PR is read as "nobody has started this." Under the operating contract on task related issue that inference is not… |
| #494 | oa-state doc: journal_stamp_id is always null, so a journal stamped with a DIFFERENT doc than state is indistinguishable from one that agrees | `oa-state doc` reports `journal_stamp_id: null` on every task, including ones whose journal carries a real `docId` — so a journal stamped with a **different** doc than state holds is indistinguishable from one that agrees. |
| #492 | An agent-authored doc asserted a number its own table contradicted, and every guard passed: shape is checked, internal consistency is not | During tonight's run, a task sub-session appended an appendix to the task 228 catch-up doc. The appendix recommended a routing and described its cost as: |
| #483 | Link mode never tidies the turn messages posted before binding: the collapse only runs on the turn path it replaced | Found while answering a doc comment on task 468. Shiv, on the catch-up doc: |
| #477 | G12 enforces one turn per wake but not WHICH author: the run session wrote first and the guard then locked out the owner | G12 (shipped tonight in [PR related issue](https://github.com/shivbijlani/focus-planner/pull/474) / [PR related issue](https://github.com/shivbijlani/focus-planner/pull/475)) enforces **at most one turn per wake**. It does not enforce **which author** writes it — and on the… |
| #476 | Zero writers, one journal: the related issue fix assigns sole authorship to the sub-session but nothing detects when it writes nothing - two PRs merged, no turn, no doc | > [!IMPORTANT] > **Correction — 2026-09-04 04:40 PT, run session.** Two evidence claims below were *asserted rather than queried* — which is [related issue](https://github.com/shivbijlani/focus-planner/issues/471)'s exact failure mode, occurring inside the issue… |
| #473 | Two writers, one journal: the run session and the task sub-session each append a turn for the same wake, and their doc edits race | On tonight's run, **task related issue received two agent turns for a single wake**, four minutes apart, both describing the same merged PR — and they disagreed with each other. |
| #468 | A capability probe spawns a fresh server, so it cannot see the session's own dead connection - green probe, dead doc channel (measured) | Every capability probe in `check-agent-inbox.ps1` that uses `mcp-probe.mjs` answers **"can a server be started?"**, never **"is the connection my session is actually using still alive?"** For the `email` row that distinction does not matter. For the… |
| #459 | run-capabilities.json does not declare the Google Workspace server, so the catch-up doc channel - the primary one - has no health probe | `run-capabilities.json` declares the MCP capabilities a run depends on so they can be probed in PHASE 0 ([related issue](https://github.com/shivbijlani/focus-planner/issues/346)). It currently declares three: `email`, `telegram`, `browser-slot`. |
| #442 | Design a way to approve in a Google Doc comment: attribution must be positive, not inferred from the absence of an agent marker | Filed from a comment by Shiv on the task-468 catch-up doc (2026-09-03), anchored on the phrase "can prove which are mine": |
| #441 | Catch-up doc creation should be a plugin skill encoding Shiv's doc preferences (no-context reader, no correction narration, collapsible sections, every ID a titled link) | Filed from a comment by Shiv on the task-468 catch-up doc (2026-09-03), anchored on "prerequisites". |

</details>

### Dispatch, consent, and prioritisation semantics

These issues describe how the Today gate, exhaustion declarations, asks, and run concurrency actually behave versus what the spec states.

> [!NOTE]
> **Technical detail: concrete reference.** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

| Issue | Title | Gap / direction from issue text |
| --- | --- |---|
| #826 | App smoke (Playwright) gate is flaky on main (journal reload persistence, settings timing) | Three intermittent failures so far. Each passed on a plain rerun, and none of the commits touched app code: - **df14d4d:** the whole job hit its 15-minute timeout and was cancelled. - **Item 5 local runs:** two `e2e/settings.spec.js` tests took 31–38 s… |
| #825 | write-turn: refuse an agent turn into a user-closed task (e1 is prose-only) | On related issue's e2e gate (`%TEMP%\oa-e2e\20261003-023719-candidate-823`, attempt 1), **e1 failed**: the coordinator wrote an agent turn into task 9405, which the user had closed (`closed-task-reply` scenario). The retry passed. |
| #816 | Coordinator can write a turn on a snoozed task (rule is prose-only); enforce in write-turn | Found in the coordinator's post-cut-over sandbox run on main @ ca2ae12 (`%TEMP%\oa-e2e\20261002-100912-coord-verify-ca2ae12`, attempt 1, CPU at 94%). |
| #814 | backfill-turn-end.ps1 cannot run: its dot-source cut point (^switch ($Command)) no longer exists in oa-state.ps1 | `backfill-turn-end.ps1` reuses oa-state.ps1's boundary logic. It dot-sources the script up to the first line matching `^switch \(\$Command\)`. oa-state.ps1 no longer has that line at column 0: the command dispatch moved… |
| #804 | e2e sandbox baseline on main: i3 always fails (PHASE 0 hygiene denied) and coordinator sometimes works an approved task itself (b5) | Found in the coordinator's baseline run for related issue on main @ 2b83c2f. Run: `%TEMP%\oa-e2e\20261001-054232-baseline-item3b` on Shiv's PC. Neither problem comes from related issue. |
| #798 | Folder-sync mirror replay can overwrite newer source content with a stale mirror copy (pre-existing) | Found while reviewing related issue. This happens on `main` today; it is not new. |
| #793 | Keep exactly one storage source (remove multi-source combined board) | Owner decision (2026-09-28): "Multiple storage sources: Removed. Both products use exactly one storage source; the provider registry picks which one. No user migration is needed (the product owner is the only multi-source user)." |
| #786 | Critical-tool preflight crashes under load and blocks every dispatch: it spawns a 6,500-line PowerShell script with a 60 s timeout just to read one settings row | The 18:00 run on 2026-09-29 dispatched nothing and ended "degraded, fail-closed". Its wrap-up said: "Critical preflight also failed (spawnSync powershell.exe ETIMEDOUT) ... no task sessions were dispatched because preflight failed." |
| #755 | Convergence roadmap: map remaining shared-product work to incremental, non-duplicative slices | **Status: assessment/backlog mapping is ready; implementation is intentionally not started. Start with the default-preserving host/profile seam.** |
| #754 | Convergence: add an opt-in Node journal-write CLI with existing guard parity | The shared-product direction calls for a one-shot Node CLI as the sanctioned agent write path. The existing… |
| #752 | Convergence: stage the single-source transition without deleting or rerouting planner data | The product direction is one selected planner source, but [App.jsx](https://github.com/shivbijlani/focus-planner/blob/8b0d15e09ed9120689edb3835f55b322a7cc204e/src/App.jsx) still implements Combined and cross-source actions, and… |
| #699 | Add GHCP LLM watchdog integration through the tray supervisor | Add an LLM-assisted GHCP watchdog capability that diagnoses and explains reliability problems while delegating deterministic enforcement to the local tray supervisor. |
| #698 | Move browser-watchdog resident checks into the optional tray app | Atomic rollout step C: make the optional tray app the sole resident dispatcher for browser-watchdog checks. |
| #697 | Remove obsolete supervisor dispatch paths and finalize tray documentation | Atomic rollout step D: cleanup and documentation after the tray reliability and browser-supervision PRs land. |
| #694 | Add chat-first Focus Planner onboarding installer | Installing Focus Planner and the Overnight Agent currently requires too much prior knowledge and encourages folder-backed automations. When an automation is attached to a OneDrive folder, temporary console and browser files can sync into OneDrive. |
| #690 | Default watchdog background components off and add safe uninstall | The Overnight Agent reliability installers currently treat Windows-level supervision as the default. They can register a Windows Scheduled Task or silently fall back to a Startup-folder program. Browser health reporting also treats a missing resident… |
| #689 | Make overnight reliability supervisor an optional tray app | Provide one optional Windows tray app for the project's local reliability checks. It runs only while the signed-in user is logged in and stays off until the user explicitly enables it. |
| #673 | Shared sorting: gate flag profiles with packed-package compatibility and rollback checks | [Issue related issue: Pilot: prove shared package consumption via taskSort.js](https://github.com/shivbijlani/focus-planner/issues/650) already owns extraction, distribution, and the first real consumer migration. Its [public pilot… |
| #672 | Shared sorting: add an explicit opt-in alias capability without positional-argument drift | The shared-code pilot already exists: [issue related issue: Pilot: prove shared package consumption via taskSort.js](https://github.com/shivbijlani/focus-planner/issues/650) and [PR related issue: extract taskSort.js into… |
| #640 | Task actions sheet renders below the fold on a narrow viewport: Create Journal sits 226px off-screen and is the only way to start a new task's journal | Found by dogfooding through the Planner UI on task related issue (2026-09-09 ~22:30 PT), while creating task 483 on a narrow/mobile-width viewport. |
| #635 | Triage consults the shipped check before recommending work, not after | ``` filed-and-unworked <- pick this up shipped-awaiting-his-review <- do NOT pick this up ``` |
| #632 | shipped-but-open-sweep is inert in the suite that runs it: the wrapper's planner cwd is not a git checkout, so it classifies 0 of 169 issues and still reports `ok, findings 0` | `shipped-but-open-sweep.mjs` (shipped today in related issue / PR related issue, merged `a30493a`) is registered in the sweep suite at `run-sweeps.ps1:203`: |
| #622 | The telegram-bridge checkout is on no deploy manifest: merged bridge code can stay inert while both deploy checks report clean | Found live during the 2026-09-08 overnight run, while shipping related issue/related issue. |
| #613 | PHASE 3 dies with an unwrapped "One or more errors occurred." when the box is at its commit limit: the token fetch Add-Type fails, is retryable, and the message names nothing | PHASE 3 (the Telegram mirror) failed tonight (2026-09-07 ~20:15 PT) with an error that names nothing actionable: |
| #609 | observe-bound-docs declares FAIL with no retry, so a transient fetch and a broken document print the identical line (measured: 14 OK / 1 FAIL, and the FAIL was transient) | `observe-bound-docs.mjs` declares `FAIL` on the **first** unsuccessful attempt. There is one `spawnSync` to fetch and one to observe, and **no retry**. So a transient fetch hiccup and a genuinely broken document print the **identical line**, and the… |
| #607 | A session that correctly does nothing is recorded as unwakeable: task related issue burned 3 sessions, and both replacements cite a could not be woken that the event log disproves (3.4s and 9s wake latency) | The per-task session liveness verdict is wrong in a specific, repeatable way: **a sub-session that wakes promptly and correctly decides there is nothing to do is recorded as `-SessionDead` and replaced.** The replacement's kickoff then asserts, in writing,… |
| #600 | A forgotten `mark` makes the turn boundary EOF, so a raw reply below it is never seen (measured: reopened=false, trailing empty) | A wake that writes a turn but skips `oa-state.ps1 mark` leaves the journal with a provenance marker and **no `<!-- /overnight-agent turn-end -->` terminator**. In that state, `Get-AgentEndIndex` returns **the full length of the file**, so the trailing… |
| #587 | Row kebab and its action sheet are both named just "Task actions" - a Delete/Complete menu that never says which task it will act on | Found while dogfooding the Planner UI on **plannermd.com** for board task **related issue** (drive the site, don't hand-edit the file). Reproduced live on the bijlanis CDP profile on 2026-09-07. |
| #577 | Tasks created in the Pacific evening are stamped with tomorrow's UTC date and render an age of `-1d` | Found by dogfooding through the Planner UI on task related issue (overnight run 2026-09-06 23:0x PT). |
| #569 | A user message above the sentinel is invisible to `reopened`: scan and extract disagree on the same file, and the related issue Today row sat `not_workable` with a same-day request in it | `scan`'s reopen reader only looks **below** the `<!-- /overnight-agent turn-end -->` stamp. But the Focus Planner app does not always append the user's message there — when he edits the task's own notes, his message lands **above** the `<!--… |
| #568 | check-agent-inbox.ps1: 42s probe budget too short for MCP cold start, producing false NOT CHECKED | `check-agent-inbox.ps1` uses a 45s-per-call budget (42s observed in the probe). On this machine that is **too short for MCP cold start**, so a perfectly healthy inbox is reported as `NOT CHECKED` — the exact "fail closed and loud" path related issue added, fired on… |
| #567 | oa-state.ps1: CWD-relative settings candidate lets the bundled template override real user-settings.md | `Get-UserSettingsPath` in `oa-state.ps1` includes a **CWD-relative** candidate. Because `SKILL.md`'s own documented invocation style is `<skill>\oa-state.ps1`, any run that `cd`s into the skill directory first resolves settings to the **bundled template**… |
| #558 | Retire repair-board-307: it reports phantom damage on a board the reader parses correctly | The `related issue` board-repair tooling (`scripts/repair-board-307.mjs` + `src/boardRepair.js`) reports the live board as damaged when the app reads every one of those rows correctly. Its output has now caused at least two overnight-agent turns on related issue to describe… |
| #556 | A reused task ID makes a LIVE task read `user_completed: true`, arming permanent reply-suppression (measured on related issue, a hit-and-run report) | Found by `board-integrity` during the 2026-09-06 07:01 PT overnight run. |
| #554 | collect-google-tasks.ps1 calls a tool that does not exist - the collector has never once succeeded | `collect-google-tasks.ps1` (shipped in PR related issue, merged 2026-09-06 as the fix for related issue) **fails 100% of the time on its first and every real execution.** It calls `list_task_lists`, and the `google-workspace` MCP does not expose a tool by that name. |
| #551 | split-user-settings.ps1 backs up on every write and never prunes: 26 files / 5.8 MB in 14 days, in the OneDrive-synced planner folder | `split-user-settings.ps1` backs up `user-settings.md` before every write (guarantee **g2**), but **nothing ever prunes those backups**. They accumulate forever inside the OneDrive-synced planner data folder. |
| #545 | scan emits the raw unanswered_user while every gate uses the closed-filtered one, so 3 closed tasks raise an ask no run is permitted to clear | `scan` emits the **raw** `unanswered_user`, but every internal reader uses the **closed-gated** `Test-UnansweredUser`. So the one field the run reports to Shiv disagrees with the one the run acts on — and it disagrees in the direction that manufactures an… |
| #543 | last_turn_at is stamped by any status-only mark, so "a turn was written here" is satisfiable without writing one - it defers the stale-turn backstop and passes -Exhausted's "must follow real work" check | `Cmd-Mark` stamps `last_turn_at` on **any** `-Status` call, whether or not a turn was written. So a status-only `mark` — which by design does not touch the journal — records that a turn happened at that moment. |
| #541 | A `blocked` task holds the only capacity slot: Test-SessionHoldsCapacity excludes done/skip but not blocked, so recording a user pause costs the run its dispatch slot (measured: 6 eligible, admits 0) | `Test-SessionHoldsCapacity` treats only `done`/`skip` as work that holds no capacity. **`blocked` falls through and keeps its session counted as work in flight** — so a task that is waiting on Shiv, and provably cannot progress by itself, holds the only… |
| #540 | A user pausing a sub-session is invisible to PHASE 1: session -Id returns reuse/live and the next run wakes it straight back up (measured on related issue) | PHASE 1 dispatches an approved/in-progress task to its bound sub-session on the strength of `oa-state.ps1 session -Id <ID>` alone. That command answers **"does a live session exist?"** — it does not answer **"is that session allowed to work right now?"** |
| #539 | create_issue gates on the CALLING project's GitHub link and ignores repo_full_name, so folder/local-only workspaces silently lose an explicit 'file an issue' instruction | While executing planner task **related issue** on 2026-09-05, an overnight-agent sub-session was told to file a GitHub issue (a workspace-discipline rule Shiv had explicitly asked for). It called the harness `create_issue` tool with `repo_full_name:… |
| #538 | Agent must not create side-project working files inside the Focus Planner data folder | The agent is treating `C:\Users\shiv\OneDrive\Apps\Focus Planner\` as general scratch space and creating side-project working files there. It is not scratch space — it is the planner's **own data store**: the board (`planner.md`, `planner-completed.md`),… |
| #534 | oa-state scan is journal-driven, so a board row with no journal file is invisible to the entire run - Today row 1 (related issue) was silently unworkable | `oa-state.ps1 scan` is the run's worklist — SKILL.md says "Run this first, every run" and "Work the rows in the order `scan` gives you". A board row that has **no journal file yet** produces **no scan row at all**, so it is invisible to every phase of the… |
| #527 | No deterministic "blocked on human" flag or last-evaluated timestamp: 164 of 244 tasks are parked on Shiv and nothing tells him which | From the task-463 journal, 2026-09-05 (verbatim): |
| #524 | PHASE 2's Google Tasks collect reads a truncated page as the whole backlog: 9 open vs the true 35, and the under-read is indistinguishable from a burn-down | The 2026-09-05 08:15 PT run did the weekly `related issue` poll (SKILL.md PHASE 2 step 2 — "collect open Google Tasks as extra planner candidates") and read **9 open tasks**. |
| #522 | Observing a doc-bound task's comments erases it from the capacity count: the run dispatches an item and admits stays 1, so related issue's fix opens the over-dispatch direction it warns about | `session -InFlight` reports **`in_flight: 0, admits: 1`** while task **related issue** holds a live, just-woken, unreleased session that a session was actively working. |
| #520 | A guard that cannot run returns the same value as a guard with nothing to do: three instances of one shape (related issue, related issue, DISMISSIVE_ASK_RE) | Three separate defects this repo has already hit share one shape: **a check that cannot do its job returns the same value as a check that had nothing to do.** Each was fixed at its own site. The shape has now recurred three times, which suggests the class… |
| #518 | Turns can ask for an approval word the gate has already granted: a valid, well-formed, unnecessary ask that related issue cannot catch | A turn can ask for an approval word for an action the gate has **already granted**. The word is valid, the reader accepts it, and it still should never have been asked for — because consent already exists. On a doc-bound task this is not merely noise: a… |
| #516 | Exhaustion has one word for two states: "queue drained" and "clock ran out" both release the Today gate, but only one is a fact about the row | `-Exhausted` is the only vocabulary for two different true states — *the queue is drained* and *the clock ran out* — and both release the Today gate. The second is a fact about the **run**, not about the row, so it should never operate a row-level gate.… |
| #515 | Resolving a blocking ask strands its Telegram notice: the message keeps the last ask forever and its id is forgotten | Resolving a blocking ask clears `docLinkNoticeHash` **and** `docLinkNoticeMessageId`, but never touches the message itself. The notice stays on the user's phone showing the **last ask it ever carried**, and the bridge has forgotten its id, so nothing can… |
| #514 | G12 trusts a field the agent writes: stamping last_woken_at retroactively bypasses the one-turn-per-wake guard | `write-turn.ps1` **G12** enforces "at most one turn per wake" by comparing the newest backup stamp against `session.last_woken_at` in the task's state file. But `last_woken_at` is a field the agent writes, and G12 trusts it unconditionally — so **writing… |
| #513 | An ask can instruct a gate edit that cannot work: the floor is unscopable, so no allow rule can ever create an exception | An ask can tell Shiv to make an `agent-gate.md` edit that **provably cannot unblock the action**, and nothing detects it. The floor (`Always ask`) is matched by **action kind**, outranks the allow list, and has **no scoping mechanism** — so no allow rule,… |
| #511 | `merge <n>` is command-shaped but the number is never checked: one approval authorises any PR, and `merge 70 and 72` silently drops 72 | `merge <PR number>` was introduced by related issue to be **command-shaped**: a bare `merge` runs through agent narration constantly, so a number was required to make the phrase impossible to self-author. That purpose is served. |
| #506 | Changing a poll/recheck cadence resets next_due to now, so 'run less often' makes a blocked task run sooner and eat the only slot | Changing a poll or recheck cadence resets `next_due` to **now**, so the one-call form of "run this task less often" makes it run *sooner*. Measured live tonight, on the task where it did real harm. |
| #491 | Turns can advertise a reply word the consent reader rejects: the vocab guard pins SKILL.md, not the asks we actually send | A journal turn can advertise any reply word it likes. The consent reader accepts a fixed list. Nothing checks that the word we **advertise** is a word the reader **accepts**, so an ask can be born unanswerable — and the failure is silent in both… |
| #487 | A task parked awaiting a reply holds a capacity slot forever: in_flight counts sessions that cannot be worked, so admits stays 0 and dispatch deadlocks | The run session could not dispatch any work at all: |
| #485 | Sweeps measure the working checkout, which nothing pulls - so a stale tree yields a confident, wrong verdict (measured: FLAGGED 9 commits when the truth was 0) | Sweeps that read the repository read the **working checkout** at `V:\repos\focus-planner`. Nothing in a run ever pulls it. PHASE 0's `auto-deploy-plugin.ps1` fetches `origin` and deploys from `origin/main`, so **deploys are correct** — but every sweep that… |
| #480 | A wedged copilot.exe leaks a session lock, so an abandoned session reads alive forever - the liveness signal two sweeps depend on | While verifying the related issue detector ([PR related issue](https://github.com/shivbijlani/focus-planner/pull/479)) against a copy of the live state store, the replayed incident came back labelled `WAKE_UNSERVICED` when the evidence said `ZERO_WRITER`. The detector was… |
| #471 | The run summary asserts repository state it never queried: two false claims in one run, both caught only by a sub-session | <!-- from: overnight-agent --> |
| #465 | Consent is replayable: an affirmative is never spent, and whether it is depends on a marker the agent writes about itself | `oa-state.ps1 consent` has **no notion of an affirmative being spent**. An `approve` stays live in the trailing region indefinitely, so a run today can be authorised by an approval the agent itself answered a week ago. |
| #456 | gh issue edit --body is an unguarded overwrite, and issue bodies carry no authorship - so "was my work overwritten?" cannot be answered either way | > **Corrected 2026-09-04 — second correction, settled against GitHub's own edit history.** This issue was filed citing a real overwrite on [related issue](https://github.com/shivbijlani/focus-planner/issues/454), then **wrongly retracted** on the strength of a… |
| #419 | auto-deploy resolves ref-history-index.mjs from the working tree, so it dies when the checkout is behind origin/main | After PR related issue (merged as `b46edfd`), `auto-deploy-plugin.ps1` resolves its new history helper from the **repository working tree**: |
| #418 | auto-deploy still exceeds its 60s budget on the live repo after related issue, so PHASE 0 ends in exit 2 every run | PR related issue (merged as `b46edfd`) bounded the auto-deploy's history work and added a wall-clock budget. On the **live repository** the classification still does not fit inside that budget, so PHASE 0's deploy step ends in a hard failure on every run: |
| #414 | Agent sessions run a git that deletes through junctions: the Copilot-bundled git 2.53.0 shadows the system git 2.54.0 on PATH | Agent sessions on this machine run a **git that deletes through a junction**, while the system git installed on the same box does not. Nobody upgraded anything wrong: the Copilot-CLI-bundled git **shadows** the system git on `PATH`, so every agent session… |
| #413 | auto-deploy exits 2 with "DRIFT SURVIVED THE DEPLOY" against a byte-identical tree: the merged-but-dead guard cries wolf | `auto-deploy-plugin.ps1` finished tonight's PHASE 0 with **exit code 2** and this banner: |
| #412 | PHASE 0's auto-deploy never finishes: 211 sequential git rev-list walks (~40 min), so "merged" still does not mean "running" | PHASE 0's `auto-deploy-plugin.ps1` step - the step that exists to make "merged" mean "running" (related issue) - **never completes**. It is not hung and it does not crash; it is doing ~211 sequential `git rev-list` history walks, each costing ~11 s on this repo,… |
| #408 | extract reports 'linked: (none)' for a task whose board row HAS a Linked ID - the upstream walk silently never happens | `oa-state.ps1 extract` reports **`linked: (none)`** for a task whose board row carries a `Linked ID`. The parent exists, the board records it, and the extract denies it — so the agent skips the upstream walk that `SKILL.md` mandates, and never sees the… |

</details>

### Deploy propagation, checkout drift, and collection sweeps

These issues describe gaps in getting a merged change running, and in the sweeps meant to catch collection drift.

> [!NOTE]
> **Technical detail: concrete reference.** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

| Issue | Title | Gap / direction from issue text |
| --- | --- |---|
| #800 | Deployment profile, host provider seam and storage provider registry | Item 1 (related issue, merged) left the app with exactly one active storage source and a provider list/factory in `src/storage/sources.js`. This item adds the three seams that let a second deployment (an enterprise Managed App build that lives in another repo) plug… |
| #753 | Convergence: unify provider registration without changing existing storage behavior | The current app has a registry of connected sources, but not a registry of provider implementations. At `8b0d15e09ed9120689edb3835f55b322a7cc204e`, provider lists/factories are hard-coded separately in… |
| #751 | Convergence: add a default-preserving deployment profile and host-provider seam | The combined-product direction needs a consumer-owned host/profile boundary, not a second fork of the app. At assessed revision `8b0d15e09ed9120689edb3835f55b322a7cc204e`,… |
| #710 | Tray update check always reports version-unknown: CLI marketplace browse omits plugin versions | The tray update-check workload `plugins/overnight-agent/checks/consumer-update-check.mjs` (related issue, merged via related issue) reads the catalog version from `copilot plugin marketplace browse focus-planner --json`. |
| #701 | Tray workload: plugin update check (hourly maintainer, daily default) | Part of the tray rollout (related issue, foundation shipped in related issue). |
| #668 | auto-deploy reports "DEPLOY NOT VERIFIED" when the deploy is verified: a dirty third checkout is surfaced through the deployment channel | `auto-deploy-plugin.ps1` exits 2 and every consumer reports **"DEPLOY NOT VERIFIED — merged code may not be running"** on runs where the deploy is complete and verified. |
| #617 | Deploy backups are never pruned: 898 directories in 13 days (~69/day) under %LOCALAPPDATA%\overnight-agent\backups | `auto-deploy-plugin.ps1` and `sync-oa-home.ps1` write a timestamped backup directory under `%LOCALAPPDATA%\overnight-agent\backups\` every time they deploy a file, and nothing ever prunes them. |
| #481 | session-state is never pruned: 4,109 directories / 2.6 GB since April, and 488 stale locks sit in the path two liveness sweeps read | Measured 2026-09-04 ~06:33 PT from the overnight run, while verifying that the new `zero-writer-sweep` (related issue, shipped tonight as related issue) reads the right session id. It does -- but the directory it reads has never been pruned. |

</details>

### Session, workspace, and runtime hygiene

These issues describe per-task session, workspace and MCP/browser process lifecycle gaps.

| Issue | Title | Gap / direction from issue text |
| --- | --- |---|
| #696 | Make user-settings.md the canonical supervisor policy source | Atomic rollout step B: make the shared user-facing `user-settings.md` the canonical source for tray-supervisor reliability policy. |
| #695 | Add optional tray app for overnight-agent reliability supervision | Implement the first atomic step of the supervisor rollout: a single optional Windows tray app for overnight-agent reliability supervision. |

### Miscellaneous

These issues do not cluster under the themes above.

| Issue | Title | Gap / direction from issue text |
| --- | --- |---|
| #808 | oa-state shifts doc-comment observed_at by the UTC offset on non-UTC hosts (CI blind: runners are UTC) | Found while porting `oa-state.ps1` to Node (item 4). |
| #707 | Keep marketplace.json overnight-agent version in sync with plugin.json so tray update checks can see updates | The tray update-check workload (related issue, merged via related issue) reads the catalog version from `copilot plugin marketplace browse focus-planner --json`. That catalog is `.github/plugin/marketplace.json`, and its `overnight-agent` entry has been `1.1.0` since related issue.… |
| #462 | Both new write-guards ship with caller-facing traps that fail toward the outcome they prevent: undefaulted writeFile, and a verdict object that duck-types into a duplicate post | Both safety contracts shipped tonight — `lib-issue-body.mjs` (issue related issue / PR related issue) and `lib-issue-comments.mjs` (issue related issue / PR related issue) — are **correct**, and both have caller-facing shapes that fail toward the exact outcome they exist to prevent. Each bit… |
