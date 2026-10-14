// Boot the shared storage for the Docs app (plans/docs-app-design.md §3).
//
// Docs lives on the same origin as Focus Planner, so it reuses the planner's
// source registry (localStorage), provider tokens and IndexedDB cache — no second
// sign-in. It never shows a storage picker: if no source is configured yet, the
// user is sent to Focus Planner to connect one.
import * as storage from '../storage/storage.js'
import { createProvider } from '../storage/registry.js'
import {
  loadSources, getSources, getActiveSourceId, restoreSource, setActiveSource,
} from '../storage/sources.js'
import { plannerUrl } from './util.js'

export { plannerUrl }

export async function bootStorage({ host = {}, profile, signal } = {}) {
  signal?.throwIfAborted()
  const consumer = !profile || profile.deploymentMode === 'consumer-web'
  const allowFallback = consumer && profile?.docs?.allowBrowserFallback !== false
  const warnings = []
  // OAuth redirects must land on a registered redirect URI (the planner root).
  storage.configureEngine({ redirectUri: `${window.location.origin}${plannerUrl()}` })
  loadSources()
  const sources = getSources()
  const selectedId = getActiveSourceId()
  let activeId = null
  if (selectedId) {
    try {
      const provider = await restoreSource(selectedId)
      signal?.throwIfAborted()
      if (provider) { await setActiveSource(selectedId); activeId = selectedId }
      else throw new Error(`Storage source ${selectedId} could not be restored`)
    } catch (error) {
      signal?.throwIfAborted()
      if (!allowFallback) throw error
      warnings.push(`Couldn't restore the selected storage: ${error.message}. Using browser storage instead.`)
    }
  }
  if (!activeId) {
    if (!allowFallback) throw new Error('Docs requires a restored storage source; browser fallback is disabled')
    const fallback = createProvider(storage.PROVIDERS.LOCAL_STORAGE)
    if (!await fallback.restore()) throw new Error('Docs browser storage could not be restored')
    signal?.throwIfAborted()
    storage.setActiveProvider(fallback)
  }
  try {
    await storage.registerSyncWorker()
    signal?.throwIfAborted()
    await storage.restoreSyncTargets()
    signal?.throwIfAborted()
  } catch (error) {
    signal?.throwIfAborted()
    if (!consumer) throw error
    warnings.push(`Docs sync is unavailable: ${error.message}`)
  }
  const accountId = host.docsAccountId || host.identity?.id || (consumer ? 'consumer-browser' : null)
  if (!accountId) throw new Error('Docs requires an account identity from its host')
  return {
    hasSources: sources.length > 0, activeId, warnings,
    draftScope: { accountId, sourceId: activeId || 'browser-local' },
  }
}
