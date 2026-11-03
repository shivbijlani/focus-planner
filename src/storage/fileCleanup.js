const TOOL_SNAPSHOTS = new Set(['create-menu.md', 'ig-home.md', 'post-composer.md'])
const INTERNAL_FILES = new Set([
  'AGENTS.md', 'agent-gate.md', 'agent-lore.md', 'agent-memory.md',
  'diagnostics.md', 'user-settings.md',
])

export function cleanupCategory(path) {
  // Conflict copies and Docs may be the only surviving version of an edit.
  if (/^(sync-conflicts|docs|agent-metadata)\//.test(path)) return null
  if (path.startsWith('.playwright-mcp/') || TOOL_SNAPSHOTS.has(path)) return 'Tooling leftovers'
  if (/\.(bak|backup)(?:[-.]|$)/i.test(path)) return 'Old backup copies'
  return null
}

export function isSidebarClutter(path) {
  return path.split('/').some(part => part.startsWith('.'))
    || /^(sync-conflicts|agent-metadata)(\/|$)/.test(path)
    || INTERNAL_FILES.has(path)
    || cleanupCategory(path) !== null
}

export async function makeFileArchive(paths, read) {
  const files = {}
  for (const path of paths) files[path] = await read(path)
  return JSON.stringify({ format: 'planner-file-archive', files }, null, 2)
}

export function downloadArchive(contents) {
  const url = URL.createObjectURL(new Blob([contents], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `planner-cleanup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
