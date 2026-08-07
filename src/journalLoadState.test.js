import { describe, expect, it } from 'vitest'

import {
  JOURNAL_EXISTENCE,
  canCreateJournal,
  journalStateFromError,
  journalStateFromResult,
} from './journalLoadState.js'

describe('journal load state', () => {
  it('never offers create when an existing journal content read fails', () => {
    const error = Object.assign(new Error('read failed'), {
      journal: { exists: true, path: 'journal/task-400.md' },
    })

    const state = journalStateFromError(error)

    expect(state).toEqual({
      existence: JOURNAL_EXISTENCE.EXISTS,
      path: 'journal/task-400.md',
      contentStatus: 'error',
    })
    expect(canCreateJournal(state.existence)).toBe(false)
  })

  it('only offers create after a successful absence check', () => {
    const unknown = journalStateFromError(new Error('check failed'))
    const absent = journalStateFromResult({ exists: false })

    expect(canCreateJournal(unknown.existence)).toBe(false)
    expect(canCreateJournal(absent.existence)).toBe(true)
  })

  it('retains previously known existence across a retry failure', () => {
    const previous = {
      existence: JOURNAL_EXISTENCE.EXISTS,
      path: 'journal/task-400.md',
      contentStatus: 'loading',
    }

    expect(journalStateFromError(new Error('retry failed'), previous)).toEqual({
      existence: JOURNAL_EXISTENCE.EXISTS,
      path: 'journal/task-400.md',
      contentStatus: 'error',
    })
  })
})
