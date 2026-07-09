// Read-state service — the controller that holds all read/unread business logic.
//
// Design (per issue #79 / task #311):
//   - The UI contains NO business logic. Components only (a) hand the service a
//     journal's raw content via track(), (b) render the boolean isUnread(), and
//     (c) FIRE an "opened" event via emitJournalOpened() when the user opens a
//     journal. They never compute signatures, compare, or persist anything.
//   - All computation + persistence lives here and behind a swappable provider.
//
// Event-driven "read": opening a journal dispatches an "opened" event; the
// service listens for it and marks the journal seen. This keeps the UI as a
// pure event emitter and lets other listeners hook the same signal later.
//
// Seeding (avoid a "wall of stars" on day one): any journal tracked before
// completeInitialSeeding() is recorded as already-seen. After initial seeding,
// a never-seen journal that appears is treated as new (unread) until opened.

import { computeJournalSignature } from './signature.js'
import { LocalStorageReadStateProvider } from './localStorageReadStateProvider.js'

const OPENED_EVENT = 'fp:journal-opened'

let _provider = new LocalStorageReadStateProvider()

// In-memory cache of each journal's current signature for this session. Filled
// by track(); read by isUnread()/markSeen() so callers never pass signatures.
const _currentSigs = new Map()

// Subscribers notified when read-state may have changed (for re-render).
const _subscribers = new Set()

// Event bus. Prefer a real EventTarget so the "opened" signal is a genuine
// event; fall back to a minimal shim in environments without EventTarget.
function makeBus() {
  if (typeof EventTarget !== 'undefined' && typeof CustomEvent !== 'undefined') {
    const t = new EventTarget()
    return {
      emit: (id) => t.dispatchEvent(new CustomEvent(OPENED_EVENT, { detail: { journalId: id } })),
      on: (fn) => {
        const h = (e) => fn(e.detail.journalId)
        t.addEventListener(OPENED_EVENT, h)
        return () => t.removeEventListener(OPENED_EVENT, h)
      },
    }
  }
  const listeners = new Set()
  return {
    emit: (id) => listeners.forEach((fn) => fn(id)),
    on: (fn) => { listeners.add(fn); return () => listeners.delete(fn) },
  }
}

const _bus = makeBus()

function notify() {
  for (const cb of _subscribers) {
    try { cb() } catch { /* a bad subscriber shouldn't break others */ }
  }
}

// ── Provider management (swappable) ────────────────────────────────

export function setReadStateProvider(provider) {
  _provider = provider
  notify()
}

export function getReadStateProvider() {
  return _provider
}

// ── Public API used by the UI ──────────────────────────────────────

/**
 * Hand the service a journal's current content. The service computes and caches
 * its signature and, during initial seeding, records it as already-seen.
 */
export function track(journalId, content) {
  const id = String(journalId)
  const sig = computeJournalSignature(content)
  const prev = _currentSigs.get(id)
  _currentSigs.set(id, sig)

  // First-load seeding: mark pre-existing journals as seen so day one is clean.
  if (!_provider.isInitialized()) {
    _provider.setSeen(id, sig)
  }

  if (prev !== sig) notify()
}

/**
 * Is this journal unread (has content the user hasn't opened since)?
 * Never-seen journals are "read" until initial seeding completes; after that a
 * newly-appearing journal counts as unread until opened.
 */
export function isUnread(journalId) {
  const id = String(journalId)
  const cur = _currentSigs.get(id)
  if (cur == null) return false
  if (_provider.hasSeen(id)) {
    return _provider.getSeen(id) !== cur
  }
  return _provider.isInitialized() === true
}

/** Record a journal as seen at its current signature (clears the badge). */
export function markSeen(journalId) {
  const id = String(journalId)
  const cur = _currentSigs.get(id)
  if (cur != null) {
    _provider.setSeen(id, cur)
    notify()
  }
}

/** Fire the "opened" event. UI calls this on open — no business logic in UI. */
export function emitJournalOpened(journalId) {
  _bus.emit(String(journalId))
}

/** Finish first-load seeding: journals appearing later count as new/unread. */
export function completeInitialSeeding() {
  if (!_provider.isInitialized()) {
    _provider.setInitialized(true)
    notify()
  }
}

/** Subscribe to read-state changes (for re-render). Returns an unsubscribe fn. */
export function subscribe(cb) {
  _subscribers.add(cb)
  return () => _subscribers.delete(cb)
}

// The service is itself the controller that reacts to the "opened" event by
// marking the journal seen — keeping that logic out of the UI.
_bus.on((journalId) => markSeen(journalId))

// Test-only reset so unit tests can start from a clean in-memory state.
export function __resetForTests(provider) {
  _currentSigs.clear()
  _subscribers.clear()
  if (provider) _provider = provider
}
