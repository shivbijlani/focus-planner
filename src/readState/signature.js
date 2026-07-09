// Pure helper: compute a lightweight "newest-entry signature" for a journal.
//
// The signature is a compact string that changes whenever a journal gains new
// content, without hashing the whole file. It is intentionally dependency-free
// and side-effect-free so it can be unit tested in isolation and reused by any
// read-state provider.
//
// Shape: "<lastDate>|<dayCount>|<length>"
//   - lastDate : the most recent "## YYYY-MM-DD" heading in the file (or "-")
//   - dayCount : how many dated day-entries the journal has
//   - length   : total character length (catches same-day edits/appends)
//
// Comparing two signatures for inequality answers "has this journal changed
// since I last looked?" cheaply and deterministically.

const DAY_HEADING_RE = /^##\s+(\d{4}-\d{2}-\d{2})\b/gm

export function computeJournalSignature(content) {
  const text = typeof content === 'string' ? content : ''
  let lastDate = '-'
  let dayCount = 0
  let m
  DAY_HEADING_RE.lastIndex = 0
  while ((m = DAY_HEADING_RE.exec(text)) !== null) {
    dayCount += 1
    // Headings appear in file order; the last one wins as "newest entry".
    if (m[1] > lastDate || lastDate === '-') lastDate = m[1]
  }
  return `${lastDate}|${dayCount}|${text.length}`
}
