# MVP Architecture

## One sentence
A static web app that reads and writes markdown files in a user-chosen local folder.

## Non-negotiables
- **No backend.** Deployable to GitHub Pages as static assets.
- **No auth.** User picks a folder; that's the whole onboarding.
- **UI is dumb.** No business logic, no file I/O, no parsing in React components.
- **Markdown is the database.** Files stay human-readable at all times.

## Layers

```
React UI  ──►  Core Worker (via Comlink)  ──►  StorageAdapter  ──►  Disk
 dumb           all logic                      one impl in V1
```

### 1. UI layer
- React + Vite
- Calls a typed proxy (e.g. `planner.getTasks()`, `planner.saveTask(t)`)
- Knows nothing about markdown, files, or storage
- Renders state, handles user input, nothing else

### 2. Core worker
- Plain JS/TS module running in a Web Worker
- Exposed to UI via Comlink (or equivalent postMessage RPC)
- Framework-free — must be portable to any future shell (Capacitor, Tauri, etc.)
- Responsibilities:
  - Parse markdown files into task/journal/todo objects
  - Serialize objects back to markdown
  - All queries, sorts, filters, state transitions
  - Holds one `StorageAdapter` instance

### 3. Storage adapter interface
```
interface StorageAdapter {
  listFiles(dir?: string): Promise<string[]>
  readFile(path: string): Promise<string>
  writeFile(path: string, content: string): Promise<void>
  exists(path: string): Promise<boolean>
}
```
V1 ships exactly one implementation: `FileSystemAccessAdapter`.

### 4. FileSystemAccessAdapter (V1)
- Uses `window.showDirectoryPicker()`
- Persists the returned `FileSystemDirectoryHandle` in IndexedDB (via `idb-keyval`)
- On load: try to restore handle, call `queryPermission` / `requestPermission`
- Chromium-only. Non-Chromium users see a "use Edge or Chrome" message.

## Data model (minimum)

The markdown files are the schema. See `02-features/capabilities.md` for exactly what formats the parser must understand.

At runtime the core worker exposes these shapes:
- `Task` — one row from the focus plan
- `Journal` — per-task markdown file with bullet points
- `Todo` — bullet in a journal prefixed `TODO:` or `DONE:`

## Deployment
- Vite with `base` configured for the GH Pages path
- GitHub Action on push to main: build, publish `dist/` to `gh-pages`
- Must also work when opened from `file://` (nice-to-have, falls out naturally)

## What not to build in V1
- Cloud drive integrations
- Mobile shells
- Any adapter other than FSA
- Service worker caching strategies beyond Vite's defaults
- Sync, conflict resolution, version history
- Collaboration, sharing, auth

## Done criteria for V1
1. User visits the GH Pages URL in Chrome/Edge.
2. Clicks "Open planner folder", picks a folder.
3. Sees their focus plan and completed tasks.
4. Can defer, complete, edit, and add tasks.
5. Can open a task's journal and tick todos.
6. Refresh the page; state restores (from the files on disk, not from localStorage).
7. Edits from a second device show up after OneDrive sync, because the user picked a OneDrive-synced folder.
