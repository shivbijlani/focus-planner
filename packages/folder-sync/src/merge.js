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
//
// That fallback 0 is an *implicit* sentinel meaning "we have no record of when
// this was written", and it is only meant to lose ties **during one merge**. It
// must never be frozen into the sidecar as the row's durable clock — see
// `normalizeZeroClock` on mergeCollections. An *explicit* `{clock: 0}` in meta
// is a different thing: a deliberate "this side is weak" stamp (records.js does
// this for a remote that has content but no sidecar yet), and is preserved.

import { diag, isDiagEnabled } from '../../diagnostics/src/index.js'

const SIDECAR_VERSION = 1

// #371 collapse guard: the minimum number of alive meta rows that must be about
// to be tombstoned in one pass — while the parsed record set is empty — for us
// to treat it as a failed/empty load rather than a genuine full-board delete.
const COLLAPSE_MIN_ALIVE = 2

/**
 * A "collapse" is the signature of a failed or empty load, NOT a user clearing
 * their board: the parsed `records` came back empty while `meta` still holds
 * COLLAPSE_MIN_ALIVE+ alive rows. This is exactly what the #113 IndexedDB switch
 * triggered — a device read an empty store (`records = {}`), and the delete
 * loops below then stamped every alive row deleted at one fresh clock, making
 * the empty state win the last-write-wins merge and wipe the board on every
 * device (#371). A real person deleting their whole board to zero is vanishingly
 * rare next to a load failure, and is trivially recoverable, so we bias hard
 * toward preserving data: when a collapse is detected, callers skip the
 * delete-stamping pass and leave the alive rows intact.
 *
 * A single-row delete-to-empty (alive count 1) is left unguarded so ordinary
 * "removed my last row" edits still tombstone normally.
 */
export function isCollapse(records, meta, minAlive = COLLAPSE_MIN_ALIVE) {
  if (Object.keys(records).length > 0) return false
  let alive = 0
  for (const id of Object.keys(meta)) {
    if (!meta[id].deleted && ++alive >= minAlive) return true
  }
  return false
}

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
  // `implicitClock` marks this 0 as a *derived* sentinel rather than a value
  // anyone actually stamped, so mergeCollections can avoid persisting it.
  return { present: true, clock: 0, implicitClock: true, deleted: false, content: snapshot.records[id] }
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

function summarizeEntry(entry) {
  if (!entry.present) return { present: false }
  const out = {
    present: true,
    clock: entry.clock ?? 0,
    deleted: !!entry.deleted,
  }
  const fp = entry.fp ?? (!entry.deleted && entry.content !== undefined ? fingerprint(entry.content) : undefined)
  if (fp !== undefined) out.fp = fp
  return out
}

function mergeDecisionReason(a, b) {
  if (!a.present) return 'remote-only'
  if (!b.present) return 'local-only'
  if (a.clock !== b.clock) return 'last-write-wins'
  if (a.deleted !== b.deleted) return 'delete-beats-live'
  if (a.deleted && b.deleted) return 'matching-tombstones'
  const sa = serialize(a.content)
  const sb = serialize(b.content)
  return sa === sb ? 'same-content' : 'content-tiebreak'
}

function logMergeDecision(id, localEntry, remoteEntry, winner) {
  if (!isDiagEnabled()) return
  const winnerSide = winner === localEntry ? 'local' : 'remote'
  const droppedSide = localEntry.present && remoteEntry.present
    ? (winnerSide === 'local' ? 'remote' : 'local')
    : null
  const reason = mergeDecisionReason(localEntry, remoteEntry)
  // Identical rows/tombstones are the overwhelmingly common case. The
  // collection summary records their count; reserve per-record events for
  // decisions that actually explain a conflict or change.
  if (reason === 'same-content' || reason === 'matching-tombstones') return
  diag('folder-sync.merge', 'record-decision', {
    id,
    reason,
    winner: winner.present ? winnerSide : null,
    dropped: droppedSide,
    droppedOnLww: reason === 'last-write-wins' ? droppedSide : null,
    local: summarizeEntry(localEntry),
    remote: summarizeEntry(remoteEntry),
  })
}

/**
 * Merge two collection snapshots with per-record LWW + tombstones.
 *
 * @param {object} local  - { records, meta }
 * @param {object} remote - { records, meta }
 * @param {object} [opts]
 * @param {number} [opts.now] - clock used when normalizing an implicit zero (see below).
 * @param {boolean} [opts.normalizeZeroClock=true] - set false to restore the pre-fix
 *   behaviour of persisting the winner's clock verbatim.
 * @returns {{ records, meta, localChanged, remoteChanged }}
 *   merged snapshot plus flags indicating whether the local store and/or the
 *   remote need to be rewritten with the merged result.
 */
export function mergeCollections(local = {}, remote = {}, opts = {}) {
  const { now = Date.now(), normalizeZeroClock = true } = opts
  const localSnap = { records: local.records ?? {}, meta: local.meta ?? {} }
  const remoteSnap = { records: remote.records ?? {}, meta: remote.meta ?? {} }

  const ids = new Set([
    ...Object.keys(localSnap.records), ...Object.keys(localSnap.meta),
    ...Object.keys(remoteSnap.records), ...Object.keys(remoteSnap.meta),
  ])

  const mergedRecords = {}
  const mergedMeta = {}

  for (const id of ids) {
    const localEntry = sideEntry(localSnap, id)
    const remoteEntry = sideEntry(remoteSnap, id)
    const winner = pickWinner(localEntry, remoteEntry)
    logMergeDecision(id, localEntry, remoteEntry, winner)
    if (!winner.present) {
      // #190: both sides resolved to "not present". For an id that a side's meta
      // still marks ALIVE, that only happens through sideEntry's phantom guard —
      // an alive meta row whose parsed record is missing returns present:false so
      // a content-less row can never win and crash fingerprint() (the #46 OneDrive
      // crash). But dropping the id here erased the *meta* too, with NO tombstone:
      // the merged sidecar (written to both replicas) ended up with no entry at
      // all. That is the silent void behind #190 — task #228's row vanished from
      // the board with "no sidecar entry at all, in either board's sidecar," and
      // its still-live journal became unreachable. A live meta entry that loses
      // its record must never become a no-op; it is either a deliberate delete
      // (tombstone) or a suspected anomaly — here, the latter. Keep it ALIVE at
      // the highest known clock (deterministic/symmetric via Math.max) but emit
      // NO record, so the crash guard still holds while the row stays TRACKED:
      // the next honest reconcile either reunites it with its parsed record or
      // tombstones it deliberately (stampLocalChanges), and the detector below
      // (findAliveWithoutRecord) can surface it in the meantime. Also log it.
      const lm = localSnap.meta[id]
      const rm = remoteSnap.meta[id]
      const localAliveClock = lm && !lm.deleted ? (lm.clock ?? 0) : null
      const remoteAliveClock = rm && !rm.deleted ? (rm.clock ?? 0) : null
      if (localAliveClock !== null || remoteAliveClock !== null) {
        const clock = Math.max(localAliveClock ?? 0, remoteAliveClock ?? 0)
        mergedMeta[id] = { clock, deleted: false }
        if (isDiagEnabled()) {
          diag('folder-sync.merge', 'phantom-meta-preserved', {
            id,
            clock,
            local: summarizeEntry(localEntry),
            remote: summarizeEntry(remoteEntry),
          })
        }
      }
      continue
    }
    if (winner.deleted) {
      mergedMeta[id] = winner.fp !== undefined
        ? { clock: winner.clock, deleted: true, fp: winner.fp }
        : { clock: winner.clock, deleted: true }
    } else {
      // Zero-clock freeze (#280): `sideEntry` hands an unmetaed record an
      // implicit clock 0 meaning "we have no record of when this was written",
      // purely so it loses ties in THIS merge. Persisting that sentinel made it
      // the row's permanent clock, and merge.js's own rule is that clock 0
      // "loses to any explicit clock" — so the row was primed to lose every
      // future merge and get dropped or double-listed by any stale replica.
      // Measured on the live boards 2026-08-26: 14 alive rows stuck at clock 0
      // (5 of 122 active, 9 of 53 completed) and 0 of 353 tombstones — exactly
      // the alive-only shape this branch produces.
      //
      // The comparison above has already happened, so giving the winner a real
      // clock here cannot change THIS merge's outcome; it only stops the
      // sentinel becoming durable state. Deliberately narrow:
      //   - alive winners only — tombstones keep their clock, so a legacy
      //     clock-0 tombstone can never be strengthened into a resurrection;
      //   - *implicit* zeros only — an explicitly stamped `{clock: 0}` (what
      //     records.js writes for a remote that has content but no sidecar) is a
      //     deliberate "this side is weak" signal and is left alone.
      // This also just restores symmetry: the local side never reaches here,
      // because stampLocalChanges already gives unmetaed local records `now`.
      const clock = normalizeZeroClock && winner.implicitClock && winner.clock === 0
        ? now
        : winner.clock
      mergedMeta[id] = { clock, deleted: false }
      mergedRecords[id] = winner.content
    }
  }

  const result = {
    records: mergedRecords,
    meta: mergedMeta,
    localChanged: !snapshotEqual(localSnap, { records: mergedRecords, meta: mergedMeta }),
    remoteChanged: !snapshotEqual(remoteSnap, { records: mergedRecords, meta: mergedMeta }),
  }
  if (isDiagEnabled()) {
    diag('folder-sync.merge', 'collections-merged', {
      ids: ids.size,
      records: Object.keys(result.records).length,
      tombstones: Object.values(result.meta).filter((m) => m?.deleted).length,
      localChanged: result.localChanged,
      remoteChanged: result.remoteChanged,
    })
  }
  return result
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
export function reconcileExternal(records, meta, clock = Date.now(), opts = {}) {
  for (const id of Object.keys(records)) {
    if (!meta[id] || meta[id].deleted) meta[id] = { clock, deleted: false }
  }
  // #371: don't tombstone everything when the record set collapsed to empty —
  // that's a failed/empty load, not a full-board delete. Preserve the alive rows.
  if (opts.guardCollapse !== false && isCollapse(records, meta)) return meta
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
export function stampLocalChanges(records, meta, clock = Date.now(), opts = {}) {
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
  // #371: when the parsed records collapsed to empty while meta still holds many
  // alive rows, this is a load failure (e.g. empty IndexedDB after the #113
  // migration), not the user deleting their whole board. Skip the delete pass so
  // we don't tombstone the entire board and lose it across every device.
  if (opts.guardCollapse !== false && isCollapse(records, meta)) return meta
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

/**
 * #190 in-app detector (records/sidecar layer). Return the ids that the sidecar
 * `meta` marks ALIVE (present, not deleted) but which have no matching parsed
 * record. This is the residue #190 leaves behind: a row tracked as live with no
 * row on the board and no tombstone — the exact "invisible but being worked"
 * state that only an external sweep noticed. It is cheap to compute wherever the
 * app already holds a board's records + meta (e.g. after a reconcile/merge), so
 * the app can surface the inconsistency itself instead of waiting for a sweep.
 *
 * Deliberately narrow: only alive-without-record is reported. A tombstone
 * (deleted:true) with no record is the correct, deliberate steady state, and a
 * record with no meta is a legacy/external write that stampLocalChanges stamps —
 * neither is an inconsistency.
 *
 * @returns {string[]} ids alive in meta but absent from records
 */
export function findAliveWithoutRecord(records = {}, meta = {}) {
  const out = []
  for (const id of Object.keys(meta)) {
    const m = meta[id]
    if (m && !m.deleted && !Object.prototype.hasOwnProperty.call(records, id)) out.push(id)
  }
  return out
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
