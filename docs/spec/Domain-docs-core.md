# Domain: docs-core

`docs-core` is the pure, dependency-free library that defines what a **native catch-up Doc** is and how it is read: how `doc.md` splits into addressable blocks, how a comment stays attached to a passage when the document changes, how comments from several devices merge, and what state a document is in. Every consumer — the browser Docs app, the publisher CLI, the agent loop and the agent tools — imports it, so the rules live once. The product and format contract is [Domain-docs](Domain-docs); the on-disk shapes are in [Data-Formats](Data-Formats). The writing side is [Domain-docs-publisher](Domain-docs-publisher).

## Responsibility and design thesis

A Doc is Markdown in exactly the **journal's** subset, not a new dialect. Therefore the Docs parser and the journal parser must agree on the two rules that decide what is markup and what is text: fenced code is literal, and `<!-- … -->` comments (which may span lines) are hidden. The shared grammar module is imported by the journal parser too, so the two cannot drift. The rejected alternative — each parser carrying its own fence and comment scan — had already produced bugs where a heading inside a code fence was treated as a heading.

Anchoring follows the W3C TextQuote idea scoped to one block. A comment stores the quoted text, a little prefix and suffix context, and the block's offset. **An outdated comment is kept and listed, never lost.** The rejected alternative — deleting comments whose text vanished — would destroy the reviewer's input exactly when the author changed the passage.

Review data is app-owned but can be written from more than one device, so comments **merge by id**, with last-write-wins on a per-comment logical clock and a deterministic tie-break. The merge is commutative and idempotent, so devices converge regardless of order.

## Behaviour

**Parsing `doc.md`.** The file starts with a header comment carrying format version, document id, revision, publish time and author, then a `# Title`, then blocks. A block begins at an anchor comment `<!-- @bN -->` and owns every visible line until the next anchor. Content before the first anchor (other than header and title) becomes block `b0`, so a hand-edited document still renders and can be commented on. Anchors and headings inside fences are literal code. BOM and CRLF are tolerated on read, and long malformed header attributes are scanned in linear time. The bold status sentence after the title is exposed separately; heading blocks form an outline; markdown is strippable to plain text for anchoring.

**Block ids.** The publisher assigns ids. When a revision is republished each new block carries over the id of a block with unique exact text, then a unique similar block; an ambiguous duplicate never carries an id, and a retired id is never reused. Changes between revisions flag only new and edited blocks.

**Links.** `doc:<id>` links a whole doc and `doc:<id>#bN` a block. The **review set** of a task is the primary doc plus every doc reachable through links, walked cycle-safely with a depth cap, with duplicates removed and order preserved. Route strings round-trip.

**Anchoring.** Re-anchoring tries, in order: same block with the quote; the quote anywhere in the document; otherwise *outdated*. Repeated quotes are disambiguated by prefix and suffix context and then by the stored offset; a tie that cannot be resolved marks the comment outdated rather than guessing. A selection across blocks stores start and end blocks with a quote for each.

**Merging review data.** Comments union by id. For the same comment the newer clock wins; equal clocks use a fixed tie-break; the highest read revision is kept. Serialisation is stable so identical merges produce identical bytes, and parsing is defensive.

**Derived state.** A comment is resolved when the agent has a resolving disposition for it, and a user can reopen it so reopening overrides older dispositions. A document is in exactly one of three states: `awaiting-review` (nothing submitted), `review-submitted` (at least one submitted review is not yet acknowledged), or `working` (the latest acknowledged review covers the current revision). The state also reports unread (revision above the user's read revision), counts of open and needs-you comments, pending review ids and draft count.

**Read-load threshold.** A catch-up Doc is only warranted when a journal is long. The measure is the number of **visible** words (comments and markers stripped), default threshold 1500, with reading minutes at 250 words per minute. App and agent share the function so they never disagree about whether the threshold is reached.

**Reader validation.** Readers validate every file defensively and ignore unknown fields so newer writers do not break older readers. Limits: a document body 256 KiB, the index 1 MiB, a review file 1 MiB, a review set 2 MiB; larger inputs are refused, never truncated. The index requires version 1 with `tasks` and `docs`; task keys are canonical positive integers; doc ids look like `d-` plus six or more lowercase alphanumerics; block ids `b1…`; comment ids `c_…`; review ids `rv_…`; intents are `approve`, `question`, `do-more`, `note`; dispositions are `answered`, `done`, `needs-you`, `declined`. A negative anchor offset is invalid, and a document's stamp and title must match its index entry.

## Modules and exports

> [!NOTE]
> **Technical detail: module reference.** Optional implementation detail; the section above states the behaviour.

<details>
<summary><strong>Show modules and exports</strong></summary>

| Path | Exports | Role |
| --- | --- | --- |
| `packages/docs-core/src/grammar.js` | `fencedLineMask`, `splitLines`, `trimBlankEnds`, `visibleLines`, `walkVisibleLines` | Shared journal grammar: fences literal, comments hidden. |
| `packages/docs-core/src/doc.js` | `assignBlockIds`, `blockPlainText`, `changedBlockIds`, `outline`, `parseDoc`, `parseDocHeader`, `parseDraftBlocks`, `statusLine` | `doc.md` to header, title and blocks; block-id carrying. |
| `packages/docs-core/src/links.js` | `DOC_ID_RE`, `docHref`, `extractDocLinks`, `isDocHref`, `linkedFrom`, `parseDocHref`, `parseRoute`, `reviewSet` | `doc:` links and the review set. |
| `packages/docs-core/src/anchor.js` | `CONTEXT_CHARS`, `findQuote`, `isMultiBlock`, `makeAnchor`, `quoteSelector`, `reanchor` | TextQuote anchoring scoped to a block. |
| `packages/docs-core/src/review.js` | `INTENTS`, `INTENT_META`, `RESOLVING_DISPOSITIONS`, `REVIEW_VERSION`, `commentStatus`, `deriveDocState`, `emptyReview`, `mergeReviews`, `newCommentId`, `newReviewId`, `parseIndex`, `parseResponse`, `parseReview`, `reopenComment`, `serializeReview`, `submitDrafts` | Review merge and derived state. |
| `packages/docs-core/src/readLoad.js` | `DEFAULT_CATCHUP_THRESHOLD`, `journalReadLoad` | Catch-up threshold measure. |
| `packages/docs-core/src/validate.js` | `DOCS_LIMITS`, `DocsDataError`, `docBodyByteLength`, `docsByteLength`, `validateDocText`, `validateIndexText`, `validateResponseText`, `validateReviewText` | Reader validators and size limits. |
| `packages/docs-core/src/index.js` | `DOCS_DIR`, `DOCS_INDEX`, `docPath`, `historyPath`, `responsePath`, `reviewPath` | Barrel plus storage path builders (`docs/index.json`, `docs/<id>/doc.md`, `review.json`, `response.json`, `history/rNNNN.md`). |

Sample `doc.md` start:

```markdown
<!-- docs v1 id=d-7kx2m4 rev=4 published=2026-09-30T21:40:00Z by=overnight-agent -->
# Task 123: Mortgage refinance options

<!-- @b1 -->
**Status: 2 options ready — tell me which one to lock.**
```

</details>

## Requirements from tests

- Anchors: capture quote, prefix and suffix; disambiguate repeats by context; use stored offset and mark unresolved ties outdated; re-anchor same block, then anywhere, then outdated; anchor multi-block selections.
- Links: parse hrefs; extract in order without duplicates; walk the review set cycle-safely with a depth cap; round-trip routes.
- Parsing: header, title and anchored blocks; fenced anchors and headings are literal; unanchored drafts split into renderable blocks; bold status line exposed; unanchored content goes to `b0`; BOM and CRLF tolerated; quoted header attributes parsed and malformed long ones scanned linearly.
- Changes: flag new and edited blocks only; list heading blocks; strip markdown; carry unique exact and similar ids without reusing retired ids and not across ambiguous duplicates.
- Grammar: the fence mask matches the journal rule; visible lines drop multi-line comments; an unterminated comment with repeated openers is stripped without rescanning; read load counts visible words only.
- Review merge: union by id; newer clock wins and `readRev` is the max; the tie-break is commutative and idempotent; stable serialisation and defensive parsing; derived state follows dispositions, with reopen overriding older ones.
- Validation: schema checks ignore unknown fields; negative offsets, invalid required fields, mismatched stamp or title, and over-limit document, index and review files are refused.

## Failure modes

Invalid data raises a `DocsDataError`; callers show it as a data problem, never as an empty document. An unterminated comment hides the rest of a file by design of the grammar, so the linear-time scan is a safety requirement. Known rendering gaps live with the app: soft-wrapped lines currently split blocks (#867), and the app does not refresh an open doc after a remote revision (#868).
