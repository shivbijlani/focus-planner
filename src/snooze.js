import { normalizeRowCells } from './boardRow.js'

const SNOOZE_COMMENT_RE = /\s*<!--\s*snooze:(\d{4}-\d{2}-\d{2})\s*-->\s*$/i
const WAKE_COLUMN = 'Wake'

function parseCells(rawLine) {
  const s = String(rawLine || '').trim()
  if (!s.startsWith('|')) return []
  return s.split('|').slice(1, -1).map(c => c.trim())
}

/**
 * #426: read the row's cells **aligned to the header** before indexing `Wake`.
 *
 * Indexing the raw row is the same defect as the reader's: on a 6-field row
 * under the 7-column Deferred header, `cells[wakeIndex]` is the misfiled
 * `Linked ID`. That survived only because `normalizeDateOnly('191')` is null —
 * luck, not design. A misfiled value that *does* parse as a date would have
 * silently snoozed a live task.
 *
 * #446: `normalizeRowCells` additionally relocates a full-width row's misfiled
 * `Linked ID` out of `Wake` first. This is the load-bearing call for that fix —
 * `clearSnoozeUntilFromLine` blanks the wake cell, so without the relocation
 * the parent id is simply deleted and the wake date written on top of it.
 */
function wakeCells(rawLine, headers) {
  const cells = parseCells(rawLine)
  return Array.isArray(headers) && headers.length > 0
    ? normalizeRowCells(cells, headers)
    : cells
}

function wakeColumnIndex(headers) {
  if (!Array.isArray(headers)) return -1
  return headers.findIndex(h => String(h || '').trim() === WAKE_COLUMN)
}

function formatCells(cells) {
  return `| ${cells.join(' | ')} |`
}

export function parseSnoozeUntil(rawLine, headers = null) {
  const explicitWakeIndex = wakeColumnIndex(headers)
  if (explicitWakeIndex !== -1) {
    const wake = normalizeDateOnly(wakeCells(rawLine, headers)[explicitWakeIndex])
    if (wake) return wake
  } else {
    const cells = parseCells(rawLine)
    if (cells.length >= 7) {
      const inferredWake = normalizeDateOnly(cells[cells.length - 2])
      if (inferredWake) return inferredWake
    }
  }

  const match = String(rawLine || '').match(SNOOZE_COMMENT_RE)
  return match ? match[1] : null
}

/**
 * Read ONLY the legacy `<!-- snooze:DATE -->` trailer off a raw row, ignoring
 * any `Wake` column.
 *
 * `parseSnoozeUntil` answers "when does this row wake?" and prefers the column.
 * A writer migrating a row to the `Wake` schema needs the different question
 * "is there a legacy date here that I am about to destroy?", because the tail of
 * the line does not survive a `cells`/`formatRow` round-trip. Splitting the two
 * reads is what lets #307's migration be explicit instead of accidental.
 */
export function parseLegacySnoozeComment(rawLine) {
  const match = String(rawLine || '').match(SNOOZE_COMMENT_RE)
  return match ? match[1] : null
}

export function normalizeDateOnly(value) {
  const s = String(value || '').trim()
  const match = s.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return null
  const [, year, month, day] = match
  const date = new Date(Number(year), Number(month) - 1, Number(day))
  if (
    date.getFullYear() !== Number(year)
    || date.getMonth() !== Number(month) - 1
    || date.getDate() !== Number(day)
  ) {
    return null
  }
  return s
}

export function clearSnoozeUntilFromLine(rawLine, headers = null) {
  const cleanLine = String(rawLine || '').replace(SNOOZE_COMMENT_RE, '').trimEnd()
  const wakeIndex = wakeColumnIndex(headers)
  if (wakeIndex === -1) return cleanLine
  // #426: align first, and note this is the load-bearing one — `setSnooze…`
  // clears before it writes, so THIS is the call that decides which cell the
  // wake date lands in. Unaligned, `cells[wakeIndex]` on a ragged 6-field row is
  // the misfiled `Linked ID`, so clearing "the wake cell" deleted the link and
  // the subsequent write then put a date where the link had been.
  const cells = wakeCells(cleanLine, headers)
  if (cells.length <= wakeIndex) return cleanLine
  cells[wakeIndex] = ''
  return formatCells(cells)
}

export function setSnoozeUntilOnLine(rawLine, snoozeUntil, headers = null) {
  const cleanLine = clearSnoozeUntilFromLine(rawLine, headers)
  const date = normalizeDateOnly(snoozeUntil)
  const wakeIndex = wakeColumnIndex(headers)
  if (wakeIndex !== -1) {
    // #426: `clearSnoozeUntilFromLine` above has already aligned the row to the
    // header, so plain `parseCells` is correct here. Aligning a second time
    // would be unreachable defensive code — no mutation of it can be killed,
    // which is this repo's definition of a decorative guard.
    const cells = parseCells(cleanLine)
    if (cells.length > wakeIndex) {
      cells[wakeIndex] = date || ''
      return formatCells(cells)
    }
  }
  return date ? `${cleanLine} <!-- snooze:${date} -->` : cleanLine
}

export function getTodayDateString(now = new Date()) {
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-')
}

function dateFromDateOnly(dateString) {
  const normalized = normalizeDateOnly(dateString)
  if (!normalized) return null
  const [year, month, day] = normalized.split('-').map(Number)
  return new Date(year, month - 1, day)
}

export function addDaysToDateString(dateString, days) {
  const date = dateFromDateOnly(dateString)
  if (!date) return null
  date.setDate(date.getDate() + days)
  return getTodayDateString(date)
}

export function getNextSaturdayDateString(today = getTodayDateString()) {
  const date = dateFromDateOnly(today)
  if (!date) return null
  const day = date.getDay()
  const daysUntilSaturday = (6 - day + 7) % 7 || 7
  return addDaysToDateString(today, daysUntilSaturday)
}

export function isSnoozeActive(snoozeUntil, today = getTodayDateString()) {
  const snoozeDate = normalizeDateOnly(snoozeUntil)
  const todayDate = normalizeDateOnly(today)
  return Boolean(snoozeDate && todayDate && snoozeDate > todayDate)
}

export function formatSnoozeDate(dateString) {
  const date = dateFromDateOnly(dateString)
  if (!date) return dateString || ''
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date)
}
