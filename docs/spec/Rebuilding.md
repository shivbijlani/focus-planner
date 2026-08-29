# Rebuilding

A build-order guide for reconstructing this system from an empty directory, sequenced so
each stage is independently verifiable before the next depends on it.

## Stage 0 — Decide the format, before writing any code

Write down the `planner.md` / `planner-completed.md` / `journal/task-<id>.md` formats
exactly as specified in [Data-Formats](Data-Formats) first. Every other stage depends on
this contract being stable, because three independent processes (the app, the Telegram
bridge, the Overnight Agent) will each implement their own reader/writer against it
without calling into each other's code. Getting this wrong late is expensive: it means
rewriting three parsers, not one.

**Verify:** hand-author a few sample `planner.md`/journal files matching the spec and
confirm they are unambiguous to a human reading them cold — that readability is the
actual acceptance test for this stage, since the format's whole purpose is legibility
without this app's source.

## Stage 1 — Pure transformation core (no I/O, no framework)

Build, in order, because each has zero dependency on anything after it:

1. **Board parsing/editing** — the equivalent of `src/focusPlanOps.js`: pure
   `(content, ...args) -> newContent` functions for add/move/delete/rename/snooze/prioritize.
2. **Journal chat parsing** — the equivalent of `src/journalChat.js`: `parseJournalChat`
   and `appendJournalMessage`, covering the marker table in [Data-Formats](Data-Formats).
3. **Task sorting** — the equivalent of `src/taskSort.js`: priority icon → manager
   priority → dependency depth ordering.

**Verify:** port the behavioural statements in [Behaviour](Behaviour)'s "Board editing and
priority" and "Journals as chat threads" sections into unit tests against these functions
directly, with no browser, filesystem, or network involved. If this stage's tests need a
DOM or a file handle, the modules are not pure enough yet.

## Stage 2 — Storage abstraction

Build one provider interface (`read`, `write`, `remove`, `listFiles`, `getJournalIds`,
`getMaxJournalId`, `journalExists`, `scaffoldIfEmpty`) and a **single** first
implementation — a browser-local one (equivalent to
`src/storage/indexeddb-provider.js`) is the cheapest to stand up and needs no OAuth. Wire
Stage 1's pure functions to this provider through a facade (`src/storage/storage.js`'s
role): UI events call a pure op, then the facade persists the result.

**Verify:** the app must be fully usable — add/edit/delete/snooze/prioritize tasks,
create and read journals — with only this one local provider, before adding any cloud
provider. This isolates "does the transformation logic work" from "does OAuth work."

## Stage 3 — Additional storage providers + multi-source registry

Add the File System Access provider, then OneDrive, then Google Drive, each behind the
same interface from Stage 2. Build the multi-source registry
(`src/storage/sources.js`'s role) last, preserving its single-source invariant: with
exactly one registered source, the UI must behave exactly as it did in Stage 2.

**Verify:** the OneDrive/Google Drive pagination requirements in
[Behaviour](Behaviour) ("Storage providers") — specifically that journal-id listings
follow every page — since a provider that silently truncates a listing reintroduces the
ID-collision failure class from Stage 1's tombstone/self-heal logic.

## Stage 4 — Record-level sync

This is the highest-risk stage and depends on Stages 1–3 being solid, because sync bugs
that resurrect deleted rows or corrupt board structure are invisible until multiple
devices are involved. Build in this order: the markdown-table codec (parse/serialize with
a frame capturing non-row structure), the merge core (`mergeCollections`,
`stampLocalChanges`, tombstones, the sidecar format), then the record-level reconcile
operation that wires codec + merge + sidecar I/O together, and only then the
transport-specific pieces (queue, service worker, OAuth provider descriptors).

**Verify:** port every statement in [Behaviour](Behaviour)'s "Record-level sync" section
as unit tests against the merge core in isolation, with in-memory stubs — no real network,
no real service worker. The zero-clock and collapse-guard requirements in particular are
the two hardest-won correctness properties in the whole system; do not skip their tests.
Only after the merge core is independently proven should the service worker and OAuth
providers be added, verified by running two independent local instances against a mock
remote provider and confirming a delete on one and an edit on the other both survive.

## Stage 5 — Independent Node consumers (parallelizable)

The Telegram bridge and the Overnight Agent's check suite can be built in parallel with
each other (and with Stage 3+) once Stage 0's format is fixed, because neither depends on
the app's code — both are independent readers/writers of the same markdown files.

- **Telegram bridge:** build the pure journal/board/digest parsers first (no filesystem,
  no network — matching `packages/telegram-bridge/src/journal.js`'s design), then the
  orchestration layer (`syncUp`/`syncDown`) with injected I/O, then the real filesystem
  adapter and Telegram HTTP client last.
- **Overnight Agent checks:** build one shared library (equivalent to `lib-live-ask.mjs`)
  before writing sweeps against it, so multiple checks cannot independently disagree about
  what a task's live ask/status is. Every sweep should ship with a paired mutcheck from the
  start, not added afterward — a sweep without one has not been proven to catch anything.

**Verify:** the Telegram bridge requirements in [Behaviour](Behaviour), and for the
Overnight Agent, that each mutcheck actually turns its sweep red when the mutation is
applied and green again once restored.

## Stage 6 — Supporting packages and polish

`diagnostics`, `install-prompt`, and `mcp-cred-vault` have no dependency on Stages 1–5 and
can be added whenever their functionality is needed: diagnostics as soon as debugging
Stage 4's sync becomes painful without it; install-prompt and mcp-cred-vault are pure UX
and credential-hygiene additions with no correctness coupling to the rest of the system.

**Verify:** diagnostics must be provably free when disabled (a no-op benchmark, not just a
code read); the MCP secrets schema must accept its own example file and reject every
malformed variant in [Behaviour](Behaviour); install-prompt's iOS special-case must be
checked on a real iOS Safari and a real iOS Chrome, since the platform distinction cannot
be verified by unit test alone.

## What to build last

The `root` domain's `server.js` (local-folder HTTP convenience) and `scripts/` tooling —
including this specification's own generator (`scripts/spec/collect.mjs`) and verifier
(`scripts/spec/verify.mjs`) — are optional accelerants, not load-bearing. Build them only
once the domains above are stable enough to be worth documenting and gating in CI.
