# Behaviour

This page is the acceptance suite: every statement below is derived from an actual test
name in the repository's 62 test files (723 individual test cases). A rebuilt
implementation is correct only if it satisfies every statement here. Per-module detail and
rationale live on each domain page; this page groups requirements by functional area so
they can be checked off independently of which file implements them.

## Board editing and priority (app)

- Adding a task must allocate its ID from the content's current maximum, skipping any ID
  that already has a journal on disk, ignoring a foreign high journal ID that does not
  belong to this planner (`src/allocateId.test.js`).
- Board sort must rank 🔴-urgent items above everything else regardless of other
  ordering; within non-urgent items, manager-priority order beats dependency-chain depth,
  which beats the remaining priority icons; dependency chains sort prerequisite-first
  within the same manager priority (`src/taskSort.test.js`).
- Moving a manager-priority task between storage sources must carry every task in its
  dependency subtree along with it, and must not carry along a task whose chain resolves
  to a *different* manager priority (`src/moveTask.test.js`).
- A snooze ("Wake") date must be set/cleared without touching any other cell in the row,
  and must still parse a legacy trailing-HTML-comment encoding for rows written before the
  column existed (`src/snooze.test.js`).
- Deleting a task must resolve its journal path at the moment of deletion — never trust a
  lazily-loaded, possibly-still-`null` cached value — so a delete issued before the row's
  journal state has resolved cannot silently orphan the journal file
  (`src/journalDelete.test.js`).
- Deleted task IDs must be tombstoned for a window so a freed ID cannot be reused before a
  sync-resurrected journal for that ID could plausibly still arrive, while ignoring
  invalid ids so a bad row cannot poison the store (`src/idTombstones.test.js`).
- A corrupted cluster of task IDs must be detected by its *gap* from the planner's normal
  numbering, not by absolute magnitude — a planner that legitimately uses high IDs
  throughout must not be flagged (`src/selfHealIds.test.js`).

## Journals as chat threads (app)

- Parsing must extract the thread title without its leading `#`, keep undated content as
  pinned "earlier notes," and route `AUTO`/`AGENT`-marked content into an agent-authored
  group distinct from the human's (`src/journalChat.test.js`).
- Appending a message must merge into today's existing "me" bubble when one exists,
  insert a `from: me` marker when the trailing author was an agent, and open a fresh dated
  block when the last dated block isn't today's.
- A journal's existence state must never offer "create" after a failed check — only after
  a successful absence check — and must retain previously known existence across a retry
  failure rather than flip-flopping (`src/journalLoadState.test.js`).
- Journal reads across ~90 board rows must be funneled through a concurrency-limited,
  board-order queue that never exceeds its limit and never re-fetches a journal already in
  flight (`src/journalLoadQueue.test.js`).
- Read/unread tracking must seed every journal tracked before initial seeding as
  already-seen (no "wall of stars" on first load), then treat a journal that first appears
  afterward as unread until opened; its signature must be stable for empty/invalid content
  and must change whenever new dated content is appended, even same-day
  (`src/readState/readStateService.test.js`, `src/readState/signature.test.js`).

## Multi-source and Combined view (app)

- Every merged row must be tagged with the id of the source it actually came from, falling
  back to legacy text lookup only when no source id is available
  (`src/combinedRouting.test.js`).
- An optimistic patch after a write must replace and re-parse only the affected source's
  content, and must return the same array reference (no needless re-render) when nothing
  actually changed (`src/combinedViewPatch.test.js`).
- The file tree shown per source must keep only curated core files at the top level, hide
  every non-journal directory even if it contains copies of core files, and drop stray
  loose `.md` files not on the allow-list (`src/fileTreeFilter.test.js`).

## Storage providers (storage)

- Cancellation via `AbortSignal` must propagate through both cloud providers' existence
  checks and reads; only an explicit not-found response may be treated as absence — a
  thrown error must remain an error, never silently reported as "file doesn't exist"
  (`src/storage/cloud-provider.abort.test.js`).
- The browser IndexedDB provider must read back exactly what it writes, return empty
  string (not throw) for a missing path, build a correctly nested file tree, and scaffold
  plan/completed files only when they do not already exist
  (`src/storage/indexeddb-provider.test.js`).
- OneDrive listings that touch journal ids must follow `@odata.nextLink` fully — stopping
  at the first page risks missing a high journal id and colliding IDs
  (`src/storage/onedrive-provider.pagination.test.js`).
- Sync-status change detection must ignore fields like `lastRemoteUpdate` that tick on
  every poll without representing a real status change, and the coalescer built on top of
  it must apply the first real change immediately, collapse a rapid burst to its final
  state, and never re-apply when a burst ends where it began
  (`src/storage/syncStatus.test.js`, `src/storage/syncStatusCoalesce.test.js`).

## Record-level sync (folder-sync)

- A stale full-file replica must never resurrect a delete; an alive sidecar entry with no
  matching record must never win as `undefined` content; a delete must beat an alive write
  at an equal clock; the merge must be deterministic and convergent on ties; and it must
  report no change when both sides already agree (`packages/folder-sync/src/merge.test.js`).
- A remote record with no sidecar meta must never be frozen at a durable clock of `0` —
  that is a within-merge sentinel only, never a stored fact — while an *explicit* clock-0
  stamp (a deliberate "this side is weak" marker) must be preserved as-is.
- A tombstoned row that merely reappears in a stale file (a "ghost") must not be revived;
  it is revived only when its content's fingerprint genuinely differs from the fingerprint
  recorded at delete time.
- An empty parsed record set arriving alongside many still-tracked alive rows must be
  treated as a load failure, not a full-board delete, while a genuine single-row (or
  all-but-one) removal must still be tombstoned correctly
  (`packages/folder-sync/src/records.test.js`).
- Remote-deletion propagation must delete a synced file that vanished remotely, never
  delete a file with a pending local change, ignore sidecar/record-level files, and never
  delete a local-only file on a fresh connect (`packages/folder-sync/src/reconcile.test.js`).
- The markdown-table codec must round-trip unchanged content byte-for-byte, drop deleted
  rows on serialize, and insert a remotely-added row under the correct section
  (`packages/folder-sync/src/codecs/mdTable.test.js`).
- Diagnostic logging during a sync must summarize an unchanged collection rather than
  logging every unchanged record, so genuine pulls/conflicts are not drowned in noise
  (`packages/folder-sync/src/diagnosticVolume.test.js`).

## Telegram mirror (telegram-bridge)

- The digest must be ordered by the active board's own Today/Deferred/urgency structure,
  never by raw task-ID magnitude, and must sink anything not on the board to the bottom
  (`packages/telegram-bridge/src/board.test.js`).
- `syncUp` must post a task's latest agent turn exactly once per change, must stamp a
  deep-link marker into the journal, must skip journals with no agent block, and must
  honor an explicit task allow-list; baseline must mark existing tasks seen without
  posting, and must never clobber a task with genuine posted history
  (`packages/telegram-bridge/src/bridge.test.js`).
- A batched reply typed in the group's General thread must be split per named task, with
  each segment's text folded in **verbatim**, ignoring numbers that are not known task IDs
  (`packages/telegram-bridge/src/routeReply.test.js`).
- An ask must always be read from a task's *newest* agent turn, never a whole-file grep
  for the last marker, and a boilerplate-salvaged ask must be marked weak so callers can
  gate on confidence (`packages/telegram-bridge/src/digest.test.js`).
- Deletion tombstones must be read strictly (`deleted === true`, not merely truthy) to
  decide which forum topics to close (`packages/telegram-bridge/src/deleted.test.js`).
- Every outbound HTTP request must carry an `AbortSignal` so it cannot hang forever, while
  a long-poll `getUpdates` request's budget must be extended, not shortened, to match its
  poll window (`packages/telegram-bridge/src/telegramClient.test.js`).
- Markdown-to-Telegram-HTML conversion must never leave literal formatting characters
  behind, must escape stray HTML-significant characters in prose, and must drop
  constructs (horizontal rules) that Telegram's HTML subset cannot represent
  (`packages/telegram-bridge/src/telegramFormat.test.js`).

## Shared configuration and diagnostics

- `user-settings.md` round-trip: rewriting every row with its own unchanged value must
  return the file byte-for-byte identical; changing one field must touch only that cell's
  bytes; CRLF endings, unusual padding, and escaped pipes in values must all survive
  (`src/config/userSettingsForm.test.js`).
- `AGENTS.md` scaffolding must write when missing (including when the provider throws
  rather than returning empty), must not rewrite an already-current copy, must refresh a
  stale-versioned copy, and must never throw even when the write itself fails
  (`src/config/agentsDoc.test.js`).
- The diagnostics event bus must be a cheap no-op when disabled, must never emit console
  traffic as a side effect of recording, must keep each context's buffer bounded as a
  ring, and must correctly select the folder-sync worker (not the root app worker) when
  asked for a worker dump (`packages/diagnostics/src/index.test.js`).
- The MCP secrets pointer-file schema must accept its own committed example, reject a
  missing version/required field/invalid env-var name/duplicate server or target, and
  throw with every violation listed, not just the first
  (`packages/mcp-cred-vault/src/schema.test.js`).

## Overnight Agent self-verification

The Overnight Agent's `checks/` suite is not exercised by the root vitest run; its
`mutcheck-*.mjs` scripts are themselves the tests, each proving that its paired sweep
fails when the specific defect it guards is reintroduced (see
[Domain-overnight-agent](Domain-overnight-agent)). A rebuild that adds a new sweep without
a paired mutcheck has, by this domain's own standard, added an unverified rule.
