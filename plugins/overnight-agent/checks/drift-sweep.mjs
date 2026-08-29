// Per-run duty: compare each journal's LIVE agent status against oa-state status,
// and flag settled-but-queued work.
//
// 2026-08-25 21:30 — MIGRATED to lib-live-status.mjs. This sweep used to read status via
// the bridge's `agentBlockStatus(agentBlockText(text))`, which has two defects:
//   1. WRONG TURN — `agentBlockText()` splits at the FIRST sentinel and stops at the first
//      date header, so on a bottom-appended chat journal it returns turn 1 forever.
//   2. DIALECT — its `([A-Za-z-]+)` capture turns the human "In progress" into the bare
//      token `in`, which matches no canonical status at all.
// Measured: that reported drift=31 where the true figure is 16. 21 of those rows were the
// parser disagreeing with ITSELF (14 `in`, 6 null, 1 wrong-turn), and it simultaneously
// MISSED 6 real disagreements. Both directions wrong at once.
// Read-only. Usage: PLANNER_PATH=... BRIDGE_SRC=... node drift-sweep.mjs
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { liveStatus } from './lib-live-status.mjs'

const PLANNER = process.env.PLANNER_PATH
const SRC = process.env.BRIDGE_SRC
if (!PLANNER || !SRC) { console.error('set PLANNER_PATH and BRIDGE_SRC (file:/// url)'); process.exit(1) }

const journalMod = await import(`${SRC}/journal.js`)
const { agentBlockText, agentBlockStatus } = journalMod

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

const TERMINAL = new Set(['done', 'skip', 'skipped', 'complete', 'completed'])
const rows = []

for (const f of readdirSync(journalDir)) {
  const m = /^task-(\d+)\.md$/.exec(f)
  if (!m) continue
  const id = m[1]
  const text = readFileSync(path.join(journalDir, f), 'utf8')
  const live = liveStatus(text)
  const jStatus = live.status                       // canonical, or null when unreadable
  const rawStatus = agentBlockStatus(agentBlockText(text))   // kept only to show the delta
  let sStatus = null
  const sp = path.join(stateDir, `task-${id}.json`)
  if (existsSync(sp)) {
    // oa-state.ps1 writes these with a UTF-8 BOM, which JSON.parse rejects.
    const raw = readFileSync(sp, 'utf8').replace(/^\uFEFF/, '')
    try { sStatus = JSON.parse(raw).status } catch (e) { console.error(`  !! unparseable state task-${id}.json: ${e.message}`) }
  }
  rows.push({
    id, jStatus, sStatus, rawStatus, live,
    onActive: active.has(id), onCompleted: completed.has(id),
    jTerminal: TERMINAL.has(jStatus), sTerminal: TERMINAL.has(sStatus),
  })
}

// Only a CANONICAL reading can disagree with state. A status we cannot read is
// "unreadable", not "different" - reporting it as drift is how the old count reached 31.
const drift = rows.filter(r => r.live.canonical && r.jStatus !== r.sStatus)
console.log(`journals=${rows.length} activeBoard=${active.size} completedBoard=${completed.size} drift=${drift.length}`)

// Cause 1: on completed board but journal block is non-terminal -> inflates queue
const c1 = rows.filter(r => r.onCompleted && !r.onActive && !r.jTerminal)
console.log(`\n[A] completed-board, journal NON-terminal (repairable): ${c1.length}`)
for (const r of c1) console.log(`  #${r.id} journal=${r.jStatus} state=${r.sStatus}`)

// Dual-board: leave for Shiv
const dual = rows.filter(r => r.onCompleted && r.onActive)
console.log(`\n[B] dual-board (leave alone): ${dual.map(r => '#' + r.id).join(' ') || 'none'}`)

// Cause 2: active board, state says terminal but journal does not
const c2 = rows.filter(r => r.onActive && !r.onCompleted && r.sTerminal && !r.jTerminal)
console.log(`\n[C] active-board, state terminal / journal non-terminal (probe before repair): ${c2.length}`)
for (const r of c2) console.log(`  #${r.id} journal=${r.jStatus} state=${r.sStatus}`)

// Reverse drift: journal terminal, state not
const c3 = rows.filter(r => r.jTerminal && !r.sTerminal)
console.log(`\n[D] journal terminal / state NON-terminal (state should follow journal): ${c3.length}`)
for (const r of c3) console.log(`  #${r.id} journal=${r.jStatus} state=${r.sStatus}`)

// Null status blocks (parser can't read) - the #412 class
const c4 = rows.filter(r => r.jStatus === null)
console.log(`\n[E] journal Status unparseable (null): ${c4.map(r => '#' + r.id).join(' ') || 'none'}`)

// [F] Statuses that ARE present but name nothing canonical. Previously these were
// silently truncated to their first word (`Umbrella category` -> `umbrella`), which read
// as a real status and then "drifted" against state forever.
const nonCanon = rows.filter(r => !r.live.canonical && r.live.source !== 'none')
console.log(`\n[F] status present but NON-CANONICAL (not a real disagreement): ${nonCanon.length}`)
for (const r of nonCanon) console.log(`  #${r.id} raw="${String(r.live.raw).slice(0, 60)}" (old parser said "${r.rawStatus}")`)

// [G] Where the OLD block-based parser disagrees with the live reading. Non-zero here
// means some other consumer still calling agentBlockStatus() is being misled.
const parserDelta = rows.filter(r => r.live.canonical && r.rawStatus !== r.jStatus)
console.log(`\n[G] old agentBlockStatus() != live status (other callers still at risk): ${parserDelta.length}`)
for (const r of parserDelta) console.log(`  #${r.id} old=${r.rawStatus} live=${r.jStatus} via=${r.live.source}`)

console.log('\nnote: for WHICH SIDE is stale on an active row, run status-sync-audit.mjs')
