# Domain: folder-sync

`folder-sync` (`packages/folder-sync/`) is the record-level CRDT sync engine that keeps a local
replica of `planner.md`/`planner-completed.md` and journals reconciled against a cloud provider
without ever losing a concurrent edit or resurrecting a row another device deleted.

## Responsibility

Replace naive whole-file last-write-wins sync (which loses concurrent edits and resurrects deleted
rows) with **per-record** reconciliation: parse a markdown file into id-keyed records via a
declarative codec, stamp each record with a logical clock on every local change, merge per-record
with tombstones against the remote, and write the merged result back to whichever side changed. It
runs as a service worker so sync survives a closed tab and can retry without the main thread's help.

## Principal modules

| Path | Purpose |
| --- | --- |
| `packages/folder-sync/src/merge.js` | The pure CRDT core: `mergeCollections`, `stampWrite`/`stampDelete`, `stampLocalChanges`, `gcTombstones`, `fingerprint`, `parseSidecar`/`serializeSidecar`, `reconcileExternal`. No I/O; exhaustively unit-testable. |
| `packages/folder-sync/src/records.js` | Record-level reconcile for one file: parse both sides → detect changes → merge with tombstones → write back. The operation that actually fixes "deleted rows reappear". |
| `packages/folder-sync/src/codecs/mdTable.js` | Generic markdown-table-sections codec: file text → `{ records, frame }`, and back. App-agnostic beyond "tables have an id in column 0". |
| `packages/folder-sync/src/engine.js` | Consumer-facing API: local-first reads/writes, enqueues dirty filenames, launches OAuth consent flows, relays SW status via `BroadcastChannel`. |
| `packages/folder-sync/src/sw.js` | The service worker: drains the dirty-file queue, pulls remote changes, runs the codec + merge + reconcile pipeline. |
| `packages/folder-sync/src/reconcile.js` | Pure decision logic for propagating remote *deletions* to the local store and for whole-file (non-record) sync fallback (`planPlainPush`, `filesToDeleteLocally`, `isMassDeletion`). |
| `packages/folder-sync/src/queue.js` | The dirty-file queue, persisted in IndexedDB so enqueued writes survive a reload. |
| `packages/folder-sync/src/idb.js` | A minimal IndexedDB helper shared between window and service-worker contexts. |
| `packages/folder-sync/src/providers/oneDrive.js` / `googleDrive.js` / `mock.js` | Remote transports; `mock.js` simulates a remote purely in IndexedDB for offline testing of the full engine+SW round trip. |

## Public exports

`createSyncEngine`, `registerServiceWorker`, `browserStorageAdapter`, `fsaAdapter`,
`googleDriveProvider`, `oneDriveProvider`, `mockProvider` (from `index.js`).

## Behavioural requirements (from the folder-sync test suite, 6 files / 126 tests)

- **The merge unit is a record, not a file.** `mergeCollections` keeps records added on either side,
  never resurrects a delete via a stale full-file replica, never lets an alive sidecar entry with no
  record win as `undefined` content (the guard for a real OneDrive crash), and is deterministic and
  convergent on clock ties.
- **An implicit zero-clock sentinel must never become durable state (#280).** A remote record with
  no meta entry is *not* persisted at clock 0 as if that were a real timestamp; the sentinel still
  loses ties inside the merge it was created for; a tombstone is never "strengthened" back to a
  non-zero clock; an *explicitly* stamped clock 0 (a genuinely weak remote) is left weak, not
  normalized away.
- **A live meta entry is never dropped with no tombstone (#190) — "the silent void".** When a
  parsed record is missing on both sides but its meta says alive, the entry is preserved *alive*
  (never silently turned into a tombstone), stamped with the highest known alive clock, emits no
  record (preserving the fingerprint-crash guard from #46), and logs an anomaly rather than being a
  silent no-op — this is exactly the defect that made task #228's board row vanish while its journal
  stayed live and unreachable.
- **An empty record set must not wipe the board (#371 collapse guard).** `isCollapse` flags "empty
  records + 2+ previously alive rows" as a collapse (a parse failure masquerading as "everything was
  deleted"); `stampLocalChanges`/`reconcileExternal` refuse to tombstone every row in that case,
  while still correctly tombstoning a genuine single-row removal — the guard is opt-out so a real
  full clear can still be stamped when that is truly what happened.
- **Deletion propagation never destroys unsynced work.** `filesToDeleteLocally` never deletes a file
  with a pending local change, never deletes a local-only file on a fresh connect (candidates are
  tracked files only), and deduplicates candidates from overlapping sources.
- **Remote pagination is exhaustive.** `listFolderRecursive` follows `@odata.nextLink` so files past
  the first page are never dropped, and correctly returns `[]` (not an error) when the app folder
  does not exist yet.
- **Sync noise is suppressed at the log level.** No diagnostic record is emitted for every unchanged
  mirror file or every up-to-date remote poll; an unchanged collection is summarized, not logged row
  by row — otherwise routine sync would flood diagnostics into uselessness.

## Failure modes guarded against

The dominant failure class this domain exists to close is **silent data loss disguised as a no-op**:
a deleted row reappearing, a live row vanishing with no tombstone, an entire board reading as
"cleared" because a parse hiccuped rather than because the user actually deleted everything. Every
test above pins one specific shape of that class, several tied to a numbered issue (#46, #190, #228,
#280, #371) where it was originally observed live.
