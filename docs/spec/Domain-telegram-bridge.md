# Domain: telegram-bridge

`telegram-bridge` is a standalone Node bridge between planner journals and a Telegram forum. It mirrors each task's newest agent turn into a task topic, folds Telegram replies back into journals, closes and reopens topics as tasks move across the board, and posts a consolidated digest of open asks. The design repeatedly chooses explicit evidence over guesswork: newest turn over whole-file grep, board order over task-id order, tombstones over absence, and persisted offsets over implicit progress. See [Architecture](Architecture), [Behaviour](Behaviour), [Domain-task-paper](Domain-task-paper), and [Domain-folder-sync](Domain-folder-sync).

## Responsibility

`packages/telegram-bridge/src/bridge.js` describes the package as two directions: `syncUp` posts each task's latest agent turn into its forum topic and `syncDown` folds Telegram replies back into journals. The package also owns `syncArchive` and the approval digest. Its rationale comments are specific about rejected alternatives. The digest refuses a whole-journal grep for the last `Needs from you:` marker because a later turn may supersede that marker without repeating it. Link mode refuses to treat silence as success: a catch-up link message is verified by probing Telegram, because a deleted link and a never-posted link would otherwise look identical.

> [!NOTE]
> **Technical detail: concrete example** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

```js
export function createBridge({ client, config, state, io, logger = () => {}, now = () => new Date(), persist = null } = {}) {
  ...
  async function syncUp() { ... }
  async function syncDown() { ... }
  async function syncArchive() { ... }
  async function syncDigest({ force = false } = {}) { ... }
}
```


</details>
## Modules and exports

> [!NOTE]
> **Technical detail: concrete reference.** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

| Path | Exports from `spec-facts.json` | Role |
| --- | --- | --- |
| `packages/telegram-bridge/bin/telegram-bridge.js` | — | CLI entrypoint: `whoami`, `baseline`, `sync-up`, `sync-down`, `sync-archive`, `digest`, `once`, `watch`. |
| `packages/telegram-bridge/scripts/sweep-ask-truncation.mjs` | — | Analysis script for Telegram truncation risk. |
| `packages/telegram-bridge/src/board.js` | `RANK_DEFERRED`, `RANK_DEFERRED_URGENT`, `RANK_OTHER`, `RANK_TODAY`, `RANK_TODAY_URGENT`, `RANK_UNLISTED`, `boardIndex`, `boardRank`, `parseBoardOrder`, `taskIdFromCell` | Active-board parsing and ranking for digest order. |
| `packages/telegram-bridge/src/bridge.js` | `blockingAsk`, `createBridge`, `formatCollapsedTurn`, `formatDocLink`, `formatDocNotice`, `formatDocRetraction`, `formatForTelegramParts`, `hashNotice`, `hashTurn`, `retractedAsk`, `splitAsk`, `terminalStatus` | Bridge orchestration plus link-mode and Telegram message shaping. |
| `packages/telegram-bridge/src/completed.js` | `parseCompletedTaskIds` | Completed-board parser. |
| `packages/telegram-bridge/src/config.js` | `assertRunnable`, `loadConfig` | Environment and path resolution. |
| `packages/telegram-bridge/src/deepLink.js` | `buildTgMetaMarker`, `docHasBeenWritten`, `parseDocMeta`, `parseTgLink`, `parseTgMeta`, `telegramDeepLink`, `upsertTgMetaMarker` | Hidden journal markers for Telegram/deep-link and catch-up-doc bindings, plus the write-detector behind the doc-link gate. |
| `packages/telegram-bridge/src/deleted.js` | `parseDeletedTaskIds` | Reads planner sync tombstones. |
| `packages/telegram-bridge/src/digest.js` | `buildDigest`, `extractAsk`, `extractAskEntry`, `hashDigest` | Digest construction and ask extraction. |
| `packages/telegram-bridge/src/index.js` | `appendUserReply`, `assertRunnable`, `buildDigest`, `createBridge`, `createFsIo`, `createTelegramClient`, `emptyState`, `extractAsk`, `extractAskEntry`, `findTaskByTopic`, `hasAgentBlock`, `hashDigest`, `hashTurn`, `journalFilename`, `latestAgentTurn`, `loadConfig`, `loadState`, `parseTitle`, `saveState`, `taskIdFromFilename`, `topicName` | Public package surface. |
| `packages/telegram-bridge/src/io.js` | `createFsIo` | Filesystem adapter over journals and boards. |
| `packages/telegram-bridge/src/journal.js` | `AGENT_HEADER`, `FROM_AGENT`, `FROM_ME`, `SENTINEL_MARKER`, `TURN_END`, `agentBlockStatus`, `agentBlockText`, `appendUserReply`, `hasAgentBlock`, `journalFilename`, `latestAgentTurn`, `parseTitle`, `splitAtSentinel`, `taskIdFromFilename`, `topicName` | Journal parsing and reply append contract. |
| `packages/telegram-bridge/src/liveStatus.js` | `CANONICAL`, `digestStatus`, `liveJournalStatus`, `liveStatus`, `normaliseStatus`, `statusStampDate` | Recency-aware live-status arbitration. |
| `packages/telegram-bridge/src/routeReply.js` | `coalesceByTask`, `parseReplyRouting` | General-thread batched reply routing. |
| `packages/telegram-bridge/src/state.js` | `STATE_VERSION`, `bumpReplyCount`, `emptyState`, `findTaskByTopic`, `getReplyCount`, `getTask`, `loadState`, `saveState`, `setArchived`, `setDigestTopic`, `setDocLink`, `setDocLinkNoticeHash`, `setDocLinkVerified`, `setLastDigest`, `setLastPosted`, `setLastPostedContext`, `setLastPostedMessageIds`, `setOffset`, `setSuppressedHash`, `setTopic`, `setUserEngaged` | Durable bridge state. |
| `packages/telegram-bridge/src/telegramClient.js` | `createTelegramClient` | Telegram Bot API wrapper with deadlines and structured rate-limit errors. |
| `packages/telegram-bridge/src/telegramFormat.js` | `escapeHtml`, `extractLinks`, `mdToTelegramHtml` | Deterministic markdown-to-Telegram HTML conversion. |

</details>

## Principal mechanics

`packages/telegram-bridge/src/state.js` is the package's durable memory. It stores topic bindings, last-posted hashes, reply counters, digest hashes, doc-link message ids, and the `getUpdates` offset. The commentary matters: suppressed turns are stored in `suppressedHash`, not `lastPostedHash`, because a completed-task suppression is a pause, not proof the message was sent. Reply counters are monotonic because a boolean `userEngaged` answers the wrong question for message collapse.

`packages/telegram-bridge/src/journal.js` defines the journal contract the bridge reads and writes: `TURN_END` is a boundary, not visible content; `latestAgentTurn()` returns the newest `<!-- from: overnight-agent -->` entry or the managed block, whichever is later; `appendUserReply()` appends a dated `<!-- from: me -->` entry at the bottom. `packages/telegram-bridge/src/liveStatus.js` then corrects the frozen-header problem by arbitrating status by date, not by file position. `packages/telegram-bridge/src/digest.js` extracts an ask from the newest turn only, preferring explicit `Needs from you:` text over weaker fallbacks like `Next:`.

On the transport side, `packages/telegram-bridge/src/telegramClient.js` wraps every Bot API call in a deadline and surfaces `retry_after` as structured data, so a `429` becomes "wait and retry" instead of "crash and duplicate the first ten tasks on the next run." `packages/telegram-bridge/src/telegramFormat.js` keeps Telegram output inside its small HTML subset, converting unsupported structures into readable plain text or `<pre>` blocks.

`syncDocLink()` in `bridge.js` gates the first catch-up-doc link post on whether the doc has actually been written, not merely bound. `ensure-catchup-doc.mjs` creates a placeholder and binds it; the body is written only by the task's first wake afterwards, so posting on the binding event pointed 4 of 5 links in one measured run at an unwritten stub (issue #588). `deepLink.js`'s `docHasBeenWritten(content, docId)` strips the `<!-- doc-meta … -->` binding marker from the journal and checks whether the doc id still occurs elsewhere in the text — any other occurrence must post-date the binding, because the id is minted at bind time and `write-turn.ps1`'s G10 rule refuses a doc-bound turn that does not name its doc. This is deliberately derived from journal content rather than a `written_at` timestamp: the amend is an agent calling Google Docs tools directly, so recording a stamp there would be an instruction living in prose, which is exactly the failure class this design avoids. `mutcheck-doc-link-written.mjs` proves the gate is load-bearing with five arms plus an absence arm.

Once a link exists, `verifyLinkMessage()` returns a three-state result — `{present: true, verified: true}`, `{present: false, verified: true}`, or `{present: true, verified: false}` — instead of a bare boolean, because a probe that could not confirm anything used to look identical to one that confirmed the link was present, silently defeating the "verified, never assumed" guarantee (issue #586, also GH #424). The probe routes through `withRateLimitRetry` so a `429` is waited out rather than logged and treated as inconclusive. `state.setDocLinkVerified(state, taskId, at)` stamps `docLinkVerifiedAt` only on a genuine observation — never on an assumption — so the least-recently-verified links sort first. Probing every bound link every run would spend a whole rate-limit budget confirming things nobody asked about, so `selectProbeTargets()` bounds each run to `config.docLinkProbeBudget` links (default `12`), oldest-verified-first; a link outside this run's budget is `linkProbeDeferred`, counted separately from `linkUnverified` (probed but inconclusive), because collapsing "not yet due" and "verification failed" would recreate the same defect one layer up.

## Behavioural requirements from tests

The behavioural spec lives in `packages/telegram-bridge/src/bridge.test.js`, `board.test.js`, `completed.test.js`, `config.test.js`, `deepLink.test.js`, `deleted.test.js`, `digest.test.js`, `docLink.test.js`, `journal.test.js`, `liveStatus.test.js`, `pointerTurn.test.js`, `routeReply.test.js`, `state.test.js`, `telegramClient.test.js`, and `telegramFormat.test.js`.

- `syncUp` creates a topic and posts once, deduplicates by content hash, stamps `<!-- tg-meta ... -->` into the journal, honours allowlists, and skips journals with no agent block.
- Message collapse is conditional. A newer unanswered turn may replace the older one, but tests require the bridge never to delete a message the user replied to and never to lose carried links.
- Completed-task quieting is precise: tasks only on the completed board stay silent, dual-board tasks still post, and a user reply to a closed task buys exactly one answer before silence resumes.
- `syncArchive` closes topics for completed or explicitly deleted tasks, reopens them when a task returns to the active board, tolerates missing completed boards or sync records, and leaves per-topic failures non-fatal.
- `syncDown` folds topic replies into journals, advances the update offset, routes General-thread batched replies by known task ids, acknowledges off-topic General replies, and keeps going when one named journal is missing.
- `buildDigest` lists every open ask, ranks board urgency ahead of off-board or soft asks, stays within Telegram size limits, names overflow tasks instead of dropping them invisibly, and adds the privacy-mode warning only when the bot membership demands it.
- `liveStatus` normalises human status phrases such as `In progress`, dates a status line from the date segment it asserts about itself, and lets the newer of {turn, block} win.
- Link mode posts exactly one catch-up link in the steady state, restores it if the user deletes it, sends short exception notices for blocking asks or terminal states, updates notices in place when safe, refuses to infer a retraction the agent did not state, and defers the first post until `docHasBeenWritten` confirms the doc is no longer the placeholder.
- `createTelegramClient` must set request deadlines, extend `getUpdates` budgets for long poll timeouts, and mark rate-limit errors with structured `retryAfter` and `isRateLimit` fields.

## Failure modes

This domain guards against stale signal and ambiguous silence. Stale signal appears as a frozen status header, a superseded ask, an old per-turn Telegram message stacked under a newer one, or task-id ordering that buries what the user actually needs to see. Ambiguous silence appears when a deleted link message is mistaken for an unchanged steady state, when a completed-task suppression is mistaken for successful posting, or when an absent board row is mistaken for a deleted task. The implementation keeps choosing durable evidence—timestamps, tombstones, message ids, reply counters, topic ids—so the bridge can prove what happened instead of guessing.
