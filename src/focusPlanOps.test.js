import { describe, expect, it } from 'vitest'
import { opMoveLinesBetweenSections, opBridgeLinks } from './focusPlanOps.js'

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
