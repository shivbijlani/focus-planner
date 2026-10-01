import { PROVIDERS } from './storage.js'
import { IndexedDbProvider } from './indexeddb-provider.js'

export async function restoreSourceOrFallback(source, {
  restoreSource,
  makeFallback = () => new IndexedDbProvider(),
  setActiveProvider,
  onReconnectRequired = () => {},
} = {}) {
  if (source) {
    try {
      const provider = await restoreSource(source.id)
      if (provider) return { provider, providerType: source.providerType, reconnectSource: null }
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
  setActiveSource,
}) {
  const provider = getProvider(source.id)
  if (!provider) return null
  let restored = false
  try { restored = Boolean(await restoreSource(source.id)) } catch { /* pick below */ }
  if (!restored) {
    setPendingSource(source.id)
    if (!await provider.pick()) return null
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
