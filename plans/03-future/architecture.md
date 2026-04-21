# Future-Proof Architecture

Design rules that make the V1 shape survive every future platform and feature
without a rewrite.

## The one rule
**The UI never talks to storage. The core never talks to a specific storage.**
Everything crosses the `StorageAdapter` boundary.

If that rule holds, every future phase is a mechanical addition.

## Layering contract

```
UI (any framework)
    │   typed RPC (Comlink or equivalent)
Core (framework-free, single source of truth)
    │   StorageAdapter interface
Adapter (swappable)
    │   platform-specific I/O
Platform (browser / iOS / Android / desktop)
```

Rules:
- Core has **zero** imports from UI or adapter implementations. It only imports
  the adapter *interface*.
- Adapters have zero knowledge of tasks, journals, or markdown. They move bytes.
- UI has zero knowledge of markdown or files. It gets typed objects from core.

## Adapter catalogue (anticipated)

| Adapter | Platform | Notes |
|---|---|---|
| `FileSystemAccessAdapter` | Chromium web | V1 |
| `OPFSAdapter` | any modern browser incl. iOS Safari | Sandboxed per-origin; enables mobile web |
| `CapacitorFsAdapter` | iOS, Android | Uses Capacitor Filesystem plugin |
| `TauriFsAdapter` | Windows, macOS, Linux desktop | Uses Tauri fs API |
| `OneDriveAdapter` | any web | MS Graph API, OAuth PKCE |
| `GoogleDriveAdapter` | any web | Drive API, OAuth PKCE |
| `DropboxAdapter` | any web | Dropbox API |
| `WebDAVAdapter` | any web | Generic; covers Nextcloud etc. |
| `S3Adapter` | any | Paid-tier encrypted sync |

A `CompositeAdapter` can layer a local adapter + a remote one for offline-first sync.

## RPC boundary

Comlink is the default. The contract is:
- All core methods are async.
- All arguments and return values are structured-cloneable (no functions, no DOM).
- Long-running operations expose progress via an `onProgress` callback passed as
  a Comlink proxy.

This contract is what lets the same core ship unchanged into Capacitor / Tauri —
those platforms just call the core module directly, skipping the worker, since
they have no cross-thread constraint.

## State & sync

- Truth is always on disk. The core is a projection; never the source of truth.
- On load: read files, build in-memory model.
- On mutation: update model, write file, emit change event.
- Future: add a `WatcherAdapter` interface for filesystems that support change
  notifications (FSA's observer, Capacitor plugins, cloud webhooks).

## Conflict strategy (for cloud / multi-device)

When two devices edit the same file:
- Compare file mtime + content hash.
- If local unsaved → write a `.conflict-YYYYMMDD-HHMMSS.md` sibling, never overwrite.
- Surface conflicts in UI as a dedicated view. Never auto-merge silently.
- This mirrors Obsidian's strategy and is well-understood by users.

## Packaging targets

All share the same core + UI bundle:

| Target | Shell | Adapter |
|---|---|---|
| Web (GitHub Pages) | none | FSA or OPFS |
| iOS | Capacitor | CapacitorFsAdapter |
| Android | Capacitor | CapacitorFsAdapter |
| Windows / macOS / Linux | Tauri | TauriFsAdapter |

One codebase, four shells, N adapters. No forks.

## Testing strategy

- Core is pure and adapter-agnostic → unit-testable with an `InMemoryAdapter`.
- Adapters have a shared conformance suite: any new adapter must pass the same
  ~20 tests (read own write, list shows new file, overwrite, delete, etc.).
- UI tests use Playwright against the static build with the in-memory adapter
  swapped in via a query flag (`?storage=memory`).

## What stays out forever

- No global auth system. Auth, if needed, is per-adapter (OneDrive login is
  OneDrive's problem, not the app's).
- No server-side anything. If a feature requires a server, it becomes a separate
  paid add-on, not part of the core app.
