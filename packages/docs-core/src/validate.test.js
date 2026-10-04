import { describe, expect, it } from 'vitest'
import {
  DOCS_LIMITS, validateDocText, validateIndexText, validateResponseText, validateReviewText,
} from './validate.js'

const primaryId = 'd-primary001'
const linkedId = 'd-linked001'
const at = '2026-10-01T12:00:00Z'

function entry(id, primary, extra = {}) {
  return {
    title: id === primaryId ? 'Primary' : 'Supporting',
    ...(primary ? { task: 845 } : {}),
    primary,
    rev: 1,
    updatedAt: at,
    links: primary ? [linkedId] : [],
    ...extra,
  }
}

function index(extra = {}) {
  return {
    version: 1,
    tasks: { '845': primaryId },
    docs: {
      [primaryId]: entry(primaryId, true),
      [linkedId]: entry(linkedId, false),
    },
    ...extra,
  }
}

function docText(id, title, body = 'Status text.') {
  return `<!-- docs v1 id=${id} rev=1 published=${at} by=fp-docs -->\n# ${title}\n\n<!-- @b1 -->\n${body}\n`
}

function response(extra = {}) {
  return {
    version: 1, rev: 1, revisions: [{ rev: 1, at, summary: 'Initial' }], dispositions: {}, ...extra,
  }
}

describe('Docs reader validation', () => {
  it('validates the index schema and ignores unknown fields', () => {
    const parsed = validateIndexText(JSON.stringify(index({
      futureField: 'ignored',
      docs: {
        [primaryId]: entry(primaryId, true, { futureDocField: true, nextBlockId: 12 }),
        [linkedId]: entry(linkedId, false),
      },
    })))
    expect(parsed).not.toHaveProperty('futureField')
    expect(parsed.docs[primaryId]).not.toHaveProperty('futureDocField')
    expect(parsed.docs[primaryId].nextBlockId).toBe(12)
    expect(parsed.tasks).toEqual({ '845': primaryId })
    expect(() => validateIndexText(JSON.stringify(index({
      docs: {
        [primaryId]: entry(primaryId, true, { nextBlockId: 0 }),
        [linkedId]: entry(linkedId, false),
      },
    })))).toThrow(/invalid nextBlockId/)
  })

  it('validates review and response schemas while ignoring unknown fields', () => {
    const review = validateReviewText(JSON.stringify({
      version: 1, comments: {
        c_one: {
          rev: 1,
          anchor: { block: 'b1', quote: 'selected', offset: 7 },
          intent: 'note',
          body: 'Context',
          createdAt: at,
          reviewId: 'rv_one',
          status: 'open',
          clock: 1,
        },
        c_two: {
          rev: 1,
          anchor: {
            block: 'b1', endBlock: 'b2', quote: 'first\n…\nlast',
            startQuote: 'first', endQuote: 'last', offset: 3,
          },
          intent: 'note',
          body: 'Across blocks',
          createdAt: at,
          reviewId: 'rv_one',
          status: 'open',
          clock: 2,
        },
      }, reviews: { rv_one: { submittedAt: at, rev: 1 } }, readRev: 2, futureField: true,
    }))
    const parsedResponse = validateResponseText(JSON.stringify(response({ futureField: true })))
    expect(review.comments.c_one.anchor.offset).toBe(7)
    expect(review.comments.c_two.anchor).toMatchObject({
      endBlock: 'b2', startQuote: 'first', endQuote: 'last', offset: 3,
    })
    expect(review.reviews.rv_one).toEqual({ submittedAt: at, rev: 1 })
    expect(review.readRev).toBe(2)
    expect(parsedResponse).not.toHaveProperty('futureField')
  })

  it('rejects a negative anchor offset', () => {
    expect(() => validateReviewText(JSON.stringify({
      version: 1,
      comments: {
        c_one: {
          rev: 1,
          anchor: { block: 'b1', quote: 'selected', offset: -1 },
          intent: 'note',
          body: 'Context',
          createdAt: at,
          reviewId: 'rv_one',
          status: 'open',
          clock: 1,
        },
      },
      reviews: { rv_one: { submittedAt: at, rev: 1 } },
      readRev: 0,
    }))).toThrow(/required fields/)
  })

  it('refuses invalid required fields in each JSON format', () => {
    expect(() => validateIndexText('{"version":1,"tasks":{}}')).toThrow(/tasks, and docs/)
    expect(() => validateReviewText('{"version":1,"comments":{},"reviews":{}}')).toThrow(/readRev/)
    expect(() => validateResponseText('{"version":1,"rev":1,"revisions":[],"dispositions":{}}')).toThrow(/revisions/)
    expect(() => validateIndexText(JSON.stringify({
      version: 1,
      tasks: { '845': primaryId },
      docs: { [primaryId]: { ...entry(primaryId, true), links: undefined } },
    }))).toThrow(/linked document ids/)
    expect(() => validateResponseText(JSON.stringify(response({
      revisions: [{ rev: 1, at, summary: '' }],
    })))).toThrow(/invalid revision/)
    expect(() => validateReviewText(JSON.stringify({
      version: 1,
      comments: {
        c_one: {
          rev: 1, anchor: { block: 'b1' }, intent: 'question', body: 'why?',
          createdAt: at, reviewId: 'rv_one', status: 'open', clock: 1,
        },
      },
      reviews: {}, readRev: 0,
    }))).toThrow(/required fields/)
  })

  it('validates document stamp and title against its index entry', () => {
    expect(validateDocText(docText(primaryId, 'Primary'), {
      docId: primaryId, entry: entry(primaryId, true),
    }).title).toBe('Primary')
    expect(() => validateDocText(docText(primaryId, 'Wrong'), {
      docId: primaryId, entry: entry(primaryId, true),
    })).toThrow(/title does not match/)
    expect(() => validateDocText(docText(primaryId, 'Primary').replace('by=fp-docs', 'by=other'), {
      docId: primaryId,
    })).toThrow(/publisher stamp/)
  })

  it('refuses a document larger than the body limit', () => {
    const tooLarge = docText(primaryId, 'Primary', 'x'.repeat(DOCS_LIMITS.docBytes))
    expect(() => validateDocText(tooLarge, { docId: primaryId })).toThrow(/D07 size/)
  })

  it('refuses an index larger than the index limit', () => {
    const tooLarge = JSON.stringify({ ...index(), futureField: 'x'.repeat(DOCS_LIMITS.indexBytes) })
    expect(() => validateIndexText(tooLarge)).toThrow(/D07 size/)
  })

  it('refuses a review file larger than the review limit', () => {
    const tooLarge = JSON.stringify({
      version: 1, comments: {}, reviews: {}, readRev: 0,
      futureField: 'x'.repeat(DOCS_LIMITS.reviewBytes),
    })
    expect(() => validateReviewText(tooLarge)).toThrow(/D07 size/)
  })
})
