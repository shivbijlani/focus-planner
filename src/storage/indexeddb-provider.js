/**
 * IndexedDB-backed "Browser Storage" provider.
 *
 * Same user-facing storage as the classic localStorage provider (label
 * "Browser Storage": private, fast, offline), but backed by IndexedDB via
 * idb-keyval. localStorage caps at ~5 MB per origin — far too small for a real
 * planner (journals + attachments), which caused writes to fail with
 * QuotaExceededError and journals to silently drop (see #371). IndexedDB offers
 * orders of magnitude more room (typically hundreds of MB to GB) and stores
 * strings compactly, so the same "Browser Storage" mode simply stops hitting a
 * ceiling.
 *
 * Files are stored one entry per path: key = "<path>", value = content string.
 *
 * MIGRATION: on first use this copies any legacy `fp-file:<path>` entries from
 * localStorage into IndexedDB. It NEVER deletes the localStorage copies on
 * import, so the change is reversible — revert to the localStorage provider and
 * the old data is still there. (An explicit clear()/forget() wipes both.)
 */
import { get, set, del, keys, clear, createStore } from 'idb-keyval'
import { LocalStorageProvider, parseTodos, buildTree } from './localstorage-provider.js'
import { PLAN_FILE, COMPLETED_FILE } from '../config/branding.js'
import { scaffoldAgentsDoc } from '../config/agentsDoc.js'

const LEGACY_PREFIX = 'fp-file:'

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

function legacyLocalStorageKeys() {
  const out = []
  if (typeof localStorage === 'undefined' || !localStorage) return out
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)
    if (k?.startsWith(LEGACY_PREFIX)) out.push(k)
  }
  return out
}

/** True when IndexedDB is usable in this context (window or worker). */
export function indexedDbAvailable() {
  return typeof indexedDB !== 'undefined' && indexedDB !== null
}

export class IndexedDbProvider {
  constructor() {
    // Dedicated DB so we never collide with the folder-sync engine's own DB.
    this._store = createStore('fp-browser-storage', 'files')
    // Kick off the one-time migration immediately; every data method awaits it,
    // so reads/writes are correct regardless of init ordering.
    this._ready = this._migrateFromLocalStorage()
  }

  async _ensureReady() {
    try { await this._ready } catch { /* migration failures must not brick I/O */ }
  }

  folderName() { return 'Browser Storage' }

  async pick() { return true } // no-op

  async restore() {
    await this._ensureReady()
    return true
  }

  async scaffold() {
    await this._ensureReady()
    if ((await get(PLAN_FILE, this._store)) === undefined) {
      await set(PLAN_FILE, SCAFFOLD_PLAN, this._store)
    }
    if ((await get(COMPLETED_FILE, this._store)) === undefined) {
      await set(COMPLETED_FILE, SCAFFOLD_COMPLETED, this._store)
    }
    await scaffoldAgentsDoc((p) => this.read(p), (p, c) => this.write(p, c))
  }

  async read(path) {
    await this._ensureReady()
    return (await get(path, this._store)) ?? ''
  }

  async write(path, content) {
    await this._ensureReady()
    await set(path, content, this._store)
  }

  async remove(path) {
    await this._ensureReady()
    await del(path, this._store)
  }

  async getFiles() {
    await this._ensureReady()
    const paths = (await keys(this._store)).map(String).sort()
    return buildTree(paths)
  }

  async checkJournal(taskId) {
    await this._ensureReady()
    const path = `journal/task-${taskId}.md`
    return {
      exists: (await get(path, this._store)) !== undefined,
      path,
    }
  }

  async maxJournalId() {
    await this._ensureReady()
    let max = 0
    for (const k of await keys(this._store)) {
      const m = String(k).match(/^journal\/task-(\d+)\.md$/)
      if (m) max = Math.max(max, parseInt(m[1], 10))
    }
    return max
  }

  async journalIds() {
    await this._ensureReady()
    const ids = new Set()
    for (const k of await keys(this._store)) {
      const m = String(k).match(/^journal\/task-(\d+)\.md$/)
      if (m) ids.add(parseInt(m[1], 10))
    }
    return ids
  }

  /** Flat list of all stored paths (for migration). Async (IDB-backed). */
  async listAllPaths() {
    await this._ensureReady()
    return (await keys(this._store)).map(String)
  }

  /**
   * Wipe all stored files. Also drops the legacy localStorage backup so a fresh
   * source can't silently re-import it on the next open.
   */
  async clear() {
    await clear(this._store)
    try {
      for (const k of legacyLocalStorageKeys()) localStorage.removeItem(k)
    } catch { /* ignore */ }
  }

  /** Called when this source is removed from the registry. */
  async forget() {
    await this.clear()
  }

  /**
   * One-time copy of legacy `fp-file:*` localStorage entries into IndexedDB.
   * Runs only when the IDB store is empty, so it never clobbers newer IDB data.
   * The localStorage entries are left intact as a backup — non-destructive.
   */
  async _migrateFromLocalStorage() {
    try {
      const existing = await keys(this._store)
      if (existing.length > 0) return // already have IDB data — nothing to import
      for (const k of legacyLocalStorageKeys()) {
        await set(k.slice(LEGACY_PREFIX.length), localStorage.getItem(k) ?? '', this._store)
      }
    } catch {
      // A failed migration must not brick startup; the provider still works,
      // it just starts empty (and localStorage data remains for a retry).
    }
  }
}

/**
 * Factory for the default "Browser Storage" provider: IndexedDB-backed when
 * available (the common case), falling back to the classic localStorage
 * provider only where IndexedDB is unavailable (e.g. some locked-down modes).
 */
export function makeBrowserStorageProvider() {
  return indexedDbAvailable() ? new IndexedDbProvider() : new LocalStorageProvider()
}

export { parseTodos }
