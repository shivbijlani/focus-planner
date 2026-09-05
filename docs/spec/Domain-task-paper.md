# Domain: task-paper

## Responsibility

`packages/task-paper` turns a chronological journal into a "paper" — one self-contained,
deterministic HTML document that reads like a settled status report instead of a log (issue #286).
It is purely additive: it only ever writes `<journal>/paper/task-<id>.html`, never reads or modifies
the journal it renders from, so deleting the `paper/` folder fully reverts the feature.

## Principal modules

| Module | Role |
| --- | --- |
| `packages/task-paper/src/paper.js` | Builds the paper model: newest agent turn is the settled current state; every superseded turn and the timestamped run log go to the appendix. |
| `packages/task-paper/src/render.js` | Renders the model as a self-contained HTML document — no external CSS/fonts/scripts/network, no generation timestamp. |
| `packages/task-paper/src/markdown.js` | A small deterministic markdown→HTML renderer scoped to exactly what journals contain; escapes first, renders second. |
| `packages/task-paper/src/comment.js` | Embeds the app's own `journalChat.js` writer verbatim (byte-identical, inline `<script type="module">`) so a note typed into a paper is appended to the journal as an ordinary attributed message. |
| `packages/task-paper/src/generate.js` | Filesystem layer: journal in, paper out; skips journals with no agent turn; processes in task-id order. |
| `packages/task-paper/bin/task-paper.js` | CLI entry point. |

## Public surface (representative exports)

`buildPaper, splitSections, AGENT_TURN_HEADING_RE` (`paper.js`); `renderPaper, slugify` (`render.js`);
`escapeHtml, isSafeUrl, renderInline, renderMarkdown` (`markdown.js`); `SHARED_WRITER_PATH,
assertEmbedsSharedWriterVerbatim, buildCommentScript, commentSectionHtml, readSharedWriter`
(`comment.js`); `generateAll, generatePaper, paperFilename, PAPER_DIRNAME` (`generate.js`).

## Behavioural requirements (from tests)

- **Comments are a fifth writer taught to the shared reader, never a bespoke parser**: the embedded
  script is byte-identical to `src/journalChat.js`, refuses source that would break out of the
  `<script>` element, and bakes in only the one task's own journal filename.
- **A comment lands after the turn-end stamp**, which is exactly what makes `oa-state.ps1`'s existing
  `reopened` detection pick it up — no second detection mechanism is built.
- **Rendering is fully deterministic**: byte-identical output for identical input, no clock/nonce/random
  id anywhere in the generated controller or the page.
- **The newest agent turn is the body; every superseded turn and the run log move to the appendix** —
  and a quoted turn heading or marker inside a fenced example must never fabricate a second turn or a
  new day (issues #320/#325).
- **The document degrades rather than lying**: it offers a copy fallback and names the target file when
  the browser cannot write, disables saving accordingly, and always reads a write back rather than
  trusting it blind.
- **The ask is above the fold**, sections render as `<details>` with the first two open and the rest
  collapsed, and each section carries a stable anchor so a comment can cite it.
- **The rendered page carries no generation timestamp**; "last updated" is derived from the journal's
  own newest dated entry.

## Failure modes this domain guards against

- **A hand-maintained "paper" going stale** — the design settled on regenerate-every-run specifically
  because a hand-maintained prototype's quoted figures began decaying the day they were written; a
  regenerated paper re-measures every run instead.
- **A second, drifted reader implementation** — `buildPaper` imports `journalChat.js`, `digest.js` and
  `journal.js` from the app and telegram-bridge domains rather than reimplementing turn/status/ask
  parsing, which is exactly how the app writer and the consent gate drifted apart in #325.
- **A typed approval reading as silence** — because the comment channel writes the same bytes the app
  and Telegram bridge write (`<!-- from: me -->`), the fail-closed consent reader in the overnight
  agent sees it as an ordinary user message with no fourth shape to teach it.
- **False negatives in validation** — paper tests must assert against raw HTML, never `innerText`,
  because collapsed `<details>` (the entire point of the format) makes `innerText` under-report a
  correct document as broken.
