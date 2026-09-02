// A small, deterministic Markdown -> HTML renderer for task papers.
//
// WHY NOT A LIBRARY: this repo has no markdown dependency and the paper generator
// must run from the agent's own environment with nothing installed. The subset
// below is exactly what task journals actually contain -- measured against the
// live corpus -- and nothing more. Anything unrecognised falls through as escaped
// text, so an unsupported construct degrades to something readable rather than
// disappearing.
//
// SECURITY / FIDELITY: every path escapes first and emits markup second. A journal
// is user- and agent-authored text that we are about to put in an HTML document,
// so raw passthrough of `<script>` (or of a stray `<` in prose) is both an
// injection risk and a rendering bug. There is no "trusted" branch here on purpose.

/** Escape text for HTML text content and double-quoted attribute values. */
export function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// Only these schemes may appear in an href. A journal can contain a
// `javascript:` or `data:` URL as plain text (a quoted example, a bug report),
// and turning that into a live link in a document the user clicks through is the
// one way this generator could actively harm them. Unknown schemes render as
// their original literal text, so the information is still visible -- just not
// clickable.
const SAFE_SCHEME_RE = /^(https?:|mailto:|#|\/|\.\/|\.\.\/)/i

export function isSafeUrl(url) {
  return SAFE_SCHEME_RE.test(String(url || '').trim())
}

// `escapeHtml` has already run by the time a URL is read out of a match, so the
// characters that are legal in a URL but were escaped have to come back before
// being re-escaped for the attribute. Without this, `?a=1&b=2` becomes `&amp;amp;`.
function unescapeAttr(value) {
  return String(value)
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&')
}

/**
 * Inline markup: code spans, images, links, bold, italic, strikethrough.
 *
 * Code spans are resolved FIRST and replaced with placeholders, because their
 * contents are literal: a journal that writes `**not bold**` inside backticks
 * means the asterisks. Running the emphasis rules over code was the single
 * biggest source of wrong output while developing this, and it matters more here
 * than in a general renderer because these journals quote markdown constantly.
 */
export function renderInline(text) {
  const src = String(text ?? '')
  const codes = []
  // Longest-run-first so ``a `b` c`` is one span, per CommonMark.
  let masked = src.replace(/(`+)([\s\S]*?)\1/g, (_m, _t, code) => {
    codes.push(code)
    return `\u0000CODE${codes.length - 1}\u0000`
  })

  masked = escapeHtml(masked)

  // Images before links: the syntaxes differ only by the leading `!`.
  masked = masked.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^)]*&quot;)?\)/g, (m, alt, url) => {
    const raw = unescapeAttr(url)
    if (!isSafeUrl(raw)) return m
    return `<img src="${escapeHtml(raw)}" alt="${alt}" loading="lazy">`
  })

  masked = masked.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^)]*&quot;)?\)/g, (m, label, url) => {
    const raw = unescapeAttr(url)
    if (!isSafeUrl(raw)) return m
    return `<a href="${escapeHtml(raw)}">${label}</a>`
  })

  masked = masked
    .replace(/\*\*\*([^*\n]+)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?![*\w])/g, '$1<em>$2</em>')
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')

  return masked.replace(
    /\u0000CODE(\d+)\u0000/g,
    (_m, i) => `<code>${escapeHtml(codes[Number(i)])}</code>`,
  )
}

const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)$/
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/

/**
 * Block-level render. Handles fenced code, ATX headings, blockquotes, tables,
 * bullet/ordered lists (with nesting), horizontal rules and paragraphs.
 *
 * `headingBase` shifts `#`-levels so a turn's `###` can become an `<h4>` inside a
 * section without producing an out-of-order document outline.
 */
export function renderMarkdown(markdown, { headingBase = 0 } = {}) {
  const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n')
  const out = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    const fence = line.match(FENCE_OPEN_RE)
    if (fence && !(fence[1][0] === '`' && fence[2].includes('`'))) {
      const delim = fence[1]
      const info = fence[2].trim().split(/\s+/)[0] || ''
      const body = []
      i++
      while (i < lines.length) {
        const c = lines[i].match(FENCE_CLOSE_RE)
        if (c && c[1][0] === delim[0] && c[1].length >= delim.length) { i++; break }
        body.push(lines[i])
        i++
      }
      const cls = info ? ` class="language-${escapeHtml(info)}"` : ''
      out.push(`<pre><code${cls}>${escapeHtml(body.join('\n'))}</code></pre>`)
      continue
    }

    if (/^\s*$/.test(line)) { i++; continue }

    if (/^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push('<hr>')
      i++
      continue
    }

    const heading = line.match(/^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/)
    if (heading) {
      const level = Math.min(6, heading[1].length + headingBase)
      out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`)
      i++
      continue
    }

    if (/^ {0,3}>/.test(line)) {
      const body = []
      while (i < lines.length && /^ {0,3}>/.test(lines[i])) {
        body.push(lines[i].replace(/^ {0,3}>\s?/, ''))
        i++
      }
      out.push(`<blockquote>${renderMarkdown(body.join('\n'), { headingBase })}</blockquote>`)
      continue
    }

    if (isTableStart(lines, i)) {
      const { html, next } = renderTable(lines, i)
      out.push(html)
      i = next
      continue
    }

    if (isListItem(line)) {
      const { html, next } = renderList(lines, i, headingBase)
      out.push(html)
      i = next
      continue
    }

    const para = []
    while (
      i < lines.length && !/^\s*$/.test(lines[i]) && !isListItem(lines[i]) &&
      !/^ {0,3}#{1,6}\s/.test(lines[i]) && !/^ {0,3}>/.test(lines[i]) &&
      !FENCE_OPEN_RE.test(lines[i]) && !isTableStart(lines, i) &&
      !/^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i])
    ) {
      para.push(lines[i])
      i++
    }
    if (para.length) out.push(`<p>${renderInline(para.join('\n'))}</p>`)
  }

  return out.join('\n')
}

function isListItem(line) {
  return /^\s*(?:[-*+]|\d+[.)])\s+/.test(line)
}

function listKind(line) {
  return /^\s*\d+[.)]\s+/.test(line) ? 'ol' : 'ul'
}

function indentOf(line) {
  return line.match(/^(\s*)/)[1].replace(/\t/g, '    ').length
}

function renderList(lines, start, headingBase) {
  const baseIndent = indentOf(lines[start])
  const kind = listKind(lines[start])
  const items = []
  let i = start

  while (i < lines.length) {
    const line = lines[i]
    if (/^\s*$/.test(line)) {
      // A blank line ends the list unless the next line continues it.
      if (i + 1 < lines.length && isListItem(lines[i + 1]) && indentOf(lines[i + 1]) >= baseIndent) {
        i++
        continue
      }
      break
    }
    if (!isListItem(line) || indentOf(line) < baseIndent) break
    if (indentOf(line) > baseIndent) {
      const { html, next } = renderList(lines, i, headingBase)
      if (items.length) items[items.length - 1].nested.push(html)
      i = next
      continue
    }
    if (listKind(line) !== kind) break

    const text = [line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')]
    i++
    // Lazy continuation: an indented, non-item line belongs to the item above.
    while (
      i < lines.length && !isListItem(lines[i]) && !/^\s*$/.test(lines[i]) &&
      indentOf(lines[i]) > baseIndent
    ) {
      text.push(lines[i].trim())
      i++
    }
    items.push({ text: text.join(' '), nested: [] })
  }

  const body = items
    .map((it) => `<li>${renderInline(it.text)}${it.nested.length ? '\n' + it.nested.join('\n') : ''}</li>`)
    .join('\n')
  return { html: `<${kind}>\n${body}\n</${kind}>`, next: i }
}

function splitRow(line) {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1)
  const cells = []
  let cur = ''
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') { cur += '|'; i++; continue }
    if (s[i] === '|') { cells.push(cur.trim()); cur = ''; continue }
    cur += s[i]
  }
  cells.push(cur.trim())
  return cells
}

function isTableStart(lines, i) {
  if (!lines[i] || !lines[i].includes('|')) return false
  const sep = lines[i + 1]
  if (!sep) return false
  return /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(sep) && sep.includes('-')
}

function renderTable(lines, start) {
  const header = splitRow(lines[start])
  const aligns = splitRow(lines[start + 1]).map((c) => {
    const left = c.startsWith(':')
    const right = c.endsWith(':')
    if (left && right) return 'center'
    if (right) return 'right'
    return null
  })
  let i = start + 2
  const rows = []
  while (i < lines.length && lines[i].includes('|') && !/^\s*$/.test(lines[i])) {
    rows.push(splitRow(lines[i]))
    i++
  }
  const cell = (tag, text, idx) => {
    const a = aligns[idx] ? ` style="text-align:${aligns[idx]}"` : ''
    return `<${tag}${a}>${renderInline(text)}</${tag}>`
  }
  const thead = `<thead><tr>${header.map((h, n) => cell('th', h, n)).join('')}</tr></thead>`
  const tbody = rows.length
    ? `<tbody>${rows.map((r) => `<tr>${r.map((c, n) => cell('td', c, n)).join('')}</tr>`).join('')}</tbody>`
    : ''
  return { html: `<table>${thead}${tbody}</table>`, next: i }
}
