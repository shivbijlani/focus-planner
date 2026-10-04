// Journal (chat thread), completion, deletion and persistence across reload.
import { test, expect } from '@playwright/test'
import {
  PLAN_FILE, COMPLETED_FILE, todayIso,
  openPlanner, waitForBoard, seedPlan, planWith, readFile, writeFile, listFiles,
  section, row, rowIds, expandSection, addTask, rowAction,
  parseSection, findRow,
} from './helpers.js'

const JOURNAL_1 = 'journal/task-1.md'

test('create a journal, post from the composer, and it renders as a "me" bubble', async ({ page }) => {
  await seedPlan(page, planWith({
    today: ['| 1 | 🟡 | Journaled task | - | 2026-01-01 | |'],
  }))

  await rowAction(page, '1', 'Create Journal')
  const view = page.locator('.journal-chat-view')
  await expect(view).toBeVisible()
  await expect(view.locator('.jc-appbar-title')).toHaveText('Task 1: Journaled task')
  expect(await readFile(page, JOURNAL_1)).toMatch(/^# Task 1: Journaled task/)

  const composer = view.getByPlaceholder(/Message yourself/)
  await composer.fill('Hello from the smoke suite')
  await composer.press('Enter')
  await expect(composer).toHaveValue('')
  await expect(view.locator('.jc-row.me .jc-bubble').last()).toContainText('Hello from the smoke suite')

  const journal = await readFile(page, JOURNAL_1)
  expect(journal).toContain(`## ${todayIso()}`)
  expect(journal).toContain('Hello from the smoke suite')

  // Back on the board, the row now carries the journal entry point.
  await view.getByRole('button', { name: 'Back to Focus Plan' }).click()
  await expect(row(page, '1').getByTitle('Open Journal')).toBeVisible()
})

test('unread star: new agent entries flag the journal until it is opened', async ({ page }) => {
  const initial = '# Task 1: Watched task\n\n## 2026-01-01\n\nFirst note\n'
  await seedPlan(page, planWith({
    today: ['| 1 | 🟡 | Watched task | - | 2026-01-01 | |'],
  }), { [JOURNAL_1]: initial })

  const star = () => row(page, '1').getByTitle('Open Journal').locator('.journal-badge-unread')
  const view = page.locator('.journal-chat-view')
  const openAndReturn = async () => {
    await row(page, '1').getByTitle('Open Journal').click()
    await expect(view).toBeVisible()
    await view.getByRole('button', { name: 'Back to Focus Plan' }).click()
    await waitForBoard(page)
  }

  // A journal that appeared after first run counts as new; opening it clears the star.
  await expect(star()).toBeVisible()
  await openAndReturn()
  await expect(star()).toHaveCount(0)

  // An external agent appends to the journal; the app flags it on next load.
  await writeFile(page, JOURNAL_1, `${initial}\n<!-- from: overnight-agent -->\nDid the thing.\n`)
  await page.reload()
  await waitForBoard(page)
  await expect(star()).toBeVisible()

  await row(page, '1').getByTitle('Open Journal').click()
  await expect(view.locator('.jc-agent-banner')).toContainText('overnight-agent')
  await expect(view.locator('.jc-row.agent .jc-bubble')).toContainText('Did the thing.')
  await view.getByRole('button', { name: 'Back to Focus Plan' }).click()
  await waitForBoard(page)
  await expect(star()).toHaveCount(0)
})

test('complete a task: it leaves the board and lands in the completed file', async ({ page }) => {
  await seedPlan(page, planWith({
    today: [
      '| 1 | 🟡 | Ship the feature | - | 2026-01-01 | |',
      '| 2 | ⚪ | Keep me | - | 2026-01-01 | |',
    ],
  }), { [JOURNAL_1]: '# Task 1: Ship the feature\n\n- TODO: write docs\n' })

  await rowAction(page, '1', 'Move to Completed')
  const dialog = page.locator('.closeout-dialog')
  await expect(dialog).toBeVisible()
  await dialog.locator('select').selectOption('Done by me')
  await dialog.locator('textarea').fill('Wrapped up cleanly')
  await dialog.getByRole('button', { name: 'Complete', exact: true }).click()
  await expect(dialog).toBeHidden()

  await expect(row(page, '1')).toHaveCount(0)
  await expect(row(page, '2')).toBeVisible()

  await expect.poll(() => readFile(page, COMPLETED_FILE)).toContain('Ship the feature - write docs · _Done by me_')
  const completed = await readFile(page, COMPLETED_FILE)
  expect(completed).toMatch(/## Week of \d+\/\d+\/\d{4}/)
  expect(completed).toMatch(new RegExp(`\\| 1 \\| ✅ \\| Ship the feature .*\\| ${todayIso()} \\|`))
  expect(findRow(parseSection(await readFile(page, PLAN_FILE), 'Today'), 1)).toBeUndefined()
  expect(await readFile(page, JOURNAL_1)).toContain('Wrapped up cleanly')

  // The completed board renders it.
  await page.getByRole('button', { name: /planner-completed\.md/ }).click()
  await expect(page.getByText('Ship the feature - write docs')).toBeVisible()
})

test('delete a task removes its row and its journal', async ({ page }) => {
  await seedPlan(page, planWith({
    today: [
      '| 1 | 🟡 | Delete me | - | 2026-01-01 | |',
      '| 2 | ⚪ | Survivor | - | 2026-01-01 | |',
    ],
  }), { [JOURNAL_1]: '# Task 1: Delete me\n\nnotes\n' })

  await expect(row(page, '1').getByTitle('Open Journal')).toBeVisible()
  await rowAction(page, '1', 'Delete Task')

  await expect(row(page, '1')).toHaveCount(0)
  await expect(row(page, '2')).toBeVisible()
  await expect.poll(() => listFiles(page)).not.toContain(JOURNAL_1)
  const plan = await readFile(page, PLAN_FILE)
  expect(findRow(parseSection(plan, 'Today'), 1)).toBeUndefined()
  expect(findRow(parseSection(plan, 'Today'), 2)).toBeDefined()
  expect(await readFile(page, COMPLETED_FILE)).not.toContain('Delete me')
})

test('state made through the UI persists across a reload', async ({ page }) => {
  await openPlanner(page)

  await addTask(page, 'Today', { task: 'Alpha', priority: '🟡' })
  await addTask(page, 'Today', { task: 'Bravo', priority: '⚪' })
  await addTask(page, 'Today', { task: 'Charlie', priority: '🔵' })
  await addTask(page, 'Deferred', { task: 'Delta', priority: '📖', linked: '1' })
  await expect(row(page, '4')).toHaveCount(1)

  // Priority change, promotion, defer, and a journal post.
  await row(page, '2').locator('.priority-icon-btn').click()
  await page.locator('.priority-dropdown-menu').getByRole('button', { name: /Urgent & Important/ }).click()
  await expect(row(page, '2').locator('.priority-icon-btn')).toHaveText('🔴')
  await rowAction(page, '1', 'Promote to Priority')
  await rowAction(page, '3', 'Defer')
  await rowAction(page, '1', 'Create Journal')
  const composer = page.getByPlaceholder(/Message yourself/)
  await composer.fill('Persisted note')
  await composer.press('Enter')
  await expect(page.locator('.jc-row.me .jc-bubble').last()).toContainText('Persisted note')
  await page.getByRole('button', { name: 'Back to Focus Plan' }).click()
  await waitForBoard(page)
  await expect.poll(() => rowIds(page, 'Today')).toEqual(['2', '1'])
  const before = await readFile(page, PLAN_FILE)

  await page.reload()
  await waitForBoard(page)

  // The board can paint before every row has settled after a reload, so the board-state checks
  // retry until they match (#826) -- the expected values are unchanged.
  expect(await readFile(page, PLAN_FILE)).toBe(before)
  await expect.poll(() => rowIds(page, 'Today')).toEqual(['2', '1'])
  await expect(row(page, '2').locator('.priority-icon-btn')).toHaveText('🔴')
  await expandSection(page, 'Deferred')
  await expect.poll(async () => (await rowIds(page, 'Deferred')).sort()).toEqual(['3', '4'])
  await expect(row(page, '4').locator('.linked-id-link')).toHaveText('1')
  await expandSection(page, 'Priorities')
  await expect(section(page, 'Priorities').locator('.priority-item')).toContainText(['Alpha'])

  await row(page, '1').getByTitle('Open Journal').click()
  await expect(page.locator('.jc-row.me .jc-bubble').last()).toContainText('Persisted note')
})
