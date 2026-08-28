import { describe, it, expect } from 'vitest'
import { parseDeletedTaskIds } from './deleted.js'

// The live shape, trimmed. `entries` is keyed by task id; `deleted: true` is the
// tombstone the planner app writes when the user deletes a row in the UI.
const LIVE = JSON.stringify({
  version: 1,
  updatedAt: 1787621820553,
  entries: {
    434: { clock: 1787621820553, deleted: true, fp: -1454295489 },
    462: { clock: 1787000000000, deleted: false, fp: 1234567890 },
    357: { clock: 1787000000001, fp: 42 },
  },
})

describe('parseDeletedTaskIds', () => {
  it('returns only the tombstoned ids', () => {
    expect(parseDeletedTaskIds(LIVE)).toEqual(['434'])
  })

  it('ignores deleted:false and records with no deleted flag', () => {
    const ids = parseDeletedTaskIds(LIVE)
    expect(ids).not.toContain('462')
    expect(ids).not.toContain('357')
  })

  it('requires deleted to be strictly true, not merely truthy', () => {
    // A malformed value must never be a licence to close a topic the user can
    // still see on his board.
    const json = JSON.stringify({
      entries: {
        1: { deleted: 'yes' },
        2: { deleted: 1 },
        3: { deleted: {} },
        4: { deleted: true },
      },
    })
    expect(parseDeletedTaskIds(json)).toEqual(['4'])
  })

  it('dedupes ids', () => {
    // NOTE: order is deliberately not asserted. These are integer-like object
    // keys, and JS iterates those in ascending NUMERIC order regardless of the
    // order they appear in the file — so "first-seen order" is not a property
    // this function can offer. It does not matter: the only caller builds a Set.
    const json = JSON.stringify({
      entries: { 30: { deleted: true }, 10: { deleted: true }, 20: { deleted: true } },
    })
    expect(parseDeletedTaskIds(json).sort()).toEqual(['10', '20', '30'])
  })

  it('returns each id once even if the same id appears in both records', () => {
    const a = parseDeletedTaskIds(JSON.stringify({ entries: { 42: { deleted: true } } }))
    const b = parseDeletedTaskIds(JSON.stringify({ entries: { 42: { deleted: true } } }))
    expect(new Set([...a, ...b]).size).toBe(1)
  })

  it('skips non-numeric ids', () => {
    const json = JSON.stringify({
      entries: { abc: { deleted: true }, '12x': { deleted: true }, 12: { deleted: true } },
    })
    expect(parseDeletedTaskIds(json)).toEqual(['12'])
  })

  it('never throws, and never reports deletions, on junk input', () => {
    // A half-written sync file must not take the bridge down, and must REALLY
    // not read as "everything is deleted".
    expect(parseDeletedTaskIds('')).toEqual([])
    expect(parseDeletedTaskIds(null)).toEqual([])
    expect(parseDeletedTaskIds(undefined)).toEqual([])
    expect(parseDeletedTaskIds('{"entries":{"434":{"deleted":tr')).toEqual([])
    expect(parseDeletedTaskIds('not json at all')).toEqual([])
    expect(parseDeletedTaskIds('[]')).toEqual([])
    expect(parseDeletedTaskIds('{}')).toEqual([])
    expect(parseDeletedTaskIds('{"entries":null}')).toEqual([])
    expect(parseDeletedTaskIds('{"entries":"nope"}')).toEqual([])
  })

  it('tolerates null entry records', () => {
    const json = JSON.stringify({ entries: { 5: null, 6: { deleted: true } } })
    expect(parseDeletedTaskIds(json)).toEqual(['6'])
  })
})
