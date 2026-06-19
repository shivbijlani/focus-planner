// Combined (multi-source) view write-routing (#39).
//
// Two folders can legitimately contain rows with identical text and/or the same
// local task id — shared umbrella/category rows (e.g. #191 "Hygiene", #192
// "Focus plan app") or genuinely duplicate rows. The combined view used to
// route a destructive op (complete / delete / move / priority) by looking the
// clicked row up in maps keyed by the trimmed row text or the local id. Those
// keys are NOT unique across sources, so a Map keeps only the last source
// iterated — and a *work* task could be archived into the *personal* folder's
// focus-plan-completed.md, then bleed onto mobile (which only syncs personal).
//
// The fix: tag every merged row with the id of the source it actually came
// from (`__sourceId`), carried on the row object through parse -> sort ->
// filter -> context menu -> handler, and resolve the owning source from that
// tag first, falling back to the legacy text lookup only for untagged rows
// (e.g. the single-source view, which has no ambiguity).

/**
 * Tag each parsed row with its owning source id.
 *
 * `rows` come out of `parseMarkdownTable` in data-line order, and `sourceIds`
 * is the parallel array produced by the combined-view merge (also in data-line
 * order), so they align by index. Rows are mutated in place (the `__sourceId`
 * property rides along through the sort/filter steps, which preserve row
 * object identity). Safe to call with mismatched/empty inputs — it no-ops.
 *
 * @param {Array<object>} rows
 * @param {Array<string>} sourceIds
 * @returns {Array<object>} the same `rows`, tagged
 */
export function tagMergedRows(rows, sourceIds) {
  if (!Array.isArray(rows) || !Array.isArray(sourceIds)) return rows
  for (let i = 0; i < rows.length; i++) {
    if (rows[i] && sourceIds[i] !== undefined && sourceIds[i] !== null) {
      rows[i].__sourceId = sourceIds[i]
    }
  }
  return rows
}

/**
 * Resolve the source a row belongs to for write-routing.
 *
 * Prefers the row's own `__sourceId` tag (unambiguous, set at merge time).
 * Falls back to the legacy trimmed-text lookup for rows that were never tagged
 * — i.e. the single-source view, or any caller that only has a raw line. The
 * fallback is what produced the cross-source bleed when two sources collided,
 * so the tag must always win when present.
 *
 * @param {object} row              the parsed/tagged row (may be undefined)
 * @param {string} rawLine          the raw markdown line for the row
 * @param {Map<string,string>} [lineToSource] legacy text -> sourceId map
 * @returns {string|undefined} the owning source id, or undefined if unknown
 */
export function resolveRowSourceId(row, rawLine, lineToSource) {
  if (row && row.__sourceId) return row.__sourceId
  if (lineToSource) return lineToSource.get((rawLine || '').trim())
  return undefined
}
