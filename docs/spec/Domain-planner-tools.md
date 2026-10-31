# Domain: planner-tools

`planner-tools` lets an agent that is not the overnight coordinator — a chat assistant, a Copilot session, or a hosted assistant such as Muse — change the planner without driving the web UI. It exposes ten typed operations (find, read, add, prioritise, move, journal, tick a todo, complete, read Docs, publish Docs) through a Node command line and a stdio MCP server, and it runs with no npm dependencies on Node 22 or later. It is the fourth way into the planner's files, beside the board, the Telegram bridge and the overnight agent, and it is bound by the same shared-data rules as the others — see [Architecture](Architecture), [Data-Formats](Data-Formats) and [Domain-docs](Domain-docs).

## The design in four decisions

| Decision | Rejected alternative | Why |
| --- | --- | --- |
| **Reuse the UI's own modules.** Every Markdown change goes through the app's board operations module, its journal grammar module and the sync engine's table codec and merge metadata. | Re-implement board and journal editing for agents. | A second implementation of the board table or the journal chat grammar diverges, and then agent writes corrupt what the app renders. The release archive ships exactly the same files at their repository paths so they stay byte-identical. |
| **Talk to OneDrive directly with conditional writes.** The tools read the Planner app folder through Microsoft Graph and write with `If-Match` (update) or `If-None-Match: *` (create). | Write to the local sync folder, or resend a stored body after a conflict. | The local folder is one device's replica; the cloud copy is the shared truth. On a 409 or 412 the change is **re-planned from fresh content**, never replayed from the old body, so a concurrent app edit survives. |
| **One planning path, two executors.** A planner function never performs HTTP and never sees credentials; it returns what must be read, or the exact writes still needed. A *broker* mode hands those requests to an external credential broker; a *direct* mode executes them itself. | Give the tools a token. | Muse's broker cannot release a token to a process; it substitutes the `Authorization` header on HTTPS egress. Tokenless planning is the only way such a host can use the tools at all. |
| **A fixed allowlist is the guardrail.** | Per-tool permission checks. | One boundary checked at three points (supplied snapshots, planned writes, outgoing requests) cannot be bypassed by a new tool forgetting a check. |

## Operations

Every operation is a pure function of file snapshots: it names the files it needs, and given those snapshots it returns a result plus the ordered writes that would bring OneDrive to the requested state. **An empty write list means "already applied"**, so the same call is both the planner and the post-write verifier, and retries are safe.

| Tool | Effect |
| --- | --- |
| `find_tasks` | Resolve a query to tasks with ids, parents and sections (`all`, `Today`, `Deferred`). Read only. Callers start every request here to avoid duplicates. |
| `get_task` | Task details with the journal tail and its todos, each with an index. Read only. |
| `add_task` | Create a row. The id is allocated past journals, task settings, the completed archive and sync records; an active task with the same title is returned instead of duplicated; a row that would break the table is rejected. |
| `set_priority` | Set the 🔴 🟡 🔵 ⚪ 🐸 📖 icon by header cell. |
| `move_task` | Move between sections, with Wake alignment; an optional date defers the task until then. |
| `append_journal` | Append an agent-attributed bubble (`<!-- from: <agent> -->`) under the owner's current date; create the journal with `If-None-Match` if missing. A hidden operation marker makes a retry exact. |
| `set_todo` | Tick or edit a journal todo by index and exact text; report a stale reference rather than guess. |
| `complete_task` | Archive, close out the journal, write a sync tombstone, remove the row and re-parent children, then verify. Callers confirm with the user first. |
| `docs_read` | Return the task's Docs set (primary plus linked drafts) with editable Markdown, block ids, revision and open comments. Read only. |
| `docs_publish` | Publish the next Docs revision through the sanctioned publisher with a disposition per open comment. |

Every change carries an `operationId` (16–120 characters of letters, digits, `:`, `_`, `-`), reused on every retry, and an owner time zone so dates are the owner's local date.

**Agents never speak as the user.** Journal authors `me`, `overnight-agent` and similar reserved names are refused, as are HTML comments and `#`/`##` headings outside code fences, because those carry attribution and date structure. This is the same "the agent must not author the signal the system reads" principle described in [Prioritisation](Prioritisation).

**Completion order matters.** `complete_task` writes the archive row, the journal close-out, a tombstone in the board's sync sidecar, then the board itself. The tombstone is required because the app's sync never infers a delete from a row missing in the cloud copy (that protects against stale devices); without it the app would restore the row. Each step is re-derived from fresh content, so an interrupted run resumes and a stale replica synced afterwards does not resurrect the task.

## The plan loop

A caller supplies `{tool, arguments, snapshots}` and receives one of four states.

| State | Meaning | What the caller does |
| --- | --- | --- |
| `read_required` | Files are missing from the snapshots. | Fetch each listed file (content plus the item id and eTag it was read with) and call again. Only a confirmed 404 becomes a null snapshot. |
| `read_complete` | A read tool finished. | Use the result. |
| `write_required` | The change is not on OneDrive yet. | Execute the listed requests in order exactly as given; stop at the first non-2xx; then, whatever happened, discard every snapshot, re-read and call again with the same arguments and `operationId`. |
| `already_applied` | Verified on OneDrive. | Only now report the change as saved. |

Rules: a 409 or 412 means re-read and re-plan; the precondition header is never stripped; a 401 or 403 means stop and ask the user to reconnect; after six rounds the caller gives up with an explicit contention message and claims nothing.

> [!NOTE]
> **Technical detail: request and response shapes.** Optional; the table above is the behaviour.

<details>
<summary><strong>Show a plan request and a write plan</strong></summary>

```json
{ "tool": "add_task",
  "arguments": { "title": "Book dentist", "priority": "🟡", "section": "Today",
                 "operationId": "muse:2026-10-21:0b8f6c1e", "timeZone": "America/Los_Angeles" },
  "snapshots": { "planner.md": { "content": "...", "id": "01ABC", "etag": "\"{9F..},4\"" } } }
```

A file that does not exist is `{"content": null, "id": null, "etag": null}`; a directory listing (`journal/`) is `{"names": [...]}`. A response in the `write_required` state lists `writes[]`, each with `filename`, `purpose`, a `preview` (removed and added lines, clipped to 12) or a summary for JSON and Docs files, and a `request` whose update form is a `PUT` to the item's content with `If-Match: <etag>` and whose create form is a `PUT` to the app-root path with `If-None-Match: *` and conflict behaviour `fail`. A snapshot over 5,000,000 characters is refused.

</details>

## Guardrail allowlist

The tools may read and write only: the board (`planner.md`) and its sync sidecar (`planner.md.sync.json`), the completed archive (`planner-completed.md`), journals (`journal/task-<id>.md`), and publisher-owned Docs files under `docs/`. They may only **read** `task-settings.json` (for id-allocation parity with the UI), the journal directory listing, each doc's `review.json` and its history listing. Everything else — `agent-gate.md`, `user-settings.md`, `AGENTS.md`, settings, plugin, skill and MCP configuration — is not in the list and therefore cannot be read, written, renamed or deleted by any tool, including through the direct Graph client. The user's `review.json` is never writable by an agent; the Docs app owns it.

Errors are structured (`code`, `message`, optional `details`); anything unexpected is reported as an internal error that explicitly claims no change, so a caller never mistakes a crash for success.

## Docs loop for remote agents

`docs_read` and `docs_publish` run the **unchanged** Docs publisher and `docs-core` against an in-memory view of the OneDrive files. The publish becomes the exact set of files it would have written, and the plan loop turns that into conditional writes; the publisher's local process lock is replaced by those preconditions. A retried `operationId` is recognised from the revision it created; an interrupted multi-file publish is rolled back (body only) or forward (body and response) on the next call; the publisher refuses raw HTML, a stale `baseRev`, or unanswered comments. In broker mode the review set is requested in batches and configuration is never read, so the first-doc threshold is the 1,500-word default. History snapshots are not trimmed over Graph; the `fp-docs` command trims them to the newest twenty. See [Domain-docs-publisher](Domain-docs-publisher) and [Domain-docs](Domain-docs).

## Modes and release

| Mode | Command | Identity |
| --- | --- | --- |
| Tokenless plan | `planner plan` with a request on stdin | None; the caller executes the requests. |
| Tokenless MCP | `planner mcp --broker` exposing one tool, `planner_plan` | None. |
| Direct MCP | `planner mcp [--device-code]` exposing the ten operations | Delegated device-code sign-in, or an access token from the runtime environment. |
| One-shot | `planner <tool> [--device-code]` with arguments on stdin | As above. |

Direct sign-in uses the planner web app's own public client, scoped to its own app folder only (`Files.ReadWrite.AppFolder`, `offline_access`). Tokens live only in process memory — never written to disk, printed, or accepted as arguments. The public client flow must be enabled on that app registration; deployment does not change it. MCP dispatch is sequential, one change at a time per process; input over 6 MB is refused; output is JSON on stdout and errors are JSON on stderr with exit code 1.

The release is a pinned, dependency-free archive containing the exact import closure of the command line at repository-relative paths, with sorted entries, fixed mtimes and owners so its SHA-256 is reproducible from the same commit; a manifest records each file's hash. Consumers verify the checksum before extracting and never use an unpinned `npx`.

> [!NOTE]
> **Technical detail: modules.** Optional reference for rebuilders.

<details>
<summary><strong>Show principal modules and exports</strong></summary>

| Path | Exports | Role |
| --- | --- | --- |
| `packages/planner-tools/bin/planner.js` | none (entry point) | Command dispatch: `plan`, `mcp`, one-shot tools. |
| `packages/planner-tools/src/operations.js` | `OPERATIONS`, `VERSION` | The operation table (`needs` / `compute`). |
| `packages/planner-tools/src/plan.js` | `planTool`, `runTool`, `writeRequest`, `GRAPH`, `APPROOT`, `MAX_ATTEMPTS` | Shared plan loop and direct executor. |
| `packages/planner-tools/src/protocol.js` | `protocol`, `TOOL_DEFINITIONS`, `BROKER_TOOL` | MCP over stdio. |
| `packages/planner-tools/src/paths.js` | `assertReadable`, `assertWritable`, `isReadable`, `isWritable`, `isListing`, `journalPath`, `encodePath`, path constants | The allowlist. |
| `packages/planner-tools/src/graph.js` | `graphClient` | Direct Graph reads and conditional writes; re-checks the item version after download so content and eTag belong together. |
| `packages/planner-tools/src/auth.js` | `deviceAuth`, `environmentAuth`, `CLIENT_ID`, `SCOPES` | Delegated sign-in. |
| `packages/planner-tools/src/docs.js` | `docsRead`, `makeDocsPublish`, `SnapshotIo`, `docUrl`, `docsNeedsJournal`, `draftSource`, `DOCS_APP_URL` | Docs loop over snapshots. |
| `packages/planner-tools/src/errors.js` | `ToolError`, `requireValue`, `safeError` | Structured errors. |
| `packages/planner-tools/scripts/pack.mjs` | `buildRelease`, `importClosure` | Reproducible release archive. |

</details>

## Tests as requirements

`packages/planner-tools/test/tools.test.js` runs against an in-memory fake Graph that implements eTags and both precondition headers (`packages/planner-tools/test/fakeGraph.js`). It pins: `find_tasks` resolves ids, parents and sections; `get_task` returns todos with indexes; `add_task` allocates past journals, settings, archive and sync records, is idempotent by title, re-applies after a concurrent edit (412) keeping both changes, and rejects table-breaking rows; priority and moves align Wake; `append_journal` is agent-attributed and idempotent, creates a missing journal with `If-None-Match`, and refuses forged attribution, headings and reserved authors; `set_todo` reports stale references; `complete_task` archives, tombstones, removes, re-parents (including Deferred rows), verifies, and stays completed when the app syncs a stale replica, even mid-way; guardrails reject out-of-allowlist snapshots and writes and never plan a write without a precondition; the broker walks `read_required → write_required → already_applied` without credentials and serves MCP `tools/list`; the command line prints its version and runs `plan` from stdin. `packages/planner-tools/test/docs.test.js` pins the create → comment → better-draft loop, roll-forward of an interrupted publish, refusal of a stale base revision, and batched broker reads. `packages/planner-tools/test/pack.test.js` pins a reproducible, self-contained archive that runs outside the repository.

## Gaps

Issue #836 (still open) is the plan for the complete agent command surface and records the decision to go direct to OneDrive with delegated access and no hosting. Its wider ambitions — a local-folder transaction coordinator, other apps' domain adapters — are not built. Issues #751–#755 track the convergence of this work with the shared package and storage seams. Tools have no equivalent of the app's snooze or lane operations.
