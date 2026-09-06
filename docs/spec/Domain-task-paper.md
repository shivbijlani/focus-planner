# Domain: task-paper

`task-paper` (`packages/task-paper/`) generates a readable, self-contained HTML "paper" from a task
journal — the structural fix for issue #285/#286's complaint that a chronological journal is the
wrong shape for understanding a complicated task's *current* state.

## Responsibility

Transform a journal's append-only chat log into a document whose body is the settled current state
(the newest agent turn) and whose appendix is everything that is, by construction, superseded
chain-of-thought (earlier agent turns, the timestamped run log). Regenerate deterministically —
byte-identical output for unchanged input — so "regenerate every run" is safe, and provide a comment
channel that writes back into the journal itself using the exact same writer the app uses, so a
comment can never be lost to the next regeneration.

## Principal modules

| Path | Purpose |
| --- | --- |
| `packages/task-paper/bin/task-paper.js` | CLI entry point; additive only — writes `<journal>/paper/task-<id>.html` and never touches the journal. |
| `packages/task-paper/src/paper.js` | Builds the "paper" model from journal markdown: `buildPaper`, `splitSections`, `AGENT_TURN_HEADING_RE`. |
| `packages/task-paper/src/render.js` | Renders the paper model into one self-contained HTML file: `renderPaper`, `slugify`. |
| `packages/task-paper/src/markdown.js` | A small, deterministic markdown→HTML renderer written specifically because the project has no markdown dependency and the generator must run with nothing installed. |
| `packages/task-paper/src/comment.js` | The comment channel: embeds `src/journalChat.js` verbatim as an inline `<script type="module">` so the page can append a comment using the exact shared writer, never a reimplementation. |
| `packages/task-paper/src/generate.js` | The filesystem layer — journal in, paper out — kept separate from the pure transform so the transform is unit-testable without touching disk. |

## Public exports

`PAPER_DIRNAME`, `generateAll`, `generatePaper`, `paperFilename` (`generate.js`);
`SHARED_WRITER_PATH`, `assertEmbedsSharedWriterVerbatim`, `buildCommentScript`,
`commentSectionHtml`, `journalFilename`, `readSharedWriter` (`comment.js`); `AGENT_TURN_HEADING_RE`,
`buildPaper`, `splitSections` (`paper.js`); `escapeHtml`, `isSafeUrl`, `renderInline`,
`renderMarkdown` (`markdown.js`); `renderPaper`, `slugify` (`render.js`).

## Behavioural requirements (from the task-paper test suite, 5 files / 87 tests)

- **The writer is embedded, never reimplemented.** The generated page's comment box reads the app's
  real `src/journalChat.js` source and embeds it byte-for-byte; a source that would break out of
  the `<script>` element is refused; the embed bakes in only that task's own journal filename; it
  is an inline module so no network fetch is needed from a `file://` origin (verified against real
  Edge behavior).
- **A comment produces the same bytes the app produces**, and lands **after the turn-end stamp**,
  which is precisely what makes it reopen the task on the next `oa-state.ps1 scan` — no new
  detection logic is required because a comment is ordinary post-stamp journal text.
- **Rendering is deterministic**: byte-identical output for identical input, no clock/nonce/random
  id anywhere in the generated controller — a "last updated" concept, if shown, must be derived
  from the journal's own newest dated entry, never a generation-time clock, or every regeneration
  would rewrite the file even when nothing changed.
- **The comment box is additive and honest about its limits**: omitted entirely for a paper with no
  task id (nothing to target); offers a copy-to-clipboard fallback and names the file to paste into
  when the browser cannot write files directly; refuses to write anything that is not a clean
  append; reads the file back after writing rather than trusting the write succeeded.
- **`buildPaper` structural transform**: takes the title from the journal's `H1`; the **newest**
  agent turn becomes the current state; an older, superseded turn never leaks into that current
  state and is moved to the appendix, alongside the Run log; consecutive same-day agent turns are
  split rather than stacked into one.
- **The markdown renderer is security-first**: raw HTML in prose is escaped, a `javascript:` URL is
  refused as a link target (text kept, hyperlink dropped), and fenced code keeps its content
  verbatim — including markup that would otherwise parse — because journals quote their own markup
  constantly and a naive renderer would interpret a quoted example as real structure.
- **`generateAll` sweeps predictably**: skips journals the agent never wrote to, honors a task-id
  filter, ignores non-journal files, reports (rather than aborting on) an unreadable journal, and
  processes journals in task-id order rather than filesystem/string order.

## Failure modes guarded against

Two failure classes recur across this domain's tests. First, **drift between readers**: `paper.js`'s
doc comment states plainly that copying `parseJournalChat`/`agentBlockStatus`/`extractAskEntry`
locally is exactly how the app writer and the consent gate drifted apart in the past (closed issue
#325) — so every reader here is imported, never re-implemented. Second, **regeneration destroying
user input**: because the whole feature exists to be safely regenerated on every run, anything a
user adds (a comment) must live somewhere regeneration cannot reach — the journal, not the paper —
which is the single design choice the rest of the comment channel falls out of.
