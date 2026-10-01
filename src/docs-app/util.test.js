import { describe, it, expect } from 'vitest'
import { timeAgo, plannerJournalHref, excerpt, filterLibrary } from './util.js'
import { journalDeepLink } from '../docsIndex.js'

describe('docs-app util', () => {
  const now = Date.parse('2026-09-30T12:00:00Z')

  it('formats relative ages', () => {
    expect(timeAgo('2026-09-30T11:59:30Z', now)).toBe('just now')
    expect(timeAgo('2026-09-30T10:00:00Z', now)).toBe('2h ago')
    expect(timeAgo('2026-09-27T12:00:00Z', now)).toBe('3d ago')
    expect(timeAgo('nope', now)).toBe('')
  })

  it('builds the planner journal deep link that App.jsx parses back', () => {
    const href = plannerJournalHref(507, '/')
    expect(href).toBe('/#journal=507')
    expect(journalDeepLink(href.slice(1))).toBe(507)
    expect(journalDeepLink('#/d/d-aaaaaa')).toBeNull()
  })

  it('truncates excerpts', () => {
    expect(excerpt('a   b', 10)).toBe('a b')
    expect(excerpt('abcdefghij', 5)).toBe('abcd…')
  })

  it('filters the library tabs and searches title or task number', () => {
    const cards = [
      { id: 'a', title: 'Mortgage', task: 123, updatedAt: '2026-09-30T00:00:00Z', unread: true, needsYou: 0, drafts: 0 },
      { id: 'b', title: 'Trip', task: 9, updatedAt: '2026-08-01T00:00:00Z', unread: false, needsYou: 0, drafts: 1 },
      { id: 'c', title: 'Old', task: null, updatedAt: '2026-01-01T00:00:00Z', unread: false, needsYou: 0, drafts: 0 },
    ]
    expect(filterLibrary(cards, 'needs', '', now).map((c) => c.id)).toEqual(['a', 'b'])
    expect(filterLibrary(cards, 'recent', '', now).map((c) => c.id)).toEqual(['a'])
    expect(filterLibrary(cards, 'all', '', now).map((c) => c.id)).toEqual(['a', 'b', 'c'])
    expect(filterLibrary(cards, 'all', '#12', now).map((c) => c.id)).toEqual(['a'])
    expect(filterLibrary(cards, 'all', 'trip', now).map((c) => c.id)).toEqual(['b'])
  })
})
