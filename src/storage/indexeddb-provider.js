/**
 * Browser IndexedDB provider — default for new visitors.
 *
 * Stores every markdown file as one IndexedDB record keyed by its path, in a
 * dedicated object store (`focus-planner` DB, `files` store) so it never
 * collides with the idb-keyval default store the FSA provider uses for
 * directory handles.
 *
 * This replaces the older localStorage-backed provider: IndexedDB is
 * asynchronous and has a far larger quota, so it comfortably holds hundreds of
 * task journals that would strain localStorage's ~5MB synchronous cap. The
 * user-facing name stays "Browser Storage" and the provider id stays
 * `local-storage` (see src/storage/storage.js PROVIDERS) so existing source
 * registries and the storage picker keep working unchanged.
 */
import { get, set, del, keys, clear, createStore } from 'idb-keyval'

import { parseTodos } from './fsa.js'
import { PLAN_FILE, COMPLETED_FILE } from '../config/branding.js'
import { scaffoldAgentsDoc } from '../config/agentsDoc.js'

// Dedicated DB + store so file records don't mix with idb-keyval's default
// keyval store (used elsewhere for FSA directory handles).
const filesStore = createStore('focus-planner', 'files')

const SCAFFOLD_PLAN = `## Today

| ID | 🎯 | Task | Priority | Added | Linked ID |
|---|---|------|----------|-------|-----------|

## Deferred

| ID | 🎯 | Task | Priority | Added | Linked ID |
|---|---|------|----------|-------|-----------|

## Priorities

`

const SCAFFOLD_COMPLETED = `# Completed Tasks
`

async function allPaths() {
  const ks = await keys(filesStore)
  return ks.map(String)
}

export class IndexedDbProvider {
  folderName() { return 'Browser Storage' }

  async pick() { return true } // no-op
  async restore() { return true } // always ready

  async scaffold() {
    if ((await get(PLAN_FILE, filesStore)) === undefined) {
      await set(PLAN_FILE, SCAFFOLD_PLAN, filesStore)
    }
    if ((await get(COMPLETED_FILE, filesStore)) === undefined) {
      await set(COMPLETED_FILE, SCAFFOLD_COMPLETED, filesStore)
    }
    await scaffoldAgentsDoc((p) => this.read(p), (p, c) => this.write(p, c))
  }

  async read(path) {
    return (await get(path, filesStore)) ?? ''
  }

  async write(path, content) {
    await set(path, content, filesStore)
  }

  async remove(path) {
    await del(path, filesStore)
  }

  async getFiles() {
    // Build a tree from flat keys so the FileTree UI works
    const paths = (await allPaths()).sort()
    return buildTree(paths)
  }

  async checkJournal(taskId) {
    const path = `journal/task-${taskId}.md`
    return {
      exists: (await get(path, filesStore)) !== undefined,
      path,
    }
  }

  async maxJournalId() {
    let max = 0
    for (const path of await allPaths()) {
      const m = path.match(/^journal\/task-(\d+)\.md$/)
      if (m) max = Math.max(max, parseInt(m[1], 10))
    }
    return max
  }

  async journalIds() {
    const ids = new Set()
    for (const path of await allPaths()) {
      const m = path.match(/^journal\/task-(\d+)\.md$/)
      if (m) ids.add(parseInt(m[1], 10))
    }
    return ids
  }

  /** Flat list of all stored paths (for migration). */
  async listAllPaths() {
    return await allPaths()
  }

  /** Wipe all stored files. */
  async clear() {
    await clear(filesStore)
  }

  /** Called when this source is removed from the registry. */
  async forget() {
    await this.clear()
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
