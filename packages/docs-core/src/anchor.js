// W3C TextQuote anchoring scoped to a block (plans/docs-app-design.md §4.3).
//
// An anchor stores the quote's zero-based block offset and optional prefix/suffix context.
// Multi-block selections also carry `endBlock`, `startQuote`, and `endQuote`.
//
// Re-anchoring order, per the design: same block + quote → quote anywhere in the doc →
// outdated. An outdated comment is kept and listed, never lost.

export const CONTEXT_CHARS = 32

export function quoteSelector(text, start, end, context = CONTEXT_CHARS) {
  const s = Math.max(0, Math.min(start, end))
  const e = Math.max(start, end)
  return {
    quote: text.slice(s, e),
    prefix: text.slice(Math.max(0, s - context), s),
    suffix: text.slice(e, e + context),
  }
}

function commonSuffixLen(a, b) {
  let n = 0
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++
  return n
}
function commonPrefixLen(a, b) {
  let n = 0
  while (n < a.length && n < b.length && a[n] === b[n]) n++
  return n
}

/**
 * Find `quote` in `text`, disambiguating repeated occurrences by how well the
 * surrounding text matches `prefix` / `suffix`. Returns { start, end, score } or null.
 */
export function findQuote(text, { quote, prefix = '', suffix = '', offset } = {}) {
  const hits = quoteHits(text, { quote, prefix, suffix })
  if (!hits.length) return null
  const bestScore = Math.max(...hits.map((hit) => hit.score))
  const best = hits.filter((hit) => hit.score === bestScore)
  const atOffset = best.filter((hit) => hit.start === offset)
  if (Number.isInteger(offset) && atOffset.length === 1) return atOffset[0]
  return best.length === 1 ? best[0] : null
}

function quoteHits(text, { quote, prefix = '', suffix = '' } = {}) {
  if (!quote || typeof text !== 'string') return []
  const hits = []
  let from = 0
  for (;;) {
    const i = text.indexOf(quote, from)
    if (i === -1) break
    const before = text.slice(Math.max(0, i - prefix.length), i)
    const after = text.slice(i + quote.length, i + quote.length + suffix.length)
    const score = commonSuffixLen(before, prefix) + commonPrefixLen(after, suffix)
    hits.push({ start: i, end: i + quote.length, score })
    from = i + 1
  }
  return hits
}

export function isMultiBlock(anchor) {
  return !!(anchor && anchor.endBlock && anchor.endBlock !== anchor.block)
}

function flattenBlocks(entries) {
  let text = ''
  const blocks = []
  for (const [id, blockText] of entries) {
    if (blocks.length) text += '\n…\n'
    const start = text.length
    text += blockText
    blocks.push({ id, start, end: text.length })
  }
  return { text, blocks }
}

function locationAt(blocks, offset) {
  const block = blocks.find((item) => offset >= item.start && offset <= item.end)
  return block ? { block: block.id, offset: offset - block.start } : null
}

/**
 * @param {object} anchor
 * @param {Record<string,string>|Map<string,string>} blockTexts  block id → text, in doc order
 * @returns {{status:'anchored'|'moved'|'outdated', block?:string, start?:number, endBlock?:string, end?:number}}
 */
export function reanchor(anchor, blockTexts) {
  const entries = blockTexts instanceof Map ? [...blockTexts.entries()] : Object.entries(blockTexts || {})
  const texts = new Map(entries)
  if (!anchor || !anchor.quote) return { status: 'outdated' }

  if (isMultiBlock(anchor)) {
    const order = entries.map(([id]) => id)
    const si = order.indexOf(anchor.block)
    const ei = order.indexOf(anchor.endBlock)
    if (si !== -1 && ei !== -1 && ei >= si) {
      const s = findQuote(texts.get(anchor.block), { quote: anchor.startQuote, prefix: anchor.prefix, offset: anchor.offset })
      const e = findQuote(texts.get(anchor.endBlock), { quote: anchor.endQuote, suffix: anchor.suffix })
      if (s && e) return { status: 'anchored', block: anchor.block, start: s.start, endBlock: anchor.endBlock, end: e.end }
    }
    const flattened = flattenBlocks(entries)
    const hit = findQuote(flattened.text, anchor)
    if (!hit) return { status: 'outdated' }
    const start = locationAt(flattened.blocks, hit.start)
    const end = locationAt(flattened.blocks, hit.end)
    if (!start || !end) return { status: 'outdated' }
    return { status: 'moved', block: start.block, start: start.offset, endBlock: end.block, end: end.offset }
  }

  const same = texts.has(anchor.block)
    ? findQuote(texts.get(anchor.block), anchor)
    : null
  if (same) return { status: 'anchored', block: anchor.block, start: same.start, endBlock: anchor.block, end: same.end }

  const hits = []
  for (const [id, text] of entries) {
    for (const hit of quoteHits(text, anchor)) hits.push({ id, ...hit })
  }
  if (hits.length) {
    const bestScore = Math.max(...hits.map((hit) => hit.score))
    const best = hits.filter((hit) => hit.score === bestScore)
    if (best.length === 1) {
      return {
        status: best[0].id === anchor.block ? 'anchored' : 'moved',
        block: best[0].id,
        start: best[0].start,
        endBlock: best[0].id,
        end: best[0].end,
      }
    }
  }
  return { status: 'outdated' }
}

/**
 * Build an anchor from a selection expressed as block-relative offsets.
 * `startText` / `endText` are the rendered texts of the start and end blocks.
 */
export function makeAnchor({ block, startText, start, endBlock, endText, end }) {
  if (!endBlock || endBlock === block) {
    const sel = quoteSelector(startText, start, end)
    return { block, endBlock: block, offset: Math.max(0, Math.min(start, end)), ...sel }
  }
  const startQuote = startText.slice(start)
  const endQuote = endText.slice(0, end)
  return {
    block,
    endBlock,
    offset: Math.max(0, start),
    quote: `${startQuote}\n…\n${endQuote}`,
    prefix: startText.slice(Math.max(0, start - CONTEXT_CHARS), start),
    suffix: endText.slice(end, end + CONTEXT_CHARS),
    startQuote,
    endQuote,
  }
}
