export function journalContent(taskId, taskName) {
  const cleanName = (taskName || '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').trim()
  return `# Task ${taskId}: ${cleanName}\n\n- TODO: \n`
}

export async function createJournalInSource(storageApi, sourceId, taskId, taskName) {
  if (!sourceId) throw new Error('A source id is required to create a combined-view journal')
  const path = `journal/task-${taskId}.md`
  await storageApi.writeToSource(sourceId, path, journalContent(taskId, taskName))
  return path
}
