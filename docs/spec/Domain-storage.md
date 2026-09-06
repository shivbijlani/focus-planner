# Domain: storage

`storage` is the provider-agnostic persistence layer: one read/write contract implemented four
times (local File System Access, OneDrive, Google Drive, browser IndexedDB), plus the multi-source
registry, diagnostics, and small JSON sidecars that sit alongside the board.

## Responsibility

Give every other domain — the board UI, the sync engine, the Telegram bridge, the overnight agent —
one abstraction (`src/storage/storage.js`) for reading and writing files in "the active storage
source", so that swapping OneDrive for Google Drive, or running with no cloud account at all,
changes zero lines outside this domain.

## Principal modules

| Path | Purpose |
| --- | --- |
| `src/storage/storage.js` | The facade: `read`, `write`, `remove`, `getFiles`, `getTodos`, `scaffold`, sync-status subscription, active-provider selection. |
| `src/storage/sources.js` | Multi-source registry (`{ id, name, providerType, config? }`); enforces at-most-one LocalStorage/OneDrive/GoogleDrive source (single browser / single OAuth account), but any number of FSA folder sources. |
| `src/storage/fsa.js` / `fsa-provider.js` | Local File System Access provider. |
| `src/storage/onedrive-provider.js` | Microsoft Graph + PKCE OAuth2, sandboxed to the app's OneDrive AppFolder. |
| `src/storage/google-drive-provider.js` | Drive API v3 + PKCE OAuth2, files under a named `Planner` folder. |
| `src/storage/indexeddb-provider.js` | The default for a brand-new visitor: one IndexedDB object store, replacing an older localStorage-backed provider whose ~5MB synchronous cap could not hold hundreds of task journals. |
| `src/storage/migrate.js` | Copies every file (including the journal subdirectory) from one provider to another. |
| `src/storage/diagnostics.js` | A copyable snapshot of storage/sync health for Settings → Diagnostics; **never includes secret token values**, only provider id, expiry, and refresh-token presence. |
| `src/storage/taskSettings.js` | Per-task AI-assistance opt-ins (`task-settings.json`), an open per-task object so future toggles need no format migration. |
| `src/storage/syncStatusCoalesce.js` | Debounces the sync-status event stream so a burst of save cycles collapses to one UI update instead of thrashing every render. |

## Public exports (facade)

From `src/storage/storage.js`: `PROVIDERS`, `TARGET_STATUS`, `read`/`write`/`remove`,
`readFromSource`/`writeToSource`/`removeFromSource`, `getFiles`/`getFilesFromSource`,
`getTodos`/`getTodosFromSource`, `journalIds`/`maxJournalId` (+ `FromSource` variants),
`checkJournal`/`checkJournalFromSource`, `scaffold`, `ensureAgentsDoc`, `getActiveProvider`,
`getAvailableProviders`, `setActiveProvider`, `connectSyncTarget`/`disconnectSyncTarget`,
`startAutoSync`/`syncNow`, `getSyncStatus`/`subscribeSyncStatus`, `registerSyncWorker`.

## Behavioural requirements (from the storage test suite, 9 files / 64 tests)

- **Cancellation propagates.** `cloud-provider.abort.test.js`: an `AbortSignal` passed into a read
  must reach the underlying OneDrive/Google Drive HTTP call; a helper error must still surface as an
  error rather than being swallowed into "file not found" — only an *explicit* not-found response
  from the provider counts as absence.
- **Diagnostics never leak secrets.** `formatDiagnosticsReport` includes key sections but is
  asserted to never expose token values, and is resilient to a mostly-empty input object.
- **IndexedDB provider round-trips exactly what it stores** — reads back written content, reports
  empty string (not an error) for a missing path, lists all paths, builds a nested tree for the
  file-tree UI, and **scaffolds `planner.md`/`planner-completed.md` without overwriting existing
  content** — a fresh install must not clobber a folder a previous session already populated.
- **OneDrive pagination is exhaustive** (task #371): `journalIds()`, `maxJournalId()`, `listFlat()`
  and `getFiles()` must all follow `@odata.nextLink` across every page rather than stopping at the
  first — a partial read of `maxJournalId()` silently causes new-task id collisions, since a new id
  is allocated by scanning existing journal ids for the highest in use.
- **Task settings tolerate corruption and preserve forward-compatibility.** A missing or corrupt
  `task-settings.json` normalizes to version 1 with no tasks rather than throwing; unknown per-task
  keys are preserved (not stripped) so a newer app version's fields survive a round-trip through an
  older one; concurrent toggles are serialized so neither update is lost; a malformed existing
  sidecar is refused rather than silently overwritten.
- **Sync-status coalescing** drops value-identical churn to one apply, applies the first change of
  a quiet period immediately (so the UI is not sluggish to *start* showing "Backing up…"), and
  coalesces a burst to its final state rather than replaying every intermediate step.

## Failure modes

A provider that silently under-reads a paginated listing (the #371 class) causes duplicate task
ids across the whole board — a defect invisible until two tasks with the same id collide in the UI.
A diagnostics report that leaks a token value would be catastrophic if pasted into a support
channel, which is why that guarantee is asserted directly rather than assumed from "we don't put
tokens in there" review discipline.
