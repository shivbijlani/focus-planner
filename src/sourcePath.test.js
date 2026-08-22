import { describe, expect, it } from 'vitest'

import { joinSourcePath, journalReadStateId } from './sourcePath.js'

describe('source-qualified journal identity', () => {
  it('navigates a combined row to its own source journal', () => {
    expect(joinSourcePath('source-b', 'journal/task-1.md'))
      .toBe('source-b::journal/task-1.md')
  })

  it('keeps duplicate task ids independent across sources', () => {
    expect(journalReadStateId('source-a', 1)).toBe('source-a::1')
    expect(journalReadStateId('source-b', 1)).toBe('source-b::1')
    expect(journalReadStateId('source-a', 1))
      .not.toBe(journalReadStateId('source-b', 1))
  })
})
