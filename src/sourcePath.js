export function journalReadStateId(sourceId, taskId) {
  return sourceId ? `${sourceId}::${taskId}` : String(taskId)
}
