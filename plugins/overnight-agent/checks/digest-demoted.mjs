// Find tasks whose AGENT BLOCK carries an ask, but whose LATEST turn does not —
// i.e. an ask silently demoted out of the digest by a later, ask-free chat reply.
// This is distinct from the known *phrasing* bug (#433): here the marker exists,
// just not in the turn the digest happens to read.
const ROOT = process.env.BRIDGE_SRC
const { createFsIo } = await import(`${ROOT}/io.js`)
const { extractAskEntry } = await import(`${ROOT}/digest.js`)
const { hasAgentBlock, latestAgentTurn, parseTitle } = await import(`${ROOT}/journal.js`)
const { parseBoardOrder, boardRank } = await import(`${ROOT}/board.js`)

const planner = process.env.PLANNER_PATH
const io = createFsIo({
  journalDir: `${planner}\\journal`,
  boardPath: `${planner}\\planner.md`,
  completedBoardPath: `${planner}\\planner-completed.md`,
})

// The agent block = from the OVERNIGHT-AGENT sentinel to the first chat entry after it.
function agentBlock(content) {
  const m = content.match(/<!--\s*OVERNIGHT-AGENT[^>]*-->/)
  if (!m) return null
  const rest = content.slice(m.index + m[0].length)
  const cut = rest.search(/^<!--\s*from:/m)
  return cut === -1 ? rest : rest.slice(0, cut)
}

let board = null
try { board = parseBoardOrder(await io.readBoard()) } catch { board = null }

const demoted = []
for (const { taskId } of await io.listJournals()) {
  const content = await io.readJournal(taskId)
  if (!hasAgentBlock(content)) continue
  const turn = latestAgentTurn(content)
  if (turn && extractAskEntry(turn)) continue // already visible
  const blk = agentBlock(content)
  if (!blk) continue
  const blockAsk = extractAskEntry(blk)
  if (!blockAsk) continue // no ask anywhere -> correctly absent
  const rank = boardRank(board, taskId)
  demoted.push({ taskId, rank, title: parseTitle(content), source: blockAsk.source, text: blockAsk.text })
}

demoted.sort((a, b) => a.rank - b.rank || Number(a.taskId) - Number(b.taskId))
console.log(`silently-demoted asks: ${demoted.length}`)
for (const d of demoted) {
  console.log(`\n#${d.taskId} (boardRank=${d.rank}) — ${d.title}`)
  console.log(`   ask[${d.source}]: ${d.text.replace(/\s+/g, ' ').slice(0, 200)}`)
}
