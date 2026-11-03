// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearBrowserDatabase, isPlannerStorageKey, resetBrowser, RESET_KEY } from './reset.js'

async function database(name, store, action) {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open(name)
    request.onupgradeneeded = () => request.result.createObjectStore(store)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite')
      const request = action(tx.objectStore(store))
      tx.oncomplete = () => resolve(request?.result)
      tx.onerror = () => reject(tx.error)
    })
  } finally { db.close() }
}
const put = (db, store, key, value) => database(db, store, s => s.put(value, key))
const keys = (db, store) => database(db, store, s => s.getAllKeys())

beforeEach(async () => {
  localStorage.clear()
  sessionStorage.clear()
  await put('folder-sync', 'meta', 'local:planner.md', { content: 'unsynced' })
  await put('focus-planner', 'files', 'planner.md', 'my tasks')
  await put('keyval-store', 'keyval', 'focus-planner-dir-handle:s1', { handle: true })
  await put('keyval-store', 'keyval', 'unrelated', 'keep')
})
afterEach(() => vi.restoreAllMocks())

describe('browser reset', () => {
  it('can reset full legacy localStorage, but frees no space before backup confirms it stopped', async () => {
    localStorage.setItem('fp-file:legacy.md', 'legacy data filling the quota')
    const setItem = Storage.prototype.setItem
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (key, value) {
      if (key === RESET_KEY && this.getItem('fp-file:legacy.md')) {
        throw new DOMException('Storage full', 'QuotaExceededError')
      }
      return setItem.call(this, key, value)
    })
    const serviceWorker = { getRegistrations: async () => [{
      scope: 'https://planner.test/folder-sync/', active: {}, unregister: async () => true,
    }] }
    await expect(resetBrowser({
      serviceWorker,
      pause: async () => { throw new Error('Other tab still open') },
    })).rejects.toThrow('Other tab still open')
    expect(localStorage.getItem('fp-file:legacy.md')).toBe('legacy data filling the quota')
    let pauseCalls = 0
    await resetBrowser({ serviceWorker, pause: async () => {
      pauseCalls += 1
      if (pauseCalls === 1) {
        expect(localStorage.getItem('fp-file:legacy.md')).toBe('legacy data filling the quota')
        expect(localStorage.getItem(RESET_KEY)).toBeNull()
      } else {
        expect(localStorage.getItem('fp-file:legacy.md')).toBeNull()
        expect(localStorage.getItem(RESET_KEY)).toBe('1')
      }
      expect(await keys('focus-planner', 'files')).toEqual(['planner.md'])
    } })
    expect(pauseCalls).toBe(2)
    expect(Object.keys(localStorage)).toEqual([])
    expect(await keys('focus-planner', 'files')).toEqual([])
  })

  it('can retry when the post-marker client check refuses a full-storage reset', async () => {
    localStorage.setItem('fp-file:legacy.md', 'legacy data filling the quota')
    const setItem = Storage.prototype.setItem
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (key, value) {
      if (key === RESET_KEY && this.getItem('fp-file:legacy.md')) {
        throw new DOMException('Storage full', 'QuotaExceededError')
      }
      return setItem.call(this, key, value)
    })
    const unregister = vi.fn(async () => true)
    const serviceWorker = { getRegistrations: async () => [{
      scope: 'https://planner.test/folder-sync/', active: {}, unregister,
    }] }
    let pauseCalls = 0
    await expect(resetBrowser({
      serviceWorker,
      pause: async () => {
        pauseCalls += 1
        if (pauseCalls === 2) throw new Error('Another Planner window opened')
      },
    })).rejects.toThrow('Another Planner window opened')
    expect(unregister).not.toHaveBeenCalled()
    expect(localStorage.getItem(RESET_KEY)).toBe('1')
    expect(await keys('focus-planner', 'files')).toEqual(['planner.md'])

    await resetBrowser({ serviceWorker, pause: async () => {} })
    expect(unregister).toHaveBeenCalledOnce()
    expect(await keys('focus-planner', 'files')).toEqual([])
  })

  it('clears only planner preferences and local databases after the worker stops, never a remote provider', async () => {
    localStorage.setItem('fp-file:legacy.md', 'old')
    localStorage.setItem('folder-sync:intended-providers', '["onedrive"]')
    localStorage.setItem('gd_token', 'test-token')
    localStorage.setItem('unrelated', 'keep')
    sessionStorage.setItem('onedrive_code_verifier', 'test')
    sessionStorage.setItem('unrelated', 'keep')
    const pause = vi.fn(async () => {
      expect(await keys('focus-planner', 'files')).toContain('planner.md')
      expect(localStorage.getItem(RESET_KEY)).toBe('1')
    })
    const unregister = vi.fn(async () => true)
    const worker = {}
    await resetBrowser({
      serviceWorker: { getRegistrations: async () => [{ scope: 'https://planner.test/folder-sync/', active: worker, unregister }] },
      pause,
    })
    expect(pause).toHaveBeenCalledWith(worker)
    expect(pause).toHaveBeenCalledTimes(2)
    expect(unregister).toHaveBeenCalledOnce()
    expect(await keys('focus-planner', 'files')).toEqual([])
    expect(await keys('folder-sync', 'meta')).toEqual([])
    expect(await keys('keyval-store', 'keyval')).toEqual(['unrelated'])
    expect(Object.keys(localStorage)).toEqual(['unrelated'])
    expect(Object.keys(sessionStorage)).toEqual(['unrelated'])
  })

  it('does not erase data or credentials when stopping the worker fails', async () => {
    localStorage.setItem('gd_token', 'test-token')
    const unregister = vi.fn()
    await expect(resetBrowser({
      serviceWorker: { getRegistrations: async () => [{ scope: 'https://planner.test/folder-sync/', active: {}, unregister }] },
      pause: async () => { throw new Error('Close other tabs') },
    })).rejects.toThrow('Close other tabs')
    expect(unregister).not.toHaveBeenCalled()
    expect(await keys('focus-planner', 'files')).toEqual(['planner.md'])
    expect(localStorage.getItem('gd_token')).toBe('test-token')
    expect(localStorage.getItem(RESET_KEY)).toBe('1')
  })

  it('does not erase files when unregistering fails', async () => {
    await expect(resetBrowser({
      serviceWorker: { getRegistrations: async () => [{ scope: 'https://planner.test/folder-sync/', active: {}, unregister: async () => false }] },
      pause: async () => {},
    })).rejects.toThrow('unregister')
    expect(await keys('focus-planner', 'files')).toEqual(['planner.md'])
  })

  it('clears all sync stores, including credentials, pending work, and folder handles', async () => {
    const db = 'reset-multistore-test'
    await new Promise((resolve, reject) => {
      const request = indexedDB.open(db)
      request.onupgradeneeded = () => {
        for (const store of ['tokens', 'queue', 'meta', 'fsa']) request.result.createObjectStore(store).put('test', 'key')
      }
      request.onsuccess = () => { request.result.close(); resolve() }
      request.onerror = () => reject(request.error)
    })
    await clearBrowserDatabase(db)
    for (const store of ['tokens', 'queue', 'meta', 'fsa']) expect(await keys(db, store)).toEqual([])
  })

  it('recognizes current and legacy auth keys without sweeping unrelated storage', () => {
    for (const key of ['fp-sources', 'fp-file:a', 'planner.diag', 'folder-sync:auto-reconnected:onedrive', 'od_token', 'gd_expires', 'google-drive_state']) {
      expect(isPlannerStorageKey(key)).toBe(true)
    }
    expect(isPlannerStorageKey('other-app')).toBe(false)
  })
})
