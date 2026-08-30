# Architecture

## Domains and how they compose

The system decomposes into eleven domains. Three (`app`, `config`, `storage`) run inside
the browser SPA; `folder-sync` runs partly on the main thread and partly in a service
worker; `telegram-bridge`, `overnight-agent`, and `mcp-cred-vault` run as independent Node
processes outside the browser entirely; `diagnostics` and `install-prompt` are small
shared packages consumed by the app; `scripts` and `root` are build/dev tooling.

| Domain | Modules | Principal module(s) | Runs in |
| --- | --- | --- | --- |
| `app` | 31 | `src/App.jsx`, `src/focusPlanOps.js`, `src/journalChat.js` | Browser (React) |
| `config` | 5 | `src/config/agentsDoc.js`, `src/config/userSettingsForm.js` | Browser |
| `storage` | 12 | `src/storage/storage.js`, `src/storage/sources.js` | Browser |
| `folder-sync` | 16 | `packages/folder-sync/src/engine.js`, `packages/folder-sync/src/merge.js`, `packages/folder-sync/src/sw.js` | Browser main thread + Service Worker |
| `diagnostics` | 1 | `packages/diagnostics/src/index.js` | Browser (both contexts) |
| `install-prompt` | 8 | `packages/install-prompt/src/useInstallPrompt.js`, `packages/install-prompt/src/InstallModal.jsx` | Browser |
| `telegram-bridge` | 16 | `packages/telegram-bridge/src/bridge.js`, `packages/telegram-bridge/bin/telegram-bridge.js` | Node (standalone CLI/daemon) |
| `overnight-agent` | 127 | `plugins/overnight-agent/skills/overnight-agent/SKILL.md`, `plugins/overnight-agent/checks/repo-drift-sweep.mjs` | Copilot CLI plugin (Node checks + PowerShell skill scripts) |
| `mcp-cred-vault` | 2 | `packages/mcp-cred-vault/src/schema.js` | Windows PowerShell/.NET launcher (JS surface only validates its pointer file) |
| `scripts` | 6 | `scripts/copy-sw.mjs`, `scripts/spec/collect.mjs`, `scripts/merge-queue.mjs` | Node (dev/CI tooling) |
| `root` | 3 | `server.js`, `vite.config.js`, `eslint.config.js` | Node (dev server) / build config |

Composition is **file-mediated, not API-mediated**, between the browser app and the two
standalone Node processes: `telegram-bridge` and `overnight-agent` never call into the
React app. They read and write the same `planner.md` / `planner-completed.md` /
`journal/task-<id>.md` files directly from disk (typically the same OneDrive-synced
folder the app itself uses), relying entirely on the markdown conventions documented in
[Data-Formats](Data-Formats) to interoperate safely. This is a deliberate boundary: it
means the planner data format, not a network API, is the integration contract, so any
future consumer (a different bridge, a different agent) only needs to honor the same
markdown conventions to participate.

## Module graph in prose

**`app`** depends on **`storage`** (to read/write files), **`config`** (for branding,
`AGENTS.md` content, and the `user-settings.md` template), and **`install-prompt`** (PWA
install UI). `storage` depends on **`folder-sync`**'s adapters and codecs indirectly via
shared IndexedDB conventions, and on **`diagnostics`** for structured event logging.
`folder-sync` is self-contained except for `diagnostics`; its `sw.js` service worker is
copied into `public/folder-sync/` at build/dev time by `scripts/copy-sw.mjs` because a
service worker must be served from the page's own origin — it cannot be imported directly
from `node_modules`/`packages/`.

`telegram-bridge` is architecturally independent of the browser code: it has its own
`journal.js`/`board.js`/`completed.js`/`deleted.js` parsers that read the *same* markdown
conventions the app writes, but do not import any `src/` module. The one exception is
`packages/telegram-bridge/src/deepLink.js`, which is explicitly documented as
dependency-free specifically so it is safe to import from both the Node bridge and the
browser app (for rendering a task's Telegram deep link inside the journal chat UI).

`overnight-agent`'s 127 modules are almost entirely `checks/*.mjs` — read-only "sweeps"
that audit the same markdown files plus the agent's own SQLite session-state store, and
"mutcheck" tests that verify each sweep still fails when the bug it guards is
reintroduced. Like `telegram-bridge`, this domain has no import dependency on `src/`; it
is coupled to the rest of the system only through the markdown file conventions and the
Telegram bridge's journal/state formats it also audits (e.g.
`plugins/overnight-agent/checks/telegram-ask-truncation-sweep.mjs` exercises the shipped
`telegramFormat.js`/bridge parser rather than a reimplementation, specifically so the
check cannot drift from what actually ships).

`scripts/spec/collect.mjs` and `scripts/spec/verify.mjs` (this specification's own
generator and gate) statically scan the whole repository; they have no runtime
dependency on any domain, by design, so they cannot inherit a bug from the code they are
checking.

## Process and runtime boundaries

1. **Browser tab (main thread).** Runs the React app, the storage provider abstraction,
   and the folder-sync *engine* (which enqueues writes and reads status, but does not
   itself talk to the network).
2. **Browser tab (Service Worker).** Runs `packages/folder-sync/src/sw.js`, registered
   with `{ type: 'module' }`. It drains the dirty-file queue (`packages/folder-sync/src/queue.js`),
   performs the actual OAuth-token-bearing HTTP calls to OneDrive/Google Drive, and posts
   status back to the main thread over a `BroadcastChannel`. This isolation exists so
   network/sync work does not block the UI thread and survives tab navigation.
3. **Local dev server (Node, `server.js`).** Optional convenience layer exposing
   `/api/files`, `/api/file`, `/api/todos`, `/api/journal-exists`, `/api/pick-folder`, and
   `/api/config` over the local filesystem, for the desktop-folder storage mode described
   in the top-level README. It is not on the critical sync/consistency path — it is a
   thin passthrough to disk.
4. **Telegram bridge process (Node, standalone).** Invoked as a CLI
   (`packages/telegram-bridge/bin/telegram-bridge.js`) with subcommands `sync-up`,
   `sync-down`, `sync-archive`, `digest`, or `once`/`watch` to loop them. Reads its own
   config from environment variables (bot token sourced from the OS credential vault, per
   `packages/telegram-bridge/src/config.js`) and persists bridge state
   (`packages/telegram-bridge/src/state.js`) outside the synced planner folder.
5. **Overnight Agent (Copilot CLI plugin).** Not a long-running server; it is invoked
   per-run by the Copilot CLI following `plugins/overnight-agent/skills/overnight-agent/SKILL.md`'s
   inbox-check → execute-approved-plans → propose-new-plans loop, shelling out to the
   `checks/*.mjs` sweeps and PowerShell helper scripts as needed.

## Data flow: user action to persisted state

A single edit — say, the user drags a task from Today to Deferred — flows as:

1. **UI event** in `src/App.jsx` calls a pure op from `src/focusPlanOps.js`
   (`opMoveBetweenSections`), which takes the current `planner.md` content string and
   returns a new content string. No I/O happens inside the op itself.
2. **Write** goes through `src/storage/storage.js`'s `write()`, which delegates to
   whichever provider is active (`src/storage/fsa-provider.js`,
   `src/storage/onedrive-provider.js`, `src/storage/google-drive-provider.js`, or
   `src/storage/indexeddb-provider.js`).
3. If a folder-sync target is configured, the same write also lands in the local
   `folder-sync` adapter and enqueues the filename via `packages/folder-sync/src/queue.js`.
4. The **service worker** wakes (or is already running), dequeues the file, parses it
   into records with `packages/folder-sync/src/codecs/mdTable.js`, stamps a logical clock
   on the changed row via `stampLocalChanges` in `packages/folder-sync/src/merge.js`, and
   reconciles it against the remote copy (`packages/folder-sync/src/reconcile.js`,
   `packages/folder-sync/src/records.js`) before pushing the merged file and its
   `.sync.json` sidecar back to OneDrive/Google Drive.
5. **Downstream consumers** — another browser tab's sync pull, the Telegram bridge's next
   `sync-up`/`sync-archive` pass, or the Overnight Agent's next board read — observe the
   change the next time they read the same markdown file, because there is no push
   notification between these independent processes; consistency is achieved entirely
   through the shared file format and its embedded clocks/tombstones.

This "shared file, independent readers/writers, reconciled by embedded metadata" shape —
rather than a central database with subscribers — is why the merge and provenance rules
in [Data-Formats](Data-Formats) carry the entire correctness burden of the system.
