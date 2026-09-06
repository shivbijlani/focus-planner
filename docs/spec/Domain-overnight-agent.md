# Domain: overnight-agent

`overnight-agent` (`plugins/overnight-agent/`) is a scheduled, markdown-journal-driven autonomous
work loop implemented as a Copilot CLI plugin. It is the repository's largest domain by module count
(159, almost entirely PowerShell) and the one the rest of the reliability and prioritisation design
exists to support. See [Prioritisation](Prioritisation) and [Reliability](Reliability) for its two
most load-bearing behaviours in depth; this page is the domain map.

## Responsibility

Run unattended roughly every 30 minutes: scan the board and journals into an ordered, gated
worklist; propose plans for eligible tasks and execute only user-approved ones, each in an isolated
per-task session/workspace; mirror progress to Telegram; and — through a large mutation-tested check
suite — continuously detect and repair its own infrastructure failures (stuck workflow runs, leaked
MCP processes, undeployed fixes, corrupted journal writes, drifted settings), so a nightly
automation with no human in the loop degrades **narrow and loud** rather than silently.

## Principal modules

| Path | Purpose |
| --- | --- |
| `plugins/overnight-agent/skills/overnight-agent/SKILL.md` | The run-loop contract: PHASE 0 (inbox + gate) → catch-up-doc comments → dispatch → propose plans → task papers → Telegram mirror, plus the pacing/priority/consent doctrine. |
| `plugins/overnight-agent/skills/overnight-agent/oa-state.ps1` | The central state-machine CLI (~5,100 lines): `scan`, `get`, `mark`, `session`, `gate`, `consent`, `doc`, `extract`, `resnapshot` — computes eligibility, sort order, gate verdicts, and capacity. |
| `plugins/overnight-agent/skills/overnight-agent/write-turn.ps1` | The only sanctioned way to append a journal turn; append-only by construction, and refuses on five distinct corruption classes (see [Reliability](Reliability)). |
| `plugins/overnight-agent/skills/overnight-agent/user-settings.md` | The user-tunable config template: paths, allow-lists, Telegram identifiers, the `## Overnight Agent behaviour` table (gate backstop, gate strict, concurrency). |
| `plugins/overnight-agent/checks/reap-stale-mcp.ps1` | Reaps orphaned/stillborn MCP server processes, gated by an ownership veto and a cohort rule. |
| `plugins/overnight-agent/checks/stuck-run-sweep.mjs` | Detects and (`--repair`) fixes workflow runs stuck at `status=running`. |
| `plugins/overnight-agent/checks/workflow-health-sweep.mjs` | Reads scheduled-workflow health directly from the app's SQLite store rather than assuming a scheduler tool is trustworthy. |
| `plugins/overnight-agent/checks/oa-supervisor.ps1` | OS-level classifier (HEALTHY/STUCK/DEAD/SCHEDULE-DEAD/LEAK) driving silent auto-restart. |
| `plugins/overnight-agent/checks/auto-deploy-plugin.ps1` | Closes the "merged is not the same as running" gap for the `installed-plugins` deploy target. |
| `plugins/overnight-agent/checks/sync-oa-home.ps1` | Closes the same gap for the second, flat `%LOCALAPPDATA%\overnight-agent` deploy target. |
| `plugins/overnight-agent/checks/check-browser-slots.ps1` | Health-checks the Playwright MCP CDP browser slots (zombie/wedged detection). |
| `plugins/overnight-agent/checks/basename-collision-sweep.mjs` | Detects two repo paths sharing one deploy basename — a state where a guard can be permanently frozen on the wrong version. |
| `plugins/overnight-agent/checks/catchup-doc-sweep.mjs` | Verifies the catch-up-doc comment channel is actually read, not merely built. |
| `plugins/overnight-agent/checks/mutcheck-doc-comments.mjs` | Mutation-checks the doc-comment attribution reader (issue #422): an agent-authored comment saying "approve" must not read as consent, agent/human authorship partitions without inspecting writing style, reading fails open while consent fails closed, and the API's own author field is read but never trusted outright. |
| `plugins/overnight-agent/skills/overnight-agent/mutcheck-*.ps1` (~30 files) | Mutation checks proving each named guard is load-bearing — see [Reliability](Reliability) for the pattern. |

## Key exports/functions of `oa-state.ps1`

`Cmd-Scan` (builds the worklist), `Test-Workable`, `Get-TodayGateVerdict`, `Test-ExhaustionClaim`,
`Set-ExhaustionDeclaration`, `Test-UserClosed`/`Test-ReopenedClosed`/`Test-UserPaused`/
`Test-UnansweredUser`, `Get-BoardMap`/`Get-PrioritiesRank`/`Get-UrgencyRank`/`Get-PriorityRank`/
`Get-SectionRank`, `Resolve-GateSettings`/`Resolve-PacingSettings`, `Get-LiveSessionCount`/
`Test-SessionHoldsCapacity`, `Cmd-Session`/`Get-SessionVerdict`, `Cmd-Gate`/`Get-GateVerdict`/
`Read-AgentGate`, `Cmd-Consent`/`Get-ConsentFacts`, `Cmd-Doc`/`Read-ObservedComments`,
`Cmd-Extract`/`Get-BoundedSlice`, `Cmd-Mark`.

## Failure modes this domain guards against

- **The agent authoring the signal its own gate reads** — named verbatim in `oa-state.ps1` as a
  recurring failure class, observed three times: an unmarked agent prose block reading back as the
  user's consent; the `awaiting_reply` ratchet parking 186 of 238 rows on the agent's own courtesy
  line; and a `mark` call resetting the Today-gate's release signal regardless of whether the work
  was actually done. See [Prioritisation](Prioritisation).
- **Silent capacity deadlock** from parked tasks holding a dispatch slot — recurred on three separate
  surfaces (issues #487, #500, #541) before the capacity predicate and its dispatcher-visible pause
  flag were unified.
- **Reanimating user-closed work via a stray reply**, and the inverse over-correction of an agent
  self-declaring "done" to gain the same protection and thereby swallowing real unread messages
  (issue #501).
- **Merged-but-not-deployed drift** — a fix landing in `main` while the actually-executing copy (one
  of two separate deploy targets) stays months behind, twice (issue #196 and its recurrence).
- **Host-dependent journal hashing** — Windows PowerShell 5.1 silently ANSI-decodes a BOM-less
  UTF-8 file differently from PowerShell 7, so the same journal bytes can hash differently depending
  on which host ran the script, corrupting the "did anything change?" signal every reader depends on.
- **Silent journal corruption on write** — five distinct classes documented in `write-turn.ps1`'s own
  header, from lost string interpolation to a stray provenance marker, guarded individually.
- **A capability that exists but is never invoked reading identical to "nothing to do"** (issue
  #346) — recurring across the inbox check, the Google Tasks collector, and the catch-up-doc comment
  channel: an empty result and an unreadable/broken input must never produce the same signal.
- **Orphaned OS processes and workflow runs with no self-healing path** — stuck workflow runs, leaked
  MCP server processes, and a supervisor daemon that can silently stop reporting its own heartbeat.
- **Collect-phase work jumping the priority queue** (issue #405) — the collect (inbox/Telegram/scan)
  and execute phases must stay separated, with only a narrow, provenance-justified exception (see
  [Prioritisation](Prioritisation) §Dispatch precedence).

## Test coverage note

Unlike the JavaScript domains, `overnight-agent`'s two JS test files
(`plugins/overnight-agent/checks/stuck-run-sweep.test.mjs`,
`plugins/overnight-agent/checks/workflow-health-sweep.test.mjs`) carry no named test cases in this
spec's collected facts, and the majority of this domain's behavioural guarantees are instead
enforced by the ~30 PowerShell `mutcheck-*.ps1` mutation-check scripts wired directly into CI (see
[Reliability](Reliability) and [Behaviour](Behaviour)), each of which asserts a real fixture drives
the real shipped script to a specific, mutation-provable verdict rather than asserting behavior
through a conventional named-test harness.
