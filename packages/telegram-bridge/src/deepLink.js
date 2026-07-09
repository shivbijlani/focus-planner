// Pure helpers to compute a Telegram deep link for a task's forum topic and to
// read/write the hidden `<!-- tg-meta ... -->` marker that carries the chatId +
// threadId mapping inside a task journal.
//
// IMPORTANT: no Node builtins here. This module is imported by BOTH the bridge
// (Node) and the planner web app (browser), so it must stay dependency-free.
//
// Why a marker in the journal? Telegram assigns a topic's message_thread_id at
// createForumTopic time — it can't be computed from the task id. The bridge
// stores it in %LOCALAPPDATA% state.json, which the web app can't read. Stamping
// the mapping into the journal lets the link travel with the synced markdown.

const TG_META_RE = /<!--\s*tg-meta\b([^>]*?)-->/i

/**
 * Build a deep link that opens the Telegram app on a specific forum topic.
 * - Public supergroup (has @username): https://t.me/<username>/<threadId>
 * - Private supergroup: strip the leading -100 from the chat id ->
 *   https://t.me/c/<internalId>/<threadId>
 * Returns '' when there isn't enough information to build a usable link.
 *
 * @param {{chatId?: string|number, threadId?: string|number, username?: string}} [fields]
 * @returns {string}
 */
export function telegramDeepLink({ chatId, threadId, username } = {}) {
  const thread = threadId != null && `${threadId}`.trim() !== '' ? `${threadId}`.trim() : ''

  if (username) {
    const u = String(username).replace(/^@/, '').trim()
    if (!u) return ''
    return thread ? `https://t.me/${u}/${thread}` : `https://t.me/${u}`
  }

  const raw = String(chatId ?? '').trim()
  if (!raw) return ''
  // Private supergroup ids look like -1004310604015; the public-facing internal
  // id drops the -100 prefix. Fall back to stripping a leading '-' otherwise.
  const internal = raw.startsWith('-100') ? raw.slice(4) : raw.replace(/^-/, '')
  if (!internal) return ''
  return thread ? `https://t.me/c/${internal}/${thread}` : `https://t.me/c/${internal}`
}

function parseAttrs(body) {
  const attrs = {}
  const re = /(\w+)=("([^"]*)"|'([^']*)'|(\S+))/g
  let m
  while ((m = re.exec(body))) {
    attrs[m[1]] = m[3] ?? m[4] ?? m[5] ?? ''
  }
  return attrs
}

/**
 * Parse the tg-meta marker fields out of journal content.
 * @param {string} content
 * @returns {{chatId: string, threadId: string, username: string} | null}
 */
export function parseTgMeta(content) {
  if (!content) return null
  const m = TG_META_RE.exec(content)
  if (!m) return null
  const { chatId, threadId, username } = parseAttrs(m[1])
  if (chatId == null && username == null) return null
  return {
    chatId: chatId ?? '',
    threadId: threadId ?? '',
    username: username ?? '',
  }
}

/**
 * Parse the marker AND compute the deep link.
 * @param {string} content
 * @returns {{chatId: string, threadId: string, username: string, url: string} | null}
 */
export function parseTgLink(content) {
  const meta = parseTgMeta(content)
  if (!meta) return null
  const url = telegramDeepLink(meta)
  if (!url) return null
  return { ...meta, url }
}

/**
 * Render a tg-meta marker line from fields (only non-empty fields are emitted).
 * @param {{chatId?: string|number, threadId?: string|number, username?: string}} [fields]
 * @returns {string}
 */
export function buildTgMetaMarker({ chatId, threadId, username } = {}) {
  const parts = []
  if (chatId != null && `${chatId}` !== '') parts.push(`chatId=${chatId}`)
  if (threadId != null && `${threadId}` !== '') parts.push(`threadId=${threadId}`)
  if (username) parts.push(`username=${String(username).replace(/^@/, '')}`)
  return `<!-- tg-meta ${parts.join(' ')} -->`
}

/**
 * Insert or replace the tg-meta marker in journal content. Idempotent: returns
 * an identical string when the marker already matches. A new marker is placed on
 * its own line right under the first H1 (`# ...`), or prepended when there's no H1.
 * @param {string} content
 * @param {{chatId?: string|number, threadId?: string|number, username?: string}} fields
 * @returns {string}
 */
export function upsertTgMetaMarker(content, fields) {
  const marker = buildTgMetaMarker(fields)
  const src = content ?? ''

  if (TG_META_RE.test(src)) {
    return src.replace(TG_META_RE, marker)
  }

  const lines = src.split(/\r?\n/)
  const h1Idx = lines.findIndex((l) => /^#\s+/.test(l))
  if (h1Idx === -1) {
    return src ? `${marker}\n${src}` : marker
  }
  lines.splice(h1Idx + 1, 0, marker)
  return lines.join('\n')
}
