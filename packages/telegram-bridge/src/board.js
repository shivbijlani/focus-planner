// Parses the ACTIVE board (`planner.md`) so the approval digest can be ordered
// by how much the user actually cares, instead of by task-ID magnitude.
//
// Why this exists: the digest has a hard Telegram size cap, so with a large
// queue only the first ~17 of ~99 asks survive; everything else collapses into
// "…and N more". That makes the ORDER the whole feature — whatever leads the
// message is, in practice, the only thing the user sees.
//
// Sorting by `Number(taskId)` descending looked like "newest first", but task
// IDs are not a priority signal. Two ways it goes wrong in the live board:
//
//   1. Malformed six-digit IDs (see task #281, "Task id's are broken") sort
//      ABOVE every real task forever. Observed live: #426580, a stale June
//      parade question, permanently occupied the top slot above two P0 merge
//      asks.
//   2. A genuine P0 sits below whatever happened to be filed most recently.
//
// The board already encodes the real answer — the user maintains it by hand:
// `## Today` outranks `## Deferred`, row order within a section is their own
// ordering, and 🔴 / `P0` mark urgency. So rank by the board, and let anything
// not on the board at all (orphans, completed rows, broken IDs) sink last.

/** Section a row was found under, in descending importance. */
const SECTION_TODAY = 'today'
const SECTION_DEFERRED = 'deferred'
const SECTION_OTHER = 'other'

// Rank tiers. Lower sorts first. `UNLISTED` is deliberately worse than every
// on-board tier so an orphaned/broken-ID task can never outrank a real one.
export const RANK_TODAY_URGENT = 0
export const RANK_TODAY = 1
export const RANK_DEFERRED_URGENT = 2
export const RANK_DEFERRED = 3
export const RANK_OTHER = 4
export const RANK_UNLISTED = 5

function sectionFromHeading(line) {
  const m = /^#{1,6}\s+(.+?)\s*$/.exec(line)
  if (!m) return null
  const name = m[1].trim().toLowerCase()
  if (name === 'today') return SECTION_TODAY
  if (name === 'deferred') return SECTION_DEFERRED
  return SECTION_OTHER
}

/** Split a markdown table row into trimmed cells. */
function cells(line) {
  const trimmed = line.trim()
  if (!trimmed.startsWith('|')) return null
  // Drop the leading pipe, then split. A trailing pipe yields a final empty
  // cell, and rows in this board sometimes carry a trailing HTML comment
  // (e.g. `<!-- snooze:… -->`) after the last pipe — both are harmless because
  // we only read the leading columns by index.
  return trimmed.slice(1).split('|').map((c) => c.trim())
}

/**
 * Is this row urgent? The board marks urgency two independent ways and either
 * one counts: the 🎯 column's red circle, or an explicit `P0` work priority.
 */
function isUrgent(icon, workPriority) {
  if (icon && icon.includes('\u{1F534}')) return true // 🔴
  return /^p0$/i.test((workPriority || '').trim())
}

/**
 * Parse `planner.md` into a lookup of task ID → board position.
 *
 * Columns are `ID | 🎯 | Task | Work Priority | Added | Linked ID`. Only rows
 * whose first cell is all digits are treated as tasks, which skips the header
 * and the `|---|---|` separator. The `## Priorities` section is a numbered
 * list rather than a table, so it contributes no rows.
 *
 * @param {string} markdown raw contents of planner.md
 * @returns {Map<string, {section: string, index: number, urgent: boolean}>}
 */
export function parseBoardOrder(markdown) {
  const out = new Map()
  if (!markdown) return out

  let section = SECTION_OTHER
  let index = 0

  for (const rawLine of markdown.split(/\r?\n/)) {
    const heading = sectionFromHeading(rawLine)
    if (heading) {
      section = heading
      continue
    }

    const cols = cells(rawLine)
    if (!cols || cols.length === 0) continue
    const id = cols[0]
    if (!/^\d+$/.test(id)) continue
    // First occurrence wins, so a task listed twice keeps its highest position.
    if (out.has(id)) continue

    out.set(id, {
      section,
      index: index++,
      urgent: isUrgent(cols[1], cols[3]),
    })
  }

  return out
}

/**
 * Rank tier for a task ID against a parsed board. Unknown IDs — orphans,
 * already-completed rows, and the malformed six-digit IDs from #281 — get
 * `RANK_UNLISTED` so they sort behind everything the user is actually tracking.
 */
export function boardRank(board, taskId) {
  const entry = board && board.get ? board.get(String(taskId)) : null
  if (!entry) return RANK_UNLISTED
  if (entry.section === SECTION_TODAY) {
    return entry.urgent ? RANK_TODAY_URGENT : RANK_TODAY
  }
  if (entry.section === SECTION_DEFERRED) {
    return entry.urgent ? RANK_DEFERRED_URGENT : RANK_DEFERRED
  }
  return RANK_OTHER
}

/**
 * Position within the board, used to break ties inside a rank tier so the
 * user's own top-to-bottom ordering is preserved. Unlisted tasks sort last.
 */
export function boardIndex(board, taskId) {
  const entry = board && board.get ? board.get(String(taskId)) : null
  return entry ? entry.index : Number.MAX_SAFE_INTEGER
}
