// localStorage-backed read-state provider.
//
// This is ONE implementation of the read-state provider interface. The
// read-state service (readStateService.js) depends only on this shape, so a
// synced/backend provider can be swapped in later via setReadStateProvider()
// without touching the UI or the service's callers.
//
// Provider interface:
//   getSeen(journalId): string | undefined   // last-seen signature, or undefined
//   setSeen(journalId, signature): void       // record a signature as seen
//   hasSeen(journalId): boolean               // has this journal ever been seen?
//   isInitialized(): boolean                  // has first-load seeding completed?
//   setInitialized(value): void
//
// Persistence note: this is per-device/per-browser (localStorage). Cross-device
// sync is explicitly out of scope for v1 (see issue #79).

const SEEN_KEY = 'fp-journal-readstate'
const INIT_KEY = 'fp-journal-readstate-initialized'

function safeParse(raw) {
  if (!raw) return {}
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' ? v : {}
  } catch {
    return {}
  }
}

export class LocalStorageReadStateProvider {
  constructor(store) {
    // Allow injecting a Storage-like object for tests; default to localStorage.
    this._store = store || (typeof localStorage !== 'undefined' ? localStorage : null)
  }

  _readMap() {
    if (!this._store) return {}
    return safeParse(this._store.getItem(SEEN_KEY))
  }

  _writeMap(map) {
    if (!this._store) return
    try {
      this._store.setItem(SEEN_KEY, JSON.stringify(map))
    } catch {
      /* quota / unavailable — read-state is best-effort */
    }
  }

  getSeen(journalId) {
    const map = this._readMap()
    return Object.prototype.hasOwnProperty.call(map, journalId) ? map[journalId] : undefined
  }

  hasSeen(journalId) {
    const map = this._readMap()
    return Object.prototype.hasOwnProperty.call(map, journalId)
  }

  setSeen(journalId, signature) {
    const map = this._readMap()
    map[journalId] = signature
    this._writeMap(map)
  }

  isInitialized() {
    if (!this._store) return false
    return this._store.getItem(INIT_KEY) === '1'
  }

  setInitialized(value) {
    if (!this._store) return
    try {
      if (value) this._store.setItem(INIT_KEY, '1')
      else this._store.removeItem(INIT_KEY)
    } catch {
      /* ignore */
    }
  }
}
