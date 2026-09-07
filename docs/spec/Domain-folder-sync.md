# Domain: folder-sync

`folder-sync` is the planner's browser-side sync substrate: a local-first API on the main thread, a service worker that drains queued writes and pulls remote changes, a record-level merge core for planner boards, and provider adapters for OneDrive, Google Drive, and a mock backend. It exists so the app can keep working offline while converging back to the same markdown files across devices. See [Architecture](Architecture), [Reliability](Reliability), and [Domain-storage](Domain-storage).

## Responsibility

The design rejects whole-file last-write-wins for planner boards. `packages/folder-sync/src/merge.js` says the merge unit is a *record* keyed by stable id, not the whole file, and that deletes are carried as tombstones so a stale replica cannot resurrect a row another device deleted. `packages/folder-sync/src/records.js` then turns that rule into an end-to-end reconcile: parse local and remote text through a codec, stamp local edits with logical clocks, merge per record, preserve sidecar metadata, and write the merged content plus sidecar back to whichever side changed. The service worker keeps that loop running even when the UI is backgrounded.

```js
export function mergeCollections(local = {}, remote = {}, opts = {}) {
  const { now = Date.now(), normalizeZeroClock = true } = opts
  ...
  return {
    records: mergedRecords,
    meta: mergedMeta,
    localChanged: !snapshotEqual(localSnap, { records: mergedRecords, meta: mergedMeta }),
    remoteChanged: !snapshotEqual(remoteSnap, { records: mergedRecords, meta: mergedMeta }),
  }
}
```

## Modules and exports

| Path | Exports from `spec-facts.json` | Role |
| --- | --- | --- |
| `packages/folder-sync/src/adapters/browserStorage.js` | `browserStorageAdapter` | Browser local-storage style adapter; default local store for consumers. |
| `packages/folder-sync/src/adapters/fsa.js` | `fsaAdapter` | File System Access API adapter. |
| `packages/folder-sync/src/auth/pkce.js` | `base64UrlEncode`, `generateCodeChallenge`, `generateCodeVerifier`, `generateState` | Shared OAuth PKCE helpers. |
| `packages/folder-sync/src/auth/tokenStore.js` | `clearTokens`, `getTokens`, `isExpired`, `setTokens` | IndexedDB-backed token store per provider. |
| `packages/folder-sync/src/codecs/mdTable.js` | `FRAME_ID`, `mdTableCodec`, `parse`, `serialize` | Planner-board codec: markdown tables plus preserved frame text. |
| `packages/folder-sync/src/engine.js` | `createSyncEngine`, `registerServiceWorker` | Main-thread consumer API and SW registration helper. |
| `packages/folder-sync/src/idb.js` | `idbDel`, `idbEntries`, `idbGet`, `idbKeys`, `idbSet`, `openDB` | Minimal IndexedDB primitives shared by page and worker. |
| `packages/folder-sync/src/index.js` | `browserStorageAdapter`, `createSyncEngine`, `fsaAdapter`, `googleDriveProvider`, `mockProvider`, `oneDriveProvider`, `registerServiceWorker` | Public package surface. |
| `packages/folder-sync/src/merge.js` | `findAliveWithoutRecord`, `fingerprint`, `gcTombstones`, `isCollapse`, `mergeCollections`, `parseSidecar`, `reconcileExternal`, `serializeSidecar`, `stampDelete`, `stampLocalChanges`, `stampWrite` | Pure record-level conflict resolution. |
| `packages/folder-sync/src/mutcheck-meta-nodrop.mjs` | — | Mutation harness proving the phantom-meta guard is load-bearing. |
| `packages/folder-sync/src/providers/googleDrive.js` | `googleDriveProvider` | Google Drive appDataFolder transport and OAuth flow. |
| `packages/folder-sync/src/providers/mock.js` | `mockProvider` | IndexedDB-only mock remote for offline tests. |
| `packages/folder-sync/src/providers/oneDrive.js` | `listFolderRecursive`, `oneDriveProvider` | OneDrive AppFolder transport with recursive pagination. |
| `packages/folder-sync/src/queue.js` | `dequeue`, `enqueue`, `has`, `peekAll` | Persistent dirty-file queue. |
| `packages/folder-sync/src/reconcile.js` | `filesToDeleteLocally`, `isConsumerVisibleMirrorPath`, `isMassDeletion`, `isValidRemotePath`, `mtimeKeysForProvider`, `planMirrorSync`, `planPlainPush`, `shouldPullRemote` | Pure decision logic for pushes, pulls, mirror repair, and deletion propagation. |
| `packages/folder-sync/src/records.js` | `frameHasStructure`, `framePriorityCount`, `isSidecarPath`, `preferPopulatedPriorityFrame`, `preferStructuredFrame`, `reconcileRecordsFile`, `sidecarPath` | File-level reconcile around the merge core. |
| `packages/folder-sync/src/sw.js` | — | Background sync worker and record-codec dispatch. |

## Central mechanics

`packages/folder-sync/src/codecs/mdTable.js` preserves structure separately from rows. It parses each planner table row into an id-keyed record and stores everything else in a `FRAME_ID` record so headings, separators, blank lines, and the ordered Priorities list survive round-trips. `packages/folder-sync/src/records.js` explicitly overrides a merged frame when last-write-wins would otherwise pick an empty or structureless frame, or would keep a structured frame whose Priorities section lost all items. `packages/folder-sync/src/reconcile.js` carries the same bias toward preservation for plain files: first contact never overwrites pre-existing remote data, mirror replay only writes when active content diverges, and "mass deletion" means "remote probably partial or wiped" rather than "delete everything locally".

The engine and worker split responsibilities cleanly. `packages/folder-sync/src/engine.js` performs immediate local reads and writes, mirrors those writes into IndexedDB, enqueues names, handles OAuth redirects, and nudges the service worker. `packages/folder-sync/src/sw.js` lists the remote up front, uses record-level reconcile for `planner.md`, `planner-completed.md`, `focus-plan.md`, and `focus-plan-completed.md`, and falls back to plain-file push/pull rules for everything else. Provider modules keep OAuth and HTTP details transport-specific: `packages/folder-sync/src/providers/oneDrive.js` follows `@odata.nextLink` recursively, and `packages/folder-sync/src/providers/googleDrive.js` paginates `files.list` so overflow never disappears after the first page.

## Behavioural requirements from tests

The domain's behavioural spec comes from `packages/folder-sync/src/codecs/mdTable.test.js`, `packages/folder-sync/src/diagnosticVolume.test.js`, `packages/folder-sync/src/merge.test.js`, `packages/folder-sync/src/providers/oneDrive.pagination.test.js`, `packages/folder-sync/src/reconcile.test.js`, and `packages/folder-sync/src/records.test.js`.

- `mergeCollections` keeps add/add rows from both sides, lets newer edits win, lets deletes beat equal-clock live writes, breaks live/live ties deterministically by content, and reports no change when both snapshots already agree.
- An alive sidecar entry with no parsed row must never win as `undefined` content. The merge treats that side as unusable record content, preserving crash resistance and logging `phantom-meta-preserved` when only metadata survives.
- The implicit zero-clock sentinel is temporary. A remote row that arrived without metadata may lose *this* merge at clock `0`, but `packages/folder-sync/src/merge.test.js` requires that sentinel not be frozen into durable sidecar state.
- Record reconcile preserves planner shape. `packages/folder-sync/src/records.test.js` requires first push to create remote content and sidecar, concurrent edits to different rows to survive together, stale local emptiness not to strip section headings, and a structured-but-empty Priorities frame not to wipe the list.
- `packages/folder-sync/src/reconcile.test.js` requires first-contact pushes to avoid destructive overwrite: untracked local deletes do not remove pre-existing remote files, untracked local content does not overwrite an existing remote file, but tracked files do update or delete normally.
- Remote deletions propagate locally only when safe: sidecars and record-level files are excluded, pending local changes block deletion, candidates are deduplicated, and a fresh provider connect never deletes local-only files.
- `packages/folder-sync/src/providers/oneDrive.pagination.test.js` requires recursive listing to follow pagination and to treat a missing app folder as `[]`, not as a fatal error.
- `packages/folder-sync/src/diagnosticVolume.test.js` requires summary diagnostics instead of one event per unchanged mirror file or per first-contact skip.

## Failure modes

This domain treats silent data loss as the primary enemy. The failure modes named in code are: a stale device resurrects a deleted board row; an empty load is misread as a whole-board delete; an alive sidecar row with no parsed content crashes fingerprinting; a newly connected provider clobbers cloud data it has never seen; pagination hides journals in subfolders; and a poison filename blocks the queue forever because the remote rejects it. The consistent mitigation is to preserve evidence, prefer non-destructive interpretations, and keep the decision logic pure enough that the test suite can pin each branch directly.
