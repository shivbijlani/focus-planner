// Shared markdown block renderer — the journal's bespoke subset (no remark/marked).
//
// Extracted verbatim from App.jsx's JournalChatView (plans/docs-app-design.md action
// item 4) so the Docs app renders documents with the same renderer the journal uses.
// The journal passes no `opts`, and with no opts the output is byte-identical to the
// pre-extraction renderer (see MarkdownBlocks.test.jsx). Docs opt in to:
//   - opts.fences: render ``` / ~~~ fenced blocks as <pre><code> instead of paragraphs
//   - opts.linkHandler(href, label, key): return a node to override a link (doc: links)

// Render inline markdown (bold, italic, code) plus links to React nodes.
export function renderInlineFormatting(text, keyBase) {
  const nodes = []
  const re = /(\*\*([^*]+)\*\*|__([^_]+)__|`([^`]+)`|\*([^*]+)\*|(?<![A-Za-z0-9])_([^_]+)_(?![A-Za-z0-9]))/g
  let last = 0
  let m
  let idx = 0
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index))
    if (m[2] != null) nodes.push(<strong key={`${keyBase}-b${idx}`}>{m[2]}</strong>)
    else if (m[3] != null) nodes.push(<strong key={`${keyBase}-b${idx}`}>{m[3]}</strong>)
    else if (m[4] != null) nodes.push(<code className="jc-code" key={`${keyBase}-c${idx}`}>{m[4]}</code>)
    else if (m[5] != null) nodes.push(<em key={`${keyBase}-i${idx}`}>{m[5]}</em>)
    else if (m[6] != null) nodes.push(<em key={`${keyBase}-i${idx}`}>{m[6]}</em>)
    last = m.index + m[0].length
    idx++
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

// Render text with links first, then inline formatting on the plain segments.
export function renderInline(text, onNavigate, keyBase = 'k', opts) {
  const linkRe = /(!?)\[([^\]]+)\]\(([^)]+)\)/g
  const out = []
  let last = 0
  let m
  let idx = 0
  while ((m = linkRe.exec(text)) !== null) {
    if (m.index > last) out.push(...renderInlineFormatting(text.slice(last, m.index), `${keyBase}-t${idx}`))
    const isImage = m[1] === '!'
    const label = m[2]
    const href = m[3]
    const custom = !isImage && opts?.linkHandler ? opts.linkHandler(href, label, `${keyBase}-l${idx}`) : null
    if (custom) {
      out.push(custom)
    } else if (isImage) {
      out.push(
        <a key={`${keyBase}-imgl${idx}`} href={href} target="_blank" rel="noopener noreferrer" className="jc-image-link">
          <img src={href} alt={label} className="jc-image" loading="lazy" />
        </a>
      )
    } else if (href.startsWith('journal/') || href.endsWith('.md')) {
      out.push(
        <a key={`${keyBase}-l${idx}`} href="#" className="internal-link" onClick={(e) => { e.preventDefault(); onNavigate(href) }}>{label}</a>
      )
    } else {
      out.push(
        <a key={`${keyBase}-l${idx}`} href={href} target="_blank" rel="noopener noreferrer" className="external-link">{label}</a>
      )
    }
    last = m.index + m[0].length
    idx++
  }
  if (last < text.length) out.push(...renderInlineFormatting(text.slice(last), `${keyBase}-t${idx}`))
  return out
}

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/

// Render a block of journal lines into chat content (lists, todos, headings,
// tables, blockquotes, text). Uses an index loop so block elements (tables,
// blockquotes) can consume multiple consecutive lines.
export function renderJournalLines(lines, onNavigate, onToggle, ctx, opts) {
  const out = []
  let list = null
  const toggleProps = (idx) => (onToggle && ctx ? {
    className: 'jc-todo-toggle',
    role: 'button',
    tabIndex: 0,
    title: 'Click to toggle',
    onClick: () => onToggle(idx),
    onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(idx) } },
  } : {})
  const flush = () => {
    if (list) { out.push(<ul className="jc-list" key={`ul-${out.length}`}>{list}</ul>); list = null }
  }
  const inline = (text, key) => renderInline(text, onNavigate, key, opts)

  const isTableRow = (s) => /^\|.*\|\s*$/.test(s.trim())
  const isTableSep = (s) => /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(s.trim())
  const splitCells = (s) => s.trim().replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim())

  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim()
    let m

    // Docs only: a fenced block is literal code (the journal keeps its old rendering).
    if (opts?.fences && (m = lines[i].match(FENCE_RE))) {
      flush()
      const delim = m[1]
      const lang = m[2].trim()
      const body = []
      let j = i + 1
      while (j < lines.length && !(lines[j].trim().startsWith(delim[0].repeat(delim.length)) && lines[j].trim().replace(/[`~]/g, '') === '')) {
        body.push(lines[j])
        j++
      }
      out.push(<pre className="jc-pre" key={`pre-${i}`} data-lang={lang || undefined}><code>{body.join('\n')}</code></pre>)
      i = j
      continue
    }

    if (!t) { flush(); continue }

    // Markdown table: header row, separator row, then body rows.
    if (isTableRow(t) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      flush()
      const header = splitCells(t)
      const rows = []
      let j = i + 2
      while (j < lines.length && isTableRow(lines[j])) { rows.push(splitCells(lines[j])); j++ }
      out.push(
        <table className="jc-table" key={`tbl-${i}`}>
          <thead><tr>{header.map((h, hi) => <th key={hi}>{inline(h, `th${i}-${hi}`)}</th>)}</tr></thead>
          <tbody>{rows.map((r, ri) => (
            <tr key={ri}>{header.map((_, ci) => <td key={ci}>{inline(r[ci] || '', `td${i}-${ri}-${ci}`)}</td>)}</tr>
          ))}</tbody>
        </table>
      )
      i = j - 1
      continue
    }

    // Blockquote: one or more consecutive `>` lines.
    if (/^>\s?/.test(t)) {
      flush()
      const quote = [t.replace(/^>\s?/, '')]
      let j = i + 1
      while (j < lines.length && /^>\s?/.test(lines[j].trim())) { quote.push(lines[j].trim().replace(/^>\s?/, '')); j++ }
      out.push(<blockquote className="jc-quote" key={`q-${i}`}>{renderJournalLines(quote, onNavigate, undefined, undefined, opts)}</blockquote>)
      i = j - 1
      continue
    }

    // Checkbox items (bulleted or numbered): - [ ] / 1. [ ] / 1) [x]
    if ((m = t.match(/^(?:[-*+]|\d+[.)])\s*\[([ xX])\]\s*(.+)/))) {
      const done = m[1].toLowerCase() === 'x'
      const idx = ctx ? ctx.n++ : null
      list = list || []
      list.push(<li key={i} {...toggleProps(idx)}><span className={`jc-chip ${done ? 'done' : 'open'}`}>{done ? 'DONE' : 'TODO'}</span>{inline(m[2], `c${i}`)}</li>)
      continue
    }
    if ((m = t.match(/^-\s*TODO:\s*(.+)/i))) {
      const idx = ctx ? ctx.n++ : null
      list = list || []
      list.push(<li key={i} {...toggleProps(idx)}><span className="jc-chip open">TODO</span>{inline(m[1], `c${i}`)}</li>)
      continue
    }
    if ((m = t.match(/^-\s*DONE:\s*(.+)/i))) {
      const idx = ctx ? ctx.n++ : null
      list = list || []
      list.push(<li key={i} {...toggleProps(idx)}><span className="jc-chip done">DONE</span>{inline(m[1], `c${i}`)}</li>)
      continue
    }
    if ((m = t.match(/^[-*+]\s+(.+)/)) || (m = t.match(/^(\d+[.)])\s+(.+)/))) {
      const itemText = m[2] != null ? `${m[1]} ${m[2]}` : m[1]
      list = list || []
      list.push(<li key={i}>{inline(itemText, `c${i}`)}</li>)
      continue
    }

    flush()
    if (/^([-*_])\1{2,}$/.test(t)) {
      out.push(<hr className="jc-hr" key={i} />)
      continue
    }
    if ((m = t.match(/^#{2,6}\s+(.+)/))) {
      out.push(<div className="jc-subhead" key={i}>{inline(m[1], `h${i}`)}</div>)
      continue
    }
    out.push(<p className="jc-p" key={i}>{inline(t, `p${i}`)}</p>)
  }
  flush()
  return out
}
