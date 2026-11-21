# Domain: docs-core

`docs-core` is the shared, dependency-free library that **defines what a native catch-up Doc is**: how its Markdown is read, how comments attach to text and survive edits, how two devices' comments merge, and how malformed data is refused. The web app, the publisher and the agent tools all import it, so they cannot disagree about the format. The full on-disk contract (files, ownership, lifecycle) is in [Domain-docs](Domain-docs); this page records the library's own responsibilities.

## Responsibility and rationale

- **One grammar, shared with journals.** A Doc body is written in exactly the journal's Markdown subset, and the two rules that decide markup from text — fenced code is literal, and HTML comments (which may span lines) are hidden — live in one module that the journal parser also imports. The rejected alternative, a Doc parser with its own rules, lets a journal and a Doc render the same text differently.
- **Stable block ids.** The publisher stamps each block with an anchor comment; every visible line after an anchor belongs to that block. Content before the first anchor becomes block `b0`, so a hand-edited Doc still renders and can still be commented on rather than being rejected.
- **Quote-based anchoring.** A comment records the quoted text, its offset within a block, and optional prefix/suffix context; multi-block selections also record start and end blocks. When a Doc changes, a comment re-anchors in order: same block and quote, then the quote anywhere in the Doc, then **outdated** — kept and listed, never lost. The rejected alternative (positional offsets alone) breaks on every edit.
- **Merge, not overwrite.** `review.json` is app-owned but may be written from more than one device, so comments merge by id; the newer logical clock wins for a given comment, equal clocks fall to a deterministic tie-break, and the merge is commutative and idempotent.
- **Validate on read, refuse loudly.** Readers validate index, review and response data and ignore unknown fields; invalid required fields, negative offsets, or oversize files are refused rather than partially read. A refusal is a data error, never "empty".
- **A shared catch-up threshold.** The visible-word count of a journal (comments and markers stripped) decides when a Doc starts; the agent and the app use the same function so they never disagree.

## Behavioural requirements

Derived from `packages/docs-core/src/*.test.js`.

- **Parsing:** reads header, title and anchored blocks; anchors and headings inside fences are literal code; unanchored drafts split into renderable blocks; the bold status line is exposed; unanchored content lands in `b0`; BOM and CRLF are tolerated; quoted header attributes parse and malformed long attributes are scanned in linear time; an unterminated comment with repeated open markers is stripped without rescanning.
- **Change tracking:** only new and edited blocks are flagged; headings form the outline; block ids carry across a rewrite when exactly one exact or similar block matches, never across ambiguous duplicates, and retired ids are not reused.
- **Journal load:** counts visible words only.
- **Anchoring:** captures quote, prefix and suffix; repeated quotes are disambiguated by context or stored offset, and unresolved ties become outdated; re-anchoring runs same block → anywhere → outdated; multi-block selections anchor to start and end blocks.
- **Links:** `doc:` hrefs parse; links extract in order without duplicates; the review set is walked cycle-safely with a depth cap; hash routes round-trip.
- **Review merge:** comments from two devices union by id; the newer clock wins and the revision takes the max; equal clocks use the specified tie-break; serialisation is stable and parsing defensive.
- **Derived state:** a comment resolves when the agent dispositions it, and a reopen overrides older dispositions; the Doc's lifecycle state is derived from the files, not stored.
- **Validation:** the index schema validates and unknown fields are ignored; review and response validate the same way; a negative anchor offset is rejected; invalid required fields are refused in each JSON format; a Doc's stamp and title must match its index entry; a Doc over the body limit, an index over the index limit, and a review over the review limit are each refused.

## Principal modules

> [!NOTE]
> **Technical detail: module and export table.** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show modules and exports</strong></summary>

| Path | Exports | Role |
| --- | --- | --- |
| `packages/docs-core/src/grammar.js` | `fencedLineMask`, `splitLines`, `trimBlankEnds`, `visibleLines`, `walkVisibleLines` | Shared fence/comment rules. |
| `packages/docs-core/src/doc.js` | `assignBlockIds`, `blockPlainText`, `changedBlockIds`, `outline`, `parseDoc`, `parseDocHeader`, `parseDraftBlocks`, `statusLine` | `doc.md` → header, title, blocks. |
| `packages/docs-core/src/anchor.js` | `CONTEXT_CHARS`, `findQuote`, `isMultiBlock`, `makeAnchor`, `quoteSelector`, `reanchor` | TextQuote anchoring. |
| `packages/docs-core/src/links.js` | `DOC_ID_RE`, `docHref`, `extractDocLinks`, `isDocHref`, `linkedFrom`, `parseDocHref`, `parseRoute`, `reviewSet` | `doc:` links and the review set. |
| `packages/docs-core/src/review.js` | `INTENTS`, `INTENT_META`, `RESOLVING_DISPOSITIONS`, `REVIEW_VERSION`, `commentStatus`, `deriveDocState`, `emptyReview`, `mergeReviews`, `newCommentId`, `newReviewId`, `parseIndex`, `parseResponse`, `parseReview`, `reopenComment`, `serializeReview`, `submitDrafts` | Comments, merge, lifecycle. |
| `packages/docs-core/src/readLoad.js` | `DEFAULT_CATCHUP_THRESHOLD`, `journalReadLoad` | Catch-up threshold measure. |
| `packages/docs-core/src/validate.js` | `DOCS_LIMITS`, `DocsDataError`, `docBodyByteLength`, `docsByteLength`, `validateDocText`, `validateIndexText`, `validateResponseText`, `validateReviewText` | Reader validation; limits are 256 KiB per Doc body, 1 MiB for the index, 1 MiB per review file, 2 MiB across a review set. |
| `packages/docs-core/src/index.js` | `DOCS_DIR`, `DOCS_INDEX`, `docPath`, `historyPath`, `responsePath`, `reviewPath` | Storage path conventions: `docs/index.json`, `docs/<id>/doc.md`, `review.json`, `response.json`, `history/rNNNN.md`. |

Id shapes enforced by validation: Doc `d-` plus six or more lowercase alphanumerics; block `b` plus a positive integer; comment `c_…`; review `rv_…`. Comment intents are approve, question, do-more and note; dispositions are answered, done, needs-you and declined.

</details>

## Failure modes

A reader that treats a refused file as empty hides a corrupt review from the agent; `docs-core` therefore raises a data error and callers must surface it. Two parsers with different fence rules would shift block boundaries and orphan comments. An unbounded review set could exhaust memory, which is why the limits exist and why traversal has a depth cap.
