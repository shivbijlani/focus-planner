import { describe, it, expect, beforeEach } from 'vitest'
import {
  track,
  isUnread,
  markSeen,
  emitJournalOpened,
  completeInitialSeeding,
  subscribe,
  setReadStateProvider,
  __resetForTests,
} from './readStateService.js'

// Minimal in-memory provider implementing the read-state provider interface.
function fakeProvider() {
  const seen = new Map()
  let initialized = false
  return {
    getSeen: (id) => (seen.has(id) ? seen.get(id) : undefined),
    hasSeen: (id) => seen.has(id),
    setSeen: (id, sig) => { seen.set(id, sig) },
    isInitialized: () => initialized,
    setInitialized: (v) => { initialized = !!v },
    _seen: seen,
  }
}

let provider
beforeEach(() => {
  provider = fakeProvider()
  __resetForTests(provider)
  setReadStateProvider(provider)
})

describe('readStateService seeding', () => {
  it('seeds journals tracked before initial seeding completes as already-seen', () => {
    track('42', '## 2026-06-01\nhello')
    expect(isUnread('42')).toBe(false)
    expect(provider.hasSeen('42')).toBe(true)
  })

  it('treats a journal that first appears AFTER seeding as unread', () => {
    completeInitialSeeding()
    track('99', '## 2026-06-02\nbrand new')
    expect(isUnread('99')).toBe(true)
  })

  it('returns not-unread for a journal that has never been tracked', () => {
    completeInitialSeeding()
    expect(isUnread('nope')).toBe(false)
  })
})

describe('read/unread lifecycle', () => {
  it('re-flags a seeded journal as unread when its content changes', () => {
    track('42', '## 2026-06-01\nhello')
    expect(isUnread('42')).toBe(false)
    completeInitialSeeding()
    // New content arrives (agent appended an entry).
    track('42', '## 2026-06-01\nhello\n## 2026-06-02\nnew note')
    expect(isUnread('42')).toBe(true)
  })

  it('markSeen clears the unread flag', () => {
    completeInitialSeeding()
    track('7', '## 2026-06-02\nnew')
    expect(isUnread('7')).toBe(true)
    markSeen('7')
    expect(isUnread('7')).toBe(false)
  })

  it('opening (via the fired event) marks the journal seen', () => {
    completeInitialSeeding()
    track('7', '## 2026-06-02\nnew')
    expect(isUnread('7')).toBe(true)
    emitJournalOpened('7')
    expect(isUnread('7')).toBe(false)
  })

  it('accepts numeric journal ids and normalizes them to strings', () => {
    completeInitialSeeding()
    track(7, '## 2026-06-02\nnew')
    expect(isUnread(7)).toBe(true)
    emitJournalOpened(7)
    expect(isUnread('7')).toBe(false)
  })
})

describe('subscribe', () => {
  it('notifies subscribers when read-state changes', () => {
    let calls = 0
    const unsub = subscribe(() => { calls += 1 })
    completeInitialSeeding()
    track('1', '## 2026-06-02\na')
    expect(calls).toBeGreaterThan(0)
    const before = calls
    markSeen('1')
    expect(calls).toBeGreaterThan(before)
    unsub()
    const afterUnsub = calls
    markSeen('1')
    expect(calls).toBe(afterUnsub)
  })
})

describe('provider swappability', () => {
  it('uses a newly set provider for persistence', () => {
    const p2 = fakeProvider()
    p2.setInitialized(true)
    setReadStateProvider(p2)
    track('55', '## 2026-06-02\nx')
    expect(isUnread('55')).toBe(true)
    markSeen('55')
    expect(p2.hasSeen('55')).toBe(true)
    expect(provider.hasSeen('55')).toBe(false)
  })
})
