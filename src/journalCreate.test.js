import { describe, expect, it, vi } from 'vitest'

import { createJournalInSource } from './journalCreate.js'

describe('combined journal creation', () => {
  it('writes duplicate task ids directly to each clicked row source', async () => {
    const storageApi = { writeToSource: vi.fn(async () => {}) }

    await createJournalInSource(storageApi, 'source-a', '7', 'Source A task')
    await createJournalInSource(storageApi, 'source-b', '7', 'Source B task')

    expect(storageApi.writeToSource.mock.calls).toEqual([
      ['source-a', 'journal/task-7.md', '# Task 7: Source A task\n\n- TODO: \n'],
      ['source-b', 'journal/task-7.md', '# Task 7: Source B task\n\n- TODO: \n'],
    ])
  })
})
