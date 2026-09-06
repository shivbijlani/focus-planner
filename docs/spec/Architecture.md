# Architecture

## What this system is

Focus Planner is a task board and journal system whose database is plain markdown files in a
user-chosen folder (local disk, OneDrive, or Google Drive), a React SPA that reads and writes those
files directly from the browser, and an unattended nightly agent (a Copilot CLI plugin) that reads the
same files and acts on them. There is no server-side database and no accounts system; the browser's
Storage/File-System-Access APIs (or a cloud provider's REST API) *are* the persistence layer, and a
lightweight Node/Express process (`server.js`) exists only to serve the built SPA and a couple of local
dev conveniences — it holds no application state.

## The twelve domains

| Domain | Responsibility | Principal module |
| --- | --- | --- |
| `app` | The board UI, journals-as-chat, settings editors, multi-source routing | `src/App.jsx` |
| `config` | Branding, the agent-gate and user-settings schemas, `AGENTS.md` generation | `src/config/agentGate.js` |
| `diagnostics` | Cross-realm (tab ↔ service-worker) diagnostic event bus | `packages/diagnostics/src/index.js` |
| `folder-sync` | Offline-first multi-device sync engine for markdown+sidecar files | `packages/folder-sync/src/merge.js` |
| `install-prompt` | PWA "add to home screen" UX | `packages/install-prompt/src/InstallModal.jsx` |
| `mcp-cred-vault` | Non-secret pointer manifest binding MCP servers to OS credential storage | `packages/mcp-cred-vault/src/schema.js` |
| `overnight-agent` | The unattended nightly Copilot CLI plugin and its self-testing check suite | `plugins/overnight-agent/checks/mutcheck-doc-comments.mjs` |
| `root` | The static file server and shared build tooling | `server.js` |
| `scripts` | Repo hygiene, board repair one-offs, and the spec-generation pipeline itself | `scripts/spec/conflicts.mjs` |
| `storage` | The pluggable multi-provider file-storage abstraction the whole app is built on | `src/storage/google-drive-provider.js` |
| `task-paper` | Static-site generator turning journals into standalone HTML "papers" | `packages/task-paper/src/render.js` |
| `telegram-bridge` | Node CLI mirroring the board/journals into a Telegram forum, and folding replies back | `packages/telegram-bridge/src/bridge.js` |

Each domain has its own page (`Domain-<name>.md`) with exports, rationale, and behavioural
requirements; this page is about how they compose.

## How the domains compose

```
                       ┌───────────────────────────────┐
                       │   planner.md / journal/*.md    │  ← the database
                       │   (local disk / OneDrive /     │
                       │    Google Drive)                │
                       └───────────────┬────────────────┘
              read/write               │               read/write
        ┌──────────────────────────────┼───────────────────────────────┐
        │                              │                                │
┌───────▼────────┐           ┌─────────▼─────────┐          ┌───────────▼───────────┐
│  browser SPA    │           │  overnight-agent    │          │  telegram-bridge CLI   │
│  (`app` domain,  │◄────────►│  Copilot CLI plugin │◄────────►│  (`telegram-bridge`)   │
│  via `storage`)  │  folder- │  (`overnight-agent`)│  Telegram│                        │
│                  │  sync    │  reads via the same  │  API     │                        │
└──────────────────┘  engine  │  storage convention  │          └────────────────────────┘
                               └──────────────────────┘
```

`storage` is the seam every other domain is built against: it exposes one interface
(`storage.read/write/list`) with five interchangeable backends (in-memory, IndexedDB, File System
Access, OneDrive, Google Drive). `app`, `folder-sync`, `task-paper`, and (via its own filesystem
reads, not the browser storage API) `overnight-agent` and `telegram-bridge` all operate on the same
on-disk file shapes described in [Data-Formats](Data-Formats) — this is what lets three independent
processes (a browser tab, a PowerShell agent, a Node CLI) collaborate on one file without a shared
server: the file format itself is the API.

`folder-sync` exists because `storage` alone is not enough once more than one **device** (not just one
browser tab) edits the same folder: a service worker background-syncs a per-record clock/tombstone
model (§9 of [Data-Formats](Data-Formats)) so two devices editing offline never silently drop each
other's rows. `diagnostics` is the narrow channel that lets the SPA's tab and its own service worker
report health to each other despite living in different JS realms.

`config` is shared, not owned by any runtime: `agent-gate.md` and `user-settings.md` are read by both
the browser (`AgentGateEditor.jsx`/`AgentSettingsEditor.jsx`) and the PowerShell agent (`oa-state.ps1`),
so their parsers live once in `src/config/` and the agent-facing generated doc (`AGENTS.md`) is derived
from the same source that drives the UI, rather than hand-kept in sync.

`overnight-agent` and `telegram-bridge` are the two processes that act on the planner data
**without** a human driving the browser. They are decoupled from each other: the bridge mirrors state
outward to Telegram and folds replies back into journals; the agent reads journals (including folded
replies) to decide what to do next. Neither imports the other; they meet only in the shared journal
file format.

`mcp-cred-vault` and `install-prompt` are narrower utilities consumed by `app` and by
`overnight-agent`'s MCP tooling respectively; `scripts` and `root` are build/ops tooling that does not
ship in the running product but is versioned as first-class code because — as `scripts`'s own
`check-node-modules.mjs` and the spec pipeline itself demonstrate — undocumented tooling regresses
exactly like undocumented product code.

## Process and runtime boundaries

| Runtime | What runs there | Domains |
| --- | --- | --- |
| Browser tab (React) | The SPA: board, journals, settings | `app`, `config`, `install-prompt`, `mcp-cred-vault` (read), `diagnostics` (client side) |
| Browser service worker | Background sync of the folder-sync engine | `folder-sync`, `diagnostics` (worker side) |
| Node (`server.js`) | Serves the built SPA; no application state | `root` |
| Node CLIs (invoked ad hoc or by CI) | `task-paper` generation, `telegram-bridge` mirror/poll, repo/board maintenance scripts | `task-paper`, `telegram-bridge`, `scripts` |
| PowerShell, scheduled on one machine | The overnight agent: scan, dispatch, act, write turns | `overnight-agent` |
| GitHub Actions | CI (lint/test/build), deploy, spec generation/publish | `scripts` (spec pipeline), workflows described in [Updating-the-Spec](Updating-the-Spec) |

The browser and the overnight agent never talk to each other directly — no socket, no shared process.
They coordinate purely by reading and writing the same files, at different times, and by leaving marks
in those files (`<!-- from: ... -->`, `<!-- .../turn-end -->`, board cells) that tell the other party
what happened. This is a deliberate simplicity choice: it means the whole system keeps working if the
browser is closed, the laptop is off, or the agent plugin is disabled, because neither side depends on
the other being live.

## Data flow: a user action to persisted state

1. A user clicks "defer" on a board row in the SPA (`app` domain).
2. `focusPlanOps.opMoveLinesBetweenSections` computes new file content — a pure string transform, no
   I/O.
3. The SPA calls `storage.write('planner.md', newContent)` — routed to whichever of the five backends
   is active for that source (`storage` domain).
4. If the active source is folder-synced, the service worker (`folder-sync`) diffs the new content
   against its sidecar, stamps a fresh logical clock on the changed row, and later background-syncs that
   record to the cloud provider and to other devices' sidecars.
5. On the machine running the overnight agent, the next scheduled run's `scan` phase (`oa-state.ps1`,
   `overnight-agent` domain) reads the updated `planner.md`, recomputes the worklist and each row's
   `eligible` flag (see [Prioritisation](Prioritisation)), and may act — writing a turn into
   `journal/task-<id>.md` via `write-turn.ps1`.
6. If Telegram mirroring is configured, `telegram-bridge` picks up the new board state and journal turn
   on its own poll cycle and mirrors them into the task's forum topic; a reply typed there is folded
   back into the same journal file, where it becomes ordinary chat content the SPA, the agent, and
   `task-paper` all read identically.
