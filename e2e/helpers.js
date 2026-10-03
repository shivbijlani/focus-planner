// Shared helpers for the app smoke suite. Everything runs against the
// browser-only IndexedDB provider ("Browser Storage"), so no OAuth or network.
import { expect } from '@playwright/test'
import { normalizeRowCells } from '../src/boardRow.js'

export const PLAN_FILE = 'planner.md'
export const COMPLETED_FILE = 'planner-completed.md'

/** Today's date as the app writes it for the Added column (UTC; tests run in UTC). */
export function todayIso() {
  return new Date().toISOString().split('T')[0]
}

export function addDaysIso(days) {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().split('T')[0]
}

/**
 * Wait until the board has rendered (storage restored, planner.md loaded). This is the app-ready
 * signal: the sections only render once the board file has been read. A cold boot right after a
 * navigation can take well over the default 10 s on a loaded machine (#826: the old document's
 * teardown waits on in-flight raster work), so the readiness wait gets its own allowance. It waits
 * for the same thing; it never relaxes what a test then asserts.
 */
export const BOOT_TIMEOUT = 60_000
export async function waitForBoard(page) {
  await expect(page.getByTestId('task-section-Today')).toBeVisible({ timeout: BOOT_TIMEOUT })
  await expect(page.getByTestId('task-section-Deferred')).toBeVisible({ timeout: BOOT_TIMEOUT })
}

/** Load the app into a fresh origin state and wait for the board. */
export async function openPlanner(page) {
  await page.goto('/')
  await waitForBoard(page)
}

function idbRequest(page, fn, arg) {
  return page.evaluate(([fnSrc, a]) => new Promise((resolve, reject) => {
    const open = indexedDB.open('focus-planner')
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const db = open.result
      const run = new Function('db', 'arg', 'resolve', 'reject', fnSrc)
      run(db, a, (v) => { db.close(); resolve(v) }, (e) => { db.close(); reject(e) })
    }
  }), [fn, arg])
}

/** Read a file straight from the IndexedDB provider's store (null if absent). */
export async function readFile(page, path) {
  return idbRequest(page, `
    const req = db.transaction('files', 'readonly').objectStore('files').get(arg)
    req.onsuccess = () => resolve(req.result ?? null)
    req.onerror = () => reject(req.error)
  `, path)
}

/** Write a file straight into the IndexedDB provider's store. */
export async function writeFile(page, path, content) {
  await idbRequest(page, `
    const tx = db.transaction('files', 'readwrite')
    tx.objectStore('files').put(arg[1], arg[0])
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  `, [path, content])
}

/** List every stored path. */
export async function listFiles(page) {
  return idbRequest(page, `
    const req = db.transaction('files', 'readonly').objectStore('files').getAllKeys()
    req.onsuccess = () => resolve(req.result.map(String))
    req.onerror = () => reject(req.error)
  `, null)
}

/** Build a planner.md with the scaffold's exact table shapes. */
export function planWith({ today = [], deferred = [], priorities = [] } = {}) {
  return [
    '## Today',
    '',
    '| ID | 🎯 | Task | Priority | Added | Linked ID |',
    '|---|---|------|----------|-------|-----------|',
    ...today,
    '',
    '## Deferred',
    '',
    '| ID | 🎯 | Task | Priority | Added | Wake | Linked ID |',
    '|---|---|------|----------|-------|------|-----------|',
    ...deferred,
    '',
    '## Priorities',
    '',
    ...priorities,
    '',
  ].join('\n')
}

/** Open the app, replace planner.md (and any extra files), and reload onto it. */
export async function seedPlan(page, content, extraFiles = {}) {
  await openPlanner(page)
  await writeFile(page, PLAN_FILE, content)
  for (const [p, c] of Object.entries(extraFiles)) await writeFile(page, p, c)
  await page.reload()
  await waitForBoard(page)
}

export function section(page, title) {
  return page.getByTestId(`task-section-${title}`)
}

export function row(page, id) {
  return page.locator(`tr[data-task-id="${id}"]`)
}

/** Task IDs in the order a section renders them. */
export async function rowIds(page, title) {
  return section(page, title).locator('tbody tr[data-task-id]').evaluateAll(
    (trs) => trs.map(tr => tr.getAttribute('data-task-id')),
  )
}

/** Expand a collapsed section (Deferred and Priorities start collapsed). */
export async function expandSection(page, title) {
  const icon = section(page, title).locator('h2.section-header .collapse-icon')
  if ((await icon.textContent()).trim() === '▶') {
    await section(page, title).locator('h2.section-header').click()
  }
  await expect(icon).toHaveText('▼')
}

/** Add a task through the section's "+" Add-Task form. */
export async function addTask(page, sectionTitle, { task, priority, linked }) {
  await section(page, sectionTitle).getByTitle(`Add task to ${sectionTitle}`).click()
  const dialog = page.getByTestId('add-task-dialog')
  await expect(dialog).toBeVisible()
  await dialog.locator('input[name="task-description"]').fill(task)
  if (priority) await dialog.getByTestId('add-task-priority').selectOption(priority)
  if (linked) await dialog.locator('input[name="linked-task"]').fill(linked)
  await dialog.getByRole('button', { name: 'Add Task' }).click()
  await expect(dialog).toBeHidden()
}

/** Open a row's action menu (right-click on desktop) and pick an action. */
export async function rowAction(page, id, label) {
  await row(page, id).locator('.task-text').click({ button: 'right' })
  const menu = page.locator('.context-menu')
  await expect(menu).toBeVisible()
  await menu.getByRole('button', { name: label }).click()
  await expect(menu).toBeHidden()
}

/**
 * Parse one section of planner.md into header-keyed rows, using the app's own
 * canonical row normalizer so a row reads the way the board reads it.
 */
export function parseSection(content, title) {
  const lines = String(content || '').split('\n')
  const start = lines.findIndex(l => l.trim() === `## ${title}`)
  if (start === -1) return []
  const out = []
  let headers = null
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i].trim()
    if (line.startsWith('## ')) break
    if (!line.startsWith('|')) continue
    const cells = line.split('|').slice(1, -1).map(c => c.trim())
    if (!headers) { headers = cells; continue }
    if (cells.every(c => /^[-:]+$/.test(c))) continue
    const norm = normalizeRowCells(cells, headers)
    const rowObj = { __raw: line }
    headers.forEach((h, idx) => { rowObj[h] = norm[idx] ?? '' })
    out.push(rowObj)
  }
  return out
}

/** Find a row by ID (leading number of the ID cell) in a parsed section. */
export function findRow(rows, id) {
  return rows.find(r => String(r.ID).match(/^(\d+)/)?.[1] === String(id))
}
