/**
 * The **agent gate** (#288) — one file in the planner folder holding the two
 * lists that decide when the overnight agent acts on its own and when it stops
 * to ask:
 *
 *  - *Do not gate these (reversible)* — the agent may do these without asking.
 *  - *Always ask (safety floor)* — the agent always pauses before these.
 *
 * ## Why this file is different from every other file the app writes
 *
 * It is **human-authored by construction**. #250 is open because approval today
 * rests on a `<!-- from: me -->` marker that the agent's own software writes, so
 * the agent cannot tell a user's authorisation from its own prose — on
 * 2026-08-31 that cost a real, explicitly-granted permission. Because the user
 * edits this file (in the app or on disk) and the agent only ever *reads* it, a
 * standing permission recorded here needs no attribution marker at all.
 *
 * Two consequences follow, and both are deliberate:
 *
 * 1. `scaffoldAgentGate` seeds the file **only when it is absent or blank**. It
 *    never refreshes or version-bumps an existing file the way
 *    `scaffoldAgentsDoc` does, because rewriting a file whose whole value is
 *    "the user wrote this" would destroy the thing that makes it trustworthy.
 * 2. `serializeAgentGate` splices only the bullet lines of the two known
 *    sections and preserves everything else verbatim — title, preamble,
 *    comments, notes inside a section, and any extra sections the user added.
 *    Saving is still a plain whole-file write (issue #288 explicitly rules out
 *    the byte-offset cell splicing `userSettingsForm.js` needs); we just rebuild
 *    the file line-by-line instead of regenerating it from the template.
 */

export const AGENT_GATE_VERSION = 1

// Lives in the active source root, next to planner.md / planner-completed.md.
export const AGENT_GATE_FILE = 'agent-gate.md'

// Section headings, as written in the canonical file. Parsing matches these
// loosely (see SECTION_MATCHERS) so a user can reword a heading without the
// app losing track of which list is which.
export const REVERSIBLE_HEADING = 'Do not gate these (reversible)'
export const ALWAYS_ASK_HEADING = 'Always ask (safety floor)'

/** Seed contents of the reversible list (verbatim from #288). */
export const DEFAULT_REVERSIBLE = [
  'focus-planner-ado-codeapp is in YOLO mode, dont ask just do, Im the only user',
  'Emailing myself',
  'Responding to an interaction in a 1-1 chat or email with valuable info (not just shiv is oof). If doing so, append message signature indicating that this was sent by bot and that shiv will review when he gets back.',
  'Creating and publishing a pull request in any repository, then continuing to work on it until all checks pass, is easily reversible and has no consequence; do not gate it.',
]

/** Seed contents of the safety floor (verbatim from #288). */
export const DEFAULT_ALWAYS_ASK = [
  'Send-to-many (group/channel, manager, mass email)',
  'Starting a fresh conversation with someone in chat/email',
]

const bullets = (lines) => lines.map((l) => `- ${l}`).join('\n')

/** The file seeded into a folder that has no gate yet. */
export const AGENT_GATE_DOC = `# Agent gate

<!-- planner-agent-gate v${AGENT_GATE_VERSION} — you own this file. The overnight agent reads it and never writes it, so anything here counts as your instruction without needing an attribution marker. -->

Two lists that tell the overnight agent when to act on its own and when to stop
and ask. Edit them in the app (**Agent gate** in the sidebar) or in this file
directly — both are the same file.

## ${REVERSIBLE_HEADING}

${bullets(DEFAULT_REVERSIBLE)}

## ${ALWAYS_ASK_HEADING}

${bullets(DEFAULT_ALWAYS_ASK)}
`

// A heading belongs to a list if it mentions either of that list's key phrases.
// Keyed loosely so "Always ask", "always ask (safety floor)" and "Safety floor"
// all resolve to the same list.
const SECTION_MATCHERS = [
  { key: 'reversible', phrases: ['do not gate', "don't gate", 'reversible'] },
  { key: 'alwaysAsk', phrases: ['always ask', 'safety floor'] },
]

const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/
const BULLET_RE = /^\s*[-*+]\s+(.*)$/

/** Which list, if any, a heading's text names. @returns {'reversible'|'alwaysAsk'|null} */
function sectionKeyFor(headingText) {
  const t = String(headingText || '').toLowerCase()
  for (const { key, phrases } of SECTION_MATCHERS) {
    if (phrases.some((p) => t.includes(p))) return key
  }
  return null
}

/**
 * Split markdown into lines, normalising CRLF (and lone CR) so a file saved by
 * a Windows editor parses identically to one saved by the app.
 * @param {string} md
 * @returns {string[]}
 */
function toLines(md) {
  return String(md == null ? '' : md).replace(/\r\n?/g, '\n').split('\n')
}

/**
 * Walk the document once, yielding `{ key, start, end }` for each section whose
 * heading names one of the two lists. `start` is the heading's index; `end` is
 * exclusive and stops at the next heading of the same-or-shallower depth.
 */
function findSections(lines) {
  const found = []
  for (let i = 0; i < lines.length; i++) {
    const m = HEADING_RE.exec(lines[i])
    if (!m) continue
    const depth = m[1].length
    const key = sectionKeyFor(m[2])
    if (!key) continue
    let end = lines.length
    for (let j = i + 1; j < lines.length; j++) {
      const next = HEADING_RE.exec(lines[j])
      if (next && next[1].length <= depth) { end = j; break }
    }
    // First heading for a list wins, so a stray later mention can't hijack it.
    if (!found.some((s) => s.key === key)) found.push({ key, start: i, end })
  }
  return found
}

/**
 * Read the two lists out of the gate file.
 *
 * Tolerant by design: missing file, blank file, only one of the two sections,
 * `*`/`+` bullets, CRLF line endings, and prose mixed in among the bullets all
 * parse without throwing. Anything that is not a bullet inside a section is
 * left alone here and preserved by {@link serializeAgentGate}.
 *
 * @param {string} md
 * @returns {{ reversible: string[], alwaysAsk: string[] }}
 */
export function parseAgentGate(md) {
  const lines = toLines(md)
  const out = { reversible: [], alwaysAsk: [] }
  for (const { key, start, end } of findSections(lines)) {
    for (let i = start + 1; i < end; i++) {
      const m = BULLET_RE.exec(lines[i])
      if (!m) continue
      const text = m[1].trim()
      if (text) out[key].push(text)
    }
  }
  return out
}

/** Build the replacement body for one section, keeping its non-bullet lines. */
function spliceSectionBody(body, items) {
  const next = []
  let placed = false
  for (const line of body) {
    if (BULLET_RE.test(line)) {
      // Collapse the old bullet block down to the new list, at the position of
      // the first bullet; later bullets are dropped (their content is already
      // in `items` if the user kept it).
      if (!placed) { next.push(...items.map((t) => `- ${t}`)); placed = true }
      continue
    }
    next.push(line)
  }
  if (placed || !items.length) return next

  // No bullets to replace: put the list after the section's last real line
  // (so an explanatory note the user wrote stays above its list).
  let lastContent = -1
  for (let i = 0; i < next.length; i++) if (next[i].trim()) lastContent = i
  const head = next.slice(0, lastContent + 1)
  const tail = next.slice(lastContent + 1)
  return [...head, '', ...items.map((t) => `- ${t}`), ...(tail.length ? tail : [''])]
}

/**
 * Write the two lists back into `md`, preserving every line the app did not
 * author: the title, preamble prose, HTML comments, notes inside a section, and
 * any extra sections. A section that does not exist yet is appended.
 *
 * Round-trips with {@link parseAgentGate}.
 *
 * @param {string} md Existing file contents ('' seeds from the canonical doc).
 * @param {{ reversible?: string[], alwaysAsk?: string[] }} lists
 * @returns {string}
 */
export function serializeAgentGate(md, lists) {
  const items = {
    reversible: (lists?.reversible || []).map((t) => String(t).trim()).filter(Boolean),
    alwaysAsk: (lists?.alwaysAsk || []).map((t) => String(t).trim()).filter(Boolean),
  }

  // An empty file has nothing worth preserving — start from the canonical doc
  // so the user still gets the title and the explanation of what this file is.
  const source = String(md == null ? '' : md).trim() ? md : AGENT_GATE_DOC
  const lines = toLines(source)
  const sections = findSections(lines)

  // Rebuild back-to-front so earlier indices stay valid.
  const out = lines.slice()
  for (const { key, start, end } of [...sections].sort((a, b) => b.start - a.start)) {
    const body = spliceSectionBody(out.slice(start + 1, end), items[key])
    out.splice(start + 1, end - start - 1, ...body)
  }

  // Append any section the file was missing, in canonical order.
  const present = new Set(sections.map((s) => s.key))
  const headings = { reversible: REVERSIBLE_HEADING, alwaysAsk: ALWAYS_ASK_HEADING }
  for (const key of ['reversible', 'alwaysAsk']) {
    if (present.has(key)) continue
    while (out.length && !out[out.length - 1].trim()) out.pop()
    out.push('', `## ${headings[key]}`, '', ...items[key].map((t) => `- ${t}`))
  }

  let text = out.join('\n').replace(/\n{3,}/g, '\n\n')
  if (!text.endsWith('\n')) text += '\n'
  return text
}

/**
 * Append a line to a list. Blank input is ignored and an exact duplicate is not
 * added twice, so hitting Enter on an empty box (or twice on the same text) is
 * harmless. Newlines are flattened — every entry is exactly one line.
 * @param {string[]} lines
 * @param {string} text
 * @returns {string[]} a new array
 */
export function addGateLine(lines, text) {
  const list = Array.isArray(lines) ? lines : []
  const clean = String(text == null ? '' : text).replace(/[\r\n]+/g, ' ').trim()
  if (!clean || list.includes(clean)) return list.slice()
  return [...list, clean]
}

/**
 * Remove the line at `index`. An out-of-range index is a no-op.
 * @param {string[]} lines
 * @param {number} index
 * @returns {string[]} a new array
 */
export function removeGateLine(lines, index) {
  const list = Array.isArray(lines) ? lines : []
  if (!Number.isInteger(index) || index < 0 || index >= list.length) return list.slice()
  return list.filter((_, i) => i !== index)
}

/**
 * Seed `agent-gate.md` when the folder has none.
 *
 * Unlike `scaffoldAgentsDoc`, this **never rewrites an existing file** — not
 * even to bump its version. The file's authority comes from the user having
 * written it, so the app only ever creates the first copy.
 *
 * Best-effort: never throws (scaffolding must not block folder setup).
 *
 * @param {(path: string) => Promise<string>} read
 * @param {(path: string, contents: string) => Promise<void>} write
 */
export async function scaffoldAgentGate(read, write) {
  let existing = ''
  try {
    existing = await read(AGENT_GATE_FILE)
  } catch {
    existing = '' // missing file (some providers throw rather than return '')
  }
  if (existing && String(existing).trim()) return
  try {
    await write(AGENT_GATE_FILE, AGENT_GATE_DOC)
  } catch {
    /* ignore — the folder is still usable without a gate file */
  }
}
