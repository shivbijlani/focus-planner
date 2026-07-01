import { describe, it, expect } from 'vitest'
import { computeJournalSignature } from './signature.js'

describe('computeJournalSignature', () => {
  it('returns a stable placeholder for empty/invalid content', () => {
    expect(computeJournalSignature('')).toBe('-|0|0')
    expect(computeJournalSignature(null)).toBe('-|0|0')
    expect(computeJournalSignature(undefined)).toBe('-|0|0')
  })

  it('counts dated day entries and captures the newest date', () => {
    const md = [
      '# Task 42: Something',
      '',
      '## 2026-06-01',
      'first entry',
      '',
      '## 2026-06-15',
      'second entry',
    ].join('\n')
    const sig = computeJournalSignature(md)
    expect(sig.startsWith('2026-06-15|2|')).toBe(true)
  })

  it('changes when new content is appended (same day edit)', () => {
    const base = '## 2026-06-01\nhello'
    const edited = '## 2026-06-01\nhello world more'
    expect(computeJournalSignature(base)).not.toBe(computeJournalSignature(edited))
  })

  it('changes when a new day entry is added', () => {
    const one = '## 2026-06-01\na'
    const two = '## 2026-06-01\na\n## 2026-06-02\nb'
    expect(computeJournalSignature(one)).not.toBe(computeJournalSignature(two))
  })

  it('picks the maximum date even if entries are out of order', () => {
    const md = '## 2026-06-20\nx\n## 2026-06-05\ny'
    expect(computeJournalSignature(md).startsWith('2026-06-20|2|')).toBe(true)
  })

  it('ignores ## headings that are not dates', () => {
    const md = '## Overview\ntext\n## 2026-06-01\nentry'
    expect(computeJournalSignature(md).startsWith('2026-06-01|1|')).toBe(true)
  })
})
