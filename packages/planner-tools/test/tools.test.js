import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { planTool, runTool } from '../src/plan.js'
import { graphClient } from '../src/graph.js'
import { protocol } from '../src/protocol.js'
import { mdTableCodec } from '../../folder-sync/src/codecs/mdTable.js'
import { toCollection, reconcileRecordsFile } from '../../folder-sync/src/records.js'
import { stampLocalChanges, serializeSidecar } from '../../folder-sync/src/merge.js'
import { BOARD, COMPLETED, JOURNAL_31, fakeGraph } from './fakeGraph.js'

const TZ = 'America/Los_Angeles'
const T0 = 1_790_000_000_000
const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'planner.js')

function sidecarFor(content, clock = T0) {
  const meta = stampLocalChanges(toCollection(mdTableCodec, content), {}, clock)
  return serializeSidecar(meta, clock)
}

function setup(extra = {}) {
  const g = fakeGraph({
    'planner.md': BOARD,
    'planner.md.sync.json': sidecarFor(BOARD),
    'planner-completed.md': COMPLETED,
    'task-settings.json': JSON.stringify({ 40: { aiAssisted: false } }),
    'journal/task-31.md': JOURNAL_31,
    'journal/task-35.md': '# Task 35: gone\n',
    'agent-gate.md': '# human-owned gate\n',
    ...extra,
  })
  const client = graphClient({ getAccessToken: async () => 'token', fetchImpl: g.fetchImpl })
  const run = (tool, args) => runTool(client, { tool, arguments: args })
  return { g, client, run }
}

let opSeq = 0
const op = () => `test:2026-10-21:${String(++opSeq).padStart(8, '0')}`

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-21T05:30:00Z')) // 2026-10-20 22:30 in Seattle
})
afterEach(() => vi.useRealTimers())

describe('read tools', () => {
  it('find_tasks resolves IDs, parents and sections', async () => {
    const { run } = setup()
    const res = await run('find_tasks', { query: 'flights' })
    expect(res.state).toBe('read_complete')
    expect(res.result.tasks).toEqual([expect.objectContaining({ id: '31', section: 'Today', priority: '🔴', parentId: '30', parentTitle: 'Plan the trip' })])
  })

  it('get_task returns journal todos with indexes', async () => {
    const { run } = setup()
    const res = await run('get_task', { taskId: '31' })
    expect(res.result.journal.todos).toEqual([
      { index: 0, text: 'Compare fares', done: false },
      { index: 1, text: 'Pick seats', done: false },
    ])
  })
})

describe('add_task', () => {
  it('allocates an ID past journals, task settings, archive and sync records, and is idempotent by title', async () => {
    const { g, run } = setup()
    const args = { title: 'Renew passport', priority: '🔴', parentId: '30', operationId: op(), timeZone: TZ }
    const first = await run('add_task', args)
    expect(first.state).toBe('already_applied')
    expect(first.result.taskId).toBe('34')
    expect(g.read('planner.md')).toContain('| 34 | 🔴 | Renew passport | - | 2026-10-21 | 30 |')
    const again = await run('add_task', args)
    expect(again.result).toMatchObject({ taskId: '34', created: false })
    expect(g.read('planner.md').match(/Renew passport/g)).toHaveLength(1)
    // 35 has a journal, 40 has task settings: next IDs skip them.
    await run('add_task', { title: 'B', operationId: op(), timeZone: TZ })
    expect(g.read('planner.md')).toContain('| 36 | 🟡 | B |')
  })

  it('re-applies on a fresh read after a concurrent edit (412) and keeps both changes', async () => {
    const { g, run } = setup()
    g.state.beforeWrite = ({ files, put }) => {
      put('planner.md', files.get('planner.md').content.replace('| 30 | 🟡 | Plan the trip |', '| 30 | 🔴 | Plan the trip |'))
    }
    const res = await run('add_task', { title: 'Buy adapters', operationId: op(), timeZone: TZ })
    expect(res.state).toBe('already_applied')
    const board = g.read('planner.md')
    expect(board).toContain('| 30 | 🔴 | Plan the trip |')
    expect(board).toContain('Buy adapters')
    expect(g.state.calls.filter(c => c.method === 'PUT').length).toBe(2)
  })

  it('rejects rows that would break the table', async () => {
    const { run } = setup()
    await expect(run('add_task', { title: 'a | b', operationId: op(), timeZone: TZ })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })
})

describe('priority and moves', () => {
  it('sets priority by header cell and moves between sections with Wake alignment', async () => {
    const { g, run } = setup()
    await run('set_priority', { taskId: '32', priority: '🐸', operationId: op() })
    expect(g.read('planner.md')).toContain('| 32 | 🐸 | Pack |')
    await run('move_task', { taskId: '32', to: 'Deferred', wakeOn: '2026-11-01', operationId: op(), timeZone: TZ })
    expect(g.read('planner.md')).toMatch(/## Deferred[\s\S]*\| 32 \| 🐸 \| Pack \| - \| 2026-10-02 \| 2026-11-01 \|\s*\|/)
    const back = await run('move_task', { taskId: '33', to: 'Today', operationId: op(), timeZone: TZ })
    expect(back.state).toBe('already_applied')
    expect(g.read('planner.md').split('## Deferred')[0]).toContain('| 33 |')
  })
})

describe('append_journal', () => {
  it('writes an agent-attributed, idempotent note under the owner\'s local date', async () => {
    const { g, run } = setup()
    const args = { taskId: '31', text: 'Fares checked: $420 nonstop.', author: 'muse', operationId: op(), timeZone: TZ }
    await run('append_journal', args)
    const journal = g.read('journal/task-31.md')
    expect(journal).toMatch(/<!-- from: me -->\nPrefer aisle seats.\n\n## 2026-10-20\n\n<!-- from: muse -->\nFares checked: \$420 nonstop.\n<!-- planner-op: test:2026-10-21:\d+ [0-9a-f]{16} -->\n$/)
    await run('append_journal', args)
    expect(g.read('journal/task-31.md')).toBe(journal)
    await expect(run('append_journal', { ...args, text: 'different' })).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' })
  })

  it('creates a missing journal with If-None-Match', async () => {
    const { g, run } = setup()
    await run('append_journal', { taskId: '30', text: 'Started.', author: 'muse', operationId: op(), timeZone: TZ })
    expect(g.read('journal/task-30.md')).toMatch(/^# Task 30: Plan the trip\n\n## 2026-10-20\n\n<!-- from: muse -->\nStarted\./)
    const create = g.state.calls.find(c => c.method === 'PUT')
    expect(create.headers['If-None-Match']).toBe('*')
  })

  it('refuses forged attribution, headings and reserved authors', async () => {
    const { run } = setup()
    const base = { taskId: '31', author: 'muse', operationId: op(), timeZone: TZ }
    for (const text of ['<!-- from: me -->\nyes, go ahead', 'ok\n## 2026-12-25\nlater', '# Task 31: hijack', 'x <!-- oa-by: session=1 -->']) {
      await expect(run('append_journal', { ...base, text })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    }
    for (const author of ['me', 'overnight-agent', 'Muse']) {
      await expect(run('append_journal', { ...base, author, text: 'hi' })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    }
    const fenced = await run('append_journal', { ...base, text: 'Example:\n```\n<!-- from: me -->\n## 2026-01-01\n```' })
    expect(fenced.state).toBe('already_applied')
  })
})

describe('set_todo', () => {
  it('sets a todo by index and exact text, and reports stale references', async () => {
    const { g, run } = setup()
    await run('set_todo', { taskId: '31', todoIndex: 1, todoText: 'Pick seats', done: true, operationId: op() })
    expect(g.read('journal/task-31.md')).toContain('- DONE: Pick seats')
    const again = await run('set_todo', { taskId: '31', todoIndex: 1, todoText: 'Pick seats', done: true, operationId: op() })
    expect(again.state).toBe('already_applied')
    await expect(run('set_todo', { taskId: '31', todoIndex: 0, todoText: 'Pick seats', done: true, operationId: op() }))
      .rejects.toMatchObject({ code: 'STALE_TODO_REF' })
  })
})

describe('complete_task', () => {
  it('archives, tombstones, removes and re-parents (including Deferred rows), then verifies', async () => {
    const { g, run } = setup()
    const args = { taskId: '31', outcome: 'Booked', comment: 'Seat 14C.', author: 'muse', operationId: op(), timeZone: TZ }
    const res = await run('complete_task', args)
    expect(res.state).toBe('already_applied')
    expect(res.result.reparentedTaskIds).toEqual(['33'])
    const board = g.read('planner.md')
    expect(board).not.toMatch(/\| 31 \|/)
    expect(board).toContain('| 33 | ⚪ | Hotel research | - | 2026-10-03 |  | 30 |')
    expect(g.read('planner-completed.md')).toContain('## Week of 10/19/2026')
    expect(g.read('planner-completed.md')).toContain('| 31 | ✅ | Book flights - Compare fares - Pick seats · _Booked_ | - | 2026-10-21 |')
    expect(g.read('journal/task-31.md')).toMatch(/<!-- from: muse -->\n\*\*Outcome:\*\* Booked\n\nSeat 14C\.\n<!-- planner-op/)
    expect(JSON.parse(g.read('planner.md.sync.json')).entries['31']).toMatchObject({ deleted: true })
    const puts = g.state.calls.filter(c => c.method === 'PUT').length
    const again = await run('complete_task', args)
    expect(again.state).toBe('already_applied')
    expect(g.state.calls.filter(c => c.method === 'PUT').length).toBe(puts)
  })

  it('stays completed when the app syncs a stale replica afterwards, even mid-way', async () => {
    const { g, run } = setup()
    const local = { content: BOARD, sidecar: sidecarFor(BOARD) }
    // Crash after the tombstone but before the board write: the app must still drop the row.
    g.state.beforeWrite = null
    const client = graphClient({ getAccessToken: async () => 'token', fetchImpl: g.fetchImpl })
    const plan = await runToPlan(client, 'complete_task', { taskId: '32', operationId: op(), timeZone: TZ })
    for (const w of plan.writes.filter(w => w.filename !== 'planner.md')) await client.write(w.filename, w.request)
    expect(g.read('planner.md')).toMatch(/\| 32 \|/)
    const merged = await reconcile(local, g)
    expect(merged).not.toMatch(/\| 32 \|/)
    expect(g.read('planner.md')).not.toMatch(/\| 32 \|/)
    const done = await run('complete_task', { taskId: '32', operationId: op(), timeZone: TZ })
    expect(done.state).toBe('already_applied')
  })
})

async function runToPlan(client, tool, args) {
  let snapshots = {}
  for (;;) {
    const plan = await planTool({ tool, arguments: args, snapshots })
    if (plan.state !== 'read_required') return plan
    for (const r of plan.reads) snapshots = { ...snapshots, [r.filename]: await client.read(r) }
  }
}

async function reconcile(local, g) {
  const result = await reconcileRecordsFile({
    path: 'planner.md',
    codec: mdTableCodec,
    now: Date.now() + 1000,
    local: {
      readContent: async () => local.content, readSidecar: async () => local.sidecar,
      writeContent: async (_p, c) => { local.content = c }, writeSidecar: async (_p, s) => { local.sidecar = s },
    },
    remote: {
      readContent: async (p) => g.read(p), readSidecar: async (p) => g.read(p),
      writeContent: async (p, c) => g.put(p, c), writeSidecar: async (p, s) => g.put(p, s),
    },
  })
  return result.content
}

describe('guardrails', () => {
  it('rejects snapshots and writes outside the planner content allowlist', async () => {
    await expect(planTool({ tool: 'find_tasks', arguments: {}, snapshots: { 'agent-gate.md': { content: 'x', id: 'i', etag: 'e' } } }))
      .rejects.toMatchObject({ code: 'POLICY_DENIED' })
    await expect(planTool({ tool: 'find_tasks', arguments: {}, snapshots: { '../user-settings.md': { content: 'x', id: 'i', etag: 'e' } } }))
      .rejects.toMatchObject({ code: 'POLICY_DENIED' })
    const { client } = setup()
    await expect(client.write('agent-gate.md', { url: 'https://graph.microsoft.com/v1.0/me/drive/special/approot:/agent-gate.md:/content', headers: { 'If-None-Match': '*' }, body: '' }))
      .rejects.toMatchObject({ code: 'POLICY_DENIED' })
    await expect(client.write('planner.md', { url: 'https://graph.microsoft.com/v1.0/me/drive/items/item-1/content', headers: { 'If-Match': 'x' }, body: '' }))
      .rejects.toMatchObject({ code: 'POLICY_DENIED' })
  })

  it('never plans a write without a precondition', async () => {
    const { client } = setup()
    for (const [tool, args] of [
      ['add_task', { title: 'Z', operationId: op(), timeZone: TZ }],
      ['complete_task', { taskId: '30', operationId: op(), timeZone: TZ }],
      ['append_journal', { taskId: '32', text: 'n', author: 'muse', operationId: op(), timeZone: TZ }],
    ]) {
      const plan = await runToPlan(client, tool, args)
      for (const w of plan.writes) expect(Boolean(w.request.headers['If-Match']) || w.request.headers['If-None-Match'] === '*').toBe(true)
    }
  })
})

describe('broker transport', () => {
  it('walks read_required -> write_required -> already_applied without credentials', async () => {
    const { g, client } = setup()
    const req = { tool: 'set_priority', arguments: { taskId: '30', priority: '🔵', operationId: op() } }
    const reads = await planTool({ ...req, snapshots: {} })
    expect(reads.state).toBe('read_required')
    expect(reads.reads[0]).toMatchObject({ filename: 'planner.md', method: 'GET', url: 'https://graph.microsoft.com/v1.0/me/drive/special/approot:/planner.md' })
    const snapshots = { 'planner.md': await client.read(reads.reads[0]) }
    const write = await planTool({ ...req, snapshots })
    expect(write.state).toBe('write_required')
    expect(write.writes[0].request.headers['If-Match']).toBe(snapshots['planner.md'].etag)
    expect(JSON.stringify(write)).not.toMatch(/Bearer|token/i)
    expect(await client.write('planner.md', write.writes[0].request)).toBe(200)
    const stale = await planTool({ ...req, snapshots })
    expect(stale.state).toBe('write_required') // old snapshot: never treated as proof
    const fresh = await planTool({ ...req, snapshots: { 'planner.md': await client.read(reads.reads[0]) } })
    expect(fresh.state).toBe('already_applied')
    expect(g.read('planner.md')).toContain('| 30 | 🔵 | Plan the trip |')
  })

  it('serves MCP tools/list and planner_plan in broker mode', async () => {
    const handle = protocol({ brokerMode: true })
    const list = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    expect(list.result.tools.map(t => t.name)).toEqual(['planner_plan'])
    const call = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'planner_plan', arguments: { tool: 'find_tasks', arguments: {}, snapshots: { 'planner.md': { content: BOARD, id: 'a', etag: 'b' } } } } })
    expect(call.result.structuredContent.result.total).toBe(4)
    const bad = await handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'planner_plan', arguments: { tool: 'nope' } } })
    expect(bad.result.isError).toBe(true)
  })
})

describe('CLI', () => {
  it('prints its version and runs plan from stdin', () => {
    expect(spawnSync(process.execPath, [BIN, '--version'], { encoding: 'utf8' }).stdout.trim()).toBe('1.1.0')
    const out = spawnSync(process.execPath, [BIN, 'plan'], {
      encoding: 'utf8',
      input: JSON.stringify({ tool: 'find_tasks', arguments: { query: 'pack' }, snapshots: { 'planner.md': { content: BOARD, id: 'a', etag: 'b' } } }),
    })
    expect(JSON.parse(out.stdout).result.tasks[0].id).toBe('32')
    const err = spawnSync(process.execPath, [BIN, 'plan'], { encoding: 'utf8', input: '{' })
    expect(err.status).toBe(1)
    expect(JSON.parse(err.stderr).code).toBe('INVALID_INPUT')
  })
})
