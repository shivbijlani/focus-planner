// 🤖 agent session links on the board (docs/spec/Domain-agent-metadata.md, scenarios S1-S5).
// The per-device files are seeded straight into Browser Storage, exactly where the sync engine
// puts the files an agent PC publishes into the synced planner folder.
import { test, expect } from '@playwright/test'
import { seedPlan, planWith, row } from './helpers.js'
import { deviceKey, fingerprint } from '../src/agentMetadata/fingerprint.js'

const SID = '8864eba8-24dc-468a-a7c7-cb5efd2b6085'
const TITLE = 'Work GitHub issues'
const ADDED = '2026-09-02'
const PLAN = planWith({ today: [`| 468 | 🟡 | ${TITLE} | - | ${ADDED} | |`, '| 469 | 🟡 | Other task | - | 2026-09-02 | |'] })
const JOURNALS = {
  'journal/task-468.md': `# Task 468: ${TITLE}\n\n- notes\n`,
  'journal/task-469.md': '# Task 469: Other task\n\n- notes\n',
}

async function deviceFile(n, { fp, sessionId = SID } = {}) {
  const id = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
  const key = await deviceKey(id)
  const now = new Date().toISOString()
  const doc = {
    schema: 'fp-agent-task-metadata@1',
    device: { key, id, name: `PC-${n}` },
    planner: { board: 'planner.md' },
    revision: 1,
    publishedAt: now,
    lastSeenAt: now,
    heartbeatMinutes: 30,
    truncated: false,
    tasks: {
      468: {
        fingerprint: fp ?? await fingerprint('468', ADDED, TITLE),
        bindings: [{ source: 'copilot-app', sessionId, status: 'live', boundAt: now, verifiedAt: now, url: `ghapp://sessions/${sessionId}` }],
      },
    },
  }
  return { [`agent-metadata/${key}.json`]: JSON.stringify(doc, null, 2) }
}

test('S1: no agent-metadata folder -> the row looks exactly as before (no 🤖)', async ({ page }) => {
  await seedPlan(page, PLAN, JOURNALS)
  await expect(row(page, '468').locator('.journal-link-note')).toBeVisible()
  await expect(page.getByTestId('agent-session-link')).toHaveCount(0)
  await expect(page.getByTestId('agent-session-menu-button')).toHaveCount(0)
})

test('S2: one device file -> one 🤖 link on the bound row only, no device name', async ({ page }) => {
  await seedPlan(page, PLAN, { ...JOURNALS, ...(await deviceFile(1)) })
  const link = row(page, '468').getByTestId('agent-session-link')
  await expect(link).toHaveCount(1)
  await expect(link).toHaveAttribute('href', `ghapp://sessions/${SID}`)
  await expect(link).toHaveAttribute('target', '_blank')
  await expect(row(page, '468')).not.toContainText('PC-1')
  await expect(row(page, '469').getByTestId('agent-session-link')).toHaveCount(0)
  // the folder never appears in the sidebar file tree
  await expect(page.getByRole('button', { name: /agent-metadata/ })).toHaveCount(0)
})

test('S3: fingerprint mismatch (row edited since the bind) -> hidden', async ({ page }) => {
  const stale = await fingerprint('468', ADDED, 'Work GitLab issues')
  await seedPlan(page, PLAN, { ...JOURNALS, ...(await deviceFile(1, { fp: stale })) })
  await expect(row(page, '468').locator('.journal-link-note')).toBeVisible()
  await expect(page.getByTestId('agent-session-link')).toHaveCount(0)
})

test('S5: two device files -> one "🤖 2" menu listing the devices', async ({ page }) => {
  await seedPlan(page, PLAN, {
    ...JOURNALS,
    ...(await deviceFile(1)),
    ...(await deviceFile(2, { sessionId: 'second-session' })),
  })
  const button = row(page, '468').getByTestId('agent-session-menu-button')
  await expect(button).toHaveText('🤖 2')
  await button.click()
  const menu = row(page, '468').getByTestId('agent-session-menu')
  await expect(menu).toBeVisible()
  await expect(menu.getByTestId('agent-session-link')).toHaveCount(2)
  await expect(menu).toContainText('PC-1')
  await expect(menu).toContainText('PC-2')
  await expect(menu.locator('a[href="ghapp://sessions/second-session"]')).toHaveCount(1)
})
