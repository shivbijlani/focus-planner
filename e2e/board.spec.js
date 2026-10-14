// Mainline board flows: first run, add, priority, move, snooze, search, links.
import { test, expect } from '@playwright/test'
import {
  PLAN_FILE, COMPLETED_FILE, todayIso, addDaysIso,
  openPlanner, seedPlan, planWith, readFile, listFiles,
  section, row, rowIds, expandSection, addTask, rowAction,
  parseSection, findRow,
} from './helpers.js'

test('first run bootstraps Browser Storage, scaffolds files and renders the board', async ({ page }) => {
  await openPlanner(page)

  // No chooser on first run: the app auto-selects the browser-only provider.
  const savedSource = await page.evaluate(() => ({
    active: localStorage.getItem('fp-active-source'),
    sources: JSON.parse(localStorage.getItem('fp-sources') || '[]'),
  }))
  expect(savedSource.sources).toHaveLength(1)
  expect(savedSource.sources[0].providerType).toBe('local-storage')
  expect(savedSource.active).toBe(savedSource.sources[0].id)

  const files = await listFiles(page)
  expect(files).toEqual(expect.arrayContaining([PLAN_FILE, COMPLETED_FILE, 'AGENTS.md', 'agent-gate.md']))
  const plan = await readFile(page, PLAN_FILE)
  expect(plan).toContain('## Today')
  expect(plan).toContain('## Deferred')
  expect(plan).toContain('## Priorities')
  expect(await readFile(page, COMPLETED_FILE)).toContain('# Completed Tasks')

  await expect(section(page, 'Today')).toBeVisible()
  await expect(section(page, 'Deferred')).toBeVisible()
  await expect(section(page, 'Priorities')).toBeVisible()
  await expect(page.getByRole('button', { name: /planner\.md/ })).toBeVisible()
})

test('Add-Task form adds a task to Today with the next ID and chosen priority', async ({ page }) => {
  await seedPlan(page, planWith({
    today: ['| 7 | 🟡 | Existing task | - | 2026-01-01 | |'],
  }))

  await addTask(page, 'Today', { task: 'Write smoke tests', priority: '🔴' })

  const added = row(page, '8')
  await expect(added).toBeVisible()
  await expect(added).toContainText('Write smoke tests')
  await expect(added.locator('.priority-icon-btn')).toHaveText('🔴')
  await expect(section(page, 'Today').locator('tr[data-task-id="8"]')).toHaveCount(1)

  const today = parseSection(await readFile(page, PLAN_FILE), 'Today')
  const r = findRow(today, 8)
  expect(r).toMatchObject({ '🎯': '🔴', Task: 'Write smoke tests', Added: todayIso() })
})

test('changing a priority icon re-sorts Today, and Priorities outrank icons', async ({ page }) => {
  await seedPlan(page, planWith({
    today: [
      '| 1 | ⚪ | Low task | - | 2026-01-01 | |',
      '| 2 | 🟡 | Important task | - | 2026-01-01 | |',
      '| 3 | 🔴 | Urgent task | - | 2026-01-01 | |',
    ],
  }))
  expect(await rowIds(page, 'Today')).toEqual(['3', '2', '1'])

  // 🐸 (frog) sorts above 🟡 among non-urgent tasks.
  await row(page, '1').locator('.priority-icon-btn').click()
  await page.locator('.priority-dropdown-menu').getByRole('button', { name: /Frog/ }).click()
  await expect(row(page, '1').locator('.priority-icon-btn')).toHaveText('🐸')
  await expect.poll(() => rowIds(page, 'Today')).toEqual(['3', '1', '2'])
  expect(findRow(parseSection(await readFile(page, PLAN_FILE), 'Today'), 1)['🎯']).toBe('🐸')

  // A task on the Priorities list outranks the icon order (urgent still first).
  await rowAction(page, '2', 'Promote to Priority')
  await expect.poll(() => rowIds(page, 'Today')).toEqual(['3', '2', '1'])
  expect(await readFile(page, PLAN_FILE)).toMatch(/## Priorities\s*\n+1\. 2\b/)
})

test('move a task Today -> Deferred and back', async ({ page }) => {
  await seedPlan(page, planWith({
    today: ['| 1 | 🟡 | Movable task | - | 2026-01-01 | |'],
  }))

  await rowAction(page, '1', 'Defer')
  await expect(section(page, 'Today').locator('tr[data-task-id="1"]')).toHaveCount(0)
  await expandSection(page, 'Deferred')
  await expect(section(page, 'Deferred').locator('tr[data-task-id="1"]')).toBeVisible()
  let plan = await readFile(page, PLAN_FILE)
  expect(findRow(parseSection(plan, 'Today'), 1)).toBeUndefined()
  expect(findRow(parseSection(plan, 'Deferred'), 1)).toMatchObject({ Task: 'Movable task', Wake: '' })

  await rowAction(page, '1', 'Move to Today')
  await expect(section(page, 'Today').locator('tr[data-task-id="1"]')).toBeVisible()
  await expect(section(page, 'Deferred').locator('tr[data-task-id="1"]')).toHaveCount(0)
  plan = await readFile(page, PLAN_FILE)
  expect(findRow(parseSection(plan, 'Today'), 1)).toMatchObject({ Task: 'Movable task' })
  expect(findRow(parseSection(plan, 'Deferred'), 1)).toBeUndefined()
})

test('adding straight to Deferred keeps Linked ID and Wake in their own columns (#426/#642)', async ({ page }) => {
  await seedPlan(page, planWith({
    today: ['| 1 | 🟡 | Parent task | - | 2026-01-01 | |'],
  }))

  await addTask(page, 'Deferred', { task: 'Deferred child', priority: '⚪', linked: '1' })
  // The add is written after the dialog closes; the app then reveals the new row itself (#268) by
  // expanding the collapsed section. Wait for that before touching the header (#826).
  const child = section(page, 'Deferred').locator('tr[data-task-id="2"]')
  await expect(child).toBeVisible()
  await expandSection(page, 'Deferred')

  await expect(child).toBeVisible()
  await expect(child.locator('.linked-id-link')).toHaveText('1')
  await expect(child.locator('.snooze-badge')).toHaveCount(0)

  const deferred = parseSection(await readFile(page, PLAN_FILE), 'Deferred')
  expect(findRow(deferred, 2)).toMatchObject({ Task: 'Deferred child', 'Linked ID': '1', Wake: '' })
})

test('snooze a task until a wake date, and a past wake date returns it to Today', async ({ page }) => {
  const wake = addDaysIso(10)
  await seedPlan(page, planWith({
    today: ['| 1 | 🟡 | Snooze me | - | 2026-01-01 | |'],
    deferred: [`| 2 | 🟡 | Wakes today | - | 2026-01-01 | ${addDaysIso(-1)} | |`],
  }))

  // The overdue wake date was applied on load: task 2 is back in Today.
  await expect(section(page, 'Today').locator('tr[data-task-id="2"]')).toBeVisible()

  await rowAction(page, '1', 'Snooze…')
  const dialog = page.locator('.snooze-picker-dialog')
  await expect(dialog).toBeVisible()
  await dialog.locator('input[type="date"]').fill(wake)
  await dialog.getByRole('button', { name: 'Snooze', exact: true }).click()
  await expect(dialog).toBeHidden()

  await expect(section(page, 'Today').locator('tr[data-task-id="1"]')).toHaveCount(0)
  await expandSection(page, 'Deferred')
  const snoozed = section(page, 'Deferred').locator('tr[data-task-id="1"]')
  await expect(snoozed.locator('.snooze-badge')).toContainText('Snoozed until')

  const plan = await readFile(page, PLAN_FILE)
  expect(findRow(parseSection(plan, 'Deferred'), 1)).toMatchObject({ Task: 'Snooze me', Wake: wake })
  expect(findRow(parseSection(plan, 'Today'), 2)).toMatchObject({ Task: 'Wakes today' })
})

test('search filters the board and clearing restores it', async ({ page }) => {
  await seedPlan(page, planWith({
    today: [
      '| 1 | 🟡 | Buy groceries | - | 2026-01-01 | |',
      '| 2 | 🟡 | Call the plumber | - | 2026-01-01 | |',
    ],
    deferred: ['| 3 | ⚪ | Plan groceries budget | - | 2026-01-01 | | |'],
  }))

  const search = page.getByRole('textbox', { name: 'Search tasks' }).first()
  await search.fill('groceries')
  await expect(row(page, '1')).toBeVisible()
  await expect(row(page, '3')).toBeVisible() // search force-opens collapsed Deferred
  await expect(row(page, '2')).toHaveCount(0)

  await search.fill('zzz-no-such-task')
  await expect(section(page, 'Today')).toContainText('No matches in Today')

  await page.getByRole('button', { name: 'Clear search' }).first().click()
  await expect(row(page, '1')).toBeVisible()
  await expect(row(page, '2')).toBeVisible()
  await expect(search).toHaveValue('')
})

test('a linked child shows under its parent and links navigate between them', async ({ page }) => {
  // Filler rows push Deferred below the fold so the jumps have to scroll.
  const filler = Array.from({ length: 30 }, (_, i) => `| ${10 + i} | ⚪ | Filler ${10 + i} | - | 2026-01-01 | |`)
  await seedPlan(page, planWith({
    today: ['| 2 | 🟡 | Child step | - | 2026-01-01 | 1 |', ...filler],
    deferred: ['| 1 | 🟡 | Parent goal | - | 2026-01-01 | | |'],
  }))

  // Child -> parent: the Linked ID jumps to the parent, expanding Deferred.
  const child = row(page, '2')
  await expect(child.locator('.linked-id-link')).toHaveText('1')
  await child.locator('.linked-id-link').click()
  const parent = section(page, 'Deferred').locator('tr[data-task-id="1"]')
  await expect(parent).toBeVisible()
  await expect(parent).toBeInViewport()

  // Parent lists the child as lead-up work; clicking it jumps back to the child.
  const preview = parent.locator('.todo-preview')
  await expect(preview).toContainText('Child step')
  await preview.click()
  const leadUp = page.locator('.lead-up-task-item', { hasText: 'Child step' })
  await expect(leadUp).toBeVisible()
  await leadUp.click()
  await expect(child).toBeInViewport()
  await expect(parent).not.toBeInViewport()
})
