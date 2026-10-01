// Boot the shared storage for the Docs app (plans/docs-app-design.md §3).
//
// Docs lives on the same origin as Focus Planner, so it reuses the planner's
// source registry (localStorage), provider tokens and IndexedDB cache — no second
// sign-in. It never shows a storage picker: if no source is configured yet, the
// user is sent to Focus Planner to connect one.
import * as storage from '../storage/storage.js'
import {
  loadSources, migrateLegacy, getSources, getActiveSourceId, restoreSource, setActiveSource,
} from '../storage/sources.js'
import { IndexedDbProvider } from '../storage/indexeddb-provider.js'

export function plannerUrl() {
  const base = (import.meta.env?.BASE_URL || '/')
  return `${base}`
}

export async function bootStorage() {
  // OAuth redirects must land on a registered redirect URI (the planner root).
  storage.configureEngine({ redirectUri: `${window.location.origin}${plannerUrl()}` })
  loadSources()
  migrateLegacy()
  const sources = getSources()
  const order = [...new Set([getActiveSourceId(), ...sources.map((s) => s.id)].filter(Boolean))]
  let activeId = null
  for (const id of order) {
    try {
      const p = await restoreSource(id)
      if (p) { await setActiveSource(id); activeId = id; break }
    } catch { /* try the next source */ }
  }
  if (!activeId) {
    const fallback = new IndexedDbProvider()
    await fallback.restore()
    storage.setActiveProvider(fallback)
  }
  try {
    await storage.registerSyncWorker()
    await storage.restoreSyncTargets()
  } catch { /* sync is best-effort; local reads still work */ }
  return { hasSources: sources.length > 0, activeId }
}
