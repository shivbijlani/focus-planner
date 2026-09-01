import { describe, expect, it } from 'vitest'

import {
  clearDiagnostics,
  dumpDiagnostics,
  enableDiagnostics,
  resetDiagnosticsForTests,
} from '../../diagnostics/src/index.js'
import {
  mergeCollections,
  stampWrite,
  stampDelete,
  reconcileExternal,
  stampLocalChanges,
  fingerprint,
  gcTombstones,
  serializeSidecar,
  parseSidecar,
  isCollapse,
  findAliveWithoutRecord,
} from './merge.js'

const snap = (records = {}, meta = {}) => ({ records, meta })

describe('mergeCollections — per-record LWW with tombstones', () => {
  it('keeps records added on either side (add/add)', () => {
    const local = snap({ a: 'A' }, { a: { clock: 1, deleted: false } })
    const remote = snap({ b: 'B' }, { b: { clock: 1, deleted: false } })
    const m = mergeCollections(local, remote)
    expect(m.records).toEqual({ a: 'A', b: 'B' })
    expect(m.localChanged).toBe(true)
    expect(m.remoteChanged).toBe(true)
  })

  it('THE BUG: a delete is not resurrected by a stale full-file replica', () => {
    // Mobile deleted row "r2" (tombstone, newer clock).
    const remote = snap(
      { r1: 'one' },
      { r1: { clock: 10, deleted: false }, r2: { clock: 20, deleted: true } },
    )
    // Desktop still holds the old alive r2 (older clock) — the stale tab.
    const local = snap(
      { r1: 'one', r2: 'two' },
      { r1: { clock: 10, deleted: false }, r2: { clock: 5, deleted: false } },
    )
    const m = mergeCollections(local, remote)
    expect(m.records).toEqual({ r1: 'one' })       // r2 stays deleted
    expect(m.meta.r2.deleted).toBe(true)
    expect(m.localChanged).toBe(true)              // desktop must drop r2
    expect(m.remoteChanged).toBe(false)            // remote already correct
  })

  it('THE ONEDRIVE CRASH: an alive sidecar entry with no record must not win as undefined content', () => {
    // A stale/inconsistent sidecar marks "r2" alive (newer clock) but the parsed
    // content has no such record — e.g. a row was removed from the file on the
    // remote without its meta being tombstoned. Previously this produced a
    // "winning" alive record whose content was `undefined`, which then crashed
    // fingerprint()/serialize on `undefined.length` and failed the whole sync
    // ("Cannot read properties of undefined (reading 'length')").
    const remote = snap(
      { r1: 'one' },                                   // r2 has NO content
      { r1: { clock: 10, deleted: false }, r2: { clock: 99, deleted: false } },
    )
    const local = snap(
      { r1: 'one', r2: 'two' },
      { r1: { clock: 10, deleted: false }, r2: { clock: 5, deleted: false } },
    )
    // Must not throw, and must keep local's real r2 content rather than a phantom.
    const m = mergeCollections(local, remote)
    expect(m.records.r1).toBe('one')
    expect(m.records.r2).toBe('two')
    // The fingerprint pass downstream must survive too.
    for (const id of Object.keys(m.records)) {
      expect(() => fingerprint(m.records[id])).not.toThrow()
    }
  })

  it('drops an alive-but-contentless entry from RECORDS, but keeps its META tracked (#190)', () => {
    const remote = snap({}, { ghost: { clock: 99, deleted: false } })
    const local = snap({}, {})
    const m = mergeCollections(local, remote)
    // No phantom record can win (the #46 crash guard) …
    expect('ghost' in m.records).toBe(false)
    // … but the live meta entry must NOT vanish with no tombstone (#190). Before
    // the fix this id evaporated from BOTH records and meta — the silent void
    // that made task #228's row disappear with no sidecar entry at all.
    expect(m.meta.ghost).toEqual({ clock: 99, deleted: false })
  })

  it('intentional re-add after delete wins when newer than the tombstone', () => {
    const remote = snap({}, { r: { clock: 5, deleted: true } })
    const local = snap({ r: 'back' }, { r: { clock: 9, deleted: false } })
    const m = mergeCollections(local, remote)
    expect(m.records).toEqual({ r: 'back' })
    expect(m.meta.r.deleted).toBe(false)
  })

  it('newer edit wins on the same record', () => {
    const local = snap({ r: 'old' }, { r: { clock: 1, deleted: false } })
    const remote = snap({ r: 'new' }, { r: { clock: 2, deleted: false } })
    expect(mergeCollections(local, remote).records).toEqual({ r: 'new' })
  })

  it('delete beats an alive write at equal clock (intentional delete)', () => {
    const local = snap({ r: 'x' }, { r: { clock: 7, deleted: false } })
    const remote = snap({}, { r: { clock: 7, deleted: true } })
    expect(mergeCollections(local, remote).records).toEqual({})
  })

  it('is deterministic & convergent on alive/alive clock ties', () => {
    const local = snap({ r: 'aaa' }, { r: { clock: 3, deleted: false } })
    const remote = snap({ r: 'bbb' }, { r: { clock: 3, deleted: false } })
    const fwd = mergeCollections(local, remote)
    const rev = mergeCollections(remote, local)
    expect(fwd.records).toEqual(rev.records)       // same result regardless of side
    expect(fwd.records).toEqual({ r: 'bbb' })      // content tie-break (lexicographic max)
  })

  it('object records merge and tie-break stably', () => {
    const local = snap({ t1: { task: 'a', pri: 1 } }, { t1: { clock: 2, deleted: false } })
    const remote = snap({ t1: { task: 'a', pri: 9 } }, { t1: { clock: 5, deleted: false } })
    expect(mergeCollections(local, remote).records).toEqual({ t1: { task: 'a', pri: 9 } })
  })

  it('carries a deleted winner fingerprint through the merge', () => {
    const local = snap({ r: 'v' }, { r: { clock: 5, deleted: false, fp: fingerprint('v') } })
    const remote = snap({}, { r: { clock: 9, deleted: true, fp: fingerprint('v') } })
    const m = mergeCollections(local, remote)
    expect(m.meta.r).toEqual({ clock: 9, deleted: true, fp: fingerprint('v') })
  })

  it('reports no change when both sides already agree', () => {
    const a = snap({ r: 'same' }, { r: { clock: 1, deleted: false } })
    const b = snap({ r: 'same' }, { r: { clock: 1, deleted: false } })
    const m = mergeCollections(a, b)
    expect(m.localChanged).toBe(false)
    expect(m.remoteChanged).toBe(false)
  })
})

describe('#280 zero-clock freeze — an implicit sentinel must not become durable state', () => {
  // Live evidence (2026-08-26): 14 alive rows across the two planner sidecars sat
  // at {clock:0, deleted:false, fp:<real>} — 5 of 122 active, 9 of 53 completed —
  // while 0 of 353 tombstones did. merge.js's own rule is that clock 0 "loses to
  // any explicit clock", so those rows were primed to lose every future merge,
  // which is how a completed task double-lists onto both boards.
  it('THE BUG: a remote record with no meta entry is no longer persisted at clock 0', () => {
    // The remote file gained `new` via an external edit (OneDrive web / desktop
    // server / the agent) that never stamped the sidecar. The remote HAS a
    // sidecar; it simply has no entry for that row.
    const local = snap({ a: 'A' }, { a: { clock: 1000, deleted: false } })
    const remote = snap(
      { a: 'A', new: 'added externally' },
      { a: { clock: 1000, deleted: false } },
    )
    const m = mergeCollections(local, remote, { now: 5000 })
    expect(m.records.new).toBe('added externally')
    expect(m.meta.new).toEqual({ clock: 5000, deleted: false })
    // Rows that already had meta are untouched — this is why production showed a
    // subset (5 of 122) rather than every row.
    expect(m.meta.a).toEqual({ clock: 1000, deleted: false })
  })

  it('the sentinel still loses ties inside the merge it was created for', () => {
    // Normalization happens when persisting the winner, after the comparison, so
    // it cannot change who wins. The unmetaed side must still lose.
    const local = snap({ r: 'stale-unmetaed' }, {})
    const remote = snap({ r: 'real write' }, { r: { clock: 7, deleted: false } })
    const m = mergeCollections(local, remote, { now: 5000 })
    expect(m.records.r).toBe('real write')
    expect(m.meta.r).toEqual({ clock: 7, deleted: false })
  })

  it('a tombstone is never strengthened — clock 0 deletes keep their clock', () => {
    // Narrow by design: touching tombstones could turn a legacy clock-0 delete
    // into something that outranks a real write, i.e. a resurrection.
    const local = snap({}, { d: { clock: 0, deleted: true } })
    const remote = snap({}, {})
    const m = mergeCollections(local, remote, { now: 5000 })
    expect(m.meta.d).toEqual({ clock: 0, deleted: true })
  })

  it('an EXPLICITLY stamped clock 0 is left weak (records.js sidecar-less remote)', () => {
    // records.js stamps a sidecar-less remote at 0 on purpose, "so a real local
    // edit wins ties". That deliberate signal must survive; only the implicit
    // no-meta sentinel is normalized.
    const local = snap({}, {})
    const remote = snap({ r: 'legacy backup' }, { r: { clock: 0, deleted: false, fp: fingerprint('legacy backup') } })
    const m = mergeCollections(local, remote, { now: 5000 })
    expect(m.records.r).toBe('legacy backup')
    expect(m.meta.r.clock).toBe(0)
  })

  it('a normalized row can no longer be beaten by a stale replica', () => {
    // This is the whole point. Before the fix the row sat at 0 and ANY explicit
    // clock outranked it; now it survives a stale side that predates it.
    const frozen = snap({ r: 'v' }, { r: { clock: 0, deleted: false } })
    const stale = snap({}, { r: { clock: 1, deleted: true } })
    expect('r' in mergeCollections(frozen, stale, { now: 5000 }).records).toBe(false)

    const repaired = snap({ r: 'v' }, { r: { clock: 5000, deleted: false } })
    expect(mergeCollections(repaired, stale, { now: 6000 }).records.r).toBe('v')
  })

  it('is still symmetric and convergent when both sides are unmetaed', () => {
    const local = snap({ r: 'aaa' }, {})
    const remote = snap({ r: 'bbb' }, {})
    const fwd = mergeCollections(local, remote, { now: 5000 })
    const rev = mergeCollections(remote, local, { now: 5000 })
    expect(fwd.records).toEqual(rev.records)
    expect(fwd.meta).toEqual(rev.meta)
    expect(fwd.meta.r).toEqual({ clock: 5000, deleted: false })
  })

  it('opts.normalizeZeroClock:false restores the previous behaviour', () => {
    const local = snap({ a: 'A' }, { a: { clock: 1, deleted: false } })
    const remote = snap({ a: 'A', new: 'x' }, { a: { clock: 1, deleted: false } })
    const m = mergeCollections(local, remote, { now: 5000, normalizeZeroClock: false })
    expect(m.meta.new).toEqual({ clock: 0, deleted: false })
  })
})

describe('stamp helpers', () => {
  it('stampWrite / stampDelete set clock + flag', () => {
    const meta = {}
    stampWrite(meta, 'a', 100)
    expect(meta.a).toEqual({ clock: 100, deleted: false })
    stampDelete(meta, 'a', 200)
    expect(meta.a).toEqual({ clock: 200, deleted: true })
  })
})

describe('reconcileExternal — external/raw file edits become record ops', () => {
  it('stamps newly added rows and tombstones removed rows', () => {
    const meta = { keep: { clock: 1, deleted: false }, gone: { clock: 1, deleted: false } }
    const records = { keep: 'k', added: 'n' } // "gone" removed in the file, "added" is new
    reconcileExternal(records, meta, 500)
    expect(meta.added).toEqual({ clock: 500, deleted: false })
    expect(meta.gone).toEqual({ clock: 500, deleted: true })
    expect(meta.keep).toEqual({ clock: 1, deleted: false })
  })

  it('re-adding an externally tombstoned id revives it', () => {
    const meta = { r: { clock: 1, deleted: true } }
    reconcileExternal({ r: 'v' }, meta, 9)
    expect(meta.r).toEqual({ clock: 9, deleted: false })
  })
})

describe('stampLocalChanges — detect adds/edits/deletes via fingerprint', () => {
  it('stamps new and edited records, tombstones removed ones, ignores unchanged', () => {
    const meta = {}
    stampLocalChanges({ a: 'A', b: 'B' }, meta, 100)
    expect(meta.a.clock).toBe(100)
    expect(meta.b.clock).toBe(100)

    // Re-run unchanged at a later clock: nothing should be re-stamped.
    stampLocalChanges({ a: 'A', b: 'B' }, meta, 200)
    expect(meta.a.clock).toBe(100)
    expect(meta.b.clock).toBe(100)

    // Edit a, delete b at t=300.
    stampLocalChanges({ a: 'A2' }, meta, 300)
    expect(meta.a.clock).toBe(300)
    expect(meta.b.clock).toBe(300)
    expect(meta.b.deleted).toBe(true)
  })

  it('does NOT resurrect a tombstoned row that reappears in a stale file (ghost)', () => {
    // Another device deleted "r"; this device's file is stale and still holds it.
    const meta = { r: { clock: 100, deleted: true, fp: fingerprint('two') } }
    stampLocalChanges({ r: 'two' }, meta, 999)
    // Tombstone survives untouched — no fresh clock that would beat the remote.
    expect(meta.r).toEqual({ clock: 100, deleted: true, fp: fingerprint('two') })
  })

  it('does NOT resurrect under a legacy tombstone with no recorded fingerprint', () => {
    const meta = { r: { clock: 100, deleted: true } }
    stampLocalChanges({ r: 'two' }, meta, 999)
    expect(meta.r).toEqual({ clock: 100, deleted: true })
  })

  it('DOES revive a tombstoned row when its content genuinely changed', () => {
    const meta = { r: { clock: 100, deleted: true, fp: fingerprint('old') } }
    stampLocalChanges({ r: 'new' }, meta, 999)
    expect(meta.r).toEqual({ clock: 999, deleted: false, fp: fingerprint('new') })
  })

  it('tombstones preserve the deleted row fingerprint for later classification', () => {
    const meta = {}
    stampLocalChanges({ r: 'v' }, meta, 100)
    expect(meta.r).toEqual({ clock: 100, deleted: false, fp: fingerprint('v') })
    // Row removed from the file → tombstoned, but keeps its fingerprint.
    stampLocalChanges({}, meta, 200)
    expect(meta.r).toEqual({ clock: 200, deleted: true, fp: fingerprint('v') })
  })

  it('fingerprint is stable and content-sensitive', () => {
    expect(fingerprint('x')).toBe(fingerprint('x'))
    expect(fingerprint('x')).not.toBe(fingerprint('y'))
  })
})

describe('#371 collapse guard — an empty record set must not wipe the board', () => {
  const aliveMeta = () => ({
    a: { clock: 100, deleted: false, fp: fingerprint('A') },
    b: { clock: 100, deleted: false, fp: fingerprint('B') },
    c: { clock: 100, deleted: false, fp: fingerprint('C') },
  })

  it('isCollapse: empty records + 2+ alive rows is a collapse', () => {
    expect(isCollapse({}, aliveMeta())).toBe(true)
    // Non-empty records is never a collapse.
    expect(isCollapse({ a: 'A' }, aliveMeta())).toBe(false)
    // A single alive row deleting to empty is an ordinary edit, not a collapse.
    expect(isCollapse({}, { a: { clock: 1, deleted: false } })).toBe(false)
    // Only tombstones alive → nothing to protect.
    expect(isCollapse({}, { a: { clock: 1, deleted: true } })).toBe(false)
  })

  it('stampLocalChanges does NOT tombstone all rows when records collapse to empty', () => {
    const meta = aliveMeta()
    stampLocalChanges({}, meta, 1784733503532)
    // Every row stays alive at its original clock — the wipe is refused.
    expect(meta.a.deleted).toBe(false)
    expect(meta.b.deleted).toBe(false)
    expect(meta.c.deleted).toBe(false)
    expect(meta.a.clock).toBe(100)
  })

  it('reconcileExternal does NOT tombstone all rows when records collapse to empty', () => {
    const meta = aliveMeta()
    reconcileExternal({}, meta, 1784733503532)
    expect(meta.a.deleted).toBe(false)
    expect(meta.b.deleted).toBe(false)
    expect(meta.c.deleted).toBe(false)
  })

  it('the guard is opt-out so a genuine full clear can still be stamped', () => {
    const meta = aliveMeta()
    stampLocalChanges({}, meta, 300, { guardCollapse: false })
    expect(meta.a.deleted).toBe(true)
    expect(meta.b.deleted).toBe(true)
    expect(meta.c.deleted).toBe(true)
  })

  it('still tombstones a normal single-row removal (not a collapse)', () => {
    const meta = { a: { clock: 100, deleted: false, fp: fingerprint('A') } }
    stampLocalChanges({}, meta, 300)
    expect(meta.a).toEqual({ clock: 300, deleted: true, fp: fingerprint('A') })
  })

  it('still tombstones the one row that was actually removed from a multi-row board', () => {
    const meta = aliveMeta()
    // b and c remain; only a was removed → records is non-empty, so no collapse.
    stampLocalChanges({ b: 'B', c: 'C' }, meta, 300)
    expect(meta.a.deleted).toBe(true)
    expect(meta.b.deleted).toBe(false)
    expect(meta.c.deleted).toBe(false)
  })
})

describe('gcTombstones', () => {
  it('drops only tombstones older than the TTL', () => {
    const meta = {
      old: { clock: 0, deleted: true },
      fresh: { clock: 1_000, deleted: true },
      alive: { clock: 0, deleted: false },
    }
    gcTombstones(meta, 2_000, 1_500)
    expect(meta.old).toBeUndefined()
    expect(meta.fresh).toBeDefined()
    expect(meta.alive).toBeDefined()
  })
})
describe('sidecar (de)serialization', () => {
  it('round-trips meta', () => {
    const meta = { a: { clock: 1, deleted: false }, b: { clock: 2, deleted: true } }
    expect(parseSidecar(serializeSidecar(meta))).toEqual(meta)
  })
  it('parseSidecar tolerates garbage and empties', () => {
    expect(parseSidecar('')).toEqual({})
    expect(parseSidecar('not json')).toEqual({})
    expect(parseSidecar('{}')).toEqual({})
  })
})

describe('#190 — a live meta entry must never be dropped with no tombstone (the silent void)', () => {
  // Root cause, reproduced. When a row is ALIVE in the sidecar meta but its parsed
  // record is missing on BOTH sides — the shape a stale/empty parse or a #171
  // parser-rejected id cell leaves — sideEntry collapses each side to present:false
  // so a content-less row can never win and crash fingerprint() (#46). pickWinner
  // then returns not-present and the merge loop used to `continue`, erasing the id
  // from BOTH records AND meta with no tombstone. That is exactly #228: "no sidecar
  // entry at all, in either board's sidecar," the row gone and the journal
  // unreachable. Each test below pins one facet of the fix; each is proven
  // load-bearing by exactly one arm of mutcheck-meta-nodrop.mjs.
  const bothPhantom = () => mergeCollections(
    { records: {}, meta: { '228': { clock: 1000, deleted: false } } },
    { records: {}, meta: { '228': { clock: 1000, deleted: false } } },
    { now: 5000 },
  )

  it('stays-alive: the preserved entry is ALIVE, never silently turned into a tombstone', () => {
    // ARM alive-flag (`deleted: false` -> `deleted: true`).
    const m = bothPhantom()
    expect(m.meta['228']).toBeDefined()
    expect(m.meta['228'].deleted).toBe(false)
  })

  it('single-sided: a one-sided alive phantom (the #228 cross-device shape) is preserved, not voided', () => {
    // Device A's sidecar still marks 228 alive; device B never had it; neither has
    // the record. This is the exact two-replica shape #228 took. Reverting the OR
    // guard to AND reintroduces the silent void HERE and only here.
    // ARM require-both (`||` -> `&&`).
    const m = mergeCollections(
      { records: {}, meta: { '228': { clock: 7, deleted: false } } },
      { records: {}, meta: {} },
      { now: 5000 },
    )
    expect('228' in m.meta).toBe(true)
    expect(m.meta['228'].deleted).toBe(false)
  })

  it('max-clock: the preserved clock is the highest known alive clock, symmetrically', () => {
    // ARM clock-min (`Math.max` -> `Math.min`). Order-independent by construction.
    const fwd = mergeCollections(
      { records: {}, meta: { r: { clock: 7, deleted: false } } },
      { records: {}, meta: { r: { clock: 3, deleted: false } } },
      { now: 5000 },
    )
    const rev = mergeCollections(
      { records: {}, meta: { r: { clock: 3, deleted: false } } },
      { records: {}, meta: { r: { clock: 7, deleted: false } } },
      { now: 5000 },
    )
    expect(fwd.meta.r.clock).toBe(7)
    expect(rev.meta.r.clock).toBe(7)
  })

  it('no-record: preserving the meta must NOT emit a record (the #46 fingerprint crash guard still holds)', () => {
    // ARM emit-record (also writing `mergedRecords[id] = winner.content`, which is
    // undefined for a not-present winner — the exact content-less row #46 crashed on).
    const m = bothPhantom()
    expect('228' in m.records).toBe(false)
    for (const id of Object.keys(m.records)) {
      expect(() => fingerprint(m.records[id])).not.toThrow()
    }
  })

  it('diag: preserving a phantom emits a logged anomaly, never a silent no-op', () => {
    // ARM diag-event (wrong event name / removed). Diagnostics off elsewhere, so the
    // buffer is otherwise empty.
    resetDiagnosticsForTests()
    clearDiagnostics()
    enableDiagnostics({ persist: false })
    bothPhantom()
    const events = dumpDiagnostics().filter((e) => e.event === 'phantom-meta-preserved')
    resetDiagnosticsForTests()
    expect(events.length).toBeGreaterThan(0)
    expect(events[0].fields.id).toBe('228')
  })

  it('a genuine tombstone on one side still wins — preservation never resurrects a delete', () => {
    // The fix must not fire when a real tombstone should win: the newer delete
    // beats the stale alive-but-recordless side, exactly as before.
    const m = mergeCollections(
      { records: {}, meta: { '9': { clock: 5, deleted: false } } },
      { records: {}, meta: { '9': { clock: 20, deleted: true } } },
      { now: 5000 },
    )
    expect(m.meta['9'].deleted).toBe(true)
    expect('9' in m.records).toBe(false)
  })
})

describe('findAliveWithoutRecord — the in-app inconsistency detector (#190)', () => {
  it('flags an id that meta marks alive but which has no record (the #228 residue)', () => {
    expect(findAliveWithoutRecord({}, { '228': { clock: 1, deleted: false } })).toEqual(['228'])
  })

  it('ignores a tombstone with no record (a deliberate, correct steady state)', () => {
    expect(findAliveWithoutRecord({}, { d: { clock: 1, deleted: true } })).toEqual([])
  })

  it('ignores an alive record that has a matching meta entry', () => {
    expect(findAliveWithoutRecord({ a: 'A' }, { a: { clock: 1, deleted: false } })).toEqual([])
  })

  it('ignores a legacy record with no meta (stampLocalChanges stamps it — not an inconsistency)', () => {
    expect(findAliveWithoutRecord({ a: 'A' }, {})).toEqual([])
  })
})
