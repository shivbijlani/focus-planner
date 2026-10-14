import { describe, expect, it, vi } from 'vitest'
import { createTaskBriefingStore, taskBriefingStoreFor } from './taskBriefing.js'

const treeWith = (...paths) => paths.map((path) => ({
  type: 'file',
  name: path.split('/').at(-1),
  path,
}))

describe('task briefing file discovery', () => {
  it('shares one file listing across task rows and detects only exact briefing filenames', async () => {
    const getFiles = vi.fn(async () => treeWith(
      'journal/task-431.md',
      'journal/task-431-briefing.md',
      'journal/task-431-webmcp-evaluation.md',
      'journal/task-431-briefing-notes.md',
    ))
    const store = createTaskBriefingStore({ getFiles })
    await Promise.all([store.load(), store.load()])

    expect(getFiles).toHaveBeenCalledTimes(1)
    expect(store.has(431)).toBe(true)
    expect(store.has('431')).toBe(true)
    expect(store.has(432)).toBe(false)
    expect(store.getSnapshot().status).toBe('ready')
  })

  it('keeps file existence separate for different active providers', async () => {
    const workProvider = { getFiles: async () => treeWith('journal/task-431-briefing.md') }
    const personalProvider = { getFiles: async () => treeWith('journal/task-431.md', 'journal/task-431-webmcp-evaluation.md') }
    const work = taskBriefingStoreFor(workProvider)
    const personal = taskBriefingStoreFor(personalProvider)

    await Promise.all([work.load(), personal.load()])
    expect(work.has(431)).toBe(true)
    expect(personal.has(431)).toBe(false)
    expect(taskBriefingStoreFor(workProvider)).toBe(work)

    await work.load({ force: true })
    expect(work.has(431)).toBe(true)
  })

  it('preserves an explicit error state and allows retry', async () => {
    const getFiles = vi.fn()
      .mockRejectedValueOnce(new Error('Provider unavailable'))
      .mockResolvedValueOnce(treeWith('journal/task-431-briefing.md'))
    const store = createTaskBriefingStore({ getFiles })

    await expect(store.load()).rejects.toThrow('Provider unavailable')
    expect(store.getSnapshot().status).toBe('error')
    expect(store.has(431)).toBe(false)
    await store.load({ force: true })
    expect(store.getSnapshot().status).toBe('ready')
    expect(store.has(431)).toBe(true)
    expect(getFiles).toHaveBeenCalledTimes(2)
  })
})
