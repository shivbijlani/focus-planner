# Domain: telegram-bridge

## Responsibility

`packages/telegram-bridge` mirrors the planner's task journals into a Telegram forum group (one task
= one topic) and folds phone replies back into the correct journal, so the user can approve/answer the
overnight agent's asks from a phone without opening the app. It also builds a single consolidated
"waiting on you" approval digest, because the per-task mirror alone scatters every open question
across dozens of separate topics.

## Principal modules

| Path | Exports | Role |
| --- | --- | --- |
| `packages/telegram-bridge/bin/telegram-bridge.js` | (CLI) | `whoami`, `baseline`, `sync-up`, `sync-down`, `sync-archive`, `digest`, `once`, `watch` — the operator-facing entry point. |
| `packages/telegram-bridge/src/bridge.js` | `createBridge`, `blockingAsk`, `splitAsk`, `formatForTelegramParts`, `terminalStatus`, ... | Orchestrates both directions: `syncUp` (post the latest agent turn per task) and `syncDown` (fold replies back). All I/O is injected so the flow is unit-testable offline. |
| `packages/telegram-bridge/src/board.js` | `parseBoardOrder`, `boardRank`, `boardIndex` | Parses `planner.md` so the digest can be ordered by how much the user actually cares (board section/urgency), not by task-ID magnitude. |
| `packages/telegram-bridge/src/digest.js` | `buildDigest`, `extractAsk`, `extractAskEntry`, `hashDigest` | Builds the consolidated approval digest from each task's **newest** agent turn only. |
| `packages/telegram-bridge/src/liveStatus.js` | `liveStatus`, `liveJournalStatus`, `normaliseStatus`, `statusStampDate`, `CANONICAL` | Derives a task's live status by date-arbitrating the newest turn against the (possibly stale/frozen) sentinel header, instead of trusting the header alone. |
| `packages/telegram-bridge/src/deleted.js` | `parseDeletedTaskIds` | Reads the planner's sync sidecar (`planner.md.sync.json`) to find tasks explicitly **deleted** by the user, so their forum topics get archived too. |
| `packages/telegram-bridge/src/completed.js` | `parseCompletedTaskIds` | Reads `planner-completed.md` for topic-archival decisions. |
| `packages/telegram-bridge/src/routeReply.js` | `parseReplyRouting`, `coalesceByTask` | Splits a single free-form General-thread reply ("merge 394, 386, 407") into per-task segments. |
| `packages/telegram-bridge/src/deepLink.js` | `telegramDeepLink`, `parseTgMeta`, `parseTgLink`, `buildTgMetaMarker`, `upsertTgMetaMarker` | Computes/reads the deep link to a task's forum topic, stamped into the journal as a `<!-- tg-meta ... -->` marker. |
| `packages/telegram-bridge/src/journal.js` | `latestAgentTurn`, `agentBlockStatus`, `hasAgentBlock`, `appendUserReply`, `splitAtSentinel`, ... | Pure, filesystem-free journal readers shared across the package. |
| `packages/telegram-bridge/src/state.js` | `loadState`, `saveState`, `setTopic`, `setLastPosted`, `bumpReplyCount`, ... | Persistent bridge state (task↔topic mapping, last-posted hash, Telegram offset) stored outside both the repo and OneDrive. |
| `packages/telegram-bridge/src/telegramFormat.js` | `mdToTelegramHtml`, `escapeHtml`, `extractLinks` | Converts journal markdown to Telegram's restricted HTML subset. |
| `packages/telegram-bridge/src/telegramClient.js` | `createTelegramClient` | Thin wrapper over the Telegram Bot API with an injectable `fetch`. |
| `packages/telegram-bridge/src/config.js` | `loadConfig`, `assertRunnable` | Loads config from environment; the bot token is **never** read from a repo file. |

## Design decisions and the defects they closed

**Ordering the digest by the board, not by task ID (`board.js`).** The digest has a hard Telegram
size cap, so with a large queue only the first ~17 of ~99 asks survive and the rest collapse into
"…and N more" — making the *order* the entire feature. Sorting by `Number(taskId)` descending looked
like "newest first" but is not a priority signal: malformed six-digit IDs sort permanently above every
real task, and a genuine P0 can sit below whatever was filed most recently. The fix reuses the order
the user already maintains by hand: `## Today` outranks `## Deferred`, row order within a section is
the user's own ordering, and 🔴/`P0` mark urgency — anything not on the board sinks last. See
[Prioritisation](Prioritisation) for the full sort key this feeds into.

**Reading the ask from the newest turn only (`digest.js`).** Journals are bottom-appended chat
threads; a later turn routinely restates a blocker in prose without re-emitting the `Needs from
you:` marker. A whole-file grep for the last marker can therefore surface an ask a newer turn already
invalidated — measured live on task #250, where a marker written 2026-07-01 was superseded on 07-07
and a grep-based triage acted on the stale one. `latestAgentTurn()` scoping fixes this by construction.

**Date-arbitrating status instead of trusting the header (`liveStatus.js`, issue #202).** The sentinel
block's `**Status:**` line is written once when the block is created and is frozen thereafter — since
2026-08-26 the only sanctioned journal writer (`write-turn.ps1`) is append-only and has no way to edit
an existing line. A task the agent has since finished therefore never left the approval queue: measured
on the live corpus of 239 journals, 10 headers disagreed with the date-arbitrated live status, with
staleness up to 73 days. `liveStatus.js` also fixes a parsing fault in the same area: the dialect
`In progress` was captured as the bare token `in` by a regex that stopped at the first space.

**Explicit deletion tombstones, not board absence (`deleted.js`).** `syncArchive` used to infer "this
task is gone" from `completed.has(taskId)`, which is false forever for a task the user deleted (it
left both boards). Measured live: 139 deleted tasks, 101 still holding a Telegram topic, 65 still
open. The fix keys archival on the sync sidecar's explicit `deleted: true` tombstone — absence alone is
ambiguous (a board that failed to parse reads the same as a genuinely gone task) and a tombstone is a
deliberate, recorded user action. See [Data-Formats](Data-Formats) for the sidecar's shape.

**Routing General-thread replies, not just in-topic ones (`routeReply.js`).** The bridge originally
recognized only a reply posted *inside* a task's own forum topic; a batched reply to the group's
General approval digest (`message_thread_id` absent) was silently dropped — the worst failure mode,
because the user sees their own message land in the chat and reasonably believes they answered.
`parseReplyRouting` splits such a message into per-task segments, validated against the journals that
actually exist so ordinary prose numbers ("$3,046", "2026") are never misread as task IDs.

## Behavioural requirements (selected, from the domain's test suites)

- `parseBoardOrder`: maps each row to its section and position, flags urgency from 🔴/`P0`, ignores the
  header/separator/Priorities list, tolerates CRLF and a trailing HTML comment, and keeps the first
  position when a task is listed twice.
- `extractAsk`: prefers an explicit ask marker, folds continuation lines into one line, keeps the real
  ask that follows a dismissive clause, and marks a boilerplate-salvaged ask as **weak** so callers can
  gate on it.
- `normaliseStatus`: reads both the human and hyphenated dialects, folds completion synonyms onto one
  canonical value, drops a trailing em-dash clause, and returns `null` (never a partial token) for a
  phrase naming no status.
- `parseDeletedTaskIds`: returns only tombstoned ids, requires `deleted` to be strictly `true` (not
  merely truthy), dedupes, and never throws on junk input.
- `parseReplyRouting`: routes a batched reply, treats newlines as separators, folds each segment
  verbatim (never paraphrased), and returns empty (so the caller can fall back) when the reply names no
  known task.
- `telegramDeepLink`: strips the `-100` prefix for a private supergroup link, prefers a username over a
  raw chat id when both are present, and returns an empty string when there is nothing to link to.
- `docLink.test.js` (#424): posts a catch-up doc link once and then stays quiet across repeated runs;
  restores exactly one link message if the user deletes it; says **nothing** for a dismissive ask,
  however it is phrased; updates a notice in place rather than stacking a second one when the ask
  changes; forgets the notice id once an ask resolves, so a returning ask is a genuinely new message.
- `pointerTurn.test.js` (#425): a pointer turn is short enough to be a pointer rather than the story,
  still opens a readable agent block, carries a status the bridge can read, and yields its ask to the
  digest rather than duplicating the doc's content in the journal.

## Failure modes

- The bridge is the shipped parser and formatter used everywhere in this domain (including by the
  `packages/telegram-bridge/scripts/sweep-ask-truncation.mjs` measurement tool), specifically so no second, hand-copied
  implementation can drift from what the bridge actually sends — a documented past failure mode.
- Every read/write path in this domain is injected (client + io), so a defect here is expected to
  surface as a failing unit test against an in-memory fixture rather than only against live Telegram.
