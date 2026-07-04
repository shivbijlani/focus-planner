import { describe, expect, it } from 'vitest'

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

  it('drops an alive-but-contentless entry when neither side has the record', () => {
    const remote = snap({}, { ghost: { clock: 99, deleted: false } })
    const local = snap({}, {})
    const m = mergeCollections(local, remote)
    expect('ghost' in m.records).toBe(false)
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
