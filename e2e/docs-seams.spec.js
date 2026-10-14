import { test, expect } from '@playwright/test'
import { SAMPLE_TITLE } from './fixtures/docs-sample.js'

const a = { accountId: 'account-a', sourceId: 'source-a' }
const b = { accountId: 'account-b', sourceId: 'source-a' }
const c = { accountId: 'account-a', sourceId: 'source-b' }
const comment = (id) => ({
  id, anchor: { block: 'b2', quote: 'This seeded task', prefix: '', suffix: '', offset: 0 },
  intent: 'note', body: id,
})

test('embedded Docs does not reset the planner theme or global layout', async ({ page }) => {
  await page.goto('/e2e/fixtures/docs-host.html')
  await expect(page.locator('.dv-title')).toHaveText(SAMPLE_TITLE)
  const styles = await page.evaluate(() => ({
    margin: getComputedStyle(document.body).margin,
    background: getComputedStyle(document.body).backgroundColor,
    scheme: getComputedStyle(document.body).colorScheme,
    plannerScheme: getComputedStyle(document.querySelector('#planner-probe button')).colorScheme,
    docsScheme: getComputedStyle(document.querySelector('.docs-app')).colorScheme,
    docsBackground: getComputedStyle(document.querySelector('.dv-page')).backgroundColor,
    rootDx: getComputedStyle(document.documentElement).getPropertyValue('--dx-bg'),
  }))
  expect(styles).toEqual({
    margin: '17px', background: 'rgb(20, 21, 22)', scheme: 'dark', plannerScheme: 'dark',
    docsScheme: 'light', docsBackground: 'rgb(255, 255, 255)', rootDx: '',
  })
})

test('switching accounts and sources discards old in-memory drafts and restores only scoped persistence', async ({ page }) => {
  await page.goto('/e2e/fixtures/docs-host.html')
  await expect(page.locator('.dv-title')).toHaveText(SAMPLE_TITLE)
  await page.evaluate(({ scopes, comments }) => {
    for (let i = 0; i < scopes.length; i++) {
      localStorage.setItem(window.docsFixture.draftKey(window.docsFixture.docId, scopes[i]), JSON.stringify([comments[i]]))
    }
  }, { scopes: [a, b, c], comments: [comment('c_account_a'), comment('c_account_b'), comment('c_source_b')] })
  await page.reload()
  await expect(page.locator('.dv-sendbar')).toContainText('1 draft')
  await page.getByRole('button', { name: /Comments/ }).first().click()
  await expect(page.locator('.dx-comment-body')).toContainText('c_account_a')

  for (const [scope, current, previous] of [[b, 'c_account_b', 'c_account_a'], [c, 'c_source_b', 'c_account_b'], [a, 'c_account_a', 'c_source_b']]) {
    await page.evaluate((next) => window.docsFixture.setScope(next), scope)
    await expect(page.locator('.dv-title')).toHaveText(SAMPLE_TITLE)
    await expect(page.locator('.dx-comment-body')).toHaveCount(0)
    await page.getByRole('button', { name: /Comments/ }).first().click()
    await expect(page.locator('.dx-comment-body')).toContainText(current)
    await expect(page.locator('.docs-app')).not.toContainText(previous)
  }
})

test('unreadable drafts remain intact and failures are visible', async ({ page }) => {
  await page.goto('/e2e/fixtures/docs-host.html')
  await expect(page.locator('.dv-title')).toHaveText(SAMPLE_TITLE)
  await page.evaluate((scope) => {
    localStorage.setItem(window.docsFixture.draftKey(window.docsFixture.docId, scope), '{"broken":true}')
  }, a)
  await page.reload()
  await expect(page.getByRole('alert')).toContainText("Couldn't load Docs drafts")
  expect(await page.evaluate((scope) => localStorage.getItem(window.docsFixture.draftKey(window.docsFixture.docId, scope)), a))
    .toBe('{"broken":true}')
})

test('draft write failure is visible without losing the in-memory comment', async ({ page }) => {
  await page.goto('/e2e/fixtures/docs-host.html')
  await expect(page.locator('.dv-title')).toHaveText(SAMPLE_TITLE)
  await page.evaluate(({ scope, draft }) => {
    const fixture = window.docsFixture
    localStorage.setItem(fixture.draftKey(fixture.docId, scope), JSON.stringify([draft]))
    const setItem = Storage.prototype.setItem
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith('fp-docs-drafts:v2:')) throw new Error('Fixture quota exceeded')
      return setItem.call(this, key, value)
    }
    fixture.setScope(scope)
  }, { scope: b, draft: comment('c_kept_in_memory') })
  await expect(page.getByRole('alert')).toContainText("Couldn't save Docs drafts")
  await expect(page.locator('.dv-sendbar')).toContainText('1 draft')
})

test('synchronous managed boot failure renders an alert and never exposes the old document', async ({ page }) => {
  await page.goto('/e2e/fixtures/docs-host.html')
  await expect(page.locator('.dv-title')).toHaveText(SAMPLE_TITLE)
  await page.evaluate(() => window.docsFixture.setFail(true))
  await expect(page.getByRole('alert')).toContainText('Managed host boot refused')
  await expect(page.locator('.dv-title')).toHaveCount(0)
})
