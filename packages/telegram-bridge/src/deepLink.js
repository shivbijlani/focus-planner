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

// The catch-up doc binding stamped by oa-state.ps1 (#423). The bridge READS this
// and never writes it: the binding is owned by the agent's state store, and #424
// is explicit that the suppression state must not become a second store of
// "which doc does this task have". What the bridge owns is purely Telegram's
// half -- the message id of the link it posted.
const DOC_META_RE = /<!--\s*doc-meta\b([^>]*?)-->/i

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
 * Read the catch-up doc binding stamped into a journal by oa-state.ps1 (#423).
 *
 * Returns `{ docId, docUrl }`, or null when the task has no doc. `docUrl` is
 * derived from `docId` when the stamp did not carry one, so a binding written
 * without the optional url still yields a usable link -- the id is the identity,
 * the url is a convenience.
 *
 * NOTE this is deliberately read-only. #423 owns the binding; #424 only needs to
 * know whether one exists and where it points.
 *
 * @param {string} content
 * @returns {{docId: string, docUrl: string} | null}
 */
export function parseDocMeta(content) {
  if (!content) return null
  const m = DOC_META_RE.exec(content)
  if (!m) return null
  const { docId, docUrl } = parseAttrs(m[1])
  const id = (docId ?? '').trim()
  if (!id) return null
  return {
    docId: id,
    docUrl: (docUrl ?? '').trim() || `https://docs.google.com/document/d/${id}/edit`,
  }
}

/**
 * #588 — HAS THE BOUND DOC ACTUALLY BEEN WRITTEN?
 *
 * `ensure-catchup-doc` creates a PLACEHOLDER and binds it; the body is written by the task's
 * first wake AFTER that binding. Binding and writing are therefore different events, and a
 * link posted on the binding points at "this has not been written yet". Since #424 makes the
 * link carry the whole wake, a stub link and a genuinely quiet task look identical on a phone.
 *
 * The signal is the doc ID'S OWN OCCURRENCE IN THE JOURNAL, outside the marker that binds it.
 * That is not a heuristic about placeholder prose (which Google may reword at any time): the
 * id is minted at bind time, so ANY other occurrence of it must have been written afterwards.
 * `write-turn.ps1`'s G10 refuses a doc-bound turn that does not name the doc, so a wake that
 * wrote a turn necessarily left one, and a doc no wake has reached cannot have one.
 *
 * Deriving it this way rather than recording a `written_at` on the amend is deliberate. The
 * amend is an agent calling Google Docs tools directly -- there is no function to instrument,
 * so "also record written_at" could only ever be an INSTRUCTION, and a rule that lives in
 * prose is the defect class this work exists to delete. It also needs no migration: every
 * already-bound task is classified correctly from the journal it already has.
 *
 * @param {string} content journal content
 * @param {string} docId the bound document id
 * @returns {boolean} true once a wake has referenced the doc outside its binding marker
 */
export function docHasBeenWritten(content, docId) {
  const id = (docId ?? '').trim()
  if (!content || !id) return false
  // Strip every binding marker first. The stamp names the doc by definition, so counting it
  // would make every bound task look written -- which is exactly the conflation being removed.
  const withoutMarkers = content.replace(new RegExp(DOC_META_RE.source, 'gi'), '')
  return withoutMarkers.includes(id)
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
