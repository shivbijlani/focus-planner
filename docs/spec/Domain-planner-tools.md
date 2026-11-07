# Domain: planner-tools

`planner-tools` lets an **agent that does not have the planner folder on disk** — a chat assistant, a
remote agent — read and change the planner safely. It exposes a small set of task operations as a
command-line tool and as a stdio MCP server. The product rule is that a remote agent changes the
planner *exactly as the app would*, can only touch the planner's content files, and can never
silently overwrite a concurrent edit.

## Responsibility

**Ten operations.** `find_tasks` (mandatory first step: search Today/Deferred to resolve IDs and avoid
duplicates), `get_task` (a task with its journal and indexed todos), `add_task`, `set_priority`,
`move_task` (Today/Deferred, optionally with a wake date), `append_journal`, `set_todo`,
`complete_task`, and the two Docs operations `docs_read` and `docs_publish`. Reads are annotated
read-only; mutations are annotated idempotent; `complete_task` is the one destructive one and its
description tells the agent to confirm with the user first.

**One planning path, two executors.** Every operation is a pure function of file *snapshots*: it
names the files it needs, and given them returns a result plus the ordered writes that would bring
the cloud folder to the requested state. An empty write list means "already applied", so the same call
is both the planner and the post-write verifier. Two executors run that one plan:

| Mode | Who executes | Credentials |
| --- | --- | --- |
| Broker (tokenless) | The caller's secure broker performs the HTTP calls and substitutes the authorization header on egress; this package only returns read requests, then write requests, then `already_applied` | None ever reach this process |
| Direct | The package signs in itself (device-code, or an access token from the environment — never from arguments) and runs the same requests | Held only in process memory, never written or printed |

**Why two executors and one planner.** The rejected alternative — separate logic per transport —
would let the broker path and the direct path drift into producing different board edits. Sharing the
plan makes the transport an implementation detail.

**Safe by construction.**

- **Allowlist.** Only the board, its sync sidecar, the completed archive, per-task journals, the Docs
  index and published Docs files, and (read-only) task settings may be read or written. Policy and
  configuration files — the agent gate, user settings, `AGENTS.md`, settings, plugin and MCP config —
  are simply absent from the allowlist, so no tool can read, change, rename or delete them. Every
  supplied snapshot, every planned write and every direct request is checked against it.
- **Preconditions on every write.** An existing file is written with `If-Match` on its eTag; a new
  file with `If-None-Match: *`. A write without a precondition is never planned. A stale-write
  response (412) makes the operation re-read and re-apply, so a concurrent edit by the app and the
  agent's change both survive.
- **Only `already_applied` means saved.** The agent is told never to report a pending write as done;
  after any outcome it discards snapshots, re-reads and calls again with the same operation id.
- **Idempotency.** Each change carries a stable `operationId`; retries are safe, and `add_task`
  reports an existing active task with the same title instead of duplicating it.
- **Attribution.** `append_journal` writes an agent-attributed bubble under the owner's date; forged
  attribution, headings and reserved authors (such as the user's own `me`) are refused, so an agent
  cannot speak as the user.
- **Reuse, not reimplementation.** Board and journal edits go through the app's own modules and the
  sync engine's record codec and merge metadata. `complete_task` mirrors the app: archive row under
  this week, tombstone so app sync removes it, remove from the board, re-parent children (including
  Deferred rows), then verify; it stays completed even if the app later syncs a stale replica.
- **Docs without a second implementation.** `docs_read` and `docs_publish` run the sanctioned
  publisher and `docs-core` unchanged against an in-memory view of the cloud files, and the publish
  becomes conditional writes. See [Domain-docs](Domain-docs) for the format and protocol; the
  publisher's local process lock is replaced by the write preconditions.
- **Reproducible release.** A pack script builds a deterministic, dependency-free archive of the exact
  import closure of the CLI (sorted entries, fixed mtimes and owners, per-file hashes in a manifest),
  so its SHA-256 is reproducible from the same commit and it runs outside the repository.

## Principal modules

> [!NOTE]
> **Technical detail: module paths and exports.** Optional reference; behaviour is described in the sections around it.

<details>
<summary><strong>Show principal modules and their exports</strong></summary>

| Path | Exports | Role |
| --- | --- | --- |
| `packages/planner-tools/bin/planner.js` | — | CLI: `plan`, `mcp [--broker] [--device-code]`, one-shot tool calls; JSON on stdout, JSON errors on stderr with exit 1; input capped at 6 MB |
| `packages/planner-tools/src/operations.js` | `OPERATIONS`, `VERSION` | The operations as pure `needs` / `compute` pairs |
| `packages/planner-tools/src/plan.js` | `APPROOT`, `GRAPH`, `MAX_ATTEMPTS`, `planTool`, `runTool`, `writeRequest` | Tokenless plan loop and the shared plan/execute driver |
| `packages/planner-tools/src/paths.js` | `BOARD`, `BOARD_SIDECAR`, `COMPLETED`, `DOCS_INDEX`, `JOURNAL_DIR`, `TASK_SETTINGS`, `assertReadable`, `assertWritable`, `encodePath`, `isListing`, `isReadable`, `isWritable`, `journalPath` | The guardrail allowlist |
| `packages/planner-tools/src/protocol.js` | `BROKER_TOOL`, `TOOL_DEFINITIONS`, `protocol` | MCP JSON-RPC surface and tool schemas |
| `packages/planner-tools/src/graph.js` | `graphClient` | Direct Microsoft Graph executor; re-reads the item version after download so content and eTag belong together |
| `packages/planner-tools/src/auth.js` | `CLIENT_ID`, `SCOPES`, `deviceAuth`, `environmentAuth` | Delegated sign-in scoped to the app's own folder |
| `packages/planner-tools/src/docs.js` | `DOCS_APP_URL`, `SnapshotIo`, `docUrl`, `docsNeedsJournal`, `docsRead`, `draftSource`, `makeDocsPublish` | Docs operations over snapshots; reuses `packages/docs-core/src/doc.js` and `packages/docs-publisher/src/publisher.js` |
| `packages/planner-tools/src/errors.js` | `ToolError`, `requireValue`, `safeError` | Typed errors that never leak secrets |
| `packages/planner-tools/scripts/pack.mjs` | `buildRelease`, `importClosure` | Deterministic release archive |

</details>

> [!NOTE]
> **Technical detail: the broker protocol.** Optional; the product behaviour is above.

<details>
<summary><strong>Show the plan loop and MCP surface</strong></summary>

`planner_plan` (the single broker-mode MCP tool) takes `{ tool, arguments, snapshots }` and returns
one of four states:

1. `read_required` — a list of Graph GET requests (file or directory listing). The caller downloads
   the content without an authorization header, re-reads metadata and accepts the content only if id
   and eTag are unchanged. A confirmed 404 becomes `{content:null,id:null,etag:null}`; a missing
   directory becomes `{names:[]}`. It may ask more than once as it discovers files.
2. A read result (for read-only tools).
3. `write_required` — ordered conditional PUTs; the caller stops at the first non-2xx and, whatever
   happened, discards snapshots, re-reads and calls again.
4. `already_applied` — the only state that means the change is saved. The loop allows at most six
   attempts.

Direct-mode MCP serves `TOOL_DEFINITIONS` through `tools/list`; broker mode serves only `planner_plan`.
Requests are handled one at a time per process. `operationId` is 16–120 characters of
`[A-Za-z0-9:_-]`; task ids are 1–6 digits; author names are lowercase and never `me`; `docs_publish`
takes the full revised Markdown (not a diff), a disposition (`answered`, `done`, `declined`,
`needs-you`) for every open comment, and an optional `baseRev` that must match the current revision.

</details>

## Behavioural requirements

From `packages/planner-tools/test/tools.test.js`, `docs.test.js` and `pack.test.js`:

- `find_tasks` resolves ids, parents and sections; `get_task` returns journal todos with indexes.
- `add_task` allocates an id past journals, task settings, the archive and sync records, is idempotent
  by title, re-applies on a fresh read after a concurrent edit (412) keeping both changes, and rejects
  rows that would break the board table.
- `set_priority` and `move_task` edit by header cell and keep the `Wake` column aligned.
- `append_journal` writes an agent-attributed, idempotent note under the owner's date, creates a
  missing journal with `If-None-Match`, and refuses forged attribution, headings and reserved authors.
- `set_todo` addresses a todo by index and exact text and reports stale references with the current
  list.
- `complete_task` archives, tombstones, removes and re-parents, then verifies, and stays completed if
  the app syncs a stale replica afterwards — even partway through.
- Guardrails reject snapshots and writes outside the allowlist and never plan an unconditional write.
- The broker transport walks `read_required` → `write_required` → `already_applied` without
  credentials and serves `tools/list` and `planner_plan`; the CLI prints its version and runs `plan`
  from stdin.
- The Docs loop creates a doc, reads comments, publishes a revision with dispositions and remains
  consistent for the `fp-docs` validator; it rolls an interrupted publish forward instead of guessing,
  refuses a stale base revision, requires Docs to be enabled, and in broker mode asks for the review
  set in batches and never reads configuration.
- The release archive is reproducible, self-contained and runs outside the repository.

## Failure modes

A sixth failed attempt surfaces an error rather than looping. An expired or missing token stops the
direct mode and asks the user to reconnect; it never retries without preconditions. Docs publishing
over a cloud folder has no multi-file transaction, so an interrupted publish is detected on the next
call and rolled forward. An open gap: remote Docs revisions can cause sync-conflict copies of
publisher-owned files in the browser and the open doc not to refresh (#868). For the Docs data
formats and protocol see [Domain-docs](Domain-docs) and [Data-Formats](Data-Formats); for how this
package sits among the others see [Architecture](Architecture).
