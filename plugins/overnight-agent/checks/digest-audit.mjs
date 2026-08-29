// Read-only audit: replicate the bridge's digest selection against the live
// journals and report which asks survive the size cap and which fall off.
import { createFsIo } from 'file:///V:/repos/focus-planner.worktrees/oa-digest-154/packages/telegram-bridge/src/io.js'
import { hasAgentBlock, latestAgentTurn, parseTitle } from 'file:///V:/repos/focus-planner.worktrees/oa-digest-154/packages/telegram-bridge/src/journal.js'
import { extractAskEntry, buildDigest } from 'file:///V:/repos/focus-planner.worktrees/oa-digest-154/packages/telegram-bridge/src/digest.js'
import { parseBoardOrder, boardRank, boardIndex } from 'file:///V:/repos/focus-planner.worktrees/oa-digest-154/packages/telegram-bridge/src/board.js'

const PLANNER = 'C:/Users/shiv/OneDrive/Apps/Focus Planner'
const io = createFsIo({
  journalDir: `${PLANNER}/journal`,
  completedBoardPath: `${PLANNER}/planner-completed.md`,
  boardPath: `${PLANNER}/planner.md`,
})

const entries = []
for (const { taskId } of await io.listJournals()) {
  const content = await io.readJournal(taskId)
  if (!hasAgentBlock(content)) continue
  const turn = latestAgentTurn(content)
  if (!turn) continue
  const ask = extractAskEntry(turn)
  if (!ask) continue
  entries.push({ taskId, title: parseTitle(content), ask: ask.text, source: ask.source })
}

const board = parseBoardOrder(await io.readBoard())
const rank = (e) => (e.source === 'next' ? 1 : 0)
entries.sort(
  (a, b) =>
    boardRank(board, a.taskId) - boardRank(board, b.taskId) ||
    boardIndex(board, a.taskId) - boardIndex(board, b.taskId) ||
    rank(a) - rank(b) ||
    Number(b.taskId) - Number(a.taskId),
)

const md = buildDigest(entries, { date: new Date().toISOString().slice(0, 10), privacyModeOn: false, preserveOrder: true })
const shown = new Set([...md.matchAll(/^\u2022 \*\*#(\d+)/gm)].map((m) => m[1]))

const needs = entries.filter((e) => e.source !== 'next')
const soft = entries.filter((e) => e.source === 'next')
console.log(`TOTAL asks: ${entries.length}  (needs=${needs.length}, next=${soft.length})`)
console.log(`DIGEST shows: ${shown.size}   chars=${md.length}`)
console.log(`\n=== SHOWN ===`)
for (const e of entries.filter((e) => shown.has(e.taskId)))
  console.log(`  #${e.taskId} [${e.source}] rank=${boardRank(board, e.taskId)} ${e.title || ''}`)

console.log(`\n=== DROPPED, but on the Today board (boardRank<=1) ===`)
for (const e of entries.filter((e) => !shown.has(e.taskId) && boardRank(board, e.taskId) <= 1))
  console.log(`  #${e.taskId} [${e.source}] rank=${boardRank(board, e.taskId)} ${e.title || ''}`)

console.log(`\n=== SHOWN but NOT on the live board (rank>=4: off-board/completed) ===`)
for (const e of entries.filter((e) => shown.has(e.taskId) && boardRank(board, e.taskId) >= 4))
  console.log(`  #${e.taskId} [${e.source}] rank=${boardRank(board, e.taskId)} ${e.title || ''}`)


