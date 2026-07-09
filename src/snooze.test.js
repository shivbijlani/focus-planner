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

  it('sets and parses a trailing HTML comment without changing table cells', () => {
    const snoozed = setSnoozeUntilOnLine(row, '2026-07-06')

    expect(snoozed).toBe(`${row} <!-- snooze:2026-07-06 -->`)
    expect(parseSnoozeUntil(snoozed)).toBe('2026-07-06')
    expect(snoozed.split('|').slice(1, -1).map(c => c.trim())).toEqual([
      '1',
      '🟡',
      'Plan weekend work',
      '-',
      '2026-07-03',
      '192',
    ])
  })

  it('replaces and clears an existing marker', () => {
    const first = setSnoozeUntilOnLine(row, '2026-07-06')
    const second = setSnoozeUntilOnLine(first, '2026-07-10')

    expect(second).toBe(`${row} <!-- snooze:2026-07-10 -->`)
    expect(clearSnoozeUntilFromLine(second)).toBe(row)
    expect(setSnoozeUntilOnLine(second, null)).toBe(row)
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
