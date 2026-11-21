# Domain: planner-tools

`planner-tools` lets an **agent that has no browser** manage the planner through ten named tools, writing to the user's OneDrive planner folder with exactly the same file formats and mutation rules as the web app. It is the cross-platform, hosting-free write path for agents outside the overnight agent (issue #836).

## Responsibility

An agent can find tasks, read one task with its journal, add a task, change priority, move a task between Today and Deferred, append a journal note, tick a journal todo, complete a task, and read and publish native catch-up Docs. The design rests on four decisions:

1. **Reuse the UI's mutation code; never reimplement formatting.** Board rows and journals are changed by the same modules the web app uses, and by the sync engine's table codec and merge metadata. The rejected alternative is a second implementation of the board and journal grammar, which would drift (the problem the one-parser-per-format rule in [Data-Formats](Data-Formats) exists to prevent).
2. **Every operation is a pure plan.** An operation names the files it needs, then, given snapshots of them, returns a result plus the ordered writes that would bring OneDrive to the requested state. An empty write list means "already applied", so the same call is both the planner and the post-write verifier, and retrying is always safe. Only the state `already_applied` means a change is saved.
3. **One planning path, two executors.** A *tokenless* mode returns read and write requests for a trusted broker to execute (the broker substitutes the Authorization header); a *direct* mode runs the identical requests itself with a delegated sign-in. The rejected alternative is separate code per mode, which would let the two disagree.
4. **A fixed file allowlist is the guardrail.** Tools may touch only the planner content files; policy and configuration files are simply not nameable.

## How a request flows

An agent calls a tool with an idempotency key (`operationId`). The plan answers `read_required` listing files to fetch (it may ask more than once as it discovers files), then `write_required` listing conditional writes, or `read_complete` for read-only tools. The caller executes the writes in order, stops at the first failure, discards all snapshots, re-reads and calls again with the same arguments. The loop ends at `already_applied`. If the file changed concurrently (HTTP 409/412), the next pass re-plans against fresh content and keeps both changes, so a concurrent edit is merged rather than overwritten. The direct executor gives up after six attempts with a `CONCURRENT_UPDATE` error and claims nothing.

## Behavioural requirements

Derived from `packages/planner-tools/test/*.test.js`.

- **Read tools:** `find_tasks` resolves IDs, parents and sections; it is the mandatory first step so duplicates are avoided. `get_task` returns journal todos with indexes.
- **`add_task`:** allocates an ID that is past every journal, task-settings entry, archive row and sync record; is idempotent by title (an active task with the same title is reported, not duplicated); re-applies after a concurrent edit and keeps both changes; refuses rows that would break the table.
- **Priority and moves:** priority is set by header cell; moving between sections keeps the Wake column aligned; `wakeOn` defers until a date.
- **`append_journal`:** writes an agent-attributed, idempotent note under the owner's date heading; creates a missing journal with a create-only precondition; refuses forged attribution, headings, and reserved authors (never `me`). Agent text therefore always renders as an agent bubble.
- **`set_todo`:** addresses a todo by index *and* exact text, and reports stale references with the current list instead of ticking the wrong item.
- **`complete_task`:** archives under the current week, tombstones, removes from the board and re-parents children, including Deferred rows, then verifies; it stays completed even if the app later syncs a stale replica. It is marked destructive so clients confirm first.
- **Guardrails:** snapshots and writes outside the allowlist are rejected; a write is never planned without a precondition (`If-Match` with the item's eTag, or `If-None-Match: *` for a new file).
- **Transports:** the broker transport walks `read_required` → `write_required` → `already_applied` without credentials; stdio MCP serves `tools/list` and a single `planner_plan` tool in broker mode; the CLI prints its version and runs `plan` from stdin.
- **Docs loop:** a draft → comment → better-draft cycle works end to end and stays consistent with `fp-docs`; an interrupted publish is rolled forward rather than guessed at; a stale base revision is refused and Docs must be enabled; broker mode asks for the review set in batches and never reads configuration. See [Domain-docs](Domain-docs) and [Domain-docs-publisher](Domain-docs-publisher).
- **Release:** the packed archive is reproducible (sorted entries, fixed mtimes, SHA-256 per file in a manifest), self-contained, and runs outside the repository.

## Privacy and credentials

Direct mode signs in with a device code, or reads an access token from the runtime environment. Tokens live only in process memory: never written, printed, or accepted as arguments. Scope is the application's own folder on OneDrive. Errors are sanitised before being returned.

## Principal modules

> [!NOTE]
> **Technical detail: module table.** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show modules and exports</strong></summary>

| Path | Exports | Role |
| --- | --- | --- |
| `packages/planner-tools/bin/planner.js` | (CLI) | Commands: `plan` (stdin), `mcp --broker`, `mcp [--device-code]`, one-shot `<tool>`. JSON on stdout, JSON errors on stderr, exit code 1. Input capped at 6 MB. |
| `packages/planner-tools/src/operations.js` | `OPERATIONS`, `VERSION` | The tool implementations (`needs` + `compute`). |
| `packages/planner-tools/src/plan.js` | `APPROOT`, `GRAPH`, `MAX_ATTEMPTS`, `planTool`, `runTool`, `writeRequest` | State machine and direct execution loop. |
| `packages/planner-tools/src/protocol.js` | `BROKER_TOOL`, `TOOL_DEFINITIONS`, `protocol` | MCP JSON-RPC surface and tool schemas. |
| `packages/planner-tools/src/graph.js` | `graphClient` | Direct Microsoft Graph reader/writer; re-checks the item version after download so content and eTag belong together. |
| `packages/planner-tools/src/auth.js` | `CLIENT_ID`, `SCOPES`, `deviceAuth`, `environmentAuth` | Delegated sign-in. |
| `packages/planner-tools/src/paths.js` | `BOARD`, `BOARD_SIDECAR`, `COMPLETED`, `DOCS_INDEX`, `JOURNAL_DIR`, `TASK_SETTINGS`, `assertReadable`, `assertWritable`, `encodePath`, `isListing`, `isReadable`, `isWritable`, `journalPath` | The allowlist; task settings are read-only (for ID allocation parity). |
| `packages/planner-tools/src/docs.js` | `DOCS_APP_URL`, `SnapshotIo`, `docUrl`, `docsNeedsJournal`, `docsRead`, `draftSource`, `makeDocsPublish` | Docs tools over an in-memory view of the OneDrive files. |
| `packages/planner-tools/src/errors.js` | `ToolError`, `requireValue`, `safeError` | Error vocabulary. |
| `packages/planner-tools/scripts/pack.mjs` | `buildRelease`, `importClosure` | Builds the deterministic release archive from the import closure of the CLI. |
| `packages/planner-tools/test/fakeGraph.js` | `fakeGraph` | In-memory Graph app folder with eTags and preconditions. |

Tool set: `find_tasks`, `get_task`, `add_task`, `set_priority`, `move_task`, `append_journal`, `set_todo`, `complete_task`, `docs_read`, `docs_publish`. Read tools are annotated read-only; mutations are idempotent; `complete_task` is destructive.

</details>

## Failure modes

Reporting `write_required` as done loses the change; callers must treat only `already_applied` as saved. Retrying without preconditions can overwrite a concurrent edit, so 401/403 stops and asks the user to reconnect rather than retrying. A tool that reaches a file outside the allowlist fails closed. In the Docs path the publisher's process lock is replaced by the conditional writes, so a lost race surfaces as a stale-base refusal.

## Direction

#836 is the open tracking issue for these tools; its decision section settles on direct OneDrive with delegated access and no hosting.
