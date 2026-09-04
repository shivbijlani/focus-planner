---
name: catchup-doc
description: >-
  Writes a zero-context catch-up doc for Shiv about one piece of work — what it is, why it
  matters, where it stands — with a link to evidence behind every claim, and every ID rendered
  as a titled link. Use whenever he says "catchup doc", "catch-up doc", "catch me up", "write it
  up", "give me a writeup", "summarize where this stands", "what's the status of X", or asks to
  review something he has no loaded context on. Also the required reporting format for GitHub
  issue work (one catch-up doc per issue, edited in place) and the body of the per-task catch-up
  document that the overnight agent points at instead of stacking long journal and Telegram
  posts. Produces a markdown file, and optionally posts it as an issue/PR comment or a Google
  Doc, using a structural subset that renders in all three. Trigger any time the conversation is
  about producing a readable status writeup for Shiv rather than doing the underlying work.
argument-hint: 'What to catch up on — an issue number, a PR, a task id, or a topic.'
user-invocable: true
---

# Catch-up doc

You write **one document that brings Shiv from zero context to able-to-decide**, about a single
piece of work. He is usually reading it on a phone, hours or days after the work happened, with
nothing loaded.

This skill is only about **producing the document**. It does not do the underlying work, and it
does not merge, close, deploy, or send anything.

## Why this lives in the plugin

These conventions used to be spread across `SKILL.md` prose, a user-scoped skill folder, and the
`gh-issue-work` operating contract in a task journal. That meant they were re-derived per run and
drifted, and a new machine picked up none of them.

They now ship **inside the repository plugin**, so they travel with it and are installed by the
existing auto-deploy path with no manual step. Two consequences worth stating, because both have
bitten before:

- The plugin manifest globs `skills/`, so this folder is discovered without being registered
  anywhere. Adding a skill is adding a directory.
- "Installed" means **both** deploy targets — `installed-plugins` and the OA home. A skill that
  lands in only one is how a merged fix ends up not being the running code.

## When to use

- He says "catchup doc", "catch me up", "write this up", "give me a writeup", "where does this
  stand".
- He is being asked to review or approve something — the doc is what makes that possible.
- As the **reporting step** of GitHub issue work (see the `gh-issue-work` skill), where the rule
  is *exactly one agentic comment per issue, and it is the catch-up doc*.
- As the **per-task catch-up document** the overnight agent binds to a task, whose link replaces
  the long per-turn journal and Telegram posts.

## Shiv's standing preferences

These four are his, stated in his own words, and they are the reason this skill exists. They are
listed here in a machine-checkable block so the skill and its guard cannot drift apart — the
same construction the approval vocabulary uses.

<!-- CATCHUP-DOC-PREFS:BEGIN -->
| key | preference | the rule |
| --- | --- | --- |
| `no-context-reader` | Assume the reader has **no context**. | Every doc is written for someone who has not been following along. No internal jargon, no assumed antecedents, no bug numbers used as nouns. |
| `no-correction-narration` | Assume the reader has **not seen previous versions**. | Do **not** narrate corrections or missteps. No "previously I said X, that was wrong". Report what is true now; put superseded history in an appendix if it must be kept. |
| `collapsible-sections` | Use **collapsible sections** where the output format supports them. | `<details>`/`<summary>` for GitHub, PR comments and journal turns. Where the format does not support folds — notably Google Docs — use a plain heading instead, and never emit a broken fold. |
| `titled-id-links` | **Every ID is a link, and carries the underlying resource's title.** | Never write a bare `#NNN`. Every task id, issue, PR or run id renders as a link whose text or parenthetical names the resource: `[issue #441](url) ("Catch-up doc creation should be a plugin skill…")`. |
<!-- CATCHUP-DOC-PREFS:END -->

### On `titled-id-links` — the one that regresses

This is the highest-value item and the easiest to get wrong, and the reason is structural rather
than careless: **during a run the agent has every ID loaded, so it never feels the friction.** A
page dense with bare `#423` / `#468` reads as perfectly clear to the process that wrote it and is
unreadable to the person it was written for.

> *"Obviously I don't have the meaning of IDs memorized."*

So resolve them mechanically rather than from memory:

```powershell
# one lookup for every id in a draft - planner board for task ids, gh for issues/PRs
powershell -File <plugin>\skills\catchup-doc\resolve-ids.ps1 -Path <draft.md>
powershell -File <plugin>\skills\catchup-doc\resolve-ids.ps1 -Path <draft.md> -Apply
```

`resolve-ids.ps1` reports every bare ID in a draft with the title it should carry, and `-Apply`
rewrites them in place. Run it before you publish; a bare ID that survives to the reader is the
defect this preference names.

Two cautions it encodes, both already paid for:

- **A bare `#NNN` is genuinely ambiguous.** Planner task ids and GitHub numbers share one
  namespace and about a quarter already collide, so `#327` has two readings that both look right.
  Always qualify the kind: `task #327`, `issue #327`, `PR #327`.
- **A title you could not resolve is reported, never invented.** An ID annotated with a guessed
  title is worse than a bare one, because it reads as verified.

## Structure

Use these sections, in this order. Keep the headings; drop a section only when it genuinely does
not apply.

1. **Status line** — one bold sentence at the very top: what state it is in and what, if anything,
   is wanted from him. He should be able to stop reading here.
2. **What this is, with no prior context** — plain sentences.
3. **Why it matters** — in his terms: what he would *notice*. Not implementation terms.
4. **What changed / what was done** — the substance. Put the deep detail in collapsible blocks so
   the page stays skimmable.
5. **Evidence** — a link for every claim of verification. See below; this is not optional.
6. **Where it stands** — what happens next, and the **exact word** to reply if a decision is
   wanted.
7. **Appendix** *(optional)* — superseded history, if it genuinely must be retained. It goes here
   precisely so the body can honour `no-correction-narration`.

### Writing rules

- **No bare command tokens.** `merge 385` means nothing on its own. Always: what it is, what it
  changes for him, what happens if he says yes, then the word to reply.
- **Advertise only an approval word the consent reader accepts.** Asking for a phrase the reader
  rejects means his reply is silently dropped — indistinguishable from him declining.
- **Skip your own missteps.** He never saw the wrong turns; recounting them buries the answer.
- **Length is not the enemy; assumed context is.** A twelve-line explanation that stands alone
  beats a three-line one made of jargon.
- **Say which you would do first, and why**, whenever there is more than one thing to decide.

### Collapsible detail

```markdown
<details>
<summary><b>Short claim a reader can decide to skip</b></summary>

The full explanation.

</details>
```

This is the one rich construct that survives GitHub markdown and the Telegram bridge intact.
**Blank lines around the inner content are required** or GitHub renders the markdown as literal
text.

⚠️ **It does NOT survive a Google Docs import.** Measured 2026-09-01: importing markdown containing
`<details>`/`<summary>` flattens the block — the summary text is absorbed into the first line of the
body and the fold is gone. Nothing is lost, but the structure is. So when the target is a Google
Doc, use a plain `## History` / `## Detail` heading instead of a fold. That is what
`collapsible-sections` means by *where the format supports them*: the preference is satisfied by
choosing the right construct per target, not by emitting a fold that will render broken.

## Evidence — the part that is not negotiable

**Anything claimed as verified needs a link he can click to check it himself.** A claim without a
link is an assertion, and the whole point of the doc is that he does not have to take your word.

| Claim | What to link |
| --- | --- |
| "tests pass" | the CI run URL, plus the pass count and the file count |
| "it's fixed" | the PR, and the test whose name asserts the fixed behaviour |
| "CI is green" | the run URL, and name the **jobs** — a run can be green while a job is red |
| "already done" | the artifact: the commit, the calendar event, the file, the run |
| "X is not needed" | the check you actually performed, with its output |

**Verify, do not assume.** If a prerequisite looks already-handled, prove it and link the proof —
finding a blocker already cleared is a legitimate, reportable result, but only when checked.

## Output targets

Always write the body to a **file** first, then publish from that file. Never build the body as an
inline shell string: quoting eats `$`, `~`, backticks and apostrophes, and the corruption is
invisible until he reads it.

- **File only** (default) — leave it as `.md` and give him the path.
- **GitHub issue or PR comment** — `gh issue comment <n> --body-file <file>`. Then **read it back**
  and confirm: comment count is what you expect, byte length matches, `<details>` tags balance,
  tables survived, no mojibake.
- **Google Doc** — author it in the structural subset above so the exported markdown is what gets
  posted. Headings, bold, lists, tables and links convert cleanly; `<details>` does **not**.
  Import with `import_to_google_doc`, then read it back with `get_doc_as_markdown` and confirm the
  tables and headings survived.
  ⚠️ The file must sit under `~\.workspace-mcp\attachments\` and be passed as a `file:///` URL —
  any other path is refused, and a Windows path without the scheme is refused separately.
- **Journal turn** — write it through `write-turn.ps1`, never by hand.

## Editing in place

On a later pass about the same thing, **edit the existing document rather than adding another**.
A second catch-up doc means he has to work out which one is current, which is the problem this
skill exists to remove.

- Address a task's doc by its **stored binding**, never by searching for its title: a rename makes
  the doc invisible, and "found nothing" is indistinguishable from "found the wrong one".
- GitHub: `gh issue comment --edit-last`, or
  `gh api -X PATCH /repos/<owner>/<repo>/issues/comments/<id> -F body=@<file>`.
- Record the comment URL when you post it, so the next pass can find it without guessing.
- **Never touch a comment you did not write.** If you cannot prove a comment is yours, leave it.

## Checklist before you hand it over

- [ ] The first bold line alone tells him the state and what is wanted.
- [ ] No sentence needs a fact that is not in the document.
- [ ] No correction narration in the body; superseded history is in the appendix or dropped.
- [ ] **No bare `#NNN`.** Every ID is a link and carries its resource's title —
      `resolve-ids.ps1` reports zero unresolved.
- [ ] Every verification claim has a link.
- [ ] Deep detail is collapsible where the target supports it; plain headings where it does not.
- [ ] If a decision is wanted, the exact reply word is stated, with what it does.
- [ ] Posted from a file, and read back to confirm it rendered.
