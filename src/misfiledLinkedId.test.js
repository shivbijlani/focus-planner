/**
 * #446 — a **full-width** Deferred row whose parent id was written into `Wake`
 * must not lose its `Linked ID`, and snoozing it must not destroy the id.
 *
 * #426 fixed the *ragged* case: a 6-field row under the 7-column header, where
 * the seam split proves the trailing value is a `Linked ID`. It cannot fix this
 * one, because there is no raggedness to detect — the row already has exactly
 * `headers.length` cells and the parent id simply sits one column too far left:
 *
 *     | 452 | 🟡 | Career ops launch pad … | - | 2026-08-26 | 204 |  |
 *                                                            ^^^ Wake  ^^ Linked ID
 *
 * Fixture shapes are taken from the live board, measured 2026-09-03:
 *   - #452 (`204`) and #374 (`191`) — full-width, parent id misfiled into `Wake`
 *   - #451 — the #426 ragged shape (must not regress)
 *   - #210 — a well-formed 7-field row (must not regress)
 *
 * The hazard the snooze arms cover is the reason this is a bug and not a
 * cosmetic complaint: `Wake` is the cell the snooze writer owns, so before this
 * fix, snoozing #452 overwrote `204` with the wake date — permanently, with no
 * tombstone, and the agent-side reader (which recovered the id positionally)
 * lost it too.
 */
import { describe, it, expect } from 'vitest'
import { cellByHeader, normalizeRowCells, recoverMisfiledLinkedId, rowCells } from './boardRow.js'
import { parseMarkdownTable } from './boardTable.js'
import { parseSnoozeUntil, setSnoozeUntilOnLine } from './snooze.js'

const DEFERRED_HEADERS = ['ID', '🎯', 'Task', 'Work Priority', 'Added', 'Wake', 'Linked ID']
const DEFERRED_HEADER = '| ID | 🎯 | Task | Work Priority | Added | Wake | Linked ID |'
const DEFERRED_SEP = '| --- | --- | ------ | --------------- | ------- | ---- | ----------- |'

// Live shapes: full-width, parent id misfiled into `Wake`, `Linked ID` empty.
const ROW_452 = '| 452 | 🟡 | Career ops launch pad | - | 2026-08-26 | 204 |  |'
const ROW_374 = '| 374 | 🟡 | Weekly meal planner app and journal | - | 2026-07-23 | 191 |  |'
// #426's ragged shape — one field short under the same header.
const ROW_451 = '| 451 | 🔴 | Report hit and run | - | 2026-08-30 | 191 |'
// Well-formed.
const ROW_210 = '| 210 | 🔴 | Fix heater | - | 2026-05-08 |  | 215 |'
// Genuinely snoozed: a real date in `Wake`, with a link.
const ROW_SNOOZED = '| 300 | 🟡 | Something later | - | 2026-08-01 | 2026-09-20 | 215 |'

const LINK = 'Linked ID'

describe('#446 recoverMisfiledLinkedId', () => {
  it('moves a non-date Wake value into an empty Linked ID', () => {
    const out = recoverMisfiledLinkedId(rowCells(ROW_452), DEFERRED_HEADERS)
    expect(out[DEFERRED_HEADERS.indexOf(LINK)]).toBe('204')
    expect(out[DEFERRED_HEADERS.indexOf('Wake')]).toBe('')
  })

  it('leaves a real wake date alone', () => {
    const out = recoverMisfiledLinkedId(rowCells(ROW_SNOOZED), DEFERRED_HEADERS)
    expect(out[DEFERRED_HEADERS.indexOf('Wake')]).toBe('2026-09-20')
    expect(out[DEFERRED_HEADERS.indexOf(LINK)]).toBe('215')
  })

  it('never clobbers a Linked ID that is already populated', () => {
    // Both cells filled and Wake is not a date: ambiguous, so change nothing.
    const row = '| 9 | 🟡 | Ambiguous | - | 2026-08-01 | 204 | 215 |'
    const out = recoverMisfiledLinkedId(rowCells(row), DEFERRED_HEADERS)
    expect(out[DEFERRED_HEADERS.indexOf('Wake')]).toBe('204')
    expect(out[DEFERRED_HEADERS.indexOf(LINK)]).toBe('215')
  })

  it('is a no-op on a header with no Wake column (Today)', () => {
    const todayHeaders = ['ID', '🎯', 'Task', 'Work Priority', 'Added', 'Linked ID']
    const row = '| 5 | 🟡 | A today task | - | 2026-08-01 | 215 |'
    expect(recoverMisfiledLinkedId(rowCells(row), todayHeaders)).toEqual(rowCells(row))
  })

  it('is a no-op when both Wake and Linked ID are empty', () => {
    const row = '| 464 | 🟡 | daily Instagram check | - | 2026-09-01 |  |  |'
    expect(recoverMisfiledLinkedId(rowCells(row), DEFERRED_HEADERS)).toEqual(rowCells(row))
  })
})

describe('#446 the reader exposes the recovered link', () => {
  const table = [DEFERRED_HEADER, DEFERRED_SEP, ROW_452, ROW_374, ROW_451, ROW_210, ROW_SNOOZED]

  it('cellByHeader reads the misfiled id as Linked ID, not Wake', () => {
    for (const [raw, id] of [[ROW_452, '204'], [ROW_374, '191']]) {
      expect(cellByHeader(rowCells(raw), DEFERRED_HEADERS, LINK)).toBe(id)
      expect(cellByHeader(rowCells(raw), DEFERRED_HEADERS, 'Wake')).toBe('')
    }
  })

  it('parseMarkdownTable folds the recovered id into the ID cell', () => {
    const parsed = parseMarkdownTable(table)
    const byId = Object.fromEntries(parsed.rows.map(r => [String(r.ID?.id ?? '').trim(), r]))
    expect(byId['452'].ID.linkedId).toBe('204')
    expect(byId['374'].ID.linkedId).toBe('191')
    // #426 must not regress, and a well-formed row must be untouched.
    expect(byId['451'].ID.linkedId).toBe('191')
    expect(byId['210'].ID.linkedId).toBe('215')
    // The recovered id must not leak back into the rendered Wake column.
    expect(byId['452'].Wake).toBe('')
    expect(byId['374'].Wake).toBe('')
    expect(byId['300'].Wake).toBe('2026-09-20')
  })

  it('does not invent a snooze out of a misfiled parent id', () => {
    // `normalizeDateOnly('204')` is null, so this passed by luck before. Assert
    // it now holds by construction: the value is not even in `Wake` any more.
    expect(parseSnoozeUntil(ROW_452, DEFERRED_HEADERS)).toBeNull()
    expect(parseSnoozeUntil(ROW_SNOOZED, DEFERRED_HEADERS)).toBe('2026-09-20')
  })
})

describe('#446 snoozing must not destroy the parent id', () => {
  it('preserves the misfiled id when a wake date is written over it', () => {
    for (const [raw, id] of [[ROW_452, '204'], [ROW_374, '191']]) {
      const snoozed = setSnoozeUntilOnLine(raw, '2026-09-20', DEFERRED_HEADERS)
      expect(cellByHeader(rowCells(snoozed), DEFERRED_HEADERS, 'Wake')).toBe('2026-09-20')
      expect(cellByHeader(rowCells(snoozed), DEFERRED_HEADERS, LINK)).toBe(id)
    }
  })

  it('round-trips: snooze then clear leaves the link intact', () => {
    const snoozed = setSnoozeUntilOnLine(ROW_452, '2026-09-20', DEFERRED_HEADERS)
    const cleared = setSnoozeUntilOnLine(snoozed, null, DEFERRED_HEADERS)
    expect(cellByHeader(rowCells(cleared), DEFERRED_HEADERS, LINK)).toBe('204')
    expect(cellByHeader(rowCells(cleared), DEFERRED_HEADERS, 'Wake')).toBe('')
  })

  it('still snoozes a ragged #426 row without losing its link', () => {
    const snoozed = setSnoozeUntilOnLine(ROW_451, '2026-09-20', DEFERRED_HEADERS)
    expect(cellByHeader(rowCells(snoozed), DEFERRED_HEADERS, 'Wake')).toBe('2026-09-20')
    expect(cellByHeader(rowCells(snoozed), DEFERRED_HEADERS, LINK)).toBe('191')
  })

  it('leaves a well-formed row exactly as #426 left it', () => {
    const snoozed = setSnoozeUntilOnLine(ROW_210, '2026-09-20', DEFERRED_HEADERS)
    expect(cellByHeader(rowCells(snoozed), DEFERRED_HEADERS, 'Wake')).toBe('2026-09-20')
    expect(cellByHeader(rowCells(snoozed), DEFERRED_HEADERS, LINK)).toBe('215')
  })
})

describe('#446 normalizeRowCells composes both rules', () => {
  it('aligns a ragged row (#426) and recovers a full-width one (#446)', () => {
    expect(normalizeRowCells(rowCells(ROW_451), DEFERRED_HEADERS)).toEqual(
      ['451', '🔴', 'Report hit and run', '-', '2026-08-30', '', '191'],
    )
    expect(normalizeRowCells(rowCells(ROW_452), DEFERRED_HEADERS)).toEqual(
      ['452', '🟡', 'Career ops launch pad', '-', '2026-08-26', '', '204'],
    )
  })
})
