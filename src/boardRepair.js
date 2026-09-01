/**
 * #307 — recovery of the two wake dates a board rewrite destroyed, plus a
 * general "make every Deferred row well-formed" pass.
 *
 * WHY THIS IS A SEPARATE, PURE MODULE
 * -----------------------------------
 * The bug being fixed here *was an unattended rewrite of the user's primary
 * board*. Repairing it with another unattended rewrite would be the same move
 * that caused the damage. So the repair lives here as a pure
 * `content -> { content, changes }` function with no I/O at all: it is fully
 * unit-testable, and the only thing that can actually touch `planner.md` is
 * `scripts/repair-board-307.mjs`, which is dry-run by default and prints the
 * diff it *would* make. Merging this file changes no user data.
 *
 * PROVENANCE OF THE RECOVERED DATES
 * ---------------------------------
 * Both values were recovered from the planner's own journals, not guessed:
 *
 *  - #327 -> 2026-09-04, recorded in `journal/task-353.md`, the journal of the
 *    task that introduced the `Wake` column: "The next one is #327 on
 *    2026-09-04."
 *  - #254 -> 2026-09-08, recorded verbatim in `journal/task-400.md`, which
 *    captured the original board row before the rewrite:
 *      | 254 | ⚪ | Add dance church events to the calendar | - | 2026-06-13 | 191 | <!-- snooze:2026-09-08 -->
 *    The same line independently confirms #254's Linked ID is 191.
 *
 * (`planner.md.sync.json` holds only version/updatedAt/entries and carries no
 * wake or date data, so it is not a recovery source.)
 */
import { findMalformedRows } from './focusPlanOps.js'
import { normalizeDateOnly } from './snooze.js'

/** The wake dates lost on 2026-08-31, with where each was recovered from. */
export const RECOVERED_WAKES = Object.freeze({
  327: Object.freeze({ wake: '2026-09-04', source: 'journal/task-353.md' }),
  254: Object.freeze({ wake: '2026-09-08', source: 'journal/task-400.md (original row, line ~3050)' }),
})

function rowCells(line) {
  return String(line || '').trim().split('|').slice(1, -1).map(c => c.trim())
}

function formatRow(cells) {
  return `| ${cells.join(' | ')} |`
}

function isSeparator(cells) {
  return cells.length > 0 && cells.every(c => /^[-:]+$/.test(c))
}

function sectionBounds(lines, section) {
  const start = lines.findIndex(l => l.startsWith('## ') && l.replace('## ', '').trim() === section)
  if (start === -1) return null
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) { end = i; break }
  }
  return { start, end }
}

function headerInfo(lines, bounds) {
  for (let i = bounds.start + 1; i < bounds.end; i++) {
    const t = lines[i]?.trim()
    if (!t?.startsWith('|')) continue
    const cells = rowCells(t)
    if (isSeparator(cells)) continue
    return { index: i, headers: cells }
  }
  return null
}

/**
 * Plan (and apply, in memory) the repair of a Deferred table.
 *
 * Two independent repairs, each reported as a `change` so a caller can show the
 * user exactly what would happen:
 *
 *  - `pad`   — a row whose cell count disagrees with the header is re-shaped to
 *              the header width, padding at the `Wake` position so a trailing
 *              value (e.g. Linked ID `295`) stays in its own column instead of
 *              sliding into `Wake`.
 *  - `wake`  — a row in `recovered` whose `Wake` cell is empty gets its
 *              recovered date back.
 *
 * Pure: returns new content, never writes.
 *
 * @returns {{ content: string, changes: Array<object> }}
 */
export function planBoardRepair(content, { recovered = RECOVERED_WAKES, section = 'Deferred' } = {}) {
  const lines = String(content || '').split('\n')
  const changes = []
  const bounds = sectionBounds(lines, section)
  if (!bounds) return { content: String(content || ''), changes }
  const header = headerInfo(lines, bounds)
  if (!header) return { content: String(content || ''), changes }

  const width = header.headers.length
  const wakeIndex = header.headers.findIndex(h => h.trim() === 'Wake')
  const padIndex = wakeIndex === -1 ? width : wakeIndex

  for (let i = header.index + 1; i < bounds.end; i++) {
    const raw = lines[i]
    if (!raw?.trim().startsWith('|')) continue
    const cells = rowCells(raw)
    if (isSeparator(cells) || cells[0] === 'ID' || cells[0] === '#' || !cells.length) continue

    let next = [...cells]
    const before = raw.trim()

    if (next.length !== width) {
      const seam = Math.max(0, Math.min(padIndex, width))
      const head = next.slice(0, seam)
      const tail = next.slice(seam)
      next = next.length < width
        ? [...head, ...new Array(width - head.length - tail.length).fill(''), ...tail]
        : [...head.slice(0, width - tail.length), ...tail.slice(Math.max(0, tail.length - (width - head.length)))]
      changes.push({ kind: 'pad', id: next[0], from: cells.length, to: width, before, after: formatRow(next) })
    }

    const entry = recovered?.[next[0]]
    if (entry && wakeIndex !== -1 && !normalizeDateOnly(next[wakeIndex])) {
      next[wakeIndex] = entry.wake
      changes.push({ kind: 'wake', id: next[0], wake: entry.wake, source: entry.source, before, after: formatRow(next) })
    }

    if (formatRow(next) !== before) lines[i] = formatRow(next)
  }

  return { content: lines.join('\n'), changes }
}

/**
 * Post-repair verification: the repaired content must have zero rows whose cell
 * count disagrees with the header, and every recovered id must actually carry
 * its date. Returned rather than thrown so the script can print it.
 */
export function verifyBoardRepair(content, { recovered = RECOVERED_WAKES, section = 'Deferred' } = {}) {
  const malformed = findMalformedRows(content, section)
  const lines = String(content || '').split('\n')
  const bounds = sectionBounds(lines, section)
  const header = bounds ? headerInfo(lines, bounds) : null
  const wakeIndex = header ? header.headers.findIndex(h => h.trim() === 'Wake') : -1
  const missing = []
  for (const id of Object.keys(recovered)) {
    const row = lines.find(l => rowCells(l)[0] === id)
    const wake = row && wakeIndex !== -1 ? normalizeDateOnly(rowCells(row)[wakeIndex]) : null
    if (wake !== recovered[id].wake) missing.push({ id, expected: recovered[id].wake, actual: wake })
  }
  return { ok: malformed.length === 0 && missing.length === 0, malformed, missing }
}
