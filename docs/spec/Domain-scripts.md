# Domain: scripts

## Responsibility

Small, standalone Node scripts that support development and maintenance but are not part
of the shipped application: replaying a verified PR merge order, copying the service
worker to a servable location, one-off data-repair tooling, a mutation-check runner, and
this specification's own fact collector and verifier.

## Principal modules

| Module | Role |
| --- | --- |
| `scripts/merge-queue.mjs` | The largest module in this domain (263 lines). Executes an empirically-verified PR merge order: GitHub's per-PR `MERGEABLE` badge is blind to PR-versus-PR collisions, so a stack that each individually reads "mergeable" can still stop dead halfway through a real merge run. The order it encodes was produced by actually merging each PR into a scratch worktree and running the full vitest suite on the result — not guessed — because the "obvious" order lands 8 of 18 PRs while the verified order lands 15 and ends green. Dry-run by default (`--execute` to actually merge); re-checks each PR's live state before touching it, runs the test suite after every merge and stops on the first failure, skips already-merged PRs (a stopped run is resumable), and leaves branches alone unless `--delete-branches` is passed. Exports `EXCLUDED`, `VERIFIED_QUEUE`, `parseTestCount`, `planQueue`, `planStep` — the pure planning functions are exported specifically so `scripts/merge-queue.test.js` can unit-test the plan without calling `gh` or mutating a real repo. |
| `scripts/spec/collect.mjs` | Deterministic, model-free fact extraction for this spec: walks the module graph, exports, data formats, tests, workflows, and open issues into `spec-facts.json`. Deliberately dependency-free (a regex pass over source, not a real parser) — these are structural facts robust enough to enumerate without a parser dependency to maintain. |
| `scripts/spec/verify.mjs` | The gate this very document must pass: checks every page in `docs/spec/` against `spec-facts.json` for invented file/export/issue references, omitted domains, and thin/example-free pages, and fails the build rather than publish an unverified spec. |
| `scripts/copy-sw.mjs` | Copies the `folder-sync` source tree into `public/folder-sync/` so Vite serves the service worker (and its ES-module imports) from the app's own origin — a browser can only register a service worker from a same-origin URL, so it cannot be imported straight out of `packages/`. |
| `scripts/fix-sidecar.mjs` | One-off repair tool: regenerates a planner sidecar from already-cleaned markdown so that removed task IDs are properly tombstoned, mirroring exactly what the app does on a local edit (`parse(md) -> records -> stampLocalChanges(records, meta) -> serializeSidecar`) — otherwise other sync replicas would resurrect the removed rows. |
| `scripts/mutcheck-skills-section.mjs` | A mutation check for the Skills-section guards: applies one targeted mutation at a time to the guarded code, re-runs the suite, and asserts it goes red — then restores the file. A passing test proves nothing unless it also fails when the behaviour it guards is broken. |

## Public exports

`scripts/merge-queue.mjs` is the one script in this domain built to be imported as well as
run: its planning functions (`planQueue`, `planStep`, `parseTestCount`) and data
(`VERIFIED_QUEUE`, `EXCLUDED`) are unit-tested directly. Every other module here exports
nothing — they are invoked as standalone Node scripts (`node scripts/<name>.mjs [args]`),
consistent with their role as tooling rather than application code.

## Behavioural requirements (from `scripts/merge-queue.test.js`, 21 tests)

- `VERIFIED_QUEUE` starts with PR 150 (the fix that unblocks the suite), lands PR 149
  before PR 154 (which is stacked on it), contains no duplicate PRs, never queues a PR that
  is also excluded, excludes PR 152 (superseded by PR 154), and has a non-decreasing
  expected test count as PRs land.
- `planStep` merges an open/mergeable PR; flags a draft so it is marked ready first; skips
  an already-merged PR (so a stopped run is resumable) and a PR closed without merging;
  stops on a conflicting PR rather than guessing; stops when the PR cannot be found; and
  still merges when mergeability is `UNKNOWN`, but reports that it did.
- `planQueue` plans every step when all are healthy, halts at the first blocker (later
  steps are unverifiable once one fails), keeps going past an already-merged PR, resumes
  from a given PR, and carries the label through for readable output.
- `parseTestCount` reads the passing count from vitest output, still reads it when some
  tests failed, and returns `null` when there is no count to read.

## Design decision: mechanism/policy split for the spec generator itself

`scripts/spec/collect.mjs` documents its own rationale directly: the "obvious" way to
generate a spec is to hand an agent the repo and say "write the spec," which produces
confident prose that drifts from the code immediately and cannot be checked, because
nothing anchors what is written to what exists. The chosen design splits this into a
MECHANISM half (`collect.mjs`, no model involved, reproducible and diffable) and a POLICY
half (an agent writing prose from the collected facts), with `verify.mjs` as the
mechanism that asserts the prose only references what `collect.mjs` actually found. This
is the same discipline the [Domain-overnight-agent](Domain-overnight-agent) check suite
applies throughout: assert the artifact at the far end, never the exit code of the step
that produced it.

## Behavioural characteristics for the rest of the domain

Only `merge-queue.mjs` has a dedicated unit-test file; the remaining scripts are enforced
procedurally instead — `verify.mjs` runs as a CI gate against the artifact `collect.mjs`
and the spec-writing step jointly produce (see `.github/workflows/spec-wiki.yml`), and
`fix-sidecar.mjs` / `mutcheck-skills-section.mjs` are one-off/manually-invoked tools whose
correctness is checked by the effect they have on the repository state at the moment they
are run (a sidecar's tombstones, or a mutation-checked test suite going red).

## Failure modes

- `verify.mjs`'s own design note calls out the two failure modes any generated spec can
  have and neither is visible from reading the spec itself: **invention** (naming a file,
  export, or issue that does not exist) and **omission** (a domain silently absent, so the
  spec reads complete while being unusable for its stated rebuilding purpose). Both are
  checked mechanically rather than left to reviewer attention.
- If `scripts/copy-sw.mjs` is skipped before `dev`/`build` (it is wired as `predev`/
  `prebuild` in `package.json` specifically so this cannot happen), the service worker
  fails to register because it would only be reachable from a `packages/` path outside the
  page's origin.
