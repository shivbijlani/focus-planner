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
