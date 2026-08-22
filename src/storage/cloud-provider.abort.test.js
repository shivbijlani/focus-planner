import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { GoogleDriveProvider } from './google-drive-provider.js'
import { OneDriveProvider } from './onedrive-provider.js'

describe('cloud provider cancellation', () => {
  beforeEach(() => {
    const store = new Map()
    globalThis.localStorage = {
      getItem: key => store.get(key) ?? null,
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: key => store.delete(key),
    }
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete globalThis.fetch
    delete globalThis.localStorage
  })

  it('passes AbortSignal through OneDrive journal checks and reads', async () => {
    const fetchMock = vi.fn(async (url) => ({
      ok: true,
      status: 200,
      text: async () => `content from ${url}`,
    }))
    globalThis.fetch = fetchMock
    const provider = new OneDriveProvider()
    provider._token = 'test-token'
    provider._expiresAt = Date.now() + 60_000
    const controller = new AbortController()

    await provider.checkJournal('1', { signal: controller.signal })
    await provider.read('journal/task-1.md', { signal: controller.signal })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls.every(([, options]) => options.signal === controller.signal)).toBe(true)
  })

  it('passes AbortSignal through Google Drive lookup and content reads', async () => {
    const fetchMock = vi.fn(async (url) => (
      String(url).includes('alt=media')
        ? { ok: true, status: 200, text: async () => 'content' }
        : { ok: true, status: 200, json: async () => ({ files: [{ id: 'file-id' }] }) }
    ))
    globalThis.fetch = fetchMock
    const provider = new GoogleDriveProvider('Planner')
    provider._token = 'test-token'
    provider._expiresAt = Date.now() + 60_000
    provider._folderId = 'folder-id'
    const controller = new AbortController()

    await provider.checkJournal('1', { signal: controller.signal })
    await provider.read('journal/task-1.md', { signal: controller.signal })

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock.mock.calls.every(([, options]) => options.signal === controller.signal)).toBe(true)
  })

  it('only treats an explicit OneDrive not-found response as absent', async () => {
    const provider = new OneDriveProvider()
    provider._token = 'test-token'
    provider._expiresAt = Date.now() + 60_000

    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 404 }))
    await expect(provider.checkJournal('1')).resolves.toEqual({
      exists: false,
      path: 'journal/task-1.md',
    })

    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 401 }))
    await expect(provider.checkJournal('1')).rejects.toThrow('OneDrive journal check failed: 401')
  })

  it('throws Google Drive helper errors instead of reporting absence', async () => {
    const provider = new GoogleDriveProvider('Planner')
    provider._token = 'test-token'
    provider._expiresAt = Date.now() + 60_000
    provider._folderId = 'folder-id'
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ files: [{ id: 'journal-folder-id' }] }),
      })
      .mockResolvedValueOnce({ ok: false, status: 503 })

    await expect(provider.checkJournal('1')).rejects.toThrow('Drive file lookup failed: 503')
  })
})
