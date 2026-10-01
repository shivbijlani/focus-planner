import { PROVIDERS } from './storage.js'
import { createProvider } from './registry.js'

export async function restoreSourceOrFallback(source, {
  restoreSource,
  makeFallback = () => createProvider(PROVIDERS.LOCAL_STORAGE),
  setActiveProvider,
  onReconnectRequired = () => {},
  pendingSource = null,
  removeSource = () => {},
} = {}) {
  if (pendingSource?.source) {
    try {
      const provider = await restoreSource(pendingSource.source.id)
      if (provider) {
        return {
          provider,
          providerType: pendingSource.source.providerType,
          reconnectSource: null,
          activateSource: pendingSource.source,
          fallback: false,
        }
      }
    } catch {
      // A rejected permission/token restore is handled like an unavailable source.
    }
    if (pendingSource.created) removeSource(pendingSource.source.id)
  }

  if (source) {
    try {
      const provider = await restoreSource(source.id)
      if (provider) {
        return {
          provider,
          providerType: source.providerType,
          reconnectSource: null,
          activateSource: source,
          fallback: false,
        }
      }
    } catch {
      // A rejected permission/token restore is handled like an unavailable source.
    }
    onReconnectRequired(source)
  }

  const provider = makeFallback()
  await provider.restore()
  setActiveProvider(provider)
  return {
    provider,
    providerType: PROVIDERS.LOCAL_STORAGE,
    reconnectSource: source || null,
    activateSource: null,
    fallback: true,
  }
}

export function findSavedSourceForProvider(sources, providerType, activeId) {
  return sources.find(source => source.id === activeId && source.providerType === providerType)
    || sources.find(source => source.providerType === providerType)
    || null
}

export async function reconnectSavedSource(source, {
  getProvider,
  restoreSource,
  setPendingSource,
  clearPendingSource = () => {},
  setActiveSource,
}) {
  const provider = getProvider(source.id)
  if (!provider) return null
  let restored = false
  try { restored = Boolean(await restoreSource(source.id)) } catch { /* pick below */ }
  if (!restored) {
    setPendingSource(source.id, { created: false })
    try {
      const picked = await provider.pick()
      if (!picked) {
        if (source.providerType === PROVIDERS.FSA) clearPendingSource()
        return null
      }
    } catch (error) {
      clearPendingSource()
      throw error
    }
  }
  await setActiveSource(source.id)
  return { provider, restored }
}

export async function bootstrapSync(storage) {
  for (const operation of [
    () => storage.registerSyncWorker(),
    () => storage.restoreSyncTargets(),
    () => storage.startAutoSync(),
  ]) {
    try {
      await operation()
    } catch (error) {
      console.error('Sync bootstrap failed:', error)
    }
  }
}
