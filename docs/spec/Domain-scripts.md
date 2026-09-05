# Domain: scripts

## Responsibility

Repository-maintenance tooling and the spec-wiki pipeline's mechanism half. Two families: **repair /
guard scripts** run by hand or CI to fix or prevent a specific known defect, each one traceable to the
issue it closes; and **`scripts/spec/*`**, the deterministic fact-collector, conflict-detector and
verifier that make the generated design spec (this document set) checkable rather than merely fluent.

## Principal modules

| Module | Role |
| --- | --- |
| `scripts/spec/collect.mjs` | Extracts `spec-facts.json` with no model involved: module graph, exports, tests, workflows, open issues — a regex pass, deliberately dependency-free. |
| `scripts/spec/verify.mjs` | The mechanical gate this document set must pass: catches invention (a named file/export/issue that doesn't exist) and omission (an uncovered domain or key module). |
| `scripts/spec/conflicts.mjs` | Detects pairs of open issues that demand opposite things about the same specific target, so contradictory "design authority" doesn't ship silently once both are cited. |
| `scripts/spec/verifyParity.mjs` | Keeps the rolling spec branch's self-verification identical to what `ci.yml` actually runs, so a green status on `spec/auto` means what it says. |
| `scripts/check-node-modules.mjs` | Turns an emptied-by-`git worktree remove` `node_modules` (issue #321) into an immediate, self-explaining `pretest` failure instead of a misleading "vitest not recognized". |
| `scripts/merge-queue.mjs` | Replays an empirically verified PR merge order (measured by actually merging into a scratch worktree and re-running the suite) as one dry-run-by-default, test-gated command. |
| `scripts/mutcheck-ragged-row.mjs`, `mutcheck-wake-migration.mjs`, `mutcheck-skills-section.mjs` | Mutation checks proving specific test suites are load-bearing: revert one part of a fix, assert the target suite goes red, restore. |
| `scripts/repair-board-307.mjs` | Dry-run-by-default board repair for issue #307, refusing to write if its own post-repair verification fails. |
| `scripts/fix-sidecar.mjs` | One-off sidecar regenerator that mirrors the app's own local-edit pipeline so removed ids are properly tombstoned rather than resurrected by another sync replica. |
| `scripts/copy-sw.mjs` | Copies the folder-sync source tree into `public/folder-sync/` so Vite serves the service worker from the app's own origin (a requirement of Service Worker registration). |

## Public surface (representative exports)

`checkNodeModules, classifyNodeModules, buildReport` (`check-node-modules.mjs`); `VERIFIED_QUEUE,
EXCLUDED, planQueue, planStep, parseTestCount` (`merge-queue.mjs`); `tokenize, sameTarget, sentences,
parseDuration, extractDirectives, extractSettings, extractLifecycle, findConflicts, buildDecisions,
renderMarkdown, citesIssue` (`conflicts.mjs`); `CI_VERIFICATION_JOBS, SPEC_VERIFY_JOB,
checkSpecVerifyParity, jobBlock, npmCommands, runLines` (`verifyParity.mjs`).

## Behavioural requirements (from tests)

- **`classifyNodeModules` distinguishes "empty" from "missing" from "unreadable"**, and `buildReport`
  fails only for the empty state (the exact #321 signature) — never for "hasn't been installed yet",
  which is `npm ci`'s job to report.
- **`VERIFIED_QUEUE` encodes a real, tested dependency order**: it starts with the fix that unblocks
  the suite, lands a PR before what's stacked on it, contains no duplicates, never queues an excluded
  PR, and its expected test count is non-decreasing across steps.
- **`planStep`/`planQueue` never guess past uncertainty**: a conflicting PR or one that can't be found
  halts the plan rather than continuing on assumption; an already-merged PR is skipped so a stopped run
  resumes cleanly; an `UNKNOWN` mergeability state still merges but says so explicitly.
- **`findConflicts` demands a shared, specific target** before calling two issues a conflict — it does
  not flag issues that merely share a topic, does not flag the same setting given the same value, and
  reports one finding per pair per kind rather than one per restatement; an issue that already cites
  the other is still flagged if the requirements are genuinely opposite.
- **`checkSpecVerifyParity` reads the workflow files themselves**, covering every npm command CI uses
  to gate a pull request, and its own mutation check catches a verification step being silently dropped
  from the spec job.

## Failure modes this domain guards against

- **Confusing toolchain breakage for a code regression** — the `node_modules` junction-deletion bug
  (#321) reads as "vitest not recognized" unless caught at the exact moment of breakage, which is why
  the check is wired as `pretest`.
- **A spec that reads complete while being wrong** — `verify.mjs` exists because both invention and
  omission are invisible to a reader; the prose "cannot be checked" is the same failure this repo's
  mutation-check scripts close for ordinary source, just applied to generated documentation.
- **A rolling spec PR that can never acquire a check** — `verifyParity.mjs` exists because a
  token-authored `pull_request` event cannot cascade into `ci.yml`'s check-runs, and the fix (writing
  commit statuses from a `schedule`-triggered run) only holds if the statuses actually reflect what ran;
  hardcoding `success` or swallowing failure with `continue-on-error` would be strictly worse than the
  empty rollup it replaces.
- **A "mergeable" badge that is blind to PR-vs-PR collisions** — GitHub computes it per-PR against
  `main` only, so a whole stack can each read green and still deadlock; `merge-queue.mjs` exists because
  that order had to be discovered empirically once and must not be rediscovered by hand every time.
