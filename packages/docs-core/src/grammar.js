// The journal grammar, shared by journals and Docs (plans/docs-app-design.md §2, §4.2).
//
// A doc.md body is written in exactly the journal's markdown subset, so both
// readers must agree on the two rules that decide what is markup and what is
// text: fenced code is literal (#320), and `<!-- ... -->` comments (which may
// span lines) are hidden. `src/journalChat.js` imports `fencedLineMask` from
// here so the journal parser and the Docs parser cannot drift apart.

const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)$/
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/

// Mark every line that belongs to a fenced block (delimiters included). Returns a boolean
// array parallel to `lines`, so callers keep their own indices and offsets unchanged.
// An unterminated fence runs to end of input, matching oa-state.ps1's Get-FenceMaskedText.
export function fencedLineMask(lines) {
  const mask = new Array(lines.length).fill(false)
  let inFence = false
  let fenceChar = ''
  let fenceLen = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '')
    if (!inFence) {
      const m = line.match(FENCE_OPEN_RE)
      if (!m) continue
      const [, delim, info] = m
      // A backtick fence may not carry a backtick in its info string (CommonMark), which
      // keeps inline code such as `a``b` from opening a block.
      if (delim[0] === '`' && info.includes('`')) continue
      inFence = true
      fenceChar = delim[0]
      fenceLen = delim.length
      mask[i] = true
    } else {
      mask[i] = true
      const c = line.match(FENCE_CLOSE_RE)
      if (c && c[1][0] === fenceChar && c[1].length >= fenceLen) inFence = false
    }
  }
  return mask
}

export function splitLines(content) {
  return String(content || '').replace(/^\uFEFF/, '').split(/\r?\n/)
}

export function trimBlankEnds(arr) {
  let start = 0
  let end = arr.length
  while (start < end && arr[start].trim() === '') start++
  while (end > start && arr[end - 1].trim() === '') end--
  return arr.slice(start, end)
}

/**
 * Walk lines applying the journal's comment rule, calling `onLine(visible, info)` for
 * every line that still has something to show (blank lines included, as '').
 * `onComment(trimmed, idx)` sees each line that is *purely* one comment before it is
 * dropped; returning true consumes it (used for block anchors and the doc header).
 * Fenced lines are passed through verbatim with `info.fenced = true`.
 */
export function walkVisibleLines(lines, { onLine, onComment } = {}) {
  const mask = fencedLineMask(lines)
  let inComment = false
  for (let idx = 0; idx < lines.length; idx++) {
    const rawLine = lines[idx]
    if (mask[idx]) { onLine?.(rawLine, { idx, fenced: true }); continue }
    let line = rawLine
    if (inComment) {
      const end = line.indexOf('-->')
      if (end === -1) continue
      line = line.slice(end + 3)
      inComment = false
    }
    const trimmed = line.trim()
    if (onComment && /^<!--(?:(?!-->)[\s\S])*-->$/.test(trimmed)) {
      if (onComment(trimmed, idx) === true) continue
    }
    let visible = line.replace(/<!--[\s\S]*?-->/g, '')
    const open = visible.indexOf('<!--')
    if (open !== -1) { visible = visible.slice(0, open); inComment = true }
    const wasBlank = rawLine.trim() === ''
    if (!wasBlank && visible.trim() === '') continue // purely a comment
    onLine?.(wasBlank ? '' : visible, { idx, fenced: false })
  }
}

/** The lines a reader actually sees: comments (incl. multi-line) removed, fences kept. */
export function visibleLines(content) {
  const out = []
  walkVisibleLines(splitLines(content), { onLine: (l) => out.push(l) })
  return out
}
