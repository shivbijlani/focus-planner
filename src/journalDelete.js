// Deleting a task must remove its journal, and that decision must not depend on
// lazily-loaded UI state.
//
// The bug this fixes (#185): the row's journal path is loaded per-row and starts
// as `null` (`journalState.path`, `contentStatus: 'loading'`). The context menu
// captures whatever that value is at the moment it is built, and the delete
// handler skipped the journal on a falsy path. Deleting a task before its
// journal state resolved therefore removed the board row and silently left
// `journal/task-<id>.md` on disk, with no error — a plausible contributor to the
// orphan journals `board-integrity` reports.
//
// The fix is to resolve the journal at delete time instead of trusting the
// captured value: fall back to asking storage whether the task has a journal.

/**
 * Decide which journal path to delete for a task.
 *
 * Prefers the already-resolved path when the row had loaded. Otherwise asks
 * storage, so a delete that happens while the row is still loading behaves the
 * same as one that happens after.
 *
 * @param {string|null|undefined} journalPath path captured from row state, may be falsy
 * @param {string|number|null|undefined} taskId the task's id
 * @param {(taskId: string|number) => Promise<{exists: boolean, path: string}>} checkJournal
 * @returns {Promise<string|null>} the path to remove, or null when there is no journal
 */
export async function resolveJournalPathForDelete(journalPath, taskId, checkJournal) {
  if (journalPath) return journalPath
  if (taskId === null || taskId === undefined || `${taskId}`.trim() === '') return null
  if (typeof checkJournal !== 'function') return null

  const result = await checkJournal(taskId)
  if (result && result.exists && result.path) return result.path
  return null
}

/**
 * Remove a task's journal, resolving the path at delete time.
 *
 * Errors are reported through `onError` rather than swallowed, so a genuine
 * storage failure is visible instead of looking identical to "no journal".
 * A task that genuinely has no journal is a silent no-op.
 *
 * @returns {Promise<boolean>} true when a journal was removed
 */
export async function deleteJournalForTask({ journalPath, taskId, checkJournal, remove, onError }) {
  const report = (err) => {
    if (typeof onError === 'function') onError(err)
  }

  let path
  try {
    path = await resolveJournalPathForDelete(journalPath, taskId, checkJournal)
  } catch (err) {
    // Failing to even determine whether a journal exists is a real failure and
    // must not be mistaken for "there was nothing to delete".
    report(err)
    return false
  }

  if (!path) return false

  try {
    await remove(path)
    return true
  } catch (err) {
    report(err)
    return false
  }
}
