# Domain: planner-tools

`planner-tools` lets an agent that has **no access to the user's disk** — a remote assistant, a chat agent — read and change the planner through the user's OneDrive app folder, with the same results as the Planner app itself. It exposes ten operations (find, read, add, prioritise, move, journal, tick a todo, complete, and two for Docs) through three front doors: a tokenless "plan" transport, an MCP server, and one-shot CLI commands (issue #836). Its central promise is **safety without trust**: the tools can only touch planner content, never policy, and a change is only ever reported as saved once it has been verified on OneDrive.

## Why this design

- **Reuse the UI's mutation core rather than reimplement it.** Every markdown change goes through the app's own `src/focusPlanOps.js` and `src/journalChat.js` and the sync engine's record codec and merge metadata (`packages/folder-sync/src/codecs/mdTable.js`, `packages/folder-sync/src/merge.js`). A second implementation of board or journal formatting would eventually write rows the app cannot read. Docs are likewise done by running the sanctioned publisher and `docs-core` unchanged ([Domain-docs-publisher](Domain-docs-publisher)).
- **Plan, don't execute.** Each operation is a pure function of file snapshots. It names the files it needs, and returns a result plus the ordered writes that would reach the requested state. Because "no writes needed" means "already applied", the same call is both the planner and the post-write verifier, and retries are idempotent.
- **One planning path, two executors.** A credential broker (the Muse assistant's) executes the planned HTTP requests by adding the Authorization header on egress, so the agent never holds a token. The direct CLI/MCP mode executes the identical requests itself. Having two planners would let the safe path and the convenient path diverge.
- **Allowlist, not denylist.** Policy files are protected by not being on the list at all.

## Principal modules

> [!NOTE]
> **Technical detail: module map.** Paths and roles.

<details>
<summary><strong>Show the package's modules and exports</strong></summary>

| Path | Role |
| --- | --- |
| `packages/planner-tools/src/operations.js` | The `OPERATIONS` table and `VERSION`. Each entry has `needs(args)` and `compute(args, snapshots, ctx)`. |
| `packages/planner-tools/src/plan.js` | `planTool` (tokenless state machine), `runTool` (direct executor), `writeRequest`, constants `GRAPH`, `APPROOT`, `MAX_ATTEMPTS`. |
| `packages/planner-tools/src/paths.js` | The file allowlist and guards: `assertReadable`, `assertWritable`, `isListing`, `journalPath`, `encodePath`, file-name constants. |
| `packages/planner-tools/src/graph.js` | `graphClient`: direct Microsoft Graph reader/writer. |
| `packages/planner-tools/src/auth.js` | `deviceAuth` (device-code sign-in), `environmentAuth` (token from the runtime environment), `CLIENT_ID`, `SCOPES`. |
| `packages/planner-tools/src/docs.js` | Docs operations over an in-memory file view: `makeDocsPublish`, `docsRead`, `SnapshotIo`, `docUrl`, `draftSource`, `docsNeedsJournal`, `DOCS_APP_URL`. |
| `packages/planner-tools/src/protocol.js` | MCP JSON-RPC handler and tool schemas: `protocol`, `TOOL_DEFINITIONS`, `BROKER_TOOL`. |
| `packages/planner-tools/src/errors.js` | `ToolError`, `requireValue`, `safeError`. |
| `packages/planner-tools/bin/planner.js` | The `planner` executable. |
| `packages/planner-tools/scripts/pack.mjs` | Release archive builder: `buildRelease`, `importClosure`. |
| `packages/planner-tools/test/fakeGraph.js` | In-memory Graph app folder with eTags and `If-Match` / `If-None-Match`, used by the tests. |

</details>

## Operations

| Operation | Kind | Behaviour |
| --- | --- | --- |
| `find_tasks` | read | Search the active board by words or ID; returns IDs, priorities, parents, sections and wake dates. Mandatory first step so the agent resolves the right task and avoids duplicates. |
| `get_task` | read | One task with recent journal text and todos as index/text pairs. |
| `add_task` | write | Allocates an ID past every journal, task setting, archived row and sync record; idempotent by title; optional parent link; rejects rows that would break the table. |
| `set_priority` | write | Sets the priority icon by header cell. |
| `move_task` | write | Moves between Today and Deferred, keeping the wake column aligned; with a wake date it returns to Today automatically. |
| `append_journal` | write | Appends a note attributed to the agent (an agent bubble, never the user), idempotently, under the day heading in the owner's time zone; creates a missing journal. Forged attribution, headings and reserved authors are refused. |
| `set_todo` | write | Checks or unchecks a journal todo by index **and** exact text; a stale reference returns `STALE_TODO_REF` with the current list. |
| `complete_task` | write | Archives under the current week, tombstones, removes from the board and re-parents children (Deferred rows included), then verifies. It stays completed even if the app later syncs a stale replica. |
| `docs_read` | read | The task's Docs set (ids, revisions, URLs, editable drafts, block ids) and every open comment. |
| `docs_publish` | write | Publishes the next revision answering every open comment with a disposition; refuses a stale base revision; requires Docs to be enabled. An interrupted publish is rolled forward, never guessed. |

Every write takes a stable **operation id** that the caller reuses unchanged on retries; this is what makes retry safe.

## The tokenless plan loop

`planTool` takes `{tool, arguments, snapshots}` and returns one of four states:

1. `read_required` — lists files (and directory listings) to fetch. It may ask more than once, as Docs discovers files while it runs.
2. `read_complete` — a read-only result.
3. `write_required` — the exact conditional writes still needed, each with a preview and a request: an existing file is replaced with `If-Match: <eTag>`; a new file is created with `If-None-Match: *`. A write is **never planned without a precondition**.
4. `already_applied` — the only state that means "saved".

After performing writes, whatever happened (success, 409, 412, timeout), the caller discards every snapshot, re-reads and calls again with the same operation id. A concurrent edit therefore causes a fresh read and fresh plan, never a resent body; the planner re-applies on top of the other change so both survive. Direct mode (`runTool`) does this loop itself up to six attempts, then fails with `CONCURRENT_UPDATE` and claims nothing.

Reads return content, item id and eTag, and the item version is re-checked after download so content and eTag always belong together; only a confirmed 404 means "file absent".

## Guardrails

The allowlist covers: `planner.md`, its sync sidecar `planner.md.sync.json`, `planner-completed.md`, `task-settings.json` (**read only**, for ID-allocation parity with the UI), `journal/task-<id>.md`, and Docs files under `docs/` (publisher-owned files writable; `review.json` read only). Everything else — `agent-gate.md`, `user-settings.md`, `AGENTS.md`, settings, plugin and MCP configuration — is simply absent, so every snapshot supplied, every write planned and every request sent is checked and refused with `POLICY_DENIED`. Snapshots over 5 MB and request input over 6 MB are rejected. Tokens live only in process memory: never written, printed or accepted as an argument. Errors are returned in a safe shape (`safeError`) that never leaks internals.

> [!NOTE]
> **Technical detail: command line and MCP surface.** The `planner` executable and protocol.

<details>
<summary><strong>Show the planner command surface</strong></summary>

| Command | Meaning |
| --- | --- |
| `planner plan < request.json` | Tokenless: request in, read/write plan out. |
| `planner mcp --broker` | Stdio MCP exposing a single `planner_plan` tool (tokenless). |
| `planner mcp [--device-code]` | Stdio MCP exposing all ten tools with direct Graph access. |
| `planner <tool> [--device-code] < arguments.json` | One-shot direct call. |
| `planner --version`, `--help` | Version (`1.1.0`) and help. |

Direct mode signs in with `--device-code` or reads `PLANNER_ACCESS_TOKEN` from the environment. Output is JSON on stdout; errors are JSON on stderr with exit code 1. MCP dispatch is sequential, one change at a time per process. Error codes include `INVALID_INPUT`, `POLICY_DENIED`, `TASK_NOT_FOUND`, `BOARD_UNAVAILABLE`, `AUTH_REQUIRED`, `ONEDRIVE_ERROR`, `CONCURRENT_UPDATE`, `OPERATION_CONFLICT`, `STALE_TODO_REF`, `DOCS_DISABLED`, `DOCS_REFUSED`, `DOCS_TORN` and `INTERNAL_ERROR`.

</details>

## Release packaging

`packages/planner-tools/scripts/pack.mjs` builds a pinned, dependency-free archive containing exactly the import closure of `bin/planner.js`, mirroring repository-relative paths so shipped files are byte-for-byte the modules the Planner UI imports (after LF normalisation). The output is deterministic — sorted entries, fixed mtimes and owners — so its SHA-256 is reproducible from the same commit, and a `MANIFEST.json` records each file's hash. The archive runs outside the repository.

## Verification

`packages/planner-tools/test/tools.test.js`, `packages/planner-tools/test/docs.test.js` and `packages/planner-tools/test/pack.test.js` pin the behaviour above, including the broker walk `read_required` → `write_required` → `already_applied` without credentials, and MCP `tools/list` in both modes. Related board semantics are in [Domain-app](Domain-app) and [Data-Formats](Data-Formats); the shared sort used for priorities is in [Domain-planner-shared-core](Domain-planner-shared-core).
