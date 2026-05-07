/**
 * Multi-source registry on top of the storage providers.
 *
 * A "source" = { id, name, providerType, config? } persisted in localStorage.
 * The active source's provider is the one that storage.js delegates to.
 *
 * Constraints:
 *  - LocalStorage / OneDrive / GoogleDrive: at most one source each
 *    (single browser / single OAuth account per app).
 *  - FSA: any number (each picks its own folder; handles namespaced by id).
 *
 * Single-source UX invariant: when the registry has exactly one entry the
 * UI is expected to behave exactly as it did before this feature existed
 * (no source folders, no Combined, no per-source labels). Callers can
 * check `getSources().length` to gate any multi-source affordances.
 */
import { PROVIDERS, getProviderName, setActiveProvider } from './storage.js'
import { LocalStorageProvider } from './localstorage-provider.js'
import { FSAProvider } from './fsa-provider.js'
import { OneDriveProvider } from './onedrive-provider.js'
import { GoogleDriveProvider } from './google-drive-provider.js'

const SOURCES_KEY = 'fp-sources'
const ACTIVE_KEY = 'fp-active-source'
// Set when we redirect to a cloud OAuth flow as part of "add source".
// Cleared once the post-redirect init completes the source's setup.
const PENDING_ADD_KEY = 'fp-pending-source-add'

// In-memory cache: sourceId -> Provider instance (lazy-instantiated, restored once).
const _providers = new Map()
let _sources = null   // [{id, name, providerType, config}]
let _activeId = null

function readJSON(key) {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function writeSources() {
  localStorage.setItem(SOURCES_KEY, JSON.stringify(_sources))
}

function nextId() {
  let n = 1
  const used = new Set((_sources || []).map(s => s.id))
  while (used.has(`s${n}`)) n++
  return `s${n}`
}

export function makeProviderFor(source) {
  switch (source.providerType) {
    case PROVIDERS.LOCAL_STORAGE: return new LocalStorageProvider()
    case PROVIDERS.FSA: return new FSAProvider(source.id)
    case PROVIDERS.ONEDRIVE: return new OneDriveProvider()
    case PROVIDERS.GOOGLE_DRIVE: return new GoogleDriveProvider(source.config?.folderName || null)
    default: throw new Error(`Unknown providerType: ${source.providerType}`)
  }
}

/** Load the sources registry from localStorage. Does NOT instantiate providers. */
export function loadSources() {
  _sources = readJSON(SOURCES_KEY) || []
  _activeId = localStorage.getItem(ACTIVE_KEY) || (_sources[0]?.id ?? null)
  return _sources
}

/**
 * One-time migration: convert the legacy single-provider setup into a
 * single-entry sources registry. Returns true if a migration happened.
 */
export function migrateLegacy() {
  if (readJSON(SOURCES_KEY)) return false
  const legacy = localStorage.getItem('fp-storage-provider')
  if (!legacy) return false
  const id = 's1'
  _sources = [{
    id,
    name: getProviderName(legacy),
    providerType: legacy,
  }]
  _activeId = id
  writeSources()
  localStorage.setItem(ACTIVE_KEY, id)
  return true
}

export function getSources() { return _sources ? [..._sources] : [] }
export function getActiveSourceId() { return _activeId }
export function getActiveSource() {
  return _sources?.find(s => s.id === _activeId) || null
}

/** Get (lazy-create) the provider instance for a source id. */
export function getProvider(sourceId) {
  if (_providers.has(sourceId)) return _providers.get(sourceId)
  const src = _sources?.find(s => s.id === sourceId)
  if (!src) return null
  const p = makeProviderFor(src)
  _providers.set(sourceId, p)
  return p
}

/**
 * Restore a source's provider (loads handle / tokens). Returns the provider
 * on success, null if it needs user re-auth, throws on hard failure.
 */
export async function restoreSource(sourceId) {
  const p = getProvider(sourceId)
  if (!p) return null
  const ok = await p.restore()
  return ok ? p : null
}

/** Switch the active source. Caller is responsible for re-loading files. */
export async function setActiveSource(sourceId) {
  const src = _sources?.find(s => s.id === sourceId)
  if (!src) throw new Error(`Unknown source: ${sourceId}`)
  _activeId = sourceId
  localStorage.setItem(ACTIVE_KEY, sourceId)
  const p = getProvider(sourceId)
  setActiveProvider(p)
  return p
}

/**
 * Add a new source. Returns the created source descriptor. The caller
 * must subsequently call `pick`/`restore` and `scaffold` on it (use
 * `getProvider(id)`).
 */
export function addSource({ name, providerType, config } = {}) {
  if (!_sources) _sources = []
  const id = nextId()
  const src = {
    id,
    name: name || getProviderName(providerType),
    providerType,
    ...(config ? { config } : {}),
  }
  _sources.push(src)
  writeSources()
  return src
}

/** Rename a source (UI label only). */
export function renameSource(sourceId, name) {
  const src = _sources?.find(s => s.id === sourceId)
  if (!src) return
  src.name = name
  writeSources()
}

/**
 * Remove a source. If it was active, the next source (if any) becomes active.
 * For FSA sources we also forget the IndexedDB handle so re-adding requires
 * a fresh folder pick.
 */
export async function removeSource(sourceId) {
  const idx = _sources?.findIndex(s => s.id === sourceId) ?? -1
  if (idx < 0) return
  const src = _sources[idx]
  const provider = _providers.get(sourceId)
  if (provider?.forget) {
    try { await provider.forget() } catch { /* ignore */ }
  }
  _providers.delete(sourceId)
  _sources.splice(idx, 1)
  writeSources()
  if (_activeId === sourceId) {
    _activeId = _sources[0]?.id || null
    if (_activeId) {
      localStorage.setItem(ACTIVE_KEY, _activeId)
      setActiveProvider(getProvider(_activeId))
    } else {
      localStorage.removeItem(ACTIVE_KEY)
      setActiveProvider(null)
    }
  }
  // Also clear legacy single-provider key if this was the last source matching it
  if (_sources.every(s => s.providerType !== src.providerType)) {
    if (localStorage.getItem('fp-storage-provider') === src.providerType) {
      localStorage.removeItem('fp-storage-provider')
    }
  }
}

/** Available provider types that aren't already in the registry (or FSA, which is multi). */
export function availableProviderTypesForAdd() {
  const used = new Set((_sources || []).map(s => s.providerType))
  const all = [PROVIDERS.LOCAL_STORAGE, PROVIDERS.FSA, PROVIDERS.ONEDRIVE, PROVIDERS.GOOGLE_DRIVE]
  return all.filter(t => t === PROVIDERS.FSA || !used.has(t))
}

/**
 * Begin adding a cloud source. Pre-creates the registry entry, marks it
 * pending, and triggers the provider's OAuth redirect. The page will reload
 * after the user signs in; the post-redirect init must call
 * `consumePendingAdd()` to find and finish the new source.
 */
export async function beginAddCloudSource(providerType, name) {
  const src = addSource({ providerType, name: name || getProviderName(providerType) })
  localStorage.setItem(PENDING_ADD_KEY, src.id)
  // Persist the pre-redirect active source so we can decide whether to
  // switch to the new one after auth (we do, because the user just
  // explicitly asked to add it).
  _activeId = src.id
  localStorage.setItem(ACTIVE_KEY, src.id)
  const p = getProvider(src.id)
  await p.pick() // redirects away — no return
  return src
}

/** True iff there's an in-flight cloud-source add waiting to be finished. */
export function hasPendingAdd() {
  return !!localStorage.getItem(PENDING_ADD_KEY)
}

/**
 * Finish a pending cloud-source add after the OAuth redirect.
 * Returns the source id if a pending add was finished (caller should
 * scaffold + activate), or null if no pending add was queued.
 */
export function consumePendingAdd() {
  const id = localStorage.getItem(PENDING_ADD_KEY)
  if (!id) return null
  localStorage.removeItem(PENDING_ADD_KEY)
  return id
}

/** Roll back a pending add when restore failed (e.g. user denied auth). */
export async function abortPendingAdd() {
  const id = consumePendingAdd()
  if (id) await removeSource(id)
}

// ── Re-authentication for existing cloud sources ─────────────────────────────
// Used when a source's tokens have expired and the user clicks "Re-connect".

const PENDING_REAUTH_KEY = 'fp-pending-reauth'

/**
 * Trigger a PKCE re-auth flow for an existing cloud source.
 * Sets a marker in localStorage, then redirects to the provider's OAuth page.
 * On return, consumePendingReauth() finishes the token exchange.
 */
export async function beginReauth(sourceId) {
  localStorage.setItem(PENDING_REAUTH_KEY, sourceId)
  const p = getProvider(sourceId)
  await p.pick() // redirects away — no return
}

/**
 * Finish a pending re-auth after the OAuth redirect.
 * Returns the source id that was re-authing, or null if none was pending.
 */
export function consumePendingReauth() {
  const id = localStorage.getItem(PENDING_REAUTH_KEY)
  if (!id) return null
  localStorage.removeItem(PENDING_REAUTH_KEY)
  return id
}

