/**
 * Pure editing logic for the Agent gate editor (#288), kept out of the
 * component file so `AgentGateEditor.jsx` only exports components (the
 * `react-refresh/only-export-components` rule) — the same split the repo
 * already uses for `SkillsSection.jsx` / `skillsSection.js`.
 */

/**
 * The Enter contract for a gate input: Enter commits the draft and clears the
 * box, every other key is ignored. Extracted so it can be tested directly —
 * the suite renders to static markup, which drops event listeners.
 *
 * Tolerant of a missing event or missing callbacks so a partially-wired input
 * can never throw during a keystroke.
 *
 * @param {{key?: string, preventDefault?: () => void}} event
 * @param {{draft?: string, onAdd?: (text: string) => void, onDraftChange?: (text: string) => void}} handlers
 * @returns {boolean} whether the event was handled
 */
export function handleGateKeyDown(event, { draft, onAdd, onDraftChange } = {}) {
  if (!event || event.key !== 'Enter') return false
  event.preventDefault?.()
  onAdd?.(draft)
  onDraftChange?.('')
  return true
}
