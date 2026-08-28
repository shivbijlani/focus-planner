// Would syncUp() ACTUALLY post for these tasks right now?
//
// ⚠️ HARDENED 2026-08-25 13:30 PT. The original version modelled only ONE of the two
// gates in syncUp() - the hash gate at bridge.js:142 (`task.lastPostedHash === hash`).
// It therefore reported "CHANGED - would post" for #405 and the bridge then refused:
//     suppressed post for completed task #405 (no user reply since it closed)
// That is the completed-task guard at bridge.js:158:
//     if (completed.has(taskId) && !task.userEngaged) { setLastPosted(...); continue }
//
// Two things make that guard worse than a skip:
//   1. it calls setLastPosted() on the way out, so the turn is recorded as ALREADY POSTED
//      and can never be delivered later, even if the task becomes eligible; and
//   2. it lifts only when `userEngaged` is true - i.e. when the user replies IN THE TOPIC -
//      which they cannot do, because the message they would reply to was never sent.
//
// It fires for any task on the COMPLETED board, including a DUAL-BOARD task that also has a
// live row on the active board (5 of them today: #355, #387, #405, #409, #424).
//
// Rule this encodes: a delivery pre-check must model EVERY gate the real path applies, or it
// manufactures false confidence. Same family as the recorded "your checker must use the
// parser's own matching semantics" trap. Belt and braces: after PHASE 3, also read the
// bridge's own `once` output for `suppressed post for completed task #<id>`.
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const ROOT = process.env.BRIDGE_SRC
const { latestAgentTurn } = await import(`${ROOT}/journal.js`)
const { parseCompletedTaskIds } = await import(`${ROOT}/completed.js`)
const planner = process.env.PLANNER_PATH
const statePath = `${process.env.LOCALAPPDATA}\\overnight-agent\\telegram-bridge\\state.json`

const state = JSON.parse(readFileSync(statePath, 'utf8'))
const tasks = state.tasks || {}

let completed = new Set()
try {
  completed = new Set(parseCompletedTaskIds(readFileSync(`${planner}\\planner-completed.md`, 'utf8')))
} catch (err) {
  console.log(`!! could not read the completed board (${err.message}) - the completed-task guard is NOT modelled`)
}

for (const id of process.argv.slice(2)) {
  const content = readFileSync(`${planner}\\journal\\task-${id}.md`, 'utf8')
  const turn = latestAgentTurn(content)
  const hash = turn ? createHash('sha256').update(turn, 'utf8').digest('hex') : null
  const known = tasks[id]?.lastPostedHash ?? null
  const same = known !== null && known === hash
  const engaged = !!tasks[id]?.userEngaged

  let verdict
  if (!turn) verdict = 'NO PARSEABLE TURN - nothing to post'
  else if (same) verdict = 'SKIP (unchanged) - no post'
  else if (completed.has(String(id)) && !engaged)
    verdict = 'SUPPRESSED (completed board, userEngaged=false) - WILL NOT POST, and the turn is burned'
  else if (known === null) verdict = 'NO STATE ENTRY - would post'
  else verdict = 'CHANGED - would post'

  console.log(`#${String(id).padEnd(4)} ${verdict}`)
}
