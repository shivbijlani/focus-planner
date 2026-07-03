import { describe, expect, it } from 'vitest'

import { sortTasksByPriority, isNeededForUrgentTask } from './taskSort.js'

function makeTask(id, priority = '🟡', linkedId = null) {
  return {
    ID: { id: String(id), linkedId },
    '🎯': priority,
    Task: `Task ${id}`,
  }
}

describe('sortTasksByPriority', () => {
  it('orders dependency chains prerequisite-first within the same manager priority', () => {
    const rows = [
      makeTask('3', '🟡'),
      makeTask('1', '🟡', '2'),
      makeTask('2', '🟡', '3'),
    ]
    const rawLines = rows.map((_, index) => `raw-${index}`)
    const headers = ['ID', '🎯', 'Task']
    const linkedIdMap = { '1': '2', '2': '3' }
    const managerPriorities = { '3': 1 }

    const { sortedRows } = sortTasksByPriority(rows, rawLines, headers, linkedIdMap, managerPriorities)

    expect(sortedRows.map(row => row.ID.id)).toEqual(['1', '2', '3'])
  })

  it('keeps manager priority order ahead of dependency depth', () => {
    const rows = [
      makeTask('10', '🟡', '11'),
      makeTask('11', '🟡'),
      makeTask('20', '🟡'),
    ]
    const rawLines = rows.map((_, index) => `raw-${index}`)
    const headers = ['ID', '🎯', 'Task']
    const linkedIdMap = { '10': '11' }
    const managerPriorities = { '20': 1, '11': 2 }

    const { sortedRows } = sortTasksByPriority(rows, rawLines, headers, linkedIdMap, managerPriorities)

    expect(sortedRows.map(row => row.ID.id)).toEqual(['20', '10', '11'])
  })

  it('still floats red urgent items above non-red items', () => {
    const rows = [
      makeTask('1', '🟡', '3'),
      makeTask('2', '🔴'),
      makeTask('3', '🟡'),
    ]
    const rawLines = rows.map((_, index) => `raw-${index}`)
    const headers = ['ID', '🎯', 'Task']
    const linkedIdMap = { '1': '3' }
    const managerPriorities = { '3': 1 }

    const { sortedRows } = sortTasksByPriority(rows, rawLines, headers, linkedIdMap, managerPriorities)

    expect(sortedRows.map(row => row.ID.id)).toEqual(['2', '1', '3'])
  })

  it('falls back to eisenhower priority when manager priority and depth match', () => {
    const rows = [
      makeTask('1', '⚪'),
      makeTask('2', '🐸'),
      makeTask('3', '🟡'),
    ]
    const rawLines = rows.map((_, index) => `raw-${index}`)
    const headers = ['ID', '🎯', 'Task']

    const { sortedRows } = sortTasksByPriority(rows, rawLines, headers, {}, {}, '2026-07-03')

    expect(sortedRows.map(row => row.ID.id)).toEqual(['2', '3', '1'])
  })

  it('sorts actively snoozed tasks below non-snoozed tasks', () => {
    const rows = [
      { ...makeTask('1', '🔴'), snoozeUntil: '2026-07-06' },
      makeTask('2', '🟡'),
      makeTask('3', '⚪'),
    ]
    const rawLines = rows.map((_, index) => `raw-${index}`)
    const headers = ['ID', '🎯', 'Task']

    const { sortedRows } = sortTasksByPriority(rows, rawLines, headers, {}, {}, '2026-07-03')

    expect(sortedRows.map(row => row.ID.id)).toEqual(['2', '3', '1'])
  })

  it('reads snooze markers from raw task rows during sorting', () => {
    const rows = [
      makeTask('1', '🔴'),
      makeTask('2', '🟡'),
    ]
    const rawLines = [
      '| 1 | 🔴 | Task 1 | - | 2026-07-03 | | <!-- snooze:2026-07-06 -->',
      '| 2 | 🟡 | Task 2 | - | 2026-07-03 | |',
    ]
    const headers = ['ID', '🎯', 'Task']

    const { sortedRows } = sortTasksByPriority(rows, rawLines, headers, {}, {}, '2026-07-03')

    expect(sortedRows.map(row => row.ID.id)).toEqual(['2', '1'])
  })

  it('treats expired snoozes as normal tasks', () => {
    const rows = [
      { ...makeTask('1', '🔴'), snoozeUntil: '2020-01-01' },
      makeTask('2', '🟡'),
    ]
    const rawLines = rows.map((_, index) => `raw-${index}`)
    const headers = ['ID', '🎯', 'Task']

    const { sortedRows } = sortTasksByPriority(rows, rawLines, headers, {}, {})

    expect(sortedRows.map(row => row.ID.id)).toEqual(['1', '2'])
  })

  it('handles cyclic links without crashing and preserves a stable order when ties remain', () => {
    const rows = [
      makeTask('1', '🟡', '2'),
      makeTask('2', '🟡', '1'),
      makeTask('3', '🟡'),
    ]
    const rawLines = rows.map((_, index) => `raw-${index}`)
    const headers = ['ID', '🎯', 'Task']
    const linkedIdMap = { '1': '2', '2': '1' }

    const { sortedRows } = sortTasksByPriority(rows, rawLines, headers, linkedIdMap, {})

    expect(sortedRows.map(row => row.ID.id)).toEqual(['1', '2', '3'])
  })

  it('resolves manager priority across chains longer than 5 hops', () => {
    // Regression: 323 → 321 → 316 → 313 → 219 → 208 (where 208 is the
    // manager priority). With the old maxDepth=5 cap, 323 would fail to
    // resolve and sort below tasks whose chains were short enough to reach
    // their manager priority. Both urgent tasks should now sort together
    // by manager priority, with the prerequisite chain order preserved.
    const rows = [
      makeTask('323', '🔴', '321'),
      makeTask('321', '🔴', '316'),
      makeTask('316', '🔴', '313'),
      makeTask('313', '🔴', '219'),
      makeTask('219', '🔴', '208'),
      makeTask('999', '🔴'),
    ]
    const rawLines = rows.map((_, index) => `raw-${index}`)
    const headers = ['ID', '🎯', 'Task']
    const linkedIdMap = { '323': '321', '321': '316', '316': '313', '313': '219', '219': '208' }
    const managerPriorities = { '208': 1 }

    const { sortedRows } = sortTasksByPriority(rows, rawLines, headers, linkedIdMap, managerPriorities)

    // All chain members resolve to the same manager priority and order by
    // dependency depth (deepest first); 999 has no manager priority so it
    // sorts after the resolved chain.
    expect(sortedRows.map(row => row.ID.id)).toEqual(['323', '321', '316', '313', '219', '999'])
  })
})

describe('isNeededForUrgentTask', () => {
  it('returns true if a task links directly to an urgent task', () => {
    const linkedIdMap = { '1': '2' }
    const taskPriorityLookup = { '2': '🔴' }
    expect(isNeededForUrgentTask('1', linkedIdMap, taskPriorityLookup)).toBe(true)
  })

  it('returns true if a task links indirectly to an urgent task', () => {
    const linkedIdMap = { '1': '2', '2': '3' }
    const taskPriorityLookup = { '3': '🔴' }
    expect(isNeededForUrgentTask('1', linkedIdMap, taskPriorityLookup)).toBe(true)
  })

  it('returns false if no task in the chain is urgent', () => {
    const linkedIdMap = { '1': '2', '2': '3' }
    const taskPriorityLookup = { '2': '🟡', '3': '🟡' }
    expect(isNeededForUrgentTask('1', linkedIdMap, taskPriorityLookup)).toBe(false)
  })

  it('returns false if the current task is urgent but links to non-urgent', () => {
    const linkedIdMap = { '1': '2' }
    const taskPriorityLookup = { '1': '🔴', '2': '🟡' }
    // Note: isNeededForUrgentTask starts from linkedIdMap['1'] = '2'
    expect(isNeededForUrgentTask('1', linkedIdMap, taskPriorityLookup)).toBe(false)
  })

  it('handles cycles without infinite looping', () => {
    const linkedIdMap = { '1': '2', '2': '1' }
    const taskPriorityLookup = { '1': '🟡', '2': '🟡' }
    expect(isNeededForUrgentTask('1', linkedIdMap, taskPriorityLookup)).toBe(false)
  })

  it('returns false for tasks with no links', () => {
    expect(isNeededForUrgentTask('1', {}, {})).toBe(false)
  })
})