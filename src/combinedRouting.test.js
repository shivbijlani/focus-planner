import { describe, expect, it } from 'vitest'
import { tagMergedRows, resolveRowSourceId } from './combinedRouting.js'
import { sortTasksByPriority } from './taskSort.js'
import { filterRowsAndRawLines } from './boardSearch.js'

// Regression for #39: in the combined view, two sources can share an identical
// row text + local id (e.g. the shared umbrella row #191 "Hygiene"). Routing a
// destructive op by text/id alone collides and writes to the wrong source. The
// fix tags each merged row with its owning source id and resolves from that.

// Mimics two sources each contributing an *identical* "Hygiene" row, the way
// buildMergedSection emits parallel data lines + sourceIds.
const headers = ['ID', '🎯', 'Task', 'Age']
const makeRow = () => ({ ID: { id: '191', linkedId: null, adoLink: null }, '🎯': '🟡', Task: 'Hygiene', Age: '1d' })
const identicalRawLine = '| 191 | 🟡 | Hygiene | - | 2026-01-01 | |'

describe('tagMergedRows', () => {
  it('tags each row with its parallel source id, even when rows are identical', () => {
    const rows = [makeRow(), makeRow()]
    tagMergedRows(rows, ['work', 'personal'])
    expect(rows[0].__sourceId).toBe('work')
    expect(rows[1].__sourceId).toBe('personal')
  })

  it('no-ops on mismatched / non-array input', () => {
    expect(() => tagMergedRows(null, ['a'])).not.toThrow()
    const rows = [makeRow()]
    tagMergedRows(rows, null)
    expect(rows[0].__sourceId).toBeUndefined()
  })

  it('leaves a row untagged when its source id is missing', () => {
    const rows = [makeRow(), makeRow()]
    tagMergedRows(rows, ['work']) // only one id provided
    expect(rows[0].__sourceId).toBe('work')
    expect(rows[1].__sourceId).toBeUndefined()
  })
})

describe('source tag survives the sort + search pipeline', () => {
  it('keeps each row bound to its source after sortTasksByPriority and filter', () => {
    const rows = [makeRow(), makeRow()]
    const rawLines = [identicalRawLine, identicalRawLine]
    tagMergedRows(rows, ['work', 'personal'])

    const { sortedRows } = sortTasksByPriority(rows, rawLines, headers, {}, {})
    // Both rows are present and still carry their distinct source ids.
    const ids = sortedRows.map(r => r.__sourceId).sort()
    expect(ids).toEqual(['personal', 'work'])

    const { rows: visible } = filterRowsAndRawLines(sortedRows, [identicalRawLine, identicalRawLine], '191')
    expect(visible).toHaveLength(2)
    expect(visible.every(r => r.__sourceId === 'work' || r.__sourceId === 'personal')).toBe(true)
  })
})

describe('resolveRowSourceId', () => {
  it('prefers the row tag over a colliding text lookup (the bug)', () => {
    // The legacy map collides: identical text resolves to whichever source was
    // iterated last ("personal"). The work row must STILL route to work.
    const lineToSource = new Map([[identicalRawLine.trim(), 'personal']])
    const workRow = makeRow()
    workRow.__sourceId = 'work'
    expect(resolveRowSourceId(workRow, identicalRawLine, lineToSource)).toBe('work')
  })

  it('falls back to the text lookup for an untagged row (single-source view)', () => {
    const lineToSource = new Map([[identicalRawLine.trim(), 'only']])
    expect(resolveRowSourceId(makeRow(), identicalRawLine, lineToSource)).toBe('only')
  })

  it('returns undefined when neither a tag nor a map is available', () => {
    expect(resolveRowSourceId(makeRow(), identicalRawLine)).toBeUndefined()
    expect(resolveRowSourceId(undefined, identicalRawLine, new Map())).toBeUndefined()
  })
})
