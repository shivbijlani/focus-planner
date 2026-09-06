# Roadmap

This page groups every open issue by its priority label. It is deliberately a survey of gaps, not a
schedule — see [Updating-the-Spec](Updating-the-Spec) for why issue numbers here specifically must
resolve against **open** issues only, distinct from every other page.

## Critical

| # | Gap |
| --- | --- |
| #501 | An agent-declared `done` still confers user-closed semantics: a Today row swallowed three unanswered user messages and released the Today gate — the failure [Prioritisation](Prioritisation) §4 documents the fix for. |
| #422 | Google Doc comments carry no author attribution — the agent's own replies come back as the user, so comments cannot yet be a consent channel. |
| #261 | A stuck "running" overnight-agent run freezes the recurring schedule; no run-level timeout exists to fail and reschedule it — addressed in part by `stuck-run-sweep.mjs` (see [Reliability](Reliability)), but the underlying gap is still open. |
| #197 | The browser watchdog cannot recover a **stuck** slot, only a missing one — a bare TCP accept is treated as health, not a real page. |
| #180 | Browser slots are hardcoded rather than configurable in `user-settings.md`, with no default-3 profile scheme. |
| #179 | ~120 tool schemas are advertised per turn, most duplicating unused browser-slot or integration tooling. |
| #139 | The Playwright MCP's CDP attach times out when the signed-in browser is overloaded. |

## High

| # | Gap |
| --- | --- |
| #423 | No durable task-to-doc binding: the catch-up doc is found by title search, so a rename silently creates a duplicate and new comments go undetected — `oa-state.ps1 doc` (§ [Domain-overnight-agent](Domain-overnight-agent)) is the fix in progress. |
| #404 | The agent works tasks inside its own run session — no per-task session, no workspace isolation, no persisted session id. This is what `session -Id <ID>` (verdict `create`/`reuse`/`replace`) now exists to close (see [Prioritisation](Prioritisation) §7). |
| #405 | The collect phase performs work instead of handing off, and the precedence of a collect-phase wake over priority order was unwritten — this is the exact gap [Prioritisation](Prioritisation) §7 now specifies. |
| #346 | PHASE 0's mandated inbox check silently no-ops when the email MCP fails its startup handshake — a missing tool reads identically to an empty inbox. |
| #321 | `git worktree remove --force` deletes through a `node_modules` junction, emptying the shared install for every checkout — `scripts/check-node-modules.mjs` (see [Domain-scripts](Domain-scripts)) detects the symptom but the root cause is still open. |
| #312 | A planner client can hold a board two revisions stale and still enter "Backing up..." — a possible upstream mechanism for the unreachable-live-journal defect (closed issue 190). |
| #304 | The user-facing explainers advertise approval words the consent reader rejects: three of four live asks were dead on arrival. |
| #302 | A `gate-allowed` verdict bypasses the journal, so an agent can merge over a fresh human "don't" — the guard is prose only, not enforced code. |
| #291 | Task journals sit unbounded on the per-run read path — `task-400.md` reached 257 KB (~66K tokens) before this was noticed. |
| #170 | The overnight agent has written turns into tasks that are already closed. |
| #181 | A green CI check must mean all tests ran and passed; 25 of 30 open PRs showed zero CI checks yet a clean badge. |

## Medium

| # | Gap |
| --- | --- |
| #330 | The exhaustion TTL is one parameter doing two jobs — expiring mid-run (fail-closed) and, if raised, letting one run declare exhaustion on another run's work (fail-open). |
| #326 | `oa-state.ps1` never writing `agent-gate.md` is load-bearing for the consent channel but is stated only in a comment, asserted by no test. |
| #322 | The Today gate's release is still agent-authored in one respect: exhaustion should be verified against the drained queue itself, not taken on the run's word. |
| #250 | Consent still rests on a marker the agent's own software writes (a follow-up to the same class of bug as the earlier, now-closed consent-marker issue). |
| #132 | Task ids can be reused after completion, because the completed board is not part of the allocation universe. |
| #328 | A bare `#NNN` is ambiguous: roughly a quarter of GitHub issue numbers already collide with a live planner task id. |
| #381 | `mutcheck-browser-slots` arm E is non-hermetic — it probes live debug ports, so the suite reads red on `main` whenever a browser happens to be open. |
| #124 / #127 | Overnight-agent business logic should be offloaded out of `SKILL.md` prose into scripts and referenced static partials — the direction this repository has in fact been moving in. |

## Low

| # | Gap |
| --- | --- |
| #207 / #8 | Backward-compatibility artifacts (legacy multi-source shims, unsuffixed FSA handles, `migrateLegacy`) are scheduled for removal now that the system is single-user; this spec deliberately does not document them as required behaviour (see this page's own scope note in [Updating-the-Spec](Updating-the-Spec)). |
| #85 / #77 / #71 / #61 / #56 | Five issues converge on the same feature (event-driven journal read/unread state) — now shipped as `src/readState/readStateService.js` (see [Domain-app](Domain-app)); the issues remain open as historical record of the design's iterations. |
| #18 / #5 | Local-first storage with background cloud sync — the `folder-sync` domain — and multi-source OneDrive connection are both now shipped; kept open pending final acceptance. |
| #104 | A final-phase post-mortem / "dream-mode memory" for the overnight agent is proposed but not built. |
| #88 | An interactive, lesson-tracked first-run onboarding tutorial is proposed but not built. |

## Unlabeled — recent findings awaiting triage

The largest bucket (72 of 123 open issues) carries no `priority:` label yet — almost all are recent,
narrowly-scoped defect reports from the overnight agent's own operation, filed faster than they can be
triaged. Representative clusters:

- **Capacity accounting** — #487 (a task parked awaiting reply holds a capacity slot forever, so
  `admits` stays 0 and dispatch deadlocks), #500 and #522 (a doc-bound task's dismissive ask makes the
  same bug look workable, then observing its comments swings capacity the other way), #541 (a
  `blocked` task is excluded from neither `done` nor `skip`, so recording a human pause still costs the
  run its dispatch slot) — all instances of the same accounting gap [Prioritisation](Prioritisation)
  §4/§7 describes the intended fix for.
- **Doc-binding integrity** — #494 (`journal_stamp_id` always reads null), #436 (`journal_stamped`
  always reads false), #408 (`extract` reports "linked: none" for a row that has a `Linked ID`), #531
  (a document with genuinely zero comments is indistinguishable from a dead connection).
- **Provenance and authorship** — #465 (consent is replayable — an affirmative is never "spent"),
  #453 (agentic issue comments carry no provenance marker, so editing "the one agentic comment" can
  silently overwrite a human's), #477/#514 (G12's one-turn-per-wake guard checks *that* a turn was
  written, not *by whom*).
- **Deploy and process hygiene** — #412/#418/#419/#413 (auto-deploy's "merged isn't running" check
  exceeds its own time budget or resolves against a stale working tree — see [Reliability](Reliability)),
  #481 (`session-state` is never pruned — 4,109 directories / 2.6 GB accumulated since April), #402
  (81 worktrees / 185 branches accumulate unpruned, leaking `git fsmonitor--daemon` processes).
- **Board-adjacent correctness** — #343 (a task snoozed in the app can still be worked, because the
  agent's snooze reader never reads the `Wake` column — see [Prioritisation](Prioritisation) §2 for the
  intended precedence), #528 (adding a task could reuse a live task's id and silently destroy its row,
  since fixed by `allocateNextId`'s union-of-ids rule, [Domain-app](Domain-app)).
- **Meta** — #406 records the spec pipeline itself once going red (stale Roadmap refs, a domain with
  no page) — the exact class of drift this generation pipeline exists to catch, per
  [Updating-the-Spec](Updating-the-Spec).

The intended direction for this whole bucket, stated across #124/#127/#337, is to keep shrinking what
lives only as `SKILL.md` prose or an ungrounded assumption, replacing each with a script, a state
field, or a mutation-checked guard — the same trajectory the `overnight-agent` domain's mutcheck suite
already embodies for the mechanisms it has finished converting.
