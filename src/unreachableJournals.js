/**
 * #190 detector — a live journal with no reachable board row.
 *
 * This is the inverse of #185 (which orphaned the *journal* when a row was
 * deleted). Here the *row* vanished and the journal survived: task #228 had a
 * live, actively-worked journal but no row on `planner.md` or
 * `planner-completed.md` and no tombstone in either board's `.sync.json`
 * sidecar, so it was invisible to Shiv, to the Telegram approval digest, and to
 * every board-gated sweep — while the overnight agent kept working and asking
 * questions into an unreachable journal.
 *
 * A journal that is (a) non-terminal, (b) has no row on either board, and (c)
 * has no tombstone is by definition an inconsistency the app can find cheaply on
 * load, from data it already has in hand. Surfacing it here means the app itself
 * notices, instead of an external sweep being the only thing that ever does.
 *
 * Pure and dependency-free so it is exhaustively unit-testable. Inputs are plain
 * shapes; ids are compared as strings so `228` and `"228"` match.
 *
 * @param {object} args
 * @param {Array<{id: string|number, terminal?: boolean}>} args.journals
 *        every task journal that exists, with `terminal` true for a finished
 *        task (done / skipped / cancelled / archived — a state where having no
 *        board row is expected and correct).
 * @param {Iterable<string|number>} args.boardIds
 *        ids that appear as a row on EITHER board (Today, Deferred, etc.) and
 *        the completed board. A journal whose id is here is reachable.
 * @param {Iterable<string|number>} args.tombstoned
 *        ids carrying a `deleted: true` entry in EITHER board's sidecar. A
 *        journal whose id is here was deliberately deleted — not an anomaly.
 * @returns {string[]} the ids of non-terminal journals that are unreachable and
 *        untombstoned, in the order the journals were supplied.
 */
export function findUnreachableLiveJournals({ journals = [], boardIds = [], tombstoned = [] } = {}) {
  const onBoard = new Set()
  for (const id of boardIds ?? []) onBoard.add(String(id))
  const deleted = new Set()
  for (const id of tombstoned ?? []) deleted.add(String(id))

  const out = []
  const seen = new Set()
  for (const journal of journals ?? []) {
    if (!journal || journal.id == null) continue
    if (journal.terminal) continue
    const id = String(journal.id)
    if (onBoard.has(id) || deleted.has(id) || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}
