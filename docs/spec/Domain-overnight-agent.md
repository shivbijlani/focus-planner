# Domain: overnight-agent

## Responsibility

`plugins/overnight-agent` is a GitHub Copilot CLI plugin: an unattended, scheduled agent that reads
the planner board and its journals, decides what is safe to act on versus what needs a human, does the
work, and writes back into the same journals the app renders. It is the largest domain in the repo by
module count (159 collected `.mjs` files under `checks/`, plus a PowerShell skill layer that the fact
collector does not parse but that carries the domain's actual state machine). See
[Prioritisation](Prioritisation) for the full selection/gating logic and [Reliability](Reliability)
for how the agent stays running unattended.

## Principal modules

The skill itself (`plugins/overnight-agent/skills/overnight-agent/`) is PowerShell and is not part of
the collected module graph, but is the domain's core:

| File | Role |
| --- | --- |
| `SKILL.md` | The agent's instructions: phase order (inbox → scan → dispatch → propose → mirror), pacing rules, reversibility/consent rules. |
| `oa-state.ps1` | Skill-owned memory: per-task JSON state, `scan` (the worklist), `session` (per-task session binding + capacity), `consent`/`gate` (the agent-gate reader), `mark` (state + exhaustion declarations). |
| `write-turn.ps1` | The **only** sanctioned way to write a turn into a journal — append-only, with guards G1–G12 against specific corruption classes (lost interpolation, doubled apostrophes, a Telegram heading anchor cut, a stray provenance marker, an over-long pointer turn, and more). |
| `user-settings.md` | The template shipped in the plugin; the user's real, filled-in copy lives outside it (see [Data-Formats](Data-Formats)). |
| `reap-stale-mcp.ps1` | Reaps orphaned MCP server processes left behind by finished sessions. |

`plugins/overnight-agent/checks/` (the collected `.mjs` corpus) is a nightly-run suite of
**detectors**, the **shared libraries** they import, and **mutation checks** that prove each
detector's guard is load-bearing rather than decorative. Its biggest module,
`plugins/overnight-agent/checks/mutcheck-doc-comments.mjs` (599 lines), is one such mutation check.
Representative detectors: `board-integrity.mjs`, `stuck-run-sweep.mjs`, `orphan-liveness-sweep.mjs`,
`ps1-encoding-sweep.mjs`, `journal-encoding-invariant.mjs`, `repo-drift-sweep.mjs`. Representative
shared libraries: `lib-live-status.mjs`, `lib-live-ask.mjs`, `lib-issue-body.mjs`,
`lib-gh-refs.mjs`.

## The mutation-check convention

A test that only ever passes proves nothing about the guard it claims to protect. This domain's
convention (documented across the `mutcheck-*.mjs`/`.ps1` files, and asserted mechanically rather than
by prose) is: revert exactly one part of a fix, re-run the target test/suite, and require the mutant to
be **killed** (some test goes red). An arm that survives means the corresponding guarantee is
untested. The stricter form used by the newer checks (e.g. `mutcheck-meta-nodrop.mjs` in the
`folder-sync` domain, `mutcheck-priority-order.ps1` here) requires the arm→test kill matrix to be a
**bijection**: every arm killed by exactly one test, no test killing two arms — an arm caught by a
second test is "misaimed" (it proves less than it claims), and a test killing two arms is not pinning
either guard individually.

## `repo-drift-sweep.mjs` — the archive that audits itself

The `checks/` directory is a versioned mirror of files that also live, and are actively edited, on the
machine that runs them (`%LOCALAPPDATA%\overnight-agent`). A one-time copy fixes staleness once; it
does not keep it fixed, since the agent writes new sweeps most nights. So the mirror is itself audited
nightly by `repo-drift-sweep.mjs`, which derives its expected file set by parsing the **live registry**
(`run-sweeps.ps1`) and walking each sweep's imports transitively — never from a hand-maintained list,
which would be the same class of staleness one level up. It reports `UNVERSIONED` (live but never
committed — the arm that prevents silent loss), `MODIFIED` (archived and live copies diverged, direction
reported because "live ahead" and "repo ahead" need opposite fixes), and `ORPHANED` (archived but no
longer referenced — informational, not a defect).

## Behavioural requirements

There are no `testFiles` entries for this domain's PowerShell skill layer (vitest does not run
`.ps1`); its behavioural contract is instead enforced by the domain's own `mutcheck-*.ps1` harness, run
as part of the nightly sweep suite rather than `npm test`. Two `.mjs` test files exist in the collected
facts with zero collected test names (`stuck-run-sweep.test.mjs`, `workflow-health-sweep.test.mjs`),
i.e. they exist but the extractor found no `describe`/`it` blocks to enumerate — their content should
be read directly rather than inferred from this page.

## Failure modes

This domain is, more than any other, a running list of **failure modes already found and closed**;
seven are surveyed in depth in [Reliability](Reliability) and [Prioritisation](Prioritisation):
run-level stuck detection, browser-slot health, journal byte-encoding safety, MCP process leaks,
deploy propagation lag, and the recurring "the agent authors the signal its own gate reads" class.
