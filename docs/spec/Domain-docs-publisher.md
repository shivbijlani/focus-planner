# Domain: docs-publisher

`docs-publisher` is the **only sanctioned writer** of publisher-owned Docs files (`doc.md`, `response.json`, `index.json` and `history/`). It ships as the `fp-docs` command-line tool and a library, and it enforces the catch-up quality rules before anything reaches the user. Agents never hand-edit those files. The full contract (file ownership, review lifecycle, error table, test vectors) is [Domain-docs](Domain-docs); reading rules are in [Domain-docs-core](Domain-docs-core); the remote variant is [Domain-planner-tools](Domain-planner-tools).

## Why one writer

Docs files are single-writer by file: the publisher owns the document side, the app owns `review.json`. A second writer would force a merge where none is wanted and would let an agent skip the lint that keeps catch-ups readable. So the publisher is the single door: it validates the draft, assigns block ids, writes atomically, snapshots history, and refuses unsafe states with a stable reason code. The rejected alternative — letting the agent write Markdown directly and having the app repair it — would move quality rules into every reader.

## Behaviour

**Commands.** `fp-docs publish`, `lint`, `status`, `comments` and `ack`. The planner folder comes from the `PLANNER_PATH` environment variable; without it the tool refuses. Options are validated strictly: unknown, duplicated or unsupported options, and non-canonical task ids, are data errors. `lint` validates a draft without touching any file; `status` reports threshold result and primary revision, for one task or a batch from a single registry read; `comments` prints open and reopened comments grouped by review-set doc, re-anchored; `ack` acknowledges a submitted review.

**Publishing.** A publish validates the draft (UTF-8, LF, journal grammar, catch-up shape, links), then writes the document with carried block ids, a new revision, a response file holding one disposition per comment, an index entry (copying a Telegram deep link from the task's journal metadata into it), and a history snapshot. Only the newest 20 prior revisions are kept, and block ids that rotated out of history are still never reused. Supporting docs are created from new aliases (`doc:new:<alias>` is rewritten to the real id) or updated with a required base revision. First publication requires the journal to reach the threshold (default 1500 visible words, configurable) unless forced; below it the normative below-threshold message is reported and no primary is created. A task never gets a second primary.

**Replying to comments.** Every open or reopened comment anywhere in the review set needs a disposition (`answered`, `done`, `needs-you`, `declined`) pointing at current block ids or draft block ordinals, or an explicit `--partial` with a reason that names the unfinished work. Unlinking a doc cannot evade its comments. `needs-you` is visible to the badges as a blocking ask. An acknowledgement of a batch of submitted reviews records them once without a new revision and never skips earlier unprocessed work. Every comment is preserved across revisions.

**Safety.**
- *Atomic multi-file write.* Files are staged to temporaries, renamed into place, and restored if a later step fails.
- *Process lock.* An exclusive lock file in the planner root serialises publishers; a live holder is never reclaimed, a dead holder is.
- *External edits.* If `doc.md` no longer matches the publisher's stamp or snapshot — even a body-only hand edit with the stamp intact — the publish refuses (`D10 external edit`) unless the edit is explicitly adopted.
- *Stale input.* A wrong base revision refuses (`D06 concurrency`); an oversized document, index or review refuses (`D07 size`), never truncating.
- *Corruption is not emptiness.* An actually empty review is distinguished from a corrupt or unreadable one.
- *Operation ids.* A stable operation id (16–120 safe characters) makes retries recognisable.

**Agent loop.** The Node agent loop that scans journals uses the publisher as its only reader: one invocation and one registry read cover 464 journals. It records the inclusive threshold at turn end and wakes the next turn once; wakes parked primary and linked reviews, keeps acknowledged unfinished work, then goes quiet; adds no Docs behaviour to a planner without the index gate; reports corrupt transport explicitly rather than as quiet or empty; never lets a Docs review bypass closed, snoozed, paused or session-ownership guards; and requires a fresh publish and a one-line pointer, treating `needs-you` as blocking. The contract is in [Domain-docs](Domain-docs).

## Modules and exports

> [!NOTE]
> **Technical detail: module reference.** Optional implementation detail; the sections above state the behaviour.

<details>
<summary><strong>Show modules, exports and error codes</strong></summary>

| Path | Exports | Role |
| --- | --- | --- |
| `packages/docs-publisher/src/publisher.js` | `DocsPublisherError`, `acknowledgeReview`, `acknowledgeReviewUnlocked`, `lintDraft`, `publish`, `publishUnlocked`, `readComments`, `readStatus`, `readStatuses`, `writeAtomically` | Publish algorithm, lint, status, comments and acknowledgement. |
| `packages/docs-publisher/src/index.js` | same set | Package surface. |
| `packages/docs-publisher/src/lock.js` | `acquireLock`, `releaseLock` | Exclusive-file, PID-based lock with no plugin dependency; dead holders optionally reclaimed. |
| `packages/docs-publisher/bin/fp-docs.js` | `main` | CLI parsing and exit codes; refuses sandbox escapes. |

`publishUnlocked` and `acknowledgeReviewUnlocked` are the same algorithms without the local lock, for callers (the remote agent tools) that substitute conditional-write preconditions.

Reason codes carried by `DocsPublisherError`: `D01 encoding`, `D02 grammar`, `D03 catch-up`, `D04 link`, `D05 disposition`, `D06 concurrency`, `D07 size`, `D08 binding`, `D09 data`, `D10 external edit`, `D11 linked input`. Their meanings are tabulated in [Domain-docs](Domain-docs).

</details>

## Requirements from tests

- A batch acknowledgement records once without a revision and never skips earlier work; primary and supporting answers publish with anchored dispositions and every comment preserved; unlinking cannot evade comments; partial work is named; invalid blocks write nothing; empty differs from corrupt.
- Status reads and validates one registry snapshot, caches files, and keeps per-task read errors; the shared threshold result is reported.
- Lint modifies nothing; a malformed index is a data error; `--check-links` does not probe local addresses.
- First revision is reader-valid and republish carries block ids; only twenty snapshots are retained and retired ids are not reused; changed stamps or body-only edits are refused unless adopted; the e2e sample passes the existing reader validators; new aliases create supporting docs; a stale linked base revision is refused.
- The CLI prints grouped comments and JSON status without modifying files and rejects non-canonical ids.
- The package packs and installs with only its declared `docs-core` dependency, never reclaims a live lock, and the consumer launcher refuses sandbox escapes without publisher writes.

## Gaps

Publisher-owned files are single-writer, yet the browser's sync engine currently files conflict copies of old revisions and does not refresh an open doc (#868). The soft-wrap rendering defect (#867) is not caught by `lint`.
