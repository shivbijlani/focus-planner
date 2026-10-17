import { describe, expect, it } from 'vitest'

import { computeMoveSet, computeBrokenLinks } from '@shivbijlani/planner-shared-core'
import * as shared from '@shivbijlani/planner-shared-core'
import * as sorting from './taskSort.js'

const baseVectors = [
  ['V1', '5', {}, { '5': '10' }, ['1', '5', '10'], ['5']],
  ['V2', '3', { '3': 1 }, { '1': '2', '2': '3' }, ['1', '2', '3', '4'], ['3', '1', '2']],
  ['V3', '2', { '2': 1, '4': 2 }, { '1': '2', '3': '4' }, ['1', '2', '3', '4'], ['2', '1']],
  ['V4', null, {}, {}, [], []],
  ['V5', '30', { '30': 1 }, { '10': '20', '20': '10', '40': '30', '50': '30' }, ['10', '20', '30', '40'], ['30', '40']],
  ['V6', '030', Object.freeze({ '030': 1 }),
    Object.freeze({ '010': '020', '020': '030' }),
    Object.freeze({ '010': 'First', '020': 'Second', '030': 'Priority' }), ['030', '010', '020']],
]

describe('computeMoveSet', () => {
  describe.each(baseVectors)('%s', (_, root, priorities, links, activeIds, expected) => {
    it('preserves root-first order with omitted, undefined, or empty aliases', () => {
      const before = JSON.stringify([priorities, links, activeIds])
      for (const result of [
        computeMoveSet(root, priorities, links, activeIds),
        computeMoveSet(root, priorities, links, activeIds, undefined),
        computeMoveSet(root, priorities, links, activeIds, {}),
      ]) {
        expect(result).toBeInstanceOf(Set)
        expect([...result]).toEqual(expected)
      }
      expect(JSON.stringify([priorities, links, activeIds])).toBe(before)
    })
  })

  it.each([
    ['V7 without aliases', {}, { '30': 1 }, ['30']],
    ['V7', { '900': '30' }, { '30': 1 }, ['30', '10']],
    ['V8', { '900': '800', '800': '30' }, { '30': 1 }, ['30']],
    ['V9', { '900': '30' }, { '30': 1, '900': 2 }, ['30']],
    ['V10', { '900': '77' }, { '30': 1 }, ['30']],
  ])('%s respects resolver alias semantics', (_, aliases, priorities, expected) => {
    const activeIds = Object.hasOwn(priorities, '900') ? ['10', '30', '900'] : ['10', '30']
    expect([...computeMoveSet('30', priorities, { '10': '900' }, activeIds, aliases)]).toEqual(expected)
  })

  it('handles empty and undefined roots and keeps a root absent from active IDs', () => {
    expect([...computeMoveSet('', {}, {}, [])]).toEqual([])
    expect([...computeMoveSet(undefined, {}, {}, [])]).toEqual([])
    expect([...computeMoveSet('30', { '30': 1 }, { '10': '30' }, ['10'])]).toEqual(['30', '10'])
  })

  it('compares exact string IDs and deduplicates without changing input order', () => {
    expect([...computeMoveSet('030', { '030': 1 }, { '010': '030', '10': '30' },
      ['010', '10', '030', '010'])]).toEqual(['030', '010'])
  })

  it('excludes unresolved chains at the sorting resolver default depth cap', () => {
    const links = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [String(i), String(i + 1)]))
    expect([...computeMoveSet('20', { '20': 1 }, links, ['0', '1', '20'])]).toEqual(['20', '1'])
  })

  it('follows links rather than chaining aliases', () => {
    expect([...computeMoveSet('30', { '30': 1 }, { '10': '900', '900': '30' },
      ['10', '30'], { '900': '800', '800': '30' })]).toEqual(['30', '10'])
  })

  it.each(['array', 'object'])('does not mutate frozen alias inputs with %s active IDs', shape => {
    const priorities = Object.freeze({ '030': 1 })
    const links = Object.freeze({ '010': '900', '020': '010' })
    const aliases = Object.freeze({ '900': '030' })
    const activeIds = Object.freeze(shape === 'array'
      ? ['020', '010', '030']
      : { '020': 'Second', '010': 'First', '030': 'Priority' })
    const before = JSON.stringify([priorities, links, activeIds, aliases])
    expect([...computeMoveSet('030', priorities, links, activeIds, aliases)]).toEqual(['030', '020', '010'])
    expect(JSON.stringify([priorities, links, activeIds, aliases])).toBe(before)
  })
})

describe('computeBrokenLinks', () => {
  it('B1 reports only incoming links from tasks left behind', () => {
    expect(computeBrokenLinks(new Set(['5']), { '7': '5', '8': '9' },
      { '7': 'Task seven', '8': 'Task eight' }))
      .toEqual([{ fromId: '7', fromName: 'Task seven', toId: '5' }])
  })

  it('B2 omits links within the move set', () => {
    expect(computeBrokenLinks(new Set(['1', '2', '3']), { '1': '2', '2': '3' }, {})).toEqual([])
  })

  it('B3 omits unrelated links', () => {
    expect(computeBrokenLinks(new Set(['5']), { '1': '99' }, {})).toEqual([])
  })

  it('B4 accepts frozen arrays and preserves exact IDs and inputs', () => {
    const moving = Object.freeze(['030'])
    const links = Object.freeze({ '010': '030', '020': '30' })
    const names = Object.freeze({ '010': 'First' })
    const before = JSON.stringify([moving, links, names])
    expect(computeBrokenLinks(moving, links, names))
      .toEqual([{ fromId: '010', fromName: 'First', toId: '030' }])
    expect(JSON.stringify([moving, links, names])).toBe(before)
  })

  it('B5 reports raw and resolved targets only for alias hits', () => {
    const links = { '10': '900' }
    const names = { '10': 'Ten' }
    expect(computeBrokenLinks(new Set(['30']), links, names, { '900': '30' }))
      .toEqual([{ fromId: '10', fromName: 'Ten', toId: '900', resolvedToId: '30' }])
    expect(computeBrokenLinks(new Set(['30']), links, names)).toEqual([])
  })

  it('returns no links for null inputs', () => {
    expect(computeBrokenLinks(null, { '10': '30' })).toEqual([])
    expect(computeBrokenLinks(['30'], null)).toEqual([])
    expect(computeBrokenLinks(undefined, undefined)).toEqual([])
  })

  it('preserves link entry order, defaults names, and gives direct hits precedence', () => {
    expect(computeBrokenLinks(['30', '900'],
      { '020': '900', '010': 'external', '030': '30', '30': '900' },
      { '020': '', '010': 'First' }, { '900': '30', external: '30' }))
      .toEqual([
        { fromId: '020', fromName: '', toId: '900' },
        { fromId: '010', fromName: 'First', toId: 'external', resolvedToId: '30' },
        { fromId: '030', fromName: '', toId: '30' },
      ])
  })

  it.each(['array', 'set'])('does not mutate frozen alias inputs with a moving %s', shape => {
    const moving = Object.freeze(shape === 'array' ? ['030'] : new Set(['030']))
    const links = Object.freeze({ '010': '900', '020': '800' })
    const names = Object.freeze({ '010': 'First' })
    const aliases = Object.freeze({ '900': '030', '800': '900' })
    expect(computeBrokenLinks(moving, links, names, aliases))
      .toEqual([{ fromId: '010', fromName: 'First', toId: '900', resolvedToId: '030' }])
    expect([...moving]).toEqual(['030'])
    expect(links).toEqual({ '010': '900', '020': '800' })
    expect(names).toEqual({ '010': 'First' })
    expect(aliases).toEqual({ '900': '030', '800': '900' })
  })
})

it('keeps every existing sorting export unchanged at the package root', () => {
  for (const [name, fn] of Object.entries(sorting)) {
    expect(shared[name]).toBe(fn)
  }
  expect(Object.keys(shared).sort())
    .toEqual([...Object.keys(sorting), 'computeMoveSet', 'computeBrokenLinks'].sort())
})
