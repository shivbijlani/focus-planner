import { describe, expect, it } from 'vitest'

import { sortTasksByPriority } from './taskSort.js'

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

    const { sortedRows } = sortTasksByPriority(rows, rawLines, headers, {}, {})

    expect(sortedRows.map(row => row.ID.id)).toEqual(['2', '3', '1'])
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
})