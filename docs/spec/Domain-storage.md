# Domain: storage

## Responsibility

A single abstraction (`src/storage/storage.js`) over four interchangeable backends so the rest of the
app never knows which one it's talking to: **FSA** (local folder via the File System Access API),
**IndexedDB** (`local-storage` provider id — the default for a new visitor), **OneDrive**, and
**Google Drive**. Multiple sources can be registered simultaneously (`src/storage/sources.js`); a
"Combined" view merges them.

## Principal modules

| Module | Role |
| --- | --- |
| `src/storage/storage.js` | The facade: `read/write/remove/getFiles/getTodos/journalIds`, delegating to whichever provider is active; also owns sync-target lifecycle (`connectSyncTarget`, `startAutoSync`). |
| `src/storage/sources.js` | The multi-source registry — `{ id, name, providerType, config? }` entries; at most one LocalStorage/OneDrive/GoogleDrive source each, any number of FSA sources. |
| `src/storage/fsa.js`, `fsa-provider.js` | Local File System Access API provider. |
| `src/storage/indexeddb-provider.js` | Browser-native provider; every file is one IndexedDB record keyed by path (chosen over localStorage's ~5 MB synchronous cap). |
| `src/storage/onedrive-provider.js`, `src/storage/google-drive-provider.js` | Cloud providers, both PKCE OAuth2, both sandboxed to an app-owned folder (OneDrive's `Files.ReadWrite.AppFolder` scope; Drive's named "Planner" folder). |
| `src/storage/migrate.js` | Copies every file (including the journal subdirectory) from one provider to another. |
| `src/storage/diagnostics.js` | A copyable, secret-safe snapshot of storage/sync state for user-facing troubleshooting. |
| `src/storage/syncStatusCoalesce.js` | Coalesces a bursty sync-status stream so the board doesn't re-render on every intermediate tick. |
| `src/storage/taskSettings.js`, `settings.js` | Small JSON sidecars (`task-settings.json`, `settings.json`) with the same read-modify-write discipline as the board. |

## Public surface (representative exports)

`PROVIDERS, read, write, remove, getFiles, getTodos, journalIds, connectSyncTarget,
registerSyncWorker, startAutoSync` (`storage.js`); `addSource, getActiveSource, getSources,
makeProviderFor` (`sources.js`); `FSAProvider`, `IndexedDbProvider`, `GoogleDriveProvider`,
`OneDriveProvider`; `migrate, snapshotFiles, resumePendingMigration` (`migrate.js`); `gatherDiagnostics,
formatDiagnosticsReport` (`diagnostics.js`).

## Behavioural requirements (from tests)

- **Pagination correctness** (issue #371 for OneDrive): `journalIds()`, `maxJournalId()`,
  `getFiles()` and the flat listing used by the sidebar must all follow `@odata.nextLink` rather than
  stopping at the first page — otherwise ids beyond page 1 silently collide.
- **Diagnostics never leak secrets**: for a connected sync target, `formatDiagnosticsReport` records
  only provider id, token expiry, and whether a refresh token exists — never a token value.
- **Sync-status coalescing** applies the first change immediately (so "Backing up…" appears promptly)
  and coalesces a burst of rapid saves to one final state, without re-applying a no-op burst.
- **`AbortSignal` propagation**: OneDrive/Google Drive journal checks and reads must honor cancellation,
  and only an explicit not-found response is treated as absence — any other error must surface, not be
  swallowed as "file doesn't exist."
- **Task settings are a structured sidecar with forward-compatible unknown fields**: malformed entries
  coerce to defaults, unknown per-task keys survive a round trip, and concurrent toggles serialize
  rather than lose an update (`taskSettings.test.js`).

## Failure modes this domain guards against

- **Cross-provider write races on JSON sidecars** — `taskSettings.js` explicitly serializes concurrent
  toggles and refuses to overwrite a malformed or shape-invalid existing file rather than clobbering it.
- **The board re-rendering on every sync tick** — `syncStatusCoalesce.js` exists specifically because a
  burst of value-identical status pushes defeated Playwright's "wait for the page to go quiet" gate,
  blocking automation (issue #133).
- **Cancelled requests hanging or reporting false absence** — the cloud providers must distinguish a
  genuine 404 from a cancelled/failed request; a cancellation must propagate through, not be read as
  "the file doesn't exist."
