import { test, expect } from '@playwright/test'
import { SAMPLE_TITLE } from './fixtures/docs-sample.js'
import { readFile } from './helpers.js'
import { reviewPath, validateReviewText } from '../packages/docs-core/src/index.js'

const a = { accountId: 'account-a', sourceId: 'source-a' }
const b = { accountId: 'account-b', sourceId: 'source-a' }
const c = { accountId: 'account-a', sourceId: 'source-b' }
const comment = (id) => ({
  id, anchor: { block: 'b2', quote: 'This seeded task', prefix: '', suffix: '', offset: 0 },
  intent: 'note', body: id,
})

async function tabTo(page, locator) {
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press('Tab')
    if (await locator.evaluate((el) => el === document.activeElement)) return
  }
  throw new Error(`Could not reach ${locator} with Tab`)
}

test('keyboard-only library to block comment, Save draft, and Send to agent persists review.json', async ({ page }) => {
  await page.addInitScript(() => {
    window.docsMouseEvents = []
    for (const type of ['mousedown', 'mouseup', 'click', 'contextmenu', 'pointerdown', 'pointerup']) {
      document.addEventListener(type, (e) => {
        if (e.pointerType || e.detail > 0) window.docsMouseEvents.push(type)
      }, true)
    }
  })
  await page.goto('/e2e/fixtures/docs-host.html')
  await expect(page.locator('.dv-title')).toHaveText(SAMPLE_TITLE)
  await tabTo(page, page.getByRole('button', { name: 'Back', exact: true }))
  await page.keyboard.press('Enter')
  await tabTo(page, page.getByRole('tab', { name: 'All', exact: true }))
  await page.keyboard.press('Enter')
  const card = page.getByRole('link').filter({ has: page.locator('.lib-card-title', { hasText: SAMPLE_TITLE }) })
  await tabTo(page, card)
  await page.keyboard.press('Enter')
  await expect(page.locator('.dv-title')).toHaveText(SAMPLE_TITLE)
  const first = page.locator('[data-block]').first()
  await tabTo(page, first)
  await page.keyboard.press('j')
  const current = page.locator('[data-block][tabindex="0"]')
  await expect(current).toBeFocused()
  const anchor = await current.evaluate((body) => ({ block: body.dataset.block, quote: body.textContent }))
  await page.keyboard.press('c')
  const sheet = page.getByRole('dialog', { name: 'Comment', exact: true })
  await expect(sheet.getByRole('textbox')).toBeFocused()
  await page.keyboard.type('Keyboard-only review comment.')
  await tabTo(page, sheet.getByRole('button', { name: 'Save draft' }))
  await page.keyboard.press('Enter')
  await expect(current).toBeFocused()
  const send = page.getByRole('button', { name: /Send to agent/ })
  await tabTo(page, send)
  await page.keyboard.press('Control+Enter')
  await expect(page.locator('.dv-sendbar')).toHaveCount(0)
  const docId = await page.evaluate(() => window.docsFixture.docId)
  const saved = validateReviewText(await readFile(page, reviewPath(docId)))
  expect(Object.values(saved.comments)).toHaveLength(1)
  expect(Object.values(saved.comments)[0]).toMatchObject({ anchor, body: 'Keyboard-only review comment.' })
  expect(await page.evaluate(() => window.docsMouseEvents)).toEqual([])
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

test('forward Tab reaches Send to agent after the doc content and task chips', async ({ page }) => {
  await page.goto('/e2e/fixtures/docs-host.html')
  await expect(page.locator('.dv-title')).toHaveText(SAMPLE_TITLE)
  await page.locator('[data-block]').first().focus()
  await page.keyboard.press('a')
  const send = page.getByRole('button', { name: /Send to agent/ })
  await expect(send).toBeVisible()
  const lastChip = page.locator('.dv-foot a.dx-trio-link').last()
  await lastChip.focus()
  await page.keyboard.press('Tab')
  await expect(send).toBeFocused()
})

test('task chips show the same keyboard focus ring as blocks', async ({ page }) => {
  await page.goto('/e2e/fixtures/docs-host.html')
  await expect(page.locator('.dv-title')).toHaveText(SAMPLE_TITLE)
  const chip = page.locator('.dv-page > .dx-trio a.dx-trio-link').first()
  await tabTo(page, chip)
  const ring = (el) => { const s = getComputedStyle(el); return { style: s.outlineStyle, width: s.outlineWidth, color: s.outlineColor } }
  const chipRing = await chip.evaluate(ring)
  expect(chipRing.style).toBe('solid')
  expect(chipRing.width).toBe('3px')
  const block = page.locator('[data-block]').first()
  await tabTo(page, block)
  expect(await block.evaluate(ring)).toEqual(chipRing)
})

test('send bar stays in the Docs pane and never covers the host sidebar footer', async ({ page }) => {
  await page.goto('/e2e/fixtures/docs-host-sidebar.html')
  await expect(page.locator('.dv-title')).toHaveText(SAMPLE_TITLE)
  await page.locator('[data-block]').first().focus()
  await page.keyboard.press('a')
  const bar = page.locator('.dv-sendbar')
  await expect(bar).toBeVisible()
  const pane = await page.locator('#root').boundingBox()
  const barBox = await bar.boundingBox()
  expect(barBox.x).toBeGreaterThanOrEqual(pane.x)
  expect(barBox.y + barBox.height).toBeLessThanOrEqual(pane.y + pane.height + 1)
  for (const id of ['host-tour', 'host-settings']) {
    const box = await page.locator(`#${id}`).boundingBox()
    const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.id, [box.x + box.width / 2, box.y + box.height / 2])
    expect(hit).toBe(id)
    await page.locator(`#${id}`).click({ trial: true })
  }
  await expect(bar).toBeInViewport()
})

test('comment sheet is fully opaque from its first frame', async ({ page }) => {
  await page.goto('/e2e/fixtures/docs-host.html')
  await expect(page.locator('.dv-title')).toHaveText(SAMPLE_TITLE)
  await page.locator('[data-block]').first().focus()
  await page.keyboard.press('c')
  const opacity = await page.locator('.dx-sheet').evaluate((el) => getComputedStyle(el).opacity)
  expect(opacity).toBe('1')
})
