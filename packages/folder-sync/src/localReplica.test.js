import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { idbGet, idbSet, idbKeys, idbDel, idbCompareAndSet } from './idb.js'
import { saveLocalReplica, readLocalSnapshot, commitLocalSnapshot } from './localReplica.js'
import { mdTableCodec } from './codecs/mdTable.js'

const path = 'planner.md'
const plan = (...rows) => '## Today\n\n| ID | Task |\n|---|---|\n' + rows.map(([id, text]) => `| ${id} | ${text} |`).join('\n') + '\n'
const ids = content => Object.keys(mdTableCodec.parse(content).records)

afterEach(async () => {
  for (const key of await idbKeys('meta')) await idbDel('meta', key)
  vi.unstubAllGlobals()
})

describe('durable local replica (real IndexedDB transactions)', () => {
  it('atomically stamps a deliberate save/delete, including clearing the entire board', async () => {
    const original = plan([1, 'A'], [2, 'B'])
    await saveLocalReplica(path, original, { importing: true, now: 1000 })
    await saveLocalReplica(path, plan(), { previousContent: original, now: 2000 })
    const saved = await readLocalSnapshot(path)
    expect(ids(saved.content)).toEqual([])
    const meta = JSON.parse(saved.rawSidecar).entries
    expect(meta['1']).toMatchObject({ deleted: true, clock: 2000 })
    expect(meta['2']).toMatchObject({ deleted: true, clock: 2000 })
  })

  it('an empty startup import is absence, not a new delete, even with one row', async () => {
    const original = plan([1, 'A'])
    await saveLocalReplica(path, original, { importing: true, now: 1000 })
    const merged = await saveLocalReplica(path, plan(), { importing: true, now: 2000 })
    expect(ids(merged)).toEqual(['1'])
    expect(JSON.parse((await readLocalSnapshot(path)).rawSidecar).entries['1'].deleted).toBe(false)
  })

  it('rejects a worker commit computed before a newer device edit', async () => {
    await saveLocalReplica(path, plan([1, 'A']), { importing: true, now: 1000 })
    const stale = await readLocalSnapshot(path)
    await saveLocalReplica(path, plan([1, 'edited'], [2, 'new']), { previousContent: stale.content, now: 2000 })
    expect(await commitLocalSnapshot(path, stale, plan(), stale.rawSidecar)).toBe(false)
    expect(ids((await readLocalSnapshot(path)).content)).toEqual(['1', '2'])
    expect((await readLocalSnapshot(path)).content).toContain('edited')
  })

  it('a sidecar-only change also invalidates a stale content commit', async () => {
    await saveLocalReplica(path, plan([1, 'A']), { importing: true, now: 1000 })
    const stale = await readLocalSnapshot(path)
    await idbSet('meta', 'local:planner.md.sync.json', { content: 'new metadata', mtime: 2 })
    expect(await commitLocalSnapshot(path, stale, plan(), stale.rawSidecar)).toBe(false)
    expect((await readLocalSnapshot(path)).content).toContain('A')
  })

  it('commits no keys if any expected value changed', async () => {
    await idbSet('meta', 'a', 1)
    await idbSet('meta', 'b', 2)
    expect(await idbCompareAndSet('meta', [['a', 1], ['b', 9]], [['a', 3], ['b', 4]])).toBe(false)
    expect(await idbGet('meta', 'a')).toBe(1)
    expect(await idbGet('meta', 'b')).toBe(2)
  })

  it('keeps a row imported from the worker while saving an edit based on an older active copy', async () => {
    const before = plan([1, 'A'])
    await saveLocalReplica(path, plan([1, 'A'], [2, 'remote addition']), { importing: true, now: 1000 })
    const merged = await saveLocalReplica(path, plan([1, 'local edit']), { previousContent: before, now: 2000 })
    expect(ids(merged)).toEqual(['1', '2'])
    expect(merged).toContain('local edit')
    expect(merged).toContain('remote addition')
  })

  it('does not turn unchanged stale content into a newer edit on reload', async () => {
    const initial = plan([1, 'A'], [2, 'B'])
    await saveLocalReplica(path, initial, { importing: true, now: 1000 })
    await saveLocalReplica(path, plan([1, 'A']), { previousContent: initial, now: 2000 })
    const merged = await saveLocalReplica(path, initial, { importing: true, now: 3000 })
    expect(ids(merged)).toEqual(['1'])
    expect(JSON.parse((await readLocalSnapshot(path)).rawSidecar).entries['2'].clock).toBe(2000)
  })

  it('explicit edits advance past observed clocks even when the device clock is behind', async () => {
    const original = plan([1, 'A'])
    await saveLocalReplica(path, original, { importing: true, now: 5000 })
    await saveLocalReplica(path, plan([1, 'Edited']), { previousContent: original, now: 1000 })
    const saved = await readLocalSnapshot(path)
    expect(saved.content).toContain('Edited')
    expect(JSON.parse(saved.rawSidecar).entries['1'].clock).toBe(5001)
  })

  it('imports recovered plain file content while preserving the older mirror as a conflict copy', async () => {
    await saveLocalReplica('journal/task-1.md', 'cached')
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await saveLocalReplica('journal/task-1.md', 'recovered', { importing: true })).toBe('recovered')
    const conflict = (await idbKeys('meta')).find(key => key.startsWith('local:sync-conflicts/'))
    expect((await idbGet('meta', conflict)).content).toBe('cached')
    log.mockRestore()
  })
})
