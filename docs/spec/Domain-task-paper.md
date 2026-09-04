# Domain: task-paper

## Responsibility

Turns a Focus Planner task journal into a **paper** — one readable, self-contained HTML page
per task — so a complicated task can be understood without reading its whole history. A
journal is a chronological log, and a log is the wrong shape for that question: the current
state is scattered across every turn that ever touched it, newest last, interleaved with
corrections. The transform is **structural, not editorial** — no model is involved and no
prose is rewritten. The newest agent turn becomes the body; every superseded turn and the
dated `Run log` move to an appendix; the open ask is lifted to the top.

The package also carries the **comment channel**: a paper can append an instruction back into
the task's own journal, as an ordinary attributed user message.

## Principal modules

| Module | Role |
| --- | --- |
| `packages/task-paper/src/render.js` | Renders a built paper into a complete standalone HTML document — status badge, ask block, collapsible `<details>` sections with stable anchors, and the appendix. No external CSS, fonts, scripts or network, because these are opened from a phone, often offline. |
| `packages/task-paper/src/paper.js` | The structural transform: splits a journal into the current turn, superseded turns, user messages and `Run log`, and promotes the `**Status:**` line and the open ask out of mid-prose into metadata. |
| `packages/task-paper/src/comment.js` | Builds the in-page comment controller and embeds the app's own journal writer **byte-for-byte**, so the paper writes the exact bytes the app and the Telegram bridge write. |
| `packages/task-paper/src/markdown.js` | A small, escaping-first markdown renderer: bold/italic/strikethrough, links, code spans, fenced blocks, nested lists, and heading shifting. |
| `packages/task-paper/src/generate.js` | The sweep: finds task journals, renders each paper into a `paper/` subfolder, and skips journals that have not changed. |
| `packages/task-paper/bin/task-paper.js` | The CLI: `generate --planner <dir>`, `--task <ids>`, or `--journal <file> --out <dir>`. |
| `packages/task-paper/src/index.js` | The package's public surface, re-exporting the render/build/generate entry points. |

## Public exports (selected)

`render.js`: `renderPaper`, `slugify`. `paper.js`: `buildPaper`, `splitSections`,
`AGENT_TURN_HEADING_RE`. `generate.js`: `generateAll`, `generatePaper`, `paperFilename`,
`PAPER_DIRNAME`. `markdown.js`: `renderMarkdown`, `renderInline`, `escapeHtml`, `isSafeUrl`.
`comment.js`: `buildCommentScript`, `commentSectionHtml`, `journalFilename`,
`readSharedWriter`, `assertEmbedsSharedWriterVerbatim`, `SHARED_WRITER_PATH`.

## Design decision: regenerated, not maintained

A hand-maintained summary has no mechanism to notice it has gone stale, and the prototype
demonstrated the failure on itself — its own quoted figures began decaying the day they were
written. A regenerated paper re-measures every run.

That is only safe because rendering is **deterministic**. There is no "generated at &lt;now&gt;"
stamp; "updated" is derived from the newest turn. An unchanged journal therefore produces
byte-identical HTML and is not rewritten, so a scheduled run does not churn every file in the
user's synced folder — which would destroy the one signal that matters, whether the task
actually moved.

## Design decision: a comment is stored in the journal, not somewhere new

The paper is a pure function of the journal, so a comment held anywhere else would be
clobbered by the next regeneration. Appending it to the journal instead makes three
requirements fall out of one choice rather than being built:

- **It survives regeneration**, because it is not in the file being regenerated.
- **Detection is free** — the agent already treats text after the turn-end stamp as the user
  speaking, so a comment reopens the task with no new detection path.
- **Consent already works**, because the bytes are a normal `<!-- from: me -->` message,
  byte-identical to what the app and the bridge write. There is no fourth shape to teach the
  fail-closed reader.

The writer is **embedded verbatim** rather than re-implemented: the app's dependency-free
journal-writer source is read from disk at generation time and inlined byte-for-byte, and a
test holds the embed identical to the source. Re-implementing it is precisely how two readers
drift into disagreeing about whether the user approved something.

## Behavioural requirements (from tests)

- **`buildPaper`**: must take the title from the H1, use the **newest** agent turn as current
  state without leaking a superseded one into it, move superseded turns and the dated
  `Run log` into the appendix, promote the `Status` line to metadata, surface the open ask,
  collect user messages newest-first, split consecutive same-day turns rather than stacking
  them, and leave no sentinel in the output.
- **Quoted markup must not be parsed as structure**: a marker or a date inside quoted content
  must not fabricate a message from the user or a new day, and a turn containing quoted markup
  must stay whole rather than splitting at it.
- **`renderPaper`**: must emit a complete standalone document needing no network, put the task
  id and title in the `title` element, show status as a badge, render each section of the
  current turn as a `<details>` with a stable anchor, open the first two and collapse the rest,
  place the ask **before** the sections and omit the block entirely when nothing is needed,
  keep superseded turns and the `Run log` in a collapsed appendix, show everything the user has
  said expanded, and state where to leave an instruction since the page is regenerated.
- **`renderMarkdown`**: must escape every character that can break out of text or an attribute,
  treat code spans and fenced blocks as literal (including markup that would otherwise parse),
  keep a `javascript:` URL as text rather than making it clickable, shift headings by
  `headingBase` while capping at `h6` rather than emitting an invalid tag, and nest an indented
  list inside its parent item.
- **`generateAll`**: must name each paper after its task and write into a `paper/` subfolder
  leaving the journal untouched, rewrite nothing when the journal has not changed, skip
  journals the agent has never written to, honour a task-id filter, ignore files that are not
  task journals, process journals in task-id order rather than string order, and report an
  unreadable journal without aborting the sweep.
- **Comment channel**: must embed the shared writer byte-for-byte, refuse a source that would
  break out of the script element, bake in only *this* task's journal filename, append after
  the turn-end stamp, produce byte-identical output for identical input with no clock or
  nonce, degrade to a read-only paper when no writer source is supplied, and omit the box for
  a paper with no task id since it could not target a file.

## Failure modes

- **Checking a paper with `innerText` reports a correct document as broken.** `innerText`
  omits content inside collapsed `<details>`, and collapse-by-default is the entire point of
  the format — so a naive text check reports most of a correct document as missing. Assert
  against the raw HTML source. This is the dangerous direction of error: the natural reaction
  is to "fix" a document that was already right.
- **A truncating write would destroy a journal.** The browser's `createWritable()` truncates
  and rewrites, so a bug producing a short string would replace a journal rather than fail.
  Anything that is not the original plus new text is refused before the handle is opened, and
  the file is re-read afterwards — an unverified write is reported, never claimed as saved.
- **A non-deterministic renderer would churn every file.** Any clock, nonce or random id in
  the output makes every unchanged task look modified on every run, which both floods the
  user's file sync and erases the "did this task move?" signal the folder otherwise carries.
