import { describe, it, expect } from 'vitest'
import { normalizeQuery, taskRowMatchesSearch, filterRowsAndRawLines } from './boardSearch.js'

const rows = [
  { ID: '70', Task: 'Write the design doc' },
  { ID: '71', Task: 'Fix heater' },
  { ID: { id: '266', linkedId: null }, Task: 'Fremont Solstice parade' },
]
const rawLines = [
  '| 70 | 🟡 | Write the design doc | - | 2026-01-27 | |',
  '| 71 | 🔴 | Fix heater | - | 2026-05-08 | 215 |',
  '| 266 | 🟡 | Fremont Solstice parade | - | 2026-06-15 | |',
]

describe('normalizeQuery', () => {
  it('trims and lowercases', () => {
    expect(normalizeQuery('  HeAtEr  ')).toBe('heater')
    expect(normalizeQuery(undefined)).toBe('')
  })
})

describe('taskRowMatchesSearch', () => {
  it('matches everything for an empty query', () => {
    expect(taskRowMatchesSearch(rows[0], '')).toBe(true)
    expect(taskRowMatchesSearch(rows[0], '   ')).toBe(true)
  })
  it('matches on task text, case-insensitively', () => {
    expect(taskRowMatchesSearch(rows[1], 'heater')).toBe(true)
    expect(taskRowMatchesSearch(rows[1], 'HEAT')).toBe(true)
    expect(taskRowMatchesSearch(rows[0], 'heater')).toBe(false)
  })
  it('matches on ID, including object-form ID cells', () => {
    expect(taskRowMatchesSearch(rows[0], '70')).toBe(true)
    expect(taskRowMatchesSearch(rows[2], '266')).toBe(true)
    expect(taskRowMatchesSearch(rows[2], '999')).toBe(false)
  })
})

describe('filterRowsAndRawLines', () => {
  it('passes through unchanged for an empty query', () => {
    const out = filterRowsAndRawLines(rows, rawLines, '')
    expect(out.rows).toBe(rows)
    expect(out.matchCount).toBe(3)
  })
  it('keeps rows and rawLines aligned when filtering', () => {
    const out = filterRowsAndRawLines(rows, rawLines, 'parade')
    expect(out.matchCount).toBe(1)
    expect(out.rows).toHaveLength(1)
    expect(out.rawLines).toHaveLength(1)
    expect(out.rawLines[0]).toContain('Fremont Solstice parade')
  })
  it('returns no matches when nothing matches', () => {
    const out = filterRowsAndRawLines(rows, rawLines, 'zzz')
    expect(out.matchCount).toBe(0)
    expect(out.rows).toEqual([])
  })
})
