# Domain: docs-core

`docs-core` is the shared library for native catch-up Docs: the one implementation of how a Doc is **parsed**, how a comment is **anchored** to text, how reviews from several devices are **merged**, how a Doc's lifecycle state is **derived**, and how every Docs file is **validated** before anything trusts it. The Docs app, the publisher CLI, the planner tools and the overnight agent all import it, so none of them can disagree about what a Doc or a comment means. The file formats, ownership rules and lifecycle are the contract in [Domain-docs](Domain-docs); this page describes the library that implements them.

## Why a shared library

Two readers that parse the same file independently will eventually disagree about what is markup and what is text, and a Doc that renders one way for the user and another way for the agent defeats the point of a feedback loop. `docs-core` therefore owns the grammar (shared with the journal parser so the two cannot drift), the read-load measure (shared by the agent and the app so they never disagree about when a catch-up Doc is warranted), and the validators (so a corrupt file is refused the same way by every reader). The rejected alternative — each surface carrying its own parser — was rejected for exactly the drift it permits.

## Principal modules

> [!NOTE]
> **Technical detail: module map.** Paths and exports of the package.

<details>
<summary><strong>Show the package's modules and exports</strong></summary>

| Path | Role | Key exports |
| --- | --- | --- |
| `packages/docs-core/src/grammar.js` | The journal's markdown rules: fenced code is literal; `<!-- … -->` comments (possibly multi-line) are hidden. `src/journalChat.js` imports `fencedLineMask` from here. | `fencedLineMask`, `splitLines`, `trimBlankEnds`, `visibleLines`, `walkVisibleLines` |
| `packages/docs-core/src/doc.js` | `doc.md` → header, title and blocks; block-id carry-over; outline and status line. Imports `grammar.js`. | `parseDoc`, `parseDocHeader`, `parseDraftBlocks`, `assignBlockIds`, `changedBlockIds`, `outline`, `blockPlainText`, `statusLine` |
| `packages/docs-core/src/anchor.js` | W3C TextQuote anchoring scoped to a block. | `makeAnchor`, `findQuote`, `reanchor`, `quoteSelector`, `isMultiBlock`, `CONTEXT_CHARS` |
| `packages/docs-core/src/links.js` | `doc:` links, the review set, and the Docs app's hash routes. | `extractDocLinks`, `isDocHref`, `parseDocHref`, `docHref`, `parseRoute`, `reviewSet`, `linkedFrom`, `DOC_ID_RE` |
| `packages/docs-core/src/review.js` | `review.json` / `response.json` parsing, merge, serialisation and derived state. | `parseReview`, `serializeReview`, `mergeReviews`, `submitDrafts`, `reopenComment`, `commentStatus`, `deriveDocState`, `parseResponse`, `parseIndex`, `INTENTS`, `INTENT_META`, `RESOLVING_DISPOSITIONS`, `REVIEW_VERSION`, `emptyReview`, `newCommentId`, `newReviewId` |
| `packages/docs-core/src/readLoad.js` | The catch-up threshold measure. Imports `grammar.js`. | `journalReadLoad`, `DEFAULT_CATCHUP_THRESHOLD` |
| `packages/docs-core/src/validate.js` | Reader-side schema and size validation. Imports `doc.js`. | `validateIndexText`, `validateReviewText`, `validateResponseText`, `validateDocText`, `DOCS_LIMITS`, `DocsDataError`, `docBodyByteLength`, `docsByteLength` |
| `packages/docs-core/src/index.js` | Package root: re-exports every module above and defines the on-disk paths. | `DOCS_DIR`, `DOCS_INDEX`, `docPath`, `historyPath`, `responsePath`, `reviewPath` |

</details>

## Required behaviour

### Parsing a Doc

- A Doc is a header comment, a title and blocks. Each block starts at an anchor comment and owns every visible line until the next anchor. Content before the first anchor becomes block `b0`, so a hand-edited Doc still renders and can still be commented on.
- Anchors and headings inside fenced code are literal code, not structure. A byte-order mark and CRLF line endings are tolerated on read. Header attributes may be quoted, and a malformed long attribute is scanned in linear time, never pathologically.
- An unanchored draft is split into renderable blocks; a bold status line directly after the title is exposed separately; headings form an outline; plain text is derived by stripping markdown.
- **Block ids are carried across revisions.** A block whose text exactly matches, or is uniquely similar to, a block of the previous revision keeps its id; ambiguous duplicates do not inherit one; and an id that was retired is never reused. Only new and edited blocks are reported as changed.

### Anchoring a comment

A comment stores the quoted text, a little prefix and suffix context, and the block's zero-based offset. Re-anchoring tries, in order: the same block with the same quote; the quote anywhere in the Doc (the stored offset and the context disambiguate repeats, and an unresolvable tie is not guessed); otherwise the comment is **outdated**. An outdated comment is kept and listed, never lost. A selection spanning blocks anchors to its start and end blocks.

### Links and the review set

`doc:<id>` links address a whole Doc and `doc:<id>#<block>` a block in it; links are extracted in order without duplicates and hash routes round-trip. The **review set** of a primary Doc is itself plus every Doc reachable through the index `links`, breadth-first, cycle-safe, capped at three hops.

### Merging reviews and deriving state

- A review file can be written from several devices, so comments merge **by id**: the union of both sides, and for the same comment the higher `clock` wins; equal clocks resolve by a deterministic tie-break, so the merge is commutative and idempotent. `readRev` takes the maximum. Serialisation sorts keys so output is stable, and parsing is defensive: missing or malformed content yields an empty review rather than an exception.
- Comment intents are `approve`, `question`, `do-more` and `note`. Submitting drafts assigns a review id and moves them to `open`; reopening a resolved comment stamps the Doc revision at which it was reopened.
- A comment is **resolved** when the agent's disposition (`answered`, `done`, `declined`) is newer than any reopen; `needs-you` is a distinct blocking status; anything else sent is open; an unsent comment is a draft. Doc state is **derived from the files and never stored**: awaiting review, review submitted (an unacknowledged review exists), or working (the latest review is acknowledged at the current revision), plus unread, open and needs-you counts.

### Validation

Readers validate before trusting. The index, review and response files must satisfy their schemas and unknown fields are ignored (forward compatibility); a negative anchor offset, a missing required field, or a document whose stamp or title disagrees with its index entry is refused. Size limits: a Doc body 256 KiB, the index 1 MiB, a review file 1 MiB, and the whole review set 2 MiB. An oversized file is refused, never truncated. Violations raise `DocsDataError`.

### The read-load measure

The catch-up threshold counts **visible words** of a journal — comments and markers stripped — because that is what a reader must wade through. The default threshold is 1500 words, shared with the publisher so a first Doc is created at the same point everywhere.

## Failure modes

| Failure | Result |
| --- | --- |
| Corrupt or oversized JSON | Refused with a data error naming the file; never treated as empty. |
| Hand-edited Doc without anchors | Renders as block `b0`; comments still anchor. |
| Quote no longer in the Doc | Comment becomes outdated and stays visible. |
| Two devices disagree on a comment | Higher `clock` wins; equal clocks resolve deterministically. |

Pinned by `packages/docs-core/src/anchor.test.js`, `packages/docs-core/src/doc.test.js`, `packages/docs-core/src/review.test.js` and `packages/docs-core/src/validate.test.js`. See also [Domain-docs-publisher](Domain-docs-publisher) and [Data-Formats](Data-Formats).
