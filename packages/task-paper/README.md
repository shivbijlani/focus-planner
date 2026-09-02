# @focus/task-paper

Turns a Focus Planner task journal into a **paper** — one readable HTML page per task —
for [issue #286](https://github.com/shivbijlani/focus-planner/issues/286).

## Why

A journal is a chronological log, and a log is the wrong shape for understanding a
complicated task. The current state is scattered across every turn that ever touched it,
newest last, interleaved with corrections. `task-400.md` is 272 KB. The answer to "what
is going on with this task" is not findable by reading it top to bottom.

> "The journal file is hard to understand and read. Same with telegram. Stacked messages
> are one aspect… What helps is one doc that assumes I have little context and is easy to
> read and comment on… It should be a paper. No talk about corrections and mistakes you
> made. That could go into appendix."

## What it does

The transform is **structural, not editorial** — nothing is rewritten and no model is
involved:

| journal | paper |
| --- | --- |
| newest agent turn, buried at the bottom | the body, in collapsible `<details>` sections |
| the ask, on the last line of the last turn | lifted to the top, above everything |
| every superseded turn | **Appendix** → "Earlier turns, newest first" |
| the dated `Run log` (chain-of-thought by construction) | **Appendix** |
| `**Status:**` mid-prose | a badge in the header |
| the user's instructions, scattered by date | **Your instructions**, newest first, expanded |

## Usage

```powershell
# every task the agent has worked
node bin/task-paper.js generate --planner "C:\...\Focus Planner"

# just a few
node bin/task-paper.js generate --planner "C:\...\Focus Planner" --task 468,286

# one journal, anywhere
node bin/task-paper.js generate --journal path\to\task-468.md --out .\out
```

Output is `<planner>\journal\paper\task-<id>.html`. The Overnight Agent runs this in
PHASE 2.5 via `plugins/overnight-agent/checks/generate-task-papers.ps1`.

## Design notes

**Additive, revertible in one step.** It only ever writes into `journal\paper\`. It never
reads, moves or edits a journal and never touches the board, so deleting that folder
reverts the feature completely. The journal stays the source of truth.

**Regenerated, not maintained.** Settled on evidence in #286: a hand-maintained document
has no mechanism to notice it has gone stale, and the prototype demonstrated the failure
on itself — its own quoted figures began decaying the day they were written. A regenerated
one re-measures every run.

**Deterministic, which is what makes regeneration safe.** There is no "generated at
&lt;now&gt;" stamp; "updated" is derived from the newest turn. An unchanged journal
therefore produces byte-identical HTML and is not rewritten, so a nightly run does not
churn every file in OneDrive.

**Readers are shared, never re-implemented.** `parseJournalChat` (fence-masked, #320)
decides who wrote what, `agentBlockStatus`/`parseTitle` read the header, and
`extractAskEntry` finds the open ask. Copying any of those is precisely how the app writer
and the consent gate drifted apart in #325 — two readers disagreeing about whether Shiv
approved something.

**Self-contained output.** No external CSS, fonts, scripts or network. These get opened
from a phone, often offline, always with no build step.

## ⚠️ If you write a checker for these documents

Assert against the **raw HTML source**, never `innerText`. Recorded on #286 after two
false negatives:

1. `innerText` omits content inside collapsed `<details>` — and collapse-by-default is the
   entire point of this format, so a naive text check reports most of a correct document
   as missing.
2. `text-transform: uppercase` breaks string matching, so authored text does not match
   rendered text. (No stylesheet here uses it, deliberately.)

Both failure modes report a **correct** document as broken, which is the dangerous
direction: the natural reaction is to "fix" a document that was already right.

## The comment channel

#286's load-bearing requirement: *"we will need a way for me to add comments. When
continuing a task, you will have to read my comments because I might instruct there
instead of journal or telegram."*

**A comment is not stored anywhere new — it is appended to the task's own journal, by the
app's own writer, as an ordinary attributed user message.** Everything else falls out of
that one choice rather than being built:

| #286 asked | how it is answered |
| --- | --- |
| where do comments live so they **survive regeneration**? | in the journal. The paper is a pure function of the journal, so a comment cannot be clobbered by regenerating the file it is not in — it reappears under **Your instructions**. |
| how does the agent detect **new** ones? | it already does. `oa-state.ps1 mark` stamps a turn-end boundary and snapshots the journal; text after that boundary is `reopened: true` on the next `scan`. Zero new detection. |
| **consent** — a comment can carry an instruction | the bytes are a normal `<!-- from: me -->` message, byte-identical to what the app and the Telegram bridge write, so the fail-closed reader already attributes it. No fourth shape to teach. |

Verified end-to-end rather than argued: a comment typed into a generated paper in Edge 152
produced `\n\n## <date>\n\n<!-- from: me -->\n<text>\n`, and the **unmodified**
`oa-state.ps1 consent` read it as `human-authored-affirmative`, `affirmative_author: "me"`.
The same journal without the comment returns `no-trailing-content`. Nothing in
`oa-state.ps1` changed.

### The writer is embedded verbatim, not re-implemented

`src/journalChat.js` is dependency-free, so **the whole file is inlined byte-for-byte**
into the paper's `<script type="module">`, read from disk at generation time and never
transcribed. An inline module script tolerates its `export` declarations (measured in Edge
152 on a `file://` origin), so no transformation is needed and a test holds the embed
byte-identical to the source. If they ever drift, a test fails rather than a user's
approval going quiet — which is exactly the #325 failure mode.

### Why the File System Access API

Measured on the live setup, not assumed: on a `file://` origin Edge 152 reports
`isSecureContext: true` and exposes `showDirectoryPicker`, and IndexedDB persists across
pages because every `file://` document shares one origin. That last property is what makes
this usable rather than a chore — **the journal folder is granted once and all papers can
then write**, instead of each paper asking separately.

### Safety

- **Append-only guard.** `createWritable()` truncates and rewrites, so a bug producing a
  short string would destroy a journal rather than fail. Anything that is not the original
  plus new text is refused before the handle is opened. A comment is worth losing; a
  journal is not.
- **Read-back verification.** The file is re-read after writing; an unverified write is
  reported rather than claimed as saved.
- **It can only write its own journal.** The filename is baked in at generation time; no
  code path names a different file.
- **It degrades instead of lying.** With no File System Access API the Save button is
  disabled and a *Copy as markdown* fallback emits the same block — date and `from: me`
  marker included — to paste into the journal by hand.
- **Still additive.** `renderPaper` without a `writerSource` produces the previous
  read-only page, and a paper with no task id never gets a box.

