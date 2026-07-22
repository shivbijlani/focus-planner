/**
 * Storage diagnostics — a copyable snapshot of the app's storage + sync state.
 *
 * Motivation: debugging "journals missing / stale store / quota overflow" issues
 * previously required poking at localStorage + IndexedDB by hand over CDP (and
 * fighting expiring OAuth tokens). This module produces a single, safe report
 * the user can copy from Settings → Diagnostics (and that the app can also write
 * to the active source as `diagnostics.md`).
 *
 * SAFETY: the report NEVER includes secrets. For sync tokens it reports only the
 * provider id, expiry, and whether a refresh token exists — never the token
 * values themselves.
 *
 * NOTE: this module is imported by the low-level storage/write path
 * (`storage.js`) to record events, so it must NOT statically import `storage.js`
 * or `sources.js` (that would create an import cycle). It lazy-imports them
 * inside `gatherDiagnostics()` instead.
 */

const PREFIX = 'fp-file:'
const ENABLE_KEY = 'fp-diagnostics-enabled'
const MAX_EVENTS = 100
const events = []

/** Whether diagnostic event capture is enabled (persisted across sessions). */
export function isDiagnosticsEnabled() {
  try { return localStorage.getItem(ENABLE_KEY) === '1' } catch { return false }
}

/** Turn diagnostic event capture on/off. */
export function setDiagnosticsEnabled(on) {
  try { localStorage.setItem(ENABLE_KEY, on ? '1' : '0') } catch { /* ignore */ }
}

/**
 * Record a diagnostic event (e.g. a sync error or a quota failure). No-op unless
 * diagnostics are enabled, so it's cheap to call from hot paths.
 */
export function recordDiagnosticEvent(type, message, extra) {
  if (!isDiagnosticsEnabled()) return
  try {
    events.push({
      t: new Date().toISOString(),
      type: String(type),
      message: String(message ?? '').slice(0, 500),
      ...(extra ? { extra } : {}),
    })
    while (events.length > MAX_EVENTS) events.shift()
  } catch { /* never throw from logging */ }
}

/** Snapshot of captured events (most recent last). */
export function getDiagnosticEvents() {
  return events.slice()
}

/** Clear the captured-event buffer. */
export function clearDiagnosticEvents() {
  events.length = 0
}

function summarizeLocalStorage() {
  const out = { fileCount: 0, chars: 0, byExt: {}, largest: [], journal: {} }
  const files = []
  const ids = []
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)
    if (!k || !k.startsWith(PREFIX)) continue
    const name = k.slice(PREFIX.length)
    const len = (localStorage.getItem(k) || '').length
    out.fileCount++
    out.chars += len + k.length
    const ext = (name.match(/\.[a-z0-9]+$/i) || ['(none)'])[0].toLowerCase()
    out.byExt[ext] = (out.byExt[ext] || 0) + 1
    files.push({ name, chars: len })
    const m = name.match(/^journal\/task-(\d+)\.md$/)
    if (m) ids.push(parseInt(m[1], 10))
  }
  out.approxBytesUtf16 = out.chars * 2
  files.sort((a, b) => b.chars - a.chars)
  out.largest = files.slice(0, 10).map(f => ({ name: f.name, kb: Math.round(f.chars / 1024) }))
  const real = ids.filter(n => n < 100000).sort((a, b) => a - b)
  const realSet = new Set(real)
  const junk = ids.filter(n => n >= 100000)
  out.journal = {
    count: real.length,
    min: real[0] ?? null,
    max: real[real.length - 1] ?? null,
    junkCount: junk.length,
    gaps: [],
  }
  if (real.length) {
    for (let n = real[0]; n <= real[real.length - 1]; n++) {
      if (!realSet.has(n)) out.journal.gaps.push(n)
    }
  }
  return out
}

async function summarizeFolderSync() {
  if (typeof indexedDB === 'undefined' || !indexedDB) return { present: false }
  try {
    if (indexedDB.databases) {
      const dbs = await indexedDB.databases()
      if (!dbs.some(d => d.name === 'folder-sync')) return { present: false }
    }
  } catch { /* fall through and try to open */ }

  const db = await new Promise((res, rej) => {
    const r = indexedDB.open('folder-sync')
    r.onsuccess = () => res(r.result)
    r.onerror = () => rej(r.error)
  })
  try {
    const stores = Array.from(db.objectStoreNames)
    const out = { present: true, stores }
    const count = (s) => new Promise((res) => {
      try {
        const rq = db.transaction(s, 'readonly').objectStore(s).count()
        rq.onsuccess = () => res(rq.result)
        rq.onerror = () => res(null)
      } catch { res(null) }
    })
    if (stores.includes('queue')) out.queueLen = await count('queue')
    if (stores.includes('meta')) out.metaCount = await count('meta')
    if (stores.includes('tokens')) {
      const toks = await new Promise((res) => {
        try {
          const rq = db.transaction('tokens', 'readonly').objectStore('tokens').getAll()
          rq.onsuccess = () => res(rq.result || [])
          rq.onerror = () => res([])
        } catch { res([]) }
      })
      // SAFETY: expiry + refresh-presence only. Never the token values.
      out.tokens = toks.map(t => ({
        provider: t.providerId || t.provider || '?',
        expiresAt: t.expiresAt ?? null,
        expiresInSec: t.expiresAt ? Math.round((t.expiresAt - Date.now()) / 1000) : null,
        hasRefreshToken: !!t.refreshToken,
      }))
    }
    return out
  } finally {
    try { db.close() } catch { /* ignore */ }
  }
}

/**
 * Gather a full diagnostics snapshot. Every section is defensive: a failure in
 * one area is captured as an `*Error` field rather than aborting the report.
 */
export async function gatherDiagnostics() {
  const d = { generatedAt: new Date().toISOString() }
  // Lazy-imported here to avoid an import cycle with storage.js (which imports
  // recordDiagnosticEvent from this module).
  let storage = null
  let sources = null
  try { storage = await import('./storage.js') } catch { /* ignore */ }
  try { sources = await import('./sources.js') } catch { /* ignore */ }
  try { d.build = storage?.getBuildId?.() } catch (e) { d.buildError = String(e) }
  try { d.userAgent = navigator.userAgent } catch { /* ignore */ }
  try {
    d.activeSourceId = sources?.getActiveSourceId?.()
    d.activeProvider = sources?.getActiveSource?.()?.providerType ?? null
    d.sources = (sources?.getSources?.() ?? []).map(s => ({ id: s.id, provider: s.providerType, name: s.name }))
  } catch (e) { d.sourcesError = String(e) }
  try { d.localStorage = summarizeLocalStorage() } catch (e) { d.localStorageError = String(e) }
  try {
    if (navigator.storage?.estimate) {
      const est = await navigator.storage.estimate()
      d.storageEstimate = { quota: est.quota, usage: est.usage }
    }
    if (navigator.storage?.persisted) d.storagePersisted = await navigator.storage.persisted()
  } catch (e) { d.estimateError = String(e) }
  try { d.syncStatus = storage?.getSyncStatus?.() } catch (e) { d.syncStatusError = String(e) }
  try { d.folderSync = await summarizeFolderSync() } catch (e) { d.folderSyncError = String(e) }
  d.diagnosticsEnabled = isDiagnosticsEnabled()
  d.recentEvents = getDiagnosticEvents()
  return d
}

function mb(bytes) {
  return (bytes / 1048576).toFixed(2)
}

/** Render a gathered diagnostics object as copy-pasteable Markdown. */
export function formatDiagnosticsReport(d) {
  const L = []
  L.push('# Planner diagnostics')
  L.push(`Generated: ${d.generatedAt}`)
  L.push(`Build: ${d.build ?? d.buildError ?? '?'}`)
  L.push(`Active source: ${d.activeProvider ?? '?'} (${d.activeSourceId ?? '?'})`)
  if (Array.isArray(d.sources)) {
    L.push(`Sources: ${d.sources.map(s => `${s.provider}${s.id ? `#${s.id}` : ''}`).join(', ') || '(none)'}`)
  }

  const ls = d.localStorage
  if (ls) {
    L.push('', '## Browser Storage (localStorage)')
    L.push(`- Files: ${ls.fileCount}`)
    L.push(`- Size: ${mb(ls.approxBytesUtf16)} MB (UTF-16) · ${(ls.chars / 1048576).toFixed(2)} M chars`)
    const j = ls.journal || {}
    L.push(`- Journals: ${j.count} (min ${j.min}, max ${j.max}, junk ${j.junkCount})`)
    if (j.gaps?.length) L.push(`- Journal gaps (${j.gaps.length}): ${j.gaps.join(', ')}`)
    if (ls.largest?.length) L.push(`- Largest: ${ls.largest.map(x => `${x.name} (${x.kb} KB)`).join(', ')}`)
    if (ls.byExt) L.push(`- By type: ${Object.entries(ls.byExt).map(([k, v]) => `${k}=${v}`).join(', ')}`)
  } else if (d.localStorageError) {
    L.push('', `## Browser Storage — ERROR: ${d.localStorageError}`)
  }

  if (d.storageEstimate) {
    L.push('', '## Browser quota (IndexedDB/OPFS bucket)')
    L.push(`- Usage: ${mb(d.storageEstimate.usage)} MB`)
    L.push(`- Quota: ${mb(d.storageEstimate.quota)} MB`)
    L.push(`- Persisted: ${d.storagePersisted ?? 'unknown'}`)
  }

  if (d.folderSync) {
    L.push('', '## Sync (folder-sync)')
    if (!d.folderSync.present) {
      L.push('- Not configured')
    } else {
      if (d.folderSync.queueLen != null) L.push(`- Pending queue: ${d.folderSync.queueLen}`)
      if (d.folderSync.metaCount != null) L.push(`- Tracked files (meta): ${d.folderSync.metaCount}`)
      for (const t of d.folderSync.tokens || []) {
        const exp = t.expiresInSec == null ? '?' : `${t.expiresInSec}s`
        L.push(`- Token ${t.provider}: expires in ${exp} (refresh: ${t.hasRefreshToken ? 'yes' : 'no'})`)
      }
    }
  }

  if (d.syncStatus) {
    L.push('', '## Sync status')
    try { L.push('```json', JSON.stringify(d.syncStatus, null, 2), '```') }
    catch { L.push('(unserializable)') }
  }

  if (d.recentEvents?.length) {
    L.push('', `## Recent events (${d.recentEvents.length})`)
    for (const e of d.recentEvents.slice(-25)) L.push(`- ${e.t} [${e.type}] ${e.message}`)
  }

  L.push('', '## Raw', '```json', safeJson(d), '```')
  return L.join('\n')
}

function safeJson(d) {
  try { return JSON.stringify(d, null, 2) }
  catch { return '{"error":"unserializable"}' }
}
