import { describe, it, expect } from 'vitest'
import {
  parseBoardOrder,
  boardRank,
  boardIndex,
  RANK_TODAY_URGENT,
  RANK_TODAY,
  RANK_DEFERRED_URGENT,
  RANK_DEFERRED,
  RANK_OTHER,
  RANK_UNLISTED,
} from './board.js'

const BOARD = `## Today

| ID | 🎯 | Task | Work Priority | Added | Linked ID |
|---|---|------|---------------|-------|-----------|
| 435 | 🔴 | Surrey BC dhol trip | P0 | 2026-08-22 | 392 |
| 434 | 🟡 | Land GH #154 | - | 2026-08-22 | 352 |
| 433 | 🔴 | Land GH #150 | P0 | 2026-08-22 | 371 |
| 432 | 🟡 | Organize mini golf with Sam | - | 2026-08-21 | 323 |
| 241 | 🟡 | Reframe resume bullets | P1 | 2026-06-04 | 204 |

## Deferred

| ID | 🎯 | Task | Work Priority | Added | Linked ID |
|---|---|------|---------------|-------|-----------|
| 252 | 🟡 | Print the week plan | - | 2026-06-12 | 191 | <!-- snooze:2026-08-23 -->
| 219 | 🔴 | home security | - | 2026-05-15 | 215 |

## Priorities

1. 285
2. 191
`

// Issue #171: the shape the app writes when a task carries an External Ticket.
// #439 was the first live row to use it, and it sat at row 1 of `## Today`.
const EXTERNAL_ID_CELL = '439,[170](https://github.com/shivbijlani/focus-planner/issues/170)'

const EXTERNAL_TICKET_BOARD = `## Today

| ID | 🎯 | Task | Work Priority | Added | Linked ID |
|---|---|------|---------------|-------|-----------|
| ${EXTERNAL_ID_CELL} | 🔴 | Fix GH #170 | - | 2026-08-23 | |
| 433 | 🔴 | Land GH #150 | P0 | 2026-08-22 | 371 |

## Deferred

| ID | 🎯 | Task | Work Priority | Added | Linked ID |
|---|---|------|---------------|-------|-----------|
| 252 | 🟡 | Print the week plan | - | 2026-06-12 | 191 |
`

describe('parseBoardOrder', () => {
  it('maps each task row to its section and position', () => {
    const board = parseBoardOrder(BOARD)
    expect(board.get('435')).toMatchObject({ section: 'today', index: 0 })
    expect(board.get('432')).toMatchObject({ section: 'today', index: 3 })
    expect(board.get('252')).toMatchObject({ section: 'deferred' })
    expect(board.get('219')).toMatchObject({ section: 'deferred' })
  })

  it('flags urgency from the 🔴 icon or an explicit P0', () => {
    const board = parseBoardOrder(BOARD)
    expect(board.get('435').urgent).toBe(true) // 🔴 and P0
    expect(board.get('433').urgent).toBe(true)
    expect(board.get('219').urgent).toBe(true) // 🔴 only, priority is "-"
    expect(board.get('434').urgent).toBe(false)
    expect(board.get('241').urgent).toBe(false) // P1 is not urgent
  })

  it('ignores header, separator, and the numbered Priorities list', () => {
    const board = parseBoardOrder(BOARD)
    expect(board.has('ID')).toBe(false)
    expect(board.has('---')).toBe(false)
    // "1. 285" is a list item, not a table row, so 285 is not a board task.
    expect(board.has('285')).toBe(false)
  })

  it('tolerates a trailing HTML comment after the last pipe', () => {
    const board = parseBoardOrder(BOARD)
    expect(board.get('252').section).toBe('deferred')
  })

  it('handles CRLF line endings', () => {
    const board = parseBoardOrder(BOARD.replace(/\n/g, '\r\n'))
    expect(board.get('435')).toMatchObject({ section: 'today', urgent: true })
    expect(board.get('219').section).toBe('deferred')
  })

  it('keeps the first position when a task is listed twice', () => {
    const dup = `${BOARD}\n| 435 | 🟡 | dup row | - | 2026-08-22 | |`
    const board = parseBoardOrder(dup)
    expect(board.get('435')).toMatchObject({ section: 'today', index: 0 })
  })

  it('returns an empty map for empty or non-table input', () => {
    expect(parseBoardOrder('').size).toBe(0)
    expect(parseBoardOrder(undefined).size).toBe(0)
    expect(parseBoardOrder('no table here').size).toBe(0)
  })

  // Issue #171. The app stores a task linked to an external ticket as
  // `<localId>,[<ticketId>](<url>)`, so requiring the whole cell to be digits
  // dropped the row before it entered the board map. The failure was silent:
  // the task simply never appeared in the digest, and using a documented
  // product feature was enough to trigger it.
  it('reads the task id from a cell that also carries an external ticket', () => {
    const board = parseBoardOrder(EXTERNAL_TICKET_BOARD)
    expect(board.get('439')).toMatchObject({ section: 'today', index: 0, urgent: true })
    // The linked ticket number is not a task and must not become one.
    expect(board.has('170')).toBe(false)
  })

  it('ranks an external-ticket row identically to the same row with a bare id', () => {
    const external = parseBoardOrder(EXTERNAL_TICKET_BOARD)
    const bare = parseBoardOrder(EXTERNAL_TICKET_BOARD.replace(EXTERNAL_ID_CELL, '439'))
    expect(external.get('439')).toEqual(bare.get('439'))
    expect(boardRank(external, '439')).toBe(boardRank(bare, '439'))
    expect(boardIndex(external, '439')).toBe(boardIndex(bare, '439'))
    // Row 1 of Today with a 🔴 is the top tier, not the not-on-board tier.
    expect(boardRank(external, '439')).toBe(RANK_TODAY_URGENT)
    expect(boardIndex(external, '439')).toBe(0)
  })

  it('tolerates whitespace around the comma in an external-ticket cell', () => {
    const board = parseBoardOrder('## Today\n\n| 439 , [170](https://x/170) | 🟡 | t | - | | |')
    expect(board.get('439')).toMatchObject({ section: 'today', index: 0 })
  })

  it('keeps a bare numeric id working exactly as before', () => {
    const board = parseBoardOrder(EXTERNAL_TICKET_BOARD)
    expect(board.get('433')).toMatchObject({ section: 'today', index: 1 })
    expect(board.get('252')).toMatchObject({ section: 'deferred' })
    // And the original board, which has no external tickets at all, is untouched.
    expect(parseBoardOrder(BOARD).get('435')).toMatchObject({ section: 'today', index: 0 })
  })

  it('skips a malformed id cell instead of throwing or mis-parsing it', () => {
    // Shapes the app never writes. Each must fall through safely, leaving the
    // row off the board rather than being guessed at.
    const board = parseBoardOrder(
      [
        '## Today',
        '',
        '| 439,170 | 🟡 | comma but no link | - | | |',
        '| #440 | 🟡 | hash prefix | - | | |',
        '| 441abc | 🟡 | trailing text | - | | |',
        '| | 🟡 | empty cell | - | | |',
        '| 442 | 🟡 | the one good row | - | | |',
      ].join('\n'),
    )
    expect(board.has('439')).toBe(false)
    expect(board.has('440')).toBe(false)
    expect(board.has('441')).toBe(false)
    expect(board.get('442')).toMatchObject({ section: 'today', index: 0 })
    expect(board.size).toBe(1)
  })
})

describe('boardRank', () => {
  const board = parseBoardOrder(BOARD)

  it('ranks urgent Today above ordinary Today', () => {
    expect(boardRank(board, '433')).toBe(RANK_TODAY_URGENT)
    expect(boardRank(board, '434')).toBe(RANK_TODAY)
    expect(boardRank(board, '433')).toBeLessThan(boardRank(board, '434'))
  })

  it('ranks Today above Deferred', () => {
    expect(boardRank(board, '434')).toBe(RANK_TODAY)
    expect(boardRank(board, '252')).toBe(RANK_DEFERRED)
    expect(boardRank(board, '434')).toBeLessThan(boardRank(board, '252'))
  })

  it('ranks urgent Deferred above ordinary Deferred', () => {
    expect(boardRank(board, '219')).toBe(RANK_DEFERRED_URGENT)
    expect(boardRank(board, '219')).toBeLessThan(boardRank(board, '252'))
  })

  it('sinks tasks that are not on the board at all', () => {
    // The #281 broken-ID case: a six-digit orphan must never lead the digest.
    expect(boardRank(board, '426580')).toBe(RANK_UNLISTED)
    expect(boardRank(board, '426580')).toBeGreaterThan(boardRank(board, '433'))
    expect(boardRank(board, '426580')).toBeGreaterThan(boardRank(board, '252'))
  })

  it('accepts numeric task ids as well as strings', () => {
    expect(boardRank(board, 433)).toBe(RANK_TODAY_URGENT)
  })

  it('treats rows under an unrecognised heading as RANK_OTHER', () => {
    const other = parseBoardOrder('## Someday\n\n| 999 | 🟡 | x | - | | |')
    expect(boardRank(other, '999')).toBe(RANK_OTHER)
  })

  it('is safe when no board could be read', () => {
    expect(boardRank(parseBoardOrder(''), '433')).toBe(RANK_UNLISTED)
    expect(boardRank(null, '433')).toBe(RANK_UNLISTED)
  })
})

describe('boardIndex', () => {
  const board = parseBoardOrder(BOARD)

  it('preserves the user\u2019s own top-to-bottom ordering', () => {
    expect(boardIndex(board, '435')).toBeLessThan(boardIndex(board, '434'))
    expect(boardIndex(board, '434')).toBeLessThan(boardIndex(board, '432'))
  })

  it('sorts unlisted tasks last', () => {
    expect(boardIndex(board, '426580')).toBe(Number.MAX_SAFE_INTEGER)
    expect(boardIndex(null, '435')).toBe(Number.MAX_SAFE_INTEGER)
  })
})

describe('end-to-end ordering behaviour', () => {
  // Mirrors the comparator bridge.js/syncDigest uses, so the ranking contract
  // is pinned here even though the sort itself lives in the bridge.
  const board = parseBoardOrder(BOARD)
  const order = (ids) =>
    [...ids].sort(
      (a, b) =>
        boardRank(board, a) - boardRank(board, b) ||
        boardIndex(board, a) - boardIndex(board, b) ||
        Number(b) - Number(a),
    )

  it('leads with the P0s and buries the broken-ID orphan', () => {
    expect(order(['426580', '434', '433', '252', '435'])).toEqual([
      '435', // Today + P0
      '433', // Today + P0
      '434', // Today
      '252', // Deferred
      '426580', // not on the board
    ])
  })

  it('falls back to newest-first among equally unlisted tasks', () => {
    expect(order(['426565', '426585', '426573'])).toEqual([
      '426585',
      '426573',
      '426565',
    ])
  })
})
