# Domain: docs-core

`docs-core` is the pure, dependency-free library that defines what a native catch-up document *is*: how its text is read, how comments stick to it, how two devices' comments merge, how its lifecycle state is derived, and which files are too large or malformed to trust. The planner app and the publisher both import it, so the user's reading screen and the agent's writing tool cannot disagree about the format. The full product behaviour, file ownership and test vectors live in [Domain-docs](Domain-docs); the on-disk samples are in [Data-Formats](Data-Formats); the publisher that writes these files is [Domain-docs-publisher](Domain-docs-publisher).

## Responsibility

The library does no input/output. Every function takes text or parsed objects and returns new values. That is a deliberate choice: the same code must run in the browser (app) and in Node (agent tool), and a reader that can touch the disk could not be shared. The design stance is **tolerant reader, strict writer** — reading a hand-edited document still renders and can still be commented on, while the publisher refuses anything the reader would mishandle.

## Behaviour a rebuild must reproduce

| Area | Requirement | Why |
| --- | --- | --- |
| Shared journal grammar | Fenced code is literal and `<!-- ... -->` comments (including multi-line and unterminated ones) are hidden. The journal chat parser and the Docs parser use the same fence mask. | Two parsers that disagree about what is markup would show the user a different document than the agent wrote. A shared function removes the possibility of drift. |
| Document parsing | A document is a header line, a title and anchored blocks. Content before the first anchor becomes block `b0`, so a hand-edited document still renders. BOMs and CRLF are tolerated; anchors and headings inside fences are literal; malformed long header attributes are scanned in linear time. | The reader must never fail on a document a person touched; it must also not be attackable by a pathological header. |
| Status line | The bold status sentence directly after the title is exposed separately. | It is the one line a returning reader needs first. |
| Block identity | Block ids are positive integers carried across revisions: an exact unique match keeps its id, a similar block keeps it by best score, ambiguous duplicates do not carry, and a retired id is never reused. New and edited blocks are flagged by comparing against the previous revision. | Comments are attached to blocks; reusing an id would attach an old comment to unrelated text. |
| Anchoring | A comment stores the quoted text, a little context before and after, and its block offset; multi-block selections store start and end blocks. Re-anchoring tries the same block, then anywhere in the document, then gives up and marks the comment *outdated*. Ties are never guessed. | A comment that cannot be placed is kept and listed, never lost or silently moved. |
| Links and review set | `doc:` links point to a whole document or one block. The review set of a primary is the primary plus every document reachable by `links`, breadth first, cycle-safe, capped at depth three. Hash routes round-trip. | The user reviews a primary and its supporting documents as one unit. |
| Review merge | `review.json` comments merge by id; the larger `clock` wins, equal clocks fall to a deterministic serialisation comparison, and `readRev` takes the maximum. The merge is commutative and idempotent. | More than one device writes the file, and folder sync can deliver edits in any order. |
| Derived state | A comment is a draft until submitted, then open, needs-you or resolved according to the agent's disposition; a reopen overrides older dispositions. Document state is derived and never stored: awaiting-review, review-submitted, or working. | Stored state can contradict the files; derived state cannot. |
| Reader validation | Index, review, response and document text are validated; unknown fields are ignored, negative anchor offsets and invalid required fields are refused, the document stamp and title must match the index entry, and size limits apply (document body 256 KiB, index 1 MiB, review file 1 MiB, review-set total 2 MiB). | Ignoring unknown fields lets the format grow; hard limits stop a runaway file from freezing the app. |
| Read load | The catch-up threshold counts visible journal words (comments and markers stripped); the default is 1500 and about 250 words is one minute. | The agent and the app share one measure so they never disagree about when a document is due. |

## Principal modules

The library has one module per concern: grammar, document parsing, anchoring, links, review state, read load, validation, and an index that re-exports them.

> [!NOTE]
> **Technical detail: module paths.** Optional reference for implementers.

<details>
<summary><strong>Show the module table</strong></summary>

| Module | Role |
| --- | --- |
| `packages/docs-core/src/grammar.js` | Fence mask, visible-line walk and line splitting shared with the journal parser. |
| `packages/docs-core/src/doc.js` | Document parsing, header, block ids, change flags, outline, plain text. |
| `packages/docs-core/src/anchor.js` | Text-quote anchors and re-anchoring. |
| `packages/docs-core/src/links.js` | `doc:` hrefs, link extraction, review-set traversal, hash routes. |
| `packages/docs-core/src/review.js` | Review and response parsing, merge, draft submission, reopen, comment status, derived document state. |
| `packages/docs-core/src/readLoad.js` | The threshold measure. |
| `packages/docs-core/src/validate.js` | Reader-side validation and the size limits. |
| `packages/docs-core/src/index.js` | Re-exports everything and defines the storage paths of the format. |

</details>

> [!NOTE]
> **Technical detail: public exports and storage paths.** Optional reference for implementers.

<details>
<summary><strong>Show exports per module and the path helpers</strong></summary>

| Module | Exports |
| --- | --- |
| `grammar.js` | `fencedLineMask`, `splitLines`, `trimBlankEnds`, `visibleLines`, `walkVisibleLines` |
| `doc.js` | `parseDoc`, `parseDocHeader`, `parseDraftBlocks`, `statusLine`, `blockPlainText`, `changedBlockIds`, `assignBlockIds`, `outline` |
| `anchor.js` | `CONTEXT_CHARS` (32), `quoteSelector`, `findQuote`, `isMultiBlock`, `reanchor`, `makeAnchor` |
| `links.js` | `DOC_ID_RE`, `parseDocHref`, `isDocHref`, `extractDocLinks`, `linkedFrom`, `reviewSet`, `docHref`, `parseRoute` |
| `review.js` | `REVIEW_VERSION`, `INTENTS` (approve, question, do-more, note), `INTENT_META`, `RESOLVING_DISPOSITIONS` (answered, done, declined), `emptyReview`, `parseReview`, `serializeReview`, `parseResponse`, `parseIndex`, `mergeReviews`, `newCommentId`, `newReviewId`, `submitDrafts`, `reopenComment`, `commentStatus`, `deriveDocState` |
| `readLoad.js` | `DEFAULT_CATCHUP_THRESHOLD`, `journalReadLoad` |
| `validate.js` | `DOCS_LIMITS`, `DocsDataError`, `docsByteLength`, `docBodyByteLength`, `validateDocText`, `validateIndexText`, `validateResponseText`, `validateReviewText` |
| `index.js` | `DOCS_DIR`, `DOCS_INDEX`, `docPath`, `reviewPath`, `responsePath`, `historyPath` |

Storage layout produced by the path helpers: `docs/index.json`, `docs/<id>/doc.md`, `docs/<id>/review.json`, `docs/<id>/response.json`, `docs/<id>/history/rNNNN.md` (revision zero-padded to four digits). Identifier shapes: documents `d-` plus six or more lowercase alphanumerics; blocks `b1`, `b2`, …; comments `c_…`; reviews `rv_…`. A dispositions value of `needs-you` is accepted by the reader but is not resolving.

Document header, as parsed:

```
<!-- docs v1 id=d-7kx2m4 rev=4 published=2026-09-30T21:40:00Z by=overnight-agent -->
# Task 123: Mortgage refinance options

<!-- @b1 -->
**Status: 2 options ready — tell me which one to lock.**
```

</details>

## Failure modes

| Failure | Behaviour |
| --- | --- |
| Malformed or schema-invalid JSON | The reader refuses it with a data error naming the field; it does not guess. |
| Oversized file | Refused with a size error rather than truncated. |
| Ambiguous duplicate block | Gets a fresh id; its old comments become outdated, not misattached. |
| Unplaceable comment | Marked outdated, kept in the list. |
| Concurrent review edits | Converge through the merge rules above; no device's comment is dropped. |

## Tests

The suites are `packages/docs-core/src/anchor.test.js`, `packages/docs-core/src/doc.test.js`, `packages/docs-core/src/review.test.js` and `packages/docs-core/src/validate.test.js`; their cases are converted to acceptance statements in [Behaviour](Behaviour). Design intent for the library is recorded in `plans/docs-app-design.md`.
