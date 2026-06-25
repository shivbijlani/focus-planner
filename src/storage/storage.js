/**
 * Storage abstraction layer for focus-planner.
 * Supports: FSA (local), OneDrive, Google Drive.
 */
import {
  createSyncEngine,
  registerServiceWorker,
  oneDriveProvider,
  googleDriveProvider,
} from '../../packages/folder-sync/src/index.js'
import { LocalStorageProvider } from './localstorage-provider.js'
import { scaffoldAgentsDoc } from '../config/agentsDoc.js'
import { getActiveTombstoneIds } from '../idTombstones.js'

// Merge recently-deleted task IDs (tombstones) into a journal-ID skip set so a
// freed ID is not reused while it could still be resurrected by sync (#314).
function withTombstones(journalIds) {
  const out = new Set(journalIds || [])
  for (const id of getActiveTombstoneIds()) out.add(id)
  return out
}

export { parseTodos } from './fsa.js'

// Sync-target status vocabulary used by the planner UI. The service-worker
// engine reports lower-level states ({ connected, state }); the status shim
// below maps those onto these app-level values.
export const TARGET_STATUS = {
  DISCONNECTED: 'disconnected',
  PENDING: 'pending',
  SYNCING: 'syncing',
  SYNCED: 'synced',
  RECONNECT_NEEDED: 'reconnect-needed',
  ERROR: 'error',
}

export const PROVIDERS = {
  LOCAL_STORAGE: 'local-storage',
  FSA: 'fsa',
  ONEDRIVE: 'onedrive',
  GOOGLE_DRIVE: 'google-drive',
}

export function getProviderName(id) {
  switch (id) {
    case PROVIDERS.LOCAL_STORAGE: return 'Browser Storage'
    case PROVIDERS.FSA: return 'Local Folder'
    case PROVIDERS.ONEDRIVE: return 'OneDrive'
    case PROVIDERS.GOOGLE_DRIVE: return 'Google Drive'
    default: return id
  }
}

export function getAvailableProviders() {
  const list = [PROVIDERS.LOCAL_STORAGE]
  if (typeof window !== 'undefined' && 'showDirectoryPicker' in window) {
    list.push(PROVIDERS.FSA)
  }
  list.push(PROVIDERS.ONEDRIVE, PROVIDERS.GOOGLE_DRIVE)
  return list
}

// ── Active provider singleton ──────────────────────────

let _provider = null
let _engine = null

const LOCAL_FOLDER_ID = 'browser-storage'

// OAuth client IDs — the same Microsoft/Google app registrations the planner
// has always used (redirect URI = origin + pathname, AppFolder scope), so the
// service-worker providers authenticate identically to the old main-thread ones.
const ONEDRIVE_CLIENT_ID = import.meta.env?.VITE_ONEDRIVE_CLIENT_ID
  || '4f22242f-c9a7-4a61-9208-8ca0e5ef8697'
const GOOGLE_CLIENT_ID = import.meta.env?.VITE_GOOGLE_CLIENT_ID
  || '1019840819252-jcrbpshgai7ror14pmimsv413qcuce17.apps.googleusercontent.com'

// Flat local adapter for the service-worker sync engine. It always delegates to
// the *current* active provider, so the engine's writes/reads, the IndexedDB
// mirror the SW pulls from, and the app's own reads all hit one source of truth.
const localAdapter = {
  id: 'planner-local',
  async init() { return true },
  async isReady() { return _provider != null },
  async getFolderName() {
    try { return _provider?.folderName?.() ?? 'Browser Storage' } catch { return 'Browser Storage' }
  },
  async readFile(name) {
    if (!_provider) return ''
    const v = await _provider.read(name)
    return v ?? ''
  },
  async writeFile(name, content) {
    if (!_provider) throw new Error('No provider set')
    await _provider.write(name, content)
    return { mtime: Date.now() }
  },
  async deleteFile(name) {
    if (!_provider) return
    await _provider.remove(name)
  },
  async listFiles() {
    if (!_provider) return []
    if (typeof _provider.listAllPaths === 'function') return _provider.listAllPaths()
    return []
  },
}

function getEngine() {
  if (_engine) return _engine
  const providers = [oneDriveProvider({ clientId: ONEDRIVE_CLIENT_ID })]
  if (GOOGLE_CLIENT_ID) providers.push(googleDriveProvider({ clientId: GOOGLE_CLIENT_ID }))
  // Constructing the engine kicks off connected-flag refresh and OAuth-redirect
  // completion, and wires online/visibility nudges to the service worker.
  _engine = createSyncEngine({ localAdapter, providers })
  return _engine
}

// ── Status shim ────────────────────────────────────────
// Map the SW engine's status `{ state, providers:{id:{connected,state,error}} }`
// onto the legacy shape App.jsx consumes:
// `{ aggregate, folders:{ [LOCAL_FOLDER_ID]:{ targets:{ id:{ status, message } } } } }`.

function mapTargetStatus(p, overall) {
  if (!p) return TARGET_STATUS.DISCONNECTED
  if (p.state === 'reconnect-required') return TARGET_STATUS.RECONNECT_NEEDED
  if (!p.connected) return TARGET_STATUS.DISCONNECTED
  if (p.state === 'error') return TARGET_STATUS.ERROR
  if (overall === 'syncing' || p.state === 'syncing') return TARGET_STATUS.SYNCING
  return TARGET_STATUS.SYNCED // connected & (synced | idle)
}

function mapEngineStatus(s) {
  const provStates = s?.providers || {}
  const targets = {}
  for (const id of [PROVIDERS.ONEDRIVE, PROVIDERS.GOOGLE_DRIVE]) {
    const p = provStates[id]
    targets[id] = { status: mapTargetStatus(p, s?.state), message: p?.error || '' }
  }
  const statuses = Object.values(targets).map(t => t.status)
  let aggregate = TARGET_STATUS.DISCONNECTED
  if (s?.state === 'syncing' || statuses.includes(TARGET_STATUS.SYNCING)) {
    aggregate = TARGET_STATUS.SYNCING
  } else if (statuses.includes(TARGET_STATUS.RECONNECT_NEEDED)) {
    aggregate = TARGET_STATUS.RECONNECT_NEEDED
  } else if (statuses.includes(TARGET_STATUS.ERROR)) {
    aggregate = TARGET_STATUS.ERROR
  } else if (statuses.includes(TARGET_STATUS.SYNCED)) {
    aggregate = TARGET_STATUS.SYNCED
  }
  return { aggregate, folders: { [LOCAL_FOLDER_ID]: { targets } } }
}

export function setActiveProvider(p) { _provider = p }
export function getActiveProvider() { return _provider }
export function hasProvider() { return _provider !== null }

export function configureLocalFirstStorage() {
  const provider = new LocalStorageProvider()
  setActiveProvider(provider)
  localStorage.setItem('fp-storage-provider', PROVIDERS.LOCAL_STORAGE)
  return provider
}

export function getLocalFolderId() {
  return LOCAL_FOLDER_ID
}

export function getSyncStatus() {
  return mapEngineStatus(getEngine().status)
}

export function subscribeSyncStatus(listener) {
  return getEngine().subscribe(s => {
    try { listener(mapEngineStatus(s)) } catch { /* ignore */ }
  })
}

export async function restoreSyncTargets() {
  // Merely constructing the engine refreshes connected-provider flags and
  // completes any in-flight OAuth redirect; the SW handles push+pull from there.
  getEngine()
}

export function startAutoSync() {
  // No-op: the service worker drives sync via Background/Periodic Sync plus
  // online/visibility/write nudges. Kept for API compatibility with App.jsx.
  getEngine()
}

export async function connectSyncTarget(targetId) {
  // Redirects to the provider's sign-in; the flow resumes after redirect back.
  return getEngine().connect(targetId)
}

export async function disconnectSyncTarget(targetId) {
  return getEngine().disconnect(targetId)
}

export async function syncNow() {
  return getEngine().syncNow()
}

export function onLocalChange(listener) {
  let lastAt = 0
  return getEngine().subscribe(s => {
    const ru = s?.lastRemoteUpdate
    if (ru && ru.at && ru.at !== lastAt) {
      lastAt = ru.at
      try { listener(ru.name) } catch { /* ignore */ }
    }
  })
}

/**
 * Register the folder-sync service worker (served from the app origin at
 * /folder-sync/ by the copy-sw build step). Call once on app start.
 */
export async function registerSyncWorker() {
  const base = (import.meta.env?.BASE_URL || '/').replace(/\/$/, '')
  return registerServiceWorker(`${base}/folder-sync/sw.js`, { type: 'module', scope: `${base}/folder-sync/` })
}

/** Build identifier injected at build time (see vite.config.js). */
export function getBuildId() {
  /* global __APP_BUILD__ */
  try { return typeof __APP_BUILD__ !== 'undefined' ? __APP_BUILD__ : 'dev' } catch { return 'dev' }
}

/**
 * Force every registered service worker to check for a new version and take
 * over immediately, then resolve. The caller should reload the page afterwards
 * so the freshly-activated workers (and freshly-fetched assets) are in control.
 *
 * This is the user-facing fix for "my phone is on a stale build": installed
 * PWAs don't reliably check for SW updates on their own, so a manual nudge is
 * the most dependable way to pull the latest sync logic.
 *
 * @returns {Promise<{updated:boolean}>} updated=true if a new worker was found.
 */
export async function updateApp() {
  if (typeof navigator === 'undefined' || !navigator.serviceWorker) {
    return { updated: false }
  }
  let updated = false
  try {
    const regs = await navigator.serviceWorker.getRegistrations()
    await Promise.all(regs.map(async (reg) => {
      try {
        await reg.update()
        // A waiting/installing worker means a newer version was fetched. Both
        // our SWs call skipWaiting() on install, but nudge any waiting one too.
        const next = reg.waiting || reg.installing
        if (next) {
          updated = true
          try { next.postMessage?.({ type: 'skip-waiting' }) } catch { /* ignore */ }
        }
      } catch { /* ignore a single registration failure */ }
    }))
  } catch { /* ignore */ }
  return { updated }
}

// ── Delegating API (unchanged surface for App.jsx) ─────

export function isSupported() {
  // Always true — cloud providers are fallback for unsupported browsers
  return true
}

export function folderName() {
  return _provider?.folderName() ?? ''
}

export async function pick() {
  if (!_provider) throw new Error('No provider set')
  return _provider.pick()
}

export async function restore() {
  if (!_provider) return null
  return _provider.restore()
}

export async function scaffold() {
  if (!_provider) throw new Error('No provider set')
  return _provider.scaffold()
}

// Ensure the active source has an up-to-date AGENTS.md describing the data
// schema, so the folder is self-documenting for any external agent. Version-
// gated and idempotent: writes only when the file is missing or outdated.
export async function ensureAgentsDoc() {
  if (!_provider) return
  await scaffoldAgentsDoc((p) => _provider.read(p), (p, c) => _provider.write(p, c))
}

export async function read(path) {
  if (!_provider) throw new Error('No provider set')
  return _provider.read(path)
}

export async function write(path, content) {
  if (!_provider) throw new Error('No provider set')
  // Route through the engine: writes the active provider, mirrors to IndexedDB,
  // enqueues the file, and nudges the service worker to sync.
  await getEngine().writeFile(path, content)
}

export async function remove(path) {
  if (!_provider) throw new Error('No provider set')
  await getEngine().deleteFile(path)
}

export async function getFiles() {
  if (!_provider) throw new Error('No provider set')
  return _provider.getFiles()
}

export async function checkJournal(taskId) {
  if (!_provider) throw new Error('No provider set')
  return _provider.checkJournal(taskId)
}

export async function getTodos(path) {
  const content = await read(path)
  const { parseTodos } = await import('./fsa.js')
  return parseTodos(content)
}

export async function maxJournalId() {
  if (!_provider) throw new Error('No provider set')
  return _provider.maxJournalId()
}

export async function journalIds() {
  if (!_provider) throw new Error('No provider set')
  const ids = _provider.journalIds ? await _provider.journalIds() : new Set()
  return withTombstones(ids)
}

// ── Cross-source read helpers (for Combined view) ─────
// These bypass the active-provider singleton so the Combined view can
// pull data from every registered source in parallel.

export async function readFromSource(sourceId, path) {
  const { getProvider } = await import('./sources.js')
  const p = getProvider(sourceId)
  if (!p) throw new Error(`No provider for source ${sourceId}`)
  return p.read(path)
}

export async function writeToSource(sourceId, path, content) {
  const { getProvider } = await import('./sources.js')
  const p = getProvider(sourceId)
  if (!p) throw new Error(`No provider for source ${sourceId}`)
  return p.write(path, content)
}

export async function maxJournalIdFromSource(sourceId) {
  const { getProvider } = await import('./sources.js')
  const p = getProvider(sourceId)
  if (!p) return 0
  try { return await p.maxJournalId() } catch { return 0 }
}

export async function journalIdsFromSource(sourceId) {
  const { getProvider } = await import('./sources.js')
  const p = getProvider(sourceId)
  if (!p || !p.journalIds) return withTombstones(new Set())
  try { return withTombstones(await p.journalIds()) } catch { return withTombstones(new Set()) }
}

export async function getFilesFromSource(sourceId) {
  const { getProvider } = await import('./sources.js')
  const p = getProvider(sourceId)
  if (!p) throw new Error(`No provider for source ${sourceId}`)
  return p.getFiles()
}

export async function removeFromSource(sourceId, path) {
  const { getProvider } = await import('./sources.js')
  const p = getProvider(sourceId)
  if (!p) throw new Error(`No provider for source ${sourceId}`)
  return p.remove(path)
}

export async function checkJournalFromSource(sourceId, taskId) {
  const { getProvider } = await import('./sources.js')
  const p = getProvider(sourceId)
  if (!p) return { exists: false }
  try { return await p.checkJournal(taskId) } catch { return { exists: false } }
}

export async function getTodosFromSource(sourceId, path) {
  const { getProvider } = await import('./sources.js')
  const p = getProvider(sourceId)
  if (!p) return []
  try {
    const content = await p.read(path)
    const { parseTodos } = await import('./fsa.js')
    return parseTodos(content)
  } catch { return [] }
}
