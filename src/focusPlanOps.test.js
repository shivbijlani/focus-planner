import { describe, expect, it } from 'vitest'
import {
  buildCompletedRow,
  completedRowExistsForTask,
  opApplySnoozeTransitions,
  opAppendToCompleted,
  opBridgeLinks,
  opChangeLinkedId,
  opMoveLinesBetweenSections,
  opRemoveTaskFromFocusPlan,
  opRemoveTaskFromFocusPlanResult,
  opSetTaskSnooze,
  opSnoozeTask,
} from './focusPlanOps.js'

const plan = [
  '# Focus Plan',
  '',
  '## Today',
  '',
  '| ID | 🎯 | Task |',
  '|---|---|------|',
  '| 1 | 🟡 | A |',
  '| 2 | 🟡 | B |',
  '| 3 | 🟡 | C |',
  '| 4 | 🟡 | D |',
  '',
  '## Deferred',
  '',
  '| ID | 🎯 | Task |',
  '|---|---|------|',
  '| 9 | ⚪ | X |',
  '',
].join('\n')

describe('buildCompletedRow', () => {
  const today = new Date().toISOString().split('T')[0]

  it('builds a row without an outcome', () => {
    const row = buildCompletedRow({ taskId: '42', taskName: 'Ship the thing', priority: 'P1' })
    expect(row).toBe(`| 42 | ✅ | Ship the thing | P1 | ${today} |`)
  })

  it('stamps the outcome inline on the task cell', () => {
    const row = buildCompletedRow({ taskId: '42', taskName: 'Ship the thing', priority: 'P1', outcome: 'Canceled' })
    expect(row).toContain('· _Canceled_')
    expect(row).toBe(`| 42 | ✅ | Ship the thing · _Canceled_ | P1 | ${today} |`)
  })

  it('appends the outcome after todo items', () => {
    const row = buildCompletedRow({
      taskId: '7', taskName: 'Task', priority: 'P0',
      todoItems: ['step one', 'step two'], outcome: 'Done by me',
    })
    expect(row).toBe(`| 7 | ✅ | Task - step one - step two · _Done by me_ | P0 | ${today} |`)
  })

  it('sanitizes pipes in the outcome so the row cannot break', () => {
    const row = buildCompletedRow({ taskId: '9', taskName: 'X', priority: 'P2', outcome: 'a|b' })
    expect(row).toContain('· _a/b_')
    expect(row.match(/\|/g).length).toBe(6)
  })

  it('ignores an empty/whitespace outcome', () => {
    const row = buildCompletedRow({ taskId: '3', taskName: 'Y', priority: '-', outcome: '   ' })
    expect(row).not.toContain('·')
    expect(row).toBe(`| 3 | ✅ | Y | - | ${today} |`)
  })
})

describe('opMoveLinesBetweenSections', () => {
  it('moves multiple rows from Today to Deferred preserving order', () => {
    const out = opMoveLinesBetweenSections(
      plan,
      ['| 3 | 🟡 | C |', '| 4 | 🟡 | D |'],
      'Today',
      'Deferred',
    )
    const lines = out.split('\n')
    const todayBlock = lines.slice(lines.indexOf('## Today'), lines.indexOf('## Deferred'))
    const deferredBlock = lines.slice(lines.indexOf('## Deferred'))
    expect(todayBlock.join('\n')).not.toContain('| C |')
    expect(todayBlock.join('\n')).not.toContain('| D |')
    expect(todayBlock.join('\n')).toContain('| A |')
    expect(todayBlock.join('\n')).toContain('| B |')
    // C and D appear in Deferred, in caller-supplied order, right under the separator.
    const dLines = deferredBlock.filter(l => l.startsWith('|') && !l.includes('---') && !l.includes('ID'))
    expect(dLines).toEqual([
      '| 3 | 🟡 | C |',
      '| 4 | 🟡 | D |',
      '| 9 | ⚪ | X |',
    ])
  })

  it('is a no-op when rawLines is empty', () => {
    expect(opMoveLinesBetweenSections(plan, [], 'Today', 'Deferred')).toBe(plan)
  })

  it('silently skips lines not present in fromSection', () => {
    const out = opMoveLinesBetweenSections(
      plan,
      ['| 3 | 🟡 | C |', '| 99 | 🟡 | ghost |'],
      'Today',
      'Deferred',
    )
    expect(out).toContain('| 3 | 🟡 | C |')
    expect(out).not.toContain('ghost')
  })
})

describe('opChangeLinkedId', () => {
  it('updates a rendered row from CRLF-backed content', () => {
    const crlfPlan = [
      '| ID | 🎯 | Task | Priority | Added | Linked ID |',
      '|---|---|------|----------|-------|-----------|',
      '| 349 | 🟡 | Overnight agent v2 | - |  |  |',
    ].join('\r\n')

    const out = opChangeLinkedId(
      crlfPlan,
      '| 349 | 🟡 | Overnight agent v2 | - |  |  |',
      '192',
    )

    expect(out).toContain('| 349 | 🟡 | Overnight agent v2 | - |  | 192 |')
  })
})

describe('snooze section moves', () => {
  const snoozePlan = [
    '# Focus Plan',
    '',
    '## Today',
    '',
    '| ID | 🎯 | Task | Work Priority | Added | Linked ID |',
    '|---|---|------|---------------|-------|-----------|',
    '| 1 | 🟡 | Active | - | 2026-07-01 | |',
    '| 2 | 🔴 | Weekend blocker | Ship | 2026-07-02 | 1 |',
    '',
    '## Deferred',
    '',
    '| ID | 🎯 | Task | Work Priority | Added | Linked ID |',
    '|---|---|------|---------------|-------|-----------|',
    '| 9 | ⚪ | Later | - | 2026-06-30 | |',
    '',
  ].join('\n')

  it('snoozes by adding a marker and moving Today to Deferred', () => {
    const out = opSnoozeTask(
      snoozePlan,
      '| 2 | 🔴 | Weekend blocker | Ship | 2026-07-02 | 1 |',
      '2026-07-11',
    )
    const lines = out.split('\n')
    const todayBlock = lines.slice(lines.indexOf('## Today'), lines.indexOf('## Deferred')).join('\n')
    const deferredBlock = lines.slice(lines.indexOf('## Deferred')).join('\n')

    expect(todayBlock).not.toContain('Weekend blocker')
    expect(deferredBlock).toContain('| 2 | 🔴 | Weekend blocker | Ship | 2026-07-02 | 1 | <!-- snooze:2026-07-11 -->')
    expect(deferredBlock.indexOf('Weekend blocker')).toBeLessThan(deferredBlock.indexOf('Later'))
  })

  it('auto-returns expired Deferred snoozes to Today and clears the marker', () => {
    const planWithExpired = opSnoozeTask(
      snoozePlan,
      '| 2 | 🔴 | Weekend blocker | Ship | 2026-07-02 | 1 |',
      '2026-07-09',
    )
    const out = opApplySnoozeTransitions(planWithExpired, '2026-07-10')
    const lines = out.split('\n')
    const todayBlock = lines.slice(lines.indexOf('## Today'), lines.indexOf('## Deferred')).join('\n')
    const deferredBlock = lines.slice(lines.indexOf('## Deferred')).join('\n')

    expect(todayBlock).toContain('| 2 | 🔴 | Weekend blocker | Ship | 2026-07-02 | 1 |')
    expect(todayBlock).not.toContain('snooze:')
    expect(deferredBlock).not.toContain('Weekend blocker')
  })

  it('leaves marker-less Deferred tasks untouched during auto-return', () => {
    const out = opApplySnoozeTransitions(snoozePlan, '2026-07-10')

    expect(out).toBe(snoozePlan)
  })

  it('un-snoozes by clearing the marker and moving Deferred back to Today', () => {
    const planWithSnooze = opSnoozeTask(
      snoozePlan,
      '| 2 | 🔴 | Weekend blocker | Ship | 2026-07-02 | 1 |',
      '2026-07-11',
    )
    const out = opSnoozeTask(
      planWithSnooze,
      '| 2 | 🔴 | Weekend blocker | Ship | 2026-07-02 | 1 | <!-- snooze:2026-07-11 -->',
      null,
    )
    const lines = out.split('\n')
    const todayBlock = lines.slice(lines.indexOf('## Today'), lines.indexOf('## Deferred')).join('\n')
    const deferredBlock = lines.slice(lines.indexOf('## Deferred')).join('\n')

    expect(todayBlock).toContain('| 2 | 🔴 | Weekend blocker | Ship | 2026-07-02 | 1 |')
    expect(todayBlock).not.toContain('snooze:')
    expect(deferredBlock).not.toContain('Weekend blocker')
  })
})

describe('opBridgeLinks', () => {
  const table = [
    '| ID | 🎯 | Task | Priority | Added | Linked ID |',
    '|---|---|------|----------|-------|-----------|',
    '| 1 | 🟡 | A | - | 2023-01-01 | 2 |',
    '| 2 | 🟡 | B | - | 2023-01-01 | 3 |',
    '| 3 | 🟡 | C | - | 2023-01-01 | |',
  ].join('\n')

  it('updates single numeric ID in Linked ID column', () => {
    const out = opBridgeLinks(table, '2', '3')
    expect(out).toContain('| 1 | 🟡 | A | - | 2023-01-01 | 3 |')
    // Task 2 itself (the removed one) is untouched by this op — that's opDeleteTask's job.
    expect(out).toContain('| 2 | 🟡 | B | - | 2023-01-01 | 3 |')
  })

  describe('opSetTaskSnooze', () => {
    it('adds, updates, and clears a snooze marker without changing columns', () => {
      const rawLine = '| 2 | 🟡 | B |'
      const snoozed = opSetTaskSnooze(plan, rawLine, '2026-07-06')

      expect(snoozed).toContain('| 2 | 🟡 | B | <!-- snooze:2026-07-06 -->')
      const updated = opSetTaskSnooze(snoozed, '| 2 | 🟡 | B | <!-- snooze:2026-07-06 -->', '2026-07-10')
      expect(updated).toContain('| 2 | 🟡 | B | <!-- snooze:2026-07-10 -->')
      expect(opSetTaskSnooze(updated, '| 2 | 🟡 | B | <!-- snooze:2026-07-10 -->', null)).toBe(plan)
    })
  })

  it('removes Linked ID when nextIdRawValue is empty', () => {
    const out = opBridgeLinks(table, '2', '')
    // The implementation adds spaces around the value, so empty becomes "  "
    expect(out).toContain('| 1 | 🟡 | A | - | 2023-01-01 |  |')
  })

  it('handles non-existent removedId gracefully', () => {
    const out = opBridgeLinks(table, '99', '100')
    expect(out).toBe(table)
  })
})

describe('opRemoveTaskFromFocusPlanResult', () => {
  it('removes the row and reports removed:true', () => {
    const r = opRemoveTaskFromFocusPlanResult(plan, '| 2 | 🟡 | B |', 'Today')
    expect(r.removed).toBe(true)
    expect(r.content).not.toContain('| 2 | 🟡 | B |')
    expect(r.content).toContain('| 3 | 🟡 | C |')
  })

  it('reports removed:false when the row is not on the board', () => {
    const r = opRemoveTaskFromFocusPlanResult(plan, '| 77 | 🟡 | Nope |', 'Today')
    expect(r.removed).toBe(false)
    expect(r.content).toBe(plan)
  })

  it('reports removed:false when the row is in a different section', () => {
    const r = opRemoveTaskFromFocusPlanResult(plan, '| 9 | ⚪ | X |', 'Today')
    expect(r.removed).toBe(false)
  })

  it('still matches when the source row has CRLF line endings', () => {
    const crlf = plan.split('\n').join('\r\n')
    const r = opRemoveTaskFromFocusPlanResult(crlf, '| 2 | 🟡 | B |', 'Today')
    expect(r.removed).toBe(true)
    expect(r.content).not.toContain('| 2 | 🟡 | B |')
  })

  it('still matches when cell padding differs', () => {
    const r = opRemoveTaskFromFocusPlanResult(plan, '|2|🟡|B|', 'Today')
    expect(r.removed).toBe(true)
  })

  it('keeps the legacy string-returning wrapper working', () => {
    expect(opRemoveTaskFromFocusPlan(plan, '| 2 | 🟡 | B |', 'Today')).not.toContain('| 2 | 🟡 | B |')
    expect(opRemoveTaskFromFocusPlan(plan, '| 77 | 🟡 | Nope |', 'Today')).toBe(plan)
  })
})

describe('completedRowExistsForTask', () => {
  const completed = [
    '# Completed Tasks',
    '',
    '## Week of 1/1/2026',
    '',
    '| # | 🎯 | Task | Work Priority | Completed Date |',
    '|---|---|------|---------------|----------------|',
    '| 42 | ✅ | Ship it | P1 | 2026-01-02 |',
  ].join('\n')

  it('finds an existing task id', () => {
    expect(completedRowExistsForTask(completed, '42')).toBe(true)
  })

  it('does not match a different id', () => {
    expect(completedRowExistsForTask(completed, '4')).toBe(false)
  })

  it('ignores blank and placeholder ids', () => {
    expect(completedRowExistsForTask(completed, '')).toBe(false)
    expect(completedRowExistsForTask(completed, '-')).toBe(false)
  })
})

describe('opAppendToCompleted', () => {
  const completed = [
    '# Completed Tasks',
    '',
    '## Week of 1/1/2026',
    '',
    '| # | 🎯 | Task | Work Priority | Completed Date |',
    '|---|---|------|---------------|----------------|',
    '| 42 | ✅ | Ship it | P1 | 2026-01-02 |',
  ].join('\n')

  it('appends a row for a new task', () => {
    const out = opAppendToCompleted(completed, '| 43 | ✅ | New | P1 | 2026-01-03 |', { taskId: '43' })
    expect(out).toContain('| 43 | ✅ | New | P1 | 2026-01-03 |')
  })

  it('does not duplicate a task that is already on the completed board', () => {
    const out = opAppendToCompleted(completed, '| 42 | ✅ | Ship it again | P1 | 2026-01-09 |', { taskId: '42' })
    expect(out).toBe(completed)
    expect(out.split('\n').filter(l => l.startsWith('| 42 |')).length).toBe(1)
  })

  it('appends when no taskId is supplied (legacy call shape)', () => {
    const out = opAppendToCompleted(completed, '| 44 | ✅ | Legacy | P2 | 2026-01-04 |')
    expect(out).toContain('| 44 | ✅ | Legacy | P2 | 2026-01-04 |')
  })
})
