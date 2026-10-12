import fs from 'node:fs/promises'
import path from 'node:path'
import { test, expect } from '@playwright/test'
import { createAgentFixture, fixtureFiles, runReviewAgent } from './fixtures/docs-agent-runner.js'
import { readFile, row, seedPlan, writeFile } from './helpers.js'

test('native Docs submitted primary and linked comments drive two real unattended agent revisions', async ({ page }) => {
  test.skip(process.env.DOCS_AGENT_ACCEPTANCE !== '1', 'Explicit opt-in: invokes real Copilot agents with synthetic isolated data.')
  test.setTimeout(20 * 60 * 1000)
  page.setDefaultTimeout(15000)
  const fixture = await createAgentFixture()
  const initial = await fixtureFiles(fixture)
  await seedPlan(page, initial['planner.md'], initial)
  const unchanged = ['planner.md', 'planner-completed.md', 'agent-gate.md', 'journal/task-9450-briefing.md']
  const evidence = { fixture: { buildSha: fixture.buildSha, fixtureRoot: fixture.root, primary: fixture.primary, supporting: fixture.supporting }, cycles: [] }
  await row(page, 9450).locator('.journal-link-doc').click()
  await expect(page.locator('.dv-title')).toHaveText('Task 9450: Synthetic delivery')

  for (const [cycle, id, quote, request, expected] of [
    [1, fixture.primary, 'The delivery date is Friday.', 'Change the delivery date to Monday in the status and delivery paragraph. Preserve the supporting notes link and the other sections.', 'The delivery date is Monday.'],
    [2, fixture.supporting, 'The parcel weighs 2 kg.', 'Change the parcel weight to exactly 3 kg. Preserve the document title and disposition this comment in the supporting document.', 'The parcel weighs 3 kg.'],
  ]) {
    if (cycle === 2) await page.getByRole('link', { name: 'supporting notes' }).click()
    const block = page.locator('[data-block]').filter({ hasText: quote }).first()
    await block.evaluate((element, text) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
      let node
      while ((node = walker.nextNode())) {
        const start = node.data.indexOf(text)
        if (start < 0) continue
        const selection = window.getSelection()
        const range = document.createRange()
        range.setStart(node, start)
        range.setEnd(node, start + text.length)
        selection.removeAllRanges()
        selection.addRange(range)
        return
      }
      throw new Error('Requested quote was not found')
    }, quote)
    const pill = page.getByRole('toolbar', { name: 'Comment on selection' })
    await expect(pill).toBeVisible()
    await pill.getByRole('button').first().click()
    const sheet = page.getByRole('dialog', { name: 'Comment' })
    await sheet.locator('textarea').fill(request)
    await sheet.getByRole('button', { name: 'Save draft' }).click()
    await page.locator('.dv-sendbar').getByRole('button', { name: /Send to agent/ }).click()
    await expect(page.locator('.dv-sendbar')).toHaveCount(0)
    const reviewPath = `docs/${id}/review.json`
    const reviewText = await readFile(page, reviewPath)
    const submitted = JSON.parse(reviewText)
    const commentId = Object.entries(submitted.comments).find(([, comment]) => comment.body === request)[0]
    await fs.writeFile(path.join(fixture.planner, ...reviewPath.split('/')), reviewText)
    const before = await fixtureFiles(fixture)
    await fs.mkdir(path.join(fixture.root, `cycle-${cycle}`), { recursive: true })
    await fs.writeFile(path.join(fixture.root, `cycle-${cycle}`, 'before.json'), JSON.stringify(before, null, 2))
    const run = await runReviewAgent(fixture, cycle)
    expect(run.analysis.livePathHits).toEqual([])
    expect(run.analysis.tripwireHits).toEqual([])
    expect(run.analysis.testReads).toEqual([])
    expect(run.analysis.deniedCalls).toEqual([])
    expect(run.analysis.provenance.ok).toBe(true)
    const calls = JSON.stringify(run.analysis.toolCalls)
    expect(calls).toContain('fp-docs')
    expect(calls).toContain('ack')
    expect(calls).toContain('publish')
    expect(calls).toContain('write-turn.mjs')
    const after = await fixtureFiles(fixture)
    const response = JSON.parse(after[`docs/${id}/response.json`])
    expect(after[`docs/${id}/doc.md`]).toContain(expected)
    expect(response.rev).toBe(JSON.parse(before[`docs/${id}/response.json`]).rev + 1)
    expect(response.dispositions[commentId].status).toMatch(/^(answered|done)$/)
    expect(after[reviewPath]).toBe(reviewText)
    for (const filename of unchanged) expect(after[filename]).toBe(initial[filename])
    for (const [filename, content] of Object.entries(after)) await writeFile(page, filename, content)
    await fs.writeFile(path.join(run.artifact, 'after.json'), JSON.stringify(after, null, 2))
    evidence.cycles.push({ cycle, doc: id, commentId, reviewId: submitted.comments[commentId].reviewId,
      beforeRev: JSON.parse(before[`docs/${id}/response.json`]).rev, afterRev: response.rev,
      exactExpected: expected, disposition: response.dispositions[commentId], artifact: run.artifact })
    await page.goto('/')
    await expect(row(page, 9450).locator('.journal-link-doc .doc-badge-unread')).toBeVisible()
    await row(page, 9450).locator('.journal-link-doc').click()
    if (cycle === 2) await page.getByRole('link', { name: 'supporting notes' }).click()
    await expect(page.locator('.dv-page')).toContainText(expected)
    await page.getByRole('button', { name: /Comments/ }).click()
    const comments = page.getByRole('dialog', { name: 'Comments' })
    await comments.getByRole('tab', { name: /Resolved/ }).click()
    await expect(comments).toContainText(request)
    await comments.getByRole('button', { name: 'Close', exact: true }).click()
    await page.screenshot({ path: path.join(run.artifact, 'reopened-reader.png'), fullPage: true })
  }
  const duplicate = fixture.invokeState('scan', '-Compact')
  const duplicateRow = duplicate.rows.find((item) => item.id === '9450')
  expect(duplicateRow?.docs_review_submitted || []).toEqual([])
  expect(duplicateRow?.docs_work_pending || false).toBe(false)
  const final = await fixtureFiles(fixture)
  for (const cycle of evidence.cycles) expect(JSON.parse(final[`docs/${cycle.doc}/response.json`]).dispositions[cycle.commentId]).toBeTruthy()
  await fs.writeFile(path.join(fixture.root, 'acceptance.json'), JSON.stringify(evidence, null, 2))
  await test.info().attach('Native Docs agent acceptance', { path: path.join(fixture.root, 'acceptance.json'), contentType: 'application/json' })
})
