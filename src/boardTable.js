/**
 * The app-side board table reader (#426).
 *
 * Extracted out of `App.jsx` so it can be tested at all: nothing in the suite
 * imports `App.jsx` (it would pull in React and the whole component tree), so
 * the single most load-bearing parse in the app had no direct test — which is
 * how #426 survived. It is the reader half of the contract whose writer half
 * lives in `focusPlanOps.js`, and both now align rows through the same
 * `boardRow.js` rule.
 *
 * The defect this fixes: the reader keyed `Linked ID` by header **name** (good)
 * but then indexed the **raw** row (fatal). `## Deferred` has a 7-column header,
 * so `Linked ID` is index 6; a 6-field row has no index 6, so `cells[6]` was
 * `undefined` and the row read back as having no link — while the stray value
 * still rendered in the trailing `Wake` column. Aligning first is the whole fix.
 */
import { alignRowToHeaders } from './boardRow.js'
import { normalizeDateOnly, parseSnoozeUntil } from './snooze.js'

// Calculate days since a date
export function daysSince(dateStr) {
  if (!dateStr || dateStr === '-') return null
  const date = new Date(dateStr)
  if (isNaN(date.getTime())) return null
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const diffTime = today - date
  const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24))
  return diffDays
}

export function displayHeader(h) {
  if (h === 'Mngr Priority' || h === 'Work Priority') return 'Priority'
  return h
}

/**
 * Parse a markdown table into structured rows.
 *
 * Returns `headers` in **display** form (the `Linked ID` column removed — it is
 * folded into the ID cell — and `Added` renamed to `Age`), plus one `row` object
 * per data line keyed by those display headers, and the untouched `rawLines`
 * that the write ops match on.
 */
export function parseMarkdownTable(lines) {
  const rows = []
  const rawLines = []
  let headerParsed = false
  // The table's own header, kept intact: raw cells are indexed against THIS,
  // never against the display headers.
  let sourceHeaders = []
  let headers = []
  let linkedIdIndex = -1
  let wakeIndex = -1

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('|')) continue

    const cells = trimmed.split('|').slice(1, -1).map(c => c.trim())

    if (!headerParsed) {
      sourceHeaders = cells
      wakeIndex = sourceHeaders.indexOf('Wake')
      linkedIdIndex = sourceHeaders.findIndex(h => h.includes('Linked'))
      headers = sourceHeaders.filter((_, i) => i !== linkedIdIndex)
      // Replace "Added" with "Age" (the Added date is shown on hover)
      const addedIndex = headers.indexOf('Added')
      if (addedIndex !== -1) headers.splice(addedIndex, 1, 'Age')
      headerParsed = true
      continue
    }

    // Skip separator row
    if (cells.every(c => /^[-:]+$/.test(c))) continue

    // #426: align BEFORE indexing. A ragged row's trailing value is its
    // `Linked ID`, not its `Wake`.
    const aligned = alignRowToHeaders(cells, sourceHeaders)

    const row = {}
    const wakeValue = wakeIndex !== -1 ? normalizeDateOnly(aligned[wakeIndex]) : null
    const snoozeUntil = wakeValue || parseSnoozeUntil(trimmed, sourceHeaders)
    const linkedIdValue = linkedIdIndex !== -1 ? (aligned[linkedIdIndex] || '') : ''

    for (let i = 0; i < sourceHeaders.length; i++) {
      if (i === linkedIdIndex) continue
      const h = sourceHeaders[i]
      const value = aligned[i] || ''

      if (h === 'Added') {
        row['Added'] = value
        const days = daysSince(value)
        row['Age'] = days !== null ? `${days}d` : ''
      } else if (h === 'ID') {
        // Parse ID cell — may contain comma-separated local ID and ADO link
        // Format: "localId,[adoId](url)" or just "localId"
        let localId = value
        let adoLink = null
        const commaIdx = value.indexOf(',[')
        if (commaIdx !== -1) {
          localId = value.substring(0, commaIdx)
          const adoPart = value.substring(commaIdx + 1)
          const adoMatch = adoPart.match(/\[(\d+)\]\(([^)]+)\)/)
          if (adoMatch) {
            adoLink = { id: adoMatch[1], url: adoMatch[2] }
          }
        }
        row[h] = (linkedIdValue && linkedIdValue !== '-')
          ? { id: localId, linkedId: linkedIdValue, adoLink }
          : { id: localId, linkedId: null, adoLink }
      } else {
        row[h] = value
      }
    }

    row.snoozeUntil = snoozeUntil
    rows.push(row)
    rawLines.push(trimmed)
  }

  return { headers, rows, rawLines }
}
