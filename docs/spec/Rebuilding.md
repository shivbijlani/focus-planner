# Rebuilding

This is a build-order guide for constructing this system from an empty directory, sequencing by
dependency: each stage only assumes the stages before it exist, and each stage names its own
verification step so a rebuilder can confirm correctness before moving on.

## Stage 0 — Toolchain and repo skeleton

Set up a Vite + React project (`vite.config.js`, `eslint.config.js`) with `vitest` as the test runner.
Wire `pretest: node scripts/check-node-modules.mjs` before `test: vitest run`, so a `node_modules`
emptied by a worktree-teardown hazard (issue #321) fails immediately and legibly rather than as a
confusing "command not found" later — see [Domain: scripts](Domain-scripts). Exclude any
non-JS-runtime tooling directory (this repo's `plugins/**`) from vitest collection, since files that
merely look like test files but require a different host environment will otherwise fail the whole
suite. Verify: `npm test` runs (and passes trivially with zero suites) and `npm run lint` runs clean.

## Stage 1 — The persisted formats

Before any UI exists, define and unit-test the pure parsers/writers for every format in
[Data-Formats](Data-Formats): the board table (`boardTable.js`/`boardRow.js` — the ragged-row alignment
invariant, issue #426), the journal chat schema (`journalChat.js` — fence-aware parsing, attribution
markers, day grouping), and the per-task JSON/markdown sidecars (`task-settings.json`,
`user-settings.md`, `agent-gate.md`). These modules must have **zero** framework dependencies so they
can be tested without a browser or a server — this repo's own constraint (nothing in the test suite
imports `App.jsx`) is why its equivalent modules live in `src/` as plain functions. Verify: run the
format-specific test files directly (e.g. `vitest run src/raggedRow.test.js src/journalChat.test.js`)
and confirm the CRLF/ragged-row/fence-aware requirements in [Behaviour](Behaviour) hold.

## Stage 2 — The storage abstraction

Build one facade (`storage.js`) over interchangeable providers, starting with the two easiest to test
without external accounts: an in-memory/IndexedDB local provider and a File System Access API provider.
Add cloud providers (OneDrive, Google Drive) after the facade's contract is locked, since they must
conform to it, not shape it — see [Domain: storage](Domain-storage) for the exact surface
(`read/write/remove/getFiles/getTodos/journalIds`) and the pagination and secret-safety requirements
each provider must satisfy. Verify: a provider-parametrized test suite (read → write → read-back,
pagination past one page, cancellation via `AbortSignal`) passes identically against every provider.

## Stage 3 — The application shell

With Stage 1's pure operations and Stage 2's storage facade in place, build the React app as a thin
consumer: `App.jsx` renders state and calls into `focusPlanOps.js`/`taskSort.js`/`moveTask.js` etc. — it
should contain no logic that isn't already covered by a Stage-1 unit test, because a thin shell is what
keeps the whole domain unit-testable without a DOM. Add `install-prompt` (platform detection, install
gating) and `diagnostics` (opt-in event tracing) as independent packages once the shell exists, since
neither is a dependency of core board/journal logic. Verify: `npm run build` produces a working bundle;
manual or Playwright-driven exercise of add/delete/move/snooze/priority-change against a local FSA
folder matches every statement in [Behaviour](Behaviour)'s board-integrity section.

## Stage 4 — Folder-sync

Build the pure merge core first (`merge.js`, `records.js`, the `mdTable` codec) with **no I/O** — every
resurrection/collapse/zero-clock invariant in [Data-Formats](Data-Formats) and
[Behaviour](Behaviour)'s folder-sync section must be provable against in-memory fixtures alone. Only
after the merge core is fully tested should the engine/Service-Worker/provider layer
(`engine.js`, `sw.js`, `providers/*.js`, `queue.js`) be built on top, because a defect discovered at the
transport layer is far more expensive to isolate than one caught in the pure merge function. Verify: the
merge-core test suite passes standalone (no browser needed); an end-to-end two-device simulation (write
locally, sync, write remotely, sync, confirm no resurrected delete) passes against a mock provider.

## Stage 5 — Telegram bridge

Build `journal.js` (turn/status parsing) and `board.js` (priority-aware ordering) as dependency-free
Node modules first, since the bridge must run entirely offline-testable with injected I/O — see
[Domain: telegram-bridge](Domain-telegram-bridge). Layer `digest.js`/`liveStatus.js` on top (newest-turn
authority, never a whole-file grep), then `deepLink.js`/`routeReply.js` for the topic-per-task mapping
and reply routing, then the Telegram HTTP client and `state.js` persistence last. Verify: the "read the
newest turn, not a frozen header" tests and the 4096-char-split tests in [Behaviour](Behaviour) pass
against synthetic journals with no live bot token required.

## Stage 6 — Task papers

Layer `packages/task-paper` on top of Stage 1's `journalChat.js` and Stage 5's `journal.js`/`digest.js`
by importing them directly, never reimplementing turn/status/ask parsing — this is the specific lesson
this repository already paid for once (issue #325, two readers disagreeing about consent). Build
`markdown.js` (the deterministic renderer) and `paper.js` (the model) before `render.js` and
`comment.js`. Verify: byte-identical rendering across repeated runs on identical input; the embedded
writer script matches `journalChat.js` byte-for-byte.

## Stage 7 — Config and cross-cutting sidecars

Build `agentsDoc.js`, `agentGate.js`, `userSettingsForm.js` and `aiSettings.js` once the board/journal
formats and storage facade exist, since they scaffold and validate files that live alongside them in the
same folder. Enforce the never-overwrite rule for `agentGate.md` and the surgical-splice (not
regenerate) rule for `userSettingsForm.js` from the start — both are load-bearing safety properties, not
later hardening (issue #250, issue #288). Verify: the round-trip identity test
(`serializeSettingsForm(md, parseSettingsForm(md).map(r => r.value)) === md`) passes for arbitrary
real-world input, including CRLF.

## Stage 8 — The Overnight Agent

This is the largest and most failure-history-laden stage, and should be built last, against a system
that already has real board/journal/sync data to exercise it. Build `oa-state.ps1`'s `scan` command
(sort key, eligibility, the Today gate) and `mark` command (turn-writing, exhaustion declaration) first,
verified against the exact sort key and gate-verdict order in [Prioritisation](Prioritisation). Add the
`session` command (per-task session, concurrency accounting, the collect-wave `-Force` exception) next.
Only after dispatch is correct should the `checks/` sweep library and its `mutcheck-*` mutation-test
companions be built — see [Domain: overnight-agent](Domain-overnight-agent) — because the sweeps assume
a working `scan`/`mark`/`session` substrate to check against. Build the reliability layer
([Reliability](Reliability): OS-dispatched supervision, stuck-run detection, silent auto-restart, deploy
propagation, encoding safety, MCP reaping, browser-slot health) last of all, since it exists to keep an
already-working agent alive unattended, not to make the agent work in the first place. Verify: each
`mutcheck-*.ps1`/`.mjs` file exits 0 (every mutation arm killed); `oa-state.ps1 session -InFlight`
reports `admits` correctly at various concurrency settings; a synthetic stuck run is detected and
repaired by `stuck-run-sweep.mjs --repair`.

## Cross-cutting: the spec pipeline

If this specification itself is being reconstructed alongside the system (rather than assumed as
ground truth), build `scripts/spec/collect.mjs` once enough of the domains above exist to extract facts
from, then `scripts/spec/verify.mjs` to check generated prose against those facts — see
[Updating-the-Spec](Updating-the-Spec) for the full pipeline this repository actually runs.

## Recommended overall order

`npm test` after every stage, plus `npm run lint` and `npm run build` before considering a stage done:

1. Toolchain skeleton
2. Data formats (board, journal, sidecars) — pure, dependency-free
3. Storage facade + providers
4. App shell (UI over Stage 1+2)
5. Folder-sync (merge core, then transport)
6. Telegram bridge
7. Task papers (depends on Stage 2 and Stage 6's journal/digest readers)
8. Config/sidecar scaffolding
9. Overnight Agent (dispatch, then sweeps, then reliability layer)

A rebuilder who follows this order at every stage has, by construction, a system whose every persisted
format, sort key, and gate verdict is provable against a fixture before the next, more complex layer is
built on top of it — matching how this repository's own mutation-tested sweeps and pure-function merge
core were in fact built and are still verified today.
