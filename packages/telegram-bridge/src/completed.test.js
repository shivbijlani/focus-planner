import { describe, it, expect } from 'vitest'
import { parseCompletedTaskIds } from './completed.js'

const BOARD = `## Week of 7/27/2026

| # | 🎯 | Task | Work Priority | Completed Date |
|---|---|------|---------------|----------------|
| 401 | ✅ | Draft house-sitter directions doc | - | 2026-08-02 |
| 387 | ✅ | Rosemary — Marketplace giveaway | - | 2026-08-02 |

## Week of 7/20/2026

| # | 🎯 | Task | Work Priority | Completed Date |
|---|---|------|---------------|----------------|
| 342 | ✅ | Add final journal comments | - | 2026-07-22 |
`

describe('parseCompletedTaskIds', () => {
  it('extracts numeric task IDs from completed rows across sections', () => {
    expect(parseCompletedTaskIds(BOARD)).toEqual(['401', '387', '342'])
  })

  it('ignores header and separator rows', () => {
    const ids = parseCompletedTaskIds(BOARD)
    expect(ids).not.toContain('#')
    expect(ids).not.toContain('---')
  })

  it('dedups repeated IDs, keeping first-seen order', () => {
    const dup = `${BOARD}\n| 401 | ✅ | dup row | - | 2026-08-03 |`
    expect(parseCompletedTaskIds(dup)).toEqual(['401', '387', '342'])
  })

  it('returns [] for empty or missing input', () => {
    expect(parseCompletedTaskIds('')).toEqual([])
    expect(parseCompletedTaskIds(undefined)).toEqual([])
    expect(parseCompletedTaskIds('no table here')).toEqual([])
  })

  it('handles CRLF line endings', () => {
    expect(parseCompletedTaskIds(BOARD.replace(/\n/g, '\r\n'))).toEqual([
      '401',
      '387',
      '342',
    ])
  })
})
