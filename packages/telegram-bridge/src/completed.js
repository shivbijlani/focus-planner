// Parses the completed board (`planner-completed.md`) into the set of task IDs
// that are currently marked done. The bridge uses this to decide which task
// topics should be archived (closed). The board groups rows under weekly
// headings; each completed row is a markdown table row whose first cell is the
// numeric task ID, e.g.:
//
//   | 401 | ✅ | Draft house-sitter directions doc | - | 2026-08-02 |
//
// We only treat rows whose first cell is all digits as tasks, so the header row
// (`| # | 🎯 | ... |`) and the `|---|---|` separator are ignored.

/**
 * @param {string} markdown raw contents of planner-completed.md
 * @returns {string[]} unique completed task IDs, in first-seen order
 */
export function parseCompletedTaskIds(markdown) {
  if (!markdown) return []
  const ids = []
  const seen = new Set()
  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line.startsWith('|')) continue
    // First table cell = text between the first and second pipe.
    const secondPipe = line.indexOf('|', 1)
    if (secondPipe === -1) continue
    const firstCell = line.slice(1, secondPipe).trim()
    if (!/^\d+$/.test(firstCell)) continue
    if (seen.has(firstCell)) continue
    seen.add(firstCell)
    ids.push(firstCell)
  }
  return ids
}
