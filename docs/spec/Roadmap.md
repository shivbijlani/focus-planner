# Roadmap

131 issues are open. This page groups them by their `priority:` label (7 critical, 15 high, 16
medium, 14 low) and, for the 79 issues carrying no priority label, by theme. All numbers below are
open issues; closed issues and merged PRs are never cited here (see
[Updating-the-Spec](Updating-the-Spec) §Issue references).

## Critical

| # | Gap |
| --- | --- |
| #501 | Agent-declared "done" confers user-closed semantics — a Today row swallowed 3 user messages and released the Today gate. |
| #422 | Google Doc comments have no author attribution: the agent's own replies come back as the human, so comments cannot be an instruction/consent channel. |
| #261 | A stuck "running" Overnight Agent run freezes the `*/30` schedule — no run-level timeout to fail and reschedule. |
| #197 | The browser watchdog can recover a missing slot but not a STUCK one (TCP-accept is treated as health). |
| #180 | Browser slots: move the slot table into `user-settings.md`, default to 3, launch a closed profile on demand. |
| #179 | ~120 tool schemas are advertised per turn, most duplicating unused browser slots or an unused integration. |
| #139 | Playwright MCP CDP attach times out when the signed-in browser is overloaded. |

## High

| # | Gap |
| --- | --- |
| #549 | `Get-Content -Raw` silently double-encodes UTF-8, corrupting catch-up docs — a third, currently unguarded corruption class. |
| #424 | Telegram posts the catch-up doc link repeatedly instead of once — 21 of 28 turns on one task exceed the message-length limit. |
| #423 | No durable task-to-doc binding: the catch-up doc is found by title search, so a rename creates a duplicate. |
| #421 | Direction: one catch-up Google Doc per task, the doc as the agent's output surface and its comments as the reply channel. |
| #404 | No per-task session/workspace isolation, no persisted session id — work happens in the shared run session. |
| #346 | PHASE 0's mandated inbox check silently no-ops when the email MCP fails its handshake; a missing tool reads as an empty inbox. |
| #321 | `git worktree remove --force` deletes through a `node_modules` junction, emptying the shared install for every checkout. |
| #318 | Guards were green against a shape the app never wrote — fixtures named for a producer are not actually pinned to it. |
| #312 | A planner client can hold a board 2 revisions stale and still enter "Backing up..." — possible mechanism behind a prior stale-sync-status defect. |
| #304 | The consent reader rejects approval words the user-facing explainers advertise — 3 of 4 live asks were dead. |
| #302 | A `gate-allowed` verdict bypasses the journal, so an agent can merge over a fresh human "don't" — the guard is prose only. |
| #291 | Task journals sit on the per-run read path and grow unbounded — one reached 257 KB (~66K tokens). |
| #243 | The browser watchdog has no plugin-update check; the plugin's own self-heal is circular. |
| #181 | A green CI check must mean all tests ran and passed — 25 of 30 open PRs showed a clean badge with zero checks. |
| #170 | The Overnight Agent writes turns into tasks that are already closed. |

## Medium

| # | Gap |
| --- | --- |
| #496 | Per-task session titles lose the planner task id, so worked tasks look undiscoverable. |
| #383 | Agent-opened browser tabs have no owner; leftover tabs accumulate and cleanup is unsafe by construction. |
| #381 | `mutcheck-browser-slots` arm E is non-hermetic — it probes live debug ports, so the suite is red on `main` whenever a browser is open. |
| #330 | The exhaustion TTL does two jobs at once (fail-closed expiry vs. fail-open cross-run risk) and cannot be tuned for one without the other. |
| #328 | A bare `#NNN` is ambiguous — 24% of GitHub numbers already collide with a live planner task id. |
| #326 | "`oa-state.ps1` never writes `agent-gate.md`" is load-bearing for consent but is asserted only in a comment. |
| #322 | The Today gate's release is still agent-authored: verify exhaustion against the drained queue rather than the run's own word. |
| #285 | On plugin update, tell the user what actually changed for them, not a list of bug numbers. |
| #275 | Mobile: the link/linked-ID UI looks broken on phone (desktop is fine). |
| #250 | Consent still rests on a marker the agent's own software writes (follow-up to a prior fix). |
| #184 | Recurring items: self check-off plus agent-run activity visibility. |
| #176 | Consolidate all planner + Overnight Agent development into one board task and one issue trail. |
| #132 | Task ids can be reused after completion because the completed board is outside the allocation universe. |
| #127 | Split `SKILL.md`'s guardrails/reference prose into referenced static partial files. |
| #124 | Offload Overnight Agent business logic to a script; keep `SKILL.md` a thin wrapper. |
| #123 | Journal `.md` store vs. Telegram: define the source of truth and bound completed-journal growth. |

## Low

| # | Gap |
| --- | --- |
| #327 | Guard-authoring conventions have no home — three "this should be a convention" notes are stranded on three separate issues. |
| #207 | Remove backward-compatibility artifacts — single-user install, no legacy support needed. |
| #104 | Overnight agent: final-phase post-mortem plus dream-mode memory. |
| #88 | First-run experience: interactive, lesson-tracked onboarding tutorial. |
| #85, #77, #71, #61, #56 | Five open issues covering the same feature — event-driven journal read/unread indicator with a localStorage provider — filed separately; see [Domain-app](Domain-app) §readState for the shipped design these describe. |
| #21 | Rebrand: rename the Azure AD app and Google OAuth consent screen to "Planner". |
| #18 | Local-first storage with background cloud sync via a service worker. |
| #12 | Move tasks between sources via right-click. |
| #8 | Remove multi-source backward-compatibility code (legacy provider, unsuffixed handle, migration path). |
| #5 | Connect a personal OneDrive folder and prepare for a combined task view. |

## Unprioritised (no `priority:` label) — grouped by theme

These 79 issues are mostly findings from the overnight agent's own sweeps (`board-integrity`,
`repo-drift-sweep`, mutcheck suites) filed faster than they are triaged into a priority band.

**Capacity, gate and consent correctness** (the recurring "agent authors its own signal" class —
see [Prioritisation](Prioritisation) §5): #556, #545, #543, #541, #540, #534, #532, #531, #528,
#527, #526, #524, #522, #520, #519, #518, #516, #515, #514, #513, #511, #506, #500, #495, #494,
#492, #491, #487, #483, #477, #476, #473, #471, #468, #465, #442, #441, #436, #433, #428, #408,
#405, #391, #354, #343.

**Deploy propagation and drift** ("merged isn't running", see [Reliability](Reliability)): #554,
#551, #533, #519, #419, #418, #414, #413, #412, #402, #398, #345.

**Reliability infrastructure (sessions, locks, supervisor)**: #547, #481, #480, #462, #461, #459,
#457, #454, #453, #452, #403, #351, #337.

**Board/data integrity and Telegram**: #548, #538, #505, #499, #328 (also listed under Medium),
#302 (also listed under High).

**Process and spec-pipeline meta**: #539, #499, #456, #406, #354.

**Security**: #314 — real email, tenant domain and directory GUID committed in a config document.

## Reading this page going forward

Priority labels are applied by hand; the unprioritised bucket above is expected to shrink as issues
are triaged, not to be treated as low-value simply for lacking a label — several (#556, #528, #514)
describe active data-integrity defects. See [Reliability](Reliability) and
[Prioritisation](Prioritisation) for the mechanisms these issues describe gaps in.
