# Domain: storage

The `storage` domain gives the rest of the planner one filesystem-like API while hiding whether the actual backing store is browser IndexedDB, File System Access, OneDrive App Folder, or Google Drive. It also owns the source registry, diagnostics, sync-status translation, and small JSON sidecars stored next to the board. This domain is where user data durability, sync visibility, and cross-source composition are made explicit. See [Architecture](Architecture), [Reliability](Reliability), and [Domain-root](Domain-root).

## Responsibility

`src/storage/storage.js` is the façade. It selects the active provider, maps folder-sync engine state into planner-specific status values, routes writes through the sync engine, scaffolds agent docs, and exposes cross-source helpers for Combined view reads. The module header is intentionally short; the deeper rationale lives in comments inside the file. Examples: tombstoned task IDs are merged into journal-ID skip sets “so a freed ID is not reused while it could still be resurrected by sync”; `subscribeSyncStatus()` deduplicates value-identical status objects because forwarding every service-worker tick “makes React re-render the whole board on every tick”; `updateApp()` exists because installed PWAs do not reliably update service workers without a manual nudge.

## Principal modules

| Path | Role | Why it exists |
| --- | --- | --- |
| `src/storage/storage.js` | Active-provider façade plus sync integration. | Keeps UI code provider-agnostic and preserves one source of truth for reads/writes. |
| `src/storage/sources.js` | Source registry. | Supports multiple named sources while preserving single-source behaviour when only one exists. |
| `src/storage/indexeddb-provider.js` | Default local provider. | Replaces the older localStorage store with async, larger-quota IndexedDB. |
| `src/storage/fsa.js` | File System Access helpers. | Persists a picked directory handle and operates on real local files. |
| `src/storage/onedrive-provider.js` | OneDrive App Folder provider. | Uses Microsoft Graph + PKCE with sandboxed scope. |
| `src/storage/google-drive-provider.js` | Google Drive provider. | Uses Drive API v3 + PKCE under a named root folder. |
| `src/storage/diagnostics.js` | Storage/sync diagnostics snapshot. | Produces a safe report for debugging missing journals, quota, and stale sync. |
| `src/storage/taskSettings.js` | Per-task JSON sidecar. | Stores planner-owned AI toggles separately from human journal prose. |

## Public exports

| Path | Exports from `spec-facts.json` |
| --- | --- |
| `src/storage/storage.js` | `PROVIDERS`, `TARGET_STATUS`, `checkJournal`, `checkJournalFromSource`, `configureLocalFirstStorage`, `connectSyncTarget`, `disconnectSyncTarget`, `ensureAgentsDoc`, `folderName`, `getActiveProvider`, `getAvailableProviders`, `getBuildId`, `getFiles`, `getFilesFromSource`, `getLocalFolderId`, `getProviderName`, `getSyncStatus`, `getTodos`, `getTodosFromSource`, `hasProvider`, `isSupported`, `journalIds`, `journalIdsFromSource`, `maxJournalId`, `maxJournalIdFromSource`, `onLocalChange`, `parseTodos`, `pick`, `read`, `readFromSource`, `registerSyncWorker`, `remove`, `removeFromSource`, `restore`, `restoreSyncTargets`, `scaffold`, `setActiveProvider`, `startAutoSync`, `subscribeSyncStatus`, `syncNow`, `syncStatusEqual`, `updateApp`, `write`, `writeToSource` |
| `src/storage/sources.js` | `abortPendingAdd`, `addSource`, `availableProviderTypesForAdd`, `beginAddCloudSource`, `beginReauth`, `consumePendingAdd`, `consumePendingReauth`, `getActiveSource`, `getActiveSourceId`, `getProvider`, `getSources`, `hasPendingAdd`, `loadSources`, `makeProviderFor`, `migrateLegacy`, `removeSource`, `renameSource`, `restoreSource`, `setActiveSource` |
| `src/storage/indexeddb-provider.js` | `IndexedDbProvider`, `parseTodos` |
| `src/storage/fsa.js` | `deleteFile`, `fileExists`, `forgetFolder`, `getJournalIds`, `getMaxJournalId`, `isSupported`, `journalExists`, `listFiles`, `parseTodos`, `pickFolder`, `readFile`, `restoreFolder`, `scaffoldIfEmpty`, `writeFile` |
| `src/storage/onedrive-provider.js` | `OneDriveProvider` |
| `src/storage/google-drive-provider.js` | `GoogleDriveProvider` |
| `src/storage/diagnostics.js` | `clearDiagnosticEvents`, `formatDiagnosticsReport`, `gatherDiagnostics`, `getDiagnosticEvents`, `isDiagnosticsEnabled`, `recordDiagnosticEvent`, `setDiagnosticsEnabled` |
| `src/storage/taskSettings.js` | `DEFAULT_TASK_SETTINGS`, `TASK_SETTINGS_FILE`, `__testing`, `getTaskSettings`, `moveTaskSettingsEntries`, `normalizeTaskSettingsFile`, `parseTaskSettingsFile`, `readTaskSettings`, `readTaskSettingsFromSource`, `serializeTaskSettingsFile`, `setTaskSetting`, `setTaskSettingInSource`, `withTaskSetting`, `withTaskSettingsMutationLock`, `writeTaskSettings`, `writeTaskSettingsToSource` |

```js
export const TARGET_STATUS = {
  DISCONNECTED: 'disconnected',
  PENDING: 'pending',
  SYNCING: 'syncing',
  SYNCED: 'synced',
  RECONNECT_NEEDED: 'reconnect-needed',
  ERROR: 'error',
}
```

Those values from `src/storage/storage.js` are the vocabulary the UI consumes; the folder-sync service worker emits lower-level provider states, and the façade maps them into this app-level contract.

## Behavioural requirements from tests

Key behavioural coverage comes from `src/storage/cloud-provider.abort.test.js`, `src/storage/diagnostics.test.js`, `src/storage/fsa.test.js`, `src/storage/indexeddb-provider.test.js`, `src/storage/onedrive-provider.pagination.test.js`, `src/storage/settings.test.js`, `src/storage/syncStatus.test.js`, `src/storage/syncStatusCoalesce.test.js`, and `src/storage/taskSettings.test.js`.

- Provider cancellation is **real I/O cancellation**, not ignored metadata. `cloud-provider.abort.test.js` requires `AbortSignal` to flow into OneDrive and Google Drive journal checks and reads.
- OneDrive pagination is **exhaustive**. `src/storage/onedrive-provider.pagination.test.js` requires `journalIds()`, `maxJournalId()`, `listFlat()`, and `getFiles()` to follow `@odata.nextLink`; otherwise journals disappear and ID allocation collides.
- IndexedDB is the **default durable local store**. `src/storage/indexeddb-provider.test.js` requires exact read/write round-trips, tree building for the file browser, journal existence/max-id reporting, scaffolding without overwrite, and full clearing on forget.
- Diagnostics are **safe to share**. `src/storage/diagnostics.test.js` requires the enable flag to persist, the event buffer to cap at 100 entries, and reports to omit token values while still surfacing expiry and refresh-token presence.
- Task settings are **lenient on read, strict on mutation**. `src/storage/taskSettings.test.js` requires corrupt or missing files to normalize during passive reads, but malformed existing documents to block overwriting during mutation; unknown per-task keys must round-trip for forward compatibility; concurrent toggles must serialize.
- Sync status is **value-deduplicated**. `src/storage/syncStatus.test.js` and `src/storage/syncStatusCoalesce.test.js` require equality by meaningful status/message fields rather than object identity, immediate leading-edge updates, and coalesced trailing updates.

## Failure modes

The dangerous failures here are silent partial truths: a paginated cloud listing that stops after page one, a stale cached OneDrive read after a write, a quota failure that drops journals without a visible trace, or concurrent JSON-sidecar writes that lose one user toggle. This domain answers them with explicit conflict errors, diagnostics capture, mutation locks, app-level status mapping, and idempotent scaffolding. When it cannot guarantee correctness—such as malformed `task-settings.json` during mutation—it refuses to overwrite the file.
