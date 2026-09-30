// Settings dialog, agent editors, and the storage providers offered today.
import { test, expect } from '@playwright/test'
import { openPlanner, waitForBoard, readFile } from './helpers.js'

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
