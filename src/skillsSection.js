/**
 * Parsing for the read-only `## Skills` board section (GH #188, board task #357).
 *
 * The planner *surfaces* skills; it never edits them. Authoring stays in the
 * OneDrive skills library + harness junctions (see the `new-skill-with-symlink`
 * skill), so everything here is read-only by construction.
 *
 * Keep this module dependency-free — same contract as `boardSearch.js` /
 * `focusPlanShared.js` — so it can be unit-tested without React or storage.
 */

export const SKILLS_SECTION_TITLE = 'Skills'

/** Canonical column order. Anything else in the table is still rendered. */
export const SKILLS_COLUMNS = ['Skill', 'Purpose', 'Source', 'Picked up by', 'Active tasks']

/** The cell that carries `#123` task references. */
export const ACTIVE_TASKS_COLUMN = 'Active tasks'

export function isSkillsSection(title) {
  return String(title == null ? '' : title).trim() === SKILLS_SECTION_TITLE
}

/**
 * Find the `## Skills` section among `parseFocusPlan()` output.
 * Returns the section (`{ title, lines }`) or `null` when the board has none —
 * callers render nothing at all in that case (no empty placeholder).
 */
export function findSkillsSection(sections) {
  if (!Array.isArray(sections)) return null
  return sections.find(s => s && isSkillsSection(s.title)) || null
}

function splitRow(trimmed) {
  return trimmed.split('|').slice(1, -1).map(c => c.trim())
}

function isSeparatorRow(cells) {
  return cells.length > 0 && cells.every(c => /^:?-{1,}:?$/.test(c))
}

/**
 * Parse the markdown table inside a `## Skills` section.
 *
 * Deliberately *not* reusing App.jsx's `parseMarkdownTable`: that one rewrites
 * task-board headers (drops `Linked ID`, renames `Added` → `Age`), which would
 * corrupt skill columns. This is a plain, faithful table read.
 *
 * Returns `{ headers, rows, notes }`:
 *  - `rows` are objects keyed by header, in table order.
 *  - `notes` are the non-table prose lines (e.g. the generator's timestamp),
 *    so the section can show its provenance without inventing it.
 */
export function parseSkillsTable(lines) {
  const headers = []
  const rows = []
  const notes = []
  let headerParsed = false

  for (const line of Array.isArray(lines) ? lines : []) {
    const trimmed = String(line == null ? '' : line).trim()
    if (!trimmed.startsWith('|')) {
      if (trimmed && !trimmed.startsWith('#')) notes.push(trimmed)
      continue
    }
    const cells = splitRow(trimmed)
    if (isSeparatorRow(cells)) continue
    if (!headerParsed) {
      headers.push(...cells)
      headerParsed = true
      continue
    }
    const row = {}
    headers.forEach((h, i) => { row[h] = cells[i] === undefined ? '' : cells[i] })
    rows.push(row)
  }

  return { headers, rows, notes }
}

/**
 * Whole-section parse: `null` when there is no `## Skills` heading, otherwise
 * the parsed table. A heading with no table yields empty `headers`/`rows`,
 * which callers treat as "nothing to render".
 */
export function parseSkillsSection(sections) {
  const section = findSkillsSection(sections)
  if (!section) return null
  return parseSkillsTable(section.lines)
}

/** True when there is a `## Skills` section with at least one skill row. */
export function hasRenderableSkills(parsed) {
  return !!parsed && Array.isArray(parsed.rows) && parsed.rows.length > 0
}

/**
 * Split a cell into plain-text and `#123` task-reference segments so the
 * renderer can make the references clickable without doing its own regex.
 *
 * Returns `[{ type: 'text' | 'ref', value }]`; a `ref`'s `value` is the bare
 * numeric id (no `#`), which is what `scrollToAndFlashTask` expects.
 */
export function splitTaskRefs(text) {
  const s = String(text == null ? '' : text)
  if (!s) return []
  const out = []
  const re = /#(\d+)\b/g
  let last = 0
  let m
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) out.push({ type: 'text', value: s.slice(last, m.index) })
    out.push({ type: 'ref', value: m[1] })
    last = m.index + m[0].length
  }
  if (last < s.length) out.push({ type: 'text', value: s.slice(last) })
  return out
}

/** Every task id referenced by a skill row's "Active tasks" cell. */
export function extractTaskRefs(text) {
  return splitTaskRefs(text).filter(p => p.type === 'ref').map(p => p.value)
}

/**
 * Strip the surrounding backticks the inventory uses for skill names, so the
 * table can style them itself instead of showing literal backticks.
 */
export function stripCode(text) {
  const s = String(text == null ? '' : text).trim()
  const m = s.match(/^`(.+)`$/)
  return m ? m[1] : s
}
