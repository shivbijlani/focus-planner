import 'fake-indexeddb/auto'

import { afterEach, describe, expect, it } from 'vitest'

import { IndexedDbProvider } from './indexeddb-provider.js'

// Each test starts from a clean store so assertions don't leak across cases.
afterEach(async () => {
  await new IndexedDbProvider().clear()
})

describe('IndexedDbProvider', () => {
  it('identifies as Browser Storage and is always ready', async () => {
    const p = new IndexedDbProvider()
    expect(p.folderName()).toBe('Browser Storage')
    await expect(p.pick()).resolves.toBe(true)
    await expect(p.restore()).resolves.toBe(true)
  })

  it('reads back what it writes and returns empty string for missing paths', async () => {
    const p = new IndexedDbProvider()
    await p.write('planner.md', '# Hello')
    expect(await p.read('planner.md')).toBe('# Hello')
    expect(await p.read('does/not/exist.md')).toBe('')
  })

  it('removes files', async () => {
    const p = new IndexedDbProvider()
    await p.write('journal/task-1.md', 'body')
    await p.remove('journal/task-1.md')
    expect(await p.read('journal/task-1.md')).toBe('')
  })

  it('lists all stored paths', async () => {
    const p = new IndexedDbProvider()
    await p.write('planner.md', 'a')
    await p.write('journal/task-3.md', 'b')
    expect((await p.listAllPaths()).sort()).toEqual([
      'journal/task-3.md',
      'planner.md',
    ])
  })

  it('builds a nested file tree for the FileTree UI', async () => {
    const p = new IndexedDbProvider()
    await p.write('planner.md', 'a')
    await p.write('journal/task-2.md', 'b')
    const tree = await p.getFiles()
    const root = tree.find((n) => n.name === 'planner.md')
    const journal = tree.find((n) => n.name === 'journal')
    expect(root).toMatchObject({ type: 'file', path: 'planner.md' })
    expect(journal).toMatchObject({ type: 'directory', path: 'journal' })
    expect(journal.children).toContainEqual({
      name: 'task-2.md',
      type: 'file',
      path: 'journal/task-2.md',
    })
  })

  it('reports journal existence, ids, and the max id', async () => {
    const p = new IndexedDbProvider()
    await p.write('journal/task-5.md', 'x')
    await p.write('journal/task-42.md', 'y')
    await p.write('planner.md', 'not a journal')

    expect(await p.checkJournal(5)).toEqual({ exists: true, path: 'journal/task-5.md' })
    expect(await p.checkJournal(99)).toEqual({ exists: false, path: 'journal/task-99.md' })
    expect(await p.journalIds()).toEqual(new Set([5, 42]))
    expect(await p.maxJournalId()).toBe(42)
  })

  it('scaffolds plan and completed files without overwriting existing content', async () => {
    const p = new IndexedDbProvider()
    await p.scaffold()
    const planner = await p.read('planner.md')
    expect(planner).toContain('## Today')
    expect(planner).toContain('## Priorities')
    expect(await p.read('planner-completed.md')).toContain('# Completed Tasks')

    // A second scaffold must be idempotent — it must not clobber edits.
    await p.write('planner.md', '# edited')
    await p.scaffold()
    expect(await p.read('planner.md')).toBe('# edited')
  })

  it('clears all stored files', async () => {
    const p = new IndexedDbProvider()
    await p.write('planner.md', 'a')
    await p.write('journal/task-1.md', 'b')
    await p.clear()
    expect(await p.listAllPaths()).toEqual([])
  })
})
