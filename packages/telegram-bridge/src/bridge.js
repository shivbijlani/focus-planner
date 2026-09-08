// Orchestrates the two directions of the bridge:
//   syncUp   — post each task's latest agent turn into its forum topic
//   syncDown — fold Telegram replies back into the task journals
// All I/O is injected (client + io) so the flow is unit-testable offline.

import { createHash } from 'crypto'
import {
  hasAgentBlock,
  latestAgentTurn,
  agentBlockText,
  agentBlockStatus,
  parseTitle,
  topicName,
  appendUserReply,
} from './journal.js'
import { digestStatus } from './liveStatus.js'
import {
  getTask,
  setTopic,
  setLastPosted,
  setLastPostedMessageIds,
  setLastPostedContext,
  setPreBindCollapseVerdict,
  getPreBindCollapseVerdict,
  bumpReplyCount,
  getReplyCount,
  setSuppressedHash,
  setArchived,
  setUserEngaged,
  setDocLink,
  setDocLinkVerified,
  setDocLinkNoticeHash,
  setDocLinkAsk,
  setDocLinkNoticeReplyCount,
  setOffset,
  setLastDigest,
  setDigestTopic,
  findTaskByTopic,
} from './state.js'
import { extractAskEntry, buildDigest, hashDigest } from './digest.js'
import { upsertTgMetaMarker, parseTgMeta, parseDocMeta, docHasBeenWritten } from './deepLink.js'
import { mdToTelegramHtml, escapeHtml, extractLinks } from './telegramFormat.js'
import { parseCompletedTaskIds } from './completed.js'
import { parseDeletedTaskIds } from './deleted.js'
import { parseBoardOrder, boardRank, boardIndex } from './board.js'
import { parseReplyRouting, coalesceByTask } from './routeReply.js'

const TELEGRAM_MAX = 4096

// Rate-limit handling (#172). A 429 is a pause, not a failure -- but an unbounded
// wait would be its own hang, so both the number of attempts and each individual
// wait are capped, and the no-`retry_after` path backs off exponentially rather
// than assuming the field is there.
const RATE_LIMIT_MAX_RETRIES = 5
const RATE_LIMIT_BASE_WAIT_MS = 2000
const RATE_LIMIT_MAX_WAIT_MS = 90000

// Injectable so tests never actually wait. Overridden via globalThis in the
// suite; production always gets the real timer.
const sleep = (ms) =>
  typeof globalThis.__telegramBridgeSleep === 'function'
    ? globalThis.__telegramBridgeSleep(ms)
    : new Promise((resolve) => setTimeout(resolve, ms))

// A turn longer than one message is SPLIT rather than truncated (see
// `formatForTelegramParts`). Cap the split so a very long turn can't carpet-bomb
// the phone with messages; past this we trim the middle and keep the ask.
const MAX_PARTS = 3

// Room to reserve in the header for the " (2/3)" part counter, so the budget we
// chunk against is still right once the counter is added.
const PART_COUNTER_RESERVE = 12

// The trailing block an agent turn ends with — the part the reader is actually
// supposed to act on. `Needs from you:` / `Your call:` come from the SKILL.md
// block template; `Next:` is the weaker fallback used by Run log entries.
const ASK_STRONG_RE = /^\s*\*{0,2}\s*(?:Needs from you|Your call)\b/i
const ASK_WEAK_RE = /^\s*\*{0,2}\s*Next\b/i

// Block statuses that are finished as far as the user is concerned. A task in
// one of these must never be pulled back into the approval queue by the
// agent-block fallback in syncDigest().
const DIGEST_TERMINAL_STATUS = new Set(['done', 'skip', 'skipped', 'complete', 'completed'])

export function hashTurn(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

// Split a turn into [body, ask], where `ask` is the trailing ask block.
//
// Anchored on the LAST strong marker rather than the first, because `Next:`
// (and occasionally `Needs from you:`) also appear inside earlier Run log
// entries — anchoring on the first would classify most of the turn as "the ask"
// and defeat the point. When both strong markers are present we start at the
// earlier of the two final pair so `Needs from you:` and `Your call:` travel
// together. Returns `ask === ''` when the turn has no ask at all.
export function splitAsk(turn) {
  const text = String(turn == null ? '' : turn)
  const lines = text.split('\n')
  let lastNeeds = -1
  let lastCall = -1
  let lastWeak = -1
  for (let i = 0; i < lines.length; i++) {
    if (ASK_STRONG_RE.test(lines[i])) {
      if (/needs from you/i.test(lines[i])) lastNeeds = i
      else lastCall = i
    } else if (ASK_WEAK_RE.test(lines[i])) lastWeak = i
  }

  let start = -1
  if (lastNeeds >= 0 && lastCall >= 0) start = Math.min(lastNeeds, lastCall)
  else if (lastNeeds >= 0) start = lastNeeds
  else if (lastCall >= 0) start = lastCall
  else start = lastWeak

  if (start < 0) return { body: text, ask: '' }
  return {
    body: lines.slice(0, start).join('\n').replace(/\s+$/, ''),
    ask: lines.slice(start).join('\n').trim(),
  }
}

// --- #424: the catch-up link replaces the per-turn post -------------------------------
//
// Shiv: "Whenever the agent wakes up, it seems to add a post to the journal and telegram
// thread with a lot of detail. Instead it should provide a link to the catch up document.
// ... Once the link is already posted in telegram, no need to post anything more."
//
// So once a task has a catch-up doc, its topic holds ONE message: the link. The doc changes;
// the link does not. Measured on the live journals, 21 of 28 turns on task 468 individually
// exceed Telegram's 4096-char limit -- this removes the large per-turn post rather than
// getting better at rendering it, which is the only fix that does not depend on a collapse
// heuristic being right (#205, #278 both attacked it from the rendering side).

const DISMISSIVE_ASK_RE = /^(none|nothing|no|n\/?a|nil|nope)\b/i

// A retraction's value is a REASON, not an ask — free prose that can legitimately begin with
// "no" ("no word could clear them; deleting is floor-blocked"). Reusing the prefix-anchored
// ask filter above silently swallowed exactly that sentence, killing the feature while every
// other test stayed green. So only a bare dismissive token counts as "no retraction here".
const DISMISSIVE_REASON_RE = /^(none|nothing|n\/?a|nil|nope)\.?$/i

/**
 * The value of the turn's last `Needs from you:` line, or '' when the agent is not blocked.
 *
 * A DISMISSIVE opener ("none", "nothing needed - say the word and I'll pick it up") is not a
 * blocking ask. That distinction is not a nicety: the agent ends nearly every turn with a
 * courtesy offer, so treating any `Needs from you:` as blocking would make the exception fire
 * every single run and rebuild the per-turn posting this issue exists to remove. The same rule,
 * for the same reason, already gates `awaiting_reply` in oa-state.ps1.
 */
export function blockingAsk(turn) {
  const lines = String(turn == null ? '' : turn).split('\n')
  let value = null
  for (const line of lines) {
    const m = /^\s*\**\s*Needs from you\s*\**\s*:?\s*\**\s*(.*)$/i.exec(line)
    if (m) value = m[1].replace(/\*+/g, '').trim()
  }
  if (value == null) return ''
  if (!value || DISMISSIVE_ASK_RE.test(value)) return ''
  return value
}

/**
 * Why a previous ask could never have been satisfied, or '' when the turn makes no such claim.
 *
 * RESOLUTION vs RETRACTION — the whole of #515 turns on this distinction.
 *
 * A resolved ask was true when it was posted: Shiv may have read it and acted on it, so the
 * notice is left exactly as it stands and its id is forgotten (see `setDocLinkNoticeHash`).
 * That is deliberate and is NOT relaxed here.
 *
 * A retracted ask was never satisfiable — measured live on task 468, a notice asked for "one
 * word" to authorise clearing two messages when `delete_data` sits on the agent-gate floor and
 * the floor overrides even a human `approve`. No word could have worked. He cannot have acted
 * on it, because acting on it was impossible, and that impossibility is the defect.
 *
 * The bridge cannot verify unsatisfiability for itself, so it never INFERS a retraction: the
 * turn's author must state one explicitly. The safety that makes an agent-authored signal
 * acceptable here is not trust, it is that a retraction cannot destroy anything -- see
 * `formatDocRetraction`, which keeps the original ask on screen.
 */
export function retractedAsk(turn) {
  const m = /^[ \t]*\**[ \t]*Retracts[ \t]*\**[ \t]*:?[ \t]*\**[ \t]*(.*)$/im.exec(
    String(turn == null ? '' : turn),
  )
  if (!m) return ''
  const value = m[1].replace(/\*+/g, '').trim()
  if (!value || DISMISSIVE_REASON_RE.test(value)) return ''
  return value
}

/** A terminal state worth one line, or '' — the other exception #424 keeps. */
export function terminalStatus(turn) {
  const m = /^[ \t]*\**[ \t]*Status[ \t]*\**[ \t]*:?[ \t]*\**[ \t]*(.*)$/im.exec(
    String(turn == null ? '' : turn),
  )
  if (!m) return ''
  const value = m[1].replace(/\*+/g, '').trim()
  if (/^(done|complete|completed|shipped)\b/i.test(value)) return 'done'
  if (/^blocked\b/i.test(value)) return 'blocked'
  if (/^(abandoned|cancell?ed|skipped?)\b/i.test(value)) return 'abandoned'
  return ''
}

/**
 * The one message a task's topic holds in the steady state.
 *
 * Deliberately DETERMINISTIC for a given task/title/doc AND a given notice state: the existence
 * probe re-sends this exact text, and Telegram's `message is not modified` reply is what proves
 * the message is still there. A timestamp or any other FREELY varying token would turn every
 * probe into a real edit and destroy that.
 *
 * #620 — the notice now rides here rather than in a message of its own, and that is a
 * deliberate narrowing of the rule above rather than a break with it. The text still cannot
 * vary freely; it varies only when the ask itself changes, which is exactly when the topic is
 * supposed to say something new. A probe on an unchanged ask is still byte-identical and still
 * answers `not modified`, so the cheap case stays cheap. What it costs is that a changed ask
 * makes one real edit — and that is strictly less than what it replaces, which was a whole
 * second message posted beneath this one and left there permanently.
 *
 * `notice` is deliberately not optional-with-a-default-of-silence at the call site: `syncDocLink`
 * always passes it, so "no ask" is a stated fact rather than an argument someone forgot.
 */
export function formatDocLink(taskId, title, docUrl, notice = {}) {
  const heading = title ? `#${taskId} — ${escapeHtml(title)}` : `#${taskId}`
  return (
    `📄 <b>${heading}</b>\n` +
    `<a href="${escapeHtml(docUrl)}">Catch-up doc</a> — the current state of this task, kept up to date.\n` +
    formatPointerNotice(notice) +
    `\n<i>Comment on the doc to reply. I read new comments each run.</i>`
  )
}

/**
 * The part of the pointer that changes: what the link genuinely cannot carry.
 *
 * Four states, and the third is the one that earns this design its keep.
 *
 * A LIVE ask, or a terminal status, reads as it always did.
 *
 * A RESOLVED ask does NOT vanish. It is struck through and marked resolved, and it stays that
 * way until another ask replaces it. This is the property #515 protects, restated for a message
 * that is always current: the old design refused to touch a resolved notice because "editing it
 * later would silently rewrite a line Shiv has already read and acted on", and the operative
 * word is SILENTLY. Folding the ask into a permanent message means resolution must rewrite it,
 * so the rewrite has to be one that cannot hide anything — the words he was asked are still on
 * screen, with their outcome attached. An ask he never got to read cannot disappear between two
 * glances at the topic, which is the failure that would otherwise be introduced in exchange for
 * the tidier topic, and it would be a silent one.
 *
 * A RETRACTED ask is the same shape with a reason, and keeps the wording `formatDocRetraction`
 * established for it.
 */
export function formatPointerNotice({ ask, terminal, resolved, retracted } = {}) {
  const lines = []
  if (terminal === 'done') lines.push('\n✅ <b>Done.</b>')
  else if (terminal === 'blocked') lines.push('\n⛔ <b>Blocked.</b>')
  else if (terminal === 'abandoned') lines.push('\n🚫 <b>Abandoned.</b>')

  if (ask) {
    lines.push(`\n🙋 <b>Waiting on you:</b> ${escapeHtml(ask)}`)
  } else if (resolved && retracted) {
    lines.push(`\n<s>${escapeHtml(resolved)}</s>\n⚠️ <b>Withdrawn</b> — ${escapeHtml(retracted)}`)
  } else if (resolved) {
    lines.push(`\n<s>${escapeHtml(resolved)}</s> <i>— resolved.</i>`)
  }

  return lines.length ? `${lines.join('')}\n` : ''
}

/** The short exception line. One line, never a turn. */
export function formatDocNotice(taskId, { ask, terminal, docUrl }) {
  const bits = []
  if (terminal === 'done') bits.push('✅ <b>Done.</b>')
  else if (terminal === 'blocked') bits.push('⛔ <b>Blocked.</b>')
  else if (terminal === 'abandoned') bits.push('🚫 <b>Abandoned.</b>')
  if (ask) bits.push(escapeHtml(ask))
  const body = bits.join(' ')
  return `<b>#${taskId}</b> ${body}\n<a href="${escapeHtml(docUrl)}">Catch-up doc</a>`
}

/**
 * What a pre-binding turn message becomes once its topic is bound to a catch-up doc.
 *
 * Short by design — the whole complaint is that these were too long for Telegram in the first
 * place. It carries the links the original message held, because those are the one thing a
 * pointer would otherwise drop: the turn's prose is still in the journal and the doc, but a URL
 * that only ever appeared in this message would be gone from the phone entirely.
 */
export function formatCollapsedTurn(taskId, { docUrl, links }) {
  const carried =
    Array.isArray(links) && links.length
      ? `\n${links.map((u) => `<a href="${escapeHtml(u)}">${escapeHtml(u)}</a>`).join('\n')}`
      : ''
  return (
    `<i>#${taskId} — an earlier update, now kept in the catch-up doc.</i>\n` +
    `<a href="${escapeHtml(docUrl)}">Catch-up doc</a>${carried}`
  )
}

export function hashNotice(ask, terminal) {
  return hashTurn(`${terminal}\u0000${ask}`)
}

/**
 * The retraction line: the original ask, struck through, above the reason it could not stand.
 *
 * The ORIGINAL WORDS ARE KEPT ON SCREEN, and that is what makes editing a notice safe here.
 * `state.js` refuses to keep a notice id after an ask resolves because "editing it later would
 * silently rewrite a line Shiv has already read and acted on" — and the operative words are
 * SILENTLY REWRITE. This neither hides nor replaces: the ask he saw is still legible, with a
 * correction attached. History is annotated, not rewritten, so the property that refusal was
 * protecting still holds while the falsehood stops standing unqualified.
 *
 * That is also why an agent-authored retraction flag is not the #322 failure class in miniature.
 * A false retraction can only add a correction beneath text that remains visible; it cannot
 * erase an ask, and the reader can still see exactly what was asked and judge for themselves.
 */
export function formatDocRetraction(taskId, { ask, reason, docUrl }) {
  return (
    `<b>#${taskId}</b> <s>${escapeHtml(ask)}</s>\n` +
    `⚠️ <b>Withdrawn</b> — ${escapeHtml(reason)}\n` +
    `<a href="${escapeHtml(docUrl)}">Catch-up doc</a>`
  )
}
// Greedily pack whole markdown lines into chunks whose CONVERTED HTML fits

// `room`. Converting per chunk is what keeps each one tag-balanced:
// `mdToTelegramHtml` is line-based and closes <pre>/<blockquote> itself, so a
// chunk boundary can never fall inside a tag.
//
// A single line longer than `room` on its own is a degenerate case (a giant
// table row); it gets hard-trimmed rather than looping forever.
function chunkMarkdown(md, room) {
  const lines = String(md).split('\n')
  const chunks = []
  let current = []

  const htmlLen = (arr) => mdToTelegramHtml(arr.join('\n')).length

  for (const line of lines) {
    if (current.length === 0) {
      // A lone over-long line can't be packed with anything; shrink it directly.
      if (htmlLen([line]) > room) {
        let cut = line
        while (cut.length > 0 && mdToTelegramHtml(cut).length > room) {
          cut = cut.slice(0, Math.max(0, Math.floor(cut.length * 0.9) - 1))
        }
        chunks.push(cut)
        continue
      }
      current.push(line)
      continue
    }
    if (htmlLen([...current, line]) > room) {
      chunks.push(current.join('\n'))
      current = []
      if (htmlLen([line]) > room) {
        let cut = line
        while (cut.length > 0 && mdToTelegramHtml(cut).length > room) {
          cut = cut.slice(0, Math.max(0, Math.floor(cut.length * 0.9) - 1))
        }
        chunks.push(cut)
        continue
      }
      current.push(line)
      continue
    }
    current.push(line)
  }
  if (current.length) chunks.push(current.join('\n'))
  return chunks.filter((c) => c.trim() !== '')
}

// Build the message(s) for one agent turn: a bold task header + the turn
// rendered as Telegram HTML, always tag-balanced, and NEVER missing the ask.
//
// History, because two separate bugs lived here:
//
// 1. A raw `msg.slice(...)` used to cut the generated HTML at an arbitrary
//    character, landing inside a tag. Telegram rejected the whole message
//    (`can't parse entities: Can't find end tag corresponding to start tag "b"`)
//    and the send silently downgraded to plain text, losing ALL formatting.
//    Fixed by only ever cutting markdown at a LINE boundary, where
//    `mdToTelegramHtml` guarantees balance.
//
// 2. That fix still kept a PREFIX of the turn — and an agent turn puts its ask
//    (`Needs from you:` / `Your call:`) at the END. So on any turn over the cap,
//    the one part the reader is supposed to act on was exactly the part thrown
//    away. Measured across 239 live journals: 55 turns truncated, 33 of them
//    with the ask silently deleted. On the surface he actually reads, those
//    tasks looked like commentary rather than a question. (GH #210.)
//
// So: SPLIT instead of truncate. The turn is chunked at line boundaries into up
// to MAX_PARTS messages posted in order to the same topic. If it still doesn't
// fit, the body is trimmed — but the ask is carried onto the final part with an
// explicit "trimmed" marker, so an ask is never silently dropped.
export function formatForTelegramParts(taskId, title, turn) {
  const base = title
    ? `\u{1F4CB} Task #${taskId} \u2014 ${title}`
    : `\u{1F4CB} Task #${taskId}`
  const headerFor = (part, total) =>
    `<b>${escapeHtml(total > 1 ? `${base} (${part}/${total})` : base)}</b>`

  // Budget for a single-message post.
  const roomOne = Math.max(0, TELEGRAM_MAX - headerFor(1, 1).length - 2)
  const wholeHtml = mdToTelegramHtml(turn)
  if (wholeHtml.length <= roomOne) return [`${headerFor(1, 1)}\n\n${wholeHtml}`]

  // Multi-part: the header now carries a counter, so budget against that.
  const room = Math.max(0, TELEGRAM_MAX - headerFor(1, 1).length - PART_COUNTER_RESERVE - 2)
  const { body, ask } = splitAsk(turn)

  let chunks = chunkMarkdown(turn, room)

  if (chunks.length > MAX_PARTS) {
    // Too long even when split. Give the ask the LAST parts and the body what is
    // left, so the thing the reader must act on always arrives.
    //
    // Subtlety worth keeping: the ask block itself can exceed one message (a turn
    // whose ask is a checklist — #272's is 7.8k chars). Keep the ask's OPENING
    // chunks, not its closing ones: `**Needs from you:**` is the first line of
    // the block, so trimming from the front deletes the very marker that makes it
    // an ask. A first cut of this did exactly that and still lost #272 and #437.
    const trimmedNote = '\u2702\ufe0f *Trimmed for Telegram \u2014 full text is in the journal.*'
    const askChunks = ask
      ? chunkMarkdown(`${trimmedNote}\n\n${ask}`, room)
      : [trimmedNote]
    // Always leave at least one part for the body.
    const askKeep = askChunks.slice(0, Math.max(1, Math.min(askChunks.length, MAX_PARTS - 1)))
    const headKeep = chunkMarkdown(body, room).slice(0, Math.max(0, MAX_PARTS - askKeep.length))
    chunks = [...headKeep, ...askKeep]
  }

  const total = chunks.length
  return chunks.map((c, i) => `${headerFor(i + 1, total)}\n\n${mdToTelegramHtml(c)}`)
}

// Plain-text fallback (no parse_mode) for the rare case Telegram rejects our
// HTML — delivery of the content matters more than the formatting.
function formatPlain(taskId, title, turn) {
  const header = title
    ? `\u{1F4CB} Task #${taskId} \u2014 ${title}`
    : `\u{1F4CB} Task #${taskId}`
  const body = `${header}\n\n${turn}`
  return body.length > TELEGRAM_MAX ? body.slice(0, TELEGRAM_MAX - 1) + '\u2026' : body
}

export function createBridge({
  client,
  config,
  state,
  io,
  logger = () => {},
  now = () => new Date(),
  // Called after each unit of durable progress (a posted turn, a folded reply).
  // Default is a no-op so every existing caller and test is unaffected.
  //
  // Why this exists (#172): `saveState` ran ONCE, after `syncOnce()` resolved.
  // `setLastPosted` only mutates memory, so anything that threw mid-loop -- a
  // rate limit being the common case -- meant that write never happened and
  // every task already posted looked unposted next run. A 14-task sweep that
  // died on task 11 re-posted the first 10. Nothing was lost; it just arrived
  // twice, on his phone.
  //
  // Checkpointing after each post makes an interrupted run resumable instead of
  // repeatable. A failed checkpoint is deliberately non-fatal: the post itself
  // already succeeded, and losing the run over a bookkeeping write would be a
  // worse outcome than the duplicate it prevents.
  persist = null,
} = {}) {
  const { chatId, taskAllowlist } = config

  async function checkpoint(label) {
    if (typeof persist !== 'function') return
    try {
      await persist(state)
    } catch (err) {
      logger(`could not checkpoint state after ${label} (${err.message})`)
    }
  }

  // Telegram's group budget is roughly 20 messages/minute, and a 429 tells us
  // exactly how long to wait. Waiting it out turns a run-killing error into a
  // pause; the alternative -- which is what happened -- is that the run dies and
  // the retry duplicates everything it had already delivered.
  //
  // Bounded on both axes so a pathological `retry_after` cannot hang a run: at
  // most RATE_LIMIT_MAX_RETRIES attempts, each capped at RATE_LIMIT_MAX_WAIT_MS.
  // If `retry_after` is absent the fallback is exponential, so behaviour
  // degrades safely rather than depending on the field being present.
  async function withRateLimitRetry(label, fn) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn()
      } catch (err) {
        if (!err || !err.isRateLimit || attempt >= RATE_LIMIT_MAX_RETRIES) throw err
        const advised = Number.isFinite(err.retryAfter) ? err.retryAfter * 1000 : null
        const backoff = advised != null ? advised : RATE_LIMIT_BASE_WAIT_MS * 2 ** attempt
        const waitMs = Math.min(backoff, RATE_LIMIT_MAX_WAIT_MS)
        logger(
          `rate limited on ${label}; waiting ${Math.round(waitMs / 1000)}s ` +
            `(attempt ${attempt + 1}/${RATE_LIMIT_MAX_RETRIES}` +
            `${advised != null ? ', server-advised' : ', no retry_after — backing off'})`,
        )
        await sleep(waitMs)
      }
    }
  }

  function isAllowed(taskId) {
    return taskAllowlist.length === 0 || taskAllowlist.includes(taskId)
  }

  async function ensureTopic(taskId, title) {
    const existing = getTask(state, taskId)
    if (existing && existing.topicId != null) return existing.topicId
    const name = topicName(taskId, title)
    // Creating a topic spends the same group quota as sending, and a new task
    // costs TWO calls (create + send) -- which is why a sweep with several new
    // topics hits the limit sooner than its task count suggests (#172).
    const result = await withRateLimitRetry(`createForumTopic task #${taskId}`, () =>
      client.createForumTopic({ chatId, name }),
    )
    const topicId = result.message_thread_id
    setTopic(state, taskId, topicId, name)
    logger(`created topic ${topicId} for task #${taskId}`)
    return topicId
  }

  // The set of task IDs currently on the completed board, read at most once per
  // run. Returns null when the board can't be read, which callers treat as "no
  // suppression" so a missing board never silences the mirror.
  let completedIds
  async function loadCompletedIds() {
    if (completedIds !== undefined) return completedIds
    if (typeof io.readCompletedBoard !== 'function') {
      completedIds = null
      return completedIds
    }
    try {
      completedIds = new Set(parseCompletedTaskIds(await io.readCompletedBoard()))
    } catch (err) {
      logger(`could not read completed board (${err.message}); posting to all tasks`)
      completedIds = null
    }
    return completedIds
  }

  // The set of task IDs currently on the ACTIVE board (planner.md), read at most
  // once per run. Returns null when the board can't be read.
  //
  // This exists because "is on the completed board" was being used as a synonym
  // for "is finished", and it isn't: a row can sit on BOTH boards at once. The
  // planner's sync layer produces exactly that (`clock:0` rows are, in the
  // board-integrity sweep's words, "primed to double-list"), and five live tasks
  // were in that state. For them the completed guard fired on a task the user
  // was actively working, so the mirror went silent on a live conversation.
  //
  // Active membership WINS: a task the user still has on their board is not
  // finished, whatever the completed board also says.
  let activeIds
  async function loadActiveIds() {
    if (activeIds !== undefined) return activeIds
    if (typeof io.readBoard !== 'function') {
      activeIds = null
      return activeIds
    }
    try {
      const board = parseBoardOrder(await io.readBoard())
      // An empty board is indistinguishable from an unreadable one here, and
      // treating "no rows" as "nothing is active" would suppress every
      // completed-board task on a transient read failure. Fall back to null
      // (= no active-board signal) instead.
      activeIds = board.size > 0 ? new Set(board.keys()) : null
    } catch (err) {
      logger(`could not read active board (${err.message}); using completed board alone`)
      activeIds = null
    }
    return activeIds
  }

  // Is this task finished, for the purposes of staying quiet? Only when the
  // completed board lists it AND the active board does not.
  function isFinished(completed, active, taskId) {
    if (!completed || !completed.has(taskId)) return false
    if (active && active.has(taskId)) return false // dual-board: still live
    return true
  }

  async function syncUp() {
    const posted = []
    const created = []
    const suppressed = []
    const linked = []
    const notified = []
    // #483 — what link mode removed, and what it would remove but has not been told it may.
    // `tidyPending` is the reportable half: it is the answer to "why does my topic still show
    // three messages when this feature shipped?", and it must be visible without reading logs.
    const tidied = []
    const tidyPending = []
    const collapsed = []
    // #586 — the two ways a doc link can end a run without having been checked. Reported
    // separately because they mean opposite things: `linkProbeDeferred` is the rolling schedule
    // working (its turn comes round shortly), `linkUnverified` is verification failing to
    // happen at all. Summing them would hide the second inside the first, which is the same
    // class of mistake as the bug being fixed — a real failure wearing the shape of routine.
    const linkUnverified = []
    const linkProbeDeferred = []
    // #588 — bound to a doc that no wake has written yet. Counted apart from the two probe
    // outcomes above: those are about a link we HAVE, this is about one we deliberately have
    // not posted. Collapsing them would hide a rollout stalling behind normal scheduling noise.
    const linkDeferredUnwritten = []
    const journals = await io.listJournals()
    const completed = await loadCompletedIds()
    const active = await loadActiveIds()
    // Chosen once, from state, before any journal is read: the selection is least-recently-
    // verified first and that ordering is only meaningful across the WHOLE candidate set.
    // Deciding per-task inside the loop would spend the budget on whichever tasks listJournals
    // happened to yield first, and starve the tail forever.
    const probeTargets = selectProbeTargets()

    for (const { taskId } of journals) {
      if (!isAllowed(taskId)) continue
      const content = await io.readJournal(taskId)
      if (!hasAgentBlock(content)) continue

      const turn = latestAgentTurn(content)
      if (!turn) continue

      const hash = hashTurn(turn)
      const task = getTask(state, taskId)

      // #424 — LINK MODE. Once #423 has bound a catch-up doc to this task, the topic holds one
      // message: the link. This is checked BEFORE the unchanged-turn guard below, on purpose.
      // The guard's job is "has the agent written something new?", and that is the wrong
      // question here: the link can go missing without the journal changing at all (the user
      // deletes it, or a send failed), and #424's acceptance requires that re-running restores
      // it. Gating the check on a new turn would make recovery depend on unrelated work
      // happening to occur.
      const docMeta = parseDocMeta(content)
      if (docMeta) {
        const outcome = await syncDocLink({ taskId, content, turn, hash, task, docMeta, completed, active, probeTargets })
        if (outcome.created) created.push(taskId)
        if (outcome.linked) linked.push(taskId)
        if (outcome.notified) notified.push(taskId)
        if (outcome.suppressed) suppressed.push(taskId)
        if (outcome.linkUnverified) linkUnverified.push(taskId)
        if (outcome.linkProbeDeferred) linkProbeDeferred.push(taskId)
        if (outcome.linkDeferredUnwritten) linkDeferredUnwritten.push(taskId)
        if (outcome.tidied) tidied.push({ taskId, messageIds: outcome.tidied })
        if (outcome.collapsed && outcome.collapsed.length)
          collapsed.push({ taskId, messageIds: outcome.collapsed })
        if (outcome.tidyPending) tidyPending.push({ taskId, messageIds: outcome.tidyPending })
        continue
      }

      // Natural, incremental mirroring: only act when there's a NEW agent turn
      // since we last posted for this task. If nothing changed, skip the task
      // ENTIRELY — no topic is created — so the bridge never mass-backfills
      // historical tasks the moment it starts running. Existing tasks are marked
      // as already-seen up front by `baseline` (run once), so their first topic
      // is created only when the agent next writes to them.
      if (task && task.lastPostedHash === hash) continue

      // A task that has reached the completed board is finished, and the user
      // should not hear about it again. Posting was previously gated ONLY on the
      // turn hash changing, which made it fire for reasons that have nothing to
      // do with the task being worked: any maintenance edit to an old journal
      // (reformatting a marker, repairing a block so the digest can parse it)
      // changes the parsed turn and therefore re-posted a months-old entry into
      // a closed topic. syncArchive() closes those topics, but the bot is a group
      // ADMIN and Telegram lets admins post into closed topics — so the message
      // landed anyway and the topic resurfaced, looking exactly like the agent
      // had started working a task the user had already closed.
      //
      // `isFinished` requires the task to be absent from the ACTIVE board too: a
      // dual-board row is still live and must post normally (#186).
      //
      // Record the declined hash in `suppressedHash`, NOT `lastPostedHash`.
      // Writing it to `lastPostedHash` marked an unsent turn as sent, and the
      // unchanged-turn check above fires first — so the turn could never be
      // delivered afterwards, even once the task became eligible. Suppression is
      // a pause, not a delete.
      if (isFinished(completed, active, taskId) && !(task && task.userEngaged)) {
        if (!task || task.suppressedHash !== hash) {
          setSuppressedHash(state, taskId, hash)
          logger(`suppressed post for completed task #${taskId} (no user reply since it closed)`)
        }
        suppressed.push(taskId)
        continue
      }

      // Adopt an existing topic id from the journal's own tg-meta marker when our
      // local state has forgotten it. state.json is machine-local and can be lost
      // or reset, but the marker travels with the cloud-synced journal and is the
      // durable record of "this task already has topic N". Reusing it here is what
      // prevents creating a DUPLICATE forum topic after a state reset.
      if (!task || task.topicId == null) {
        const meta = parseTgMeta(content)
        const existingThread = meta && `${meta.threadId}`.trim() !== '' ? Number(meta.threadId) : null
        if (existingThread != null && !Number.isNaN(existingThread)) {
          setTopic(state, taskId, existingThread, topicName(taskId, parseTitle(content)))
        }
      }

      const current = getTask(state, taskId)
      const hadTopic = current && current.topicId != null
      const title = parseTitle(content)
      const topicId = await ensureTopic(taskId, title)
      if (!hadTopic) created.push(taskId)

      // Stamp a hidden tg-meta marker into the journal so the planner web app
      // can build a deep link to this topic (the topic id lives only in our
      // local state.json otherwise). Only write when it actually changes so we
      // don't rewrite the file on every sync.
      const withMeta = upsertTgMetaMarker(content, { chatId, threadId: topicId })
      if (withMeta !== content) {
        await io.writeJournal(taskId, withMeta)
      }

      // Post the turn as one message, or as an ordered run of parts when it is
      // too long for one. `setLastPosted` runs only after the whole run is sent,
      // so a mid-run failure retries the turn rather than recording it as done;
      // and the plain-text fallback is per-part, so one rejected part never
      // costs the rest of the turn.
      //
      // COLLAPSE (#205): if our own previous turn for this task is still the last
      // thing in the topic and the user has NOT replied to it, that turn is
      // superseded and gets deleted once this one is safely out. Shiv's words:
      // "if I haven't responded, assume it's unread and can be clobbered."
      //
      // TWO gates, and each closes a way #205 was lossy in practice (#278):
      //
      // 1. THE BOUNDARY. `userEngaged` used to stand in for "has the user
      //    replied?" and it is the wrong signal: it is consumed by ANY post,
      //    including one authored before the user's message existed. The mirror
      //    runs sync-down then once in a single pass, so that is the normal
      //    case, not an edge case — the fold sets the flag and the very next
      //    post clears it without having answered anything. `replyCount` cannot
      //    be consumed by posting, so comparing it against the value captured
      //    when those ids went out asks the real question: has a reply landed
      //    SINCE? It is also stable, which is what #278's observation 2 (same
      //    task, no reply, collapse then no collapse) was missing.
      //
      // 2. LOSSLESSNESS. Collapse assumes the new turn says everything the old
      //    one did. When that is false the deletion is unrecoverable — it cost a
      //    YouTube link the replacement never carried forward. So if the turn
      //    being replaced holds a link this one does not, it is kept. Stacking
      //    is a cosmetic regression; a deleted link is lost content.
      //
      // `userEngaged` is left alone: it is load-bearing for a different job
      // (letting a closed task deliver one answer per user message) and
      // consuming it there is correct. It is still read here as a THIRD, purely
      // conservative freeze — it can only ever prevent a collapse, never cause a
      // wrong one, and it is what keeps pre-existing state (written before
      // `replyCount` existed, so it reads 0 === 0) safe across the upgrade.
      const repliesNow = getReplyCount(state, taskId)
      const repliesAtPost = task && Number.isInteger(task.lastPostedReplyCount)
        ? task.lastPostedReplyCount
        : 0
      const userSpokeSincePost = repliesNow !== repliesAtPost || !!(task && task.userEngaged)

      const turnLinks = extractLinks(turn)
      const priorLinks = task && Array.isArray(task.lastPostedLinks) ? task.lastPostedLinks : []
      const droppedLinks = priorLinks.filter((l) => !turnLinks.includes(l))

      const canCollapse =
        !!task &&
        !userSpokeSincePost &&
        !droppedLinks.length &&
        Array.isArray(task.lastPostedMessageIds)
      const supersedes = canCollapse ? task.lastPostedMessageIds : []

      if (task && Array.isArray(task.lastPostedMessageIds) && task.lastPostedMessageIds.length) {
        if (userSpokeSincePost) {
          logger(
            `not collapsing task #${taskId}: a reply was folded since that turn was posted ` +
              `(${repliesAtPost} -> ${repliesNow})`,
          )
        } else if (droppedLinks.length) {
          logger(
            `not collapsing task #${taskId}: the new turn drops ${droppedLinks.length} link(s) ` +
              `the previous one carried (${droppedLinks.join(', ')})`,
          )
        }
      }

      const parts = formatForTelegramParts(taskId, title, turn)

      // EDIT IN PLACE RATHER THAN POST-THEN-DELETE (#468). Collapse below is a
      // delete, and a delete is refused outside Telegram's 48h window — so on any
      // task woken less often than that, the new turn went out and the old one
      // stayed, which is the stacking Shiv is looking at. An edit has no such
      // window: `editMessageText` works on a message of any age. So when the same
      // gates that permit a collapse hold AND the new turn has exactly as many
      // parts as the one it replaces, rewrite those messages instead. Nothing is
      // posted and nothing is deleted, so there is no window in which the topic
      // holds neither turn.
      //
      // Strictly forward-only: this changes what the NEXT turn does. It never
      // reaches back over history.
      //
      // A part-count mismatch falls through to post-then-delete deliberately.
      // Editing 2 of 3 messages would leave the third holding stale prose with no
      // id to correct it, which is worse than the stacking it avoids.
      let editedIds = null
      if (
        supersedes.length &&
        supersedes.length === parts.length &&
        typeof client.editMessageText === 'function'
      ) {
        const done = []
        for (const [index, text] of parts.entries()) {
          const messageId = supersedes[index]
          try {
            await withRateLimitRetry(`editMessageText task #${taskId}`, () =>
              client.editMessageText({ chatId, messageId, text, parseMode: 'HTML' }),
            )
            done.push(messageId)
          } catch (err) {
            if (err && err.isRateLimit) throw err
            const msg = String((err && err.message) || '').toLowerCase()
            // Already says exactly this: the message on screen is the message we
            // wanted, so the edit succeeded in every sense that matters.
            if (msg.includes('not modified')) {
              done.push(messageId)
              continue
            }
            logger(
              `could not edit message ${messageId} for task #${taskId} ` +
                `(${err.message}); posting the turn instead`,
            )
            break
          }
        }
        if (done.length === parts.length) {
          editedIds = done
          logger(`edited ${done.length} message(s) in place for task #${taskId}`)
        }
      }

      const postedIds = editedIds ? editedIds.slice() : []
      const toPost = editedIds ? [] : parts
      for (const [index, text] of toPost.entries()) {
        try {
          const sent = await withRateLimitRetry(`sendMessage task #${taskId}`, () =>
            client.sendMessage({
              chatId,
              text,
              messageThreadId: topicId,
              parseMode: 'HTML',
            }),
          )
          if (sent && Number.isInteger(sent.message_id)) postedIds.push(sent.message_id)
        } catch (err) {
          // The plain-text fallback exists for ONE failure: Telegram rejecting
          // our HTML (an unexpected entity). It is exactly wrong for a rate
          // limit -- it spends another call against the same exhausted quota,
          // and it used to have no catch of its own, so the second 429
          // propagated and killed the run (#172). A 429 has already been waited
          // out and retried above by the time it reaches here, so re-sending is
          // pointless as well as harmful: let it stop this task, and keep the
          // ids already posted.
          if (err && err.isRateLimit) throw err
          logger(
            `HTML send failed for task #${taskId} part ${index + 1}/${parts.length} ` +
              `(${err.message}); retrying as plain text`,
          )
          const sent = await withRateLimitRetry(`sendMessage (plain) task #${taskId}`, () =>
            client.sendMessage({
              chatId,
              text: formatPlain(
                taskId,
                parts.length > 1 ? `${title} (${index + 1}/${parts.length})` : title,
                turn,
              ),
              messageThreadId: topicId,
            }),
          )
          if (sent && Number.isInteger(sent.message_id)) postedIds.push(sent.message_id)
        }
      }

      // Strictly AFTER the new turn is out. Deleting first would open a window in
      // which the topic contains neither turn, and a crash in between would leave
      // the user with nothing rather than with a duplicate. A failed delete is a
      // cosmetic regression to the old stacking behaviour; a failed post after a
      // successful delete is lost content.
      if (!editedIds && supersedes.length && typeof client.deleteMessage === 'function' && postedIds.length) {
        let removed = 0
        for (const messageId of supersedes) {
          try {
            await client.deleteMessage({ chatId, messageId })
            removed++
          } catch (err) {
            // Older than Telegram's 48h delete window, already gone, or lacking
            // rights. Never fatal: the worst case is the stacked message Shiv
            // was already seeing before this existed.
            logger(`could not collapse superseded message ${messageId} for task #${taskId} (${err.message})`)
          }
        }
        if (removed) logger(`collapsed ${removed} superseded message(s) for task #${taskId}`)
      }

      setLastPostedMessageIds(state, taskId, postedIds)
      // Capture the boundary alongside the ids, in the same step, so the two can
      // never disagree: a later collapse of THESE ids is allowed only while the
      // reply count still reads what it read here, and only while the turn that
      // replaces them still carries these links.
      setLastPostedContext(state, taskId, {
        replyCount: repliesNow,
        links: turnLinks,
      })
      setLastPosted(state, taskId, hash)
      // The pending-suppression marker has served its purpose once the turn is
      // out; clearing it keeps state from carrying a stale "we owe this task a
      // post" flag forever.
      if (task && task.suppressedHash) setSuppressedHash(state, taskId, null)
      // Consume the engagement: the user's message has now been answered. A
      // closed task therefore delivers one agent turn per user reply and then
      // goes quiet again, instead of the flag latching it permanently open.
      if (task && task.userEngaged) setUserEngaged(state, taskId, false)
      posted.push(taskId)
      logger(
        `posted task #${taskId} to topic ${topicId}` +
          (parts.length > 1 ? ` in ${parts.length} parts` : ''),
      )
      // Durable progress. Everything above is now on the user's phone, so the
      // fact of it must survive whatever happens to the rest of this loop.
      await checkpoint(`task #${taskId}`)
    }

    return {
      posted,
      created,
      suppressed,
      linked,
      notified,
      tidied,
      tidyPending,
      collapsed,
      linkUnverified,
      linkProbeDeferred,
      linkDeferredUnwritten,
    }
  }

  // #424's worker. Everything about it is shaped by one line in the issue: "Do not just
  // suppress posts... 'already posted' must be VERIFIED, not assumed, or the task goes
  // permanently silent. Silence and success would otherwise be identical."
  //
  // So a stored message id is treated as a place to PROBE, never as a promise. The probe is an
  // edit to the text the message should already hold: Telegram answers `message is not
  // modified` when it exists and `message to edit not found` when it does not. Both arrive as
  // errors, so the MESSAGE is read rather than the mere fact of failure — reading only
  // "did it throw?" would classify a healthy message as missing and repost it every run.
  async function syncDocLink({ taskId, content, turn, hash, task, docMeta, completed, active, probeTargets = null }) {
    const out = {
      created: false,
      linked: false,
      notified: false,
      suppressed: false,
      retracted: false,
      collapsed: [],
      // #586 — the two ways a link can end a run unconfirmed, kept apart on purpose. See the
      // probe branch below.
      linkUnverified: false,
      linkProbeDeferred: false,
      // #588 — bound, but the doc is still the placeholder `ensure-catchup-doc` created.
      linkDeferredUnwritten: false,
    }

    // A finished task stays quiet here exactly as it does for turns (#186): the topic is
    // archived and the user has closed it. A user reply reopens the conversation.
    if (isFinished(completed, active, taskId) && !(task && task.userEngaged)) {
      if (!task || task.suppressedHash !== hash) {
        setSuppressedHash(state, taskId, hash)
        logger(`suppressed doc link for completed task #${taskId} (no user reply since it closed)`)
      }
      out.suppressed = true
      return out
    }

    // #588 — DO NOT POINT AT A DOCUMENT NOBODY HAS WRITTEN.
    //
    // Binding and writing are separate events, so a task bound during a run would otherwise
    // have its link pushed in that SAME run, before any wake had put a word in the document.
    // Under #424 the link IS the wake's entire message, which makes a stub link worse than
    // silence: it spends the one message the topic gets on "this has not been written yet".
    //
    // Scoped to the FIRST post. A link already in the topic is left exactly as it is -- the
    // fix is forward-only, and retracting messages he has already seen would be going back to
    // correct history rather than correcting the build that produces it.
    //
    // Deferral is COUNTED and logged, never merely skipped. A step that quietly does nothing
    // is indistinguishable from a step that had nothing to do, which is the shape of the very
    // defect being fixed here; the run summary has to be able to say it happened.
    {
      const bound = getTask(state, taskId)
      const alreadyLinked = bound && Number.isInteger(bound.docLinkMessageId)
      if (!alreadyLinked && !docHasBeenWritten(content, docMeta.docId)) {
        out.linkDeferredUnwritten = true
        logger(
          `deferred catch-up doc link for task #${taskId}: doc ${docMeta.docId} is bound but not yet written`,
        )
        return out
      }
    }

    // Adopt an existing topic from the journal marker before creating one, same as syncUp.
    if (!task || task.topicId == null) {
      const meta = parseTgMeta(content)
      const existingThread = meta && `${meta.threadId}`.trim() !== '' ? Number(meta.threadId) : null
      if (existingThread != null && !Number.isNaN(existingThread)) {
        setTopic(state, taskId, existingThread, topicName(taskId, parseTitle(content)))
      }
    }

    const current = getTask(state, taskId)
    const hadTopic = current && current.topicId != null
    const title = parseTitle(content)
    const topicId = await ensureTopic(taskId, title)
    if (!hadTopic) out.created = true

    const withMeta = upsertTgMetaMarker(content, { chatId, threadId: topicId })
    if (withMeta !== content) await io.writeJournal(taskId, withMeta)

    // #620 — the notice rides in the pointer, so it has to be known BEFORE the pointer text is
    // built. Resolved asks are read back out of state here rather than recomputed, because the
    // whole point is that the words survive their own resolution.
    const priorEntry = getTask(state, taskId)
    const liveAsk = blockingAsk(turn)
    const liveTerminal = terminalStatus(turn)
    const retraction = retractedAsk(turn)
    const carriedAsk = priorEntry && priorEntry.docLinkAsk ? String(priorEntry.docLinkAsk) : null
    const carriedResolved =
      priorEntry && priorEntry.docLinkResolvedAsk ? String(priorEntry.docLinkResolvedAsk) : null
    // An ask that is no longer live becomes the trace. A NEW ask replaces the trace outright:
    // one outstanding thing at a time is the whole point of a single message, and a stack of
    // struck-through history inside the pointer would rebuild the complaint inside one bubble.
    const resolvedAsk = liveAsk ? null : carriedAsk || carriedResolved
    const noticeState = {
      ask: liveAsk,
      terminal: liveTerminal,
      resolved: resolvedAsk,
      retracted: resolvedAsk && retraction ? retraction : null,
    }

    const linkText = formatDocLink(taskId, title, docMeta.docUrl, noticeState)
    const entry = getTask(state, taskId)
    // A rebinding invalidates the old message: it points at a document that is no longer this
    // task's. Treat it as absent rather than editing it in place, so the stale link cannot
    // survive as a second, wrong pointer.
    const boundElsewhere = entry && entry.docLinkDocId && entry.docLinkDocId !== docMeta.docId
    const knownId = entry && Number.isInteger(entry.docLinkMessageId) && !boundElsewhere
      ? entry.docLinkMessageId
      : null

    let liveId = null
    if (knownId != null) {
      // `probeTargets === null` means the budget is switched off: probe everything.
      if (probeTargets === null || probeTargets.has(String(taskId))) {
        const probe = await verifyLinkMessage(taskId, knownId, linkText)
        liveId = probe.present ? knownId : null
        if (probe.verified) {
          // Only an actual observation refreshes the clock. Letting an assumption count as
          // verification would push the task to the BACK of the queue on the strength of a
          // guess -- so the links we know least about would be probed least often, which is
          // the failure this ordering exists to prevent.
          if (probe.present) setDocLinkVerified(state, taskId, Date.now())
        } else {
          out.linkUnverified = true
        }
      } else {
        // Deliberately not probed this run; its turn comes round within `docLinkProbeBudget`
        // runs. This is NOT the same state as an exhausted retry budget and is counted apart
        // from it: one is normal scheduling, the other is verification failing to happen. The
        // whole defect being fixed here was two different situations producing one
        // indistinguishable output, so collapsing these two would rebuild it.
        liveId = knownId
        out.linkProbeDeferred = true
      }
      if (liveId == null) {
        logger(`doc link for task #${taskId} is gone from topic ${topicId}; reposting`)
      }
    }

    if (liveId == null) {
      const sent = await withRateLimitRetry(`sendMessage (doc link) task #${taskId}`, () =>
        client.sendMessage({
          chatId,
          text: linkText,
          messageThreadId: topicId,
          parseMode: 'HTML',
          disablePreview: false,
        }),
      )
      if (sent && Number.isInteger(sent.message_id)) {
        liveId = sent.message_id
        setDocLink(state, taskId, { docId: docMeta.docId, messageId: liveId })
        // A successful send is first-hand evidence the message exists, so it starts the clock.
        // Without this a freshly posted link sorts as never-verified and jumps the queue next
        // run to re-confirm something we just watched Telegram accept.
        setDocLinkVerified(state, taskId, Date.now())
        out.linked = true
        logger(`posted catch-up doc link for task #${taskId} to topic ${topicId}`)
        // Pin it when we can. Best-effort: an unpinned link is a cosmetic loss, and the bot
        // may lack the right in some groups, so a failure must never stop the run.
        if (typeof client.pinChatMessage === 'function') {
          try {
            await client.pinChatMessage({ chatId, messageId: liveId })
          } catch (err) {
            logger(`could not pin doc link for task #${taskId} (${err.message})`)
          }
        }
      }
    } else if (boundElsewhere) {
      setDocLink(state, taskId, { docId: docMeta.docId, messageId: liveId })
    }

    // #483 — THE PRE-BINDING TURNS. A task bound to a doc after it had already been posting
    // turns leaves those turns sitting above the link forever, so its topic never reaches the
    // one message #424 specifies. The collapse that would remove them already exists, but it
    // lives on the turn path and only ever runs as a SIDE EFFECT of posting the next turn --
    // which a doc-bound task never does. So the one thing that could tidy them is the very post
    // this feature was built to stop, and no number of correct runs can reach them.
    //
    // Nothing here deletes by default. These are messages in the user's own thread and they are
    // the record of what happened; the flag is his word, not a setting the agent may assume.
    // See loadConfig for why link mode cannot judge losslessness for itself.
    if (liveId != null) {
      const bound = getTask(state, taskId)
      const noticeId =
        bound && Number.isInteger(bound.docLinkNoticeMessageId) ? bound.docLinkNoticeMessageId : null
      // The link is the replacement and the notice carries the one thing a link cannot, so
      // neither is ever a candidate. Both are managed by their own code above; excluding them
      // here is cheap insurance against a state file that ever conflates them with a turn.
      const original = Array.isArray(bound && bound.lastPostedMessageIds)
        ? bound.lastPostedMessageIds
        : []
      const stranded = original.filter(
        (id) => Number.isInteger(id) && id !== liveId && id !== noticeId,
      )

      if (stranded.length) {
        // The same freeze as the turn path, for the same reason: a message the user has replied
        // to is not a superseded draft, it is a conversation. `lastPostedReplyCount` is the
        // count as it stood when those ids went out, so this asks whether a reply landed SINCE
        // -- not whether one has ever landed at all.
        //
        // But that comparison is only meaningful while SOMETHING still maintains both halves,
        // and nothing here does: `setLastPostedContext` is the sole writer of
        // `lastPostedReplyCount` and it lives on the turn path, which link mode `continue`s
        // past. For a doc-bound task the captured half is pinned at the last pre-binding turn
        // while `repliesNow` keeps climbing -- and it climbs BECAUSE the link and the notice are
        // there to be replied to. Recomputed every run, the verdict flips to "spoke since" on
        // the first reply after binding and can never flip back, since the only thing that
        // clears it is a turn post #424 exists to prevent. The collapse was moved off the turn
        // path; its precondition was not.
        //
        // So decide once, when link mode takes ownership of these ids, and keep the answer.
        // `undefined` is "not yet asked" and is distinct from `false`.
        const recordedVerdict = getPreBindCollapseVerdict(state, taskId)
        let spokeSince
        if (typeof recordedVerdict === 'boolean') {
          spokeSince = recordedVerdict
        } else {
          const repliesNow = getReplyCount(state, taskId)
          const repliesAtPost = Number.isInteger(bound.lastPostedReplyCount)
            ? bound.lastPostedReplyCount
            : 0
          spokeSince = repliesNow !== repliesAtPost || !!bound.userEngaged
          setPreBindCollapseVerdict(state, taskId, spokeSince)
          if (spokeSince) {
            logger(
              `task #${taskId}: pre-binding message(s) frozen for good -- a reply landed since ` +
                `they went out (${repliesAtPost} -> ${repliesNow}). Recorded, so later replies ` +
                'to the link or the notice do not re-decide it.',
            )
          }
        }
        const strandedLinks = Array.isArray(bound.lastPostedLinks) ? bound.lastPostedLinks : []
        const carried = strandedLinks.length
          ? `, carrying ${strandedLinks.length} link(s) the doc link does not: ${strandedLinks.join(', ')}`
          : ''

        if (spokeSince) {
          logger(
            `not tidying ${stranded.length} pre-binding message(s) for task #${taskId}: a reply ` +
              'landed since they were posted',
          )
        } else if (config.tidyBoundTopics !== true && config.collapseBoundTurns) {
          // COLLAPSE, the default. Each stranded turn keeps its place in the thread and becomes
          // one line pointing at the doc. Nothing is removed, so this is not the floor's
          // "permanent data loss" and needs no word from him -- and it is literally what he
          // asked for: "I expected it to update or delete the last one."
          const collapsed = []
          for (const messageId of stranded) {
            const text = formatCollapsedTurn(taskId, {
              docUrl: docMeta.docUrl,
              links: strandedLinks,
            })
            try {
              await client.editMessageText({ chatId, messageId, text, parseMode: 'HTML' })
              collapsed.push(messageId)
            } catch (err) {
              const msg = String((err && err.message) || '').toLowerCase()
              // Already collapsed on an earlier run, so there is nothing to do and it is not a
              // failure. Counted as done, or every future run would retry it forever.
              if (msg.includes('not modified')) {
                collapsed.push(messageId)
                continue
              }
              // Older than Telegram's edit window, already gone, or lacking rights. Never fatal:
              // the worst case is the message stays as it is, which is where it was anyway.
              logger(`could not collapse message ${messageId} for task #${taskId} (${err.message})`)
            }
          }
          if (collapsed.length) {
            // Forgotten only once collapsed, and filtered from the ORIGINAL list so a message
            // that failed above survives in state for the next run to retry.
            setLastPostedMessageIds(
              state,
              taskId,
              original.filter((id) => !collapsed.includes(id)),
            )
            out.collapsed = collapsed.slice()
            logger(
              `collapsed ${collapsed.length} pre-binding message(s) for task #${taskId} into ` +
                'doc pointers',
            )
          }
        } else if (config.tidyBoundTopics !== true) {
          out.tidyPending = stranded.slice()
          logger(
            `task #${taskId} has ${stranded.length} pre-binding message(s) above its doc link ` +
              `(${stranded.join(', ')})${carried}. ` +
              'Set TELEGRAM_BRIDGE_TIDY_BOUND=on to remove them.',
          )
        } else if (typeof client.deleteMessage === 'function') {
          const removed = []
          for (const messageId of stranded) {
            try {
              await client.deleteMessage({ chatId, messageId })
              removed.push(messageId)
            } catch (err) {
              // Older than Telegram's 48h window, already gone, or lacking rights. Never fatal:
              // the worst case is the stacking that was there before this existed.
              logger(`could not tidy message ${messageId} for task #${taskId} (${err.message})`)
            }
          }
          // Only what is actually gone is forgotten, and the filter runs over the ORIGINAL list
          // so an id excluded above survives in state. Clearing the whole list on a partial
          // failure would strand the survivors permanently -- nothing else records them, so the
          // next run would not know they were ever there.
          if (removed.length) {
            setLastPostedMessageIds(
              state,
              taskId,
              original.filter((id) => !removed.includes(id)),
            )
            out.tidied = removed.slice()
            logger(
              `tidied ${removed.length} pre-binding message(s) for task #${taskId}` +
                (strandedLinks.length ? `; they carried ${strandedLinks.join(', ')}` : ''),
            )
          }
        }
      }
    }

    // #620 — RETIRING THE SEPARATE NOTICE.
    //
    // The exception that used to live here was sound and became the problem. #424 allowed one
    // short extra message for the two things a link genuinely cannot carry — the agent is
    // blocked on the user, or the task ended — on the understanding that this was rare. It is
    // not rare: measured across the live bridge state, 59 of 76 bound topics were sitting at
    // two permanent messages, because a doc-bound turn almost always declares an ask and the
    // turn guard requires it to. An exception holding in 78% of cases is the rule, and the rule
    // it had quietly replaced is the one that was asked for: "Every time I look at the app, I
    // expect to see a single telegram message per task."
    //
    // Nothing here was misbehaving, which is why no test of any part could see it. The ask now
    // rides in the pointer above, so this block no longer posts anything at all; what remains is
    // retiring the messages the old design already left in the topic.
    const legacyNoticeId =
      entry && Number.isInteger(entry.docLinkNoticeMessageId) ? entry.docLinkNoticeMessageId : null

    if (legacyNoticeId != null) {
      // Its content is not being destroyed — it is on screen in the pointer, either as the live
      // ask or as the struck-through trace of a resolved one, and it is in the doc and the
      // journal besides. So removing it loses nothing, which is what separates this from the
      // deletion #483 deliberately refused to do without his word: there, the message was the
      // only record of what it said.
      //
      // The reply freeze still applies, and for the original reason. A message he has answered
      // is not a superseded draft, it is his side of a conversation, and the agent does not get
      // to remove that however redundant its text has become.
      const repliesNow = getReplyCount(state, taskId)
      const repliesAtNotice = Number.isInteger(entry.docLinkNoticeReplyCount)
        ? entry.docLinkNoticeReplyCount
        : null

      if (repliesAtNotice == null) {
        // FIRST SIGHTING. Deliberately does not remove anything this run. The old state never
        // recorded the reply count at the moment the notice was posted, so whether he has
        // already answered it is not reconstructable — and guessing wrong here deletes a
        // message he replied to, which is the one outcome this must never produce. Record the
        // count and decide next run, when the question has become answerable.
        setDocLinkNoticeReplyCount(state, taskId, repliesNow)
        logger(
          `task #${taskId}: found a legacy notice message; recording the reply count (` +
            `${repliesNow}) and retiring it next run if nothing lands in between`,
        )
      } else if (repliesNow !== repliesAtNotice) {
        logger(
          `task #${taskId}: leaving the old notice message in place — a reply landed since it ` +
            `was seen (${repliesAtNotice} -> ${repliesNow}), so it is part of the conversation ` +
            'rather than a duplicate',
        )
        // Deliberately NOT forgetting the id. Forgetting it would make the next run believe
        // there was never a notice, and the topic would keep two messages forever with nothing
        // recording why. Kept, so the reason stays inspectable.
      } else if (typeof client.deleteMessage === 'function') {
        let removed = false
        try {
          await withRateLimitRetry(`deleteMessage (retire notice) task #${taskId}`, () =>
            client.deleteMessage({ chatId, messageId: legacyNoticeId }),
          )
          removed = true
        } catch (err) {
          // Telegram only lets a bot delete its own messages for 48h unless it is an admin, so
          // a failure here is expected on older topics rather than exceptional. Fall back to
          // collapsing it in place: the topic still converges on one message that MEANS
          // anything, and the stale demand stops standing unqualified. That is the same
          // fallback direction #483 chose, for the same reason — an edit needs no permission
          // because it removes nothing.
          logger(`could not delete the old notice for task #${taskId} (${err.message}); collapsing`)
          removed = await editNotice(
            taskId,
            legacyNoticeId,
            formatCollapsedTurn(taskId, { docUrl: docMeta.docUrl, links: [] }),
          )
        }

        if (removed) {
          out.noticeRetired = true
          setDocLinkNoticeHash(state, taskId, null)
          logger(`retired the separate notice for task #${taskId}; the pointer carries it now`)
        }
      }
    }

    // Record what the pointer is currently saying, so the next run can tell a resolved ask from
    // one that was never made. This is the state that makes the trace possible: without it,
    // resolution would have nothing to strike through and the ask would simply vanish.
    setDocLinkAsk(state, taskId, {
      ask: liveAsk,
      resolved: noticeState.resolved,
      retracted: noticeState.retracted,
    })
    if (liveAsk || liveTerminal || noticeState.resolved) out.notified = true

    // Record the turn as accounted for. If the doc binding is ever removed, the task falls back
    // to turn posting WITHOUT dumping the backlog it was quiet for -- which is the conservative
    // direction: a missed turn is visible in the doc, whereas a sudden flood of historical turns
    // is exactly the complaint this issue answers.
    setLastPosted(state, taskId, hash)
    if (task && task.suppressedHash) setSuppressedHash(state, taskId, null)
    if (task && task.userEngaged) setUserEngaged(state, taskId, false)
    await checkpoint(`task #${taskId} (doc link)`)
    return out
  }

  // Rewrite the notice already in the topic. Returns true only when Telegram CONFIRMS the edit
  // landed.
  //
  // The fail direction here is deliberately the OPPOSITE of verifyLinkMessage above, and the
  // difference is the point. The link never changes, so an inconclusive probe should assume the
  // message is fine and stay quiet — guessing "gone" would post a duplicate link every time the
  // API had a bad minute. A notice is the opposite: it carries NEW information (the agent is
  // blocked, or the task ended) that exists nowhere else in the topic. Assuming an unconfirmed
  // edit worked would silently drop the one message the user needs, which is #170's defect. So
  // anything short of a confirmed edit falls through to sending a fresh message: the worst case
  // is one duplicate line, against losing a blocking ask entirely.
  //
  // That trade holds for a genuine failure. It does NOT hold for a 429, and #586 is where the
  // difference bites: a rate limit is a "wait", and treating it as an unconfirmed edit sends a
  // second notice a few seconds later — through `withRateLimitRetry`, so the duplicate is the
  // call that actually succeeds. The result is a stacked pair of notices in the topic, produced
  // by the very code written to keep the topic to one message. Waiting first collapses that
  // case: the edit lands, and no second message is ever composed.
  async function editNotice(taskId, messageId, text) {
    try {
      await withRateLimitRetry(`edit notice task #${taskId}`, () =>
        client.editMessageText({ chatId, messageId, text, parseMode: 'HTML' }),
      )
      return true
    } catch (err) {
      const msg = String((err && err.message) || '').toLowerCase()
      // Already says exactly this. The message is present and correct, so there is nothing to
      // send — treating it as a failure would post a duplicate of a line already on screen.
      if (msg.includes('not modified')) return true
      logger(`could not update the notice for task #${taskId} (${err.message}); posting a new one`)
      return false
    }
  }

  // Does `messageId` still exist in the chat? See syncDocLink's header for why this is an edit.
  //
  // Returns a THREE-state answer, and the third state is the entire point of #586:
  //
  //   { present: true,  verified: true  }  Telegram confirmed the message is there.
  //   { present: false, verified: true  }  Telegram confirmed it is gone -- repost.
  //   { present: true,  verified: false }  We could not find out, and are assuming.
  //
  // The first two are evidence. The third is a guess, and it used to be indistinguishable from
  // the first: both returned bare `true`. That is how #424's guarantee -- "the link's existence
  // is VERIFIED, never assumed" -- silently stopped being in force while every log line read as
  // benign. A caller that cannot tell an observation from an assumption cannot report the
  // difference, so nobody could see that verification had stopped happening.
  //
  // Assuming present (rather than gone) on an unverified probe is still the right default: a
  // network blip or a permissions problem is not evidence of deletion, and guessing "gone"
  // would post a duplicate link every time the API had a bad minute. But that argument holds
  // only while the guess is RARE. When it fires on every task on every run it is not a
  // fallback, it is the behaviour -- so the guess is now counted and reported rather than
  // logged per-task in a tone that reads like routine.
  //
  // A 429 is NOT an inconclusive result. It is "ask again later", and the bridge has known how
  // to do that since #172 -- the probe simply never used it. Routing through the same bounded
  // retry as the send path means a rate limit costs a pause instead of a guarantee.
  async function verifyLinkMessage(taskId, messageId, text) {
    try {
      await withRateLimitRetry(`doc link probe task #${taskId}`, () =>
        client.editMessageText({ chatId, messageId, text, parseMode: 'HTML', disablePreview: false }),
      )
      return { present: true, verified: true }
    } catch (err) {
      const msg = String((err && err.message) || '').toLowerCase()
      if (msg.includes('not modified')) return { present: true, verified: true }
      if (
        msg.includes('message to edit not found') ||
        msg.includes("message can't be edited") ||
        msg.includes('message_id_invalid')
      ) {
        return { present: false, verified: true }
      }
      // Only reachable once the retry budget above is genuinely exhausted, so this is a real
      // sustained rate limit rather than the self-inflicted storm that used to land here.
      if (err && err.isRateLimit) {
        logger(
          `doc link for task #${taskId} could NOT be verified: still rate limited after ` +
            `${RATE_LIMIT_MAX_RETRIES} attempts (${err.message}); assuming it is still there`,
        )
        return { present: true, verified: false }
      }
      logger(`doc link probe for task #${taskId} was inconclusive (${err.message}); assuming it is still there`)
      return { present: true, verified: false }
    }
  }

  // WHICH links to probe this run (#586).
  //
  // The probe is an edit with byte-identical text: it costs a full call against a group budget
  // the code above documents as roughly 20 messages/minute, and its expected answer is "not
  // modified" -- it almost always confirms what state already said. Probing every bound link
  // every run therefore spends the whole budget to learn nothing, and once 61 tasks became
  // doc-bound the pass began rate-limiting ITSELF: every probe after the budget ran out
  // returned "assume present", and genuine operations later in the run (closeForumTopic) were
  // refused with a budget the probes had already drained.
  //
  // So verification becomes ROLLING rather than per-run: a bounded number of links are probed
  // each run, least-recently-verified first, and every link is therefore checked within a
  // bounded number of runs. That is weaker than "every link, every run" on paper and far
  // stronger in fact, because "every link, every run" was verifying nothing at all.
  //
  // Never-verified sorts first: "no evidence yet" is a stronger claim on the budget than
  // "evidence that is a few runs old".
  //
  // Candidates come from state, not from the journals, because only a task that has already
  // been linked has anything to probe. A task with no link message yet does not appear here at
  // all -- the budget gates VERIFYING a link, never SENDING one, so a new task still gets its
  // link immediately no matter how spent the budget is.
  function selectProbeTargets() {
    const budget = Number(config.docLinkProbeBudget)
    const candidates = Object.keys(state.tasks || {}).filter((id) =>
      Number.isInteger(state.tasks[id] && state.tasks[id].docLinkMessageId),
    )
    // Non-positive or non-finite means "no limit" -- the pre-#586 behaviour, kept as a
    // deliberate escape hatch rather than an accident.
    if (!Number.isFinite(budget) || budget <= 0) return null
    candidates.sort(
      (a, b) => (state.tasks[a].docLinkVerifiedAt || 0) - (state.tasks[b].docLinkVerifiedAt || 0),
    )
    return new Set(candidates.slice(0, budget))
  }

  async function syncDown() {
    const folded = []
    const unrouted = []
    const offset = state.updateOffset > 0 ? state.updateOffset : undefined
    const updates = await client.getUpdates({
      offset,
      allowedUpdates: ['message'],
    })

    // Only paid for when an off-topic reply actually shows up.
    let knownTaskIds = null
    const loadKnownTaskIds = async () => {
      if (!knownTaskIds) knownTaskIds = (await io.listJournals()).map((j) => j.taskId)
      return knownTaskIds
    }

    let maxUpdateId = state.updateOffset - 1
    for (const update of updates) {
      if (update.update_id > maxUpdateId) maxUpdateId = update.update_id
      const msg = update.message
      if (!msg) continue
      if (msg.from && msg.from.is_bot) continue
      const text = msg.text
      if (!text || !text.trim()) continue
      // Ignore the service message that opens a forum topic.
      if (msg.forum_topic_created) continue

      // A reply inside a task's topic is unambiguous — it answers that task.
      const topicTaskId =
        msg.message_thread_id != null ? findTaskByTopic(state, msg.message_thread_id) : null

      // Otherwise it's an answer to a cross-task digest (General, or a topic we
      // don't own). Previously these were dropped silently; now we route by the
      // task IDs named in the text. See routeReply.js.
      const routed = topicTaskId
        ? [{ taskId: topicTaskId, text }]
        : coalesceByTask(parseReplyRouting(text, { knownTaskIds: await loadKnownTaskIds() }))

      if (!routed.length) {
        // Nothing to file, but the user did say something — surface it instead
        // of pretending it never arrived.
        unrouted.push({ text, messageId: msg.message_id, threadId: msg.message_thread_id ?? null })
        logger(`could not route reply: ${text.slice(0, 80)}`)
        continue
      }

      const day = now().toISOString().slice(0, 10)
      for (const entry of routed) {
        let content
        try {
          content = await io.readJournal(entry.taskId)
        } catch {
          content = null
        }
        if (content == null) {
          // A named task with no journal file yet: don't lose the answer.
          unrouted.push({
            text: entry.text,
            messageId: msg.message_id,
            threadId: msg.message_thread_id ?? null,
          })
          logger(`no journal for task #${entry.taskId}; reply left unrouted`)
          continue
        }
        const updated = appendUserReply(content, { text: entry.text, date: day })
        await io.writeJournal(entry.taskId, updated)
        // The user has spoken about this task, so it is a live conversation even
        // if the task itself is closed. Without this, the completed-board guard
        // in syncUp would swallow the agent's reply and the user would be left
        // asking a question into a topic that never answers.
        setUserEngaged(state, entry.taskId, true)
        // The collapse boundary (#278). Separate from `userEngaged` on purpose:
        // this one is never consumed by a post, so "the user has spoken since
        // that turn went out" stays true until a turn is actually posted after
        // the reply — which is the only point at which the turn above it stops
        // being frozen.
        bumpReplyCount(state, entry.taskId)
        folded.push({ taskId: entry.taskId, text: entry.text })
        logger(`folded reply into task #${entry.taskId}`)
      }

      // Close the loop: a batched answer is worthless if the user can't tell it
      // registered. Ack only off-topic replies — inside a task topic the next
      // agent turn is itself the confirmation.
      if (!topicTaskId) {
        await acknowledge(msg, routed)
      }
    }

    if (updates.length) setOffset(state, maxUpdateId + 1)
    // The replies are already written into the journals at this point. If the
    // offset advance is not persisted, the next run re-reads and re-folds the
    // same updates, so checkpoint here too rather than only at the end.
    if (folded.length || updates.length) await checkpoint('syncDown')
    return { folded, unrouted }
  }

  // Best-effort receipt for a batched reply. Never let a failed ack abort the
  // run — the answers are already safely in the journals by this point.
  async function acknowledge(msg, routed) {
    const filed = routed.map((r) => `#${r.taskId}`).join(', ')
    try {
      await client.sendMessage({
        chatId,
        text: `\u2705 Filed to ${filed} \u2014 I'll pick these up on the next run.`,
        messageThreadId: msg.message_thread_id ?? undefined,
        replyToMessageId: msg.message_id,
      })
    } catch (err) {
      logger(`ack failed: ${err.message}`)
    }
  }

  async function syncOnce() {
    const up = await syncUp()
    const archived = await syncArchive()
    const down = await syncDown()
    // Digest goes LAST so it reflects the turns just posted, and so a failure
    // to compose it can never prevent the mirroring/fold-back work above from
    // being persisted.
    let digest = { posted: false, count: 0 }
    if (config.digestEnabled === false) {
      logger('digest disabled (TELEGRAM_BRIDGE_DIGEST=off); General thread left alone')
      digest = { posted: false, count: 0, skipped: true }
    } else {
      try {
        digest = await syncDigest()
      } catch (err) {
        logger(`digest failed (${err.message}); continuing`)
      }
    }
    return { up, archived, down, digest }
  }

  // Archive/unarchive task topics to mirror the board. A task that has moved to
  // planner-completed.md — OR that the user DELETED in the app — gets its forum
  // topic CLOSED (Telegram's reversible "archive": it collapses under the
  // group's Closed section and stops new non-admin posts). A task that later
  // leaves the completed board (reopened) gets its topic REOPENED. Both
  // directions are idempotent — we only call Telegram when the desired
  // archived-state differs from what we recorded, so re-runs are no-ops. A
  // per-topic failure (e.g. the bot lacks can_manage_topics) is logged and
  // skipped; it never aborts the run and is retried next time.
  //
  // Deleted tasks are included because a deletion removes the row from BOTH
  // boards, so `completed.has(id)` is false for them forever and their topics
  // used to stay open permanently. On the live planner that had accumulated 65
  // still-open topics for tasks that no longer exist.
  async function syncArchive() {
    const archived = []
    const reopened = []
    // Gated on the "Archive completed topics" setting (default on). When the
    // user turns it off we neither read the board nor touch any topic.
    if (config.archiveCompleted === false) return { archived, reopened, skipped: true }
    if (typeof io.readCompletedBoard !== 'function') return { archived, reopened }

    const board = await io.readCompletedBoard()
    const completed = new Set(parseCompletedTaskIds(board))
    // Same active-wins rule as syncUp: a task on BOTH boards is live, so its
    // topic must not be closed underneath an ongoing conversation (#186).
    const active = await loadActiveIds()

    // Tombstoned (deleted-in-app) tasks. Optional: an io without
    // readSyncRecords keeps the old completed-board-only behaviour, so existing
    // in-memory test harnesses and older callers are unaffected.
    const deleted = new Set()
    if (typeof io.readSyncRecords === 'function') {
      try {
        for (const raw of await io.readSyncRecords()) {
          for (const id of parseDeletedTaskIds(raw)) deleted.add(id)
        }
      } catch (err) {
        logger(`could not read sync records (${err.message}); archiving completed only`)
      }
    }

    for (const [taskId, task] of Object.entries(state.tasks)) {
      if (!task || task.topicId == null) continue
      if (!isAllowed(taskId)) continue

      // Active membership WINS over a tombstone too, not just over the
      // completed board. `readSyncRecords` returns EVERY planner sync record,
      // and a task that is live on the active board is legitimately absent from
      // `planner-completed.md`, so that record tombstones it as `deleted: true`.
      // Unioning both records loses which board a tombstone came from, turning
      // "not a row in the completed file" into "the user deleted this task".
      // Measured on the live planner: 37 active-board tasks carried such a
      // tombstone and 33 had their topic closed underneath them — including
      // #276, a task on the Today board. A genuine deletion leaves BOTH boards,
      // so it is still archived (#434) — this only rescues tasks the user can
      // still see.
      const isDeleted = deleted.has(taskId) && !(active && active.has(taskId))
      const shouldArchive = isFinished(completed, active, taskId) || isDeleted
      const isArchived = !!task.archived
      if (shouldArchive === isArchived) continue

      try {
        if (shouldArchive) {
          await client.closeForumTopic({ chatId, messageThreadId: task.topicId })
          setArchived(state, taskId, true)
          archived.push(taskId)
          logger(
            `archived (closed) topic ${task.topicId} for ` +
              `${isDeleted ? 'deleted' : 'completed'} task #${taskId}`,
          )
        } else {
          await client.reopenForumTopic({ chatId, messageThreadId: task.topicId })
          setArchived(state, taskId, false)
          reopened.push(taskId)
          logger(`reopened topic ${task.topicId} for reactivated task #${taskId}`)
        }
      } catch (err) {
        logger(
          `archive: ${shouldArchive ? 'close' : 'reopen'} failed for task #${taskId} ` +
            `(topic ${task.topicId}): ${err.message}`,
        )
      }
    }

    return { archived, reopened }
  }

  // Resolve WHERE the digest should be posted.
  //
  // Returns the message_thread_id to post into, or undefined for the General
  // thread (the historical behaviour, kept as the default so existing setups
  // are unaffected).
  //
  // A numeric setting is used as-is. A name is resolved to a topic exactly
  // once and cached in state — re-resolving every run would create a duplicate
  // "Waiting on you" topic every night, which is the obvious failure mode here.
  // Changing the configured name is treated as pointing at a different topic,
  // so it resolves afresh rather than quietly posting into the old one.
  async function resolveDigestThreadId() {
    const setting = (config.digestTopic || '').trim()
    if (!setting) return undefined

    if (/^\d+$/.test(setting)) return Number(setting)

    if (state.digestTopicId != null && state.digestTopicName === setting) {
      return state.digestTopicId
    }

    const result = await client.createForumTopic({ chatId, name: setting })
    const topicId = result.message_thread_id
    setDigestTopic(state, topicId, setting)
    logger(`created digest topic "${setting}" (${topicId})`)
    return topicId
  }

  // Post ONE consolidated "waiting on you" message listing every task's open
  // ask. It goes to the group's General thread by default, or to a dedicated
  // forum topic when TELEGRAM_BRIDGE_DIGEST_TOPIC names one.
  //
  // The asks are read from each task's NEWEST agent turn via latestAgentTurn —
  // never by grepping the journal for its last `Needs from you:` marker, which
  // can be weeks stale (see the note at the top of digest.js). Getting this
  // wrong would rebroadcast dead asks nightly.
  //
  // ⚠️ With ONE bounded exception. Journals are bottom-appended chat threads, so
  // the "newest agent turn" is often a conversational reply — and a reply about
  // some *other* task carries no ask marker. That silently demoted the task's
  // real, still-open ask out of the queue entirely: measured live 2026-08-23,
  // **38 tasks** had a properly-marked ask in their current agent block that the
  // user never saw, including one-word wins (#405 "go", #391 `merge 120`, and
  // the #371/#372/#388/#404 PR approvals). That is ~27% of all open asks.
  //
  // So when the newest turn has no ask, fall back to `agentBlockText()` — the
  // sentinel block only, stopping at the first chat entry. That is NOT the
  // whole-file grep the warning above forbids: it cannot reach a superseded
  // block or a marker buried in an old Run log, and the block is by definition
  // the agent's *current* state for the task (it holds the live Status line,
  // rewritten every time the agent acts). Terminal statuses are excluded so a
  // finished task can never be revived into the queue.
  //
  // Idempotent: the composed text is hashed and compared against the last one
  // posted, so a run where nothing changed posts nothing at all.
  async function syncDigest({ force = false } = {}) {
    const entries = []
    const journals = await io.listJournals()
    // #174: the completed board is the authority on whether the user has closed
    // a task, and it outranks anything written inside the journal.
    //
    // The terminal-status gates below read the journal's own `**Status:**`, and
    // they only drop a *weak* ask. So a finished task whose newest turn happens
    // to carry a strong `Needs from you:` / `Next:` marker stayed in the queue
    // forever — measured live 2026-09-02, **11 completed tasks** were still
    // being shown as open asks, every one of them strong.
    //
    // `isFinished()` is the predicate the posting path already uses, and it
    // already resolves the dual-board case the right way: a row on BOTH boards
    // is still live, so ambiguity resolves toward visible. Reusing it here means
    // the digest and the mirror cannot disagree about what "closed" means.
    const completedIds = await loadCompletedIds()
    const activeIds = await loadActiveIds()

    for (const { taskId } of journals) {
      if (!isAllowed(taskId)) continue
      // Closed on the board = out of the queue, whatever the journal says. A
      // stale `**Status:**` line cannot resurrect it, and neither can a strong
      // marker left behind in a turn the agent has already finished.
      if (isFinished(completedIds, activeIds, taskId)) continue
      const content = await io.readJournal(taskId)
      if (!hasAgentBlock(content)) continue
      const turn = latestAgentTurn(content)
      const block = agentBlockText(content)
      // #202: the task's LIVE status, arbitrated by date across the newest
      // Status-bearing turn and the sentinel block — NOT the block header alone.
      //
      // The header is frozen: `write-turn.ps1` is append-only by design, so nothing
      // has rewritten a `**Status:**` line since 2026-08-26. Reading it meant a task
      // the agent had FINISHED never left this queue — it kept its 2026-06-19
      // `blocked` header while its newest turn said `Done` and `Needs from you:
      // nothing`. Measured live: 10 of 239 journals disagreed, 9 on the active board,
      // staleness up to 73 days, and every future close leaked the same way.
      //
      // This also retires the dialect fault: the old capture stopped at a space, so
      // the human `In progress` became the bare token `in`, which is not a status but
      // is a truthy string — so `TERMINAL.has(status)` answered "not terminal" for the
      // wrong reason and looked correct. 18 of `drift-sweep [G]`'s 32 rows were this.
      //
      // The header is still passed in as the fallback, so this can only ever ADD
      // information: where the live reader has a verdict it wins, and where it has
      // none the previous behaviour stands exactly as before. See `digestStatus`.
      const status = digestStatus(content, agentBlockStatus(block))
      // An unparseable turn must NOT end the task's chances. A journal whose
      // newest agent entry is malformed - e.g. the `<!-- from: overnight-agent
      // -->` marker written ABOVE its `## <date>` heading, which makes the turn
      // body parse as empty - would otherwise be dropped here, before the
      // agent-block fallback below ever ran. Observed live on #273, a `## Today`
      // task holding a real `**Needs from you:** just approve` in its block.
      let ask = turn ? extractAskEntry(turn) : null
      // A `weak` ask was salvaged from boilerplate - SKILL.md's generic
      // `**Your call:**` line, or the remainder of a `Needs from you: none …`
      // that opened by dismissing the user. Both survive verbatim into turns
      // the agent has already closed, so on their own they must never drag a
      // finished task back into the approval queue. Strong markers keep their
      // existing behaviour and are still honoured on any status.
      if (ask && ask.weak && DIGEST_TERMINAL_STATUS.has(status)) ask = null
      if (!ask) {
        if (!block || DIGEST_TERMINAL_STATUS.has(status)) continue
        ask = extractAskEntry(block)
        if (!ask) continue
      }
      entries.push({
        taskId,
        title: parseTitle(content),
        ask: ask.text,
        source: ask.source,
      })
    }

    // The user's OWN board is the priority order — it is the thing he
    // maintains by hand, and `## Today` / 🔴 / row position is exactly how he
    // says what matters. So the board leads, and the ask's marker style only
    // breaks ties between tasks sitting at the same board position.
    //
    // This deliberately inverts the previous key order. Ranking `needs` above
    // `next` FIRST meant a single formatting choice inside a journal outranked
    // every priority the user had set: a 🔴 `## Today` task whose newest turn
    // happened to phrase its ask as `Next:` sorted below all ~81 ordinary
    // `Needs from you:` asks and fell off the size-capped message entirely.
    // Observed live one day after the board-order change landed: #356 (🔴),
    // #434 (`merge 154`) and #407 (`merge 124`) were all pushed out by
    // ordinary household rows, while the digest claimed to lead with the P0
    // merge asks. Marker style drifts every time a journal gains a turn; the
    // board does not, so the board has to be the stable key.
    //
    // Falls back to newest-first when there is no board to read.
    let board = null
    if (typeof io.readBoard === 'function') {
      try {
        board = parseBoardOrder(await io.readBoard())
      } catch {
        board = null
      }
    }
    const rank = (e) => (e.source === 'next' ? 1 : 0)
    entries.sort(
      (a, b) =>
        boardRank(board, a.taskId) - boardRank(board, b.taskId) ||
        boardIndex(board, a.taskId) - boardIndex(board, b.taskId) ||
        rank(a) - rank(b) ||
        Number(b.taskId) - Number(a.taskId),
    )

    // Only surface the privacy warning when it is actually true, so it stays
    // meaningful instead of becoming boilerplate the user learns to skip.
    //
    // `can_read_all_group_messages` ALONE is not sufficient, and trusting it
    // was an active bug: Telegram delivers every group message to a bot that
    // is a group ADMINISTRATOR regardless of the privacy flag, but `getMe`
    // keeps reporting `can_read_all_group_messages: false` for that bot. So an
    // admin bot printed "a message you merely type in the group is never
    // delivered" on top of every digest — false, and it put friction on the
    // exact channel the user chose as primary, telling him to reply-to-bot
    // when plain typing works fine.
    //
    // Judge by admin status first; only fall back to the flag when membership
    // can't be read. Any failure keeps the warning OFF, because a spurious
    // warning is worse than a missing one.
    let privacyModeOn = false
    try {
      const me = await client.getMe()
      const flagged = !!me && me.can_read_all_group_messages === false
      if (flagged && typeof client.getChatMember === 'function' && me.id != null) {
        try {
          const member = await client.getChatMember({ chatId, userId: me.id })
          const isAdmin =
            member &&
            (member.status === 'administrator' || member.status === 'creator')
          privacyModeOn = !isAdmin
        } catch {
          // Membership unreadable — fall back to the flag alone.
          privacyModeOn = true
        }
      } else {
        privacyModeOn = flagged
      }
    } catch {
      privacyModeOn = false
    }

    const md = buildDigest(entries, {
      date: now().toISOString().slice(0, 10),
      privacyModeOn,
      preserveOrder: true,
    })
    const hash = hashDigest(md)

    if (!force && state.lastDigestHash === hash) {
      logger(`digest unchanged (${entries.length} open asks); not posting`)
      return { posted: false, count: entries.length, hash }
    }

    // Resolved only once we know we're actually posting, so a run with an
    // unchanged queue never creates a topic as a side effect.
    const messageThreadId = await resolveDigestThreadId()

    try {
      await client.sendMessage({
        chatId,
        text: mdToTelegramHtml(md),
        parseMode: 'HTML',
        messageThreadId,
      })
    } catch (err) {
      logger(`HTML digest send failed (${err.message}); retrying as plain text`)
      await client.sendMessage({ chatId, text: md, messageThreadId })
    }

    setLastDigest(state, hash)
    logger(
      `posted digest with ${entries.length} open ask(s)` +
        (messageThreadId != null ? ` to topic ${messageThreadId}` : ' to General'),
    )
    return { posted: true, count: entries.length, hash, threadId: messageThreadId ?? null }
  }

  // One-time (idempotent) setup: record each existing agent-block journal's
  // current latest-turn hash as "already posted" WITHOUT creating a topic or
  // sending anything. After this, syncUp only mirrors tasks whose agent turn
  // changes afterwards — so the bridge starts fresh from "now" instead of
  // backfilling the whole history. Tasks that already have a posted history are
  // left untouched.
  async function baseline() {
    const seen = []
    const skipped = []
    const journals = await io.listJournals()

    for (const { taskId } of journals) {
      if (!isAllowed(taskId)) continue
      const content = await io.readJournal(taskId)
      if (!hasAgentBlock(content)) continue
      const turn = latestAgentTurn(content)
      if (!turn) continue

      const task = getTask(state, taskId)
      if (task && task.lastPostedHash) {
        skipped.push(taskId) // already tracked/posted — don't clobber
        continue
      }
      setLastPosted(state, taskId, hashTurn(turn))
      seen.push(taskId)
    }

    return { seen, skipped }
  }

  // Migration for the TURN_END boundary fix. Changing what `latestAgentTurn()`
  // returns changes `hashTurn()`, and syncUp dedupes on exactly that hash — so
  // without this, shipping the fix would re-post one stale turn for every
  // journal whose stamp used to be swallowed (36 live journals when this was
  // written). That is the very duplicate-message symptom the fix exists to stop.
  //
  // It is deliberately narrow: a task is re-baselined ONLY when its stored hash
  // matches the LEGACY parse of the journal as it stands right now. That proves
  // the stored hash refers to this exact turn, already delivered, and that the
  // only thing that moved is how we parse it. Any task whose stored hash matches
  // neither parse has genuinely new content and is left alone, so a real pending
  // post can never be silently absorbed.
  //
  // Idempotent: after it runs, stored === new hash, which matches no legacy hash
  // that differs, so a second run migrates nothing.
  async function rebaselineTurnEnd() {
    const migrated = []
    const unchanged = []
    const pending = []
    const journals = await io.listJournals()

    for (const { taskId } of journals) {
      if (!isAllowed(taskId)) continue
      const task = getTask(state, taskId)
      if (!task || !task.lastPostedHash) continue

      const content = await io.readJournal(taskId)
      if (!hasAgentBlock(content)) continue

      const next = latestAgentTurn(content)
      const legacy = latestAgentTurn(content, { includeTurnEnd: true })
      if (!next || !legacy) continue

      const nextHash = hashTurn(next)
      const legacyHash = hashTurn(legacy)

      if (nextHash === legacyHash) {
        unchanged.push(taskId) // no stamp in this turn — the fix is a no-op here
        continue
      }
      if (task.lastPostedHash === legacyHash) {
        setLastPosted(state, taskId, nextHash)
        migrated.push(taskId)
      } else {
        // Stored hash matches neither parse: this turn has moved on since it was
        // posted, so it is legitimately due a post. Leave it for syncUp.
        pending.push(taskId)
      }
    }

    return { migrated, unchanged, pending }
  }

  // One-time repair for the turns the old completed-guard destroyed (#186).
  //
  // Before the fix, suppression wrote the declined hash into `lastPostedHash`,
  // which marks an UNSENT turn as sent. For a dual-board task — live on
  // planner.md and also listed on planner-completed.md — that guard fired every
  // run, so its current turn is recorded as delivered while the user never saw
  // it. Fixing the guard alone does not release those turns: the unchanged-turn
  // check still matches the absorbed hash and skips them forever.
  //
  // Scope is deliberately narrow: ONLY tasks the active board still lists AND
  // the completed board also lists. A task that is genuinely completed is left
  // alone, so #170 cannot regress into re-posting closed work.
  async function recoverSuppressed() {
    const released = []
    const journals = await io.listJournals()
    const completed = await loadCompletedIds()
    const active = await loadActiveIds()
    if (!completed || !active) return { released, skipped: 'no board signal' }

    for (const { taskId } of journals) {
      if (!isAllowed(taskId)) continue
      if (!completed.has(taskId) || !active.has(taskId)) continue

      const task = getTask(state, taskId)
      if (!task || !task.lastPostedHash) continue

      const content = await io.readJournal(taskId)
      if (!hasAgentBlock(content)) continue
      const turn = latestAgentTurn(content)
      if (!turn) continue

      // Only release when the stored hash IS the current turn — that is the
      // absorbed state. If they differ, the task already has a newer turn that
      // syncUp will post on its own and nothing needs clearing.
      if (task.lastPostedHash !== hashTurn(turn)) continue

      setLastPosted(state, taskId, null)
      released.push(taskId)
      logger(`released suppressed turn for dual-board task #${taskId}`)
    }

    return { released }
  }

  return {
    ensureTopic,
    syncUp,
    syncDown,
    syncArchive,
    syncOnce,
    syncDigest,
    baseline,
    rebaselineTurnEnd,
    recoverSuppressed,
  }
}
