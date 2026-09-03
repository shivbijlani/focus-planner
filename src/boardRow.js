/**
 * The board's one canonical row/header alignment rule (#426).
 *
 * `planner.md` is hand-editable, so its tables are **ragged**: `## Deferred` has
 * a 7-column header (`… | Added | Wake | Linked ID |`) while `## Today` has 6
 * (no `Wake`), and rows written before `Wake` existed — or by a writer that did
 * not know about it — carry only 6 fields under the 7-column header.
 *
 * Every reader and writer therefore has to answer the same question: given this
 * row's cells and this table's header, which cell is `Linked ID` and which is
 * `Wake`? Answering it in more than one place is what #426 actually is — the
 * writer (`opAddTask`, fixed in #307) and the reader (`parseMarkdownTable`)
 * disagreed, so a row the writer emitted correctly was read back wrong.
 *
 * So this module is deliberately the *only* implementation, imported by the
 * writer (`focusPlanOps.js`), the reader (`boardTable.js`) and the snooze
 * column accessors (`snooze.js`). "The reader agrees with the writer" then holds
 * by construction rather than by keeping two edits in sync.
 *
 * The rule itself is not new: it is the seam logic proven by #307, and it
 * matches what the agent-side reader (`oa-state.ps1 extract`) already does —
 * which is precisely why that reader resolved `451 -> #191` correctly while the
 * app did not.
 */

export const WAKE_COLUMN = 'Wake'

export function rowCells(line) {
  return String(line || '').trim().split('|').slice(1, -1).map(c => c.trim())
}

export function formatRow(cells) {
  return `| ${cells.join(' | ')} |`
}

export function isTableSeparatorCells(cells) {
  return cells.length > 0 && cells.every(c => /^[-:]+$/.test(c))
}

/**
 * The index the tail is anchored at: the `Wake` column, or the end of the
 * header when there is no `Wake` column.
 */
export function wakeSeamIndex(headers) {
  if (!Array.isArray(headers)) return 0
  const wakeIndex = headers.findIndex(h => String(h || '').trim() === WAKE_COLUMN)
  return wakeIndex === -1 ? headers.length : wakeIndex
}

/**
 * Re-shape one row's cells so they line up with `headers`.
 *
 * Padding **position** is the whole point. The leading columns
 * (ID, 🎯, Task, Priority, Added) are positionally reliable, but the tail is
 * not: a short row like
 *
 *     | 451 | 🔴 | Report hit and run | - | 2026-08-30 | 191 |
 *
 * carries `191` as its **Linked ID**, and naively appending an empty cell at
 * the end would leave `191` in the freshly inserted `Wake` slot — a bogus wake
 * date AND an apparently parentless task.
 *
 * So we split at the seam: cells before it keep their left-aligned positions,
 * cells from it onward stay **right-aligned** to the end of the header, and any
 * missing cells are inserted at the seam. `191` therefore lands in `Linked ID`
 * and `Wake` is empty — which is what the row always meant.
 *
 * The inverse (a row with too many cells, e.g. the live board's Today row #245
 * with a trailing spare cell) keeps the head and the right-most tail that still
 * fits, so a trailing `Linked ID` stays in the last column rather than shifting.
 */
export function alignRowToHeaders(cells, headers) {
  if (!Array.isArray(cells) || !Array.isArray(headers) || headers.length === 0) {
    return Array.isArray(cells) ? [...cells] : []
  }
  const width = headers.length
  if (cells.length === width) return [...cells]
  const seam = Math.max(0, Math.min(wakeSeamIndex(headers), width))
  const head = cells.slice(0, seam)
  const tail = cells.slice(seam)
  if (cells.length < width) {
    const fill = new Array(Math.max(0, width - head.length - tail.length)).fill('')
    return [...head, ...fill, ...tail]
  }
  const keepTail = tail.slice(Math.max(0, tail.length - (width - head.length)))
  return [...head.slice(0, width - keepTail.length), ...keepTail]
}

/**
 * Read one header-named cell off a raw row, aligning first.
 *
 * This is the accessor readers should use instead of `cells[headers.indexOf(x)]`
 * — that expression is #426 in its shortest form.
 */
export function cellByHeader(cells, headers, headerName) {
  if (!Array.isArray(headers)) return ''
  const index = headers.findIndex(h => String(h || '').trim() === headerName)
  if (index === -1) return ''
  return alignRowToHeaders(cells, headers)[index] ?? ''
}
