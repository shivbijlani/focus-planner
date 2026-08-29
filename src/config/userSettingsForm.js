/**
 * Round-trip-safe structured view of `user-settings.md` (task #372, item 3).
 *
 * The overnight-agent config file is the user's **source of truth** — the plugin
 * reads it on every run and it holds real paths, accounts and allow-lists. So the
 * structured settings form must NEVER corrupt it. This module gives the UI an
 * ordered list of the editable **table rows** (the config knobs: paths, accounts,
 * on/off toggles) and a serializer that, on save, replaces ONLY the value cell of
 * a changed row inside the original text. The file is never regenerated:
 * intro prose, the `## Preferences` list, comments, blank lines, spacing and any
 * unknown sections are preserved byte-for-byte.
 *
 * Guarantees (see userSettingsForm.test.js):
 *  - Identity: `serializeSettingsForm(md, parseSettingsForm(md).map(r => r.value))`
 *    returns `md` unchanged (for any input, incl. CRLF and odd spacing).
 *  - Surgical edits: changing one field's value changes only that one cell.
 */

// Scan a single markdown table row into its cell segments (the text between
// consecutive unescaped pipes), keeping each segment's absolute start/end offset
// within the line so we can splice a value in place without touching anything
// else. Escaped pipes (`\|`) inside a cell are treated as literal, not delimiters.
function splitTableRow(line) {
  const pipes = []
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '|' && (i === 0 || line[i - 1] !== '\\')) pipes.push(i)
  }
  if (pipes.length < 2) return null
  const cells = []
  for (let p = 0; p < pipes.length - 1; p++) {
    const start = pipes[p] + 1
    const end = pipes[p + 1]
    cells.push({ start, end, text: line.slice(start, end) })
  }
  return cells
}

const SEPARATOR_CELL = /^\s*:?-{3,}:?\s*$/

/**
 * Parse `md` into an ordered list of editable table rows.
 * Each row: { section, label, value, line, valStart, valEnd }
 *  - `value` is the trimmed cell text (what the form input shows/edits).
 *  - `valStart`/`valEnd` bound the trimmed value inside `lines[line]`, so
 *    surrounding whitespace/padding is preserved on save.
 *
 * A row is only surfaced when it belongs to a `| Setting | Value |` table (the
 * header + `---` separator establish the table); rows outside such tables and
 * the separator/header rows themselves are skipped.
 */
export function parseSettingsForm(md) {
  if (typeof md !== 'string') return []
  const lines = md.split('\n')
  const rows = []
  let section = null
  let inTable = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const heading = line.match(/^#{1,6}\s+(.+?)\s*$/)
    if (heading) {
      section = heading[1].trim()
      inTable = false
      continue
    }
    if (!line.trimStart().startsWith('|')) {
      inTable = false
      continue
    }
    const cells = splitTableRow(line)
    if (!cells || cells.length < 2) {
      inTable = false
      continue
    }
    const label = cells[0].text.trim()
    const valueCell = cells[1]
    const valueTrimmed = valueCell.text.trim()
    // Header row of a Setting|Value table opens the table.
    if (label.toLowerCase() === 'setting' && valueTrimmed.toLowerCase() === 'value') {
      inTable = true
      continue
    }
    // Alignment/separator row (`| --- | --- |`) — stays in the table, not data.
    if (SEPARATOR_CELL.test(cells[0].text) && SEPARATOR_CELL.test(valueCell.text)) {
      continue
    }
    if (!inTable || !label) continue
    const padLeft = valueCell.text.length - valueCell.text.trimStart().length
    const padRight = valueCell.text.length - valueCell.text.trimEnd().length
    rows.push({
      section,
      label,
      value: valueTrimmed,
      line: i,
      valStart: valueCell.start + padLeft,
      valEnd: valueCell.end - padRight,
    })
  }
  return rows
}

/**
 * Produce a new markdown string with edited row values spliced back into the
 * original text. `updates` is an array aligned to `parseSettingsForm(md)` order;
 * each entry is the new value for that row (or null/undefined/unchanged to leave
 * it as-is). Only cells whose value actually changed are rewritten, and only the
 * value cell is touched — nothing else in the file moves.
 *
 * Newlines in a value are collapsed to spaces so a single table cell can't be
 * broken across lines (which would corrupt the table).
 */
export function serializeSettingsForm(md, updates) {
  if (typeof md !== 'string') return md
  const rows = parseSettingsForm(md)
  if (!rows.length) return md
  const lines = md.split('\n')
  // Apply per-line edits right-to-left so earlier offsets stay valid even if two
  // edited rows share a line (they never do, but this keeps splicing robust).
  const edits = []
  for (let k = 0; k < rows.length; k++) {
    const row = rows[k]
    const next = updates ? updates[k] : undefined
    if (next == null) continue
    const cleaned = String(next).replace(/[\r\n]+/g, ' ')
    if (cleaned === row.value) continue
    edits.push({ ...row, cleaned })
  }
  edits.sort((a, b) => (b.line - a.line) || (b.valStart - a.valStart))
  for (const e of edits) {
    const line = lines[e.line]
    lines[e.line] = line.slice(0, e.valStart) + e.cleaned + line.slice(e.valEnd)
  }
  return lines.join('\n')
}

/**
 * Group parsed rows by their `##` section, preserving first-seen order, so the
 * form can render section headers (Settings, Telegram, …). Returns
 * `[{ section, rows: [{ ...row, index }] }]` where `index` is the row's position
 * in the flat `parseSettingsForm` array (the key `serializeSettingsForm` expects).
 */
export function groupSettingsForm(md) {
  const rows = parseSettingsForm(md)
  const groups = []
  const bySection = new Map()
  rows.forEach((row, index) => {
    const key = row.section || ''
    let group = bySection.get(key)
    if (!group) {
      group = { section: row.section, rows: [] }
      bySection.set(key, group)
      groups.push(group)
    }
    group.rows.push({ ...row, index })
  })
  return groups
}

/**
 * Whether the file has any structured rows worth showing a form for. When false,
 * the UI should fall back to the raw editor.
 */
export function hasSettingsForm(md) {
  return parseSettingsForm(md).length > 0
}
