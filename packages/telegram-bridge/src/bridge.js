// Orchestrates the two directions of the bridge:
//   syncUp   — post each task's latest agent turn into its forum topic
//   syncDown — fold Telegram replies back into the task journals
// All I/O is injected (client + io) so the flow is unit-testable offline.

import { createHash } from 'crypto'
import {
  hasAgentBlock,
  latestAgentTurn,
  agentBlockText,
  agentBlockStatus,
  parseTitle,
  topicName,
  appendUserReply,
} from './journal.js'
import {
  getTask,
  setTopic,
  setLastPosted,
  setLastPostedMessageIds,
  setLastPostedContext,
  bumpReplyCount,
  getReplyCount,
  setSuppressedHash,
  setArchived,
  setUserEngaged,
  setOffset,
  setLastDigest,
  setDigestTopic,
  findTaskByTopic,
} from './state.js'
import { extractAskEntry, buildDigest, hashDigest } from './digest.js'
import { upsertTgMetaMarker, parseTgMeta } from './deepLink.js'
import { mdToTelegramHtml, escapeHtml, extractLinks } from './telegramFormat.js'
import { parseCompletedTaskIds } from './completed.js'
import { parseDeletedTaskIds } from './deleted.js'
import { parseBoardOrder, boardRank, boardIndex } from './board.js'
import { parseReplyRouting, coalesceByTask } from './routeReply.js'

const TELEGRAM_MAX = 4096

// Rate-limit handling (#172). A 429 is a pause, not a failure -- but an unbounded
// wait would be its own hang, so both the number of attempts and each individual
// wait are capped, and the no-`retry_after` path backs off exponentially rather
// than assuming the field is there.
const RATE_LIMIT_MAX_RETRIES = 5
const RATE_LIMIT_BASE_WAIT_MS = 2000
const RATE_LIMIT_MAX_WAIT_MS = 90000

// Injectable so tests never actually wait. Overridden via globalThis in the
// suite; production always gets the real timer.
const sleep = (ms) =>
  typeof globalThis.__telegramBridgeSleep === 'function'
    ? globalThis.__telegramBridgeSleep(ms)
    : new Promise((resolve) => setTimeout(resolve, ms))

// A turn longer than one message is SPLIT rather than truncated (see
// `formatForTelegramParts`). Cap the split so a very long turn can't carpet-bomb
// the phone with messages; past this we trim the middle and keep the ask.
const MAX_PARTS = 3

// Room to reserve in the header for the " (2/3)" part counter, so the budget we
// chunk against is still right once the counter is added.
const PART_COUNTER_RESERVE = 12

// The trailing block an agent turn ends with — the part the reader is actually
// supposed to act on. `Needs from you:` / `Your call:` come from the SKILL.md
// block template; `Next:` is the weaker fallback used by Run log entries.
const ASK_STRONG_RE = /^\s*\*{0,2}\s*(?:Needs from you|Your call)\b/i
const ASK_WEAK_RE = /^\s*\*{0,2}\s*Next\b/i

// Block statuses that are finished as far as the user is concerned. A task in
// one of these must never be pulled back into the approval queue by the
// agent-block fallback in syncDigest().
const DIGEST_TERMINAL_STATUS = new Set(['done', 'skip', 'skipped', 'complete', 'completed'])

export function hashTurn(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

// Split a turn into [body, ask], where `ask` is the trailing ask block.
//
// Anchored on the LAST strong marker rather than the first, because `Next:`
// (and occasionally `Needs from you:`) also appear inside earlier Run log
// entries — anchoring on the first would classify most of the turn as "the ask"
// and defeat the point. When both strong markers are present we start at the
// earlier of the two final pair so `Needs from you:` and `Your call:` travel
// together. Returns `ask === ''` when the turn has no ask at all.
export function splitAsk(turn) {
  const text = String(turn == null ? '' : turn)
  const lines = text.split('\n')
  let lastNeeds = -1
  let lastCall = -1
  let lastWeak = -1
  for (let i = 0; i < lines.length; i++) {
    if (ASK_STRONG_RE.test(lines[i])) {
      if (/needs from you/i.test(lines[i])) lastNeeds = i
      else lastCall = i
    } else if (ASK_WEAK_RE.test(lines[i])) lastWeak = i
  }

  let start = -1
  if (lastNeeds >= 0 && lastCall >= 0) start = Math.min(lastNeeds, lastCall)
  else if (lastNeeds >= 0) start = lastNeeds
  else if (lastCall >= 0) start = lastCall
  else start = lastWeak

  if (start < 0) return { body: text, ask: '' }
  return {
    body: lines.slice(0, start).join('\n').replace(/\s+$/, ''),
    ask: lines.slice(start).join('\n').trim(),
  }
}

// Greedily pack whole markdown lines into chunks whose CONVERTED HTML fits
// `room`. Converting per chunk is what keeps each one tag-balanced:
// `mdToTelegramHtml` is line-based and closes <pre>/<blockquote> itself, so a
// chunk boundary can never fall inside a tag.
//
// A single line longer than `room` on its own is a degenerate case (a giant
// table row); it gets hard-trimmed rather than looping forever.
function chunkMarkdown(md, room) {
  const lines = String(md).split('\n')
  const chunks = []
  let current = []

  const htmlLen = (arr) => mdToTelegramHtml(arr.join('\n')).length

  for (const line of lines) {
    if (current.length === 0) {
      // A lone over-long line can't be packed with anything; shrink it directly.
      if (htmlLen([line]) > room) {
        let cut = line
        while (cut.length > 0 && mdToTelegramHtml(cut).length > room) {
          cut = cut.slice(0, Math.max(0, Math.floor(cut.length * 0.9) - 1))
        }
        chunks.push(cut)
        continue
      }
      current.push(line)
      continue
    }
    if (htmlLen([...current, line]) > room) {
      chunks.push(current.join('\n'))
      current = []
      if (htmlLen([line]) > room) {
        let cut = line
        while (cut.length > 0 && mdToTelegramHtml(cut).length > room) {
          cut = cut.slice(0, Math.max(0, Math.floor(cut.length * 0.9) - 1))
        }
        chunks.push(cut)
        continue
      }
      current.push(line)
      continue
    }
    current.push(line)
  }
  if (current.length) chunks.push(current.join('\n'))
  return chunks.filter((c) => c.trim() !== '')
}

// Build the message(s) for one agent turn: a bold task header + the turn
// rendered as Telegram HTML, always tag-balanced, and NEVER missing the ask.
//
// History, because two separate bugs lived here:
//
// 1. A raw `msg.slice(...)` used to cut the generated HTML at an arbitrary
//    character, landing inside a tag. Telegram rejected the whole message
//    (`can't parse entities: Can't find end tag corresponding to start tag "b"`)
//    and the send silently downgraded to plain text, losing ALL formatting.
//    Fixed by only ever cutting markdown at a LINE boundary, where
//    `mdToTelegramHtml` guarantees balance.
//
// 2. That fix still kept a PREFIX of the turn — and an agent turn puts its ask
//    (`Needs from you:` / `Your call:`) at the END. So on any turn over the cap,
//    the one part the reader is supposed to act on was exactly the part thrown
//    away. Measured across 239 live journals: 55 turns truncated, 33 of them
//    with the ask silently deleted. On the surface he actually reads, those
//    tasks looked like commentary rather than a question. (GH #210.)
//
// So: SPLIT instead of truncate. The turn is chunked at line boundaries into up
// to MAX_PARTS messages posted in order to the same topic. If it still doesn't
// fit, the body is trimmed — but the ask is carried onto the final part with an
// explicit "trimmed" marker, so an ask is never silently dropped.
export function formatForTelegramParts(taskId, title, turn) {
  const base = title
    ? `\u{1F4CB} Task #${taskId} \u2014 ${title}`
    : `\u{1F4CB} Task #${taskId}`
  const headerFor = (part, total) =>
    `<b>${escapeHtml(total > 1 ? `${base} (${part}/${total})` : base)}</b>`

  // Budget for a single-message post.
  const roomOne = Math.max(0, TELEGRAM_MAX - headerFor(1, 1).length - 2)
  const wholeHtml = mdToTelegramHtml(turn)
  if (wholeHtml.length <= roomOne) return [`${headerFor(1, 1)}\n\n${wholeHtml}`]

  // Multi-part: the header now carries a counter, so budget against that.
  const room = Math.max(0, TELEGRAM_MAX - headerFor(1, 1).length - PART_COUNTER_RESERVE - 2)
  const { body, ask } = splitAsk(turn)

  let chunks = chunkMarkdown(turn, room)

  if (chunks.length > MAX_PARTS) {
    // Too long even when split. Give the ask the LAST parts and the body what is
    // left, so the thing the reader must act on always arrives.
    //
    // Subtlety worth keeping: the ask block itself can exceed one message (a turn
    // whose ask is a checklist — #272's is 7.8k chars). Keep the ask's OPENING
    // chunks, not its closing ones: `**Needs from you:**` is the first line of
    // the block, so trimming from the front deletes the very marker that makes it
    // an ask. A first cut of this did exactly that and still lost #272 and #437.
    const trimmedNote = '\u2702\ufe0f *Trimmed for Telegram \u2014 full text is in the journal.*'
    const askChunks = ask
      ? chunkMarkdown(`${trimmedNote}\n\n${ask}`, room)
      : [trimmedNote]
    // Always leave at least one part for the body.
    const askKeep = askChunks.slice(0, Math.max(1, Math.min(askChunks.length, MAX_PARTS - 1)))
    const headKeep = chunkMarkdown(body, room).slice(0, Math.max(0, MAX_PARTS - askKeep.length))
    chunks = [...headKeep, ...askKeep]
  }

  const total = chunks.length
  return chunks.map((c, i) => `${headerFor(i + 1, total)}\n\n${mdToTelegramHtml(c)}`)
}

// Plain-text fallback (no parse_mode) for the rare case Telegram rejects our
// HTML — delivery of the content matters more than the formatting.
function formatPlain(taskId, title, turn) {
  const header = title
    ? `\u{1F4CB} Task #${taskId} \u2014 ${title}`
    : `\u{1F4CB} Task #${taskId}`
  const body = `${header}\n\n${turn}`
  return body.length > TELEGRAM_MAX ? body.slice(0, TELEGRAM_MAX - 1) + '\u2026' : body
}

export function createBridge({
  client,
  config,
  state,
  io,
  logger = () => {},
  now = () => new Date(),
  // Called after each unit of durable progress (a posted turn, a folded reply).
  // Default is a no-op so every existing caller and test is unaffected.
  //
  // Why this exists (#172): `saveState` ran ONCE, after `syncOnce()` resolved.
  // `setLastPosted` only mutates memory, so anything that threw mid-loop -- a
  // rate limit being the common case -- meant that write never happened and
  // every task already posted looked unposted next run. A 14-task sweep that
  // died on task 11 re-posted the first 10. Nothing was lost; it just arrived
  // twice, on his phone.
  //
  // Checkpointing after each post makes an interrupted run resumable instead of
  // repeatable. A failed checkpoint is deliberately non-fatal: the post itself
  // already succeeded, and losing the run over a bookkeeping write would be a
  // worse outcome than the duplicate it prevents.
  persist = null,
} = {}) {
  const { chatId, taskAllowlist } = config

  async function checkpoint(label) {
    if (typeof persist !== 'function') return
    try {
      await persist(state)
    } catch (err) {
      logger(`could not checkpoint state after ${label} (${err.message})`)
    }
  }

  // Telegram's group budget is roughly 20 messages/minute, and a 429 tells us
  // exactly how long to wait. Waiting it out turns a run-killing error into a
  // pause; the alternative -- which is what happened -- is that the run dies and
  // the retry duplicates everything it had already delivered.
  //
  // Bounded on both axes so a pathological `retry_after` cannot hang a run: at
  // most RATE_LIMIT_MAX_RETRIES attempts, each capped at RATE_LIMIT_MAX_WAIT_MS.
  // If `retry_after` is absent the fallback is exponential, so behaviour
  // degrades safely rather than depending on the field being present.
  async function withRateLimitRetry(label, fn) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn()
      } catch (err) {
        if (!err || !err.isRateLimit || attempt >= RATE_LIMIT_MAX_RETRIES) throw err
        const advised = Number.isFinite(err.retryAfter) ? err.retryAfter * 1000 : null
        const backoff = advised != null ? advised : RATE_LIMIT_BASE_WAIT_MS * 2 ** attempt
        const waitMs = Math.min(backoff, RATE_LIMIT_MAX_WAIT_MS)
        logger(
          `rate limited on ${label}; waiting ${Math.round(waitMs / 1000)}s ` +
            `(attempt ${attempt + 1}/${RATE_LIMIT_MAX_RETRIES}` +
            `${advised != null ? ', server-advised' : ', no retry_after — backing off'})`,
        )
        await sleep(waitMs)
      }
    }
  }

  function isAllowed(taskId) {
    return taskAllowlist.length === 0 || taskAllowlist.includes(taskId)
  }

  async function ensureTopic(taskId, title) {
    const existing = getTask(state, taskId)
    if (existing && existing.topicId != null) return existing.topicId
    const name = topicName(taskId, title)
    // Creating a topic spends the same group quota as sending, and a new task
    // costs TWO calls (create + send) -- which is why a sweep with several new
    // topics hits the limit sooner than its task count suggests (#172).
    const result = await withRateLimitRetry(`createForumTopic task #${taskId}`, () =>
      client.createForumTopic({ chatId, name }),
    )
    const topicId = result.message_thread_id
    setTopic(state, taskId, topicId, name)
    logger(`created topic ${topicId} for task #${taskId}`)
    return topicId
  }

  // The set of task IDs currently on the completed board, read at most once per
  // run. Returns null when the board can't be read, which callers treat as "no
  // suppression" so a missing board never silences the mirror.
  let completedIds
  async function loadCompletedIds() {
    if (completedIds !== undefined) return completedIds
    if (typeof io.readCompletedBoard !== 'function') {
      completedIds = null
      return completedIds
    }
    try {
      completedIds = new Set(parseCompletedTaskIds(await io.readCompletedBoard()))
    } catch (err) {
      logger(`could not read completed board (${err.message}); posting to all tasks`)
      completedIds = null
    }
    return completedIds
  }

  // The set of task IDs currently on the ACTIVE board (planner.md), read at most
  // once per run. Returns null when the board can't be read.
  //
  // This exists because "is on the completed board" was being used as a synonym
  // for "is finished", and it isn't: a row can sit on BOTH boards at once. The
  // planner's sync layer produces exactly that (`clock:0` rows are, in the
  // board-integrity sweep's words, "primed to double-list"), and five live tasks
  // were in that state. For them the completed guard fired on a task the user
  // was actively working, so the mirror went silent on a live conversation.
  //
  // Active membership WINS: a task the user still has on their board is not
  // finished, whatever the completed board also says.
  let activeIds
  async function loadActiveIds() {
    if (activeIds !== undefined) return activeIds
    if (typeof io.readBoard !== 'function') {
      activeIds = null
      return activeIds
    }
    try {
      const board = parseBoardOrder(await io.readBoard())
      // An empty board is indistinguishable from an unreadable one here, and
      // treating "no rows" as "nothing is active" would suppress every
      // completed-board task on a transient read failure. Fall back to null
      // (= no active-board signal) instead.
      activeIds = board.size > 0 ? new Set(board.keys()) : null
    } catch (err) {
      logger(`could not read active board (${err.message}); using completed board alone`)
      activeIds = null
    }
    return activeIds
  }

  // Is this task finished, for the purposes of staying quiet? Only when the
  // completed board lists it AND the active board does not.
  function isFinished(completed, active, taskId) {
    if (!completed || !completed.has(taskId)) return false
    if (active && active.has(taskId)) return false // dual-board: still live
    return true
  }

  async function syncUp() {
    const posted = []
    const created = []
    const suppressed = []
    const journals = await io.listJournals()
    const completed = await loadCompletedIds()
    const active = await loadActiveIds()

    for (const { taskId } of journals) {
      if (!isAllowed(taskId)) continue
      const content = await io.readJournal(taskId)
      if (!hasAgentBlock(content)) continue

      const turn = latestAgentTurn(content)
      if (!turn) continue

      const hash = hashTurn(turn)
      const task = getTask(state, taskId)

      // Natural, incremental mirroring: only act when there's a NEW agent turn
      // since we last posted for this task. If nothing changed, skip the task
      // ENTIRELY — no topic is created — so the bridge never mass-backfills
      // historical tasks the moment it starts running. Existing tasks are marked
      // as already-seen up front by `baseline` (run once), so their first topic
      // is created only when the agent next writes to them.
      if (task && task.lastPostedHash === hash) continue

      // A task that has reached the completed board is finished, and the user
      // should not hear about it again. Posting was previously gated ONLY on the
      // turn hash changing, which made it fire for reasons that have nothing to
      // do with the task being worked: any maintenance edit to an old journal
      // (reformatting a marker, repairing a block so the digest can parse it)
      // changes the parsed turn and therefore re-posted a months-old entry into
      // a closed topic. syncArchive() closes those topics, but the bot is a group
      // ADMIN and Telegram lets admins post into closed topics — so the message
      // landed anyway and the topic resurfaced, looking exactly like the agent
      // had started working a task the user had already closed.
      //
      // `isFinished` requires the task to be absent from the ACTIVE board too: a
      // dual-board row is still live and must post normally (#186).
      //
      // Record the declined hash in `suppressedHash`, NOT `lastPostedHash`.
      // Writing it to `lastPostedHash` marked an unsent turn as sent, and the
      // unchanged-turn check above fires first — so the turn could never be
      // delivered afterwards, even once the task became eligible. Suppression is
      // a pause, not a delete.
      if (isFinished(completed, active, taskId) && !(task && task.userEngaged)) {
        if (!task || task.suppressedHash !== hash) {
          setSuppressedHash(state, taskId, hash)
          logger(`suppressed post for completed task #${taskId} (no user reply since it closed)`)
        }
        suppressed.push(taskId)
        continue
      }

      // Adopt an existing topic id from the journal's own tg-meta marker when our
      // local state has forgotten it. state.json is machine-local and can be lost
      // or reset, but the marker travels with the cloud-synced journal and is the
      // durable record of "this task already has topic N". Reusing it here is what
      // prevents creating a DUPLICATE forum topic after a state reset.
      if (!task || task.topicId == null) {
        const meta = parseTgMeta(content)
        const existingThread = meta && `${meta.threadId}`.trim() !== '' ? Number(meta.threadId) : null
        if (existingThread != null && !Number.isNaN(existingThread)) {
          setTopic(state, taskId, existingThread, topicName(taskId, parseTitle(content)))
        }
      }

      const current = getTask(state, taskId)
      const hadTopic = current && current.topicId != null
      const title = parseTitle(content)
      const topicId = await ensureTopic(taskId, title)
      if (!hadTopic) created.push(taskId)

      // Stamp a hidden tg-meta marker into the journal so the planner web app
      // can build a deep link to this topic (the topic id lives only in our
      // local state.json otherwise). Only write when it actually changes so we
      // don't rewrite the file on every sync.
      const withMeta = upsertTgMetaMarker(content, { chatId, threadId: topicId })
      if (withMeta !== content) {
        await io.writeJournal(taskId, withMeta)
      }

      // Post the turn as one message, or as an ordered run of parts when it is
      // too long for one. `setLastPosted` runs only after the whole run is sent,
      // so a mid-run failure retries the turn rather than recording it as done;
      // and the plain-text fallback is per-part, so one rejected part never
      // costs the rest of the turn.
      //
      // COLLAPSE (#205): if our own previous turn for this task is still the last
      // thing in the topic and the user has NOT replied to it, that turn is
      // superseded and gets deleted once this one is safely out. Shiv's words:
      // "if I haven't responded, assume it's unread and can be clobbered."
      //
      // TWO gates, and each closes a way #205 was lossy in practice (#278):
      //
      // 1. THE BOUNDARY. `userEngaged` used to stand in for "has the user
      //    replied?" and it is the wrong signal: it is consumed by ANY post,
      //    including one authored before the user's message existed. The mirror
      //    runs sync-down then once in a single pass, so that is the normal
      //    case, not an edge case — the fold sets the flag and the very next
      //    post clears it without having answered anything. `replyCount` cannot
      //    be consumed by posting, so comparing it against the value captured
      //    when those ids went out asks the real question: has a reply landed
      //    SINCE? It is also stable, which is what #278's observation 2 (same
      //    task, no reply, collapse then no collapse) was missing.
      //
      // 2. LOSSLESSNESS. Collapse assumes the new turn says everything the old
      //    one did. When that is false the deletion is unrecoverable — it cost a
      //    YouTube link the replacement never carried forward. So if the turn
      //    being replaced holds a link this one does not, it is kept. Stacking
      //    is a cosmetic regression; a deleted link is lost content.
      //
      // `userEngaged` is left alone: it is load-bearing for a different job
      // (letting a closed task deliver one answer per user message) and
      // consuming it there is correct. It is still read here as a THIRD, purely
      // conservative freeze — it can only ever prevent a collapse, never cause a
      // wrong one, and it is what keeps pre-existing state (written before
      // `replyCount` existed, so it reads 0 === 0) safe across the upgrade.
      const repliesNow = getReplyCount(state, taskId)
      const repliesAtPost = task && Number.isInteger(task.lastPostedReplyCount)
        ? task.lastPostedReplyCount
        : 0
      const userSpokeSincePost = repliesNow !== repliesAtPost || !!(task && task.userEngaged)

      const turnLinks = extractLinks(turn)
      const priorLinks = task && Array.isArray(task.lastPostedLinks) ? task.lastPostedLinks : []
      const droppedLinks = priorLinks.filter((l) => !turnLinks.includes(l))

      const canCollapse =
        !!task &&
        !userSpokeSincePost &&
        !droppedLinks.length &&
        Array.isArray(task.lastPostedMessageIds)
      const supersedes = canCollapse ? task.lastPostedMessageIds : []

      if (task && Array.isArray(task.lastPostedMessageIds) && task.lastPostedMessageIds.length) {
        if (userSpokeSincePost) {
          logger(
            `not collapsing task #${taskId}: a reply was folded since that turn was posted ` +
              `(${repliesAtPost} -> ${repliesNow})`,
          )
        } else if (droppedLinks.length) {
          logger(
            `not collapsing task #${taskId}: the new turn drops ${droppedLinks.length} link(s) ` +
              `the previous one carried (${droppedLinks.join(', ')})`,
          )
        }
      }

      const parts = formatForTelegramParts(taskId, title, turn)
      const postedIds = []
      for (const [index, text] of parts.entries()) {
        try {
          const sent = await withRateLimitRetry(`sendMessage task #${taskId}`, () =>
            client.sendMessage({
              chatId,
              text,
              messageThreadId: topicId,
              parseMode: 'HTML',
            }),
          )
          if (sent && Number.isInteger(sent.message_id)) postedIds.push(sent.message_id)
        } catch (err) {
          // The plain-text fallback exists for ONE failure: Telegram rejecting
          // our HTML (an unexpected entity). It is exactly wrong for a rate
          // limit -- it spends another call against the same exhausted quota,
          // and it used to have no catch of its own, so the second 429
          // propagated and killed the run (#172). A 429 has already been waited
          // out and retried above by the time it reaches here, so re-sending is
          // pointless as well as harmful: let it stop this task, and keep the
          // ids already posted.
          if (err && err.isRateLimit) throw err
          logger(
            `HTML send failed for task #${taskId} part ${index + 1}/${parts.length} ` +
              `(${err.message}); retrying as plain text`,
          )
          const sent = await withRateLimitRetry(`sendMessage (plain) task #${taskId}`, () =>
            client.sendMessage({
              chatId,
              text: formatPlain(
                taskId,
                parts.length > 1 ? `${title} (${index + 1}/${parts.length})` : title,
                turn,
              ),
              messageThreadId: topicId,
            }),
          )
          if (sent && Number.isInteger(sent.message_id)) postedIds.push(sent.message_id)
        }
      }

      // Strictly AFTER the new turn is out. Deleting first would open a window in
      // which the topic contains neither turn, and a crash in between would leave
      // the user with nothing rather than with a duplicate. A failed delete is a
      // cosmetic regression to the old stacking behaviour; a failed post after a
      // successful delete is lost content.
      if (supersedes.length && typeof client.deleteMessage === 'function' && postedIds.length) {
        let removed = 0
        for (const messageId of supersedes) {
          try {
            await client.deleteMessage({ chatId, messageId })
            removed++
          } catch (err) {
            // Older than Telegram's 48h delete window, already gone, or lacking
            // rights. Never fatal: the worst case is the stacked message Shiv
            // was already seeing before this existed.
            logger(`could not collapse superseded message ${messageId} for task #${taskId} (${err.message})`)
          }
        }
        if (removed) logger(`collapsed ${removed} superseded message(s) for task #${taskId}`)
      }

      setLastPostedMessageIds(state, taskId, postedIds)
      // Capture the boundary alongside the ids, in the same step, so the two can
      // never disagree: a later collapse of THESE ids is allowed only while the
      // reply count still reads what it read here, and only while the turn that
      // replaces them still carries these links.
      setLastPostedContext(state, taskId, {
        replyCount: repliesNow,
        links: turnLinks,
      })
      setLastPosted(state, taskId, hash)
      // The pending-suppression marker has served its purpose once the turn is
      // out; clearing it keeps state from carrying a stale "we owe this task a
      // post" flag forever.
      if (task && task.suppressedHash) setSuppressedHash(state, taskId, null)
      // Consume the engagement: the user's message has now been answered. A
      // closed task therefore delivers one agent turn per user reply and then
      // goes quiet again, instead of the flag latching it permanently open.
      if (task && task.userEngaged) setUserEngaged(state, taskId, false)
      posted.push(taskId)
      logger(
        `posted task #${taskId} to topic ${topicId}` +
          (parts.length > 1 ? ` in ${parts.length} parts` : ''),
      )
      // Durable progress. Everything above is now on the user's phone, so the
      // fact of it must survive whatever happens to the rest of this loop.
      await checkpoint(`task #${taskId}`)
    }

    return { posted, created, suppressed }
  }

  async function syncDown() {
    const folded = []
    const unrouted = []
    const offset = state.updateOffset > 0 ? state.updateOffset : undefined
    const updates = await client.getUpdates({
      offset,
      allowedUpdates: ['message'],
    })

    // Only paid for when an off-topic reply actually shows up.
    let knownTaskIds = null
    const loadKnownTaskIds = async () => {
      if (!knownTaskIds) knownTaskIds = (await io.listJournals()).map((j) => j.taskId)
      return knownTaskIds
    }

    let maxUpdateId = state.updateOffset - 1
    for (const update of updates) {
      if (update.update_id > maxUpdateId) maxUpdateId = update.update_id
      const msg = update.message
      if (!msg) continue
      if (msg.from && msg.from.is_bot) continue
      const text = msg.text
      if (!text || !text.trim()) continue
      // Ignore the service message that opens a forum topic.
      if (msg.forum_topic_created) continue

      // A reply inside a task's topic is unambiguous — it answers that task.
      const topicTaskId =
        msg.message_thread_id != null ? findTaskByTopic(state, msg.message_thread_id) : null

      // Otherwise it's an answer to a cross-task digest (General, or a topic we
      // don't own). Previously these were dropped silently; now we route by the
      // task IDs named in the text. See routeReply.js.
      const routed = topicTaskId
        ? [{ taskId: topicTaskId, text }]
        : coalesceByTask(parseReplyRouting(text, { knownTaskIds: await loadKnownTaskIds() }))

      if (!routed.length) {
        // Nothing to file, but the user did say something — surface it instead
        // of pretending it never arrived.
        unrouted.push({ text, messageId: msg.message_id, threadId: msg.message_thread_id ?? null })
        logger(`could not route reply: ${text.slice(0, 80)}`)
        continue
      }

      const day = now().toISOString().slice(0, 10)
      for (const entry of routed) {
        let content
        try {
          content = await io.readJournal(entry.taskId)
        } catch {
          content = null
        }
        if (content == null) {
          // A named task with no journal file yet: don't lose the answer.
          unrouted.push({
            text: entry.text,
            messageId: msg.message_id,
            threadId: msg.message_thread_id ?? null,
          })
          logger(`no journal for task #${entry.taskId}; reply left unrouted`)
          continue
        }
        const updated = appendUserReply(content, { text: entry.text, date: day })
        await io.writeJournal(entry.taskId, updated)
        // The user has spoken about this task, so it is a live conversation even
        // if the task itself is closed. Without this, the completed-board guard
        // in syncUp would swallow the agent's reply and the user would be left
        // asking a question into a topic that never answers.
        setUserEngaged(state, entry.taskId, true)
        // The collapse boundary (#278). Separate from `userEngaged` on purpose:
        // this one is never consumed by a post, so "the user has spoken since
        // that turn went out" stays true until a turn is actually posted after
        // the reply — which is the only point at which the turn above it stops
        // being frozen.
        bumpReplyCount(state, entry.taskId)
        folded.push({ taskId: entry.taskId, text: entry.text })
        logger(`folded reply into task #${entry.taskId}`)
      }

      // Close the loop: a batched answer is worthless if the user can't tell it
      // registered. Ack only off-topic replies — inside a task topic the next
      // agent turn is itself the confirmation.
      if (!topicTaskId) {
        await acknowledge(msg, routed)
      }
    }

    if (updates.length) setOffset(state, maxUpdateId + 1)
    // The replies are already written into the journals at this point. If the
    // offset advance is not persisted, the next run re-reads and re-folds the
    // same updates, so checkpoint here too rather than only at the end.
    if (folded.length || updates.length) await checkpoint('syncDown')
    return { folded, unrouted }
  }

  // Best-effort receipt for a batched reply. Never let a failed ack abort the
  // run — the answers are already safely in the journals by this point.
  async function acknowledge(msg, routed) {
    const filed = routed.map((r) => `#${r.taskId}`).join(', ')
    try {
      await client.sendMessage({
        chatId,
        text: `\u2705 Filed to ${filed} \u2014 I'll pick these up on the next run.`,
        messageThreadId: msg.message_thread_id ?? undefined,
        replyToMessageId: msg.message_id,
      })
    } catch (err) {
      logger(`ack failed: ${err.message}`)
    }
  }

  async function syncOnce() {
    const up = await syncUp()
    const archived = await syncArchive()
    const down = await syncDown()
    // Digest goes LAST so it reflects the turns just posted, and so a failure
    // to compose it can never prevent the mirroring/fold-back work above from
    // being persisted.
    let digest = { posted: false, count: 0 }
    if (config.digestEnabled === false) {
      logger('digest disabled (TELEGRAM_BRIDGE_DIGEST=off); General thread left alone')
      digest = { posted: false, count: 0, skipped: true }
    } else {
      try {
        digest = await syncDigest()
      } catch (err) {
        logger(`digest failed (${err.message}); continuing`)
      }
    }
    return { up, archived, down, digest }
  }

  // Archive/unarchive task topics to mirror the board. A task that has moved to
  // planner-completed.md — OR that the user DELETED in the app — gets its forum
  // topic CLOSED (Telegram's reversible "archive": it collapses under the
  // group's Closed section and stops new non-admin posts). A task that later
  // leaves the completed board (reopened) gets its topic REOPENED. Both
  // directions are idempotent — we only call Telegram when the desired
  // archived-state differs from what we recorded, so re-runs are no-ops. A
  // per-topic failure (e.g. the bot lacks can_manage_topics) is logged and
  // skipped; it never aborts the run and is retried next time.
  //
  // Deleted tasks are included because a deletion removes the row from BOTH
  // boards, so `completed.has(id)` is false for them forever and their topics
  // used to stay open permanently. On the live planner that had accumulated 65
  // still-open topics for tasks that no longer exist.
  async function syncArchive() {
    const archived = []
    const reopened = []
    // Gated on the "Archive completed topics" setting (default on). When the
    // user turns it off we neither read the board nor touch any topic.
    if (config.archiveCompleted === false) return { archived, reopened, skipped: true }
    if (typeof io.readCompletedBoard !== 'function') return { archived, reopened }

    const board = await io.readCompletedBoard()
    const completed = new Set(parseCompletedTaskIds(board))
    // Same active-wins rule as syncUp: a task on BOTH boards is live, so its
    // topic must not be closed underneath an ongoing conversation (#186).
    const active = await loadActiveIds()

    // Tombstoned (deleted-in-app) tasks. Optional: an io without
    // readSyncRecords keeps the old completed-board-only behaviour, so existing
    // in-memory test harnesses and older callers are unaffected.
    const deleted = new Set()
    if (typeof io.readSyncRecords === 'function') {
      try {
        for (const raw of await io.readSyncRecords()) {
          for (const id of parseDeletedTaskIds(raw)) deleted.add(id)
        }
      } catch (err) {
        logger(`could not read sync records (${err.message}); archiving completed only`)
      }
    }

    for (const [taskId, task] of Object.entries(state.tasks)) {
      if (!task || task.topicId == null) continue
      if (!isAllowed(taskId)) continue

      // Active membership WINS over a tombstone too, not just over the
      // completed board. `readSyncRecords` returns EVERY planner sync record,
      // and a task that is live on the active board is legitimately absent from
      // `planner-completed.md`, so that record tombstones it as `deleted: true`.
      // Unioning both records loses which board a tombstone came from, turning
      // "not a row in the completed file" into "the user deleted this task".
      // Measured on the live planner: 37 active-board tasks carried such a
      // tombstone and 33 had their topic closed underneath them — including
      // #276, a task on the Today board. A genuine deletion leaves BOTH boards,
      // so it is still archived (#434) — this only rescues tasks the user can
      // still see.
      const isDeleted = deleted.has(taskId) && !(active && active.has(taskId))
      const shouldArchive = isFinished(completed, active, taskId) || isDeleted
      const isArchived = !!task.archived
      if (shouldArchive === isArchived) continue

      try {
        if (shouldArchive) {
          await client.closeForumTopic({ chatId, messageThreadId: task.topicId })
          setArchived(state, taskId, true)
          archived.push(taskId)
          logger(
            `archived (closed) topic ${task.topicId} for ` +
              `${isDeleted ? 'deleted' : 'completed'} task #${taskId}`,
          )
        } else {
          await client.reopenForumTopic({ chatId, messageThreadId: task.topicId })
          setArchived(state, taskId, false)
          reopened.push(taskId)
          logger(`reopened topic ${task.topicId} for reactivated task #${taskId}`)
        }
      } catch (err) {
        logger(
          `archive: ${shouldArchive ? 'close' : 'reopen'} failed for task #${taskId} ` +
            `(topic ${task.topicId}): ${err.message}`,
        )
      }
    }

    return { archived, reopened }
  }

  // Resolve WHERE the digest should be posted.
  //
  // Returns the message_thread_id to post into, or undefined for the General
  // thread (the historical behaviour, kept as the default so existing setups
  // are unaffected).
  //
  // A numeric setting is used as-is. A name is resolved to a topic exactly
  // once and cached in state — re-resolving every run would create a duplicate
  // "Waiting on you" topic every night, which is the obvious failure mode here.
  // Changing the configured name is treated as pointing at a different topic,
  // so it resolves afresh rather than quietly posting into the old one.
  async function resolveDigestThreadId() {
    const setting = (config.digestTopic || '').trim()
    if (!setting) return undefined

    if (/^\d+$/.test(setting)) return Number(setting)

    if (state.digestTopicId != null && state.digestTopicName === setting) {
      return state.digestTopicId
    }

    const result = await client.createForumTopic({ chatId, name: setting })
    const topicId = result.message_thread_id
    setDigestTopic(state, topicId, setting)
    logger(`created digest topic "${setting}" (${topicId})`)
    return topicId
  }

  // Post ONE consolidated "waiting on you" message listing every task's open
  // ask. It goes to the group's General thread by default, or to a dedicated
  // forum topic when TELEGRAM_BRIDGE_DIGEST_TOPIC names one.
  //
  // The asks are read from each task's NEWEST agent turn via latestAgentTurn —
  // never by grepping the journal for its last `Needs from you:` marker, which
  // can be weeks stale (see the note at the top of digest.js). Getting this
  // wrong would rebroadcast dead asks nightly.
  //
  // ⚠️ With ONE bounded exception. Journals are bottom-appended chat threads, so
  // the "newest agent turn" is often a conversational reply — and a reply about
  // some *other* task carries no ask marker. That silently demoted the task's
  // real, still-open ask out of the queue entirely: measured live 2026-08-23,
  // **38 tasks** had a properly-marked ask in their current agent block that the
  // user never saw, including one-word wins (#405 "go", #391 `merge 120`, and
  // the #371/#372/#388/#404 PR approvals). That is ~27% of all open asks.
  //
  // So when the newest turn has no ask, fall back to `agentBlockText()` — the
  // sentinel block only, stopping at the first chat entry. That is NOT the
  // whole-file grep the warning above forbids: it cannot reach a superseded
  // block or a marker buried in an old Run log, and the block is by definition
  // the agent's *current* state for the task (it holds the live Status line,
  // rewritten every time the agent acts). Terminal statuses are excluded so a
  // finished task can never be revived into the queue.
  //
  // Idempotent: the composed text is hashed and compared against the last one
  // posted, so a run where nothing changed posts nothing at all.
  async function syncDigest({ force = false } = {}) {
    const entries = []
    const journals = await io.listJournals()

    for (const { taskId } of journals) {
      if (!isAllowed(taskId)) continue
      const content = await io.readJournal(taskId)
      if (!hasAgentBlock(content)) continue
      const turn = latestAgentTurn(content)
      const block = agentBlockText(content)
      const status = agentBlockStatus(block)
      // An unparseable turn must NOT end the task's chances. A journal whose
      // newest agent entry is malformed - e.g. the `<!-- from: overnight-agent
      // -->` marker written ABOVE its `## <date>` heading, which makes the turn
      // body parse as empty - would otherwise be dropped here, before the
      // agent-block fallback below ever ran. Observed live on #273, a `## Today`
      // task holding a real `**Needs from you:** just approve` in its block.
      let ask = turn ? extractAskEntry(turn) : null
      // A `weak` ask was salvaged from boilerplate - SKILL.md's generic
      // `**Your call:**` line, or the remainder of a `Needs from you: none …`
      // that opened by dismissing the user. Both survive verbatim into turns
      // the agent has already closed, so on their own they must never drag a
      // finished task back into the approval queue. Strong markers keep their
      // existing behaviour and are still honoured on any status.
      if (ask && ask.weak && DIGEST_TERMINAL_STATUS.has(status)) ask = null
      if (!ask) {
        if (!block || DIGEST_TERMINAL_STATUS.has(status)) continue
        ask = extractAskEntry(block)
        if (!ask) continue
      }
      entries.push({
        taskId,
        title: parseTitle(content),
        ask: ask.text,
        source: ask.source,
      })
    }

    // The user's OWN board is the priority order — it is the thing he
    // maintains by hand, and `## Today` / 🔴 / row position is exactly how he
    // says what matters. So the board leads, and the ask's marker style only
    // breaks ties between tasks sitting at the same board position.
    //
    // This deliberately inverts the previous key order. Ranking `needs` above
    // `next` FIRST meant a single formatting choice inside a journal outranked
    // every priority the user had set: a 🔴 `## Today` task whose newest turn
    // happened to phrase its ask as `Next:` sorted below all ~81 ordinary
    // `Needs from you:` asks and fell off the size-capped message entirely.
    // Observed live one day after the board-order change landed: #356 (🔴),
    // #434 (`merge 154`) and #407 (`merge 124`) were all pushed out by
    // ordinary household rows, while the digest claimed to lead with the P0
    // merge asks. Marker style drifts every time a journal gains a turn; the
    // board does not, so the board has to be the stable key.
    //
    // Falls back to newest-first when there is no board to read.
    let board = null
    if (typeof io.readBoard === 'function') {
      try {
        board = parseBoardOrder(await io.readBoard())
      } catch {
        board = null
      }
    }
    const rank = (e) => (e.source === 'next' ? 1 : 0)
    entries.sort(
      (a, b) =>
        boardRank(board, a.taskId) - boardRank(board, b.taskId) ||
        boardIndex(board, a.taskId) - boardIndex(board, b.taskId) ||
        rank(a) - rank(b) ||
        Number(b.taskId) - Number(a.taskId),
    )

    // Only surface the privacy warning when it is actually true, so it stays
    // meaningful instead of becoming boilerplate the user learns to skip.
    //
    // `can_read_all_group_messages` ALONE is not sufficient, and trusting it
    // was an active bug: Telegram delivers every group message to a bot that
    // is a group ADMINISTRATOR regardless of the privacy flag, but `getMe`
    // keeps reporting `can_read_all_group_messages: false` for that bot. So an
    // admin bot printed "a message you merely type in the group is never
    // delivered" on top of every digest — false, and it put friction on the
    // exact channel the user chose as primary, telling him to reply-to-bot
    // when plain typing works fine.
    //
    // Judge by admin status first; only fall back to the flag when membership
    // can't be read. Any failure keeps the warning OFF, because a spurious
    // warning is worse than a missing one.
    let privacyModeOn = false
    try {
      const me = await client.getMe()
      const flagged = !!me && me.can_read_all_group_messages === false
      if (flagged && typeof client.getChatMember === 'function' && me.id != null) {
        try {
          const member = await client.getChatMember({ chatId, userId: me.id })
          const isAdmin =
            member &&
            (member.status === 'administrator' || member.status === 'creator')
          privacyModeOn = !isAdmin
        } catch {
          // Membership unreadable — fall back to the flag alone.
          privacyModeOn = true
        }
      } else {
        privacyModeOn = flagged
      }
    } catch {
      privacyModeOn = false
    }

    const md = buildDigest(entries, {
      date: now().toISOString().slice(0, 10),
      privacyModeOn,
      preserveOrder: true,
    })
    const hash = hashDigest(md)

    if (!force && state.lastDigestHash === hash) {
      logger(`digest unchanged (${entries.length} open asks); not posting`)
      return { posted: false, count: entries.length, hash }
    }

    // Resolved only once we know we're actually posting, so a run with an
    // unchanged queue never creates a topic as a side effect.
    const messageThreadId = await resolveDigestThreadId()

    try {
      await client.sendMessage({
        chatId,
        text: mdToTelegramHtml(md),
        parseMode: 'HTML',
        messageThreadId,
      })
    } catch (err) {
      logger(`HTML digest send failed (${err.message}); retrying as plain text`)
      await client.sendMessage({ chatId, text: md, messageThreadId })
    }

    setLastDigest(state, hash)
    logger(
      `posted digest with ${entries.length} open ask(s)` +
        (messageThreadId != null ? ` to topic ${messageThreadId}` : ' to General'),
    )
    return { posted: true, count: entries.length, hash, threadId: messageThreadId ?? null }
  }

  // One-time (idempotent) setup: record each existing agent-block journal's
  // current latest-turn hash as "already posted" WITHOUT creating a topic or
  // sending anything. After this, syncUp only mirrors tasks whose agent turn
  // changes afterwards — so the bridge starts fresh from "now" instead of
  // backfilling the whole history. Tasks that already have a posted history are
  // left untouched.
  async function baseline() {
    const seen = []
    const skipped = []
    const journals = await io.listJournals()

    for (const { taskId } of journals) {
      if (!isAllowed(taskId)) continue
      const content = await io.readJournal(taskId)
      if (!hasAgentBlock(content)) continue
      const turn = latestAgentTurn(content)
      if (!turn) continue

      const task = getTask(state, taskId)
      if (task && task.lastPostedHash) {
        skipped.push(taskId) // already tracked/posted — don't clobber
        continue
      }
      setLastPosted(state, taskId, hashTurn(turn))
      seen.push(taskId)
    }

    return { seen, skipped }
  }

  // Migration for the TURN_END boundary fix. Changing what `latestAgentTurn()`
  // returns changes `hashTurn()`, and syncUp dedupes on exactly that hash — so
  // without this, shipping the fix would re-post one stale turn for every
  // journal whose stamp used to be swallowed (36 live journals when this was
  // written). That is the very duplicate-message symptom the fix exists to stop.
  //
  // It is deliberately narrow: a task is re-baselined ONLY when its stored hash
  // matches the LEGACY parse of the journal as it stands right now. That proves
  // the stored hash refers to this exact turn, already delivered, and that the
  // only thing that moved is how we parse it. Any task whose stored hash matches
  // neither parse has genuinely new content and is left alone, so a real pending
  // post can never be silently absorbed.
  //
  // Idempotent: after it runs, stored === new hash, which matches no legacy hash
  // that differs, so a second run migrates nothing.
  async function rebaselineTurnEnd() {
    const migrated = []
    const unchanged = []
    const pending = []
    const journals = await io.listJournals()

    for (const { taskId } of journals) {
      if (!isAllowed(taskId)) continue
      const task = getTask(state, taskId)
      if (!task || !task.lastPostedHash) continue

      const content = await io.readJournal(taskId)
      if (!hasAgentBlock(content)) continue

      const next = latestAgentTurn(content)
      const legacy = latestAgentTurn(content, { includeTurnEnd: true })
      if (!next || !legacy) continue

      const nextHash = hashTurn(next)
      const legacyHash = hashTurn(legacy)

      if (nextHash === legacyHash) {
        unchanged.push(taskId) // no stamp in this turn — the fix is a no-op here
        continue
      }
      if (task.lastPostedHash === legacyHash) {
        setLastPosted(state, taskId, nextHash)
        migrated.push(taskId)
      } else {
        // Stored hash matches neither parse: this turn has moved on since it was
        // posted, so it is legitimately due a post. Leave it for syncUp.
        pending.push(taskId)
      }
    }

    return { migrated, unchanged, pending }
  }

  // One-time repair for the turns the old completed-guard destroyed (#186).
  //
  // Before the fix, suppression wrote the declined hash into `lastPostedHash`,
  // which marks an UNSENT turn as sent. For a dual-board task — live on
  // planner.md and also listed on planner-completed.md — that guard fired every
  // run, so its current turn is recorded as delivered while the user never saw
  // it. Fixing the guard alone does not release those turns: the unchanged-turn
  // check still matches the absorbed hash and skips them forever.
  //
  // Scope is deliberately narrow: ONLY tasks the active board still lists AND
  // the completed board also lists. A task that is genuinely completed is left
  // alone, so #170 cannot regress into re-posting closed work.
  async function recoverSuppressed() {
    const released = []
    const journals = await io.listJournals()
    const completed = await loadCompletedIds()
    const active = await loadActiveIds()
    if (!completed || !active) return { released, skipped: 'no board signal' }

    for (const { taskId } of journals) {
      if (!isAllowed(taskId)) continue
      if (!completed.has(taskId) || !active.has(taskId)) continue

      const task = getTask(state, taskId)
      if (!task || !task.lastPostedHash) continue

      const content = await io.readJournal(taskId)
      if (!hasAgentBlock(content)) continue
      const turn = latestAgentTurn(content)
      if (!turn) continue

      // Only release when the stored hash IS the current turn — that is the
      // absorbed state. If they differ, the task already has a newer turn that
      // syncUp will post on its own and nothing needs clearing.
      if (task.lastPostedHash !== hashTurn(turn)) continue

      setLastPosted(state, taskId, null)
      released.push(taskId)
      logger(`released suppressed turn for dual-board task #${taskId}`)
    }

    return { released }
  }

  return {
    ensureTopic,
    syncUp,
    syncDown,
    syncArchive,
    syncOnce,
    syncDigest,
    baseline,
    rebaselineTurnEnd,
    recoverSuppressed,
  }
}
