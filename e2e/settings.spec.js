// Settings dialog, agent editors, and the storage providers offered today.
import { test, expect } from '@playwright/test'
import { openPlanner, waitForBoard, readFile, writeFile, planWith, PLAN_FILE } from './helpers.js'

async function openSettings(page) {
  await page.getByRole('button', { name: /Settings/ }).first().click()
  const dialog = page.locator('.settings-dialog')
  await expect(dialog).toBeVisible()
  return dialog
}

test('agent gate editor: add a line, save, and it survives a reload', async ({ page }) => {
  await openPlanner(page)
  const openGate = async () => {
    await page.getByRole('button', { name: /agent-gate\.md/ }).click()
    await expect(page.getByRole('heading', { name: 'Agent gate' })).toBeVisible()
  }

  await openGate()
  const input = page.getByRole('textbox', { name: 'Add to Always ask (safety floor)' })
  await input.fill('Smoke-test rule: never email the CEO')
  await input.press('Enter')
  await expect(page.getByText('Unsaved changes.')).toBeVisible()
  await page.getByTitle('Save agent-gate.md').click()
  await expect(page.getByText('Saved.')).toBeVisible()
  expect(await readFile(page, 'agent-gate.md')).toContain('Smoke-test rule: never email the CEO')

  await page.reload()
  await waitForBoard(page)
  await openGate()
  await expect(page.locator('#agent-gate-always-ask-title').locator('..'))
    .toContainText('Smoke-test rule: never email the CEO')
})

test('agent settings editor: edit, save, and it survives a reload', async ({ page }) => {
  await openPlanner(page)
  const openEditor = async () => {
    const dialog = await openSettings(page)
    await dialog.getByRole('button', { name: 'Open user-settings.md' }).click()
    await expect(page.getByRole('heading', { name: 'Agent settings' })).toBeVisible()
  }

  await openEditor()
  await page.getByRole('tab', { name: 'Raw' }).click()
  const raw = page.locator('textarea.settings-ai-input')
  await raw.fill('# Overnight Agent — user settings\n\nSmoke setting: 42\n')
  await page.getByTitle('Save user-settings.md').click()
  await expect(page.getByText('Saved.')).toBeVisible()
  expect(await readFile(page, 'user-settings.md')).toContain('Smoke setting: 42')

  await page.reload()
  await waitForBoard(page)
  await openEditor()
  await page.getByRole('tab', { name: 'Raw' }).click()
  await expect(page.locator('textarea.settings-ai-input')).toHaveValue(/Smoke setting: 42/)
})

test('settings: mission statement persists and pins to the board', async ({ page }) => {
  await openPlanner(page)
  let dialog = await openSettings(page)
  await dialog.locator('.settings-mission-input').fill('Ship calm software')
  await expect.poll(async () => JSON.parse(await readFile(page, 'settings.json') || '{}').missionStatement)
    .toBe('Ship calm software')
  await dialog.locator('.settings-dialog-close').click()

  await page.reload()
  await waitForBoard(page)
  await expect(page.getByRole('textbox', { name: 'Search tasks' }).first())
    .toHaveAttribute('placeholder', /Ship calm software/)
  dialog = await openSettings(page)
  await expect(dialog.locator('.settings-mission-input')).toHaveValue('Ship calm software')
})

test('storage choices offered today: browser, local folder, OneDrive, Google Drive', async ({ page }) => {
  await openPlanner(page)
  const dialog = await openSettings(page)
  const names = dialog.locator('.sync-target-name')
  await expect(names.filter({ hasText: /^Browser Storage$/ })).toHaveCount(1)
  await expect(names.filter({ hasText: /^Local Folder$/ })).toHaveCount(1)
  await expect(names.filter({ hasText: /^OneDrive$/ })).toHaveCount(1)
  await expect(names.filter({ hasText: /^Google Drive$/ })).toHaveCount(1)
  await expect(dialog.locator('.sync-target-card', { hasText: 'Browser Storage' })).toContainText('● Active')
})

test('storage picker lists every provider when storage cannot start', async ({ page }) => {
  // Make IndexedDB unusable so first-run bootstrap fails and the app falls
  // back to its full-screen storage picker.
  await page.addInitScript(() => {
    const broken = () => { throw new Error('IndexedDB disabled for smoke test') }
    Object.defineProperty(window, 'indexedDB', { get: broken, configurable: true })
  })
  await page.goto('/')
  const picker = page.locator('.storage-picker')
  await expect(picker).toBeVisible()
  const names = picker.locator('.storage-option-name')
  await expect(names).toHaveText(['Browser Storage', 'Local Folder', 'OneDrive', 'Google Drive'])
})

test('legacy multi-source state opens only the saved active source and shows a dismissible notice', async ({ page }) => {
  await openPlanner(page)
  await writeFile(page, PLAN_FILE, planWith({
    today: ['| 42 | 🟡 | Personal source task | - | 2026-01-01 | |'],
  }))
  const savedSources = [
    { id: 's1', name: 'Work folder', providerType: 'fsa' },
    { id: 's2', name: 'Personal browser', providerType: 'local-storage' },
  ]
  await page.evaluate((sources) => {
    localStorage.setItem('fp-sources', JSON.stringify(sources))
    localStorage.setItem('fp-active-source', 's2')
  }, savedSources)

  await page.reload()
  await waitForBoard(page)

  await expect(page.locator('.source-notice')).toContainText('Work folder')
  await expect(page.locator('.source-notice')).toContainText('Switch sources in Settings')
  await expect(page.locator('tr[data-task-id="42"]')).toContainText('Personal source task')
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('fp-sources')))).toEqual(savedSources)
  expect(await page.evaluate(() => localStorage.getItem('fp-active-source'))).toBe('s2')

  await page.getByRole('button', { name: 'Dismiss storage source notice' }).click()
  await expect(page.locator('.source-notice')).toHaveCount(0)
  await page.reload()
  await waitForBoard(page)
  await expect(page.locator('.source-notice')).toHaveCount(0)
})

test('switching a saved storage source in Settings reloads the board from that choice', async ({ page }) => {
  await openPlanner(page)
  const savedSources = [
    { id: 's1', name: 'Work', providerType: 'local-storage' },
    { id: 's2', name: 'Personal', providerType: 'local-storage' },
  ]
  await page.evaluate((sources) => {
    localStorage.setItem('fp-sources', JSON.stringify(sources))
    localStorage.setItem('fp-active-source', 's1')
  }, savedSources)
  await page.reload()
  await waitForBoard(page)

  const dialog = await openSettings(page)
  await dialog.getByRole('button', { name: 'Use Personal' }).click()

  await waitForBoard(page)
  expect(await page.evaluate(() => localStorage.getItem('fp-active-source'))).toBe('s2')
  await expect(page.locator('.source-notice')).toContainText('Work')
})

test('failed active-source restore falls back without changing saved choices and offers reconnect', async ({ page }) => {
  await openPlanner(page)
  await writeFile(page, PLAN_FILE, planWith({
    today: ['| 73 | 🟡 | Browser fallback task | - | 2026-01-01 | |'],
  }))
  const sources = [{ id: 's1', name: 'Work folder', providerType: 'fsa' }]
  await page.evaluate((savedSources) => {
    localStorage.setItem('fp-sources', JSON.stringify(savedSources))
    localStorage.setItem('fp-active-source', 's1')
  }, sources)

  await page.reload()
  await waitForBoard(page)

  await expect(page.locator('tr[data-task-id="73"]')).toContainText('Browser fallback task')
  await expect(page.getByRole('button', { name: 'Reconnect Work folder' })).toBeVisible()
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('fp-sources')))).toEqual(sources)
  expect(await page.evaluate(() => localStorage.getItem('fp-active-source'))).toBe('s1')
})

test('canceling reconnect then switching sources leaves the selected source active after reload', async ({ page }) => {
  await page.addInitScript(() => {
    window.showDirectoryPicker = async () => { throw new DOMException('User cancelled', 'AbortError') }
  })
  await openPlanner(page)
  await writeFile(page, PLAN_FILE, planWith({
    today: ['| 73 | 🟡 | Keep browser source | - | 2026-01-01 | |'],
  }))
  const sources = [
    { id: 's1', name: 'Work folder', providerType: 'fsa' },
    { id: 's2', name: 'Personal browser', providerType: 'local-storage' },
  ]
  await page.evaluate((savedSources) => {
    localStorage.setItem('fp-sources', JSON.stringify(savedSources))
    localStorage.setItem('fp-active-source', 's1')
  }, sources)
  await page.reload()
  await waitForBoard(page)

  await page.getByRole('button', { name: 'Reconnect Work folder' }).click()
  await expect.poll(() => page.evaluate(() => localStorage.getItem('fp-pending-source'))).toBeNull()
  const dialog = await openSettings(page)
  await dialog.getByRole('button', { name: 'Use Personal browser' }).click()
  await waitForBoard(page)
  await page.reload()
  await waitForBoard(page)

  expect(await page.evaluate(() => localStorage.getItem('fp-active-source'))).toBe('s2')
  expect(await page.evaluate(() => localStorage.getItem('fp-pending-source'))).toBeNull()
  await expect(page.locator('tr[data-task-id="73"]')).toContainText('Keep browser source')
})

test('canceling a Settings OAuth source switch restores the previous folder in the error session', async ({ page }) => {
  await page.addInitScript(() => {
    const filesKey = 'e2e-fsa-files'
    const readFiles = () => JSON.parse(localStorage.getItem(filesKey) || '{}')
    const writeFiles = files => localStorage.setItem(filesKey, JSON.stringify(files))
    const makeFile = path => ({
      kind: 'file',
      async getFile() {
        const content = readFiles()[path] || ''
        return { text: async () => content }
      },
      async createWritable() {
        let content = ''
        return {
          write: async value => { content = value },
          close: async () => {
            const files = readFiles()
            files[path] = content
            writeFiles(files)
          },
        }
      },
    })
    const makeDirectory = (prefix = '') => ({
      kind: 'directory',
      name: 'Smoke folder',
      queryPermission: async () => 'granted',
      requestPermission: async () => 'granted',
      async getDirectoryHandle(name, { create = false } = {}) {
        const path = prefix ? `${prefix}/${name}` : name
        if (!create && !Object.keys(readFiles()).some(file => file.startsWith(`${path}/`))) {
          throw new DOMException('Directory not found', 'NotFoundError')
        }
        return makeDirectory(path)
      },
      async getFileHandle(name, { create = false } = {}) {
        const path = prefix ? `${prefix}/${name}` : name
        if (!create && !(path in readFiles())) throw new DOMException('File not found', 'NotFoundError')
        return makeFile(path)
      },
      async *entries() {
        const files = Object.keys(readFiles())
        const names = new Set()
        for (const file of files) {
          if (prefix && !file.startsWith(`${prefix}/`)) continue
          const remainder = prefix ? file.slice(prefix.length + 1) : file
          const name = remainder.split('/')[0]
          if (names.has(name)) continue
          names.add(name)
          yield [name, remainder.includes('/') ? makeDirectory(prefix ? `${prefix}/${name}` : name) : makeFile(prefix ? `${prefix}/${name}` : name)]
        }
      },
    })
    const directory = makeDirectory()
    window.showDirectoryPicker = async () => directory
    const nativeGet = IDBObjectStore.prototype.get
    const nativePut = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.get = function(key) {
      const request = nativeGet.call(this, key)
      if (this.transaction.db.name === 'keyval-store' && String(key).startsWith('focus-planner-dir-handle:')) {
        Object.defineProperty(request, 'result', { configurable: true, get: () => directory })
      }
      return request
    }
    IDBObjectStore.prototype.put = function(value, key) {
      if (this.transaction.db.name === 'keyval-store' && String(key).startsWith('focus-planner-dir-handle:')) {
        return nativePut.call(this, 'mock-folder-handle', key)
      }
      return nativePut.call(this, value, key)
    }
  })
  await openPlanner(page)
  const sources = [
    { id: 's1', name: 'Work folder', providerType: 'fsa' },
    { id: 's2', name: 'Work OneDrive', providerType: 'onedrive' },
  ]
  const folderPlan = planWith({
    today: ['| 74 | 🟡 | Restored folder task | - | 2026-01-01 | |'],
  })
  await page.evaluate(async ({ savedSources, content }) => {
    localStorage.setItem('fp-sources', JSON.stringify(savedSources))
    localStorage.setItem('fp-active-source', 's1')
    localStorage.setItem('e2e-fsa-files', JSON.stringify({
      'planner.md': content,
      'planner-completed.md': '# Completed Tasks\n',
    }))
    const request = indexedDB.open('keyval-store')
    request.onupgradeneeded = () => request.result.createObjectStore('keyval')
    await new Promise((resolve, reject) => {
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const tx = request.result.transaction('keyval', 'readwrite')
        tx.objectStore('keyval').put('mock-folder-handle', 'focus-planner-dir-handle:s1')
        tx.oncomplete = resolve
        tx.onerror = () => reject(tx.error)
      }
    })
  }, { savedSources: sources, content: folderPlan })
  await page.reload()
  await waitForBoard(page)
  const appOrigin = new URL(page.url()).origin
  await page.route('https://login.microsoftonline.com/**', route =>
    route.fulfill({ status: 200, contentType: 'text/html', body: 'Sign-in canceled' }),
  )

  const dialog = await openSettings(page)
  await dialog.getByRole('button', { name: 'Use Work OneDrive' }).click()
  await expect(page).toHaveURL(/login\.microsoftonline\.com/)

  await page.goto(`${appOrigin}/?error=access_denied`)
  await waitForBoard(page)

  expect(await page.evaluate(() => localStorage.getItem('fp-active-source'))).toBe('s1')
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('fp-sources')))).toEqual(sources)
  expect(await page.evaluate(() => localStorage.getItem('fp-pending-source'))).toBeNull()
  await expect(page.getByText('Restored folder task')).toBeVisible()
  await expect(page.getByRole('button', { name: /Reconnect/ })).toHaveCount(0)
})
