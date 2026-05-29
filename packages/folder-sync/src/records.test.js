import { describe, expect, it } from 'vitest'
import { reconcileRecordsFile, sidecarPath } from './records.js'
import { mdTableCodec } from './codecs/mdTable.js'

// In-memory store with content + sidecar maps, exposing the closure shape that
// reconcileRecordsFile expects.
function store(initial = {}) {
  const files = new Map(Object.entries(initial))
  return {
    files,
    readContent: async (p) => files.get(p) ?? null,
    writeContent: async (p, c) => { files.set(p, c) },
    readSidecar: async (p) => files.get(p) ?? null,
    writeSidecar: async (p, c) => { files.set(p, c) },
    get: (p) => files.get(p),
  }
}

const HEADER = `## Today

| ID | 🎯 | Task | Priority | Added | Linked ID |
|---|---|------|----------|-------|----------|
`
const row = (id, task) => `| ${id} | 🟡 | ${task} | - | 2026-01-27 | |`
const plan = (...rows) => HEADER + rows.join('\n') + '\n'

const PATH = 'focus-plan.md'

async function syncOnce(localStore, remoteStore, now) {
  return reconcileRecordsFile({
    path: PATH,
    codec: mdTableCodec,
    local: localStore,
    remote: remoteStore,
    now,
  })
}

describe('reconcileRecordsFile — end-to-end record sync', () => {
  it('first push: empty remote receives local content + sidecar', async () => {
    const local = store({ [PATH]: plan(row(1, 'A'), row(2, 'B')) })
    const remote = store({})
    const res = await syncOnce(local, remote, 1000)
    expect(res.changedRemote).toBe(true)
    expect(remote.get(PATH)).toContain('A')
    expect(remote.get(PATH)).toContain('B')
    expect(remote.get(sidecarPath(PATH))).toBeTruthy()
  })

  it('THE BUG, end-to-end: a row deleted on mobile is NOT resurrected by a stale desktop', async () => {
    // Shared starting state synced to both + remote.
    const initial = plan(row(1, 'A'), row(2, 'B'))
    const mobile = store({ [PATH]: initial })
    const desktop = store({ [PATH]: initial })
    const remote = store({})

    // Both devices do an initial sync to establish sidecars on the remote.
    await syncOnce(mobile, remote, 1000)
    await syncOnce(desktop, remote, 1000)

    // Mobile deletes row 2 and syncs (tombstone pushed at t=2000).
    mobile.files.set(PATH, plan(row(1, 'A')))
    await syncOnce(mobile, remote, 2000)
    expect(remote.get(PATH)).not.toContain('B')

    // Desktop is a STALE tab: it still has row 2 locally and never saw the
    // delete. It syncs later (t=3000) — the classic resurrection trigger.
    await syncOnce(desktop, remote, 3000)

    // Row 2 must stay gone on the remote AND be removed from the stale desktop.
    expect(remote.get(PATH)).not.toContain('B')
    expect(desktop.get(PATH)).not.toContain('B')
    expect(remote.get(PATH)).toContain('A')
  })

  it('concurrent edits to different rows both survive', async () => {
    const initial = plan(row(1, 'A'), row(2, 'B'))
    const d1 = store({ [PATH]: initial })
    const d2 = store({ [PATH]: initial })
    const remote = store({})
    await syncOnce(d1, remote, 1000)
    await syncOnce(d2, remote, 1000)

    d1.files.set(PATH, plan(row(1, 'A-edited'), row(2, 'B')))
    await syncOnce(d1, remote, 2000)

    d2.files.set(PATH, plan(row(1, 'A'), row(2, 'B-edited')))
    await syncOnce(d2, remote, 2500) // pulls d1's edit, keeps its own

    expect(remote.get(PATH)).toContain('A-edited')
    expect(remote.get(PATH)).toContain('B-edited')
  })

  it('a new row added on another device propagates down on pull', async () => {
    const initial = plan(row(1, 'A'))
    const d1 = store({ [PATH]: initial })
    const d2 = store({ [PATH]: initial })
    const remote = store({})
    await syncOnce(d1, remote, 1000)
    await syncOnce(d2, remote, 1000)

    d1.files.set(PATH, plan(row(1, 'A'), row(5, 'added')))
    await syncOnce(d1, remote, 2000)

    await syncOnce(d2, remote, 3000)
    expect(d2.get(PATH)).toContain('added')
  })

  it('converges: a second no-op sync changes nothing', async () => {
    const local = store({ [PATH]: plan(row(1, 'A')) })
    const remote = store({})
    await syncOnce(local, remote, 1000)
    const res = await syncOnce(local, remote, 2000)
    expect(res.changedLocal).toBe(false)
    expect(res.changedRemote).toBe(false)
  })
})
