import { describe, expect, it } from 'vitest'

import {
  computeMoveSet, computeBrokenLinks,
  renumberMovedRows, maxTaskIdInRows, rewriteRowId, parseLocalId, retitleJournal,
} from './moveTask.js'

describe('computeMoveSet', () => {
  it('returns just the task itself when it is not a manager priority', () => {
    const moving = computeMoveSet('5', {}, { '5': '10' }, ['1', '5', '10'])
    expect([...moving]).toEqual(['5'])
  })

  it('pulls every descendant of a manager priority into the move set', () => {
    // 1 -> 2 -> 3 (manager priority); 4 unrelated
    const linkedIdMap = { '1': '2', '2': '3' }
    const managerPriorities = { '3': 1 }
    const moving = computeMoveSet('3', managerPriorities, linkedIdMap, ['1', '2', '3', '4'])
    expect([...moving].sort()).toEqual(['1', '2', '3'])
  })

  it('does not pull in tasks that resolve to a different manager priority', () => {
    // 1 -> 2 (priority A); 3 -> 4 (priority B)
    const linkedIdMap = { '1': '2', '3': '4' }
    const managerPriorities = { '2': 1, '4': 2 }
    const moving = computeMoveSet('2', managerPriorities, linkedIdMap, ['1', '2', '3', '4'])
    expect([...moving].sort()).toEqual(['1', '2'])
  })

  it('returns an empty set for a missing task ID', () => {
    expect(computeMoveSet(null, {}, {}, []).size).toBe(0)
  })
})

describe('computeBrokenLinks', () => {
  it('flags incoming links from tasks that are staying behind', () => {
    // 7 -> 5 will break if 5 moves but 7 stays
    const linkedIdMap = { '7': '5', '8': '9' }
    const taskLookup = { '7': 'Task seven', '8': 'Task eight' }
    const broken = computeBrokenLinks(new Set(['5']), linkedIdMap, taskLookup)
    expect(broken).toEqual([{ fromId: '7', fromName: 'Task seven', toId: '5' }])
  })

  it('does not flag links between two moving tasks', () => {
    const linkedIdMap = { '1': '2', '2': '3' }
    const broken = computeBrokenLinks(new Set(['1', '2', '3']), linkedIdMap, {})
    expect(broken).toEqual([])
  })

  it('returns an empty list when nothing links to the moving tasks', () => {
    const linkedIdMap = { '1': '99' }
    const broken = computeBrokenLinks(new Set(['5']), linkedIdMap, {})
    expect(broken).toEqual([])
  })
})

describe('parseLocalId / maxTaskIdInRows', () => {
  it('parses a plain and an ADO-suffixed ID cell', () => {
    expect(parseLocalId('271')).toBe('271')
    expect(parseLocalId('426576,[419965](https://x/419965)')).toBe('426576')
  })

  it('finds the max local task ID across rows, ignoring header/separator', () => {
    const content = [
      '## Today',
      '| ID | 🎯 | Task | P | Added | Linked ID |',
      '|---|---|---|---|---|---|',
      '| 5 | 🟡 | A | - | d | |',
      '| 12,[999](u) | 🟡 | B | - | d | |',
      '| 9 | 🟡 | C | - | d | |',
    ].join('\n')
    expect(maxTaskIdInRows(content)).toBe(12)
  })
})

describe('rewriteRowId', () => {
  it('replaces the local ID and preserves an ADO suffix', () => {
    const row = '| 426576,[419965](https://x/419965) | 🟡 | Task | - | 2026-06-16 | 192 |'
    const out = rewriteRowId(row, '262', new Map())
    expect(out).toContain('| 262,[419965](https://x/419965) |')
    expect(out).toContain('| 192 |') // linked id untouched (not in map)
  })

  it('remaps a linked ID that points at another moving task', () => {
    const row = '| 426588 | 🟡 | Task | - | 2026-06-16 | 426587 |'
    const idMap = new Map([['426587', '272'], ['426588', '273']])
    const out = rewriteRowId(row, '273', idMap)
    expect(out).toContain('| 273 |')
    expect(out).toContain('| 272 |')
  })
})

describe('renumberMovedRows', () => {
  it('renumbers moved rows into the target sequence (no foreign IDs cross)', () => {
    const movingRows = [
      { taskId: '426587', rawLine: '| 426587 | 🟡 | Food tracker | - | 2026-06-16 | |' },
      { taskId: '426588', rawLine: '| 426588 | 🟡 | Llm | - | 2026-06-16 | 426587 |' },
    ]
    // Target folder's own max is 271.
    const { idMap, rows } = renumberMovedRows(movingRows, 271)
    expect(idMap.get('426587')).toBe('272')
    expect(idMap.get('426588')).toBe('273')
    expect(rows[0].newRawLine).toContain('| 272 |')
    // Within-set link remapped 426587 -> 272.
    expect(rows[1].newRawLine).toContain('| 273 |')
    expect(rows[1].newRawLine).toContain('| 272 |')
  })

  it('skips target IDs already taken by an existing journal', () => {
    const movingRows = [{ taskId: '900', rawLine: '| 900 | 🟡 | X | - | d | |' }]
    const { idMap } = renumberMovedRows(movingRows, 271, new Set([272, 273]))
    expect(idMap.get('900')).toBe('274')
  })
})

describe('retitleJournal', () => {
  it('rewrites the task heading to the new ID', () => {
    expect(retitleJournal('# Task 426580: Parade\n\nbody', '266'))
      .toBe('# Task 266: Parade\n\nbody')
  })
})
