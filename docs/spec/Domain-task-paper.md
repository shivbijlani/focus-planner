# Domain: task-paper

`task-paper` generates a self-contained HTML "paper" for each task journal. It is not another source of truth. The journal remains authoritative; the paper is a deterministic projection optimized for reading on a phone or printing. The package also embeds a comment channel that appends directly back into the journal so regeneration cannot overwrite user feedback. See [Architecture](Architecture), [Domain-telegram-bridge](Domain-telegram-bridge), and [Data-Formats](Data-Formats).

## Responsibility

The package's leading comments explain the core design choice: a journal is chronological, but the rebuilder needs current state first. `packages/task-paper/src/paper.js` therefore does a structural transform, not a summarisation pass. The newest agent turn becomes the current body, superseded turns and run-log sections move to the appendix, and user messages are collected separately as instructions. `packages/task-paper/src/render.js` then renders that model as a single HTML file with no external CSS, fonts, or scripts, because papers live beside journals in synced storage and must open correctly from `file://`.

> [!NOTE]
> **Technical detail: concrete example** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

```js
export function generatePaper(journalPath, { outDir = null, fsImpl = fs, writerSource = undefined } = {}) {
  const paper = buildPaper(content, { taskId })
  const html = renderPaper(paper, {
    journalHref: path.posix.join('..', filename),
    telegramHref: telegramHrefFrom(content),
    writerSource: writerSource === undefined ? readSharedWriter() : writerSource,
  })
  ...
}
```


</details>
## Modules and exports

> [!NOTE]
> **Technical detail: concrete reference.** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

| Path | Exports from `spec-facts.json` | Role |
| --- | --- | --- |
| `packages/task-paper/bin/task-paper.js` | — | CLI: generate one paper or sweep a planner's `journal/` folder. |
| `packages/task-paper/src/comment.js` | `SHARED_WRITER_PATH`, `assertEmbedsSharedWriterVerbatim`, `buildCommentScript`, `commentSectionHtml`, `journalFilename`, `readSharedWriter` | Comment-channel embed around the shared app writer. |
| `packages/task-paper/src/generate.js` | `PAPER_DIRNAME`, `generateAll`, `generatePaper`, `paperFilename` | Filesystem boundary: journal in, HTML out. |
| `packages/task-paper/src/index.js` | `AGENT_TURN_HEADING_RE`, `buildPaper`, `escapeHtml`, `generateAll`, `generatePaper`, `isSafeUrl`, `paperFilename`, `renderInline`, `renderMarkdown`, `renderPaper`, `slugify`, `splitSections` | Public package surface. |
| `packages/task-paper/src/markdown.js` | `escapeHtml`, `isSafeUrl`, `renderInline`, `renderMarkdown` | Small deterministic markdown renderer. |
| `packages/task-paper/src/paper.js` | `AGENT_TURN_HEADING_RE`, `buildPaper`, `splitSections` | Journal-to-paper model transform. |
| `packages/task-paper/src/render.js` | `renderPaper`, `slugify` | HTML renderer for the paper model. |

</details>

## Principal mechanics

`packages/task-paper/src/paper.js` deliberately imports shared readers instead of copying them: `parseJournalChat` from `src/journalChat.js`, `agentBlockStatus` and `parseTitle` from `packages/telegram-bridge/src/journal.js`, and `extractAskEntry` from `packages/telegram-bridge/src/digest.js`. The comment explains why: readers that drift apart have already caused approval and parsing bugs elsewhere in the repo. Agent turns are further split on `## 🌙 Overnight Agent` headers because `parseJournalChat()` groups by author and day, which is not the same thing as a semantic turn.

`packages/task-paper/src/markdown.js` accepts only the subset the journals actually use: escaped HTML, safe links, code spans, fenced blocks, headings, lists, tables, blockquotes, and paragraphs. Unsupported constructs fall through as escaped text. `packages/task-paper/src/render.js` keeps the ask above the fold, opens the first two sections, collapses the appendix, and links back to the journal and Telegram when available.

The comment channel in `packages/task-paper/src/comment.js` is the most consequential design choice. It reads `src/journalChat.js` verbatim and embeds it as an inline module. The generated page does not invent a new comment format or a second parser; it appends an ordinary `<!-- from: me -->` journal message. The controller refuses any write that is not a clean append and reads the file back after writing.

## Behavioural requirements from tests

The behavioural spec comes from `packages/task-paper/src/comment.test.js`, `generate.test.js`, `markdown.test.js`, `paper.test.js`, and `render.test.js`.

- `buildPaper` takes the title from the task H1, promotes the newest agent turn to current state, moves superseded turns and Run log content into the appendix, promotes `Status:` to metadata, surfaces the open ask, and returns a usable model even when there is no agent turn yet.
- Fence-masked parsing is mandatory. Quoted `##` headings and quoted agent markers inside code examples must not fabricate sections, dates, or extra turns.
- `renderPaper` emits a complete standalone HTML document, uses no network resources, shows the status badge and ask near the top, gives sections stable anchors, collapses appendix history by default, escapes raw HTML from the journal, and remains byte-identical for identical input.
- `renderMarkdown` escapes HTML first, refuses unsafe schemes such as `javascript:` as live links, preserves fenced code verbatim, and renders tables, nested lists, blockquotes, and shifted headings deterministically.
- `generatePaper` writes to a `paper/` subfolder rather than beside the journal, skips rewriting unchanged HTML, adds a Telegram topic link when a `tg-meta` stamp exists, and leaves the journal untouched.
- `generateAll` skips journals the agent never wrote to unless told otherwise, honours task-id filters, processes journals in numeric task order, ignores non-journal files, and reports unreadable journals without aborting the sweep.
- The comment feature is additive: when no writer source or no task id is available, the page stays readable and honest rather than pretending edits will work.

## Failure modes

The domain is built around two failure modes. The first is reader drift: if the paper had its own parser for authorship, title, status, or ask extraction, it would silently disagree with the app or Telegram bridge. The second is regeneration loss: a note typed into the paper would disappear on the next render if it lived in the HTML file itself. The chosen design avoids both by importing shared readers and by appending comments to the journal, not to the generated page.
