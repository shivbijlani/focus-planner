import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('#planner/deployment-profile', () => ({
  default: { enabledProviders: ['local-storage'] },
}))

let StoragePicker
let getEnabledProviderTypes
let listSettingsProviders

beforeAll(async () => {
  await import('./registerBuiltinProviders.js')
  ;({ StoragePicker } = await import('../StoragePicker.jsx'))
  ;({ getEnabledProviderTypes, listSettingsProviders } = await import('./registry.js'))
})

describe('profile-filtered provider UI', () => {
  it('shows only Browser Storage in the picker and shared Settings provider list', () => {
    const markup = renderToStaticMarkup(createElement(StoragePicker, { onReady() {} }))

    expect(getEnabledProviderTypes()).toEqual(['local-storage'])
    expect(listSettingsProviders().map(({ label }) => label)).toEqual(['Browser Storage'])
    expect(markup).toContain('Browser Storage')
    expect(markup).not.toContain('Local Folder')
    expect(markup).not.toContain('OneDrive')
    expect(markup).not.toContain('Google Drive')
  })
})
