// Scroll a task's row into view and briefly flash it, so the user can see where
// a task landed — e.g. right after adding one to a long list (#268).
//
// Honors `prefers-reduced-motion`: for users who opt out we snap into place
// instead of smooth-scrolling. The CSS flash animation is also disabled under
// reduced motion (see `tr.highlight-flash` in App.css), so the row gets a brief
// static highlight rather than an animated fade.

export const FLASH_CLASS = 'highlight-flash'
export const FLASH_MS = 1500

function prefersReducedMotion() {
  return (
    typeof globalThis.matchMedia === 'function' &&
    globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

function flashRow(row, reduce) {
  if (typeof row.scrollIntoView === 'function') {
    row.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' })
  }
  row.classList.add(FLASH_CLASS)
  setTimeout(() => row.classList.remove(FLASH_CLASS), FLASH_MS)
}

// Expand any collapsed (non-priority) sections so a row hidden inside one can be
// found on retry. Returns true if it expanded anything.
function expandCollapsedSections(doc) {
  const collapsedHeaders = doc.querySelectorAll(
    '.task-section:not(.manager-priorities-section) .section-header .collapse-icon, .task-section:not(.personal-priorities-section) .section-header .collapse-icon'
  )
  let expanded = false
  collapsedHeaders.forEach(icon => {
    if (icon.textContent.trim() === '▶') {
      icon.closest('.section-header').click()
      expanded = true
    }
  })
  return expanded
}

/**
 * Scroll to the row for `taskId` and flash it. If the row isn't in the DOM yet
 * (e.g. it's inside a collapsed section), expand collapsed sections and retry
 * once after `retryDelayMs`.
 *
 * `doc` is injectable for testing; defaults to the global document.
 */
export function scrollToAndFlashTask(taskId, { doc = globalThis.document, retryDelayMs = 150 } = {}) {
  if (taskId === undefined || taskId === null || taskId === '' || !doc) return
  const reduce = prefersReducedMotion()
  let row = doc.querySelector(`tr[data-task-id="${taskId}"]`)
  if (row) {
    flashRow(row, reduce)
    return
  }
  if (expandCollapsedSections(doc)) {
    setTimeout(() => {
      row = doc.querySelector(`tr[data-task-id="${taskId}"]`)
      if (row) flashRow(row, reduce)
    }, retryDelayMs)
  }
}
