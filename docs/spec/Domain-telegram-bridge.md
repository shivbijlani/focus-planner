# Domain: telegram-bridge

## Responsibility

A dependency-free Node CLI (`packages/telegram-bridge`) that mirrors task journals into a Telegram
forum group — one task, one topic — and folds replies back into the journal they answer, so the
planner can be worked from a phone. It also posts a consolidated "waiting on you" approval digest,
because the per-topic mirror alone scatters every open question across as many topics as there are
active tasks.

## Principal modules

| Module | Role |
| --- | --- |
| `packages/telegram-bridge/src/bridge.js` | Orchestrates both directions (`syncUp`/`syncDown`) plus archive/digest; all I/O injected for offline testability. |
| `packages/telegram-bridge/src/board.js` | Parses `planner.md` so the digest can be ordered by the board's own priority signals, not by task-id magnitude (see [Prioritisation](Prioritisation)). |
| `packages/telegram-bridge/src/digest.js` | Builds the single consolidated approval-queue message, reading each task's **newest agent turn** for its open ask. |
| `packages/telegram-bridge/src/liveStatus.js` | Determines a task's live status from its newest turn rather than a frozen `**Status:**` header line that nothing rewrites once written (issue #202). |
| `packages/telegram-bridge/src/journal.js` | Pure journal parsing: turn boundaries, the turn-end stamp, status-line dialect tolerance. |
| `packages/telegram-bridge/src/deepLink.js` | Computes/reads the `<!-- tg-meta -->` marker mapping a journal to its forum topic. |
| `packages/telegram-bridge/src/routeReply.js` | Routes a batched, free-form General-thread reply ("merge 394, 386; go on 348") to the tasks it names. |
| `packages/telegram-bridge/src/completed.js`, `deleted.js` | Parse the completed board and the sync-record tombstones to decide which topics to archive. |
| `packages/telegram-bridge/src/telegramFormat.js` | Converts markdown to Telegram's limited HTML subset (no headings/lists/tables as block structure). |
| `packages/telegram-bridge/src/state.js` | Persistent topic/offset/dedup state, stored outside the repo and outside OneDrive. |

## Public surface (representative exports)

`createBridge, blockingAsk, terminalStatus, hashTurn, formatDocLink, formatDocNotice,
formatDocRetraction, formatCollapsedTurn, retractedAsk, splitAsk, formatForTelegramParts, hashNotice`
(`bridge.js`); `buildDigest, extractAsk,
extractAskEntry, hashDigest` (`digest.js`); `boardRank, boardIndex, parseBoardOrder` (`board.js`);
`liveStatus, digestStatus, normaliseStatus` (`liveStatus.js`); `latestAgentTurn, agentBlockStatus,
appendUserReply, hasAgentBlock` (`journal.js`); `parseReplyRouting, coalesceByTask` (`routeReply.js`);
`telegramDeepLink, upsertTgMetaMarker` (`deepLink.js`); `mdToTelegramHtml` (`telegramFormat.js`).

## Behavioural requirements (from tests)

- **The ask survives Telegram's 4,096-char cap** (issue #210): a long turn is split into balanced
  parts, none exceeding the cap, and the trailing ask is never truncated away; a split turn is not
  reposted on the next run.
- **A superseded turn is deleted and replaced, never stacked** (issue #205) — but only until the user
  has replied to it; once replied to, a turn is never deleted.
- **Rate limits never cause duplicate posts** (issue #172): a 429 mid-sweep resumes and posts each task
  exactly once across the crash/retry boundary; the server-advised `retry_after` is honored.
- **The digest reads the newest turn, never a whole-file grep** for the last `**Needs from you:**` line
  — a superseded ask restated in later prose without re-emitting the marker must not resurface (the
  "stale marker regression" fixture set, `digest.test.js`).
- **Status is read live, not from a frozen header** (issue #202): a task whose newest turn says `Done`
  must drop out of the digest even though its header block still says `blocked`, and vice versa for a
  reopened task — the fix may only ever *add* information, never override a genuinely-informative
  frozen header with nothing.
- **Board-aware digest ordering**: leads with the board's own urgency signals, sinks a malformed
  six-digit id or a task absent from the board entirely, and excludes a P0 whose only "ask" is the
  agent's own next step rather than something from the user.
- **Deletion is tracked explicitly, not inferred from absence** (issue #171/#174): a task on neither
  board is archived only if a sync record actually marks it `deleted: true`; a board that fails to
  parse must never be read as "everything on it was deleted."
- **A General-thread reply routes by known task id, never by coincidental digits** in the prose
  (dollar amounts, slot numbers, years) — an unroutable reply is reported, never silently discarded.
- **The catch-up-doc link replaces the per-turn post and stays quiet** across repeated unchanged runs
  (issue #424), updating in place rather than stacking a second notice when the ask changes.
- **A retraction corrects the notice in place; a resolution never touches it again** (issue #424): a
  resolved ask deliberately leaves its notice standing and forgets the message id — rewriting it later
  would rewrite history the user may already have acted on. A retraction (the turn explicitly states
  the ask no longer stands, never inferred from a dismissive or absent `Retracts` line) is different:
  the ask could not have been actionable, so leaving it stand is what would misrepresent history.
  `formatDocRetraction` edits the notice to show the original ask struck through above the reason,
  annotating rather than deleting; the message id is still forgotten afterwards, so a returning ask is
  still posted as a new message.
- **Turns stranded above a task's catch-up-doc link are collapsed in place, never deleted** (issues
  #483/#521): once a doc link is posted, earlier turns for that task are edited down to a one-line
  pointer (`formatCollapsedTurn`) rather than removed, because deleting the user's own messages sits on
  the agent-gate floor ("outcome can result in permanent data loss") and cannot legitimately fire even
  under an explicit approval. Collapsing is not data loss — the collapsed text is a mirror of a journal
  turn the bridge re-reads every run — so it needs no consent and defaults ON
  (`TELEGRAM_BRIDGE_COLLAPSE_BOUND`, off only for explicit `off`/`false`/`0`/`no`); the separate delete
  path (`TELEGRAM_BRIDGE_TIDY_BOUND`) is unchanged and unreachable in practice. Any links the original
  message carried are re-emitted in the pointer so they are not lost from the phone entirely; a message
  the user has replied to is frozen and never collapsed, and a message whose edit fails is remembered so
  a later run can retry it.

## Failure modes this domain guards against

- **A whole-file grep surfacing a stale ask** the newest turn already invalidated — this is the
  specific defect the "newest-turn-wins" contract in `digest.js`/`liveStatus.js` closes.
- **A reply typed instead of sent as a topic reply being silently discarded** — Telegram's bot-privacy
  mode only delivers replies, and `routeReply.js` exists because General-thread replies to the digest
  have no `message_thread_id` to route by.
- **A deleted task's topic staying open forever** — measured live at 139 deleted tasks, 101 still
  holding a topic, 65 of those still open, before `deleted.js` shipped.
- **`liveStatus.js` and its OA-side twin (`plugins/overnight-agent/checks/lib-live-status.mjs`)
  drifting apart** — they are deployed to two different runtimes (repo vs. flattened `%LOCALAPPDATA%`)
  so neither can import the other; `mutcheck-live-status-parity.mjs` pins them together and fails if
  they disagree on any fixture or live journal.
