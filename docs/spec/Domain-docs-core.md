# Domain: docs-core

`docs-core` is the shared, dependency-free library that defines what a native catch-up Doc *is*: how a document file is parsed into addressable blocks, how a comment stays attached to text as the document is revised, how review and response files merge and validate, and how the Docs lifecycle state is derived. Every reader and writer of Docs — the app, the publisher CLI and the remote agent tools — imports it, so no one reimplements the format. The on-disk contract (files, ownership, normative vectors) lives in [Domain-docs](Domain-docs) and [Data-Formats](Data-Formats); this page covers the library's responsibilities and rationale. The writer is [Domain-docs-publisher](Domain-docs-publisher).

## Responsibility

| Concern | Behaviour |
| --- | --- |
| Grammar | A Doc body is written in exactly the journal's markdown subset. Fenced code is literal text, and `<!-- … -->` comments (possibly multi-line) are hidden. The journal parser and the Docs parser share this one rule so they cannot drift. |
| Blocks | A doc is a header line, a title and a sequence of blocks. A block anchor comment of the form `<!-- @bN -->` starts a block; every visible line after it belongs to it until the next anchor. Content before the first anchor becomes block `b0`, so a hand-edited doc still renders and can be commented on. Anchors and headings inside code fences are literal. |
| Block ids across revisions | A revised draft carries ids forward: unique exact or similar blocks keep their id, ids are never reused once retired, and an ambiguous duplicate never inherits an id. |
| Change detection | Only new and edited blocks are flagged as changed since the previous revision. |
| Anchoring | A comment stores a quote with a little context and the block it was made in. When the doc is revised, the comment is re-found in a fixed order: same block and quote, then the quote anywhere in the doc, then *outdated*. An outdated comment is kept and listed, never discarded. A selection spanning blocks anchors to its start and end blocks. |
| Links | `doc:` links address a whole doc or a block within it. The review set — the docs reachable from a task's primary doc — is walked cycle-safely with a depth cap. |
| Review merge | `review.json` (user to agent) is app-owned but may be written from several devices, so comments union by id; the newer logical clock wins for the same comment, with a deterministic serialisation tie-break so the merge is commutative and idempotent. |
| Lifecycle | A comment is resolved when the agent responds with a disposition (`answered`, `done`, `needs-you`, `declined`); an explicit reopen overrides older dispositions. The doc state is derived from the files, never stored. |
| Read load | The catch-up threshold counts *visible* journal words — comments and markers stripped — with a default of 1500. The agent and the app both use this one measure so they never disagree about when a journal needs a Doc. |
| Validation | Readers validate before trusting. Unknown fields are ignored, required fields are enforced, negative anchor offsets are refused, a doc's stamp and title must match its index entry, and size limits are enforced: 256 KiB per document, 1 MiB for the index, 1 MiB per review file, 2 MiB for a review set. |

## Why these choices

- **Re-anchoring instead of storing a position.** Positions break on every revision; the rejected alternative would orphan comments each time the agent edits. The quote-then-fallback order plus a kept-and-listed *outdated* state means feedback is never silently lost.
- **Merge by id with last-write-wins, not file-level conflict.** Two devices may comment offline; whole-file conflict copies would hide comments. This is also why open issue #868 matters: remote revisions currently surface as sync-conflict copies and the open doc does not refresh.
- **Fail closed on invalid data.** A reader that tolerated corrupt files would let an agent act on a half-written review; validation errors are surfaced rather than treated as "empty".
- **One threshold measure.** Divergent word counts would make the app offer a Doc the agent never wrote, or the reverse.

> [!NOTE]
> **Technical detail: modules, exports and storage paths.** Optional reference.

<details>
<summary><strong>Show module table and path helpers</strong></summary>

| Path | Exports |
| --- | --- |
| `packages/docs-core/src/grammar.js` | `fencedLineMask`, `splitLines`, `trimBlankEnds`, `visibleLines`, `walkVisibleLines` |
| `packages/docs-core/src/doc.js` | `assignBlockIds`, `blockPlainText`, `changedBlockIds`, `outline`, `parseDoc`, `parseDocHeader`, `parseDraftBlocks`, `statusLine` |
| `packages/docs-core/src/anchor.js` | `CONTEXT_CHARS`, `findQuote`, `isMultiBlock`, `makeAnchor`, `quoteSelector`, `reanchor` |
| `packages/docs-core/src/links.js` | `DOC_ID_RE`, `docHref`, `extractDocLinks`, `isDocHref`, `linkedFrom`, `parseDocHref`, `parseRoute`, `reviewSet` |
| `packages/docs-core/src/review.js` | `INTENTS`, `INTENT_META`, `RESOLVING_DISPOSITIONS`, `REVIEW_VERSION`, `commentStatus`, `deriveDocState`, `emptyReview`, `mergeReviews`, `newCommentId`, `newReviewId`, `parseIndex`, `parseResponse`, `parseReview`, `reopenComment`, `serializeReview`, `submitDrafts` |
| `packages/docs-core/src/readLoad.js` | `DEFAULT_CATCHUP_THRESHOLD`, `journalReadLoad` |
| `packages/docs-core/src/validate.js` | `DOCS_LIMITS`, `DocsDataError`, `docBodyByteLength`, `docsByteLength`, `validateDocText`, `validateIndexText`, `validateResponseText`, `validateReviewText` |
| `packages/docs-core/src/index.js` | Re-exports all of the above plus `DOCS_DIR`, `DOCS_INDEX`, `docPath`, `historyPath`, `responsePath`, `reviewPath` |

```text
docs/index.json
docs/<doc-id>/doc.md
docs/<doc-id>/review.json
docs/<doc-id>/response.json
docs/<doc-id>/history/r0007.md      # revision zero-padded to four digits
```

A document opens with a header comment, then the title, then anchored blocks:

```text
<!-- docs v1 id=d-7kx2m4 rev=4 published=2026-09-30T21:40:00Z by=overnight-agent -->
# Task 123: Mortgage refinance options

<!-- @b1 -->
**Status: 2 options ready — tell me which one to lock.**
```

Header attributes may be quoted; malformed over-long attributes are scanned in linear time. Parsing tolerates a BOM and CRLF line endings. Comment intents are `approve`, `question`, `do-more` and `note`. An unterminated comment containing repeated open markers is stripped without rescanning, so hostile input cannot cause quadratic work. `doc:` links look like `[brief](doc:d-9a1c0q)` for a whole doc and `doc:d-9a1c0q#b9` for a block; hash routes round-trip.

</details>

## Behavioural requirements

From `anchor.test.js`, `doc.test.js`, `review.test.js` and `validate.test.js` in `packages/docs-core/src`.

- Anchors capture quote, prefix and suffix; repeated quotes are disambiguated by context or stored offset, and unresolved ties become outdated.
- Re-anchoring tries same block, then anywhere, then outdated; multi-block selections anchor to start and end blocks.
- Parsing reads header, title and anchored blocks; treats anchors and headings in fences as code; splits unanchored drafts into renderable blocks; puts unanchored content in `b0`; exposes the bold status line; tolerates BOM and CRLF.
- Only new and edited blocks are flagged changed; outlines list heading blocks; plain-text extraction strips markdown; ids carry across exact and similar blocks without reusing retired ids and never across ambiguous duplicates.
- Review merging unions two devices' comments by id, newer clock wins, equal clocks use the tie-break, and the merge is commutative and idempotent; serialisation is stable and parsing is defensive.
- A comment resolves when the agent dispositions it; reopening overrides older dispositions; lifecycle state derives from the files.
- Validation checks each JSON format's schema and ignores unknown fields, rejects negative offsets and invalid required fields, checks stamp and title against the index entry, and refuses documents, indexes and review files over their limits.
- Read load counts visible words only; `doc:` links parse, extract in order without duplicates, and the review-set walk is cycle-safe with a depth cap.

## Failure modes

An invalid or oversize file raises a `DocsDataError` from validation; callers must report it explicitly rather than fall back to empty. An unanchored hand edit degrades gracefully to block `b0`. A comment whose quote is gone is outdated, not deleted.
