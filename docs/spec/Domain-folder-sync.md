# Domain: folder-sync

## Responsibility

A transport-agnostic sync engine (`packages/folder-sync`) that keeps a browser's local mirror of the
planner folder consistent with a cloud remote (OneDrive or Google Drive) across multiple devices,
without ever letting one device's stale state resurrect another device's delete. It runs partly on the
main thread (`engine.js` — reads/writes go to the local adapter immediately, then enqueue for sync) and
partly in a registered Service Worker (`sw.js` — drains the dirty-file queue and pulls remote changes),
communicating status back via `BroadcastChannel`.

## Principal modules

| Module | Role |
| --- | --- |
| `packages/folder-sync/src/merge.js` | The pure conflict-resolution core: record-level last-write-wins with tombstones. No I/O, no deps — exhaustively unit-testable and identical on both sides of the worker boundary. |
| `packages/folder-sync/src/records.js` | Per-file record-level reconcile: parse both sides via a codec, stamp local changes, merge, write back whichever side(s) changed. |
| `packages/folder-sync/src/codecs/mdTable.js` | Declarative markdown-table-sections codec — turns a planner-style file into id-keyed records plus a "frame" (every non-row line) for faithful reconstruction. |
| `packages/folder-sync/src/reconcile.js` | Pure decision logic for whole-file sync: which files to delete locally when they vanish from the remote listing, and whether/when to pull. |
| `packages/folder-sync/src/engine.js`, `sw.js` | The consumer API and the Service Worker that actually drains the queue and calls the providers. |
| `packages/folder-sync/src/providers/oneDrive.js`, `googleDrive.js`, `mock.js` | Provider descriptors (serializable, sent to the SW via `postMessage`) plus the HTTP helpers each needs. |
| `packages/folder-sync/src/queue.js`, `idb.js` | The IndexedDB-backed dirty-file queue and a minimal cross-context (window/SW) IndexedDB helper. |

## Public surface (representative exports)

`createSyncEngine, registerServiceWorker` (`engine.js`/`index.js`); `mergeCollections, stampWrite,
stampDelete, stampLocalChanges, reconcileExternal, gcTombstones, findAliveWithoutRecord` (`merge.js`);
`reconcileRecordsFile, preferPopulatedPriorityFrame` (`records.js`); `mdTableCodec, parse, serialize`
(`codecs/mdTable.js`); `filesToDeleteLocally, planMirrorSync, planPlainPush, shouldPullRemote,
isMassDeletion, isValidRemotePath` (`reconcile.js`).

## Behavioural requirements (from tests)

- **A delete is never resurrected by a stale full-file replica** — the central guarantee of
  `mergeCollections`, proven directly (`merge.test.js`: "THE BUG: a delete is not resurrected by a
  stale full-file replica").
- **An alive-but-recordless sidecar entry must not crash the merge as `undefined` content**, and must
  not be silently voided into a tombstone either — it is preserved alive, its clock raised to the
  highest known value, and a diagnostic anomaly is logged (issue #190, the root cause of task #228's
  invisible live journal).
- **A zero clock is only ever an implicit "we don't know" during one merge**, never a durable value —
  an unmet-ed remote record must not be permanently frozen at clock 0 (issue #280).
- **An empty record set is refused as "everything was deleted"** unless the caller opts out — a
  collapse detector (`isCollapse`) distinguishes a genuine full clear from a parse failure that
  happened to yield zero records (issue #371).
- **`isMassDeletion` flags a full wipe but not a normal single deletion**, and never fires when nothing
  is tracked yet (no baseline to compare against).
- **`planMirrorSync` rehydrates a file missing from the active store** (the "stranded journal" bug) and
  never treats an empty mirror file the active store also lacks as a deletion to propagate.
- **`isValidRemotePath` rejects a source-scoped key that leaked into the sync queue** (the OneDrive 400
  bug) and every character a provider forbids in a path segment.

## Failure modes this domain guards against

- **"Deleted rows reappear"** — the reason the merge unit is a record, not a whole file: a stale
  replica can overwrite unrelated rows in a whole-file last-write-wins scheme even when it has no idea
  a particular row was deleted.
- **The #46 fingerprint crash** — preserving a phantom alive-but-recordless entry must never itself
  emit a record, or the same crash it was written to prevent recurs one call later.
- **Structured content silently overwritten by an empty frame** — `preferStructuredFrame` /
  `preferPopulatedPriorityFrame` restore a structured or populated side when a merge would otherwise
  emit an empty `## Priorities` list or a headerless frame, guarding two historically-observed corruption
  shapes ("BLANK-PLANNER BUG", "PRIORITIES-WIPE BUG" in `records.test.js`).
- **Legacy heading names** — `framePriorityCount` still recognizes the old `Work Priorities` /
  `Manager Priorities` headings so an unmigrated file's priority list is still counted rather than read
  as empty; this is a compatibility path scheduled for removal once #207/#8 land, not part of the
  forward contract.
