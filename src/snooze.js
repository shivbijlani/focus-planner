const SNOOZE_COMMENT_RE = /\s*<!--\s*snooze:(\d{4}-\d{2}-\d{2})\s*-->\s*$/i
const WAKE_COLUMN = 'Wake'

function parseCells(rawLine) {
  const s = String(rawLine || '').trim()
  if (!s.startsWith('|')) return []
  return s.split('|').slice(1, -1).map(c => c.trim())
}

function wakeColumnIndex(headers) {
  if (!Array.isArray(headers)) return -1
  return headers.findIndex(h => String(h || '').trim() === WAKE_COLUMN)
}

function formatCells(cells) {
  return `| ${cells.join(' | ')} |`
}

export function parseSnoozeUntil(rawLine, headers = null) {
  const cells = parseCells(rawLine)
  const explicitWakeIndex = wakeColumnIndex(headers)
  if (explicitWakeIndex !== -1) {
    const wake = normalizeDateOnly(cells[explicitWakeIndex])
    if (wake) return wake
  } else if (cells.length >= 7) {
    const inferredWake = normalizeDateOnly(cells[cells.length - 2])
    if (inferredWake) return inferredWake
  }

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
  const cells = parseCells(cleanLine)
  if (cells.length <= wakeIndex) return cleanLine
  cells[wakeIndex] = ''
  return formatCells(cells)
}

export function setSnoozeUntilOnLine(rawLine, snoozeUntil, headers = null) {
  const cleanLine = clearSnoozeUntilFromLine(rawLine, headers)
  const date = normalizeDateOnly(snoozeUntil)
  const wakeIndex = wakeColumnIndex(headers)
  if (wakeIndex !== -1) {
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
