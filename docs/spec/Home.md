# Focus Planner

Focus Planner is a markdown-backed task planner: the database is a folder of plain markdown files
(`planner.md`, `planner-completed.md`, one journal per task) that a human can open, read and edit in
any text editor, and that a browser-based board, a static journal viewer, a Telegram bot, and an
autonomous overnight agent all read and write concurrently, kept consistent by a CRDT sync layer and
a deliberately narrow set of shared parsing rules. There is no application database — the files are
the system of record, and every reader is required to derive the same view of them.

## The problem this solves

A task planner that only one program can read stops being useful the moment you want a second way
into the same data — a phone, a chat bot, an autonomous agent working overnight, a plain-text
editor when nothing else is available. The alternative to a real backend is not "no design," it is a
harder design problem: multiple independent readers and writers touching the same small set of
human-readable files, occasionally offline, occasionally concurrent, with no server to arbitrate.
Every core design decision in this system exists to make that safe:

- **One file format, many readers, one parser per format.** The board's `Wake`/`Linked ID` column
  ambiguity (issue #426) and the journal chat grammar are each read and written by exactly one shared
  implementation, never independently reimplemented per surface — see [Data-Formats](Data-Formats).
- **CRDT merge instead of last-write-wins.** Two devices editing the same file offline must both
  survive reconnection without silently losing a change — see [Architecture](Architecture) and
  [Domain-folder-sync](Domain-folder-sync).
- **Priority is data, not judgement.** What order the overnight agent works tasks in is a
  deterministic function of the board's own content, never the agent's improvisation — see
  [Prioritisation](Prioritisation).
- **An unattended agent must fail narrow and loud, not silently.** A 30-minute cron job with no
  human watching a given run needs to detect its own stuck states and repair them, or say clearly
  that it could not — see [Reliability](Reliability).
- **A signal the agent can write about itself must never carry the authority of a signal only the
  user can produce.** This single principle recurs across consent, the Today-gate, and dispatch
  precedence — see [Prioritisation](Prioritisation) §5–7.

## How the pieces fit together

Twelve domains divide the system: a browser-facing board (`app`), the on-disk formats and their
shared config (`config`, `storage`), a bidirectional sync engine (`folder-sync`), an autonomous
overnight worker (`overnight-agent`), a Telegram mirror (`telegram-bridge`), a static journal
publisher (`task-paper`), supporting services (`mcp-cred-vault`, `install-prompt`, `diagnostics`),
the server and build entry points (`root`), and repository tooling including this spec's own
generation pipeline (`scripts`). See [Architecture](Architecture) for how they compose at runtime and
[Rebuilding](Rebuilding) for the order to build them in.

## Pages

| Page | Contents |
| --- | --- |
| [Architecture](Architecture) | Domains, module graph, runtime processes, data-flow from user action to persisted state. |
| [Data-Formats](Data-Formats) | Every persisted format — board, journals, agent/bridge state — with annotated real samples and invariants. |
| [Domain-app](Domain-app) | The board UI and its pure content-transformation core. |
| [Domain-config](Domain-config) | Agent gate, user settings, `AGENTS.md`, and their write-safety guarantees. |
| [Domain-diagnostics](Domain-diagnostics) | Structured, no-content-leak logging shared across storage providers. |
| [Domain-folder-sync](Domain-folder-sync) | The CRDT merge engine and service-worker sync client. |
| [Domain-install-prompt](Domain-install-prompt) | The install/onboarding prompt UI (and its untested-code gap). |
| [Domain-mcp-cred-vault](Domain-mcp-cred-vault) | Schema-validated credential storage for MCP servers. |
| [Domain-overnight-agent](Domain-overnight-agent) | The autonomous work-loop plugin: state machine, run phases, self-healing checks. |
| [Domain-root](Domain-root) | The Express server, build entry points, and repo-wide lint config. |
| [Domain-scripts](Domain-scripts) | Build glue, developer-safety scripts, and the spec generation pipeline. |
| [Domain-storage](Domain-storage) | The multi-provider file storage abstraction underlying the board and sync. |
| [Domain-task-paper](Domain-task-paper) | Static journal-to-HTML publishing. |
| [Domain-telegram-bridge](Domain-telegram-bridge) | The Telegram mirror: digest, live status, reply routing. |
| [Prioritisation](Prioritisation) | How priority is expressed, changed, and turned into an ordered, gated, paced worklist. |
| [Behaviour](Behaviour) | Testable behavioural requirements, grouped by area. |
| [Rebuilding](Rebuilding) | Build order for reconstructing the system from an empty directory. |
| [Updating-the-Spec](Updating-the-Spec) | How this spec itself is generated, verified and published. |
| [Roadmap](Roadmap) | Open issues grouped by priority. |
| [Reliability](Reliability) | How the unattended overnight agent stays running and heals itself. |
