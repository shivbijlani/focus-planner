// review.json (user → agent) and response.json (agent → user)
// (plans/docs-app-design.md §4.3, §4.4, §6).
//
// review.json is app-owned but can be written by more than one device, so comments merge
// by id with the folder-sync record rules (per-record last-write-wins on `clock`, ties
// broken deterministically) — the same code that merges planner.md rows.

import { mergeCollections } from '../../folder-sync/src/merge.js'

export const REVIEW_VERSION = 1
export const INTENTS = ['approve', 'question', 'do-more', 'note']
export const INTENT_META = {
  approve: { icon: '✅', label: 'Approve' },
  question: { icon: '❓', label: 'Question' },
  'do-more': { icon: '🔧', label: 'Do more' },
  note: { icon: '💬', label: 'Note' },
}
export const RESOLVING_DISPOSITIONS = new Set(['answered', 'done', 'declined'])

export function emptyReview() {
  return { version: REVIEW_VERSION, comments: {}, reviews: {}, readRev: 0 }
}

function safeJson(text) {
  if (text == null || String(text).trim() === '') return null
  try { return JSON.parse(String(text).replace(/^\uFEFF/, '')) } catch { return null }
}

export function parseReview(text) {
  const j = safeJson(text)
  const r = emptyReview()
  if (!j || typeof j !== 'object') return r
  if (j.comments && typeof j.comments === 'object') r.comments = { ...j.comments }
  if (j.reviews && typeof j.reviews === 'object') r.reviews = { ...j.reviews }
  if (Number.isFinite(j.readRev)) r.readRev = j.readRev
  return r
}

export function serializeReview(review) {
  const r = review || emptyReview()
  const comments = {}
  for (const id of Object.keys(r.comments || {}).sort()) comments[id] = r.comments[id]
  const reviews = {}
  for (const id of Object.keys(r.reviews || {}).sort()) reviews[id] = r.reviews[id]
  return `${JSON.stringify({ version: REVIEW_VERSION, comments, reviews, readRev: r.readRev || 0 }, null, 2)}\n`
}

export function parseResponse(text) {
  const j = safeJson(text) || {}
  return {
    version: j.version || 1,
    rev: Number.isFinite(j.rev) ? j.rev : 0,
    revisions: Array.isArray(j.revisions) ? j.revisions : [],
    dispositions: j.dispositions && typeof j.dispositions === 'object' ? j.dispositions : {},
    ackedReview: j.ackedReview || null,
  }
}

export function parseIndex(text) {
  const j = safeJson(text)
  if (!j || typeof j !== 'object') return null
  return { version: j.version || 1, tasks: j.tasks || {}, docs: j.docs || {} }
}

function toCollection(review) {
  const records = {}
  const meta = {}
  for (const [id, c] of Object.entries(review.comments || {})) {
    const { clock, ...rest } = c
    records[id] = rest
    meta[id] = { clock: Number.isFinite(clock) ? clock : 0, deleted: false }
  }
  return { records, meta }
}

/** Merge two review.json snapshots. Pure; returns a new review. */
export function mergeReviews(a, b) {
  const A = a || emptyReview()
  const B = b || emptyReview()
  const merged = mergeCollections(toCollection(A), toCollection(B), { normalizeZeroClock: false })
  const comments = {}
  for (const [id, rec] of Object.entries(merged.records)) {
    comments[id] = { ...rec, clock: merged.meta[id]?.clock ?? 0 }
  }
  const reviews = { ...(B.reviews || {}), ...(A.reviews || {}) }
  return {
    version: REVIEW_VERSION,
    comments,
    reviews,
    readRev: Math.max(A.readRev || 0, B.readRev || 0),
  }
}

function rand(n) {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz'
  let s = ''
  const bytes = new Uint8Array(n)
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(bytes)
  else for (let i = 0; i < n; i++) bytes[i] = Math.floor(Math.random() * 256)
  for (let i = 0; i < n; i++) s += alphabet[bytes[i] % alphabet.length]
  return s
}

export function newCommentId(now = Date.now()) { return `c_${now.toString(36)}${rand(6)}` }
export function newReviewId(now = Date.now()) { return `rv_${now.toString(36)}${rand(6)}` }

/**
 * Turn on-device drafts into one submitted review and merge it into `review`.
 * Returns { review, reviewId }. Drafts must carry { id, anchor, intent, body, createdAt }.
 */
export function submitDrafts(review, drafts, { rev, now = Date.now() } = {}) {
  const base = review || emptyReview()
  if (!drafts?.length) return { review: base, reviewId: null }
  const reviewId = newReviewId(now)
  const iso = new Date(now).toISOString()
  const incoming = emptyReview()
  drafts.forEach((d, i) => {
    incoming.comments[d.id] = {
      rev: d.rev ?? rev,
      anchor: d.anchor,
      intent: d.intent,
      body: d.body || '',
      createdAt: d.createdAt || iso,
      reviewId,
      status: 'open',
      clock: now + i,
    }
  })
  incoming.reviews[reviewId] = { submittedAt: iso, rev }
  return { review: mergeReviews(base, incoming), reviewId }
}

/** Reopen a sent comment the agent resolved. The reopen is stamped with the doc rev. */
export function reopenComment(review, commentId, { rev, now = Date.now() } = {}) {
  const c = review?.comments?.[commentId]
  if (!c) return review
  return {
    ...review,
    comments: {
      ...review.comments,
      [commentId]: { ...c, status: 'reopened', reopenedRev: rev, reopenedAt: new Date(now).toISOString(), clock: Math.max(now, (c.clock || 0) + 1) },
    },
  }
}

/**
 * The user-facing status of one comment:
 * 'draft' | 'open' | 'needs-you' | 'resolved'.
 * (Outdated is an anchoring overlay the caller applies on top of open comments.)
 */
export function commentStatus(comment, disposition) {
  if (!comment) return 'open'
  if (!comment.reviewId) return 'draft'
  const d = disposition
  const reopenedRev = comment.status === 'reopened' ? (comment.reopenedRev ?? Infinity) : -Infinity
  if (d && (d.rev ?? 0) > reopenedRev) {
    if (RESOLVING_DISPOSITIONS.has(d.status)) return 'resolved'
    if (d.status === 'needs-you') return 'needs-you'
  }
  return 'open'
}

/**
 * Derived per-doc state (§6). Never stored.
 * @returns {{ state, rev, readRev, unread, openCount, needsYou, pendingReviews, drafts }}
 */
export function deriveDocState({ entry, review, response, drafts = 0 } = {}) {
  const rev = Math.max(response?.rev || 0, entry?.rev || 0)
  const rv = review || emptyReview()
  const disp = response?.dispositions || {}
  let openCount = 0
  let needsYou = 0
  for (const [id, c] of Object.entries(rv.comments || {})) {
    const s = commentStatus(c, disp[id])
    if (s === 'open') openCount++
    if (s === 'needs-you') { needsYou++; openCount++ }
  }
  if (!Object.keys(rv.comments || {}).length && entry?.openDispositions?.['needs-you']) {
    needsYou = entry.openDispositions['needs-you']
  }
  const reviews = Object.entries(rv.reviews || {}).sort((x, y) => String(x[1].submittedAt).localeCompare(String(y[1].submittedAt)))
  const ackedIdx = response?.ackedReview ? reviews.findIndex(([id]) => id === response.ackedReview) : -1
  const pendingReviews = reviews.slice(ackedIdx + 1).map(([id]) => id)
  let state = 'awaiting-review'
  if (pendingReviews.length) state = 'review-submitted'
  else if (ackedIdx >= 0 && (reviews[ackedIdx][1].rev ?? 0) >= rev) state = 'working'
  return {
    state,
    rev,
    readRev: rv.readRev || 0,
    unread: rev > (rv.readRev || 0),
    openCount,
    needsYou,
    pendingReviews,
    drafts,
  }
}
