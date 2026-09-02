// Build a "paper" model of a task from its journal markdown.
//
// THE POINT (issue #286): a journal is a chronological log, and a log is the wrong
// shape for understanding a complicated task. The current state is scattered across
// every turn that ever touched it, interleaved with corrections, newest last. Shiv:
// "What helps is one doc that assumes I have little context and is easy to read...
// It should be a paper. No talk about corrections and mistakes you made. That could
// go into appendix."
//
// So the transform is structural rather than editorial. Nothing is rewritten and no
// model is invoked: the NEWEST agent turn is the settled current state and becomes
// the body, and everything that is by construction chain-of-thought -- every
// superseded turn, and the timestamped Run log of the current one -- is moved to the
// appendix. That is deterministic, so regenerating produces byte-identical output for
// unchanged input, which is what makes "regenerate every run" safe.
//
// WHY REGENERATE RATHER THAN MAINTAIN: settled on evidence in #286 itself. A
// hand-maintained document has no mechanism to notice it has gone stale, and the
// prototype demonstrated the failure on itself -- its own quoted figures began
// decaying the day they were written. A regenerated one re-measures every run.
//
// READERS ARE SHARED, NEVER RE-IMPLEMENTED. `parseJournalChat` (fence-masked, #320)
// decides who wrote what; `agentBlockStatus` reads the status word; `extractAskEntry`
// finds the open ask. Copying any of those here is exactly how the app writer and the
// consent gate drifted apart in #325 -- two readers disagreeing about whether Shiv
// approved something. One implementation each, imported.

import { parseJournalChat, fencedLineMask } from '../../../src/journalChat.js'
import { agentBlockStatus, parseTitle } from '../../telegram-bridge/src/journal.js'
import { extractAskEntry } from '../../telegram-bridge/src/digest.js'

// The agent's own turn header, "## 🌙 Overnight Agent — <headline>". Matching it is
// what splits a run of consecutive agent turns into DISCRETE turns: `parseJournalChat`
// groups by author and day, so two turns written the same day with no reply between
// them arrive as one group. Presenting that merged group as a single unit is the
// "stacked messages" complaint (#286) reproduced in a new surface, so it is split here.
export const AGENT_TURN_HEADING_RE = /^\s{0,3}##\s*\u{1F319}/u

// Sections of a turn that are chain-of-thought by construction and belong in the
// appendix rather than the body. `Run log` is dated, per-run narration -- literally
// the "timestamped info showing chain of thought" the issue rules out of the paper.
const APPENDIX_SECTION_RE = /^(?:run\s*log|honest\s+note|corrections?|what\s+i\s+got\s+wrong)\b/i

const STATUS_LINE_RE = /^\s*\*{0,2}Status:?\*{0,2}\s*:?\s*(.+)$/i

/** Strip trailing/leading blank lines without touching interior blanks. */
function trimBlank(lines) {
  let a = 0
  let b = lines.length
  while (a < b && lines[a].trim() === '') a++
  while (b > a && lines[b - 1].trim() === '') b--
  return lines.slice(a, b)
}

// SKILL.md defines the agent's managed region as "the `---` immediately followed by
// the OVERNIGHT-AGENT sentinel", so that rule belongs to the sentinel, not to the
// message above it. The shared chat parser drops the sentinel comment but keeps the
// rule, which therefore lands at the end of whatever the user last said. Left in, it
// renders as a stray divider hanging off their message.
function stripTrailingRule(lines) {
  const out = lines.slice()
  while (out.length && /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(out[out.length - 1])) out.pop()
  return trimBlank(out)
}

/**
 * Split a turn body into `### `-delimited sections. Text before the first `###`
 * is the lead and is returned with a null heading.
 *
 * Fence-masked for the same reason everything else here is: these journals quote
 * markdown headings inside examples constantly, and splitting on a quoted `###`
 * would tear a section in half and file the remainder under a heading that was
 * never a heading.
 */
export function splitSections(body) {
  const lines = String(body ?? '').split('\n')
  const mask = fencedLineMask(lines)
  const sections = []
  let cur = { heading: null, lines: [] }
  for (const [i, line] of lines.entries()) {
    const m = mask[i] ? null : line.match(/^\s{0,3}(#{3,6})\s+(.*?)\s*#*\s*$/)
    if (m) {
      if (cur.heading !== null || trimBlank(cur.lines).length) sections.push(cur)
      cur = { heading: m[2].trim(), level: m[1].length, lines: [] }
      continue
    }
    cur.lines.push(line)
  }
  if (cur.heading !== null || trimBlank(cur.lines).length) sections.push(cur)
  return sections.map((s) => ({
    heading: s.heading,
    level: s.level || 3,
    body: trimBlank(s.lines).join('\n'),
  }))
}

/**
 * Split a run of agent lines into discrete turns at each `## 🌙` header.
 *
 * Takes a flat `{ day, line }` stream rather than a group, because a single agent
 * turn does NOT correspond to a single parser group. `parseJournalChat` starts a new
 * group whenever the author label changes, and a turn's own header sits above its
 * `<!-- from: overnight-agent -->` marker — so the sentinel opens a group holding
 * only the header, and the marker opens another holding the body. Keyed off groups,
 * that one turn is reported as two: a heading with no content, and content with no
 * heading. The `## 🌙` header is the real boundary, so it is the one used.
 */
function splitAgentStream(entries) {
  const mask = fencedLineMask(entries.map((e) => e.line))
  const turns = []
  let cur = null
  for (const [i, entry] of entries.entries()) {
    if (!mask[i] && AGENT_TURN_HEADING_RE.test(entry.line)) {
      if (cur) turns.push(cur)
      cur = {
        heading: entry.line.replace(/^\s{0,3}##\s*/, '').trim(),
        day: entry.day,
        author: entry.agent || 'overnight-agent',
        lines: [],
      }
      continue
    }
    if (!cur) {
      cur = { heading: null, day: entry.day, author: entry.agent || 'overnight-agent', lines: [] }
    }
    // A turn's day is the day of its newest content, so a turn that spans a date
    // header is reported under the day it was actually finished.
    if (entry.day) cur.day = cur.day || entry.day
    cur.lines.push(entry.line)
  }
  if (cur) turns.push(cur)
  return turns
    .map((t) => ({
      kind: 'agent',
      day: t.day,
      author: t.author,
      heading: t.heading,
      body: trimBlank(t.lines).join('\n'),
    }))
    .filter((t) => t.heading || t.body)
}

/**
 * Turn journal markdown into a paper model.
 *
 * Returns a plain object; rendering is a separate concern (`render.js`) so the
 * structure can be asserted directly in tests without parsing HTML back out.
 */
export function buildPaper(content, { taskId = null } = {}) {
  const source = String(content ?? '')
  const { title, pinned, groups } = parseJournalChat(source)
  // `parseTitle` strips the `Task <id>: ` prefix; the chat parser keeps the whole H1.
  // The id is already shown as its own label, so the prefix would just repeat it.
  const headline = parseTitle(source) || title

  const turns = []
  let pendingAgent = []
  const flushAgent = () => {
    if (pendingAgent.length) turns.push(...splitAgentStream(pendingAgent))
    pendingAgent = []
  }

  for (const g of groups) {
    if (g.author === 'agent') {
      // Separate concatenated groups so two paragraphs never fuse into one.
      if (pendingAgent.length) pendingAgent.push({ day: g.day, line: '', agent: g.agent })
      for (const line of g.lines) pendingAgent.push({ day: g.day, line, agent: g.agent })
    } else {
      flushAgent()
      const body = stripTrailingRule(g.lines).join('\n')
      if (body) turns.push({ kind: 'user', day: g.day, author: 'me', heading: null, body })
    }
  }
  flushAgent()

  const agentTurns = turns.filter((t) => t.kind === 'agent')
  const userTurns = turns.filter((t) => t.kind === 'user')
  const currentTurn = agentTurns.length ? agentTurns[agentTurns.length - 1] : null

  // Everything except the current turn is history, newest first.
  const priorTurns = currentTurn
    ? turns.slice(0, turns.lastIndexOf(currentTurn)).slice().reverse()
    : turns.slice().reverse()

  let statusLine = null
  const bodySections = []
  const appendixSections = []

  if (currentTurn) {
    for (const section of splitSections(currentTurn.body)) {
      const kept = []
      for (const line of section.body.split('\n')) {
        // The status line is metadata: it is promoted to the header rather than
        // left mid-prose, where it reads as narration.
        if (statusLine === null && section.heading === null) {
          const m = line.match(STATUS_LINE_RE)
          if (m) { statusLine = m[1].trim(); continue }
        }
        kept.push(line)
      }
      const cleaned = { ...section, body: trimBlank(kept).join('\n') }
      if (!cleaned.heading && !cleaned.body) continue
      if (cleaned.heading && APPENDIX_SECTION_RE.test(cleaned.heading)) appendixSections.push(cleaned)
      else bodySections.push(cleaned)
    }
  }

  const status = agentBlockStatus(currentTurn ? currentTurn.body : null) ||
    agentBlockStatus(source)
  const ask = currentTurn ? extractAskEntry(currentTurn.body) : null

  return {
    taskId: taskId == null ? null : String(taskId),
    title: headline || (taskId ? `Task ${taskId}` : 'Task'),
    framing: stripTrailingRule(pinned).join('\n'),
    status: status || null,
    statusLine,
    ask,
    current: currentTurn
      ? {
          day: currentTurn.day,
          heading: currentTurn.heading,
          sections: bodySections,
        }
      : null,
    appendix: {
      sections: appendixSections,
      priorTurns,
    },
    userMessages: userTurns.slice().reverse(),
    counts: {
      turns: turns.length,
      agentTurns: agentTurns.length,
      userMessages: userTurns.length,
      sourceBytes: Buffer.byteLength(source, 'utf8'),
    },
  }
}
