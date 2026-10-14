// `doc:` links and the review set (plans/docs-app-design.md §4.2, §5).
//
//   [Mortgage options brief](doc:d-9a1c0q)        → whole doc
//   [the escrow note](doc:d-9a1c0q#b9)             → a block in it

export const DOC_ID_RE = /^d-[a-z0-9]{6,}$/

export function parseDocHref(href) {
  const m = String(href || '').trim().match(/^doc:(d-[a-z0-9]{6,})(?:#(b\d+))?$/)
  if (!m) return null
  return { docId: m[1], block: m[2] || null }
}

export function isDocHref(href) {
  return parseDocHref(href) !== null
}

/** Every doc id linked from a doc body, in first-seen order, deduped. */
export function extractDocLinks(content) {
  const out = []
  const seen = new Set()
  const re = /\]\(\s*doc:(d-[a-z0-9]{6,})(?:#b\d+)?\s*\)/g
  let m
  while ((m = re.exec(String(content || '')))) {
    if (!seen.has(m[1])) { seen.add(m[1]); out.push(m[1]) }
  }
  return out
}

/** Docs whose index entry links to `docId` ("Linked from" footer). */
export function linkedFrom(index, docId) {
  const docs = index?.docs || {}
  return Object.keys(docs).filter((id) => id !== docId && (docs[id]?.links || []).includes(docId))
}

/**
 * The review set of a primary doc: itself plus every doc reachable through `links`
 * in index.json, breadth-first, cycle-safe, capped at `depth` hops.
 */
export function reviewSet(index, primaryId, depth = 3) {
  const docs = index?.docs || {}
  const out = []
  const seen = new Set([primaryId])
  let frontier = [primaryId]
  out.push(primaryId)
  for (let d = 0; d < depth && frontier.length; d++) {
    const next = []
    for (const id of frontier) {
      for (const l of docs[id]?.links || []) {
        if (seen.has(l) || !docs[l]) continue
        seen.add(l)
        out.push(l)
        next.push(l)
      }
    }
    frontier = next
  }
  return out
}

export function docHref(docId, { block, comment } = {}) {
  const q = []
  if (block) q.push(`block=${encodeURIComponent(block)}`)
  if (comment) q.push(`comment=${encodeURIComponent(comment)}`)
  return `#/d/${docId}${q.length ? `?${q.join('&')}` : ''}`
}

/** Parse the Docs app hash route: '' | '#/' → library; '#/d/<id>?block=&comment=' → doc. */
export function parseRoute(hash) {
  const h = String(hash || '').replace(/^#/, '')
  const m = h.match(/^\/d\/(d-[a-z0-9]{6,})(?:\?(.*))?$/)
  if (!m) return { view: 'library' }
  const params = new URLSearchParams(m[2] || '')
  return { view: 'doc', docId: m[1], block: params.get('block'), comment: params.get('comment') }
}
