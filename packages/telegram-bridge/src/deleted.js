// Parses the planner's sync records (`planner.md.sync.json`,
// `planner-completed.md.sync.json`) into the set of task IDs the user has
// DELETED in the app.
//
// Why this exists
// ---------------
// `syncArchive` used to decide a topic's fate purely from the completed board:
//
//     shouldArchive = completed.has(taskId)
//
// That has no way to express "this task is gone". A task the user deletes in
// the planner UI leaves BOTH boards, so `completed.has(id)` is false forever —
// and its forum topic therefore stays open in Telegram for good. Measured on
// the live planner: 139 deleted tasks, 101 of them still holding a topic, 65 of
// those still open. The user noticed one of them (#434, deleted 2026-08-24) was
// still sitting in his forum four days later and asked for it to be removed.
//
// It is deliberately keyed on the explicit `deleted: true` tombstone rather than
// on "absent from the board". Absence is ambiguous — a board that failed to
// parse, or a row that has not synced yet, would read as absent and could close
// a live task's topic. The tombstone is a deliberate, recorded user action.
//
// Shape of the file (written by the app's folder-sync layer):
//
//   {
//     "version": 1,
//     "updatedAt": 1787621820553,
//     "entries": {
//       "434": { "clock": 1787621820553, "deleted": true,  "fp": -1454295489 },
//       "462": { "clock": 1787000000000, "deleted": false, "fp":  1234567890 }
//     }
//   }

/**
 * @param {string} json raw contents of a `*.sync.json` planner record
 * @returns {string[]} unique deleted task IDs. Order is unspecified — these are
 *   integer-like object keys, which JS iterates in ascending numeric order, so
 *   insertion order is not recoverable. The caller builds a Set, so it is moot.
 */
export function parseDeletedTaskIds(json) {
  if (!json) return []
  let parsed
  try {
    parsed = JSON.parse(json)
  } catch {
    // A truncated or half-written sync file must never take the bridge down,
    // and must never be read as "everything is deleted". Treat it as no signal.
    return []
  }
  const entries = parsed && typeof parsed === 'object' ? parsed.entries : null
  if (!entries || typeof entries !== 'object') return []

  const ids = []
  const seen = new Set()
  for (const [rawId, record] of Object.entries(entries)) {
    if (!record || typeof record !== 'object') continue
    // Strictly `true` — not merely truthy. A malformed value is not a licence
    // to close a topic the user can still see.
    if (record.deleted !== true) continue
    const id = String(rawId).trim()
    if (!/^\d+$/.test(id)) continue
    if (seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  return ids
}
