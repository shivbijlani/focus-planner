import { extractTaskId } from './taskSort.js'

// Board search/filter (#271): rapid filtering to find a task by ID or text.

export function normalizeQuery(query) {
  return (query || '').trim().toLowerCase()
}

/**
 * A task row matches the search if the (normalized) query is a substring of its
 * ID or its Task text. An empty query matches everything.
 */
export function taskRowMatchesSearch(row, query) {
  const q = normalizeQuery(query)
  if (!q) return true
  const id = String(extractTaskId(row) || '').toLowerCase()
  const task = String((row && row['Task']) || '').toLowerCase()
  return id.includes(q) || task.includes(q)
}

/**
 * Filter parallel `rows` / `rawLines` arrays by the query, preserving their
 * alignment. Returns the filtered arrays plus a `matchCount`. With an empty
 * query the inputs pass through unchanged.
 */
export function filterRowsAndRawLines(rows, rawLines, query) {
  const q = normalizeQuery(query)
  if (!q) return { rows, rawLines, matchCount: rows.length }
  const fRows = []
  const fRaw = []
  rows.forEach((row, i) => {
    if (taskRowMatchesSearch(row, q)) {
      fRows.push(row)
      fRaw.push(rawLines[i])
    }
  })
  return { rows: fRows, rawLines: fRaw, matchCount: fRows.length }
}
