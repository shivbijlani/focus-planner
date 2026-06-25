/**
 * Deleted-task ID "tombstones".
 *
 * Background (bug #314 / #305): deleting a task frees its ID, and ID allocation
 * only skips IDs whose journal file still exists (see `allocateNextId`). So a
 * freed ID can be reused immediately — and if the *old* journal for that ID
 * then comes back from another synced replica (OneDrive can resurrect a file
 * the delete hadn't propagated to yet), the reused ID now points at the wrong
 * journal: the "journal belongs to a different task" mismatch.
 *
 * Fix: when a task is deleted, remember its ID for a window (a "tombstone").
 * While the tombstone is active it joins the allocation collision-skip set, so
 * the freed ID is not reused until the sync-resurrection window has passed.
 *
 * The core is a set of pure functions over a plain `{ [id]: deletedAtMs }`
 * store so it is trivially unit-testable; a thin localStorage-backed wrapper
 * (`recordDeletedId` / `getActiveTombstoneIds`) persists it in the browser and
 * is a safe no-op where `localStorage` is unavailable (tests, SSR).
 */

// How long a deleted ID stays reserved. Generous enough to outlast a slow
// OneDrive sync-resurrection, short enough that IDs are eventually recyclable.
export const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days
export const TOMBSTONE_KEY = 'fp-id-tombstones'

/**
 * Return a new store with `id` recorded as deleted at `now`. Invalid ids
 * (non-numeric, <= 0) are ignored so a bad row can't poison the store.
 * @param {Record<string, number>} store
 * @param {number|string} id
 * @param {number} now epoch ms
 * @returns {Record<string, number>}
 */
export function addTombstone(store, id, now = Date.now()) {
  const n = Number(id)
  const base = store && typeof store === 'object' ? store : {}
  if (!Number.isFinite(n) || n <= 0) return { ...base }
  return { ...base, [n]: now }
}

/**
 * Drop entries older than `ttlMs` (or with a non-numeric timestamp).
 * @returns {Record<string, number>}
 */
export function pruneTombstones(store, now = Date.now(), ttlMs = TOMBSTONE_TTL_MS) {
  const out = {}
  for (const [k, v] of Object.entries(store && typeof store === 'object' ? store : {})) {
    if (typeof v === 'number' && Number.isFinite(v) && now - v < ttlMs) out[k] = v
  }
  return out
}

/**
 * The set of still-active (non-expired) tombstoned IDs as numbers.
 * @returns {Set<number>}
 */
export function activeTombstoneIds(store, now = Date.now(), ttlMs = TOMBSTONE_TTL_MS) {
  const ids = new Set()
  for (const [k, v] of Object.entries(store && typeof store === 'object' ? store : {})) {
    if (typeof v === 'number' && Number.isFinite(v) && now - v < ttlMs) {
      const n = Number(k)
      if (Number.isFinite(n)) ids.add(n)
    }
  }
  return ids
}

// ── Persistence (browser localStorage; empty / no-op when unavailable) ──

function readStore() {
  try {
    if (typeof localStorage === 'undefined') return {}
    const raw = localStorage.getItem(TOMBSTONE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeStore(store) {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(TOMBSTONE_KEY, JSON.stringify(store))
  } catch {
    /* ignore quota / serialization errors — tombstones are best-effort */
  }
}

/**
 * Record a deleted task ID as a tombstone, pruning expired entries first.
 * Safe to call where localStorage is unavailable.
 * @param {number|string} id
 * @param {number} now epoch ms
 */
export function recordDeletedId(id, now = Date.now()) {
  const next = addTombstone(pruneTombstones(readStore(), now), id, now)
  writeStore(next)
  return next
}

/**
 * Active tombstoned IDs (Set<number>) for the allocation collision-skip set.
 * Also opportunistically prunes expired entries from storage.
 * @param {number} now epoch ms
 * @returns {Set<number>}
 */
export function getActiveTombstoneIds(now = Date.now()) {
  const pruned = pruneTombstones(readStore(), now)
  writeStore(pruned)
  return activeTombstoneIds(pruned, now)
}
