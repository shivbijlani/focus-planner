import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runTool, planTool } from '../src/plan.js'
import { graphClient } from '../src/graph.js'
import { readStatus, readComments } from '../../docs-publisher/src/publisher.js'
import { BOARD, COMPLETED, JOURNAL_31, fakeGraph } from './fakeGraph.js'

const T0 = Date.parse('2026-10-21T16:00:00Z')

function setup() {
  const g = fakeGraph({
    'planner.md': BOARD,
    'planner-completed.md': COMPLETED,
    'journal/task-31.md': JOURNAL_31,
    'docs/index.json': '{\n  "version": 1,\n  "tasks": {},\n  "docs": {}\n}\n',
    'user-settings.md': 'Catch-up doc threshold: 1\n',
  })
  const client = graphClient({ getAccessToken: async () => 'token', fetchImpl: g.fetchImpl })
  let clock = T0
  const run = (tool, args) => runTool(client, { tool, arguments: args }, { now: () => (clock += 1000) })
  return { g, run }
}

const PRIMARY = `# Task 31: Book flights

**Status: first resume draft is ready for your comments.**

## What this is, with no prior context

Draft resume bullets for the flights role. The draft itself is in [the resume draft](doc:new:resume).

## Why it matters

Applications close Friday.

## What changed / what was done

Wrote the first draft from the journal notes.

## Evidence

The journal notes on this task.

## Where it stands

Comment on any line of the draft, press Send, then tell Muse.
`

const DRAFT_V1 = `# Resume draft

Led a team that leveraged cutting-edge synergies to deliver value.

Built the fare comparison tool used by 40 travel agents.
`

const DRAFT_V2 = `# Resume draft

Led four engineers to ship fare search in six weeks.

Built the fare comparison tool used by 40 travel agents.
`

function putReview(g, docId, rev, comments) {
  const at = '2026-10-21T17:00:00.000Z'
  const review = {
    version: 1,
    readRev: rev,
    reviews: { rv_phone1: { submittedAt: at, rev } },
    comments: Object.fromEntries(comments.map((c, i) => [c.id, {
      rev, anchor: { block: c.block, quote: c.quote, offset: 0 }, intent: c.intent, body: c.body,
      createdAt: at, reviewId: 'rv_phone1', status: 'open', clock: Date.parse(at) + i,
    }])),
  }
  g.put(`docs/${docId}/review.json`, `${JSON.stringify(review, null, 2)}\n`)
}

function dumpToDisk(g) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'planner-docs-'))
  for (const [name, file] of g.files) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true })
    fs.writeFileSync(path.join(root, name), file.content)
  }
  return root
}

describe('Docs draft -> comment -> better draft loop', () => {
  it('creates, reads comments, publishes a revision with dispositions, and stays consistent for fp-docs', async () => {
    const { g, run } = setup()

    const created = await run('docs_publish', {
      taskId: '31', summary: 'First resume draft', draft: PRIMARY, force: true,
      linked: [{ alias: 'resume', draft: DRAFT_V1 }],
      author: 'muse', timeZone: 'America/Los_Angeles', operationId: 'muse:test:create-0001',
    })
    expect(created.state).toBe('already_applied')
    const primaryId = created.result.doc
    const draftId = created.result.linked[0].doc
    expect(created.result.rev).toBe(1)
    expect(created.result.url).toBe(`https://plannermd.com/docs.html#/d/${primaryId}`)
    expect(JSON.parse(g.read('docs/index.json')).tasks['31']).toBe(primaryId)
    expect(g.read(`docs/${primaryId}/doc.md`)).toContain(`doc:${draftId}`)
    expect(g.read('journal/task-31.md')).toMatch(/<!-- from: muse -->[\s\S]*Draft r1 is ready for your review/)

    // The user comments from the phone (the Docs app writes review.json).
    const draftDoc = g.read(`docs/${draftId}/doc.md`)
    const block = draftDoc.match(/<!-- @(b\d+) -->\nLed a team/)[1]
    putReview(g, draftId, 1, [{ id: 'c_phone1', block, quote: 'leveraged cutting-edge synergies', intent: 'do-more', body: 'Sounds like AI. Say what I actually did.' }])

    const read = await run('docs_read', { taskId: '31' })
    expect(read.state).toBe('read_complete')
    const doc = read.result.docs.find(d => d.id === draftId)
    expect(doc.pendingReviews).toEqual(['rv_phone1'])
    expect(doc.draft).toBe(DRAFT_V1)
    expect(read.result.comments).toEqual([expect.objectContaining({
      doc: draftId, comments: [expect.objectContaining({ id: 'c_phone1', body: 'Sounds like AI. Say what I actually did.', quote: 'leveraged cutting-edge synergies', state: 'open' })],
    })])

    // Publishing without answering the comment is refused by the publisher.
    await expect(run('docs_publish', {
      taskId: '31', summary: 'skip', baseRev: 1, linked: [{ id: draftId, baseRev: 1, draft: DRAFT_V2 }], operationId: 'muse:test:skip-00001',
    })).rejects.toMatchObject({ code: 'DOCS_REFUSED' })

    const putsBefore = g.state.calls.filter(c => c.method === 'PUT').length
    const revised = await run('docs_publish', {
      taskId: '31', summary: 'De-AI the lead bullet', baseRev: 1,
      linked: [{ id: draftId, baseRev: 1, draft: DRAFT_V2 }],
      dispositions: [{ doc: draftId, id: 'c_phone1', status: 'done', blocks: ['@1'], note: 'Rewrote with the real scope.' }],
      author: 'muse', timeZone: 'America/Los_Angeles', operationId: 'muse:test:rev2-00001',
    })
    expect(revised.state).toBe('already_applied')
    expect(revised.result).toMatchObject({ doc: primaryId, rev: 2, linked: [{ doc: draftId, rev: 2 }] })
    const puts = g.state.calls.filter(c => c.method === 'PUT').slice(putsBefore)
    expect(puts.every(c => c.headers['If-Match'] || c.headers['If-None-Match'] === '*')).toBe(true)
    expect(puts.some(c => /review\.json/.test(c.url))).toBe(false)
    expect(JSON.parse(g.read(`docs/${draftId}/response.json`))).toMatchObject({
      rev: 2, ackedReview: 'rv_phone1', dispositions: { c_phone1: { status: 'done', rev: 2 } },
    })

    // A retry with the same operationId changes nothing.
    const writes = g.state.calls.filter(c => c.method === 'PUT').length
    const retry = await run('docs_publish', {
      taskId: '31', summary: 'De-AI the lead bullet', baseRev: 1,
      linked: [{ id: draftId, baseRev: 1, draft: DRAFT_V2 }],
      dispositions: [{ doc: draftId, id: 'c_phone1', status: 'done', blocks: ['@1'] }],
      author: 'muse', timeZone: 'America/Los_Angeles', operationId: 'muse:test:rev2-00001',
    })
    expect(retry.state).toBe('already_applied')
    expect(g.state.calls.filter(c => c.method === 'PUT').length).toBe(writes)
    expect(g.read('journal/task-31.md').match(/Draft r2 is ready/g)).toHaveLength(1)

    const after = await run('docs_read', { taskId: '31', includeDrafts: false })
    expect(after.result.comments).toEqual([])

    // The sanctioned publisher reads the same files as consistent.
    const root = dumpToDisk(g)
    const status = await readStatus({ root, task: 31 })
    expect(status.primary).toMatchObject({ id: primaryId, rev: 2 })
    expect((await readComments({ root, task: 31 })).docs).toEqual([])
  })

  it('rolls an interrupted publish forward instead of guessing', async () => {
    const { g, run } = setup()
    const created = await run('docs_publish', {
      taskId: '31', summary: 'First', draft: PRIMARY, force: true, linked: [{ alias: 'resume', draft: DRAFT_V1 }], operationId: 'muse:test:torn-create1',
    })
    const primaryId = created.result.doc
    const indexAtRev1 = g.read('docs/index.json')
    await run('docs_publish', { taskId: '31', summary: 'Second', baseRev: 1, operationId: 'muse:test:torn-second' })
    // Simulate the index write never landing: body and response are at r2, index at r1.
    g.put('docs/index.json', indexAtRev1)
    const retried = await run('docs_publish', { taskId: '31', summary: 'Second', baseRev: 1, operationId: 'muse:test:torn-second' })
    expect(retried.state).toBe('already_applied')
    expect(JSON.parse(g.read('docs/index.json')).docs[primaryId].rev).toBe(2)
    expect((await readStatus({ root: dumpToDisk(g), task: 31 })).primary.rev).toBe(2)
  })

  it('refuses a stale base revision and needs Docs enabled', async () => {
    const { g, run } = setup()
    await run('docs_publish', { taskId: '31', summary: 'First', draft: PRIMARY, force: true, linked: [{ alias: 'resume', draft: DRAFT_V1 }], operationId: 'muse:test:stale-create' })
    await expect(run('docs_publish', { taskId: '31', summary: 'x', operationId: 'muse:test:stale-nobase' })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(run('docs_publish', { taskId: '31', summary: 'x', baseRev: 7, operationId: 'muse:test:stale-base7' })).rejects.toMatchObject({ code: 'DOCS_REFUSED' })
    g.files.delete('docs/index.json')
    await expect(run('docs_read', { taskId: '31' })).rejects.toMatchObject({ code: 'DOCS_DISABLED' })
  })

  it('broker mode asks for the review set in batches and never reads configuration', async () => {
    const { run } = setup()
    await run('docs_publish', { taskId: '31', summary: 'First', draft: PRIMARY, force: true, linked: [{ alias: 'resume', draft: DRAFT_V1 }], operationId: 'muse:test:broker-make' })
    const first = await planTool({ tool: 'docs_read', arguments: { taskId: '31' }, snapshots: {} })
    expect(first.reads.map(r => r.filename)).toEqual(['docs/index.json'])
    const second = await planTool({ tool: 'docs_read', arguments: { taskId: '31' }, snapshots: { 'docs/index.json': { content: '{"version":1,"tasks":{"31":"d-aaaaaa"},"docs":{"d-aaaaaa":{"title":"T","task":31,"primary":true,"rev":1,"updatedAt":"2026-10-21T00:00:00Z","links":[],"nextBlockId":2}}}', id: 'i', etag: 'e' } } })
    expect(second.state).toBe('read_required')
    const names = second.reads.map(r => r.filename)
    expect(names).toEqual(expect.arrayContaining(['journal/task-31.md', 'docs/d-aaaaaa/doc.md', 'docs/d-aaaaaa/review.json', 'docs/d-aaaaaa/response.json']))
    expect(names.some(n => /settings|agent-gate|AGENTS/.test(n))).toBe(false)
    await expect(planTool({ tool: 'docs_read', arguments: { taskId: '31' }, snapshots: { 'user-settings.md': { content: '', id: 'x', etag: 'y' } } })).rejects.toMatchObject({ code: 'POLICY_DENIED' })
  })
})
