import { describe, it, expect } from 'vitest'
import { createAgentMetadataReader, parseProjection, LIMITS } from './agent-metadata-reader.js'
import { deviceKey, fingerprint } from '../agentMetadata/fingerprint.js'

// Visibility scenarios S1–S17 of docs/spec/Domain-agent-metadata.md. Row 468 / Added 2026-09-02 /
// "Work GitHub issues" (fingerprint V1); "now" is 2026-10-02T21:30:00Z.
const NOW = Date.parse('2026-10-02T21:30:00Z')
const V1 = 'sha256:9945c3c23d25ea6448ffaeb4ca719b074eb20db11e3920c9b3ae2a7c42c21815'
const V10 = 'sha256:709b3190ed8f9a81a6e3fc6b9ea69cde73ef519b85cd276d11b9fb6653359905'
const SID = '8864eba8-24dc-468a-a7c7-cb5efd2b6085'
const ROW = { id: '468', added: '2026-09-02', title: 'Work GitHub issues' }

async function device(n) {
  const id = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
  return { id, key: await deviceKey(id), name: `PC-${n}` }
}

function projection(dev, over = {}, binding = {}) {
  const b = { source: 'copilot-app', sessionId: SID, status: 'live', boundAt: null, verifiedAt: null, url: `ghapp://sessions/${SID}`, ...binding }
  if (b.url === undefined) delete b.url
  return {
    schema: 'fp-agent-task-metadata@1',
    device: { key: dev.key, id: dev.id, name: dev.name },
    planner: { board: 'planner.md' },
    revision: 5,
    publishedAt: '2026-10-02T21:25:00Z',
    lastSeenAt: '2026-10-02T21:25:00Z',
    heartbeatMinutes: 30,
    truncated: false,
    tasks: { 468: { fingerprint: V1, bindings: [b] } },
    ...over,
  }
}

function fakeStore(files) {
  const io = { lists: 0, reads: [], maxInFlight: 0, inFlight: 0, failRead: null, failList: null }
  io.listDir = async (dir) => {
    io.lists++
    if (io.failList) throw io.failList
    const prefix = `${dir}/`
    const names = Object.keys(files).filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length))
    return names.length ? names : (Object.prototype.hasOwnProperty.call(files, `${dir}/`) ? [] : null)
  }
  io.read = async (path) => {
    io.reads.push(path)
    io.inFlight++
    io.maxInFlight = Math.max(io.maxInFlight, io.inFlight)
    await new Promise((r) => setTimeout(r, 1))
    io.inFlight--
    if (io.failRead) { const e = io.failRead; if (typeof e === 'function') { const x = e(path); if (x) throw x } else throw e }
    return files[path]
  }
  return io
}

async function setup(files, now = () => NOW) {
  const io = fakeStore(files)
  const reader = createAgentMetadataReader({ listDir: io.listDir, read: io.read, now })
  await reader.refresh()
  return { io, reader, files }
}

const put = (files, dev, doc, name = `${dev.key}.json`) => { files[`agent-metadata/${name}`] = JSON.stringify(doc) }
const rowFp = () => fingerprint(ROW.id, ROW.added, ROW.title)

describe('agent metadata reader — visibility scenarios', () => {
  it('row fingerprint is V1', async () => { expect(await rowFp()).toBe(V1) })

  it('S1: no folder -> nothing, and no file reads', async () => {
    const { io, reader } = await setup({ 'planner.md': '' })
    expect(reader.enabled).toBe(false)
    expect(reader.bindingsFor('468', V1)).toEqual([])
    expect(io.reads).toEqual([])
    expect(io.lists).toBe(1)
  })

  it('S2: one valid file -> one live binding with its link, fresh', async () => {
    const a = await device(1); const files = {}
    put(files, a, projection(a))
    const { reader } = await setup(files)
    const links = reader.bindingsFor('468', await rowFp())
    expect(links).toHaveLength(1)
    expect(links[0]).toMatchObject({ deviceKey: a.key, deviceName: 'PC-1', sessionId: SID, url: `ghapp://sessions/${SID}`, stale: false })
  })

  it('S3: binding-time fingerprint differs (title edited since bind) -> nothing', async () => {
    const a = await device(1); const files = {}
    put(files, a, projection(a, { tasks: { 468: { fingerprint: V10, bindings: [{ source: 'copilot-app', sessionId: SID, status: 'live' }] } } }))
    const { reader } = await setup(files)
    expect(reader.bindingsFor('468', V1)).toEqual([])
  })

  it('S4: a cosmetic edit of the row keeps the link', async () => {
    const a = await device(1); const files = {}
    put(files, a, projection(a))
    const { reader } = await setup(files)
    expect(reader.bindingsFor('468', await fingerprint('468', '2026-09-02', '🚀 work  github issues'))).toHaveLength(1)
  })

  it('S5: two devices -> two bindings from two devices', async () => {
    const a = await device(1); const b = await device(2); const files = {}
    put(files, a, projection(a))
    put(files, b, projection(b, {}, { sessionId: 'other-session', url: 'ghapp://sessions/other-session' }))
    const { reader } = await setup(files)
    const links = reader.bindingsFor('468', V1)
    expect(links.map((l) => l.deviceName).sort()).toEqual(['PC-1', 'PC-2'])
  })

  it('S6: lastSeenAt older than max(15 min, 2 x heartbeat) -> shown, stale', async () => {
    const a = await device(1); const files = {}
    put(files, a, projection(a, { lastSeenAt: '2026-10-02T19:00:00Z' }))
    const { reader } = await setup(files)
    expect(reader.bindingsFor('468', V1)[0].stale).toBe(true)
    // 50 minutes old with a 30-minute heartbeat is still fresh (threshold 60 min)
    const files2 = {}; put(files2, a, projection(a, { lastSeenAt: '2026-10-02T20:40:00Z' }))
    expect((await setup(files2)).reader.bindingsFor('468', V1)[0].stale).toBe(false)
    // with no heartbeat declared the floor is 15 minutes
    const files3 = {}; const p = projection(a, { lastSeenAt: '2026-10-02T21:10:00Z' }); delete p.heartbeatMinutes; put(files3, a, p)
    expect((await setup(files3)).reader.bindingsFor('468', V1)[0].stale).toBe(true)
  })

  it('S7: conflict copies and temp files are never read', async () => {
    const a = await device(1); const files = {}
    put(files, a, projection(a))
    files[`agent-metadata/${a.key} (1).json`] = 'x'
    files[`agent-metadata/.${a.key}.json.tmp`] = 'x'
    files[`agent-metadata/${a.key}-PC.json`] = 'x'
    const { io, reader } = await setup(files)
    expect(io.reads).toEqual([`agent-metadata/${a.key}.json`])
    expect(reader.bindingsFor('468', V1)).toHaveLength(1)
  })

  it('S8: file name stem != device.key -> nothing', async () => {
    const a = await device(1); const b = await device(2); const files = {}
    put(files, a, projection(a), `${b.key}.json`)
    expect((await setup(files)).reader.bindingsFor('468', V1)).toEqual([])
  })

  it('S8b: device.key not derived from device.id -> nothing', async () => {
    const a = await device(1); const files = {}
    put(files, a, projection({ ...a, id: '00000000-0000-4000-8000-999999999999' }))
    expect((await setup(files)).reader.bindingsFor('468', V1)).toEqual([])
  })

  it('S9: unsafe url -> nothing', async () => {
    const a = await device(1); const files = {}
    put(files, a, projection(a, {}, { url: 'javascript:alert(1)' }))
    expect((await setup(files)).reader.bindingsFor('468', V1)).toEqual([])
  })

  it('S10: a ghapp link to another session -> nothing', async () => {
    const a = await device(1); const files = {}
    put(files, a, projection(a, {}, { url: 'ghapp://sessions/someone-else' }))
    expect((await setup(files)).reader.bindingsFor('468', V1)).toEqual([])
  })

  it('S11: a later failed read keeps the last good copy, shown stale', async () => {
    const a = await device(1); const files = {}
    put(files, a, projection(a))
    let t = NOW
    const { io, reader } = await setup(files, () => t)
    io.failRead = new Error('network down')
    t += LIMITS.refreshMs
    await reader.refresh()
    const links = reader.bindingsFor('468', V1)
    expect(links).toHaveLength(1)
    expect(links[0].stale).toBe(true)
  })

  it('S11b: a later invalid copy (half-synced) also keeps the last good copy', async () => {
    const a = await device(1); const files = {}
    put(files, a, projection(a))
    let t = NOW
    const { reader } = await setup(files, () => t)
    files[`agent-metadata/${a.key}.json`] = '{"schema":"fp-agent-task-metadata@1","dev'
    t += LIMITS.refreshMs
    await reader.refresh()
    expect(reader.bindingsFor('468', V1)[0].stale).toBe(true)
  })

  it('S12: a successful listing without the file removes its links', async () => {
    const a = await device(1); const files = {}
    put(files, a, projection(a))
    let t = NOW
    const { reader } = await setup(files, () => t)
    delete files[`agent-metadata/${a.key}.json`]
    files['agent-metadata/notes.txt'] = 'x'
    t += LIMITS.refreshMs
    await reader.refresh()
    expect(reader.bindingsFor('468', V1)).toEqual([])
  })

  it('S12b: a successful read without the task removes that task only', async () => {
    const a = await device(1); const files = {}
    put(files, a, projection(a))
    let t = NOW
    const { reader } = await setup(files, () => t)
    put(files, a, projection(a, { revision: 6, tasks: {} }))
    t += LIMITS.refreshMs
    await reader.refresh()
    expect(reader.bindingsFor('468', V1)).toEqual([])
  })

  it('S13: an older revision arriving late is ignored', async () => {
    const a = await device(1); const files = {}
    put(files, a, projection(a))
    let t = NOW
    const { reader } = await setup(files, () => t)
    put(files, a, projection(a, { revision: 4, tasks: {} }))
    t += LIMITS.refreshMs
    await reader.refresh()
    expect(reader.bindingsFor('468', V1)).toHaveLength(1)
  })

  it('S14: a binding that is not live is not shown', async () => {
    const a = await device(1); const files = {}
    put(files, a, projection(a, {}, { status: 'dead' }))
    expect((await setup(files)).reader.bindingsFor('468', V1)).toEqual([])
  })

  it('S15: no url -> a binding without a link', async () => {
    const a = await device(1); const files = {}
    put(files, a, projection(a, {}, { url: undefined }))
    const links = (await setup(files)).reader.bindingsFor('468', V1)
    expect(links).toHaveLength(1)
    expect(links[0].url).toBe(null)
  })

  it('S16: a different task id -> nothing', async () => {
    const a = await device(1); const files = {}
    put(files, a, projection(a))
    expect((await setup(files)).reader.bindingsFor('469', V1)).toEqual([])
  })

  it('S17: at most 64 files are read, two at a time', async () => {
    const files = {}
    for (let i = 1; i <= 70; i++) { const d = await device(i); put(files, d, projection(d)) }
    const { io, reader } = await setup(files)
    expect(io.reads).toHaveLength(64)
    expect(io.maxInFlight).toBeLessThanOrEqual(2)
    const sortedNames = Object.keys(files).map((p) => p.slice('agent-metadata/'.length)).sort()
    expect(io.reads.map((p) => p.slice('agent-metadata/'.length)).sort()).toEqual(sortedNames.slice(0, 64))
    expect(reader.bindingsFor('468', V1)).toHaveLength(64)
  })
})

describe('agent metadata reader — limits', () => {
  it('refreshes at most once every 5 minutes', async () => {
    const a = await device(1); const files = {}
    put(files, a, projection(a))
    let t = NOW
    const { io, reader } = await setup(files, () => t)
    t += LIMITS.refreshMs - 1
    expect(await reader.refresh()).toBe(false)
    expect(io.lists).toBe(1)
    t += 1
    expect(await reader.refresh()).toBe(true)
    expect(io.lists).toBe(2)
  })

  it('a 429 pauses every read for at least 5 minutes and keeps what is known', async () => {
    const files = {}
    const devs = []
    for (let i = 1; i <= 4; i++) { const d = await device(i); devs.push(d); put(files, d, projection(d)) }
    let t = NOW
    const { io, reader } = await setup(files, () => t)
    io.reads.length = 0
    io.failRead = () => Object.assign(new Error('OneDrive read failed: 429'), { status: 429 })
    t += LIMITS.refreshMs
    await reader.refresh()
    expect(io.reads.length).toBeLessThanOrEqual(2)
    expect(reader.bindingsFor('468', V1)).toHaveLength(4)
    expect(reader.bindingsFor('468', V1).every((l) => l.stale)).toBe(true)
    io.failRead = null
    const before = io.lists
    t += LIMITS.refreshMs - 1
    expect(await reader.refresh({ force: true })).toBe(false)
    expect(io.lists).toBe(before)
  })

  it('Retry-After longer than 5 minutes is honoured', async () => {
    const a = await device(1); const files = {}
    put(files, a, projection(a))
    let t = NOW
    const { io, reader } = await setup(files, () => t)
    io.failList = Object.assign(new Error('429'), { status: 429, retryAfter: 900 })
    t += LIMITS.refreshMs
    await reader.refresh()
    io.failList = null
    t += 10 * 60 * 1000
    expect(await reader.refresh()).toBe(false)
    t += 5 * 60 * 1000
    expect(await reader.refresh()).toBe(true)
  })

  it('rejects a file over 256 KiB', async () => {
    const a = await device(1)
    const doc = projection(a, { padding: 'x'.repeat(LIMITS.maxBytes) })
    expect(await parseProjection(JSON.stringify(doc), `${a.key}.json`)).toBe(null)
  })

  it('drops malformed task entries but keeps the rest of the file', async () => {
    const a = await device(1)
    const doc = projection(a)
    doc.tasks['07'] = doc.tasks[468]
    doc.tasks['9'] = { fingerprint: 'md5:x', bindings: [] }
    const p = await parseProjection(JSON.stringify(doc), `${a.key}.json`)
    expect([...p.tasks.keys()]).toEqual(['468'])
  })
})

describe('agent metadata reader — announced devices (docs/spec/Domain-lanes.md)', () => {
  it('lists every valid device file with its name, freshness and last seen, sorted by key; none without the folder', async () => {
    const a = await device(1); const b = await device(2); const files = {}
    put(files, a, projection(a))
    put(files, b, projection(b, { lastSeenAt: '2026-10-02T19:00:00Z', tasks: {} }))
    files['agent-metadata/not-a-key.json'] = '{}'
    const { reader } = await setup(files)
    const list = reader.devices()
    expect(list.map((d) => d.key)).toEqual([a.key, b.key].sort())
    const byName = Object.fromEntries(list.map((d) => [d.name, d]))
    expect(byName['PC-1']).toMatchObject({ stale: false, lastSeenMs: Date.parse('2026-10-02T21:25:00Z') })
    expect(byName['PC-2']).toMatchObject({ stale: true, lastSeenMs: Date.parse('2026-10-02T19:00:00Z') })
    const none = await setup({ 'planner.md': '' })
    expect(none.reader.devices()).toEqual([])
  })
})
