# Domain: docs-publisher

`docs-publisher` is the **only sanctioned writer** of the publisher-owned Docs files. It ships as the `fp-docs` command and as a library, and it turns an agent's Markdown draft into a validated, numbered, atomically written revision, while reading — never writing — the user's comments. Agents never hand-edit `docs/` files: the publisher is where every rule in [Domain-docs](Domain-docs) is enforced. It builds on [Domain-docs-core](Domain-docs-core) for parsing, validation and review sets, and runs unchanged under [Domain-planner-tools](Domain-planner-tools) for remote agents.

## Why a single publisher

The alternative, letting each agent write `doc.md`, `response.json`, the index and history itself, was rejected: a Docs revision is a multi-file change (body, response, index entry, history snapshot, linked docs) that must land together, carry stable block ids, answer every open comment, and refuse malformed input. Centralising the write means every guarantee is implemented once and tested once, and a half-applied publish is never visible to the app.

## Commands

| Command | Behaviour |
| --- | --- |
| `fp-docs publish` | Validate a draft and publish the next revision for a task, optionally with linked supporting docs and a disposition for each open comment. |
| `fp-docs lint` | Run the same draft validation without writing any file. |
| `fp-docs status` | Report a task's Docs state (primary revision, threshold result), for one task or a batch of tasks from one registry read. |
| `fp-docs comments` | List open and reopened comments grouped by review-set document with re-anchored placements; optional JSON output; never modifies files. |
| `fp-docs ack` | Acknowledge a submitted review without publishing a revision. |

The planner folder is taken from the `PLANNER_PATH` environment variable. Task ids must be canonical positive integers (`007` is rejected). Unknown or repeated options, and options not supported by the chosen command, are data errors.

## Required behaviour

**First publication and threshold.** A task gets its first primary document only when its journal's read load reaches the configured threshold (default 1,500 words, inclusive), or when the caller passes `--force` deliberately. Below threshold without force, publish creates nothing and reports the normative below-threshold spelling. A task that already has a primary is updated, never given a second primary. Without the `docs/index.json` gate the planner behaves as if Docs did not exist.

**Validation (`lint` and `publish`).** The draft must be valid UTF-8 without a BOM, with LF line endings, free of mojibake markers, inside the journal Markdown subset (no raw HTML other than comments), and — for a primary — begin with a bold status sentence and contain the required catch-up sections, with every "verified/fixed/done" claim linked to evidence and no bare `#NNN` issue number. Linked `doc:` targets must exist or be created in the same publish; external URLs must be well-formed, and `--check-links` additionally checks reachability but never probes local or private network addresses. Failures are coded errors `D01`–`D11` (encoding, grammar, catch-up shape, link, disposition, concurrency, size, binding, data, external edit, linked input) with a stated fix; the full table is in [Domain-docs](Domain-docs).

**Answer every comment.** Every open or reopened comment anywhere in the task's review set needs a disposition (a status, the new blocks that answer it, and a note), or the publish must be explicitly partial with a stated reason. Unlinking a draft cannot evade this, because the whole reachable set is checked. A disposition may point only at blocks that exist in the new draft; an invalid block is rejected with no writes. A "needs you" disposition is a blocking ask that the app badges.

**Concurrency.** `--base-rev` must equal the current revision, and an existing linked doc requires its own base revision; mismatches are concurrency errors. A local lock file in the planner folder serialises publishers; a lock whose holder process is dead is reclaimed, a live holder's lock is never reclaimed, and a publisher that cannot get the lock in five seconds fails rather than waiting forever. Callers whose storage already serialises writers (remote agents using conditional writes) use the publish algorithm without the process lock.

**External edits.** The publisher refuses to overwrite a `doc.md` that differs from its own stamp or snapshot — including a body-only hand edit that left the stamp intact — unless `--adopt-external-edit` says the edit was reviewed. Reason: silently overwriting a human's edit is the failure that destroys trust in the loop.

**Revisions and history.** A republish carries block ids, increments the revision, appends a revision summary to the response, and retains only the newest **twenty** prior history snapshots. Retired block ids are never reused even after their snapshots rotate out. A task's Telegram deep link in its journal metadata is copied into the primary's index entry, so the bridge can post the doc link.

**Atomic multi-file writes.** Every publish stages all changed files as temporary files, then renames them in turn. If any step fails (tests inject a failing rename), already-committed files are restored from their previous contents, temporary files are removed, and directories the publish created are removed. Nothing partial remains.

**Size limits.** A body over 256 KiB, an index or review file over 1 MiB, or review-set bodies totalling over 2 MiB across the depth-three traversal are refused, never truncated.

**Reading status honestly.** Status distinguishes a genuinely empty review from a corrupt or unreadable one, and a batch status reads and validates one registry snapshot, caches files and preserves per-task read errors rather than failing the whole batch.

**Acknowledging reviews.** `ack` records that a batch of submitted reviews was seen, once, across the primary and linked docs, without a revision, and never skips earlier unfinished work. Publishing likewise claims the submitted reviews, which the Docs app shows as "Working".

> [!NOTE]
> **Technical detail: example invocation.** Optional reference.

<details>
<summary><strong>Show a publish with a disposition</strong></summary>

```text
fp-docs publish --task 123 --draft draft.md --summary "Answered the two questions" \
  --base-rev 4 --linked new:draft=draft-support.md \
  --disposition d-7kx2m4/c_lq2k9x=done:b3,@3:"Added the comparison table"
```

`new:<alias>=FILE` creates a supporting doc and rewrites `doc:new:<alias>` links to its real id; `<id>=FILE` updates an existing one and needs `--linked-base-rev`. `--dispositions FILE` supplies many; `--partial --reason TEXT` declares unfinished work.

</details>

## Agent-loop contract (summary)

A Node consumer in the overnight agent scans journals for Docs work with **one** publisher invocation and **one** registry read (for 464 journals in the pinned test), records threshold crossing at turn end and wakes the next turn once, and adds no behaviour to a planner without the index gate. It wakes parked primary and linked reviews, keeps acknowledged unfinished work, then goes quiet; reports corrupt transport explicitly rather than as quiet or empty; and never lets a review bypass the closed, snoozed, paused or session-ownership guards. A turn requires a fresh publish plus a one-line journal pointer, and treats "needs you" as blocking. The full contract is in [Domain-docs](Domain-docs).

> [!NOTE]
> **Technical detail: modules and exports.** Optional reference for rebuilders.

<details>
<summary><strong>Show principal modules and exports</strong></summary>

| Path | Exports | Role |
| --- | --- | --- |
| `packages/docs-publisher/src/publisher.js` | `publish`, `publishUnlocked`, `lintDraft`, `readStatus`, `readStatuses`, `readComments`, `acknowledgeReview`, `acknowledgeReviewUnlocked`, `writeAtomically`, `DocsPublisherError` | All publisher behaviour. |
| `packages/docs-publisher/src/lock.js` | `acquireLock`, `releaseLock` | Exclusive-file PID lock; same protocol as the agent lock, with no plugin dependency. |
| `packages/docs-publisher/src/index.js` | the publisher exports | Package root. |
| `packages/docs-publisher/bin/fp-docs.js` | `main` | Command-line front end. |

The package declares exactly one dependency, `docs-core`, and packs and installs without the plugin tree.

</details>

## Tests as requirements

`packages/docs-publisher/src/publisher.test.js` pins the feedback loop (batch acknowledgement once without a revision and never skipping earlier work; primary and supporting answers with anchored dispositions preserving every comment; partial work named explicitly; invalid blocks rejected without writes; empty versus corrupt reviews), draft validation (lint modifies nothing; a malformed index is a data error; local addresses are not probed), publishing (reader-valid first revision, block id carry, twenty-snapshot retention, stamp and hand-edit refusals, new linked docs, base-revision checks, threshold), command-line JSON output, and size and atomicity. `packages/docs-publisher/src/standalone.test.js` pins that the package installs with only its declared dependency, never reclaims a live lock, and that the consumer launcher refuses sandbox escapes without publisher writes. `packages/docs-publisher/src/agent-loop.test.js` pins the loop summarised above.

## Failure modes

| Failure | Behaviour |
| --- | --- |
| Another publisher holds the lock | Concurrency error after five seconds; nothing written. |
| Crash or error mid-publish | Earlier renames rolled back, temp files and new directories removed. |
| Hand-edited `doc.md` | Refused until adopted or restored. |
| Corrupt index or review | Data error naming the file; never reported as "no comments". |
