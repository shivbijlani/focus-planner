/**
 * Storage abstraction layer for focus-planner.
 * Supports: FSA (local), OneDrive, Google Drive.
 */
import { createFolderSync, TARGET_STATUS } from '../../packages/folder-sync/src/index.js'
import { LocalStorageProvider } from './localstorage-provider.js'
import { OneDriveProvider } from './onedrive-provider.js'
import { GoogleDriveProvider } from './google-drive-provider.js'

export { parseTodos } from './fsa.js'
export { TARGET_STATUS }

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
let _folderSync = null

const LOCAL_FOLDER_ID = 'browser-storage'

function getFolderSync() {
  if (_folderSync) return _folderSync

  const localStore = new LocalStorageProvider()
  _folderSync = createFolderSync({
    configKey: 'fp-folder-sync-config-v1',
    metaPrefix: 'fp-folder-sync-meta:',
    pendingKey: 'fp-folder-sync-pending-target',
    localFolders: [{
      id: LOCAL_FOLDER_ID,
      name: 'Browser Storage',
      store: {
        read: path => localStore.read(path),
        write: (path, content) => localStore.write(path, content),
        listPaths: () => localStore.listAllPaths(),
      },
      targets: [
        oneDriveTarget(),
        googleDriveTarget(),
      ],
    }],
  })
  return _folderSync
}

function oneDriveTarget() {
  const provider = new OneDriveProvider()
  return {
    id: PROVIDERS.ONEDRIVE,
    label: 'OneDrive',
    restore: () => provider.restore(),
    connect: () => provider.pick(),
    write: (path, content) => provider.write(path, content),
    remove: path => provider.remove(path),
    read: path => provider.read(path),
    list: () => provider.listFlat(),
  }
}

function googleDriveTarget() {
  const provider = new GoogleDriveProvider()
  return {
    id: PROVIDERS.GOOGLE_DRIVE,
    label: 'Google Drive',
    restore: () => provider.restore(),
    connect: () => provider.pick(),
    write: (path, content) => provider.write(path, content),
    remove: path => provider.remove(path),
    read: path => provider.read(path),
    list: () => provider.listFlat(),
  }
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
  return getFolderSync().getStatus()
}

export function subscribeSyncStatus(listener) {
  return getFolderSync().subscribe(listener)
}

export async function restoreSyncTargets() {
  return getFolderSync().restoreTargets()
}

export function startAutoSync() {
  return getFolderSync().startAutoSync()
}

export async function connectSyncTarget(targetId) {
  return getFolderSync().connectTarget(LOCAL_FOLDER_ID, targetId)
}

export async function syncNow(targetId = null) {
  return getFolderSync().syncNow(LOCAL_FOLDER_ID, targetId)
}

export async function pullNow(targetId = null) {
  return getFolderSync().pullNow(LOCAL_FOLDER_ID, targetId)
}

export function onLocalChange(listener) {
  return getFolderSync().onLocalChange(listener)
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

export async function read(path) {
  if (!_provider) throw new Error('No provider set')
  return _provider.read(path)
}

export async function write(path, content) {
  if (!_provider) throw new Error('No provider set')
  await _provider.write(path, content)
  await getFolderSync().markDirty(path, 'write', LOCAL_FOLDER_ID)
}

export async function remove(path) {
  if (!_provider) throw new Error('No provider set')
  await _provider.remove(path)
  await getFolderSync().markDirty(path, 'delete', LOCAL_FOLDER_ID)
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
