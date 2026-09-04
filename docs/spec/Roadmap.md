# Roadmap

This system is not finished. This page lists every currently open issue, grouped by
priority label, so a rebuild — or a continuation of this repo — knows what is known-broken
or known-missing rather than inheriting an undocumented gap. 38 issues are open as of the
facts this spec was generated from.

## Unlabeled bugs (1 open) — currently the most acute

Filed most recently and not yet priority-labeled, but describing the automation being dead
in the water rather than merely degraded:

- **#261 — A stuck "running" run freezes the `*/30` schedule.** There is no run-level
  timeout or heartbeat: once a run hangs, it never leaves `running`, so the
  scheduler's `nextRunAt` passes and the next run never fires — silently disabling the
  entire every-30-minutes automation with no alert. This is the run-lifecycle analogue of
  the browser-slot watchdog gaps below (#197), but for the workflow run itself. The
  Overnight Agent's own staleness backstop (see [Prioritisation](Prioritisation)) mitigates
  the consequence for the task board without addressing the run lifecycle itself.

## Critical (5 open, all `reliability`)

Every critical issue concerns the [Domain-overnight-agent](Domain-overnight-agent)'s
supervision and consent boundary — the layer built on top of the well-tested planner data
model, not the model itself.

- **#197 — The watchdog can recover a missing browser slot but not a stuck one.** A
  TCP-accept check is treated as the health signal, so a hung-but-listening process reads
  healthy; the failure Shiv actually hit ("the browser slot stopped responding mid-session")
  is exactly the one case classified as fine. Related to issue 177 (process fan-out),
  issue 178 (reaper ownership), #139 (the matching stuck-slot symptom), and #180 (the slot
  table); umbrella issue #176.
- **#180 — Browser slots are hardcoded instead of configurable.** Six slots exist today,
  five near-identical clones of the same account, one already down and disabled. The
  requested fix moves the slot table into `user-settings.md` (default: one regular profile,
  Bijlani and Kiley launched on demand) so the watchdog reads live configuration instead of
  a fixed list.
- **#179 — ~120 tool schemas are advertised to the model on every turn.** Every MCP server
  injects the full JSON schema of every tool it exposes on every turn regardless of use;
  with 4–5 near-identical Playwright browser slots configured, that is ~100 duplicate tool
  definitions competing for context on a run that typically uses one slot and three tools —
  a token-cost and reliability problem, not just tidiness, and it compounds the agent's
  per-run context budget directly.
- **#139 — Playwright MCP's CDP attach times out when the signed-in browser is
  overloaded** (too many open targets, or a pegged main thread) — one concrete instance of
  the "stuck, not missing" failure #197 generalizes.
- **#243 — The browser watchdog has no plugin-update check, so its own self-heal is
  circular** (it lives inside the agent it is meant to repair). Measured reality is more
  nuanced than the premise: `auto-deploy-plugin.ps1` already auto-deploys `main` to the
  installed plugin at PHASE 0 of every run, so fixes do ship — the watchdog itself is just
  not among the things checked for staleness.

## High (3 open)

- **#250 — Consent still rests on a marker the agent's own software writes** (a follow-up
  to its now-closed predecessor issue, which made the consent *reader* fail closed — an
  affirmative only counts when attributed to `<!-- from: me -->`) — but that marker is
  stamped by the Telegram bridge's own fold path (`sync-down`), not by an unforgeable
  channel such as the reply's originating `from_user` id. The predecessor's third success
  criterion (an approval record the agent's own journal-writing path cannot reach) is
  still open.
- **#181 — A green CI check must mean all tests ran and passed.** 25 of 30 open PRs, at
  filing time, had run zero CI checks yet showed `mergeStateStatus: CLEAN` — the exact
  inversion of the obvious reading, since `CLEAN` here is strictly weaker evidence than
  `UNSTABLE`.
- **#170 — The Overnight Agent writes turns into tasks that are already closed.**

## Medium (7 open)

- **#184 — Dailies:** recurring items need self check-off, a cadence+predicate form, and
  agent-run activity visibility. Two of the four requested flavors (agent-run FYI, scheduled
  digest) already ship as live scheduled workflows; the gap is specifically the two
  user-facing recurring forms.
- **#176 — Consolidate all planner.md + Overnight Agent development into one board task
  and one issue trail.** Today the same work is tracked across ~41 board tasks, ~19 GitHub
  issues and ~20 Telegram topics, and the triple-tracking itself is the problem: the same
  defect drifts across all three and becomes impossible to see as "open" in one place.
- **#132 — Task IDs can be reused after completion**, because the completed board is not
  part of the allocation-collision universe (see `idTombstones.js` in
  [Domain-app](Domain-app), which addresses the related deletion case but not this one) — a
  concrete ID collision was observed.
- **#127 — Split `SKILL.md` guardrails/reference prose into referenced static partial
  files** (companion to #124).
- **#124 — Offload Overnight Agent business logic to a script; keep `SKILL.md` a thin
  wrapper** instead of prose the model must re-derive behaviour from every run.
- **#123 — Journal `.md` store vs. Telegram: clarify source of truth** and manage
  completed-journal growth over time.
- **#207 — Remove backward-compatibility artifacts** — a first pass found 66 marker hits
  across 21 files (`legacy`, `backward compat`, `deprecated`, `migrateLegacy`,
  pre-rebrand naming); since there is exactly one installation of this app, none of it earns
  its complexity.

## Low (13 open)

Mostly deferred features and cleanup, not defects:

- **#104 — Final-phase post-mortem + "dream-mode" memory** for the Overnight Agent.
- **#88 — First-run interactive, lesson-tracked onboarding tutorial** (iPhone mini target).
- **#85, #77, #71, #61, #56 — Five separate open issues for the same feature:
  event-driven journal read/unread tracking** (UI fires events; localStorage as the first
  provider; no cross-device sync in v1). [Domain-app](Domain-app)'s
  `src/readState/readStateService.js` already implements exactly this design — these issues
  appear to predate or duplicate the shipped implementation and are candidates for
  consolidation or closure once verified against the code.
- **#21 — Rebrand:** rename the Azure AD app and Google OAuth consent screen to "Planner,"
  matching the code-level rebrand already done in `src/config/branding.js`.
- **#18 — Local-first storage with background cloud sync via service worker** — largely
  superseded by the shipped [Domain-folder-sync](Domain-folder-sync), also a
  consolidation/closure candidate.
- **#12 — Move tasks between sources via right-click** — already implemented per
  `src/moveTask.js` (see [Domain-app](Domain-app)); likely stale.
- **#8 — Remove multi-source backward-compatibility code** (legacy `fp-storage-provider`,
  unsuffixed FSA handle, `migrateLegacy`) once no user needs the migration path — a smaller,
  earlier-filed sibling of #207 above.
- **#5 — Connect a personal OneDrive folder and prepare for a combined task view** —
  superseded by the shipped multi-source/Combined view in [Domain-app](Domain-app).

## Reading this list honestly

The unlabeled bug #261 is, by its evidence, more operationally urgent right
now than most of the labeled criticals: the automation is not degraded, it is dead-locked.
Beneath that, the critical and high clusters are dominated by two structural gaps in the
[Domain-overnight-agent](Domain-overnight-agent): a consent boundary that still depends on
software-written markers rather than an unforgeable channel (#250, #302, #322 — see
[Prioritisation](Prioritisation)), and a
supervision/browser-automation layer that is entirely inside its own failure domain
(#197, #180, #179, #139, #243). Neither cluster touches the planner data model itself, which
is heavily tested and self-verified (see [Behaviour](Behaviour)) — the least-finished part
of this system is the newer, more autonomous layer built on top of it, not the storage or
sync core. Several "low" issues (#85/#77/#71/#61/#56, #18, #12, #5) describe features that
already appear to be implemented in the current codebase; that drift between the issue
tracker and the code is itself worth flagging rather than silently resolving, since a
maintainer should verify and close rather than assume either side is authoritative.
