// Remember where you were on the board so returning from a task's journal lands
// you at the same scroll position instead of jumping back to the top (#278).
//
// The board scrolls inside the `.content` <main> element; opening a journal
// swaps that element to an internally-scrolling chat view and, on return,
// re-renders a fresh board at scrollTop 0. We snapshot the board's scrollTop
// just before navigating away and reapply it once the board has rendered again.
//
// Positions live in a module-level Map (keyed by the board's file path) so they
// survive the journal view's unmount/remount within a session, and reset
// naturally on a full reload.

const positions = new Map()

// Save the board's current scroll offset for `path`. Ignores junk values so a
// detached/zero-height container can't poison the saved position.
export function saveScrollPosition(path, scrollTop) {
  if (!path) return
  const top = Number(scrollTop)
  if (!Number.isFinite(top) || top < 0) return
  positions.set(path, top)
}

// Return the saved offset for `path`, or null if nothing was saved.
export function getSavedScrollPosition(path) {
  if (!path || !positions.has(path)) return null
  return positions.get(path)
}

export function clearScrollPosition(path) {
  positions.delete(path)
}

// Test-only: wipe all saved positions.
export function _resetScrollPositions() {
  positions.clear()
}

// Clamp a saved offset to what the container can actually scroll to right now.
// If the board shrank while you were away (a task was completed/removed), an
// out-of-range offset would otherwise snap to the bottom; instead we restore to
// the nearest valid position, falling back to 0 when the board no longer
// scrolls at all.
export function clampScrollTop(saved, scrollHeight, clientHeight) {
  const top = Number(saved)
  if (!Number.isFinite(top) || top <= 0) return 0
  const max = Math.max(0, Number(scrollHeight) - Number(clientHeight))
  if (!Number.isFinite(max)) return top
  return Math.min(top, max)
}
