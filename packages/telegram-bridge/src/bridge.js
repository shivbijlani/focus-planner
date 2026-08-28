// Orchestrates the two directions of the bridge:
//   syncUp   — post each task's latest agent turn into its forum topic
//   syncDown — fold Telegram replies back into the task journals
// All I/O is injected (client + io) so the flow is unit-testable offline.

import { createHash } from 'crypto'
import {
  hasAgentBlock,
  latestAgentTurn,
  parseTitle,
  topicName,
  appendUserReply,
} from './journal.js'
import {
  getTask,
  setTopic,
  setLastPosted,
  setArchived,
  setOffset,
  findTaskByTopic,
} from './state.js'
import { upsertTgMetaMarker, parseTgMeta } from './deepLink.js'
import { mdToTelegramHtml, escapeHtml } from './telegramFormat.js'
import { parseCompletedTaskIds } from './completed.js'

const TELEGRAM_MAX = 4096

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

export function createBridge({ client, config, state, io, logger = () => {}, now = () => new Date() }) {
  const { chatId, taskAllowlist } = config

  function isAllowed(taskId) {
    return taskAllowlist.length === 0 || taskAllowlist.includes(taskId)
  }

  async function ensureTopic(taskId, title) {
    const existing = getTask(state, taskId)
    if (existing && existing.topicId != null) return existing.topicId
    const name = topicName(taskId, title)
    const result = await client.createForumTopic({ chatId, name })
    const topicId = result.message_thread_id
    setTopic(state, taskId, topicId, name)
    logger(`created topic ${topicId} for task #${taskId}`)
    return topicId
  }

  async function syncUp() {
    const posted = []
    const created = []
    const journals = await io.listJournals()

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
      const parts = formatForTelegramParts(taskId, title, turn)
      for (const [index, text] of parts.entries()) {
        try {
          await client.sendMessage({
            chatId,
            text,
            messageThreadId: topicId,
            parseMode: 'HTML',
          })
        } catch (err) {
          // If Telegram rejects our HTML (e.g. an unexpected entity), don't lose
          // the update — resend the same content as plain text.
          logger(
            `HTML send failed for task #${taskId} part ${index + 1}/${parts.length} ` +
              `(${err.message}); retrying as plain text`,
          )
          await client.sendMessage({
            chatId,
            text: formatPlain(taskId, parts.length > 1 ? `${title} (${index + 1}/${parts.length})` : title, turn),
            messageThreadId: topicId,
          })
        }
      }
      setLastPosted(state, taskId, hash)
      posted.push(taskId)
      logger(
        `posted task #${taskId} to topic ${topicId}` +
          (parts.length > 1 ? ` in ${parts.length} parts` : ''),
      )
    }

    return { posted, created }
  }

  async function syncDown() {
    const folded = []
    const offset = state.updateOffset > 0 ? state.updateOffset : undefined
    const updates = await client.getUpdates({
      offset,
      allowedUpdates: ['message'],
    })

    let maxUpdateId = state.updateOffset - 1
    for (const update of updates) {
      if (update.update_id > maxUpdateId) maxUpdateId = update.update_id
      const msg = update.message
      if (!msg || msg.message_thread_id == null) continue
      if (msg.from && msg.from.is_bot) continue
      const text = msg.text
      if (!text || !text.trim()) continue
      // Ignore the service message that opens a forum topic.
      if (msg.forum_topic_created) continue

      const taskId = findTaskByTopic(state, msg.message_thread_id)
      if (!taskId) continue

      const content = await io.readJournal(taskId)
      const day = now().toISOString().slice(0, 10)
      const updated = appendUserReply(content, { text, date: day })
      await io.writeJournal(taskId, updated)
      folded.push({ taskId, text })
      logger(`folded reply into task #${taskId}`)
    }

    if (updates.length) setOffset(state, maxUpdateId + 1)
    return { folded }
  }

  async function syncOnce() {
    const up = await syncUp()
    const archived = await syncArchive()
    const down = await syncDown()
    return { up, archived, down }
  }

  // Archive/unarchive task topics to mirror the completed board. A task that has
  // moved to planner-completed.md gets its forum topic CLOSED (Telegram's
  // reversible "archive": it collapses under the group's Closed section and
  // stops new non-admin posts). A task that later leaves the completed board
  // (reopened) gets its topic REOPENED. Both directions are idempotent — we only
  // call Telegram when the desired archived-state differs from what we recorded,
  // so re-runs are no-ops. A per-topic failure (e.g. the bot lacks
  // can_manage_topics) is logged and skipped; it never aborts the run and is
  // retried next time.
  async function syncArchive() {
    const archived = []
    const reopened = []
    // Gated on the "Archive completed topics" setting (default on). When the
    // user turns it off we neither read the board nor touch any topic.
    if (config.archiveCompleted === false) return { archived, reopened, skipped: true }
    if (typeof io.readCompletedBoard !== 'function') return { archived, reopened }

    const board = await io.readCompletedBoard()
    const completed = new Set(parseCompletedTaskIds(board))

    for (const [taskId, task] of Object.entries(state.tasks)) {
      if (!task || task.topicId == null) continue
      if (!isAllowed(taskId)) continue

      const shouldArchive = completed.has(taskId)
      const isArchived = !!task.archived
      if (shouldArchive === isArchived) continue

      try {
        if (shouldArchive) {
          await client.closeForumTopic({ chatId, messageThreadId: task.topicId })
          setArchived(state, taskId, true)
          archived.push(taskId)
          logger(`archived (closed) topic ${task.topicId} for completed task #${taskId}`)
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

  return { ensureTopic, syncUp, syncDown, syncArchive, syncOnce, baseline }
}
