# Domain: docs-publisher

`docs-publisher` is the only writer of published catch-up documents. It ships as the `fp-docs` command-line tool: the agent hands it a draft in plain journal markdown, and it validates, converts, assigns block ids, answers comments, snapshots the previous revision and updates the registry — all or nothing. The file formats and product behaviour are specified in [Domain-docs](Domain-docs); the shared reading library it builds on is [Domain-docs-core](Domain-docs-core).

## Responsibility

One writer per file is the central rule: the publisher owns `doc.md`, `response.json`, `index.json` and the history snapshots, while the app owns `review.json`. Concentrating publishing in one tool means every document the user sees has passed the same checks, and a half-written revision can be detected and repaired instead of shown. The alternative — letting the agent write documents directly — was rejected because nothing could then guarantee valid block anchors, preserved comments or a consistent revision across files.

## Commands

| Command | What it does |
| --- | --- |
| `publish` | Creates or updates a task's primary document and any supporting documents in one call. Updates against a linked document require the revision the caller last read, so a stale edit is refused. |
| `lint` | Runs the same encoding, grammar, contract, link and size checks without writing anything. |
| `status` | Reports the journal's word count against the threshold, document revisions and read state, and open comment counts. Task ids must be canonical. |
| `comments` | Lists open and reopened comments across the whole review set, grouped by document and re-anchored for display. It changes no files. |

Related flags: a new supporting document is created from an alias and its `doc:new:<alias>` links are rewritten to the generated id; a below-threshold first primary needs an explicit force; leaving comments unanswered needs a partial publish with a stated reason; adopting a hand edit needs an explicit flag. Link reachability is only checked when asked, and the check never probes local addresses.

## Requirements a rebuild must meet

| Area | Requirement |
| --- | --- |
| Draft validation | Lint never modifies files; a malformed index is reported as a data error, distinct from a draft error. |
| First publication | Produces a document the reader-side validators accept, honours a configured threshold, and copies a Telegram deep link from the journal's metadata into the primary's index entry. |
| Republishing | Carries block ids forward; keeps only the newest twenty prior revision snapshots; never reuses a retired id even after its snapshot rotates out. |
| External edits | A changed publisher stamp is refused unless explicitly adopted, and so is a body-only hand edit even when the stamp is left intact. |
| Comments | Every open comment in the review set needs a disposition, or the publish must be partial with a reason. |
| Size and atomicity | An oversized index, review file, document or review set (over two MiB across the depth-three traversal) is refused. Writes are staged and renamed; if a rename fails, earlier files are restored and any newly created directories are removed. |
| Commit order | `doc.md`, then `response.json`, then `index.json`; the same revision appears in the body stamp, the response and the index entry. A mismatch on the next run is treated as a torn write and repaired from the latest complete snapshot and response, never by inventing a revision. |

Refusals exit non-zero, leave the last complete revision readable and name the offending file or comment with a corrective action; the error codes are tabulated in [Domain-docs](Domain-docs).

## Principal modules

The publisher is one logic module, a re-export index and a thin command-line wrapper.

> [!NOTE]
> **Technical detail: module paths.** Optional reference for implementers.

<details>
<summary><strong>Show the module table</strong></summary>

| Module | Role |
| --- | --- |
| `packages/docs-publisher/src/publisher.js` | All logic: draft lint, conversion, block-id assignment, dispositions, snapshots, atomic staged writes, status and comment reads. |
| `packages/docs-publisher/src/index.js` | Re-exports the public API. |
| `packages/docs-publisher/bin/fp-docs.js` | The command-line wrapper: argument parsing, JSON output, exit codes. |

</details>

> [!NOTE]
> **Technical detail: public API.** Optional reference for implementers.

<details>
<summary><strong>Show exported functions and dependencies</strong></summary>

`packages/docs-publisher/src/index.js` exports `publish`, `lintDraft`, `readStatus`, `readComments`, `writeAtomically` and the `DocsPublisherError` class. `publisher.js` imports `grammar.js`, `index.js` and `review.js` from `packages/docs-core/src`; the CLI imports only the publisher's own `index.js`. The Docs root comes from configuration and is never accepted as a command-line path, so a caller cannot redirect writes.

</details>

## Known gaps

The overnight-agent skill does not yet call `fp-docs` automatically; the wiring is separate work described in [Domain-docs](Domain-docs).

## Tests

All behaviour above is pinned by `packages/docs-publisher/src/publisher.test.js` (draft validation, publish, CLI, size limits and atomic writes); see [Behaviour](Behaviour).
