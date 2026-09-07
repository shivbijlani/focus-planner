# Architecture

Focus Planner has no server-side database and, apart from one thin local file server, no backend of
its own. The system of record is a folder of markdown files — `planner.md`, the Today/Deferred
board; `planner-completed.md`, the completed-task archive; and one `journal/task-<id>.md` per
task — plus a handful of config sidecars (`agent-gate.md`, `user-settings.md`), synced across
devices by the user's own cloud storage (OneDrive, Google Drive) or kept local (the File System
Access API, IndexedDB). Everything else — the React board, the sync engine, the Telegram mirror, the
overnight autonomous agent — is a reader or writer of that folder, never an owner of state the
folder does not already hold. This is the design decision the rest of the system follows from:
state lives in files a human can open and edit by hand, not behind an API only the app understands.

## The domains

| Domain | Principal modules | Responsibility |
| --- | --- | --- |
| `app` | `src/App.jsx`, `src/focusPlanOps.js`, `src/journalChat.js`, `src/boardRow.js`, `src/journalLoadQueue.js` | The React board UI, the pure content-transformation functions over `planner.md`, and journal chat-thread rendering. |
| `storage` | `src/storage/storage.js`, `src/storage/sources.js`, `src/storage/taskSettings.js`, `src/storage/fsa.js`, `src/storage/indexeddb-provider.js`, `src/storage/onedrive-provider.js`, `src/storage/google-drive-provider.js` | The provider-agnostic read/write abstraction over FSA, OneDrive, Google Drive and IndexedDB, plus a multi-source registry and per-task settings sidecars. |
| `folder-sync` | `packages/folder-sync/src/engine.js`, `packages/folder-sync/src/merge.js`, `packages/folder-sync/src/records.js`, `packages/folder-sync/src/sw.js`, `packages/folder-sync/src/queue.js` | The record-level sync engine (running in a service worker) that reconciles a local replica against a cloud provider without losing concurrent edits or resurrecting deleted rows. |
| `config` | `src/config/agentGate.js`, `src/config/agentsDoc.js`, `src/config/aiSettings.js`, `src/config/userSettingsForm.js`, `src/config/agentSettingsVisibility.js`, `src/config/branding.js` | Schemas and editors for the config sidecars the overnight agent and the app both depend on. |
| `task-paper` | `packages/task-paper/src/paper.js`, `packages/task-paper/src/render.js`, `packages/task-paper/src/markdown.js`, `packages/task-paper/src/generate.js`, `packages/task-paper/src/comment.js` | Renders a chronological journal into a settled, printable markdown/HTML artifact, with a comment channel back into the journal. |
| `telegram-bridge` | `packages/telegram-bridge/src/bridge.js`, `packages/telegram-bridge/src/digest.js`, `packages/telegram-bridge/src/state.js`, `packages/telegram-bridge/src/liveStatus.js` | A standalone Node CLI mirroring task journals into a Telegram forum and folding replies back in, with a consolidated approval digest. |
| `overnight-agent` | `plugins/overnight-agent/skills/overnight-agent/oa-state.ps1`, `.../SKILL.md`, plus 159 `plugins/overnight-agent/checks/*.mjs` scripts | A scheduled, unattended Copilot CLI plugin that scans the board, proposes and executes plans, and mutation-tests its own reliability. See [Domain-overnight-agent](Domain-overnight-agent), [Prioritisation](Prioritisation) and [Reliability](Reliability). |
| `mcp-cred-vault` | `packages/mcp-cred-vault/src/schema.js` | Validates the non-secret pointer file that tells a machine which credentials to pull from its OS vault. |
| `install-prompt` | `packages/install-prompt/src/useInstallPrompt.js`, `packages/install-prompt/src/InstallModal.jsx` | Cross-platform "add to home screen" PWA install UX. |
| `diagnostics` | `packages/diagnostics/src/index.js` | A shared, low-overhead event/tracing sink used by the app, its service worker, and folder-sync, so a live worker's state can be dumped on demand. |
| `scripts` | `scripts/spec/collect.mjs`, `scripts/spec/verify.mjs`, `scripts/merge-queue.mjs` | Repo-maintenance tooling: this spec's own generation pipeline, dependency-hygiene guards, and merge-queue automation. See [Domain-scripts](Domain-scripts). |
| `root` | `server.js`, `vite.config.js`, `eslint.config.js` | The dev/build toolchain and the one real backend process (below). |

## Runtime processes

There are four long-lived runtime surfaces, and they do not share memory or a process:

1. **The browser tab** — the React app (`src/App.jsx`) plus its registered service worker
   (`packages/folder-sync/src/sw.js`). The service worker owns the dirty-file queue
   (`packages/folder-sync/src/queue.js`) and the remote pull/push cycle; the main thread owns the UI
   and enqueues writes. They communicate only via `postMessage`/`BroadcastChannel`, never shared
   memory, because a service worker can be evicted and restarted by the browser at any time —
   `packages/folder-sync/src/engine.js`'s own doc comment states status events "come back from the
   SW via BroadcastChannel" for exactly this reason.
2. **`server.js`** — a ~300-line Express process exposing `GET /api/files`, `GET/PUT/DELETE
   /api/file`, `GET /api/todos`, `GET /api/journal-exists`, `POST /api/pick-folder`, and
   `GET/POST /api/config`. It is the "local folder" workflow described in the repository's own
   `README.md` ("start planner"): it lets a locally-run Copilot CLI session, or any HTTP client, read
   and write the same markdown files the browser app uses, without going through a browser storage
   provider. It resolves every path against a configurable `PLANNER_PATH` (persisted to
   `planner-config.json`) and rejects any request whose resolved path escapes that root.
3. **The overnight agent** — a Copilot CLI plugin invoked by an OS-level scheduler (see
   [Reliability](Reliability) for how that scheduler is itself kept alive). It never talks to
   `server.js` or the browser tab; it reads and writes the same files directly on disk or through the
   synced cloud folder, which is why every board/journal format in [Data-Formats](Data-Formats) has
   to be something a PowerShell script and a browser IndexedDB provider can both parse identically.
4. **The Telegram bridge** (`packages/telegram-bridge/bin/telegram-bridge.js`) — an optional, fourth
   process, typically run in a watch loop, that also reads/writes journals and its own state file
   (`packages/telegram-bridge/src/state.js`). It is independent of the other three and can be absent
   entirely without breaking the board or the agent: it is a mirror, not a source of truth.

## Data flow: a user action to persisted state

Take "the user completes a task from the board":

1. **App** — `src/App.jsx` calls into `src/focusPlanOps.js`'s exported operations (for example
   `opAppendToCompleted`, `opRemoveTaskFromFocusPlan`), which are pure `(content, ...args) ->
   newContent` transforms over the in-memory string of `planner.md` and
   `planner-completed.md`. No I/O happens inside these functions — this is exactly what lets the
   single-source `FocusPlanView` and the multi-source Combined view reuse the identical algorithm,
   each routing an operation to whichever source the row belongs to.
2. **Storage** — the new content is handed to `src/storage/storage.js`'s `write`, which delegates to
   whichever provider is active (`getActiveProvider()`), and for FSA/OneDrive/Google Drive providers
   the change is queued for the sync engine rather than written straight to the remote.
3. **Sync** — the service worker (`packages/folder-sync/src/sw.js`) drains the queue
   (`packages/folder-sync/src/queue.js`), diffs the before/after board into per-record changes,
   stamps a logical clock via `stampLocalChanges` (`packages/folder-sync/src/merge.js`), and
   reconciles against the remote via `mergeCollections`/`reconcileExternal` before pushing — never a
   raw whole-file overwrite, so a concurrent edit made on another device is merged rather than
   clobbered.
4. **Remote propagation** — the cloud provider (OneDrive/Google Drive) now holds the new bytes; any
   other device's own service worker pulls them down on its own cycle and runs the same merge in
   reverse.
5. **Downstream readers** — the Telegram bridge's next sync pass reads `planner-completed.md` and
   can close the task's forum topic; the overnight agent's next `scan` reads the same board and
   journal and stops treating the task as `eligible` (see [Prioritisation](Prioritisation)).

No step in this chain assumes the others are running. A user can edit `planner.md` directly in a
text editor, sync it with any file-sync tool of their choosing, and every downstream reader still
functions, because the file format is the contract, not an API call.

## Why this shape, and what was rejected

The obvious alternative — a real backend with a database and an authenticated sync API — is rejected
implicitly by every module's own framing: `src/storage/storage.js`'s leading comment calls itself a
"Storage abstraction layer... Supports: FSA (local), OneDrive, Google Drive," never "the app's
database," and the overnight agent's entire design (see [Prioritisation](Prioritisation)) assumes it
can act as a second, independent writer to the *same* files a browser tab is editing, with no
locking protocol beyond the sync engine's per-record merge. A database-backed design would need a
real API for the agent to call, real auth for a scheduled background process to hold, and a
migration story every time the schema changed. Plain files trade that away for: a user can always
read their own data with any text editor, any device can become a second "client" with zero
integration work (an agent, a phone, a browser), and the file format itself — not a server's
willingness to be reachable — is the single point of truth.

`packages/folder-sync/src/merge.js`'s record-level design is itself a rejection of a simpler
alternative: whole-file last-write-wins. Its own doc comment names the reason — that approach let a
stale replica "resurrect a row that another device deleted," which it calls "the root cause of the
'deleted rows reappear' bug." Record-level tombstones (`stampDelete`, `gcTombstones`) close that hole
by making a delete a fact with its own logical clock, not the mere absence of a row that a
late-arriving write can silently restore.

See [Data-Formats](Data-Formats) for every file's exact grammar and invariants,
[Prioritisation](Prioritisation) for how the overnight agent turns the board into an ordered, gated
worklist, and [Reliability](Reliability) for how that agent stays running unattended for long
stretches at a time.
