# Domain: scripts

`scripts/` holds repo-maintenance tooling that is not part of the shipped product: build-time
helpers, one-off repair scripts, mutation-check harnesses for app-level fixes, and this spec's own
generation pipeline.

## Responsibility

Keep the repository buildable and its guarantees provably load-bearing, without shipping any of
this code to users. Three sub-concerns: (1) build glue (`copy-sw.mjs`), (2) developer-workflow
safety nets (`check-node-modules.mjs`, `merge-queue.mjs`), and (3) the spec pipeline
(`scripts/spec/*`, see [Updating-the-Spec](Updating-the-Spec)).

## Principal modules

| Path | Purpose |
| --- | --- |
| `scripts/copy-sw.mjs` | Copies `folder-sync`'s source tree into `public/folder-sync/` so Vite serves the service worker from the app's own origin (a SW can only register from a same-origin URL). Runs as `predev`/`prebuild`. |
| `scripts/check-node-modules.mjs` | Detects the exact #321 signature — `node_modules` exists but is **empty**, not missing — and fails loudly instead of letting the next command fail as a confusing "'vitest' is not recognized". Wired as `pretest`. |
| `scripts/merge-queue.mjs` | Executes an empirically-verified PR merge order (`VERIFIED_QUEUE`) derived by actually merging each PR into a scratch worktree and running the full suite — because GitHub's per-PR "mergeable" badge is blind to PR-vs-PR collisions. Dry-run by default; test-gated per merge; resumable. |
| `scripts/fix-sidecar.mjs` | One-off: regenerates a planner sync sidecar from cleaned markdown so removed task ids are properly tombstoned (mirrors the app's own local-edit path exactly). |
| `scripts/repair-board-307.mjs` | Dry-run-by-default board repair for the #307 defect class; refuses to write if its own post-repair verification fails. |
| `scripts/mutcheck-ragged-row.mjs` / `mutcheck-wake-migration.mjs` / `mutcheck-skills-section.mjs` | App-level mutation checks proving a fix's tests are load-bearing (see [Reliability](Reliability) for the pattern's general rationale). |
| `scripts/spec/collect.mjs` | Deterministic, model-free fact collector — the "mechanism" half of the spec pipeline; produces `spec-facts.json`. |
| `scripts/spec/verify.mjs` | Fails the build if generated spec prose references anything not in the collected facts, or omits a domain. |
| `scripts/spec/conflicts.mjs` | Deterministic conflicting-requirement detector across open issues — a third mechanism-half, alongside collect and verify. |
| `scripts/spec/verifyParity.mjs` | Keeps the spec branch's own verification job identical to CI's, so its green badge cannot silently decouple from what actually ran. |

## Public exports

`buildReport`, `checkNodeModules`, `classifyNodeModules` (`check-node-modules.mjs`); `EXCLUDED`,
`VERIFIED_QUEUE`, `parseTestCount`, `planQueue`, `planStep` (`merge-queue.mjs`); `buildDecisions`,
`citesIssue`, `extractDirectives`, `extractLifecycle`, `extractSettings`, `findConflicts`,
`parseDuration`, `renderMarkdown`, `sameTarget`, `sentences`, `tokenize` (`conflicts.mjs`);
`CI_VERIFICATION_JOBS`, `SPEC_VERIFY_JOB`, `checkSpecVerifyParity`, `jobBlock`, `npmCommands`,
`runLines` (`verifyParity.mjs`).

## Behavioural requirements (from the scripts test suite, 4 files / 80 tests)

- **The #321 emptied-`node_modules` check distinguishes "missing" from "empty".** `classifyNodeModules`
  reports `populated` when there are entries, `empty` — *not* missing — for a directory that exists
  with nothing in it, `missing` when the directory is absent, and does not treat an unreadable
  directory as empty (a permissions error is a different failure). `buildReport` fails **only** for
  the empty state, names both the issue and the repair, points at the safe teardown that stops it
  recurring, and stays silent when everything is fine — a missing `node_modules` is just "`npm ci`
  hasn't run yet" and must not be flagged, or the guard becomes noise that gets deleted.
- **`merge-queue`'s verified order is asserted as data, not just executed.** `VERIFIED_QUEUE` starts
  with the fix that unblocks the suite, lands a PR before the one stacked on it, contains no
  duplicate PRs, never queues a PR that is also excluded, excludes a PR superseded by a later one,
  and has a non-decreasing expected test count as PRs land — each is a property of the *plan*,
  checkable without touching GitHub. `planStep`/`planQueue` separately handle: merging an open
  mergeable PR, flagging a draft, skipping an already-merged PR (so a stopped run is resumable),
  skipping a PR closed without merging, **stopping** (not guessing) on a conflicting PR or one that
  cannot be found, still merging when mergeability reads `UNKNOWN` but saying so, halting at the
  first blocker since later steps become unverifiable, and carrying a resume point.
- **The conflict detector is precision-first.** `sameTarget` rejects a single shared token and an
  unrelated phrase, and rejects a long sentence merely containing a short one — a "shared, specific
  target" is required before two statements are called a conflict, because a detector that cries
  wolf gets muted within a week (the design note cites the Telegram digest's own past failure of
  exactly that shape). `findConflicts` flags opposite requirements about the same behavior, two
  different values for the same setting, and add-versus-remove of the same artifact, but does not
  flag two issues that merely share a topic or opposite requirements about genuinely different
  things.

## Failure modes guarded against

The unifying theme is **misattributed failure**: a broken shared install reading as a broken PR
(#321), a green per-PR mergeable badge reading as "the stack merges cleanly" when it does not, and a
noisy conflict/mutation detector being switched off by reviewers who no longer trust it. Every check
in this domain is designed to fail loudly and specifically rather than merely fail.
