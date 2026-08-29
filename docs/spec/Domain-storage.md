# Domain: storage

## Responsibility

The single abstraction every other domain in the browser app reads and writes files
through. It hides four completely different backends behind one interface so
[Domain-app](Domain-app) never branches on which one is active, and it owns the
multi-source registry that lets a user connect more than one folder/account
simultaneously.

## Principal modules

| Module | Role |
| --- | --- |
| `src/storage/storage.js` | The facade: `read`, `write`, `remove`, `getFiles`, `getTodos`, `journalIds`, plus multi-source variants (`readFromSource`, etc.), sync-target lifecycle (`connectSyncTarget`, `startAutoSync`, `syncNow`), and the `PROVIDERS` registry. |
| `src/storage/sources.js` | The multi-source registry: at most one LocalStorage/OneDrive/GoogleDrive source each, any number of FSA (local-folder) sources, persisted to `localStorage`. |
| `src/storage/fsa-provider.js` / `src/storage/fsa.js` | File System Access API provider for desktop Chromium — the user picks a real folder handle. |
| `src/storage/indexeddb-provider.js` | Browser-local default provider (`local-storage` id, "Browser Storage" display name) — one IndexedDB record per file path, replacing an older localStorage-backed implementation whose ~5MB synchronous quota strained under hundreds of journals. |
| `src/storage/onedrive-provider.js` | Microsoft Graph + PKCE OAuth2, sandboxed to the app's special AppFolder (`Files.ReadWrite.AppFolder` scope) — no broad file permissions requested. |
| `src/storage/google-drive-provider.js` | Drive API v3 + PKCE OAuth2, storing files under a named folder (default `Planner`) in the user's Drive root. |
| `src/storage/migrate.js` | Copies every file (including the `journal/` subdirectory) from one provider to another, for switching storage backends without data loss. |
| `src/storage/syncStatusCoalesce.js` | Coalesces the sync-status event stream so a burst of save cycles collapses to a handful of renders instead of thrashing the board on every status nudge. |

## Public exports (selected)

`storage.js`: `PROVIDERS`, `TARGET_STATUS`, `read`, `write`, `remove`, `getFiles`,
`getTodos`, `journalIds`, `maxJournalId`, `getActiveProvider`, `setActiveProvider`,
`connectSyncTarget`, `disconnectSyncTarget`, `startAutoSync`, `syncNow`,
`subscribeSyncStatus`, `ensureAgentsDoc`. `sources.js`: `getSources`, `addSource`,
`removeSource`, `renameSource`, `setActiveSource`, `beginAddCloudSource`,
`beginReauth`, `migrateLegacy`. `syncStatusCoalesce.js`: `makeSyncStatusCoalescer`,
`sameSyncStatus`.

## Design decision: one provider interface, four backends

The rejected alternative was branching UI/app logic on storage type. Instead every
provider implements the same shape (`read`, `write`, `remove`, `listFiles`,
`getJournalIds`, `getMaxJournalId`, `journalExists`, `scaffoldIfEmpty`, plus
provider-specific `isSupported`/`pickFolder`), so `src/storage/storage.js` and everything
above it is written once against the interface. `src/storage/sources.js` documents the
resulting single-source UX invariant explicitly: when the registry holds exactly one
entry, the UI must behave exactly as it did before multi-source existed — no source
folders, no Combined view, no per-source labels — so multi-source is additive, not a
rewrite of the common case.

## Behavioural requirements (from tests)

- **Cancellation** (`src/storage/cloud-provider.abort.test.js`): an `AbortSignal` passed
  to a read must propagate through both OneDrive's journal-existence check and Google
  Drive's lookup/content read; only an *explicit* not-found response from OneDrive may be
  treated as absence, and a Google Drive helper's genuine error must be thrown rather than
  silently reported as absence — collapsing "the file doesn't exist" and "the request
  failed" is not acceptable.
- **`fsa.js` `parseTodos`** must parse checkbox todos at the start of a journal, including
  when the content begins with a UTF-8 BOM (`\uFEFF`) — a BOM must not shift or break the
  checkbox regex.
- **`IndexedDbProvider`** must identify as "Browser Storage" and report itself always
  ready; must read back exactly what it writes and return an empty string (not throw) for
  a missing path; must build a correctly nested file tree for the sidebar; must report
  journal existence, the full id list, and the max id; and must scaffold the plan/completed
  files only when they don't already exist (never overwriting real content).
- **OneDrive pagination** (task 371 in `src/storage/onedrive-provider.pagination.test.js`)
  must follow `@odata.nextLink` rather than stopping at the first page for every listing
  operation that touches journal ids — `journalIds()`, `maxJournalId()`, `listFlat()`, and
  `getFiles()` must all see items beyond page one, since missing a later page's high
  journal id would let a freed/lower id collide with one already in use.
- **`syncStatusEqual`** must treat two independently constructed but field-identical
  status objects as equal, must detect a changed aggregate or a changed per-target status
  or message, and must explicitly ignore non-status fields such as `lastRemoteUpdate` that
  change on every tick without representing a real status change.
- **`makeSyncStatusCoalescer`** must drop value-identical churn to a single applied
  update, apply the first change in a quiet period immediately (leading edge), coalesce a
  burst of rapid changes down to the final state once the burst settles (trailing edge),
  must *not* re-apply on the trailing edge when a burst ends exactly where it began, and
  its `cancel()` must stop a pending trailing apply.

## Failure modes

- A provider that reports "not found" for both a genuinely absent file and an unrelated
  network failure would make the app treat every transient outage as "this task has no
  journal yet" — this is why the abort/cloud-provider tests specifically require
  distinguishing an explicit not-found response from a thrown error.
- Stopping OneDrive/Google Drive listings at the first page silently truncates the known
  journal-id universe, directly enabling the ID-collision failure class also guarded
  against in [Domain-app](Domain-app)'s tombstone and self-heal modules.
- Coalescing sync-status updates incorrectly (e.g. dropping the *first* real change, not
  just duplicates) would make "Backing up…" never appear during a genuinely fast save
  cycle — the leading-edge requirement exists specifically to keep the label truthful
  while still cutting render volume.
