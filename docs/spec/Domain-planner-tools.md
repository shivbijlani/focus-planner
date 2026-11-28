# Domain: planner-tools

`planner-tools` lets an AI agent that has no filesystem access to the planner — a remote agent, or a desktop assistant — read and change the board and journals directly in the user's OneDrive app folder, without the browser app open. It is a command-line tool and an MCP (Model Context Protocol) server exposing eight planner operations and two Docs operations. Its governing rule: **it never re-implements board or journal formatting**. Every Markdown change goes through the same modules the UI uses, and every Docs read or publish runs the sanctioned publisher ([Domain-docs-publisher](Domain-docs-publisher)) and [Domain-docs-core](Domain-docs-core). It is the direct-storage counterpart to the local overnight agent ([Domain-overnight-agent](Domain-overnight-agent)). The whole package is tracked by open issue #836.

## Responsibility

| Operation | Kind | What it does |
| --- | --- | --- |
| `find_tasks` | read | Search the active board (Today / Deferred) by words or id; the mandatory first step to resolve which task is meant and avoid duplicates. |
| `get_task` | read | One task with its journal text and todo list, including the index/text pairs `set_todo` needs. |
| `add_task` | write | Add a row; the new id is allocated the same way the app does, past journals, task settings, the archive and sync records. An active task with the same title is reported, not duplicated. |
| `set_priority` | write | Change the priority icon. |
| `move_task` | write | Move between Today and Deferred; a wake date defers until then and returns the task to Today. |
| `append_journal` | write | Append an agent-attributed note (rendered as an agent bubble, never as the user); creates the journal if missing. |
| `set_todo` | write | Check or uncheck one journal todo, identified by index *and* exact text. |
| `complete_task` | write | Complete exactly as the app does: archive under the week, remove from the board, re-parent children (including Deferred rows), then verify. |
| `docs_read` | read | The task's Docs set: ids, revisions, URLs, editable draft Markdown, block ids and every open user comment. |
| `docs_publish` | write | Publish the next revision of the Docs set with a disposition per open comment, optionally leaving a journal pointer. |

## The plan/execute design

Every operation is a pure function of file snapshots. It declares which files it needs, and given those snapshots returns a result plus the ordered writes that would bring OneDrive to the requested state. An **empty write list means the change is already applied**, so the same call is both the planner and the post-write verifier, and retries are safe. This replaces the rejected alternative of "call, write, trust" — a network write whose outcome is uncertain would otherwise risk duplicate rows or lost edits.

The planner answers in one of four states:

| State | Meaning |
| --- | --- |
| `read_required` | More files are needed; the reply lists them. |
| `read_complete` | A read operation finished; the result is attached. |
| `write_required` | The exact conditional writes still needed, each with a preview for showing the user. |
| `already_applied` | The change is verified saved. Only this state means "saved". |

After any write — success, conflict or timeout — the caller discards all snapshots, re-reads and calls again with the same tool, arguments and operation id. Every write carries a precondition (`If-Match` with the eTag read, or `If-None-Match: *` to create); a 409 or 412 means someone else edited, so the loop re-reads and re-plans rather than resending a stale body. This is what keeps concurrent edits from the app and the agent both. A write is never planned without a precondition. The loop gives up after six attempts.

## Two executors, one planning path

- **Broker mode (tokenless).** The planner never performs HTTP and never sees credentials. The caller (for example the Muse sandbox, whose credential broker holds the refresh token) fetches snapshots, and executes the returned requests by substituting the Authorization header on its own egress. The MCP server in this mode exposes a single read-only `planner_plan` tool.
- **Direct mode.** The CLI or MCP server signs in (device-code flow, or an access token from the runtime environment — never from arguments), reads files itself and executes the same requests. Tokens live only in process memory and are never written, printed or accepted as arguments.

Splitting planning from execution means the security-sensitive step (holding a token) is separable from the logic, and both modes are guaranteed to produce identical writes.

## Guardrails

- **A file allowlist is the security boundary.** Only the board, its sync sidecar, the completed archive, task settings (read-only, for id allocation parity), journals, and the Docs index and per-doc files may be touched. Policy and configuration files — the agent gate, user settings, `AGENTS.md`, settings, plugin, skill and MCP configuration — are simply absent, so no tool can read, write, rename or delete them. Every supplied snapshot, every planned write and every Graph request is checked against it.
- **Attribution cannot be forged.** `append_journal` refuses forged attribution, headings and reserved author names, and HTML comments, so an agent cannot impersonate the user or inject structure into the chat grammar.
- **Stale references fail loudly.** `set_todo` returns a stale-reference error with the current list rather than toggling the wrong item.
- **Docs consistency.** A publish through this path stays consistent for `fp-docs`; an interrupted publish rolls forward rather than guessing; a stale base revision is refused; Docs must be enabled for the planner (the index gate).

> [!NOTE]
> **Technical detail: CLI, modules and release archive.** Optional reference for rebuilders.

<details>
<summary><strong>Show command surface and module table</strong></summary>

```text
planner plan < request.json          # tokenless: {"tool","arguments","snapshots"} -> plan
planner mcp --broker                 # stdio MCP exposing planner_plan
planner mcp [--device-code]          # stdio MCP, direct Graph access
planner <tool> [--device-code] < arguments.json   # one-shot direct call
planner --version | --help
```

Output is JSON on stdout; errors are JSON on stderr with exit code 1. Standard input is capped at 6 MB. `--broker` is valid only with `mcp`. Mutating tools carry an `operationId` and (where dates are written) a `timeZone`; mutations are annotated idempotent, `complete_task` destructive, reads read-only.

| Path | Exports | Role |
| --- | --- | --- |
| `packages/planner-tools/bin/planner.js` | — | CLI entry. |
| `packages/planner-tools/src/operations.js` | `OPERATIONS`, `VERSION` | The operations; uses the UI's `src/focusPlanOps.js` and `src/journalChat.js` and the sync engine's table codec and merge metadata in `packages/folder-sync`. |
| `packages/planner-tools/src/plan.js` | `APPROOT`, `GRAPH`, `MAX_ATTEMPTS`, `planTool`, `runTool`, `writeRequest` | Plan states and the shared loop. |
| `packages/planner-tools/src/graph.js` | `graphClient` | Direct Graph executor; re-checks the item version after download so content and eTag belong together; writes only plan-produced requests to allowlisted files. |
| `packages/planner-tools/src/auth.js` | `CLIENT_ID`, `SCOPES`, `deviceAuth`, `environmentAuth` | Delegated sign-in using the same public client as the web app, scoped to its own app folder. |
| `packages/planner-tools/src/paths.js` | `BOARD`, `BOARD_SIDECAR`, `COMPLETED`, `DOCS_INDEX`, `JOURNAL_DIR`, `TASK_SETTINGS`, `assertReadable`, `assertWritable`, `encodePath`, `isListing`, `isReadable`, `isWritable`, `journalPath` | The allowlist. |
| `packages/planner-tools/src/protocol.js` | `BROKER_TOOL`, `TOOL_DEFINITIONS`, `protocol` | MCP tool schemas and the stdio protocol. |
| `packages/planner-tools/src/docs.js` | `DOCS_APP_URL`, `SnapshotIo`, `docUrl`, `docsNeedsJournal`, `docsRead`, `draftSource`, `makeDocsPublish` | Docs over an in-memory view (`SnapshotIo`) of the OneDrive files; the publish becomes the exact set of files it would have written, turned into conditional PUTs. The publisher's local process lock is replaced by those preconditions. |
| `packages/planner-tools/src/errors.js` | `ToolError`, `requireValue`, `safeError` | Coded errors and redaction of error text. |
| `packages/planner-tools/scripts/pack.mjs` | `buildRelease`, `importClosure` | Builds the release archive. |
| `packages/planner-tools/test/fakeGraph.js` | `APPROOT`, `BOARD`, `COMPLETED`, `GRAPH`, `JOURNAL_31`, `fakeGraph` | In-memory Graph app folder for tests, with eTags and `If-Match` / `If-None-Match`. |

Allowlisted paths: `planner.md`, `planner.md.sync.json`, `planner-completed.md`, `task-settings.json` (read only), `journal/task-<N>.md` (one to six digits), `docs/index.json`, and under `docs/<doc-id>/` the files `doc.md`, `response.json`, `history/rNNNN.md` and `review.json` (the latter read-only to the tools' writes). Doc ids match `d-[a-z0-9]{6,40}`.

The release archive mirrors repository-relative paths of the exact import closure of the CLI entry, so shipped files are byte-for-byte the modules the Planner UI imports (after line-ending normalisation), with no rewriting and no dependencies. Output is deterministic — sorted entries, fixed mtimes and owners — so the SHA-256 is reproducible from the same commit, and `MANIFEST.json` records each file's hash.

</details>

## Behavioural requirements

From `packages/planner-tools/test/tools.test.js`, `docs.test.js` and `pack.test.js`.

- `find_tasks` resolves ids, parents and sections; `get_task` returns journal todos with indexes.
- `add_task` allocates an id beyond journals, task settings, the archive and sync records; is idempotent by title; re-applies on a fresh read after a concurrent-edit conflict and keeps both changes; rejects rows that would break the table.
- Priority changes act by header cell; moves between sections keep the wake column aligned.
- `append_journal` writes an idempotent, agent-attributed note under the owner's date; creates a missing journal with a create-only precondition; refuses forged attribution, headings and reserved authors.
- `set_todo` acts by index and exact text and reports stale references.
- `complete_task` archives, tombstones, removes and re-parents (including Deferred rows), then verifies; it stays completed when the app later syncs a stale replica, even mid-way.
- Snapshots and writes outside the content allowlist are rejected, and no write is ever planned without a precondition.
- The broker transport walks `read_required`, `write_required`, `already_applied` without credentials and serves MCP `tools/list` and `planner_plan`.
- The CLI prints its version and runs `plan` from standard input.
- Docs: create, read comments, publish a revision with dispositions and remain consistent for `fp-docs`; roll an interrupted publish forward; refuse a stale base revision and require Docs to be enabled; in broker mode ask for the review set in batches and never read configuration.
- The release archive is reproducible, self-contained and runs outside the repository.

## Failure modes

A stale reference, a missing task, an id that exists both on the board and in the archive (a human must resolve it) and a refused path each return a coded `ToolError`, never a partial write. A conflict mid-sequence leaves already-written files in place; because each is individually idempotent and the next call re-plans from fresh reads, the remainder completes on retry. A 401 or 403 is not retried: the user must reconnect.
