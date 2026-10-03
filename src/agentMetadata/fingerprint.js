// Per-device agent metadata — the app's half of the fingerprint and link rules
// (docs/spec/Domain-agent-metadata.md). Mirrors the publisher in
// plugins/overnight-agent/skills/overnight-agent/agent-metadata.mjs; both run every vector in
// plugins/overnight-agent/tests/agent-metadata/vectors.json, which is what keeps them equal.

const COMMENT_RE = /<!--[\s\S]*?-->/g
const EMOJI_RE = /\p{Extended_Pictographic}|\p{Regional_Indicator}|[\u{1F3FB}-\u{1F3FF}]|\uFE0E|\uFE0F|\u200D|\u20E3|[\u{E0020}-\u{E007F}]/gu
const collapse = (s) => s.replace(/\s+/gu, ' ').trim()
const pad2 = (n) => String(n).padStart(2, '0')

function realDate(y, m, d) {
  if (m < 1 || m > 12 || d < 1) return false
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate()
}

export function canonicalId(cell) {
  const local = String(cell ?? '').normalize('NFKC').split(',[')[0]
  const m = /\d+/.exec(local)
  return m ? m[0].replace(/^0+(?=\d)/, '') : null
}

export function canonicalAdded(cell) {
  const s = collapse(String(cell ?? '').replace(COMMENT_RE, '').normalize('NFKC'))
  if (!s) return ''
  let m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T ][0-9:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/i.exec(s)
  if (m && realDate(+m[1], +m[2], +m[3])) return `${m[1]}-${pad2(+m[2])}-${pad2(+m[3])}`
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s)
  if (m && realDate(+m[3], +m[1], +m[2])) return `${m[3]}-${pad2(+m[1])}-${pad2(+m[2])}`
  return s.toLowerCase()
}

export function canonicalTitle(cell) {
  const s = String(cell ?? '').replace(COMMENT_RE, '').normalize('NFKC').replace(EMOJI_RE, '')
  return collapse(s).toLowerCase()
}

export function fingerprintText(id, added, title) {
  const cid = canonicalId(id)
  if (cid === null) return null
  return `fp-task@1\n${cid}\n${canonicalAdded(added)}\n${canonicalTitle(title)}`
}

async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

const fpCache = new Map()

/** `sha256:<hex>` for a board row's [ID, Added, Task] cells, or null when the ID has no digits. */
export async function fingerprint(id, added, title) {
  const text = fingerprintText(id, added, title)
  if (text === null) return null
  if (fpCache.has(text)) return fpCache.get(text)
  const fp = `sha256:${await sha256Hex(text)}`
  if (fpCache.size > 2000) fpCache.clear()
  fpCache.set(text, fp)
  return fp
}

export async function deviceKey(deviceId) {
  return (await sha256Hex(`fp-device@1\n${String(deviceId).toLowerCase()}`)).slice(0, 32)
}

/** The link if it is safe for this session (the Copilot app's own link, or https), else null. */
export function safeUrl(url, sessionId) {
  if (typeof url !== 'string' || !url || url.length > 2048) return null
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0020\u007f-\u009f]/.test(url)) return null
  const app = /^ghapp:\/\/sessions\/([^/?#]+)$/.exec(url)
  if (app) return app[1].toLowerCase() === String(sessionId).toLowerCase() ? url : null
  if (!url.startsWith('https://')) return null
  let u
  try { u = new URL(url) } catch { return null }
  if (u.protocol !== 'https:' || !u.hostname || u.username || u.password) return null
  return url
}
