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

/** Heading blocks, for the Outline sheet. */
export function outline(parsed) {
  return (parsed?.blocks || [])
    .filter((b) => b.kind === 'heading')
    .map((b) => ({ id: b.id, text: b.heading, level: b.level }))
}
