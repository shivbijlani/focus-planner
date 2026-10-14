import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  configureEngine: vi.fn(), registerSyncWorker: vi.fn(), restoreSyncTargets: vi.fn(),
  setActiveProvider: vi.fn(), createProvider: vi.fn(), fallbackRestore: vi.fn(),
  loadSources: vi.fn(), getSources: vi.fn(), getActiveSourceId: vi.fn(),
  restoreSource: vi.fn(), setActiveSource: vi.fn(),
}))
vi.mock('../storage/storage.js', () => ({ ...mocks, PROVIDERS: { LOCAL_STORAGE: 'local-storage' } }))
vi.mock('../storage/registry.js', () => ({ createProvider: mocks.createProvider }))
vi.mock('../storage/sources.js', () => mocks)
import { bootStorage } from './storageBoot.js'

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('window', { location: { origin: 'https://example.test' } })
  mocks.getSources.mockReturnValue([{ id: 's1' }])
  mocks.getActiveSourceId.mockReturnValue('s1')
  mocks.restoreSource.mockResolvedValue(null)
  mocks.fallbackRestore.mockResolvedValue(true)
  mocks.createProvider.mockReturnValue({ restore: mocks.fallbackRestore })
})

describe('Docs storage policy', () => {
  it.each([null, new Error('Managed restore refused')])('never falls back after failed managed restore (%s)', async (failure) => {
    if (failure) mocks.restoreSource.mockRejectedValue(failure)
    await expect(bootStorage({ profile: { deploymentMode: 'managed' }, host: { docsAccountId: 'account' } }))
      .rejects.toThrow(/restore|restored/)
    expect(mocks.createProvider).not.toHaveBeenCalled()
    expect(mocks.setActiveProvider).not.toHaveBeenCalled()
  })

  it('fails closed when a managed source is absent', async () => {
    mocks.getActiveSourceId.mockReturnValue(null)
    await expect(bootStorage({ profile: { deploymentMode: 'managed' } })).rejects.toThrow('fallback is disabled')
    expect(mocks.createProvider).not.toHaveBeenCalled()
  })

  it('keeps intentional consumer fallback and reports its reason', async () => {
    mocks.restoreSource.mockRejectedValue(new Error('Sign in again'))
    const boot = await bootStorage()
    expect(boot.draftScope).toEqual({ accountId: 'consumer-browser', sourceId: 'browser-local' })
    expect(boot.warnings[0]).toContain('Sign in again')
    expect(mocks.setActiveProvider).toHaveBeenCalledOnce()
  })

  it('surfaces consumer fallback failure rather than returning a usable boot', async () => {
    mocks.fallbackRestore.mockResolvedValue(false)
    await expect(bootStorage()).rejects.toThrow('browser storage could not be restored')
    expect(mocks.setActiveProvider).not.toHaveBeenCalled()
  })

  it('surfaces managed sync failure without selecting fallback', async () => {
    mocks.restoreSource.mockResolvedValue({})
    mocks.restoreSyncTargets.mockRejectedValue(new Error('Managed boot failed'))
    await expect(bootStorage({ profile: { deploymentMode: 'managed' }, host: { docsAccountId: 'account' } }))
      .rejects.toThrow('Managed boot failed')
    expect(mocks.createProvider).not.toHaveBeenCalled()
  })

  it('returns a restored source and host account identity', async () => {
    mocks.restoreSource.mockResolvedValue({})
    expect(await bootStorage({ host: { docsAccountId: 'tenant/account' } }))
      .toMatchObject({ draftScope: { accountId: 'tenant/account', sourceId: 's1' }, warnings: [] })
  })
})
