export const TARGET_STATUS = {
  DISCONNECTED: 'disconnected',
  PENDING: 'pending',
  SYNCING: 'syncing',
  SYNCED: 'synced',
  RECONNECT_NEEDED: 'reconnect-needed',
  ERROR: 'error',
}

const DEFAULT_CONFIG_KEY = 'folder-sync:config'
const DEFAULT_META_PREFIX = 'folder-sync:meta:'
const DEFAULT_PENDING_KEY = 'folder-sync:pending-target'
const DEFAULT_SYNC_DELAY = 800

export function createFolderSync(options) {
  const storage = options.storage ?? globalThis.localStorage
  if (!storage) throw new Error('createFolderSync requires a storage implementation')

  const configKey = options.configKey ?? DEFAULT_CONFIG_KEY
  const metaPrefix = options.metaPrefix ?? DEFAULT_META_PREFIX
  const pendingKey = options.pendingKey ?? DEFAULT_PENDING_KEY
  const syncDelay = options.syncDelay ?? DEFAULT_SYNC_DELAY
  const folders = new Map(options.localFolders.map(folder => [folder.id, normalizeFolder(folder)]))
  const listeners = new Set()
  const changeListeners = new Set()
  const timers = new Map()
  let config = loadConfig(storage, configKey, folders)
  let status = buildInitialStatus(folders, config)

  function getConfig() {
    return structuredCloneSafe(config)
  }

  function getStatus() {
    return structuredCloneSafe(status)
  }

  function subscribe(listener) {
    listeners.add(listener)
    listener(getStatus())
    return () => listeners.delete(listener)
  }

  function onLocalChange(listener) {
    changeListeners.add(listener)
    return () => changeListeners.delete(listener)
  }

  function emitChanges(paths) {
    if (paths.length === 0) return
    for (const listener of changeListeners) listener(paths)
  }

  async function restoreTargets() {
    const pending = getSessionItem(pendingKey)
    let changedPaths = []
    for (const folder of folders.values()) {
      const folderConfig = config.folders[folder.id]
      for (const target of folder.targets) {
        const targetConfig = folderConfig.targets[target.id]
        if (!targetConfig?.enabled && pending !== targetKey(folder.id, target.id)) continue
        const restored = await tryRestoreTarget(target)
        if (restored) {
          targetConfig.enabled = true
          targetConfig.connectedAt = targetConfig.connectedAt ?? Date.now()
          setTargetStatus(folder.id, target.id, TARGET_STATUS.PENDING)
          if (pending === targetKey(folder.id, target.id)) {
            removeSessionItem(pendingKey)
            await markLocalOnlyDirty(folder, target)
            const pulled = await mergeFromTarget(folder, target)
            changedPaths = changedPaths.concat(pulled)
          } else {
            // Existing connection — pull remote changes on restore
            const pulled = await mergeFromTarget(folder, target)
            changedPaths = changedPaths.concat(pulled)
          }
        } else {
          setTargetStatus(folder.id, target.id, TARGET_STATUS.RECONNECT_NEEDED, 'Sign in again to resume backup.')
        }
      }
    }
    saveConfig(storage, configKey, config)
    emit()
    emitChanges(changedPaths)
    scheduleAll()
  }

  async function connectTarget(folderId, targetId) {
    const folder = getFolder(folderId)
    const target = getTarget(folder, targetId)
    const restored = await tryRestoreTarget(target)
    if (restored) {
      enableTarget(folder.id, target.id)
      await markLocalOnlyDirty(folder, target)
      const pulled = await mergeFromTarget(folder, target)
      await syncNow(folder.id, target.id)
      emitChanges(pulled)
      return { ok: true }
    }

    setSessionItem(pendingKey, targetKey(folder.id, target.id))
    await target.connect()
    return { ok: false, redirected: true }
  }

  function disconnectTarget(folderId, targetId) {
    const folder = getFolder(folderId)
    getTarget(folder, targetId)
    const targetConfig = config.folders[folder.id].targets[targetId]
    targetConfig.enabled = false
    targetConfig.connectedAt = null
    saveConfig(storage, configKey, config)
    setTargetStatus(folder.id, targetId, TARGET_STATUS.DISCONNECTED)
  }

  async function markDirty(path, operation = 'write', folderId = config.defaultFolderId) {
    const folder = getFolder(folderId)
    const enabledTargets = folder.targets.filter(target => config.folders[folder.id].targets[target.id]?.enabled)
    if (enabledTargets.length === 0) return

    const meta = readMeta(storage, metaPrefix, folder.id, path)
    meta.operation = operation
    meta.localMtime = Date.now()
    meta.dirtyTargets = meta.dirtyTargets ?? {}
    for (const target of enabledTargets) {
      meta.dirtyTargets[target.id] = true
      setTargetStatus(folder.id, target.id, TARGET_STATUS.PENDING)
    }
    writeMeta(storage, metaPrefix, folder.id, path, meta)
    schedule(folder.id)
  }

  async function markAllDirty(folderId = config.defaultFolderId, targetId = null) {
    const folder = getFolder(folderId)
    const paths = await folder.store.listPaths()
    for (const path of paths) {
      const meta = readMeta(storage, metaPrefix, folder.id, path)
      meta.operation = 'write'
      meta.localMtime = Date.now()
      meta.dirtyTargets = meta.dirtyTargets ?? {}
      if (targetId) {
        meta.dirtyTargets[targetId] = true
      } else {
        for (const target of folder.targets) {
          if (config.folders[folder.id].targets[target.id]?.enabled) {
            meta.dirtyTargets[target.id] = true
          }
        }
      }
      writeMeta(storage, metaPrefix, folder.id, path, meta)
    }
  }

  async function syncNow(folderId = config.defaultFolderId, onlyTargetId = null) {
    const folder = getFolder(folderId)
    const metas = listMetas(storage, metaPrefix, folder.id)
    const dirtyMetas = metas.filter(({ meta }) => {
      return Object.entries(meta.dirtyTargets ?? {}).some(([targetId, dirty]) => {
        return dirty && (!onlyTargetId || targetId === onlyTargetId)
      })
    })
    if (dirtyMetas.length === 0) {
      for (const target of folder.targets) {
        if (onlyTargetId && target.id !== onlyTargetId) continue
        if (config.folders[folder.id].targets[target.id]?.enabled) {
          setTargetStatus(folder.id, target.id, TARGET_STATUS.SYNCED)
        }
      }
      emit()
      return { synced: 0 }
    }

    let synced = 0
    for (const target of folder.targets) {
      if (onlyTargetId && target.id !== onlyTargetId) continue
      if (!config.folders[folder.id].targets[target.id]?.enabled) continue

      const targetDirtyMetas = dirtyMetas.filter(({ meta }) => meta.dirtyTargets?.[target.id])
      if (targetDirtyMetas.length === 0) continue

      const restored = await tryRestoreTarget(target)
      if (!restored) {
        setTargetStatus(folder.id, target.id, TARGET_STATUS.RECONNECT_NEEDED, 'Sign in again to resume backup.')
        continue
      }

      setTargetStatus(folder.id, target.id, TARGET_STATUS.SYNCING)
      for (const { path, meta } of targetDirtyMetas) {
        try {
          if (meta.operation === 'delete') {
            await target.remove(path)
          } else {
            const content = await folder.store.read(path)
            await target.write(path, content)
          }
          synced += 1
          meta.dirtyTargets[target.id] = false
          meta.lastSyncedAt = Date.now()
          writeMeta(storage, metaPrefix, folder.id, path, meta)
        } catch (error) {
          setTargetStatus(folder.id, target.id, TARGET_STATUS.ERROR, error.message || 'Backup failed.')
          break
        }
      }

      if (!hasDirtyForTarget(storage, metaPrefix, folder.id, target.id)) {
        setTargetStatus(folder.id, target.id, TARGET_STATUS.SYNCED)
      }
    }

    emit()
    return { synced }
  }

  function startAutoSync() {
    const trigger = () => scheduleAll()
    globalThis.addEventListener?.('online', trigger)
    globalThis.addEventListener?.('focus', trigger)
    globalThis.document?.addEventListener?.('visibilitychange', () => {
      if (globalThis.document.visibilityState === 'visible') trigger()
    })
    scheduleAll()
  }

  async function pullNow(folderId = config.defaultFolderId, onlyTargetId = null) {
    const folder = getFolder(folderId)
    let changed = []
    for (const target of folder.targets) {
      if (onlyTargetId && target.id !== onlyTargetId) continue
      if (!config.folders[folder.id].targets[target.id]?.enabled) continue
      if (!target.list || !target.read || !folder.store.write) continue
      const restored = await tryRestoreTarget(target)
      if (!restored) {
        setTargetStatus(folder.id, target.id, TARGET_STATUS.RECONNECT_NEEDED, 'Sign in again to resume backup.')
        continue
      }
      const pulled = await mergeFromTarget(folder, target)
      changed = changed.concat(pulled)
    }
    emitChanges(changed)
    return { changed }
  }

  async function mergeFromTarget(folder, target) {
    if (!target.list || !target.read || !folder.store.write) return []
    const remoteEntries = await target.list().catch(() => [])
    const changedPaths = []
    for (const entry of remoteEntries) {
      const meta = readMeta(storage, metaPrefix, folder.id, entry.path)
      // Skip files that are dirty locally — local wins
      if (meta.dirtyTargets?.[target.id]) continue
      const remoteMtime = entry.mtime ? Date.parse(entry.mtime) : 0
      const localMtime = meta.localMtime ?? 0
      // Skip if remote hasn't changed since our last sync
      if (remoteMtime <= localMtime && meta.remoteEtags?.[target.id] === entry.etag) continue
      try {
        const content = await target.read(entry.path)
        await folder.store.write(entry.path, content)
        meta.localMtime = remoteMtime || Date.now()
        meta.lastSyncedAt = Date.now()
        meta.remoteEtags = { ...(meta.remoteEtags ?? {}), [target.id]: entry.etag }
        meta.dirtyTargets = meta.dirtyTargets ?? {}
        meta.dirtyTargets[target.id] = false
        writeMeta(storage, metaPrefix, folder.id, entry.path, meta)
        changedPaths.push(entry.path)
      } catch (error) {
        setTargetStatus(folder.id, target.id, TARGET_STATUS.ERROR, error.message || 'Pull failed.')
      }
    }
    return changedPaths
  }

  async function markLocalOnlyDirty(folder, target) {
    const localPaths = await folder.store.listPaths()
    for (const path of localPaths) {
      const meta = readMeta(storage, metaPrefix, folder.id, path)
      // If we already know this file on the remote, skip
      if (meta.remoteEtags?.[target.id]) continue
      meta.operation = 'write'
      meta.localMtime = meta.localMtime ?? Date.now()
      meta.dirtyTargets = meta.dirtyTargets ?? {}
      meta.dirtyTargets[target.id] = true
      writeMeta(storage, metaPrefix, folder.id, path, meta)
    }
  }

  function enableTarget(folderId, targetId) {
    const folder = getFolder(folderId)
    getTarget(folder, targetId)
    const targetConfig = config.folders[folder.id].targets[targetId]
    targetConfig.enabled = true
    targetConfig.connectedAt = targetConfig.connectedAt ?? Date.now()
    saveConfig(storage, configKey, config)
    setTargetStatus(folder.id, targetId, TARGET_STATUS.PENDING)
  }

  function schedule(folderId) {
    clearTimeout(timers.get(folderId))
    timers.set(folderId, setTimeout(() => {
      syncNow(folderId).catch(error => {
        setFolderError(folderId, error.message || 'Sync failed.')
      })
    }, syncDelay))
  }

  function scheduleAll() {
    for (const folderId of folders.keys()) schedule(folderId)
  }

  function setTargetStatus(folderId, targetId, nextStatus, message = '') {
    status.folders[folderId].targets[targetId] = {
      ...status.folders[folderId].targets[targetId],
      status: nextStatus,
      message,
      updatedAt: Date.now(),
    }
    emit()
  }

  function setFolderError(folderId, message) {
    const folder = getFolder(folderId)
    for (const target of folder.targets) {
      if (config.folders[folder.id].targets[target.id]?.enabled) {
        setTargetStatus(folder.id, target.id, TARGET_STATUS.ERROR, message)
      }
    }
  }

  function emit() {
    const aggregate = aggregateStatus(status, config)
    status = { ...status, aggregate }
    const snapshot = getStatus()
    for (const listener of listeners) listener(snapshot)
  }

  function getFolder(folderId) {
    const folder = folders.get(folderId)
    if (!folder) throw new Error(`Unknown local folder: ${folderId}`)
    return folder
  }

  function getTarget(folder, targetId) {
    const target = folder.targets.find(item => item.id === targetId)
    if (!target) throw new Error(`Unknown sync target: ${targetId}`)
    return target
  }

  return {
    connectTarget,
    disconnectTarget,
    getConfig,
    getStatus,
    markAllDirty,
    markDirty,
    onLocalChange,
    pullNow,
    restoreTargets,
    startAutoSync,
    subscribe,
    syncNow,
  }
}

function normalizeFolder(folder) {
  return {
    ...folder,
    targets: folder.targets ?? [],
  }
}

function loadConfig(storage, configKey, folders) {
  const saved = readJson(storage, configKey)
  const defaultFolderId = saved?.defaultFolderId ?? folders.keys().next().value
  const config = {
    defaultFolderId,
    folders: saved?.folders ?? {},
  }
  for (const folder of folders.values()) {
    config.folders[folder.id] = config.folders[folder.id] ?? { targets: {} }
    for (const target of folder.targets) {
      config.folders[folder.id].targets[target.id] = {
        enabled: false,
        connectedAt: null,
        ...(config.folders[folder.id].targets[target.id] ?? {}),
      }
    }
  }
  saveConfig(storage, configKey, config)
  return config
}

function saveConfig(storage, configKey, config) {
  storage.setItem(configKey, JSON.stringify(config))
}

function buildInitialStatus(folders, config) {
  const status = { aggregate: TARGET_STATUS.DISCONNECTED, folders: {} }
  for (const folder of folders.values()) {
    status.folders[folder.id] = { name: folder.name, targets: {} }
    for (const target of folder.targets) {
      const enabled = config.folders[folder.id].targets[target.id]?.enabled
      status.folders[folder.id].targets[target.id] = {
        id: target.id,
        label: target.label,
        status: enabled ? TARGET_STATUS.PENDING : TARGET_STATUS.DISCONNECTED,
        message: '',
        updatedAt: null,
      }
    }
  }
  status.aggregate = aggregateStatus(status, config)
  return status
}

function aggregateStatus(status, config) {
  const enabledStatuses = []
  for (const [folderId, folder] of Object.entries(status.folders)) {
    for (const [targetId, target] of Object.entries(folder.targets)) {
      if (config.folders[folderId]?.targets[targetId]?.enabled) enabledStatuses.push(target.status)
    }
  }
  if (enabledStatuses.length === 0) return TARGET_STATUS.DISCONNECTED
  if (enabledStatuses.includes(TARGET_STATUS.ERROR)) return TARGET_STATUS.ERROR
  if (enabledStatuses.includes(TARGET_STATUS.RECONNECT_NEEDED)) return TARGET_STATUS.RECONNECT_NEEDED
  if (enabledStatuses.includes(TARGET_STATUS.SYNCING)) return TARGET_STATUS.SYNCING
  if (enabledStatuses.includes(TARGET_STATUS.PENDING)) return TARGET_STATUS.PENDING
  return TARGET_STATUS.SYNCED
}

async function tryRestoreTarget(target) {
  try {
    return await target.restore()
  } catch {
    return false
  }
}

function targetKey(folderId, targetId) {
  return `${folderId}:${targetId}`
}

function metaKey(prefix, folderId, path) {
  return `${prefix}${folderId}:${path}`
}

function readMeta(storage, prefix, folderId, path) {
  return readJson(storage, metaKey(prefix, folderId, path)) ?? {
    operation: 'write',
    localMtime: null,
    dirtyTargets: {},
  }
}

function writeMeta(storage, prefix, folderId, path, meta) {
  storage.setItem(metaKey(prefix, folderId, path), JSON.stringify(meta))
}

function listMetas(storage, prefix, folderId) {
  const metas = []
  const keyPrefix = `${prefix}${folderId}:`
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i)
    if (!key?.startsWith(keyPrefix)) continue
    const path = key.slice(keyPrefix.length)
    metas.push({ path, meta: readJson(storage, key) ?? {} })
  }
  return metas
}

function hasDirtyForTarget(storage, prefix, folderId, targetId) {
  return listMetas(storage, prefix, folderId).some(({ meta }) => meta.dirtyTargets?.[targetId])
}

function readJson(storage, key) {
  const raw = storage.getItem(key)
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function structuredCloneSafe(value) {
  return JSON.parse(JSON.stringify(value))
}

function getSessionItem(key) {
  return globalThis.sessionStorage?.getItem(key) ?? null
}

function setSessionItem(key, value) {
  globalThis.sessionStorage?.setItem(key, value)
}

function removeSessionItem(key) {
  globalThis.sessionStorage?.removeItem(key)
}
