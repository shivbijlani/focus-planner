import { describe, it, expect, vi } from 'vitest'
import { resolveJournalPathForDelete, deleteJournalForTask } from './journalDelete.js'

describe('resolveJournalPathForDelete', () => {
  it('uses the resolved row path when the row had already loaded', async () => {
    const checkJournal = vi.fn()
    const path = await resolveJournalPathForDelete('journal/task-313.md', '313', checkJournal)
    expect(path).toBe('journal/task-313.md')
    // No need to ask storage when the row already knows.
    expect(checkJournal).not.toHaveBeenCalled()
  })

  it('falls back to storage when the row journal state is still loading (#185)', async () => {
    const checkJournal = vi.fn(async () => ({ exists: true, path: 'journal/task-313.md' }))
    const path = await resolveJournalPathForDelete(null, '313', checkJournal)
    expect(path).toBe('journal/task-313.md')
    expect(checkJournal).toHaveBeenCalledWith('313')
  })

  it('returns null when the task genuinely has no journal', async () => {
    const checkJournal = vi.fn(async () => ({ exists: false, path: 'journal/task-99.md' }))
    expect(await resolveJournalPathForDelete(null, '99', checkJournal)).toBe(null)
  })

  it('returns null when there is no task id to derive from', async () => {
    const checkJournal = vi.fn()
    expect(await resolveJournalPathForDelete(null, null, checkJournal)).toBe(null)
    expect(await resolveJournalPathForDelete(null, '', checkJournal)).toBe(null)
    expect(await resolveJournalPathForDelete(null, '   ', checkJournal)).toBe(null)
    expect(checkJournal).not.toHaveBeenCalled()
  })

  it('accepts a numeric task id', async () => {
    const checkJournal = vi.fn(async (id) => ({ exists: true, path: `journal/task-${id}.md` }))
    expect(await resolveJournalPathForDelete(null, 313, checkJournal)).toBe('journal/task-313.md')
  })
})

describe('deleteJournalForTask', () => {
  it('removes the journal when the row state had resolved', async () => {
    const remove = vi.fn(async () => {})
    const ok = await deleteJournalForTask({
      journalPath: 'journal/task-313.md',
      taskId: '313',
      checkJournal: async () => ({ exists: false, path: '' }),
      remove,
    })
    expect(ok).toBe(true)
    expect(remove).toHaveBeenCalledWith('journal/task-313.md')
  })

  it('removes the journal even when the row state is still loading (the #185 regression)', async () => {
    const remove = vi.fn(async () => {})
    const ok = await deleteJournalForTask({
      journalPath: null, // row still had contentStatus: 'loading'
      taskId: '313',
      checkJournal: async (id) => ({ exists: true, path: `journal/task-${id}.md` }),
      remove,
    })
    expect(ok).toBe(true)
    expect(remove).toHaveBeenCalledWith('journal/task-313.md')
  })

  it('is a silent no-op for a task that has no journal', async () => {
    const remove = vi.fn(async () => {})
    const onError = vi.fn()
    const ok = await deleteJournalForTask({
      journalPath: null,
      taskId: '99',
      checkJournal: async () => ({ exists: false, path: 'journal/task-99.md' }),
      remove,
      onError,
    })
    expect(ok).toBe(false)
    expect(remove).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
  })

  it('surfaces a storage failure instead of swallowing it', async () => {
    const boom = new Error('quota exceeded')
    const onError = vi.fn()
    const ok = await deleteJournalForTask({
      journalPath: 'journal/task-313.md',
      taskId: '313',
      checkJournal: async () => ({ exists: true, path: 'journal/task-313.md' }),
      remove: async () => { throw boom },
      onError,
    })
    expect(ok).toBe(false)
    expect(onError).toHaveBeenCalledWith(boom)
  })

  it('surfaces a failure to look the journal up, rather than reading it as "no journal"', async () => {
    const boom = new Error('provider offline')
    const onError = vi.fn()
    const remove = vi.fn(async () => {})
    const ok = await deleteJournalForTask({
      journalPath: null,
      taskId: '313',
      checkJournal: async () => { throw boom },
      remove,
      onError,
    })
    expect(ok).toBe(false)
    expect(remove).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith(boom)
  })

  it('does not throw when no onError handler is supplied', async () => {
    await expect(deleteJournalForTask({
      journalPath: 'journal/task-313.md',
      taskId: '313',
      checkJournal: async () => ({ exists: true, path: 'journal/task-313.md' }),
      remove: async () => { throw new Error('nope') },
    })).resolves.toBe(false)
  })
})
