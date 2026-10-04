import { describe, it, expect } from 'vitest'
import {
  emptyReview, parseReview, serializeReview, mergeReviews, submitDrafts, reopenComment,
  commentStatus, deriveDocState, parseResponse, parseIndex,
} from './review.js'

const anchor = { block: 'b1', endBlock: 'b1', quote: 'q', prefix: '', suffix: '' }

describe('review.json merge', () => {
  it('unions comments from two devices by id', () => {
    const phone = submitDrafts(emptyReview(), [{ id: 'c_a', anchor, intent: 'question', body: 'why?' }], { rev: 2, now: 1000 }).review
    const desk = submitDrafts(emptyReview(), [{ id: 'c_b', anchor, intent: 'note', body: 'fyi' }], { rev: 2, now: 2000 }).review
    const m = mergeReviews(phone, desk)
    expect(Object.keys(m.comments).sort()).toEqual(['c_a', 'c_b'])
    expect(Object.keys(m.reviews)).toHaveLength(2)
    expect(mergeReviews(desk, phone)).toEqual(m)
  })

  it('newer clock wins for the same comment, and readRev takes the max', () => {
    const base = submitDrafts(emptyReview(), [{ id: 'c_a', anchor, intent: 'question', body: 'v1' }], { rev: 1, now: 1000 }).review
    const reopened = reopenComment({ ...base, readRev: 3 }, 'c_a', { rev: 2, now: 5000 })
    const m = mergeReviews(base, reopened)
    expect(m.comments.c_a.status).toBe('reopened')
    expect(m.readRev).toBe(3)
  })

  it('uses the spec tie-break for equal clocks and is commutative and idempotent', () => {
    const common = {
      rev: 1, anchor, intent: 'note', createdAt: '2026-10-01T12:00:00Z',
      reviewId: 'rv_one', status: 'open', clock: 42,
    }
    const left = { ...emptyReview(), comments: { c_a: { ...common, body: 'alpha' } } }
    const right = { ...emptyReview(), comments: { c_a: { ...common, body: 'zeta' }, c_b: { ...common, body: 'separate id' } } }
    const merged = mergeReviews(left, right)
    expect(merged.comments.c_a.body).toBe('zeta')
    expect(Object.keys(merged.comments).sort()).toEqual(['c_a', 'c_b'])
    expect(mergeReviews(left, right)).toEqual(mergeReviews(right, left))
    expect(mergeReviews(merged, merged)).toEqual(merged)

    const tieBase = {
      rev: 1, anchor, intent: 'note', createdAt: '2026-10-01T12:00:00Z',
      reviewId: 'rv_one', status: 'open', body: 'same',
    }
    const orderedLeft = { ...tieBase, extension: 'a', clock: 42 }
    const orderedRight = { ...tieBase, clock: 42, extension: 'z' }
    const tie = mergeReviews(
      { ...emptyReview(), comments: { c_tie: orderedLeft } },
      { ...emptyReview(), comments: { c_tie: orderedRight } },
    )
    expect(JSON.stringify(orderedLeft) > JSON.stringify(orderedRight)).toBe(true)
    expect(tie.comments.c_tie).toEqual(orderedLeft)
  })

  it('serializes stably and parses defensively', () => {
    const r = submitDrafts(emptyReview(), [{ id: 'c_a', anchor, intent: 'approve' }], { rev: 1, now: 1 }).review
    const text = serializeReview(r)
    expect(text.endsWith('\n')).toBe(true)
    expect(parseReview(text)).toEqual(r)
    expect(parseReview('not json')).toEqual(emptyReview())
    expect(parseResponse('').dispositions).toEqual({})
    expect(parseIndex('')).toBeNull()
  })
})

describe('derived state', () => {
  it('resolves a comment when the agent dispositions it, and reopen overrides older dispositions', () => {
    const c = { reviewId: 'rv', status: 'open' }
    expect(commentStatus({ status: 'open' })).toBe('draft')
    expect(commentStatus(c)).toBe('open')
    expect(commentStatus(c, { status: 'answered', rev: 4 })).toBe('resolved')
    expect(commentStatus(c, { status: 'needs-you', rev: 4 })).toBe('needs-you')
    const re = { ...c, status: 'reopened', reopenedRev: 4 }
    expect(commentStatus(re, { status: 'done', rev: 4 })).toBe('open')
    expect(commentStatus(re, { status: 'done', rev: 5 })).toBe('resolved')
  })

  it('derives the lifecycle state from the files', () => {
    const { review, reviewId } = submitDrafts(emptyReview(), [{ id: 'c_a', anchor, intent: 'question' }], { rev: 3, now: 1000 })
    expect(deriveDocState({ entry: { rev: 3 }, review, response: { rev: 3, dispositions: {} } }))
      .toMatchObject({ state: 'review-submitted', unread: true, openCount: 1 })
    expect(deriveDocState({ entry: { rev: 3 }, review, response: { rev: 3, ackedReview: reviewId, dispositions: {} } }).state).toBe('working')
    const done = deriveDocState({ entry: { rev: 4 }, review: { ...review, readRev: 4 }, response: { rev: 4, ackedReview: reviewId, dispositions: { c_a: { status: 'needs-you', rev: 4 } } } })
    expect(done).toMatchObject({ state: 'awaiting-review', unread: false, needsYou: 1 })
  })
})
