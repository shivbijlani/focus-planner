/**
 * Migration helpers for focus-planner.
 * Copies all files from one provider to another, including journal subdir.
 */
import { PROVIDERS, setActiveProvider } from './storage.js'
import { LocalStorageProvider } from './localstorage-provider.js'
import { FSAProvider } from './fsa-provider.js'
import { OneDriveProvider } from './onedrive-provider.js'
import { GoogleDriveProvider } from './google-drive-provider.js'

const MIGRATION_KEY = 'fp-pending-migration'

export function makeProvider(id, opts = {}) {
  switch (id) {
    case PROVIDERS.LOCAL_STORAGE: return new LocalStorageProvider()
    case PROVIDERS.FSA: return new FSAProvider()
    case PROVIDERS.ONEDRIVE: return new OneDriveProvider(opts.folderName || null)
    case PROVIDERS.GOOGLE_DRIVE: return new GoogleDriveProvider(opts.folderName || null)
    default: throw new Error(`Unknown provider: ${id}`)
  }
}

function flattenTree(tree, out = []) {
  for (const item of tree) {
    if (item.type === 'file') out.push(item.path)
    else if (item.type === 'directory' && item.children) flattenTree(item.children, out)
  }
  return out
}

export async function snapshotFiles(provider) {
  let paths
  if (provider.listAllPaths) {
    paths = provider.listAllPaths()
  } else {
    const tree = await provider.getFiles()
    paths = flattenTree(tree)
  }
  const data = {}
  for (const path of paths) {
    data[path] = await provider.read(path)
  }
  return data
}

export async function restoreFiles(provider, payload) {
  for (const [path, content] of Object.entries(payload)) {
    await provider.write(path, content)
  }
}

export function hasPendingMigration() {
  return !!sessionStorage.getItem(MIGRATION_KEY)
}

export function readPendingMigration() {
  const raw = sessionStorage.getItem(MIGRATION_KEY)
  if (!raw) return null
  try { return JSON.parse(raw) } catch { return null }
}

export function clearPendingMigration() {
  sessionStorage.removeItem(MIGRATION_KEY)
}

export async function migrate(fromProvider, toId, opts = {}) {
  const payload = await snapshotFiles(fromProvider)
  const target = makeProvider(toId)

  if (toId === PROVIDERS.ONEDRIVE || toId === PROVIDERS.GOOGLE_DRIVE) {
    sessionStorage.setItem(MIGRATION_KEY, JSON.stringify({
      toId,
      payload,
      deleteSource: !!opts.deleteSource,
      fromId: opts.fromId || null,
      folderName: opts.folderName || null,
    }))
    // restore() returns truthy on success, or redirects on first auth
    const ok = await target.restore()
    if (ok === true || (ok && typeof ok === 'object')) {
      // Already authed — finish synchronously
      await target.scaffold()
      await restoreFiles(target, payload)
      sessionStorage.removeItem(MIGRATION_KEY)
      setActiveProvider(target)
      localStorage.setItem('fp-storage-provider', toId)
      if (opts.deleteSource && fromProvider.clear) fromProvider.clear()
      return { ok: true }
    }
    // restore() returned null — pick() was needed but we didn't trigger auth yet
    await target.pick() // triggers redirect
    return { ok: false, redirected: true }
  }

  // Synchronous targets: LOCAL_STORAGE or FSA
  if (toId === PROVIDERS.FSA) {
    const handle = await target.pick() // requires user gesture; will throw if denied
    if (!handle) return { ok: false, error: 'Folder selection cancelled' }
  } else {
    await target.restore()
  }
  await target.scaffold()
  await restoreFiles(target, payload)
  setActiveProvider(target)
  localStorage.setItem('fp-storage-provider', toId)
  if (opts.deleteSource && fromProvider.clear) fromProvider.clear()
  return { ok: true }
}

export async function resumePendingMigration() {
  const pending = readPendingMigration()
  if (!pending) return null

  const target = makeProvider(pending.toId, { folderName: pending.folderName || null })
  const ok = await target.restore()
  if (!ok) return null

  await target.scaffold()
  await restoreFiles(target, pending.payload)
  setActiveProvider(target)
  localStorage.setItem('fp-storage-provider', pending.toId)
  if (pending.deleteSource && pending.fromId === PROVIDERS.LOCAL_STORAGE) {
    new LocalStorageProvider().clear()
  }
  clearPendingMigration()
  return pending.toId
}
