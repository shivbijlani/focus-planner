# Domain: docs-core

`docs-core` is the shared, dependency-free reading library for native catch-up Docs. It defines what a Docs document *is* — how a `doc.md` splits into addressable blocks, how a comment finds its text again after the document is rewritten, how comments from two devices merge, which size and shape limits a reader enforces, and how a task's linked documents form a review set. The Docs app, the fp-docs publisher ([Domain-docs-publisher](Domain-docs-publisher)), the agent loop and the remote agent tools ([Domain-planner-tools](Domain-planner-tools)) all import it, so none can disagree about the format. The normative file formats, lifecycle and test vectors live in [Domain-docs](Domain-docs); this page states the library's responsibilities.

## Responsibilities

**One grammar for journals and Docs.** A `doc.md` body is written in exactly the journal's Markdown subset. Two rules decide what is markup and what is text: fenced code is literal, and `<!-- ... -->` comments (which may span lines) are hidden. The journal parser imports the fence rule from `docs-core` rather than keeping its own copy, so the two parsers cannot drift apart. Alternative rejected: a second, Docs-specific Markdown dialect — it would force every agent writing a journal and a doc to learn two languages and would let an unclosed comment hide different text in each.

**Parsing a document into blocks.** A document is a header comment (format version, document id, revision, publish time, author), a title line, and a sequence of **blocks**. Each block begins with an anchor comment `<!-- @bN -->` assigned by the publisher; every visible line after it belongs to that block until the next anchor. The parser guarantees:

- anchors and headings inside code fences are literal code, not structure;
- a hand-edited document with no anchors still renders — unanchored content becomes block `b0` — and can still be commented on;
- a byte-order mark and CRLF line endings are tolerated on read (the publisher refuses them on write);
- an unanchored draft splits into renderable blocks;
- the bold status sentence directly after the title is exposed as the document's status line;
- header attributes may be quoted, and malformed or very long attributes are scanned in linear time (a hostile document cannot stall a reader).

**Stable block ids.** On republish, each block keeps its id when its text is unchanged or when a single similar block carries it over. Where a duplicate makes the match ambiguous, the block gets a **new** id rather than a guessed one, and ids of retired blocks are never reused (new ids are allocated above every id ever used). Reason: comments and dispositions point at block ids, so reusing an id would silently attach an old comment to unrelated text. A change detector reports which blocks are new or edited so the app can mark them.

**Anchoring a comment to text.** A comment records a quotation (the selected text), a 32-character prefix and suffix for context, and the zero-based offset within its block; a multi-block selection also records the end block and the start and end quotes. When the document changes, re-anchoring tries, in order: the same block with the same quote; the quote anywhere in the document, using prefix and suffix to choose between repeats; and otherwise marks the comment **outdated**. A tie that cannot be resolved is outdated, not guessed. An outdated comment is kept and listed, never lost.

**Review state.** `review.json` is owned by the app but can be written by more than one device, so comments merge by id: union of comments, the higher logical clock wins for the same comment, an equal clock uses a deterministic tie-break, and the result is commutative and idempotent. Serialisation is stable (sorted keys). Parsing is defensive: a missing or damaged file reads as an empty review rather than throwing, and unknown fields are ignored. A comment is *resolved* when the agent gives it a resolving disposition (answered, done or declined), and a user reopen overrides older dispositions. The document's lifecycle state is derived from the three files (index entry, review, response), never stored.

**Reader validation.** The reader validates each JSON format (index, review, response) and the document header against its index entry, refuses invalid required fields (a negative anchor offset is rejected), and ignores unknown fields so a newer writer cannot break an older reader. Limits: a document body is at most 256 KiB, the index and a review file at most 1 MiB each, and a review set at most 2 MiB in total.

**Links and review sets.** `doc:` hrefs parse to a document id with optional block and comment targets and round-trip through the app's hash routes. Links are extracted in order without duplicates. The **review set** of a task is the primary document plus every document reachable through links, traversed cycle-safely with a depth cap of three, so unlinking a draft cannot hide its open comments.

**Read load.** A journal's "read load" counts visible words only (comments and fenced markup excluded) against a default catch-up threshold of 1,500 words; crossing the threshold is what makes a first catch-up doc eligible.

**Storage layout.** Documents live under `docs/`: an index at `docs/index.json`, and per document a `doc.md`, `review.json`, `response.json` and numbered history snapshots (`history/r0004.md` style, four-digit zero-padded revision).

> [!NOTE]
> **Technical detail: modules and exports.** Optional reference for rebuilders.

<details>
<summary><strong>Show principal modules and exports</strong></summary>

| Path | Exports | Role |
| --- | --- | --- |
| `packages/docs-core/src/doc.js` | `parseDoc`, `parseDocHeader`, `parseDraftBlocks`, `assignBlockIds`, `changedBlockIds`, `outline`, `blockPlainText`, `statusLine` | Document → header, title, blocks. |
| `packages/docs-core/src/anchor.js` | `quoteSelector`, `findQuote`, `makeAnchor`, `reanchor`, `isMultiBlock`, `CONTEXT_CHARS` | Text-quote anchoring. |
| `packages/docs-core/src/grammar.js` | `fencedLineMask`, `visibleLines`, `walkVisibleLines`, `splitLines`, `trimBlankEnds` | Shared journal grammar. |
| `packages/docs-core/src/index.js` | `DOCS_DIR`, `DOCS_INDEX`, `docPath`, `reviewPath`, `responsePath`, `historyPath` | Path helpers; the package root also re-exports the review, link, validation and read-load modules. |

```js
docPath(id)        // 'docs/<id>/doc.md'
reviewPath(id)     // 'docs/<id>/review.json'
responsePath(id)   // 'docs/<id>/response.json'
historyPath(id, 4) // 'docs/<id>/history/r0004.md'
```

```text
<!-- docs v1 id=d-7kx2m4 rev=4 published=2026-09-30T21:40:00Z by=overnight-agent -->
# Task 123: Mortgage refinance options

<!-- @b1 -->
**Status: 2 options ready — tell me which one to lock.**
```

</details>

## Tests as requirements

`packages/docs-core/src/doc.test.js`: header, title and anchored blocks parse; anchors and headings inside fences are literal; unanchored drafts split into renderable blocks; the bold status line is exposed; unanchored content lands in `b0`; BOM and CRLF are tolerated; quoted attributes parse and long malformed ones scan linearly; only new and edited blocks are flagged; ids carry across unique exact and similar blocks and never across ambiguous duplicates or into retired ids; the fence mask matches the journal rule; multi-line comments and unterminated comments with repeated open markers are stripped without rescanning; read load counts visible words only.

`packages/docs-core/src/anchor.test.js`: quote, prefix and suffix are captured; repeated quotes are disambiguated by context and stored offset, unresolved ties are outdated; re-anchoring goes same block, then anywhere, then outdated; multi-block selections anchor to start and end blocks; doc hrefs parse and round-trip; link extraction is ordered and de-duplicated; review-set traversal is cycle-safe with a depth cap.

`packages/docs-core/src/review.test.js`: comments union across devices; newer clock wins and the read revision takes the maximum; equal clocks use the specified tie-break, commutatively and idempotently; serialisation is stable and parsing defensive; an agent disposition resolves a comment and a reopen overrides older dispositions; lifecycle state derives from the files.

`packages/docs-core/src/validate.test.js`: index, review and response schemas validate and ignore unknown fields; a negative anchor offset is rejected; invalid required fields are refused in every JSON format; document stamp and title are checked against the index entry; an oversized body, index or review file is refused.

## Failure modes

| Failure | Required behaviour |
| --- | --- |
| Damaged or empty `review.json` | Read as an empty review; never throws into the UI. |
| Document stamp disagrees with its index entry | Reader validation fails; the document is not rendered as valid. |
| Oversized body, index, review or review set | Refused with a size error; never truncated. |
| Ambiguous re-anchor | Comment is outdated and still listed. |
| Link cycle among documents | Traversal terminates at the depth cap. |
