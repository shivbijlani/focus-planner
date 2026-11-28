# Domain: docs-publisher

`docs-publisher` is the single sanctioned writer of native catch-up Docs. It validates a draft, assigns block ids and revision numbers, writes the document, history, index and response files as one unit, and reads back status and open comments for agents. It ships as a standalone Node command, `fp-docs`, so the Docs workflow does not depend on the overnight-agent plugin tree. The file formats and publish protocol it implements are specified normatively in [Domain-docs](Domain-docs); the parsing and validation it relies on are in [Domain-docs-core](Domain-docs-core).

## Responsibility

- **Publish** a revision of a task's doc from a draft, optionally with linked docs and with a disposition for each reviewed comment.
- **Lint** a draft without writing anything.
- **Report** per-task status (one task or a batch, optionally as JSON) and the open comments awaiting the agent.
- **Acknowledge** a review so the agent's pickup is recorded.
- **Guard** every write through caller-supplied path and writability checks.

## Why a separate, standalone package

The alternative — leaving the publisher inside the overnight-agent plugin tree — is rejected (the lock's own comment notes it needs "no plugin dependency") because the same publish must run from several places: the local agent, the Node agent loop, and remote agents that only see OneDrive (see [Domain-planner-tools](Domain-planner-tools)). One implementation with one set of guards means a publish is identical wherever it happens. The package declares only its `docs-core` dependency; its tests pack and install it without the plugin tree to prove that.

## Publish guarantees

| Guarantee | Mechanism |
| --- | --- |
| One writer at a time per planner folder | An exclusive lock file `.fp-docs.lock` in the planner folder, holding the owner's process id, five-second wait. A dead holder may be reclaimed; a live holder's lock is never reclaimed. |
| All-or-nothing writes | Every file in a publish is first written to a temporary sibling, then renamed into place. On any failure, committed renames are reversed (restoring previous content or removing new files), temporaries are removed and newly created directories are removed. |
| No lost user edits | A stale `--base-rev` is refused; a hand edit of the published doc is detected and refused unless the caller passes the explicit adopt flag. |
| Idempotent retries | A publish can carry an operation marker recorded on the new revision summary so a retried request recognises its own completed publish. |
| Policy guard | The CLI refuses to run without path and writability guards, supplied by the deployment launcher or a guard module named in the environment; sandbox escapes are refused with no publisher writes. |
| Bounded history | Old revisions are trimmed after a publish. |

Publisher errors carry a stable code, a detail and a suggested action; coded classes include data (`D09 data`), concurrency (`D06 concurrency`), disposition (`D05 disposition`), linked input (`D11 linked input`) and policy (`D09 policy`).

> [!TIP]
> **Technical detail: the `fp-docs` command surface.** Optional reference for rebuilders.

<details>
<summary><strong>Show commands, flags and environment</strong></summary>

```text
fp-docs publish --task N --draft FILE --summary TEXT [--base-rev R]
        [--linked new:<alias>=FILE|<id>=FILE] [--linked-base-rev R]
        [--force] [--adopt-external-edit] [--check-links]
        [--disposition [DOC/]COMMENT=STATUS:bN,@N:NOTE] [--dispositions FILE]
        [--partial --reason TEXT]
fp-docs lint     --draft FILE [--check-links]
fp-docs status   --task N [--json]      |  --tasks N,N,... --json
fp-docs comments --task N [--json]
fp-docs ack      --task N --review ID [--doc ID]
```

- `PLANNER_PATH` names the planner data folder and is required.
- Guards come from the launcher, or from a module named by `FP_DOCS_GUARD_MODULE` that exports `assertPath` and `assertWritable`.
- `STATUS` in a disposition is one of `answered`, `done`, `needs-you`, `declined`; comment ids look like `c_…`; an optional `d-…/` prefix targets a linked doc.
- `--linked <id>=FILE` requires a matching `--linked-base-rev`, in order; `new:<alias>=FILE` creates a linked doc.
- Option repeats are rejected except for `--linked`, `--linked-base-rev` and `--disposition`; unknown options are errors.

| Path | Exports |
| --- | --- |
| `packages/docs-publisher/bin/fp-docs.js` | `main` |
| `packages/docs-publisher/src/index.js` | `DocsPublisherError`, `acknowledgeReview`, `acknowledgeReviewUnlocked`, `lintDraft`, `publish`, `publishUnlocked`, `readComments`, `readStatus`, `readStatuses`, `writeAtomically` |
| `packages/docs-publisher/src/publisher.js` | the same set (implementation) |
| `packages/docs-publisher/src/lock.js` | `acquireLock`, `releaseLock` (the same exclusive-file/PID protocol as the agent lock, with no plugin dependency) |

`publishUnlocked` and `acknowledgeReviewUnlocked` are the same algorithms without the local lock, for callers whose storage already serialises writers.

</details>

## Behavioural requirements

From `packages/docs-publisher/src/agent-loop.test.js` and `standalone.test.js`.

- The package packs and installs with only its declared `docs-core` dependency, without the plugin tree.
- A live publisher lock is never reclaimed.
- The consumer launcher refuses sandbox escapes without any publisher write.
- The Node agent loop scans 464 journals with one publisher invocation and one registry read.
- It records the inclusive threshold at turn end and wakes the next turn once.
- A planner without the Docs index gate gets no Docs behaviour at all.
- Parked primary and linked reviews wake; acknowledged unfinished work is kept; then the loop goes quiet.
- A corrupt transport is reported explicitly, never as quiet or empty, including in compact scans.
- Docs reviews never bypass closed, snoozed, paused or session-ownership guards.
- A turn requires a fresh publish and a one-line journal pointer, and `needs-you` counts as blocking.

## Failure modes

A lock held past the five-second wait fails the publish with a concurrency error; nothing is written. A crash between staging and renaming leaves only temporary files, never a half-published revision. Open issue #868 records that revisions arriving through sync can create conflict copies and leave the open doc stale; #852 and #854 track the CLI slices.
