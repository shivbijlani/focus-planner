/**
 * Tiny helpers shared between focusPlanOps.js and App.jsx so we don't
 * have an import cycle. Keep this file dependency-free.
 */

export function isPrioritiesSection(title) {
  return title === 'Priorities' || title === 'Work Priorities' || title === 'Manager Priorities'
}
