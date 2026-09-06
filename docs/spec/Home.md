# Focus Planner

Focus Planner is a task board and journal system whose database is plain markdown files, editable by
a human in any text editor, a browser tab, or an unattended overnight agent, with no server-side
database and no accounts system standing between any of them. The problem it solves is keeping one
person's task list, priority ordering, and per-task working notes consistent across three things that
would otherwise drift apart: a phone or laptop browser, a second device syncing the same folder, and a
nightly Copilot CLI agent that reads the board and acts on it while its owner sleeps.

## Core design principles

**The file format is the API.** Nothing in this system talks to anything else over a socket or a
shared process. A browser tab, a PowerShell agent, and a Node CLI collaborate on the same
`planner.md` and `journal/task-<id>.md` files purely by reading and writing them, at different times,
leaving marks (`<!-- from: ... -->`, a `turn-end` stamp, a board cell) that tell the next reader what
happened. See [Architecture](Architecture).

**One alignment rule, shared by every reader and writer.** `planner.md`'s tables are ragged by
construction — hand-edited, evolving column sets, ambiguous short rows — so the question "which cell
is this row's `Linked ID`?" is answered in exactly one place (`src/boardRow.js`) and imported
everywhere else. Issue #426 is what happens when two implementations of that question disagree. See
[Data-Formats](Data-Formats) and [Domain-app](Domain-app).

**Ordering is data, not judgement.** The overnight agent does not decide what to work on next by
reasoning about the board in its head; `oa-state.ps1 scan` computes a sorted worklist with a binding
`eligible` flag once, so two runs over an unchanged board produce the same order and that order is
auditable afterward. See [Prioritisation](Prioritisation).

**A gate must never be releasable by the thing it gates.** The Today→Deferred gate, exhaustion
declarations, capacity accounting, and journal consent markers have each, at different times, been
broken the same way: a signal the agent's own software produced was trusted to open a door only a
human's action should open. The fix is always to key release on something external — board text,
wall-clock staleness, a fresh declaration each run. See [Prioritisation](Prioritisation) and
[Reliability](Reliability).

**Reliability is out-of-band, not self-supervised.** An agent that supervises itself cannot detect
that it has stopped running. Every liveness, restart, and deploy-propagation mechanism in this system
is dispatched by something outside the process it watches — the OS scheduler, a second unattended
dispatcher, a nightly sweep that audits its own archive. See [Reliability](Reliability).

**Write append-only where correctness matters.** Journals are never rewritten, only appended to, by
exactly one sanctioned writer (`write-turn.ps1`) carrying explicit guards against known corruption
classes. See [Data-Formats](Data-Formats) and [Reliability](Reliability).

## Priority icons

| Icon | Meaning |
| --- | --- |
| 🔴 | Urgent & Important |
| 🟡 | Important, Not Urgent |
| 🔵 | Urgent, Not Important |
| ⚪ | Not Urgent, Not Important |
| ✅ | Done |
| 🐸 | Frog (eat first) |
| 📖 | Learning |

## Where things are unfinished

This is a system under active development, not a finished product. [Roadmap](Roadmap) surveys all 129
open issues by priority label; the most consequential open gaps are capacity accounting in the
overnight agent's dispatch logic, doc-binding integrity for the catch-up-doc channel, and provenance
markers that distinguish agent-authored from human-authored state. [Prioritisation](Prioritisation)
and [Reliability](Reliability) both call out, inline, which of the mechanisms they describe are shipped
code versus run-loop guidance still tracked by an open issue.

## Page index

| Page | Contents |
| --- | --- |
| [Architecture](Architecture) | The domains, how they compose, process/runtime boundaries, and the data-flow from a user action to persisted state. |
| [Data-Formats](Data-Formats) | Every persisted format — the board, journals, agent state, sync sidecars — with annotated real samples and invariants. |
| [Domain-app](Domain-app) | The board UI, journals-as-chat, settings editors, multi-source routing. |
| [Domain-config](Domain-config) | The agent-gate and user-settings schemas, `AGENTS.md` generation, branding. |
| [Domain-diagnostics](Domain-diagnostics) | The cross-realm (tab ↔ service-worker) diagnostic event bus. |
| [Domain-folder-sync](Domain-folder-sync) | The offline-first multi-device sync engine for markdown + sidecar files. |
| [Domain-install-prompt](Domain-install-prompt) | The PWA "add to home screen" UX. |
| [Domain-mcp-cred-vault](Domain-mcp-cred-vault) | The non-secret pointer manifest binding MCP servers to OS credential storage. |
| [Domain-overnight-agent](Domain-overnight-agent) | The unattended nightly Copilot CLI plugin and its self-testing check suite. |
| [Domain-root](Domain-root) | The static file server and shared build tooling. |
| [Domain-scripts](Domain-scripts) | Repo hygiene, board-repair one-offs, and the spec-generation pipeline itself. |
| [Domain-storage](Domain-storage) | The pluggable multi-provider file-storage abstraction the whole app is built on. |
| [Domain-task-paper](Domain-task-paper) | The static-site generator turning journals into standalone HTML "papers". |
| [Domain-telegram-bridge](Domain-telegram-bridge) | The Node CLI mirroring the board/journals into a Telegram forum and folding replies back. |
| [Prioritisation](Prioritisation) | How priority is expressed, changed, gated, paced, and dispatched — the system's most load-bearing behaviour. |
| [Behaviour](Behaviour) | The system's required behaviour as testable statements, grouped by area. |
| [Rebuilding](Rebuilding) | A build-order guide, with a verification step at each stage, for starting from an empty directory. |
| [Updating-the-Spec](Updating-the-Spec) | The maintenance guide for this spec: the pipeline, the verifier, and its traps. |
| [Roadmap](Roadmap) | Known gaps and direction, grouped by priority label, referencing open issues. |
| [Reliability](Reliability) | How the unattended overnight agent stays running on one machine and heals itself. |
