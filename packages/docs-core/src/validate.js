import { parseDoc, parseDocHeader } from './doc.js'

export const DOCS_LIMITS = {
  docBytes: 256 * 1024,
  indexBytes: 1024 * 1024,
  reviewBytes: 1024 * 1024,
  reviewSetBytes: 2 * 1024 * 1024,
}

const DOC_ID_RE = /^d-[a-z0-9]{6,}$/
const BLOCK_ID_RE = /^b[1-9][0-9]*$/
const COMMENT_ID_RE = /^c_[A-Za-z0-9_-]+$/
const REVIEW_ID_RE = /^rv_[A-Za-z0-9_-]+$/
const INTENTS = new Set(['approve', 'question', 'do-more', 'note'])
const DISPOSITIONS = new Set(['answered', 'done', 'needs-you', 'declined'])

export class DocsDataError extends Error {
  constructor(message) {
    super(message)
    this.name = 'DocsDataError'
  }
}

export function docsByteLength(value) {
  return new TextEncoder().encode(String(value ?? '')).byteLength
}

function reject(message) {
  throw new DocsDataError(message)
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function integer(value, min = 0) {
  return Number.isSafeInteger(value) && value >= min
}

function timestamp(value) {
  return typeof value === 'string'
    && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value)
    && Number.isFinite(Date.parse(value))
}

function uri(value) {
  if (typeof value !== 'string' || !value) return false
  try { return !!new URL(value).protocol } catch { return false }
}

function jsonObject(text, label, maxBytes) {
  if (maxBytes != null && docsByteLength(text) > maxBytes) {
    reject(`D07 size: ${label} exceeds ${maxBytes} bytes`)
  }
  if (text == null || String(text).trim() === '') return null
  let value
  try { value = JSON.parse(String(text).replace(/^\uFEFF/, '')) } catch {
    reject(`${label} is not valid JSON`)
  }
  if (!object(value)) reject(`${label} must be a JSON object`)
  return value
}

function known(source, keys) {
  return Object.fromEntries(keys.filter((key) => Object.hasOwn(source, key)).map((key) => [key, source[key]]))
}

function checkDocEntry(id, entry) {
  if (!DOC_ID_RE.test(id) || !object(entry)) reject(`Invalid Docs index entry: ${id}`)
  if (typeof entry.title !== 'string' || !entry.title.trim()) reject(`Docs ${id} requires a non-empty title`)
  if (typeof entry.primary !== 'boolean') reject(`Docs ${id} requires primary to be a boolean`)
  if (!integer(entry.rev, 1)) reject(`Docs ${id} requires a positive revision`)
  if (!timestamp(entry.updatedAt)) reject(`Docs ${id} requires a UTC updatedAt timestamp`)
  if (!Array.isArray(entry.links) || !entry.links.every((link) => typeof link === 'string' && DOC_ID_RE.test(link))) {
    reject(`Docs ${id} requires an array of valid linked document ids`)
  }
  if (new Set(entry.links).size !== entry.links.length) reject(`Docs ${id} has duplicate links`)
  if (entry.task !== undefined && !integer(entry.task, 1)) reject(`Docs ${id} has an invalid task id`)
  if (entry.telegramUrl !== undefined && !uri(entry.telegramUrl)) reject(`Docs ${id} has an invalid telegramUrl`)
  if (entry.openDispositions !== undefined) {
    const counts = entry.openDispositions
    if (!object(counts) || Object.keys(counts).some((key) => key !== 'needs-you' || !integer(counts[key]))) {
      reject(`Docs ${id} has invalid openDispositions`)
    }
  }
  if (entry.primary ? entry.task === undefined : entry.task !== undefined || entry.telegramUrl !== undefined) {
    reject(`Docs ${id} has an invalid primary/task binding`)
  }
  return known(entry, ['title', 'task', 'primary', 'rev', 'updatedAt', 'telegramUrl', 'links', 'openDispositions'])
}

export function validateIndexText(text) {
  const index = jsonObject(text, 'docs/index.json', DOCS_LIMITS.indexBytes)
  if (!index) return null
  if (index.version !== 1 || !object(index.tasks) || !object(index.docs)) {
    reject('docs/index.json requires version 1, tasks, and docs')
  }
  const tasks = {}
  for (const [taskId, docId] of Object.entries(index.tasks)) {
    if (!/^[1-9][0-9]*$/.test(taskId) || !DOC_ID_RE.test(docId)) reject(`Invalid Docs task binding: ${taskId}`)
    tasks[taskId] = docId
  }
  const docs = {}
  for (const [id, entry] of Object.entries(index.docs)) docs[id] = checkDocEntry(id, entry)

  for (const [taskId, docId] of Object.entries(tasks)) {
    const entry = docs[docId]
    if (!entry?.primary || entry.task !== Number(taskId)) reject(`Task ${taskId} does not bind to its primary doc`)
  }
  for (const [id, entry] of Object.entries(docs)) {
    if (entry.primary && tasks[String(entry.task)] !== id) reject(`Primary doc ${id} has no matching task binding`)
    if (entry.links.some((link) => !docs[link])) reject(`Docs ${id} links to a missing document`)
  }
  return { version: 1, tasks, docs }
}

function validateReviewObject(review) {
  if (review.version !== 1 || !object(review.comments) || !object(review.reviews) || !integer(review.readRev)) {
    reject('review.json requires version 1, comments, reviews, and a non-negative readRev')
  }
  const comments = {}
  for (const [id, c] of Object.entries(review.comments)) {
    if (!COMMENT_ID_RE.test(id) || !object(c)) reject(`Invalid review comment: ${id}`)
    const a = c.anchor
    if (!integer(c.rev, 1) || !object(a) || !BLOCK_ID_RE.test(a.block || '') || typeof a.quote !== 'string' || !a.quote
      || (a.endBlock !== undefined && !BLOCK_ID_RE.test(a.endBlock))
      || (a.prefix !== undefined && typeof a.prefix !== 'string')
      || (a.suffix !== undefined && typeof a.suffix !== 'string')
      || !INTENTS.has(c.intent) || typeof c.body !== 'string' || !timestamp(c.createdAt)
      || typeof c.reviewId !== 'string' || !REVIEW_ID_RE.test(c.reviewId)
      || !['open', 'reopened'].includes(c.status) || !integer(c.clock)) {
      reject(`Invalid required fields in review comment ${id}`)
    }
    if (c.status === 'reopened' && (!timestamp(c.reopenedAt) || !integer(c.reopenedRev, 1))) {
      reject(`Reopened review comment ${id} requires reopenedAt and reopenedRev`)
    }
    comments[id] = {
      ...known(c, ['rev', 'intent', 'body', 'createdAt', 'reviewId', 'status', 'clock', 'reopenedAt', 'reopenedRev']),
      anchor: known(a, ['block', 'endBlock', 'quote', 'prefix', 'suffix']),
    }
  }
  const reviews = {}
  for (const [id, r] of Object.entries(review.reviews)) {
    if (!REVIEW_ID_RE.test(id) || !object(r) || !timestamp(r.submittedAt) || !integer(r.rev, 1)) {
      reject(`Invalid review batch: ${id}`)
    }
    reviews[id] = known(r, ['submittedAt', 'rev'])
  }
  return { version: 1, comments, reviews, readRev: review.readRev }
}

export function validateReviewText(text) {
  if (text == null || String(text).trim() === '') return { version: 1, comments: {}, reviews: {}, readRev: 0 }
  return validateReviewObject(jsonObject(text, 'review.json', DOCS_LIMITS.reviewBytes))
}

export function validateResponseText(text) {
  const response = jsonObject(text, 'response.json')
  if (!response || response.version !== 1 || !integer(response.rev, 1) || !Array.isArray(response.revisions)
    || response.revisions.length < 1 || response.revisions.length > 20 || !object(response.dispositions)) {
    reject('response.json requires version 1, a positive rev, revisions, and dispositions')
  }
  const revisions = response.revisions.map((r) => {
    if (!object(r) || !integer(r.rev, 1) || !timestamp(r.at) || typeof r.summary !== 'string' || !r.summary) {
      reject('response.json contains an invalid revision')
    }
    return known(r, ['rev', 'at', 'summary'])
  })
  const dispositions = {}
  for (const [id, d] of Object.entries(response.dispositions)) {
    if (!COMMENT_ID_RE.test(id) || !object(d) || !DISPOSITIONS.has(d.status) || !integer(d.rev, 1)
      || !Array.isArray(d.blocks) || d.blocks.length < 1 || !d.blocks.every((b) => typeof b === 'string' && BLOCK_ID_RE.test(b))
      || new Set(d.blocks).size !== d.blocks.length || (d.note !== undefined && typeof d.note !== 'string')) {
      reject(`Invalid response disposition: ${id}`)
    }
    dispositions[id] = known(d, ['status', 'rev', 'blocks', 'note'])
  }
  if (response.ackedReview !== undefined && response.ackedReview !== null
    && (typeof response.ackedReview !== 'string' || !REVIEW_ID_RE.test(response.ackedReview))) {
    reject('response.json has an invalid ackedReview')
  }
  return {
    version: 1,
    rev: response.rev,
    revisions,
    dispositions,
    ackedReview: response.ackedReview ?? null,
  }
}

export function validateDocText(text, { docId, entry, response } = {}) {
  const content = String(text ?? '')
  if (docsByteLength(content) > DOCS_LIMITS.docBytes) {
    reject(`D07 size: ${docId || 'doc.md'} exceeds ${DOCS_LIMITS.docBytes} bytes`)
  }
  const firstLine = content.replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0]
  const header = parseDocHeader(content)
  if (!header || firstLine.trim() !== firstLine || header.version !== 1 || header.id !== docId
    || !integer(header.rev, 1) || !timestamp(header.published) || header.by !== 'fp-docs') {
    reject(`Invalid publisher stamp in docs/${docId}/doc.md`)
  }
  const parsed = parseDoc(content)
  if (!parsed.title || (entry && parsed.title !== entry.title)) {
    reject(`Document title does not match the Docs index for ${docId}`)
  }
  if (entry && header.rev !== entry.rev) reject(`Document revision does not match the Docs index for ${docId}`)
  if (response && response.rev !== header.rev) reject(`Document revision does not match response.json for ${docId}`)
  return parsed
}
