import { describe, expect, it } from 'vitest'
import { reconcileRecordsFile, sidecarPath, frameHasStructure, preferStructuredFrame, framePriorityCount, preferPopulatedPriorityFrame } from './records.js'
import { mdTableCodec } from './codecs/mdTable.js'
import { serializeSidecar } from './merge.js'

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
// Like `plan`, but appends a `## Priorities` section with the given ordered-list
// items (e.g. '1. 191'). An empty array yields a scaffolded, item-less section.
const planP = (priItems, ...rows) =>
  HEADER + rows.join('\n') + '\n\n## Priorities\n\n' +
  (priItems.length ? priItems.join('\n') + '\n' : '')

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

  it('ONEDRIVE CRASH repro: a remote sidecar marking a missing row alive must not crash sync', async () => {
    // Real-world OneDrive failure ("Cannot read properties of undefined (reading
    // 'length')"): the remote sidecar lists a row as alive, but the remote
    // content file no longer contains that row (an inconsistent backup). The
    // merge used to produce an alive record with `undefined` content, which
    // crashed fingerprint() and failed the entire backup.
    const remote = store({
      [PATH]: plan(row(1, 'A')), // row 2 is absent from the content...
      [sidecarPath(PATH)]: serializeSidecar(
        {
          1: { clock: 1000, deleted: false },
          2: { clock: 9000, deleted: false }, // ...but the sidecar says it's alive
          __frame__: { clock: 1000, deleted: false },
        },
        1000,
      ),
    })
    const local = store({ [PATH]: plan(row(1, 'A'), row(2, 'B')) })

    // Must not throw.
    const res = await syncOnce(local, remote, 5000)
    expect(res.content).toContain('A')
    // Local's real row 2 content is preserved rather than wiped by the phantom.
    expect(local.get(PATH)).toContain('B')
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

  it('BLANK-PLANNER BUG: an empty local file must not strip the remote section headings', async () => {
    // Repro of the live plannermd.com corruption: a freshly connected/empty
    // device has an empty planner.md while the cloud holds the real, structured
    // file. The FRAME (section headings) merges by LWW and the empty local frame
    // (stamped `now`) would otherwise beat the remote frame (stamped 0),
    // dropping every `## ` heading and orphaning all rows → blank planner.
    const remoteContent = plan(row(245, 'Amy xfinity'), row(246, 'Amy wifi'))
    const localEmpty = store({ [PATH]: '' })
    const remote = store({ [PATH]: remoteContent })

    await syncOnce(localEmpty, remote, 5000)

    // Local must receive the full structured file, headings intact.
    const got = localEmpty.get(PATH)
    expect(got).toContain('## Today')
    expect(got).toContain('Amy xfinity')
    expect(got).toContain('Amy wifi')
    // Remote must keep its structure (not get clobbered with a headerless blob).
    expect(remote.get(PATH)).toContain('## Today')

    // And it must stay fixed on a follow-up sync (no flip-flop).
    await syncOnce(localEmpty, remote, 6000)
    expect(localEmpty.get(PATH)).toContain('## Today')
  })

  it('PRIORITIES-WIPE BUG: a structured-but-empty-priorities frame must not wipe the list', async () => {
    // Repro of the live plannermd.com data loss: the whole `## Priorities`
    // ordered list lives in the FRAME record. A device whose frame still has all
    // `## ` headings but an EMPTY Priorities section (a freshly-scaffolded source
    // whose plan template is `## Priorities\n\n`, or an external edit that dropped
    // the list) syncs with a newer clock. Its frame passes the structure guard
    // (headings present) yet would erase the user's priorities via LWW.
    const withPriorities = planP(['1. 191', '2. 200', '3. 204'], row(1, 'A'))
    const emptyPriorities = planP([], row(1, 'A')) // same row, scaffolded empty list
    const remote = store({})

    // Device 1 establishes the real priorities on the remote.
    const d1 = store({ [PATH]: withPriorities })
    await syncOnce(d1, remote, 1000)
    expect(remote.get(PATH)).toContain('1. 191')

    // Device 2 (scaffold/empty list) syncs LATER, so its frame wins LWW.
    const d2 = store({ [PATH]: emptyPriorities })
    await syncOnce(d2, remote, 5000)

    // The populated list must survive on the remote and propagate back to d2.
    expect(remote.get(PATH)).toContain('1. 191')
    expect(remote.get(PATH)).toContain('2. 200')
    expect(remote.get(PATH)).toContain('3. 204')
    expect(d2.get(PATH)).toContain('1. 191')

    // Stays fixed on a follow-up sync (no flip-flop back to empty).
    await syncOnce(d2, remote, 6000)
    expect(remote.get(PATH)).toContain('3. 204')
  })
})

describe('frameHasStructure', () => {
  it('is true when a ## heading is present', () => {
    expect(frameHasStructure('## Today\n\n| ID |')).toBe(true)
    expect(frameHasStructure('\n\n## Deferred')).toBe(true)
  })
  it('is false for empty / headerless frames', () => {
    expect(frameHasStructure('')).toBe(false)
    expect(frameHasStructure('\n\n')).toBe(false)
    expect(frameHasStructure('| 1 | row only |')).toBe(false)
    expect(frameHasStructure(null)).toBe(false)
    expect(frameHasStructure(undefined)).toBe(false)
  })
})

describe('preferStructuredFrame', () => {
  it('returns the structured side when the other is empty', () => {
    expect(preferStructuredFrame('', '## Today')).toBe('## Today')
    expect(preferStructuredFrame('## Today', '')).toBe('## Today')
  })
  it('returns null when both are structured (let the merge stand)', () => {
    expect(preferStructuredFrame('## A', '## B')).toBeNull()
  })
  it('returns null when neither is structured', () => {
    expect(preferStructuredFrame('', '')).toBeNull()
    expect(preferStructuredFrame('rows', 'rows')).toBeNull()
  })
})

describe('framePriorityCount', () => {
  const frame = (body) => `## Today\n\n| ID |\n\n## Priorities\n\n${body}`
  it('counts ordered-list items in the Priorities section', () => {
    expect(framePriorityCount(frame('1. 191\n2. 200\n3. 204\n'))).toBe(3)
  })
  it('is 0 for an empty Priorities section', () => {
    expect(framePriorityCount(frame(''))).toBe(0)
    expect(framePriorityCount('## Today\n\n| ID |\n')).toBe(0)
  })
  it('ignores numbered lines outside the Priorities section', () => {
    expect(framePriorityCount('## Today\n\n1. not a priority\n')).toBe(0)
  })
  it('recognizes the legacy Work/Manager Priorities headings', () => {
    expect(framePriorityCount('## Work Priorities\n\n1. 191\n')).toBe(1)
    expect(framePriorityCount('## Manager Priorities\n\n1. 191\n2. 200\n')).toBe(2)
  })
  it('handles non-string input', () => {
    expect(framePriorityCount(null)).toBe(0)
    expect(framePriorityCount(undefined)).toBe(0)
  })
})

describe('preferPopulatedPriorityFrame', () => {
  const withList = '## Priorities\n\n1. 191\n2. 200\n'
  const emptyList = '## Priorities\n\n'
  it('restores the side that still has priorities when the merge emptied them', () => {
    expect(preferPopulatedPriorityFrame(emptyList, withList, emptyList)).toBe(withList)
    expect(preferPopulatedPriorityFrame(withList, emptyList, emptyList)).toBe(withList)
  })
  it('leaves the merge alone when it already kept a populated list', () => {
    expect(preferPopulatedPriorityFrame(emptyList, withList, withList)).toBeNull()
  })
  it('does nothing when neither side has priorities', () => {
    expect(preferPopulatedPriorityFrame(emptyList, emptyList, emptyList)).toBeNull()
  })
  it('keeps the richer list if the merge dropped both sides somehow', () => {
    const longer = '## Priorities\n\n1. 1\n2. 2\n3. 3\n'
    const shorter = '## Priorities\n\n1. 1\n'
    expect(preferPopulatedPriorityFrame(longer, shorter, emptyList)).toBe(longer)
    expect(preferPopulatedPriorityFrame(shorter, longer, emptyList)).toBe(longer)
  })
})
