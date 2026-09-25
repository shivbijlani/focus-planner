/**
 * The allocation universe — every task ID that is already spoken for.
 *
 * Why this module exists
 * ---------------------
 * Task IDs were allocated as `maxId + 1`, where `maxId` was scanned from the
 * ACTIVE board only. That is not a safety property, and it fails in two
 * different ways that turn out to be the same bug (GH #528, GH #132):
 *
 *  1. **The completed board is not in the universe (#132).** Completing a task
 *     moves its row off `planner.md`, so `maxId` drops back below it and the
 *     ID is handed out a second time. Measured live: #392 "billion heartbeats
 *     video" was completed 2026-07-29, and #392 "Buy dhol from Nagi" was
 *     created 2026-07-30 with the same number.
 *
 *  2. **Two replicas allocate the same number (#528).** Two devices that each
 *     see `max = 482` both deterministically compute `483`. The later write
 *     silently destroys the earlier row. Measured live twice: 2026-09-05 (the
 *     user-authored "Potential Turkey vacation" row) and 2026-09-09 (a Dubai
 *     itinerary task, overwritten ~30 minutes after it was created).
 *
 * This is deliberately **not** framed as a race window. Two replicas holding
 * the same `maxId` collide 100% of the time, not occasionally, so it cannot be
 * fixed with retries, debouncing or timing tweaks. It is fixed by asking a
 * wider question before writing: *is this number already taken anywhere?*
 *
 * Membership, never maximum
 * -------------------------
 * Every function here answers "is this ID taken?" and nothing else. That
 * distinction is load-bearing rather than stylistic: the live sync shadow
 * carries junk legacy IDs in the 426000+ range (426565, 426566, 426592) left
 * by an old orphaned-journal incident. Taking `max()` across the universe
 * would number the next task 426593 and every task after it. Because
 * `allocateNextId` starts at `contentMaxId + 1` and walks upward over taken
 * IDs, those junk entries are simply never reached — they only ever stop an ID
 * from being reused.
 *
 * IDs stay small human-readable integers by design. Shiv reads and types them
 * aloud ("parent 451 to health and hygiene", "mark 459 complete"), so UUIDs and
 * device-prefixed IDs were considered and rejected on those grounds.
 *
 * Everything here is pure and dependency-free so it is exhaustively testable;
 * the caller does the I/O and hands in the text.
 */

/** First-cell grammar shared by both boards: a bare ID, or `401,[170](url)`. */
const LEADING_ID = /^(\d+)/

function addId(set, value) {
  const n = typeof value === 'number' ? value : parseInt(String(value ?? '').trim(), 10)
  if (Number.isFinite(n) && n > 0) set.add(n)
}

/**
 * Task IDs present as table rows in a board's markdown.
 *
 * Works for both the active board and `planner-completed.md`: they share the
 * row grammar, and the completed board simply groups its rows under weekly
 * headings. Header rows (`| ID | …`) and separator rows (`|---|`) are skipped.
 *
 * @param {string} markdown raw contents of planner.md / planner-completed.md
 * @returns {Set<number>}
 */
export function taskIdsFromBoard(markdown) {
  const ids = new Set()
  if (!markdown || typeof markdown !== 'string') return ids
  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line.startsWith('|')) continue
    const secondPipe = line.indexOf('|', 1)
    if (secondPipe === -1) continue
    const cell = line.slice(1, secondPipe).trim()
    if (!cell || cell === 'ID' || /^[-:]+$/.test(cell)) continue
    const match = cell.match(LEADING_ID)
    if (match) addId(ids, match[1])
  }
  return ids
}

/**
 * Task IDs recorded in a folder-sync shadow (`<board>.sync.json`).
 *
 * **Includes tombstones.** An entry with `deleted: true` is an ID the user
 * consumed and then removed; reissuing it lets a resurrected journal or a
 * lagging replica re-attach to the wrong task. So every key counts as taken,
 * deleted or not — this set answers membership, and only membership.
 *
 * A truncated or half-written shadow must never take allocation down and must
 * never be read as "nothing is taken but also everything is fine": it yields no
 * signal, and the other universe members still apply.
 *
 * @param {string} json raw contents of a `*.sync.json` record
 * @returns {Set<number>}
 */
export function taskIdsFromSyncShadow(json) {
  const ids = new Set()
  if (!json || typeof json !== 'string') return ids
  let parsed
  try {
    parsed = JSON.parse(json)
  } catch {
    return ids
  }
  const entries = parsed && typeof parsed === 'object' ? parsed.entries : null
  if (!entries || typeof entries !== 'object') return ids
  for (const rawId of Object.keys(entries)) {
    if (!/^\d+$/.test(String(rawId).trim())) continue
    addId(ids, rawId)
  }
  return ids
}

/**
 * Union every source of "this ID is taken" into one collision-skip set.
 *
 * Each input is independently optional: a folder with no completed board, no
 * shadow, or no journals still produces a usable (smaller) universe rather than
 * failing. A wider universe can only ever push an allocation upward to a free
 * number, never onto a used one, so partial inputs degrade safely.
 *
 * @param {object} args
 * @param {Iterable<string>} [args.boards] markdown of every board to include —
 *        the active board AND `planner-completed.md` (the #132 gap).
 * @param {Iterable<string>} [args.shadows] raw `*.sync.json` contents.
 * @param {Iterable<number|string>} [args.journalIds] ids of `journal/task-N.md`
 *        files, plus any caller-side reservations (deleted-id tombstones,
 *        task-settings keys).
 * @param {Iterable<number|string>} [args.extraIds] anything else already known
 *        to be spoken for.
 * @returns {Set<number>} every ID that must not be allocated.
 */
export function collectAllocationUniverse({ boards = [], shadows = [], journalIds = [], extraIds = [] } = {}) {
  const ids = new Set()
  for (const board of boards ?? []) {
    for (const id of taskIdsFromBoard(board)) ids.add(id)
  }
  for (const shadow of shadows ?? []) {
    for (const id of taskIdsFromSyncShadow(shadow)) ids.add(id)
  }
  for (const id of journalIds ?? []) addId(ids, id)
  for (const id of extraIds ?? []) addId(ids, id)
  return ids
}
