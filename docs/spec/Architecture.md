# Architecture

Focus Planner has no server-side database and, apart from one thin static file server, no backend
of its own. The system of record is a folder of markdown and JSON files — `planner.md`,
`planner-completed.md`, `journal/task-<id>.md`, and a handful of config sidecars — synced across
devices by the user's own cloud storage (OneDrive, Google Drive) or kept local (File System Access,
IndexedDB). Everything else — the React board, the sync engine, the Telegram mirror, the overnight
autonomous agent — is a reader or writer of that folder, never an owner of state the folder does not
already hold. This is the central design decision the rest of the system follows from: state lives
in files a human can open and edit by hand, not behind an API only the app understands.

## The domains

| Domain | Principal modules | Responsibility |
| --- | --- | --- |
| `app` | `src/App.jsx`, `src/focusPlanOps.js`, `src/journalChat.js`, `src/boardRow.js`, `src/taskSort.js` | The React board UI and the pure content-transformation functions that read/write `planner.md` and journals. |
| `storage` | `src/storage/storage.js`, `src/storage/sources.js`, `src/storage/taskSettings.js` | The provider-agnostic read/write abstraction over FSA, OneDrive, Google Drive and IndexedDB, plus multi-source registry and per-task settings sidecars. |
| `folder-sync` | `packages/folder-sync/src/engine.js`, `packages/folder-sync/src/merge.js`, `packages/folder-sync/src/records.js`, `packages/folder-sync/src/sw.js` | The record-level CRDT sync engine (a service worker) that reconciles a local replica against a cloud provider without losing concurrent edits or resurrecting deleted rows. |
| `config` | `src/config/agentGate.js`, `src/config/agentsDoc.js`, `src/config/aiSettings.js`, `src/config/userSettingsForm.js` | Definitions and safe (non-destructive) editors for the config sidecars the overnight agent and the app both depend on. |
| `task-paper` | `packages/task-paper/src/paper.js`, `packages/task-paper/src/render.js`, `packages/task-paper/src/generate.js` | Regenerates a chronological journal into a settled-state HTML "paper" (issue #285) with a comment channel back into the journal. |
| `telegram-bridge` | `packages/telegram-bridge/src/bridge.js`, `packages/telegram-bridge/src/digest.js`, `packages/telegram-bridge/src/board.js` | A standalone Node CLI mirroring task journals into a Telegram forum and folding replies back in, plus a consolidated approval digest. |
| `overnight-agent` | `plugins/overnight-agent/skills/overnight-agent/oa-state.ps1`, `.../SKILL.md`, `.../write-turn.ps1` | A scheduled, unattended Copilot CLI plugin that scans the board, proposes and (on approval) executes plans, and self-heals its own infrastructure. See [Domain-overnight-agent](Domain-overnight-agent), [Prioritisation](Prioritisation) and [Reliability](Reliability). |
| `mcp-cred-vault` | `packages/mcp-cred-vault/src/schema.js` | Validates the non-secret pointer file that tells a machine which credentials to pull from its OS vault. |
| `install-prompt` | `packages/install-prompt/src/useInstallPrompt.js` | Cross-platform "add to home screen" PWA install UX. |
| `diagnostics` | `packages/diagnostics/src/index.js` | A shared, low-overhead event/tracing sink used by the app, its service worker, and folder-sync, so a live worker's state can be dumped on demand. |
| `scripts` | `scripts/spec/collect.mjs`, `scripts/spec/verify.mjs`, `scripts/merge-queue.mjs` | Repo-maintenance tooling: this spec's own generation pipeline, dependency-hygiene guards, and a verified PR merge order. |
| `root` | `server.js`, `vite.config.js`, `eslint.config.js` | The dev/build toolchain and the one real backend process (see below). |

## Runtime processes

There are exactly three long-lived runtime surfaces, and they do not share memory:

1. **The browser tab** — the React app (`src/App.jsx`) plus its registered service worker
   (`packages/folder-sync/src/sw.js`). The service worker owns the dirty-file queue
   (`packages/folder-sync/src/queue.js`) and the remote pull/push cycle; the main thread owns the
   UI and enqueues writes. They talk only via `postMessage`/`BroadcastChannel`, never shared state,
   because a service worker can be evicted and restarted by the browser at any time.
2. **`server.js`** — a small Express process (`GET/PUT/DELETE /api/file`, `GET /api/files`,
   `GET /api/todos`, `GET /api/journal-exists`, `POST /api/pick-folder`, `GET/POST /api/config`)
   used only in the local-folder desktop workflow described in `README.md` ("start planner"): it
   lets a locally-run Copilot CLI session read and edit the same markdown files the browser app
   uses, without going through a browser storage provider.
3. **The overnight agent** — a Copilot CLI plugin invoked by an OS-level scheduler roughly every 30
   minutes (see [Reliability](Reliability) for how that scheduler itself is kept alive). It never
   talks to `server.js` or the browser tab; it reads and writes the same files directly on disk (or
   through the synced cloud folder), which is why every board/journal format in
   [Data-Formats](Data-Formats) has to be something a PowerShell script and a browser IndexedDB
   provider can both parse identically.

The Telegram bridge (`packages/telegram-bridge/bin/telegram-bridge.js`) is a fourth, optional
process: a Node CLI, typically run as `watch`, that also reads/writes journals and its own
`state.json`. It is independent of the other three and can be absent entirely without breaking the
board or the agent — it is a mirror, not a source of truth.

## Data flow: a user action to persisted state

Take "the user completes a task from the board":

1. **App** — `src/App.jsx` calls `opAppendToCompleted`/`opRemoveTaskFromFocusPlan` (`src/focusPlanOps.js`),
   which are pure `content -> newContent` transforms over the in-memory string of `planner.md` and
   `planner-completed.md`. No I/O happens inside these functions — this is what makes the exact same
   algorithms reusable from the single-source view and the multi-source Combined view.
2. **Storage** — the new content is handed to `src/storage/storage.js`'s `write`, which delegates to
   whichever provider is active (`getActiveProvider()`), and (for FSA/OneDrive/GoogleDrive) enqueues
   the changed filename in the folder-sync dirty queue.
3. **Sync** — the service worker (`packages/folder-sync/src/sw.js`) drains the queue, parses the
   before/after board with the declarative table codec (`packages/folder-sync/src/codecs/mdTable.js`),
   diffs it into per-record changes, stamps a logical clock (`stampLocalChanges`), and reconciles
   against the remote via `mergeCollections`/`reconcileRecordsFile` before pushing — never a raw
   whole-file overwrite, so a concurrent edit on another device is merged rather than clobbered.
4. **Remote propagation** — the cloud provider (OneDrive/Google Drive) now holds the new bytes; any
   other device's own service worker pulls them down on its own poll cycle and runs the same merge
   in reverse.
5. **Downstream readers** — the Telegram bridge's next `sync-archive` pass reads `planner-completed.md`
   (via `packages/telegram-bridge/src/completed.js`) and closes the task's forum topic; the
   overnight agent's next `scan` reads the same boards and journal and stops treating the task as
   `eligible`.

No step in this chain assumes the others are running. A user can edit `planner.md` directly in a
text editor, sync it manually via any file-sync tool, and every downstream reader still functions,
because the format is the contract, not an API call.

## Why this shape, and what was rejected

The obvious alternative — a real backend with a database and an authenticated sync API — was
rejected implicitly by every module's own framing: `src/storage/storage.js` is explicitly "Storage
abstraction layer... Supports: FSA (local), OneDrive, Google Drive", never "the app's database", and
the overnight agent's entire design (see [Prioritisation](Prioritisation)) assumes it can act as a
second, independent writer to the *same* files a browser tab is editing, with no locking protocol
beyond markdown's own append-only journal convention and the sync engine's per-record CRDT. A
database-backed design would need a real API for the agent to call, real auth for a scheduled
background process to hold, and a migration story every time the schema changed. Plain files traded
that away for: the user can always read their own data with any editor, any device can be a second
"client" with zero integration work (an agent, a phone, a text editor), and the format itself
— not a server's willingness to be reachable — is the single point of truth.

See [Data-Formats](Data-Formats) for every file's exact grammar and invariants, [Prioritisation](Prioritisation)
for how the overnight agent turns the board into an ordered, gated worklist, and
[Reliability](Reliability) for how that agent stays running unattended for weeks at a time.
