// Service worker — drains the dirty-file queue and pulls remote changes.
// Registered with `{ type: 'module' }`.  Chromium / latest Firefox / Safari 16+.

import { peekAll, dequeue } from './queue.js'
import { getTokens } from './auth/tokenStore.js'
import { idbGet, idbSet } from './idb.js'
import { reconcileRecordsFile, isSidecarPath } from './records.js'
import { mdTableCodec } from './codecs/mdTable.js'
import { oneDriveProvider } from './providers/oneDrive.js'
import { googleDriveProvider } from './providers/googleDrive.js'
import { mockProvider } from './providers/mock.js'

const CHANNEL = 'folder-sync'
const META_STORE = 'meta'

// Files that sync at the record (row) level — per-row merge with tombstones —
// instead of as opaque whole-file blobs, keyed by file name -> codec. This is
// what prevents a stale push on one device from resurrecting a row deleted on
// another. Files without a codec keep the legacy whole-file last-write-wins path.
const RECORD_CODECS = {
  'focus-plan.md': mdTableCodec,
  'focus-plan-completed.md': mdTableCodec,
}

const PROVIDER_FACTORIES = {
  'onedrive': oneDriveProvider,
  'google-drive': googleDriveProvider,
  'mock': mockProvider,
}

let currentProviders = []

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (evt) => evt.waitUntil(self.clients.claim()))

self.addEventListener('message', (evt) => {
  const msg = evt.data
  if (!msg) return
  if (msg.type === 'sync') {
    currentProviders = (msg.providers || []).map(p => {
      const factory = PROVIDER_FACTORIES[p.id]
      return factory ? factory({ clientId: p.clientId }) : null
    }).filter(Boolean)
    evt.waitUntil(runSync(msg.reason || 'message'))
  }
})

// Background Sync API
self.addEventListener('sync', (evt) => {
  if (evt.tag === 'folder-sync') evt.waitUntil(runSync('background-sync'))
})
self.addEventListener('periodicsync', (evt) => {
  if (evt.tag === 'folder-sync') evt.waitUntil(runSync('periodic-sync'))
})

let inFlight = null
async function runSync(reason) {
  if (inFlight) return inFlight
  inFlight = (async () => {
    await broadcast({ state: 'syncing', error: null })
    try {
      if (!currentProviders.length) {
        await broadcast({ state: 'idle' })
        return
      }
      if (!self.navigator.onLine) {
        await broadcast({ state: 'offline' })
        return
      }
      const providerStatuses = {}
      for (const p of currentProviders) {
        try {
          await syncOneProvider(p)
          providerStatuses[p.id] = { connected: true, state: 'synced', error: null }
        } catch (e) {
          const msg = (e && e.message) || String(e)
          if (msg === 'reconnect-required') {
            providerStatuses[p.id] = { connected: false, state: 'reconnect-required', error: msg }
          } else {
            providerStatuses[p.id] = { connected: true, state: 'error', error: msg }
          }
          console.error(`[folder-sync sw] ${p.id} sync error:`, e)
        }
      }
      const states = Object.values(providerStatuses).map(s => s.state)
      const overall = states.includes('reconnect-required')
        ? 'reconnect-required'
        : states.every(s => s === 'synced')
          ? 'synced'
          : 'idle'
      await broadcast({ state: overall, lastSync: Date.now(), providers: providerStatuses, reason })
    } finally {
      inFlight = null
    }
  })()
  return inFlight
}

async function syncOneProvider(provider) {
  const tok = await getTokens(provider.id)
  if (!tok) throw new Error('reconnect-required')

  // 1) Push: drain queue.
  const dirty = await peekAll()
  for (const name of dirty) {
    // Sidecars are sync metadata, not user data — never push them directly.
    if (isSidecarPath(name)) { await dequeue(name); continue }
    const codec = RECORD_CODECS[name]
    if (codec) {
      // Record-level merge: deletions are carried as tombstones, so pushing
      // can never resurrect a row another device deleted.
      await reconcileRecord(provider, name, codec)
      await dequeue(name)
      continue
    }
    const localContent = await readLocal(name)
    if (localContent === null) {
      // local was deleted
      await provider.deleteRemote(provider, name)
    } else {
      const res = await provider.writeRemote(provider, name, localContent)
      await setRemoteMtime(provider.id, name, res.mtime)
    }
    await dequeue(name)
  }

  // 2) Pull: list remote, compare mtimes, download newer.
  const remoteList = await provider.listRemote(provider)
  for (const item of remoteList) {
    if (isSidecarPath(item.name)) continue
    const codec = RECORD_CODECS[item.name]
    if (codec) {
      await reconcileRecord(provider, item.name, codec)
      await setRemoteMtime(provider.id, item.name, item.mtime)
      continue
    }
    const lastSeen = await getRemoteMtime(provider.id, item.name)
    if (lastSeen && lastSeen >= item.mtime) continue
    const remoteContent = await provider.readRemote(provider, item.name)
    if (remoteContent != null) {
      await writeLocal(item.name, remoteContent)
      await setRemoteMtime(provider.id, item.name, item.mtime)
    }
  }
}

// Record-level reconcile for one file, symmetric across push and pull: parses
// both sides into records, merges per-row with tombstones, writes the merged
// result + sidecar back to whichever side changed.
async function reconcileRecord(provider, name, codec) {
  const safe = async (fn) => { try { return await fn() } catch { return null } }
  return reconcileRecordsFile({
    path: name,
    codec,
    local: {
      readContent: p => readLocal(p),
      writeContent: (p, content) => writeLocal(p, content),
      readSidecar: p => readLocal(p),
      writeSidecar: (p, content) => writeLocal(p, content),
    },
    remote: {
      readContent: p => safe(() => provider.readRemote(provider, p)),
      writeContent: (p, content) => provider.writeRemote(provider, p, content),
      readSidecar: p => safe(() => provider.readRemote(provider, p)),
      writeSidecar: (p, content) => provider.writeRemote(provider, p, content),
    },
  })
}

// ---- local I/O from SW context ----
// The SW has no direct adapter reference. It uses a *shared protocol*:
//  - For browserStorage we can't access localStorage from a SW, so we proxy
//    through clients via postMessage. For now we restrict the SW to working
//    on shared IndexedDB-mirrored data: we keep a mirror of writes in the
//    'meta' store keyed by `local:<name>` so the SW can read latest content
//    even when no client is open. Writes from the engine update both.
//
// (When a future FSA adapter is involved, the engine can pass a sharable
// directory handle via postMessage — out of scope for v0.0.1.)
//
// To keep things simple and working today: engine mirrors every write to
// IndexedDB under store 'meta' key `local:<name>` and deletes mark it null.

async function readLocal(name) {
  const rec = await idbGet(META_STORE, `local:${name}`)
  if (!rec) return null
  return rec.deleted ? null : rec.content
}
async function writeLocal(name, content) {
  await idbSet(META_STORE, `local:${name}`, { content, mtime: Date.now() })
  // Notify clients so they can refresh their in-memory state / re-read via adapter.
  // Use `includeUncontrolled: true` because the SW's scope is narrow
  // (`/folder-sync/`) and the app page may not be controlled by this SW.
  const clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' })
  for (const c of clients) c.postMessage({ type: 'remote-update', name })
}
async function getRemoteMtime(providerId, name) {
  return (await idbGet(META_STORE, `mtime:${providerId}:${name}`)) || null
}
async function setRemoteMtime(providerId, name, mtime) {
  await idbSet(META_STORE, `mtime:${providerId}:${name}`, mtime)
}

async function broadcast(partial) {
  const bc = new BroadcastChannel(CHANNEL)
  bc.postMessage({ type: 'status', status: partial })
  bc.close()
}
