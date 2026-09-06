# Domain: folder-sync

## Responsibility

`packages/folder-sync` is the generic, app-agnostic sync engine underneath the `storage` domain's
cloud providers: a service worker that drains a dirty-file queue, pulls remote changes, and resolves
conflicts at the **record** level rather than the whole-file level, so two devices editing different
rows of `planner.md` never let one replica silently destroy the other's edit.

## Principal modules

| Path | Exports | Role |
| --- | --- | --- |
| `packages/folder-sync/src/engine.js` | `createSyncEngine`, `registerServiceWorker` | Consumer-facing API: local reads/writes are immediate, writes enqueue for the service worker, status comes back via `BroadcastChannel`. |
| `packages/folder-sync/src/sw.js` | (service worker, no exports) | Drains the dirty-file queue and pulls remote changes; registered as an ES module. |
| `packages/folder-sync/src/merge.js` | `mergeCollections`, `stampWrite`, `stampDelete`, `parseSidecar`, `serializeSidecar`, `gcTombstones`, `reconcileExternal`, `fingerprint`, `isCollapse` | **Tier A conflict resolution**: record-level last-write-wins with tombstones. Pure, dependency-free, exhaustively unit-testable. |
| `packages/folder-sync/src/records.js` | `reconcileRecordsFile`, `sidecarPath`, `isSidecarPath`, `preferStructuredFrame`, `preferPopulatedPriorityFrame` | Per-file reconcile: parse both sides into records via a codec, stamp local changes, merge with tombstones, write back whichever side(s) changed. Transport-agnostic — usable from both the service worker and the main-thread engine. |
| `packages/folder-sync/src/codecs/mdTable.js` | `mdTableCodec`, `parse`, `serialize`, `FRAME_ID` | Turns a planner-style markdown file (`##` sections containing pipe tables) into id-keyed records plus a "frame" capturing every non-row line, so the file round-trips faithfully. |
| `packages/folder-sync/src/reconcile.js` | `filesToDeleteLocally`, `shouldPullRemote`, `planMirrorSync`, `planPlainPush`, `isMassDeletion`, `isConsumerVisibleMirrorPath` | Pure decision logic for propagating remote deletions to the local store, without touching IndexedDB or the network. |
| `packages/folder-sync/src/queue.js` | `enqueue`, `dequeue`, `has`, `peekAll` | Dirty-file queue persisted in IndexedDB so writes survive reloads. |
| `packages/folder-sync/src/idb.js` | `openDB`, `idbGet`, `idbSet`, `idbDel`, `idbKeys`, `idbEntries` | Minimal IndexedDB helper working in both window and service-worker contexts (single DB `folder-sync`, stores `tokens`/`queue`/`meta`/`fsa`). |
| `packages/folder-sync/src/auth/pkce.js`, `auth/tokenStore.js` | PKCE helpers; `getTokens`/`setTokens`/`isExpired` | Shared OAuth plumbing for the cloud providers. |
| `packages/folder-sync/src/providers/oneDrive.js`, `providers/googleDrive.js`, `providers/mock.js` | `oneDriveProvider`, `googleDriveProvider`, `mockProvider` | Remote-side adapters: serialisable descriptors on the main thread, plain HTTP helpers usable from either realm. |
| `packages/folder-sync/src/adapters/fsa.js`, `adapters/browserStorage.js` | `fsaAdapter`, `browserStorageAdapter` | Local-side adapters. |

## The merge model

A **collection snapshot** is `{ records: { [id]: content }, meta: { [id]: { clock, deleted } } }`.
`clock` is a logical mtime (`Date.now()` at write/delete time). The merge unit is a **record**
(stable id), not the whole file — this is the fix for the historically observed "deleted rows
reappear" bug: deletes are recorded as tombstones, so a stale replica can never resurrect a row another
device deleted, because the tombstone's clock outlives the stale copy's absence of one.

A record present in `records` but missing from `meta` is treated as a legacy/external write with
clock `0` — an *implicit* sentinel meaning "we have no record of when this was written," meant only to
lose ties **during one merge**; it must never be frozen into the sidecar as the row's durable clock
(`normalizeZeroClock`). An *explicit* `{ clock: 0 }` in meta is a different, deliberate "this side is
weak" stamp and is preserved as-is.

`mutcheck-meta-nodrop.mjs` (`packages/folder-sync/src/mutcheck-meta-nodrop.mjs`) is a mutation check
guarding the specific defect this model closed (issue #190): a live meta entry whose parsed record is
missing on **both** sides must never be dropped with no tombstone — that silent void is what made a
task's board row vanish while its journal stayed live and unreachable. The fix preserves the entry,
keeps it alive (not tombstoned), stamps the highest known clock, and emits no record — all four parts
pinned 1:1 by a dedicated mutation arm.

## The codec/frame split

`mdTable.js` is declarative and pure: it knows only "tables have an id in column 0," not any
planner-specific rule, so the same codec instance runs identically in the service worker and on the
main thread. The **frame** is the file text with each data row replaced by a `\u0000ROW:<id>\u0000`
marker, plus per-section insertion anchors, so a row added on another device lands under the correct
heading on reconstruction. See [Data-Formats](Data-Formats) for an annotated sample.

## Behavioural requirements (selected, from the domain's test suites)

- `mergeCollections`: keeps add/add records from both sides; a delete is not resurrected by a stale
  full-file replica; an alive sidecar entry with no record must not win as `undefined` content (the
  "OneDrive crash" regression); a newer edit wins on the same record; delete beats an alive write at
  equal clock (an intentional delete); the merge is deterministic and convergent on alive/alive ties.
- `reconcileRecordsFile`: an empty local file must not strip the remote section headings (the
  "blank-planner" bug); a structured-but-empty-priorities frame must not wipe the `## Priorities`
  list; concurrent edits to different rows both survive; a second no-op sync changes nothing
  (convergence).
- `mdTableCodec`: round-trips unchanged content exactly; drops a deleted row on serialize; inserts a
  row added on another device under its section; extracts an id from a composite first cell (the
  external-ticket link form).
- `filesToDeleteLocally`: never deletes a file with a pending local (offline) change, and never
  deletes a local-only file on a fresh connect — candidates are tracked files only.
- `diagnosticVolume.test.js`: does not emit a diagnostic record for every unchanged mirror file or
  every first-contact skip — only changed decisions and remote pulls are logged, so the diagnostics
  stream summarizes an unchanged collection instead of drowning in per-file no-ops.
- `oneDrive.pagination.test.js`: `listFolderRecursive` follows `@odata.nextLink` so files past the
  first page are not dropped, and returns `[]` (not an error) when the app folder does not exist yet.

## Failure modes

- Any conflict-resolution change here must stay pure (no I/O) so the mutation-testing harness
  (`mutcheck-meta-nodrop.mjs`) can drive it directly against the real `merge.js` — a defect that can
  only be reproduced against live IndexedDB/network is a defect this domain's guard style cannot pin.
- A codec that infers app-specific structure (rather than the generic "id in column 0" rule) would
  break the main-thread/service-worker parity this module depends on for correctness.
