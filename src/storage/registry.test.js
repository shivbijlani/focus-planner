import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { validateDeploymentProfile } from '../config/profile.js'
import {
  createProvider,
  getProvider,
  listProviders,
  registerProvider,
  resetRegistryForTests,
} from './registry.js'

const factory = () => ({ ready: true })

describe('storage provider registry', () => {
  beforeEach(() => {
    resetRegistryForTests()
    globalThis.window = { showDirectoryPicker() {} }
  })

  afterEach(() => {
    resetRegistryForTests()
    delete globalThis.window
  })

  it('registers and creates providers by type', () => {
    registerProvider({ type: 'browser', label: 'Browser Storage', factory })

    expect(getProvider('browser')).toMatchObject({ type: 'browser', label: 'Browser Storage' })
    expect(createProvider('browser')).toEqual({ ready: true })
  })

  it('rejects duplicate registrations', () => {
    registerProvider({ type: 'browser', label: 'Browser Storage', factory })
    expect(() => registerProvider({ type: 'browser', label: 'Duplicate', factory })).toThrow(/already registered/)
  })

  it('filters by enabled provider types and preserves profile order', () => {
    registerProvider({ type: 'browser', label: 'Browser Storage', factory })
    registerProvider({ type: 'folder', label: 'Local Folder', factory })
    registerProvider({ type: 'cloud', label: 'Cloud', factory })

    expect(listProviders(['cloud', 'browser']).map(({ type }) => type)).toEqual(['cloud', 'browser'])
    expect(listProviders(['browser']).map(({ label }) => label)).toEqual(['Browser Storage'])
  })

  it('fails when the profile names an unregistered or unknown provider', () => {
    expect(() => listProviders(['missing'])).toThrow(/Unknown storage provider/)
    expect(() => validateDeploymentProfile({ enabledProviders: ['missing'] })).toThrow(/Unknown storage provider/)
  })
})
