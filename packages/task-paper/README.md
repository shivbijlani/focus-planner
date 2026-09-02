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

## Not yet built

The **comment channel**. #286's load-bearing requirement is that the user can leave
instructions on the doc and the agent reads them. This page is a read surface only, and
says so in its own footer — anything typed into it is discarded on the next regeneration.
Wiring that up means teaching the consent reader a fifth writer, which #325 shows must be
done in the shared reader rather than per-channel.
