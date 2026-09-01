import { beforeEach, describe, expect, it } from 'vitest'

import {
  clearDiagnostics,
  dumpDiagnostics,
  enableDiagnostics,
  resetDiagnosticsForTests,
} from '../packages/diagnostics/src/index.js'
import { planBoardRepair, verifyBoardRepair, RECOVERED_WAKES } from './boardRepair.js'
import { findMalformedRows, opAddTask, opMoveBetweenSections } from './focusPlanOps.js'
import { parseSnoozeUntil } from './snooze.js'

// ── helpers ──────────────────────────────────────────────────────────
const cellsOf = line => String(line || '').trim().split('|').slice(1, -1).map(c => c.trim())
const rowFor = (content, id) => content.split('\n').find(l => cellsOf(l)[0] === String(id))
const deferredHeaders = (content) => {
  let inDeferred = false
  for (const line of content.split('\n')) {
    if (line.startsWith('## ')) { inDeferred = line.replace('## ', '').trim() === 'Deferred'; continue }
    if (!inDeferred || !line.trim().startsWith('|')) continue
    const cells = cellsOf(line)
    if (cells[0] === 'ID') return cells
  }
  return []
}
const wakeOf = (content, id) => parseSnoozeUntil(rowFor(content, id), deferredHeaders(content))

/**
 * The board exactly as it stood BEFORE the 2026-08-31 16:47:11 rewrite: a
 * 6-column Deferred table whose only wake dates live in legacy
 * `<!-- snooze:DATE -->` trailers. #254 and #327 are the two real rows.
 */
const LEGACY_BOARD = [
  '## Today',
  '',
  '| ID | 🎯 | Task | Work Priority | Added | Linked ID |',
  '|---|---|------|---------------|-------|-----------|',
  '| 463 | 🟡 | Ship issues | - | 2026-08-31 | 192 |',
  '',
  '## Deferred',
  '',
  '| ID | 🎯 | Task | Work Priority | Added | Linked ID |',
  '| --- | --- | ------ | --------------- | ------- | ----------- |',
  '| 446 | 🔴 | NVIDIA roles | - | 2026-08-24 | 295 |',
  '| 327 | 🟡 | Black lodge has emerald city soul club | - |  | <!-- snooze:2026-09-04 -->',
  '| 254 | ⚪ | Add dance church events to the calendar | - | 2026-06-13 | 191 | <!-- snooze:2026-09-08 -->',
  '',
].join('\n')

/** Any op that touches Deferred triggers the schema migration. */
const rewriteBoard = (content = LEGACY_BOARD) => opAddTask(
  content,
  { task: 'Report hit and run', priority: '🔴', linkedTask: '', section: 'Deferred' },
).content

describe('#307 — a board rewrite must migrate legacy snooze comments, never drop them', () => {
  // ROOT CAUSE, REPRODUCED. `ensureWakeColumn` migrated the Deferred table to
  // the 7-column `Wake` schema by rebuilding each row from `rowCells(line)` —
  // which slices off everything after the final `|`, i.e. the legacy
  // `<!-- snooze:DATE -->` trailer — and then `formatRow`ing the result. The row
  // came out well-formed with an EMPTY Wake cell: the user's date was gone, with
  // no tombstone and no log. Worse, any row whose cell count didn't equal the
  // OLD header width was skipped entirely, so it kept its old width under the
  // new 7-column header and a trailing Linked ID slid into the Wake slot.
  //
  // These tests round-trip through the WRITER. The pre-existing snooze tests
  // could not catch this: they only assert "legacy comment present -> parser
  // honours it", and the writer is the thing that destroys the comment.

  it('preserves a legacy wake date through the writer (#254 -> 2026-09-08)', () => {
    expect(wakeOf(LEGACY_BOARD, 254)).toBe('2026-09-08')
    const after = rewriteBoard()
    // Before the fix this was null: 7 well-formed cells with an empty Wake.
    expect(wakeOf(after, 254)).toBe('2026-09-08')
  })

  it('preserves a legacy wake date on a SHORT row (#327 -> 2026-09-04)', () => {
    // #327 has no Linked ID, so with the trailer stripped it is 5 cells against
    // a 6-column header — the `cells.length === headers.length` guard skipped it
    // outright, leaving it malformed AND unmigrated.
    expect(wakeOf(LEGACY_BOARD, 327)).toBe('2026-09-04')
    const after = rewriteBoard()
    expect(wakeOf(after, 327)).toBe('2026-09-04')
  })

  it('leaves no legacy snooze comment behind once the Wake column exists', () => {
    const after = rewriteBoard()
    expect(after).not.toContain('snooze:')
    // …because the dates moved into the column, not because they were deleted.
    expect(wakeOf(after, 254)).toBe('2026-09-08')
    expect(wakeOf(after, 327)).toBe('2026-09-04')
  })

  it('keeps a trailing Linked ID in Linked ID — it must not slide into Wake (#446/#356/#276)', () => {
    // The live-board damage: `295` (Linked ID, the "Apply to jobs" parent) ended
    // up in the Wake position, so three 🔴 tasks rendered a bogus wake AND read
    // as parentless, breaking the upstream-context walk.
    const after = rewriteBoard()
    const headers = deferredHeaders(after)
    const cells = cellsOf(rowFor(after, 446))
    expect(cells[headers.indexOf('Linked ID')]).toBe('295')
    expect(cells[headers.indexOf('Wake')]).toBe('')
  })

  it('never emits a row whose cell count disagrees with its section header', () => {
    // Guarantee 2, asserted on the writer's own output.
    expect(findMalformedRows(LEGACY_BOARD, 'Deferred').length).toBeGreaterThan(0)
    expect(findMalformedRows(rewriteBoard(), 'Deferred')).toEqual([])
  })

  it('survives a second rewrite pass (idempotent, no drift)', () => {
    const once = rewriteBoard()
    const twice = rewriteBoard(once)
    expect(wakeOf(twice, 254)).toBe('2026-09-08')
    expect(wakeOf(twice, 327)).toBe('2026-09-04')
    expect(findMalformedRows(twice, 'Deferred')).toEqual([])
  })

  it('carries a legacy wake date across a section move (Today has no Wake column)', () => {
    // The second loss site: transformRowForSection stripped the trailer and
    // sourced Wake only from the source row's own Wake cell.
    const moved = opMoveBetweenSections(
      LEGACY_BOARD,
      '| 254 | ⚪ | Add dance church events to the calendar | - | 2026-06-13 | 191 | <!-- snooze:2026-09-08 -->',
      'Deferred',
      'Deferred',
    )
    expect(parseSnoozeUntil(rowFor(moved, 254), deferredHeaders(moved))).toBe('2026-09-08')
  })

  it('migrates a legacy row even when the Wake column ALREADY exists', () => {
    // The original code early-returned as soon as the header contained `Wake`,
    // so a legacy-format row arriving after the schema change — synced from a
    // replica still on the old build, or written by an external agent following
    // the older format SKILL.md documents — would sit there forever with its
    // date in a comment the column-first reader ignores. This is the live
    // board's current shape, so it is the case that actually matters now.
    const modernBoardWithLegacyRow = [
      '## Deferred',
      '',
      '| ID | 🎯 | Task | Work Priority | Added | Wake | Linked ID |',
      '| --- | --- | ------ | --------------- | ------- | ---- | ----------- |',
      '| 254 | ⚪ | Add dance church events to the calendar | - | 2026-06-13 | 191 | <!-- snooze:2026-09-08 -->',
      '',
    ].join('\n')
    const after = rewriteBoard(modernBoardWithLegacyRow)
    expect(wakeOf(after, 254)).toBe('2026-09-08')
    expect(after).not.toContain('snooze:')
    expect(findMalformedRows(after, 'Deferred')).toEqual([])
  })

  it('carries a legacy date through transformRowForSection when the source table is already modern', () => {
    // Pins the `|| legacyWake` fallback inside transformRowForSection itself:
    // a Today row (no Wake column anywhere in Today) carrying a legacy trailer,
    // moved into a Deferred table that already has the column.
    const board = [
      '## Today',
      '',
      '| ID | 🎯 | Task | Work Priority | Added | Linked ID |',
      '|---|---|------|---------------|-------|-----------|',
      '| 900 | 🟡 | Legacy carrier | - | 2026-08-01 | 191 | <!-- snooze:2026-12-25 -->',
      '',
      '## Deferred',
      '',
      '| ID | 🎯 | Task | Work Priority | Added | Wake | Linked ID |',
      '| --- | --- | ------ | --------------- | ------- | ---- | ----------- |',
      '',
    ].join('\n')
    const moved = opMoveBetweenSections(
      board,
      '| 900 | 🟡 | Legacy carrier | - | 2026-08-01 | 191 | <!-- snooze:2026-12-25 -->',
      'Today',
      'Deferred',
    )
    expect(wakeOf(moved, 900)).toBe('2026-12-25')
  })
})

describe('#307 — an un-migratable wake date is logged as an anomaly, never dropped silently', () => {
  // Guarantee 3, and deliberately the SAME rule #190/PR #306 established one
  // layer down (`phantom-meta-preserved` / `alive-without-record`): a live value
  // is either deliberately removed or it is a recoverable anomaly — never
  // nothing. Same `diag`/`isDiagEnabled` mechanism, not a parallel one.
  beforeEach(() => {
    resetDiagnosticsForTests()
    enableDiagnostics({ persist: false })
    clearDiagnostics()
  })

  const events = () => dumpDiagnostics().filter(e => e.channel === 'planner.board')

  it('logs when a wake date is dropped because the destination has no Wake column', () => {
    // Deferred -> Today legitimately clears the wake, but the value stops
    // existing, so it must be recorded rather than vanish.
    opMoveBetweenSections(
      LEGACY_BOARD,
      '| 254 | ⚪ | Add dance church events to the calendar | - | 2026-06-13 | 191 | <!-- snooze:2026-09-08 -->',
      'Deferred',
      'Today',
    )
    const dropped = events().filter(e => e.event === 'wake-dropped-on-section-move')
    expect(dropped.length).toBeGreaterThan(0)
    expect(dropped.at(-1).fields.wake).toBe('2026-09-08')
  })

  it('logs a conflict when the Wake column and the legacy comment disagree', () => {
    // A row that already carries a date in the position Wake will occupy, plus a
    // disagreeing legacy trailer. The column wins, but the discard is recorded.
    const withConflict = LEGACY_BOARD.replace(
      '| 254 | ⚪ | Add dance church events to the calendar | - | 2026-06-13 | 191 | <!-- snooze:2026-09-08 -->',
      '| 254 | ⚪ | Add dance church events to the calendar | - | 2026-06-13 | 2026-10-01 | 191 | <!-- snooze:2026-09-08 -->',
    )
    rewriteBoard(withConflict)
    const conflicts = events().filter(e => e.event === 'wake-migration-conflict')
    expect(conflicts.length).toBeGreaterThan(0)
    expect(conflicts.at(-1).fields).toMatchObject({ kept: '2026-10-01', discarded: '2026-09-08' })
  })

  it('stays silent when there is nothing to report', () => {
    rewriteBoard()
    expect(events().filter(e => e.event.startsWith('wake-migration'))).toEqual([])
  })
})

describe('#307 — recovery of the two dates the rewrite already destroyed', () => {
  // Guarantee 4. Pure, in-memory, dry-run-able; nothing here touches a real
  // board (see src/boardRepair.js for why that matters).
  const DAMAGED = [
    '## Deferred',
    '',
    '| ID | 🎯 | Task | Work Priority | Added | Wake | Linked ID |',
    '| --- | --- | ------ | --------------- | ------- | ---- | ----------- |',
    '| 464 | 🟡 | Daily, check instagram | - | 2026-08-31 |  |',
    '| 451 | 🔴 | Report hit and run | - | 2026-08-30 |  |',
    '| 446 | 🔴 | NVIDIA roles | - | 2026-08-24 | 295 |',
    '| 356 | 🔴 | De-AI the pars and resume | - | 2026-07-05 | 295 |',
    '| 276 | 🔴 | Apply to github job | - | 2026-06-16 | 295 |',
    '| 327 | 🟡 | Black lodge has emerald city soul club | - |  |  |  |',
    '| 254 | ⚪ | Add dance church events to the calendar | - | 2026-06-13 |  | 191 |',
    '',
  ].join('\n')

  it('reproduces the live damage: 5 malformed rows and 0 wake dates', () => {
    expect(findMalformedRows(DAMAGED, 'Deferred').map(r => r.id)).toEqual(['464', '451', '446', '356', '276'])
    expect(wakeOf(DAMAGED, 254)).toBeNull()
    expect(wakeOf(DAMAGED, 327)).toBeNull()
  })

  it('restores #327 -> 2026-09-04 and #254 -> 2026-09-08 from journal provenance', () => {
    const { content, changes } = planBoardRepair(DAMAGED)
    expect(wakeOf(content, 327)).toBe('2026-09-04')
    expect(wakeOf(content, 254)).toBe('2026-09-08')
    const wakeChanges = changes.filter(c => c.kind === 'wake')
    expect(wakeChanges.map(c => c.id).sort()).toEqual(['254', '327'])
    // Every recovered value must say where it came from.
    for (const c of wakeChanges) expect(c.source).toMatch(/journal\/task-\d+\.md/)
  })

  it('returns the three job tasks their Linked ID = 295 instead of a bogus wake', () => {
    const { content } = planBoardRepair(DAMAGED)
    const headers = deferredHeaders(content)
    for (const id of [446, 356, 276]) {
      const cells = cellsOf(rowFor(content, id))
      expect(cells[headers.indexOf('Linked ID')]).toBe('295')
      expect(cells[headers.indexOf('Wake')]).toBe('')
    }
  })

  it('leaves zero malformed rows and verifies its own result', () => {
    const { content } = planBoardRepair(DAMAGED)
    expect(findMalformedRows(content, 'Deferred')).toEqual([])
    expect(verifyBoardRepair(content)).toMatchObject({ ok: true, malformed: [], missing: [] })
    expect(verifyBoardRepair(DAMAGED).ok).toBe(false)
  })

  it('is idempotent and reports no changes on an already-repaired board', () => {
    const once = planBoardRepair(DAMAGED).content
    const twice = planBoardRepair(once)
    expect(twice.changes).toEqual([])
    expect(twice.content).toBe(once)
  })

  it('never overwrites a wake date the user has since set', () => {
    const userSet = DAMAGED.replace(
      '| 254 | ⚪ | Add dance church events to the calendar | - | 2026-06-13 |  | 191 |',
      '| 254 | ⚪ | Add dance church events to the calendar | - | 2026-06-13 | 2027-01-01 | 191 |',
    )
    expect(wakeOf(planBoardRepair(userSet).content, 254)).toBe('2027-01-01')
  })

  it('pins the recovered values and their provenance', () => {
    expect(RECOVERED_WAKES[327].wake).toBe('2026-09-04')
    expect(RECOVERED_WAKES[254].wake).toBe('2026-09-08')
    expect(RECOVERED_WAKES[327].source).toContain('task-353')
    expect(RECOVERED_WAKES[254].source).toContain('task-400')
  })
})
