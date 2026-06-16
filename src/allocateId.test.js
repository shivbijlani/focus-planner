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
