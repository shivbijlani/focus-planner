import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('#planner/deployment-profile', () => ({
  default: { enabledProviders: ['local-storage'] },
}))

let StoragePicker
let StorageSourceSettings
let getEnabledProviderTypes

beforeAll(async () => {
  await import('./registerBuiltinProviders.js')
  ;({ StoragePicker } = await import('../StoragePicker.jsx'))
  ;({ StorageSourceSettings } = await import('../StorageSourceSettings.jsx'))
  ;({ getEnabledProviderTypes } = await import('./registry.js'))
})

describe('profile-filtered provider UI', () => {
  it('shows only Browser Storage in the picker and rendered Settings cards', () => {
    const pickerMarkup = renderToStaticMarkup(createElement(StoragePicker, { onReady() {} }))
    const settingsMarkup = renderToStaticMarkup(
      createElement(StorageSourceSettings, { activeProviderType: null, onChoose() {}, busy: false }),
    )

    expect(getEnabledProviderTypes()).toEqual(['local-storage'])
    expect(pickerMarkup).toContain('Browser Storage')
    expect(pickerMarkup).not.toContain('Local Folder')
    expect(settingsMarkup).toContain('Browser Storage')
    expect(settingsMarkup).not.toContain('Local Folder')
    expect(settingsMarkup).not.toContain('OneDrive')
    expect(settingsMarkup).not.toContain('Google Drive')
  })
})
