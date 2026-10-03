import { get, set, del } from 'idb-keyval'
import { PLAN_FILE, COMPLETED_FILE } from '../config/branding.js'
import { scaffoldAgentsDoc } from '../config/agentsDoc.js'
import { scaffoldAgentGate } from '../config/agentGate.js'

const HANDLE_DB_KEY = 'focus-planner-dir-handle'

function dbKey(suffix) {
  return suffix ? `${HANDLE_DB_KEY}:${suffix}` : HANDLE_DB_KEY
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
  const normalized = content.replace(/^\uFEFF/, '')
  const lines = normalized.split(/\r?\n/)
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
  if (!dirHandle) return []
  return listRecursive(dirHandle)
}

/** File names directly inside `path` (any extension), or null when the folder does not exist. */
export async function listDirectory(dirHandle, path) {
  if (!dirHandle) return null
  let dir = dirHandle
  try {
    for (const part of path.split('/').filter(Boolean)) dir = await dir.getDirectoryHandle(part)
  } catch {
    return null
  }
  const names = []
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind === 'file') names.push(name)
  }
  return names
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

/**
 * The set of task IDs that have a journal file. Used as a collision-skip set
 * when allocating a new task ID so we never reuse an ID whose journal still
 * exists — without letting a stray high ID inflate the numbering.
 */
export async function getJournalIds(dirHandle) {
  const ids = new Set()
  try {
    const journalDir = await dirHandle.getDirectoryHandle('journal')
    for await (const [name] of journalDir.entries()) {
      const m = name.match(/^task-(\d+)\.md$/)
      if (m) ids.add(parseInt(m[1], 10))
    }
  } catch { /* no journal dir yet */ }
  return ids
}

const SCAFFOLD_PLAN = `## Today

| ID | 🎯 | Task | Work Priority | Added | Linked ID |
|---|---|------|---------------|-------|-----------|

## Deferred

| ID | 🎯 | Task | Work Priority | Added | Wake | Linked ID |
|---|---|------|---------------|-------|------|-----------|

## Priorities

`

const SCAFFOLD_COMPLETED = `# Completed Tasks
`

export async function scaffoldIfEmpty(dirHandle) {
  const hasPlan = await fileExists(dirHandle, PLAN_FILE)
  if (!hasPlan) {
    await writeFile(dirHandle, PLAN_FILE, SCAFFOLD_PLAN)
  }
  const hasCompleted = await fileExists(dirHandle, COMPLETED_FILE)
  if (!hasCompleted) {
    await writeFile(dirHandle, COMPLETED_FILE, SCAFFOLD_COMPLETED)
  }
  await scaffoldAgentsDoc(
    (p) => readFile(dirHandle, p),
    (p, c) => writeFile(dirHandle, p, c),
  )
  await scaffoldAgentGate(
    (p) => readFile(dirHandle, p),
    (p, c) => writeFile(dirHandle, p, c),
  )
}
