/**
 * Storage abstraction layer for focus-planner.
 * Supports: FSA (local), OneDrive, Google Drive.
 */
export { parseTodos } from './fsa.js'

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

export function setActiveProvider(p) { _provider = p }
export function getActiveProvider() { return _provider }
export function hasProvider() { return _provider !== null }

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

export async function read(path) {
  if (!_provider) throw new Error('No provider set')
  return _provider.read(path)
}

export async function write(path, content) {
  if (!_provider) throw new Error('No provider set')
  return _provider.write(path, content)
}

export async function remove(path) {
  if (!_provider) throw new Error('No provider set')
  return _provider.remove(path)
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
