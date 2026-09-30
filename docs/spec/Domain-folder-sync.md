# Domain: folder-sync

`folder-sync` is the planner's browser-side sync substrate: a local-first API on the main thread, a service worker that drains queued writes and pulls remote changes, a record-level merge core for planner boards, and provider adapters for OneDrive, Google Drive, and a mock backend. It exists so the app can keep working offline while converging back to the same markdown files across devices. See [Architecture](Architecture), [Reliability](Reliability), and [Domain-storage](Domain-storage).

## Responsibility

The design rejects whole-file last-write-wins for planner boards. `packages/folder-sync/src/merge.js` says the merge unit is a *record* keyed by stable id, not the whole file, and that deletes are carried as tombstones so a stale replica cannot resurrect a row another device deleted. `packages/folder-sync/src/records.js` then turns that rule into an end-to-end reconcile: parse local and remote text through a codec, stamp local edits with logical clocks, merge per record, preserve sidecar metadata, and write the merged content plus sidecar back to whichever side changed. The service worker keeps that loop running even when the UI is backgrounded.

> [!NOTE]
> **Technical detail: concrete example** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

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


</details>
## Modules and exports

> [!NOTE]
> **Technical detail: concrete reference.** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

| Path | Exports from `spec-facts.json` | Role |
| --- | --- | --- |
| `packages/folder-sync/src/adapters/browserStorage.js` | `browserStorageAdapter` | Browser local-storage style adapter; default local store for consumers. |
| `packages/folder-sync/src/adapters/fsa.js` | `fsaAdapter` | File System Access API adapter. |
| `packages/folder-sync/src/auth/pkce.js` | `base64UrlEncode`, `generateCodeChallenge`, `generateCodeVerifier`, `generateState` | Shared OAuth PKCE helpers. |
| `packages/folder-sync/src/auth/tokenStore.js` | `clearTokens`, `getTokens`, `isExpired`, `setTokens` | IndexedDB-backed token store per provider. |
| `packages/folder-sync/src/codecs/mdTable.js` | `FRAME_ID`, `mdTableCodec`, `parse`, `serialize` | Planner-board codec: markdown tables plus preserved frame text. |
| `packages/folder-sync/src/engine.js` | `createSyncEngine`, `readAuthResponseParams`, `recentAutoReconnects`, `registerServiceWorker` | Main-thread consumer API, OAuth redirect handling (query `code` or fragment `access_token`), auto-reconnect with a redirect-loop guard, and SW registration helper. |
| `packages/folder-sync/src/idb.js` | `idbDel`, `idbEntries`, `idbGet`, `idbKeys`, `idbSet`, `openDB` | Minimal IndexedDB primitives shared by page and worker. |
| `packages/folder-sync/src/index.js` | `browserStorageAdapter`, `createSyncEngine`, `fsaAdapter`, `googleDriveProvider`, `mockProvider`, `oneDriveProvider`, `registerServiceWorker` | Public package surface. |
| `packages/folder-sync/src/merge.js` | `findAliveWithoutRecord`, `fingerprint`, `gcTombstones`, `isCollapse`, `mergeCollections`, `parseSidecar`, `reconcileExternal`, `serializeSidecar`, `stampDelete`, `stampLocalChanges`, `stampWrite` | Pure record-level conflict resolution. |
| `packages/folder-sync/src/mutcheck-meta-nodrop.mjs` | — | Mutation harness proving the phantom-meta guard is load-bearing. |
| `packages/folder-sync/src/providers/googleDrive.js` | `buildAuthUrl`, `completeAuth`, `googleDriveProvider` | Google Drive appDataFolder transport and OAuth 2.0 token-model (implicit) flow with silent `prompt=none` renewal. |
| `packages/folder-sync/src/providers/mock.js` | `mockProvider` | IndexedDB-only mock remote for offline tests. |
| `packages/folder-sync/src/providers/oneDrive.js` | `listFolderRecursive`, `oneDriveProvider` | OneDrive AppFolder transport with recursive pagination. |
| `packages/folder-sync/src/queue.js` | `dequeue`, `enqueue`, `has`, `peekAll` | Persistent dirty-file queue. |
| `packages/folder-sync/src/reconcile.js` | `filesToDeleteLocally`, `isConsumerVisibleMirrorPath`, `isMassDeletion`, `isValidRemotePath`, `mtimeKeysForProvider`, `planMirrorSync`, `planPlainPush`, `shouldPullRemote` | Pure decision logic for pushes, pulls, mirror repair, and deletion propagation. |
| `packages/folder-sync/src/records.js` | `frameHasStructure`, `framePriorityCount`, `isSidecarPath`, `preferPopulatedPriorityFrame`, `preferStructuredFrame`, `reconcileRecordsFile`, `sidecarPath` | File-level reconcile around the merge core. |
| `packages/folder-sync/src/sw.js` | — | Background sync worker and record-codec dispatch. |

</details>

## Central mechanics

`packages/folder-sync/src/codecs/mdTable.js` preserves structure separately from rows. It parses each planner table row into an id-keyed record and stores everything else in a `FRAME_ID` record so headings, separators, blank lines, and the ordered Priorities list survive round-trips. `packages/folder-sync/src/records.js` explicitly overrides a merged frame when last-write-wins would otherwise pick an empty or structureless frame, or would keep a structured frame whose Priorities section lost all items. `packages/folder-sync/src/reconcile.js` carries the same bias toward preservation for plain files: first contact never overwrites pre-existing remote data, mirror replay only writes when active content diverges, and "mass deletion" means "remote probably partial or wiped" rather than "delete everything locally".

The engine and worker split responsibilities cleanly. `packages/folder-sync/src/engine.js` performs immediate local reads and writes, mirrors those writes into IndexedDB, enqueues names, handles OAuth redirects, and nudges the service worker. `packages/folder-sync/src/sw.js` lists the remote up front, uses record-level reconcile for `planner.md`, `planner-completed.md`, `focus-plan.md`, and `focus-plan-completed.md`, and falls back to plain-file push/pull rules for everything else. With several targets connected, each cycle first fans the shared dirty queue out to a per-provider pending list (`pending:<id>` in the meta store, ordered by `planProviderPush`: board files, then fresh edits, then other markdown, then everything else). It then pushes to every provider before pulling from any, so each target receives every edit and one target's large pull cannot delay another target's backup. Previously a single queue was dequeued by whichever provider synced first, so with OneDrive and Google Drive both connected, Google Drive received nothing. On true first contact (a provider with no tracked files and no `seeded:<id>` marker), the pending list is seeded with the whole local mirror, so a newly connected target gets a full backup under the usual first-contact rules. A per-provider push budget (60 s per cycle) with progress saved after every file lets a large seed resume across service-worker restarts, and a follow-up cycle is scheduled until it drains. Disconnect clears the provider's mtimes, pending list and seed marker. Provider modules keep OAuth and HTTP details transport-specific: `packages/folder-sync/src/providers/oneDrive.js` follows `@odata.nextLink` recursively, and `packages/folder-sync/src/providers/googleDrive.js` paginates `files.list` so overflow never disappears after the first page.

Google Drive authenticates differently from OneDrive. Google's token endpoint refuses the app's "Web application" OAuth client without its `client_secret`, even with PKCE (`invalid_request: client_secret is missing.`), and the static site has no backend to hold a secret. So `googleDrive.js` uses Google's browser-safe token model: `response_type=token` returns an access token (about 1 hour, no refresh token) in the redirect fragment, and the engine reads it with `readAuthResponseParams` and then strips the fragment. When the token expires, or Drive answers 401, the provider reports `reconnect-required` and keeps its token record. The engine's auto-reconnect then renews with a silent `prompt=none` redirect, using the stored account email as `login_hint`. That redirect returns straight to the app while the user is still signed in to Google. Auto-reconnect is deferred while a text field is focused, so it never navigates away mid-edit. It is also limited to one failed attempt per tab session and two attempts per provider in any 10 minutes, so a sign-in that keeps "succeeding" with tokens the API then rejects can never become a redirect loop. If silent renewal needs interaction (`#error=interaction_required`), the target shows "Sign in again" and a click runs the interactive flow. The OAuth client must list the app origin under Authorized JavaScript origins and the exact `origin + pathname` (`https://plannermd.com/`, `http://localhost:5173/`) under Authorized redirect URIs.

## Behavioural requirements from tests

The domain's behavioural spec comes from `packages/folder-sync/src/codecs/mdTable.test.js`, `packages/folder-sync/src/diagnosticVolume.test.js`, `packages/folder-sync/src/engine.authParams.test.js`, `packages/folder-sync/src/merge.test.js`, `packages/folder-sync/src/providerPush.test.js`, `packages/folder-sync/src/providers/googleDrive.auth.test.js`, `packages/folder-sync/src/providers/oneDrive.pagination.test.js`, `packages/folder-sync/src/reconcile.test.js`, and `packages/folder-sync/src/records.test.js`.

- `mergeCollections` keeps add/add rows from both sides, lets newer edits win, lets deletes beat equal-clock live writes, breaks live/live ties deterministically by content, and reports no change when both snapshots already agree.
- An alive sidecar entry with no parsed row must never win as `undefined` content. The merge treats that side as unusable record content, preserving crash resistance and logging `phantom-meta-preserved` when only metadata survives.
- The implicit zero-clock sentinel is temporary. A remote row that arrived without metadata may lose *this* merge at clock `0`, but `packages/folder-sync/src/merge.test.js` requires that sentinel not be frozen into durable sidecar state.
- Record reconcile preserves planner shape. `packages/folder-sync/src/records.test.js` requires first push to create remote content and sidecar, concurrent edits to different rows to survive together, stale local emptiness not to strip section headings, and a structured-but-empty Priorities frame not to wipe the list.
- `packages/folder-sync/src/reconcile.test.js` requires first-contact pushes to avoid destructive overwrite: untracked local deletes do not remove pre-existing remote files, untracked local content does not overwrite an existing remote file, but tracked files do update or delete normally.
- Remote deletions propagate locally only when safe: sidecars and record-level files are excluded, pending local changes block deletion, candidates are deduplicated, and a fresh provider connect never deletes local-only files.
- `packages/folder-sync/src/providers/oneDrive.pagination.test.js` requires recursive listing to follow pagination and to treat a missing app folder as `[]`, not as a fatal error.
- `packages/folder-sync/src/providers/googleDrive.auth.test.js` requires Google sign-in to request `response_type=token` (never an auth code or refresh token), to renew with `prompt=none` plus the remembered `login_hint`, to ignore responses whose `state` is not its own, to surface a refused silent renewal as an error, and to map token expiry and Drive 401s to `reconnect-required` without calling Google or discarding the record. `packages/folder-sync/src/engine.authParams.test.js` requires auth responses to be read from the query (`code`) or fragment (`access_token`/`error`) only when `state` is present, and the loop guard to count only attempts from the last 10 minutes.
- `packages/folder-sync/src/providerPush.test.js` requires every provider to receive each queued edit, per-provider pending names to carry over and dedupe, a first-contact seed ordered board files first, then edits, then other markdown, then other files, sidecars and unsyncable names to be dropped, and disconnect cleanup to select only that provider's mtime, pending and seed keys.
- `packages/folder-sync/src/diagnosticVolume.test.js` requires summary diagnostics instead of one event per unchanged mirror file or per first-contact skip.

## Failure modes

This domain treats silent data loss as the primary enemy. The failure modes named in code are: a stale device resurrects a deleted board row; an empty load is misread as a whole-board delete; an alive sidecar row with no parsed content crashes fingerprinting; a newly connected provider clobbers cloud data it has never seen; pagination hides journals in subfolders; and a poison filename blocks the queue forever because the remote rejects it. The consistent mitigation is to preserve evidence, prefer non-destructive interpretations, and keep the decision logic pure enough that the test suite can pin each branch directly.
