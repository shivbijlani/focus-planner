// Thin wrapper over the Telegram Bot API. Uses the global `fetch` (Node 18+).
// `fetchImpl` is injectable so tests never touch the network.

const API_BASE = 'https://api.telegram.org'

// Node's global fetch has NO default timeout, so a stalled connection (as opposed
// to a refused one) hangs forever. The bridge is invoked inside every agent run --
// PHASE 3 and the pre-scan `sync-down` -- so one hung request hangs the whole run,
// with no error and no log line. That is the "await with no deadline" failure mode.
// Every request therefore carries an explicit deadline and fails LOUDLY, naming the
// method and the elapsed time, because a named failure is worth far more than a
// silent one when diagnosing this after the fact.
const DEFAULT_TIMEOUT_MS = 30000

export function createTelegramClient({
  token,
  fetchImpl = fetch,
  apiBase = API_BASE,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  if (!token) throw new Error('createTelegramClient: token is required')

  async function call(method, params = {}) {
    const url = `${apiBase}/bot${token}/${method}`

    // `getUpdates` supports Telegram-side long polling via a `timeout` field in
    // SECONDS. The transport deadline must outlive it, or we would abort a request
    // that is behaving exactly as asked. Budget = long-poll window + our own margin.
    const longPollMs = Number.isFinite(params.timeout) ? Math.max(0, params.timeout) * 1000 : 0
    const budgetMs = longPollMs + timeoutMs

    const started = Date.now()
    let res
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
        // AbortSignal.timeout is Node 18+, the same floor global fetch already needs.
        ...(typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
          ? { signal: AbortSignal.timeout(budgetMs) }
          : {}),
      })
    } catch (err) {
      // An abort is indistinguishable from a network error to the caller unless we
      // say so. Name the operation and the stage that stalled.
      if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        throw new Error(
          `Telegram ${method}: timed out after ${Date.now() - started} ms (budget ${budgetMs} ms)`,
        )
      }
      throw err
    }

    let data
    try {
      data = await res.json()
    } catch {
      throw new Error(`Telegram ${method}: non-JSON response (HTTP ${res.status})`)
    }
    if (!data || data.ok !== true) {
      const desc = data && data.description ? data.description : `HTTP ${res.status}`
      throw new Error(`Telegram ${method} failed: ${desc}`)
    }
    return data.result
  }

  return {
    call,
    getMe: () => call('getMe'),
    getChatMember: ({ chatId, userId }) =>
      call('getChatMember', {
        chat_id: chatId,
        user_id: userId,
      }),
    createForumTopic: ({ chatId, name, iconColor }) =>
      call('createForumTopic', {
        chat_id: chatId,
        name,
        ...(iconColor != null ? { icon_color: iconColor } : {}),
      }),
    editForumTopic: ({ chatId, messageThreadId, name }) =>
      call('editForumTopic', {
        chat_id: chatId,
        message_thread_id: messageThreadId,
        ...(name != null ? { name } : {}),
      }),
    // "Archive" a task's thread: closing a forum topic collapses it under the
    // group's Closed section and blocks new messages from non-admins. The Bot
    // API has no separate per-topic archive primitive, so close/reopen is the
    // reversible equivalent. Requires the bot to have can_manage_topics (or be
    // the topic creator, which it is for topics it opened).
    closeForumTopic: ({ chatId, messageThreadId }) =>
      call('closeForumTopic', {
        chat_id: chatId,
        message_thread_id: messageThreadId,
      }),
    reopenForumTopic: ({ chatId, messageThreadId }) =>
      call('reopenForumTopic', {
        chat_id: chatId,
        message_thread_id: messageThreadId,
      }),
    sendMessage: ({
      chatId,
      text,
      messageThreadId,
      parseMode,
      replyToMessageId,
      disablePreview = true,
    }) =>
      call('sendMessage', {
        chat_id: chatId,
        text,
        ...(messageThreadId != null ? { message_thread_id: messageThreadId } : {}),
        ...(parseMode ? { parse_mode: parseMode } : {}),
        // Threading the acknowledgement under the message it answers keeps a
        // busy General feed readable, and tells the user *which* reply landed.
        ...(replyToMessageId != null
          ? { reply_parameters: { message_id: replyToMessageId, allow_sending_without_reply: true } }
          : {}),
        link_preview_options: { is_disabled: disablePreview },
      }),
    getUpdates: ({ offset, timeout = 0, allowedUpdates } = {}) =>
      call('getUpdates', {
        ...(offset != null ? { offset } : {}),
        timeout,
        ...(allowedUpdates ? { allowed_updates: allowedUpdates } : {}),
      }),
    // Used to collapse a superseded, unanswered agent turn (#205). Telegram lets a
    // bot delete its own message for 48h, and any message in a group where it is an
    // admin - which this bot is, since it creates and closes forum topics.
    deleteMessage: ({ chatId, messageId }) =>
      call('deleteMessage', {
        chat_id: chatId,
        message_id: messageId,
      }),
  }
}
