import { get, set, del } from 'idb-keyval'

const LEGACY_DB_KEY = 'focus-planner-dir-handle'

function dbKey(suffix) {
  return suffix ? `${LEGACY_DB_KEY}:${suffix}` : LEGACY_DB_KEY
}

export function isSupported() {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window
}

export async function pickFolder(suffix) {
  const handle = await window.showDirectoryPicker({ mode: 'readwrite' })
  await set(dbKey(suffix), handle)
  return handle
}

export async function forgetFolder(suffix) {
  await del(dbKey(suffix))
}

export async function restoreFolder(suffix) {
  const handle = await get(dbKey(suffix))
  if (!handle) return null
  try {
    const permission = await handle.queryPermission({ mode: 'readwrite' })
    if (permission === 'granted') return handle
    const requested = await handle.requestPermission({ mode: 'readwrite' })
    return requested === 'granted' ? handle : null
  } catch {
    return null
  }
}

async function getFileHandle(dirHandle, path, create = false) {
  const parts = path.split('/')
  const filename = parts.pop()
  let dir = dirHandle
  for (const part of parts) {
    dir = await dir.getDirectoryHandle(part, { create })
  }
  return dir.getFileHandle(filename, { create })
}

export async function readFile(dirHandle, path) {
  const fh = await getFileHandle(dirHandle, path)
  const file = await fh.getFile()
  return file.text()
}

export async function writeFile(dirHandle, path, content) {
  const fh = await getFileHandle(dirHandle, path, true)
  const writable = await fh.createWritable()
  await writable.write(content)
  await writable.close()
}

export async function deleteFile(dirHandle, path) {
  const parts = path.split('/')
  const filename = parts.pop()
  let dir = dirHandle
  try {
    for (const part of parts) {
      dir = await dir.getDirectoryHandle(part)
    }
    await dir.removeEntry(filename)
  } catch {
    // File or directory doesn't exist — nothing to delete
  }
}

export async function fileExists(dirHandle, path) {
  try {
    await getFileHandle(dirHandle, path)
    return true
  } catch {
    return false
  }
}

export async function journalExists(dirHandle, taskId) {
  const path = `journal/task-${taskId}.md`
  const exists = await fileExists(dirHandle, path)
  if (!exists) return { exists: false }
  return { exists: true, path }
}

export function parseTodos(content) {
  const lines = content.split(/\r?\n/)
  const todos = []
  for (const line of lines) {
    const checkboxMatch = line.match(/^-\s*\[([ x])\]\s*(.+)/i)
    if (checkboxMatch) {
      todos.push({ done: checkboxMatch[1].toLowerCase() === 'x', text: checkboxMatch[2].trim() })
      continue
    }
    const todoMatch = line.match(/^-\s*TODO:\s*(.+)/i)
    if (todoMatch) {
      todos.push({ done: false, text: todoMatch[1].trim() })
      continue
    }
    const doneMatch = line.match(/^-\s*DONE:\s*(.+)/i)
    if (doneMatch) {
      todos.push({ done: true, text: doneMatch[1].trim() })
    }
  }
  return todos
}

async function listRecursive(dirHandle, prefix = '') {
  const items = []
  for await (const [name, handle] of dirHandle.entries()) {
    if (name.startsWith('.') || name === 'node_modules') continue
    const path = prefix ? `${prefix}/${name}` : name
    if (handle.kind === 'directory') {
      const children = await listRecursive(handle, path)
      items.push({ name, type: 'directory', path, children })
    } else if (name.endsWith('.md')) {
      items.push({ name, type: 'file', path })
    }
  }
  return items
}

export async function listFiles(dirHandle) {
  return listRecursive(dirHandle)
}

export async function getMaxJournalId(dirHandle) {
  try {
    const journalDir = await dirHandle.getDirectoryHandle('journal')
    let maxId = 0
    for await (const [name] of journalDir.entries()) {
      const m = name.match(/^task-(\d+)\.md$/)
      if (m) maxId = Math.max(maxId, parseInt(m[1], 10))
    }
    return maxId
  } catch {
    return 0
  }
}

const SCAFFOLD_FOCUS_PLAN = `## Today

| ID | 🎯 | Task | Work Priority | Added | Linked ID |
|---|---|------|---------------|-------|-----------|

## Deferred

| ID | 🎯 | Task | Work Priority | Added | Linked ID |
|---|---|------|---------------|-------|-----------|

## Priorities

`

const SCAFFOLD_COMPLETED = `# Completed Tasks
`

export async function scaffoldIfEmpty(dirHandle) {
  const hasFocusPlan = await fileExists(dirHandle, 'focus-plan.md')
  if (!hasFocusPlan) {
    await writeFile(dirHandle, 'focus-plan.md', SCAFFOLD_FOCUS_PLAN)
  }
  const hasCompleted = await fileExists(dirHandle, 'focus-plan-completed.md')
  if (!hasCompleted) {
    await writeFile(dirHandle, 'focus-plan-completed.md', SCAFFOLD_COMPLETED)
  }
}
