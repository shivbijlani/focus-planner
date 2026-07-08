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

const TELEGRAM_MAX = 4096

export function hashTurn(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function formatForTelegram(taskId, title, turn) {
  const header = title ? `\u{1F4CB} Task #${taskId} \u2014 ${title}` : `\u{1F4CB} Task #${taskId}`
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
      const hadTopic = task && task.topicId != null

      const title = parseTitle(content)
      const topicId = await ensureTopic(taskId, title)
      if (!hadTopic) created.push(taskId)

      if (task && task.lastPostedHash === hash) continue

      await client.sendMessage({
        chatId,
        text: formatForTelegram(taskId, title, turn),
        messageThreadId: topicId,
      })
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

  return { ensureTopic, syncUp, syncDown, syncOnce }
}
