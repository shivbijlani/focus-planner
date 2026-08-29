// Replay the bridge's real digest selection over the LIVE journals, without
// sending anything. Used to re-measure ordering (never trust a prior claim).
const ROOT = process.env.BRIDGE_SRC
const { createFsIo } = await import(`${ROOT}/io.js`)
const { extractAskEntry, buildDigest } = await import(`${ROOT}/digest.js`)
const { parseBoardOrder, boardRank, boardIndex } = await import(`${ROOT}/board.js`)
const { hasAgentBlock, latestAgentTurn, parseTitle } = await import(`${ROOT}/journal.js`)

const planner = process.env.PLANNER_PATH
const io = createFsIo({
  journalDir: `${planner}\\journal`,
  boardPath: `${planner}\\planner.md`,
  completedBoardPath: `${planner}\\planner-completed.md`,
})

const entries = []
const journals = await io.listJournals()
for (const { taskId } of journals) {
  const content = await io.readJournal(taskId)
  if (!hasAgentBlock(content)) continue
  const turn = latestAgentTurn(content)
  if (!turn) continue
  const ask = extractAskEntry(turn)
  if (!ask) continue
  entries.push({ taskId, title: parseTitle(content), ask: ask.text, source: ask.source })
}

let board = null
try { board = parseBoardOrder(await io.readBoard()) } catch { board = null }

const SORT = process.env.SORT_MODE || 'board-first'
const rank = (e) => (e.source === 'next' ? 1 : 0)
if (SORT === 'board-first') {
  entries.sort((a, b) =>
    boardRank(board, a.taskId) - boardRank(board, b.taskId) ||
    boardIndex(board, a.taskId) - boardIndex(board, b.taskId) ||
    rank(a) - rank(b) ||
    Number(b.taskId) - Number(a.taskId))
} else {
  // #158 key: marker style was PRIMARY, board only broke ties within a group.
  entries.sort((a, b) =>
    rank(a) - rank(b) ||
    boardRank(board, a.taskId) - boardRank(board, b.taskId) ||
    boardIndex(board, a.taskId) - boardIndex(board, b.taskId) ||
    Number(b.taskId) - Number(a.taskId))
}

const msg = buildDigest(entries, { preserveOrder: SORT === 'board-first' })
const visible = [...msg.matchAll(/^\u2022 \*\*#(\d+)/gm)].map((m) => m[1])

console.log(`journals=${journals.length} asks=${entries.length} sort=${SORT}`)
console.log(`visible=${visible.length}: ${visible.join(' ')}`)
const want = ['433', '434', '407', '356', '160']
for (const w of want) {
  const i = visible.indexOf(w)
  console.log(`  #${w}: ${i === -1 ? 'ABSENT' : `slot ${i + 1}`}`)
}
