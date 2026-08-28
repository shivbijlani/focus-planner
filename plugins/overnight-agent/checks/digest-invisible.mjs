// Which BOARD tasks does the digest drop entirely, and why?
//
// syncDigest() drops a task when neither its newest agent turn NOR its agent
// block yields an ask (and non-terminal status). Those tasks are invisible in
// the approval queue *before* any ordering runs, so board priority can't save
// them. This harness reproduces that exact gate and reports the survivors vs
// the dropped, annotated with the board section / urgency icon so a 🔴 Today
// task falling out is impossible to miss.
//
// Usage: BRIDGE_SRC=<file:// src> PLANNER_PATH=<planner> node digest-invisible.mjs [--all]
const ROOT = process.env.BRIDGE_SRC
const { createFsIo } = await import(`${ROOT}/io.js`)
const { extractAskEntry } = await import(`${ROOT}/digest.js`)
const { hasAgentBlock, latestAgentTurn, agentBlockText, agentBlockStatus, parseTitle } =
  await import(`${ROOT}/journal.js`)

const DIGEST_TERMINAL_STATUS = new Set(['done', 'skip', 'skipped', 'complete', 'completed'])
const planner = process.env.PLANNER_PATH
const io = createFsIo({
  journalDir: `${planner}\\journal`,
  boardPath: `${planner}\\planner.md`,
  completedBoardPath: `${planner}\\planner-completed.md`,
})

// Parse the board into id -> { section, icon, row } so we can rank the damage.
const boardText = await io.readBoard()
const board = new Map()
let section = null
let row = 0
for (const line of boardText.split(/\r?\n/)) {
  const h = /^##\s+(.+?)\s*$/.exec(line)
  if (h) { section = h[1]; continue }
  const m = /^\|\s*(\d+)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|/.exec(line)
  if (m && section) board.set(m[1], { section, icon: m[2], title: m[3], row: row++ })
}

const kept = []
const dropped = []
for (const { taskId } of await io.listJournals()) {
  const onBoard = board.get(taskId)
  if (!onBoard && !process.argv.includes('--all')) continue
  const content = await io.readJournal(taskId)
  if (!hasAgentBlock(content)) { dropped.push({ taskId, onBoard, why: 'no agent block' }); continue }
  const turn = latestAgentTurn(content)
  const block0 = agentBlockText(content)
  const status0 = agentBlockStatus(block0)
  let ask = turn ? extractAskEntry(turn) : null
  let via = 'turn'
  // Mirror syncDigest(): a `weak` ask was salvaged from boilerplate and must
  // not revive a task whose block is terminal. Keep this in step with
  // bridge.js or the audit will over-report what the queue can show.
  if (ask && ask.weak && DIGEST_TERMINAL_STATUS.has(status0)) ask = null
  if (!ask) {
    const block = agentBlockText(content)
    const status = agentBlockStatus(block)
    if (!block) { dropped.push({ taskId, onBoard, why: 'no block text' }); continue }
    if (DIGEST_TERMINAL_STATUS.has(status)) {
      dropped.push({ taskId, onBoard, why: `terminal status (${status})` }); continue
    }
    ask = extractAskEntry(block)
    via = 'block'
    if (!ask) {
      dropped.push({ taskId, onBoard, why: `NO ASK MARKER (status ${status || 'unknown'})`, real: true })
      continue
    }
  }
  kept.push({ taskId, via, source: ask.source, onBoard })
}

const fmt = (d) => {
  const b = d.onBoard
  const where = b ? `${b.section.padEnd(9)} ${b.icon || ' '} row ${String(b.row).padStart(3)}` : 'off-board'
  return `  #${String(d.taskId).padEnd(7)} ${where}  ${d.why}`
}

console.log(`board tasks with journals : ${kept.length + dropped.length}`)
console.log(`visible to digest         : ${kept.length}`)
console.log(`dropped                   : ${dropped.length}`)

const real = dropped.filter((d) => d.real)
console.log(`\n--- DROPPED FOR LACK OF AN ASK MARKER (${real.length}) — these are open tasks the queue cannot show ---`)
const weight = (d) => {
  const b = d.onBoard
  if (!b) return 999
  const today = b.section.startsWith('Today') ? 0 : 100
  const urgent = /🔴/.test(b.icon) ? 0 : 10
  return today + urgent
}
for (const d of real.sort((a, b) => weight(a) - weight(b) || (a.onBoard?.row ?? 0) - (b.onBoard?.row ?? 0))) {
  console.log(fmt(d))
}

const other = dropped.filter((d) => !d.real)
console.log(`\n--- dropped for other (legitimate) reasons: ${other.length} ---`)
const byWhy = {}
for (const d of other) byWhy[d.why] = (byWhy[d.why] || 0) + 1
for (const [w, n] of Object.entries(byWhy).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)}  ${w}`)
