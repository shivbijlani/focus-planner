/**
 * User-facing vs advanced partition for the Agent settings form (task #397).
 *
 * `user-settings.md` is the overnight agent's source of truth, but most of its
 * rows are paths, account IDs, chat/bot identifiers and allow-lists that a user
 * should almost never touch — surfacing all of them as editable inputs is noisy
 * and risky. This module classifies each parsed settings row as:
 *
 *  - `user`     — a knob a person reasonably flips (their name, timezone, a
 *                 feature on/off toggle). Shown by default.
 *  - `advanced` — infrastructure the agent manages (paths, accounts, IDs, tokens,
 *                 allow-lists). Kept out of the way behind a disclosure, still
 *                 editable for the rare case it must change.
 *
 * Classification is by **label** (case-insensitive, trimmed), which is stable
 * even though the section headers in the file carry parenthetical task notes
 * (e.g. `## Telegram (mobile journal bridge — task #352)`). The set is
 * intentionally small and conservative: anything not explicitly user-facing is
 * treated as advanced, so a new/unknown row never leaks into the simple view.
 */

// Labels a user reasonably edits directly. Everything else is advanced.
const USER_FACING_LABELS = new Set([
  'user',      // who the agent is working for
  'timezone',  // their timezone
  'enabled',   // a feature on/off toggle (e.g. Telegram mirroring)
  'tasks',     // which tasks a feature applies to (allow-list of IDs)
])

/**
 * Normalize a settings label for comparison (trim + lowercase).
 * @param {string} label
 * @returns {string}
 */
function normalizeLabel(label) {
  return String(label == null ? '' : label).trim().toLowerCase()
}

/**
 * Classify a single settings row by its label.
 * @param {string} label
 * @returns {'user' | 'advanced'}
 */
export function classifyAgentSetting(label) {
  return USER_FACING_LABELS.has(normalizeLabel(label)) ? 'user' : 'advanced'
}

/**
 * Whether a settings row should be shown by default (user-facing).
 * @param {string} label
 * @returns {boolean}
 */
export function isUserFacingSetting(label) {
  return classifyAgentSetting(label) === 'user'
}

/**
 * Split the output of `groupSettingsForm(md)` into two parallel group lists —
 * `{ user, advanced }` — preserving section grouping and each row's original
 * flat `index` (the key `serializeSettingsForm` expects). Groups that end up
 * with no rows in a partition are dropped, so the caller can render each list
 * directly. Every input row lands in exactly one partition (nothing is lost).
 *
 * @param {Array<{section: string|null, rows: Array<{label: string, index: number}>}>} groups
 * @returns {{ user: typeof groups, advanced: typeof groups }}
 */
export function partitionAgentSettings(groups) {
  const user = []
  const advanced = []
  for (const group of Array.isArray(groups) ? groups : []) {
    const userRows = []
    const advancedRows = []
    for (const row of group && Array.isArray(group.rows) ? group.rows : []) {
      if (isUserFacingSetting(row.label)) userRows.push(row)
      else advancedRows.push(row)
    }
    if (userRows.length) user.push({ section: group.section, rows: userRows })
    if (advancedRows.length) advanced.push({ section: group.section, rows: advancedRows })
  }
  return { user, advanced }
}
