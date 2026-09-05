# Domain: overnight-agent

## Responsibility

The largest domain in the repository (159 modules under `plugins/overnight-agent/checks/`, plus a
PowerShell-based control layer under `plugins/overnight-agent/skills/overnight-agent/` that is not
JS/TS and so does not appear in this project's `modules[]` inventory but is the domain's operational
core). Together they let an unattended, long-running Copilot CLI agent read the planner folder, decide
what to work on, act, self-heal from its own failures, and prove — mechanically, not by assertion —
that every one of its guards actually catches the defect it claims to catch. The dispatch, priority and
pacing mechanics of the control layer are covered in full in [Prioritisation](Prioritisation); the
supervision and self-healing mechanics are covered in full in [Reliability](Reliability). This page
covers the domain's shape and its `checks/` library, which both of those pages draw on as executable
evidence.

## Shape of `checks/`

Every one of the 159 modules falls into one of three families, distinguishable by name:

| Family | Count (approx.) | Purpose |
| --- | --- | --- |
| `*-sweep.mjs` | ~48 | One-shot detectors run over the live planner folder or a git worktree; each flags exactly one class of defect (a stale ask, a dropped deliverable, an orphaned journal, a collision) and exits non-zero when it finds one. |
| `mutcheck-*.mjs` | ~40 | Mutation-tests for the sweeps above: each reverts exactly one guard inside its target sweep, re-runs that sweep against a known fixture, and asserts the sweep's verdict flips — proving the guard is load-bearing rather than decorative. |
| `lib-*.mjs` | ~13 | Shared, dependency-light readers reused across sweeps and mutchecks (e.g. `lib-live-status.mjs`, `lib-live-ask.mjs`, `lib-issue-comments.mjs`, `lib-postmortem.mjs`) so the same journal/board parsing logic is not reimplemented per sweep. |

The remaining modules are single-purpose utilities (`cdp-eval.mjs`/`cdp-read.mjs` for Chrome DevTools
Protocol probes into a running browser tab, `md2html.mjs`, `mcp-probe.mjs`) and cross-cutting audits
(`board-integrity.mjs`, `doc-claim-consistency-sweep.mjs`, `installed-skill-drift-sweep.mjs`).

## Representative modules

| Module | Role |
| --- | --- |
| `plugins/overnight-agent/checks/board-integrity.mjs` | Structural board audit distinct from `board-gaps.mjs` (board→journal only): catches duplicate ids within one board, an id listed on both boards simultaneously (#280 resurrection), one id reused by two different tasks (#281), a `clock:0` sync-journal entry (the mechanism behind #280 — an epoch clock can never win a CRDT merge, so a stale row is resurrected every sync), an orphaned journal (#445), and a board row with no journal. |
| `plugins/overnight-agent/checks/mutcheck-basename-collision.mjs` | Runs `basename-collision-sweep.mjs` as a **child process against real throwaway git repos** — not a function lifted out of it — and asserts disabling any one guard breaks exactly its own fixture and nothing else; exists because this repo has already shipped a detector that "reported 157 every night and passed anyway." |
| `plugins/overnight-agent/checks/dead-ask-word-sweep.mjs`, `dropped-ask-sweep.mjs`, `digest-invisible.mjs` | Detect an open question the agent asked that never reached the user through any live channel. |
| `plugins/overnight-agent/checks/lib-live-status.mjs`, `lib-live-ask.mjs` | The check-suite's own copies of the "read the newest turn, not a frozen header" rule also implemented in `packages/telegram-bridge/src/liveStatus.js` / `digest.js` — two independent runtimes, pinned together by mutation tests rather than shared code, because the two deploy targets (repo checkout vs. flattened `%LOCALAPPDATA%` install) cannot import from each other. |
| `plugins/overnight-agent/checks/installed-skill-drift-sweep.mjs` | Detects the installed, flattened copy of the plugin diverging from the repo's own source — the deploy-propagation problem covered in [Reliability](Reliability). |
| `plugins/overnight-agent/checks/journal-encoding-invariant.mjs` | Guards the byte-level encoding safety of journal writes (see [Reliability](Reliability)). |
| `plugins/overnight-agent/checks/swallowed-message-sweep.mjs` | The domain's largest module by line count. Guards *incidence*, not exposure: whether one of the user's messages is sitting unanswered at the bottom of a journal right now. It exists because an earlier audit measured only how many journals *could* swallow a reply and reported that number as if it answered whether a message actually *had been* lost — which was false the moment it was written: one task held two unanswered questions appended nine hours earlier, read `done — nothing new` on every run in between. The sweep walks up from end-of-file collecting the trailing block, asks the provenance markers first (a `<!-- from: me -->` block the machinery structurally cannot see needs no heuristic at all), and only falls back to prose heuristics — distinguishing a wrapped continuation of the agent's own paragraph from a genuine new block by whether the line above it ends mid-sentence or is grammatically finished. |

## Why the mutcheck pattern exists as its own family

A sweep with no automated JS test suite (the domain has effectively none in `testFiles` — the two
nominal vitest files, `stuck-run-sweep.test.mjs` and `workflow-health-sweep.test.mjs`, both currently
carry empty test arrays) cannot rely on ordinary unit tests to prove it still works, because the sweeps
run against real filesystem/git state that is awkward to fixture inside vitest, and because the actual
failure this repo has already suffered — a check passing every night while doing nothing — is
precisely the failure ordinary "does it run" testing cannot catch. The mutcheck family is the answer:
each targeted sweep gets a companion module whose entire job is to prove that sweep's guards are
load-bearing, one guard at a time, by breaking it on purpose and asserting the break is detected. This
is the harness `run-sweeps.ps1` invokes on a schedule (see [Reliability](Reliability)) and the one
[Prioritisation](Prioritisation) points to as "the executable statement of the intended behaviour" for
dispatch precedence.

## Failure modes this domain guards against

- **A check that cannot fail** — the recurring, named failure class this whole domain exists to close:
  a detector that always reports the same reassuring value regardless of the real state of the system.
  The mutcheck family exists specifically because a sweep passing is not evidence it works; only a
  sweep *failing when it should* is.
- **Two independently-deployed copies of the same logic silently drifting** — `lib-live-status.mjs`'s
  parity mutation test against `packages/telegram-bridge/src/liveStatus.js` exists because the two
  cannot share an import across their deploy boundary, so they are pinned together by test instead.
- **A deployed install falling behind its source** — `installed-skill-drift-sweep.mjs` exists because
  "the code is merged" and "the running agent has it" are different facts on a single, long-lived
  machine with no redeploy step (see [Reliability](Reliability) for the full "merged isn't running"
  mechanism).
