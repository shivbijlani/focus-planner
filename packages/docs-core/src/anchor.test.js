import { describe, it, expect } from 'vitest'
import { quoteSelector, findQuote, reanchor, makeAnchor } from './anchor.js'
import { parseDocHref, extractDocLinks, reviewSet, linkedFrom, parseRoute, docHref } from './links.js'

describe('TextQuote anchoring', () => {
  const text = 'Option A is a fixed rate. Option B is a fixed 30-year at 5.9% with no points.'

  it('captures quote, prefix and suffix', () => {
    const s = text.indexOf('fixed 30-year')
    const sel = quoteSelector(text, s, s + 'fixed 30-year at 5.9%'.length, 14)
    expect(sel).toEqual({ quote: 'fixed 30-year at 5.9%', prefix: 'Option B is a ', suffix: ' with no point' })
  })

  it('disambiguates repeated quotes with context', () => {
    const t = 'a fixed rate; b fixed rate'
    expect(findQuote(t, { quote: 'fixed', prefix: 'b ' }).start).toBe(t.lastIndexOf('fixed'))
    expect(findQuote(t, { quote: 'fixed', prefix: 'a ' }).start).toBe(t.indexOf('fixed'))
    expect(findQuote(t, { quote: 'nope' })).toBeNull()
  })

  it('uses the stored offset for a repeated quote and marks unresolved ties outdated', () => {
    const t = 'one quote; two quote'
    const anchor = makeAnchor({ block: 'b1', startText: t, start: 15, end: 20 })
    expect(anchor.offset).toBe(15)
    expect(reanchor(anchor, { b1: t })).toMatchObject({ status: 'anchored', start: 15 })
    expect(reanchor({ block: 'b1', quote: 'target', prefix: 'same ', suffix: ' same' }, {
      b1: 'same target same / same target same',
    })).toEqual({ status: 'outdated' })
    expect(reanchor({ block: 'b1', quote: 'target', prefix: 'same ', suffix: ' same' }, {
      b1: 'gone',
      b2: 'same target same',
      b3: 'same target same',
    })).toEqual({ status: 'outdated' })
  })

  it('re-anchors: same block, then anywhere, then outdated', () => {
    const a = { block: 'b7', endBlock: 'b7', quote: '5.9%', prefix: 'at ', suffix: ' with' }
    expect(reanchor(a, { b6: 'x', b7: 'rate at 5.9% with' })).toMatchObject({ status: 'anchored', block: 'b7', start: 8, end: 12 })
    expect(reanchor(a, { b7: 'rewritten', b9: 'now at 5.9% with' })).toMatchObject({ status: 'moved', block: 'b9' })
    expect(reanchor(a, { b7: 'gone' })).toEqual({ status: 'outdated' })
  })

  it('anchors multi-block selections to start and end blocks', () => {
    const a = makeAnchor({ block: 'b1', startText: 'first para tail', start: 6, endBlock: 'b2', endText: 'second para', end: 6 })
    expect(a).toMatchObject({ block: 'b1', endBlock: 'b2', startQuote: 'para tail', endQuote: 'second' })
    expect(reanchor(a, { b1: 'first para tail', b2: 'second para' })).toMatchObject({ status: 'anchored', start: 6, end: 6, endBlock: 'b2' })
    expect(reanchor(a, { b2: 'second para', b1: 'first para tail' }).status).toBe('outdated')
    expect(reanchor(a, { b9: 'first para tail', b10: 'second para' }))
      .toMatchObject({ status: 'moved', block: 'b9', start: 6, endBlock: 'b10', end: 6 })
    expect(reanchor(a, { b1: 'changed', b2: 'second para' }).status).toBe('outdated')
  })
})

describe('doc: links', () => {
  it('parses doc hrefs', () => {
    expect(parseDocHref('doc:d-9a1c0q')).toEqual({ docId: 'd-9a1c0q', block: null })
    expect(parseDocHref('doc:d-9a1c0q#b9')).toEqual({ docId: 'd-9a1c0q', block: 'b9' })
    expect(parseDocHref('https://x')).toBeNull()
  })
  it('extracts links in order without duplicates', () => {
    expect(extractDocLinks('[a](doc:d-aaaaaa) [b](doc:d-bbbbbb#b2) [a](doc:d-aaaaaa)')).toEqual(['d-aaaaaa', 'd-bbbbbb'])
  })
  it('walks the review set cycle-safely with a depth cap', () => {
    const index = { docs: { p: { links: ['a'] }, a: { links: ['b', 'p'] }, b: { links: ['c'] }, c: { links: [] } } }
    expect(reviewSet(index, 'p')).toEqual(['p', 'a', 'b', 'c'])
    expect(reviewSet(index, 'p', 1)).toEqual(['p', 'a'])
    expect(linkedFrom(index, 'a')).toEqual(['p'])
  })
  it('round-trips hash routes', () => {
    expect(parseRoute('')).toEqual({ view: 'library' })
    expect(parseRoute(docHref('d-aaaaaa', { block: 'b3', comment: 'c_1' }))).toEqual({ view: 'doc', docId: 'd-aaaaaa', block: 'b3', comment: 'c_1' })
  })
})
