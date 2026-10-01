// Docs data access: index/doc/review/response/history through the shared storage
// provider, plus on-device drafts. The on-disk format is plans/docs-app-design.md §4.
import * as storage from '../storage/storage.js'
import {
  DOCS_INDEX, docPath, reviewPath, responsePath, historyPath,
  parseIndex, parseDoc, parseReview, parseResponse, serializeReview, mergeReviews, emptyReview,
  submitDrafts, reopenComment,
} from '../../packages/docs-core/src/index.js'

async function readText(path) {
  try { return (await storage.read(path)) || '' } catch { return '' }
}

export async function loadIndex() {
  return parseIndex(await readText(DOCS_INDEX))
}

export async function loadDoc(docId) {
  const [docText, reviewText, responseText] = await Promise.all([
    readText(docPath(docId)), readText(reviewPath(docId)), readText(responsePath(docId)),
  ])
  if (!docText) return null
  return {
    id: docId,
    text: docText,
    parsed: parseDoc(docText),
    review: parseReview(reviewText),
    response: parseResponse(responseText),
  }
}

export async function loadHistory(docId, rev) {
  const text = await readText(historyPath(docId, rev))
  return text ? parseDoc(text) : null
}

export async function loadReviewSummary(docId) {
  const [reviewText, responseText] = await Promise.all([readText(reviewPath(docId)), readText(responsePath(docId))])
  return { review: parseReview(reviewText), response: parseResponse(responseText) }
}

// ── review.json writes: read → merge → write, with If-Match when the provider has it ──

export class ReviewConflictError extends Error {}

/**
 * Apply `mutate(review) → review` to the latest review.json and persist it.
 * The mutation is re-applied on top of whatever is on disk, and the result is merged
 * by comment id with that copy (folder-sync record rules), so a concurrent write from
 * another device is never lost. When the active provider supports eTags (OneDrive as
 * the active source) the write is conditional and retried on 412.
 */
export async function updateReview(docId, mutate, { attempts = 3 } = {}) {
  const path = reviewPath(docId)
  const provider = storage.getActiveProvider()
  const conditional = typeof provider?.readWithEtag === 'function'
  for (let i = 0; i < attempts; i++) {
    let current
    let etag = null
    if (conditional) {
      const r = await provider.readWithEtag(path)
      current = parseReview(r.content)
      etag = r.etag
    } else {
      current = parseReview(await readText(path))
    }
    const next = mergeReviews(current, mutate(current) || current)
    const text = serializeReview(next)
    if (!conditional) {
      await storage.write(path, text)
      return next
    }
    try {
      await provider.write(path, text, etag ? { ifMatch: etag } : { ifNoneMatch: '*' })
      return next
    } catch (e) {
      if (!e?.conflict) throw e
    }
  }
  throw new ReviewConflictError('review.json kept changing; please try again')
}

export function sendDrafts(docId, drafts, rev) {
  let reviewId = null
  return updateReview(docId, (cur) => {
    const res = submitDrafts(cur, drafts, { rev })
    reviewId = res.reviewId
    return res.review
  }).then((review) => ({ review, reviewId }))
}

export function markRead(docId, rev) {
  return updateReview(docId, (cur) => (cur.readRev >= rev ? cur : { ...cur, readRev: rev }))
}

export function reopen(docId, commentId, rev) {
  return updateReview(docId, (cur) => reopenComment(cur, commentId, { rev }))
}

// ── Drafts: on-device until "Send to agent" ────────────────────────────────

const draftKey = (docId) => `fp-docs-drafts:${docId}`

export function loadDrafts(docId) {
  try {
    const v = JSON.parse(localStorage.getItem(draftKey(docId)) || '[]')
    return Array.isArray(v) ? v : []
  } catch { return [] }
}

export function saveDrafts(docId, drafts) {
  try {
    if (drafts.length) localStorage.setItem(draftKey(docId), JSON.stringify(drafts))
    else localStorage.removeItem(draftKey(docId))
  } catch { /* storage full: drafts stay in memory for this session */ }
}

export function draftCount(docId) {
  return loadDrafts(docId).length
}

export { emptyReview }
