# Domain: docs-publisher

`docs-publisher` is the **only sanctioned writer** of published Docs. It provides the `fp-docs` command and the library behind it. The agent never writes `docs/` files by hand; it hands a draft to `fp-docs`, which validates it, assigns stable block ids, records how each user comment was answered, and commits the result so a reader never sees a half-written doc. The user-visible Docs behaviour and the normative command contract are in [Domain-docs](Domain-docs); the shared format library is [Domain-docs-core](Domain-docs-core); file formats are in [Data-Formats](Data-Formats).

## Responsibility

- **Publish** a task's primary catch-up doc and any supporting docs from a draft, in one atomic step.
- **Lint** a draft with the identical rules, without writing.
- **Report status**: how long the journal is against the catch-up threshold, each doc's revision, read state and open counts, for one task or a batch in a single read.
- **Return comments**: every open or reopened comment across the review set, grouped by doc, re-anchored to the current text.
- **Acknowledge a review**: claim a submitted review batch so the doc moves to the working state and no other task is woken.
- Serialise concurrent publishers with a recoverable lock.

## Design decisions and rejected alternatives

| Decision | Rejected alternative | Why |
| --- | --- | --- |
| The publisher **never writes `review.json`**. | Letting the agent edit review state. | The user's comments are the app's data. The agent answers in `response.json`; one writer per file means neither side can erase the other. |
| Every refusal is a **named code** with a corrective action, and leaves the last complete revision readable. | Best-effort writes with warnings. | An unattended agent needs an unambiguous signal and a recovery step; a partial write is worse than none. |
| **All inputs are validated before any write**; writes go to a temporary file in the target directory and are renamed into place. Prior revisions are snapshotted, keeping the newest 20. Commit order is body, then response, then index. | Writing files in place. | A crash must leave either the old or the new revision, never a mix. The fixed order lets the next run detect a torn write by comparing the revision in the stamp, response and index, and repair from the latest complete pair. |
| A hand-edited doc is **refused** unless the editor explicitly adopts the change, even if the publisher stamp was left intact. | Overwriting silently. | A human edit is information the agent did not produce; overwriting it loses it. |
| Comments cannot be **evaded by unlinking**: the review set is traversed from the primary, and partial work must be named with a reason. | Letting a draft drop a link to skip its comments. | An answered comment is the product's promise to the user. |
| Block ids are never reused, even after their snapshots rotate out. | Deriving ids from retained history only. | A reused id would attach an old comment to new text. |
| The package depends only on `docs-core` and carries its own lock. | Depending on the agent plugin's lock. | It must install and run standalone, without the plugin tree. |

## Behavioural requirements

Derived from the package's tests.

**Publishing**

- A first publish is reader-valid; a republish carries block ids forward.
- Only the newest twenty prior revisions are retained, and retired block ids are not reused after their snapshots rotate out.
- A changed publisher stamp is refused unless explicitly adopted; so is a body-only hand edit.
- Updating a linked document requires and checks its base revision.
- A supporting doc can be created from a new alias, and `doc:new` links are rewritten to the generated id.
- A Telegram deep link in the task journal metadata is copied into the primary's index entry.
- The first publication honours the configured threshold; a below-threshold first primary reports the normative below-threshold spelling and creates nothing.
- The e2e sample validates through the same reader validators the app uses.

**Comments and answers**

- Primary and supporting answers publish with anchored dispositions, preserving every comment.
- A linked batch is acknowledged once, without a revision, and earlier work is never skipped.
- Needs-you dispositions are visible to badges; invalid blocks are rejected without writes.
- An empty review is distinguished from a corrupt or unreadable one.
- Open and reopened comments come back grouped by review-set doc, with re-anchored placements.

**Limits and safety**

- An oversized index, review file, or review-set body aggregate is refused, including a review set over two MiB across the depth-three traversal.
- If a rename fails midway, earlier files are restored; newly created directories are removed after a failed publish.
- A live publisher lock is never reclaimed.
- Lint never modifies files; a malformed index is reported as a data error; `--check-links` never probes local addresses.

**Agent loop (Node)**

- A scan of hundreds of journals costs one publisher invocation and one registry read.
- The threshold is inclusive and recorded at turn end; the next turn is woken once.
- A planner without the `docs/index.json` gate sees no Docs behaviour at all.
- Parked primary and linked reviews wake; acknowledged unfinished work stays; then the loop goes quiet.
- Corrupt transport is reported explicitly, never as quiet or empty.
- Docs reviews never bypass closed, snoozed, paused or session-ownership guards.
- Publishing requires a fresh publish and a one-line pointer; needs-you counts as blocking.

**Packaging**

- The package packs and installs with only its declared `docs-core` dependency.
- The consumer launcher refuses sandbox escapes without any publisher write.

## Failure modes

| Failure | Behaviour |
| --- | --- |
| Draft invalid (encoding, grammar, catch-up contract, link, size) | Non-zero exit with the code, file/field and a corrective action; nothing written. |
| Stale base revision | Concurrency refusal; the caller re-reads and republishes. |
| Torn write after a crash | Detected by revision mismatch on the next run and repaired from the latest complete snapshot; a revision is never invented from a partial body. |
| Publisher tooling missing | Explicit error, never an empty review. |
| Planner folder not configured | The command refuses; the root comes from configuration, never from a command-line path. |

> [!NOTE]
> **Technical detail: modules, commands and exports.** Optional reference for implementers; the behaviour above is the contract.

<details>
<summary><strong>Show modules, commands and exports</strong></summary>

| Module | Exports | Role |
| --- | --- | --- |
| `packages/docs-publisher/bin/fp-docs.js` | `main` | The CLI. Commands `publish`, `lint`, `status`, `comments`, `ack`; rejects unknown options and non-canonical task ids; takes the Docs root from `PLANNER_PATH`. |
| `packages/docs-publisher/src/publisher.js` | `publish`, `lintDraft`, `readStatus`, `readStatuses`, `readComments`, `acknowledgeReview`, `writeAtomically`, `DocsPublisherError` | The implementation: draft model, link checks, atomic staged write, status and comments reads. |
| `packages/docs-publisher/src/index.js` | the same eight names | Package entry. |
| `packages/docs-publisher/src/lock.js` | `acquireLock`, `releaseLock` | Exclusive-file lock holding the process id, with optional reclaim of a dead holder. |

The command flags and the error-code table (`D01 encoding` through `D11 linked input`) are specified in [Domain-docs](Domain-docs) and are not repeated here.

</details>

See [Technical Architecture](Technical-Architecture) for the Docs data flow, and [Roadmap](Roadmap) for the staged build (#852, #854).
