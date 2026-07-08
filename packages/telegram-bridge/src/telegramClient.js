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
    sendMessage: ({ chatId, text, messageThreadId, parseMode, disablePreview = true }) =>
      call('sendMessage', {
        chat_id: chatId,
        text,
        ...(messageThreadId != null ? { message_thread_id: messageThreadId } : {}),
        ...(parseMode ? { parse_mode: parseMode } : {}),
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
