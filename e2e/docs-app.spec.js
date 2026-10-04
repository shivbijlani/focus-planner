import { test, expect } from '@playwright/test'
import {
  emptyReview, journalReadLoad, reviewPath, serializeReview, submitDrafts, validateReviewText,
} from '../packages/docs-core/src/index.js'
import { planWith, readFile, removeFile, row, seedPlan, writeFile } from './helpers.js'
import {
  SAMPLE_DOC_FILES, SAMPLE_JOURNAL, SAMPLE_PRIMARY_ID, SAMPLE_TASK_ID, SAMPLE_TITLE,
} from './fixtures/docs-sample.js'

const taskRow = `| ${SAMPLE_TASK_ID} | 🟡 | Sample catch-up task | - | 2026-10-04 | |`

test('over-threshold sample opens its primary document and follows a linked document', async ({ page }) => {
  expect(journalReadLoad(SAMPLE_JOURNAL).reached).toBe(true)
  await seedPlan(page, planWith({ today: [taskRow] }), SAMPLE_DOC_FILES)

  const task = row(page, SAMPLE_TASK_ID)
  await expect(task.locator('.journal-link-note')).toBeVisible()
  await expect(task.locator('.journal-link-tg')).toBeVisible()
  const docLink = task.locator('.journal-link-doc')
  await expect(docLink).toBeVisible()
  await docLink.click()

  await expect(page).toHaveURL(new RegExp(`docs\\.html#\\/d\\/${SAMPLE_PRIMARY_ID}`))
  await expect(page.locator('.dv-title')).toHaveText(SAMPLE_TITLE)
  await expect(page.locator('#blk-b1')).toBeVisible()
  await expect(page.locator('.dv-page textarea, .dv-page [contenteditable="true"]')).toHaveCount(0)
  await page.locator('.dv-foot').scrollIntoViewIfNeeded()
  await expect.poll(async () => JSON.parse(await readFile(page, reviewPath(SAMPLE_PRIMARY_ID)) || '{}').readRev).toBe(1)
  await page.getByRole('link', { name: 'supporting sample notes' }).click()
  await expect(page.locator('.dv-title')).toHaveText('Supporting sample notes')
  await expect(page.locator('.dv-linked-from')).toContainText(SAMPLE_TITLE)
})

test('phone rail gives the primary doc priority and puts Telegram and Journal in task actions', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await seedPlan(page, planWith({ today: [taskRow] }), SAMPLE_DOC_FILES)

  const task = row(page, SAMPLE_TASK_ID)
  await expect(task.locator('.doc-action')).toBeVisible()
  await expect(task.locator('.journal-icons')).toHaveCount(0)
  await task.getByRole('button', { name: 'Task actions' }).click()
  const actions = page.getByRole('dialog', { name: 'Task actions' })
  await expect(actions.getByRole('button', { name: 'Open Telegram' })).toBeVisible()
  await expect(actions.getByRole('button', { name: 'Open journal' })).toBeVisible()
  const boardScreenshot = test.info().outputPath('docs-phone-board.png')
  await page.screenshot({ path: boardScreenshot, fullPage: true })
  await test.info().attach('Phone-width Docs task row', { path: boardScreenshot, contentType: 'image/png' })
  await page.keyboard.press('Escape')
  await task.locator('.doc-action').click()
  await expect(page.locator('.dv-title')).toHaveText(SAMPLE_TITLE)
  const readerScreenshot = test.info().outputPath('docs-phone-reader.png')
  await page.screenshot({ path: readerScreenshot, fullPage: true })
  await test.info().attach('Phone-width Docs reader', { path: readerScreenshot, contentType: 'image/png' })
})

test('mobile selection comments persist, send through the review merge, and reload', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await seedPlan(page, planWith({ today: [taskRow] }), SAMPLE_DOC_FILES)
  await row(page, SAMPLE_TASK_ID).locator('.doc-action').click()
  await expect(page.locator('.dv-title')).toHaveText(SAMPLE_TITLE)

  await page.locator('[data-block="b2"]').evaluate((body) => {
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT)
    let node
    while ((node = walker.nextNode())) {
      const start = node.data.indexOf('This seeded task')
      if (start < 0) continue
      const range = document.createRange()
      range.setStart(node, start)
      range.setEnd(node, start + 'This seeded task'.length)
      const selection = window.getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      return
    }
    throw new Error('The test quote was not found in the reader')
  })
  const pill = page.getByRole('toolbar', { name: 'Comment on selection' })
  await expect(pill).toBeVisible()
  await pill.getByRole('button').first().click()
  const sheet = page.getByRole('dialog', { name: 'Comment' })
  await sheet.locator('textarea').fill('Please explain this section.')
  await sheet.getByRole('button', { name: 'Save draft' }).click()
  await expect(page.locator('.dv-sendbar')).toContainText('1 draft')

  await page.reload()
  await expect(page.locator('.dv-title')).toHaveText(SAMPLE_TITLE)
  await expect(page.locator('.dv-sendbar')).toContainText('1 draft')

  const remote = submitDrafts(emptyReview(), [{
    id: 'c_remote',
    anchor: { block: 'b3', quote: 'This seeded task', prefix: '', suffix: '', offset: 0 },
    intent: 'note',
    body: 'Comment from another replica.',
  }], { rev: 1, now: 1_790_000_000_000 }).review
  await writeFile(page, reviewPath(SAMPLE_PRIMARY_ID), serializeReview(remote))
  await page.locator('.dv-sendbar').getByRole('button', { name: /Send to agent/ }).click()
  await expect(page.locator('.dv-sendbar')).toHaveCount(0)

  const saved = validateReviewText(await readFile(page, reviewPath(SAMPLE_PRIMARY_ID)))
  expect(Object.keys(saved.comments)).toHaveLength(2)
  expect(saved.comments.c_remote.body).toBe('Comment from another replica.')
  expect(Object.values(saved.comments).some((item) => item.body === 'Please explain this section.')).toBe(true)
  expect(await readFile(page, `docs/${SAMPLE_PRIMARY_ID}/doc.md`)).toBe(SAMPLE_DOC_FILES[`docs/${SAMPLE_PRIMARY_ID}/doc.md`])
  expect(await readFile(page, 'docs/index.json')).toBe(SAMPLE_DOC_FILES['docs/index.json'])
  expect(await readFile(page, `docs/${SAMPLE_PRIMARY_ID}/response.json`)).toBe(SAMPLE_DOC_FILES[`docs/${SAMPLE_PRIMARY_ID}/response.json`])

  await page.reload()
  await expect(page.locator('.dv-title')).toHaveText(SAMPLE_TITLE)
  await page.getByRole('button', { name: /Comments/ }).click()
  const panel = page.getByRole('dialog', { name: 'Comments' })
  await expect(panel).toContainText('Please explain this section.')
  await expect(panel).toContainText('Comment from another replica.')
})

test('mobile tap-hold opens a whole-paragraph comment fallback', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await seedPlan(page, planWith({ today: [taskRow] }), SAMPLE_DOC_FILES)
  await row(page, SAMPLE_TASK_ID).locator('.doc-action').click()
  await expect(page.locator('.dv-title')).toHaveText(SAMPLE_TITLE)
  const body = page.locator('[data-block="b2"]')
  await body.scrollIntoViewIfNeeded()
  const bounds = await body.boundingBox()
  await page.evaluate(() => window.getSelection()?.removeAllRanges())
  await body.dispatchEvent('pointerdown', {
    button: 0,
    clientX: bounds.x + bounds.width / 2,
    clientY: bounds.y + bounds.height / 2,
    pointerId: 1,
    pointerType: 'touch',
    isPrimary: true,
  })
  await page.waitForTimeout(700)
  await body.dispatchEvent('pointerup', { button: 0, pointerId: 1, pointerType: 'touch', isPrimary: true })
  const pill = page.getByRole('toolbar', { name: 'Comment on selection' })
  await expect(pill).toBeVisible()
  await expect(pill).toContainText('Comment on this paragraph')
  await pill.getByRole('button').first().click()
  await expect(page.getByRole('dialog', { name: 'Comment' }).locator('.dx-quote'))
    .toContainText('This seeded task has a long journal')
})

test('without docs/index.json the planner renders no Docs task links', async ({ page }) => {
  await seedPlan(page, planWith({ today: [taskRow] }), {
    [`journal/task-${SAMPLE_TASK_ID}.md`]: SAMPLE_JOURNAL,
  })
  const before = await row(page, SAMPLE_TASK_ID).innerHTML()
  await writeFile(page, 'docs/index.json', SAMPLE_DOC_FILES['docs/index.json'])
  await writeFile(page, `docs/${SAMPLE_PRIMARY_ID}/response.json`, SAMPLE_DOC_FILES[`docs/${SAMPLE_PRIMARY_ID}/response.json`])
  await page.reload()
  await expect(row(page, SAMPLE_TASK_ID).locator('.journal-link-doc')).toBeVisible()
  await removeFile(page, 'docs/index.json')
  await page.reload()
  await expect(row(page, SAMPLE_TASK_ID).locator('.journal-link-note')).toBeVisible()
  await expect(row(page, SAMPLE_TASK_ID).locator('.journal-link-doc')).toHaveCount(0)
  expect(await row(page, SAMPLE_TASK_ID).innerHTML()).toBe(before)
})
