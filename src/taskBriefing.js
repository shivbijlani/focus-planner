// Optional primary Markdown briefings are discovered from one provider file listing,
// shared by all task rows. A Docs primary remains a separate, independently linked file.
import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { onLocalChange } from './storage/storage.js'
import { taskBriefingPath } from './fileTreePresentation.js'

const stores = new WeakMap()
let activeStore = null
let wired = false

function collectPaths(items, paths = new Set()) {
  for (const item of items || []) {
    if (item.type === 'file' && typeof item.path === 'string') {
      paths.add(item.path.replace(/\\/g, '/'))
    } else if (item.type === 'directory') {
      collectPaths(item.children, paths)
    }
  }
  return paths
}

export function createTaskBriefingStore(provider) {
  let snapshot = { status: 'unknown', paths: null, error: null }
  let inflight = null
  const listeners = new Set()
  const notify = () => listeners.forEach((listener) => listener())

  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot() {
      return snapshot
    },
    has(taskId) {
      const path = taskBriefingPath(taskId)
      return snapshot.status === 'ready' && !!path && snapshot.paths.has(path)
    },
    async load({ force = false } = {}) {
      if (inflight) return inflight
      if (!force && snapshot.status === 'ready') return snapshot
      snapshot = { status: 'loading', paths: snapshot.paths, error: null }
      notify()
      inflight = (async () => {
        try {
          if (typeof provider?.getFiles !== 'function') {
            throw new Error('The active storage provider cannot list files.')
          }
          const tree = await provider.getFiles()
          snapshot = { status: 'ready', paths: collectPaths(tree), error: null }
          return snapshot
        } catch (error) {
          snapshot = { status: 'error', paths: null, error }
          throw error
        } finally {
          inflight = null
          notify()
        }
      })()
      return inflight
    },
  }
}

export function taskBriefingStoreFor(provider) {
  if (!provider || (typeof provider !== 'object' && typeof provider !== 'function')) return null
  let store = stores.get(provider)
  if (!store) {
    store = createTaskBriefingStore(provider)
    stores.set(provider, store)
  }
  return store
}

function ensureSubscribed() {
  if (wired || typeof document === 'undefined') return
  wired = true
  try {
    onLocalChange((name) => {
      if (/^journal\/task-\d+-briefing\.md$/.test(String(name || ''))) {
        activeStore?.load({ force: true }).catch(() => {})
      }
    })
  } catch { /* storage engine may not be initialized yet */ }
  const refresh = () => activeStore?.load({ force: true }).catch(() => {})
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refresh()
  })
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) refresh()
  })
}

export function useTaskBriefing(provider, taskId) {
  const store = taskBriefingStoreFor(provider)
  const subscribe = useCallback((listener) => store?.subscribe(listener) ?? (() => {}), [store])
  const getSnapshot = useCallback(() => store?.getSnapshot() ?? EMPTY, [store])
  const snapshot = useSyncExternalStore(subscribe, getSnapshot)

  useEffect(() => {
    if (!store || taskId == null || taskId === '') return undefined
    ensureSubscribed()
    activeStore = store
    store.load().catch(() => {})
  }, [store, taskId])

  const retry = useCallback(() => store?.load({ force: true }), [store])
  const path = store?.has(taskId) ? taskBriefingPath(taskId) : null
  return { status: snapshot.status, path, retry }
}

const EMPTY = Object.freeze({ status: 'unknown', paths: null, error: null })
