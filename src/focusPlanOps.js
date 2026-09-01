/**
 * Pure content-transformation operations on focus-plan.md.
 *
 * Each function takes (content, ...args) and returns a new content string
 * (or a small object describing extra side-effects that the caller must
 * perform — e.g. completed-task entries to write to a different file).
 *
 * Keeping these pure lets us reuse the exact same algorithms from both the
 * single-source FocusPlanView and the multi-source Combined view (where
 * each operation routes to whichever source the rawLine belongs to).
 */
import { diag, isDiagEnabled } from '../packages/diagnostics/src/index.js'
import { isPrioritiesSection } from './focusPlanShared.js'
import {
  clearSnoozeUntilFromLine,
  isSnoozeActive,
  normalizeDateOnly,
  parseLegacySnoozeComment,
  parseSnoozeUntil,
  setSnoozeUntilOnLine,
} from './snooze.js'

const PRIORITY_HEADING = '## Priorities'
const WAKE_COLUMN = 'Wake'
const MAX_TIMEOUT_MS = 2_147_483_647

function rowCells(line) {
  return String(line || '').trim().split('|').slice(1, -1).map(c => c.trim())
}

function formatRow(cells) {
  return `| ${cells.join(' | ')} |`
}

function isTableSeparatorCells(cells) {
  return cells.length > 0 && cells.every(c => /^[-:]+$/.test(c))
}

function findSectionTable(lines, section) {
  let currentSection = null
  let headerIndex = -1
  let separatorIndex = -1
  let endIndex = lines.length

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.startsWith('## ')) {
      if (currentSection === section) {
        endIndex = i
        break
      }
      currentSection = line.replace('## ', '').trim()
      continue
    }
    if (currentSection !== section) continue
    const trimmed = line.trim()
    if (!trimmed.startsWith('|')) continue
    const cells = rowCells(trimmed)
    if (headerIndex === -1 && !isTableSeparatorCells(cells)) {
      headerIndex = i
    } else if (headerIndex !== -1 && separatorIndex === -1 && isTableSeparatorCells(cells)) {
      separatorIndex = i
    }
  }

  const headers = headerIndex === -1 ? [] : rowCells(lines[headerIndex])
  return { headerIndex, separatorIndex, endIndex, headers }
}

function shouldHaveWakeColumn(section, headers) {
  return section === 'Deferred' && headers.includes('Added') && headers.some(h => h.includes('Linked'))
}

function wakeInsertIndex(headers) {
  const linkedIndex = headers.findIndex(h => h.includes('Linked'))
  return linkedIndex === -1 ? headers.length : linkedIndex
}

function isDataRowCells(cells) {
  return cells.length > 0 && !isTableSeparatorCells(cells) && cells[0] !== 'ID' && cells[0] !== '#'
}

/**
 * #307: report a wake date the writer could not carry across, instead of
 * dropping it silently.
 *
 * Same rule #190/PR #306 established one layer down (`phantom-meta-preserved` /
 * `alive-without-record`): a live value must never become a no-op. It is either
 * deliberately removed or it is a recoverable anomaly — never nothing. This is
 * that rule applied to the board writer, and it deliberately reuses the same
 * `diag`/`isDiagEnabled` mechanism rather than inventing a parallel channel.
 */
function reportWakeAnomaly(event, fields) {
  if (!isDiagEnabled()) return
  diag('planner.board', event, fields)
}

/**
 * Re-shape one table row so it has exactly `headers.length` cells (#307
 * guarantee 2: the writer must never emit a row whose cell count disagrees with
 * its section header).
 *
 * Padding position matters. The leading columns (ID, 🎯, Task, Priority, Added)
 * are positionally reliable, but the tail is not: a short row like
 * `| 446 | 🔴 | NVIDIA roles | - | 2026-08-24 | 295 |` carries `295` as its
 * **Linked ID**, and naively appending an empty cell at the end would leave
 * `295` sitting in the freshly inserted `Wake` slot — the live-board damage this
 * issue reports for #446/#356/#276 (a bogus wake value AND an apparently
 * parentless task, which breaks the upstream-context walk).
 *
 * So we split at `padIndex` (the Wake position): cells before it keep their
 * left-aligned positions, cells from it onward are kept **right-aligned** to the
 * end of the header. Missing cells are inserted at the seam.
 */
function normalizeRowToHeaders(cells, headers, padIndex) {
  const width = headers.length
  if (cells.length === width) return [...cells]
  const seam = Math.max(0, Math.min(padIndex, width))
  const head = cells.slice(0, seam)
  const tail = cells.slice(seam)
  if (cells.length < width) {
    const fill = new Array(width - head.length - tail.length).fill('')
    return [...head, ...fill, ...tail]
  }
  // Too many cells: keep the head and the right-most tail that still fits, so a
  // trailing Linked ID stays in the last column rather than shifting left.
  const keepTail = tail.slice(Math.max(0, tail.length - (width - head.length)))
  return [...head.slice(0, width - keepTail.length), ...keepTail]
}

/**
 * Bring the Deferred table up to the 7-column `Wake` schema (task #353/PR #126).
 *
 * #307 — this is where the data loss happened. The original loop was:
 *
 *   const cells = rowCells(lines[i])                       // drops the tail after the last `|`
 *   if (cells.length === table.headers.length) {           // …and skipped everything else
 *     cells.splice(insertIndex, 0, '')
 *     lines[i] = formatRow(cells)                          // rebuilt from cells only
 *   }
 *
 * which destroyed live data in two distinct ways, both reproduced in the tests:
 *
 *  1. **Dropped wake dates.** `rowCells` slices off whatever follows the final
 *     pipe, so a legacy `<!-- snooze:2026-09-08 -->` never reached `cells`, and
 *     `formatRow` rebuilt the row without it. The row came out well-formed with
 *     an **empty** Wake cell: the date was gone, with no tombstone and no log.
 *     That is #254 (2026-09-08) and #327 (2026-09-04) on the live board.
 *  2. **Malformed rows.** Any row whose cell count didn't equal the *old* header
 *     width was skipped entirely, so it kept its old width under the new
 *     7-column header. A trailing `295` (Linked ID) then sat in the `Wake`
 *     position — #446/#356/#276 rendering a bogus wake and reading as orphans.
 *
 * Now every data row is migrated: the legacy comment is read from the raw line
 * *before* any reshaping, the row is normalized to the header width with the
 * padding placed so trailing values stay in their own column, and the recovered
 * date is written into `Wake`. Anything that still cannot be carried across is
 * reported via `reportWakeAnomaly` rather than dropped.
 *
 * The migration pass also runs when the `Wake` column **already exists**. The
 * original early-return meant a legacy row arriving after the schema change —
 * synced from a replica still running the old build, or written by an external
 * agent following the older format that SKILL.md documents — would sit on the
 * board forever with its date in a comment the column-first reader ignores.
 */
function ensureWakeColumn(lines, section) {
  const table = findSectionTable(lines, section)
  if (!shouldHaveWakeColumn(section, table.headers) && !table.headers.includes(WAKE_COLUMN)) {
    return table
  }

  const alreadyPresent = table.headers.includes(WAKE_COLUMN)
  const insertIndex = alreadyPresent
    ? table.headers.indexOf(WAKE_COLUMN)
    : wakeInsertIndex(table.headers)
  const headers = [...table.headers]

  if (!alreadyPresent) {
    headers.splice(insertIndex, 0, WAKE_COLUMN)
    lines[table.headerIndex] = formatRow(headers)

    if (table.separatorIndex !== -1) {
      const separator = rowCells(lines[table.separatorIndex])
      separator.splice(insertIndex, 0, '----')
      lines[table.separatorIndex] = formatRow(separator)
    }
  }

  for (let i = table.separatorIndex + 1; i < table.endIndex; i++) {
    if (!lines[i]?.trim().startsWith('|')) continue
    const rawLine = lines[i]
    const cells = rowCells(rawLine)
    if (!isDataRowCells(cells)) continue

    // Read the legacy comment off the RAW line first — `rowCells` is about to
    // throw the tail away, and that discard is the whole bug.
    const legacyWake = parseLegacySnoozeComment(rawLine)
    const nextCells = normalizeRowToHeaders(cells, headers, insertIndex)
    const existingWake = normalizeDateOnly(nextCells[insertIndex])

    if (legacyWake && !existingWake) {
      nextCells[insertIndex] = legacyWake
    } else if (legacyWake && existingWake && existingWake !== legacyWake) {
      // The column already holds a date and the comment disagrees. The column is
      // the source of truth (`parseSnoozeUntil` prefers it), so keep it — but the
      // comment's value is about to stop existing, so say so.
      reportWakeAnomaly('wake-migration-conflict', {
        id: nextCells[0] ?? '', section, kept: existingWake, discarded: legacyWake,
      })
    }

    const migrated = formatRow(nextCells)
    if (legacyWake && !parseSnoozeUntil(migrated, headers)) {
      // Should be unreachable, but #307 is precisely a wake date that vanished
      // with nothing recording it. Never let that be silent again.
      reportWakeAnomaly('wake-migration-failed', {
        id: nextCells[0] ?? '', section, wake: legacyWake, row: rawLine.trim(),
      })
    }
    lines[i] = migrated
  }

  return findSectionTable(lines, section)
}

/**
 * #307 guarantee 2, as an inspectable predicate: every data row in a section
 * must have exactly as many cells as that section's header.
 *
 * Exported so both the writer's own tests and the (human-gated) repair path can
 * assert the invariant on real content instead of eyeballing it.
 */
export function findMalformedRows(content, section = 'Deferred') {
  const lines = String(content || '').split('\n')
  const table = findSectionTable(lines, section)
  if (table.headerIndex === -1) return []
  const width = table.headers.length
  const out = []
  for (let i = table.separatorIndex + 1; i < table.endIndex; i++) {
    const line = lines[i]
    if (!line?.trim().startsWith('|')) continue
    const cells = rowCells(line)
    if (!isDataRowCells(cells)) continue
    if (cells.length !== width) {
      out.push({ lineIndex: i, id: cells[0], cells: cells.length, expected: width, line: line.trim() })
    }
  }
  return out
}

/**
 * Re-shape a row from one section's header layout into another's.
 *
 * #307: this is the *second* place a wake date could evaporate. The first line
 * strips the legacy `<!-- snooze:DATE -->` trailer, and the `Wake` cell was then
 * sourced only from `sourceByHeader` — so moving a legacy-format row out of a
 * table that has no `Wake` column (Deferred → Today → Deferred, or a
 * "defer all below" sweep) silently discarded the date. Read the legacy trailer
 * off the raw line and use it as the fallback, so an explicit `wakeUntil` still
 * wins but nothing is lost when there isn't one.
 */
function transformRowForSection(rawLine, fromHeaders, toHeaders, { wakeUntil = null } = {}) {
  const legacyWake = parseLegacySnoozeComment(rawLine)
  const cleanLine = clearSnoozeUntilFromLine(rawLine, fromHeaders)
  const sourceCells = rowCells(cleanLine)
  if (!Array.isArray(fromHeaders) || fromHeaders.length === 0
      || !Array.isArray(toHeaders) || toHeaders.length === 0) {
    return cleanLine
  }

  const sourceByHeader = new Map()
  fromHeaders.forEach((header, index) => sourceByHeader.set(header, sourceCells[index] || ''))
  const cells = toHeaders.map(header => {
    if (header === WAKE_COLUMN) {
      return normalizeDateOnly(wakeUntil)
        || normalizeDateOnly(sourceByHeader.get(WAKE_COLUMN))
        || legacyWake
        || ''
    }
    return sourceByHeader.get(header) || ''
  })

  if (legacyWake && !toHeaders.includes(WAKE_COLUMN) && !normalizeDateOnly(wakeUntil)) {
    // The destination genuinely has nowhere to put a wake date (e.g. Today).
    // That is a legitimate clear, but the value still stops existing here, so it
    // must be recorded rather than dropped in silence — the #190/PR #306 rule.
    reportWakeAnomaly('wake-dropped-on-section-move', {
      id: cells[0] ?? '', wake: legacyWake, to: toHeaders.join('|'),
    })
  }
  return formatRow(cells)
}

// ── Section moves / row mutations ────────────────────────────────────

export function opMoveBetweenSections(content, rawLine, fromSection, toSection, options = {}) {
  const lines = content.split('\n')
  if (toSection === 'Deferred') ensureWakeColumn(lines, toSection)
  const fromTable = findSectionTable(lines, fromSection)
  const toTable = findSectionTable(lines, toSection)
  let inFromSection = false
  let inToSection = false
  let toSectionInsertIndex = -1
  let lineToRemoveIndex = -1
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.startsWith('## ')) {
      const sectionName = line.replace('## ', '').trim()
      inFromSection = sectionName === fromSection
      inToSection = sectionName === toSection
    }
    if (inToSection && line.trim().startsWith('|') && line.includes('---')) {
      toSectionInsertIndex = i + 1
    }
    if (inFromSection && line.trim() === rawLine) {
      lineToRemoveIndex = i
    }
  }
  if (lineToRemoveIndex === -1 || toSectionInsertIndex === -1) return content
  const removed = lines.splice(lineToRemoveIndex, 1)[0]
  if (lineToRemoveIndex < toSectionInsertIndex) toSectionInsertIndex--
  lines.splice(toSectionInsertIndex, 0, transformRowForSection(removed, fromTable.headers, toTable.headers, options))
  return lines.join('\n')
}

/**
 * Move multiple rows from one section to another in a single pass.
 *
 * Used by the "Defer all below" cut-line action: the caller supplies the
 * ordered list of raw lines (top-to-bottom as shown to the user) that should
 * move. Lines that aren't found in `fromSection` are silently skipped.
 * The moved rows are appended to the destination section in the supplied
 * order, immediately after the table separator row.
 */
export function opMoveLinesBetweenSections(content, rawLines, fromSection, toSection) {
  if (!Array.isArray(rawLines) || rawLines.length === 0) return content
  const targets = new Set(rawLines.map(l => l.trim()).filter(Boolean))
  if (targets.size === 0) return content

  const lines = content.split('\n')
  if (toSection === 'Deferred') ensureWakeColumn(lines, toSection)
  const fromTable = findSectionTable(lines, fromSection)
  const toTable = findSectionTable(lines, toSection)
  let currentSection = null
  let toSectionInsertIndex = -1
  const removeIndices = []
  const removedByLine = new Map()

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.startsWith('## ')) {
      currentSection = line.replace('## ', '').trim()
    }
    if (currentSection === toSection && toSectionInsertIndex === -1
        && line.trim().startsWith('|') && line.includes('---')) {
      toSectionInsertIndex = i + 1
    }
    if (currentSection === fromSection) {
      const trimmed = line.trim()
      if (targets.has(trimmed) && !removedByLine.has(trimmed)) {
        removeIndices.push(i)
        removedByLine.set(trimmed, line)
      }
    }
  }
  if (toSectionInsertIndex === -1 || removeIndices.length === 0) return content

  // Remove from highest index downward so earlier indices remain valid.
  removeIndices.sort((a, b) => b - a)
  for (const idx of removeIndices) {
    lines.splice(idx, 1)
    if (idx < toSectionInsertIndex) toSectionInsertIndex--
  }

  // Insert in the caller-provided order (top-to-bottom as displayed).
  const orderedRemoved = rawLines
    .map(l => removedByLine.get(l.trim()))
    .filter(v => v !== undefined)
    .map(line => transformRowForSection(line, fromTable.headers, toTable.headers))
  lines.splice(toSectionInsertIndex, 0, ...orderedRemoved)
  return lines.join('\n')
}

export function opChangePriority(content, rawLine, oldPriority, newPriority) {
  const newLine = rawLine.replace(oldPriority, newPriority)
  const lines = content.split('\n')
  const lineIndex = lines.findIndex(line => line.trim() === rawLine)
  if (lineIndex === -1) return content
  lines[lineIndex] = newLine
  return lines.join('\n')
}

export function opSetTaskSnooze(content, rawLine, snoozeUntil) {
  const lines = content.split('\n')
  const found = findTaskRow(content, rawLine)
  if (found.lineIndex === -1) return content
  if (found.section === 'Deferred') {
    ensureWakeColumn(lines, 'Deferred')
  }
  const table = findSectionTable(lines, found.section)
  lines[found.lineIndex] = setSnoozeUntilOnLine(lines[found.lineIndex], snoozeUntil, table.headers)
  return lines.join('\n')
}

function findTaskRow(content, rawLine) {
  const lines = content.split('\n')
  let section = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.startsWith('## ')) {
      section = line.replace('## ', '').trim()
    }
    if (line.trim() === rawLine) {
      return { lines, lineIndex: i, section }
    }
  }
  return { lines, lineIndex: -1, section: null }
}

export function opSnoozeTask(content, rawLine, snoozeUntil) {
  const { lines, lineIndex, section } = findTaskRow(content, rawLine)
  if (lineIndex === -1) return content

  if (snoozeUntil && section === 'Today') {
    return opMoveBetweenSections(content, rawLine, 'Today', 'Deferred', { wakeUntil: snoozeUntil })
  }

  if (!snoozeUntil && section === 'Deferred') {
    return opMoveBetweenSections(content, rawLine, 'Deferred', 'Today')
  }

  if (section === 'Deferred') ensureWakeColumn(lines, 'Deferred')
  const table = findSectionTable(lines, section)
  const nextLine = snoozeUntil
    ? setSnoozeUntilOnLine(lines[lineIndex], snoozeUntil, table.headers)
    : clearSnoozeUntilFromLine(lines[lineIndex], table.headers)
  lines[lineIndex] = nextLine
  return lines.join('\n')
}

export function opApplySnoozeTransitions(content, today) {
  let updated = content
  const lines = content.split('\n')
  let section = null
  let headers = []
  const activeToday = []
  const expiredDeferred = []

  for (const line of lines) {
    if (line.startsWith('## ')) {
      section = line.replace('## ', '').trim()
      continue
    }
    const trimmed = line.trim()
    if (!trimmed.startsWith('|')) continue
    const cells = trimmed.split('|').slice(1, -1).map(c => c.trim())
    if (cells[0] === 'ID' || cells[0] === '#') {
      headers = cells
      continue
    }
    if (cells.every(c => /^[-:]+$/.test(c))) continue
    const snoozeUntil = parseSnoozeUntil(trimmed, headers)
    if (!snoozeUntil) continue
    if (section === 'Deferred' && !isSnoozeActive(snoozeUntil, today)) {
      expiredDeferred.push(trimmed)
    } else if (section === 'Today' && isSnoozeActive(snoozeUntil, today)) {
      activeToday.push(trimmed)
    }
  }

  for (const rawLine of expiredDeferred) {
    updated = opSnoozeTask(updated, rawLine, null)
  }
  for (const rawLine of activeToday) {
    const snoozeUntil = parseSnoozeUntil(rawLine)
    updated = opSnoozeTask(updated, rawLine, snoozeUntil)
  }

  return updated
}

export function nextWakeTimeoutMs(content, now = new Date()) {
  const nowDate = now instanceof Date ? now : new Date(now)
  if (Number.isNaN(nowDate.getTime())) return null

  let section = null
  let headers = []
  let nextWakeAt = null
  for (const line of String(content || '').split('\n')) {
    if (line.startsWith('## ')) {
      section = line.replace('## ', '').trim()
      headers = []
      continue
    }
    if (section !== 'Deferred') continue
    const trimmed = line.trim()
    if (!trimmed.startsWith('|')) continue
    const cells = rowCells(trimmed)
    if (cells[0] === 'ID' || cells[0] === '#') {
      headers = cells
      continue
    }
    if (isTableSeparatorCells(cells)) continue
    const wake = parseSnoozeUntil(trimmed, headers)
    const normalized = normalizeDateOnly(wake)
    if (!normalized) continue
    const [year, month, day] = normalized.split('-').map(Number)
    const wakeAt = new Date(year, month - 1, day).getTime()
    if (wakeAt > nowDate.getTime() && (nextWakeAt === null || wakeAt < nextWakeAt)) {
      nextWakeAt = wakeAt
    }
  }
  if (nextWakeAt === null) return null
  return Math.min(MAX_TIMEOUT_MS, Math.max(0, nextWakeAt - nowDate.getTime()))
}

export function opDeleteTask(content, rawLine) {
  const lines = content.split('\n')
  const lineIndex = lines.findIndex(line => line.trim() === rawLine)
  if (lineIndex === -1) return content
  lines.splice(lineIndex, 1)
  return lines.join('\n')
}

export function opRenameTask(content, rawLine, newTaskName) {
  const lines = content.split('\n')
  const lineIndex = lines.findIndex(line => line.trim() === rawLine)
  if (lineIndex === -1) return content
  const parts = rawLine.split('|')
  if (parts.length < 4) return content
  parts[3] = ` ${newTaskName} `
  lines[lineIndex] = parts.join('|')
  return lines.join('\n')
}

/**
 * Find the table header row governing `lineIndex` by scanning upward for the
 * nearest header (a `|` row whose first cell is `ID`/`#`).
 *
 * Deliberately not section-based: several ops are called with bare tables that
 * have no `## Section` heading at all, and a row must still be written against
 * the header it actually lives under.
 */
function headersForLine(lines, lineIndex) {
  for (let i = lineIndex - 1; i >= 0; i--) {
    const trimmed = lines[i]?.trim()
    if (!trimmed) continue
    if (trimmed.startsWith('## ')) return []
    if (!trimmed.startsWith('|')) continue
    const cells = rowCells(trimmed)
    if (cells[0] === 'ID' || cells[0] === '#') return cells
  }
  return []
}

/**
 * Set a row's `Linked ID`, addressing the cell **by header** rather than by a
 * fixed offset.
 *
 * #307: this used a hardcoded `parts[6] = newLinkedId`. That offset is the last
 * cell of the OLD 6-column schema, but `Wake` is inserted immediately *before*
 * `Linked ID`, so on a 7-column row `parts[6]` is the **Wake** cell. Setting a
 * task's parent therefore wrote the parent id into the wake date and left the
 * real `Linked ID` untouched — the same "value lands in the wrong column"
 * corruption the issue reports for #446/#356/#276, but produced live, on every
 * edit, rather than once by the migration.
 *
 * Observed in the wild: #451 was a 6-cell row at 22:28 and read
 * `| 451 | 🔴 | Report hit and run | - | 2026-08-30 | 191 |` by 22:58 — the
 * `191` sitting in the position the 7-column header calls `Wake`.
 *
 * The row is also normalized to the header width on the way through, so this op
 * can no longer leave a malformed row behind either.
 */
export function opChangeLinkedId(content, rawLine, newLinkedId) {
  const lines = content.split('\n')
  // Rendered rows are trimmed by parseMarkdownTable, while CRLF-backed files
  // retain a trailing \r after split('\n'). Match their normalized row text.
  const lineIndex = lines.findIndex(line => line.trim() === rawLine.trim())
  if (lineIndex === -1) return content

  const headers = headersForLine(lines, lineIndex)
  const linkedIndex = headers.findIndex(h => h.includes('Linked'))
  if (linkedIndex === -1) {
    // No header to address by (e.g. a headerless fragment): keep the historical
    // positional behaviour rather than guessing.
    const parts = rawLine.split('|')
    if (parts.length < 7) return content
    parts[6] = ` ${newLinkedId || ''} `
    lines[lineIndex] = parts.join('|')
    return lines.join('\n')
  }

  const wakeIndex = headers.indexOf(WAKE_COLUMN)
  const padIndex = wakeIndex === -1 ? headers.length : wakeIndex
  const cells = normalizeRowToHeaders(rowCells(lines[lineIndex]), headers, padIndex)
  cells[linkedIndex] = newLinkedId || ''
  const hadCarriageReturn = lines[lineIndex].endsWith('\r')
  lines[lineIndex] = formatRow(cells) + (hadCarriageReturn ? '\r' : '')
  return lines.join('\n')
}

export function opLinkToAdoBugDb(content, rawLine, adoLink) {
  const lines = content.split('\n')
  const lineIndex = lines.findIndex(line => line.trim() === rawLine)
  if (lineIndex === -1) return content
  const parts = rawLine.split('|')
  if (parts.length < 3) return content
  const currentId = parts[1].trim()
  const commaIdx = currentId.indexOf(',[')
  const localId = commaIdx !== -1 ? currentId.substring(0, commaIdx) : currentId
  if (adoLink) {
    parts[1] = ` ${localId},[${adoLink.id}](${adoLink.url}) `
  } else {
    parts[1] = ` ${localId} `
  }
  lines[lineIndex] = parts.join('|')
  return lines.join('\n')
}

// ── Add / promote ────────────────────────────────────────────────────

function extractTicketIdFromUrl(url) {
  const endMatch = url.match(/\/(\d+)\/?(?:[?#].*)?$/)
  if (endMatch) return endMatch[1]
  const midMatch = url.match(/\/(\d{5,})\//)
  if (midMatch) return midMatch[1]
  return null
}

function findInsertAndMaxId(lines, section) {
  let inTargetSection = false
  let insertIndex = -1
  let maxId = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.startsWith('## ')) {
      inTargetSection = line.replace('## ', '').trim() === section
    }
    if (inTargetSection && insertIndex === -1 && line.trim().startsWith('|') && line.includes('---')) {
      insertIndex = i + 1
    }
    if (line.trim().startsWith('|')) {
      const cells = line.split('|').slice(1, -1).map(c => c.trim())
      if (cells.length >= 1 && cells[0] !== 'ID' && !/^[-:]+$/.test(cells[0])) {
        const numMatch = cells[0].match(/^(\d+)/)
        if (numMatch) maxId = Math.max(maxId, parseInt(numMatch[1], 10))
      }
    }
  }
  return { insertIndex, maxId }
}

/**
 * Allocate the next task ID.
 *
 * Numbering is driven by the planner's own task rows (`contentMaxId`), NOT by
 * the journal folder. Existing journal IDs are only used as a collision-skip
 * set so we never reuse an ID whose journal still exists. This means a stray
 * or foreign high-numbered journal (e.g. one copied in from another folder)
 * can no longer inflate the numbering — it simply isn't contiguous with
 * `contentMaxId + 1`, so the skip loop never reaches it.
 *
 * `existingJournalIds` may be a Set<number>; any other value (including the
 * legacy numeric `baselineMaxId`) is ignored so old callers stay correct.
 */
export function allocateNextId(contentMaxId, existingJournalIds) {
  const ids = existingJournalIds instanceof Set ? existingJournalIds : null
  let id = (contentMaxId || 0) + 1
  if (ids) {
    while (ids.has(id)) id++
  }
  return id
}

export function opAddTask(content, { task, priority, linkedTask, section }, existingJournalIds = new Set()) {
  const lines = content.split('\n')
  if (section === 'Deferred') ensureWakeColumn(lines, 'Deferred')
  const { insertIndex, maxId } = findInsertAndMaxId(lines, section)
  if (insertIndex === -1) return content
  const newId = allocateNextId(maxId, existingJournalIds)
  const today = new Date().toISOString().split('T')[0]
  const trimmedLinked = linkedTask ? linkedTask.trim() : ''
  const isUrl = /^https?:\/\//.test(trimmedLinked)
  let idCell
  let linkedCell = ''
  if (isUrl) {
    const adoId = extractTicketIdFromUrl(trimmedLinked)
    if (adoId) {
      idCell = `${newId},[${adoId}](${trimmedLinked.replace(/\/$/, '')})`
    } else {
      idCell = String(newId)
      linkedCell = trimmedLinked
    }
  } else {
    idCell = String(newId)
    linkedCell = trimmedLinked
  }
  const table = findSectionTable(lines, section)
  const row = transformRowForSection(
    formatRow([idCell, priority, task, '-', today, linkedCell]),
    ['ID', '🎯', 'Task', table.headers.find(h => h.includes('Priority')) || 'Priority', 'Added', 'Linked ID'],
    table.headers,
  )
  lines.splice(insertIndex, 0, row)
  return { content: lines.join('\n'), newId }
}

export function opPromoteTodoToTask(content, todoText, parentTaskId, existingJournalIds = new Set()) {
  const lines = content.split('\n')
  const { insertIndex, maxId } = findInsertAndMaxId(lines, 'Today')
  if (insertIndex === -1) return content
  const newId = allocateNextId(maxId, existingJournalIds)
  const today = new Date().toISOString().split('T')[0]
  const cleanText = todoText.replace(/^TODO:\s*/i, '').trim()
  const row = `| ${newId} | 🟡 | ${cleanText} | - | ${today} | ${parentTaskId} |`
  lines.splice(insertIndex, 0, row)
  return { content: lines.join('\n'), newId }
}

export function opAddAndPrioritize(content, taskName, prioritySectionTitle, existingJournalIds = new Set()) {
  const lines = content.split('\n')
  const { insertIndex, maxId } = findInsertAndMaxId(lines, 'Today')
  if (insertIndex === -1) return content
  const newId = allocateNextId(maxId, existingJournalIds)
  const today = new Date().toISOString().split('T')[0]
  lines.splice(insertIndex, 0, `| ${newId} | 🟡 | ${taskName} | - | ${today} | |`)

  let inPriority = false
  let lastNumIndex = -1
  let numCount = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.startsWith('## ')) {
      if (inPriority) break
      inPriority = line.replace('## ', '').trim() === prioritySectionTitle
    }
    if (inPriority && /^\d+\.\s+/.test(line.trim())) {
      lastNumIndex = i
      numCount++
    }
  }
  const priorityLine = `${numCount + 1}. ${newId}`
  if (lastNumIndex >= 0) {
    lines.splice(lastNumIndex + 1, 0, priorityLine)
  } else {
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('## ') && lines[i].replace('## ', '').trim() === prioritySectionTitle) {
        lines.splice(i + 1, 0, priorityLine)
        break
      }
    }
  }
  return { content: lines.join('\n'), newId }
}

// ── Manager priorities (Priorities section) ──────────────────────────

function findPrioritiesRange(lines) {
  let start = -1
  let end = lines.length
  let title = null
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim()
    if (trimmed.startsWith('## ')) {
      const t = trimmed.replace(/^##\s+/, '')
      if (start === -1 && isPrioritiesSection(t)) {
        start = i
        title = t
      } else if (start !== -1) {
        end = i
        break
      }
    }
  }
  return { start, end, title }
}

export function opUpdateManagerPriorities(content, newPriorityLines) {
  const lines = content.split('\n')
  const { start, end, title } = findPrioritiesRange(lines)
  if (start === -1) {
    // No Priorities section yet — append one.
    return content.trimEnd() + '\n\n' + PRIORITY_HEADING + '\n\n' + newPriorityLines.join('\n') + '\n'
  }
  const before = lines.slice(0, start)
  const after = lines.slice(end)
  // Always normalize the heading to "## Priorities".
  const heading = title === 'Priorities' ? lines[start] : '## Priorities'
  const out = [...before, heading, '', ...newPriorityLines, '', ...after]
  return out.join('\n')
}

export function opPromoteToManagerPriority(content, taskId) {
  const lines = content.split('\n')
  const { start, end } = findPrioritiesRange(lines)
  if (start === -1) {
    return content.trimEnd() + '\n\n' + PRIORITY_HEADING + '\n\n1. ' + taskId + '\n'
  }
  let lastNumIndex = -1
  let maxNum = 0
  for (let i = start + 1; i < end; i++) {
    const m = lines[i].trim().match(/^(\d+)\.\s+/)
    if (m) {
      lastNumIndex = i
      maxNum = Math.max(maxNum, parseInt(m[1], 10))
    }
  }
  const newLine = `${maxNum + 1}. ${taskId}`
  if (lastNumIndex >= 0) {
    lines.splice(lastNumIndex + 1, 0, newLine)
  } else {
    lines.splice(start + 1, 0, newLine)
  }
  return lines.join('\n')
}

/**
 * Bridge links when a task is deleted or completed.
 * If task A links to task B, and task B is being removed,
 * task A should now link to whatever task B was linked to (task C).
 */
export function opBridgeLinks(content, removedId, nextIdRawValue) {
  const lines = content.split('\n')
  const newLines = lines.map(line => {
    if (!line.trim().startsWith('|')) return line
    const parts = line.split('|')
    if (parts.length < 7) return line

    // Skip header and separator
    if (parts[1].trim() === 'ID' || parts[1].trim().startsWith('---')) return line

    const currentLinkedId = parts[6].trim()
    if (currentLinkedId === String(removedId)) {
      parts[6] = ` ${nextIdRawValue || ''} `
      return parts.join('|')
    }
    return line
  })
  return newLines.join('\n')
}

export function opRemoveFromManagerPriority(content, taskId) {
  const lines = content.split('\n')
  const { start, end } = findPrioritiesRange(lines)
  if (start === -1) return content
  const before = lines.slice(0, start + 1)
  const sectionBody = lines.slice(start + 1, end).filter(line => {
    const m = line.trim().match(/^\d+\.\s+(.+)$/)
    return !(m && m[1].trim() === taskId)
  })
  let num = 1
  const renumbered = sectionBody.map(line => {
    const m = line.trim().match(/^\d+\.\s+(.+)$/)
    if (m) return `${num++}. ${m[1]}`
    return line
  })
  const after = lines.slice(end)
  return [...before, ...renumbered, ...after].join('\n')
}

// ── Move-to-completed ───────────────────────────────────────────────
//
// Splits the work between two files — focus-plan.md (remove the row) and
// focus-plan-completed.md (append the row, possibly creating a weekly
// section). Each file edit is returned so the caller can write them in
// the right order to the right source.

// Reports whether the row was actually removed. A move-to-completed that
// appends to the completed board but silently fails to remove the source row
// leaves the task on BOTH boards, so the caller must be able to tell the
// difference between "removed" and "found nothing".
export function opRemoveTaskFromFocusPlanResult(content, rawLine, fromSection) {
  const lines = content.split('\n')
  const target = normalizeRow(rawLine)
  let inFromSection = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.startsWith('## ')) {
      inFromSection = line.replace('## ', '').trim() === fromSection
    }
    if (inFromSection && target && normalizeRow(line) === target) {
      lines.splice(i, 1)
      return { content: lines.join('\n'), removed: true }
    }
  }
  return { content, removed: false }
}

// Compare rows on their cell values, so a stray \r (CRLF sources) or drifting
// padding inside the markdown table can't make an exact-string match miss.
function normalizeRow(line) {
  return (line || '').replace(/\r/g, '').trim().replace(/\s*\|\s*/g, '|')
}

export function opRemoveTaskFromFocusPlan(content, rawLine, fromSection) {
  return opRemoveTaskFromFocusPlanResult(content, rawLine, fromSection).content
}

export function buildCompletedRow({ taskId, taskName, priority, todoItems = [], outcome = '' }) {
  const today = new Date().toISOString().split('T')[0]
  let displayName = (taskName || '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
  if (todoItems.length > 0) displayName += ' - ' + todoItems.join(' - ')
  // Stamp the optional close-out outcome inline on the task cell so the
  // completed board stays skimmable. Sanitize pipes so it can't break the row.
  const cleanOutcome = (outcome || '').replace(/\|/g, '/').trim()
  if (cleanOutcome) displayName += ` · _${cleanOutcome}_`
  return `| ${taskId || '-'} | ✅ | ${displayName} | ${priority || '-'} | ${today} |`
}

// True when the completed board already carries a row for this task id.
// Guards the append against re-entry: the completed write happens before the
// plan write, so a failed/retried move would otherwise stack duplicate rows.
export function completedRowExistsForTask(completedContent, taskId) {
  if (!taskId) return false
  const id = String(taskId).trim()
  if (!id || id === '-') return false
  return (completedContent || '')
    .split('\n')
    .some(line => {
      const m = line.replace(/\r/g, '').match(/^\s*\|\s*([^|]+?)\s*\|/)
      return m ? m[1] === id : false
    })
}

export function opAppendToCompleted(completedContent, completedRow, { taskId = '' } = {}) {
  if (completedRowExistsForTask(completedContent, taskId)) return completedContent
  const lines = (completedContent || '# Completed Tasks\n').split('\n')
  const now = new Date()
  const dayOfWeek = now.getDay()
  const monday = new Date(now)
  monday.setDate(now.getDate() - ((dayOfWeek + 6) % 7))
  const weekLabel = `${monday.getMonth() + 1}/${monday.getDate()}/${monday.getFullYear()}`
  const weekHeader = `## Week of ${weekLabel}`
  let insertIndex = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === weekHeader) {
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim().startsWith('|') && lines[j].includes('---')) {
          insertIndex = j + 1
          break
        }
      }
      break
    }
  }
  if (insertIndex === -1) {
    let headerIndex = lines.findIndex(l => l.startsWith('# Completed Tasks'))
    if (headerIndex === -1) headerIndex = 0
    lines.splice(headerIndex + 1, 0,
      '',
      weekHeader,
      '',
      '| # | 🎯 | Task | Work Priority | Completed Date |',
      '|---|---|------|---------------|----------------|',
      completedRow,
    )
  } else {
    lines.splice(insertIndex, 0, completedRow)
  }
  return lines.join('\n')
}
