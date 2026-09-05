# Roadmap

This page groups every open issue by its priority label and states, for each, what is broken or
missing and the intended direction. Closed issues describe already-shipped fixes and are cited on other
pages as design rationale, not here — this page is restricted to what is still open.

## Priority: critical

| # | Gap | Direction |
| --- | --- | --- |
| #501 | An agent-declared `done` confers user-closed semantics: a Today row swallowed 3 user messages and released the Today gate anyway. | Tighten the gate verdict so an unanswered user message is checked before any exhaustion or status claim, regardless of who wrote the status (see [Prioritisation](Prioritisation)). |
| #422 | Google Doc comments carry no author attribution — the agent's own replies come back looking like Shiv's, so comments cannot safely be an instruction or consent channel. | Needs a positive attribution mechanism before doc comments can be trusted as consent (related: #442). |
| #261 | A stuck `running` Overnight Agent run can freeze the entire `*/30` schedule with no run-level timeout. | Addressed by `stuck-run-sweep.mjs`'s run-level-timeout arm (see [Reliability](Reliability)); this issue tracks hardening that mechanism further. |
| #197 | The watchdog treats a bare TCP accept as health, so it can confirm a slot is up while it is actually stuck. | `check-browser-slots.ps1`'s CDP-based wedged-slot probe (see [Reliability](Reliability)) is the fix in progress; this issue tracks full closure. |
| #180 | The browser slot list was hardcoded rather than configuration. | Move it into `user-settings.md`'s `## Browser slots` table (largely done — see [Reliability](Reliability) — issue tracks remaining defaults work). |
| #179 | ~120 tool schemas are advertised per turn, most duplicate browser slots or unused integrations. | Reduce the advertised surface to only what a given run actually needs. |
| #139 | Playwright MCP CDP attach can time out when the signed-in browser is overloaded. | Needs a bounded-retry or overload-aware attach strategy. |

## Priority: high

| # | Gap | Direction |
| --- | --- | --- |
| #424 | 21 of 28 turns on one task exceeded Telegram's 4096-char limit before the catch-up-doc fix. | Post the catch-up doc link once, then stay quiet, rather than re-posting a long turn every time. |
| #423 | The catch-up doc is found by title search with no durable id, so a rename can create a silent duplicate. | Bind the doc by durable id rather than title text. |
| #421 | No single agent-output surface exists per task; make one Google Doc per task the canonical output and reply channel. | Establishes the doc-per-task model #423/#424/#442 all build on. |
| #404 | The run session did every task's work itself, with no per-task session, workspace isolation, or persisted session id. | Landed in large part (see the `session` command family in [Prioritisation](Prioritisation)); issue remains open for residual isolation gaps. |
| #346 | PHASE 0's mandated inbox check can silently no-op when the email MCP fails its startup handshake — a missing tool reads identically to an empty inbox. | Require the check to report `NOT CHECKED` rather than a false "nothing new" when the capability itself is unavailable. |
| #321 | `git worktree remove --force` deletes through a `node_modules` junction, emptying the shared install for every checkout at once. | Guarded at the symptom by `scripts/check-node-modules.mjs` (see [Domain: scripts](Domain-scripts)); the underlying teardown hazard itself remains open. |
| #318 | Guards were green against a shape the app never actually writes — fixtures named for a producer were never pinned to it. | Requires fixtures to be generated from (or validated against) the real producer, not hand-authored to resemble it. |
| #312 | A planner client can hold a board two revisions stale and still enter "Backing up…" — a possible upstream mechanism for the class of orphaned-journal bug fixed by the now-closed issue 190. | Needs the sync client to detect and refuse to declare success against stale local state. |
| #304 | User-facing explainer text advertises approval words the consent reader itself rejects — measured: 3 of 4 live asks were effectively dead. | Align the consent vocabulary the UI teaches users with the vocabulary the reader actually accepts. |
| #302 | A `gate-allowed` verdict can bypass the journal entirely, letting an agent merge over a fresh human "don't" — the guard is prose-only today. | Make the gate check the journal directly rather than trusting an intermediate verdict object. |
| #291 | Task journals sit on the per-run read path and grow without bound — one measured at 257KB (~66K tokens). | Needs a size-budget or summarization strategy so journal growth doesn't degrade every future run's read cost. |
| #243 | The browser watchdog has no plugin-update check, making the plugin's own self-heal circular (it lives inside the agent it repairs). | Needs an update-check path that doesn't depend on the plugin already being current. |
| #181 | A green CI check must mean all tests ran and passed; measured 25 of 30 open PRs showed zero CI checks yet a clean badge. | Requires the badge to reflect an actual completed check run, not an absent one (related mechanism: `scripts/spec/verifyParity.mjs`, see [Domain: scripts](Domain-scripts)). |
| #170 | The Overnight Agent has written turns into tasks that are already closed. | Needs a guard preventing writes to a closed task outside of an explicit reopen. |

## Priority: medium

| # | Gap | Direction |
| --- | --- | --- |
| #496 | Per-task session titles lose the planner task id, so worked tasks look undiscoverable in the session list. | Include the task id in the session title. |
| #383 | Agent-opened browser tabs have no owner, so leftover tabs accumulate and cleanup is unsafe by construction. | Needs tab-level ownership tracking analogous to the MCP reaper's session-ownership model. |
| #381 | A mutcheck arm for browser slots is non-hermetic — it probes live debug ports, so the suite is red whenever a real browser is open. | Make the arm run against a fixture, not the live machine. |
| #330 | The exhaustion TTL is one parameter doing two jobs: it must expire mid-run (fail-closed) while not letting a raised value let one run declare exhaustion on another run's work (fail-open). | Split into two parameters, or otherwise decouple the two failure directions (see [Prioritisation](Prioritisation)). |
| #328 | A bare `#NNN` reference is ambiguous — 24% of GitHub issue numbers already collide with a live planner task id. | Needs a disambiguating prefix convention or context-sensitive resolution. |
| #326 | `oa-state.ps1` never writing `agent-gate.md` is load-bearing for the consent channel but is currently asserted only by a comment, not a test. | Add a `mutcheck`-style assertion of the one-way property (see [Prioritisation](Prioritisation)). |
| #322 | The Today gate's release still trusts the run's own word rather than verifying the exhaustion claim against the drained queue. | Cross-check the declared examined set against what was actually processed. |
| #285 | On a plugin update, tell the user what changed for them in plain language, not bug numbers. | Needs a user-facing changelog surface distinct from issue references. |
| #275 | The link/linked-ID UI looks broken on phone even though desktop renders correctly. | Needs a mobile-specific layout fix. |
| #250 | Consent still rests on a marker the agent's own software writes (a follow-up to the fix shipped in the now-closed issue 227). | Move toward a signal the agent genuinely cannot author (see the failure-class discussion in [Prioritisation](Prioritisation)). |
| #184 | Recurring daily items need self-check-off and agent-run activity visibility. | Needs a recurring-task model distinct from one-off board rows. |
| #176 | Planner-and-agent development discussion is scattered across many boards/issues rather than one trail. | Organizational consolidation, not a code change. |
| #132 | Task ids can be reused after completion because the completed board is not in the allocation universe. | Include completed-board ids in id-allocation to prevent collision. |
| #127 | `SKILL.md`'s guardrail/reference prose should be split into referenced static partial files. | Companion cleanup to #124. |
| #124 | Overnight Agent business logic should live in scripts, keeping `SKILL.md` a thin wrapper. | Structural refactor; much of the sort/gate/pacing logic already lives in `oa-state.ps1` per [Prioritisation](Prioritisation), but full extraction is incomplete. |
| #123 | Journal `.md` storage versus Telegram as source of truth, and unbounded completed-journal growth, need a resolution. | Needs an explicit source-of-truth and growth-bound decision. |

## Priority: low

| # | Gap | Direction |
| --- | --- | --- |
| #327 | Guard-authoring conventions ("this should be a convention") are stranded across three separate issues with no single home. | Consolidate into one documented convention. |
| #207 | Backward-compatibility artifacts (single-user install has no need for legacy support) should be removed. | Per hard rule, this spec deliberately does not document such paths as required behavior; this issue is the tracked removal (see also #8). |
| #104 | A final-phase post-mortem and "dream-mode" memory capability for the agent is proposed but unbuilt. | Open design work, no committed shape yet. |
| #88 | An interactive, lesson-tracked first-run onboarding tutorial is proposed. | Open design work. |
| #85, #77, #71, #61, #56 | Five overlapping issues describing the same event-driven journal read/unread indicator (UI fires events; localStorage as the first provider; explicitly deferred sync). | Should be consolidated into one issue; the feature itself is implemented in `src/readState/*` (see [Domain: app](Domain-app)) with sync intentionally out of scope for v1. |
| #21 | Rebrand: rename the Azure AD app and Google OAuth consent screen to "Planner." | Cosmetic/account-config change, not a code change. |
| #18 | Local-first storage with background cloud sync via a Service Worker. | Substantially delivered by `packages/folder-sync` (see [Domain: folder-sync](Domain-folder-sync)); issue may be stale. |
| #12 | Move tasks between sources via right-click. | UI affordance not yet built for the multi-source combined view. |
| #8 | Remove multi-source backward-compat code (`fp-storage-provider` legacy key, unsuffixed FSA handle, `migrateLegacy`). | Per hard rule, not documented here as required behavior; tracked removal alongside #207. |
| #5 | Connect a personal OneDrive folder and prepare for a combined task view. | Predecessor to the now-implemented multi-source model in `src/storage/sources.js`. |

## Unlabeled (no priority assigned)

The largest group (51 open issues) has no `priority:` label. Grouped by theme:

**Collect/dispatch precedence and capacity** — #506 (a cadence reset can make a *less* frequent poll fire *sooner*), #500 (a doc-bound wait holds the only capacity slot), #487 (a parked task counts against `in_flight`, deadlocking dispatch at `admits: 0`), #405 (collect performs work instead of handing off — see [Prioritisation](Prioritisation)), #477 (one-turn-per-wake is enforced but not *which* author writes it), #473/#476 (two writers can race on one journal, or neither writes at all).

**Consent and attribution provenance** — #505 (unmarked run-session issue comments get duplicated instead of edited), #491 (a turn can advertise a reply word the consent reader rejects), #465 (an affirmative consent is never "spent" — replayable), #462 (two new write-guards have caller-facing traps that fail toward the exact outcome they're meant to prevent), #453 (agentic issue comments carry no provenance marker, so an edit-in-place can overwrite a human comment), #456 (issue-body overwrites are unguarded and unattributed), #442 (need a positive, non-inferred attribution design for doc-comment approval).

**Deploy propagation and drift measurement** — #419 (auto-deploy resolves a helper from the working tree, so it breaks when the checkout is behind `origin/main`), #418/#412/#413 (auto-deploy's time budget, walk cost, and false-positive "drift survived" reporting all need further tightening beyond the fixes in [Reliability](Reliability)), #398 (the drift sweep's own query cost is quadratic in file×reference count), #485 (sweeps measure the working checkout, which nothing pulls, yielding a confident wrong verdict), #461 (the encoding sweep resolves its root to the main checkout, so running it from a worktree scans the wrong tree).

**Session/resource hygiene** — #481 (session-state directories are never pruned — 2.6GB since April), #480 (a wedged host process leaks a session lock that two liveness sweeps depend on), #452 (worktree teardown doesn't release its session binding), #402 (worktrees/branches accumulate without pruning and leak `git fsmonitor--daemon` processes), #414 (the Copilot-bundled git shadows the system git on PATH, silently invoking the version with the junction-deletion bug from #321), #345 (unbounded leaked host processes made the desktop app unresponsive; need a preflight resource check before spawning more).

**Doc-channel and MCP capability probing** — #502 (`-Observe` returns 0 for the MCP's own output shape, reading as "empty" incorrectly), #494/#436 (`oa-state`'s doc-binding fields are always null/false on a resolve, so a durable binding and an at-risk one are indistinguishable), #468 (a capability probe spawns a fresh server and so cannot see the session's own dead connection), #459 (Google Workspace isn't declared in `run-capabilities.json`, so the primary doc channel has no health probe), #433 (a nudge threshold fires on every real doc-bound turn measured so far — needs distribution data before re-tuning), #441 (catch-up doc creation should be a plugin skill encoding specific formatting preferences).

**Board/journal integrity** — #499 (a consistency sweep flags append-only journal history it can never fix, pinning a permanent false finding), #492 (an agent-authored doc asserted a number its own table contradicted, and every shape guard passed), #495 (brief assembly conflates "no open PR" with "unstarted," misreading "shipped, awaiting review"), #471 (a run summary asserted repository state it never actually queried), #457 (a session asserted a false negative about its own past actions after an id rollover), #428 (a merged PR's `Closes #N` auto-closes its issue, skipping the intended review step), #408 (an extraction reports "linked: none" for a row that has a Linked ID), #483 (link mode never tidies pre-binding turn messages), #343 (the agent's snooze reader never reads the `Wake` column, so a snoozed task can be worked early).

**Spec pipeline and misc** — #406 (spec verify was red on `main`: stale Roadmap refs plus an uncovered domain — the class of defect this very page and the Domain pages exist to prevent), #354 (the gaps-page staleness gate should be position-aware: an entry-position reference is the assertion, a prose reference is history), #391 (pacing encoding — see [Prioritisation](Prioritisation)), #351 (in-flight work is invisible to other sessions, causing duplicated fixes), #337 (a supervisor install/uninstall toggle in `user-settings.md` needs full reconciliation), #454 (`agent-lore.md` is 903KB, 160 headings, and has zero readers — a write-only memory file), #314 (a real email, tenant domain, and directory GUID are committed in `region-dropdown.md` — a security-labeled item needing redaction).
