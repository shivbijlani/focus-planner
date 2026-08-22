export function joinSourcePath(sourceId, path) {
  return sourceId ? `${sourceId}::${path}` : path
}

export function journalReadStateId(sourceId, taskId) {
  return joinSourcePath(sourceId, String(taskId))
}
