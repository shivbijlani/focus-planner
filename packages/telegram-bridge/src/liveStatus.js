// liveStatus.js — "what is this task's LIVE status?", for the digest.
//
// WHY THIS EXISTS (#202)
// ---------------------
// `syncDigest()` used to decide "is this task finished?" by reading
// `agentBlockStatus(agentBlockText(content))` — a `**Status:**` line near the top
// of the sentinel block. **Nothing writes that line any more.** Since 2026-08-26
// the only sanctioned journal writer is `write-turn.ps1`, which is deliberately
// append-only so it can never delete one of the user's replies; it has no
// parameter that can touch an existing line. So the header freezes at whatever it
// said the day the block was created, while the agent's real status moves on in
// appended turns.
//
// The consequence is that a task the agent has FINISHED never leaves the approval
// queue. Measured on the live corpus (239 journals): 10 headers disagreed with the
// date-arbitrated live status, 9 of them on the active board, staleness up to 73
// days. Controlled experiment: flipping ONE frozen header line (#232, from
// `blocked · 2026-06-19` to `Done · 2026-08-27`) and changing nothing else took the
// digest from 133 open asks to 132, with #232 absent.
//
// There is a second, larger fault mixed into the same call. `agentBlockStatus`
// captures `([A-Za-z-]+)`, which stops at a space, so the human dialect
// `In progress` parses to the bare token `in` — not a status at all. 18 of the 32
// rows `drift-sweep [G]` prints every run are this, not real drift.
//
// RELATIONSHIP TO `plugins/overnight-agent/checks/lib-live-status.mjs`
// -------------------------------------------------------------------
// That file solved this correctly for the sweeps in Aug 2026 and carries the
// corpus-tested arbitration rules. It is NOT imported here, and that is deliberate:
// the checks are deployed as FLAT files into `%LOCALAPPDATA%\overnight-agent\`,
// while this package runs from the repo, so a relative import across the two would
// resolve in the repo and break in the deployed copy — the "merged but not running"
// failure class. Sweeps that need bridge source already reach for it through the
// `BRIDGE_SRC` env var for the same reason, in the other direction.
//
// So the two are intentional twins, and are pinned together by
// `checks/mutcheck-live-status-parity.mjs`, which imports BOTH (this one via
// `BRIDGE_SRC`) and fails if they disagree on any fixture or on any live journal.
// Change one, and the check tells you to change the other.

const AGENT = '<!-- from: overnight-agent -->'
const USER = '<!-- from: me -->'
const SENTINEL = '<!-- OVERNIGHT-AGENT'

// Capture the status PHRASE: everything after `Status:` up to the first separator.
// Separators seen live: `·` (middot), `|`, or end of line.
const rxStatusLine = /^[ \t]*\*{0,2}Status:?\*{0,2}[ \t]*:?[ \t]*\*{0,2}([^\n\u00b7|]*)/m
// Global twin of the above, derived from one source so the two cannot diverge.
const rxStatusLineG = new RegExp(rxStatusLine.source, 'gm')
const rxDate = /(\d{4}-\d{2}-\d{2})/
const rxHeader = /^##[ \t]+(\d{4}-\d{2}-\d{2})/gm

export const CANONICAL = ['proposed', 'approved', 'revise', 'in-progress', 'blocked', 'done', 'skip']

/**
 * The STAMP date of a Status line — the date the line asserts about itself, as
 * opposed to a date it merely mentions in prose.
 *
 * Taking the first date is wrong (`Done — shipped 2026-07-18 …; postmortem written
 * 2026-08-22. — 2026-08-22`) and so is taking the last (`Done · 2026-08-23 — trip
 * completed 2026-08-01`). The structural cue is POSITION: the template writes the
 * stamp as its own `·`-delimited segment, while a mentioned date is embedded in a
 * clause. So take the LAST segment that is nothing but a date, falling back to the
 * first date on the line.
 */
export function statusStampDate(line) {
  if (!line) return null
  const segments = String(line).split(/[\u00b7|\u2014\u2013]|(?:\s-\s)/)
  for (let i = segments.length - 1; i >= 0; i--) {
    const bare = segments[i].replace(/[*_`()[\]{}.,;:"']/g, ' ').trim()
    if (/^\d{4}-\d{2}-\d{2}$/.test(bare)) return bare
  }
  const m = rxDate.exec(String(line))
  return m ? m[1] : null
}

/**
 * Map a free-text status phrase onto the canonical vocabulary.
 * Returns null when the phrase does not name a canonical status.
 *
 * This is the half that fixes the dialect fault: `In progress` (with a space) and
 * `In-progress` both reach `in-progress`, where the old `([A-Za-z-]+)` capture
 * produced `in`.
 */
export function normaliseStatus(phrase) {
  if (!phrase) return null
  let s = String(phrase).replace(/[*_`]/g, '').trim().toLowerCase()
  s = s.replace(/\s*[\u2014\u2013]\s.*$/, '').trim() // " — waiting on you"
  if (!s) return null
  if (/^in[\s-]?progress/.test(s)) return 'in-progress'
  if (/^(done|complete[d]?)\b/.test(s)) return 'done'
  if (/^skip(ped)?\b/.test(s)) return 'skip'
  if (/^propos/.test(s)) return 'proposed'
  if (/^approv/.test(s)) return 'approved'
  if (/^revis/.test(s)) return 'revise'
  if (/^block/.test(s)) return 'blocked'
  return null
}

function allIndexes(hay, needle) {
  const out = []
  let i = hay.indexOf(needle)
  while (i !== -1) {
    out.push(i)
    i = hay.indexOf(needle, i + needle.length)
  }
  return out
}

/**
 * One slice can hold MORE THAN ONE agent block, because the agent appends further
 * `## 🌙 Overnight Agent` blocks without necessarily emitting a new `from:` marker.
 * First-match returns whichever status sits highest, which is the wrong one.
 *
 * Two rules were tried and falsified by the live corpus rather than by argument:
 *   1. "Take the last" — some journals follow the real status line with an italic
 *      prose note that also opens with the word Status, which normalises to nothing.
 *   2. "Take the last CANONICAL one" — still POSITION, and position is not time. A
 *      block whose Status line is rewritten in place can sit ABOVE a historical
 *      sub-block, and last-canonical walks the task back a month.
 *
 * So arbitrate BY DATE, NOT BY POSITION. Newest stamp wins; a tie keeps the
 * positionally later line; with no stamps anywhere, fall back to the last canonical,
 * which is the bottom-appended default. Single-Status slices are unaffected.
 */
function statusFromSlice(slice, sourcePrefix) {
  rxStatusLineG.lastIndex = 0
  const cands = []
  let lastAny = null
  let m
  while ((m = rxStatusLineG.exec(slice)) !== null) {
    lastAny = m
    const raw = m[1].trim()
    if (normaliseStatus(raw) !== null) {
      const line = slice.slice(m.index).split(/\r?\n/)[0].trim()
      cands.push({ m, line, date: statusStampDate(line) })
    }
    if (m.index === rxStatusLineG.lastIndex) rxStatusLineG.lastIndex++ // zero-width guard
  }

  let hit = null
  if (cands.length) {
    const dated = cands.filter((c) => c.date)
    // `>=` so that among equal dates the positionally later line wins.
    hit = dated.length
      ? dated.reduce((best, c) => (c.date >= best.date ? c : best)).m
      : cands[cands.length - 1].m
  }
  if (!hit) hit = lastAny
  if (!hit) return null
  const raw = hit[1].trim()
  const line = slice.slice(hit.index).split(/\r?\n/)[0].trim()
  return {
    status: normaliseStatus(raw),
    raw,
    line,
    date: statusStampDate(line),
    source: sourcePrefix,
  }
}

/** Offsets of every `## YYYY-MM-DD` chat header, so an undated turn can still be dated. */
function headerDates(text) {
  const out = []
  rxHeader.lastIndex = 0
  let m
  while ((m = rxHeader.exec(text)) !== null) out.push({ off: m.index, date: m[1] })
  return out
}

/** The date of the nearest `## YYYY-MM-DD` header at or above `off`. */
function headerDateFor(headers, off) {
  let best = null
  for (const h of headers) {
    if (h.off <= off) best = h.date
    else break
  }
  return best
}

/**
 * The task's live status, arbitrated across the newest Status-bearing agent turn and
 * the sentinel block.
 *
 * Turn-vs-block is itself a "which one owns it?" question and must be settled by
 * DATE, not by position: the loop rewrites the BLOCK's Status line every run, while
 * a turn only sometimes restates it, so an unconditional turn preference reports a
 * stale turn as live.
 *
 * @param {string} text raw journal markdown
 * @returns {{status:string|null, raw:string|null, line:string|null, date:string|null,
 *            source:string, canonical:boolean, turnIndex:number, turnCount:number,
 *            effDate:string|null, arbitration:string}}
 */
export function liveStatus(text) {
  const turns = allIndexes(text, AGENT)
  const users = allIndexes(text, USER)
  const turnCount = turns.length
  const headers = headerDates(text)
  const none = {
    status: null,
    raw: null,
    line: null,
    date: null,
    source: 'none',
    canonical: false,
    turnIndex: turnCount,
    turnCount,
    effDate: null,
    arbitration: 'none',
  }

  // Newest agent turn that carries a Status line.
  let turnHit = null
  for (let i = turnCount - 1; i >= 0; i--) {
    const start = turns[i]
    // A turn ends at the next `from:` marker of either kind.
    let end = text.length
    for (const idx of [...turns, ...users]) if (idx > start && idx < end) end = idx
    const hit = statusFromSlice(text.slice(start, end), `turn-${i + 1}`)
    if (hit) {
      turnHit = {
        ...hit,
        canonical: hit.status !== null,
        turnIndex: i + 1,
        turnCount,
        effDate: hit.date || headerDateFor(headers, start),
      }
      break
    }
  }

  // The agent block (the template writes Status there, rewritten every run).
  let blockHit = null
  const s = text.lastIndexOf(SENTINEL)
  if (s !== -1) {
    let end = text.length
    for (const idx of [...turns, ...users]) if (idx > s && idx < end) end = idx
    const hit = statusFromSlice(text.slice(s, end), 'block')
    if (hit) {
      blockHit = { ...hit, canonical: hit.status !== null, turnIndex: 0, turnCount, effDate: hit.date }
    }
  }

  // Arbitrate by DATE, not by position: whichever line is strictly newer is live.
  if (turnHit && blockHit) {
    if (turnHit.effDate && blockHit.effDate) {
      if (blockHit.effDate > turnHit.effDate) return { ...blockHit, arbitration: 'block-newer' }
      return {
        ...turnHit,
        arbitration: blockHit.effDate === turnHit.effDate ? 'same-date-turn' : 'turn-newer',
      }
    }
    return { ...turnHit, arbitration: 'undatable-turn' }
  }
  if (turnHit) return { ...turnHit, arbitration: 'turn-only' }
  if (blockHit) return { ...blockHit, arbitration: 'block-only' }

  return none
}

/**
 * The digest's status verdict for a journal: the canonical live status, or null when
 * the journal names none.
 *
 * Deliberately returns null rather than a raw token for a non-canonical phrase. The
 * old reader's failure was that it returned `in` — a value that is not a status but
 * IS a string, so every `TERMINAL.has(status)` test silently said "not terminal" and
 * looked like it had worked. A null says "this journal does not state a status",
 * which is true, and which the caller can then handle explicitly.
 */
export function liveJournalStatus(text) {
  if (!text) return null
  return liveStatus(text).status
}

/**
 * The verdict the digest actually uses: the live status, falling back to whatever
 * the previous reader said when the live one finds nothing.
 *
 * WHY THE FALLBACK (measured, not defensive)
 * ------------------------------------------
 * `liveStatus` locates the managed block with `lastIndexOf(SENTINEL)`. A journal that
 * *quotes* the sentinel in its prose therefore has its block "found" at the quote, and
 * the real Status line above it is never read. That is not hypothetical: task 267
 * explains the marker convention in a bullet and so contains the literal
 * `<!-- OVERNIGHT-AGENT ... -->` inside backticks. Its live verdict is `null`, while
 * its actual header says `done`. Without this fallback, #202's fix would have pushed a
 * finished task back INTO the queue — the exact defect it exists to remove.
 *
 * So the composition is deliberate: this change may only ever ADD information. When
 * the live reader has a verdict it wins, because the header is frozen and the live
 * reader is why this issue was filed. When it has none, nothing is known that was not
 * known before, and the previous behaviour stands unchanged.
 *
 * The `lastIndexOf` quirk is shared with `lib-live-status.mjs` and is left alone here
 * on purpose — it affects 14 sweeps, has its own mutation checks, and correcting it is
 * a separate change with a separate blast radius.
 *
 * @param {string} text raw journal markdown
 * @param {string|null} headerStatus what the previous block-header reader returned
 */
export function digestStatus(text, headerStatus) {
  const live = liveJournalStatus(text)
  return live !== null ? live : headerStatus ?? null
}
