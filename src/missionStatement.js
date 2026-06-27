// Mission statement: a short personal "north star" the user can set in Settings
// and see tastefully pinned at the top of the board.
//
// Design (per task #322 + the read-state philosophy in #311): the UI carries no
// business logic. It reads the current value and fires a change event; this module
// is the single place that knows the value lives in localStorage. Swapping the
// backing store later (e.g. a synced provider) means changing only this file.

const STORAGE_KEY = 'fp-mission-statement'
const CHANGE_EVENT = 'fp-mission-changed'

// Read the saved mission statement. Returns '' when unset or unavailable.
export function getMissionStatement() {
  try {
    return localStorage.getItem(STORAGE_KEY) || ''
  } catch {
    return ''
  }
}

// Persist the mission statement and notify listeners. Trims surrounding
// whitespace; an empty/whitespace-only value clears it.
export function setMissionStatement(value) {
  const next = (value || '').trim()
  try {
    if (next) localStorage.setItem(STORAGE_KEY, next)
    else localStorage.removeItem(STORAGE_KEY)
  } catch {
    // Storage may be unavailable (private mode, quota). Still fire the event so
    // the in-memory UI stays in sync for this session.
  }
  try {
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: next }))
  } catch {
    // No window (tests/SSR) — nothing to notify.
  }
  return next
}

// Subscribe to mission-statement changes. Fires the listener with the new value.
// Returns an unsubscribe function.
export function subscribeMissionStatement(listener) {
  const handler = (e) => listener(e?.detail ?? getMissionStatement())
  try {
    window.addEventListener(CHANGE_EVENT, handler)
    return () => window.removeEventListener(CHANGE_EVENT, handler)
  } catch {
    return () => {}
  }
}

export const __testing = { STORAGE_KEY, CHANGE_EVENT }
