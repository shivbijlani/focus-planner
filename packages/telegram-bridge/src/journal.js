// Pure helpers for reading Focus Planner task journals and folding replies
// back in. No filesystem access here so the parsing stays trivially testable.

export const SENTINEL_MARKER =
  '<!-- OVERNIGHT-AGENT do not edit this line'
export const FROM_ME = '<!-- from: me -->'
export const FROM_AGENT = '<!-- from: overnight-agent -->'
export const AGENT_HEADER = '## \u{1F319} Overnight Agent' // "## 🌙 Overnight Agent"

// Written by `oa-state.ps1 mark` (skill side) to stamp where the agent's turn
// ended, so a reply typed underneath can never be absorbed into the turn. It is
// agent bookkeeping, NOT content: the reader must treat it as a boundary, the
// same way it treats a `<!-- from: … -->` marker or a date header.
export const TURN_END = '<!-- /overnight-agent turn-end -->'

const DATE_HEADER = /^##\s+\d{4}-\d{2}-\d{2}/

/** `task-352.md` -> `352` (null if it doesn't match). */
export function taskIdFromFilename(filename) {
  const m = /^task-(\d+)\.md$/i.exec(filename)
  return m ? m[1] : null
}

/** `352` -> `task-352.md`. */
export function journalFilename(taskId) {
  return `task-${taskId}.md`
}

/** Pull the task title out of the `# Task <id>: <title>` H1 (or first H1). */
export function parseTitle(content) {
  const lines = content.split(/\r?\n/)
  for (const line of lines) {
    const titled = /^#\s+Task\s+\d+:\s*(.+?)\s*$/i.exec(line)
    if (titled) return titled[1].trim()
    const h1 = /^#\s+(.+?)\s*$/.exec(line)
    if (h1) return h1[1].trim()
  }
  return ''
}

/**
 * A Telegram forum topic name for a task. Telegram caps topic names at 128
 * chars, so truncate defensively.
 */
export function topicName(taskId, title) {
  const base = title ? `#${taskId} \u00B7 ${title}` : `#${taskId}`
  return base.length > 128 ? base.slice(0, 125) + '\u2026' : base
}

/** Split a journal into { head, block } at the agent sentinel marker. */
export function splitAtSentinel(content) {
  const idx = content.indexOf(SENTINEL_MARKER)
  if (idx === -1) return { head: content, block: '' }
  // Back up to the start of the sentinel's own line so the "---" rule above it
  // is treated as part of the head, not the managed block.
  const lineStart = content.lastIndexOf('\n', idx) + 1
  return { head: content.slice(0, lineStart), block: content.slice(lineStart) }
}

/** True when the journal has the agent-managed block at all. */
export function hasAgentBlock(content) {
  return content.includes(SENTINEL_MARKER)
}

/**
 * The agent-managed block ONLY — from the sentinel down to the first chat entry
 * that follows it. Chat entries (`<!-- from: … -->`) are conversation appended
 * *below* the block; they are not part of it.
 *
 * This is deliberately a bounded region, not a whole-file scan: it cannot reach
 * an older superseded block or a stale marker buried in a historical Run log,
 * which is the failure mode digest.js warns about. The block is the agent's
 * current state for the task — it carries the live `**Status:**` and
 * `**Needs from you:**` — so it is the right fallback when the newest chat turn
 * happens not to restate the ask.
 *
 * A chat entry is `## <date>` followed by a `<!-- from: … -->` marker, so the
 * date header is the real boundary. A *bare* `<!-- from: overnight-agent -->`
 * seen before any date header is not a chat entry at all — it is a stray
 * provenance stamp some past run wrote INSIDE the block, above the plan body.
 * Treating it as a terminator severed the block at that line and discarded the
 * `**Needs from you:**` / `**Your call:**` below it, which silently disabled the
 * whole agent-block fallback in syncDigest() for those tasks. Measured live:
 * 26 journals in this shape, and #308 — a `proposed` ask open since 2026-08-10
 * whose newest turn also carries no marker — was dropped from the digest
 * entirely as a result. `<!-- from: me -->` still terminates unconditionally:
 * once the user has spoken, the block is over regardless of headers.
 */
export function agentBlockText(content) {
  const { block } = splitAtSentinel(content)
  if (!block) return null
  const lines = block.split(/\r?\n/)
  const body = []
  let sawDateHeader = false
  for (const raw of lines) {
    const trimmed = raw.trim()
    if (trimmed === FROM_ME) break
    if (DATE_HEADER.test(raw)) {
      sawDateHeader = true
      break
    }
    if (trimmed === FROM_AGENT && sawDateHeader) break
    body.push(raw)
  }
  return body.join('\n').trim() || null
}

/**
 * The status word from a block's `**Status:** Proposed · plan v1 · <date>` line,
 * lowercased (e.g. `proposed`, `done`, `in-progress`). Null when absent.
 */
export function agentBlockStatus(block) {
  if (!block) return null
  const m = /^\s*\*{0,2}Status:?\*{0,2}\s*:?\s*\*{0,2}([A-Za-z-]+)/m.exec(block)
  return m ? m[1].toLowerCase() : null
}

/**
 * The most recent agent-authored message in the journal — either the latest
 * `<!-- from: overnight-agent -->` chat entry or the managed plan block,
 * whichever appears later. Returns the trimmed text, or null if none.
 *
 * The turn ends at the `TURN_END` stamp. Not honouring it had two costs, both
 * measured live against 124 open board rows:
 *   1. `mark` appends the stamp AFTER the turn was posted, so the turn text —
 *      and therefore `hashTurn()`, which is syncUp's only dedupe key — changed
 *      for an already-delivered turn and the bridge re-posted it. 90/90 of the
 *      journals `mark` would touch flipped hash.
 *   2. The raw stamp fell inside the body and was rendered into the message, so
 *      the user literally read `<!-- /overnight-agent turn-end -->` at the
 *      bottom of 36 journals' Telegram messages.
 *
 * `includeTurnEnd` reproduces the old, stamp-swallowing parse. It exists for
 * ONE caller — the `rebaseline-turn-end` migration, which needs the legacy hash
 * to recognise a turn that was already delivered under the old rule. Nothing
 * else should set it.
 */
export function latestAgentTurn(content, { includeTurnEnd = false } = {}) {
  const lines = content.split(/\r?\n/)
  let startLine = -1
  let startKind = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (line === FROM_AGENT) {
      startLine = i
      startKind = 'marker'
    } else if (lines[i].startsWith(AGENT_HEADER)) {
      if (i > startLine) {
        startLine = i
        startKind = 'plan'
      }
    }
  }

  if (startLine === -1) return null

  const body = []
  for (let j = startLine + 1; j < lines.length; j++) {
    const raw = lines[j]
    const trimmed = raw.trim()
    if (trimmed === FROM_ME || trimmed === FROM_AGENT) break
    if (!includeTurnEnd && trimmed === TURN_END) break
    if (DATE_HEADER.test(raw)) break
    if (startKind === 'marker' && /^##\s/.test(raw)) break
    if (startKind === 'plan' && /^##\s/.test(raw) && !raw.startsWith(AGENT_HEADER))
      break
    body.push(raw)
  }

  return body.join('\n').trim() || null
}

/**
 * Append a user reply to the bottom of the journal as a dated
 * `<!-- from: me -->` chat entry — exactly the shape the Focus Planner app
 * appends, so the existing oa-state reopen loop picks it up unchanged.
 */
export function appendUserReply(content, { text, date }) {
  const day = date || new Date().toISOString().slice(0, 10)
  const trimmedEnd = content.replace(/\s+$/, '')
  const entry = `## ${day}\n\n${FROM_ME}\n${text.trim()}\n`
  return `${trimmedEnd}\n\n${entry}`
}
