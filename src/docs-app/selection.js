// DOM side of commenting: selection → block-scoped TextQuote anchor, anchor → Range,
// and highlight painting with the CSS Custom Highlight API (no DOM mutation) or a
// <mark> fallback for browsers without it (plans/docs-app-design.md §7 Commenting).
import { makeAnchor } from '../../packages/docs-core/src/index.js'

export const BLOCK_SEL = '[data-block]'

export function blockBodies(root) {
  return root ? [...root.querySelectorAll(BLOCK_SEL)] : []
}

export function blockTexts(root) {
  const m = new Map()
  for (const el of blockBodies(root)) m.set(el.dataset.block, el.textContent)
  return m
}

function offsetWithin(bodyEl, node, offset) {
  const r = document.createRange()
  r.selectNodeContents(bodyEl)
  r.setEnd(node, offset)
  return r.toString().length
}

/**
 * Convert the current selection into an anchor, or null when the selection is
 * collapsed or outside `root`. Returns { anchor, rect } where rect is the
 * selection's bounding box in viewport coordinates.
 */
export function selectionToAnchor(root) {
  const sel = typeof window !== 'undefined' ? window.getSelection() : null
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null
  const range = sel.getRangeAt(0)
  if (!root.contains(range.commonAncestorContainer)) return null
  const bodies = blockBodies(root).filter((b) => range.intersectsNode(b))
  if (!bodies.length) return null
  const first = bodies[0]
  const last = bodies[bodies.length - 1]
  const startText = first.textContent
  const endText = last.textContent
  const start = first.contains(range.startContainer) ? offsetWithin(first, range.startContainer, range.startOffset) : 0
  const end = last.contains(range.endContainer) ? offsetWithin(last, range.endContainer, range.endOffset) : endText.length
  if (first === last && end <= start) return null
  if (first === last && !startText.slice(start, end).trim()) return null
  const anchor = makeAnchor({ block: first.dataset.block, startText, start, endBlock: last.dataset.block, endText, end })
  return { anchor, rect: selectionRect(range) }
}

/** Anchor covering a whole block (tap-hold fallback). */
export function blockAnchor(bodyEl) {
  const text = bodyEl.textContent
  return makeAnchor({ block: bodyEl.dataset.block, startText: text, start: 0, endBlock: bodyEl.dataset.block, endText: text, end: text.length })
}

export function selectionRect(range) {
  const rects = [...range.getClientRects()].filter((r) => r.width || r.height)
  const b = range.getBoundingClientRect()
  const lastRect = rects[rects.length - 1] || b
  return { top: b.top, bottom: lastRect.bottom, left: b.left, right: b.right, width: b.width }
}

function locate(bodyEl, offset) {
  const walker = document.createTreeWalker(bodyEl, NodeFilter.SHOW_TEXT)
  let seen = 0
  let node
  let lastNode = null
  while ((node = walker.nextNode())) {
    const len = node.data.length
    if (offset <= seen + len) return { node, offset: offset - seen }
    seen += len
    lastNode = node
  }
  return lastNode ? { node: lastNode, offset: lastNode.data.length } : null
}

/** Build a DOM Range from a reanchor() result. */
export function rangeFor(root, placed) {
  if (!placed || placed.status === 'outdated') return null
  const startEl = root.querySelector(`[data-block="${placed.block}"]`)
  const endEl = root.querySelector(`[data-block="${placed.endBlock || placed.block}"]`)
  if (!startEl || !endEl) return null
  const s = locate(startEl, placed.start)
  const e = locate(endEl, placed.end)
  if (!s || !e) return null
  const r = document.createRange()
  try {
    r.setStart(s.node, s.offset)
    r.setEnd(e.node, e.offset)
  } catch { return null }
  return r
}

export function supportsCustomHighlights() {
  return typeof CSS !== 'undefined' && !!CSS.highlights && typeof window.Highlight === 'function'
}

function unwrapMarks(root) {
  for (const m of [...root.querySelectorAll('mark[data-docs-hl]')]) {
    const parent = m.parentNode
    while (m.firstChild) parent.insertBefore(m.firstChild, m)
    parent.removeChild(m)
    parent.normalize()
  }
}

function wrapRangeInMarks(range, cls) {
  const nodes = []
  const walker = document.createTreeWalker(range.commonAncestorContainer.nodeType === 3 ? range.commonAncestorContainer.parentNode : range.commonAncestorContainer, NodeFilter.SHOW_TEXT)
  let n
  while ((n = walker.nextNode())) if (range.intersectsNode(n)) nodes.push(n)
  for (const node of nodes) {
    let start = node === range.startContainer ? range.startOffset : 0
    let end = node === range.endContainer ? range.endOffset : node.data.length
    if (end <= start) continue
    let target = node
    if (start > 0) { target = target.splitText(start); end -= start; start = 0 }
    if (end < target.data.length) target.splitText(end)
    const mark = document.createElement('mark')
    mark.dataset.docsHl = '1'
    mark.className = cls
    target.parentNode.insertBefore(mark, target)
    mark.appendChild(target)
  }
}

/**
 * Paint highlights. `groups` maps a highlight name (e.g. 'docs-comment') to Ranges.
 * Returns a cleanup function.
 */
export function paintHighlights(root, groups) {
  if (!root) return () => {}
  if (supportsCustomHighlights()) {
    for (const [name, ranges] of Object.entries(groups)) {
      CSS.highlights.set(name, new window.Highlight(...ranges.filter(Boolean)))
    }
    return () => { for (const name of Object.keys(groups)) CSS.highlights.delete(name) }
  }
  unwrapMarks(root)
  // Wrap from the end of the document backwards so earlier Ranges stay valid.
  const all = []
  for (const [name, ranges] of Object.entries(groups)) for (const r of ranges) if (r) all.push([name, r])
  all.sort((a, b) => b[1].compareBoundaryPoints(Range.START_TO_START, a[1]))
  for (const [name, r] of all) { try { wrapRangeInMarks(r, `hl-${name}`) } catch { /* skip */ } }
  return () => unwrapMarks(root)
}
