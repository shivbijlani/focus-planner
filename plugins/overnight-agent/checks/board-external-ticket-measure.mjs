// Measures the #171 fix against the LIVE board.
//   1. Parity: every id the OLD parser found, the NEW parser must still find,
//      with an identical entry. That is the no-regression half.
//   2. Effect: inject the app's real External-Ticket cell shape into the top
//      row of `## Today` and show what each parser does with it.
import { readFileSync } from 'node:fs'
import { parseBoardOrder, boardRank, boardIndex, RANK_UNLISTED } from '../../../packages/telegram-bridge/src/board.js'

const BOARD = process.env.PLANNER_PATH + '\\planner.md'
const md = readFileSync(BOARD, 'utf8')

// The parser exactly as it was before the fix.
function parseOld(markdown) {
  const out = new Map()
  if (!markdown) return out
  let section = 'other'
  let index = 0
  for (const rawLine of markdown.split(/\r?\n/)) {
    const h = /^#{1,6}\s+(.+?)\s*$/.exec(rawLine)
    if (h) {
      const n = h[1].trim().toLowerCase()
      section = n === 'today' ? 'today' : n === 'deferred' ? 'deferred' : 'other'
      continue
    }
    const t = rawLine.trim()
    if (!t.startsWith('|')) continue
    const cols = t.slice(1).split('|').map((c) => c.trim())
    const id = cols[0]
    if (!/^\d+$/.test(id)) continue
    if (out.has(id)) continue
    const urgent = (cols[1] || '').includes('\u{1F534}') || /^p0$/i.test((cols[3] || '').trim())
    out.set(id, { section, index: index++, urgent })
  }
  return out
}

const oldB = parseOld(md)
const newB = parseBoardOrder(md)

let drift = 0
for (const [id, o] of oldB) {
  const n = newB.get(id)
  if (!n || n.section !== o.section || n.index !== o.index || n.urgent !== o.urgent) {
    drift++
    console.log(`  DRIFT ${id}: old=${JSON.stringify(o)} new=${JSON.stringify(n)}`)
  }
}
const added = [...newB.keys()].filter((k) => !oldB.has(k))

console.log('=== 1. PARITY against the live board ===')
console.log(`  rows old=${oldB.size}  new=${newB.size}  drift=${drift}  newly-parsed=${added.length}`)
console.log(`  ${drift === 0 && added.length === 0 ? 'PASS - identical, no regression' : 'CHANGED'}`)

// --- 2. Effect ------------------------------------------------------------
const lines = md.split(/\r?\n/)
const todayIdx = lines.findIndex((l) => /^##\s+Today\s*$/i.test(l))
let rowIdx = -1
for (let i = todayIdx + 1; i < lines.length; i++) {
  const m = /^\|\s*(\d+)\s*\|/.exec(lines[i])
  if (m) { rowIdx = i; break }
}
const realId = /^\|\s*(\d+)\s*\|/.exec(lines[rowIdx])[1]
const ticket = `${realId},[171](https://github.com/shivbijlani/focus-planner/issues/171)`
lines[rowIdx] = lines[rowIdx].replace(/^\|\s*\d+\s*\|/, `| ${ticket} |`)
const injected = lines.join('\n')

const oldI = parseOld(injected)
const newI = parseBoardOrder(injected)

console.log('\n=== 2. EFFECT: same row, now carrying an External Ticket ===')
console.log(`  cell: | ${ticket} |   (row 1 of ## Today)`)
for (const [label, b] of [['OLD parser', oldI], ['NEW parser', newI]]) {
  const rank = boardRank(b, realId)
  const idx = boardIndex(b, realId)
  console.log(
    `  ${label}: onBoard=${b.has(realId)}  rank=${rank}${rank === RANK_UNLISTED ? ' (UNLISTED - sinks to the roll-up)' : ''}  index=${idx === Number.MAX_SAFE_INTEGER ? 'MAX_SAFE_INTEGER' : idx}`,
  )
}
const fixed = newI.has(realId) && boardRank(newI, realId) === boardRank(newB, realId) && boardIndex(newI, realId) === boardIndex(newB, realId)
console.log(`  ${fixed ? 'PASS - identical to the same row with a bare id' : 'FAIL'}`)
