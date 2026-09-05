# Architecture

## Shape of the system

Focus Planner is a **markdown-backed planner** with no database and no application server of
record. The durable state is a folder of plain-text files (`planner.md`, `planner-completed.md`,
`journal/task-<id>.md`, and a handful of small JSON/markdown sidecars). Everything else — a React
PWA, a background sync engine, a Node CLI that bridges to Telegram, and a Windows-resident
autonomous agent — is a *reader and writer of that folder*, never an owner of state the folder
doesn't already have. This is the central design decision the whole system is built around: any
client that can read and write markdown can participate, including a human with a text editor.

The repository therefore has three runtime surfaces, all pointed at the same folder:

1. **The web app** (`src/`, built with Vite/React, `domain: app`) — the primary UI. Runs entirely
   client-side; there is no required backend. It talks to storage through one of four interchangeable
   providers (local File System Access, browser IndexedDB, OneDrive, Google Drive — `domain: storage`)
   and, for the two cloud providers, through a background sync engine running in a Service Worker
   (`packages/folder-sync`, `domain: folder-sync`).
2. **The Telegram bridge** (`packages/telegram-bridge`, `domain: telegram-bridge`) — a dependency-free
   Node CLI that mirrors task journals into a Telegram forum (one task = one topic) and folds replies
   back into journals, so the same folder can be worked from a phone.
3. **The Overnight Agent** (`plugins/overnight-agent`, `domain: overnight-agent`) — a GitHub Copilot
   CLI plugin, installed on the user's own Windows machine, that autonomously proposes and executes
   work against the same journals under a plan → approve → execute loop, gated by files the user
   (never the agent) authors.

Two smaller domains cut across all three: `config` (the schema and round-trip-safe editors for the
small control files — `agent-gate.md`, `user-settings.md`, `AGENTS.md` — that the app scaffolds and
the agent reads) and `diagnostics` (a shared, secret-safe event log used by both the app and the sync
worker). `task-paper` (a static HTML "paper" generator), `install-prompt` (PWA install UX),
`mcp-cred-vault` (a non-secret pointer-file schema for the agent's credential wiring) and `scripts`
(repo tooling, including the pipeline that produced this document) round out the twelve domains in
`spec-facts.json`. `root` covers the three files that configure the whole repo:
`eslint.config.js`, `vite.config.js`, and the legacy dev-only `server.js`.

## Why a folder of markdown, not a database

The alternative — a conventional client/server app with a real database — was rejected implicitly by
every design choice in the storage layer: `src/storage/storage.js`'s doc comment states the supported
backends as "FSA (local), OneDrive, Google Drive," i.e. the user's own storage, not a service this
project operates. The payoff is that **the data has no dependency on this application continuing to
exist** — `src/config/agentsDoc.js` scaffolds an `AGENTS.md` into every connected folder specifically
so "a user can point ANY agent at the folder and it will know how to read and update the files —
without needing this app's source." The cost is that every consistency property a database would give
for free (atomic multi-record transactions, foreign keys, a single writer) has to be built by hand at
the file level — which is why `packages/folder-sync/src/merge.js` exists at all (see
[Data-Formats](Data-Formats) and [Domain-folder-sync](Domain-folder-sync)).

## Module graph, by data-flow

```
                     ┌───────────────────────────┐
                     │        src/App.jsx        │  (7,215 lines; the UI shell)
                     └─────────────┬─────────────┘
     imports pure ops from:        │              imports storage from:
     boardRow.js / boardTable.js   │              storage/storage.js
     focusPlanOps.js / snooze.js   │                ├─ fsa.js (local folder)
     taskSort.js / moveTask.js     │                ├─ indexeddb-provider.js (browser)
     journalChat.js                │                ├─ google-drive-provider.js
     idTombstones.js               │                ├─ onedrive-provider.js
     selfHealIds.js                │                └─ sources.js (multi-source registry)
                     ┌─────────────┴─────────────┐
                     │  packages/folder-sync      │  (Service Worker; OneDrive/GDrive only)
                     │  engine.js -> queue.js      │
                     │            -> records.js    │
                     │               -> merge.js   │  <- pure, per-record LWW + tombstones
                     │               -> codecs/    │     mdTable.js: table <-> records
                     └─────────────┬─────────────┘
                                   │  writes/reads
                     ┌─────────────┴─────────────┐
                     │   planner.md / planner-    │
                     │   completed.md / journal/  │  <- the actual database
                     │   *.md + small JSON/md      │
                     │   sidecars (see Data-Formats)│
                     └─────────────┬─────────────┘
                    reads/writes   │    reads/writes
       ┌───────────────────────────┤    ├───────────────────────────┐
       │ packages/telegram-bridge  │    │ plugins/overnight-agent    │
       │ bridge.js orchestrates:   │    │ SKILL.md (the run loop) +  │
       │  board.js / journal.js /  │    │ oa-state.ps1 (the state    │
       │  digest.js / liveStatus.js│    │ machine: scan/mark/session)│
       │  routeReply.js / state.js│    │ + ~150 checks/*.mjs|ps1     │
       └───────────────────────────┘    │   (mutation-tested guards) │
                                         └───────────────────────────┘
```

`src/focusPlanOps.js` and `src/boardTable.js` are the app's writer and reader of `planner.md`;
`packages/telegram-bridge/src/board.js` and `plugins/overnight-agent/skills/overnight-agent/oa-state.ps1`
are two more independent readers of the *same* file. `src/boardRow.js` exists specifically to stop the
app's own reader and writer from disagreeing with each other (issue #426) — see
[Data-Formats](Data-Formats) for the ragged-header problem it solves. There is no shared library
across the three languages/runtimes (JS in the browser, JS in Node, PowerShell on Windows), so each
side's parser is a separate, independently-tested implementation of the same grammar; keeping the
grammar simple (plain markdown tables, HTML-comment markers) is what makes three independent readers
tractable at all.

## Process and runtime boundaries

| Surface | Runtime | Lifetime | Talks to storage via |
| --- | --- | --- | --- |
| Web app | Browser tab (React, client-side only) | Open tab | Storage provider directly (FSA/IndexedDB) or via the Service Worker engine (OneDrive/GDrive) |
| Sync engine | Browser Service Worker (`packages/folder-sync/src/sw.js`) | Registered once, survives tab closes | OAuth'd HTTP to OneDrive/Google Drive; IndexedDB for its own queue/tokens/sidecars |
| Telegram bridge | Node CLI process (`packages/telegram-bridge/bin/telegram-bridge.js`), invoked by the agent's scheduled run or `watch` | One process per `once`/`watch` invocation | Direct filesystem read/write of the same folder the app uses (via `--journals`/`PLANNER_PATH`) |
| Overnight Agent | GitHub Copilot CLI session on the user's Windows machine, dispatched on a schedule | One run per dispatch (`*/30` by default); `oa-supervisor` keeps the schedule itself alive (see [Reliability](Reliability)) | Direct filesystem read/write via `oa-state.ps1`; own private state under `%LOCALAPPDATA%\overnight-agent\state\`, never in the synced folder |
| `server.js` (repo root) | Local Node/Express process, dev-only | Manual `npm run server` | Direct filesystem, hard-coded to a sibling `../planner` directory — a legacy convenience path, not part of the shipped app's storage abstraction |

The web app and the agent never talk to each other directly: every hand-off between "what the user
wants" and "what the agent may do unattended" is mediated by a file the user owns —
`agent-gate.md` (`src/config/agentGate.js`) for standing permissions, `user-settings.md`
(`src/config/aiSettings.js` / `src/config/userSettingsForm.js`) for run configuration — plus the
journals themselves as the record of proposed/approved/executed work. This indirection is deliberate:
issue #250 records that when approval instead rested on a marker (`<!-- from: me -->`) that the
agent's own software writes, the agent could not distinguish a user's authorization from its own
prose, and it cost a real granted permission on 2026-08-31. `agentGate.js`'s doc comment states the
fix as a design rule: a file "human-authored by construction," seeded once and never rewritten by the
app once populated, needs no attribution marker at all because only the human can have put text there.

## Data-flow: a task from user action to persisted state

1. **User adds a task** in the board UI → `opAddTask` (`src/focusPlanOps.js`) returns new file content
   for `planner.md`, allocating the next id via `allocateNextId` (skipping ids protected by an active
   *tombstone*, `src/idTombstones.js`) → `storage.write()` persists it through the active provider.
2. **On a local/FSA or IndexedDB source**, the write is durable immediately. **On OneDrive/Google
   Drive**, the write also lands in the local mirror immediately (optimistic), and the filename is
   enqueued (`packages/folder-sync/src/queue.js`) for the Service Worker to push to the remote — see
   [Domain-folder-sync](Domain-folder-sync) for the record-level merge that keeps two devices' edits
   from clobbering each other.
3. **The agent's next scheduled run** calls `oa-state.ps1 scan`, which re-reads `planner.md` and
   `journal/*.md` directly off disk (or the synced OneDrive folder), computes each row's eligibility,
   and returns an ordered worklist — see [Prioritisation](Prioritisation).
4. **The agent proposes/executes work** by appending to the task's journal (never rewriting it — see
   [Data-Formats](Data-Formats)) and, if Telegram mirroring is enabled, the bridge's next `sync-up`
   posts that turn into the task's forum topic; a reply there is folded back into the same journal by
   `sync-down`, which is exactly the same kind of append the app's own UI would make, using the shared
   `<!-- from: me -->` grammar (`src/journalChat.js`) so no reader has to special-case where a message
   came from.
5. **The user completes or deletes the task** in the app → the row moves from `planner.md` to
   `planner-completed.md` (or is removed with a tombstone written to the sidecar) → the bridge's next
   `sync-archive` closes the task's Telegram topic, and the agent's next `scan` stops treating the task
   as workable.

Every step in that chain is a plain read-modify-write of a text file; nothing here requires a running
server, a database migration, or the app being open. That is what "the folder is the database" means
concretely, and it is why [Data-Formats](Data-Formats) — not this page — is the artifact a rebuilder
most needs.

See also: [Data-Formats](Data-Formats) for the file formats, [Prioritisation](Prioritisation) for how
the board's own ordering becomes the agent's worklist, [Reliability](Reliability) for how the agent
stays running unattended, and the per-domain pages for each module's exports and tests.
