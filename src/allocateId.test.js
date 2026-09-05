import { describe, expect, it } from 'vitest'
import { allocateNextId, opAddTask } from './focusPlanOps.js'

// Regression tests for the "IDs jumped into the 426xxx range" bug.
//
// Numbering must be driven by the planner's own task rows. Existing journal
// IDs are only a collision-skip set, so a stray/foreign high-numbered journal
// (e.g. one copied in from another folder, or left behind by an old task) can
// never inflate the numbering.
describe('allocateNextId', () => {
  it('numbers from the content max, ignoring a foreign high journal ID', () => {
    // A polluted journal folder contains task-426586.md from another folder.
    const journalIds = new Set([426586, 426585, 271])
    // The planner itself only goes up to 271.
    expect(allocateNextId(271, journalIds)).toBe(272)
  })

  it('skips an ID that already has a journal (collision avoidance)', () => {
    const journalIds = new Set([272, 273])
    expect(allocateNextId(271, journalIds)).toBe(274)
  })

  it('works with no journal set', () => {
    expect(allocateNextId(259)).toBe(260)
    expect(allocateNextId(0)).toBe(1)
  })

  it('ignores a legacy numeric argument (old call shape)', () => {
    // Old callers passed the journal *max* as a number; it must be ignored now.
    expect(allocateNextId(259, 426586)).toBe(260)
  })

  // GH #528. `contentMaxId` is one number, so it cannot be a safety property:
  // if it is ever computed too low, `contentMaxId + 1` names a LIVE task.
  it('skips IDs that are live in the content even when contentMaxId is stale', () => {
    const inContent = new Set([471, 472, 473, 474])
    // A stale snapshot reports the max as 470 while 471-474 are really there.
    expect(allocateNextId(470, new Set(), inContent)).toBe(475)
  })

  it('skips the union of content IDs and journal IDs', () => {
    // 471-474 are live rows, 475-476 have journals: the first genuinely free
    // ID is 477.
    expect(allocateNextId(470, new Set([475, 476]), new Set([471, 472, 473, 474]))).toBe(477)
  })

  it('still works when no content set is supplied (old call shape)', () => {
    expect(allocateNextId(271, new Set([272]))).toBe(273)
  })
})

describe('opAddTask resists journal-driven ID inflation', () => {
  const plan = [
    '## Today',
    '',
    '| ID | 🎯 | Task | Priority | Added | Linked ID |',
    '|---|---|------|----------|-------|-----------|',
    '| 271 | 🟡 | Existing | - | 2026-06-16 | |',
    '',
  ].join('\n')

  it('continues from the planner max even when a 426xxx journal lingers', () => {
    const journalIds = new Set([426586, 426585, 426575])
    const r = opAddTask(plan, { task: 'New', priority: '🟡', linkedTask: '', section: 'Today' }, journalIds)
    expect(r.newId).toBe(272)
    expect(r.content).toContain('| 272 | 🟡 | New |')
  })
})

// GH #528 -- adding a task reused a LIVE task's ID and destroyed that task's row.
//
// Reproduces the exact live failure of 2026-09-05: the board carried 471-474,
// the app allocated 471, and the user-authored "Potential Turkey vacation" row
// was silently replaced. No dialog, no console error -- the only symptom was a
// task the user had written that morning quietly ceasing to exist.
describe('opAddTask never reuses a live task ID (GH #528)', () => {
  // A ragged first cell defeats the maxId scan for row 474, so `maxId` comes
  // back low while 474 is plainly alive in the content. This is the shape of
  // the bug -- a maxId that disagrees with the rows actually present -- without
  // depending on how the app came to hold a stale copy.
  const board = [
    '## Today',
    '',
    '| ID | 🎯 | Task | Priority | Added | Linked ID |',
    '|---|---|------|----------|-------|-----------|',
    '| 473 | 🟡 | Health, Wellness and Nutrition coaching | - | 2026-09-05 | 370 |',
    '| 472 | 🔴 | Plan my day | - | 2026-09-05 | 370 |',
    '',
    '## Deferred',
    '',
    '| ID | 🎯 | Task | Priority | Added | Wake | Linked ID |',
    '| --- | --- | ------ | --------------- | ------- | ---- | ----------- |',
    '| 474 | 🟡 | Social diary | - | 2026-09-05 |  | 191 |',
    '| 471 | 🟡 | Potential Turkey vacation | - | 2026-09-05 |  | 234 |',
    '| 470 | 🟡 | Spec updater automation | - | 2026-09-03 |  | 463 |',
    '',
  ].join('\n')

  it('allocates past every live row instead of colliding with one', () => {
    const r = opAddTask(
      board,
      { task: 'Daily fitness + nutrition coach', priority: '🟡', linkedTask: '473', section: 'Deferred' },
      new Set(),
    )
    expect(r.newId).toBe(475)
  })

  it('leaves every pre-existing row intact', () => {
    const r = opAddTask(
      board,
      { task: 'Daily fitness + nutrition coach', priority: '🟡', linkedTask: '473', section: 'Deferred' },
      new Set(),
    )
    // The row that was destroyed live must survive, verbatim.
    expect(r.content).toContain('| 471 | 🟡 | Potential Turkey vacation |')
    expect(r.content).toContain('| 472 | 🔴 | Plan my day |')
    expect(r.content).toContain('| 473 | 🟡 | Health, Wellness and Nutrition coaching |')
    expect(r.content).toContain('| 474 | 🟡 | Social diary |')
    // Exactly one row gained (5 existing + 1 new), and no ID appears twice.
    const ids = [...r.content.matchAll(/^\| (\d+) /gm)].map(m => m[1])
    expect(ids).toHaveLength(6)
    expect(new Set(ids).size).toBe(6)
  })

  it('skips an ID whose journal exists even when no row uses it', () => {
    const r = opAddTask(
      board,
      { task: 'Another', priority: '🟡', linkedTask: '', section: 'Today' },
      new Set([475, 476]),
    )
    expect(r.newId).toBe(477)
  })
})
