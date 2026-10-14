// Phone viewport: the board renders and the row actions sheet is reachable.
import { test, expect, devices } from '@playwright/test'
import { seedPlan, planWith, readFile, section, row, parseSection, findRow, PLAN_FILE } from './helpers.js'

const { defaultBrowserType: _ignored, ...phone } = devices['iPhone SE']
test.use({ ...phone, viewport: { width: 375, height: 667 } })

test('phone: board renders and the task actions sheet works', async ({ page }) => {
  await seedPlan(page, planWith({
    today: ['| 1 | 🟡 | Phone task | - | 2026-01-01 | |'],
  }))

  await expect(page.getByRole('button', { name: /Open Planner menu/ })).toBeVisible()
  await expect(section(page, 'Today')).toBeVisible()
  await expect(row(page, '1')).toContainText('Phone task')

  await row(page, '1').getByRole('button', { name: 'Task actions' }).click()
  const sheet = page.getByRole('dialog', { name: 'Task actions' })
  await expect(sheet).toBeVisible()
  await expect(sheet.getByRole('button', { name: /Move to Completed/ })).toBeVisible()
  await sheet.getByRole('button', { name: /Defer/ }).first().click()
  await expect(sheet).toBeHidden()

  await expect(section(page, 'Today').locator('tr[data-task-id="1"]')).toHaveCount(0)
  expect(findRow(parseSection(await readFile(page, PLAN_FILE), 'Deferred'), 1)).toMatchObject({ Task: 'Phone task' })
})
