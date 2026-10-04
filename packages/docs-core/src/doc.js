// doc.md → { header, title, blocks } (plans/docs-app-design.md §4.2).
//
//   <!-- docs v1 id=d-7kx2m4 rev=4 published=2026-09-30T21:40:00Z by=overnight-agent -->
//   # Task 123: Mortgage refinance options
//
//   <!-- @b1 -->
//   **Status: 2 options ready — tell me which one to lock.**
//
// Block anchors (`<!-- @bN -->`) are assigned by the publisher. Every visible line after
// an anchor belongs to that block until the next anchor. Content before the first anchor
// (other than the header and title) becomes block `b0`, so a hand-edited doc still renders
// and can still be commented on.

import { splitLines, walkVisibleLines, trimBlankEnds } from './grammar.js'

const HEADER_RE = /^<!--\s*docs\s+v(\d+)\b([\s\S]*?)-->$/i
const ANCHOR_RE = /^<!--\s*@(b\d+)\s*-->$/

function parseAttrs(body) {
  const attrs = {}
  const text = String(body || '')
  let i = 0
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i])) i++
    const keyStart = i
    while (i < text.length && /[\w-]/.test(text[i])) i++
    if (i === keyStart || text[i] !== '=') {
      while (i < text.length && !/\s/.test(text[i])) i++
      continue
    }
    const key = text.slice(keyStart, i++)
    if (i >= text.length) continue
    const quote = text[i] === '"' || text[i] === "'" ? text[i] : null
    if (quote) {
      const valueStart = ++i
      while (i < text.length && text[i] !== quote) i++
      if (i < text.length) {
        attrs[key] = text.slice(valueStart, i++)
        continue
      }
      i = valueStart - 1
    }
    const valueStart = i
    while (i < text.length && !/\s/.test(text[i])) i++
    if (i > valueStart) attrs[key] = text.slice(valueStart, i)
  }
  return attrs
}

export function parseDocHeader(content) {
  for (const line of splitLines(content)) {
    const t = line.trim()
    if (!t) continue
    const m = t.match(HEADER_RE)
    if (!m) return null
    const a = parseAttrs(m[2])
    return {
      version: Number(m[1]),
      id: a.id || null,
      rev: a.rev != null ? Number(a.rev) : null,
      published: a.published || null,
      by: a.by || null,
    }
  }
  return null
}

function blockKind(lines) {
  const first = (lines[0] || '').trim()
  if (/^(`{3,}|~{3,})/.test(first)) return 'code'
  if (/^#{2,6}\s/.test(first)) return 'heading'
  if (/^\|.*\|$/.test(first)) return 'table'
  if (/^>/.test(first)) return 'quote'
  if (/^(?:[-*+]|\d+[.)])\s/.test(first)) return 'list'
  if (/^([-*_])\1{2,}$/.test(first)) return 'rule'
  return 'para'
}

export function parseDoc(content) {
  const lines = splitLines(content)
  const header = parseDocHeader(content)
  let title = ''
  const blocks = []
  let cur = null
  const ensure = () => {
    if (!cur) { cur = { id: 'b0', lines: [] }; blocks.push(cur) }
    return cur
  }
  walkVisibleLines(lines, {
    onComment: (t) => {
      const a = t.match(ANCHOR_RE)
      if (a) { cur = { id: a[1], lines: [] }; blocks.push(cur); return true }
      if (HEADER_RE.test(t)) return true
      return false
    },
    onLine: (line, { fenced }) => {
      if (!fenced && !title && !cur) {
        const tm = line.trim().match(/^#\s+(.+)/)
        if (tm) { title = tm[1].trim(); return }
      }
      ensure().lines.push(line)
    },
  })
  const out = []
  for (const b of blocks) {
    const bl = trimBlankEnds(b.lines)
    if (!bl.length) continue
    const kind = blockKind(bl)
    const heading = kind === 'heading' ? bl[0].trim().replace(/^#{2,6}\s+/, '') : null
    const level = kind === 'heading' ? bl[0].trim().match(/^(#{2,6})/)[1].length : null
    out.push({ id: b.id, lines: bl, kind, heading, level })
  }
  return { header, title, blocks: out, statusLine: statusLine(out) }
}

/** Parse an unanchored draft into the renderer blocks that the publisher anchors. */
export function parseDraftBlocks(content) {
  const lines = splitLines(content)
  const titleIndex = lines.findIndex((line) => /^#\s+/.test(line))
  if (titleIndex === -1) return []
  const source = []
  walkVisibleLines(lines.slice(titleIndex + 1), {
    onLine: (line, info) => source.push({ line, fenced: info.fenced }),
  })
  const blocks = []
  let current = []
  let kind = null
  const flush = () => {
    if (!current.length) return
    const parsed = parseDoc(`<!-- @b1 -->\n${current.join('\n')}`).blocks[0]
    if (parsed) blocks.push(parsed)
    current = []
    kind = null
  }
  const isList = (line) => /^(?:\s*(?:[-*+]|\d+[.)])\s|\s*\[[ xX]\]\s)/.test(line)
  for (let index = 0; index < source.length; index++) {
    const { line, fenced } = source[index]
    const trimmed = line.trim()
    if (!trimmed && !fenced) {
      flush()
      continue
    }
    if (fenced) {
      if (kind !== 'code' && current.length) flush()
      kind = 'code'
      current.push(line)
      continue
    }
    if (/^#{1,6}\s/.test(line)) {
      flush()
      current.push(line)
      flush()
      continue
    }
    if (/^\|.*\|$/.test(line)) {
      flush()
      current.push(line)
      flush()
      continue
    }
    if (isList(line)) {
      if (kind === 'list') flush()
      kind = 'list'
      current.push(line)
      continue
    }
    if (/^\s+/.test(line) && kind === 'list') {
      current.push(line)
      continue
    }
    if (/^>/.test(line)) {
      if (kind !== 'quote') flush()
      kind = 'quote'
      current.push(line)
      continue
    }
    if (kind !== 'paragraph') {
      flush()
      kind = 'paragraph'
    }
    current.push(line)
  }
  flush()
  return blocks
}

/** The doc's bold status line (catch-up contract: first block is `**Status: …**`). */
export function statusLine(blocks) {
  for (const b of blocks || []) {
    const t = (b.lines[0] || '').trim()
    if (b.kind !== 'para') continue
    const m = t.match(/^\*\*(.+?)\*\*\s*(.*)$/)
    if (m) return `${m[1]}${m[2] ? ` ${m[2]}` : ''}`.trim()
    return null
  }
  return null
}

/** Rough plain text of a block (markdown syntax removed) — for search and diffing. */
export function blockPlainText(block) {
  return (block?.lines || [])
    .map((l) => l
      .replace(/^\s*(#{1,6}|>|[-*+]|\d+[.)])\s+/, '')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[*_`]/g, '')
      .replace(/^\|/, '').replace(/\|$/, '').replace(/\|/g, ' '))
    .join('\n')
    .trim()
}

/** Ids of blocks that are new or whose text changed between two parsed revisions. */
export function changedBlockIds(current, previous) {
  const prev = new Map((previous?.blocks || []).map((b) => [b.id, b.lines.join('\n').trim()]))
  const out = new Set()
  for (const b of current?.blocks || []) {
    if (!prev.has(b.id) || prev.get(b.id) !== b.lines.join('\n').trim()) out.add(b.id)
  }
  return out
}

function blockTokens(block) {
  const text = blockPlainText(block).normalize('NFC').toLowerCase()
  return text.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) || []
}

function normalizedBlock(block) {
  return blockTokens(block).join(' ')
}

function tokenSimilarity(left, right) {
  const a = new Set(blockTokens(left))
  const b = new Set(blockTokens(right))
  if (!a.size && !b.size) return 1
  let intersection = 0
  for (const token of a) if (b.has(token)) intersection++
  return intersection / (a.size + b.size - intersection)
}

/**
 * Assign stable positive block ids, carrying unambiguous ids from the prior revision.
 * `nextId` must be greater than every id ever used by this document.
 */
export function assignBlockIds(blocks, previous = [], nextId = 1) {
  const current = (blocks || []).map((block) => ({ ...block }))
  const old = (previous || []).map((block) => ({ ...block }))
  const usedCurrent = new Set()
  const usedOld = new Set()
  const assign = (currentIndex, oldIndex) => {
    current[currentIndex].id = old[oldIndex].id
    usedCurrent.add(currentIndex)
    usedOld.add(oldIndex)
  }

  for (let ni = 0; ni < current.length; ni++) {
    const key = normalizedBlock(current[ni])
    if (!key) continue
    const candidates = old.map((block, oi) => normalizedBlock(block) === key ? oi : -1).filter((oi) => oi !== -1)
    if (candidates.length !== 1) continue
    const oi = candidates[0]
    const reverse = current.filter((block) => normalizedBlock(block) === key)
    if (reverse.length === 1 && !usedOld.has(oi)) assign(ni, oi)
  }

  while (true) {
    const scores = new Map()
    for (let ni = 0; ni < current.length; ni++) {
      if (usedCurrent.has(ni)) continue
      const ranked = []
      for (let oi = 0; oi < old.length; oi++) {
        if (usedOld.has(oi)) continue
        ranked.push({ oi, score: tokenSimilarity(current[ni], old[oi]) })
      }
      ranked.sort((a, b) => b.score - a.score)
      scores.set(`n${ni}`, ranked)
    }
    const oldRanks = new Map()
    for (let oi = 0; oi < old.length; oi++) {
      if (usedOld.has(oi)) continue
      const ranked = []
      for (let ni = 0; ni < current.length; ni++) {
        if (usedCurrent.has(ni)) continue
        ranked.push({ ni, score: tokenSimilarity(current[ni], old[oi]) })
      }
      ranked.sort((a, b) => b.score - a.score)
      oldRanks.set(oi, ranked)
    }
    const pairs = []
    for (let ni = 0; ni < current.length; ni++) {
      if (usedCurrent.has(ni)) continue
      const ranked = scores.get(`n${ni}`) || []
      const best = ranked[0]
      if (!best || best.score < 0.8 || ranked[1]?.score === best.score) continue
      const reverse = oldRanks.get(best.oi) || []
      if (reverse[0]?.ni === ni && reverse[1]?.score !== reverse[0]?.score) pairs.push([ni, best.oi])
    }
    if (!pairs.length) break
    for (const [ni, oi] of pairs) if (!usedCurrent.has(ni) && !usedOld.has(oi)) assign(ni, oi)
  }

  for (let ni = 0; ni < current.length; ni++) {
    if (usedCurrent.has(ni)) continue
    current[ni].id = `b${nextId++}`
  }
  return { blocks: current, nextId }
}

/** Heading blocks, for the Outline sheet. */
export function outline(parsed) {
  return (parsed?.blocks || [])
    .filter((b) => b.kind === 'heading')
    .map((b) => ({ id: b.id, text: b.heading, level: b.level }))
}
