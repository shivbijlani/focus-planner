// Dry-run probe: would repairing a journal's **Status:** line change the turn the
// Telegram bridge would POST? Uses the bridge's own parsers, never writes.
//
// Repairing a Status line is only safe when the task's latest agent turn is a
// later `<!-- from: overnight-agent -->` chat entry (the Status line then sits
// outside the posted turn). If the plan block IS the latest turn, the edit
// changes the hash and syncUp would post a months-old entry into the task's
// topic -- which is exactly the #400 "closed tasks look open" bug.
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const ROOT = process.env.BRIDGE_SRC
const { latestAgentTurn, agentBlockText, agentBlockStatus } = await import(`${ROOT}/journal.js`)
const planner = process.env.PLANNER_PATH

const STATUS_RX = /^([ \t]*\*{0,2}Status:?\*{0,2}[ \t]*:?[ \t]*\*{0,2})([A-Za-z-]+)/m
const h = (s) => (s == null ? 'NULL' : createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 12))

for (const id of process.argv.slice(2)) {
  const path = `${planner}\\journal\\task-${id}.md`
  let content
  try {
    content = readFileSync(path, 'utf8')
  } catch {
    console.log(`#${id}: NO JOURNAL`)
    continue
  }

  const before = latestAgentTurn(content)
  const status = agentBlockStatus(agentBlockText(content))

  // Simulate the minimal repair: replace only the status WORD, first match only.
  const patched = content.replace(STATUS_RX, (m, prefix) => `${prefix}Done`)
  if (patched === content) {
    console.log(`#${id}: no Status line matched -- skip`)
    continue
  }
  const after = latestAgentTurn(patched)

  const posts = h(before) !== h(after)
  console.log(
    `#${String(id).padEnd(4)} status=${String(status).padEnd(12)} ` +
      `turnHash ${h(before)} -> ${h(after)}  ${posts ? 'WOULD POST  (unsafe)' : 'no post     (safe)'}`
  )
}
