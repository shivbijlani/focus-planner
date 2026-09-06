# Domain: scripts

## Responsibility

Operational tooling that sits outside the app's runtime: build-support scripts, one-off repair
scripts run by a human or agent against a real planner folder, and the self-hosted pipeline that
generates and verifies this design specification. Nothing here ships to the browser.

## Principal modules

| Path | Exports | Role |
| --- | --- | --- |
| `scripts/check-node-modules.mjs` | `checkNodeModules`, `classifyNodeModules`, `buildReport` | Wired as `pretest`; turns "the shared `node_modules` was emptied" into an immediate, self-explaining failure. |
| `scripts/copy-sw.mjs` | (none) | Copies the folder-sync source tree into `public/folder-sync/` so Vite serves the service worker from the app's own origin. |
| `scripts/merge-queue.mjs` | `VERIFIED_QUEUE`, `planQueue`, `planStep`, `parseTestCount` | Executes an empirically verified PR merge order (dry-run by default; test-gated when `--execute`). |
| `scripts/repair-board-307.mjs` | (CLI, imports `../src/boardRepair.js`) | Dry-run-by-default recovery tool for a board rewrite defect (issue #307). |
| `scripts/fix-sidecar.mjs` | (CLI) | Regenerates a planner sidecar from cleaned markdown so removed task IDs are properly tombstoned. |
| `scripts/mutcheck-wake-migration.mjs`, `mutcheck-skills-section.mjs`, `mutcheck-ragged-row.mjs` | (CLI) | Repo-root mutation checks proving specific app-level test suites are load-bearing. |
| `scripts/spec/collect.mjs` | (CLI) | Deterministic, model-free fact collector — produces `spec-facts.json`. |
| `scripts/spec/verify.mjs` | (CLI) | Model-free verification gate: fails the build if the generated spec invents a reference or omits a domain. |
| `scripts/spec/conflicts.mjs` | `findConflicts`, `extractDirectives`, `extractLifecycle`, `extractSettings`, `buildDecisions`, `tokenize`, `sentences`, `parseDuration`, `sameTarget`, `citesIssue`, `renderMarkdown` | Model-free detector for pairs of open issues that demand opposite things. |
| `scripts/spec/verifyParity.mjs` | `CI_VERIFICATION_JOBS`, `SPEC_VERIFY_JOB`, `checkSpecVerifyParity`, `jobBlock`, `npmCommands`, `runLines` | Keeps the spec branch's self-verification job identical to what `ci.yml` actually runs. |

## The spec pipeline is itself a domain module

`collect.mjs` / `verify.mjs` / `conflicts.mjs` / `verifyParity.mjs` are the mechanism half of this very
document's generation, and are described in full in [Updating-the-Spec](Updating-the-Spec). The
short version: `collect.mjs` extracts facts with **no model involved** (module graph, exports, tests,
workflows, open issues); a model writes prose from those facts; `verify.mjs` fails the build if the
prose references anything the facts do not contain; `conflicts.mjs` separately flags when two open
issues demand opposite things — a defect `verify.mjs` cannot catch, because both issue numbers are
individually valid references.

## `merge-queue.mjs` — expensive knowledge, replayed as one command

GitHub's per-PR `MERGEABLE` badge is blind to PR-vs-PR collisions, so a stack of PRs can each read
"mergeable" and still jam halfway through a real merge run. `VERIFIED_QUEUE` is not a guess: it was
produced by actually merging each PR into a scratch worktree and running the full test suite on the
result. Merging in the "obvious" order lands 8 of 18 PRs; the recorded order lands 15 and ends green.
The script is dry-run by default, re-checks each PR's live state before touching it, runs the test
suite after every merge and stops on the first failure, and skips already-merged PRs so a stopped run
is resumable.

## `check-node-modules.mjs` — an empty install is not a missing one

Closes issue #321: `git worktree remove --force` deletes **through** a `node_modules` junction,
emptying the shared install for the main checkout and every other worktree at once, while
`fs.existsSync('node_modules')` still reports `true`. The next command then fails as `'vitest' is not
recognized` — misattributed as a broken change rather than a missing toolchain. This check is
deliberately **not** an error when `node_modules` is simply absent (that is "`npm ci` hasn't run yet,"
and npm already says so); it only fails on the exact #321 signature: present, but empty.

## Behavioural requirements (selected, from the domain's test suites)

- `classifyNodeModules` distinguishes `missing` / `empty` / `populated`, and does not treat an
  unreadable directory as empty; `buildReport` fails **only** for the empty state and names both the
  issue and the repair.
- `VERIFIED_QUEUE` starts with the PR that unblocks the suite, lands a stacked PR after its
  dependency, contains no duplicates, never queues an excluded PR, and has a non-decreasing expected
  test count as PRs land.
- `planStep`: merges an open/mergeable PR; flags a draft so it is marked ready first; skips an
  already-merged or closed-without-merging PR; stops (rather than guessing) on a conflicting PR or one
  it cannot find.
- `conflicts.mjs`'s `tokenize`/`sameTarget`/`extractDirectives`: drops stopwords and punctuation while
  keeping modal verbs the directive rules need; rejects a single shared token or an unrelated phrase as
  a match; recognizes "never"/"do not"/"stop" as a negative directive.
- `verifyParity.mjs`'s mutation suite: separately catches a verification step dropped from the spec
  job, CI gaining a check the spec job does not run, a status hardcoded to success, a failure absorbed
  by `continue-on-error`, and checkout floating to a branch name instead of the verified commit SHA.

## Failure modes

- A script here that silently swallows a false-success (e.g. an emptied `node_modules` reading as
  "fine") produces exactly the misattributed failure `check-node-modules.mjs` exists to end — the
  general pattern this repository repeatedly guards against (see [Reliability](Reliability)).
- `verifyParity.mjs`'s existence implies the spec-verification job and `ci.yml` **will** drift the
  moment someone edits one and not the other; a red `verifyParity` test is the intended signal, not a
  flake to route around.
