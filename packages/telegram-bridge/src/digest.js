// Builds the "what is waiting on you" approval digest — one message listing
// every open ask across all tasks, posted to the group's General thread.
//
// Why this exists: the bridge mirrors each task into its own forum topic, so
// the approval queue only ever existed scattered across ~15 topics, each
// needing a separate reply. On a channel where bot privacy mode silently
// discards anything the user merely *types* (only replies survive), that is a
// reliable way to have a queue sit unanswered for days. One consolidated,
// reply-able message collapses that to a single reply.
//
// ⚠️ The correctness property that matters here: the ask MUST be read from the
// task's NEWEST agent turn, never by grepping the whole journal for its last
// `**Needs from you:**` line. Journals are bottom-appended chat threads, and
// later turns routinely restate a blocker in prose without re-emitting the
// marker — so a whole-file grep can surface an ask that newer turns already
// invalidated (observed live: task #250's marker was written 2026-07-01 and
// superseded on 07-07, and a grep-based triage acted on the stale one). A
// digest built on that grep would rebroadcast stale asks every night and train
// the user to distrust it. `latestAgentTurn()` gives us the newest turn; we
// only ever scan inside it.

import { createHash } from 'crypto'

const TELEGRAM_MAX = 4096

// Matches `**Needs from you:**`, `Needs from you:`, and the `— <qualifier>`
// variants the journals use (e.g. `**Needs from you — still one line:**`).
const NEEDS_RE = /^\s*\*{0,2}Needs from you\b[^:]*:\*{0,2}\s*(.*)$/i
// Matches a `Next:` / `- Next:` / `**Next:**` line.
const NEXT_RE = /^\s*[-*]?\s*\*{0,2}Next\*{0,2}\s*:\s*(.*)$/i

/** Collapse whitespace and strip trailing markdown noise from an ask line. */
function tidy(text) {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * Pull the open ask out of a SINGLE agent turn's text.
 *
 * Returns `{ text, source }` where source is:
 *   'needs' — an explicit `**Needs from you:**`. This is the agent's formal
 *             ask and is genuinely blocking on the user.
 *   'next'  — only a `Next:` line. Much weaker: `Next:` often describes what
 *             the *agent* will do next ("keep polling on future overnight
 *             runs"), not something the user owes. Callers should rank these
 *             below 'needs' and drop them first when space is tight, so the
 *             digest never presents agent-side continuation as a user ask.
 *
 * When the marker line is empty (the ask continues on the following lines,
 * which the journals do often), continuation lines are folded in until a blank
 * line or the next block starts.
 *
 * Returns null when the turn contains no ask at all.
 */
export function extractAskEntry(turn) {
  if (!turn) return null
  const lines = String(turn).split(/\r?\n/)

  const gather = (startIdx, firstCapture) => {
    const parts = firstCapture ? [firstCapture] : []
    for (let i = startIdx + 1; i < lines.length; i++) {
      const raw = lines[i]
      if (!raw.trim()) break
      // Stop at the start of a new structural block or a new marker line.
      if (/^\s{0,3}(#{1,6}\s|\*{2}[A-Z])/.test(raw)) break
      if (NEEDS_RE.test(raw) || NEXT_RE.test(raw)) break
      parts.push(raw.trim())
      // Keep asks short — one or two wrapped lines is plenty for a digest.
      if (parts.join(' ').length > 400) break
    }
    const joined = tidy(parts.join(' '))
    return joined || null
  }

  let nextAsk = null
  for (let i = 0; i < lines.length; i++) {
    const needs = NEEDS_RE.exec(lines[i])
    if (needs) {
      const ask = gather(i, needs[1].trim())
      // "none" / "nothing" means explicitly not waiting on the user.
      if (ask && /^(none|nothing)\b/i.test(ask)) return null
      if (ask) return { text: ask, source: 'needs' }
    }
    if (nextAsk == null) {
      const next = NEXT_RE.exec(lines[i])
      if (next) nextAsk = gather(i, next[1].trim())
    }
  }

  if (!nextAsk) return null
  if (/^(complete|done|nothing|none)\b/i.test(nextAsk)) return null
  return { text: nextAsk, source: 'next' }
}

/** Convenience wrapper: just the ask text, or null. */
export function extractAsk(turn) {
  const entry = extractAskEntry(turn)
  return entry ? entry.text : null
}

/** Stable content hash so an unchanged queue is never re-posted. */
export function hashDigest(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function truncateAsk(ask, max = 220) {
  if (ask.length <= max) return ask
  return ask.slice(0, max - 1).replace(/\s+\S*$/, '') + '\u2026'
}

/**
 * Compose the digest markdown from `[{ taskId, title, ask }]`.
 *
 * `privacyModeOn` adds the reply-or-it-is-lost warning. That warning is not
 * decoration: with privacy mode on, a typed message never reaches the bot, so
 * a digest that does not tell the user to *reply* can produce answers that
 * vanish silently.
 */
export function buildDigest(entries, { date, privacyModeOn = false } = {}) {
  const day = date || new Date().toISOString().slice(0, 10)
  const open = entries.filter((e) => e && e.ask)

  // Formal `Needs from you:` asks are what actually block the user; `Next:`
  // lines are a weaker fallback that often describe agent-side work. Rank the
  // real asks first so that when the message has to be trimmed, it is always
  // the soft ones that fall off the end.
  const blocking = open.filter((e) => e.source !== 'next')
  const soft = open.filter((e) => e.source === 'next')
  const ordered = [...blocking, ...soft]

  const lines = [`**\u{1F319} Waiting on you \u2014 ${day}**`, '']

  if (ordered.length === 0) {
    lines.push('Nothing is waiting on you right now. \u2705')
    return lines.join('\n')
  }

  const n = blocking.length || ordered.length
  lines.push(
    `${n} open ask${n === 1 ? '' : 's'}. You can answer several at once in one reply.`,
    '',
  )

  if (privacyModeOn) {
    lines.push(
      '\u26A0\uFE0F **Reply to this message.** Bot privacy mode is ON, so a message you merely ' +
        'type in the group is never delivered. Replies, /commands and @mentions do get through.',
      '',
    )
  }

  for (const e of ordered) {
    const head = e.title ? `#${e.taskId} \u00B7 ${e.title}` : `#${e.taskId}`
    lines.push(`\u2022 **${head}** \u2014 ${truncateAsk(e.ask)}`)
  }

  const out = lines.join('\n')
  // Leave headroom for HTML tag expansion downstream.
  const budget = TELEGRAM_MAX - 600
  if (out.length <= budget) return out

  // Too many asks to fit: keep as many WHOLE entries as will fit and say how
  // many were dropped, rather than truncating mid-entry. The footer has to be
  // budgeted for up front — appending it after the fill is what pushes the
  // message back over the cap.
  const headerCount = privacyModeOn ? 6 : 4
  const header = lines.slice(0, headerCount)
  const entryLines = lines.slice(headerCount)
  // Worst-case footer, sized for the largest count it could report.
  const footerFor = (n) => `\n\n\u2026and ${n} more \u2014 see the task topics.`
  const footerBudget = footerFor(entryLines.length).length

  let used = header.join('\n').length + footerBudget
  const kept = []
  for (const line of entryLines) {
    if (used + line.length + 1 > budget) break
    kept.push(line)
    used += line.length + 1
  }

  const dropped = entryLines.length - kept.length
  return [...header, ...kept].join('\n') + footerFor(dropped)
}
