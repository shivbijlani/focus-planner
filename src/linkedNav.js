// Pure helpers for deciding where a "linked task" navigation should land.
//
// A linked-id chip navigates to the task it points at. If that task's row is
// not currently in the DOM (e.g. hidden by an active search filter, or on a
// collapsed/other page), the UI has to decide which board to open. The bug in
// task #394 was that a *live* task hidden by a search filter was wrongly routed
// to the completed board. These helpers centralize the "is it actually active?"
// test so the navigation fallback and the "missing" badge can never drift apart.

/** Pull the first run of digits out of a linked id (which may be a number,
 *  a string, or a "123 (title)" style label). Returns the id string or null. */
export function extractLinkedNum(linkedId) {
  if (linkedId === 0 || linkedId === '0') return '0'
  if (!linkedId) return null
  const m = String(linkedId).match(/(\d+)/)
  return m ? m[1] : null
}

/** True only when we can positively determine the linked task is NOT among the
 *  active tasks. When activeTaskIds is unknown (not an array) we return false —
 *  we never assume a task is missing without evidence. Mirrors the inline
 *  `isLinkedTaskMissing` used to render the "missing" badge. */
export function shouldNavigateToCompleted(linkedId, activeTaskIds) {
  const num = extractLinkedNum(linkedId)
  if (!num) return false
  if (!Array.isArray(activeTaskIds)) return false
  return !activeTaskIds.includes(num)
}

/** Choose which board file a linked-id navigation should fall back to when the
 *  target row isn't in the DOM. An active (or unknown) task goes to the plan
 *  board; only a task we know is not active goes to the completed board. */
export function linkedNavFallbackFile(linkedId, activeTaskIds, planFile, completedFile) {
  return shouldNavigateToCompleted(linkedId, activeTaskIds) ? completedFile : planFile
}
