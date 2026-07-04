// Tier A conflict resolution: record-level last-write-wins with tombstones.
//
// The merge unit is a *record* (stable id), not the whole file. Deletes are
// recorded as tombstones so a stale replica can never resurrect a row that
// another device deleted — the root cause of the "deleted rows reappear" bug.
//
// This module is pure (no I/O, no deps) so it is exhaustively unit-testable
// and identical across both apps. The transport/SW layer feeds it parsed
// records + sidecar meta; the projection layer turns records back into
// markdown.
//
// A "collection snapshot" is:
//   {
//     records: { [id]: <content> },              // alive records (any serializable)
//     meta:    { [id]: { clock, deleted } },     // per-record logical clock (ms) + tombstone flag
//   }
//
// `clock` is a logical mtime (Date.now() at the time of the write/delete).
// A record present in `records` but missing from `meta` is treated as a
// legacy/external write with clock 0 (loses to any explicit clock). Callers
// should stamp a real clock via stampWrite when importing external edits.

const SIDECAR_VERSION = 1

function serialize(content) {
  if (typeof content === 'string') return content
  // JSON.stringify(undefined) returns the value `undefined` (not a string), so
  // guard against it — otherwise downstream `.length`/charCodeAt access throws
  // "Cannot read properties of undefined (reading 'length')".
  const s = JSON.stringify(content)
  return typeof s === 'string' ? s : ''
}

// Resolve one side of the merge for a given id into a normalized entry:
//   { present: bool, clock, deleted, content? }
function sideEntry(snapshot, id) {
  const meta = snapshot.meta?.[id]
  const hasRecord = Object.prototype.hasOwnProperty.call(snapshot.records ?? {}, id)
  if (!meta && !hasRecord) return { present: false }
  if (meta) {
    // Carry the deleted content's fingerprint (when recorded) so it survives the
    // merge and lets a later reappearance be classified as a stale-file ghost
    // (identical fp → keep tombstone) vs a genuine re-add (different fp → revive).
    if (meta.deleted) return { present: true, clock: meta.clock ?? 0, deleted: true, fp: meta.fp }
    // Alive per the sidecar, but the parsed content carries no such record — a
    // stale/inconsistent sidecar (e.g. a row removed from the file without its
    // meta being tombstoned, which happens with externally-edited cloud copies).
    // Treat this side as having no usable record so a phantom, content-less entry
    // can never win the merge. Previously it won as an "alive" record with
    // `undefined` content, crashing fingerprint() on `undefined.length` and
    // failing the whole sync ("Cannot read properties of undefined (reading
    // 'length')"). The other side's real record or tombstone wins instead.
    if (!hasRecord) return { present: false }
    return {
      present: true,
      clock: meta.clock ?? 0,
      deleted: false,
      content: snapshot.records[id],
    }
  }
  // Record exists with no meta — legacy/external write, oldest possible clock.
  return { present: true, clock: 0, deleted: false, content: snapshot.records[id] }
}

// Pick the winning entry between two normalized sides. Deterministic and
// symmetric so every device converges to the same result.
function pickWinner(a, b) {
  if (!a.present) return b
  if (!b.present) return a

  if (a.clock !== b.clock) return a.clock > b.clock ? a : b

  // Equal clocks: a delete beats an alive write (deletes are intentional).
  if (a.deleted !== b.deleted) return a.deleted ? a : b
  if (a.deleted && b.deleted) return a

  // Both alive, equal clock: break ties on content so the choice does not
  // depend on which device is "local" (otherwise replicas would diverge).
  const sa = serialize(a.content)
  const sb = serialize(b.content)
  if (sa === sb) return a
  return sa > sb ? a : b
}

/**
 * Merge two collection snapshots with per-record LWW + tombstones.
 *
 * @param {object} local  - { records, meta }
 * @param {object} remote - { records, meta }
 * @returns {{ records, meta, localChanged, remoteChanged }}
 *   merged snapshot plus flags indicating whether the local store and/or the
 *   remote need to be rewritten with the merged result.
 */
export function mergeCollections(local = {}, remote = {}) {
  const localSnap = { records: local.records ?? {}, meta: local.meta ?? {} }
  const remoteSnap = { records: remote.records ?? {}, meta: remote.meta ?? {} }

  const ids = new Set([
    ...Object.keys(localSnap.records), ...Object.keys(localSnap.meta),
    ...Object.keys(remoteSnap.records), ...Object.keys(remoteSnap.meta),
  ])

  const mergedRecords = {}
  const mergedMeta = {}

  for (const id of ids) {
    const winner = pickWinner(sideEntry(localSnap, id), sideEntry(remoteSnap, id))
    if (!winner.present) continue
    if (winner.deleted) {
      mergedMeta[id] = winner.fp !== undefined
        ? { clock: winner.clock, deleted: true, fp: winner.fp }
        : { clock: winner.clock, deleted: true }
    } else {
      mergedMeta[id] = { clock: winner.clock, deleted: false }
      mergedRecords[id] = winner.content
    }
  }

  return {
    records: mergedRecords,
    meta: mergedMeta,
    localChanged: !snapshotEqual(localSnap, { records: mergedRecords, meta: mergedMeta }),
    remoteChanged: !snapshotEqual(remoteSnap, { records: mergedRecords, meta: mergedMeta }),
  }
}

// Two snapshots are equal if their alive records and their meta (clock+deleted)
// match. Used only to decide whether a rewrite/push is needed.
function snapshotEqual(a, b) {
  const aIds = new Set([...Object.keys(a.records), ...Object.keys(a.meta)])
  const bIds = new Set([...Object.keys(b.records), ...Object.keys(b.meta)])
  if (aIds.size !== bIds.size) return false
  for (const id of aIds) {
    if (!bIds.has(id)) return false
    const am = a.meta[id] ?? (id in a.records ? { clock: 0, deleted: false } : null)
    const bm = b.meta[id] ?? (id in b.records ? { clock: 0, deleted: false } : null)
    if ((am?.clock ?? 0) !== (bm?.clock ?? 0)) return false
    if (!!am?.deleted !== !!bm?.deleted) return false
    if (!am?.deleted) {
      if (serialize(a.records[id]) !== serialize(b.records[id])) return false
    }
  }
  return true
}

// ── Mutation helpers (stamp logical clocks as the app edits) ────────────

/** Record a local create/update of `id` at `clock` (default now). Mutates+returns meta. */
export function stampWrite(meta, id, clock = Date.now()) {
  meta[id] = { clock, deleted: false }
  return meta
}

/**
 * Record a local delete of `id` at `clock` (default now) as a tombstone,
 * preserving the last-known content fingerprint so a later stale-file
 * reappearance can be told apart from a genuine re-add.
 */
export function stampDelete(meta, id, clock = Date.now()) {
  const prevFp = meta[id]?.fp
  meta[id] = prevFp !== undefined
    ? { clock, deleted: true, fp: prevFp }
    : { clock, deleted: true }
  return meta
}

/**
 * Reconcile parsed records against meta after an *external* edit (e.g. the
 * file was changed directly via the desktop server, agent, or OneDrive web).
 * - New ids present in records but absent from meta get a fresh clock.
 * - Ids whose alive record disappeared from the file become tombstones.
 * Mutates and returns meta.
 *
 * Note: this only detects adds and deletes. Prefer `stampLocalChanges`, which
 * also detects in-place content edits via a stored fingerprint.
 */
export function reconcileExternal(records, meta, clock = Date.now()) {
  for (const id of Object.keys(records)) {
    if (!meta[id] || meta[id].deleted) meta[id] = { clock, deleted: false }
  }
  for (const id of Object.keys(meta)) {
    if (!meta[id].deleted && !(id in records)) meta[id] = { clock, deleted: true }
  }
  return meta
}

// Small, stable, non-cryptographic fingerprint (djb2) used to detect whether a
// record's content changed since we last stamped it. Stored in meta as `fp`.
export function fingerprint(content) {
  const s = serialize(content)
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return h
}

/**
 * Detect local changes (adds, edits, deletes) by comparing the current parsed
 * records against the fingerprints stored in meta, and stamp `clock` on
 * anything that changed. Works regardless of whether the edit came from our own
 * UI or an external editor, so it is the single entry point for "the local file
 * changed". Mutates and returns meta.
 *
 * Resurrection guard (#280): a row that is present in the file but tombstoned in
 * meta is NOT blindly re-stamped alive. On a device whose file is stale (e.g.
 * OneDrive delivered an old copy that still contains a row another device
 * deleted), re-stamping it alive with a fresh `now` clock would beat the remote
 * tombstone and resurrect the deleted row — then push it back to everyone. We
 * only revive a tombstoned row when the tombstone recorded the deleted content's
 * fingerprint AND it differs now (a genuine local re-add). An identical
 * reappearance, or a legacy tombstone with no recorded fingerprint, is treated
 * as a stale-file ghost: the tombstone is kept so the merge strips the row.
 * Deletes preserve the last-known fingerprint so this comparison is possible.
 */
export function stampLocalChanges(records, meta, clock = Date.now()) {
  for (const id of Object.keys(records)) {
    const fp = fingerprint(records[id])
    const m = meta[id]
    if (!m) {
      meta[id] = { clock, deleted: false, fp }
      continue
    }
    if (m.deleted) {
      // Only a proven content change (recorded fp differs) counts as a genuine
      // re-add; otherwise honor the tombstone and let the ghost row be dropped.
      if (m.fp !== undefined && m.fp !== fp) {
        meta[id] = { clock, deleted: false, fp }
      }
      continue
    }
    if (m.fp !== fp) {
      meta[id] = { clock, deleted: false, fp }
    }
  }
  for (const id of Object.keys(meta)) {
    if (!meta[id].deleted && !(id in records)) {
      // Tombstone the removed row, keeping its fingerprint so a later stale-file
      // reappearance can be classified (ghost vs genuine re-add) above.
      const prevFp = meta[id].fp
      meta[id] = prevFp !== undefined
        ? { clock, deleted: true, fp: prevFp }
        : { clock, deleted: true }
    }
  }
  return meta
}

/** Drop tombstones older than ttlMs so the sidecar can't grow forever. */
export function gcTombstones(meta, now = Date.now(), ttlMs = 90 * 24 * 60 * 60 * 1000) {
  for (const id of Object.keys(meta)) {
    if (meta[id].deleted && now - (meta[id].clock ?? 0) > ttlMs) delete meta[id]
  }
  return meta
}

// ── Sidecar (de)serialization ──────────────────────────────────────────

/** Serialize per-record meta to the sidecar JSON string stored next to the file. */
export function serializeSidecar(meta, now = Date.now()) {
  return JSON.stringify({ version: SIDECAR_VERSION, updatedAt: now, entries: meta })
}

/** Parse a sidecar JSON string back into a meta object. Tolerant of garbage. */
export function parseSidecar(raw) {
  if (!raw) return {}
  try {
    const obj = JSON.parse(raw)
    return obj && typeof obj === 'object' && obj.entries ? obj.entries : {}
  } catch {
    return {}
  }
}
