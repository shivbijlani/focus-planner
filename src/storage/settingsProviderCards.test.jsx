import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

let StorageSourceSettings

beforeAll(async () => {
  globalThis.window = { showDirectoryPicker() {} }
  await import('./registerBuiltinProviders.js')
  ;({ StorageSourceSettings } = await import('../StorageSourceSettings.jsx'))
})

afterEach(() => {
  delete globalThis.window
})

describe('consumer Settings provider cards', () => {
  it('preserves the established card icon and label pairs', () => {
    globalThis.window = { showDirectoryPicker() {} }
    const markup = renderToStaticMarkup(
      createElement(StorageSourceSettings, { activeProviderType: null, onChoose() {}, busy: false }),
    )

    expect(markup).toMatch(/<span class="sync-target-icon">🗂️<\/span>[\s\S]*?<div class="sync-target-name">Browser Storage<\/div>/)
    expect(markup).toMatch(/<span class="sync-target-icon">📂<\/span>[\s\S]*?<div class="sync-target-name">Local Folder<\/div>/)
    expect(markup).not.toContain('OneDrive')
    expect(markup).not.toContain('Google Drive')
  })
})
