# Focus Planner — Design Thesis

Focus Planner is a **markdown-backed task planner**: the database is a handful of
plain-text `.md` files (`planner.md`, `planner-completed.md`, `journal/task-<id>.md`,
`user-settings.md`, `AGENTS.md`), and the React app is a *view and editor* over those
files, not their owner. The files are the source of truth; the app, the sync engine, the
Telegram bridge and the overnight autonomous agent are all peers that read and write the
same markdown through the same conventions. Anyone with a text editor — human or AI agent
— can open the folder and understand it without this app's source, because the folder
scaffolds its own contract (`AGENTS.md`) and the app never invents a proprietary
serialization to hide state in.

## The problem this solves

A task list that only an app can read is a task list you cannot inspect, diff, back up,
sync with your own tools, or hand to an unrelated AI agent. Focus Planner rejects that
trade: every persisted artifact is markdown or small JSON sidecars a human can open. This
buys three things the design leans on hard:

1. **Multi-writer safety.** Because the files are plain text, more than one process
   legitimately writes them — the browser app, a folder-sync service worker replicating
   across OneDrive/Google Drive/local devices, a Telegram bridge folding phone replies
   back into journals, and an autonomous "overnight agent" proposing and executing plans.
   Anything that can be opened by a human can also be opened by unrelated software, so the
   record-level merge and provenance-marking design (see [Data-Formats](Data-Formats)) exists to
   stop those writers from stepping on each other.
2. **Portability without a server.** The "backend" (`server.js`) is a thin local-disk
   convenience for one storage mode; the real persistence targets are the user's own
   OneDrive, Google Drive, or browser-local storage, each behind the same provider
   interface (see [Domain-storage](Domain-storage)). There is no proprietary cloud database to
   operate or lose access to.
3. **Agent-legibility as a first-class requirement.** Every format below documents
   itself in-band (`AGENTS.md`, HTML-comment markers in journals) so that external
   automation — including a different vendor's agent — can act on the same files
   correctly. This is why `src/config/agentsDoc.js` exists as a versioned, scaffolded
   document rather than a wiki page: the contract travels with the data.

## Core design principles

- **Pure transformation functions over stateful classes.** Board edits
  (`src/focusPlanOps.js`), journal parsing (`src/journalChat.js`), sync merges
  (`packages/folder-sync/src/merge.js`), and Telegram formatting
  (`packages/telegram-bridge/src/telegramFormat.js`) are implemented as `(input) -> output`
  functions with no hidden state, specifically so they can be unit-tested without a
  browser, a filesystem, or a network — and so the *same* algorithm can run from two call
  sites (e.g. the single-source and Combined views) without divergence.
- **Record-level merge, not whole-file last-write-wins.** The single most important
  correctness decision in the system: two devices editing the same markdown file must not
  let a stale replica resurrect a row the other device deleted. This is why every synced
  file has a tombstone-bearing JSON sidecar (`<path>.sync.json`) — see
  [Data-Formats](Data-Formats) and `packages/folder-sync/src/merge.js`.
  The rejected alternative was whole-file diffing/3-way merge, which cannot express "this
  row is deleted" as distinct from "this row was never seen" and was the direct cause of
  the deleted-rows-reappear defect class this module fixes.
- **Consent is explicit and structural where it matters.** The Overnight Agent
  distinguishes *proposing* a plan (always allowed) from *executing* one (gated on human
  approval recorded in the journal). This split is deliberately conservative even where it
  is not yet fully enforced — see [Roadmap](Roadmap) for the known gap where approval can
  currently be inferred from unmarked prose (issue #227).
- **Assert the artifact, not the exit code.** The overnight-agent's "sweep" and
  "mutcheck" checks (see [Domain-overnight-agent](Domain-overnight-agent)) and this very spec's own
  `scripts/spec/verify.mjs` gate share one discipline: a green check must mean the actual
  output was inspected and found correct, not merely that a script returned 0. A rule kept
  only as prose regresses silently; a rule kept as an executable check does not.
- **Self-healing over halting.** Corrupted or drifted state (runaway task IDs,
  resurrected sync sidecar rows, stale AGENTS.md copies) is repaired defensively at load
  time (`src/selfHealIds.js`, `packages/folder-sync/src/records.js` guards) rather than
  crashing the UI, because the data is the user's real planning tool and must stay usable
  even when a sync partner behaved unexpectedly.

## System shape

At the center is a React SPA (`src/App.jsx`, ~7,200 lines) rendering the two markdown
boards and their journals. It talks to storage through one interchangeable provider
interface (`src/storage/storage.js`) with concrete backends for the File System Access
API, OneDrive, Google Drive and browser IndexedDB. A separate sync engine
(`packages/folder-sync`) runs in a service worker to replicate the same files across
devices using record-level merge. Two independent Node processes extend the same files
outside the browser: `packages/telegram-bridge` mirrors task journals into a Telegram
forum so the user can approve/reply from a phone, and the `plugins/overnight-agent`
Copilot CLI plugin autonomously works tasks overnight under the plan→approve→execute
loop. `packages/mcp-cred-vault` and `packages/install-prompt` are narrow supporting
packages (Windows credential handling for the agent's MCP servers, and "Add to Home
Screen" PWA affordances, respectively). See [Architecture](Architecture) for how these
compose and [Rebuilding](Rebuilding) for the order to build them in.

## Page index

- [Architecture](Architecture) — domain composition, module graph, runtime boundaries, data flow.
- [Data-Formats](Data-Formats) — every persisted format, with annotated real samples.
- [Domain-app](Domain-app) — the React planner UI and its pure helper modules.
- [Domain-config](Domain-config) — branding, AI/user settings, the AGENTS.md contract.
- [Domain-storage](Domain-storage) — the provider abstraction and its four backends.
- [Domain-folder-sync](Domain-folder-sync) — the record-merge sync engine and service worker.
- [Domain-telegram-bridge](Domain-telegram-bridge) — the Telegram forum mirror.
- [Domain-overnight-agent](Domain-overnight-agent) — the autonomous agent plugin and its check suite.
- [Domain-diagnostics](Domain-diagnostics) — the shared diagnostics event bus.
- [Domain-install-prompt](Domain-install-prompt) — PWA install UX.
- [Domain-mcp-cred-vault](Domain-mcp-cred-vault) — the Windows secret pointer-file schema.
- [Domain-scripts](Domain-scripts) — build/maintenance scripts, including this spec's own generator.
- [Domain-root](Domain-root) — the Express dev server and build tooling entry points.
- [Behaviour](Behaviour) — the system's required behaviour, derived from its tests.
- [Rebuilding](Rebuilding) — a build-order guide starting from an empty directory.
- [Roadmap](Roadmap) — known gaps and direction, from open issues.
