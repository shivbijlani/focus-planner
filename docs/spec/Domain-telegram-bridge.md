# Domain: telegram-bridge

## Responsibility

An independent Node CLI/daemon that mirrors task journals into a Telegram forum group —
one topic per task — so the user can review agent progress and reply (approve, redirect,
answer a question) from a phone, without opening the planner app. It also posts a single
consolidated "waiting on you" digest across all open asks, and folds Telegram replies back
into the correct journal(s).

## Principal modules

| Module | Role |
| --- | --- |
| `packages/telegram-bridge/src/bridge.js` | Orchestrates `syncUp` (post each task's latest agent turn into its topic) and `syncDown` (fold replies back into journals). All I/O is injected so the flow is unit-testable offline. |
| `packages/telegram-bridge/bin/telegram-bridge.js` | The CLI entry point: `whoami`, `baseline`, `sync-up`, `sync-down`, `sync-archive`, `digest`, `once`, `watch [secs]`. |
| `packages/telegram-bridge/src/journal.js` | Pure journal parsing shared with the orchestration layer: title/turn extraction, agent-block detection, appending a user reply — no filesystem access, so it stays trivially testable. |
| `packages/telegram-bridge/src/digest.js` | Builds the consolidated approval-queue message, reading each task's ask from its **newest** agent turn only — never a whole-file grep, which could surface a stale, superseded ask. |
| `packages/telegram-bridge/src/board.js` | Orders the digest by the *active board*'s own Today/Deferred/urgency structure, not by task-ID magnitude, since ID order actively misranks malformed/legacy IDs above real priorities. |
| `packages/telegram-bridge/src/deleted.js` | Reads the planner's sync-sidecar tombstones to decide which forum topics correspond to tasks the user deleted (not merely completed), so a deleted task's topic can be closed. |
| `packages/telegram-bridge/src/routeReply.js` | Splits a single free-form reply typed in the group's General thread into per-task segments, so a batched answer like "merge 394, 386; go on 348" lands in each named task's journal. |
| `packages/telegram-bridge/src/telegramFormat.js` | Converts the agent's markdown into the small HTML subset Telegram's `parse_mode: HTML` supports (no block structure — headings collapse to bold, bullets become `• `). |
| `packages/telegram-bridge/src/deepLink.js` | Dependency-free (importable from both Node and the browser) helpers for the `tg-meta` marker that carries a task's chatId/threadId inside its journal. |
| `packages/telegram-bridge/src/state.js` | Persistent state: task-to-topic map, last-posted-turn hash, Telegram `getUpdates` offset — stored outside the synced planner folder. |
| `packages/telegram-bridge/src/config.js` | Loads bridge configuration from environment variables; the bot token is never read from a repo file, only from the OS credential vault via env. |

## Public exports (selected)

`bridge.js`: `createBridge`, `formatForTelegramParts`, `hashTurn`, `splitAsk`.
`digest.js`: `buildDigest`, `extractAsk`, `extractAskEntry`, `hashDigest`. `journal.js`:
`latestAgentTurn`, `hasAgentBlock`, `appendUserReply`, `parseTitle`, `topicName`,
`taskIdFromFilename`. `routeReply.js`: `parseReplyRouting`, `coalesceByTask`.
`state.js`: `emptyState`, `loadState`, `saveState`, `setTopic`, `setArchived`,
`setUserEngaged`. `telegramFormat.js`: `mdToTelegramHtml`, `escapeHtml`.

## Design decision: read the ask from the newest turn only, never a whole-file grep

`digest.js` documents the rejected alternative explicitly: grepping the whole journal
file for the last `**Needs from you:**` marker looks equivalent but is not, because a
journal is a bottom-appended chat thread and a later turn routinely restates a blocker in
prose without re-emitting the marker. A whole-file grep can then surface an ask an
already-superseded turn wrote, rebroadcasting a stale ask every night and training the
user to distrust the digest. `latestAgentTurn()` isolates the newest turn first, and every
ask extraction scans only inside it.

## Behavioural requirements (from tests)

- **`parseBoardOrder`/`boardRank`**: must map each task row to its section and position,
  detect urgency from either the 🔴 icon or an explicit `P0` marker, ignore header,
  separator, and the numbered `Priorities` list, tolerate a trailing HTML comment after
  the last pipe and CRLF line endings, keep the *first* position when a task is (wrongly)
  listed twice, and rank urgent-Today above ordinary-Today above urgent-Deferred above
  ordinary-Deferred, sinking anything not on the board at all to the bottom.
- **`syncUp`**: must create a topic and post a task's agent turn exactly once (dedup on
  repeat runs), must stamp a `tg-meta` marker into the journal for deep-linking, must skip
  journals with no agent block at all, and must honor an explicit task allow-list when
  configured.
- **Baseline**: running `baseline` must mark existing tasks as already-seen without
  creating topics or posting anything; after baseline, an unchanged task must still create
  no topic on the next `syncUp`, but a genuinely *new* agent turn must create the topic and
  post; baseline must never clobber a task that already has real posted history.
- **Duplicate-topic prevention**: if local state forgot a task's topic id, `syncUp` must
  reuse the topic id recorded in the journal's own `tg-meta` marker rather than creating a
  second topic.
- **`syncDown`**: must fold a topic reply into its journal and advance the Telegram
  offset; must ignore bot messages, replies to unmapped topics, and empty text; must route
  a General-thread reply to the specific tasks it names (via `parseReplyRouting`).
- **`parseCompletedTaskIds`**: must extract numeric IDs from completed rows across every
  weekly section, ignore header/separator rows, dedupe repeated IDs keeping first-seen
  order, return `[]` for empty/missing input, and handle CRLF line endings.
- **`parseDeletedTaskIds`**: must return only ids whose tombstone has `deleted` **strictly
  `true`** (not merely truthy), ignoring `deleted:false` or a missing flag; must dedupe ids
  seen in both board sidecars; must skip non-numeric ids; and must never throw or report a
  false deletion on junk/null input.
- **`loadConfig`**: `archiveCompleted` and `digestEnabled` must both default to on when
  their env var is unset, stay on for any affirmative value, and turn off only for an
  explicit case-insensitive `off`/`false`/`0`/`no` — the two flags must vary independently.
  `digestTopic` must default to the General thread when unset, keep a numeric topic id
  verbatim, trim a topic-name string, and treat a whitespace-only value as unset.
- **`telegramDeepLink`/`parseTgMeta`**: must build a private supergroup link by stripping
  the `-100` chat-id prefix, prefer a public username over a numeric chatId when both are
  present, link to the group root when there is no specific thread, and return an empty
  string when there is nothing to link to; `parseTgMeta` must tolerate unknown fields and
  quoting, and return `null` when no marker is present.
- **`extractAsk`**: must prefer an explicit ask marker, fall back through progressively
  weaker signals, fold multi-line continuations into a single-line ask, keep the real ask
  that follows a dismissive clause without mistaking the dismissal's tail for the ask
  itself, mark a boilerplate-salvaged ask as **weak** so callers can gate on confidence,
  and return `null` when a turn genuinely contains no ask.
- **`latestAgentTurn`**: must return the newest `from: overnight-agent` entry rather than
  an older plan block, must fall back to the plan block only when no chat turn exists yet,
  and must return `null` when there is no agent content at all.
- **`parseReplyRouting`**: must route the batched-reply shape the agent itself asks users
  for, treat newlines as segment separators (so bullet-list replies work), fold each
  segment's text **verbatim** (never paraphrase an approval), ignore numbers that are not
  known task IDs (so ordinary prose numbers are not misread as routing targets), and
  return `[]` — a meaningful "no known task mentioned" signal — for input naming nothing
  recognizable.
- **`telegramClient` request deadlines**: every request must carry an `AbortSignal` so a
  stalled call cannot hang forever, and a `getUpdates` long-poll request's budget must be
  extended by the poll window rather than being aborted early — but must still abort once
  even that extended budget expires.
- **`mdToTelegramHtml`**: must convert bold/italic without leaving literal asterisks,
  render inline code and fenced code blocks (even an unterminated fence) safely, turn
  headings into a bold line and bullets into `• ` while keeping numbered items, turn only
  real-scheme links into anchors (relative links degrade to plain text), escape stray
  HTML-significant characters in prose, and drop horizontal rules (Telegram HTML has no
  block structure to render them with).

## Failure modes

- Truncating a turn to fit Telegram's 4,096-character cap risks cutting off exactly the
  `Needs from you:`/`Your call:` ask, since agent turns place the ask at the end — the
  formatter must split rather than blindly truncate.
- Deciding a topic's archive state purely from "is this id on the completed board" cannot
  express deletion, since a deleted task leaves *both* boards — this is why archival also
  consults the sync sidecar's explicit `deleted: true` tombstone via
  `packages/telegram-bridge/src/deleted.js`, rather than treating board-absence as
  sufficient evidence.
- A rate-limited run that loses its in-memory state before persisting risks re-posting
  every message on retry — `state.js` persisting `lastPostedHash` and `updateOffset`
  durably (not just in memory) is what keeps a crash-and-retry idempotent instead of a
  duplicate flood.
