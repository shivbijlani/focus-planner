// Where a fixed-position context menu should actually be drawn (GH #640).
//
// The menu is `position: fixed` and was placed at the raw pointer coordinates, so a menu opened
// near the bottom of the viewport ran off the fold. Measured on the report that prompted this:
// a 7-item sheet on a 360x780 viewport put "Create Journal" at `top: 1006` — 226px below the
// bottom edge — and the items after it further down still. Because the menu is fixed, scrolling
// the page behind it does not bring them back, and `.context-menu` sets `overflow: hidden`, so
// the menu could not scroll either. The entries were simply unreachable.
//
// That matters more than a clipped menu usually would: for a task with no journal yet, the
// "Create Journal" entry in this menu is the ONLY way to start one — the 📔 affordance is absent
// from the row until the file exists. So an unreachable tail meant a task that could not be
// given a journal at all.
//
// Pure, and separate from the component, so the geometry can be tested without a DOM.

// Keeps the menu clear of the very edge. Small enough not to move a menu that already fits.
export const MENU_MARGIN = 8

/**
 * Clamp a menu's top-left corner so the whole menu stays inside the viewport.
 *
 * Preference order, which is what makes this feel right rather than merely correct:
 *   1. draw at the pointer, if it fits;
 *   2. otherwise FLIP above/left of the pointer, so the menu never covers the row it acts on;
 *   3. otherwise SLIDE it back inside the viewport;
 *   4. if it cannot fit at all, pin to the margin and let the caller scroll it.
 */
export function clampMenuPosition({
  x,
  y,
  width = 0,
  height = 0,
  viewportWidth = 0,
  viewportHeight = 0,
  margin = MENU_MARGIN,
} = {}) {
  const num = (v) => (Number.isFinite(v) ? v : 0)
  const vw = num(viewportWidth)
  const vh = num(viewportHeight)
  let left = num(x)
  let top = num(y)
  const w = num(width)
  const h = num(height)

  // Before measurement the menu reports 0x0. Clamping against that would move it to the pointer
  // for one frame and then jump, so an unmeasured menu is left exactly where it was asked for.
  if (!w && !h) return { top, left }

  if (vh && top + h + margin > vh) {
    // A flip only helps when the flipped position actually fits. The pointer itself can be below
    // the fold — that is precisely the reported case, where y was 1006 on a 780-tall viewport —
    // and flipping around an off-screen pointer lands off-screen again. Verified by the arm that
    // reproduces that measurement.
    const flipped = top - h
    top = flipped >= margin && flipped + h + margin <= vh
      ? flipped
      : Math.max(margin, vh - h - margin)
  }
  if (vw && left + w + margin > vw) {
    const flipped = left - w
    left = flipped >= margin && flipped + w + margin <= vw
      ? flipped
      : Math.max(margin, vw - w - margin)
  }
  // A pointer above/left of the margin (or a negative coordinate) must not push the menu off the
  // opposite edge, so the lower bound is applied last and unconditionally.
  return { top: Math.max(margin, top), left: Math.max(margin, left) }
}

/**
 * The tallest the menu may be before it has to scroll. Paired with the clamp: together they mean
 * a menu with more entries than the viewport can show becomes scrollable rather than truncated,
 * which is the case `overflow: hidden` silently lost.
 */
export function menuMaxHeight(viewportHeight, margin = MENU_MARGIN) {
  const vh = Number.isFinite(viewportHeight) ? viewportHeight : 0
  if (!vh) return null
  return Math.max(0, vh - margin * 2)
}
