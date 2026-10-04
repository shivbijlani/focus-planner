import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  bootstrapSync,
  findSavedSourceForProvider,
  reconnectSavedSource,
  restoreSourceOrFallback,
} from './sourceRecovery.js'

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial))
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  }
}

describe('storage source recovery', () => {
  afterEach(() => {
    delete globalThis.localStorage
  })

  it('falls back to Browser Storage without changing saved choices or active ID', async () => {
    globalThis.localStorage = memoryStorage({
      'fp-sources': JSON.stringify([{ id: 's1', name: 'Work', providerType: 'fsa' }]),
      'fp-active-source': 's1',
    })
    const source = { id: 's1', name: 'Work', providerType: 'fsa' }
    const fallback = { restore: vi.fn().mockResolvedValue(true) }
    const onReconnectRequired = vi.fn()
    const setActiveProvider = vi.fn()

    const result = await restoreSourceOrFallback(source, {
      restoreSource: vi.fn().mockResolvedValue(null),
      makeFallback: () => fallback,
      setActiveProvider,
      onReconnectRequired,
    })

    expect(result).toEqual({
      provider: fallback,
      providerType: 'local-storage',
      reconnectSource: source,
      activateSource: null,
      fallback: true,
    })
    expect(onReconnectRequired).toHaveBeenCalledWith(source)
    expect(setActiveProvider).toHaveBeenCalledWith(fallback)
    expect(localStorage.getItem('fp-active-source')).toBe('s1')
    expect(JSON.parse(localStorage.getItem('fp-sources'))).toEqual([source])
  })

  it.each([true, false])('retries the persisted active source after pending restore fails (created=%s)', async created => {
    const active = { id: 's1', name: 'Work folder', providerType: 'fsa' }
    const pending = { id: 's2', name: 'OneDrive', providerType: 'onedrive' }
    const activeProvider = { id: 'active-provider' }
    const restoreSource = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(activeProvider)
    const removeSource = vi.fn()
    const onReconnectRequired = vi.fn()
    const makeFallback = vi.fn()
    globalThis.localStorage = memoryStorage({
      'fp-sources': JSON.stringify([active, pending]),
      'fp-active-source': active.id,
    })

    const result = await restoreSourceOrFallback(active, {
      pendingSource: { source: pending, created },
      restoreSource,
      makeFallback,
      setActiveProvider: vi.fn(),
      removeSource,
      onReconnectRequired,
    })

    expect(restoreSource.mock.calls).toEqual([[pending.id], [active.id]])
    expect(removeSource.mock.calls).toEqual(created ? [[pending.id]] : [])
    expect(result).toEqual({
      provider: activeProvider,
      providerType: active.providerType,
      reconnectSource: null,
      activateSource: active,
      fallback: false,
    })
    expect(onReconnectRequired).not.toHaveBeenCalled()
    expect(makeFallback).not.toHaveBeenCalled()
    expect(localStorage.getItem('fp-active-source')).toBe(active.id)
    expect(JSON.parse(localStorage.getItem('fp-sources'))[0]).toEqual(active)
  })

  it('restores and activates the one-shot pending source only after success', async () => {
    const active = { id: 's1', providerType: 'local-storage' }
    const pending = { id: 's2', providerType: 'onedrive' }
    const provider = { id: 'provider' }
    const result = await restoreSourceOrFallback(active, {
      pendingSource: { source: pending, created: true },
      restoreSource: vi.fn().mockResolvedValue(provider),
      setActiveProvider: vi.fn(),
    })
    expect(result.provider).toBe(provider)
    expect(result.activateSource).toBe(pending)
    expect(result.providerType).toBe('onedrive')
    expect(result.fallback).toBe(false)
  })

  it('attempts all sync bootstrap steps even when one fails', async () => {
    const storage = {
      registerSyncWorker: vi.fn().mockRejectedValue(new Error('worker unavailable')),
      restoreSyncTargets: vi.fn().mockResolvedValue(undefined),
      startAutoSync: vi.fn(),
    }
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    await bootstrapSync(storage)

    expect(storage.registerSyncWorker).toHaveBeenCalledOnce()
    expect(storage.restoreSyncTargets).toHaveBeenCalledOnce()
    expect(storage.startAutoSync).toHaveBeenCalledOnce()
    error.mockRestore()
  })

  it('does not start sync or enter the ready UI when the local replica cannot initialize', async () => {
    const storage = {
      registerSyncWorker: vi.fn().mockResolvedValue(undefined),
      restoreSyncTargets: vi.fn().mockRejectedValue(new Error('IndexedDB unavailable')),
      startAutoSync: vi.fn(),
    }
    await expect(bootstrapSync(storage)).rejects.toThrow('IndexedDB unavailable')
    expect(storage.startAutoSync).not.toHaveBeenCalled()
  })

  it('prefers the active saved source of a provider type before reusing another', () => {
    const choices = [
      { id: 's1', providerType: 'fsa' },
      { id: 's2', providerType: 'fsa' },
    ]
    expect(findSavedSourceForProvider(choices, 'fsa', 's2')).toBe(choices[1])
    expect(findSavedSourceForProvider(choices, 'fsa', 'missing')).toBe(choices[0])
    expect(findSavedSourceForProvider(choices, 'local-storage', 's1')).toBeNull()
  })

  it('reconnects an existing choice before activating its unchanged ID', async () => {
    const source = { id: 's2', name: 'Local Folder', providerType: 'fsa' }
    const provider = { pick: vi.fn().mockResolvedValue({ name: 'chosen folder' }) }
    const restoreSource = vi.fn().mockResolvedValue(null)
    const setPendingSource = vi.fn()
    const clearPendingSource = vi.fn()
    const setActiveSource = vi.fn()

    const result = await reconnectSavedSource(source, {
      getProvider: vi.fn(id => id === source.id ? provider : null),
      restoreSource,
      setPendingSource,
      clearPendingSource,
      setActiveSource,
    })

    expect(restoreSource).toHaveBeenCalledWith('s2')
    expect(provider.pick).toHaveBeenCalledOnce()
    expect(setPendingSource).toHaveBeenCalledWith('s2', { created: false })
    expect(setActiveSource).toHaveBeenCalledWith('s2')
    expect(result).toEqual({ provider, restored: false })
    expect(clearPendingSource).not.toHaveBeenCalled()
  })

  it('does not activate a source when the user cancels reconnection', async () => {
    const setActiveSource = vi.fn()
    const clearPendingSource = vi.fn()
    const result = await reconnectSavedSource(
      { id: 's2', providerType: 'fsa' },
      {
        getProvider: () => ({ pick: vi.fn().mockResolvedValue(null) }),
        restoreSource: vi.fn().mockResolvedValue(null),
        setPendingSource: vi.fn(),
        clearPendingSource,
        setActiveSource,
      },
    )
    expect(result).toBeNull()
    expect(clearPendingSource).toHaveBeenCalledOnce()
    expect(setActiveSource).not.toHaveBeenCalled()
  })

  it('clears pending state when a saved source picker throws', async () => {
    const clearPendingSource = vi.fn()
    await expect(reconnectSavedSource(
      { id: 's2', providerType: 'fsa' },
      {
        getProvider: () => ({ pick: vi.fn().mockRejectedValue(new DOMException('cancelled', 'AbortError')) }),
        restoreSource: vi.fn().mockResolvedValue(null),
        setPendingSource: vi.fn(),
        clearPendingSource,
        setActiveSource: vi.fn(),
      },
    )).rejects.toMatchObject({ name: 'AbortError' })
    expect(clearPendingSource).toHaveBeenCalledOnce()
  })
})
