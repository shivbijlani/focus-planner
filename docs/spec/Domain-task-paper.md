# Domain: task-paper

## Responsibility

Generates a read-optimized "paper" — a single, self-contained HTML document — from each task's
chronological journal, and gives the user a comment channel back into that same journal. A journal is
a bottom-appended chat log, which is the wrong shape for understanding a complicated task once it has
many turns; the paper restructures it into "current state first, history in a collapsed appendix"
without any model call, so it is deterministic and safe to regenerate on every run (issue #286).

## Principal modules

| Path | Exports | Role |
| --- | --- | --- |
| `packages/task-paper/bin/task-paper.js` | (CLI) | Generates `<journal>/paper/task-<id>.html` for one or all journals. Additive only — it never reads, moves or modifies the journal itself. |
| `packages/task-paper/src/generate.js` | `generateAll`, `generatePaper`, `paperFilename`, `PAPER_DIRNAME` | Filesystem layer: journal in, paper out. Kept separate from `paper.js`/`render.js` so the transform itself stays pure and disk-free. |
| `packages/task-paper/src/paper.js` | `buildPaper`, `splitSections`, `AGENT_TURN_HEADING_RE` | Builds the paper *model* of a task from journal markdown: which turn is current, which are superseded, what belongs in the appendix. |
| `packages/task-paper/src/render.js` | `renderPaper`, `slugify` | Renders a paper model as one self-contained HTML document. |
| `packages/task-paper/src/markdown.js` | `renderMarkdown`, `renderInline`, `escapeHtml`, `isSafeUrl` | A small, deterministic Markdown→HTML renderer (see [Data-Formats](Data-Formats) for why no library is used). |
| `packages/task-paper/src/comment.js` | `buildCommentScript`, `commentSectionHtml`, `journalFilename`, `SHARED_WRITER_PATH`, `assertEmbedsSharedWriterVerbatim`, `readSharedWriter` | The comment channel: turns a note typed into the rendered paper into an ordinary, attributed journal message. |

## The transform (issue #286)

`buildPaper` is structural, not editorial: nothing is rewritten and no model is invoked. The **newest**
agent turn is the settled current state and becomes the paper's body; every **superseded** turn, and
the timestamped Run log of the current one, is by construction chain-of-thought and is moved to the
appendix. Because the transform is deterministic, regenerating an unchanged journal produces
byte-identical HTML — which is what makes "regenerate on every run" (rather than hand-maintain) safe.
Regeneration was chosen specifically because a hand-maintained summary has no mechanism to notice it
has gone stale; the design note in `paper.js` records that the prototype demonstrated this failure on
itself before the regenerate-every-run rule was adopted.

`buildPaper` reuses the shared journal readers rather than re-implementing them: `parseJournalChat`
(from the `app` domain's `src/journalChat.js`) decides who wrote what, and the digest/journal helpers
from `telegram-bridge` (`packages/telegram-bridge/src/digest.js`, `.../journal.js`) locate the status
word and the open ask. Copying any of those locally would be exactly how the reader and the writer of
one concept drift apart — the failure class documented across this repository (see
[Prioritisation](Prioritisation) §"agent-authored gate signals").

## `render.js` — self-contained and undated on purpose

The rendered document has no external CSS, fonts, scripts, or network calls, because these documents
live next to journals in OneDrive and are opened from a phone, often offline. It also has **no
"generated at" timestamp**: because regeneration happens on every run, a clock in the output would
make every document rewrite even when nothing changed, churning the sync folder and destroying the one
signal that matters — whether the task actually moved. "Last updated" is instead derived from the
journal's own newest dated heading.

## The comment channel (issue #286, second half)

A comment typed into a paper is **not stored anywhere new** — `comment.js` appends it to the task's
own journal, through the app's own writer, as an ordinary attributed user message. This single design
choice is why the feature needs no new storage, no new detection path, and cannot be lost on
regeneration: the paper is a pure function of the journal, so the comment (now inside the journal)
renders under "Your instructions" the next time the paper regenerates, and the consent/reopen readers
that already scan journal text see it for free.

## Data format produced

See [Data-Formats](Data-Formats) for a sample of the rendered paper's structure (title, status badge,
collapsible `<details>` sections, the ask surfaced above the fold).

## Behavioural requirements (selected, from the domain's test suites)

- `buildPaper` takes its title from the H1, uses the **newest** agent turn as current state, moves a
  superseded turn and the Run log to the appendix, and promotes the Status line to metadata rather
  than leaving it mid-prose.
- `generatePaper` writes into a `paper/` subfolder, leaves the journal untouched, rewrites nothing when
  the journal has not changed, and links to the Telegram topic only when the journal carries a
  `tg-meta` stamp.
- `renderMarkdown`/`renderInline`: escapes every character that could break out of text or an
  attribute, treats code spans as literal (quoted markup is not interpreted), and refuses to make a
  `javascript:` URL clickable while keeping its text.
- `renderPaper` produces a complete, standalone HTML document needing no network; shows status as a
  badge; renders the current turn's sections as `<details>`, opening the first two and collapsing the
  rest; gives each section a stable anchor a comment can cite; and surfaces the open ask above the
  fold, before the sections.
- `comment.js`'s embedded writer script is read verbatim from the app's own source, refuses a source
  that would break out of its `<script>` element, and bakes in only the current task's journal
  filename — so the comment produces the exact bytes the app's own writer would.

## Failure modes

- Validating a rendered paper against `.innerText` rather than the raw HTML source is a documented
  false-negative trap: collapsed `<details>` content is invisible to `.innerText`, and collapse-by-
  default is the entire point of the format — a naive text check would report a correct document as
  broken (`render.js`'s own doc comment records two false negatives from this before it was fixed).
- If the shared writer script embedded in a paper's comment box ever drifts from the app's real
  writer, a comment typed in the paper would produce bytes the app's own journal-write guards would
  reject; `assertEmbedsSharedWriterVerbatim` and `readSharedWriter` exist to make that drift
  detectable rather than silent.
