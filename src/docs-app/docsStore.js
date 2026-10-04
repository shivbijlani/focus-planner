// Docs data access: index/doc/review/response/history through the shared storage
// provider, plus on-device drafts. The on-disk format is plans/docs-app-design.md §4.
import * as storage from '../storage/storage.js'
import {
  DOCS_INDEX, docPath, reviewPath, responsePath, historyPath,
  parseIndex, serializeReview, mergeReviews, emptyReview,
  submitDrafts, reopenComment, reviewSet, DOCS_LIMITS, docsByteLength,
  validateDocText, validateReviewText, validateResponseText,
} from '../../packages/docs-core/src/index.js'

async function readText(path) {
  return (await storage.read(path)) ?? ''
}

export async function loadIndex() {
  return parseIndex(await readText(DOCS_INDEX))
}

export async function validateReviewSet(index, primaryId, read = readText) {
  const ids = reviewSet(index, primaryId)
  let totalBytes = 0
  const texts = new Map()
  for (const id of ids) {
    const text = await read(docPath(id))
    if (!text) throw new Error(`Missing document body for ${id}`)
    validateDocText(text, { docId: id, entry: index.docs[id] })
    totalBytes += docsByteLength(text)
    if (totalBytes > DOCS_LIMITS.reviewSetBytes) {
      throw new Error(`D07 size: task review set exceeds ${DOCS_LIMITS.reviewSetBytes} bytes`)
    }
    texts.set(id, text)
  }
  return texts
}

export async function loadDoc(docId, index) {
  const entry = index?.docs?.[docId]
  if (!entry) throw new Error(`Document ${docId} is not listed in docs/index.json`)
  const primaryIds = Object.entries(index.docs)
    .filter(([id, doc]) => doc.primary && reviewSet(index, id).includes(docId))
    .map(([id]) => id)
  const bodies = new Map()
  for (const primaryId of primaryIds) {
    const set = await validateReviewSet(index, primaryId)
    for (const [id, text] of set) bodies.set(id, text)
  }
  const docText = bodies.get(docId) ?? await readText(docPath(docId))
  if (!docText) throw new Error(`Missing document body for ${docId}`)
  const [reviewText, responseText] = await Promise.all([
    readText(reviewPath(docId)), readText(responsePath(docId)),
  ])
  const response = validateResponseText(responseText)
  return {
    id: docId,
    text: docText,
    parsed: validateDocText(docText, { docId, entry, response }),
    review: validateReviewText(reviewText),
    response,
  }
}

export async function loadHistory(docId, rev, entry) {
  const text = await readText(historyPath(docId, rev))
  return text ? validateDocText(text, { docId, entry }) : null
}

export async function loadReviewSummary(docId) {
  const [reviewText, responseText] = await Promise.all([readText(reviewPath(docId)), readText(responsePath(docId))])
  return { review: validateReviewText(reviewText), response: validateResponseText(responseText) }
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
      current = validateReviewText(r.content)
      etag = r.etag
    } else {
      current = validateReviewText(await readText(path))
    }
    const next = mergeReviews(current, mutate(current) || current)
    const text = serializeReview(next)
    validateReviewText(text)
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
