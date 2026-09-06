# Rebuilding

A build order for reconstructing this system from an empty directory, staged so each part can be
verified before the next depends on it. Root `package.json` scripts referenced below already exist and
should be reused, not reinvented: `dev`, `server`, `start`, `build`, `lint`, `test`,
`check:node-modules`, `merge-queue`, `copy:sw`.

## Stage 0 — repository shape and tooling

Set up a plain Vite + React app (no server-side framework) with `type: module`, ESLint via
`eslint.config.js` (see [Domain-root](Domain-root)), and Vitest for tests. Packages that are shared
across the browser app, Node CLIs, and the overnight-agent plugin live under `packages/*`, each its own
independently-versioned package (`@focus/diagnostics`, `@focus/folder-sync`, `@focus/mcp-cred-vault`,
`@focus/task-paper`, `@focus/telegram-bridge`) rather than an npm workspace — this is deliberate: issue
#321 records a `git worktree remove --force` deleting through a `node_modules` junction and emptying a
*shared* install, which a workspace's single top-level `node_modules` would make worse, not better.
Reuse `scripts/check-node-modules.mjs`'s pattern (wired as `pretest`) to catch a `node_modules` tree that
disagrees with the lockfile before it causes a confusing downstream failure.

**Verify:** `npm run lint && npm test` pass on an empty app shell.

## Stage 1 — the storage abstraction

Build `storage` first: one interface (`read`/`write`/`list`) over five interchangeable backends
(in-memory for tests, IndexedDB, File System Access, OneDrive, Google Drive) — see
[Domain-storage](Domain-storage). Every other domain assumes this exists; building it last would mean
retrofitting every consumer's I/O. Include the small JSON sidecars this stage owns:
`task-settings.json` and `settings.json` (§6–7, [Data-Formats](Data-Formats)).

**Verify:** each provider passes the same behavioural contract test suite (pagination, abort, list) —
`src/storage/*.test.js`.

## Stage 2 — the board format

Build the `planner.md` reader/writer next: `src/boardRow.js` (the one ragged-table alignment rule),
`src/boardTable.js` (parsing), `src/focusPlanOps.js` (pure content transforms), `src/snooze.js`, and
`src/taskSort.js` — see [Domain-app](Domain-app) and [Data-Formats](Data-Formats) §1. Build the
alignment rule (`boardRow.js`) **before** any reader or writer, and make every reader/writer import it,
rather than each reimplementing "which cell is `Linked ID`" — issue #426 is what happens when that
rule exists in two places.

**Verify:** `src/boardWakeMigration.test.js`, `src/raggedRow.test.js`, `src/misfiledLinkedId.test.js`,
`src/taskSort.test.js` all pass against representative ragged fixtures (short rows, over-wide rows, rows
predating the `Wake` column).

## Stage 3 — the app shell and board UI

Build `src/App.jsx` on top of Stages 1–2: board rendering by section, context-menu operations routed
through `focusPlanOps.js`, id allocation (`allocateNextId`, unioning content and journal ids so a new
task can never collide with a live row — issue #528) and search/filter (`boardSearch.js`).

**Verify:** `src/focusPlanOps.test.js`, `src/allocateId.test.js`, `src/boardSearch.test.js`.

## Stage 4 — journals as chat

Build `src/journalChat.js` (the parser/renderer for the chat-thread format in
[Data-Formats](Data-Formats) §3), then journal creation/deletion (`journalDelete.js` resolving its path
at delete time, not from cached UI state — issue #185), the ordered/de-duplicated load queue
(`journalLoadQueue.js`), and the read-state service (`src/readState/readStateService.js`) as a pure
event-driven controller with no business logic in the UI.

**Verify:** `src/journalChat.test.js`, `src/journalDelete.test.js`, `src/readState/readStateService.test.js`.

## Stage 5 — config: the agent gate and user settings

Build `src/config/agentGate.js` and `src/config/userSettingsForm.js` — the two files the browser app
and the (not-yet-built) overnight agent both read. Enforce the round-trip identity contract for
`user-settings.md` (re-serializing an unchanged row must return the original bytes exactly) from the
start; it is far cheaper to build in than to retrofit once a hand-edited settings file exists in the
wild.

**Verify:** `src/config/agentGate.test.js`, `src/config/userSettingsForm.test.js`.

## Stage 6 — multi-source ("Combined") support

Build `combinedRouting.js` (tag every merged row with its true source id — never route a destructive op
by text or local id, which is what issue #39 was) and `moveTask.js` (moving a manager-priority
dependency subtree between folders) on top of Stages 2–3.

**Verify:** `src/combinedRouting.test.js`, `src/moveTask.test.js`.

## Stage 7 — folder-sync

Build the offline-first sync engine last among the browser-facing pieces, since it only matters once
more than one device edits the same folder: the mdTable codec (record/frame split,
[Data-Formats](Data-Formats) §8), the per-record clock/tombstone merge model (§9), then the service
worker wiring. This is the correct order because the merge model is provable in isolation (pure
functions over records) before any browser/background-sync machinery exists around it.

**Verify:** `packages/folder-sync/src/merge.test.js`, `records.test.js`, `codecs/mdTable.test.js`,
`reconcile.test.js`.

## Stage 8 — task-paper, telegram-bridge, diagnostics, mcp-cred-vault, install-prompt

These five are independent of each other and can be built in any order once Stages 1–5 exist, since
each reads the same on-disk formats rather than talking to one another directly:

- **`task-paper`** (static HTML generator) needs only `journalChat.js`'s parsing conventions — see
  [Domain-task-paper](Domain-task-paper).
- **`telegram-bridge`** (Node CLI) needs the board and journal formats plus a Telegram bot token — see
  [Domain-telegram-bridge](Domain-telegram-bridge) and [Data-Formats](Data-Formats) §3 for the
  `turn-end` boundary its reply-folding logic must respect.
- **`diagnostics`** (cross-realm event bus) is needed by `folder-sync`'s service worker and the app's
  own tab, but can be stubbed until both sides exist.
- **`mcp-cred-vault`** (pointer-only secrets manifest) is needed only once MCP tooling is configured.
- **`install-prompt`** (PWA install UX) has no dependents; build it whenever the PWA manifest exists.

**Verify:** each package's own test suite in isolation — `packages/task-paper/src/*.test.js`,
`packages/telegram-bridge/src/*.test.js`, `packages/diagnostics/src/index.test.js`,
`packages/mcp-cred-vault/src/schema.test.js`.

## Stage 9 — the overnight agent

Build last, because it depends on every format above being stable: `oa-state.ps1`'s `scan` (the sort
key and gate in [Prioritisation](Prioritisation) §1–4), `session` (capacity accounting, §7),
`write-turn.ps1` (the sole sanctioned journal writer, with its G1–G12 guards — see
[Reliability](Reliability)), then the nightly check suite under `plugins/overnight-agent/checks/`. Build
the mutation checks (`mutcheck-*`) alongside each guard they prove, not afterward — a guard without a
mutation proof is unverified by this domain's own standard.

**Verify:** there is no vitest suite for the PowerShell layer; verify each guard by deliberately
reverting it and confirming its paired `mutcheck-*.ps1` goes red, per
[Domain-overnight-agent](Domain-overnight-agent).

## Stage 10 — CI and the spec pipeline

Wire the four GitHub Actions workflows last: `ci.yml` (lint/test/build on every push), `deploy.yml`,
`pr-closing-keyword.yml`, and `spec-wiki.yml` (this spec's own generation pipeline — see
[Updating-the-Spec](Updating-the-Spec)). None of these should gate earlier stages; they exist to keep
the finished system from silently regressing.

**Verify:** `npm run lint && npm test && npm run build` all pass locally before wiring any workflow to
require them.
