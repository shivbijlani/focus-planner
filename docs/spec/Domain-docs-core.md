# Domain: docs-core

`docs-core` is the pure, dependency-free library that defines what a native catch-up **Doc** *is*: how a doc body is read, how a comment finds its place in a doc that has since been rewritten, how two devices' comments merge, and which files are valid. The Docs app and the `fp-docs` publisher both import it, so the reader and the writer can never disagree about the format. The file layout and normative contract are in [Domain-docs](Domain-docs); the on-disk samples are in [Data-Formats](Data-Formats); the writer is [Domain-docs-publisher](Domain-docs-publisher).

## Responsibility

- Parse a doc body into a title, a header and a list of addressable blocks.
- Give every block a stable id that survives republishing, so a comment keeps pointing at the same passage.
- Re-anchor a comment onto a changed doc, and **never lose it**: a comment whose passage has vanished is kept and shown as outdated.
- Merge two devices' review files without a server, deterministically.
- Derive a document's state (awaiting review, review submitted, working) from files, never storing it.
- Decide whether a journal is long enough to deserve a catch-up doc.
- Refuse malformed or oversized files before any reader trusts them.

## Design decisions and rejected alternatives

| Decision | Rejected alternative | Why |
| --- | --- | --- |
| A doc body is written in the **same markdown subset as a journal**, and the two parsers share one fence-and-comment rule. | A second markup dialect for docs. | The rule that decides what is code and what is hidden markup is the one that silently drifts between two parsers. The grammar module is imported by the journal parser too, so they cannot diverge. |
| Comments anchor by **quote plus surrounding text**, scoped to a block, with a fallback search across the whole doc. | Anchoring by character offset or line number. | Offsets break on the first edit. Quote-and-context survives rewording of neighbouring text; the stored offset is only a tie-breaker. |
| An unanchorable comment becomes **outdated**, stays in the file and stays listed. | Dropping it or silently moving it to the nearest block. | Dropping loses the user's words. A wrong move misattributes them. |
| Block ids are **carried** from the previous revision by exact match first, then by high token similarity with mutual best-match, and a new id is never one that was used before. | Renumbering every publish; or reusing ids freed by deleted blocks. | A renumbered doc orphans every comment. A reused id would attach an old comment to unrelated new text. Ambiguous duplicates get fresh ids rather than a guess. |
| Review comments merge **by id, newest `clock` wins**, with a deterministic text tie-break. | Last-writer-wins on the whole file. | Two devices adding different comments offline must both survive. The tie-break makes the merge commutative and idempotent, so folder sync can apply it in any order. |
| Doc state is **derived**, never stored. | A stored status field. | A stored status can disagree with the review and response files that actually hold the facts. |
| Readers **validate and ignore unknown fields**, and refuse oversized files. | Trusting whatever is on disk. | The files are shared with agents and other devices; a corrupt or hostile file must fail loudly rather than render wrongly. |

## Behavioural requirements

Derived from the package's tests. Each statement is something a rebuild must satisfy.

**Parsing the body**

- A doc reads as a header, a title and anchored blocks; content before the first anchor becomes block `b0`, so a hand-edited doc still renders and can still be commented on.
- Anchors and headings inside fenced code are literal text, not structure.
- An unanchored draft is split into renderable blocks.
- The bold status line directly under the title is exposed as the doc's status sentence.
- A byte-order mark and CRLF line endings are tolerated.
- Header attributes may be quoted; a malformed, very long attribute scans in linear time.
- Hidden comments, including multi-line ones, are removed from the visible text; an unterminated comment with repeated open markers is stripped without rescanning.

**Change tracking and block ids**

- Only new and edited blocks are flagged as changed.
- The outline lists heading blocks; plain-text extraction strips markdown.
- Unique exact and similar blocks carry their old id; retired ids are never reused; an ambiguous duplicate does not inherit an id.

**Anchoring and links**

- An anchor captures the quote with prefix and suffix context; repeated quotes are disambiguated by context, then by stored offset, and an unresolved tie is outdated.
- Re-anchoring tries the same block, then anywhere in the doc, then gives up as outdated.
- A multi-block selection anchors to its start and end blocks.
- `doc:` links parse, are extracted in first-seen order without duplicates, and hash routes round-trip.
- The review set (a primary doc plus everything it links to) is walked breadth-first, cycle-safe, with a depth cap of three.

**Review merge and state**

- Two devices' comments union by id; the newer clock wins for the same comment and `readRev` takes the maximum.
- Equal clocks resolve by a fixed tie-break; the merge is commutative and idempotent.
- Serialization is stable; parsing is defensive.
- A comment resolves when the agent gives it a resolving disposition; reopening overrides older dispositions.
- Lifecycle state is derived from the files.

**Validation**

- The index schema is validated and unknown fields are ignored; review and response schemas likewise.
- A negative anchor offset is rejected; invalid required fields are refused in every JSON format.
- A document's stamp and title must match its index entry.
- Oversized documents, indexes and review files are refused.

**Read load**

- The catch-up threshold counts only visible journal words, so hidden comments and markers never push a journal over the line.

## Failure modes

| Failure | Behaviour |
| --- | --- |
| Malformed or schema-invalid JSON | A data error is raised naming the file; nothing is partially rendered. |
| File over its size limit | Refused with a size error rather than truncated. |
| Quote no longer present | Comment shown as outdated, retained. |
| Quote appears several times with equal context score | Treated as unresolved and outdated, not guessed. |
| Index cross-references disagree (task binding without a primary, link to a missing doc) | Whole index refused. |

> [!NOTE]
> **Technical detail: modules and public exports.** Optional reference for implementers; the sections above state the behaviour.

<details>
<summary><strong>Show modules, exports and limits</strong></summary>

| Module | Exports | Role |
| --- | --- | --- |
| `packages/docs-core/src/grammar.js` | `fencedLineMask`, `splitLines`, `trimBlankEnds`, `visibleLines`, `walkVisibleLines` | The shared journal grammar: fenced code literal, comments hidden. |
| `packages/docs-core/src/doc.js` | `parseDoc`, `parseDocHeader`, `parseDraftBlocks`, `assignBlockIds`, `changedBlockIds`, `blockPlainText`, `outline`, `statusLine` | Body parsing and block-id carry-over. |
| `packages/docs-core/src/anchor.js` | `makeAnchor`, `quoteSelector`, `findQuote`, `reanchor`, `isMultiBlock`, `CONTEXT_CHARS` | Quote anchoring; context window is 32 characters. |
| `packages/docs-core/src/links.js` | `parseDocHref`, `isDocHref`, `extractDocLinks`, `linkedFrom`, `reviewSet`, `docHref`, `parseRoute`, `DOC_ID_RE` | `doc:` links, review-set traversal, app hash routes. |
| `packages/docs-core/src/review.js` | `mergeReviews`, `submitDrafts`, `reopenComment`, `commentStatus`, `deriveDocState`, `parseReview`, `serializeReview`, `parseResponse`, `parseIndex`, `emptyReview`, `newCommentId`, `newReviewId`, `INTENTS`, `INTENT_META`, `RESOLVING_DISPOSITIONS`, `REVIEW_VERSION` | Review files, merge and derived state. Intents are approve, question, do-more, note; resolving dispositions are answered, done, declined. |
| `packages/docs-core/src/readLoad.js` | `journalReadLoad`, `DEFAULT_CATCHUP_THRESHOLD` | Visible-word count; default threshold 1500 words, minutes estimated at 250 words per minute. |
| `packages/docs-core/src/validate.js` | `validateDocText`, `validateIndexText`, `validateReviewText`, `validateResponseText`, `DocsDataError`, `DOCS_LIMITS`, `docsByteLength`, `docBodyByteLength` | Reader validation. Limits: body 256 KiB, index 1 MiB, review 1 MiB, review set 2 MiB. |
| `packages/docs-core/src/index.js` | `DOCS_DIR`, `DOCS_INDEX`, `docPath`, `historyPath`, `responsePath`, `reviewPath` | Storage paths of the on-disk layout. |

</details>

See [Technical Architecture](Technical-Architecture) for how the Docs pieces sit in the wider system, and [Behaviour](Behaviour) for the whole acceptance suite.
