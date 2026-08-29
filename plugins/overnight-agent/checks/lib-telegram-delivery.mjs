// telegram-delivery.mjs — the ONE model of what Telegram actually receives.
//
// WHY THIS FILE EXISTS (added 2026-08-29)
// ---------------------------------------
// Three sweeps — telegram-ask-truncation-sweep, truncated-ask-liveness and
// truncation-openboard-scope — each carried a byte-identical hand-copy of the
// bridge's OLD truncate-a-prefix logic:
//
//     let budget = Math.max(0, room - 400)
//     while (bodyHtml.length > room && budget > 0) { ...shrink... }
//     return truncateMarkdown(turn, budget)
//
// PR #211 (merged 2026-08-28) DELETED that path from bridge.js and replaced it
// with `formatForTelegramParts`, which SPLITS a long turn across up to 3
// messages and, past that, trims the body while explicitly carrying the ask onto
// the final part. So all three sweeps were grading a code path that no longer
// exists.
//
// The cost was not symmetric, and the loud half was not the dangerous half:
//
//   * telegram-ask-truncation-sweep went RED on a FALSE POSITIVE (#435), and its
//     remediation text told the next run to "shorten the turn to <~3,400 chars"
//     — i.e. to degrade the journal to satisfy a constraint that had been fixed.
//     A detector that is wrong in the direction of "do less work" is worse than
//     one that is silent.
//   * the other two were GREEN FOR THE WRONG REASON. They never call the
//     splitter, so they would have stayed green if it regressed. That is the
//     failure mode this repo keeps rediscovering: a guard that grades the wrong
//     artifact reports on something nobody is shipping.
//
// Two of the three files claimed in their own header comment that they used the
// shipped formatter "never a reimplementation". The claim was true of
// `mdToTelegramHtml` and false of the truncation model, which is exactly how it
// survived review three times.
//
// So: one module, importing the SHIPPED entry point, and no local model of the
// cap at all. If bridge.js changes again, every consumer changes with it.
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'

// Resolve the shipped bridge. `src` is a file:/// URL (a bare V:\ path fails
// with ERR_UNSUPPORTED_ESM_URL_SCHEME on Windows).
export async function loadShippedDelivery(src) {
  const { formatForTelegramParts, splitAsk } = await import(`${src}/bridge.js`)
  const { mdToTelegramHtml } = await import(`${src}/telegramFormat.js`)
  if (typeof formatForTelegramParts !== 'function') {
    throw new Error('bridge.js does not export formatForTelegramParts — refusing to guess a model')
  }
  return { formatForTelegramParts, splitAsk, mdToTelegramHtml }
}

// Turn rendered HTML back into the text a reader actually sees, so tokens can be
// compared. Anchors keep BOTH label and target; everything else loses its tags.
export function deliveredText(html) {
  return String(html)
    .replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '$2 $1')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, '&')
}

// What the bridge actually posts for one turn.
//
// `text` is the reader-visible form of the delivery. `sourceText` is the SAME
// turn put through the SAME md -> HTML -> text pipeline without any splitting.
//
// Comparing those two is the whole trick, and it is what the first version of
// this module got wrong. Comparing raw markdown against delivered HTML makes the
// FORMATTER look like data loss: `mdToTelegramHtml` renders `[label](./x.md)` as
// bare `label`, dropping the href, so every deliverable link read as "lost" —
// 41 open-board tasks were flagged on a first run, almost all of them delivered
// whole in a single message. Loss and rendering are different things, and only
// one of them is this suite's business.
//
// Same pipeline both sides means a single-part delivery is loss-free BY
// CONSTRUCTION (`sourceText` is literally a substring of `text`), so anything
// this reports is the split cap dropping content and nothing else.
export function deliveryFor(shipped, taskId, title, turn) {
  const parts = shipped.formatForTelegramParts(taskId, title || '', turn)
  const html = parts.join('\n')
  return {
    parts,
    html,
    text: deliveredText(html),
    sourceText: deliveredText(shipped.mdToTelegramHtml(turn)),
  }
}

const ASK_MD = /^\s*\*{0,2}\s*(Needs from you|Your call|Next)\b/im

export function turnHasAsk(turn) {
  return ASK_MD.test(String(turn))
}

// An ask counts as delivered when its opening line reaches the reader.
//
// Checked by locating the ask with the SHIPPED `splitAsk` and looking for that
// exact rendered line, rather than by re-matching a marker pattern on the
// delivered side. The first version did the latter and required a colon right
// after the marker — which flagged #284, whose ask reads
// `**Needs from you — one line:**`. The marker was delivered perfectly; the
// detector's second regex simply disagreed with its first.
export function askDelivered(shipped, turn, delivery) {
  const { ask } = shipped.splitAsk(turn)
  if (!ask) return true
  const rendered = deliveredText(shipped.mdToTelegramHtml(ask))
  const firstLine = rendered.split('\n').map((l) => l.trim()).find((l) => l.length > 0)
  if (!firstLine) return true
  return delivery.text.includes(firstLine)
}

// Signals that represent something actionable rather than prose. Matched against
// the RENDERED source, so they must be things a reader can still see: link
// hrefs do not survive `mdToTelegramHtml` for anyone, split or not.
export const SIGNALS = [
  [/\bmerge\s+\d+/gi, 'merge <n>'],
  [/\bPR\s*#\d+/gi, 'PR #<n>'],
  [/\bissue\s*#\d+/gi, 'issue #<n>'],
  [/https?:\/\/[^\s)>\]]+/g, 'url'],
]

// Which actionable tokens exist in the rendered turn but never reach the reader.
// Compares TOKENS, not lengths: a split delivery is legitimately shorter than
// its source in characters (headers and part counters cost room) while losing
// nothing, so a length test would report loss on every long turn.
export function lostSignals(turn, delivery) {
  const lost = []
  for (const [re, label] of SIGNALS) {
    const seen = new Set()
    for (const m of delivery.sourceText.matchAll(re)) {
      const token = (m[1] || m[0]).trim()
      if (!token || seen.has(token)) continue
      seen.add(token)
      if (!delivery.text.includes(token)) lost.push({ label, token })
    }
  }
  return lost
}

// Shared journal walk, so each sweep states its own question rather than its own
// directory listing.
export function eachTurn(journalsDir, latestAgentTurn, fn) {
  for (const f of readdirSync(journalsDir)) {
    const m = f.match(/^task-(\d+)\.md$/)
    if (!m) continue
    let text
    try { text = readFileSync(join(journalsDir, f), 'utf8') } catch { continue }
    let turn
    try { turn = latestAgentTurn(text) } catch { continue }
    if (!turn) continue
    const body = typeof turn === 'string' ? turn : turn.text || turn.body || ''
    if (!body.trim()) continue
    fn(m[1], body)
  }
}
