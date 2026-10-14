import { describe, expect, it } from 'vitest'

import { journalReadStateId } from './sourcePath.js'

describe('source-scoped journal identity', () => {
  it('keeps duplicate task ids independent across sources', () => {
    expect(journalReadStateId('source-a', 1)).toBe('source-a::1')
    expect(journalReadStateId('source-b', 1)).toBe('source-b::1')
    expect(journalReadStateId('source-a', 1))
      .not.toBe(journalReadStateId('source-b', 1))
  })
})
