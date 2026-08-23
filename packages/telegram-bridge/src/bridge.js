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
  setLastDigest,
  setDigestTopic,
  findTaskByTopic,
} from './state.js'
import { extractAskEntry, buildDigest, hashDigest } from './digest.js'
import { upsertTgMetaMarker, parseTgMeta } from './deepLink.js'
import { mdToTelegramHtml, escapeHtml } from './telegramFormat.js'
import { parseCompletedTaskIds } from './completed.js'
import { parseBoardOrder, boardRank, boardIndex } from './board.js'
import { parseReplyRouting, coalesceByTask } from './routeReply.js'

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
      if (!turn) continue
      const ask = extractAskEntry(turn)
      if (!ask) continue
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

  return { ensureTopic, syncUp, syncDown, syncArchive, syncOnce, syncDigest, baseline }
}
