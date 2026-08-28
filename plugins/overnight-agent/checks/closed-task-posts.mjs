// Measures the #400 bug on the LIVE journals: how many tasks would syncUp post
// into even though they are already on the completed board?
//
// Usage:
//   $env:PLANNER_PATH='C:\Users\shiv\OneDrive\Apps\Focus Planner'
//   $env:BRIDGE_SRC='file:///V:/repos/.../packages/telegram-bridge/src'
//   node closed-task-posts.mjs
import fs from 'fs/promises'
import path from 'path'

const SRC = process.env.BRIDGE_SRC
const PLANNER = process.env.PLANNER_PATH
const STATE = path.join(process.env.LOCALAPPDATA, 'overnight-agent', 'telegram-bridge', 'state.json')

const { hasAgentBlock, latestAgentTurn, parseTitle } = await import(`${SRC}/journal.js`)
const { hashTurn } = await import(`${SRC}/bridge.js`)
const { parseCompletedTaskIds } = await import(`${SRC}/completed.js`)

const completed = new Set(
  parseCompletedTaskIds(await fs.readFile(path.join(PLANNER, 'planner-completed.md'), 'utf-8')),
)
const state = JSON.parse(await fs.readFile(STATE, 'utf-8'))
const journalDir = path.join(PLANNER, 'journal')
const files = (await fs.readdir(journalDir)).filter((f) => /^task-\d+\.md$/.test(f))

const wouldPost = []
for (const f of files) {
  const taskId = f.match(/^task-(\d+)\.md$/)[1]
  const content = await fs.readFile(path.join(journalDir, f), 'utf-8')
  if (!hasAgentBlock(content)) continue
  const turn = latestAgentTurn(content)
  if (!turn) continue
  const task = state.tasks[taskId]
  if (task && task.lastPostedHash === hashTurn(turn)) continue
  wouldPost.push({
    taskId,
    title: (parseTitle(content) || '').slice(0, 52),
    completed: completed.has(taskId),
    archivedTopic: !!(task && task.archived),
    topicId: task ? (task.topicId ?? null) : null,
  })
}

const bad = wouldPost.filter((t) => t.completed)
console.log(`journals scanned      : ${files.length}`)
console.log(`completed-board tasks : ${completed.size}`)
console.log(`syncUp would post to  : ${wouldPost.length}`)
console.log(`  of those, CLOSED    : ${bad.length}   <-- the #400 bug`)
for (const t of bad) {
  console.log(
    `   #${t.taskId}  topic=${t.topicId ?? 'NEW'}${t.archivedTopic ? ' (archived)' : ''}  ${t.title}`,
  )
}
const ok = wouldPost.filter((t) => !t.completed)
console.log(`  of those, open      : ${ok.length}  [${ok.map((t) => '#' + t.taskId).join(' ')}]`)
