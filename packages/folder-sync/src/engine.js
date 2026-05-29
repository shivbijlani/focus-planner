// Engine — the consumer-facing API.
// - All reads/writes go to the local adapter immediately.
// - Writes enqueue the filename for the SW to sync.
// - OAuth consent flows are launched here (main thread).
// - Status events come back from the SW via BroadcastChannel.

import { enqueue, peekAll } from './queue.js'
import { getTokens, clearTokens } from './auth/tokenStore.js'
import { idbSet, idbGet } from './idb.js'

const CHANNEL = 'folder-sync'
const META_STORE = 'meta'
const INTENDED_KEY = 'folder-sync:intended-providers'
const AUTO_RECONNECT_FLAG = 'folder-sync:auto-reconnected'

function readIntended() {
  if (typeof localStorage === 'undefined') return new Set()
  try {
    const raw = localStorage.getItem(INTENDED_KEY)
    return new Set(raw ? JSON.parse(raw) : [])
  } catch { return new Set() }
}
function writeIntended(set) {
  if (typeof localStorage === 'undefined') return
  try { localStorage.setItem(INTENDED_KEY, JSON.stringify([...set])) } catch { /* ignore */ }
}
function addIntended(id) {
  const s = readIntended(); s.add(id); writeIntended(s)
}
function removeIntended(id) {
  const s = readIntended(); s.delete(id); writeIntended(s)
}

async function mirrorWrite(name, content) {
  await idbSet(META_STORE, `local:${name}`, { content, mtime: Date.now() })
}
async function mirrorDelete(name) {
  await idbSet(META_STORE, `local:${name}`, { deleted: true, mtime: Date.now() })
}
async function mirrorRead(name) {
  const r = await idbGet(META_STORE, `local:${name}`)
  return r && !r.deleted ? r.content : null
}

export function createSyncEngine({ localAdapter, providers = [], redirectUri = (typeof window !== 'undefined' ? window.location.origin + window.location.pathname : '') }) {
  if (!localAdapter) throw new Error('createSyncEngine: localAdapter is required')

  const providerMap = new Map(providers.map(p => [p.id, p]))
  const listeners = new Set()
  let status = {
    state: 'idle',
    lastSync: null,
    error: null,
    providers: {}, // providerId -> { connected, state, error }
  }

  // Listen for SW status broadcasts.
  if (typeof BroadcastChannel !== 'undefined') {
    const bc = new BroadcastChannel(CHANNEL)
    bc.onmessage = (evt) => {
      if (!evt.data || evt.data.type !== 'status') return
      status = { ...status, ...evt.data.status }
      emit()
      maybeAutoReconnect()
    }
  }

  // Listen for "remote-update" messages: SW pulled a remote change into
  // the IDB mirror; sync it back into the consumer-visible local adapter.
  if (typeof navigator !== 'undefined' && navigator.serviceWorker) {
    navigator.serviceWorker.addEventListener('message', async (evt) => {
      const msg = evt.data
      if (!msg || msg.type !== 'remote-update') return
      const content = await mirrorRead(msg.name)
      if (content == null) {
        await localAdapter.deleteFile(msg.name)
      } else {
        await localAdapter.writeFile(msg.name, content)
      }
      // Tell consumer to refresh
      for (const fn of listeners) {
        try { fn({ ...status, lastRemoteUpdate: { name: msg.name, at: Date.now() } }) } catch { /* ignore */ }
      }
    })
  }

  function emit() {
    for (const fn of listeners) {
      try { fn(status) } catch { /* ignore */ }
    }
  }

  async function getSyncSwRegistration() {
    if (typeof navigator === 'undefined' || !navigator.serviceWorker) return null
    try {
      const regs = await navigator.serviceWorker.getRegistrations()
      // Prefer the SW whose scope ends with '/folder-sync/' (our registered scope).
      return regs.find(r => r.scope && r.scope.includes('/folder-sync/')) || null
    } catch {
      return null
    }
  }

  async function nudgeSW(reason = 'write') {
    const reg = await getSyncSwRegistration()
    if (!reg) return
    const sw = reg.active || reg.waiting || reg.installing
    if (!sw) return
    const providerConfigs = providers.map(p => ({ id: p.id, clientId: p.clientId }))
    sw.postMessage({ type: 'sync', reason, providers: providerConfigs })
  }

  async function refreshConnectedFlags() {
    const connected = {}
    for (const p of providers) {
      const tok = await getTokens(p.id)
      connected[p.id] = { connected: !!tok, state: tok ? 'idle' : 'disconnected', error: null }
      // Backfill: any provider with stored tokens is presumed intentionally
      // connected. Ensures the auto-reconnect-on-load behaviour also kicks
      // in for users who connected before this feature shipped.
      if (tok) addIntended(p.id)
    }
    status = { ...status, providers: connected }
    emit()
  }

  // Handle OAuth redirect: if URL contains code+state and we recognise it, complete auth.
  async function maybeCompleteOAuthRedirect() {
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    if (!params.has('code') || !params.has('state')) return
    for (const p of providers) {
      try {
        const ok = await p.completeAuth(params, redirectUri)
        if (ok) {
          window.history.replaceState({}, document.title, window.location.pathname)
          addIntended(p.id)
          // Allow auto-reconnect to fire again on future breakages this session.
          try { sessionStorage.removeItem(`${AUTO_RECONNECT_FLAG}:${p.id}`) } catch { /* ignore */ }
          await refreshConnectedFlags()
          await nudgeSW('post-auth')
          return
        }
      } catch (e) {
        console.error(`[folder-sync] ${p.id} completeAuth failed:`, e)
      }
    }
  }

  // If a provider the user previously connected is reporting it can no
  // longer sync (token expired / refresh revoked / tokens missing), redirect
  // them to sign in on page load. This prevents the user from editing data
  // locally while sync is broken — those edits would later clobber changes
  // made on another device once sync resumes.
  //
  // Skipped when:
  //   - offline (can't reach the IdP),
  //   - returning from an OAuth redirect (URL has code/state),
  //   - the user voluntarily disconnected (provider not in intended set),
  //   - we already auto-redirected this session (avoid loops if the user
  //     cancels the sign-in screen).
  let autoReconnectAttempted = false
  function maybeAutoReconnect() {
    if (autoReconnectAttempted) return
    if (typeof window === 'undefined' || typeof navigator === 'undefined') return
    if (!navigator.onLine) return
    const params = new URLSearchParams(window.location.search)
    if (params.has('code') || params.has('state') || params.has('error')) return
    const intended = readIntended()
    if (intended.size === 0) return
    for (const p of providers) {
      if (!intended.has(p.id)) continue
      const ps = status.providers?.[p.id]
      if (!ps || ps.state !== 'reconnect-required') continue
      const flagKey = `${AUTO_RECONNECT_FLAG}:${p.id}`
      try { if (sessionStorage.getItem(flagKey)) continue } catch { /* ignore */ }
      autoReconnectAttempted = true
      try { sessionStorage.setItem(flagKey, '1') } catch { /* ignore */ }
      Promise.resolve(p.startAuth(redirectUri)).catch(err => {
        console.warn('[folder-sync] auto-reconnect failed:', err)
      })
      return
    }
  }

  // Periodic + event-driven nudges
  if (typeof window !== 'undefined') {
    window.addEventListener('online', () => nudgeSW('online'))
    document.addEventListener?.('visibilitychange', () => {
      if (document.visibilityState === 'visible') nudgeSW('visibility')
    })
  }

  // Kick-off
  refreshConnectedFlags()
  maybeCompleteOAuthRedirect()
  // Drain any queued writes from a previous session (e.g. the user reloaded
  // before sync finished). Wait one tick so the SW has time to register.
  setTimeout(() => { nudgeSW('init').catch(() => {}) }, 500)

  return {
    // ---- local I/O (always immediate) ----
    async readFile(name) {
      return localAdapter.readFile(name)
    },
    async writeFile(name, contents) {
      const res = await localAdapter.writeFile(name, contents)
      await mirrorWrite(name, contents)
      await enqueue(name)
      nudgeSW('write')
      return res
    },
    async deleteFile(name) {
      await localAdapter.deleteFile(name)
      await mirrorDelete(name)
      await enqueue(name) // SW will see local missing → delete remote
      nudgeSW('delete')
    },
    async listFiles() {
      return localAdapter.listFiles()
    },
    async getFolderName() {
      return localAdapter.getFolderName()
    },
    async initLocal() {
      return localAdapter.init?.() ?? true
    },
    localAdapter,

    // ---- cloud sync targets ----
    listProviders() {
      return providers.map(p => ({ id: p.id, displayName: p.displayName }))
    },
    async connect(providerId) {
      const p = providerMap.get(providerId)
      if (!p) throw new Error(`Unknown provider: ${providerId}`)
      // Record user intent up-front so a successful sign-in (which redirects
      // away from the app and back) is recognised as intentional. Without
      // this, the post-redirect handler still marks them intended on
      // completeAuth — but recording it here is harmless and covers any
      // provider that may not strictly return through completeAuth.
      addIntended(providerId)
      await p.startAuth(redirectUri) // redirects; flow resumes via maybeCompleteOAuthRedirect
    },
    async disconnect(providerId) {
      removeIntended(providerId)
      try { sessionStorage.removeItem(`${AUTO_RECONNECT_FLAG}:${providerId}`) } catch { /* ignore */ }
      await clearTokens(providerId)
      await refreshConnectedFlags()
    },
    async isConnected(providerId) {
      return !!(await getTokens(providerId))
    },
    async syncNow() {
      await nudgeSW('manual')
    },
    async pendingFiles() {
      return peekAll()
    },

    // ---- status ----
    get status() { return status },
    subscribe(fn) {
      listeners.add(fn)
      fn(status)
      return () => listeners.delete(fn)
    },
  }
}

/**
 * Helper for consumers: register the package's service worker.
 * The SW file must be served from the app's origin — copy
 * `packages/folder-sync/src/sw.js` (and its imports) into your public/ dir
 * during build, then call this with the served path.
 */
export async function registerServiceWorker(url, options = { type: 'module' }) {
  if (typeof navigator === 'undefined' || !navigator.serviceWorker) {
    console.warn('[folder-sync] service worker not supported')
    return null
  }
  try {
    const reg = await navigator.serviceWorker.register(url, options)
    return reg
  } catch (e) {
    console.error('[folder-sync] SW registration failed:', e)
    return null
  }
}
