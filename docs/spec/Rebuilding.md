# Rebuilding

This page gives a dependency-aware build order for recreating the repository from an empty directory. It uses the actual module graph in `spec-facts.json`, not an abstract architecture sketch. For format details, start with [Data-Formats](Data-Formats); for the runtime rules that act on those files, see [Prioritisation](Prioritisation) and [Architecture](Architecture).

As of the current tree, the forward file names are `planner.md` and `planner-completed.md`. `.github/copilot-instructions.md` still mentions `focus-plan.md`; that is legacy naming, not a different design.

## 0. Recreate the toolchain and package surface first

The root `package.json` has these scripts in `spec-facts.json`:

> [!NOTE]
> **Technical detail: concrete example** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

```json
{
  "predev": "node scripts/copy-sw.mjs",
  "dev": "vite",
  "server": "node server.js",
  "start": "concurrently \"npm run server\" \"npm run dev\"",
  "prebuild": "node scripts/copy-sw.mjs",
  "build": "vite build",
  "copy:sw": "node scripts/copy-sw.mjs",
  "lint": "eslint .",
  "check:node-modules": "node scripts/check-node-modules.mjs",
  "pretest": "node scripts/check-node-modules.mjs",
  "test": "vitest run",
  "merge-queue": "node scripts/merge-queue.mjs",
  "preview": "vite preview"
}
```


</details>
Runtime dependencies in `spec-facts.json` are `express`, `cors`, `idb-keyval`, `react`, and `react-dom`. The important dev dependencies are `vite`, `@vitejs/plugin-react`, `vitest`, `eslint`, `concurrently`, `fake-indexeddb`, and `sharp`.

Build this first because the repo’s CI already assumes `npm ci`, `npm test`, `npm run build`, and `npm run lint` exist. `.github/workflows/ci.yml` and `.github/workflows/deploy.yml` both run `npm ci`; CI then runs `npm test`, `npm run build`, and `npm run lint`, while deploy runs `npm run build` again to produce `dist/`.

## 1. Build the board grammar and pure board operations

Start with `src/boardRow.js`, `src/snooze.js`, `src/boardTable.js`, `src/taskSort.js`, and `src/focusPlanOps.js`. This is the most stable leaf of the application graph:

- `src/boardRow.js` imports nothing.
- `src/snooze.js` imports `./boardRow.js`.
- `src/boardTable.js` imports `./boardRow.js` and `./snooze.js`.
- `src/focusPlanOps.js` imports `./boardRow.js`, `./focusPlanShared.js`, and `./snooze.js`.
- `src/App.jsx` later imports both `./boardTable.js` and `./focusPlanOps.js`.

That makes the board parser/writer contract foundational. If this layer is wrong, the UI, Telegram bridge, and Overnight Agent all inherit the same corruption.

**Verification for this stage**

Run the focused board suite that already exists in `testFiles[]`:

> [!NOTE]
> **Technical detail: concrete example** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

```bash
npx vitest run \
  src/focusPlanOps.test.js \
  src/raggedRow.test.js \
  src/boardWakeMigration.test.js \
  src/misfiledLinkedId.test.js \
  src/taskSort.test.js
```


</details>
Those tests pin the dangerous invariants: ragged Deferred rows, wake-column migration, linked-id recovery, id allocation, completion rows, and priority ordering.

## 2. Build the journal parser and config-file editors next

Next implement the markdown journal and the markdown-backed configuration editors:

- `src/journalChat.js` imports nothing.
- `src/journalLoadQueue.js` imports nothing.
- `src/config/agentGate.js` imports nothing.
- `src/config/agentsDoc.js` imports nothing.
- `src/config/aiSettings.js` and `src/config/userSettingsForm.js` are also leaf-level helpers.

These modules are intentionally dependency-light because the app, the Telegram bridge, and the Overnight Agent all need the same journal and config syntax. They are a better second stage than React because they fix the file contracts before any component tree is built.

**Verification for this stage**

> [!NOTE]
> **Technical detail: concrete example** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

```bash
npx vitest run \
  src/journalChat.test.js \
  src/journalLoadQueue.test.js \
  src/config/agentGate.test.js \
  src/config/aiSettings.test.js \
  src/config/userSettingsForm.test.js
```


</details>
That validates append-only journal writes, sentinel handling, fence masking, queue concurrency, human-authored gate preservation, and surgical `user-settings.md` edits.

## 3. Build folder-sync before finalizing storage orchestration

The repo’s current graph wires sync directly into storage: `src/storage/storage.js` imports `../../packages/folder-sync/src/index.js`. So a clean rebuild should implement the sync package before the final top-level storage service, even if you stub the boundary briefly.

Start with the pure sync core:

- `packages/folder-sync/src/codecs/mdTable.js`
- `packages/folder-sync/src/merge.js`
- `packages/folder-sync/src/records.js`

Then add provider helpers and engine wiring. This ordering follows the internal package graph: `records.js` imports `./codecs/mdTable.js` and `./merge.js`, while higher-level storage code later imports the folder-sync package as a dependency.

**Verification for this stage**

> [!NOTE]
> **Technical detail: concrete example** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

```bash
npx vitest run \
  packages/folder-sync/src/codecs/mdTable.test.js \
  packages/folder-sync/src/merge.test.js \
  packages/folder-sync/src/reconcile.test.js \
  packages/folder-sync/src/records.test.js \
  packages/folder-sync/src/providers/oneDrive.pagination.test.js
```


</details>
These tests prove the row/frame codec, tombstone merge, record reconciliation, and cloud-provider pagination behavior that the app depends on during sync.

## 4. Build storage providers and the Express API together

Now implement the file I/O layer and server contract:

- `src/storage/fsa-provider.js` imports only `./fsa.js`.
- `src/storage/indexeddb-provider.js` imports config scaffolds plus `./fsa.js`.
- `src/storage/onedrive-provider.js` and `src/storage/google-drive-provider.js` import config scaffolds.
- `src/storage/sources.js` imports the provider modules.
- `src/storage/storage.js` imports folder-sync, config scaffolds, `./indexeddb-provider.js`, and `./sources.js`.
- `server.js` has no local imports, but its API has to align with the same planner/journal file model.

The justification is practical as well as structural: `server.js` exposes `/api/files`, `/api/file`, `/api/todos`, `/api/journal-exists`, `/api/config`, and folder-picking/config endpoints. Those APIs only make sense once the planner folder contract and storage behaviors are stable.

**Verification for this stage**

> [!NOTE]
> **Technical detail: concrete example** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

```bash
npx vitest run \
  src/storage/fsa.test.js \
  src/storage/indexeddb-provider.test.js \
  src/storage/onedrive-provider.pagination.test.js \
  src/storage/cloud-provider.abort.test.js \
  src/storage/settings.test.js \
  src/storage/taskSettings.test.js \
  src/storage/diagnostics.test.js \
  src/storage/syncStatus.test.js \
  src/storage/syncStatusCoalesce.test.js
```


</details>
Then do a smoke check of the backend contract itself:

> [!NOTE]
> **Technical detail: concrete example** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

```bash
npm run server
```


</details>
`server.js` is not covered by a dedicated root test file in `testFiles[]`, so the storage suite plus a server smoke run is the narrowest real verification available before full app integration.

## 5. Build `src/App.jsx` after board, journals, config, sync, and storage exist

`src/App.jsx` is large because it is the integration layer, not the source of truth. Its imports show the dependency direction clearly: it pulls in `./boardTable.js`, `./focusPlanOps.js`, `./journalChat.js`, `./journalLoadQueue.js`, `./config/agentGate.js`, `./config/aiSettings.js`, `./storage/storage.js`, `./storage/sources.js`, `./storage/taskSettings.js`, and `../packages/telegram-bridge/src/deepLink.js`.

That means React comes **after** the file grammars and the service layers. Rebuilding the UI earlier would force you to guess at contracts that the current repo has already extracted into pure modules.

**Verification for this stage**

> [!NOTE]
> **Technical detail: concrete example** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

```bash
npx vitest run \
  src/AgentGateEditor.test.jsx \
  src/SkillsSection.test.jsx \
  src/combinedRouting.test.js \
  src/fileTreeEqual.test.js \
  src/linkedNav.test.js \
  src/moveTask.test.js \
  src/selfHealIds.test.js \
  src/skillsSection.test.js
npm run build
```


</details>
`npm run build` matters here because CI and deploy both rely on Vite production builds succeeding, not just isolated unit tests.

## 6. Build the Telegram bridge after the board and journal formats are stable

The Telegram bridge is mostly a downstream reader/writer of the same planner formats:

- `packages/telegram-bridge/src/board.js` parses `planner.md` ordering and id cells.
- `packages/telegram-bridge/src/completed.js` parses `planner-completed.md`.
- `packages/telegram-bridge/src/journal.js` reads/writes journal chat markers.
- `packages/telegram-bridge/src/state.js` persists host-local bridge state.

Its internal modules are fairly independent, but conceptually it should come after the planner/journal contract is fixed, because it mirrors those files rather than defining them.

**Verification for this stage**

> [!NOTE]
> **Technical detail: concrete example** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

```bash
npx vitest run \
  packages/telegram-bridge/src/board.test.js \
  packages/telegram-bridge/src/completed.test.js \
  packages/telegram-bridge/src/journal.test.js \
  packages/telegram-bridge/src/state.test.js \
  packages/telegram-bridge/src/config.test.js \
  packages/telegram-bridge/src/deleted.test.js \
  packages/telegram-bridge/src/digest.test.js \
  packages/telegram-bridge/src/routeReply.test.js \
  packages/telegram-bridge/src/bridge.test.js
```


</details>
That is the real package-level contract: row parsing, completion detection, journal folding, digest ranking, reply routing, and end-to-end bridge behavior.

## 7. Build standalone credential tooling alongside the integrations

`packages/mcp-cred-vault/src/schema.js` is not deep in the app graph, but it belongs after the basic file-backed architecture is clear because it is another file contract, not a UI feature.

**Verification for this stage**

> [!NOTE]
> **Technical detail: concrete example** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

```bash
npx vitest run packages/mcp-cred-vault/src/schema.test.js
```


</details>
## 8. Build the Overnight Agent plugin last

The plugin depends on almost every format defined above:

- it reads `planner.md`, `planner-completed.md`, and journals directly;
- it reads `agent-gate.md` and `user-settings.md` directly;
- `user-settings.md` points at `packages/telegram-bridge/bin/telegram-bridge.js` for Telegram mirroring;
- its own `oa-state.ps1` persists per-task JSON keyed by the same task ids the board and journals use.

This is why the current repo treats the plugin as a consumer of stable formats rather than a prerequisite for them. Build it only after the markdown contracts stop moving.

**Verification for this stage**

There are two direct test files in `testFiles[]`:

> [!NOTE]
> **Technical detail: concrete example** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

```bash
npx vitest run \
  plugins/overnight-agent/checks/stuck-run-sweep.test.mjs \
  plugins/overnight-agent/checks/workflow-health-sweep.test.mjs
```


</details>
The heavier verification lives in CI as PowerShell mutation checks, and those are part of the actual design surface. `.github/workflows/ci.yml` runs, among others:

- `./plugins/overnight-agent/checks/mutcheck-browser-slots.ps1`
- `./plugins/overnight-agent/skills/overnight-agent/mutcheck-inbox-check.ps1`
- `./plugins/overnight-agent/skills/overnight-agent/mutcheck-google-tasks.ps1`
- `node ./plugins/overnight-agent/checks/mutcheck-read-path-budget.mjs`
- `./plugins/overnight-agent/checks/mutcheck-board-linked.ps1`
- `./plugins/overnight-agent/checks/mutcheck-workspace-verdict.ps1`

A faithful rebuild needs those guards or equivalent ones, because the plugin’s failure modes are mostly semantic drift rather than syntax errors.

## 9. Finish by restoring CI parity

Once the code exists, close the loop by matching the checked-in workflows:

1. `npm ci`
2. `npm test`
3. `npm run build`
4. `npm run lint`

Those are the exact gating steps in `.github/workflows/ci.yml`; `.github/workflows/deploy.yml` repeats `npm ci` and `npm run build` before publishing Pages. The spec pipeline in `.github/workflows/spec-wiki.yml` then layers `node scripts/spec/collect.mjs`, Copilot-driven page generation, and `node scripts/spec/verify.mjs` on top of that same install/build baseline.

If you have to cut scope during a rebuild, do not cut Stages 1–4. The current import graph makes them the shared substrate for everything else: the UI imports them, sync imports them, and the automation stack reads the files they define.

See also [Domain-app](Domain-app), [Domain-config](Domain-config), [Domain-storage](Domain-storage), [Domain-folder-sync](Domain-folder-sync), [Domain-telegram-bridge](Domain-telegram-bridge), and [Domain-overnight-agent](Domain-overnight-agent).
