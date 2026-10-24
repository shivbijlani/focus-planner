# Domain: planner-tools

`planner-tools` lets an agent change the planner **without driving the web UI**: find tasks, add them, set priority, move or defer them, append journal notes, tick todos, complete tasks, and run the Docs draft-and-comment loop. It ships as a command-line tool and a stdio MCP server with no npm dependencies, and it talks directly to the OneDrive copy of the planner folder. See [Architecture](Architecture) for the surrounding system, [Domain-docs](Domain-docs) for the Docs formats it reuses, and [Data-Formats](Data-Formats) for the files it edits.

## Design thesis

Four decisions shape the package.

1. **Same code as the app, never a re-implementation.** Every board or journal change goes through the UI's own modules and the sync engine's record codec, so an agent edit is byte-compatible with a user edit. The alternative — a second formatter for rows and journal bubbles — would drift and corrupt files the app then has to reconcile.
2. **Operations are pure.** Each operation declares which files it needs and, given snapshots of them, returns a result plus the ordered writes that would reach the requested state. An empty write list means "already applied", so the same call plans the change and verifies it afterwards, and retries are safe.
3. **Conditional writes, never blind ones.** Reads capture each file's version tag; updates are sent only if the tag still matches and creates only if the file does not yet exist. On a conflict the change is **re-applied to fresh content**, never replayed from a stale body, so concurrent app edits survive.
4. **Tokenless planning.** One planner produces the exact HTTP requests; two executors run them. In the credential-broker mode the planner never sees a token — the broker attaches the authorization header on egress. In direct mode the tool itself signs in and runs the same requests. One planning path means the two modes cannot diverge.

## What an agent can touch

An allowlist is the guardrail. Only the board, its sync sidecar, the completed archive, per-task journals, publisher-owned Docs files, and a few read-only files (task settings, Docs review files, the journal listing) are reachable. Policy and configuration files — the agent gate, user settings, `AGENTS.md`, settings and plugin configuration — are **absent from the list**, so no tool can read, write, rename or delete them, and the direct Graph client re-checks every request. This keeps the document the user edits to control the agent out of the agent's own reach, an instance of the principle in [Prioritisation](Prioritisation) that an agent must not author the signal its gate reads.

**Agents never speak as the user.** Journal notes carry a `from: <agent>` marker; the authors `me` and `overnight-agent` (and similar reserved names) are refused, as are HTML comments and top-level headings outside code fences, because those carry attribution and dates.

## Tools

| Tool | Kind | Behaviour |
| --- | --- | --- |
| `find_tasks` | read | Resolves IDs, parents and sections; should start every request so duplicates are avoided. |
| `get_task` | read | Journal tail and todos with indexes. |
| `add_task` | write | Allocates an ID past journals, task settings, the archive and sync records; idempotent by title among active tasks; rejects rows that would break the table. |
| `set_priority` | write | Sets the priority icon by header cell. |
| `move_task` | write | Moves between Today and Deferred, aligning the Wake date when a `wakeOn` is given. |
| `append_journal` | write | Agent-attributed, idempotent note; creates a missing journal with a create-only precondition. |
| `set_todo` | write | Targets a todo by index and exact text; reports stale references instead of guessing. |
| `complete_task` | write | Archives, tombstones, removes and re-parents children (Deferred rows included), then verifies. |
| `docs_read` | read | The task's Docs set with editable Markdown, block ids and open comments. |
| `docs_publish` | write | Publishes the next Docs revision with one disposition per open comment. |

Each write carries an `operationId` (16–120 characters of letters, digits, `:`, `_`, `-`) reused on every retry so the effect lands once. A hidden marker in the journal note makes note retries exact; external editors that strip it lose that protection.

**Completion order.** Graph has no multi-file transaction, so `complete_task` writes in a safe order — archive row, journal close-out, a **sync tombstone** in the board sidecar, then the board — and re-derives each step from fresh content so an interrupted run resumes. The tombstone is required because the app's sync never infers a delete from a row missing in the cloud copy (that protects against stale devices); without it the app would restore the completed row.

## The plan loop

A planner call returns one of four states. The caller must act on it exactly.

| State | Meaning | Caller action |
| --- | --- | --- |
| `read_required` | Needed files are missing from the supplied snapshots. | Fetch them (content plus version tag, re-checking the version after download) and call again. |
| `read_complete` | A read tool finished. | Use the result. |
| `write_required` | The change is not yet on OneDrive. | Execute the returned requests in order, unmodified, stopping at the first non-success; then discard all snapshots, re-read and call again. |
| `already_applied` | Verified present. | Only now report the change as saved. |

On a 409 or 412 the caller re-reads and re-plans without ever stripping a precondition. On 401 or 403 it stops and asks the user to reconnect. After five rounds it gives up with an explicit contention message.

## Docs draft review loop

An agent publishes a draft as a native Docs set rather than sending it elsewhere; the user comments in the Docs app; the agent reads the comments and publishes a better revision. `docs_read` returns each doc's Markdown, revision and open comments. `docs_publish` takes the base revision and a disposition for every open comment (`done`, `answered`, `declined`, or `needs-you` to ask back), and may leave a one-line journal pointer. Nothing re-implements the Docs format: the unchanged publisher and `docs-core` ([Domain-docs-publisher](Domain-docs-publisher), [Domain-docs-core](Domain-docs-core)) run against an in-memory view of the OneDrive files, and the files the publish would have written become conditional writes. The publisher's local process lock is replaced by those preconditions. The publisher refuses raw HTML, a stale base revision, or unanswered comments (`DOCS_REFUSED` with the reason code); it never writes the user's review file; an interrupted multi-file publish is rolled back (body only) or forward (body and response) on the next call. Docs must be enabled for the planner, and configuration files remain unreadable so the first-doc threshold is the default.

Known gaps from the first end-to-end run: remote revisions make the browser's sync engine file conflict copies of publisher-owned files and the open doc does not refresh (#868); the Docs renderer mis-handles soft-wrapped lines and emphasis across wraps (#867); the comment features in the app are tracked in #854.

## Distribution

The release is a pinned, reproducible archive: sorted entries, fixed mtimes and owners, a SHA-256 beside it, and a manifest of each file's hash. It contains the exact import closure of the CLI at repository-relative paths, byte-for-byte the modules the UI imports after line-ending normalisation, so nothing is rewritten. Consumers verify the checksum before extracting and never use an unpinned `npx`. Direct mode signs in with the planner app's public client via device code, scoped to its own app folder; tokens live only in process memory and are never written, printed or taken as arguments.

## Modules and exports

> [!NOTE]
> **Technical detail: module reference.** Optional implementation detail; the sections above state the behaviour.

<details>
<summary><strong>Show modules, exports and imports</strong></summary>

| Path | Exports | Role |
| --- | --- | --- |
| `packages/planner-tools/bin/planner.js` | — | CLI entry: tool subcommands, `plan`, and `mcp` (broker or device-code). |
| `packages/planner-tools/src/operations.js` | `OPERATIONS`, `VERSION` | The pure operation table; imports the app's `src/focusPlanOps.js` and `src/journalChat.js` and the folder-sync codec and merge. |
| `packages/planner-tools/src/plan.js` | `APPROOT`, `GRAPH`, `MAX_ATTEMPTS`, `planTool`, `runTool`, `writeRequest` | Tokenless plan transport and the shared plan/execute loop. |
| `packages/planner-tools/src/graph.js` | `graphClient` | Direct Graph executor; reads return `{content, id, etag}`, writes only run requests produced by `planTool`. |
| `packages/planner-tools/src/auth.js` | `CLIENT_ID`, `SCOPES`, `deviceAuth`, `environmentAuth` | Delegated sign-in for direct mode. |
| `packages/planner-tools/src/paths.js` | `BOARD`, `BOARD_SIDECAR`, `COMPLETED`, `DOCS_INDEX`, `JOURNAL_DIR`, `TASK_SETTINGS`, `assertReadable`, `assertWritable`, `encodePath`, `isListing`, `isReadable`, `isWritable`, `journalPath` | The allowlist guardrail. |
| `packages/planner-tools/src/docs.js` | `DOCS_APP_URL`, `SnapshotIo`, `docUrl`, `docsNeedsJournal`, `docsRead`, `draftSource`, `makeDocsPublish` | Docs read/publish over snapshots. |
| `packages/planner-tools/src/protocol.js` | `BROKER_TOOL`, `TOOL_DEFINITIONS`, `protocol` | MCP tool list and the broker tool. |
| `packages/planner-tools/src/errors.js` | `ToolError`, `requireValue`, `safeError` | Errors that never echo secrets. |
| `packages/planner-tools/scripts/pack.mjs` | `buildRelease`, `importClosure` | Reproducible release archive. |
| `packages/planner-tools/test/fakeGraph.js` | `APPROOT`, `BOARD`, `COMPLETED`, `GRAPH`, `JOURNAL_31`, `fakeGraph` | In-memory Graph app folder implementing only the endpoints used, with version tags and conditional headers. |

</details>

## Requirements from tests

- `find_tasks` resolves IDs, parents and sections; `get_task` returns journal todos with indexes.
- `add_task` allocates past journals, settings, archive and sync records, is idempotent by title, re-applies after a concurrent edit (412) keeping both changes, and rejects rows that would break the table.
- Priority is set by header cell; moves between sections align the Wake date.
- `append_journal` writes an agent-attributed idempotent note under the owner's date, creates a missing journal create-only, and refuses forged attribution, headings and reserved authors.
- `set_todo` reports stale references.
- `complete_task` archives, tombstones, removes and re-parents (including Deferred rows), verifies, and stays completed even if the app syncs a stale replica afterwards or mid-way.
- Guardrails reject snapshots and writes outside the allowlist and never plan a write without a precondition.
- The broker transport walks `read_required`, `write_required`, `already_applied` without credentials; MCP lists tools and serves `planner_plan` in broker mode; the CLI prints its version and runs `plan` from stdin.
- Docs: create, read comments, publish a revision with dispositions and stay consistent with `fp-docs`; roll an interrupted publish forward; refuse a stale base revision or Docs not enabled; ask for the review set in batches and never read configuration.
- The release archive is reproducible, self-contained and runs outside the repository.

## Failure modes

- No multi-file transaction exists; ordering plus idempotent re-planning is the recovery mechanism, and persistent contention ends in an explicit give-up after five rounds.
- History snapshots are not trimmed over Graph; the local `fp-docs` tool trims them to the newest 20.
- A caller that ignores `write_required` and reports success early would claim an unsaved change; only `already_applied` is proof.
