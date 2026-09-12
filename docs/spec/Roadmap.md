# Roadmap

This page records **known gaps and forward direction** from the **178 open issues** captured in `spec-facts.json`. Entries with a `priority:` label are grouped by that label first. Remaining issues are grouped by the exact non-priority labels present, and issues with no labels are grouped by recurring themes from their titles and bodies. Use this alongside [Behaviour](Behaviour), [Reliability](Reliability), [Prioritisation](Prioritisation), and the relevant `Domain-*` page.

## Critical

7 open issues carry `priority: critical`. These are the explicitly triaged gaps in the snapshot.

| Issue | Other labels | Title | Gap / direction from issue text |
| --- | --- | --- | --- |
| #501 | bug, reliability | Agent-declared done confers user-closed semantics: a Today row swallowed 3 user messages and released the Today gate | A task the agent marked done acquires the semantics of a task the user closed. On planner task related issue — which is still row 1 of ## Today in planner.md — that caused three unanswered… |
| #422 | bug, reliability, overnight-agent | Google Doc comments have no author attribution: the agent's own replies come back as Shiv, so comments cannot be an instruction or consent channel | Shiv wants Google Doc comments to be the primary communication mechanism for a task (related issue). That requires the agent to answer one question every wake: which comments are his, and which are my own replies? |
| #261 | bug, reliability | A stuck "running" Overnight Agent run freezes the */30 schedule — no run-level timeout to fail & reschedule | Net effect: a single hung run silently disables the entire every-30-minutes automation with no alert. This is the run-lifecycle analogue of the browser-slot watchdog gaps in related issue / related issue, but for the workflow run… |
| #197 | bug, tech-debt, reliability | Watchdog cannot recover a STUCK browser slot - only a missing one (TCP-accept is treated as health) | Related to the performance-improvements work in related issue (process fan-out / memory), and to related issue (reaper ownership), related issue (the exact stuck-slot symptom) and related issue (slot table). Umbrella: related issue. |
| #180 | enhancement, reliability | Browser slots: move the slot table into user-settings, default to 3 (regular/bijlanis/kiley), and launch a closed profile on demand | Six slots are configured, five of which are near-identical clones of the same account: |
| #179 | enhancement, tech-debt, reliability | ~120 tool schemas advertised per turn, most of them duplicate browser slots or an unused integration | Every MCP server the CLI connects to injects the full JSON schema of every one of its tools into the model's context on every single turn, whether or not that tool is ever called. The agent… |
| #139 | reliability | Playwright MCP CDP attach times out when the signed-in browser is overloaded (too many targets / pegged main thread) | When this happens the agent cannot read or drive the page and has to set the task blocked (seen repeatedly on planner tasks related issue and related issue). |

## High

28 open issues carry `priority: high`. These are the explicitly triaged gaps in the snapshot.

> [!NOTE]
> **Technical detail: concrete reference.** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

| Issue | Other labels | Title | Gap / direction from issue text |
| --- | --- | --- | --- |
| #643 | bug, reliability | Supervisor restarts all GHCP sessions to clean up one finished run, interrupting unrelated active work | The out-of-band supervisor recovers a stuck-but-finished workflow record by restarting the whole app, which also kills sessions that are mid-tool-call and progressing normally. |
| #638 | bug, reliability | A 5h49m host-sleep outage silenced every scheduled unit and left zero record: the supervisor heartbeat stores only lastCheckUtc | The host slept 5h49m; ~11 overnight-agent slots, ~23 heartbeats and a forensics pass were all silently skipped, and on resume the supervisor wrote a fresh timestamp that reads as a healthy daemon 20 seconds later. |
| #627 | bug, reliability | `eligible` binds selection but not work: admits stayed 0 for a 6h window while 3 journals gained turns, 2 on rows scan marks ineligible | Spec-conformance forensics pass 7 measured `admits` staying at 0 across a 6-hour window while turns were still written to journals, 2 of them on rows `scan` itself reports as `eligible: false`. |
| #618 | bug, reliability | A declared ask is never validated against its own turn: related issue asks two questions it cannot guess, declares them an 'offer', and no reader waits (25 of 254 rows have an open ask nobody awaits) | #560 replaced the prose-regex `awaiting_reply` with a declared ask (`<!-- oa-ask: ... -->`), and declared rows rose from 6 to 11 across two runs. But nothing validates a declared ask's `-Ask` level against what the turn's own text actually asks: a turn can declare `offer` while asking a question it cannot guess the answer to, and no reader waits on it — measured at 25 of 254 rows carrying an open ask nobody is waiting for. |
| #605 | bug, reliability | A due poll never fires on a Deferred row: Test-Workable grants the timer override, then the Today gate discards it (measured: related issue due_poll=true, eligible=false) | Measured live on the board by the spec-conformance forensics pass (#565): `Test-Workable` grants the due-poll timer override on a Deferred row, but the Today gate discards that grant before dispatch — so a due poll never actually fires on a Deferred row, despite `docs/spec/Prioritisation.md`'s parking table stating that it should. |
| #589 | bug, reliability | in_flight reports 3 against a concurrency ceiling of 1, and scan emits no per-row capacity field so the membership of that 3 is unobservable | `session -InFlight` reports 3 items in flight against a ceiling of 1, and the set of sessions producing that 3 is not derivable from any read-only interface — `Prioritisation.md` treats the ceiling as normative, but nothing on the worklist names which rows count against it. |
| #583 | bug, reliability | 6 of 12 scheduled overnight-agent run slots recorded zero turns in a 6h window (3 most recent consecutive), so 'fired and did nothing' is indistinguishable from 'never fired' | Spec-conformance forensics pass 3 measured a 6-hour window in which the scheduler fired 12 run slots and 6 of them, including the 3 most recent consecutively, recorded zero turns in the session store. |
| #579 | bug, reliability | Prioritisation.md 6 claims a missing concurrency row reports settings-malformed; the code reports 'default', and the documented '## Overnight Agent behaviour' table does not exist in user-settings.md | Spec-conformance forensics pass 2 found the live `user-settings.md` has no `## Overnight Agent behaviour` heading and no match for `concurrenc` at all, so the concurrency, Today-gate-backstop, and Today-gate-strict settings are all silently on built-in defaults with no signal they were never configured. |
| #565 | enhancement, reliability | No spec-conformance forensics: 50+ sweeps detect known defect shapes, nothing checks whether the system matches the spec | There are 50+ sweeps in plugins/overnight-agent/checks/, and every one of them detects a previously diagnosed defect shape. Each was written after a specific bug was found. There is nothing that asks the opposite question: |
| #564 | bug, reliability | A satisfied timer does not park its task: make 'parked until T' the single primitive for clock, third-party and human waits | A completed timer does not park its task until the next due date. poll and recheck can only release a park; neither can create one. So between polls, a recurring task falls through to the plain… |
| #562 | bug, reliability | Session replacement can go backwards: task related issue rebound to a session its own successor had already replaced (3 sessions in 13h) | Per-task session replacement can go backwards, rebinding a task to a session that a newer session had already replaced. The result is a cycle: two sessions can each be recorded as the other's replacement, and each… |
| #561 | enhancement, reliability | Scheduling decisions are unauditable: scan is not replayable and no run records why a row was picked or skipped | When a run picks a task, nothing durable records why. The ordered worklist, each row's eligibility, and the reason a higher-ranked row was skipped all exist only in memory during the run and are gone when… |
| #560 | bug, reliability | awaiting_reply is recovered by regex from the agent's own prose: declare the ask instead of inferring it | The Today→Deferred gate is driven by a fact that is recovered by regex from the agent's own narrative closing line, rather than declared. oa-state.ps1 (lines 1364–1365): |
| #549 | bug, reliability, overnight-agent | Get-Content -Raw silently double-encodes UTF-8, corrupting catch-up docs - a third corruption class, currently unguarded | The doc was built by reading a UTF-8 markdown file with bare Get-Content -Raw and pushing the string to the Google Docs API. Every em-dash, curly quote and Turkish character (Goreme, Nevsehir, Istanbulkart) landed in the… |
| #424 | enhancement, overnight-agent | Telegram: post the catch-up doc link once, then stay quiet - 21 of 28 turns on task 468 exceed the 4096-char message limit | So a task's Telegram topic should contain, in the steady state, one message: the catch-up doc link. Not one per wake. |
| #423 | enhancement, reliability, overnight-agent | No durable task-to-doc binding: the catch-up doc is found by title search, so a rename silently creates a duplicate and new comments cannot be detected | For the catch-up doc to be a durable per-task surface, the agent needs two facts it does not currently persist anywhere: |
| #421 | enhancement, overnight-agent | One catch-up Google Doc per task: make the doc the agent's output surface and its comments the reply channel | Today a planner task has two surfaces and both are chronological logs: |
| #404 | — | Overnight agent works tasks in the run session: no per-task session, no workspace isolation, no persisted session id | The overnight agent does the work itself, in the run session. There is no per-task session, no per-task workspace, and no memory of where a task's work was last done. |
| #346 | bug, reliability | PHASE 0's mandated inbox check silently does not run when the email MCP fails its startup handshake - a missing tool is indistinguishable from an empty inbox | PHASE 0 of the Overnight Agent skill mandates, every run: |
| #321 | bug, reliability | git worktree remove --force deletes through a node_modules junction, emptying the shared install for every checkout | The documented way to avoid a slow npm install in a worktree is to junction the main checkout's node_modules: |
| #318 | bug, reliability | Guards were green against a shape the app never wrote: fixtures named for a producer are not pinned to it | Four guards asserted, for months, that the planner app writes journal replies as ## <date> + . The app did not write that shape until related issue merged tonight. |
| #312 | bug, reliability | Hazard: a planner client can hold a board 2 revisions stale and still enter 'Backing up...' - possible upstream mechanism for related issue | While attempting to drive the planner UI (to set a parent link Shiv requested over Telegram), I loaded plannermd.com in a signed-in browser profile that had not been used for the planner recently. The app rendered… |
| #304 | bug, reliability | The user-facing explainers advertise approval words the consent reader rejects — 3 of 4 live asks were dead | related issue fixed the vocabulary drift between the consent reader and SKILL.md, and related issue added a mechanical guard so those two can never diverge again. But SKILL.md is not the only surface that tells the… |
| #302 | bug, reliability | A gate-allowed verdict bypasses the journal, so an agent can merge over a fresh human "don't" — the guard is prose only | PR related issue makes agent-gate.md enforceable. Its consent command short-circuits: when the gate file allows an action, it returns consent_ok: true / reason=gate-allowed before the journal is ever read. |
| #291 | bug, reliability | Task journals are on the per-run read path and grow without bound — task-400.md is 257 KB (~66K tokens) | SKILL.md instructs the agent to read a task's linked journals in full before planning or executing: |
| #243 | enhancement, reliability | Browser watchdog has no plugin update check - the plugin self-heal is circular (lives inside the agent it repairs) | The condition is met — the watchdog does not do a plugin update check — so this issue exists. But the premise needs one correction before anyone acts on it, because the scary reading ("we ship… |
| #181 | bug | A green check must mean all tests ran and passed - 25 of 30 open PRs have zero CI checks yet badge CLEAN | Every one of those 25 reports mergeStateStatus: CLEAN, which in the GitHub UI and in gh pr list reads as "good to go". It does not mean the tests passed. It means nothing ever ran. CLEAN… |
| #170 | — | Overnight Agent writes turns into tasks that are already closed | This issue is the single source of truth for the bug. The fix should land as one piece of work, not a stack. |

</details>

## Medium

18 open issues carry `priority: medium`. These are the explicitly triaged gaps in the snapshot.

| Issue | Other labels | Title | Gap / direction from issue text |
| --- | --- | --- | --- |
| #571 | bug, reliability | status_by carries no close-provenance: it is 'agent' on 249 of 250 rows while user_completed is true on 54, so related issue's stated conformance check is unevaluatable | docs/spec/Prioritisation.md builds the "only the user closes a task" invariant (related issue) on task provenance, and scan exposes a status_by field that appears to carry it. It does not. status_by is agent on 249 of 250… |
| #563 | bug | Task menu reports 'AI-assisted: Off' and 'Persistent session: Off' for behaviour that is always on; cut the persistent-session toggle | The task kebab menu shows two per-task toggles that both read Off: |
| #496 | bug | Per-task session titles lose the planner task id, so worked tasks look undiscoverable | Per-task session binding works, but the visible session title does not preserve the planner task id. A session is renamed to the latest GitHub issue or PR it handles, so searching sessions for the planner task… |
| #383 | enhancement, reliability | Agent-opened browser tabs have no owner, so leftover tabs accumulate and cleanup is unsafe by construction | Short answer: the instinct is right, the literal mechanism is not available, and the valuable half is ownership rather than grouping. Detail below, including a measurement that says this would not have prevented the most recent… |
| #381 | bug, reliability | mutcheck-browser-slots arm E is non-hermetic: it probes the live debug ports, so the suite is red on main whenever a browser is open | mutcheck-browser-slots.ps1 fails on main right now, and it fails for a reason that has nothing to do with the code under test. Arm E asserts that check-browser-slots.ps1 "exits 0 when nothing is up", but the fixture… |
| #330 | bug, reliability | The exhaustion TTL is one parameter doing two jobs: it expires mid-run (fail-closed), and raising it would let one run declare on another run's work (fail-open) | Post-merge finding about a default introduced in related issue, surfaced by a fleet observation and then measured. The symptom is not a correctness bug — it fails closed — but the default is sized against the… |
| #328 | documentation, reliability | A bare #NNN is ambiguous: 24% of GitHub numbers already collide with a live planner task ID | This is not a coming problem. 78 of 327 GitHub numbers (24%) already collide with a live planner task ID, and the ranges are converging: GitHub is at 327 and climbing (seven filed in one night)… |
| #326 | reliability | oa-state.ps1 never writing agent-gate.md is load-bearing for the consent channel, stated in a comment, and asserted by nothing | oa-state.ps1 states, in its own header at line 367: |
| #322 | enhancement, reliability | The Today gate's release is still agent-authored: verify exhaustion against the drained queue instead of taking the run's word | The Today→Deferred gate no longer releases on recency. It releases when the run makes an affirmative exhaustion declaration in its own call, naming what it examined: |
| #285 | — | On plugin update, tell the user what actually changed for them (not bug numbers) | The version moves and nothing tells the user what moved with it. Today the only way to answer "which bugs should I expect to see fixed?" is to read git log across the bumps and translate… |
| #275 | bug | Mobile: link / linked-ID UI looks broken on phone (desktop is fine) | Live on plannermd.com, viewport forced to 600 x 900: |
| #250 | reliability | Consent still rests on a marker the agent's own software writes (follow-up to related issue) | It is not an unforgeable channel, and related issue's third success criterion is still unticked: |
| #184 | — | Dailies: recurring items (self check-off + agent-run activity visibility) — task related issue | Some items recur; the one-and-done task model doesn't fit them. From the original note, four flavors: |
| #176 | — | Consolidate all plannermd + Overnight Agent development into one board task and one issue trail | Consolidating all planner-md / Overnight Agent development into one place. |
| #132 | bug | Task IDs can be reused after completion (completed board not in allocation universe) — e.g. related issue collision | After the first related issue was completed and moved off the active board, the allocator handed 392 out again to a brand-new task. IDs are meant to be permanent and unique across the app's whole history… |
| #127 | — | Split SKILL.md guardrails/reference prose into referenced static partial files (companion to related issue) | This issue is the complementary, distinct piece related issue does not cover: moving the *judgment/reference prose itself out of SKILL.md into separate, referenced static partial files* — without turning it into script stdout. The guardrails stay… |
| #124 | enhancement | Offload Overnight Agent business logic to a script; keep SKILL.md a thin wrapper | The Overnight Agent skill is mostly SKILL.md — a ~40 KB / ~496-line prose file. Because a skill doc is read inline by the LLM every run, it has a practical size ceiling, and every future… |
| #123 | enhancement | Journal .md store vs Telegram: source of truth + completed-journal growth | _Filed by the Overnight Agent on behalf of task related issue (journal storage & source-of-truth)._ |

## Low

16 open issues carry `priority: low`. These are the explicitly triaged gaps in the snapshot.

> [!NOTE]
> **Technical detail: concrete reference.** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

| Issue | Other labels | Title | Gap / direction from issue text |
| --- | --- | --- | --- |
| #646 | enhancement, priority: low | Journal UX: a user-triggered compression button that rewrites a long journal into one pinned part and one current response | Journals only grow; a task worked over weeks accumulates a thread nobody re-reads from the top. Shiv asked for a button that lets the agent rewrite a long journal down to one pinned summary plus the current response. |
| #645 | enhancement, priority: low | Journal UX: a button to insert a todo, so adding one does not require typing `- [ ]` by hand | The reading side of journal todos (checkbox rendering, `/api/todos` extraction) is done; the writing side is not — today a todo can only be added by knowing the markdown convention and typing it by hand. |
| #327 | documentation, reliability | Guard-authoring conventions have no home: three "this should be a convention" notes are stranded on three separate issues | Three separate issues have now each ended with "…and this should go in the guard-authoring conventions." There is no such document, so each note is stranded on its own ticket and the next guard gets written… |
| #207 | — | Remove backward-compatibility artifacts - single-user install, no legacy support needed | There is exactly one install of this app (Shiv's). Any code that exists solely to keep an older on-disk shape working is dead weight: it can be deleted, and the one environment migrated forward by hand… |
| #104 | enhancement | Overnight agent: final-phase post-mortem + dream-mode memory | Add a final-phase post-mortem + "dream mode" memory to the overnight agent so it compounds learning across runs (from Focus Planner task related issue, split out to keep the app-UI close-out task clean; kin to related… |
| #88 | enhancement | First-run experience: interactive, lesson-tracked onboarding tutorial (iPhone mini) | Add a first-run experience for users who have no tasks yet. Instead of a static welcome modal, the app seeds fake ("training-wheels") tasks that the user taps to learn each core action by doing it. The… |
| #85 | enhancement | Event-based journal unread indicator (UI fires events; localStorage as first provider) | Event-based journal unread indicator (UI fires events; localStorage as first provider) |
| #77 | enhancement | Journal read/unread tracking (event-driven UI + localStorage provider, star overlay) | Track which journals have unread updates and show a star/dot badge on the journal's icon in the sidebar. Clearing happens when the user opens the journal. |
| #71 | enhancement | Journal read/unread tracking: event-driven UI + localStorage provider + star overlay | Journal read/unread tracking: event-driven UI + localStorage provider + star overlay |
| #61 | enhancement | Event-driven unread/read indicator for journals (UI fires events; localStorage provider; no sync v1) | --- _Filed by the Overnight Agent on behalf of @shivbijlani for hand-off to an autonomous coding agent (jules.google.com). Deliverable requested: a short video demoing the unread star appearing on a new entry and clearing on open._ |
| #56 | enhancement | Event-driven journal read/unread state (star overlay, no UI business logic) [related issue] | Event-driven journal read/unread state (star overlay, no UI business logic) [related issue] |
| #21 | — | Rebrand: rename Azure AD app + Google OAuth consent screen to "Planner" | Updating with detailed instructions and a verified PowerShell snippet. |
| #18 | — | Local-first storage with background cloud sync via service worker | Rework the storage layer so all reads/writes hit a local store first (instant UI), and a service-worker-driven sync engine propagates changes to cloud providers (OneDrive, Google Drive) in the background. The whole thing ships as a… |
| #12 | — | Move tasks between sources via right-click | Move tasks between sources via right-click |
| #8 | tech-debt, cleanup | Remove multi-source backward-compat code (legacy fp-storage-provider, unsuffixed FSA handle, migrateLegacy) | 1. src/storage/fsa.js — legacy unsuffixed IndexedDB handle fallback Lines ~24–34 in restoreFolder(suffix). Adopts focus-planner-dir-handle → focus-planner-dir-handle:<suffix>. Becomes a no-op after one successful load (it deletes the legacy slot). Safe to remove once the production deploy has… |
| #5 | — | Feature: Connect personal OneDrive folder and prepare for combined task view | Today, these contexts are split. Users cannot easily view personal + work tasks in one place. |

</details>

## Labelled but unprioritised

22 open issues have labels, but none of those labels is a `priority:` band. The tables below keep the grouping faithful to the data instead of inventing a priority order.

### `reliability`

| Issue | Title | Gap / direction from issue text |
| --- | --- | --- |
| #533 | auto-deploy: a budget expiry in the LAST phase leaves the two deploy targets on different refs, and the exit-before-report path never says so | auto-deploy-plugin.ps1 deploys two targets in sequence — the installed plugin tree, then the OA home under %LOCALAPPDATA%\overnight-agent. Both draw from one cumulative wall-clock budget. When that budget expires during the second target's sync, the first target… |
| #532 | A poll-driven wake never advances last_woken_at, so write-turn G12 refuses EVERY author and the wake records nothing (measured on related issue) | A poll-driven wake never advances session.last_woken_at, and write-turn.ps1 G12 keys "is there already a turn for THIS wake?" off that stamp. So on any task with a bound session and an armed poll, the stale stamp… |
| #436 | oa-state doc: journal_stamped is always false on a resolve, so a durable binding and an at-risk one look identical | oa-state.ps1 doc -Id <ID> reports journal_stamped: false for every resolve-only call, whether or not the journal actually carries its stamp. |
| #351 | In-flight work is invisible to other sessions: a finished fix sat unshipped, and two sessions then duplicated it | The fix for related issue was already written before this run started. A previous session had done the work, committed it, and pushed it to shivbijlani-fix-supervisor-wal-stale-read — and then never opened a pull request. It had… |

### `bug`

| Issue | Title | Gap / direction from issue text |
| --- | --- | --- |
| #628 | The collapse fixes cannot reach 208 of 229 bound topics: a message whose id was never recorded is unreachable forever | Every fix Shiv has been waiting on for the "single Telegram message per task" behaviour was already shipped and deployed when he wrote it hadn't improved — the fixes only apply to topics whose bound message id was recorded going forward, and no sweep measures the outcome Shiv actually looks at. |
| #626 | A stated finding and its own contradiction have equal standing in prose: the correct answer was transmitted and lost twice in one wake | Six instances, two sub-shapes, fired in a single wake: a declaration without a checker is byte-identical to its own contradiction at the point of use, the same family #520 already generalises and #618 hit for declared asks. |
| #625 | find_and_replace_doc escapes a real newline into a literal `\n`, reports `Replaced 1`, and the damage only matches back out with a real newline | A real newline written through the tool arrives in the document as the two literal characters `\` and `n`; a paragraph break cannot be inserted through this path at all, and the obvious repair (searching for the literal `\n` it left behind) silently matches nothing. |
| #602 | mutcheck-journal-encoding fails 2/3 on main: the journal encoding guard validates the call shape, not the encoding argument, so an ANSI decode inside Read-JournalText survives | `checks/mutcheck-journal-encoding.mjs` fails on `origin/main` at 2/3 mutants killed, exit 1, with arm M2 SURVIVED — the guard confirms `Add-TurnTerminator` reads with `Get-Content -Raw`, but not that the encoding argument passed is the correct one, so an ANSI decode inside `Read-JournalText` survives undetected. |
| #557 | write-turn.ps1 prints a bare backup filename, so the rollback artifact looks missing when you need it | write-turn.ps1 announces its backup as a bare filename with no directory: |
| #528 | Adding a task can reuse a live task's ID and silently destroy that task's row | Adding a task through the UI can be assigned an ID that is already in use by a live task, and the existing task's row is then destroyed — silently, with no warning, no dialog, and… |
| #502 | Doc comments read as empty: -Observe returns 0 for the MCP's own output shape | oa-state.ps1 doc -Id <ID> -Observe <file> returns zero comments when handed the exact output the Google Workspace MCP produces. -Observe then reports new_comments: 0 -- which is byte-identical to "the user said nothing." |
| #343 | A task snoozed in the app can be worked before its wake date: the agent's snooze reader never sees the Wake column | Found while writing docs/spec/Prioritisation.md (related issue). Verified against the code; not previously filed as far as I can tell. |

### `bug + reliability + overnight-agent`

> [!NOTE]
> **Technical detail: concrete reference.** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

| Issue | Title | Gap / direction from issue text |
| --- | --- | --- |
| #610 | observe-bound-docs: a transient failure and a broken page print the identical FAIL line | `observe-bound-docs.mjs` polls each bound catch-up doc once. All three failure paths — fetch exit, observe exit, `observation !== 'read'` — increment `failed` and move on with no retry, so a transient fetch hiccup and a genuinely broken document are reported identically. |
| #461 | ps1-encoding-sweep resolves its root to the main checkout, so running it from a worktree scans a different tree and reports clean | plugins/overnight-agent/checks/ps1-encoding-sweep.mjs resolves the tree it scans from a hardcoded path to the main checkout, not from the tree it was invoked in: |
| #454 | agent-lore.md is write-only: 903 KB, 160 headings, zero readers - and 'grep for the heading you need' can only retrieve what a run already knows | agent-lore.md is where the Overnight Agent is instructed to record every hazard, postmortem and run learning. SKILL.md says so explicitly: |
| #453 | Agentic issue comments carry no provenance marker, so "edit the one agentic comment in place" can overwrite a human comment | The operating contract for GitHub issue work has two rules that both depend on telling an agent comment from a human one: |
| #428 | A merged PR auto-closes its issue via Closes #N, skipping the review step the operating contract requires | PR related issue carried Closes related issue. in its body. On merge, GitHub closed issue related issue automatically — before Shiv had read the catch-up doc. I reopened it by hand. |

</details>

### `bug + overnight-agent`

| Issue | Title | Gap / direction from issue text |
| --- | --- | --- |
| #612 | A cold google-workspace MCP server reports a healthy doc as unreadable (and #610's 1500ms retry cannot cross it) | A cold `google-workspace` MCP server exceeds the probe timeout, so a healthy document reports as unreadable, and the #610 retry window is too short to cross a cold start. |

### `bug + reliability`

> [!NOTE]
> **Technical detail: concrete reference.** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

| Issue | Title | Gap / direction from issue text |
| --- | --- | --- |
| #457 | A session asserted a false negative about its own past actions after an ID rollover, and nothing could contradict it | A session asserted a confident, checkable false negative about its own past actions — "I never edited related issue" — after its surfaced session ID changed. Nothing in the system could have contradicted it. The correct… |
| #452 | Worktree teardown doesn't release the session binding — task stays bound: reuse, live pointing at a deleted workspace | Tearing down a per-task worktree with scripts/remove-worktree.ps1 does not release the task's session binding (related issue). The result is a binding that reports bound: true, verdict: reuse, state: live while the workspace it names no longer… |

</details>

### `enhancement`

| Issue | Title | Gap / direction from issue text |
| --- | --- | --- |
| #354 | Spec verify: make the gaps-page staleness gate position-aware (entry-position refs are the assertion; prose refs are history) | PR related issue also widens the issue-ref regex to a negative lookbehind (/(?<![\w\/])#(\d{1,4})\b/) because the previous /(?:^|\s)#/ boundary could not see #NNN preceded by *, (, or , — which is exactly Roadmap's entry format -… |
| #337 | Supervisor: user-settings toggle + watchdog reconciles install/uninstall to match it | Today the supervisor is installed by a one-time manual run of install-oa-supervisor.ps1 and is never reconciled. There is no way to turn it off short of manually running -Uninstall, and nothing re-asserts it if the task/daemon… |

### `overnight-agent`

| Issue | Title | Gap / direction from issue text |
| --- | --- | --- |
| #433 | G9's 800-char nudge fires on every real doc-bound turn so far (901, 1082): measure the distribution before re-tuning | write-turn.ps1's G9 nudge advises aiming under ~800 characters on a doc-bound task. Every real turn written since the guard shipped has been above it: |
| #391 | Overnight agent: encode pacing (one-item isolation, estimate-before-start, done=published) | The pacing discipline below is written down for the gh-issue-work skill (its SKILL.md has a "Pacing" section, "Set by Shiv, 2026-09-02") but is not encoded for the overnight-agent, nor in the Prioritisation wiki page (docs/spec/Prioritisation.md): |

### `security`

| Issue | Title | Gap / direction from issue text |
| --- | --- | --- |
| #314 | Personal data in the repo: region-dropdown.md contains a real email, tenant domain and directory GUID | Found while auditing the repo for personal values ahead of shipping this to other people (came out of the related issue / PR related issue work). |

## Unlabelled issues, grouped by theme

77 open issues have no labels at all in `spec-facts.json`. Because the data offers no explicit priority for them, the groups below follow the recurring topics visible in their titles and first body paragraphs.

### Docs, comments, and Google Workspace channels

These issues describe the catch-up-doc path, doc comment observability, provenance, and the handoff between Telegram turns and Google Workspace.

| Issue | Title | Gap / direction from issue text |
| --- | --- | --- |
| #620 | A doc-bound topic settles on TWO messages, not one: the #424 notice exception now fires in 59 of 76 bound topics | #424 carved a one-line notice out as a deliberate exception for the two things a doc link genuinely cannot carry — the agent is blocked on the user, or the task reached a terminal state — on the premise that this is rare. Measured across live bridge state: of 76 doc-bound topics, 59 end on two permanent messages (the link plus a separate notice) and only 17 end on the single-message ideal, so the "rare exception" is in fact the common case. |
| #609 | observe-bound-docs declares FAIL with no retry, so a transient fetch and a broken document print the identical line (measured: 14 OK / 1 FAIL, and the FAIL was transient) | `observe-bound-docs.mjs` declares FAIL on the first unsuccessful attempt across its one fetch and one observe `spawnSync` call, with no retry — so a transient fetch hiccup and a genuinely broken document print the identical FAIL line. Measured at 14 OK / 1 FAIL, and the one FAIL was confirmed transient on a second manual attempt. |
| #598 | Binding a task creates a doc channel nobody polls: PHASE 0.7 reads per-selection, so a parked task's comments reach nothing (UNREAD 0 -> 5 in 90 min, measured) | `doc -Observe` is called from PHASE 0.7, a per-task step that runs only for the task a run is working. A run works one task, so a task's doc channel is read only when that task happens to be selected — a task that is bound but not selected can accumulate unread comments indefinitely; measured going from 0 to 5 unread in a 90-minute window while parked. |
| #570 | google-workspace probes AVAILABLE but is exposed to no agent session: the doc-comment channel is unreadable from where PHASE 0.7 runs (3 of Shiv's comments sat unread) | check-agent-inbox.ps1 reports google-workspace as AVAILABLE by spawning the server as a child process. But the run — and, since related issue, every task sub-session — calls that MCP through its session toolset, which is a different… |
| #594 | No sweep reads a catch-up doc's body, so a figure in the primary surface can go stale unflagged (measured: 5 stale coverage figures in the #468 doc, understating the rollout by 13 and overstating the remainder 2x) | `doc-claim-consistency-sweep.mjs` reads only local journal files; the catch-up docs are Google Docs and are not on that path, so no sweep has ever read one's body even though its own comment claims full scope. |
| #593 | scan publishes doc_new_comments without the freshness of the read behind it, so a channel never observed and a channel observed-and-empty are the same `0` on the worklist | `scan` carries `doc_new_comments` but not the freshness of the read that produced it, so "observed 30 seconds ago, genuinely empty", "last observed 5 days ago, 3 comments since", and "never observed" are all byte-identical `0` on the one worklist a run reads. |
| #588 | Telegram posts the catch-up doc link when the doc is bound, not when it is written, so 4 of 5 links in one run pointed at unwritten placeholders | `ensure-catchup-doc` binds a placeholder and the body is written only on the task's first wake afterward, but the bridge posted the link on binding — so a task bound during a run got its link pushed in that same run, before any wake could have written it. The write-based gate (`docHasBeenWritten`, refs GH 592) has since landed; this issue tracks its confirmation. |
| #541 | A blocked task holds the only capacity slot: Test-SessionHoldsCapacity excludes done/skip but not blocked, so recording a user pause costs the run its dispatch slot (measured: 6 eligible, admits 0) | Test-SessionHoldsCapacity treats only done/skip as work that holds no capacity. blocked falls through and keeps its session counted as work in flight — so a task that is waiting on Shiv, and provably cannot progress by… |
| #526 | Deterministic "blocked on human" flag + last-evaluated timestamp, readable by the planner UI | Today there is no way to look at the planner UI and see which tasks are waiting on me. The information exists, but only inside the agent's own local state store, in a form only the… |
| #522 | Observing a doc-bound task's comments erases it from the capacity count: the run dispatches an item and admits stays 1, so related issue's fix opens the over-dispatch direction it warns about | session -InFlight reports in_flight: 0, admits: 1 while task related issue holds a live, just-woken, unreleased session that a session was actively working. |
| #519 | PHASE 0 syncs two deploy targets but not the checkout PHASE 3 executes from: verified-current True while the live bridge was 5 commits behind and missing the fix that merged that night | PHASE 0's auto-deploy-plugin.ps1 closes "merged != running" for two targets — installed-plugins and the OA home — and reports verified-current True. It closes it for neither of them by updating a working tree: it fetches origin/main… |
| #518 | Turns can ask for an approval word the gate has already granted: a valid, well-formed, unnecessary ask that related issue cannot catch | A turn can ask for an approval word for an action the gate has already granted. The word is valid, the reader accepts it, and it still should never have been asked for — because consent… |
| #515 | Resolving a blocking ask strands its Telegram notice: the message keeps the last ask forever and its id is forgotten | Resolving a blocking ask clears docLinkNoticeHash and docLinkNoticeMessageId, but never touches the message itself. The notice stays on the user's phone showing the last ask it ever carried, and the bridge has forgotten its id, so… |
| #505 | Run-session issue comments are unmarked, so every later pass duplicates instead of editing (and stamping the stranded one makes it worse) | The run session posts issue comments ad hoc via gh api and does not pass them through stampIssueComment() from lib-issue-comments.mjs. Task sub-sessions already stamp theirs. So every run-session comment lands unmarked. |
| #500 | A doc-bound task waiting on doc comments holds the only capacity slot: related issue makes its ask dismissive by design, so it reads as workable | The 2026-09-04 14:31 PT run could dispatch nothing. Not because the board was empty — 12 rows were eligible — but because the single capacity slot was held by a task that cannot progress without a… |
| #499 | doc-claim-consistency-sweep flags append-only journal history it can never fix - first run pins a permanent finding | doc-claim-consistency-sweep shipped and deployed tonight (2026-09-04). On its first live run it returned exactly one finding, and that finding is unfixable by construction — it sits in immutable, superseded journal history. Left as-is, this sweep reports… |
| #495 | Brief assembly reads 'no open PR' as 'unstarted', but the operating contract makes 'shipped, awaiting review' look identical: 5 of 6 issues briefed wrong in one wake | The run session assembles a sub-session brief by asking which issues are unstarted, and answers it with gh pr list --state open. Absence of an open PR is read as "nobody has started this." Under the… |
| #494 | oa-state doc: journal_stamp_id is always null, so a journal stamped with a DIFFERENT doc than state is indistinguishable from one that agrees | oa-state doc reports journal_stamp_id: null on every task, including ones whose journal carries a real docId — so a journal stamped with a different doc than state holds is indistinguishable from one that agrees. |
| #492 | An agent-authored doc asserted a number its own table contradicted, and every guard passed: shape is checked, internal consistency is not | During tonight's run, a task sub-session appended an appendix to the task 228 catch-up doc. The appendix recommended a routing and described its cost as: |
| #483 | Link mode never tidies the turn messages posted before binding: the collapse only runs on the turn path it replaced | Found while answering a doc comment on task 468. Shiv, on the catch-up doc: |
| #477 | G12 enforces one turn per wake but not WHICH author: the run session wrote first and the guard then locked out the owner | G12 (shipped tonight in PR related issue / PR related issue) enforces at most one turn per wake. It does not enforce which author writes it — and on the very first wake after it shipped… |
| #476 | Zero writers, one journal: the related issue fix assigns sole authorship to the sub-session but nothing detects when it writes nothing - two PRs merged, no turn, no doc | Tonight's run is the first under the related issue contract (shipped in PR related issue / related issue), and it ended with two merged reliability PRs and no journal turn from the session the contract names… |
| #473 | Two writers, one journal: the run session and the task sub-session each append a turn for the same wake, and their doc edits race | On tonight's run, task related issue received two agent turns for a single wake, four minutes apart, both describing the same merged PR — and they disagreed with each other. |
| #471 | The run summary asserts repository state it never queried: two false claims in one run, both caught only by a sub-session | During the 2026-09-04 02:00 PT overnight run, the run session's own summary asserted repository state twice without querying it. Both claims were false. Both were caught by a sub-session, not by any mechanical check. |
| #468 | A capability probe spawns a fresh server, so it cannot see the session's own dead connection - green probe, dead doc channel (measured) | Every capability probe in check-agent-inbox.ps1 that uses mcp-probe.mjs answers "can a server be started?", never "is the connection my session is actually using still alive?" For the email row that distinction does not matter. For the… |
| #459 | run-capabilities.json does not declare the Google Workspace server, so the catch-up doc channel - the primary one - has no health probe | run-capabilities.json declares the MCP capabilities a run depends on so they can be probed in PHASE 0 (related issue). It currently declares three: email, telegram, browser-slot. |
| #442 | Design a way to approve in a Google Doc comment: attribution must be positive, not inferred from the absence of an agent marker | related issue shipped comment attribution and deliberately stopped short of consent. The reason is not a missing feature — it is that the agent posts to the doc through Shiv's own Google identity, so the API… |
| #441 | Catch-up doc creation should be a plugin skill encoding Shiv's doc preferences (no-context reader, no correction narration, collapsible sections, every ID a titled link) | Catch-up doc conventions are currently spread across SKILL.md prose, the catchup-doc skill, and the gh-issue-work operating contract in the task-463 journal. That means they are re-derived per run and drift, and there is no single artifact… |

### Dispatch, consent, and prioritisation semantics

These issues cluster around whether the scheduler is allowed to work a task, whether a reply or approval is still valid, and whether the Today gate is released on real evidence.

> [!NOTE]
> **Technical detail: concrete reference.** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

| Issue | Title | Gap / direction from issue text |
| --- | --- | --- |
| #607 | A session that correctly does nothing is recorded as unwakeable: task related issue burned 3 sessions, and both replacements cite a could not be woken that the event log disproves (3.4s and 9s wake latency) | The per-task session liveness verdict is wrong in a specific, repeatable way: a sub-session that wakes promptly and correctly decides there is nothing to do is recorded as `-SessionDead` and replaced. The event log shows the session waking in 3.4s and 9s respectively — well within budget — so the replacement's stated reason, "could not be woken", is disproved by the very log the verdict is supposed to be reading. |
| #600 | A forgotten `mark` makes the turn boundary EOF, so a raw reply below it is never seen (measured: reopened=false, trailing empty) | A wake that writes a turn but skips `oa-state.ps1 mark` leaves the journal with a provenance marker and no `<!-- /overnight-agent turn-end -->` terminator. In that state `Get-AgentEndIndex` treats end-of-file as the boundary, so a user's raw reply appended below the missing terminator sits after the implicit end and is never read as a reopen — measured as `reopened=false` with the reply present but reported as trailing-empty content. |
| #569 | A user message above the sentinel is invisible to reopened: scan and extract disagree on the same file, and the related issue Today row sat not_workable with a same-day request in it | scan's reopen reader only looks below the stamp. But the Focus Planner app does not always append the user's message there — when he edits the task's own notes, his message lands above the sentinel, in… |
| #568 | check-agent-inbox.ps1: 42s probe budget too short for MCP cold start, producing false NOT CHECKED | check-agent-inbox.ps1 uses a 45s-per-call budget (42s observed in the probe). On this machine that is too short for MCP cold start, so a perfectly healthy inbox is reported as NOT CHECKED — the exact "fail closed… |
| #567 | oa-state.ps1: CWD-relative settings candidate lets the bundled template override real user-settings.md | Get-UserSettingsPath in oa-state.ps1 includes a CWD-relative candidate. Because SKILL.md's own documented invocation style is <skill>\oa-state.ps1, any run that cds into the skill directory first resolves settings to the bundled template — the very file the function's… |
| #558 | Retire repair-board-307: it reports phantom damage on a board the reader parses correctly | The related issue board-repair tooling (scripts/repair-board-307.mjs + src/boardRepair.js) reports the live board as damaged when the app reads every one of those rows correctly. Its output has now caused at least two overnight-agent turns on related… |
| #556 | A reused task ID makes a LIVE task read user_completed: true, arming permanent reply-suppression (measured on related issue, a hit-and-run report) | Found by board-integrity during the 2026-09-06 07:01 PT overnight run. |
| #554 | collect-google-tasks.ps1 calls a tool that does not exist - the collector has never once succeeded | collect-google-tasks.ps1 (shipped in PR related issue, merged 2026-09-06 as the fix for related issue) fails 100% of the time on its first and every real execution. It calls list_task_lists, and the google-workspace MCP does not expose… |
| #551 | split-user-settings.ps1 backs up on every write and never prunes: 26 files / 5.8 MB in 14 days, in the OneDrive-synced planner folder | split-user-settings.ps1 backs up user-settings.md before every write (guarantee g2), but nothing ever prunes those backups. They accumulate forever inside the OneDrive-synced planner data folder. |
| #547 | A folder session's workspace IS the planner data folder, so Playwright MCP wrote 760 KB of debris into OneDrive beside planner.md (4 of 4 folder sessions affected; happened 4.2h after related issue filed the prose rule) | C:\Users\shiv\OneDrive\Apps\Focus Planner\ is the planner's own data store. On 2026-09-05 an agent session wrote 760 KB of Playwright MCP debris into it as .playwright-mcp\, where it is now syncing to OneDrive and to every device, sitting… |
| #545 | scan emits the raw unanswered_user while every gate uses the closed-filtered one, so 3 closed tasks raise an ask no run is permitted to clear | scan emits the raw unanswered_user, but every internal reader uses the closed-gated Test-UnansweredUser. So the one field the run reports to Shiv disagrees with the one the run acts on — and it disagrees in the… |
| #543 | last_turn_at is stamped by any status-only mark, so "a turn was written here" is satisfiable without writing one - it defers the stale-turn backstop and passes -Exhausted's "must follow real work" check | Cmd-Mark stamps last_turn_at on any -Status call, whether or not a turn was written. So a status-only mark — which by design does not touch the journal — records that a turn happened at that moment. |
| #540 | A user pausing a sub-session is invisible to PHASE 1: session -Id returns reuse/live and the next run wakes it straight back up (measured on related issue) | PHASE 1 dispatches an approved/in-progress task to its bound sub-session on the strength of oa-state.ps1 session -Id <ID> alone. That command answers "does a live session exist?" — it does not answer "is that session allowed… |
| #539 | create_issue gates on the CALLING project's GitHub link and ignores repo_full_name, so folder/local-only workspaces silently lose an explicit 'file an issue' instruction | While executing planner task related issue on 2026-09-05, an overnight-agent sub-session was told to file a GitHub issue (a workspace-discipline rule Shiv had explicitly asked for). It called the harness create_issue tool with repo_full_name: shivbijlani/focus-planner and… |
| #538 | Agent must not create side-project working files inside the Focus Planner data folder | The agent is treating C:\Users\shiv\OneDrive\Apps\Focus Planner\ as general scratch space and creating side-project working files there. It is not scratch space — it is the planner's own data store: the board (planner.md, planner-completed.md), the journals (journal\task-*.md)… |
| #534 | oa-state scan is journal-driven, so a board row with no journal file is invisible to the entire run - Today row 1 (related issue) was silently unworkable | oa-state.ps1 scan is the run's worklist — SKILL.md says "Run this first, every run" and "Work the rows in the order scan gives you". A board row that has no journal file yet produces no scan… |
| #527 | No deterministic "blocked on human" flag or last-evaluated timestamp: 164 of 244 tasks are parked on Shiv and nothing tells him which | Two thirds of the board is waiting on him, and there is nowhere he can look to find out which two thirds. The Telegram approval digest is the closest thing and is deliberately scoped — an… |
| #524 | PHASE 2's Google Tasks collect reads a truncated page as the whole backlog: 9 open vs the true 35, and the under-read is indistinguishable from a burn-down | The 2026-09-05 08:15 PT run did the weekly related issue poll (SKILL.md PHASE 2 step 2 — "collect open Google Tasks as extra planner candidates") and read 9 open tasks. |
| #520 | A guard that cannot run returns the same value as a guard with nothing to do: three instances of one shape (related issue, related issue, DISMISSIVE_ASK_RE) | Three separate defects this repo has already hit share one shape: a check that cannot do its job returns the same value as a check that had nothing to do. Each was fixed at its own… |
| #516 | Exhaustion has one word for two states: "queue drained" and "clock ran out" both release the Today gate, but only one is a fact about the row | -Exhausted is the only vocabulary for two different true states — the queue is drained and the clock ran out — and both release the Today gate. The second is a fact about the run, not… |
| #514 | G12 trusts a field the agent writes: stamping last_woken_at retroactively bypasses the one-turn-per-wake guard | write-turn.ps1 G12 enforces "at most one turn per wake" by comparing the newest backup stamp against session.last_woken_at in the task's state file. But last_woken_at is a field the agent writes, and G12 trusts it unconditionally —… |
| #513 | An ask can instruct a gate edit that cannot work: the floor is unscopable, so no allow rule can ever create an exception | An ask can tell Shiv to make an agent-gate.md edit that provably cannot unblock the action, and nothing detects it. The floor (Always ask) is matched by action kind, outranks the allow list, and has no… |
| #511 | merge <n> is command-shaped but the number is never checked: one approval authorises any PR, and merge 70 and 72 silently drops 72 | merge <PR number> was introduced by related issue to be command-shaped: a bare merge runs through agent narration constantly, so a number was required to make the phrase impossible to self-author. That purpose is served. |
| #506 | Changing a poll/recheck cadence resets next_due to now, so 'run less often' makes a blocked task run sooner and eat the only slot | Changing a poll or recheck cadence resets next_due to now, so the one-call form of "run this task less often" makes it run sooner. Measured live tonight, on the task where it did real harm. |
| #491 | Turns can advertise a reply word the consent reader rejects: the vocab guard pins SKILL.md, not the asks we actually send | A journal turn can advertise any reply word it likes. The consent reader accepts a fixed list. Nothing checks that the word we advertise is a word the reader accepts, so an ask can be born… |
| #487 | A task parked awaiting a reply holds a capacity slot forever: in_flight counts sessions that cannot be worked, so admits stays 0 and dispatch deadlocks | The run session could not dispatch any work at all: |
| #485 | Sweeps measure the working checkout, which nothing pulls - so a stale tree yields a confident, wrong verdict (measured: FLAGGED 9 commits when the truth was 0) | Sweeps that read the repository read the working checkout at V:\repos\focus-planner. Nothing in a run ever pulls it. PHASE 0's auto-deploy-plugin.ps1 fetches origin and deploys from origin/main, so deploys are correct — but every sweep that… |
| #480 | A wedged copilot.exe leaks a session lock, so an abandoned session reads alive forever - the liveness signal two sweeps depend on | While verifying the related issue detector (PR related issue) against a copy of the live state store, the replayed incident came back labelled WAKE_UNSERVICED when the evidence said ZERO_WRITER. The detector was right and the machine… |
| #465 | Consent is replayable: an affirmative is never spent, and whether it is depends on a marker the agent writes about itself | oa-state.ps1 consent has no notion of an affirmative being spent. An approve stays live in the trailing region indefinitely, so a run today can be authorised by an approval the agent itself answered a week ago. |
| #419 | auto-deploy resolves ref-history-index.mjs from the working tree, so it dies when the checkout is behind origin/main | After PR related issue (merged as b46edfd), auto-deploy-plugin.ps1 resolves its new history helper from the repository working tree: |
| #414 | Agent sessions run a git that deletes through junctions: the Copilot-bundled git 2.53.0 shadows the system git 2.54.0 on PATH | Agent sessions on this machine run a git that deletes through a junction, while the system git installed on the same box does not. Nobody upgraded anything wrong: the Copilot-CLI-bundled git shadows the system git on… |
| #413 | auto-deploy exits 2 with "DRIFT SURVIVED THE DEPLOY" against a byte-identical tree: the merged-but-dead guard cries wolf | auto-deploy-plugin.ps1 finished tonight's PHASE 0 with exit code 2 and this banner: |
| #412 | PHASE 0's auto-deploy never finishes: 211 sequential git rev-list walks (~40 min), so "merged" still does not mean "running" | PHASE 0's auto-deploy-plugin.ps1 step - the step that exists to make "merged" mean "running" (related issue) - never completes. It is not hung and it does not crash; it is doing ~211 sequential git rev-list history… |
| #408 | extract reports 'linked: (none)' for a task whose board row HAS a Linked ID - the upstream walk silently never happens | oa-state.ps1 extract reports linked: (none) for a task whose board row carries a Linked ID. The parent exists, the board records it, and the extract denies it — so the agent skips the upstream walk that… |
| #406 | spec verify is red on main: 5 stale Roadmap refs (issues closed today) + the new task-paper domain has no spec page | node scripts/spec/verify.mjs --facts spec-facts.json --dir docs/spec fails on clean main as of 2026-09-02. Reproduced against origin/main at 02d2243 with no local changes: |
| #405 | Collect phase performs work instead of handing off, and the precedence of a collect-phase wake over priority order is unwritten | The run has a collect step (PHASE 0: agent inbox, Telegram sync-down, oa-state.ps1 scan) and an execute step (PHASE 1/2). Nothing separates them: the moment collect surfaces something, the run acts on it, in the run… |
| #403 | Supervisor reports HEALTHY while the machine is unusable: it detects a stalled schedule, not a resource leak (ghcp WebView2 burned 7 CPU-hours in 14.7h) | Shiv asked, during a live sluggishness investigation on 2026-09-02: "isn't there a gh issue around creating an out-of-process scheduled script that detects leaks with ghcp and restarts it". |
| #402 | Agent accumulates 81 worktrees / 185 branches without pruning: it is the growing input behind related issue, and it leaks unreaped git fsmonitor--daemon processes | Measured on 2026-09-02 ~11:00 PT while diagnosing a live complaint that the machine was sluggish. The box (shiv-devbox, 4 logical cores, 16 GB) sat at 100% CPU with a processor queue length of 21 — roughly… |
| #398 | installed-skill-drift-sweep.mjs costs 429s and runs twice per deploy: it asks 209 files x 287 refs (59,983 queries) when a no-drift tree needs 209 | Measured on 2026-09-02 while fixing related issue. That fix removed the per-file process spawning in sync-oa-home.ps1 (79.2 s -> 3.9 s), but the end-to-end deploy is still ~11.7 minutes, and essentially all of the remainder is… |
| #345 | ghcp desktop app went unresponsive (blank UI) from unbounded leaked copilot.exe session hosts - add a preflight resource check before spawning new sessions/tasks | The check should look at free RAM, CPU load, and/or count of existing live session-host processes, and if a configurable safety threshold is breached: - Refuse or defer spawning the new session (fail closed, with a… |

</details>

### Triage vs. already-shipped work

`gh issue list --state open` cannot distinguish "filed and unworked" from "shipped, awaiting his review": a shipped PR does not close its issue in this repo (Shiv closes it himself after reading the catch-up doc), so both states render identically as `OPEN`. #630 measured the cost of that ambiguity at the point of consumption — three run sessions recommended already-shipped work twelve times across 2026-09-07/08 — and #635 (implemented by `issue-shipped.mjs` and write-turn.ps1's G15 gate) moved the check from an after-the-fact census into the triage decision itself, so a run refuses to recommend an issue whose fix already cites it in shipped source. Both #630 and #635 stay open under this repo's own rule even though their fixes have shipped: closing them is Shiv's decision, not the commit's, which is the exact phenomenon the issues describe. #632 remains a live gap: the census sweep (`shipped-but-open-sweep.mjs`) is registered to run from the planner data folder, which is not a git checkout, so in its scheduled home it classifies nothing every time and still reports `ok, findings 0` — a silent-pass shape the suite has hit before (#520).

> [!NOTE]
> **Technical detail: concrete reference.** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

| Issue | Title | Gap / direction from issue text |
| --- | --- | --- |
| #630 | `OPEN` spans shipped-awaiting-review and filed-and-unworked, and the tracker renders them identically | `gh issue list --state open` renders "pick this up" and "do not pick this up" identically. Twelve already-shipped recommendations were made before the classification (`issue-shipped.mjs`) existed. |
| #632 | shipped-but-open-sweep is inert in the suite that runs it | The sweep wrapper's `cwd` is the planner data folder, not a git checkout, so the census classifies 0 of 169 issues in its scheduled home and still reports `ok, findings 0`. |
| #635 | Triage consults the shipped check before recommending work, not after | The census (#630) ran after the fact into a suite log; nothing consulted it at the moment a run decides what to hand a sub-session. Fixed by making `issue-shipped.mjs` a preflight check that write-turn.ps1's G15 enforces on every journal turn. |
| #639 | issue-shipped.mjs reports historical mentions as shipped work, failing in the dangerous direction | The classifier cannot tell "this code fixes #N" from "this code mentions #N as a historical note" in comments, and both are common here — measured live triaging task #468, where #442 and #433 were both misread as SHIPPED. |

</details>

### Deploy propagation, checkout drift, and collection sweeps

These issues say “merged” is not yet a sufficient proxy for “running” or “measured correctly” because deploy, checkout, and sweep machinery can drift apart.

| Issue | Title | Gap / direction from issue text |
| --- | --- | --- |
| #418 | auto-deploy still exceeds its 60s budget on the live repo after related issue, so PHASE 0 ends in exit 2 every run | PR related issue (merged as b46edfd) bounded the auto-deploy's history work and added a wall-clock budget. On the live repository the classification still does not fit inside that budget, so PHASE 0's deploy step ends in… |
| #575 | deploy-installed-plugin REFUSE is ancestry-blind: a just-merged file reads as a "live fix" that deploying "would REVERT", and the message asserts the opposite of the truth | `deploy-installed-plugin.ps1` refuses to deploy a file when the installed bytes match some git ref other than `origin/main`, printing "live fix is not on origin/main — deploying would REVERT it" — on a normal merge the installed copy is the pre-merge content and deploying would advance it, not revert it, because the classifier compares content identity against a ref set and never asks which side is newer. |
| #622 | The telegram-bridge checkout is on no deploy manifest: merged bridge code can stay inert while both deploy checks report clean | `auto-deploy-plugin.ps1` syncs the plugin tree and the OA home, but the telegram-bridge package is invoked from the main checkout by PHASE 3 — neither deploy target covers it, so a merged bridge fix can sit unshipped with both deploy checks reporting clean. |

### Planner app UI and data integrity

These issues describe defects in the planner web app itself — the board rendering and interaction
surface a user drives directly, as opposed to the overnight agent's own machinery.

| Issue | Title | Gap / direction from issue text |
| --- | --- | --- |
| #641 | Journal entries written by an agent through the UI composer are stamped `<!-- from: me -->`, so agent prose is indistinguishable from Shiv's own words | An agent driving plannermd.com writes journal entries through the same "Message yourself…" composer a human uses, and the app stamps every entry from that composer as `<!-- from: me -->` — which means the human — so agent-authored prose in the consent channel is indistinguishable from Shiv's own. |
| #640 | Task actions sheet renders below the fold on a narrow viewport: Create Journal sits 226px off-screen and is the only way to start a new task's journal | Opening the row kebab (⋯) → Task actions action sheet on a task low in the Deferred list renders the sheet below the fold on a narrow/mobile-width viewport; the sheet is a fixed overlay, so scrolling the board behind it never brings the buttons into view. |
| #587 | Row kebab and its action sheet are both named just "Task actions" - a Delete/Complete menu that never says which task it will act on | Found while dogfooding the Planner UI on plannermd.com for board task 400. Every row's kebab (`⋯`) and the action sheet it opens are labelled with the same constant string, "Task actions"; neither the button's accessible name nor the open sheet says which task it is. |
| #577 | Tasks created in the Pacific evening are stamped with tomorrow's UTC date and render an age of `-1d` | Tasks created through plannermd.com at ~23:00 PT land in `planner.md` stamped with the following day's date because the `Added` column is written in UTC, so the board then renders their age as `-1d` until the Pacific date catches up. |

### Session, workspace, and runtime hygiene

These issues focus on leaked sessions, polluted workspaces, stale locks, backup growth, and runtime/tooling behaviours that distort the planner’s operating environment.

| Issue | Title | Gap / direction from issue text |
| --- | --- | --- |
| #617 | Deploy backups are never pruned: 898 directories in 13 days (~69/day) under %LOCALAPPDATA%\overnight-agent\backups | `auto-deploy-plugin.ps1` and `sync-oa-home.ps1` write a timestamped backup directory under `%LOCALAPPDATA%\overnight-agent\backups\` every time they deploy a file, and nothing ever prunes them — measured at 898 directories accumulated in 13 days, roughly 69 per day. |
| #613 | PHASE 3 dies with an unwrapped "One or more errors occurred." when the box is at its commit limit: the token fetch Add-Type fails, is retryable, and the message names nothing | PHASE 3 (the Telegram mirror) failed with an error that names nothing actionable — `One or more errors occurred. MIRROR_EXIT=1` — while the machine was at its virtual-memory commit limit. The underlying cause is a token-fetch `Add-Type` call that throws a generic aggregate exception under memory pressure; the failure is retryable, but the message gives an operator nothing to act on. |
| #481 | session-state is never pruned: 4,109 directories / 2.6 GB since April, and 488 stale locks sit in the path two liveness sweeps read | Measured 2026-09-04 ~06:33 PT from the overnight run, while verifying that the new zero-writer-sweep (related issue, shipped tonight as related issue) reads the right session id. It does -- but the directory it reads has never… |
| #462 | Both new write-guards ship with caller-facing traps that fail toward the outcome they prevent: undefaulted writeFile, and a verdict object that duck-types into a duplicate post | Both safety contracts shipped tonight — lib-issue-body.mjs (issue related issue / PR related issue) and lib-issue-comments.mjs (issue related issue / PR related issue) — are correct, and both have caller-facing shapes that fail toward the exact… |
| #456 | gh issue edit --body is an unguarded overwrite, and issue bodies carry no authorship - so "was my work overwritten?" cannot be answered either way | Editing an issue body with gh issue edit --body / --body-file is an unconditional whole-document overwrite. There is no base revision, no precondition, and no conflict detection. |

