/**
 * #426 — a Deferred row with 6 fields under the 7-column header must not lose
 * its `Linked ID`.
 *
 * The board is hand-editable, so its tables are ragged in both directions:
 * `## Deferred` carries a `Wake` column that `## Today` does not, and rows
 * written before `Wake` existed (or by a pre-#307 writer, which is what
 * plannermd.com was still running when this was filed) have one field too few.
 * The writer was fixed in #307; the **reader** still indexed `Linked ID` off the
 * raw row, so `cells[6]` on a 6-field row was `undefined` and the link vanished.
 *
 * Fixture shapes are taken from the live board, measured 2026-09-03:
 *   - #451 / #470 — 6 fields under the 7-column Deferred header
 *   - #210        — a well-formed 7-field row (must not regress)
 *   - #245        — 7 fields under the 6-column Today header (the inverse case,
 *                   present on the live board and not mentioned in the issue)
 */
import { describe, it, expect } from 'vitest'
import { alignRowToHeaders, rowCells } from './boardRow.js'
import { parseMarkdownTable } from './boardTable.js'
import { findMalformedRows, opAddTask, opChangeLinkedId } from './focusPlanOps.js'
import { parseSnoozeUntil, setSnoozeUntilOnLine } from './snooze.js'
import { readFileSync } from 'node:fs'

const DEFERRED_HEADER = '| ID | 🎯 | Task | Work Priority | Added | Wake | Linked ID |'
const DEFERRED_SEP = '| --- | --- | ------ | --------------- | ------- | ---- | ----------- |'
const TODAY_HEADER = '| ID | 🎯 | Task | Work Priority | Added | Linked ID |'
const TODAY_SEP = '|---|---|------|---------------|-------|-----------|'

// A 6-field row under the 7-column header — the exact live shape of #451.
const RAGGED_451 = '| 451 | 🔴 | Report hit and run | - | 2026-08-30 | 191 |'
// A well-formed 7-field row — #210 on the live board.
const WELLFORMED_210 = '| 210 | 🔴 | Fix heater | - | 2026-05-08 |  | 215 |'
// Wake genuinely set, Linked ID genuinely empty. A wake date must never be
// mistaken for a linked task (the inverse false positive).
const WAKE_ONLY_864 = '| 864 | 🟡 | wake set, no link | - | 2026-09-02 | 2026-12-25 |  |'

const DEFERRED = [
  '## Deferred', '', DEFERRED_HEADER, DEFERRED_SEP,
  RAGGED_451, WELLFORMED_210, WAKE_ONLY_864, '',
]

const BOARD = [
  '## Today', '', TODAY_HEADER, TODAY_SEP,
  '| 245 | 🟡 | Amy xfinity internet | - | 2026-06-07 |  |  |',
  '| 468 | 🟡 | work github issues | - | 2026-09-02 | 463 |',
  '',
  ...DEFERRED,
].join('\n')

const idCell = (rows, id) => rows.find(r => r.ID?.id === id).ID

describe('#426 reader: a ragged Deferred row keeps its Linked ID', () => {
  const { rows } = parseMarkdownTable(DEFERRED)

  it('binds the trailing field of a 6-field row to Linked ID, not Wake', () => {
    // The acceptance criterion: #451 renders `451 → 191`. `.linked-id-wrapper`
    // is rendered iff `linkedId` is truthy (App.jsx), so this IS that assertion.
    expect(idCell(rows, '451').linkedId).toBe('191')
  })

  it('leaves Wake empty on that row rather than silently populating it', () => {
    const row = rows.find(r => r.ID?.id === '451')
    expect(row.Wake).toBe('')
    expect(row.snoozeUntil).toBeNull()
  })

  it('still reads a well-formed 7-field row correctly', () => {
    expect(idCell(rows, '210').linkedId).toBe('215')
  })

  it('never mistakes a Wake date for a linked task', () => {
    expect(idCell(rows, '864').linkedId).toBeNull()
    expect(rows.find(r => r.ID?.id === '864').snoozeUntil).toBe('2026-12-25')
  })

  it('does not shift columns on an over-wide row (7 fields, 6-column header)', () => {
    const { rows: todayRows } = parseMarkdownTable(BOARD.split('\n').slice(0, 6))
    const row = todayRows.find(r => r.ID?.id === '245')
    expect(row.Added).toBe('2026-06-07')
    expect(row.Task).toBe('Amy xfinity internet')
  })

  it('keeps the rendered Age/Added columns aligned on a ragged row', () => {
    const row = rows.find(r => r.ID?.id === '451')
    expect(row.Added).toBe('2026-08-30')
    expect(row['Work Priority']).toBe('-')
    expect(row.Task).toBe('Report hit and run')
  })
})

describe('#426 alignment rule', () => {
  const headers = rowCells(DEFERRED_HEADER)

  it('inserts the missing cell at the Wake seam, not at the end', () => {
    expect(alignRowToHeaders(rowCells(RAGGED_451), headers)).toEqual(
      ['451', '🔴', 'Report hit and run', '-', '2026-08-30', '', '191'],
    )
  })

  it('leaves a row that already matches its header untouched', () => {
    const cells = rowCells(WELLFORMED_210)
    expect(alignRowToHeaders(cells, headers)).toEqual(cells)
  })

  it('drops a spare trailing cell rather than shifting the tail left', () => {
    const todayHeaders = rowCells(TODAY_HEADER)
    const over = rowCells('| 245 | 🟡 | Amy | - | 2026-06-07 |  |  |')
    expect(alignRowToHeaders(over, todayHeaders)).toEqual(
      ['245', '🟡', 'Amy', '-', '2026-06-07', ''],
    )
  })

  it('keeps the RIGHT-most tail of an over-wide row, so Linked ID survives', () => {
    // An over-wide row only bites where the seam is before the end of the
    // header — i.e. a Deferred row, which has `Wake`. Truncating to the first
    // `width` cells (the obvious implementation) would read `stray` as the link.
    const over = rowCells('| 999 | 🔴 | pasted badly | - | 2026-08-30 | 2026-10-01 | stray | 191 |')
    expect(alignRowToHeaders(over, headers)).toEqual(
      ['999', '🔴', 'pasted badly', '-', '2026-08-30', 'stray', '191'],
    )
  })
})

describe('#426 snooze hazard: a misfiled value must never snooze a task', () => {
  const headers = rowCells(DEFERRED_HEADER)
  // The issue names this hazard explicitly: today `191` is discarded only
  // because it does not parse as a date — "luck, not design". A linked id that
  // IS date-shaped would have silently snoozed a live task.
  const DATE_SHAPED = '| 452 | 🔴 | linked id that looks like a date | - | 2026-08-30 | 2026-12-25 |'

  it('does not read a ragged row trailing field as a wake date', () => {
    expect(parseSnoozeUntil(DATE_SHAPED, headers)).toBeNull()
  })

  it('exposes that same value as the Linked ID instead', () => {
    const { rows } = parseMarkdownTable([
      DEFERRED_HEADER, DEFERRED_SEP, DATE_SHAPED,
    ])
    expect(idCell(rows, '452').linkedId).toBe('2026-12-25')
  })

  it('preserves the Linked ID when snoozing a ragged row', () => {
    // Before the fix this wrote the date over cells[5] — i.e. over `191` —
    // destroying #451's parent link as a side effect of snoozing it.
    const snoozed = setSnoozeUntilOnLine(RAGGED_451, '2026-10-01', headers)
    expect(rowCells(snoozed)).toEqual(
      ['451', '🔴', 'Report hit and run', '-', '2026-08-30', '2026-10-01', '191'],
    )
  })
})

describe('#426 writers emit the shape their section header declares', () => {
  it('writes 7 fields into Deferred, with the link in Linked ID', () => {
    const { content } = opAddTask(BOARD, {
      task: 'probe', priority: '🟡', linkedTask: '463', section: 'Deferred',
    })
    const row = content.split('\n').find(l => l.includes('| probe |'))
    expect(rowCells(row)).toHaveLength(7)
    expect(rowCells(row)[5]).toBe('')
    expect(rowCells(row)[6]).toBe('463')
  })

  it('writes 6 fields into Today', () => {
    const { content } = opAddTask(BOARD, {
      task: 'probe', priority: '🟡', linkedTask: '463', section: 'Today',
    })
    const row = content.split('\n').find(l => l.includes('| probe |'))
    expect(rowCells(row)).toHaveLength(6)
    expect(rowCells(row)[5]).toBe('463')
  })

  it('sets Linked ID without touching Wake on a 7-column row', () => {
    const next = opChangeLinkedId(BOARD, WELLFORMED_210, '999')
    const row = next.split('\n').find(l => l.startsWith('| 210 |'))
    expect(rowCells(row)[6]).toBe('999')
    expect(rowCells(row)[5]).toBe('')
  })

  it('sets Linked ID on a ragged row without inventing a wake date', () => {
    const next = opChangeLinkedId(BOARD, RAGGED_451, '777')
    const row = next.split('\n').find(l => l.startsWith('| 451 |'))
    expect(rowCells(row)[6]).toBe('777')
    expect(rowCells(row)[5]).toBe('')
  })
})

describe('#426 the single-source view must not reimplement the linked-id write', () => {
  // `handleChangeLinkedId` in App.jsx carried its own `parts[6] = …`, which is
  // the **Wake** cell on a 7-column row — the #307 defect, still live in the
  // copy wired into the single-source view. App.jsx cannot be imported (it
  // pulls in React and the whole tree), so this is asserted at the source.
  const src = readFileSync(new URL('./App.jsx', import.meta.url), 'utf8')

  it('has no hardcoded parts[6] assignment left', () => {
    const assignments = src.split('\n').filter(l => /^\s*parts\[6\]\s*=/.test(l))
    expect(assignments).toEqual([])
  })

  it('delegates to opChangeLinkedId', () => {
    expect(src).toMatch(/handleChangeLinkedId[\s\S]{0,600}?ops\.opChangeLinkedId/)
  })
})

describe('#426 acceptance: the reader agrees with the writer', () => {
  it('reports 0 rows whose parsed width disagrees with their section header', () => {
    const disagreements = []
    let headers = null
    for (const line of BOARD.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('|')) { if (trimmed.startsWith('## ')) headers = null; continue }
      const cells = rowCells(trimmed)
      if (cells[0] === 'ID' || cells[0] === '#') { headers = cells; continue }
      if (cells.every(c => /^[-:]+$/.test(c))) continue
      if (!headers) continue
      if (alignRowToHeaders(cells, headers).length !== headers.length) {
        disagreements.push(trimmed)
      }
    }
    expect(disagreements).toEqual([])
  })

  it('is a realistic fixture: the raw board really is malformed before alignment', () => {
    // Guards the audit above from passing vacuously against a tidy fixture.
    expect(findMalformedRows(BOARD, 'Deferred').map(r => r.id)).toEqual(['451'])
  })

  it('leaves no malformed Deferred row behind once a writer touches the board', () => {
    const { content } = opAddTask(BOARD, {
      task: 'probe', priority: '🟡', linkedTask: '', section: 'Deferred',
    })
    expect(findMalformedRows(content, 'Deferred')).toEqual([])
  })
})
