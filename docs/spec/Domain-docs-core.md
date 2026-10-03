# Domain: docs-core

`docs-core` is the shared parsing, anchoring and merge logic behind **Docs** — a second small
app, installable on its own, that gives a long-running task a readable "catch-up" document instead
of forcing anyone (human or agent) to re-read its whole journal. The package itself has no UI and no
storage of its own: it turns bytes from three files (`doc.md`, `review.json`, `response.json`) into
structured state, and turns structured state back into bytes. Everything that actually reads or
writes those bytes — the Docs reader app (`src/docs-app`) today, and a sanctioned agent-side
publisher in the future — imports this package rather than re-implementing any of it.

The feature is still mid-build. The parsing/anchoring/merge core and a read-and-comment app exist
and are unit-tested; the agent-side publisher (`fp-docs`) and the overnight agent's turn integration
described in `plans/docs-app-design.md` are not implemented yet. This page describes what exists now;
[Data-Formats](Data-Formats) carries the full target file-format contract.

## Why a long journal gets a doc at all

A task journal is an append-only chat log: good for "what happened," bad for "what's true right
now" once it runs long. Rather than build a bespoke summarizer, the design reuses a working
pattern — Google Docs comments were already how the user and the agent collaborated on a long task
— and reimplements it on local files instead of the Google Workspace API, which removes a whole
class of defects that API introduced (no author attribution, UTF-8 corruption on write, comments
misread as empty, transient reads indistinguishable from empty). The one new idea is **anchoring**:
a comment binds to a span of text, not to the whole document, so approving part of a plan is
possible and unambiguous.

## Responsibility

- **Parse** a doc's markdown body into typed blocks with stable ids (`doc.js`), using the exact same
  comment-hiding and fenced-code rules the journal already uses (`grammar.js`), so one grammar
  implementation serves both surfaces and cannot drift between them.
- **Anchor** a user's text selection to a block, and **re-anchor** that selection after the doc is
  rewritten, using the W3C TextQuote pattern — quote plus surrounding prefix/suffix context
  (`anchor.js`).
- **Merge** `review.json` — the user's comments — across devices that wrote it independently, by
  reusing the record-merge rules `folder-sync` already applies to `planner.md`, rather than inventing
  a second merge algorithm (`review.js`).
- **Link** docs together (`doc:<id>` references) and compute the *review set* — a primary doc plus
  everything it reaches — so the agent knows the full scope of what a review submission wakes
  (`links.js`).
- **Measure** when a journal has become long enough to deserve a doc at all, from one shared
  threshold function both the app and the (future) agent call, so they can never disagree about
  whether a task has crossed it (`readLoad.js`).

## Principal modules and exports

> [!NOTE]
> Exact exports from `spec-facts.json`, for a rebuilder wiring up imports.

<details>
<summary><strong>Show technical detail: module table</strong></summary>

| Path | Exports | Role |
| --- | --- | --- |
| `packages/docs-core/src/review.js` | `INTENTS`, `INTENT_META`, `RESOLVING_DISPOSITIONS`, `REVIEW_VERSION`, `commentStatus`, `deriveDocState`, `emptyReview`, `mergeReviews`, `newCommentId`, `newReviewId`, `parseIndex`, `parseResponse`, `parseReview`, `reopenComment`, `serializeReview`, `submitDrafts` | `review.json`/`response.json` parsing, merge-by-id, and the derived per-doc lifecycle state. |
| `packages/docs-core/src/doc.js` | `blockPlainText`, `changedBlockIds`, `outline`, `parseDoc`, `parseDocHeader`, `statusLine` | `doc.md` → `{ header, title, blocks }`; block-kind detection; diffing between revisions. |
| `packages/docs-core/src/anchor.js` | `CONTEXT_CHARS`, `findQuote`, `isMultiBlock`, `makeAnchor`, `quoteSelector`, `reanchor` | W3C TextQuote construction, scoring and re-anchoring, including multi-block selections. |
| `packages/docs-core/src/grammar.js` | `fencedLineMask`, `splitLines`, `trimBlankEnds`, `visibleLines`, `walkVisibleLines` | The shared comment-hiding/fence-masking rules also used by the journal renderer. |
| `packages/docs-core/src/links.js` | `DOC_ID_RE`, `docHref`, `extractDocLinks`, `isDocHref`, `linkedFrom`, `parseDocHref`, `parseRoute`, `reviewSet` | `doc:` link parsing, the Docs app's hash router, and review-set traversal. |
| `packages/docs-core/src/readLoad.js` | `DEFAULT_CATCHUP_THRESHOLD`, `journalReadLoad` | The catch-up threshold measure (visible words), shared by every reader. |
| `packages/docs-core/src/index.js` | `DOCS_DIR`, `DOCS_INDEX`, `docPath`, `historyPath`, `responsePath`, `reviewPath` | Barrel re-export of the five modules above, plus the on-disk path helpers. |

</details>

`review.js` imports `mergeCollections` from `packages/folder-sync/src/merge.js` directly — the
package depends on [Domain-folder-sync](Domain-folder-sync) rather than duplicating its per-record,
clock-ordered merge rule for a second file format.

## Behavioural requirements (from `testFiles`)

> [!NOTE]
> Each row is one test in `packages/docs-core/src/*.test.js`. Together they are the contract a
> reimplementation of this package must satisfy.

<details>
<summary><strong>Show technical detail: test-derived requirements</strong></summary>

| Area | Test | Requirement |
| --- | --- | --- |
| Anchoring | `captures quote, prefix and suffix` | `quoteSelector` must return the selected text plus up to `CONTEXT_CHARS` of surrounding text on each side. |
| Anchoring | `disambiguates repeated quotes with context` | When a quote occurs more than once in a block, `findQuote` must pick the occurrence whose prefix/suffix best match, not the first occurrence. |
| Anchoring | `re-anchors: same block, then anywhere, then outdated` | `reanchor` must try the original block first, then every other block, then report `outdated` — never silently drop a comment. |
| Anchoring | `anchors multi-block selections to start and end blocks` | A selection spanning two blocks must anchor on `{ block, endBlock }` independently, each re-anchored with its own quote. |
| Links | `parses doc hrefs` | `parseDocHref` must accept `doc:<id>` and `doc:<id>#<blockId>` and reject everything else. |
| Links | `extracts links in order without duplicates` | `extractDocLinks` must return each linked doc id once, in first-seen order. |
| Links | `walks the review set cycle-safely with a depth cap` | `reviewSet` must not loop forever on a link cycle and must stop expanding past its depth parameter. |
| Links | `round-trips hash routes` | `parseRoute` must invert `docHref` for both the library and single-doc routes, including `block`/`comment` query params. |
| Parsing | `reads the header, title and anchored blocks` | `parseDoc` must recover the `<!-- docs v1 ... -->` header fields, the `# Title` line, and each `<!-- @bN -->`-delimited block. |
| Parsing | `treats anchors and headings inside fences as literal code` | A `<!-- @bN -->` comment or `#` heading written inside a fenced code block must not be parsed as a real anchor or heading. |
| Parsing | `exposes the bold status line` | `statusLine` must recover the doc's `**Status: …**` first line per the catch-up contract. |
| Parsing | `puts unanchored content in b0 so hand-edited docs still render` | Content before the first anchor (other than header/title) must still produce a renderable, commentable block. |
| Parsing | `tolerates BOM and CRLF` | `parseDoc` must strip a leading BOM and normalize `\r\n` without corrupting block boundaries. |
| Diffing | `flags new and edited blocks only` | `changedBlockIds` must report exactly the blocks whose text changed or that are new between two parses, never unrelated ones. |
| Diffing | `lists heading blocks` | `outline` must return only heading-kind blocks, each with its id, text and level. |
| Diffing | `strips markdown for plain text` | `blockPlainText` must remove markdown syntax (emphasis, links, list/heading markers, table pipes) while preserving the visible words. |
| Grammar | `fence mask matches the journal rule` | `fencedLineMask` must agree with the journal parser's fence-masking behaviour (the two must not drift). |
| Grammar | `visible lines drop comments including multi-line comments` | `visibleLines` must hide every `<!-- ... -->` span, including ones spanning multiple lines, while keeping fenced content verbatim. |
| Threshold | `counts visible words only` | `journalReadLoad` must count words from `visibleLines` output, not raw file content, so hidden markers never inflate the catch-up measure. |
| Merge | `unions comments from two devices by id` | `mergeReviews` must include every comment id present in either input snapshot. |
| Merge | `newer clock wins for the same comment, and readRev takes the max` | On the same comment id, the higher `clock` value wins; `readRev` in the merged result is the max of the two inputs. |
| Merge | `serializes stably and parses defensively` | `serializeReview`/`parseReview` must round-trip, with comment/review keys written in sorted order for stable diffs, and must tolerate malformed or empty JSON without throwing. |
| Lifecycle | `resolves a comment when the agent dispositions it, and reopen overrides older dispositions` | `commentStatus` must report `resolved` once a disposition at or after the comment's last reopen covers it; `reopenComment` must make a comment `open`/`needs-you` again regardless of an earlier disposition. |
| Lifecycle | `derives the lifecycle state from the files` | `deriveDocState` must compute `state` (`awaiting-review` / `review-submitted` / `working`), `unread`, `openCount` and `needsYou` purely from `entry`/`review`/`response`, never from any value stored a second time. |

</details>

## Data model this package operates on

The on-disk shape — `docs/index.json`, `docs/<id>/doc.md`, `docs/<id>/review.json`,
`docs/<id>/response.json`, `docs/<id>/history/r<rev>.md` — and its invariants are documented in
[Data-Formats](Data-Formats); `docs-core/src/index.js` is the single place that names those five
path shapes (`DOCS_INDEX`, `docPath`, `reviewPath`, `responsePath`, `historyPath`), so a path
literal never needs to be duplicated at a call site.

## Failure modes

- **Grammar drift.** If `grammar.js`'s fence/comment rules ever diverge from the journal's own copy
  in `src/journalChat.js`, a block anchor computed from one parser would not line up with text
  rendered by the other. The `fence mask matches the journal rule` test exists specifically to catch
  this before it reaches users.
- **Lost comments on rewrite.** If `reanchor`'s three-step fallback (same block → anywhere → outdated)
  were skipped or reordered, a comment on content the agent moved (rather than deleted) would be
  silently dropped instead of surfaced as outdated — this is the one case the design explicitly
  refuses to let happen.
- **Divergent merge semantics.** Because `review.js` calls into `folder-sync`'s `mergeCollections`
  rather than its own merge code, a change to clock-ordering semantics there applies to comments too;
  a change made only on one side would make the two formats merge inconsistently without any test
  failing locally in the other package.
- **Incomplete feature surface.** This package has no code path for *writing* `doc.md` or
  `response.json` — that is the unbuilt `fp-docs` publisher. A rebuilder should not infer a
  publishing contract from this domain; it exists only as the plan in `plans/docs-app-design.md`.
