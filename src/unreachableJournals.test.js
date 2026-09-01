import { describe, expect, it } from 'vitest'
import { findUnreachableLiveJournals } from './unreachableJournals.js'

describe('findUnreachableLiveJournals — #190 in-app detection', () => {
  it('THE #228 CASE: a non-terminal journal with no row and no tombstone is flagged', () => {
    const out = findUnreachableLiveJournals({
      journals: [{ id: 228, terminal: false }],
      boardIds: [1, 2, 3],
      tombstoned: [17, 42],
    })
    expect(out).toEqual(['228'])
  })

  it('is silent when the journal has a row on a board (reachable)', () => {
    expect(findUnreachableLiveJournals({
      journals: [{ id: 228, terminal: false }],
      boardIds: [228],
      tombstoned: [],
    })).toEqual([])
  })

  it('is silent when the journal was deliberately deleted (tombstoned)', () => {
    // The 27 correctly-retired journals the sweep found — a tombstone means the
    // delete was intentional, not an anomaly.
    expect(findUnreachableLiveJournals({
      journals: [{ id: 228, terminal: false }],
      boardIds: [],
      tombstoned: [228],
    })).toEqual([])
  })

  it('is silent when the journal is terminal (finished tasks legitimately leave the board)', () => {
    expect(findUnreachableLiveJournals({
      journals: [{ id: 228, terminal: true }],
      boardIds: [],
      tombstoned: [],
    })).toEqual([])
  })

  it('matches ids across string/number types', () => {
    expect(findUnreachableLiveJournals({
      journals: [{ id: '228', terminal: false }],
      boardIds: ['1'],
      tombstoned: [],
    })).toEqual(['228'])
    expect(findUnreachableLiveJournals({
      journals: [{ id: 228, terminal: false }],
      boardIds: ['228'], // string board id must still count as reachable
      tombstoned: [],
    })).toEqual([])
  })

  it('reports several unreachable live journals in supplied order, de-duplicated', () => {
    const out = findUnreachableLiveJournals({
      journals: [
        { id: 300, terminal: false },
        { id: 228, terminal: false },
        { id: 228, terminal: false }, // duplicate id
        { id: 5, terminal: true },     // terminal → excluded
      ],
      boardIds: [],
      tombstoned: [],
    })
    expect(out).toEqual(['300', '228'])
  })

  it('tolerates empty / missing inputs', () => {
    expect(findUnreachableLiveJournals()).toEqual([])
    expect(findUnreachableLiveJournals({})).toEqual([])
    expect(findUnreachableLiveJournals({ journals: [null, { terminal: false }] })).toEqual([])
  })
})
