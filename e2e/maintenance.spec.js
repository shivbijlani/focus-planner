import { test, expect } from '@playwright/test'
import { openPlanner, writeFile, readFile, waitForBoard, listFiles } from './helpers.js'

async function settings(page) {
  await page.getByRole('button', { name: /Settings/ }).first().click()
  return page.locator('.settings-dialog')
}

test('sidebar clutter toggle is reversible and cleanup requires a recovery download and confirmation', async ({ page }) => {
  await openPlanner(page)
  await writeFile(page, '.playwright-mcp/snapshot.md', '# Tool output')
  await writeFile(page, 'planner.md.bak-123', '# Old plan')
  await writeFile(page, 'journal/task-1.md', '# Keep this journal')
  await writeFile(page, 'sync-conflicts/journal/task-1.md.123.md', '# Keep this recovered version')
  await page.reload()
  await waitForBoard(page)
  await expect(page.locator('.sidebar-file-tree')).not.toContainText('.playwright-mcp')
  const dialog = await settings(page)
  await dialog.getByLabel('Show technical files in the sidebar').check()
  await expect(page.locator('.sidebar-file-tree')).toContainText('.playwright-mcp')
  await dialog.getByLabel('Show technical files in the sidebar').uncheck()
  await dialog.getByRole('button', { name: 'Review cleanup candidates' }).click()
  await expect(dialog.getByText('2 candidate files.', { exact: false })).toBeVisible()
  await dialog.getByRole('button', { name: 'Select all candidates' }).click()
  const remove = dialog.getByRole('button', { name: 'Delete selected files' })
  await expect(remove).toBeDisabled()
  const downloaded = page.waitForEvent('download')
  await dialog.getByRole('button', { name: 'Download selected files for recovery' }).click()
  const download = await downloaded
  const stream = await download.createReadStream()
  let text = ''
  for await (const chunk of stream) text += chunk.toString()
  expect(JSON.parse(text).files).toEqual({
    '.playwright-mcp/snapshot.md': '# Tool output',
    'planner.md.bak-123': '# Old plan',
  })
  page.once('dialog', dialog => dialog.dismiss())
  await remove.click()
  expect(await readFile(page, '.playwright-mcp/snapshot.md')).toBe('# Tool output')
  page.once('dialog', dialog => dialog.accept())
  await remove.click()
  await expect.poll(() => readFile(page, '.playwright-mcp/snapshot.md')).toBeNull()
  expect(await readFile(page, 'planner.md.bak-123')).toBeNull()
  expect(await readFile(page, 'journal/task-1.md')).toBe('# Keep this journal')
  expect(await readFile(page, 'sync-conflicts/journal/task-1.md.123.md')).toBe('# Keep this recovered version')
})

test('reset refuses other tabs, then clears browser files and sign-in state without remote deletion', async ({ page, context }) => {
  await openPlanner(page)
  await writeFile(page, 'journal/task-1.md', '# Unsynced journal')
  const other = await context.newPage()
  await openPlanner(other)
  const dialog = await settings(page)
  page.once('dialog', dialog => dialog.dismiss())
  await dialog.getByRole('button', { name: 'Reset & sign out' }).click()
  await expect(dialog).toBeVisible()
  expect(await readFile(page, 'journal/task-1.md')).toBe('# Unsynced journal')
  page.once('dialog', dialog => dialog.accept())
  await dialog.getByRole('button', { name: 'Reset & sign out' }).click()
  await expect(page.getByRole('status')).toContainText('Close other Planner')
  const reset = page.getByRole('button', { name: 'Retry reset' })
  expect(await readFile(page, 'journal/task-1.md')).toBe('# Unsynced journal')
  await other.close()
  await page.evaluate(async () => {
    localStorage.setItem('folder-sync:intended-providers', '["onedrive","google-drive"]')
    localStorage.setItem('gd_token', 'test-legacy-token')
    sessionStorage.setItem('google-drive_state', 'test-oauth-state')
    await new Promise((resolve, reject) => {
      const request = indexedDB.open('folder-sync')
      request.onsuccess = () => {
        const db = request.result
        const tx = db.transaction('tokens', 'readwrite')
        tx.objectStore('tokens').put({ accessToken: 'test-token', expiresAt: Date.now() + 3600000 }, 'onedrive')
        tx.oncomplete = () => { db.close(); resolve() }
        tx.onerror = () => { db.close(); reject(tx.error) }
      }
      request.onerror = () => reject(request.error)
    })
  })
  const remoteRequests = []
  page.on('request', request => {
    if (/graph.microsoft.com|googleapis.com/.test(request.url())) remoteRequests.push(request.method())
  })
  page.once('dialog', dialog => dialog.accept())
  await reset.click()
  await waitForBoard(page)
  expect(await listFiles(page)).not.toContain('journal/task-1.md')
  expect(await page.evaluate(() => ({
    intended: localStorage.getItem('folder-sync:intended-providers'),
    legacy: localStorage.getItem('gd_token'),
    state: sessionStorage.getItem('google-drive_state'),
    marker: localStorage.getItem('planner.reset-in-progress'),
  }))).toEqual({ intended: null, legacy: null, state: null, marker: null })
  const current = await settings(page)
  await expect(current.locator('.sync-target-card', { hasText: 'OneDrive' })).toContainText('Not backed up')
  await expect(current.locator('.sync-target-card', { hasText: 'Google Drive' })).toContainText('Not backed up')
  expect(remoteRequests).toEqual([])
})

test('reset works when legacy files have filled the real browser localStorage quota', async ({ page }) => {
  await openPlanner(page)
  await writeFile(page, 'journal/task-9.md', '# Local journal')
  const dialog = await settings(page)
  const error = await page.evaluate(() => {
    const key = 'fp-file:legacy.md'
    const used = Object.keys(localStorage).reduce((sum, k) => sum + k.length + localStorage.getItem(k).length, 0)
    localStorage.setItem(key, 'x'.repeat(5 * 1024 * 1024 - used - key.length - 8))
    try { localStorage.setItem('planner.reset-in-progress', '1'); return null }
    catch (error) { return error.name }
  })
  expect(error).toBe('QuotaExceededError')
  const resetPageLoaded = page.waitForRequest(request => request.isNavigationRequest() && request.url().endsWith('/reset.html'))
  const returnedToPlanner = page.waitForEvent('framenavigated', frame => frame === page.mainFrame() && new URL(frame.url()).pathname === '/')
  page.once('dialog', dialog => dialog.accept())
  await dialog.getByRole('button', { name: 'Reset & sign out' }).click()
  await resetPageLoaded
  await returnedToPlanner
  await waitForBoard(page)
  expect(await readFile(page, 'journal/task-9.md')).toBeNull()
  expect(await page.evaluate(() => localStorage.getItem('fp-file:legacy.md'))).toBeNull()
})
