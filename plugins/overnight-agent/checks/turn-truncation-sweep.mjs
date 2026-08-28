// Sweep: agent turns that are SILENTLY TRUNCATED in transit to Telegram.
//
// THE DEFECT (found 2026-08-25 15:50 PT on #371)
// ---------------------------------------------
// `latestAgentTurn()` reads forward from the last `<!-- from: overnight-agent -->`
// marker and breaks on the first `## <heading>` line - ANY `##` line, not just a date
// header. So a turn whose BODY contains ordinary markdown h2 sections is cut at the
// first one, and the rest never reaches the phone.
//
// On #371 (the friction post-mortem Shiv explicitly asked for) the 14:30 run fixed the
// OPENING heading, ran `would-post.mjs`, saw "CHANGED - would post" and declared it
// delivered. It posted 1,156 of ~11,000 characters: the body still contained
// `## The friction ...` and `## What I'd need ...`, and it cut at the first one.
//
// WHY would-post.mjs DOES NOT CATCH THIS
// --------------------------------------
// `would-post.mjs` answers "will something post?", not "will ALL of it post?". Both a
// complete turn and a turn truncated to its first paragraph report `CHANGED - would post`.
// This sweep answers the second question by diffing the parsed turn against the text that
// SHOULD have posted (marker -> next genuine user chat entry / EOF).
//
// Harness discipline (per recorded traps): the "parsed" side uses the bridge's OWN
// latestAgentTurn(), so the checker cannot be stricter or looser than the real parser.
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

const ROOT = process.env.BRIDGE_SRC
if (!ROOT) { console.error('BRIDGE_SRC is required (file:/// URL to the pinned bridge src)'); process.exit(1) }
const { latestAgentTurn } = await import(`${ROOT}/journal.js`)

const PLANNER = process.env.PLANNER_PATH
if (!PLANNER) { console.error('PLANNER_PATH is required'); process.exit(1) }
const JOURNALS = path.join(PLANNER, 'journal')

const board = readFileSync(path.join(PLANNER, 'planner.md'), 'utf8')
const activeIds = new Set()
for (const m of board.matchAll(/^\|\s*(\d+)[,\s|]/gm)) activeIds.add(m[1])

const rxAgentMarker = /^\s*<!--\s*from:\s*overnight-agent\s*-->\s*$/
// ANY provenance marker ends the turn - including a sibling skill's (e.g. `from: dance-church`),
// which legitimately terminates the agent's turn just as a user reply does.
const rxAnyFromMarker = /^\s*<!--\s*from:\s*[^>]*-->\s*$/
const rxBlockHeader = /^##\s*🌙/
const rxDateHeader = /^##\s+\d{4}-\d{2}-\d{2}/
const rxAnyH2 = /^##\s+/

// Characters of dropped body below which we don't bother reporting (trailing blank lines,
// a stray separator, etc). Anything above this is real content Shiv never received.
const THRESHOLD = 200

const rows = []
for (const f of readdirSync(JOURNALS)) {
  const mf = /^task-(\d+)\.md$/.exec(f)
  if (!mf) continue
  const id = mf[1]
  const content = readFileSync(path.join(JOURNALS, f), 'utf8')
  const parsed = latestAgentTurn(content)
  if (!parsed) continue

  const lines = content.split(/\r?\n/)

  // Anchor exactly where the PARSER anchors: the newest agent content, which is the LATER
  // of (last `<!-- from: overnight-agent -->` marker, last `## 🌙 Overnight Agent` header).
  // Anchoring on the marker alone produced a false positive on #334, where a 2026-06-27 chat
  // marker sits ABOVE a newer 2026-08-11 agent block - the parser correctly posts the block.
  let markerAt = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (rxAgentMarker.test(lines[i])) { markerAt = i; break }
  }
  let headerAt = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (rxBlockHeader.test(lines[i])) { headerAt = i; break }
  }
  const anchor = Math.max(markerAt, headerAt)
  if (anchor === -1) continue

  // Walk forward to the LEGITIMATE end of the turn: the next genuine chat entry by anyone
  // other than this turn's author. A `## <date>` only ends the turn if somebody actually
  // speaks under it; a `##` that is merely a body section heading does NOT.
  let legitEnd = lines.length
  let breakLine = null
  for (let i = anchor + 1; i < lines.length; i++) {
    if (rxAnyFromMarker.test(lines[i])) { legitEnd = i; break }
    if (rxDateHeader.test(lines[i])) {
      const lookahead = lines.slice(i + 1, i + 4)
      if (lookahead.some(l => rxAnyFromMarker.test(l))) { legitEnd = i; break }
    }
  }

  const shouldPost = lines.slice(anchor + 1, legitEnd).join('\n').trim()
  const dropped = shouldPost.length - parsed.trim().length
  if (dropped <= THRESHOLD) continue

  // Identify the offending line: the first `##` inside the region that is not a real
  // chat-entry date header. That is what the parser cut on.
  for (let i = anchor + 1; i < legitEnd; i++) {
    if (rxAnyH2.test(lines[i])) { breakLine = { n: i + 1, text: lines[i] }; break }
  }

  rows.push({ id, active: activeIds.has(id), parsed: parsed.trim().length, should: shouldPost.length, dropped, breakLine })
}

const active = rows.filter(r => r.active).sort((a, b) => b.dropped - a.dropped)
const inactive = rows.filter(r => !r.active).sort((a, b) => b.dropped - a.dropped)

console.log('agent turns TRUNCATED before reaching Telegram (body-internal "##" cuts the turn)')
console.log(`  active board : ${active.length}`)
console.log(`  off board    : ${inactive.length}\n`)
console.log('--- ACTIVE BOARD (live tasks whose newest turn is only PARTLY delivered) ---')
if (!active.length) console.log('  (none)')
for (const r of active) {
  console.log(`  #${r.id.padEnd(4)} posted=${String(r.parsed).padStart(5)}  should=${String(r.should).padStart(5)}  DROPPED=${String(r.dropped).padStart(5)} chars`)
  if (r.breakLine) console.log(`         cut at line ${r.breakLine.n}: ${r.breakLine.text.slice(0, 72)}`)
}
if (inactive.length) {
  console.log(`\n--- off board (completed; do NOT post to closed tasks - see #400) ---`)
  for (const r of inactive) console.log(`  #${r.id.padEnd(4)} DROPPED=${r.dropped} chars`)
}
process.exit(active.length ? 2 : 0)
