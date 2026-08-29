import { describe, expect, it } from 'vitest'

import {
  addDaysToDateString,
  clearSnoozeUntilFromLine,
  getNextSaturdayDateString,
  isSnoozeActive,
  normalizeDateOnly,
  parseSnoozeUntil,
  setSnoozeUntilOnLine,
} from './snooze.js'

describe('snooze row markers', () => {
  const row = '| 1 | 🟡 | Plan weekend work | - | 2026-07-03 | 192 |'
  const deferredHeaders = ['ID', '🎯', 'Task', 'Work Priority', 'Added', 'Wake', 'Linked ID']
  const deferredRow = '| 1 | 🟡 | Plan weekend work | - | 2026-07-03 |  | 192 |'

  it('sets and parses a Wake column without changing other table cells', () => {
    const snoozed = setSnoozeUntilOnLine(deferredRow, '2026-07-06', deferredHeaders)

    expect(snoozed).toBe('| 1 | 🟡 | Plan weekend work | - | 2026-07-03 | 2026-07-06 | 192 |')
    expect(parseSnoozeUntil(snoozed, deferredHeaders)).toBe('2026-07-06')
    expect(snoozed.split('|').slice(1, -1).map(c => c.trim())).toEqual([
      '1',
      '🟡',
      'Plan weekend work',
      '-',
      '2026-07-03',
      '2026-07-06',
      '192',
    ])
  })

  it('replaces and clears an existing Wake value', () => {
    const first = setSnoozeUntilOnLine(deferredRow, '2026-07-06', deferredHeaders)
    const second = setSnoozeUntilOnLine(first, '2026-07-10', deferredHeaders)

    expect(second).toBe('| 1 | 🟡 | Plan weekend work | - | 2026-07-03 | 2026-07-10 | 192 |')
    expect(clearSnoozeUntilFromLine(second, deferredHeaders)).toBe(deferredRow)
    expect(setSnoozeUntilOnLine(second, null, deferredHeaders)).toBe(deferredRow)
  })

  it('falls back to parsing the legacy trailing HTML comment', () => {
    const legacy = `${row} <!-- snooze:2026-07-06 -->`

    expect(parseSnoozeUntil(legacy)).toBe('2026-07-06')
  })

  it('treats future snoozes as active and expired snoozes as inactive', () => {
    expect(isSnoozeActive('2026-07-04', '2026-07-03')).toBe(true)
    expect(isSnoozeActive('2026-07-03', '2026-07-03')).toBe(false)
    expect(isSnoozeActive('2026-07-02', '2026-07-03')).toBe(false)
  })
})

describe('snooze date helpers', () => {
  it('validates date-only strings', () => {
    expect(normalizeDateOnly('2026-07-04')).toBe('2026-07-04')
    expect(normalizeDateOnly('2026-02-31')).toBeNull()
    expect(normalizeDateOnly('07/04/2026')).toBeNull()
  })

  it('computes quick dates', () => {
    expect(addDaysToDateString('2026-07-03', 1)).toBe('2026-07-04')
    expect(addDaysToDateString('2026-07-03', 7)).toBe('2026-07-10')
    expect(getNextSaturdayDateString('2026-07-03')).toBe('2026-07-04')
    expect(getNextSaturdayDateString('2026-07-04')).toBe('2026-07-11')
  })
})
