# Domain: overnight-agent

## Responsibility

A Copilot CLI plugin (`plugins/overnight-agent/plugin.json`) that autonomously works
Focus Planner tasks overnight under a **plan → approve → execute** loop: it proposes a
plan inside a task's journal (always allowed), waits for the human to approve or request
revisions, and only executes a plan that was approved. Approval is the system's safety
gate. The skill instructions live in
`plugins/overnight-agent/skills/overnight-agent/SKILL.md`; the 127 modules catalogued
here are almost entirely the **verification suite** that keeps the agent's own behaviour
honest — this is, by a wide margin, the largest and most heavily self-audited domain in
the repository (127 of 227 total modules).

## Principal modules and the check taxonomy

| Category | Count | Example | Purpose |
| --- | --- | --- | --- |
| **sweep** | 38 | `plugins/overnight-agent/checks/dropped-ask-sweep.mjs` | Read-only detectors that scan the live journals/board for one specific defect class and report findings; the executable form of a written rule. |
| **mutcheck** | 25 | `plugins/overnight-agent/checks/mutcheck-dropped-ask.mjs` | Proves the paired sweep actually fires: applies a targeted mutation to reintroduce the bug the sweep guards, asserts the sweep goes red, then restores the file. A sweep with no mutcheck is unverified. |
| **lib** | 7 | `plugins/overnight-agent/checks/lib-live-ask.mjs` | Shared extractors (`liveAsk`, `agentTurnSlices`) so multiple sweeps agree on primitives like "what is this task's live ask/status," rather than each reimplementing (and potentially disagreeing about) the same journal-parsing logic. |
| **audits / measures / probes** | ~30 | `plugins/overnight-agent/checks/board-integrity.mjs`, `plugins/overnight-agent/checks/digest-audit.mjs`, `plugins/overnight-agent/checks/rule-coverage.mjs` | One-off or recurring diagnostic tooling: structural board audits, digest-selection replay, and (explicitly distrusted, see below) coverage measurement. |
| **task-specific investigations** | ~12 | `plugins/overnight-agent/checks/ynab-236-lookup.mjs`, `plugins/overnight-agent/checks/yt-transcript.mjs`, `plugins/overnight-agent/checks/cdp-eval.mjs` | Ad-hoc, read-only tools built with the same conventions to answer a specific task's question (a YNAB transaction lookup, a YouTube transcript recovery, raw Chrome DevTools Protocol access bypassing Playwright) — evidence the check-runner pattern is reused as general investigative tooling, not just self-audit. |

`plugins/overnight-agent/checks/repo-drift-sweep.mjs` (535 lines, the domain's largest
module) is "the check that keeps the other 37 checks alive": it verifies every file the
live enforcement suite depends on is committed to git and identical to what is actually
running, because the suite itself is developed against a local, uncommitted
`%LOCALAPPDATA%\overnight-agent` copy that a crash or a laptop loss could erase entirely
without a trace anywhere else.

## Design decision: consent is a plan/approve/execute split, enforced by convention today

Proposing a plan is unconditionally safe; only an *approved* plan may be executed. This is
the one design decision everything else in this domain exists to protect. It is currently
enforced by SKILL.md convention and audited by `self-attested-gate-sweep.mjs` and its
siblings (`reversible-gate-sweep.mjs`, `owned-target-gate-sweep.mjs`,
`deliverable-gate-sweep.mjs`) rather than by a structural boundary the agent cannot
write around — see [Roadmap](Roadmap) issue #250 for the known gap (the `from: me`
attribution marker is written by software the agent itself runs, not by an unforgeable
channel) and its rejected "just trust the convention" alternative.

## Design decision: assert the artifact, never the exit code

Every check in this domain is built to answer "did the real output change," not "did the
script exit 0." `rule-coverage.mjs` is the canonical cautionary tale, and its own header
carries a live warning never to trust the number it prints: its first version reported
100% rule coverage because the enforcement-corpus scan matched a rule's own restated
prose in a comment header, certifying every rule as enforced by matching its own
quotation. Stripping comments only moved the number to 99%, still far too generous — "one
distinguishing term appears somewhere in 107 files" is not evidence of enforcement. The
durable finding was the false-green pattern itself, and it is why every sweep here is
paired with a mutcheck that proves the check can actually fail, not merely that it can
pass.

## Behavioural requirements (representative; the check suite has no vitest-style unit
tests of its own — see "Verification model" below)

- **`repo-drift-sweep`** must report `UNVERSIONED` for any file the live suite depends on
  that exists in no archive, and `MODIFIED` when an archived and a live copy have
  diverged, with direction reported — this is the mechanism that prevents a sweep written
  tonight and never committed from silently vanishing.
- **`lib-live-ask`** must extract a task's ask from its *newest* agent turn only — the
  same "grep the last marker anywhere in the file" bug this library was built to fix
  independently affected two separate sweeps (`declared-unblocked-sweep`,
  `inprogress-stall-sweep`), each silently misreporting whichever task's newest turn used
  a different ask dialect (`Next:`, `Your call:`) than the literal `Needs from you:`
  string those sweeps' original, unshared implementations searched for.
- **`dropped-ask-sweep`** must detect an ask that was present in one turn and silently
  absent from the next, a defect shape distinct from — and previously invisible to —
  `regressive-ask-sweep`'s three arms (amnesia / slot re-ask / stale grab), all of which
  require the ask to still be *present* in order to fire; a dropped ask leaves no trace
  for a contradiction-based detector to catch.
- **`board-integrity`** must detect: the same id listed twice within one board
  (`DUPE-OPEN`/`DUPE-COMPLETED`), an id open and completed simultaneously
  (`BOTH-BOARDS`), one id reused by two materially different tasks (`ID-COLLISION`), a
  sync-sidecar entry persisted with `clock: 0` (`ZERO-CLOCK`, the root mechanism behind
  `BOTH-BOARDS`), a journal with no board row on either side (`ORPHAN-JOURNAL`), and a
  board row with no journal file (`NO-JOURNAL`).
- **Every sweep with a paired mutcheck must go red** when its mutcheck applies the
  targeted mutation, and must return to green once the mutcheck restores the original
  file — a sweep whose mutcheck cannot make it fail is documented as equivalent to having
  no check at all.

## Verification model

This domain's checks are not exercised by the root `vitest` suite counted elsewhere in
this specification; two are Node scripts with their own inline assertion runner invoked
directly (`plugins/overnight-agent/checks/stuck-run-sweep.test.mjs` and
`plugins/overnight-agent/checks/workflow-health-sweep.test.mjs`, run as
`node <file>.test.mjs` against a throwaway SQLite fixture DB, never the live
`~/.copilot/data.db`). The wider mutcheck family (25 files) plays the same self-verifying
role for every other sweep: a `mutcheck-*.mjs` script is itself the test, run on demand
rather than as part of CI.

## Failure modes

- A sweep whose ask/status extraction disagrees with a sibling sweep's own extraction
  (because each reimplemented journal parsing independently) produces contradictory
  findings on the same task — the `lib-live-ask.mjs` / `lib-live-status.mjs` shared
  extractors exist specifically to make that class of disagreement structurally
  impossible rather than something each sweep must remember to avoid.
- A finding measured only against a synthetic fixture, never against the live backlog,
  risks describing a bug that does not actually occur in practice — several sweeps'
  documentation explicitly cites a measured live-backlog percentage (e.g. "12 of 49 active
  non-terminal tasks (24.5%) were mis-attributed") specifically to avoid shipping a
  detector built only on imagined failure cases.
- See [Roadmap](Roadmap) for the currently-open gaps this domain has itself filed against
  its own design, including the still-forgeable consent marker (issue #250, a follow-up to
  the now-closed predecessor issue) and the residual in the Today gate's release signal
  (issue #322, described in [Prioritisation](Prioritisation)).
