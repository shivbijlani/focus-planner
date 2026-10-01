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
    })
    expect(onReconnectRequired).toHaveBeenCalledWith(source)
    expect(setActiveProvider).toHaveBeenCalledWith(fallback)
    expect(localStorage.getItem('fp-active-source')).toBe('s1')
    expect(JSON.parse(localStorage.getItem('fp-sources'))).toEqual([source])
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
    const setActiveSource = vi.fn()

    const result = await reconnectSavedSource(source, {
      getProvider: vi.fn(id => id === source.id ? provider : null),
      restoreSource,
      setPendingSource,
      setActiveSource,
    })

    expect(restoreSource).toHaveBeenCalledWith('s2')
    expect(provider.pick).toHaveBeenCalledOnce()
    expect(setPendingSource).toHaveBeenCalledWith('s2')
    expect(setActiveSource).toHaveBeenCalledWith('s2')
    expect(result).toEqual({ provider, restored: false })
  })

  it('does not activate a source when the user cancels reconnection', async () => {
    const setActiveSource = vi.fn()
    const result = await reconnectSavedSource(
      { id: 's2', providerType: 'fsa' },
      {
        getProvider: () => ({ pick: vi.fn().mockResolvedValue(null) }),
        restoreSource: vi.fn().mockResolvedValue(null),
        setPendingSource: vi.fn(),
        setActiveSource,
      },
    )
    expect(result).toBeNull()
    expect(setActiveSource).not.toHaveBeenCalled()
  })
})
