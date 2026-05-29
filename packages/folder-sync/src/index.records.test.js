import { describe, expect, it } from 'vitest'

import { createFolderSync } from './index.js'
import { mdTableCodec } from './codecs/mdTable.js'

// End-to-end regression for the reported bug: a row deleted on one device must
// not be resurrected when a *stale* second device later pushes its old copy.
// This drives the real engine (createFolderSync) with record-level codecs and a
// shared in-memory "remote" that both devices read/write, mimicking OneDrive.

function memoryStorage() {
  const data = new Map()
  return {
    get length() { return data.size },
    key(i) { return Array.from(data.keys())[i] ?? null },
    getItem(k) { return data.has(k) ? data.get(k) : null },
    setItem(k, v) { data.set(k, String(v)) },
    removeItem(k) { data.delete(k) },
    clear() { data.clear() },
  }
}

function memoryStore(initial = {}) {
  const files = new Map(Object.entries(initial))
  return {
    read: async p => files.get(p) ?? '',
    write: async (p, c) => { files.set(p, c) },
    listPaths: async () => Array.from(files.keys()).sort(),
    set: (p, c) => files.set(p, c),
    get: p => files.get(p),
  }
}

// Shared remote backing store (stands in for OneDrive). Throws on missing read
// so the engine's safe-read wrappers exercise the same path as a real provider.
function sharedRemote() {
  const files = new Map()
  let seq = 0
  return {
    files,
    api: {
      write: async (p, c) => { seq += 1; files.set(p, { content: c, etag: `e${seq}`, mtime: new Date(Date.now() + seq * 1000).toISOString() }) },
      read: async (p) => { if (!files.has(p)) throw new Error('404'); return files.get(p).content },
      remove: async (p) => { files.delete(p) },
      list: async () => Array.from(files.entries()).map(([p, v]) => ({ path: p, etag: v.etag, mtime: v.mtime })),
    },
  }
}

function device(remoteApi, initial = {}, clock) {
  const store = memoryStore(initial)
  const target = {
    id: 'onedrive',
    label: 'onedrive',
    restore: async () => true,
    connect: async () => true,
    write: remoteApi.write,
    remove: remoteApi.remove,
    read: remoteApi.read,
    list: remoteApi.list,
  }
  const sync = createFolderSync({
    storage: memoryStorage(),
    configKey: 'config',
    metaPrefix: 'meta:',
    pendingKey: 'pending',
    clock,
    recordCodecs: { 'focus-plan.md': mdTableCodec },
    localFolders: [{ id: 'browser', name: 'Browser Storage', store, targets: [target] }],
  })
  return { sync, store }
}

const plan = (rows) => `## Today

| ID | 🎯 | Task | Priority | Added | Linked ID |
|---|---|------|----------|-------|----------|
${rows.join('\n')}

## Priorities

1. 70
`

const ROW_70 = '| 70 | 🟡 | First task | Sydney | 2026-01-27 | |'
const ROW_71 = '| 71 | 🔴 | Second task | Vibe | 2026-01-28 | |'
const ROW_72 = '| 72 | ⚪ | Third task | - | 2026-01-29 | |'

describe('engine record sync — delete does not resurrect across devices', () => {
  it('a stale device pushing its old copy cannot bring back a deleted row', async () => {
    const remote = sharedRemote()
    // Monotonic logical clock: each operation happens at a distinct time, as
    // it would in the real world (edits seconds/minutes apart).
    let t = 1000
    const clock = () => (t += 1000)

    // Device A seeds the remote with three rows.
    const A = device(remote.api, { 'focus-plan.md': plan([ROW_70, ROW_71, ROW_72]) }, clock)
    await A.sync.connectTarget('browser', 'onedrive')
    expect(await remote.api.read('focus-plan.md')).toContain('Second task')

    // Device B pulls the three rows.
    const B = device(remote.api, {}, clock)
    await B.sync.connectTarget('browser', 'onedrive')
    expect(B.store.get('focus-plan.md')).toContain('Second task')

    // On B (mobile), the user deletes row 71.
    B.store.set('focus-plan.md', plan([ROW_70, ROW_72]))
    await B.sync.markDirty('focus-plan.md', 'write', 'browser')
    await B.sync.syncNow('browser', 'onedrive')
    expect(await remote.api.read('focus-plan.md')).not.toContain('Second task')

    // Device A is stale: it never pulled and still has row 71 locally. It now
    // pushes. Under the OLD whole-file LWW this resurrected 71; record-level
    // merge sees B's tombstone (newer) and keeps 71 deleted everywhere.
    await A.sync.markDirty('focus-plan.md', 'write', 'browser')
    await A.sync.syncNow('browser', 'onedrive')

    const remoteFinal = await remote.api.read('focus-plan.md')
    expect(remoteFinal).not.toContain('Second task')
    expect(remoteFinal).toContain('First task')
    expect(remoteFinal).toContain('Third task')

    // A's own local copy converges (row 71 dropped) on the next reconcile.
    expect(A.store.get('focus-plan.md')).not.toContain('Second task')
  })

  it('concurrent edits on different rows both survive', async () => {
    const remote = sharedRemote()
    let t = 1000
    const clock = () => (t += 1000)
    const A = device(remote.api, { 'focus-plan.md': plan([ROW_70, ROW_71]) }, clock)
    await A.sync.connectTarget('browser', 'onedrive')
    const B = device(remote.api, {}, clock)
    await B.sync.connectTarget('browser', 'onedrive')

    // A edits row 70, B edits row 71, then both sync.
    A.store.set('focus-plan.md', plan(['| 70 | 🟡 | First task EDITED | Sydney | 2026-01-27 | |', ROW_71]))
    await A.sync.markDirty('focus-plan.md', 'write', 'browser')
    await A.sync.syncNow('browser', 'onedrive')

    B.store.set('focus-plan.md', plan([ROW_70, '| 71 | 🔴 | Second task EDITED | Vibe | 2026-01-28 | |']))
    await B.sync.markDirty('focus-plan.md', 'write', 'browser')
    await B.sync.syncNow('browser', 'onedrive')

    const remoteFinal = await remote.api.read('focus-plan.md')
    expect(remoteFinal).toContain('First task EDITED')
    expect(remoteFinal).toContain('Second task EDITED')
  })
})
