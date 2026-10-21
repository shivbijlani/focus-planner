# Focus Planner agent tools 1.1.0

Lets an agent (Muse, a Copilot chat, any process that can run Node 22+) update
Shiv's Focus Planner without driving the web UI: find tasks, add tasks, set
priority, defer/move, append agent-attributed journal notes, check todos and
complete tasks. No hosted service and no npm dependencies.

- **Same code as the app.** Every change is made by the Planner UI's own
  modules (`src/focusPlanOps.js`, `src/journalChat.js`) and the sync engine's
  record metadata (`packages/folder-sync`). The release archive contains those
  exact files at their repository paths (`MANIFEST.json` lists their hashes).
- **Direct OneDrive, conditional writes.** Tools read the Planner app folder
  (`Apps/Focus Planner`) through Microsoft Graph with item eTags and write with
  `If-Match` (updates) or `If-None-Match: *` (creates). Never the local sync
  folder. On a conflict the change is re-applied to fresh content, never by
  resending an old body, so concurrent app edits survive.
- **Guardrails are unreachable.** Only `planner.md`, its `planner.md.sync.json`
  sidecar, `planner-completed.md`, `journal/task-<id>.md`, publisher-owned Docs
  files under `docs/` (and read-only `task-settings.json`, Docs `review.json` and
  the journal listing) are allowed. `agent-gate.md`,
  `user-settings.md`, `AGENTS.md`, settings and any other file are refused for
  every read and write, including by the direct Graph client.
- **Agents never speak as the user.** Journal notes carry `<!-- from: <agent> -->`;
  `me`, `overnight-agent` and similar authors are refused, as are HTML comments
  and `#`/`##` headings outside code fences (they carry attribution and dates).

## Install a pinned release

Release: https://github.com/shivbijlani/focus-planner/releases/tag/planner-tools-v1.1.0

```bash
base=https://github.com/shivbijlani/focus-planner/releases/download/planner-tools-v1.1.0
curl -fsSLO $base/planner-tools-1.1.0.tgz
curl -fsSLO $base/planner-tools-1.1.0.tgz.sha256
sha256sum -c planner-tools-1.1.0.tgz.sha256      # must print OK before extracting
tar -xzf planner-tools-1.1.0.tgz
node package/packages/planner-tools/bin/planner.js --version   # 1.1.0
```

Windows: `Get-FileHash planner-tools-1.1.0.tgz -Algorithm SHA256` must equal the
first word of the `.sha256` file. Do not use an unpinned `npx`.

## Tokenless broker transport (Muse)

Muse's credential broker cannot hand a token to a process; it substitutes the
`Authorization` header on HTTPS egress to Graph. So the tools never see a
token. Run either:

```bash
node package/packages/planner-tools/bin/planner.js mcp --broker   # MCP tool: planner_plan
node package/packages/planner-tools/bin/planner.js plan < request.json   # one shot
```

Request: `{"tool": "<name>", "arguments": {...}, "snapshots": {...}}`. Response
`state` is one of:

| state | meaning | what to do |
| --- | --- | --- |
| `read_required` | files are missing from `snapshots` | GET each listed URL through the broker. For files: take `id`, `eTag`, `@microsoft.graph.downloadUrl`; download that URL **without** Authorization; GET the metadata again and keep the content only if `id`/`eTag` are unchanged. Supply `snapshots[filename] = {"content","id","etag"}`; only a confirmed 404 is `{"content":null,"id":null,"etag":null}`. For `journal/`: supply `{"names":[...]}` (follow `@odata.nextLink`). Call again. |
| `read_complete` | read tool result | Use `result`. |
| `write_required` | the change is not on OneDrive yet | Show `writes[].preview` when useful. Execute `writes[].request` in order, exactly as given (UTF-8 body, keep `If-Match`/`If-None-Match`); stop at the first non-2xx. Then, **whatever happened**, discard all snapshots, re-read, and call again with the same tool, arguments and `operationId`. |
| `already_applied` | verified on OneDrive | Only now report the change as saved. |

On 409/412: re-read and re-plan (never strip the precondition or replay a body).
On 401/403: stop and ask the user to reconnect. Give up after five rounds with
an explicit contention message.

## Tools

Start every request with `find_tasks` to resolve the task the user means and to
avoid duplicates. Use one `operationId` per intended change (16-120 of
`A-Za-z0-9:_-`, e.g. `muse:2026-10-21:<uuid>`) and reuse it on every retry. Pass
`timeZone` (the owner's IANA zone, `America/Los_Angeles` for Shiv) on changes.

| tool | arguments | notes |
| --- | --- | --- |
| `find_tasks` | `query?`, `section?` (`all`/`Today`/`Deferred`), `limit?` | read only |
| `get_task` | `taskId`, `journalChars?` | read only; journal tail and todos with `index` |
| `add_task` | `title`, `priority?`, `section?`, `parentId?`, `operationId`, `timeZone` | ID allocated like the app; an active task with the same title is returned instead of duplicated |
| `set_priority` | `taskId`, `priority`, `operationId` | 🔴 🟡 🔵 ⚪ 🐸 📖 |
| `move_task` | `taskId`, `to`, `wakeOn?`, `operationId`, `timeZone` | `wakeOn` defers until a date |
| `append_journal` | `taskId`, `text`, `author`, `operationId`, `timeZone` | agent bubble; creates the journal if missing; a hidden `planner-op` marker makes retries exact |
| `set_todo` | `taskId`, `todoIndex`, `todoText`, `done`, `operationId` | index + exact text from `get_task` |
| `complete_task` | `taskId`, `outcome?`, `comment?`, `author?`, `operationId`, `timeZone` | archives, removes, re-parents children; confirm with the user first |
| `docs_read` | `taskId`, `includeDrafts?` | read only; the task's Docs set (primary + linked drafts) with editable Markdown, block ids and open comments |
| `docs_publish` | `taskId`, `summary`, `baseRev`, `draft?`, `linked?`, `dispositions?`, `author?`, `timeZone?`, `operationId` | next Docs revision through the sanctioned publisher; one disposition per open comment |

## Docs draft review loop

For drafts the user should comment on (resumes, PARs, proposals), publish them
as a native Docs set instead of emailing them: a primary catch-up doc for the
task that links a supporting doc holding the draft itself.

1. **First draft:** `docs_publish` with `draft` (the catch-up: `# Title`, a
   bold status sentence, then the sections *What this is, with no prior
   context*, *Why it matters*, *What changed / what was done*, *Evidence*,
   *Where it stands*), `linked: [{"alias": "draft", "draft": "# ..."}]`
   referenced from the primary as `doc:new:draft`, and `force: true` when the
   journal is short. Send the user the returned `url`.
2. **The user comments** in the Docs app (phone or desktop) and presses Send,
   then tells the agent ("I made comments on 356").
3. **Next draft:** `docs_read` returns each doc's current Markdown, `rev` and
   the open comments (quoted text, intent, body). Rewrite the full draft,
   answer questions in the doc itself, then `docs_publish` with `baseRev` (the
   primary rev), `linked: [{"id", "baseRev", "draft"}]` for each changed
   supporting doc, and a disposition per comment, e.g.
   `{"doc": "d-…", "id": "c_…", "status": "done", "blocks": ["@3"]}` where `@3`
   is the third block of the new draft. `needs-you` asks the user back. Pass
   `author` and `timeZone` to leave a one-line journal pointer.
4. Only `already_applied` means published; then tell the user the revision is
   ready at `url`.

The publisher refuses (code `DOCS_REFUSED`, with the `D0x` reason) drafts with
raw HTML, a stale `baseRev`, or unanswered comments. It is the unchanged
`packages/docs-publisher` code running against the fetched snapshots; it never
writes the user's `review.json`. Publishing claims the submitted reviews (the
Docs app shows "Working"). A retried `operationId` is recognised from the
revision it created. An interrupted multi-file publish is rolled back (body
only) or forward (body and response) on the next call. History snapshots are
not trimmed over Graph; `fp-docs` trims them to the newest 20. Configuration
files stay unreadable, so the first-doc threshold is the 1,500-word default.

`complete_task` touches several files in a safe order: archive row, journal
close-out, a sync tombstone in `planner.md.sync.json`, then the board. Each step
is re-derived from fresh content, so an interrupted run resumes correctly. The
tombstone is required because the app's sync never infers a delete from a row
missing in the cloud copy (that protects against stale devices); without it the
app would restore the row.

## Direct mode (CLI / chat MCP)

```bash
node package/packages/planner-tools/bin/planner.js mcp --device-code
echo '{"query":"trip"}' | node package/packages/planner-tools/bin/planner.js find_tasks --device-code
```

Signs in with the Planner app's public client ID
`4f22242f-c9a7-4a61-9208-8ca0e5ef8697`, scope
`Files.ReadWrite.AppFolder offline_access` (only the Planner app folder). This
requires "Allow public client flows" on that app registration; deployment does
not change it. Tokens stay in process memory. `PLANNER_ACCESS_TOKEN` in the
runtime environment is also accepted (captured, then removed from the
environment). Direct mode executes exactly the requests the broker plan would
return, with the same re-read/re-plan loop.

## Limits

- Graph has no multi-file transaction; ordering plus idempotent re-planning is
  what makes interrupted completions recoverable.
- `add_task` is idempotent by title among active tasks.
- External editors that strip `planner-op` markers lose retry protection for
  those notes.
- Tested with in-memory Graph fakes (including forced 412s, app-sync
  reconciliation of a stale replica, and guardrail attempts): `npx vitest run
  packages/planner-tools` in the repository.
