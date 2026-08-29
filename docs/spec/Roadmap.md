# Roadmap

This system is not finished. This page lists every currently open issue, grouped by
priority label, so a rebuild — or a continuation of this repo — knows what is known-broken
or known-missing rather than inheriting an undocumented gap. 41 issues are open as of the
facts this spec was generated from.

## Critical (12 open)

The critical list is dominated by two clusters: consent/supervision gaps in the Overnight
Agent, and browser-automation resource exhaustion in its Playwright/MCP tooling.

- **#227 — Approval is inferred from a file the agent writes: consent can be
  self-authored.** The approval gate reads plain-English prose in
  `journal/task-<id>.md`, and the agent is one of the writers of that same file. Today
  every agent write happens to stamp its own turn with a provenance marker
  (`<!-- from: overnight-agent -->`), so the gap is latent rather than exploited — but
  nothing in the *reader* enforces that marking, only convention in the writers. The fix
  direction: require a positive human-authorship signal rather than treating unmarked
  text as human by default.
- **#226 — Supervision lives entirely inside the failure domain.** Nothing external can
  detect the agent simply not running; the watchdog is part of the same process tree it
  is meant to supervise.
- **#212 — `fix-playwright-npx-slots.ps1` writes `mcp-config.json` with a UTF-8 BOM.**
  `JSON.parse` rejects a BOM-prefixed file, so every check the script runs afterward is
  blind to the corruption it just introduced.
- **#200 — `reap-stale-mcp`'s 20-minute age gate is the only protection, and it is below
  two workflows' real runtime** — the reaper can kill a run that is still legitimately
  working.
- **#197 — Watchdog cannot recover a STUCK browser slot, only a missing one** — a
  TCP-accept check is treated as a health signal, so a hung-but-listening process reads
  healthy.
- **#190 — Data loss: a live task's board row can vanish with no tombstone**, leaving its
  journal unreachable (cross-referenced against a related sibling issue in its body).
- **#186 — telegram-bridge's completed-board guard permanently drops turns for
  dual-board tasks**, affecting 5 live tasks at the time of filing.
- **#180 — Browser slots should live in user-settings** (currently hardcoded), defaulting
  to 3 named profiles, launching a closed profile on demand.
- **#179 — ~120 tool schemas advertised per turn**, most duplicating browser slots or an
  unused integration — a token-cost and reliability problem, not just tidiness.
- **#178 — Stale-MCP reaper kills by age, not ownership** — it cannot protect the current
  run and can still kill a long-running one.
- **#177 — MCP servers fan out ~6 processes per slot and survive the run** — 36 processes
  / 2.4 GB observed per session, 58 processes / 5 GB in one measured case.
- **#139 — Playwright MCP CDP attach times out when the signed-in browser is
  overloaded** (too many targets or a pegged main thread).

## High (7 open)

- **#223 — The Overnight Agent should work tasks in priority order** (Today first, by
  priority), falling through to Deferred only when Today is exhausted — today it does
  not respect board order.
- **#205 — Collapse consecutive unanswered turns into one current message**, so a stalled
  conversation doesn't read as multiple separate asks.
- **#202 — A finished task stays in the approval queue forever**, because the queue reads
  a frozen Status header rather than the latest turn.
- **#196 — Auto-deploy merged plugin changes to the installed copy**, escalating when the
  deploy is refused — currently a manual step.
- **#181 — A green CI check must mean all tests ran and passed**: 25 of 30 open PRs had
  zero CI checks yet showed a clean badge at filing time.
- **#172 — A rate-limited telegram-bridge run loses all state and re-posts every message
  on retry** — a duplicate-flood risk directly opposed to the idempotency
  `packages/telegram-bridge/src/state.js` is designed to provide (see
  [Domain-telegram-bridge](Domain-telegram-bridge)).
- **#170 — The Overnight Agent writes turns into tasks that are already closed.**

## Medium (9 open)

- **#184 — Dailies:** recurring items need both self-check-off and agent-run activity
  visibility.
- **#176 — Consolidate all plannermd + Overnight Agent development** into one board task
  and one issue trail, rather than scattered tracking.
- **#174 — The approval digest keeps completed tasks in the queue**: the terminal-status
  gate only covers *weak* asks, not all of them.
- **#173 — Lint is red on `main`**, degrading the CI signal added by a prior fix.
- **#171 — A task with an External Ticket is invisible to the Telegram digest ordering**
  because the board parser rejects that ID cell shape.
- **#132 — Task IDs can be reused after completion**, because the completed board is not
  part of the allocation-collision universe — a concrete collision was observed.
- **#127 — Split `SKILL.md` guardrails/reference prose into referenced static partial
  files.**
- **#124 — Offload Overnight Agent business logic to a script; keep `SKILL.md` a thin
  wrapper.**
- **#123 — Journal `.md` store vs. Telegram: clarify source of truth and manage
  completed-journal growth.**

## Low (13 open)

Mostly deferred features and cleanup, not defects:

- **#104 — Final-phase post-mortem + "dream-mode" memory** for the Overnight Agent.
- **#88 — First-run interactive, lesson-tracked onboarding tutorial** (iPhone mini
  target).
- **#85, #77, #71, #61, #56 — Five separate open issues for the same feature:
  event-driven journal read/unread tracking** (UI fires events; localStorage as the first
  provider; no cross-device sync in v1). [Domain-app](Domain-app)'s
  `src/readState/readStateService.js` already implements this design — these issues
  appear to predate or duplicate that implementation and are candidates for consolidation
  or closure once verified against the shipped code.
- **#21 — Rebrand:** rename the Azure AD app and Google OAuth consent screen to
  "Planner," matching the code-level rebrand already done in
  `src/config/branding.js`.
- **#18 — Local-first storage with background cloud sync via service worker** — largely
  superseded by the shipped [Domain-folder-sync](Domain-folder-sync), also a
  consolidation/closure candidate.
- **#12 — Move tasks between sources via right-click** — already implemented per
  `src/moveTask.js` (see [Domain-app](Domain-app)); likely stale.
- **#8 — Remove multi-source backward-compatibility code** (legacy `fp-storage-provider`,
  unsuffixed FSA handle, `migrateLegacy`) once no user needs the migration path.
- **#5 — Connect a personal OneDrive folder and prepare for a combined task view** —
  superseded by the shipped multi-source/Combined view in [Domain-app](Domain-app).

## Tech-debt / cleanup (5 + 1 open, overlapping the above)

Several critical/high issues above are also tagged `tech-debt` (#197, #179, #178, #177),
reflecting that the MCP browser-slot resource exhaustion problems are simultaneously
reliability incidents and structural debt, not merely inefficiency. #207 ("Remove
backward-compatibility artifacts — single-user install, no legacy support needed") and #8
above are pure cleanup with no user-facing symptom.

## Reading this list honestly

The critical cluster shows the system's least-finished area is not the planner data model
(which is heavily tested and self-verified — see [Behaviour](Behaviour)) but the two
newer, more autonomous layers built on top of it: the Overnight Agent's consent/execution
boundary, and its browser-automation tooling's process/resource lifecycle. Several "low"
issues (#85/#77/#71/#61/#56, #18, #12, #5) describe features that already appear to be
implemented in the current codebase — this is itself worth flagging rather than silently
resolving, since it suggests the issue tracker has drifted ahead of or behind the code in
places, and a maintainer should verify and close rather than assume either the code or the
issue list is authoritative.
