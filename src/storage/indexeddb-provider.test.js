import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clear as idbClear, createStore } from 'idb-keyval'
import { IndexedDbProvider, makeBrowserStorageProvider, indexedDbAvailable } from './indexeddb-provider.js'

// Same DB/store the provider uses, so we can reset between tests.
const store = createStore('fp-browser-storage', 'files')

let originalLocalStorage
let lsStore

beforeEach(async () => {
  await idbClear(store)
  originalLocalStorage = globalThis.localStorage
  lsStore = new Map()
  globalThis.localStorage = {
    get length() { return lsStore.size },
    key: (i) => [...lsStore.keys()][i] ?? null,
    getItem: (k) => (lsStore.has(k) ? lsStore.get(k) : null),
    setItem: (k, v) => { lsStore.set(k, String(v)) },
    removeItem: (k) => { lsStore.delete(k) },
  }
})

afterEach(async () => {
  await idbClear(store)
  if (originalLocalStorage === undefined) delete globalThis.localStorage
  else globalThis.localStorage = originalLocalStorage
})

describe('IndexedDbProvider CRUD', () => {
  it('writes, reads, lists, and removes files', async () => {
    const p = new IndexedDbProvider()
    await p.write('planner.md', '# board')
    await p.write('journal/task-370.md', '# 370')
    expect(await p.read('planner.md')).toBe('# board')
    expect(await p.read('missing.md')).toBe('')
    expect((await p.listAllPaths()).sort()).toEqual(['journal/task-370.md', 'planner.md'])
    const tree = await p.getFiles()
    expect(tree.some(n => n.name === 'planner.md' && n.type === 'file')).toBe(true)
    expect(tree.some(n => n.name === 'journal' && n.type === 'directory')).toBe(true)
    await p.remove('planner.md')
    expect(await p.read('planner.md')).toBe('')
  })

  it('computes journal ids and max, ignoring non-journal keys', async () => {
    const p = new IndexedDbProvider()
    await p.write('journal/task-120.md', 'a')
    await p.write('journal/task-372.md', 'b')
    await p.write('journal/task-9.md', 'c')
    await p.write('planner.md', 'board')
    expect(await p.maxJournalId()).toBe(372)
    expect([...(await p.journalIds())].sort((a, b) => a - b)).toEqual([9, 120, 372])
    expect(await p.checkJournal(372)).toEqual({ exists: true, path: 'journal/task-372.md' })
    expect((await p.checkJournal(999)).exists).toBe(false)
  })

  it('stores far more than the ~5MB localStorage cap would allow', async () => {
    const p = new IndexedDbProvider()
    const big = 'x'.repeat(1_000_000) // 1 MB
    for (let i = 0; i < 8; i++) await p.write(`journal/task-${i}.md`, big) // ~8 MB total
    expect((await p.listAllPaths()).length).toBe(8)
    expect(await p.read('journal/task-7.md')).toHaveLength(1_000_000)
  })
})

describe('migration from localStorage', () => {
  it('copies legacy fp-file entries on first use, non-destructively', async () => {
    localStorage.setItem('fp-file:planner.md', '# legacy board')
    localStorage.setItem('fp-file:journal/task-371.md', '# 371')
    localStorage.setItem('unrelated-key', 'x')
    const p = new IndexedDbProvider()
    expect(await p.read('planner.md')).toBe('# legacy board')
    expect(await p.read('journal/task-371.md')).toBe('# 371')
    // localStorage is kept as a backup (non-destructive import)
    expect(localStorage.getItem('fp-file:planner.md')).toBe('# legacy board')
    // unrelated keys are not imported
    expect(await p.read('unrelated-key')).toBe('')
  })

  it('does not import when the IDB store already has data', async () => {
    const p1 = new IndexedDbProvider()
    await p1.write('planner.md', '# idb board')
    localStorage.setItem('fp-file:planner.md', '# legacy board')
    const p2 = new IndexedDbProvider()
    expect(await p2.read('planner.md')).toBe('# idb board') // idb wins; no clobber
  })
})

describe('clear()', () => {
  it('wipes both IndexedDB and the legacy localStorage backup', async () => {
    const p = new IndexedDbProvider()
    await p.write('a.md', '1')
    localStorage.setItem('fp-file:a.md', '1')
    await p.clear()
    expect(await p.listAllPaths()).toEqual([])
    expect(localStorage.getItem('fp-file:a.md')).toBe(null)
  })
})

describe('makeBrowserStorageProvider', () => {
  it('returns an IndexedDbProvider when IndexedDB is available', () => {
    expect(indexedDbAvailable()).toBe(true)
    expect(makeBrowserStorageProvider()).toBeInstanceOf(IndexedDbProvider)
  })
})
