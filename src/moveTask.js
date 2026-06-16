/**
 * Helpers for moving a task between sources.
 *
 * When the user right-clicks a task and chooses "Move to {source}", we need to:
 *   1. Figure out exactly which tasks are travelling with it.
 *   2. Warn about cross-source links that will break (incoming links from
 *      tasks that are staying behind).
 *
 * A "manager priority" task carries its full dependency subtree with it:
 * every task whose chain (via linkedIdMap) resolves up to the moving task is
 * dragged along. For a non-priority task, only that task moves.
 */

import { resolveManagerPriority } from './taskSort.js'

/**
 * Compute the set of task IDs that should move together when the user
 * moves `taskId`.
 *
 *  - If `taskId` is a manager priority, every task whose dependency chain
 *    resolves to it is included (the entire subtree).
 *  - Otherwise just `taskId` itself.
 *
 * Returns a Set<string> of task IDs (always includes `taskId`).
 */
export function computeMoveSet(taskId, managerPriorities, linkedIdMap, allTaskIds) {
  const moving = new Set()
  if (!taskId) return moving
  moving.add(String(taskId))

  if (!managerPriorities || !managerPriorities[taskId]) {
    return moving
  }

  // Manager priority — pull in every descendant.
  const ids = Array.isArray(allTaskIds) ? allTaskIds : Object.keys(allTaskIds || {})
  for (const id of ids) {
    if (id === taskId) continue
    const resolved = resolveManagerPriority(id, linkedIdMap || {}, managerPriorities)
    if (resolved && resolved.id === taskId) {
      moving.add(String(id))
    }
  }
  return moving
}

/**
 * Compute the set of incoming links that will break when `movingIds` leave
 * the current source. A "broken link" is a task that is *not* moving but
 * whose `linkedId` points at a task that *is* moving.
 *
 * Returns an array of `{ fromId, fromName, toId }`.
 */
export function computeBrokenLinks(movingIds, linkedIdMap, taskLookup) {
  const broken = []
  if (!movingIds || !linkedIdMap) return broken
  const moveSet = movingIds instanceof Set ? movingIds : new Set(movingIds)
  for (const [fromId, toId] of Object.entries(linkedIdMap)) {
    if (moveSet.has(fromId)) continue
    if (moveSet.has(toId)) {
      broken.push({
        fromId,
        fromName: (taskLookup && taskLookup[fromId]) || '',
        toId,
      })
    }
  }
  return broken
}

/**
 * Parse the local numeric task ID from an ID cell that may carry an ADO
 * suffix, e.g. `"426576,[419965](url)"` → `"426576"`.
 */
export function parseLocalId(idCell) {
  const s = String(idCell).trim()
  const commaIdx = s.indexOf(',[')
  const local = commaIdx !== -1 ? s.slice(0, commaIdx) : s
  const m = local.trim().match(/^(\d+)/)
  return m ? m[1] : null
}

/** The highest local task ID present in a focus-plan markdown string. */
export function maxTaskIdInRows(text) {
  let max = 0
  for (const line of String(text).split('\n')) {
    const t = line.trim()
    if (!t.startsWith('|')) continue
    const cells = t.split('|').slice(1, -1).map(c => c.trim())
    if (!cells.length || cells[0] === 'ID' || /^[-:]+$/.test(cells[0])) continue
    const id = parseLocalId(cells[0])
    if (id) max = Math.max(max, parseInt(id, 10))
  }
  return max
}

/**
 * Rewrite a markdown task row: set its local ID to `newId` (preserving any
 * `,[ado](url)` suffix) and remap its Linked ID column if it points at an ID
 * in `idMap` (so links *within* the moving set stay intact).
 */
export function rewriteRowId(rawLine, newId, idMap = new Map()) {
  const parts = rawLine.split('|')
  if (parts.length < 3) return rawLine
  const idCell = parts[1].trim()
  const commaIdx = idCell.indexOf(',[')
  const suffix = commaIdx !== -1 ? idCell.slice(commaIdx) : ''
  parts[1] = ` ${newId}${suffix} `
  // Linked ID is the last data cell (parts ends with '' after the trailing |).
  const linkedIdx = parts.length - 2
  if (linkedIdx >= 2) {
    const linked = parts[linkedIdx].trim()
    const lm = linked.match(/^(\d+)/)
    if (lm && idMap.has(lm[1])) {
      parts[linkedIdx] = ` ${idMap.get(lm[1])}${linked.slice(lm[1].length)} `
    }
  }
  return parts.join('|')
}

/**
 * Renumber moving rows into a target source's own sequence so a task moved
 * between folders never carries a foreign ID across (which would otherwise
 * inflate the target folder's numbering).
 *
 * IDs are assigned contiguously above `baseId` (the target's current max task
 * ID), skipping any IDs already taken by a journal in the target so we never
 * clobber an existing journal. Links among the moving rows are remapped.
 *
 * Returns `{ idMap: Map<oldId,newId>, rows: [{ ...row, oldId, newId, newRawLine }] }`.
 */
export function renumberMovedRows(movingRows, baseId, takenJournalIds = new Set()) {
  const idMap = new Map()
  const taken = takenJournalIds instanceof Set ? takenJournalIds : new Set()
  let next = Number(baseId) || 0
  const prepared = (movingRows || []).map(r => {
    next += 1
    while (taken.has(next)) next += 1
    const oldId = String(r.taskId)
    idMap.set(oldId, String(next))
    return { ...r, oldId, newId: String(next) }
  })
  const rows = prepared.map(p => ({
    ...p,
    newRawLine: rewriteRowId(p.rawLine, p.newId, idMap),
  }))
  return { idMap, rows }
}

/** Retitle a journal's first `# Task <id>:` heading to a new ID. */
export function retitleJournal(journalContent, newId) {
  return String(journalContent).replace(/^# Task \d+:/, `# Task ${newId}:`)
}
