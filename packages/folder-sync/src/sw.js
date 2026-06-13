// Service worker — drains the dirty-file queue and pulls remote changes.
// Registered with `{ type: 'module' }`.  Chromium / latest Firefox / Safari 16+.

import { peekAll, dequeue } from './queue.js'
import { getTokens } from './auth/tokenStore.js'
import { idbGet, idbSet, idbKeys, idbDel } from './idb.js'
import { reconcileRecordsFile, isSidecarPath } from './records.js'
import { filesToDeleteLocally, planPlainPush, shouldPullRemote, isMassDeletion } from './reconcile.js'
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
// NOTE: these MUST match the actual top-level file names the app uses
// (see src/config/branding.js: PLAN_FILE / COMPLETED_FILE). The app was
// rebranded from `focus-plan*.md` to `planner*.md`; the old key names left the
// real files (planner.md / planner-completed.md) WITHOUT record-level merge,
// so they were synced as opaque blobs and were vulnerable to being clobbered or
// wiped. Map both the current and legacy names so per-row tombstone merge
// applies regardless of which naming a given store still uses.
const RECORD_CODECS = {
  'planner.md': mdTableCodec,
  'planner-completed.md': mdTableCodec,
  'focus-plan.md': mdTableCodec,            // legacy (pre-rebrand)
  'focus-plan-completed.md': mdTableCodec,  // legacy (pre-rebrand)
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
      // Only reconcile remote deletions when exactly one provider is syncing.
      // With multiple targets a file may legitimately live on one and not the
      // other, so auto-deleting on absence could destroy data.
      const reconcileDeletes = currentProviders.length === 1
      for (const p of currentProviders) {
        try {
          await syncOneProvider(p, reconcileDeletes)
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

async function syncOneProvider(provider, reconcileDeletes = false) {
  const tok = await getTokens(provider.id)
  if (!tok) throw new Error('reconnect-required')

  // List the remote up front. Knowing what already exists in the cloud lets the
  // push step avoid clobbering pre-existing remote data on the FIRST sync after
  // a provider is connected (the data-loss-on-connect bug): queued local
  // deletes/overwrites must never destroy files we've never seen on this remote.
  const remoteList = await provider.listRemote(provider)
  const remoteNames = new Set(remoteList.map(i => i.name))

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
    const tracked = !!(await getRemoteMtime(provider.id, name))
    const action = planPlainPush({ localContent, tracked, remoteHas: remoteNames.has(name) })
    if (action === 'delete') {
      await provider.deleteRemote(provider, name)
      await clearRemoteMtime(provider.id, name)
      remoteNames.delete(name)
    } else if (action === 'write') {
      const res = await provider.writeRemote(provider, name, localContent)
      await setRemoteMtime(provider.id, name, res.mtime)
      remoteNames.add(name)
    }
    // action === 'skip': first contact with pre-existing remote data — leave the
    // cloud copy intact; the pull step below downloads it (cloud wins).
    await dequeue(name)
  }

  // 2) Pull: compare mtimes against the up-front listing, download newer. Files
  // we just created/updated in the push step are now tracked with an mtime >=
  // the listed one, so they're skipped; files we 'skip'-ped are untracked and
  // get pulled here so the cloud copy is preserved locally.
  for (const item of remoteList) {
    if (isSidecarPath(item.name)) continue
    const codec = RECORD_CODECS[item.name]
    if (codec) {
      await reconcileRecord(provider, item.name, codec)
      await setRemoteMtime(provider.id, item.name, item.mtime)
      continue
    }
    const lastSeen = await getRemoteMtime(provider.id, item.name)
    // Pull when the remote is newer OR when we have no local copy (a stale
    // mtime must not strand a file that isn't actually present locally — the
    // "journals don't come down on reconnect" bug). readRemote returning null
    // (file vanished between list and read) still guards against resurrecting a
    // remote deletion.
    const localPresent = (await readLocal(item.name)) != null
    if (!shouldPullRemote({ lastSeen, remoteMtime: item.mtime, localPresent })) continue
    const remoteContent = await provider.readRemote(provider, item.name)
    if (remoteContent != null) {
      await writeLocal(item.name, remoteContent)
      await setRemoteMtime(provider.id, item.name, item.mtime)
    }
  }

  // 3) Reconcile remote deletions: a file we PREVIOUSLY SYNCED with this
  // provider (proven by a tracked remote mtime) that has now vanished from the
  // remote listing was deleted on another device — remove our local copy so it
  // doesn't reappear as a ghost on next launch.
  //
  // CRITICAL: only files we've actually synced (tracked mtime) are eligible.
  // We must NOT consider the whole local mirror here: on a freshly-connected
  // provider that already holds a file or two, every local-only file (e.g.
  // journals never pushed yet) is absent from the remote listing and would be
  // wiped — which is exactly the "connecting OneDrive blew away my files" bug.
  // Untracked local files are pushed up by the push step instead, never deleted.
  if (reconcileDeletes && remoteList.length > 0) {
    const pending = new Set(await peekAll())
    const candidates = new Set(await trackedRemoteNames(provider.id))
    const toDelete = filesToDeleteLocally({
      candidates,
      remoteNames,
      pending,
      isSidecar: isSidecarPath,
      isRecordFile: (name) => !!RECORD_CODECS[name],
    })
    // Mass-deletion circuit breaker: if EVERY sync-managed plain file we track
    // is suddenly absent from the remote, that's almost certainly a wiped or
    // partial remote listing — not the user deleting everything. Skip deletion
    // and let the push step re-upload. Worst case is a harmless ghost file.
    const deletableCount = [...candidates].filter(
      (name) => !isSidecarPath(name) && !RECORD_CODECS[name] && !pending.has(name),
    ).length
    if (!isMassDeletion({ deletableCount, toDeleteCount: toDelete.length })) {
      for (const name of toDelete) {
        await deleteLocal(name)
        await clearRemoteMtime(provider.id, name)
      }
    } else {
      console.warn(`[folder-sync sw] ${provider.id}: skipping mass deletion of ${toDelete.length} file(s) — remote looks wiped/partial`)
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
async function deleteLocal(name) {
  // Tombstone the mirror entry and tell clients to drop the file from the
  // active store. The engine's `remote-update` handler sees the tombstone
  // (mirror reads null) and calls the local adapter's deleteFile.
  await idbSet(META_STORE, `local:${name}`, { deleted: true, mtime: Date.now() })
  const clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' })
  for (const c of clients) c.postMessage({ type: 'remote-update', name })
}
async function getRemoteMtime(providerId, name) {
  return (await idbGet(META_STORE, `mtime:${providerId}:${name}`)) || null
}
async function setRemoteMtime(providerId, name, mtime) {
  await idbSet(META_STORE, `mtime:${providerId}:${name}`, mtime)
}
async function clearRemoteMtime(providerId, name) {
  await idbDel(META_STORE, `mtime:${providerId}:${name}`)
}

// Names of files we've previously synced with a provider (have a stored remote
// mtime). Used to scope deletion reconciliation to sync-managed files only.
async function trackedRemoteNames(providerId) {
  const prefix = `mtime:${providerId}:`
  const keys = await idbKeys(META_STORE)
  const names = []
  for (const k of keys) {
    if (typeof k === 'string' && k.startsWith(prefix)) names.push(k.slice(prefix.length))
  }
  return names
}

async function broadcast(partial) {
  const bc = new BroadcastChannel(CHANNEL)
  bc.postMessage({ type: 'status', status: partial })
  bc.close()
}
