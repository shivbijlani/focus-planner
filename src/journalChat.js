// Pure helpers for rendering journal markdown as a chat thread.
// Kept dependency-free so they can be unit tested without React.

export function localISODate(d = new Date()) {
  const z = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`
}

export function formatChatDay(day) {
  if (!day) return null
  const d = new Date(`${day}T00:00:00`)
  if (isNaN(d)) return day
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

export function trimBlankEnds(arr) {
  let start = 0
  let end = arr.length
  while (start < end && arr[start].trim() === '') start++
  while (end > start && arr[end - 1].trim() === '') end--
  return arr.slice(start, end)
}

// Parse a journal markdown file into a chat-style structure.
// Convention:
//   "# Task XX: Title"          -> thread title
//   "## YYYY-MM-DD [label]"     -> starts a new day (author resets to me)
//   "<!-- from: NAME -->"       -> switches author (NAME === me returns to me)
//   "<!-- ...AUTO/AGENT... -->" -> agent block (auto-generated/agent-managed)
// Content before the first day/agent marker is "pinned" (undated header notes).
// Multi-line HTML comments (e.g. <!-- dc-meta ... -->) are stripped entirely.

// Shared agent-sentinel detector. Agent skills mark their managed region with a
// sentinel HTML comment; both "...-AUTO" (e.g. DANCE-CHURCH-AUTO) and "...-AGENT"
// (e.g. OVERNIGHT-AGENT) styles are recognized. Parser and append both use this
// so they can never disagree about where an agent block begins.
export const AGENT_SENTINEL_RE = /^<!--.*\b(?:AUTO|AGENT)\b.*-->/i
const FROM_RE = /^<!--\s*from:\s*([^\s>]+)\s*-->/i

// --- Fenced code blocks are QUOTED TEXT, not markup (#320 / #325) -----------------------
// Every markup rule below (`## ` day, `<!-- from: X -->`, the agent sentinel) is anchored to
// the start of a line. Inside a fenced block the quoted markup sits at column 0 too, so
// without a fence pass the parser cannot tell an ILLUSTRATION of a journal from a journal.
//
// This repo quotes journal markup in fences constantly -- the #320 issue body itself does --
// and the damage is user-visible in both directions. Measured on a turn whose only unusual
// feature was a fenced example: the agent's `<!-- from: me -->\nyes, go ahead` rendered as a
// bubble FROM SHIV (an approval he never typed, shown as his), a fenced `## 2026-12-25`
// teleported the rest of the turn onto a fabricated future day, and one turn was split into
// four stacked bubbles instead of two. That is the "hard to read / stacked messages"
// complaint in #286, produced by the reader rather than by the content.
//
// `oa-state.ps1` (the consent gate) learned this in #344; its `Get-FenceMaskedText` is the
// same rule. Keeping the two in step matters: when one reader thinks a quoted marker is real
// and the other does not, they disagree about who wrote a message -- and the thing they
// disagree about is whether Shiv approved something.
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)$/
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/

// Mark every line that belongs to a fenced block (delimiters included). Returns a boolean
// array parallel to `lines`, so callers keep their own indices and offsets unchanged.
//
// Deliberately ONE implementation shared by the parser and the writer below. They ask the
// same question -- "is this line markup or quoted text?" -- and two copies of a subtle
// CommonMark rule is how they drift back apart.
export function fencedLineMask(lines) {
  const mask = new Array(lines.length).fill(false)
  let inFence = false
  let fenceChar = ''
  let fenceLen = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '')
    if (!inFence) {
      const m = line.match(FENCE_OPEN_RE)
      if (!m) continue
      const [, delim, info] = m
      // A backtick fence may not carry a backtick in its info string (CommonMark), which
      // keeps inline code such as `a``b` from opening a block.
      if (delim[0] === '`' && info.includes('`')) continue
      inFence = true
      fenceChar = delim[0]
      fenceLen = delim.length
      mask[i] = true
    } else {
      mask[i] = true
      const c = line.match(FENCE_CLOSE_RE)
      if (c && c[1][0] === fenceChar && c[1].length >= fenceLen) inFence = false
    }
  }
  // An unterminated fence runs to end of input, matching Get-FenceMaskedText.
  return mask
}
const DATE_RE = /^##\s+(\d{4}-\d{2}-\d{2})\b/
// Any `## ` heading (dated or not) ends the preceding marker's ownership.
const HEADING_RE = /^##\s/
// The provenance marker the app stamps on its own writes. Byte-identical to the
// Telegram bridge's `FROM_ME` so both channels are indistinguishable to readers.
export const FROM_ME = '<!-- from: me -->'

export function parseJournalChat(content) {
  const text = (content || '').replace(/^\uFEFF/, '')
  const lines = text.split(/\r?\n/)
  let title = ''
  const pinned = []
  const groups = []
  let started = false
  let curDay = null
  let curAuthor = 'me'
  let curAgent = null
  let inComment = false

  const dateRe = DATE_RE
  const fromRe = FROM_RE
  const autoRe = AGENT_SENTINEL_RE
  const fenceMask = fencedLineMask(lines)

  const pushLine = (line) => {
    let g = groups[groups.length - 1]
    if (!g || g.day !== curDay || g.author !== curAuthor || g.agent !== curAgent) {
      g = { day: curDay, author: curAuthor, agent: curAgent, lines: [] }
      groups.push(g)
    }
    g.lines.push(line)
  }

  for (let idx = 0; idx < lines.length; idx++) {
    const rawLine = lines[idx]
    let line = rawLine

    // Fenced content is literal: emit it verbatim and run no markup rule over it, so a
    // quoted `<!-- from: me -->` or `## <date>` cannot switch author or open a day (#320).
    // Checked before the comment machinery so an example comment inside a fence still
    // renders as the code it is instead of being swallowed.
    if (fenceMask[idx]) {
      if (!started) pinned.push(rawLine)
      else pushLine(rawLine)
      continue
    }

    // Continue swallowing a multi-line HTML comment (e.g. <!-- dc-meta ... -->)
    if (inComment) {
      const end = line.indexOf('-->')
      if (end === -1) continue
      line = line.slice(end + 3)
      inComment = false
    }
    const trimmed = line.trim()

    if (!title) {
      const tm = trimmed.match(/^#\s+(.+)/)
      if (tm) { title = tm[1].trim(); continue }
    }
    const dm = trimmed.match(dateRe)
    if (dm) {
      curDay = dm[1]
      curAuthor = 'me'
      curAgent = null
      started = true
      continue
    }
    const fm = trimmed.match(fromRe)
    if (fm) {
      if (fm[1].toLowerCase() === 'me') { curAuthor = 'me'; curAgent = null }
      else { curAuthor = 'agent'; curAgent = fm[1] }
      started = true
      continue
    }
    if (autoRe.test(trimmed)) {
      curAuthor = 'agent'
      curAgent = curAgent || 'agent'
      started = true
      continue
    }

    // Remove complete inline comments; if a comment opens without closing,
    // keep any visible text before it and swallow the rest across lines.
    let visible = line.replace(/<!--[\s\S]*?-->/g, '')
    const open = visible.indexOf('<!--')
    if (open !== -1) { visible = visible.slice(0, open); inComment = true }

    const wasBlank = rawLine.trim() === ''
    if (!wasBlank && visible.trim() === '') continue // line was purely a comment
    const emit = wasBlank ? '' : visible
    if (!started) pinned.push(emit)
    else pushLine(emit)
  }

  return {
    title,
    pinned: trimBlankEnds(pinned),
    groups: groups
      .map((g) => ({ ...g, lines: trimBlankEnds(g.lines) }))
      .filter((g) => g.lines.length > 0),
  }
}

// Append a new "me" message to journal markdown, merging into today's bubble.
//
// The app is the true author of everything appended here (journal-chat sends and
// task close-out notes; agent content is written by the agents themselves, never
// through this path), so it stamps its own provenance. Without the marker, a
// `## ` heading leaves the text unattributed, and the overnight agent's consent
// gate fails closed on unattributed text — which silently discarded every
// approval typed in the app. The emitted shape is byte-identical to the Telegram
// bridge's `appendUserReply`, so an approval reads the same from either channel.
// Historical unmarked entries are never rewritten; only new text is stamped.
export function appendJournalMessage(content, text, today = localISODate()) {
  const body = (content || '').replace(/\s+$/, '')
  const lines = body.split(/\r?\n/)
  // Fenced lines are quoted text, not markup (#320) — a `## <date>` inside an example
  // must not be mistaken for the journal's newest day, which would merge today's message
  // under a heading that does not exist.
  const attrMask = fencedLineMask(lines)
  let lastDate = null
  for (let i = lines.length - 1; i >= 0; i--) {
    if (attrMask[i]) continue
    const m = lines[i].trim().match(DATE_RE)
    if (m) { lastDate = m[1]; break }
  }
  // Whether a `<!-- from: me -->` marker still owns the end of the file. Any
  // `## ` heading ends the previous marker's ownership, so only a marker that is
  // the last governing token can carry the new text's attribution. When one
  // does, merging under it is already attributed and needs no second marker.
  //
  // Fenced lines are skipped (#320): a marker quoted in an example is not a marker.
  // Reading one as real makes this writer conclude the text is already attributed and
  // omit the marker -- while the consent gate, which masks fences, sees unattributed
  // text and fails closed. The user's approval is then dropped by the disagreement
  // between the two readers rather than by either one being wrong on its own.
  let attributed = false
  for (let i = 0; i < lines.length; i++) {
    if (attrMask[i]) continue
    const t = lines[i].trim()
    const fm = t.match(FROM_RE)
    if (fm) { attributed = fm[1].toLowerCase() === 'me'; continue }
    if (AGENT_SENTINEL_RE.test(t) || HEADING_RE.test(t)) attributed = false
  }
  let addition
  if (lastDate !== today) addition = `\n\n## ${today}\n\n${FROM_ME}\n${text}`
  else if (attributed) addition = `\n${text}`
  else addition = `\n\n${FROM_ME}\n${text}`
  return `${body}${addition}\n`
}

// Build the close-out comment written to a task journal when a task is
// completed. `outcome` is a short label (e.g. "Canceled"); `comment` is
// optional free text. Returns '' when there is nothing to record.
export function formatCloseOutComment(outcome, comment) {
  const parts = []
  const cleanOutcome = (outcome || '').trim()
  const cleanComment = (comment || '').trim()
  if (cleanOutcome) parts.push(`**Outcome:** ${cleanOutcome}`)
  if (cleanComment) parts.push(cleanComment)
  return parts.join('\n\n')
}
