# Rebuilding

A build-order guide for constructing this system from an empty directory, sequenced by dependency:
each stage only needs what came before it, and each stage names how to verify it before moving on.

## Stage 0 — repository scaffold

Set up `package.json` with the scripts below (from `packageScripts`), and a bare Vite + React app.

```json
{
  "predev": "node scripts/copy-sw.mjs",
  "dev": "vite",
  "server": "node server.js",
  "start": "concurrently \"npm run server\" \"npm run dev\"",
  "prebuild": "node scripts/copy-sw.mjs",
  "build": "vite build",
  "lint": "eslint .",
  "pretest": "node scripts/check-node-modules.mjs",
  "test": "vitest run"
}
```
Build `scripts/check-node-modules.mjs` first (see [Domain-scripts](Domain-scripts)) — it is a
guard, not a feature, but every later `npm test` depends on it existing and failing loudly on a
half-installed tree. **Verify:** `npm test` runs (even with zero tests) and fails clearly if
`node_modules` is emptied.

## Stage 1 — the data format contract

Before any UI code: write the markdown grammar for `planner.md` (Today/Deferred tables,
`## Priorities`, `## Skills`) and journals, and the shared header-driven row parser
(`boardRow.js`-equivalent) that both reads and — later — writes it. Get the ragged-row invariant
(#426: `Wake` vs `Linked ID` resolved by header name, never index) right here, because every later
stage depends on this being correct once. See [Data-Formats](Data-Formats) for the exact grammar and
[Architecture](Architecture) for why files are the format instead of a database.
**Verify:** unit tests reading a well-formed board, a ragged Deferred row, and a misfiled
`Linked ID`/`Wake` value all resolve the same way the real repository's `boardRow`/`boardTable`
tests do (see [Domain-app](Domain-app), [Behaviour](Behaviour) §Board integrity).

## Stage 2 — pure task operations

Build the framework-free operation layer next: `allocateNextId`, add/move/rename/snooze/delete a
task, id tombstoning, manager-priority sort (`taskSort.js`-equivalent). These are `content ->
content` string transforms with no I/O and no React, so they can be fully tested against fixture
markdown before any storage or UI exists. **Verify:** id allocation never collides across content
and journal counters (issue #528's guarantee), and priority sort matches the full key in
[Prioritisation](Prioritisation) §1.

## Stage 3 — storage abstraction

Build the storage layer (`storage` domain — see [Domain-storage](Domain-storage)) as a provider
interface over "read file, write file, list files," with **at most one provider active per source**.
Implement a local-filesystem provider first (simplest, no auth), then a cloud provider behind the
same interface. **Verify:** the storage test suite's own guarantees — pagination correctness,
diagnostics never leaking file contents, tombstone-file corruption tolerance.

## Stage 4 — sync engine

Build the folder-sync CRDT merge core (`merge.js`-equivalent) as pure functions over parsed records,
then the service-worker/engine wiring that drives it against the storage layer from Stage 3. This is
the hardest stage; budget the most test-writing time here. **Verify:** the merge core's own
conflict-resolution tests (local-edit-vs-remote-edit, delete-vs-edit) pass before wiring in a real
network provider. See [Domain-folder-sync](Domain-folder-sync).

## Stage 5 — the board UI

Build `App.jsx` last among the app-facing pieces, wiring Stage 2's pure operations and Stage 3/4's
storage/sync to a rendered table, using the Stage 1 grammar for every read and write. Add search,
snoozing, and the journal-chat renderer (`journalChat.js`-equivalent) once the table itself round-
trips correctly. **Verify:** a full add-task → edit → snooze → complete cycle round-trips through the
real markdown file and back.

## Stage 6 — config and settings

Build `agent-gate.md` and `user-settings.md` reading/writing (`config` domain) as a thin layer over
Stage 3's storage: never-overwrite semantics for the gate, single-cell surgical writes for settings,
safe-default-with-visible-fallback for malformed values. **Verify:** a hand-edited gate file survives
untouched after the app reads it; a malformed settings cell resolves to a documented default rather
than crashing.

## Stage 7 — independent readers (parallelizable)

These three do not depend on each other and can be built in any order once Stages 1–3 exist:
`task-paper` (static journal-to-HTML export, embeds Stage 5's `journalChat`-equivalent),
`telegram-bridge` (digest/reply-routing bot reading the Stage 1 board and journals), and
`mcp-cred-vault`/`install-prompt` (small standalone utilities). See their respective `Domain-*` pages.

## Stage 8 — the overnight agent

Build last, since it is a *consumer* of every prior stage's format contract, not a producer of a new
one: the `oa-state.ps1` state machine (`scan`/`gate`/`session`/`mark`), the Today-gate and pacing
rules exactly as specified in [Prioritisation](Prioritisation), and the reliability check suite from
[Reliability](Reliability) (MCP reaping, stuck-run repair, deploy-propagation checks) once the agent
itself is running unattended and has something to fail at. **Verify:** the `mutcheck-*` pattern from
day one — every check ships with a fixture proving it is load-bearing before it is trusted to gate a
real run.

## Stage 9 — CI and the spec pipeline

Wire `ci.yml`'s test/lint/mutcheck jobs and, if this spec itself is to be maintained going forward,
the `collect → generate → verify → publish` pipeline described in
[Updating-the-Spec](Updating-the-Spec). This is genuinely last: it has nothing to check until every
prior stage exists.
