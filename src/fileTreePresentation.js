// Descriptive task files can be reports, recipes, or other artifacts, not a
// second journal. Classify only for display; never group or deduplicate paths.
export function taskBriefingPath(taskId) {
  const id = String(taskId ?? '')
  return /^\d+$/.test(id) ? `journal/task-${id}-briefing.md` : null
}

export function journalFilePresentation(path) {
  const match = path.replace(/\\/g, '/').match(/(?:^|\/)journal\/task-(\d+)(?:-([^/]+))?\.md$/)
  if (!match) return null

  const [, taskId, description] = match
  if (description === 'briefing') {
    return {
      icon: '📑',
      label: `Briefing · Task ${taskId}`,
      title: `Primary Markdown briefing for Task ${taskId}; independent from the journal and any Docs primary`,
    }
  }
  return description
    ? {
        icon: '📄',
        label: `Supporting doc · Task ${taskId}`,
        title: `Supporting document for Task ${taskId}, separate from task-${taskId}.md`,
      }
    : {
        icon: '📔',
        label: `Journal · Task ${taskId}`,
        title: `Chronological journal for Task ${taskId}`,
      }
}
