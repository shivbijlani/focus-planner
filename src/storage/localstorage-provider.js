/**
 * Browser localStorage provider for focus-planner — default for new visitors.
 * Stores all markdown files under `fp-file:<path>` keys.
 */
import { parseTodos } from './fsa.js'

const PREFIX = 'fp-file:'

const SCAFFOLD_FOCUS_PLAN = `## Today

| ID | 🎯 | Task | Priority | Added | Linked ID |
|---|---|------|----------|-------|-----------|

## Deferred

| ID | 🎯 | Task | Priority | Added | Linked ID |
|---|---|------|----------|-------|-----------|

## Priorities

`

const SCAFFOLD_COMPLETED = `# Completed Tasks
`

function allKeys() {
  const keys = []
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)
    if (k?.startsWith(PREFIX)) keys.push(k)
  }
  return keys
}

export class LocalStorageProvider {
  folderName() { return 'Browser Storage' }

  async pick() { return true } // no-op
  async restore() { return true } // always ready

  async scaffold() {
    if (localStorage.getItem(PREFIX + 'focus-plan.md') === null) {
      localStorage.setItem(PREFIX + 'focus-plan.md', SCAFFOLD_FOCUS_PLAN)
    }
    if (localStorage.getItem(PREFIX + 'focus-plan-completed.md') === null) {
      localStorage.setItem(PREFIX + 'focus-plan-completed.md', SCAFFOLD_COMPLETED)
    }
  }

  async read(path) {
    return localStorage.getItem(PREFIX + path) ?? ''
  }

  async write(path, content) {
    localStorage.setItem(PREFIX + path, content)
  }

  async remove(path) {
    localStorage.removeItem(PREFIX + path)
  }

  async getFiles() {
    // Build a tree from flat keys so the FileTree UI works
    const paths = allKeys().map(k => k.slice(PREFIX.length)).sort()
    return buildTree(paths)
  }

  async checkJournal(taskId) {
    const path = `journal/task-${taskId}.md`
    return {
      exists: localStorage.getItem(PREFIX + path) !== null,
      path,
    }
  }

  async maxJournalId() {
    let max = 0
    for (const k of allKeys()) {
      const m = k.slice(PREFIX.length).match(/^journal\/task-(\d+)\.md$/)
      if (m) max = Math.max(max, parseInt(m[1], 10))
    }
    return max
  }

  /** Flat list of all stored paths (for migration). */
  listAllPaths() {
    return allKeys().map(k => k.slice(PREFIX.length))
  }

  /** Wipe all stored files. */
  clear() {
    allKeys().forEach(k => localStorage.removeItem(k))
  }
}

function buildTree(paths) {
  const root = []
  const dirs = new Map() // path -> children array
  dirs.set('', root)

  for (const path of paths) {
    const parts = path.split('/')
    let parentPath = ''
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i]
      const childPath = parentPath ? `${parentPath}/${p}` : p
      if (!dirs.has(childPath)) {
        const children = []
        dirs.get(parentPath).push({ name: p, type: 'directory', path: childPath, children })
        dirs.set(childPath, children)
      }
      parentPath = childPath
    }
    const fileName = parts[parts.length - 1]
    if (fileName.endsWith('.md')) {
      dirs.get(parentPath).push({ name: fileName, type: 'file', path })
    }
  }
  return root
}

export { parseTodos }
