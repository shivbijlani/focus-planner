/**
 * Saved storage choices and the single active provider.
 *
 * Older installs may have several saved choices. They remain available for
 * switching, but only the active provider is opened by the planner.
 */
import { PROVIDERS, getProviderName, setActiveProvider } from './storage.js'
import { IndexedDbProvider } from './indexeddb-provider.js'
import { FSAProvider } from './fsa-provider.js'
import { OneDriveProvider } from './onedrive-provider.js'
import { GoogleDriveProvider } from './google-drive-provider.js'

const SOURCES_KEY = 'fp-sources'
const ACTIVE_KEY = 'fp-active-source'
const PENDING_KEY = 'fp-pending-source'
const PENDING_CREATED_KEY = 'fp-pending-source-created'
const MULTI_SOURCE_NOTICE_KEY = 'fp-multi-source-notice-dismissed'

const _providers = new Map()
let _sources = null
let _activeId = null

function readJSON(key) {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

export function chooseActiveSource(sources, activeId) {
  if (!Array.isArray(sources) || sources.length === 0) return null
  return sources.find(source => source.id === activeId) || sources[0]
}

export function makeProviderFor(source) {
  switch (source.providerType) {
    case PROVIDERS.LOCAL_STORAGE: return new IndexedDbProvider()
    case PROVIDERS.FSA: return new FSAProvider(source.id)
    case PROVIDERS.ONEDRIVE: return new OneDriveProvider()
    case PROVIDERS.GOOGLE_DRIVE: return new GoogleDriveProvider(source.config?.folderName || null)
    default: throw new Error(`Unknown providerType: ${source.providerType}`)
  }
}

/** Load saved choices without opening any provider. */
export function loadSources() {
  const saved = readJSON(SOURCES_KEY)
  _sources = Array.isArray(saved) ? saved.filter(source =>
    source && typeof source.id === 'string' && typeof source.providerType === 'string',
  ) : []
  const selected = chooseActiveSource(_sources, localStorage.getItem(ACTIVE_KEY))
  _activeId = selected?.id ?? null
  if (_activeId && localStorage.getItem(ACTIVE_KEY) !== _activeId) {
    localStorage.setItem(ACTIVE_KEY, _activeId)
  }
  return [..._sources]
}

export function getSources() { return _sources ? [..._sources] : [] }
export function getActiveSourceId() { return _activeId }
export function getActiveSource() {
  return _sources?.find(source => source.id === _activeId) || null
}
export function getHiddenSources() {
  return (_sources || []).filter(source => source.id !== _activeId)
}
export function isMultiSourceNoticeDismissed() {
  return localStorage.getItem(MULTI_SOURCE_NOTICE_KEY) === '1'
}
export function dismissMultiSourceNotice() {
  localStorage.setItem(MULTI_SOURCE_NOTICE_KEY, '1')
}

export function getProvider(sourceId) {
  if (_providers.has(sourceId)) return _providers.get(sourceId)
  const source = _sources?.find(item => item.id === sourceId)
  if (!source) return null
  const provider = makeProviderFor(source)
  _providers.set(sourceId, provider)
  return provider
}

function nextSourceId() {
  const used = new Set((_sources || []).map(source => source.id))
  let index = 1
  while (used.has(`s${index}`)) index++
  return `s${index}`
}

export function createSourceDescriptor({ name, providerType, config } = {}) {
  return {
    id: nextSourceId(),
    name: name || getProviderName(providerType),
    providerType,
    ...(config ? { config } : {}),
  }
}

export function saveSource(source, provider) {
  if (!_sources) _sources = []
  const existing = _sources.find(item => item.id === source.id)
  if (!existing) _sources.push(source)
  if (provider) _providers.set(source.id, provider)
  localStorage.setItem(SOURCES_KEY, JSON.stringify(_sources))
  return existing || source
}

export function setPendingSource(sourceId, { created = false } = {}) {
  localStorage.setItem(PENDING_KEY, sourceId)
  localStorage.setItem(PENDING_CREATED_KEY, created ? '1' : '0')
}

export function consumePendingSource() {
  const sourceId = localStorage.getItem(PENDING_KEY)
  const created = localStorage.getItem(PENDING_CREATED_KEY) === '1'
  clearPendingSource()
  const source = _sources?.find(item => item.id === sourceId) || null
  return source ? { source, created } : null
}

export function clearPendingSource() {
  localStorage.removeItem(PENDING_KEY)
  localStorage.removeItem(PENDING_CREATED_KEY)
}

export function removeSource(sourceId) {
  if (!_sources) return
  _sources = _sources.filter(source => source.id !== sourceId)
  _providers.delete(sourceId)
  clearPendingSource()
  localStorage.setItem(SOURCES_KEY, JSON.stringify(_sources))
}

export async function restoreSource(sourceId) {
  const provider = getProvider(sourceId)
  if (!provider) return null
  return await provider.restore() ? provider : null
}

/** Make one saved choice active. The caller restores it before switching the UI. */
export async function setActiveSource(sourceId) {
  const source = _sources?.find(item => item.id === sourceId)
  if (!source) throw new Error(`Unknown source: ${sourceId}`)
  _activeId = sourceId
  localStorage.setItem(ACTIVE_KEY, sourceId)
  clearPendingSource()
  const provider = getProvider(sourceId)
  setActiveProvider(provider)
  return provider
}

export function addSource({ name, providerType, config } = {}) {
  return saveSource(createSourceDescriptor({ name, providerType, config }))
}

export function renameSource(sourceId, name) {
  const source = _sources?.find(item => item.id === sourceId)
  if (!source) return
  source.name = name
  localStorage.setItem(SOURCES_KEY, JSON.stringify(_sources))
}

export const __testing = {
  reset() {
    _providers.clear()
    _sources = null
    _activeId = null
  },
}
