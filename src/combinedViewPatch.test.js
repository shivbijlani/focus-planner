import { describe, it, expect, vi } from 'vitest'
import { patchPerSourceContent } from './combinedViewPatch.js'

// A tiny stand-in for parseFocusPlan: the helper only cares that `sections` is
// recomputed from the new content, not how it's parsed.
const parse = (content) => ({ parsedFrom: content })

const makePerSource = () => [
  { source: { id: 'a' }, content: 'A-old', sections: { parsedFrom: 'A-old' } },
  { source: { id: 'b' }, content: 'B-old', sections: { parsedFrom: 'B-old' } },
]

describe('patchPerSourceContent', () => {
  it('replaces content and re-parses sections for the matching source only', () => {
    const before = makePerSource()
    const after = patchPerSourceContent(before, 'b', 'B-new', parse)

    expect(after).not.toBe(before)
    expect(after[0]).toBe(before[0]) // untouched source keeps its reference
    expect(after[1].content).toBe('B-new')
    expect(after[1].sections).toEqual({ parsedFrom: 'B-new' })
    // Source 'a' was never re-parsed.
    expect(after[0].content).toBe('A-old')
  })

  it('reflects a link/mark write immediately (the #411 stale-render case)', () => {
    const before = makePerSource()
    // Simulate opChangeLinkedId producing new plan text for source 'a'.
    const after = patchPerSourceContent(before, 'a', 'A-linked-280', parse)
    expect(after[0].content).toBe('A-linked-280')
    expect(after[0].sections).toEqual({ parsedFrom: 'A-linked-280' })
  })

  it('returns the same reference when content is unchanged (no needless render)', () => {
    const before = makePerSource()
    const parseSpy = vi.fn(parse)
    const after = patchPerSourceContent(before, 'a', 'A-old', parseSpy)
    expect(after).toBe(before)
    expect(parseSpy).not.toHaveBeenCalled()
  })

  it('returns the same reference when no source matches', () => {
    const before = makePerSource()
    const after = patchPerSourceContent(before, 'zzz', 'whatever', parse)
    expect(after).toBe(before)
  })

  it('is a no-op before perSource has loaded (null) or without a sourceId', () => {
    expect(patchPerSourceContent(null, 'a', 'x', parse)).toBe(null)
    const before = makePerSource()
    expect(patchPerSourceContent(before, '', 'x', parse)).toBe(before)
    expect(patchPerSourceContent(before, undefined, 'x', parse)).toBe(before)
  })

  it('does not mutate the input array or entries', () => {
    const before = makePerSource()
    const snapshot = JSON.parse(JSON.stringify(before))
    patchPerSourceContent(before, 'b', 'B-new', parse)
    expect(before).toEqual(snapshot)
  })
})
