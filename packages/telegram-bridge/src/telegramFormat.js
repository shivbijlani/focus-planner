// Convert the markdown the Overnight Agent writes into journals into the small
// HTML subset Telegram's `parse_mode: HTML` understands, so bold/italic/code/
// links render as formatting instead of showing literal `**`, `` ` ``, etc.
//
// Telegram HTML supports only a handful of inline tags (b, i, u, s, a, code,
// pre, blockquote, tg-spoiler) and NO block structure — no headings, lists, or
// tables. So headings collapse to a bold line, bullets become `• `, numbered
// items keep their `n.`, and anything unsupported degrades to plain text.
//
// Dependency-free (this package ships with no deps) and pure, so it's unit
// tested offline alongside the rest of the bridge.

const KNOWN_SCHEME = /^(https?:|tg:\/\/|mailto:)/i

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

// Format the inline spans of a single already-line-split string. Inline code is
// extracted first so its contents are never treated as bold/italic/link syntax.
function inline(text) {
  const codes = []
  let s = String(text).replace(/`([^`]+)`/g, (_, c) => {
    codes.push(c)
    return `\u0000C${codes.length - 1}\u0000`
  })

  s = escapeHtml(s)

  // Links: [label](url). Only real schemes become anchors; relative/other links
  // (e.g. ./task-363-design-spec.md) render as just their label text.
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => {
    const u = url.trim()
    if (KNOWN_SCHEME.test(u)) return `<a href="${escapeHtml(u)}">${label}</a>`
    return label
  })

  // Bold before italic so `**x**` isn't eaten by the single-asterisk rule.
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
  s = s.replace(/__([^_\n]+)__/g, '<b>$1</b>')
  // Italic: a single * or _ not adjacent to another (so leftover ** won't match).
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<i>$2</i>')
  s = s.replace(/(^|[^_\w])_([^_\n]+)_(?![_\w])/g, '$1<i>$2</i>')
  // Strikethrough.
  s = s.replace(/~~([^~\n]+)~~/g, '<s>$1</s>')

  // Restore inline code (escaping its own contents).
  s = s.replace(/\u0000C(\d+)\u0000/g, (_, i) => `<code>${escapeHtml(codes[Number(i)])}</code>`)
  return s
}

/**
 * Convert a markdown string into Telegram-flavoured HTML.
 * The output is always tag-balanced (fenced code blocks and blockquotes are
 * closed even if the source is truncated mid-block).
 * @param {string} md
 * @returns {string}
 */
export function mdToTelegramHtml(md) {
  if (!md) return ''
  const lines = String(md).replace(/\r\n/g, '\n').split('\n')
  const out = []
  let quote = []

  const flushQuote = () => {
    if (quote.length) {
      out.push(`<blockquote>${quote.join('\n')}</blockquote>`)
      quote = []
    }
  }

  let i = 0
  while (i < lines.length) {
    const line = lines[i]

    // Fenced code block ``` ... ``` -> <pre> (contents kept verbatim + escaped).
    if (/^\s*```/.test(line)) {
      flushQuote()
      const body = []
      i++
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        body.push(lines[i])
        i++
      }
      i++ // skip the closing fence (or run off the end if truncated)
      out.push(`<pre>${escapeHtml(body.join('\n'))}</pre>`)
      continue
    }

    // Blockquote: collect consecutive `>` lines into one <blockquote>.
    const bq = /^\s*>\s?(.*)$/.exec(line)
    if (bq) {
      quote.push(inline(bq[1]))
      i++
      continue
    }
    flushQuote()

    // Horizontal rule -> drop (Telegram has no <hr>). Must be checked before the
    // bullet rule so a `---` line isn't read as a list item.
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      i++
      continue
    }

    // Heading (#..######) -> bold line (Telegram has no headings).
    const h = /^\s*#{1,6}\s+(.*)$/.exec(line)
    if (h) {
      out.push(`<b>${inline(h[1].trim())}</b>`)
      i++
      continue
    }

    // Bullet list item -> `• `.
    const b = /^(\s*)[-*+]\s+(.*)$/.exec(line)
    if (b) {
      out.push(`${b[1]}\u2022 ${inline(b[2])}`)
      i++
      continue
    }

    // Numbered list item -> keep the number.
    const n = /^(\s*)(\d+)\.\s+(.*)$/.exec(line)
    if (n) {
      out.push(`${n[1]}${n[2]}. ${inline(n[3])}`)
      i++
      continue
    }

    out.push(inline(line))
    i++
  }
  flushQuote()

  return out.join('\n')
}
