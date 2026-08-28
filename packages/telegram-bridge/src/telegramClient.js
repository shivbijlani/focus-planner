// Thin wrapper over the Telegram Bot API. Uses the global `fetch` (Node 18+).
// `fetchImpl` is injectable so tests never touch the network.

const API_BASE = 'https://api.telegram.org'

export function createTelegramClient({ token, fetchImpl = fetch, apiBase = API_BASE }) {
  if (!token) throw new Error('createTelegramClient: token is required')

  async function call(method, params = {}) {
    const url = `${apiBase}/bot${token}/${method}`
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
    })
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
  }
}
