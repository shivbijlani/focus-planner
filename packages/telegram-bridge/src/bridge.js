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
  setOffset,
  findTaskByTopic,
} from './state.js'
import { upsertTgMetaMarker } from './deepLink.js'
import { mdToTelegramHtml, escapeHtml } from './telegramFormat.js'

const TELEGRAM_MAX = 4096

export function hashTurn(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

// Truncate markdown at a line boundary so conversion never cuts through an
// inline `**...**`/`` `...` `` pair (those don't span lines in our converter),
// keeping the resulting HTML tag-balanced.
function truncateMarkdown(md, budget) {
  if (md.length <= budget) return md
  const cut = md.slice(0, budget)
  const nl = cut.lastIndexOf('\n')
  const base = nl > 0 ? cut.slice(0, nl) : cut
  return `${base}\n\u2026`
}

// Build the HTML message: a bold task header + the agent turn rendered as
// Telegram HTML. Leaves headroom under the 4096 char cap for tag expansion.
function formatForTelegram(taskId, title, turn) {
  const header = title
    ? `\u{1F4CB} Task #${taskId} \u2014 ${title}`
    : `\u{1F4CB} Task #${taskId}`
  const headerHtml = `<b>${escapeHtml(header)}</b>`
  // Reserve room for the header, the blank line, and tag expansion.
  const budget = Math.max(0, TELEGRAM_MAX - headerHtml.length - 2 - 400)
  const bodyHtml = mdToTelegramHtml(truncateMarkdown(turn, budget))
  let msg = `${headerHtml}\n\n${bodyHtml}`
  if (msg.length > TELEGRAM_MAX) msg = msg.slice(0, TELEGRAM_MAX - 1) + '\u2026'
  return msg
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

      const hadTopic = task && task.topicId != null
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

      try {
        await client.sendMessage({
          chatId,
          text: formatForTelegram(taskId, title, turn),
          messageThreadId: topicId,
          parseMode: 'HTML',
        })
      } catch (err) {
        // If Telegram rejects our HTML (e.g. an unexpected entity), don't lose
        // the update — resend the same turn as plain text.
        logger(`HTML send failed for task #${taskId} (${err.message}); retrying as plain text`)
        await client.sendMessage({
          chatId,
          text: formatPlain(taskId, title, turn),
          messageThreadId: topicId,
        })
      }
      setLastPosted(state, taskId, hash)
      posted.push(taskId)
      logger(`posted task #${taskId} to topic ${topicId}`)
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
    const down = await syncDown()
    return { up, down }
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

  return { ensureTopic, syncUp, syncDown, syncOnce, baseline }
}
