// Explain, per task id, WHY it is present or absent from the digest selection.
// Usage: BRIDGE_SRC=<file:// src> PLANNER_PATH=<planner> node digest-why.mjs 435 400 ...
const ROOT = process.env.BRIDGE_SRC
const { createFsIo } = await import(`${ROOT}/io.js`)
const { extractAskEntry } = await import(`${ROOT}/digest.js`)
const { hasAgentBlock, latestAgentTurn, parseTitle } = await import(`${ROOT}/journal.js`)

const planner = process.env.PLANNER_PATH
const io = createFsIo({
  journalDir: `${planner}\\journal`,
  boardPath: `${planner}\\planner.md`,
  completedBoardPath: `${planner}\\planner-completed.md`,
})

const ids = process.argv.slice(2)
for (const id of ids) {
  let content
  try { content = await io.readJournal(id) } catch (e) { console.log(`#${id}: NO JOURNAL (${e.message})`); continue }
  const hb = hasAgentBlock(content)
  const turn = hb ? latestAgentTurn(content) : null
  const ask = turn ? extractAskEntry(turn) : null
  console.log(`\n=== #${id} — ${parseTitle(content) || '(no title)'} ===`)
  console.log(`  hasAgentBlock : ${hb}`)
  console.log(`  latestTurn    : ${turn ? `${turn.length} chars` : 'null'}`)
  console.log(`  extractAsk    : ${ask ? `source=${ask.source} text=${JSON.stringify(ask.text.slice(0, 160))}` : 'NULL  <-- dropped from digest'}`)
  if (turn && !ask) {
    const lines = turn.split(/\r?\n/).filter((l) => l.trim())
    console.log('  --- last 12 non-empty lines of the turn ---')
    for (const l of lines.slice(-12)) console.log(`   | ${l.slice(0, 150)}`)
  }
}
