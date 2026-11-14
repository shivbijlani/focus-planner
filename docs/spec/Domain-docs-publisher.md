# Domain: docs-publisher

`docs-publisher` is the **only writer** of the publisher-owned Docs files. It ships the `fp-docs` command line (`packages/docs-publisher/bin/fp-docs.js`) and the library behind it (`packages/docs-publisher/src/publisher.js`). An agent that wants to hand the user a catch-up Doc, answer the user's comments, or check what is waiting does it through this package and nowhere else. The user's own `review.json` is never written here; it belongs to the app. The on-disk contract is in [Domain-docs](Domain-docs) and the shared parsing and validation library in [Domain-docs-core](Domain-docs-core).

## Why one sanctioned writer

A Doc is a conversation between the user and an agent, so its files have strict ownership: the publisher writes the Doc, its history, the response file and the index; the app writes reviews. Letting any agent hand-edit those files would let a malformed or half-written Doc reach the user's reader. Funnelling every write through one validated, atomic, lock-protected implementation turns "the agent produced something plausible" into "the agent produced something the reader provably accepts". The rejected alternative was documenting the format and trusting agents to follow it.

## Principal modules

> [!NOTE]
> **Technical detail: module map and commands.** Paths, exports and the CLI surface.

<details>
<summary><strong>Show the package's modules and CLI</strong></summary>

| Path | Role |
| --- | --- |
| `packages/docs-publisher/src/publisher.js` | The implementation: lint, publish, status, comments, acknowledge, atomic write. Exports `publish`, `publishUnlocked`, `lintDraft`, `readStatus`, `readStatuses`, `readComments`, `acknowledgeReview`, `acknowledgeReviewUnlocked`, `writeAtomically`, `DocsPublisherError`. |
| `packages/docs-publisher/src/lock.js` | Exclusive-file lock holding the process id (`acquireLock`, `releaseLock`); the same protocol as the consumer agent lock, with no plugin dependency. |
| `packages/docs-publisher/src/index.js` | Package root re-exporting the publisher API. |
| `packages/docs-publisher/bin/fp-docs.js` | The CLI (`main`). |

| Command | Purpose |
| --- | --- |
| `fp-docs publish --task N --draft FILE --summary TEXT` | Publish the next revision (or first Doc). Options: `--base-rev`, repeatable `--linked new:<alias>=FILE` or `<id>=FILE`, `--linked-base-rev`, `--force`, `--adopt-external-edit`, `--check-links`, `--disposition [DOC/]COMMENT=STATUS:bN,@N:NOTE`, `--dispositions FILE`, `--partial --reason TEXT`. |
| `fp-docs lint --draft FILE` | Validate a draft without touching any file. |
| `fp-docs status --task N [--json]` or `--tasks N,N --json` | Report state, revision and threshold result for one or many tasks. |
| `fp-docs comments --task N [--json]` | Print open and reopened comments grouped by review-set Doc. |
| `fp-docs ack --task N --review ID [--doc ID]` | Acknowledge a review without publishing a revision. |

</details>

## Required behaviour

### Publishing

- The first revision is **reader-valid** by construction (it passes the same validators the app uses). Republishing carries block ids forward and never reuses a retired id, even after old snapshots rotate out.
- Only the **twenty most recent prior revisions** are retained as history snapshots.
- A changed publisher stamp, or a body edited by hand even when the stamp is left intact, is refused unless the caller explicitly adopts the external edit. The publisher never silently overwrites a human's change.
- A supporting Doc is created from a new alias; `doc:new:<alias>` links are rewritten to the real id in the same publish. Updating a linked Doc requires and checks its base revision. A Telegram deep link in the task journal's metadata is copied into the primary's index entry.
- The threshold is configurable. Below it, no primary is created and the normative below-threshold message is returned; `--force` overrides deliberately.

### Answering comments

- Every open or reopened comment in the whole review set needs a **disposition** (`answered`, `done`, `declined`, `needs-you`) anchored to a block of the new draft, or the publish must be explicitly marked partial with a reason. Partial work is named, not hidden, and a comment cannot be evaded by unlinking its Doc.
- All comments are preserved. `needs-you` is visible to status badges.
- `ack` acknowledges a linked batch once, without a revision, and never skips earlier unacknowledged work.
- Comments are returned with their placements re-anchored to the current revision.

### Reading

- `status` for many tasks reads and validates **one registry snapshot**, caches files, and preserves per-task read errors rather than failing the batch.
- An actually empty review is distinguished from a corrupt or unreadable one; corruption is reported, never presented as "nothing to do".
- `lint` writes nothing; a malformed index is a data error; `--check-links` never probes local addresses.

### Safety

- Refuses an oversized index, review file or review-set body aggregate, including a review set over two MiB across the depth-three traversal.
- Writes are **staged and atomic**: if a rename fails partway, earlier files are restored and newly created directories are removed.
- A live lock is never reclaimed; the package declares only its `docs-core` dependency so it packs and installs standalone, and its consumer launcher refuses sandbox escapes without writing.

### Failure vocabulary

Every refusal is a `DocsPublisherError` carrying one of ten categories — `D01 encoding`, `D02 grammar`, `D03 catch-up`, `D04 link`, `D05 disposition`, `D06 concurrency`, `D07 size`, `D08 binding`, `D09 data`, `D10 external edit` — with a remedy. The table of causes is in [Domain-docs](Domain-docs).

## Agent-loop behaviour (Node)

`packages/docs-publisher/src/agent-loop.test.js` pins how the overnight agent uses the publisher: one publisher invocation and one registry read scan every journal; a threshold crossing is recorded at turn end and wakes the next turn once; a planner without the Docs index gate gets no Docs behaviour; parked primary and linked reviews wake, acknowledged unfinished work stays, then the loop goes quiet; corrupt transport is reported explicitly; Docs reviews never bypass closed, snoozed, paused or session-ownership guards; and a turn needs a fresh publish and a one-line pointer, with `needs-you` treated as blocking.

## Tests

`packages/docs-publisher/src/publisher.test.js`, `packages/docs-publisher/src/standalone.test.js` and the agent-loop test above. Remote agents reach the same publisher through [Domain-planner-tools](Domain-planner-tools).
