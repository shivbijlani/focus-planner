const ROOT = process.env.BRIDGE_SRC
const { createFsIo } = await import(`${ROOT}/io.js`)
const J = await import(`${ROOT}/journal.js`)
const planner = process.env.PLANNER_PATH
const io = createFsIo({
  journalDir: `${planner}\\journal`,
  boardPath: `${planner}\\planner.md`,
  completedBoardPath: `${planner}\\planner-completed.md`,
})

const boardText = await io.readBoard()
const meta = {}
let section = null
for (const line of boardText.split(/\r?\n/)) {
  const h = /^##\s+(.+?)\s*$/.exec(line)
  if (h) { section = h[1]; continue }
  const m = /^\|\s*(\d+)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|/.exec(line)
  if (m && section) meta[m[1]] = { section, icon: m[2], title: m[3] }
}

const have = new Set((await io.listJournals()).map((j) => j.taskId))
for (const [id, m] of Object.entries(meta)) {
  const tag = `#${id.padEnd(6)} [${m.section} ${m.icon || ' '}] ${m.title.slice(0, 70)}`
  if (!have.has(id)) { console.log(`NO JOURNAL ${tag}`); continue }
  const c = await io.readJournal(id)
  if (!J.hasAgentBlock(c)) console.log(`NO BLOCK   ${tag}`)
  else if (!J.latestAgentTurn(c)) console.log(`NO TURN    ${tag}`)
}
console.log('done')
