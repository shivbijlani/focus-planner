// Verify #186 against the LIVE boards: which tasks did the old completed-guard
// classify as finished, and which does the active-wins rule rescue?
import fs from 'fs/promises'
import path from 'path'

const SRC = process.env.BRIDGE_SRC
const PLANNER = process.env.PLANNER_PATH
const { parseCompletedTaskIds } = await import(`${SRC}/completed.js`)
const { parseBoardOrder } = await import(`${SRC}/board.js`)

const completedMd = await fs.readFile(path.join(PLANNER, 'planner-completed.md'), 'utf-8')
const activeMd = await fs.readFile(path.join(PLANNER, 'planner.md'), 'utf-8')

const completed = new Set(parseCompletedTaskIds(completedMd))
const active = new Set(parseBoardOrder(activeMd).keys())

const oldFinished = [...completed]
const newFinished = oldFinished.filter((id) => !active.has(id))
const rescued = oldFinished.filter((id) => active.has(id))

const statePath = path.join(
  process.env.LOCALAPPDATA,
  'overnight-agent',
  'telegram-bridge',
  'state.json',
)
let state = { tasks: {} }
try {
  state = JSON.parse(await fs.readFile(statePath, 'utf-8'))
} catch {}

console.log(`completed-board ids : ${completed.size}`)
console.log(`active-board ids    : ${active.size}`)
console.log(`OLD guard suppressed: ${oldFinished.length}`)
console.log(`NEW guard suppresses: ${newFinished.length}`)
console.log(`RESCUED (dual-board): ${rescued.length}`)
console.log('')
for (const id of rescued) {
  const t = state.tasks[id]
  console.log(
    `  #${id}  topic=${t?.topicId ?? '-'}  userEngaged=${t?.userEngaged ?? false}  ` +
      `lastPostedHash=${t?.lastPostedHash ? t.lastPostedHash.slice(0, 8) : '(none)'}`,
  )
}
