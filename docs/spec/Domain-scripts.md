# Domain: scripts

`scripts/` is a small domain by count — **12 modules** in `spec-facts.json` — but it carries
high-leverage repository tooling. None of these files ship in the planner app's runtime bundle.
They instead support developer workflow, repair historical data safely, or keep the spec pipeline
anchored to code that exists.

This page is the module reference for the domain. The spec-generation pipeline itself is explained
in more depth in [Updating-the-Spec](Updating-the-Spec).

## What lives here

The domain splits into four jobs.

1. **Spec-pipeline mechanisms** in `scripts/spec/*` collect facts, detect contradictory issue
   requirements, verify generated prose against those facts, and keep the spec branch's badge equal
   to CI.
2. **Workflow-safety tools** such as `scripts/check-node-modules.mjs` and
   `scripts/merge-queue.mjs` turn easy-to-misread failure modes into explicit, reproducible ones.
3. **One-off repair and build helpers** such as `scripts/copy-sw.mjs`, `scripts/fix-sidecar.mjs`,
   and `scripts/repair-board-307.mjs` apply a narrow transformation or bootstrap step.
4. **Top-level mutation checks** such as `scripts/mutcheck-ragged-row.mjs` and
   `scripts/mutcheck-wake-migration.mjs` prove that recent app-level fixes are genuinely tested.

A representative slice from the source shows the domain's style:

> [!NOTE]
> **Technical detail: concrete example** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

```js
// scripts/spec/collect.mjs
// The agent then writes prose FROM these facts, and `verify.mjs` asserts the
// prose only references things that appear here.

// scripts/spec/verify.mjs
// A generated spec fails in two directions ... INVENTION and OMISSION.

// scripts/merge-queue.mjs
// Dry-run by default. It prints the plan and changes nothing unless you pass
// `--execute`.
```


</details>
## Module list

| Path | Why it exists in the source | Notable API / behaviour |
| --- | --- | --- |
| `scripts/check-node-modules.mjs` | Prevents the #321 failure from being blamed on a code change. The header explains that an **empty** `node_modules` still exists, so ordinary existence checks say "fine" while later commands fail confusingly. | Exports `classifyNodeModules`, `buildReport`, `checkNodeModules`. Wired as a pretest-style guard. |
| `scripts/copy-sw.mjs` | Ensures Vite serves the folder-sync service worker and its ES-module imports from the app's own origin, because a service worker can only register from same-origin URLs. | Copies `packages/folder-sync/src` and `packages/diagnostics/src` into `public/`, skipping test files. |
| `scripts/fix-sidecar.mjs` | One-off repair helper. The file does not carry a large `WHY THIS EXISTS` block; its opening comment states the exact transformation: regenerate a planner sidecar from cleaned markdown so removed task IDs stay tombstoned instead of being resurrected by sync replicas. | Mirrors the app path `parse(md) -> records -> stampLocalChanges(records, meta) -> serializeSidecar`. Dry-run unless `--apply`. |
| `scripts/merge-queue.mjs` | Replays an empirically verified merge order because GitHub's per-PR `MERGEABLE` badge is blind to PR-versus-PR collisions. The comment says the queue order comes from actual scratch-worktree merges plus full vitest runs. | Exports `VERIFIED_QUEUE`, `EXCLUDED`, `planStep`, `planQueue`, `parseTestCount`. Dry-run by default; `--execute` re-checks each PR and stops on the first failure. |
| `scripts/mutcheck-ragged-row.mjs` | Proves the #426 and #446 ragged-row / misfiled-linked-id tests are load-bearing. The comment is explicit that the defect spanned files, so the mutcheck mutates more than one target. | Reverts one fix fragment at a time, reruns `src/raggedRow.test.js` or `src/misfiledLinkedId.test.js`, then restores the original file. |
| `scripts/mutcheck-skills-section.mjs` | Proves the #188 Skills-section guards are not decorative. | Mutates `src/skillsSection.js`, `src/SkillsSection.jsx`, and `src/focusPlanOps.js`, reruns the Skills-section suites, and fails on surviving mutants. |
| `scripts/mutcheck-wake-migration.mjs` | Proves the #307 wake-migration tests are load-bearing. | Mutates `src/focusPlanOps.js`, reruns `src/boardWakeMigration.test.js`, and requires the reverted behaviour to make the suite fail. |
| `scripts/repair-board-307.mjs` | Repairs #307 board damage but refuses to become another unattended destructive rewrite. Its header says "DRY RUN BY DEFAULT" and refuses to write if post-repair verification fails. | Uses `planBoardRepair`, `verifyBoardRepair`, and `RECOVERED_WAKES` from `src/boardRepair.js`; writes only with `--write`. |
| `scripts/spec/collect.mjs` | Generates `spec-facts.json` without a model. Its rationale is the mechanism/policy split: collect structural facts deterministically, then let prose be generated from those facts. | Walks the repo, extracts exports/imports/components/header docs/tests/workflows/issues, and assigns each module to a domain. |
| `scripts/spec/conflicts.mjs` | Detects contradictory open-issue requirements that `verify.mjs` cannot catch. The comment says cadence makes the spec fresher, not truer; two open issues can still ask for opposite things. | Exports `tokenize`, `sentences`, `sameTarget`, `extractDirectives`, `extractSettings`, `parseDuration`, `extractLifecycle`, `findConflicts`, `citesIssue`, `buildDecisions`, `renderMarkdown`. |
| `scripts/spec/verify.mjs` | Fails the build when generated spec prose invents paths or omits domains. Its header names the two target failure classes directly: **INVENTION** and **OMISSION**. | Reads `spec-facts.json` plus `docs/spec/`, checks path references, issue references, domain coverage, key-module coverage, minimum page length, and fenced examples. |
| `scripts/spec/verifyParity.mjs` | Keeps the spec branch's verification honest. Its rationale is GitHub's no-cascade rule for token-authored PR events: the spec workflow must publish its own status, but that status must still mean the same thing as CI. | Exports `CI_VERIFICATION_JOBS`, `SPEC_VERIFY_JOB`, `jobBlock`, `runLines`, `npmCommands`, `checkSpecVerifyParity`. |

## The `scripts/spec/*` pipeline

These four files are tightly related, but they do different jobs.

- `scripts/spec/collect.mjs` is the **fact collector**. Its comments justify the deliberate lack of
  a parser: structural facts do not need one, and a parser would add maintenance surface. It also
  explains why it captures leading comment blocks verbatim: in this repo, those comments hold the
  rationale a human spec needs.
- `scripts/spec/verify.mjs` is the **truth gate** over prose. It does not ask whether the generator
  exited cleanly; it checks whether the prose names files that exist and covers domains that exist.
- `scripts/spec/conflicts.mjs` is the **contradiction detector**. The source chooses precision over
  recall on purpose, using token overlap and Jaccard thresholds so a noisy report does not train
  maintainers to ignore it.
- `scripts/spec/verifyParity.mjs` is the **workflow-integrity guard**. It reads the workflow YAML as
  text, not through a YAML dependency, then compares the npm commands in `ci.yml` with the spec
  branch's verification job and checks structural rules such as "no hardcoded success" and
  `steps.<name>.outcome`-derived status.

The exported constants in `verifyParity.mjs` show the contract directly:

> [!NOTE]
> **Technical detail: concrete example** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

```js
export const CI_VERIFICATION_JOBS = ['test', 'lint']
export const SPEC_VERIFY_JOB = 'verify-spec-branch'
```


</details>
That small surface is the point: the script checks parity by the commands CI actually runs, not by
an informal promise that two workflows "look similar".

## Workflow and repair tools

`scripts/check-node-modules.mjs` and `scripts/merge-queue.mjs` both convert an ambiguous state into
an explicit verdict. The former distinguishes `missing`, `populated`, `empty`, and `unreadable`
`node_modules`, then fails **only** for the exact #321 signature: a directory that exists but has
no entries. The latter encodes merge order as data:

> [!NOTE]
> **Technical detail: concrete example** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

```js
export const VERIFIED_QUEUE = [
  { pr: 150, label: 'add missing fake-indexeddb devDependency (unblocks the suite)', tests: 459 },
  { pr: 151, label: 'reap stale MCP servers before PHASE 0', tests: 459 },
  { pr: 149, label: 'route batched Telegram replies outside a task topic', tests: 478 },
]
```


</details>
`planStep()` stops on `CONFLICTING`, skips already-merged PRs so a run is resumable, and treats a
missing PR as a stop rather than a guess.

The repair/build helpers are narrower. `scripts/copy-sw.mjs` exists so the service worker loads
from same origin. `scripts/fix-sidecar.mjs` regenerates tombstones in `.sync.json` sidecars. The
source is honest about the gap here: only `copy-sw.mjs` and `repair-board-307.mjs` carry rich
rationale blocks; `fix-sidecar.mjs` is a concise one-off CLI, so its design intent lives in the
opening comment and the exact codec/merge functions it calls.

## The top-level mutchecks

The three mutation scripts all follow the same repository-wide discipline: mutate the real code,
run the real tests, and fail if a mutant survives.

- `scripts/mutcheck-wake-migration.mjs` detects regressions such as skipping short rows again,
  padding at the wrong seam, or dropping wake-migration diagnostics.
- `scripts/mutcheck-ragged-row.mjs` detects the broader row-shape family: unaligned readers,
  clobbered linked IDs, date-shaped wake values, and `App.jsx` reintroducing its own linked-id
  writer instead of using the shared operation.
- `scripts/mutcheck-skills-section.mjs` covers UI/data-shape guarantees around the Skills section:
  read-only rendering, keyboard reachability, preserving unknown sections, and parsing references
  correctly.

This domain is small, but it is where the repository encodes several of its strongest meta-rules:
dry-run destructive repair by default, prefer a direct artifact check over an indirect success
signal, and prove that a test suite would actually notice if the guarded behaviour broke.
