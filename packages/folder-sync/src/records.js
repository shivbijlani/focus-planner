// Record-level reconcile for a single file.
//
// This is the operation that actually fixes the "deleted rows reappear" bug:
// instead of pushing/pulling an opaque whole file with last-write-wins, it
//   1. parses both local and remote into records (via a codec),
//   2. detects local changes and stamps logical clocks (sidecar meta),
//   3. merges per-record with tombstones (merge core),
//   4. writes the merged result back to whichever side(s) changed,
// so a stale replica can never resurrect a row another device deleted.
//
// It is transport-agnostic: callers supply plain async read/write closures for
// the local store and the remote target, plus read/write for each side's
// sidecar (the JSON file that carries per-record clocks + tombstones). That
// makes it equally usable from the service worker and the main-thread engine,
// and trivially testable with in-memory stubs.

import {
  mergeCollections,
  stampLocalChanges,
  gcTombstones,
  fingerprint,
  serializeSidecar,
  parseSidecar,
} from './merge.js'
import { FRAME_ID } from './codecs/mdTable.js'

/** True if a codec frame carries real structure (at least one `## ` heading). */
export function frameHasStructure(frame) {
  return typeof frame === 'string' && /(^|\n)\s*##\s/.test(frame)
}

/**
 * Guard against an empty/structureless frame winning the merge. The codec stores
 * all section headings (## Today / ## Deferred / ## Priorities, table headers,
 * separators, the Priorities list, prose) in a single FRAME record that merges
 * by last-write-wins like any row. On the first sync a brand-new/empty local
 * file's empty frame is stamped `now` and beats the remote's good frame stamped
 * `0`, stripping every heading and leaving the rows orphaned — which renders as
 * a blank planner (title only). A frame with no `## ` heading carries no
 * structure and must never overwrite one that does.
 *
 * @returns {string|null} the structured frame to use instead, or null to keep
 *   the merged frame as-is (both sides structured, or both empty).
 */
export function preferStructuredFrame(localFrame, remoteFrame) {
  const l = frameHasStructure(localFrame)
  const r = frameHasStructure(remoteFrame)
  if (l && !r) return localFrame
  if (r && !l) return remoteFrame
  return null
}

// Section titles the app treats as the manager/work Priorities list. Kept in
// sync with src/focusPlanShared.js:isPrioritiesSection. The codec folds this
// ordered list into the FRAME record, so it merges by last-write-wins.
const PRIORITIES_TITLES = new Set(['Priorities', 'Work Priorities', 'Manager Priorities'])

/**
 * Count the ordered-list items (`1. ...`, `2. ...`) inside a frame's Priorities
 * section. Used to detect when a merge has emptied the list.
 */
export function framePriorityCount(frame) {
  if (typeof frame !== 'string') return 0
  let inPriorities = false
  let count = 0
  for (const line of frame.split('\n')) {
    const heading = line.match(/^##\s+(.+?)\s*$/)
    if (heading) {
      inPriorities = PRIORITIES_TITLES.has(heading[1].trim())
      continue
    }
    if (inPriorities && /^\s*\d+\.\s+\S/.test(line)) count++
  }
  return count
}

/**
 * Guard against a populated Priorities list being silently wiped by the frame's
 * last-write-wins merge. The whole `## Priorities` ordered list lives inside the
 * single FRAME record, so a side whose frame still HAS every `## ` heading but an
 * EMPTY Priorities section (e.g. a freshly-scaffolded source whose plan template
 * is `## Priorities\n\n`, or an external editor that dropped the list) can win on
 * a newer clock and erase the user's priorities — without tripping
 * `preferStructuredFrame`, which only catches a frame missing headings entirely.
 *
 * When the merged frame ended up with no Priorities items but exactly one side
 * still carried them, prefer that side's frame so the list survives. Mirrors the
 * structure guard's bias: the worst case is a harmless resurrected list (user-
 * fixable), never silent data loss. If both sides have items, the LWW winner is
 * already non-empty and we leave it alone.
 *
 * @returns {string|null} the frame to use instead, or null to keep the merged
 *   frame as-is.
 */
export function preferPopulatedPriorityFrame(localFrame, remoteFrame, mergedFrame) {
  if (framePriorityCount(mergedFrame) > 0) return null
  const l = framePriorityCount(localFrame)
  const r = framePriorityCount(remoteFrame)
  if (l > 0 && r === 0) return localFrame
  if (r > 0 && l === 0) return remoteFrame
  if (l > 0 && r > 0) return l >= r ? localFrame : remoteFrame
  return null
}

/** Convention: a file's sidecar lives next to it as `<path>.sync.json`. */
export function sidecarPath(path) {
  return `${path}.sync.json`
}

/** True if `path` is a sidecar file (so transports can skip listing them as data). */
export function isSidecarPath(path) {
  return path.endsWith('.sync.json')
}

// Fold the codec's frame into the record set so it merges by LWW like any other
// record, then split it back out for serialize().
function toCollection(codec, content) {
  const { records, frame } = codec.parse(content ?? '')
  const all = { ...records }
  all[FRAME_ID] = { frame }
  return all
}

function fromCollection(codec, mergedRecords) {
  const records = {}
  let frame = ''
  for (const [id, rec] of Object.entries(mergedRecords)) {
    if (id === FRAME_ID) { frame = rec?.frame ?? ''; continue }
    records[id] = rec
  }
  return codec.serialize({ records, frame })
}

/**
 * @param {object} args
 * @param {string} args.path
 * @param {{parse:Function, serialize:Function}} args.codec
 * @param {object} args.local   - { readContent, writeContent, readSidecar, writeSidecar }
 * @param {object} args.remote  - { readContent, writeContent, readSidecar, writeSidecar }
 * @param {number} [args.now]
 * @returns {Promise<{changedLocal:boolean, changedRemote:boolean, content:string}>}
 */
export async function reconcileRecordsFile({ path, codec, local, remote, now = Date.now() }) {
  const [localContent, remoteContent, localSidecar, remoteSidecar] = await Promise.all([
    local.readContent(path),
    remote.readContent(path),
    local.readSidecar(sidecarPath(path)),
    remote.readSidecar(sidecarPath(path)),
  ])

  const localRecords = toCollection(codec, localContent)
  const remoteRecords = toCollection(codec, remoteContent)
  const localMeta = parseSidecar(localSidecar)
  const remoteMeta = parseSidecar(remoteSidecar)

  // Detect and stamp any local edits (from our UI *or* an external editor such
  // as the desktop server / OneDrive web) so they carry an honest clock.
  stampLocalChanges(localRecords, localMeta, now)
  // The remote side's edits were stamped on whatever device produced them; we
  // only stamp here for the very first sync where the remote has content but no
  // sidecar yet (legacy backup). Use clock 0 so a real local edit wins ties.
  if (!remoteSidecar) stampLocalChanges(remoteRecords, remoteMeta, 0)

  const merged = mergeCollections(
    { records: localRecords, meta: localMeta },
    { records: remoteRecords, meta: remoteMeta },
  )

  // Guard: never let an empty/structureless frame win. The FRAME record merges
  // by LWW; on a first sync a brand-new/empty local file (frame '') stamped
  // `now` beats the remote's structured frame stamped `0`, which would strip
  // every `## ` heading and orphan all the rows (blank-planner corruption).
  const localFrame = localRecords[FRAME_ID]?.frame ?? ''
  const remoteFrame = remoteRecords[FRAME_ID]?.frame ?? ''
  const mergedFrame = merged.records[FRAME_ID]?.frame ?? ''
  if (!frameHasStructure(mergedFrame)) {
    const better = preferStructuredFrame(localFrame, remoteFrame)
    if (better != null) {
      merged.records[FRAME_ID] = { frame: better }
      // Ensure the restored frame is treated as the live value going forward.
      if (merged.meta[FRAME_ID]) merged.meta[FRAME_ID].deleted = false
      else merged.meta[FRAME_ID] = { clock: now, deleted: false }
    }
  }

  // Guard: never let a populated Priorities list be wiped by the frame's LWW
  // merge. The whole `## Priorities` ordered list lives in the FRAME record, so a
  // structured-but-empty frame (e.g. a freshly-scaffolded source, or an external
  // edit that dropped the list) can win on a newer clock and erase the user's
  // priorities while still passing the structure guard above. Re-apply the side
  // that still has the list. Re-read the (possibly structure-restored) frame.
  {
    const curMergedFrame = merged.records[FRAME_ID]?.frame ?? ''
    const better = preferPopulatedPriorityFrame(localFrame, remoteFrame, curMergedFrame)
    if (better != null) {
      merged.records[FRAME_ID] = { frame: better }
      if (merged.meta[FRAME_ID]) merged.meta[FRAME_ID].deleted = false
      else merged.meta[FRAME_ID] = { clock: now, deleted: false }
    }
  }

  gcTombstones(merged.meta, now)
  // The merge core drops the change-detection fingerprint from winning entries;
  // recompute it from the merged content so the *next* sync can tell what truly
  // changed (otherwise every record looks edited and stale rows masquerade as
  // fresh writes, which both resurrects deletes and clobbers concurrent edits).
  for (const [id, rec] of Object.entries(merged.records)) {
    if (merged.meta[id]) merged.meta[id].fp = fingerprint(rec)
  }
  const mergedContent = fromCollection(codec, merged.records)
  const mergedSidecar = serializeSidecar(merged.meta, now)

  const changedLocal = mergedContent !== (localContent ?? '') || merged.localChanged
  const changedRemote = mergedContent !== (remoteContent ?? '') || merged.remoteChanged

  if (changedLocal) {
    await local.writeContent(path, mergedContent)
    await local.writeSidecar(sidecarPath(path), mergedSidecar)
  } else {
    // Keep sidecars converged even when content is identical.
    await local.writeSidecar(sidecarPath(path), mergedSidecar)
  }
  if (changedRemote) {
    await remote.writeContent(path, mergedContent)
    await remote.writeSidecar(sidecarPath(path), mergedSidecar)
  } else {
    await remote.writeSidecar(sidecarPath(path), mergedSidecar)
  }

  return { changedLocal, changedRemote, content: mergedContent }
}
