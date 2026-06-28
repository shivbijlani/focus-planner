import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  addTombstone,
  pruneTombstones,
  activeTombstoneIds,
  getActiveTombstoneIds,
  recordDeletedId,
  TOMBSTONE_KEY,
  TOMBSTONE_TTL_MS,
} from './idTombstones.js'
import { allocateNextId } from './focusPlanOps.js'

describe('id tombstones', () => {
  let originalLocalStorage
  let store

  beforeEach(() => {
    originalLocalStorage = globalThis.localStorage
    store = new Map()
    globalThis.localStorage = {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => { store.set(key, String(value)) },
      removeItem: (key) => { store.delete(key) },
    }
  })

  afterEach(() => {
    if (originalLocalStorage === undefined) {
      delete globalThis.localStorage
    } else {
      globalThis.localStorage = originalLocalStorage
    }
  })

  it('records a deleted id with its delete timestamp', () => {
    const s = addTombstone({}, 305, 1000)
    expect(s[305]).toBe(1000)
  })

  it('ignores invalid ids so a bad row cannot poison the store', () => {
    expect(addTombstone({}, 'abc', 1000)).toEqual({})
    expect(addTombstone({}, 0, 1000)).toEqual({})
    expect(addTombstone({}, -5, 1000)).toEqual({})
  })

  it('treats a recent tombstone as active and an expired one as gone', () => {
    const now = 10_000_000_000
    const store = { 305: now - 1000, 306: now - (TOMBSTONE_TTL_MS + 1) }
    const ids = activeTombstoneIds(store, now)
    expect(ids.has(305)).toBe(true)
    expect(ids.has(306)).toBe(false)
  })

  it('prunes expired entries', () => {
    const now = 10_000_000_000
    const store = { 305: now - 1000, 306: now - (TOMBSTONE_TTL_MS + 1) }
    expect(Object.keys(pruneTombstones(store, now))).toEqual(['305'])
  })

  // The actual #314 / #305 regression: a freed ID must NOT be reused while its
  // tombstone is active, even though the journal for it no longer exists.
  it('blocks reuse of a freshly-deleted id during allocation', () => {
    const now = Date.now()
    // 305 was just deleted: its journal is gone, so the journal skip-set is empty…
    const journalIds = new Set()
    // …but the tombstone keeps 305 reserved.
    const skip = new Set([
      ...journalIds,
      ...activeTombstoneIds(addTombstone({}, 305, now), now),
    ])
    // Planner max is 304, so naive allocation would hand back the freed 305.
    expect(allocateNextId(304, skip)).toBe(306)
  })

  it('lets a long-expired id be reused again', () => {
    const now = Date.now()
    const store = { 305: now - (TOMBSTONE_TTL_MS + 1) }
    const skip = new Set([...activeTombstoneIds(store, now)])
    expect(allocateNextId(304, skip)).toBe(305)
  })

  it('persists and reads active tombstones from localStorage', () => {
    recordDeletedId(305, 1000)
    expect(JSON.parse(store.get(TOMBSTONE_KEY))).toEqual({ 305: 1000 })
    expect(getActiveTombstoneIds(1001).has(305)).toBe(true)
  })

  it('prunes expired tombstones from localStorage when read', () => {
    const now = 10_000_000_000
    store.set(TOMBSTONE_KEY, JSON.stringify({
      305: now - (TOMBSTONE_TTL_MS + 1),
      306: now - 1000,
    }))
    expect([...getActiveTombstoneIds(now)]).toEqual([306])
    expect(JSON.parse(store.get(TOMBSTONE_KEY))).toEqual({ 306: now - 1000 })
  })
})
