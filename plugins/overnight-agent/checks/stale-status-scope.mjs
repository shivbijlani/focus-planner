// Measure: how often does the status read from the MANAGED BLOCK (what
// drift-sweep + friends use today, via agentBlockText -> agentBlockStatus)
// differ from the status carried by the NEWEST agent turn?
//
// This is the 2026-08-25 21:00 meta-rule ("a checker that extracts the current
// X must first decide which TURN owns it") applied to STATUS rather than to the
// ask. agentBlockText() splits at the FIRST sentinel and stops at the first
// date header, so on a bottom-appended chat journal it returns turn 1 forever.
//
// Read-only. Never writes. Usage:
//   PLANNER_PATH=... BRIDGE_SRC=file:///.../src node stale-status-scope.mjs
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import path from 'node:path'

const PLANNER = process.env.PLANNER_PATH
const SRC = process.env.BRIDGE_SRC
if (!PLANNER || !SRC) { console.error('set PLANNER_PATH and BRIDGE_SRC (file:/// url)'); process.exit(1) }

const { agentBlockText, agentBlockStatus, latestAgentTurn } = await import(`${SRC}/journal.js`)

const journalDir = path.join(PLANNER, 'journal')
const stateDir = path.join(process.env.LOCALAPPDATA, 'overnight-agent', 'state')

function boardIds(file) {
  const p = path.join(PLANNER, file)
  if (!existsSync(p)) return new Set()
  const ids = new Set()
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = /^\|\s*(\d+)/.exec(line)
    if (m) ids.add(m[1])
  }
  return ids
}
const active = boardIds('planner.md')
const completed = boardIds('planner-completed.md')

// Same regex agentBlockStatus uses, but tolerant of the "In progress" dialect:
// capture the whole status phrase up to the separator, then normalise.
const STATUS_PHRASE = /^\s*\*{0,2}Status:?\*{0,2}\s*:?\s*\*{0,2}([^\u00b7\n|*]+)/m

function normaliseStatus(phrase) {
  if (!phrase) return null
  let s = phrase.trim().toLowerCase()
  s = s.replace(/\s*[\u2014-].*$/, '').trim()   // drop " — trailing prose"
  s = s.replace(/\s+/g, '-')                     // "in progress" -> "in-progress"
  s = s.replace(/-+$/, '')
  const alias = {
    'in': 'in-progress', 'inprogress': 'in-progress', 'progress': 'in-progress',
    'complete': 'done', 'completed': 'done', 'skipped': 'skip',
    'proposed': 'proposed', 'approved': 'approved', 'blocked': 'blocked',
  }
  return alias[s] || s
}

function statusFromText(t) {
  if (!t) return null
  const m = STATUS_PHRASE.exec(t)
  return m ? normaliseStatus(m[1]) : null
}

const rows = []
for (const f of readdirSync(journalDir)) {
  const m = /^task-(\d+)\.md$/.exec(f)
  if (!m) continue
  const id = m[1]
  const text = readFileSync(path.join(journalDir, f), 'utf8')

  const block = agentBlockText(text)
  const rawBlockStatus = agentBlockStatus(block)          // what checkers use today
  const newest = latestAgentTurn(text)

  // Correct reading: newest turn's Status line, else fall back to the block.
  const newestStatus = statusFromText(newest)
  const blockStatus = statusFromText(block)
  const liveStatus = newestStatus ?? blockStatus
  const source = newestStatus ? 'newest-turn' : (blockStatus ? 'block' : 'none')

  let sStatus = null
  const sp = path.join(stateDir, `task-${id}.json`)
  if (existsSync(sp)) {
    try { sStatus = JSON.parse(readFileSync(sp, 'utf8').replace(/^\uFEFF/, '')).status } catch { }
  }

  rows.push({
    id, rawBlockStatus, blockStatus, newestStatus, liveStatus, source, sStatus,
    onActive: active.has(id), onCompleted: completed.has(id),
  })
}

const TERMINAL = new Set(['done', 'skip'])
const activeRows = rows.filter(r => r.onActive)

// 1. Dialect damage: raw parser vs normalised, on the SAME text.
const dialect = rows.filter(r => r.rawBlockStatus && r.blockStatus && r.rawBlockStatus !== r.blockStatus)

// 2. Wrong-turn damage: newest turn carries a status that differs from the block's.
const wrongTurn = rows.filter(r => r.newestStatus && r.blockStatus && r.newestStatus !== r.blockStatus)

// 3. The expensive subset: the difference flips terminal-ness on a LIVE board row.
const flips = wrongTurn.filter(r => r.onActive && (TERMINAL.has(r.blockStatus) !== TERMINAL.has(r.newestStatus)))

// 4. Rows where the raw parser returns null but a status IS readable.
const rescued = rows.filter(r => !r.rawBlockStatus && r.liveStatus)

console.log(`journals=${rows.length}  activeBoard=${activeRows.length}`)
console.log(`\n[1] DIALECT: raw agentBlockStatus != normalised, same text: ${dialect.length}`)
for (const r of dialect) console.log(`   #${r.id.padEnd(4)} raw=${String(r.rawBlockStatus).padEnd(12)} normalised=${r.blockStatus}${r.onActive ? '   (ACTIVE BOARD)' : ''}`)

console.log(`\n[2] WRONG TURN: newest-turn status != managed-block status: ${wrongTurn.length}`)
for (const r of wrongTurn) console.log(`   #${r.id.padEnd(4)} block=${String(r.blockStatus).padEnd(12)} newest=${String(r.newestStatus).padEnd(12)} state=${String(r.sStatus).padEnd(12)}${r.onActive ? ' (ACTIVE)' : r.onCompleted ? ' (completed)' : ''}`)

console.log(`\n[3] TERMINAL FLIP on an active row (the expensive class): ${flips.length}`)
for (const r of flips) console.log(`   #${r.id} block=${r.blockStatus} newest=${r.newestStatus} state=${r.sStatus}`)

console.log(`\n[4] raw parser=null but a status IS readable: ${rescued.length}`)
for (const r of rescued) console.log(`   #${r.id.padEnd(4)} live=${String(r.liveStatus).padEnd(12)} via=${r.source}${r.onActive ? ' (ACTIVE)' : r.onCompleted ? ' (completed)' : ' (ORPHAN: no board row)'}`)

// 5. Live-status vs state disagreement on active rows (what actually misroutes work).
const disagree = activeRows.filter(r => r.liveStatus && r.sStatus && r.liveStatus !== r.sStatus)
console.log(`\n[5] ACTIVE rows where live journal status != state status: ${disagree.length}`)
for (const r of disagree) console.log(`   #${r.id.padEnd(4)} journal=${String(r.liveStatus).padEnd(12)} state=${String(r.sStatus).padEnd(12)} via=${r.source}`)
