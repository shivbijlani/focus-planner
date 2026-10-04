import { test, expect } from '@playwright/test'
import { journalReadLoad, reviewPath } from '../packages/docs-core/src/index.js'
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
  await page.screenshot({ path: test.info().outputPath('docs-phone-board.png'), fullPage: true })
  await page.keyboard.press('Escape')
  await task.locator('.doc-action').click()
  await expect(page.locator('.dv-title')).toHaveText(SAMPLE_TITLE)
  await page.screenshot({ path: test.info().outputPath('docs-phone-reader.png'), fullPage: true })
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
