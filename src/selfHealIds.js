/**
 * TEMPORARY defence-in-depth: self-heal "runaway" task IDs on load.
 *
 * Background: a bug let new task IDs inherit a foreign/journal counter and jump
 * into a far-away range (e.g. the 426xxx band that belongs to a different
 * planner). The numbering bug itself is fixed at the source (see
 * allocateNextId + per-source journalIds), but replicas that were already
 * polluted can still arrive via sync. This module renumbers those stray
 * high-outlier IDs back down into the planner's own contiguous sequence when
 * the plan file is loaded.
 *
 * It is intentionally isolated in its own file so it can be deleted wholesale
 * once every device has loaded at least once and healed itself. The single
 * call site in App.jsx is marked with `SELF_HEAL_IDS`.
 */
import { parseLocalId, rewriteRowId } from './moveTask.js'

/**
 * Given the list of task-row IDs (numbers), return the set of IDs considered
 * "outliers" — a high cluster separated from the main body by a gap larger
 * than `gapThreshold`. Everything at or above the first such gap is flagged.
 *
 * A healthy, contiguous sequence (low or high) yields an empty set, so this is
 * a no-op for a planner that legitimately uses large IDs.
 *
 * @param {number[]} ids
 * @param {number} gapThreshold
 * @returns {Set<number>}
 */
export function detectOutlierIds(ids, gapThreshold = 1000) {
  const uniq = [...new Set(ids.filter(n => Number.isFinite(n)))].sort((a, b) => a - b)
  if (uniq.length < 2) return new Set()
  let cut = -1
  for (let i = 1; i < uniq.length; i++) {
    if (uniq[i] - uniq[i - 1] > gapThreshold) { cut = i; break }
  }
  if (cut === -1) return new Set()
  return new Set(uniq.slice(cut))
}

/**
 * Pure transform: renumber outlier task IDs in a focus-plan markdown string
 * down into the planner's own sequence, remapping linked-IDs and the
 * Priorities list to match.
 *
 * @param {string} content
 * @param {object} [opts]
 * @param {Set<number>} [opts.journalIds]  IDs already taken by a journal file (skip these).
 * @param {number} [opts.gapThreshold]
 * @returns {{ content: string, idMap: Map<string,string>, changed: boolean }}
 */
export function selfHealOutlierIds(content, { journalIds = new Set(), gapThreshold = 1000 } = {}) {
  const lines = content.split('\n')

  // Collect the local numeric ID of every data row.
  const rowIds = []
  for (const line of lines) {
    const t = line.trim()
    if (!t.startsWith('|')) continue
    const cells = t.split('|').slice(1, -1).map(c => c.trim())
    if (!cells.length || cells[0] === 'ID' || cells[0] === '#' || /^[-:]+$/.test(cells[0])) continue
    const id = parseLocalId(cells[0])
    if (id) rowIds.push(parseInt(id, 10))
  }

  const outliers = detectOutlierIds(rowIds, gapThreshold)
  if (outliers.size === 0) return { content, idMap: new Map(), changed: false }

  // Assign new IDs continuing from the highest non-outlier row ID, skipping any
  // ID already taken by a surviving row or an existing journal.
  const normal = rowIds.filter(id => !outliers.has(id))
  const taken = new Set([...normal, ...[...journalIds].map(Number)])
  let next = normal.length ? Math.max(...normal) : 0
  const idMap = new Map()
  for (const oldId of [...outliers].sort((a, b) => a - b)) {
    next++
    while (taken.has(next)) next++
    taken.add(next)
    idMap.set(String(oldId), String(next))
  }

  // Rewrite rows (own ID + any linked-ID pointing at a renamed task) and the
  // Priorities list entries.
  let inPriorities = false
  const out = lines.map(line => {
    const t = line.trim()
    if (t.startsWith('## ')) {
      const title = t.replace(/^##\s+/, '')
      inPriorities = /^(Priorities|Work Priorities|Manager Priorities)$/.test(title)
      return line
    }
    if (t.startsWith('|')) {
      const cells = t.split('|').slice(1, -1).map(c => c.trim())
      if (!cells.length || cells[0] === 'ID' || cells[0] === '#' || /^[-:]+$/.test(cells[0])) return line
      const localId = parseLocalId(cells[0])
      const linkedRaw = (cells[cells.length - 1] || '').match(/^(\d+)/)?.[1]
      const idChanges = localId && idMap.has(localId)
      const linkChanges = linkedRaw && idMap.has(linkedRaw)
      if (!idChanges && !linkChanges) return line
      const newLocal = idChanges ? idMap.get(localId) : localId
      return rewriteRowId(line, newLocal, idMap)
    }
    if (inPriorities) {
      const m = line.match(/^(\s*)(\d+)\.\s+(.+?)\s*$/)
      if (m && idMap.has(m[3])) {
        return `${m[1]}${m[2]}. ${idMap.get(m[3])}`
      }
    }
    return line
  })

  return { content: out.join('\n'), idMap, changed: true }
}
