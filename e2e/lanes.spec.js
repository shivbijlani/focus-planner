// Lanes on the board and in Settings (docs/spec/Domain-lanes.md, app scenarios A1-A10).
// A single-PC user (A1, A2) sees nothing new: no Devices & lanes section, no chips, no row-menu
// item, and `#lane:` text in a title shown exactly as typed.
import { test, expect } from '@playwright/test'
import { seedPlan, planWith, row, readFile, listFiles } from './helpers.js'
import { deviceKey } from '../src/agentMetadata/fingerprint.js'

const PLAN = planWith({
  today: [
    '| 20 | 🟡 | Home errand #lane:home | - | 2026-09-01 | |',
    '| 21 | 🟡 | Untagged | - | 2026-09-01 | |',
    '| 24 | 🟡 | Two lanes #lane:home #lane:ado | - | 2026-09-01 | |',
    '| 35 | 🟡 | Cloud job #lane:cloud | - | 2026-09-01 | |',
  ],
})

async function device(n, { name = `PC-${n}`, minutesAgo = 1 } = {}) {
  const id = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
  const key = await deviceKey(id)
  const seen = new Date(Date.now() - minutesAgo * 60000).toISOString()
  const doc = {
    schema: 'fp-agent-task-metadata@1', device: { key, id, name }, planner: { board: 'planner.md' },
    revision: 1, publishedAt: seen, lastSeenAt: seen, heartbeatMinutes: 30, truncated: false, tasks: {},
  }
  return { key, files: { [`agent-metadata/${key}.json`]: JSON.stringify(doc, null, 2) } }
}

function lanesFile(devices, tasks = {}) {
  return { 'agent-lanes.json': `${JSON.stringify({ schema: 'fp-agent-lanes@1', revision: 1, devices, tasks }, null, 2)}\n` }
}

async function openSettings(page) {
  await page.getByRole('button', { name: /Settings/ }).first().click()
  const dialog = page.locator('.settings-dialog')
  await expect(dialog).toBeVisible()
  return dialog
}

async function expectNoLaneMenu(page, id) {
  await row(page, id).locator('.task-text').click({ button: 'right' })
  const menu = page.locator('.context-menu')
  await expect(menu).toBeVisible()
  await expect(menu.getByRole('button', { name: /Lane…/ })).toHaveCount(0)
  await page.keyboard.press('Escape')
}

test('A1: no agents, no lanes file -> nothing new anywhere; #lane: text shown as typed', async ({ page }) => {
  await seedPlan(page, PLAN)
  await expect(row(page, '20')).toContainText('Home errand #lane:home')
  await expect(page.getByTestId('lane-chip')).toHaveCount(0)
  await expect(page.getByTestId('lanes-banner')).toHaveCount(0)
  await expectNoLaneMenu(page, '20')
  const dialog = await openSettings(page)
  await expect(dialog.getByTestId('lanes-settings')).toHaveCount(0)
})

test('A2: one PC announced, no lanes file -> still nothing new', async ({ page }) => {
  const one = await device(1)
  await seedPlan(page, PLAN, one.files)
  await expect(row(page, '20')).toContainText('Home errand #lane:home')
  await expect(page.getByTestId('lane-chip')).toHaveCount(0)
  const dialog = await openSettings(page)
  await expect(dialog).toContainText('Mission')
  await expect(dialog.getByTestId('lanes-settings')).toHaveCount(0)
})

test('A3: two PCs announced, no lanes file -> Devices & lanes offered; no chips, no row-menu item', async ({ page }) => {
  const a = await device(1, { name: 'WORK-LAPTOP' })
  const b = await device(2, { name: 'HOME-DESKTOP' })
  await seedPlan(page, PLAN, { ...a.files, ...b.files })
  await expect(page.getByTestId('lane-chip')).toHaveCount(0)
  await expectNoLaneMenu(page, '20')
  const dialog = await openSettings(page)
  const panel = dialog.getByTestId('lanes-settings')
  await expect(panel).toBeVisible()
  await expect(panel.getByTestId('lanes-device')).toHaveCount(2)
  await expect(panel).toContainText('WORK-LAPTOP')
  await expect(panel).toContainText('HOME-DESKTOP')
  // Both unassigned PCs are catch-all, and both are fresh: the overlap is called out (A9).
  await expect(panel.getByTestId('lanes-catchall-warning')).toBeVisible()
})

test('A4/A6/A7: lanes set up -> served, waiting and conflict chips; untagged rows show none', async ({ page }) => {
  const a = await device(1, { name: 'HOME-DESKTOP' })
  await seedPlan(page, PLAN, { ...a.files, ...lanesFile({ [a.key]: { name: 'HOME-DESKTOP', lanes: ['home'], catchAll: true } }) })
  await expect(row(page, '20').getByTestId('lane-chip')).toHaveText('home')
  await expect(row(page, '21').getByTestId('lane-chip')).toHaveCount(0)
  await expect(row(page, '35').getByTestId('lane-chip')).toHaveText('⏳ cloud')
  await expect(row(page, '35').getByTestId('lane-chip')).toHaveAttribute('title', /No PC serves lane cloud/)
  await expect(row(page, '24').getByTestId('lane-chip')).toHaveText('⚠ lane')
  await expect(row(page, '24').getByTestId('lane-chip')).toHaveAttribute('title', /Conflicting lanes \(ado, home\)/)
})

test('A5: the only PC serving a lane is stale -> waiting, naming it', async ({ page }) => {
  const a = await device(1, { name: 'HOME-DESKTOP', minutesAgo: 600 })
  await seedPlan(page, PLAN, { ...a.files, ...lanesFile({ [a.key]: { name: 'HOME-DESKTOP', lanes: ['home'], catchAll: false } }) })
  const chip = row(page, '20').getByTestId('lane-chip')
  await expect(chip).toHaveText('⏳ home')
  await expect(chip).toHaveAttribute('title', /Waiting for a PC that serves lane home — HOME-DESKTOP, last seen/)
})

test('A8: a broken lanes file -> banner, no chips', async ({ page }) => {
  const a = await device(1)
  await seedPlan(page, PLAN, { ...a.files, 'agent-lanes.json': 'not json' })
  await expect(page.getByTestId('lanes-banner')).toBeVisible()
  await expect(page.getByTestId('lanes-banner')).toContainText('not_json')
  await expect(page.getByTestId('lane-chip')).toHaveCount(0)
})

test('A10: assigning a lane in the panel rewrites agent-lanes.json and nothing in agent-metadata/', async ({ page }) => {
  const a = await device(1, { name: 'WORK-LAPTOP' })
  const b = await device(2, { name: 'HOME-DESKTOP' })
  await seedPlan(page, PLAN, { ...a.files, ...b.files, ...lanesFile({}) })
  const before = { a: await readFile(page, `agent-metadata/${a.key}.json`), b: await readFile(page, `agent-metadata/${b.key}.json`) }
  const dialog = await openSettings(page)
  const laptop = dialog.getByTestId('lanes-device').filter({ hasText: 'WORK-LAPTOP' })
  await laptop.getByRole('textbox', { name: 'Lane name' }).fill('ado')
  await laptop.getByRole('button', { name: 'Add' }).click()
  await expect(laptop.locator('.lane-chip')).toHaveText(/ado/)
  const doc = JSON.parse(await readFile(page, 'agent-lanes.json'))
  expect(doc.schema).toBe('fp-agent-lanes@1')
  expect(doc.revision).toBe(2)
  expect(doc.devices[a.key]).toEqual({ name: 'WORK-LAPTOP', lanes: ['ado'], catchAll: false })
  expect(await readFile(page, `agent-metadata/${a.key}.json`)).toBe(before.a)
  expect(await readFile(page, `agent-metadata/${b.key}.json`)).toBe(before.b)
  expect((await listFiles(page)).filter((p) => p.startsWith('agent-metadata/'))).toHaveLength(2)
})

test('row menu Lane… assigns the task in agent-lanes.json; a tagged row defers to its title', async ({ page }) => {
  const a = await device(1, { name: 'HOME-DESKTOP' })
  await seedPlan(page, PLAN, { ...a.files, ...lanesFile({ [a.key]: { name: 'HOME-DESKTOP', lanes: ['home'], catchAll: true } }) })
  await row(page, '21').locator('.task-text').click({ button: 'right' })
  await page.locator('.context-menu').getByRole('button', { name: /Lane…/ }).click()
  const picker = page.getByTestId('lane-picker')
  await expect(picker).toBeVisible()
  await picker.getByRole('button', { name: 'home', exact: true }).click()
  await expect(picker).toBeHidden()
  expect(JSON.parse(await readFile(page, 'agent-lanes.json')).tasks).toEqual({ 21: 'home' })
  await expect(row(page, '21').getByTestId('lane-chip')).toHaveText('home')

  await row(page, '20').locator('.task-text').click({ button: 'right' })
  await page.locator('.context-menu').getByRole('button', { name: /Lane…/ }).click()
  await expect(page.getByTestId('lane-picker')).toContainText('#lane:home')
  await expect(page.getByTestId('lane-picker').getByRole('button', { name: 'home', exact: true })).toHaveCount(0)
})
