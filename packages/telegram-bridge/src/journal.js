// Pure helpers for reading Focus Planner task journals and folding replies
// back in. No filesystem access here so the parsing stays trivially testable.

export const SENTINEL_MARKER =
  '<!-- OVERNIGHT-AGENT do not edit this line'
export const FROM_ME = '<!-- from: me -->'
export const FROM_AGENT = '<!-- from: overnight-agent -->'
export const AGENT_HEADER = '## \u{1F319} Overnight Agent' // "## 🌙 Overnight Agent"

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
 * The most recent agent-authored message in the journal — either the latest
 * `<!-- from: overnight-agent -->` chat entry or the managed plan block,
 * whichever appears later. Returns the trimmed text, or null if none.
 */
export function latestAgentTurn(content) {
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
