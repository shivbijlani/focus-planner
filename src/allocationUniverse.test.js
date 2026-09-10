import { describe, expect, it } from 'vitest'
import { opAddTask, opAddAndPrioritize } from './focusPlanOps.js'
import {
  collectAllocationUniverse,
  taskIdsFromBoard,
  taskIdsFromSyncShadow,
} from './allocationUniverse.js'

// Regression tests for GH #528 and GH #132 — the same invariant, two triggers.
//
// The invariant, at the write path: **before committing a new row, if the
// target ID already exists anywhere in the allocation universe, do not write
// it. Allocate the next genuinely free ID and keep both tasks.**
//
// Why `maxId + 1` cannot be patched into correctness
// --------------------------------------------------
// It is one number, so it cannot carry a safety property. Two replicas that
// each see `max = 482` both deterministically compute `483` — that is a 100%
// collision for any two devices creating a task within one sync interval, not
// a race window that got unlucky. So the tests below never test timing. They
// test membership: given a universe that already contains an ID, allocation
// must step over it.
//
// The test trap this file is written against
// ------------------------------------------
// A single-client test PASSES against the unfixed code, because creating two
// tasks in sequence refreshes `maxId` between calls and can never collide. So
// `two independent writers` below allocates TWICE FROM ONE SNAPSHOT, never
// letting the first write update the second writer's view of the board.

// ── A tiny model of two devices sharing one synced folder ──────────────
//
// Only the parts that matter for allocation: what each replica can see when it
// allocates. `journalIds` and `shadowIds` are separate on purpose — in the live
// 2026-09-09 incident the second device's journal listing was stale by ~30
// minutes while the sync shadow had already moved on, and that difference is
// precisely what decides whether the collision happens.
function makeFolder({ board, completedBoard = '', journalIds = [], shadowIds = [] }) {
  return {
    board,
    completedBoard,
    journalIds: new Set(journalIds),
    // The shadow is a real `planner.md.sync.json`, tombstones and all.
    shadow: JSON.stringify({
      version: 1,
      updatedAt: 1787621820553,
      entries: Object.fromEntries(
        shadowIds.map(id => [String(id), { clock: 1787621820553, deleted: false, fp: 1 }]),
      ),
    }),
  }
}

// What a replica hands to `opAddTask` — read at write time, exactly as
// `buildAllocationUniverse` in App.jsx does.
function universeFor(folder) {
  return collectAllocationUniverse({
    boards: [folder.completedBoard],
    shadows: [folder.shadow],
    journalIds: folder.journalIds,
  })
}

const ADD = { priority: '🟡', linkedTask: '', section: 'Today' }

const rowIds = (content) => [...content.matchAll(/^\|\s*(\d+)[\s,|]/gm)].map(m => Number(m[1]))

describe('two independent writers allocating from one stale snapshot (GH #528)', () => {
  // The board both devices are holding. Neither has seen the other's new row.
  const SNAPSHOT = [
    '# Focus Plan',
    '',
    '## Today',
    '',
    '| ID | 🎯 | Task | Mngr Priority | Added | Linked ID |',
    '|---|---|------|---------------|-------|-----------|',
    '| 482 | 🟡 | Linked in engagement specialist | - | 2026-09-10 | 204 |',
    '| 228 | 🟡 | Nov 2026 Dubai trip | - | 2026-08-02 | |',
    '',
  ].join('\n')

  // Device A creates a task, then its shadow entry syncs out. Its *journal*
  // has not reached device B yet — the stale-listing condition measured live.
  function afterFirstWriter() {
    const folder = makeFolder({ board: SNAPSHOT, journalIds: [482, 228], shadowIds: [482, 228] })
    const a = opAddTask(SNAPSHOT, { ...ADD, task: 'Dubai itinerary, day by day' }, universeFor(folder))
    return {
      a,
      // Only the shadow has caught up. This is the whole point: the second
      // device must still refuse the ID.
      synced: makeFolder({
        board: SNAPSHOT,
        journalIds: [482, 228],
        shadowIds: [482, 228, a.newId],
      }),
    }
  }

  it('gives the two writers different IDs', () => {
    const { a, synced } = afterFirstWriter()
    // B allocates from the SAME stale SNAPSHOT — it never saw A's row.
    const b = opAddTask(SNAPSHOT, { ...ADD, task: 'Book the Abu Dhabi hotel' }, universeFor(synced))

    expect(a.newId).toBe(483)
    expect(b.newId).toBe(484)
    expect(b.newId).not.toBe(a.newId)
  })

  it('keeps both tasks — neither row is overwritten', () => {
    const { a, synced } = afterFirstWriter()
    const b = opAddTask(SNAPSHOT, { ...ADD, task: 'Book the Abu Dhabi hotel' }, universeFor(synced))

    // Each device wrote its own copy; the sync layer merges them by row ID.
    // Distinct IDs is what makes that merge lossless, so assert the merged
    // result carries both tasks rather than one silently replacing the other.
    const merged = new Map()
    for (const content of [a.content, b.content]) {
      for (const line of content.split('\n')) {
        const m = line.match(/^\|\s*(\d+)\s*\|/)
        if (m) merged.set(Number(m[1]), line)
      }
    }
    expect(merged.get(a.newId)).toContain('Dubai itinerary, day by day')
    expect(merged.get(b.newId)).toContain('Book the Abu Dhabi hotel')
    // Both pre-existing rows survive untouched.
    expect(merged.get(482)).toContain('Linked in engagement specialist')
    expect(merged.get(228)).toContain('Nov 2026 Dubai trip')
    expect(merged.size).toBe(4)
  })

  it('leaves the rest of the board byte-identical', () => {
    const { a } = afterFirstWriter()
    const before = SNAPSHOT.split('\n')
    const after = a.content.split('\n')
    // Exactly one line added, and every original line survives verbatim and in
    // order — the added row is the only difference.
    expect(after).toHaveLength(before.length + 1)
    expect(after.filter(line => !line.includes('Dubai itinerary, day by day'))).toEqual(before)
  })
})

describe('an ID that only exists on the completed board is never reallocated (GH #132)', () => {
  // The live collision: #392 "billion heartbeats video" was completed
  // 2026-07-29 and left the active board; #392 "Buy dhol from Nagi" was created
  // 2026-07-30 and got the same number. Note there is deliberately no
  // `journal/task-392.md` here — the issue's repro is explicit that the reuse
  // happens when no journal lingers to accidentally cover the gap.
  const ACTIVE = [
    '## Today',
    '',
    '| ID | 🎯 | Task | Mngr Priority | Added | Linked ID |',
    '|---|---|------|---------------|-------|-----------|',
    '| 391 | 🟡 | Existing task | - | 2026-07-28 | |',
    '',
  ].join('\n')

  const COMPLETED = [
    '# Completed Tasks',
    '',
    '## Week of 2026-07-27',
    '',
    '| ID | 🎯 | Task | Mngr Priority | Added |',
    '|---|---|------|---------------|-------|',
    '| 392 | ✅ | billion heartbeats video | - | 2026-07-29 |',
    '',
  ].join('\n')

  it('skips the completed ID and allocates the next free one', () => {
    const folder = makeFolder({ board: ACTIVE, completedBoard: COMPLETED, journalIds: [391] })
    const r = opAddTask(ACTIVE, { ...ADD, task: 'Buy dhol from Nagi (daman)' }, universeFor(folder))
    expect(r.newId).toBe(393)
  })

  it('recognises a completed row that carries an external ticket link', () => {
    // Completed rows share the active board's cell grammar, including
    // `392,[170](url)`. A parser that only accepted a bare number would read
    // this row as "not a task" and hand 392 out again.
    const linked = COMPLETED.replace(
      '| 392 | ✅ |',
      '| 392,[170](https://example.com/170) | ✅ |',
    )
    const folder = makeFolder({ board: ACTIVE, completedBoard: linked, journalIds: [391] })
    const r = opAddTask(ACTIVE, { ...ADD, task: 'Buy dhol from Nagi (daman)' }, universeFor(folder))
    expect(r.newId).toBe(393)
  })

  it('does not let the completed board become the source of the maximum', () => {
    // Membership, never maximum. A completed board holding a junk high ID must
    // reserve that number without dragging every future task up to it.
    const junk = COMPLETED.replace('| 392 |', '| 426592 |')
    const folder = makeFolder({ board: ACTIVE, completedBoard: junk, journalIds: [391] })
    const r = opAddTask(ACTIVE, { ...ADD, task: 'Next task' }, universeFor(folder))
    expect(r.newId).toBe(392)
  })
})

describe('an ID that only exists as a journal file is never reallocated', () => {
  const ACTIVE = [
    '## Today',
    '',
    '| ID | 🎯 | Task | Mngr Priority | Added | Linked ID |',
    '|---|---|------|---------------|-------|-----------|',
    '| 391 | 🟡 | Existing task | - | 2026-07-28 | |',
    '',
  ].join('\n')

  it('skips it on the add path', () => {
    // `journal/task-392.md` exists with no row on either board.
    const folder = makeFolder({ board: ACTIVE, journalIds: [391, 392] })
    const r = opAddTask(ACTIVE, { ...ADD, task: 'New task' }, universeFor(folder))
    expect(r.newId).toBe(393)
  })

  it('skips it on the add-and-prioritize path', () => {
    // Third write path onto the board, named in #132 alongside handleAddTask.
    const folder = makeFolder({ board: ACTIVE, journalIds: [391, 392] })
    const r = opAddAndPrioritize(ACTIVE, 'New task', 'Sydney rollout', universeFor(folder))
    expect(r.newId).toBe(393)
  })

  it('reaches the add-and-prioritize path through the full universe too', () => {
    // The discriminating half of the above: pre-fix this site was handed the
    // journal IDs alone, so an ID that only ever appears on the completed board
    // was invisible to it. Same allocation universe as the add path, or #132
    // is only half fixed.
    const completed = [
      '# Completed Tasks',
      '',
      '## Week of 2026-07-27',
      '',
      '| ID | 🎯 | Task | Mngr Priority | Added |',
      '|---|---|------|---------------|-------|',
      '| 392 | ✅ | billion heartbeats video | - | 2026-07-29 |',
      '',
    ].join('\n')
    const folder = makeFolder({ board: ACTIVE, completedBoard: completed, journalIds: [391] })
    const r = opAddAndPrioritize(ACTIVE, 'New task', 'Sydney rollout', universeFor(folder))
    expect(r.newId).toBe(393)
    expect(new Set(rowIds(r.content)).size).toBe(rowIds(r.content).length)
  })
})

describe('the allocation universe is membership, never a maximum', () => {
  it('counts sync-shadow tombstones as taken', () => {
    // A deleted ID that comes back from another replica must not re-attach to
    // a different task, so `deleted: true` still reserves the number.
    const shadow = JSON.stringify({
      version: 1,
      entries: {
        434: { clock: 1, deleted: true, fp: -1 },
        462: { clock: 1, deleted: false, fp: 1 },
      },
    })
    expect(taskIdsFromSyncShadow(shadow)).toEqual(new Set([434, 462]))
  })

  it('does not let the shadow\u2019s junk 426xxx IDs inflate numbering', () => {
    // The live shadow carries 426565 / 426566 / 426592 from an old orphaned
    // journal incident. Taking max() across the universe would number the next
    // task 426593 and every task after it. Walking up from contentMax never
    // reaches them.
    const board = [
      '## Today',
      '',
      '| ID | 🎯 | Task | Mngr Priority | Added | Linked ID |',
      '|---|---|------|---------------|-------|-----------|',
      '| 482 | 🟡 | Existing | - | 2026-09-09 | |',
      '',
    ].join('\n')
    const folder = makeFolder({ board, journalIds: [482], shadowIds: [426565, 426566, 426592, 482] })
    const r = opAddTask(board, { ...ADD, task: 'New task' }, universeFor(folder))
    expect(r.newId).toBe(483)
  })

  it('survives a truncated or half-written shadow without failing the write', () => {
    // A partial sync file must not take allocation down, and must not be read
    // as "everything is free" in a way that stops the other members applying.
    expect(taskIdsFromSyncShadow('{"entries":{"4')).toEqual(new Set())
    expect(taskIdsFromSyncShadow('')).toEqual(new Set())
    expect(taskIdsFromSyncShadow(null)).toEqual(new Set())
    const universe = collectAllocationUniverse({
      shadows: ['{"entries":{"4'],
      journalIds: [391],
    })
    expect(universe).toEqual(new Set([391]))
  })

  it('ignores header and separator rows when reading a board', () => {
    const board = [
      '| ID | 🎯 | Task |',
      '|---|---|------|',
      '| --- | --- | --- |',
      '| 12 | 🟡 | Real row |',
      'not a table row',
    ].join('\n')
    expect(taskIdsFromBoard(board)).toEqual(new Set([12]))
  })

  it('unions every member into one skip set', () => {
    const universe = collectAllocationUniverse({
      boards: ['| 1 | 🟡 | a |'],
      shadows: [JSON.stringify({ entries: { 2: { deleted: true } } })],
      journalIds: [3],
      extraIds: ['4'],
    })
    expect(universe).toEqual(new Set([1, 2, 3, 4]))
  })

  it('degrades safely when a folder has no completed board or shadow yet', () => {
    // Every read is individually optional: a missing file yields a smaller
    // universe, not a wrong answer.
    expect(collectAllocationUniverse({ boards: [''], shadows: [''], journalIds: [7] }))
      .toEqual(new Set([7]))
    expect(collectAllocationUniverse()).toEqual(new Set())
  })
})
