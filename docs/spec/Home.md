# Focus Planner

Focus Planner is a task planner whose database is a folder of plain markdown files, read and written by
three independent runtimes — a browser web app, a Node.js Telegram bridge, and a PowerShell-driven
autonomous overnight agent — with no server and no shared schema beyond the text format itself. The
folder can live in a local File System Access handle, IndexedDB, OneDrive, or Google Drive, and can sync
across devices without a central service. The problem this solves is not "build a to-do app"; it is
"let a person and an unattended AI agent both durably act on the same prioritized worklist, from
whatever device or channel is at hand, without either one corrupting what the other wrote."

## Core design principles

**The folder is the database; markdown is the schema.** There is no database server and no ORM. Every
piece of state — the board, a task's journal, sync bookkeeping, agent memory — is a markdown or JSON
file with an explicit, tested format (see [Data-Formats](Data-Formats)). This is what makes the system
inspectable and editable by a human with a text editor, and portable across four different storage
backends without a migration.

**Every reader is independently tested, because none of them share a runtime.** The browser, the
Telegram bridge, and the overnight agent's PowerShell control layer cannot import from one another —
they run in different languages and processes. Rather than force a shared library across that boundary,
this system accepts three separate implementations of overlapping logic (e.g. board-priority sorting,
newest-turn-status reading) and pins them together with mutation tests instead of code sharing. See
[Prioritisation](Prioritisation)'s "two sort keys" discussion and [Domain:
overnight-agent](Domain-overnight-agent)'s parity mutcheck for the concrete mechanism.

**A signal the agent authored cannot be trusted as the agent's own permission to act.** This repository
has independently discovered the same failure three times: a consent marker the agent itself wrote being
read back as human approval, a closing courtesy line parking the agent's own task, and a timestamp the
agent itself stamped releasing the agent's own gate. The design principle that follows is stated
explicitly in the code: prefer a signal the agent cannot author, and where one is unavoidable, let it
only cancel a permission, never grant one. See [Prioritisation](Prioritisation).

**A passing check is not evidence, only a claim.** Sweeps, guards and gates throughout the overnight
agent are proven correct by deliberately breaking them and asserting the break is detected — the
`mutcheck-*` family — because this repository has shipped, and measured, checks that reported the same
reassuring value every single night regardless of the real state of the system. See
[Reliability](Reliability) and [Domain: overnight-agent](Domain-overnight-agent).

**Unattended supervision must be dispatched from outside the thing it supervises.** An agent, an app
scheduler, or an in-process watchdog cannot reliably notice its own death. Every layer of this system's
self-healing is deliberately dispatched from a strictly wider domain than what it watches — the OS
schedules the daemon, the daemon watches the app, a normal run watches the daemon. See
[Reliability](Reliability).

**Provenance, not urgency, is what may widen a rule.** The single sanctioned exception to the overnight
agent's default one-item concurrency is not "this is important" — it is "a user did this, not the
agent." See [Prioritisation](Prioritisation)'s dispatch-precedence section.

## What this system is not (yet)

Several things described elsewhere in this spec are explicitly unfinished, by the repository's own open
issues, not by omission of this document: pacing (issue #391) is currently prose guidance in `SKILL.md`,
not an enforced mechanism; per-task Google Doc comment attribution (#422, #442) has no positive-consent
design yet; and a number of reliability/provenance gaps remain open, catalogued in full on
[Roadmap](Roadmap). This spec describes the system as it is built today and names what is missing rather
than presenting either as finished.

## Reading order

Start with [Architecture](Architecture) for the system's shape, then [Data-Formats](Data-Formats) for
the formats every domain reads and writes. From there:

| Page | Covers |
| --- | --- |
| [Architecture](Architecture) | Domain composition, module graph, runtime boundaries, data-flow from user action to persisted state. |
| [Data-Formats](Data-Formats) | Every persisted format — board, journal, sidecars, sync state, bridge state — with real annotated samples. |
| [Domain: app](Domain-app) | The web app: board/journal transformations, sorting, moves, id lifecycle. |
| [Domain: config](Domain-config) | Scaffolded canonical docs and round-trip-safe settings views. |
| [Domain: diagnostics](Domain-diagnostics) | The opt-in, cross-worker event-tracing facility. |
| [Domain: folder-sync](Domain-folder-sync) | The record-level, tombstone-aware merge engine and its Service Worker transport. |
| [Domain: install-prompt](Domain-install-prompt) | Per-platform PWA install nudging. |
| [Domain: mcp-cred-vault](Domain-mcp-cred-vault) | The non-secret pointer file scheme for MCP server credentials. |
| [Domain: overnight-agent](Domain-overnight-agent) | The autonomous agent's sweep/mutcheck library and its shape. |
| [Domain: root](Domain-root) | Build/lint config and the legacy local-dev server. |
| [Domain: scripts](Domain-scripts) | Repository maintenance tooling and the spec pipeline's mechanism half. |
| [Domain: storage](Domain-storage) | The multi-provider storage facade (FSA/IndexedDB/OneDrive/Google Drive). |
| [Domain: task-paper](Domain-task-paper) | Regenerated, deterministic per-task HTML papers. |
| [Domain: telegram-bridge](Domain-telegram-bridge) | The mobile journal mirror and reply-folding bridge. |
| [Prioritisation](Prioritisation) | How priority is expressed, changed, and dispatched — the full sort key, the Today gate, pacing, dispatch precedence. |
| [Behaviour](Behaviour) | The system's required behaviour as testable statements, grouped by area. |
| [Rebuilding](Rebuilding) | A dependency-ordered build guide from an empty directory. |
| [Reliability](Reliability) | How the unattended overnight agent stays running and heals itself. |
| [Roadmap](Roadmap) | Known gaps and direction, grouped by priority, from open issues. |
| [Updating-the-Spec](Updating-the-Spec) | How this specification itself is generated, verified, and published. |
