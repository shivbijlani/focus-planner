# Domain: docs-publisher

`docs-publisher` is the **only sanctioned writer of an agent's side of a native catch-up Doc**. It packages the `fp-docs` command-line tool and the library behind it. Agents never edit Doc files by hand: they hand the publisher a draft and per-comment dispositions, and it validates, stamps, snapshots and writes atomically. The file formats and lifecycle are specified in [Domain-docs](Domain-docs) and the shared library in [Domain-docs-core](Domain-docs-core).

## Responsibility and rationale

- **Publish, lint, status, comments, acknowledge.** Five commands cover the loop: `publish` (create or update the primary and supporting docs), `lint` (the same validation with no writes), `status` (threshold state, revisions, open counts, for one task or a batch from one registry read), `comments` (open and reopened comments grouped by document and re-anchored), and `ack` (claim a submitted review so the task reads as Working).
- **One writer per file.** The publisher writes `doc.md`, `response.json`, history snapshots and the index; it never writes `review.json`, which belongs to the app. This is what makes concurrent app and agent activity safe without locks across devices.
- **Atomic, recoverable writes.** A publish stages every file and renames them together; if a rename fails midway the earlier files are restored and newly created directories removed. Only the 20 most recent prior revision snapshots are retained, and block ids retired when snapshots rotate out are never reused.
- **Refuse unsafe edits.** A changed publisher stamp, or a body hand-edited behind an intact stamp, is refused unless the caller explicitly adopts the external edit. A stale base revision is refused. Invalid dispositions (for instance, an unknown block) are rejected before any write.
- **No silent loss of comments.** Every open comment must receive a disposition (answered, done, declined, needs-you) unless the caller declares a partial publish with a reason. A comment cannot be evaded by unlinking a supporting doc. `needs-you` is visible to badges and is blocking for the agent.
- **A local process lock, not a distributed one.** Mutations are serialised with an exclusive PID lock file that never reclaims a live holder. The package carries its own lock (the same protocol as the agent's) so it has no dependency on the plugin; it depends only on `docs-core`.
- **Honest errors.** Failures carry a category code D01–D11 (encoding, grammar, catch-up, link, disposition, concurrency, size, binding, data, external edit, linked input). An actually empty review is distinguished from a corrupt or unreadable one, and a below-threshold publish reports the normative spelling without creating a primary.

## Behavioural requirements

Derived from `packages/docs-publisher/src/*.test.js`.

- **Feedback loop:** acknowledging a linked batch happens once, without a revision, and never skips earlier work; primary and supporting answers publish with anchored dispositions and every comment is preserved; partial work is named explicitly.
- **Publish:** a first revision is reader-valid and block ids carry on republish; the configured threshold governs first publication; a Telegram deep link in the task journal metadata is copied into the primary's index entry; a supporting doc is created from a new alias and `doc:new:<alias>` links are rewritten to the generated id; updating a linked doc requires and checks its base revision.
- **Validation:** `lint` never modifies files; a malformed index is a data error; `--check-links` does not probe local addresses.
- **Batch status:** one registry snapshot is read and validated, files are cached, and per-task read errors are preserved rather than aborting the batch.
- **CLI:** comments print as JSON without modifying publisher files; status prints JSON and rejects non-canonical task ids; `publish` accepts the documented new-linked-doc flag.
- **Limits and atomicity:** oversize index, review file, and review-set aggregate are refused (including across the depth-three traversal over two MiB); an injected rename failure restores earlier files; a failed publish removes newly created directories.
- **Standalone package:** it packs and installs with only its declared `docs-core` dependency and no plugin tree; it never reclaims a live publisher lock; the consumer launcher refuses sandbox escapes with no publisher writes.
- **Node agent loop:** one publisher invocation and one registry read scan hundreds of journals; the catch-up threshold is recorded at turn end and wakes the next turn once; a planner without the Docs index gate gets no Docs behaviour; parked primary and linked reviews wake, acknowledged unfinished work stays, then the loop goes quiet; corrupt transport is reported rather than shown as quiet; Docs reviews never bypass closed, snoozed, paused or session-ownership guards; a fresh publish plus a one-line journal pointer is required and `needs-you` is blocking.

## Principal modules

> [!NOTE]
> **Technical detail: module and export table.** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show modules and exports</strong></summary>

| Path | Exports | Role |
| --- | --- | --- |
| `packages/docs-publisher/bin/fp-docs.js` | `main` | CLI: `publish`, `lint`, `status`, `comments`, `ack`; options such as `--task`, `--draft`, `--summary`, `--base-rev`, `--linked`, `--disposition(s)`, `--partial --reason`, `--force`, `--adopt-external-edit`, `--check-links`, `--json`. Unknown or duplicated options are D09 data errors. |
| `packages/docs-publisher/src/publisher.js` | `DocsPublisherError`, `acknowledgeReview`, `acknowledgeReviewUnlocked`, `lintDraft`, `publish`, `publishUnlocked`, `readComments`, `readStatus`, `readStatuses`, `writeAtomically` | The publisher; the `Unlocked` variants run under a caller-held lock (used when a different concurrency control, such as conditional writes, is in force). |
| `packages/docs-publisher/src/lock.js` | `acquireLock`, `releaseLock` | Exclusive-file PID lock with optional dead-holder reclaim. |
| `packages/docs-publisher/src/index.js` | (re-exports the publisher API) | Package entry. |

</details>

## Failure modes

A hand-edited Doc published over silently would destroy a user's edit, hence the stamp check. A crash between renames would leave a torn revision, hence staged writes with restore. Reading a corrupt review as empty would make the agent look finished, hence the separate corrupt/empty outcomes. Remote agents use the same code through [Domain-planner-tools](Domain-planner-tools), replacing the process lock with conditional writes.

## Known gaps

The publisher CLI and the related app slices were tracked as staged items (#852, #854, #845, #838); catch-up document creation can still duplicate documents when creation succeeds but binding fails (#763), and no sweep reads a Doc's body for stale figures (#594).
