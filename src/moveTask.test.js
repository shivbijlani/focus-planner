import { describe, expect, it } from 'vitest'

import { computeMoveSet, computeBrokenLinks } from './moveTask.js'

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
