// Sweep: journals whose MOST RECENT agent work is invisible to the Telegram bridge.
//
// THE DEFECT (found 2026-08-25 12:45 PT on #327)
// ---------------------------------------------
// `latestAgentTurn()` (packages/telegram-bridge/src/journal.js) locates the newest agent
// message by scanning for the LAST `<!-- from: overnight-agent -->` marker, falling back
// to the `## 🌙 Overnight Agent` plan header. It then reads FORWARD and breaks on the
// first `## <date>` header, `<!-- from: me -->`, or `<!-- from: overnight-agent -->`.
//
// So if a run appends a bare `**<date> (overnight):**` Run-log entry BELOW a user's
// `## <date>` / `<!-- from: me -->` chat entry WITHOUT its own agent marker, that entry is
// past the break and is never posted. On #327 that hid 5 consecutive entries for 27 days,
// including the "FLYER FOUND" result that answered the whole task - which is why it read
// as "Shiv is ignoring this" when in fact he was never shown the answer.
//
// This sweep flags journals where agent-authored content exists AFTER the point
// latestAgentTurn() stops, i.e. work that exists on disk but not on the phone.
//
// Harness discipline (per recorded traps): uses the bridge's OWN latestAgentTurn() rather
// than a re-implementation, so the checker cannot be stricter or looser than the parser.
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

const ROOT = process.env.BRIDGE_SRC
if (!ROOT) { console.error('BRIDGE_SRC is required (file:/// URL to the pinned bridge src)'); process.exit(1) }
const { latestAgentTurn } = await import(`${ROOT}/journal.js`)

const PLANNER = process.env.PLANNER_PATH
const JOURNALS = path.join(PLANNER, 'journal')

// active board ids, so we can separate "live and invisible" from historical noise
const board = readFileSync(path.join(PLANNER, 'planner.md'), 'utf8')
const activeIds = new Set()
for (const m of board.matchAll(/^\|\s*(\d+)[,\s|]/gm)) activeIds.add(m[1])

// An agent Run-log entry, as every run writes it: **YYYY-MM-DD (overnight...):**
const rxRunEntry = /^\*\*(\d{4}-\d{2}-\d{2})[^*]*\*\*/
const rxAgentMarker = /^\s*<!--\s*from:\s*overnight-agent\s*-->\s*$/

const rows = []
for (const f of readdirSync(JOURNALS)) {
  const mf = /^task-(\d+)\.md$/.exec(f)
  if (!mf) continue
  const id = mf[1]
  const content = readFileSync(path.join(JOURNALS, f), 'utf8')
  const turn = latestAgentTurn(content)
  if (!turn) continue

  const lines = content.split(/\r?\n/)

  // Where does the posted turn END in the file? Find the last line of `turn` in the file.
  const turnLines = turn.split('\n')
  const lastTurnLine = turnLines[turnLines.length - 1]
  let turnEnd = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i] === lastTurnLine) { turnEnd = i; break }
  }
  if (turnEnd === -1) continue // couldn't localise; skip rather than guess

  // Any agent Run-log entry AFTER the posted turn = work that never reaches the phone.
  const orphans = []
  for (let i = turnEnd + 1; i < lines.length; i++) {
    const mr = rxRunEntry.exec(lines[i])
    if (mr) orphans.push(mr[1])
  }
  if (!orphans.length) continue

  const hasMarker = lines.some(l => rxAgentMarker.test(l))
  rows.push({
    id,
    active: activeIds.has(id),
    count: orphans.length,
    newest: orphans.sort().slice(-1)[0],
    oldest: orphans.sort()[0],
    hasMarker,
  })
}

const active = rows.filter(r => r.active).sort((a, b) => (a.newest < b.newest ? 1 : -1))
const inactive = rows.filter(r => !r.active)

console.log(`journals with agent entries BELOW the posted turn (invisible on Telegram)`)
console.log(`  active board : ${active.length}`)
console.log(`  off board    : ${inactive.length}\n`)
console.log(`--- ACTIVE BOARD (these are live tasks whose newest work Shiv cannot see) ---`)
for (const r of active) {
  console.log(`  #${r.id.padEnd(4)} hidden=${String(r.count).padStart(2)} entr${r.count === 1 ? 'y' : 'ies'}  ` +
    `range=${r.oldest}..${r.newest}  agentMarkerAnywhere=${r.hasMarker}`)
}
if (inactive.length) console.log(`\n--- off board: ${inactive.map(r => '#' + r.id).join(' ')}`)
