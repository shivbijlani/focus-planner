// Optimistic patch for the Combined view's per-source state.
//
// The Combined board keeps each source's parsed content in `perSource`. Its
// mutation path (applyOp) writes the new content straight to the provider, then
// bumps a reloadKey to re-read every source. That re-read is asynchronous and
// can briefly lag the write, so the board rendered stale content until a full
// page reload (#411). Patching the just-written source's entry in place makes
// the board reflect the change immediately, while the reloadKey re-read still
// reconciles from storage in the background.
//
// Pure so it's unit-testable without React: given the current perSource array,
// return a new array with the matching source's `content` + `sections` replaced
// (recomputed via the supplied `parse` fn). Returns the original reference when
// there is nothing to patch, so React can skip a needless render.
export function patchPerSourceContent(perSource, sourceId, newContent, parse) {
  if (!Array.isArray(perSource) || !sourceId) return perSource
  let changed = false
  const next = perSource.map((entry) => {
    if (entry?.source?.id !== sourceId || entry.content === newContent) return entry
    changed = true
    return { ...entry, content: newContent, sections: parse(newContent) }
  })
  return changed ? next : perSource
}
