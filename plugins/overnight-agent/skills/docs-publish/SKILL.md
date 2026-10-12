---
name: docs-publish
description: Publish a task's native Docs catch-up, consume submitted span reviews, and disposition comments through fp-docs. Uses index.tasks, not Google title search or Markdown briefings.
---

# Native Docs turns

This is an optional surface, enabled only by `docs/index.json` in the configured planner
folder. Do not create that gate implicitly, import old documents, convert
`journal/task-N-briefing.md`, or remove the Google path.

Resolve the matching repository from `FOCUS_PLANNER_REPO` (or the current repository).
Installed plugins need this variable set to their matching deployed repository; a missing
publisher is an error, not an empty review. Set `PLANNER_PATH` to the configured planner
folder. Run `node <repo>\packages\docs-publisher\bin\fp-docs.js` for each command below.
The publisher and Node tools refuse paths outside `OA_SANDBOX_ROOT` in a sandbox.

## One task, one writer

The task's bound session owns acknowledgement and publishing. The coordinator sends the
native review signal and this procedure in its usual guarded brief; it does not do the work.
Respect closed rows, snooze, pauses, lanes, ownership, attribution, and the agent-gate floor.
Do not enable any automation to process reviews.

1. `status --task N --json` resolves the primary through `index.tasks[N]` and visits linked
   supporting documents cycle-safely to depth 3. Read the existing bodies, journal history,
   and `comments --task N --json`. Missing/invalid files or failed reads are errors.
2. For each document's `pendingReviews`, in the returned order, run
   `ack --task N --doc ID --review REVIEW`. Ack is an idempotent claim, not a resolution:
   after an interrupted run, unresolved claimed work still wakes the task. Never skip an
   earlier batch. Supporting comments belong to the supporting doc, not the primary.
3. Do the requested work and amend the prose surgically. A comment is input, not authority
   to bypass consent. An `approve` intent covers only the quoted explicit proposal; vague
   approval is not whole-document approval, does not close a task, and cannot override the
   safety floor. The existing `consent` checks still apply before consequential actions.
4. Write drafts in your own workspace, UTF-8 without BOM and LF. The primary follows the
   catchup-doc structure; preserve links, tables, old Google links and accepted text.
   Never edit published files or `review.json` directly.
5. `publish --task N --draft FILE --base-rev R --summary TEXT --dispositions FILE`
   publishes the primary in place. Include `--linked ID=FILE --linked-base-rev R` for each
   supporting doc changed. New linked docs use `new:alias=FILE` and `doc:new:alias` links.
   Dispositions JSON is an array of `{ "doc": "d-...", "id": "c_...", "status":
   "answered|done|needs-you|declined", "blocks": ["bN"], "note": "short explanation" }`.
   `@N` in `blocks` points to the Nth draft body block (not the H1), so an edited block
   receiving a new anchor can still be addressed without guessing its id.
   The CLI also accepts repeated `--disposition DOC/COMMENT=STATUS:bN,@N:NOTE`.
   Answer in prose and disposition every open/reopened comment in the old and new review
   sets. Only explicit `--partial --reason TEXT` leaves work unfinished; report that reason.
6. A `needs-you` disposition is a blocking ask. Write one short journal prose line with the
   Docs URL and the exact ask, using `write-turn.mjs -Id N -BodyFile FILE -Ask blocking`.
   Start that prose line with `**Needs from you:**` so the existing ask reader recognizes it.
   Otherwise use `-Ask none` and `**Needs from you:** None. Updated [catch-up](URL).`
   Keep the normal moon heading and provenance marker; the tool supplies authorship.
   The full status and answer live in the document, not a second journal report.
   Then `oa-state.mjs mark -Id N -Status ...`. Do not mark a task complete on approval alone.

After every turn, `status` checks the full journal's visible-word count. With the gate enabled,
`mark` records a reached threshold with no primary; the next turn creates it once, without
`--force`, summarizing the whole journal. Below-threshold tasks remain journal-only. Once a
primary exists, each actual turn publishes a new revision before its journal pointer.
Duplicate scans/acks are not turns and must not manufacture another revision or pointer.
