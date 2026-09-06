# Domain: storage

## Responsibility

The storage abstraction layer: a single interface the rest of the app (`app` domain) calls to read,
write, and list markdown files, regardless of whether the data actually lives in the File System
Access API (a local folder), the browser's IndexedDB, OneDrive, or Google Drive. It also owns the
small JSON sidecar files that are machine-managed rather than user-edited (`settings.json`,
`task-settings.json`), and the diagnostics snapshot used to debug sync problems.

## Principal modules

| Path | Exports | Role |
| --- | --- | --- |
| `src/storage/storage.js` | `PROVIDERS`, `TARGET_STATUS`, `read`, `write`, `remove`, `getFiles`, `getTodos`, `journalIds`, `scaffold`, `syncNow`, `connectSyncTarget`, ... (largest export surface in the domain) | The facade every other module calls; delegates to whichever provider is active. |
| `src/storage/sources.js` | `getSources`, `addSource`, `getActiveSource`, `setActiveSource`, `makeProviderFor`, ... | Multi-source registry: which storage backends are configured, and which one is active. |
| `src/storage/fsa.js` | `pickFolder`, `readFile`, `writeFile`, `listFiles`, `getJournalIds`, `scaffoldIfEmpty`, ... | Local-folder provider primitives (File System Access API). |
| `src/storage/fsa-provider.js` | `FSAProvider` | Wraps `fsa.js` behind the common provider interface. |
| `src/storage/indexeddb-provider.js` | `IndexedDbProvider`, `parseTodos` | Default provider for new visitors — every file is one IndexedDB record keyed by path. |
| `src/storage/onedrive-provider.js` | `OneDriveProvider` | Microsoft Graph API + PKCE OAuth2, sandboxed to the app's OneDrive AppFolder. |
| `src/storage/google-drive-provider.js` | `GoogleDriveProvider` | Drive API v3 + PKCE OAuth2, sandboxed to a named "Planner" folder. |
| `src/storage/migrate.js` | `migrate`, `snapshotFiles`, `restoreFiles`, `resumePendingMigration` | Copies every file (including the `journal/` subdirectory) from one provider to another. |
| `src/storage/settings.js` | `SETTINGS_FILE`, `readSettings`, `writeSettings` | The mission-statement sidecar JSON. |
| `src/storage/taskSettings.js` | `getTaskSettings`, `setTaskSetting`, `withTaskSetting`, `moveTaskSettingsEntries`, ... | Per-task AI-assistance opt-ins (`task-settings.json`), keyed by stable task ID. |
| `src/storage/diagnostics.js` | `gatherDiagnostics`, `formatDiagnosticsReport`, `recordDiagnosticEvent`, ... | A copyable, secret-free snapshot of storage + sync state for user-reported bug triage. |
| `src/storage/syncStatusCoalesce.js` | `makeSyncStatusCoalescer`, `sameSyncStatus` | Collapses rapid-fire sync status pushes so the board doesn't re-render on every internal tick. |

## Design

**Providers share one interface** (read/write/remove/list/journal helpers) so `storage.js` can treat
FSA, IndexedDB, OneDrive, and Google Drive identically. **Multi-source** support (`sources.js`) sits
above that: a "source" is `{ id, name, providerType, config? }` persisted in `localStorage`. LocalStorage,
OneDrive, and GoogleDrive sources are capped at one each (one browser, one OAuth account); FSA sources
are uncapped, since each is just a different local folder. A single-source registry is required to
behave exactly as the app did before multi-source existed — no combined view, no per-source labels —
so `getSources().length === 1` gates every multi-source affordance.

**`taskSettings.js`** stores machine-owned metadata in a sidecar file rather than journal prose,
mirroring `settings.js`'s pattern. A task with no recorded entry is treated as having every opt-in
off, so pre-existing tasks are unaffected until a user explicitly opts in — and each entry is an open
object so a future opt-in needs no format migration.

**`diagnostics.js`** is imported by the low-level write path (`storage.js`) to record events, so it
must never statically import `storage.js` or `sources.js` — that would be an import cycle — and
instead lazy-imports them inside `gatherDiagnostics()`. Its report never includes secret values: for
sync tokens it reports only the provider id, expiry, and whether a refresh token exists.

**`syncStatusCoalesce.js`** exists because the sync engine emits a status object on every nudge during
a backup, and most pushes are value-identical. `App.jsx` feeds every push into React state, forcing a
full re-render; a burst of rapid save cycles thrashes the UI and defeats Playwright's "wait for the
page to go quiet" automation gate (issue referenced as #133 in the module's own doc comment). The
coalescer drops value-identical pushes, applies the first change in a quiet period immediately
("Backing up…" appears promptly), and coalesces a burst to its final state once it settles.

## Data formats owned here

See [Data-Formats](Data-Formats) for full annotated samples of `settings.json` and
`task-settings.json`.

## Behavioural requirements (selected, from the domain's test suites)

- `cloud-provider.abort.test.js`: an `AbortSignal` passed to a read must propagate through both the
  OneDrive and Google Drive providers; only an explicit not-found response is treated as absence — a
  helper error must be thrown, never silently reported as "file does not exist."
- `onedrive-provider.pagination.test.js` (task #371): `journalIds()` and `maxJournalId()` must see ids
  across **all** pages of a paginated folder listing by following `@odata.nextLink`, not just the
  first page — otherwise two devices can allocate colliding task IDs.
- `indexeddb-provider.test.js`: identifies as "Browser Storage", is always ready, reads back what it
  writes, returns empty string for a missing path, and scaffolds plan/completed files without
  overwriting existing content.
- `taskSettings.test.js`: `parseTaskSettingsFile` tolerates missing/corrupt JSON; unknown per-task keys
  are preserved for forward compatibility; concurrent toggles are serialized so neither update is
  lost; a malformed existing sidecar is never silently overwritten.
- `diagnostics.test.js`: the formatted report never leaks token values, and the event buffer is capped
  at 100 entries and only records when diagnostics are enabled.
- `syncStatusCoalesce.test.js`: value-identical churn collapses to a single apply; the leading edge of
  a change applies immediately; a trailing burst that ends where it began does not re-apply.

## Failure modes

- A provider that reports "not found" for a transient network error (rather than throwing) would
  make the app scaffold a fresh file over one that still exists remotely — the abort/cancellation
  tests exist specifically to keep that distinction sharp.
- A pagination bug in any cloud provider's `maxJournalId()` reintroduces the exact task-ID collision
  class `onedrive-provider.pagination.test.js` was written to close (task #371).
