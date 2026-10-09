// Descriptive task files can be reports, recipes, or other artifacts, not a
// second journal. Classify only for display; never group or deduplicate paths.
export function journalFilePresentation(path) {
  const match = path.replace(/\\/g, '/').match(/(?:^|\/)journal\/task-(\d+)(?:-([^/]+))?\.md$/)
  if (!match) return null

  const [, taskId, description] = match
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
