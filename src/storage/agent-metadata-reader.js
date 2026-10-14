// Reads the per-device agent metadata files (agent-metadata/<device-key>.json) that each PC's
// Overnight Agent publishes, and answers "which agent sessions belong to this board row?".
// Contract: docs/spec/Domain-agent-metadata.md ("Reader rules"). It reads nothing else — no
// journals, no agent state — and honours the reader limits: a refresh at most every 5 minutes,
// at most 64 files, at most 2 reads at once, and a pause on HTTP 429.
import { deviceKey, safeUrl } from '../agentMetadata/fingerprint.js'

export const METADATA_DIR = 'agent-metadata'
export const SCHEMA = 'fp-agent-task-metadata@1'
export const FILE_NAME_RE = /^[0-9a-f]{32}\.json$/
export const LIMITS = {
  refreshMs: 5 * 60 * 1000,
  maxFiles: 64,
  concurrency: 2,
  pauseMs: 5 * 60 * 1000,
  maxBytes: 256 * 1024,
  maxTasks: 500,
  maxBindings: 4,
  staleFloorMs: 15 * 60 * 1000,
}
const SOURCE_RE = /^[a-z][a-z0-9-]{0,31}$/
const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const TASK_ID_RE = /^(0|[1-9]\d*)$/
const FP_RE = /^sha256:[0-9a-f]{64}$/

function isThrottle(e) {
  return e?.status === 429 || /\b429\b/.test(String(e?.message ?? ''))
}

function retryAfterMs(e) {
  const v = e?.retryAfter ?? e?.headers?.get?.('Retry-After')
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n * 1000 : 0
}

/** Validate one file's text. Returns the projection, or null when the file must be ignored. */
export async function parseProjection(text, fileName) {
  if (typeof text !== 'string' || !text) return null
  if (new TextEncoder().encode(text).length > LIMITS.maxBytes) return null
  let doc
  try { doc = JSON.parse(text) } catch { return null }
  if (!doc || typeof doc !== 'object' || doc.schema !== SCHEMA) return null
  const dev = doc.device
  const key = String(fileName).replace(/\.json$/, '')
  if (!dev || typeof dev.key !== 'string' || dev.key !== key || !FILE_NAME_RE.test(`${dev.key}.json`)) return null
  if (typeof dev.id !== 'string' || (await deviceKey(dev.id)) !== dev.key) return null
  const name = typeof dev.name === 'string' ? dev.name.trim() : ''
  // eslint-disable-next-line no-control-regex
  if (!name || name.length > 64 || /[\u0000-\u001f\u007f-\u009f]/.test(name)) return null
  if (!Number.isInteger(doc.revision) || doc.revision < 1) return null
  const lastSeenMs = Date.parse(doc.lastSeenAt)
  if (Number.isNaN(lastSeenMs)) return null
  let heartbeat = null
  if (doc.heartbeatMinutes !== undefined) {
    if (!Number.isInteger(doc.heartbeatMinutes) || doc.heartbeatMinutes < 1 || doc.heartbeatMinutes > 1440) return null
    heartbeat = doc.heartbeatMinutes
  }
  const tasks = new Map()
  const entries = doc.tasks && typeof doc.tasks === 'object' ? Object.entries(doc.tasks) : []
  for (const [id, t] of entries.slice(0, LIMITS.maxTasks)) {
    if (!TASK_ID_RE.test(id) || !t || !FP_RE.test(t.fingerprint) || !Array.isArray(t.bindings)) continue
    const bindings = []
    for (const b of t.bindings.slice(0, LIMITS.maxBindings)) {
      if (!b || !SOURCE_RE.test(b.source) || !SESSION_RE.test(b.sessionId) || typeof b.status !== 'string') continue
      let url = null
      if (b.url !== undefined && b.url !== null) {
        url = safeUrl(b.url, b.sessionId)
        if (!url) continue // an unsafe link hides the binding; it never falls back to a plain badge
      }
      bindings.push({ source: b.source, sessionId: b.sessionId, status: b.status, url })
    }
    if (bindings.length) tasks.set(id, { fingerprint: t.fingerprint, bindings })
  }
  return { key: dev.key, name, revision: doc.revision, lastSeenMs, heartbeat, tasks }
}

async function pool(items, size, fn) {
  let i = 0
  let stop = false
  const worker = async () => {
    while (!stop && i < items.length) {
      const item = items[i++]
      if ((await fn(item)) === false) stop = true
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker))
}

/**
 * @param {object} io
 * @param {(dir: string) => Promise<string[]|null>} io.listDir  file names in a folder; null when absent
 * @param {(path: string) => Promise<string>} io.read
 * @param {() => number} [io.now]
 * @param {(event: string, detail?: object) => void} [io.diag]
 */
export function createAgentMetadataReader({ listDir, read, now = () => Date.now(), diag = () => {} }) {
  const devices = new Map() // key -> { projection, unavailable }
  let lastRefreshAt = null
  let pausedUntil = 0
  let enabled = false
  let inflight = null
  let generation = 0

  async function doRefresh() {
    lastRefreshAt = now()
    let names
    try {
      names = await listDir(METADATA_DIR)
    } catch (e) {
      for (const d of devices.values()) d.unavailable = true
      if (isThrottle(e)) pausedUntil = now() + Math.max(LIMITS.pauseMs, retryAfterMs(e))
      diag('list-failed', { throttled: isThrottle(e) })
      return
    }
    if (!Array.isArray(names)) { devices.clear(); enabled = false; return }
    enabled = true
    const candidates = names.filter((n) => FILE_NAME_RE.test(n)).sort()
    if (candidates.length > LIMITS.maxFiles) diag('too-many-files', { ignored: candidates.length - LIMITS.maxFiles })
    const chosen = candidates.slice(0, LIMITS.maxFiles)
    const present = new Set(chosen.map((n) => n.slice(0, 32)))
    for (const key of [...devices.keys()]) if (!present.has(key)) devices.delete(key) // removed
    const unread = new Set(chosen)
    await pool(chosen, LIMITS.concurrency, async (name) => {
      if (now() < pausedUntil) return false
      unread.delete(name)
      const key = name.slice(0, 32)
      const known = devices.get(key)
      let text
      try {
        text = await read(`${METADATA_DIR}/${name}`)
      } catch (e) {
        if (known) known.unavailable = true
        if (isThrottle(e)) {
          pausedUntil = now() + Math.max(LIMITS.pauseMs, retryAfterMs(e))
          diag('throttled', {})
          return false
        }
        return true
      }
      const p = await parseProjection(text, name)
      if (!p) { if (known) known.unavailable = true; return true }
      if (known && p.revision < known.projection.revision) return true // an older copy arriving late
      devices.set(key, { projection: p, unavailable: false })
      return true
    })
    for (const name of unread) { const d = devices.get(name.slice(0, 32)); if (d) d.unavailable = true }
  }

  return {
    /** Refresh unless one ran within the last 5 minutes (or reads are paused). */
    refresh({ force = false } = {}) {
      if (inflight) return inflight
      const t = now()
      if (t < pausedUntil) return Promise.resolve(false)
      if (!force && lastRefreshAt !== null && t - lastRefreshAt < LIMITS.refreshMs) return Promise.resolve(false)
      inflight = doRefresh().finally(() => { inflight = null; generation++ })
      return inflight.then(() => true)
    },
    /** Increments once per completed refresh. */
    get generation() { return generation },
    get enabled() { return enabled },
    /**
     * Every device that has announced itself (a valid file in agent-metadata/), for the lanes
     * panel and the "waiting for a PC" state (docs/spec/Domain-lanes.md).
     * @returns {{ key, name, stale, lastSeenMs }[]} sorted by key
     */
    devices() {
      const t = now()
      return [...devices.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, d]) => {
        const p = d.projection
        const staleAfter = p.heartbeat ? Math.max(LIMITS.staleFloorMs, 2 * p.heartbeat * 60000) : LIMITS.staleFloorMs
        return { key, name: p.name, stale: d.unavailable || t - p.lastSeenMs > staleAfter, lastSeenMs: p.lastSeenMs }
      })
    },
    /**
     * Live bindings whose binding-time fingerprint matches this row's fingerprint.
     * @returns {{ deviceKey, deviceName, sessionId, url, stale, lastSeenMs }[]}
     */
    bindingsFor(taskId, rowFingerprint) {
      if (!taskId || !rowFingerprint) return []
      const out = []
      const seen = new Set()
      const t = now()
      for (const [key, d] of [...devices.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
        const p = d.projection
        const task = p.tasks.get(String(taskId))
        if (!task || task.fingerprint !== rowFingerprint) continue
        const staleAfter = p.heartbeat ? Math.max(LIMITS.staleFloorMs, 2 * p.heartbeat * 60000) : LIMITS.staleFloorMs
        const stale = d.unavailable || t - p.lastSeenMs > staleAfter
        for (const b of task.bindings) {
          if (b.status !== 'live') continue
          const id = `${key}|${b.sessionId}`
          if (seen.has(id)) continue
          seen.add(id)
          out.push({ deviceKey: key, deviceName: p.name, sessionId: b.sessionId, url: b.url, stale, lastSeenMs: p.lastSeenMs })
        }
      }
      return out
    },
  }
}
