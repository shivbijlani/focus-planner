# Domain: telegram-bridge

`telegram-bridge` (`packages/telegram-bridge/`) is a standalone Node CLI that mirrors task journals
into a Telegram forum (one topic per task) and folds replies back into the journals, plus a
consolidated "what is waiting on you" approval digest.

## Responsibility

Make the board and its open questions reachable from a phone with zero per-topic navigation:
`sync-up` posts each task's latest agent turn into its own forum topic; `sync-down` folds Telegram
replies back into journals (both single-topic replies and multi-task batched replies posted in
General); `sync-archive` closes/reopens topics as tasks complete or reactivate; `digest` posts one
message listing every open ask across all tasks, ordered by how much the user actually cares — the
board's own Today/Deferred/urgency ordering, not task-id order.

## Principal modules

| Path | Purpose |
| --- | --- |
| `packages/telegram-bridge/src/bridge.js` | Orchestrates both sync directions; all I/O injected (client + io) so the flow is unit-testable offline. |
| `packages/telegram-bridge/src/journal.js` | Pure journal parsing shared with the app: `agentBlockStatus`, `latestAgentTurn`, `appendUserReply`, `splitAtSentinel`. |
| `packages/telegram-bridge/src/digest.js` | Builds the consolidated approval digest; reads the ask from the **newest** agent turn only, never a whole-file grep for the last ask marker. |
| `packages/telegram-bridge/src/board.js` | Ranks tasks for the digest by board position (Today-urgent > Today > Deferred-urgent > Deferred > unlisted), not by numeric task id. |
| `packages/telegram-bridge/src/liveStatus.js` | Arbitrates a task's *live* status from its newest turn, because the frozen `**Status:**` header near the top of a journal is written once and never updated by the only sanctioned writer. |
| `packages/telegram-bridge/src/routeReply.js` | Splits one batched, cross-task Telegram reply (posted in General, no `message_thread_id`) into per-task segments. |
| `packages/telegram-bridge/src/deleted.js` | Reads the planner's sync sidecars for `deleted: true` tombstones, so a deleted task's forum topic is still archived even though the task is on no board. |
| `packages/telegram-bridge/src/deepLink.js` | Reads/writes the `<!-- tg-meta ... -->` marker mapping a task to its forum topic. |
| `packages/telegram-bridge/src/state.js` | Persistent bridge state: task↔topic map, last-posted-turn hashes, `getUpdates` offset. |
| `packages/telegram-bridge/src/telegramFormat.js` | Converts journal markdown to Telegram's small HTML subset (no headings/lists/tables — they collapse to bold lines, `• ` bullets, plain text). |

## Public exports

`appendUserReply`, `assertRunnable`, `buildDigest`, `createBridge`, `createFsIo`,
`createTelegramClient`, `emptyState`, `extractAsk`, `extractAskEntry`, `findTaskByTopic`,
`hasAgentBlock`, `hashDigest`, `hashTurn`, `journalFilename`, `latestAgentTurn`, `loadConfig`,
`loadState`, `parseTitle`, `saveState`, `taskIdFromFilename`, `topicName` (from `index.js`).

## Behavioural requirements (from the telegram-bridge test suite, 15 files / 357 tests)

- **The digest reads only the newest turn's ask, never a whole-journal grep** — a later turn that
  restates a blocker in prose without re-emitting the `**Needs from you:**` marker must not let a
  grep-based reader surface a stale, already-superseded ask (measured live: task #250's marker was
  written 2026-07-01 and superseded 07-07). `extractAsk`/`extractAskEntry` fold continuation lines
  into one line, prefer an explicit ask over a fallback "Next" line, drop a Next line describing the
  agent's own work rather than something needed from the user, mark boilerplate-salvaged asks as
  *weak* so callers can gate on confidence, and return `null` (not a guess) for a turn with no ask.
- **Digest ordering follows the board, not task-id magnitude.** Rank order is Today-urgent >
  Today > Deferred-urgent > Deferred > unlisted; a malformed six-digit id (e.g. `#426580`) or a
  genuinely high-priority task filed most recently must not out-rank a real P0, because the digest's
  hard size cap means only the first ~17 of ~99 asks survive — whatever leads is, in practice, the
  only thing the user sees.
- **A batched cross-task reply is split correctly.** `parseReplyRouting` routes the shape the agent
  itself asks for ("merge 394, 386, 407; go on 348"), treats newlines as separators so bullet-list
  replies work, folds each segment's text verbatim (never paraphrased), validates task ids against
  journals that actually exist (so ordinary prose numbers like "1000W" or "$3,046" are never
  mistaken for task ids), and returns an empty routing (a meaningful "no known task mentioned"
  signal) rather than guessing.
- **Live status is arbitrated by recency, not by a frozen header (#202).** `normaliseStatus` reads
  human dialects ("In progress", hyphenated forms) without a naive space-stopping regex swallowing
  `In progress` down to the bare token `in`; folds completion synonyms onto one canonical value;
  drops a trailing em-dash clause rather than failing to parse; `statusStampDate` takes the date the
  line actually stamps itself with, not merely the first or last date mentioned in surrounding
  prose; and `liveStatus` prefers whichever of {block header, newest turn} is actually newer, so a
  task the agent finished cannot get stuck in the approval queue forever because its header froze on
  the day the sentinel block was created.
- **A deleted task's topic is still archived.** Because `deleted: true` is an explicit, recorded
  tombstone (never inferred from "absent from both boards", which is ambiguous with a parse failure
  or an unsynced row), the archiver can close a topic for a task the user genuinely deleted without
  risking closing one that merely failed to parse.

## Failure modes guarded against

Two recurring shapes: **stale signal read as current** (a frozen status header, a superseded ask, a
task-id sort that promotes an old malformed row) and **an ambiguous absence read as a definite
state** (a task missing from both boards could mean deleted, could mean a parse bug — the tombstone
exists specifically so the bridge never has to guess which).
